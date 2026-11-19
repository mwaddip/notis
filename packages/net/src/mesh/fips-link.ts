// MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends already hold"
// — a fips-ts `Transport` that carries FIPS link packets on a libp2p protocol
// stream over a connection two Notis ends already hold. Browser-safe: imports
// no Node built-in and reads no Node global.
//
// The holding rules of MESH_INTERFACE → FIPS → "A key holds one link, and the
// libp2p peer that named it holds the key": one link per key; the same peer's
// later stream replaces the link where that peer opened it too; the lower
// key's stream kept on a simultaneous open; another peer's stream closed; a
// link not up within `hintTimeoutMs` of its key frames closed; an ended link
// reopened by its opener over a connection it still holds after
// `retryIntervalMs(failures, retryBaseMs, retryCapMs, random)`; `linkUp`
// resets the count.

import { lpStream } from '@libp2p/utils';
import type {
  Transport,
  TransportAddress,
  TransportContext,
} from '@fips/core';
import { toHex } from '@fips/core';
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { retryIntervalMs } from './relay-retry.js';
import { FIPS_LINK_MTU } from './constants.js';
import type { MeshNetworkName } from './constants.js';

/**
 * MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends
 * already hold" — the link protocol a libp2p stream carries FIPS packets on,
 * named for the network: `/notis/<network>/fips-link/1.0.0`.
 */
export function fipsLinkProtocol(network: MeshNetworkName): string {
  return `/notis/${network}/fips-link/1.0.0`;
}

/**
 * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
 * named it holds the key" — the options every LibP2pLinkTransport takes;
 * every field required. The stack passes
 * `(addr) => fipsNode.connect(addr)`, `FIPS_LINK_HINT_TIMEOUT_MS`,
 * `RETRY_BASE_MS`, `RETRY_CAP_MS`, and `Math.random`. Tests pass their own.
 */
export interface LibP2pLinkTransportOptions {
  readonly network: MeshNetworkName;
  readonly connectPeer: (addr: TransportAddress) => Promise<void>;
  readonly hintTimeoutMs: number;
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly random: () => number;
}

// A held link stream. MESH_INTERFACE → FIPS → "A key holds one link, and the
// libp2p peer that named it holds the key" says the libp2p peer that named
// the key holds the key; `remotePeer` is that peer id. `opener` names which
// end opened the stream — only the opener reopens an ended link.
interface LinkEntry {
  remoteKeyHex: string;
  remotePeer: string;
  stream: Stream;
  connection: Connection;
  opener: 'us' | 'them';
  state: 'pending' | 'up';
  hintTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  failures: number;
}

/**
 * MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends
 * already hold" — a fips-ts Transport that carries FIPS packets on a libp2p
 * protocol stream.
 */
export class LibP2pLinkTransport implements Transport {
  readonly type = 'notis-libp2p';
  readonly mtu: number = FIPS_LINK_MTU;
  readonly maxFrameBytes: number = FIPS_LINK_MTU;

  private readonly options: LibP2pLinkTransportOptions;
  private readonly protocol: string;
  private context: TransportContext | null = null;
  private libp2p: Libp2p | null = null;
  // Keyed by remote compressed key hex; one entry per remote key —
  // MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
  // named it holds the key".
  private readonly links = new Map<string, LinkEntry>();
  private ownKeyBytes: Uint8Array | null = null;
  private ownKeyHex: string | null = null;
  private stopped = false;

  constructor(options: LibP2pLinkTransportOptions) {
    this.options = options;
    this.protocol = fipsLinkProtocol(options.network);
  }

  async start(ctx: TransportContext): Promise<void> {
    this.context = ctx;
    this.ownKeyBytes = ctx.localIdentity.publicKey;
    this.ownKeyHex = toHex(ctx.localIdentity.publicKey);
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Close every held link; clear every timer — no handle outlives `stop`.
    for (const entry of [...this.links.values()]) {
      if (entry.hintTimer !== null) clearTimeout(entry.hintTimer);
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
      entry.hintTimer = null;
      entry.retryTimer = null;
      try { entry.stream.abort(new Error('transport stopped')); } catch { /* already */ }
    }
    this.links.clear();
    if (this.libp2p !== null) {
      try { await this.libp2p.unhandle(this.protocol); } catch { /* already */ }
    }
    this.libp2p = null;
    this.context = null;
  }

  /**
   * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
   * named it holds the key" — connect resolves where a stream is held for
   * the address and throws otherwise. The address's `addr` is a 33-byte
   * compressed FIPS key hex (66 hex chars).
   */
  async connect(addr: TransportAddress): Promise<void> {
    const entry = this.links.get(addr.addr);
    if (!entry) throw new Error(`no link held for ${addr.addr}`);
  }

  /**
   * MESH_INTERFACE → FIPS → "Each side names its key first" — write one
   * FIPS packet as a length-prefixed frame on the held stream for addr.
   */
  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    const entry = this.links.get(addr.addr);
    if (!entry) throw new Error(`no link held for ${addr.addr}`);
    const lp = lpStream(entry.stream, { maxDataLength: FIPS_LINK_MTU });
    await lp.write(packet);
  }

  async close(addr: TransportAddress): Promise<void> {
    const entry = this.links.get(addr.addr);
    if (!entry) return;
    this.dropEntry(entry, 'local close');
  }

  /**
   * MESH_INTERFACE → FIPS → "Each side names its key first" — register the
   * link protocol's inbound handler with libp2p. `maxInboundStreams: 1`
   * holds the per-connection cap (MESH_INTERFACE → FIPS → "A link rides a
   * libp2p connection the two ends already hold" → "a connection carries
   * one link stream at once").
   */
  async attach(libp2p: Libp2p): Promise<void> {
    this.libp2p = libp2p;
    await libp2p.handle(
      this.protocol,
      (stream: Stream, connection: Connection) => {
        void this.acceptStream(stream, connection);
      },
      { maxInboundStreams: 1 },
    );
  }

  /**
   * MESH_INTERFACE → FIPS → "A node opens a link over each connection it
   * dialled to a Notis peer" — opens a link stream on an existing libp2p
   * connection, exchanges keys, answers the remote compressed key hex. On
   * the keep-or-close rules (`resolveNewStream`) the opener may be closed
   * and answer the empty string.
   */
  async openLink(connection: Connection): Promise<string> {
    if (this.stopped || this.context === null || this.ownKeyBytes === null) {
      return '';
    }
    let stream: Stream;
    try {
      stream = await connection.newStream(this.protocol);
    } catch {
      return '';
    }
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    // Opener writes its key first; then reads the answerer's.
    try {
      await lp.write(this.ownKeyBytes);
    } catch {
      try { stream.abort(new Error('key write failed')); } catch { /* already */ }
      return '';
    }
    const remoteKeyHex = await this.readKeyFrame(lp, stream);
    if (!remoteKeyHex) return '';
    const remotePeerStr = connection.remotePeer.toString();
    // Apply the holding rules before holding the stream.
    if (!this.resolveNewStream(remoteKeyHex, remotePeerStr, 'us', stream, connection)) {
      return '';
    }
    this.holdStream(remoteKeyHex, remotePeerStr, 'us', stream, connection);
    try {
      await this.options.connectPeer({ transport: this.type, addr: remoteKeyHex });
    } catch {
      // The FMP handshake may fail; the link stays pending, the hint
      // timer trims it (MESH_INTERFACE → FIPS → "A link is up once FIPS's
      // own handshake over it completes").
    }
    return remoteKeyHex;
  }

  /**
   * MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake over it
   * completes" — the stack calls this on fips-ts's `peer` event with
   * `state: 'connected'`, which resets the opener's retry count.
   */
  linkUp(remoteKeyHex: string): void {
    const entry = this.links.get(remoteKeyHex);
    if (!entry) return;
    entry.state = 'up';
    entry.failures = 0;
    if (entry.hintTimer !== null) {
      clearTimeout(entry.hintTimer);
      entry.hintTimer = null;
    }
  }

  /**
   * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
   * named it holds the key" — the keys whose links are up.
   */
  linkedKeys(): string[] {
    const out: string[] = [];
    for (const entry of this.links.values()) {
      if (entry.state === 'up') out.push(entry.remoteKeyHex);
    }
    return out;
  }

  // ----- internal helpers -----

  private async acceptStream(stream: Stream, connection: Connection): Promise<void> {
    if (this.stopped || this.context === null || this.ownKeyBytes === null) {
      try { stream.abort(new Error('transport stopped')); } catch { /* already */ }
      return;
    }
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    const remoteKeyHex = await this.readKeyFrame(lp, stream);
    if (!remoteKeyHex) return;
    const remotePeerStr = connection.remotePeer.toString();
    if (!this.resolveNewStream(remoteKeyHex, remotePeerStr, 'them', stream, connection)) {
      return;
    }
    try {
      await lp.write(this.ownKeyBytes);
    } catch {
      try { stream.abort(new Error('key write failed')); } catch { /* already */ }
      return;
    }
    this.holdStream(remoteKeyHex, remotePeerStr, 'them', stream, connection);
    try {
      await this.options.connectPeer({ transport: this.type, addr: remoteKeyHex });
    } catch { /* hint timer trims a pending link */ }
  }

  // MESH_INTERFACE → FIPS → "Each side names its key first" — read the
  // first length-prefixed frame under the hint timeout and validate it as
  // a 33-byte compressed secp256k1 key.
  private async readKeyFrame(
    lp: ReturnType<typeof lpStream>,
    stream: Stream,
  ): Promise<string | null> {
    const signal = AbortSignal.timeout(this.options.hintTimeoutMs);
    let buf: Uint8Array | null = null;
    try {
      const list = await lp.read({ signal });
      buf = list.subarray();
    } catch {
      try { stream.abort(new Error('key frame deadline or error')); } catch { /* already */ }
      return null;
    }
    if (buf.length !== 33 || (buf[0] !== 0x02 && buf[0] !== 0x03)) {
      try { stream.abort(new Error('key frame malformed')); } catch { /* already */ }
      return null;
    }
    return toHex(buf);
  }

  // MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
  // named it holds the key" — the holding rules. Returns true where the new
  // stream is kept; the old entry's stream is closed as a side effect where
  // the new one replaces it.
  private resolveNewStream(
    remoteKeyHex: string,
    remotePeer: string,
    opener: 'us' | 'them',
    newStream: Stream,
    newConnection: Connection,
  ): boolean {
    const held = this.links.get(remoteKeyHex);
    if (!held) return true;
    if (held.remotePeer !== remotePeer) {
      // A stream naming the key from another peer is closed.
      try { newStream.abort(new Error('another peer holds the key')); } catch { /* already */ }
      return false;
    }
    if (held.opener === 'them' && opener === 'them') {
      // Same peer replaces where it opened the link too.
      this.dropEntry(held, 'replaced by newer stream');
      return true;
    }
    if (held.opener === 'us' && opener === 'us') {
      // Same end opened twice; keep the earlier, close the later.
      try { newStream.abort(new Error('one link per key')); } catch { /* already */ }
      return false;
    }
    // Simultaneous open: our outbound stream and their inbound stream for
    // the same key. The opener whose FIPS key sorts lower wins.
    const ourKey = this.ownKeyHex ?? '';
    const theirKey = remoteKeyHex;
    const ourStreamIsOpener = (opener === 'us' ? ourKey : theirKey) === ourKey
      ? (held.opener === 'us' ? ourKey : theirKey)
      : (held.opener === 'us' ? ourKey : theirKey);
    void ourStreamIsOpener;
    // Which stream's opener key is lower?
    const heldOpenerKey = held.opener === 'us' ? ourKey : theirKey;
    const newOpenerKey = opener === 'us' ? ourKey : theirKey;
    // If one is lower, keep that one. ownKeyHex compared bytewise with
    // remote key hex orders the same as the raw bytes since both are
    // lowercase hex of equal length (33 bytes, 66 chars each).
    if (newOpenerKey < heldOpenerKey) {
      // The new stream's opener is lower — keep the new, drop the held.
      this.dropEntry(held, 'lower-keyed opener wins');
      void newConnection;
      return true;
    }
    // The held stream's opener is lower (or equal); close the new.
    try { newStream.abort(new Error('higher-keyed opener loses')); } catch { /* already */ }
    return false;
  }

  private holdStream(
    remoteKeyHex: string,
    remotePeer: string,
    opener: 'us' | 'them',
    stream: Stream,
    connection: Connection,
  ): void {
    const prevFailures = this.links.get(remoteKeyHex)?.failures ?? 0;
    const entry: LinkEntry = {
      remoteKeyHex,
      remotePeer,
      stream,
      connection,
      opener,
      state: 'pending',
      hintTimer: null,
      retryTimer: null,
      failures: prevFailures,
    };
    this.links.set(remoteKeyHex, entry);
    // MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake over
    // it completes" — the stream is closed if a link is not up within
    // hintTimeoutMs of its key frames.
    entry.hintTimer = setTimeout(() => {
      entry.hintTimer = null;
      if (entry.state !== 'up' && this.links.get(remoteKeyHex) === entry) {
        try { entry.stream.abort(new Error('link not up in time')); } catch { /* already */ }
      }
    }, this.options.hintTimeoutMs);
    this.runRxLoop(entry);
  }

  private async runRxLoop(entry: LinkEntry): Promise<void> {
    const lp = lpStream(entry.stream, { maxDataLength: FIPS_LINK_MTU });
    try {
      while (!this.stopped && this.links.get(entry.remoteKeyHex) === entry) {
        const list = await lp.read();
        const bytes = list.subarray();
        const ctx = this.context;
        if (!ctx) break;
        ctx.onPacket({
          transportType: this.type,
          remoteAddr: { transport: this.type, addr: entry.remoteKeyHex },
          data: new Uint8Array(bytes),
          receivedAtMs: Date.now(),
        });
      }
    } catch {
      // A read past the cap, a reset or a close — fall through to the
      // disconnect path.
    } finally {
      this.onStreamEnd(entry);
    }
  }

  private onStreamEnd(entry: LinkEntry): void {
    // If this entry is no longer the held one, the replacement already
    // took its place.
    const current = this.links.get(entry.remoteKeyHex);
    if (current !== entry) return;
    this.dropEntry(entry, 'stream ended');
    const ctx = this.context;
    if (ctx !== null) {
      ctx.onConnectionState?.({
        remoteAddr: { transport: this.type, addr: entry.remoteKeyHex },
        state: 'disconnected',
      });
    }
    // MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer
    // that named it holds the key" → "When a link ends, the end that
    // opened it opens it again". Only the opener reopens, and only over a
    // connection it still holds to that peer.
    if (entry.opener !== 'us') return;
    this.scheduleReopen(entry);
  }

  private scheduleReopen(entry: LinkEntry): void {
    if (this.stopped) return;
    entry.failures += 1;
    const wait = retryIntervalMs(
      entry.failures,
      this.options.retryBaseMs,
      this.options.retryCapMs,
      this.options.random,
    );
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void this.reopen(entry);
    }, wait);
    // Stage the entry so repeated close/reopen keeps the failure count
    // under one key (MESH_INTERFACE → FIPS → "A key holds one link, and
    // the libp2p peer that named it holds the key").
    this.links.set(entry.remoteKeyHex, entry);
  }

  private async reopen(entry: LinkEntry): Promise<void> {
    if (this.stopped || this.libp2p === null) return;
    // Pick an open connection to the same libp2p peer (not the one that
    // just closed).
    const libp2p = this.libp2p;
    const openConns = libp2p.getConnections().filter(
      (c) => c.remotePeer.toString() === entry.remotePeer && c.status === 'open',
    );
    if (openConns.length === 0) {
      // No connection left — give up. The far end may reopen if it also
      // holds a path.
      this.links.delete(entry.remoteKeyHex);
      return;
    }
    // Pick the first open connection. `openLink` goes through the holding
    // rules the same way.
    this.links.delete(entry.remoteKeyHex);
    await this.openLink(openConns[0]!);
  }

  private dropEntry(entry: LinkEntry, _reason: string): void {
    if (entry.hintTimer !== null) {
      clearTimeout(entry.hintTimer);
      entry.hintTimer = null;
    }
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    try { entry.stream.abort(new Error(_reason)); } catch { /* already */ }
    if (this.links.get(entry.remoteKeyHex) === entry) {
      this.links.delete(entry.remoteKeyHex);
    }
  }
}
