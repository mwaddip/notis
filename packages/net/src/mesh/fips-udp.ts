// MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
// its operator turns it on" — a fips-ts `Transport` carrying one FIPS
// packet per UDP datagram, beside the libp2p link transport. Imports
// Node's `dgram` and `dns/promises`; never reached from
// `@dagsocial/net/browser`.
//
// A configured peer is addressed by `<ipv4>:<port>` or `[<ipv6>]:<port>`
// — not by key, as FipsNode's address convention goes; the Noise IK
// first message from an unknown address names the sender's key through
// the handshake, as the original FIPS daemon does. `discover()` yields
// each configured peer at start and again on the retry schedule while
// it holds no link (→ The client's node list → "Retry"); `noteLink`
// drives it. Inbound addresses count against `inboundMax` — a half-open
// handshake is released after 2 × `FIPS_LINK_HINT_TIMEOUT_MS`, so it
// cannot pin the cap.

import * as dgram from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns/promises';
import type {
  DiscoveredPeer,
  Logger,
  Transport,
  TransportAddress,
  TransportContext,
} from '@fips/core';
import { compressedPubkeyFromXOnly, decodeNpub, noopLogger } from '@fips/core';

import {
  FIPS_LINK_HINT_TIMEOUT_MS,
  FIPS_LINK_MTU,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type PublicFipsPeer,
} from './constants.js';
import { retryIntervalMs } from './relay-retry.js';

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — `send` throws this when its caller
 * addresses a UDP address the transport did not dial and has not taken
 * as an inbound link.
 */
export class UdpFipsSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UdpFipsSendError';
  }
}

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — options the `UdpFipsTransport`
 * constructor takes.
 *
 * - `listen`: the address the transport binds for inbound (`null` to
 *   bind an ephemeral port on both families for the transport's own
 *   dials alone);
 * - `peers`: the configured public peers to dial;
 * - `inboundMax`: how many addresses it did not dial it holds at once
 *   (→ "A node may accept public links");
 * - `resolve`: optional DNS resolver; the default is `node:dns`'s
 *   `lookup` returning every answer, IPv4 before IPv6;
 * - `random`: optional source for the retry draw; default `Math.random`.
 */
export interface UdpFipsTransportOptions {
  readonly listen: { host: string; port: number } | null;
  readonly peers: readonly PublicFipsPeer[];
  readonly inboundMax: number;
  readonly resolve?: (host: string) => Promise<string[]>;
  readonly random?: () => number;
  readonly logger?: Logger;
}

interface PeerState {
  readonly source: PublicFipsPeer;
  readonly compressedKey: Uint8Array;
  resolvedAddr: string | null;
  failures: number;
  linked: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  yieldCount: number;
}

interface InboundState {
  firstSeenMs: number;
  linked: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

// IPv4 has four octets; a bracketed IPv6 host carries colons inside the
// brackets. The split keeps the two families on one address shape.
function formatUdpAddr(host: string, port: number, family: 4 | 6): string {
  return family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function parseUdpAddr(addr: string): { host: string; port: number; family: 4 | 6 } | null {
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    if (end < 0 || addr[end + 1] !== ':') return null;
    const host = addr.slice(1, end);
    const port = Number(addr.slice(end + 2));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port, family: 6 };
  }
  const i = addr.lastIndexOf(':');
  if (i < 0) return null;
  const host = addr.slice(0, i);
  const port = Number(addr.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // A bare colon-bearing host is an IPv6 literal addressed wrong; refuse.
  if (host.includes(':')) return null;
  return { host, port, family: 4 };
}

// node:dns's lookup with `all: true, verbatim: false` answers every
// address, IPv4 before IPv6, so the first answer is an IPv4 one wherever
// the host has one.
async function defaultResolve(host: string): Promise<string[]> {
  const answers = await dnsLookup(host, { all: true, verbatim: false });
  return answers.map((a) => a.address);
}

/**
 * MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
 * its operator turns it on" — a fips-ts `Transport` that carries one
 * FIPS packet per UDP datagram, dialling each configured public peer
 * and accepting strangers' links up to `inboundMax`.
 *
 * `identityMayChangeAtAddress` is omitted (falsy): a UDP `<ip>:<port>`
 * is not a physical identity anchor as a VM MAC is, and NAT port reuse
 * or a spoofed sender must not displace a held link. The processor's
 * `rebindPeerIdentity` closes the fresh handshake and leaves the held
 * one standing, which is the behaviour this transport wants.
 */
export class UdpFipsTransport implements Transport {
  readonly type = 'udp';
  readonly mtu: number = FIPS_LINK_MTU;
  readonly maxFrameBytes: number = FIPS_LINK_MTU;

  private readonly listen: { host: string; port: number } | null;
  private readonly inboundMax: number;
  private readonly resolver: (host: string) => Promise<string[]>;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly peerStates: PeerState[] = [];
  private readonly addrToPeer = new Map<string, PeerState>();
  private readonly inbound = new Map<string, InboundState>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly readyQueue: PeerState[] = [];

  private socket4: dgram.Socket | null = null;
  private socket6: dgram.Socket | null = null;
  private boundPort4: number | null = null;
  private boundPort6: number | null = null;
  private ctx: TransportContext | null = null;
  private stopped = false;
  private discoverWaker: (() => void) | null = null;

  constructor(options: UdpFipsTransportOptions) {
    this.listen = options.listen;
    this.inboundMax = options.inboundMax;
    this.resolver = options.resolve ?? defaultResolve;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? noopLogger;
    for (const source of options.peers) {
      const xOnly = decodeNpub(source.npub);
      const compressedKey = compressedPubkeyFromXOnly(xOnly);
      this.peerStates.push({
        source,
        compressedKey,
        resolvedAddr: null,
        failures: 0,
        linked: false,
        retryTimer: null,
        yieldCount: 0,
      });
    }
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    // One udp4 socket and one udp6. The `listen` address's family binds
    // on its host and port, the other family on an ephemeral port. With
    // `listen = null` both bind ephemeral. A `udp6` bind that fails on
    // a host with no IPv6 is logged once, never thrown.
    const listenFamily: 4 | 6 | null = this.listen === null
      ? null
      : (this.listen.host.includes(':') ? 6 : 4);
    await this.bindSocket4(listenFamily === 4 ? this.listen : null);
    await this.bindSocket6(listenFamily === 6 ? this.listen : null);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const peer of this.peerStates) peer.retryTimer = null;
    for (const [, inb] of this.inbound) inb.releaseTimer = null;
    this.readyQueue.length = 0;
    if (this.discoverWaker) { const w = this.discoverWaker; this.discoverWaker = null; w(); }
    await this.closeSocket(this.socket4);
    await this.closeSocket(this.socket6);
    this.socket4 = null;
    this.socket6 = null;
    this.boundPort4 = null;
    this.boundPort6 = null;
  }

  // FipsNode calls `transport.connect` before sending its own Msg1.
  // UDP has no connection setup of its own, so this resolves at once
  // and the handshake runs through `send`.
  async connect(_addr: TransportAddress): Promise<void> {
    if (this.stopped) throw new Error('udp transport stopped');
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (this.stopped) throw new UdpFipsSendError('udp: transport stopped');
    if (addr.transport !== 'udp') {
      throw new UdpFipsSendError(`udp: wrong transport "${addr.transport}"`);
    }
    if (!this.addrToPeer.has(addr.addr) && !this.inbound.has(addr.addr)) {
      throw new UdpFipsSendError(`udp: no path to ${addr.addr}`);
    }
    const parts = parseUdpAddr(addr.addr);
    if (parts === null) throw new UdpFipsSendError(`udp: bad address ${addr.addr}`);
    const socket = parts.family === 6 ? this.socket6 : this.socket4;
    if (socket === null) throw new UdpFipsSendError(`udp: no socket for family ${parts.family}`);
    await new Promise<void>((resolve, reject) => {
      socket.send(packet, parts.port, parts.host, (err) => (err ? reject(err) : resolve()));
    });
  }

  async *discover(): AsyncIterable<DiscoveredPeer> {
    // Start each peer's resolve concurrently so a host that does not
    // resolve delays no other peer.
    for (const peer of this.peerStates) void this.yieldPeer(peer);
    while (!this.stopped) {
      if (this.readyQueue.length === 0) {
        await new Promise<void>((resolve) => { this.discoverWaker = resolve; });
        this.discoverWaker = null;
      }
      while (this.readyQueue.length > 0 && !this.stopped) {
        const peer = this.readyQueue.shift();
        if (!peer || peer.resolvedAddr === null) continue;
        yield {
          remoteAddr: { transport: 'udp', addr: peer.resolvedAddr },
          publicKey: peer.compressedKey,
          meta: { name: peer.source.name, npub: peer.source.npub },
        };
      }
    }
  }

  /**
   * MESH_INTERFACE → FIPS → "A public peer is an npub at a `host:port`"
   * — the stack tells the transport each UDP link's state.
   * `noteLink(addr, true)` ends the count of failures in a row for that
   * configured peer or marks an inbound address linked;
   * `noteLink(addr, false)` starts the wait for a configured peer or
   * releases an inbound address.
   */
  noteLink(addr: string, up: boolean): void {
    if (this.stopped) return;
    const peer = this.addrToPeer.get(addr);
    if (peer !== undefined) {
      if (up) {
        peer.linked = true;
        peer.failures = 0;
        if (peer.retryTimer !== null) {
          clearTimeout(peer.retryTimer);
          this.timers.delete(peer.retryTimer);
          peer.retryTimer = null;
        }
      } else {
        const wasLinked = peer.linked;
        peer.linked = false;
        peer.failures = 0;
        this.markFailureAndScheduleRetry(peer);
        // Tell FipsNode the path to this address dropped so it clears
        // its peer entry and lets the next discovery dial run instead
        // of short-circuiting on `peer.link.state === "established"`.
        // The second noteLink(addr, false) a test listener feeds back
        // from the resulting `peer disconnected` event is a no-op here
        // because `peer.linked` is already false.
        if (wasLinked) {
          try {
            this.ctx?.onConnectionState?.({
              remoteAddr: { transport: 'udp', addr },
              state: 'disconnected',
            });
          } catch (err) {
            this.logger.warn('onConnectionState threw', err);
          }
        }
      }
      return;
    }
    const inb = this.inbound.get(addr);
    if (inb !== undefined) {
      if (up) {
        inb.linked = true;
        if (inb.releaseTimer !== null) {
          clearTimeout(inb.releaseTimer);
          this.timers.delete(inb.releaseTimer);
          inb.releaseTimer = null;
        }
      } else {
        this.releaseInbound(addr);
      }
    }
  }

  // Exposed for the mesh stack and tests; parse-only, no side effects.
  listenPort4(): number | null { return this.boundPort4; }
  listenPort6(): number | null { return this.boundPort6; }
  // The count of `discover()` yields for a configured peer whose
  // resolved address matches `addr` — the transport's own retries,
  // whatever the caller does with each yield. Used by cases watching
  // the retry schedule independently of FipsNode's dedup.
  yieldsForAddr(addr: string): number {
    const peer = this.addrToPeer.get(addr);
    return peer ? peer.yieldCount : 0;
  }

  private async bindSocket4(listen: { host: string; port: number } | null): Promise<void> {
    const sock = dgram.createSocket({ type: 'udp4' });
    sock.on('error', (err) => this.logger.warn('udp4 socket error', err));
    sock.on('message', (msg, rinfo) => this.handleDatagram(msg, rinfo, 4));
    const host = listen ? listen.host : '0.0.0.0';
    const port = listen ? listen.port : 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        sock.once('error', onError);
        sock.bind(port, host, () => { sock.removeListener('error', onError); resolve(); });
      });
      const address = sock.address();
      this.socket4 = sock;
      this.boundPort4 = typeof address === 'object' && address !== null ? address.port : null;
    } catch (err) {
      try { sock.close(); } catch { /* already */ }
      throw err;
    }
  }

  private async bindSocket6(listen: { host: string; port: number } | null): Promise<void> {
    const sock = dgram.createSocket({ type: 'udp6', ipv6Only: true });
    sock.on('error', (err) => this.logger.warn('udp6 socket error', err));
    sock.on('message', (msg, rinfo) => this.handleDatagram(msg, rinfo, 6));
    const host = listen ? listen.host : '::';
    const port = listen ? listen.port : 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        sock.once('error', onError);
        sock.bind(port, host, () => { sock.removeListener('error', onError); resolve(); });
      });
      const address = sock.address();
      this.socket6 = sock;
      this.boundPort6 = typeof address === 'object' && address !== null ? address.port : null;
    } catch (err) {
      try { sock.close(); } catch { /* already */ }
      // A host with no IPv6 still runs on IPv4.
      this.logger.warn('udp6 bind failed, continuing on IPv4 alone', err);
      this.socket6 = null;
      this.boundPort6 = null;
    }
  }

  private async closeSocket(sock: dgram.Socket | null): Promise<void> {
    if (sock === null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => { if (!settled) { settled = true; resolve(); } };
      try { sock.close(done); } catch { done(); }
    });
  }

  private handleDatagram(msg: Buffer, rinfo: dgram.RemoteInfo, family: 4 | 6): void {
    // Nothing a datagram holds throws out of the handler.
    try {
      if (this.stopped) return;
      if (msg.length > FIPS_LINK_MTU) return;
      const addrStr = formatUdpAddr(rinfo.address, rinfo.port, family);
      const configured = this.addrToPeer.get(addrStr);
      if (configured === undefined) {
        const taken = this.inbound.get(addrStr);
        if (taken === undefined) {
          if (this.inbound.size >= this.inboundMax) return; // drop past cap
          const state: InboundState = { firstSeenMs: Date.now(), linked: false, releaseTimer: null };
          this.inbound.set(addrStr, state);
          this.armInboundRelease(addrStr);
        }
      }
      const ctx = this.ctx;
      if (ctx === null) return;
      const data = new Uint8Array(msg.byteLength);
      data.set(msg);
      try {
        ctx.onPacket({
          transportType: 'udp',
          remoteAddr: { transport: 'udp', addr: addrStr },
          data,
          receivedAtMs: Date.now(),
        });
      } catch (err) {
        this.logger.warn('onPacket threw', err);
      }
    } catch (err) {
      this.logger.warn('udp handler threw', err);
    }
  }

  private armInboundRelease(addrStr: string): void {
    const state = this.inbound.get(addrStr);
    if (state === undefined || state.linked) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      const cur = this.inbound.get(addrStr);
      if (cur !== undefined && !cur.linked) {
        this.inbound.delete(addrStr);
      }
    }, 2 * FIPS_LINK_HINT_TIMEOUT_MS);
    this.timers.add(t);
    state.releaseTimer = t;
  }

  private releaseInbound(addr: string): void {
    const state = this.inbound.get(addr);
    if (state === undefined) return;
    if (state.releaseTimer !== null) {
      clearTimeout(state.releaseTimer);
      this.timers.delete(state.releaseTimer);
    }
    this.inbound.delete(addr);
  }

  // Resolves the peer's host and puts it in the ready queue on
  // success, or counts a failure and schedules a retry on the drawn
  // wait, matching `MESH_INTERFACE → FIPS → "A public peer is an npub
  // at a `host:port`"`: a host that does not resolve delays no other
  // peer and is tried again on the same schedule.
  private async yieldPeer(peer: PeerState): Promise<void> {
    if (this.stopped || peer.linked) return;
    const resolved = await this.tryResolve(peer.source.host);
    if (this.stopped) return;
    if (resolved === null) {
      this.markFailureAndScheduleRetry(peer);
      return;
    }
    const addrStr = formatUdpAddr(resolved.address, peer.source.port, resolved.family);
    // A re-resolved peer whose address moved releases its old mapping.
    if (peer.resolvedAddr !== null && peer.resolvedAddr !== addrStr) {
      if (this.addrToPeer.get(peer.resolvedAddr) === peer) {
        this.addrToPeer.delete(peer.resolvedAddr);
      }
    }
    peer.resolvedAddr = addrStr;
    this.addrToPeer.set(addrStr, peer);
    peer.yieldCount += 1;
    this.readyQueue.push(peer);
    if (this.discoverWaker !== null) { const w = this.discoverWaker; this.discoverWaker = null; w(); }
    this.markFailureAndScheduleRetry(peer);
  }

  private async tryResolve(host: string): Promise<{ address: string; family: 4 | 6 } | null> {
    try {
      const answers = await this.resolver(host);
      if (answers.length === 0) return null;
      // Pick the first answer; v4 before v6 under the default resolver.
      const first = answers[0]!;
      const family = first.includes(':') ? 6 : 4;
      return { address: first, family };
    } catch {
      return null;
    }
  }

  private markFailureAndScheduleRetry(peer: PeerState): void {
    if (this.stopped || peer.linked) return;
    peer.failures += 1;
    if (peer.retryTimer !== null) {
      clearTimeout(peer.retryTimer);
      this.timers.delete(peer.retryTimer);
    }
    const wait = retryIntervalMs(peer.failures, RETRY_BASE_MS, RETRY_CAP_MS, this.random);
    const t = setTimeout(() => {
      this.timers.delete(t);
      peer.retryTimer = null;
      void this.yieldPeer(peer);
    }, wait);
    this.timers.add(t);
    peer.retryTimer = t;
  }
}
