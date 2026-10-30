// MESH_INTERFACE → Transports / Discovery / The client's node list / The
// node endpoint — a client is a libp2p host with a fresh Ed25519 key over
// the browser transports alone (`webRTCDirect`, `webRTC`,
// `circuitRelayTransport`, `webSockets` for secure addresses only), the DHT
// as a client on `dhtProtocol(network)`, and no `@libp2p/bootstrap`: it
// dials its anchors itself, per address, with libp2p's own unexpected-peer
// classification routed to `NodeList.wrongKey` and every other dial
// failure to `NodeList.failure`.
//
// Browser-safe (`MESH_INTERFACE → Place in the workspace`): no `node:`
// import, `performance.now()` the default clock, every timer capped at
// `MAX_TIMER_MS` (2^31 − 1).

import { createLibp2p, type Libp2p } from 'libp2p';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { kadDHT } from '@libp2p/kad-dht';
import { http as httpService, type HTTP } from '@libp2p/http';
import { UnexpectedPeerError } from '@libp2p/interface';
import type { Connection, PeerId } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPair } from '@dagsocial/types';
import type { NetworkProfile } from '@dagsocial/types';
import { resolveTip, DEFAULT_M, DEFAULT_K } from '@dagsocial/nipopow-client';
import type { TipResult } from '@dagsocial/nipopow-client';
import type { HttpFetch } from '@dagsocial/node-reads';
import { nodeKeyFromKeyPair, notisIdFromPeerId, peerIdFromNotisId } from '../identity.js';
import { parseMeshUrl, meshBaseUrl, MeshUrlError } from '../mesh-url.js';
import { meshFetch } from '../http-fetch.js';
import { MeshConfigError, assertNoDns } from '../config.js';
import {
  NodeList,
  type Anchor,
  type FailureKind,
  type NodeEntry,
} from './node-list.js';
import { tipEvents, type TipEvent } from './tip-events.js';
import { dhtProtocol, CHECK_INTERVAL_MS, type NetworkName } from '../protocols.js';

/**
 * MESH_INTERFACE → NAT — the client refuses an ICE server named by anything
 * but an IP literal: `stun:<IPv4>:<port>` or `stun:[<IPv6>]:<port>`.
 */
const STUN_IPV4_RE = /^stun:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/;
const STUN_IPV6_RE = /^stun:\[([0-9a-fA-F:]+)\]:(\d{1,5})$/;

// A 32-bit signed timer deadline — `MESH_INTERFACE → Place in the
// workspace`: a cap in both runtimes, since a browser's `setTimeout` reads
// its ms as a signed int.
const MAX_TIMER_MS = 0x7fff_ffff;

// A pre-dial deadline — the longest the client waits for a dial to
// finish before giving up on an address. Local-network WebRTC-direct
// handshakes land in well under a second; the ceiling is here only to
// keep a UDP endpoint that no one answers from stalling a check (no
// equivalent of TCP's "connection refused" for UDP).
const DIAL_TIMEOUT_MS = 3_000;

function cappedTimerMs(ms: number): number {
  return Math.max(0, Math.min(MAX_TIMER_MS, ms | 0));
}

function assertIceServers(stunServers: readonly string[]): void {
  for (const s of stunServers) {
    const ipv4 = STUN_IPV4_RE.exec(s);
    if (ipv4) {
      const [, host, portStr] = ipv4;
      if (isValidIPv4(host!) && isValidPort(portStr!)) continue;
    }
    const ipv6 = STUN_IPV6_RE.exec(s);
    if (ipv6) {
      const [, host, portStr] = ipv6;
      if (isValidIPv6(host!) && isValidPort(portStr!)) continue;
    }
    throw new MeshConfigError(
      `ICE server refused: ${JSON.stringify(s)} is not stun:<IPv4>:<port> or stun:[<IPv6>]:<port>`,
    );
  }
}

function isValidIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isValidIPv6(s: string): boolean {
  // A permissive IPv6 shape: colons and hex, at least one colon. The
  // detailed check belongs to the dialler; this is only a hostname/not-IP
  // sanity gate.
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
  if (!s.includes(':')) return false;
  return true;
}

function isValidPort(s: string): boolean {
  if (!/^\d{1,5}$/.test(s)) return false;
  const n = Number(s);
  return n >= 0 && n <= 65_535;
}

export interface ClientState {
  nodeId: string | null;
  transport: 'webrtc-direct' | 'webrtc' | 'wss' | null;
  path: 'direct' | 'relay' | null;
  lastLeft: { nodeId: string; reason: string } | null;
  anchorReached: boolean;
  tip: { height: number; hash: string } | null;
  nodes: NodeEntry[];
}

export interface MeshClient {
  fetch: HttpFetch;
  check(): Promise<TipResult>;
  state(): ClientState;
  onState(cb: (s: ClientState) => void): () => void;
  stop(): Promise<void>;
}

export interface StartMeshClientOptions {
  anchors: Anchor[];
  network: NetworkName;
  profile: NetworkProfile;
  stunServers: string[];
  clock?: () => number;
  resolve?: typeof resolveTip;
}

export async function startMeshClient(o: StartMeshClientOptions): Promise<MeshClient> {
  // Phase 1: pure refusals, no socket or libp2p state touched.
  for (const a of o.anchors) assertNoDns('anchor', a.addrs);
  assertIceServers(o.stunServers);

  const clock = o.clock ?? defaultClock;
  const resolveFn = o.resolve ?? resolveTip;

  // A fresh Ed25519 key for the client's own peer id — `MESH_INTERFACE →
  // Place in the workspace` names `generateKeyPair()` + `nodeKeyFromKeyPair`.
  const key = nodeKeyFromKeyPair(generateKeyPair());

  const transports = [
    webRTCDirect(),
    webRTC({ rtcConfiguration: { iceServers: iceConfigurations(o.stunServers) } }),
    circuitRelayTransport(),
    webSockets(),
  ];

  // `MESH_INTERFACE → Discovery` — the client runs the DHT as a client on
  // `/notis/<network>/kad/1.0.0`. `clientMode: true` keeps it off the
  // server side of the handler registration.
  const node = await createLibp2p({
    privateKey: key.privateKey,
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      http: httpService(),
      dht: kadDHT({ protocol: dhtProtocol(o.network), clientMode: true }),
    },
  });
  const typed = node as unknown as Libp2p<{ http: HTTP }>;

  const client = new MeshClientImpl(typed, key.notisId, o, clock, resolveFn);
  client.start();
  return client;
}

function defaultClock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function iceConfigurations(stunServers: readonly string[]): RTCIceServer[] {
  return stunServers.map((url) => ({ urls: url }));
}

class MeshClientImpl implements MeshClient {
  private readonly node: Libp2p<{ http: HTTP }>;
  private readonly clock: () => number;
  private readonly resolveFn: typeof resolveTip;
  private readonly profile: NetworkProfile;
  private readonly nodeList: NodeList;
  private readonly listeners = new Set<(s: ClientState) => void>();
  private readonly state_: ClientState;
  private readonly meshFetchFn: HttpFetch;
  private readonly latestEventReason = new Map<string, string>();
  private checkInProgress: Promise<TipResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly onDiscovery: (evt: CustomEvent<{ id: PeerId; multiaddrs: Multiaddr[] }>) => void;
  private readonly onConnectionOpen: () => void;
  private readonly onConnectionClose: () => void;

  constructor(
    node: Libp2p<{ http: HTTP }>,
    ownId: string,
    o: StartMeshClientOptions,
    clock: () => number,
    resolveFn: typeof resolveTip,
  ) {
    this.node = node;
    this.clock = clock;
    this.resolveFn = resolveFn;
    this.profile = o.profile;
    this.nodeList = new NodeList(o.anchors, ownId, clock);
    this.state_ = {
      nodeId: null,
      transport: null,
      path: null,
      lastLeft: null,
      anchorReached: false,
      tip: null,
      nodes: this.nodeList.entries(),
    };
    this.meshFetchFn = meshFetch(node);
    this.onDiscovery = (evt): void => this.handleDiscovery(evt.detail);
    this.onConnectionOpen = (): void => this.refreshTransportPathAndEmit();
    this.onConnectionClose = (): void => this.refreshTransportPathAndEmit();
  }

  start(): void {
    // The DHT reports a peer the first time it hears of one; every one
    // becomes a `NodeList` entry before any later event can name it
    // (MESH_INTERFACE → Discovery).
    this.node.addEventListener('peer:discovery', this.onDiscovery);
    this.node.addEventListener('connection:open', this.onConnectionOpen);
    this.node.addEventListener('connection:close', this.onConnectionClose);
    // The first check runs at start (MESH_INTERFACE → The client's node
    // list → "A check runs at start"); a failure here does not take the
    // client down, it is reflected in the state and the next check comes
    // on the ordinary cadence.
    this.scheduleNextCheck(0);
  }

  readonly fetch: HttpFetch = async (url, init) => {
    let parsed: { notisId: string } | null = null;
    try {
      parsed = parseMeshUrl(url);
    } catch (e) {
      if (!(e instanceof MeshUrlError)) throw e;
      // Falls through to `meshFetchFn`, which rejects with its own
      // `MeshFetchError` of kind 'url'.
    }
    try {
      return await this.meshFetchFn(url, init);
    } catch (e) {
      // MESH_INTERFACE → The client's node list — a failed fetch to the
      // node in use triggers an immediate check (one at a time, so a
      // trigger during a check is that check).
      if (parsed !== null && parsed.notisId === this.state_.nodeId) {
        this.triggerImmediateCheck();
      }
      throw e;
    }
  };

  async check(): Promise<TipResult> {
    if (this.checkInProgress) return this.checkInProgress;
    this.checkInProgress = this.runCheck()
      .finally(() => { this.checkInProgress = null; });
    return this.checkInProgress;
  }

  state(): ClientState {
    return {
      ...this.state_,
      nodes: this.nodeList.entries(),
    };
  }

  onState(cb: (s: ClientState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Any in-flight check must finish before `node.stop()` tears libp2p
    // down: a webRTC dial still running when the native transport
    // closes crashes node-datachannel (its callback runs on a thread
    // without a V8 HandleScope).
    if (this.checkInProgress) {
      try { await this.checkInProgress; } catch { /* already surfaced to its caller */ }
    }
    this.node.removeEventListener('peer:discovery', this.onDiscovery);
    this.node.removeEventListener('connection:open', this.onConnectionOpen);
    this.node.removeEventListener('connection:close', this.onConnectionClose);
    await this.node.stop();
  }

  private triggerImmediateCheck(): void {
    if (this.stopped) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNextCheck(0);
  }

  private scheduleNextCheck(afterMs: number): void {
    if (this.stopped) return;
    const ms = cappedTimerMs(afterMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check()
        .catch(() => undefined)
        .finally(() => this.scheduleNextCheck(CHECK_INTERVAL_MS));
    }, ms);
  }

  private async runCheck(): Promise<TipResult> {
    // Phase 1: pre-dial every candidate the client has not already
    // connected to, so libp2p's unexpected-peer failure is caught per
    // address instead of folded into a generic transport failure.
    const beforeIds = this.nodeList.candidates();
    for (const id of beforeIds) {
      if (this.stopped) break;
      if (this.hasOpenConnection(id)) continue;
      await this.dialByAddresses(id);
    }

    // Phase 2: the resolve seam reads whatever candidates remain. A node
    // whose pre-dial failed has moved to `retry` and will no longer be a
    // candidate here.
    const afterIds = this.nodeList.candidates();
    const urls = afterIds.map((id) => meshBaseUrl(id));
    const result = await this.resolveFn(
      urls,
      DEFAULT_M,
      DEFAULT_K,
      this.profile,
      this.clock,
      this.fetch,
    );

    // Phase 3: each node in the result earns an event through `tipEvents`;
    // apply them and record their reasons so `lastLeft` can name the one
    // that moved the node in use.
    const nowMs = this.clock();
    for (const ev of tipEvents(result, nowMs)) {
      this.applyEvent(ev);
    }

    // Phase 4: the node in use is the first candidate after this check.
    const oldInUse = this.state_.nodeId;
    const newInUse = this.nodeList.candidates()[0] ?? null;
    if (newInUse !== oldInUse) {
      this.state_.lastLeft = oldInUse !== null
        ? { nodeId: oldInUse, reason: this.latestEventReason.get(oldInUse) ?? 'moved' }
        : null;
      this.state_.nodeId = newInUse;
      this.refreshTransportPath();
    } else if (oldInUse !== null) {
      // The transport may still have changed (relay to direct, say) under
      // a stable node id — refresh so `state()` is current.
      this.refreshTransportPath();
    }

    // Phase 5: the node in use's own tip, read through `/blocks/current`.
    // A failed read moves nothing: the open connection stays, the next
    // check runs on the ordinary cadence.
    if (newInUse !== null) {
      await this.refreshTip(newInUse);
    } else {
      this.state_.tip = null;
    }

    this.state_.anchorReached = this.nodeList.anchorReached();
    this.emitStateChange();
    return result;
  }

  private applyEvent(ev: TipEvent): void {
    switch (ev.ev) {
      case 'success':
        this.nodeList.success(ev.id);
        this.latestEventReason.set(ev.id, 'success');
        break;
      case 'behind':
        this.nodeList.behind(ev.id);
        this.latestEventReason.set(ev.id, 'behind');
        break;
      case 'failure':
        this.nodeList.failure(ev.id, ev.kind);
        this.latestEventReason.set(ev.id, `failure: ${ev.kind}`);
        break;
      case 'lie':
        this.nodeList.lie(ev.id, ev.evidence);
        this.latestEventReason.set(ev.id, `lie: ${ev.evidence.kind}`);
        break;
    }
  }

  private async dialByAddresses(id: string): Promise<void> {
    const entry = this.nodeList.entry(id);
    if (!entry) return;
    const addrs = [...entry.addrs];
    let lastKind: FailureKind = 'transport';
    for (const addr of addrs) {
      if (this.stopped) return;
      // Secure WebSockets alone (`MESH_INTERFACE → Transports`): a plain
      // `/ws` address with no `/tls/` or `/wss` cover is skipped and
      // treated as a transport failure for this address. The browser
      // would refuse it too under its mixed-content policy.
      if (/\/ws(?:\/|$)/.test(addr) && !/\/wss(?:\/|$)/.test(addr) && !/\/tls\//.test(addr)) {
        lastKind = 'transport';
        continue;
      }
      try {
        const ma = withPeerId(addr, id);
        // CONSTANTS → Client reads — a per-dial deadline keeps a stopped
        // peer from stalling the pre-dial pass: a WebRTC-direct dial that
        // never answers would otherwise wait for libp2p's own longer
        // ceiling. REQUEST_TIMEOUT_MS matches the reader's deadline the
        // client holds every HTTP answer to.
        const signal = AbortSignal.timeout(DIAL_TIMEOUT_MS);
        await this.node.dial(ma, { signal });
        return; // success — connection open
      } catch (e) {
        if (isUnexpectedPeer(e)) {
          this.nodeList.wrongKey(id, addr, answeredIdOf(e));
          continue;
        }
        lastKind = classifyDialError(e);
        // continue to the next address
      }
    }
    // Every address refused — the brief maps this to `failure(id, kind)`.
    // The last kind seen is the one that reaches the list: the brief says
    // `'timeout'` for a dial that hit its deadline, `'transport'` otherwise.
    const stillHere = this.nodeList.entry(id);
    if (stillHere && stillHere.status !== 'blacklisted') {
      this.nodeList.failure(id, lastKind);
      this.latestEventReason.set(id, `failure: ${lastKind}`);
    }
  }

  private hasOpenConnection(notisId: string): boolean {
    try {
      const expected = toLibp2pPeerIdString(notisId);
      for (const c of this.node.getConnections()) {
        if (c.remotePeer.toString() === expected) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private refreshTransportPath(): void {
    const inUse = this.state_.nodeId;
    if (inUse === null) {
      this.state_.transport = null;
      this.state_.path = null;
      return;
    }
    const conn = this.firstConnectionFor(inUse);
    if (!conn) {
      this.state_.transport = null;
      this.state_.path = null;
      return;
    }
    const ma = conn.remoteAddr.toString();
    this.state_.transport = transportOf(ma);
    this.state_.path = pathOf(ma);
  }

  private refreshTransportPathAndEmit(): void {
    const before = { transport: this.state_.transport, path: this.state_.path };
    this.refreshTransportPath();
    if (before.transport !== this.state_.transport || before.path !== this.state_.path) {
      this.emitStateChange();
    }
  }

  private firstConnectionFor(notisId: string): Connection | null {
    let expected: string;
    try {
      expected = toLibp2pPeerIdString(notisId);
    } catch {
      return null;
    }
    for (const c of this.node.getConnections()) {
      if (c.remotePeer.toString() === expected) return c;
    }
    return null;
  }

  private async refreshTip(inUseId: string): Promise<void> {
    try {
      const res = await this.meshFetchFn(meshBaseUrl(inUseId) + '/blocks/current');
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      if (isTipShape(body)) {
        this.state_.tip = { height: body.height, hash: body.id };
      }
    } catch {
      // The read's own failure is recorded through the fetch wrapper, if
      // the caller used it; here we just leave the previous tip in place.
    }
  }

  private handleDiscovery(detail: { id: PeerId; multiaddrs: Multiaddr[] }): void {
    let id: string;
    try {
      id = notisIdFromPeerId(detail.id);
    } catch {
      // Not a Notis-shaped peer id (secp256k1, say): ignore. The DHT
      // walks only Notis peers in principle, so this guards against
      // defensive misreads.
      return;
    }
    const addrs = detail.multiaddrs.map((ma) => ma.toString());
    this.nodeList.add(id, addrs);
  }

  private emitStateChange(): void {
    const snapshot = this.state();
    for (const cb of [...this.listeners]) {
      try {
        cb(snapshot);
      } catch {
        // A listener's own throw must not take the client down: the state
        // write already happened and the other listeners still deserve to
        // hear.
      }
    }
  }
}

function withPeerId(addr: string, notisId: string): Multiaddr {
  const peerIdString = toLibp2pPeerIdString(notisId);
  // An anchor may list an address with a `/p2p/<id>` tail — the id libp2p
  // will verify. For a dial on behalf of `notisId`, that tail must name
  // `notisId`'s peer id, so a server at the address with any other key
  // fails libp2p's own unexpected-peer check (MESH_INTERFACE → The
  // client's node list). The tail is rewritten in place when any
  // `/p2p/<X>` is present; a bare address has one appended.
  if (/\/p2p\/[^/]+/.test(addr)) {
    return multiaddr(addr.replace(/\/p2p\/[^/]+/, `/p2p/${peerIdString}`));
  }
  return multiaddr(`${addr}/p2p/${peerIdString}`);
}

// MESH_INTERFACE → Identity — the libp2p peer id string that corresponds
// to a Notis id, cached because `getConnections` compares peer id strings
// on every pre-dial loop. A single `peerIdFromNotisId` call is cheap, but
// the cache keeps a run of candidates from paying N × BLAKE2b.
const peerIdStringCache = new Map<string, string>();
function toLibp2pPeerIdString(notisId: string): string {
  const cached = peerIdStringCache.get(notisId);
  if (cached !== undefined) return cached;
  const pid = peerIdFromNotisId(notisId);
  const s = pid.toString();
  peerIdStringCache.set(notisId, s);
  return s;
}

function isUnexpectedPeer(e: unknown): boolean {
  if (e instanceof UnexpectedPeerError) return true;
  const named = e as { name?: unknown } | null;
  if (named !== null && typeof named === 'object' && named.name === 'UnexpectedPeerError') return true;
  // libp2p wraps the inner error for a multi-address dial — check nested
  // errors by name.
  const errors = (e as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      if (isUnexpectedPeer(inner)) return true;
    }
  }
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) return isUnexpectedPeer(cause);
  return false;
}

function answeredIdOf(e: unknown): string | null {
  const msg = (e as { message?: unknown })?.message;
  if (typeof msg !== 'string') return null;
  // The thrown message reads "Expected remote peer X but connected to Y"
  // (libp2p's upgrader).
  const m = /connected to\s+([^\s]+)/.exec(msg);
  if (!m) return null;
  try {
    const pid = peerIdFromString(m[1]!);
    return notisIdFromPeerId(pid);
  } catch {
    return null;
  }
}

function classifyDialError(e: unknown): FailureKind {
  const name = (e as { name?: unknown })?.name;
  if (typeof name === 'string' && /TimeoutError|AbortError/i.test(name)) return 'timeout';
  const msg = (e as { message?: unknown })?.message;
  if (typeof msg === 'string' && /timed? ?out/i.test(msg)) return 'timeout';
  return 'transport';
}

function transportOf(ma: string): 'webrtc-direct' | 'webrtc' | 'wss' | null {
  if (ma.includes('/webrtc-direct/')) return 'webrtc-direct';
  if (ma.includes('/webrtc/') || ma.includes('/webrtc')) {
    if (ma.includes('/webrtc-direct')) return 'webrtc-direct';
    if (/\/webrtc(?!-direct)/.test(ma)) return 'webrtc';
  }
  if (ma.includes('/wss') || ma.includes('/tls/ws')) return 'wss';
  return null;
}

function pathOf(ma: string): 'direct' | 'relay' | null {
  if (ma.includes('/p2p-circuit')) return 'relay';
  return 'direct';
}

function isTipShape(v: unknown): v is { height: number; id: string } {
  if (v === null || typeof v !== 'object') return false;
  const h = (v as { height?: unknown }).height;
  const id = (v as { id?: unknown }).id;
  return typeof h === 'number' && typeof id === 'string';
}
