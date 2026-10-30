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
import { UnexpectedPeerError } from '@libp2p/interface';
import type { Connection, PeerId } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPair } from '@dagsocial/types';
import type { NetworkProfile } from '@dagsocial/types';
import { resolveTip, DEFAULT_M, DEFAULT_K } from '@dagsocial/nipopow-client';
import type { TipResult } from '@dagsocial/nipopow-client';
import { fetchJson, HEIGHT_READ_BYTES } from '@dagsocial/node-reads';
import type { HttpFetch, NodeError } from '@dagsocial/node-reads';
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
import {
  dhtProtocol,
  CHECK_INTERVAL_MS,
  DIAL_TIMEOUT_MS,
  type NetworkName,
} from '../protocols.js';

/**
 * MESH_INTERFACE → NAT — the client refuses an ICE server named by anything
 * but an IP literal: `stun:<IPv4>:<port>` or `stun:[<IPv6>]:<port>`.
 */
const STUN_IPV4_RE = /^stun:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/;
const STUN_IPV6_RE = /^stun:\[([0-9a-fA-F:]+)\]:(\d{1,5})$/;

// A 32-bit signed timer deadline — `MESH_INTERFACE → Place in the
// workspace`: a cap in both runtimes, since a browser's `setTimeout` reads
// its ms as a signed int.
export const MAX_TIMER_MS = 0x7fff_ffff;

// Clamp a `setTimeout` interval into the 32-bit signed range: a value past
// `MAX_TIMER_MS` makes `setTimeout` fire at once in a browser and warns in
// Node, and a negative one does the same. `NaN` folds to 0; `+Infinity`
// to the cap; a fraction floors.
export function cappedTimerMs(ms: number): number {
  if (Number.isNaN(ms) || ms < 0) return 0;
  if (ms > MAX_TIMER_MS) return MAX_TIMER_MS;
  return Math.floor(ms);
}

// `readCappedJson`'s body sentinels (`@dagsocial/node-reads`'s `http.ts`):
// an answer over the route's cap, or one whose body does not parse as JSON,
// is a body-level failure under a key-authenticated link, and the lie row
// of `MESH_INTERFACE → The client's node list` is what the client moves
// the node by. Every other non-ok NodeResult is HTTP-level and reads as a
// failure.
const BODY_OVER_CAP = 'body over ';
const BODY_UNPARSEABLE = 'unparseable body:';

/**
 * MESH_INTERFACE → Discovery / NAT — the client's config refusals as a pure,
 * synchronous function. One check, called from `startMeshClient` as its first
 * statement and reused by any caller (such as the page) that wants to refuse
 * a config before starting a libp2p node. A `MeshConfigError` is thrown for
 * a `/dns4/`, `/dns6/`, `/dnsaddr/` anchor or seed address, or an ICE server
 * that is not `stun:<IPv4>:<port>` / `stun:[<IPv6>]:<port>`.
 */
export function assertClientConfig(o: {
  anchors: readonly Anchor[];
  seeds?: readonly Anchor[];
  stunServers: readonly string[];
}): void {
  for (const a of o.anchors) assertNoDns('anchor', a.addrs);
  if (o.seeds !== undefined) {
    for (const s of o.seeds) assertNoDns('seed', s.addrs);
  }
  assertIceServers(o.stunServers);
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
  /**
   * Test seam: the libp2p node under the client. The suite dispatches a
   * `peer:discovery` event here so the "a discovered node is added before
   * any event names it" case can hold its guard without a three-node DHT
   * walk (MESH_INTERFACE → Discovery). Not meant for ordinary callers.
   */
  readonly libp2p: Libp2p;
}

export interface StartMeshClientOptions {
  anchors: Anchor[];
  /**
   * MESH_INTERFACE → Discovery → Seeds — contacts the client holds without
   * trusting them. A seed is a candidate like any node the DHT finds; no answer
   * from one makes `anchorReached` true. Addresses meet the same refusals as
   * an anchor's.
   */
  seeds?: Anchor[];
  network: NetworkName;
  profile: NetworkProfile;
  stunServers: string[];
  clock?: () => number;
  resolve?: typeof resolveTip;
}

export async function startMeshClient(o: StartMeshClientOptions): Promise<MeshClient> {
  // The one check, held by `assertClientConfig`. Runs before any libp2p
  // state exists, so a refused config creates no node.
  assertClientConfig(o);

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
      dht: kadDHT({ protocol: dhtProtocol(o.network), clientMode: true }),
    },
  });

  const client = new MeshClientImpl(node, key.notisId, o, clock, resolveFn);
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
  readonly libp2p: Libp2p;
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
    node: Libp2p,
    ownId: string,
    o: StartMeshClientOptions,
    clock: () => number,
    resolveFn: typeof resolveTip,
  ) {
    this.libp2p = node;
    this.clock = clock;
    this.resolveFn = resolveFn;
    this.profile = o.profile;
    this.nodeList = new NodeList(o.anchors, ownId, clock);
    // MESH_INTERFACE → Discovery → Seeds — "a seed is a candidate like any
    // node the DHT finds". Added before the first check, so a seed is in
    // the candidates `resolveTip` reads from the start; `NodeList.add`
    // records them as non-anchor entries, so a seed's success leaves
    // `anchorReached` false. The client's own key is dropped the same way
    // an anchor list's own-key entry is.
    if (o.seeds !== undefined) {
      for (const s of o.seeds) {
        if (s.notisId === ownId) continue;
        this.nodeList.add(s.notisId, s.addrs);
      }
    }
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
    this.libp2p.addEventListener('peer:discovery', this.onDiscovery);
    this.libp2p.addEventListener('connection:open', this.onConnectionOpen);
    this.libp2p.addEventListener('connection:close', this.onConnectionClose);
    // The first check runs at start (MESH_INTERFACE → The client's node
    // list → "A check"); a failure here does not take the client down, it
    // is reflected in the state and the next check comes on the ordinary
    // cadence.
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
    this.libp2p.removeEventListener('peer:discovery', this.onDiscovery);
    this.libp2p.removeEventListener('connection:open', this.onConnectionOpen);
    this.libp2p.removeEventListener('connection:close', this.onConnectionClose);
    await this.libp2p.stop();
  }

  private triggerImmediateCheck(): void {
    if (this.stopped) return;
    // MESH_INTERFACE → The client's node list → "A check" — "one check at
    // a time: a trigger during a check is that check." The ongoing check
    // is the response; a trigger during it adds no second check.
    if (this.checkInProgress !== null) return;
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
        .catch((e) => {
          // A check that threw is a bug — `runCheck` catches each phase's
          // own failures. Log it and carry on: the periodic cadence keeps
          // the client alive, and the next check sees the current state.
          // eslint-disable-next-line no-console
          console.error('[mesh-client] check threw', e);
        })
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
        // MESH_INTERFACE → The client's node list — `DIAL_TIMEOUT_MS` is
        // the longest one dial of one address waits; past it the address
        // counts as a timeout and the dialler moves to the next.
        const signal = AbortSignal.timeout(DIAL_TIMEOUT_MS);
        await this.libp2p.dial(ma, { signal });
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
    // Every address refused: the node moves by `failure(id, kind)` on the last
    // kind seen — `'timeout'` for a dial that hit its deadline, `'transport'`
    // for any other transport-level failure, both the `retry` row of
    // `MESH_INTERFACE → The client's node list`.
    const stillHere = this.nodeList.entry(id);
    if (stillHere && stillHere.status !== 'blacklisted') {
      this.nodeList.failure(id, lastKind);
      this.latestEventReason.set(id, `failure: ${lastKind}`);
    }
  }

  private hasOpenConnection(notisId: string): boolean {
    // `toLibp2pPeerIdString` throws only on a bad notisId; the ids here
    // come from `NodeList`, which refuses one at the door — so a throw
    // means a bug upstream and must not be swallowed.
    const expected = toLibp2pPeerIdString(notisId);
    for (const c of this.libp2p.getConnections()) {
      if (c.remotePeer.toString() === expected) return true;
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
    // Same as `hasOpenConnection`: a bad notisId past `NodeList`'s door
    // is a bug upstream, not a signal to silently return null.
    const expected = toLibp2pPeerIdString(notisId);
    for (const c of this.libp2p.getConnections()) {
      if (c.remotePeer.toString() === expected) return c;
    }
    return null;
  }

  private async refreshTip(inUseId: string): Promise<void> {
    // MESH_INTERFACE → The node endpoint — the mesh carries no new reader:
    // `/blocks/current` reads through `fetchJson` under the route's own cap
    // (`HEIGHT_READ_BYTES`, `CONSTANTS → Client reads`). A hostile node that
    // sends more than the cap is cut off at the reader. The result is
    // classified per `MESH_INTERFACE → The client's node list`: a transport
    // or HTTP non-ok result moves the node by `failure`; an answer whose
    // body does not parse, overflows the cap, or parses but is not a tip
    // moves it by `lie` of kind `malformed` — a malformed answer over a
    // link authenticated to the key is the contract's lie row.
    const url = meshBaseUrl(inUseId) + '/blocks/current';
    const r = await fetchJson<unknown>(this.fetch, url, HEIGHT_READ_BYTES);
    const nowMs = this.clock();
    if (!r.ok) {
      if (isBodyLevelFailure(r)) {
        this.applyEvent({
          id: inUseId,
          ev: 'lie',
          evidence: { kind: 'malformed', atMs: nowMs, detail: r.body },
        });
        return;
      }
      if (r.status === 0) {
        const kind: FailureKind = r.timedOut === true ? 'timeout' : 'transport';
        this.applyEvent({ id: inUseId, ev: 'failure', kind });
        return;
      }
      this.applyEvent({ id: inUseId, ev: 'failure', kind: 'refused' });
      return;
    }
    if (!isTipShape(r.data)) {
      this.applyEvent({
        id: inUseId,
        ev: 'lie',
        evidence: { kind: 'malformed', atMs: nowMs, detail: 'tip shape invalid' },
      });
      return;
    }
    this.state_.tip = { height: r.data.height, hash: r.data.id };
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
      } catch (e) {
        // A listener's own throw must not take the client down nor silence
        // the next one — log it (a listener that throws is a bug) and
        // carry on. The state write already happened.
        // eslint-disable-next-line no-console
        console.error('[mesh-client] onState listener threw', e);
      }
    }
  }
}

function isBodyLevelFailure(r: NodeError): boolean {
  return r.body.startsWith(BODY_OVER_CAP) || r.body.startsWith(BODY_UNPARSEABLE);
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
