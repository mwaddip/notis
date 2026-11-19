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

import { lpStream, type LengthPrefixedStream } from '@libp2p/utils';
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

// A held link stream. One `lpStream` per stream, used for the key frames,
// every `send` and the receive loop (MESH_INTERFACE → FIPS → "Each side
// names its key first"). Each `@libp2p/utils` byteStream listens to
// `message` events and buffers up to 4 MiB — a second wrapper would copy
// every inbound byte in parallel and abort the stream.
interface LinkEntry {
  remoteKeyHex: string;
  remotePeer: string;
  stream: Stream;
  lp: LengthPrefixedStream<Stream>;
  connection: Connection;
  opener: 'us' | 'them';
  state: 'pending' | 'up';
  hintTimer: ReturnType<typeof setTimeout> | null;
}

// MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
// named it holds the key" — the opener's failure count against one libp2p
// peer. Kept apart from `links` so `send`, `connect` and `resolveNewStream`
// see only live streams.
interface RetryEntry {
  remotePeer: string;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
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
  // Live links keyed by remote compressed key hex; one entry per remote key
  // (MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer
  // that named it holds the key").
  private readonly links = new Map<string, LinkEntry>();
  // Opener-side retry state keyed by libp2p peer id. Every failed open
  // attempt against the peer counts here; `linkUp` resets it; `stop()`
  // clears every timer (MESH_INTERFACE → FIPS → "A key holds one link,
  // and the libp2p peer that named it holds the key").
  private readonly retries = new Map<string, RetryEntry>();
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
      entry.hintTimer = null;
      try { entry.stream.abort(new Error('transport stopped')); } catch { /* already */ }
    }
    this.links.clear();
    for (const r of this.retries.values()) {
      if (r.timer !== null) clearTimeout(r.timer);
    }
    this.retries.clear();
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
    await entry.lp.write(packet);
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
   * connection, exchanges keys, answers the remote compressed key hex.
   * Any failure — stream refused, key write failed, key frame malformed,
   * holding rule closed the new stream — records a failure against the
   * libp2p peer and schedules a retry on a connection the opener still
   * holds.
   */
  async openLink(connection: Connection): Promise<string> {
    if (this.stopped || this.context === null || this.ownKeyBytes === null) {
      return '';
    }
    const remotePeerStr = connection.remotePeer.toString();
    let stream: Stream;
    try {
      stream = await connection.newStream(this.protocol);
    } catch {
      this.markFailure(remotePeerStr);
      return '';
    }
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    try {
      await lp.write(this.ownKeyBytes);
    } catch {
      try { stream.abort(new Error('key write failed')); } catch { /* already */ }
      this.markFailure(remotePeerStr);
      return '';
    }
    const remoteKeyHex = await this.readKeyFrame(lp, stream);
    if (!remoteKeyHex) {
      this.markFailure(remotePeerStr);
      return '';
    }
    if (!this.resolveNewStream(remoteKeyHex, remotePeerStr, 'us', stream)) {
      // The holding rules closed this opener's stream — the kept stream
      // stands in for it, so no failure to mark.
      return '';
    }
    this.holdStream(remoteKeyHex, remotePeerStr, 'us', stream, lp, connection);
    // Pause any pending retry timer while this attempt is in flight;
    // `linkUp` clears the entry, `onStreamEnd` schedules the next.
    const r = this.retries.get(remotePeerStr);
    if (r !== undefined && r.timer !== null) {
      clearTimeout(r.timer);
      r.timer = null;
    }
    try {
      await this.options.connectPeer({ transport: this.type, addr: remoteKeyHex });
    } catch {
      // fips-ts's FMP handshake may fail later; the hint timer trims a
      // pending link and `onStreamEnd` records the failure.
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
    if (entry.hintTimer !== null) {
      clearTimeout(entry.hintTimer);
      entry.hintTimer = null;
    }
    const r = this.retries.get(entry.remotePeer);
    if (r !== undefined) {
      if (r.timer !== null) clearTimeout(r.timer);
      this.retries.delete(entry.remotePeer);
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

  /**
   * MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
   * named it holds the key" — how many failures in a row the opener has
   * recorded against this libp2p peer, 0 when there is none.
   */
  failureCountFor(remotePeer: string): number {
    return this.retries.get(remotePeer)?.failures ?? 0;
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
    if (!this.resolveNewStream(remoteKeyHex, remotePeerStr, 'them', stream)) {
      return;
    }
    try {
      await lp.write(this.ownKeyBytes);
    } catch {
      try { stream.abort(new Error('key write failed')); } catch { /* already */ }
      return;
    }
    this.holdStream(remoteKeyHex, remotePeerStr, 'them', stream, lp, connection);
    // The answerer does NOT call connectPeer. fips-ts's packet processor
    // handles a responder's first handshake message through onPacket —
    // only the opener initiates (`FipsNode.ts` `onTransportConn` at line
    // 575 ignores `connected` events; the responder's packets go through
    // `packetProcessor.process`). Measured: with the answerer not calling
    // connectPeer, every link case still comes up.
  }

  // MESH_INTERFACE → FIPS → "Each side names its key first" — read the
  // first length-prefixed frame under the hint timeout and validate it as
  // a 33-byte compressed secp256k1 key.
  private async readKeyFrame(
    lp: LengthPrefixedStream<Stream>,
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
  ): boolean {
    const held = this.links.get(remoteKeyHex);
    if (!held) return true;
    if (held.remotePeer !== remotePeer) {
      try { newStream.abort(new Error('another peer holds the key')); } catch { /* already */ }
      return false;
    }
    if (held.opener === 'them' && opener === 'them') {
      this.dropEntry(held, 'replaced by newer stream');
      return true;
    }
    if (held.opener === 'us' && opener === 'us') {
      try { newStream.abort(new Error('one link per key')); } catch { /* already */ }
      return false;
    }
    // Simultaneous open: compare opener keys bytewise. ownKeyHex and the
    // remote key hex are both lowercase 66-char hex, so lexicographic
    // comparison orders the same as raw bytes.
    const ourKey = this.ownKeyHex ?? '';
    const theirKey = remoteKeyHex;
    const heldOpenerKey = held.opener === 'us' ? ourKey : theirKey;
    const newOpenerKey = opener === 'us' ? ourKey : theirKey;
    if (newOpenerKey < heldOpenerKey) {
      this.dropEntry(held, 'lower-keyed opener wins');
      return true;
    }
    try { newStream.abort(new Error('higher-keyed opener loses')); } catch { /* already */ }
    return false;
  }

  private holdStream(
    remoteKeyHex: string,
    remotePeer: string,
    opener: 'us' | 'them',
    stream: Stream,
    lp: LengthPrefixedStream<Stream>,
    connection: Connection,
  ): void {
    const entry: LinkEntry = {
      remoteKeyHex,
      remotePeer,
      stream,
      lp,
      connection,
      opener,
      state: 'pending',
      hintTimer: null,
    };
    this.links.set(remoteKeyHex, entry);
    entry.hintTimer = setTimeout(() => {
      entry.hintTimer = null;
      if (entry.state !== 'up' && this.links.get(remoteKeyHex) === entry) {
        try { entry.stream.abort(new Error('link not up in time')); } catch { /* already */ }
      }
    }, this.options.hintTimeoutMs);
    void this.runRxLoop(entry);
  }

  private async runRxLoop(entry: LinkEntry): Promise<void> {
    try {
      while (!this.stopped && this.links.get(entry.remoteKeyHex) === entry) {
        const list = await entry.lp.read();
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
    if (entry.opener !== 'us') return;
    this.markFailure(entry.remotePeer);
  }

  private markFailure(remotePeer: string): void {
    if (this.stopped || this.libp2p === null) return;
    const stillConnected = this.libp2p.getConnections().some(
      (c) => c.remotePeer.toString() === remotePeer && c.status === 'open',
    );
    if (!stillConnected) {
      const existing = this.retries.get(remotePeer);
      if (existing !== undefined && existing.timer !== null) {
        clearTimeout(existing.timer);
      }
      this.retries.delete(remotePeer);
      return;
    }
    let r = this.retries.get(remotePeer);
    if (r === undefined) {
      r = { remotePeer, failures: 0, timer: null };
      this.retries.set(remotePeer, r);
    }
    r.failures += 1;
    if (r.timer !== null) clearTimeout(r.timer);
    const wait = retryIntervalMs(
      r.failures,
      this.options.retryBaseMs,
      this.options.retryCapMs,
      this.options.random,
    );
    const entry = r;
    r.timer = setTimeout(() => {
      entry.timer = null;
      void this.retryReopen(remotePeer);
    }, wait);
  }

  private async retryReopen(remotePeer: string): Promise<void> {
    if (this.stopped || this.libp2p === null) return;
    const open = this.libp2p.getConnections().filter(
      (c) => c.remotePeer.toString() === remotePeer && c.status === 'open',
    );
    if (open.length === 0) {
      this.retries.delete(remotePeer);
      return;
    }
    await this.openLink(open[0]!);
  }

  private dropEntry(entry: LinkEntry, _reason: string): void {
    if (entry.hintTimer !== null) {
      clearTimeout(entry.hintTimer);
      entry.hintTimer = null;
    }
    try { entry.stream.abort(new Error(_reason)); } catch { /* already */ }
    if (this.links.get(entry.remoteKeyHex) === entry) {
      this.links.delete(entry.remoteKeyHex);
    }
  }
}
