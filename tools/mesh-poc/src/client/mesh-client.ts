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
import type { Address } from '@libp2p/interface';
import {
  loopbackAddressLast,
  publicAddressesFirst,
  circuitRelayAddressesLast,
} from '@libp2p/utils';
import { generateKeyPair } from '@dagsocial/types';
import type { NetworkProfile } from '@dagsocial/types';
import { resolveTip, DEFAULT_M, DEFAULT_K } from '@dagsocial/nipopow-client';
import type { TipResult } from '@dagsocial/nipopow-client';
import { readCappedJson, HEIGHT_READ_BYTES, isRecord } from '@dagsocial/node-reads';
import type { HttpFetch, NodeError } from '@dagsocial/node-reads';
import { isNonNegSafeInt } from '@dagsocial/node-reads';
import { isHex64 } from '@dagsocial/types';
import { nodeKeyFromKeyPair, notisIdFromPeerId, peerIdFromNotisId } from '../identity.js';
import { meshBaseUrl, idOfMeshUrl } from '../mesh-url.js';
import { meshFetchOverConnection, MeshFetchError } from '../http-fetch.js';
import { MeshConfigError, assertNoDns } from '../config.js';
import {
  NodeList,
  type Anchor,
  type FailureKind,
  type NodeEntry,
} from './node-list.js';
import { tipEvents, type TipEvent } from './tip-events.js';
import { pickServer, type ReadNeed } from './server-pick.js';
import { agreementCounts, type AgreementCounts } from './agreement.js';
import { stunServersFor } from './stun-list.js';
import {
  dhtProtocol,
  CHECK_INTERVAL_MS,
  DIAL_TIMEOUT_MS,
  PEER_DIAL_MIN_MS,
  STUN_SERVERS_MAX,
  type NetworkName,
} from '../protocols.js';
export type { ReadNeed } from './server-pick.js';

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
}): void {
  for (const a of o.anchors) assertNoDns('anchor', a.addrs);
  if (o.seeds !== undefined) {
    for (const s of o.seeds) assertNoDns('seed', s.addrs);
  }
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
  tip: { height: number; hash: string | null } | null;
  /**
   * MESH_INTERFACE → No anchor reached → "The agreement counts" — after
   * each check, how many nodes verified a proof on the tip's chain
   * within its last `k` headers, how many of those are anchors, and
   * how many verified off those headers. `null` before the first
   * check; written from each check's `TipResult` thereafter.
   */
  agreement: AgreementCounts | null;
  nodes: NodeEntry[];
}

export interface MeshClient {
  fetch: HttpFetch;
  /**
   * MESH_INTERFACE → The client's node list → "A routed read goes to a
   * node its need allows" — picks a server from the client's node list
   * by the read's `need` and the fast set, opens the stream on the
   * connection the client already holds there, and sets
   * `state.nodeId / transport / path` to that node and connection.
   * Returns the serving node's id beside the response so the caller
   * can log it without a `state()` race (a check's own tip read may
   * land between two of the caller's reads). Rejects as
   * `MeshFetchError` of kind `transport` and triggers an immediate
   * check when no node is allowed for the need, or when the fetch
   * itself fails.
   */
  read(path: string, need: ReadNeed): Promise<{ response: Response; nodeId: string }>;
  check(): Promise<TipResult>;
  state(): ClientState;
  onState(cb: (s: ClientState) => void): () => void;
  stop(): Promise<void>;
  /**
   * MESH_INTERFACE → NAT → "A client's STUN list comes from the public
   * nodes it holds" — the ICE configuration the webRTC transport reads
   * at each dial, derived from the client's current node entries. Never
   * `undefined` `iceServers` (traps file, "The mesh and its stage"):
   * libp2p falls back to DNS-named defaults when `iceServers` is
   * absent, so the function always answers `{ iceServers: [...] }`,
   * including an empty array when no public node is held.
   */
  iceConfiguration(): { iceServers: RTCIceServer[] };
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
   * MESH_INTERFACE → Discovery → "Seeds" — contacts the client holds without
   * trusting them. A seed is a candidate like any node the DHT finds; no answer
   * from one makes `anchorReached` true. Addresses meet the same refusals as
   * an anchor's.
   */
  seeds?: Anchor[];
  network: NetworkName;
  profile: NetworkProfile;
  /**
   * MESH_INTERFACE → "Two clocks" — the retry timers' clock. The list and
   * every per-entry deadline reads this; a clock that steps never holds a
   * node out or retries it at once. Monotonic (`performance.now`) by
   * default.
   */
  clock?: () => number;
  /**
   * MESH_INTERFACE → "Two clocks" — the verifier's clock. A header's
   * stamp is wall-clock time, so the nipopow proof verifier reads this,
   * never the monotonic one. `Date.now` by default. Scenarios may inject
   * a fake wall clock to assert the handoff.
   */
  wallClock?: () => number;
  /**
   * MESH_INTERFACE → The client's node list → "A routed read goes to a
   * node its need allows" — the fast set is picked at random; this is
   * the random source. `Math.random` by default; test cases inject a
   * sweeping sequence to pin the spread.
   */
  random?: () => number;
  resolve?: typeof resolveTip;
}

export async function startMeshClient(o: StartMeshClientOptions): Promise<MeshClient> {
  // The one check, held by `assertClientConfig`. Runs before any libp2p
  // state exists, so a refused config creates no node.
  assertClientConfig(o);

  const clock = o.clock ?? defaultClock;
  const wallClock = o.wallClock ?? (() => Date.now());
  const resolveFn = o.resolve ?? resolveTip;

  // A fresh Ed25519 key for the client's own peer id — `MESH_INTERFACE →
  // Place in the workspace` names `generateKeyPair()` + `nodeKeyFromKeyPair`.
  const key = nodeKeyFromKeyPair(generateKeyPair());

  // MESH_INTERFACE → NAT — "Only the relayed WebRTC path uses STUN;
  // WebRTC-direct to a public address needs none". `webRTCDirect` is
  // built with an empty iceServers list so js-libp2p does not fall
  // back to its DEFAULT_ICE_SERVERS (`@libp2p/webrtc@7.0.2`'s
  // `src/constants.ts:12`, which `src/private-to-public/utils/
  // get-rtcpeerconnection.ts:147` reads when `rtcConfiguration.
  // iceServers` is undefined).
  //
  // MESH_INTERFACE → NAT → "A client's STUN list comes from the public
  // nodes it holds" — `webRTC`'s `rtcConfiguration` is a function the
  // transport reads on every dial (`@libp2p/webrtc@7.0.2`'s
  // `src/private-to-private/transport.js:100` and `:143`), so the
  // derived list flows into every new peer connection. The holder is
  // reassigned once the client exists; before then, `webRTC` is built
  // but no dial has run, and the fallback `{ iceServers: [] }` keeps
  // libp2p off its DNS-named defaults.
  const iceHolder: { current: () => { iceServers: RTCIceServer[] } } = {
    current: () => ({ iceServers: [] }),
  };
  const transports = [
    webRTCDirect({ rtcConfiguration: { iceServers: [] } }),
    webRTC({ rtcConfiguration: () => iceHolder.current() }),
    circuitRelayTransport(),
    webSockets(),
  ];

  // `MESH_INTERFACE → Discovery` — the client runs the DHT as a client on
  // `/notis/<network>/kad/1.0.0`. `clientMode: true` keeps it off the
  // server side of the handler registration.
  // `MESH_INTERFACE → The client's node list → "The secure WebSocket is
  // the fallback"` — the client gives libp2p its one address order
  // through the dial queue's `addressSorter`; attribution reads the
  // list libp2p reports it dialled, never a re-derivation.
  const node = await createLibp2p({
    privateKey: key.privateKey,
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: { addressSorter: notisAddressSorter },
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ protocol: dhtProtocol(o.network), clientMode: true }),
    },
  });

  const random = o.random ?? Math.random;
  const client = new MeshClientImpl(node, key.notisId, o, clock, wallClock, random, resolveFn);
  // MESH_INTERFACE → NAT → "A client's STUN list comes from the
  // public nodes it holds" — now that the client holds its node list,
  // the holder derives the ICE configuration from it. `webRTC` reads
  // the function on every dial, so the next dial sees the live list.
  iceHolder.current = () => client.iceConfiguration();
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
  private readonly wallClock: () => number;
  private readonly random: () => number;
  /**
   * MESH_INTERFACE → The client's node list → "A check" — "it times
   * each node's proof read; that time is the node's speed until the
   * next check." A speed holds until the next check writes a fresh
   * one, so a check populates a FRESH map while it runs and swaps
   * references when `resolveTip` answers. A routed read reaching the
   * live map during the hold sees the previous check's values.
   */
  private readMsMap: Map<string, number> = new Map();
  /**
   * MESH_INTERFACE → The client's node list — the latest check's
   * `TipResult.nodes[i].behind` per node. Written into a fresh map
   * during the check and swapped in with `readMsMap` when
   * `resolveTip` answers.
   */
  private behindByMap: Map<string, number | null> = new Map();
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
    wallClock: () => number,
    random: () => number,
    resolveFn: typeof resolveTip,
  ) {
    this.libp2p = node;
    this.clock = clock;
    this.wallClock = wallClock;
    this.random = random;
    this.resolveFn = resolveFn;
    this.profile = o.profile;
    this.nodeList = new NodeList(o.anchors, ownId, clock);
    // MESH_INTERFACE → Discovery → "Seeds" — "a seed is a candidate like any
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
      agreement: null,
      nodes: decorateEntries(this.nodeList.entries(), node.getConnections()),
    };
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — the client's reads open their stream on a
    // connection the client already holds for the key, picked by
    // `pickConnectionForRead` (strict: open, direct first, never
    // limited). A read with no suitable connection rejects as a
    // transport failure.
    this.meshFetchFn = meshFetchOverConnection((notisId) =>
      pickConnectionForRead(this.libp2p.getConnections(), toLibp2pPeerIdString(notisId)),
    );
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

  readonly fetch: HttpFetch = (url, init) => this.meshFetchFn(url, init);

  async check(): Promise<TipResult> {
    if (this.checkInProgress) return this.checkInProgress;
    this.checkInProgress = this.runCheck()
      .finally(() => { this.checkInProgress = null; });
    return this.checkInProgress;
  }

  async read(path: string, need: ReadNeed): Promise<{ response: Response; nodeId: string }> {
    // MESH_INTERFACE → The client's node list → "A routed read goes
    // to a node its need allows". `usable` is the strict read pick's
    // non-null result over the same connection list the fetch opens
    // its stream on.
    const connections = this.libp2p.getConnections();
    const entries = this.nodeList.entries();
    const candidates = entries.map((e) => ({
      id: e.notisId,
      status: e.status,
      readMs: this.readMsMap.get(e.notisId) ?? null,
      usable: pickConnectionForRead(connections, toLibp2pPeerIdString(e.notisId)) !== null,
    }));
    const picked = pickServer(candidates, need, this.random);
    if (picked === null) {
      // Trigger a check so the next read may find an allowed node.
      // During a running check (phase 5's own tip read) the trigger
      // is a no-op — `checkInProgress !== null`.
      this.triggerImmediateCheck();
      throw new MeshFetchError('transport', `no node allowed for a ${need} read`);
    }
    const url = meshBaseUrl(picked) + path;
    try {
      const response = await this.meshFetchFn(url, undefined);
      this.state_.nodeId = picked;
      this.refreshTransportPath();
      this.emitStateChange();
      return { response, nodeId: picked };
    } catch (e) {
      // MESH_INTERFACE → The client's node list → "A read opens no
      // connection" — "a failed routed read runs a check at once,
      // which dials from the list".
      this.triggerImmediateCheck();
      throw e;
    }
  }

  state(): ClientState {
    return {
      ...this.state_,
      nodes: decorateEntries(this.nodeList.entries(), this.libp2p.getConnections(), {
        readMs: this.readMsMap,
        behindBy: this.behindByMap,
      }),
    };
  }

  /**
   * MESH_INTERFACE → NAT — "the ICE configuration names no server"
   * when no public node is held. The derivation reads the current
   * (decorated) entries — a node moved to `blacklisted`, a new
   * speed from the latest check, or a hand-added anchor's address
   * all flow in at the next dial. The internal `assertIceServers`
   * holds the derived list to the IP-literal rule as the contract's
   * refusal (a derived server that is not an IP literal cannot
   * happen; the check stays as the contract's refusal).
   */
  iceConfiguration(): { iceServers: RTCIceServer[] } {
    const servers = stunServersFor(this.state().nodes, STUN_SERVERS_MAX);
    assertIceServers(servers);
    return { iceServers: iceConfigurations(servers) };
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
    // Snapshot ok/trailing before the check runs so `lastLeft` names
    // any node that leaves the set — the pre-dial itself may move a
    // node to retry, so the snapshot has to sit before phase 1.
    const okTrailingBefore = new Set<string>();
    for (const e of this.nodeList.entries()) {
      if (e.status === 'ok' || e.status === 'trailing') okTrailingBefore.add(e.notisId);
    }

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
    // candidate here. The fetch is wrapped per URL so `readMs` is the
    // duration from fetch call to end of body — a time to headers
    // alone would miss the transfer. The check's new readings land in
    // a FRESH map so a routed read in flight reads the previous
    // check's speeds (MESH_INTERFACE → The client's node list → "A
    // check"); the swap happens when `resolveTip` answers.
    const afterIds = this.nodeList.candidates();
    const urls = afterIds.map((id) => meshBaseUrl(id));
    const pendingReadMs = new Map<string, number>();
    const pendingBehindBy = new Map<string, number | null>();
    const timedFetch = this.makeTimedFetch(pendingReadMs);
    // MESH_INTERFACE → "Two clocks" — the verifier reads the wall clock
    // (`wallClock`); the node list keeps its monotonic clock for retries.
    // A header's `createdAt` is wall-clock time, so a client whose own
    // monotonic clock reads tens of seconds would see every honest
    // header as decades ahead and refuse the proof under `clock`.
    const result = await this.resolveFn(
      urls,
      DEFAULT_M,
      DEFAULT_K,
      this.profile,
      this.wallClock,
      timedFetch,
    );

    // Phase 3: each node in the result earns an event through `tipEvents`;
    // apply them and record their reasons. Record `behind` per node into
    // the pending map, then swap both maps in at once — the live maps
    // move only when the check's new values are complete. Every URL
    // here is a `meshBaseUrl(id)` from phase 2, so `idOfMeshUrl`
    // throwing would be a bug upstream and the throw propagates.
    for (const node of result.nodes) {
      pendingBehindBy.set(idOfMeshUrl(node.url), node.behind);
    }
    this.readMsMap = pendingReadMs;
    this.behindByMap = pendingBehindBy;
    const nowMs = this.clock();
    for (const ev of tipEvents(result, nowMs)) {
      this.applyEvent(ev);
    }

    // Phase 5: the tip read, through the routed-read path. A `tip`
    // read picks only `ok` nodes; `read` sets `state.nodeId` to the
    // server on success and triggers a check on failure (a no-op
    // during this one). `refreshTip`'s classification applies to the
    // node that read went to.
    try {
      const tipRead = await this.read('/blocks/current', 'tip');
      await this.classifyTipRead(tipRead.response, tipRead.nodeId);
    } catch (e) {
      // Only the read's own rejection — `MeshFetchError`, from a
      // failed or unroutable read — reads as "no tip this round".
      // Anything else came from inside classifyTipRead and is a bug;
      // let it surface instead of hiding under `tip = null`.
      if (e instanceof MeshFetchError) {
        this.state_.tip = null;
      } else {
        throw e;
      }
    }

    // After the check: name any node that was ok/trailing before and
    // is neither after it. One entry — the first found, since the
    // page carries one `lastLeft`.
    let left: string | null = null;
    for (const id of okTrailingBefore) {
      const e = this.nodeList.entry(id);
      if (!e || (e.status !== 'ok' && e.status !== 'trailing')) {
        left = id;
        break;
      }
    }
    if (left !== null) {
      this.state_.lastLeft = {
        nodeId: left,
        reason: this.latestEventReason.get(left) ?? 'left',
      };
    }

    // The agreement counts from the latest check: anchors are read
    // from the current entries so a hand-added trusted node counts.
    const anchorIds = new Set<string>();
    for (const e of this.nodeList.entries()) {
      if (e.anchor) anchorIds.add(e.notisId);
    }
    this.state_.agreement = agreementCounts(result, anchorIds);

    this.state_.anchorReached = this.nodeList.anchorReached();
    this.emitStateChange();
    return result;
  }

  /**
   * MESH_INTERFACE → The client's node list → "A check" — "it times
   * each node's proof read; that time is the node's speed until the
   * next check." The wrapper runs the fetch and reads the body to
   * its end before recording `readMs`, so a time to headers alone
   * does not stand in for the transfer. A failed read leaves
   * `readMs` unset. The target map is passed by the check so a
   * fresh map holds the new readings while the live one still
   * answers routed reads with the previous check's speeds.
   */
  private makeTimedFetch(target: Map<string, number>): HttpFetch {
    return async (url, init) => {
      const startMs = this.clock();
      // The URL is a `meshBaseUrl(id)` + path from `resolveTip`'s
      // candidates — `idOfMeshUrl` throwing here is a bug upstream, so
      // the throw propagates.
      const id = idOfMeshUrl(url);
      const response = await this.fetch(url, init);
      if (!response.body) {
        target.set(id, this.clock() - startMs);
        return response;
      }
      const original = response.body;
      const clock = this.clock;
      const nid = id;
      const wrapped = new ReadableStream<Uint8Array>({
        start(controller) {
          const reader = original.getReader();
          void (async () => {
            try {
              for (;;) {
                const r = await reader.read();
                if (r.done) {
                  target.set(nid, clock() - startMs);
                  controller.close();
                  return;
                }
                controller.enqueue(r.value);
              }
            } catch (e) {
              // Mid-body failure leaves readMs unset — the caller
              // sees the error.
              controller.error(e);
            }
          })();
        },
        cancel(reason) {
          original.cancel(reason).catch(() => undefined);
        },
      });
      return new Response(wrapped, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }

  private applyEvent(ev: TipEvent): void {
    switch (ev.ev) {
      case 'success':
        this.nodeList.success(ev.id);
        this.latestEventReason.set(ev.id, 'success');
        break;
      case 'trailing':
        this.nodeList.trailing(ev.id);
        this.latestEventReason.set(ev.id, 'trailing');
        break;
      case 'behind':
        this.nodeList.behind(ev.id);
        this.latestEventReason.set(ev.id, 'behind');
        break;
      case 'failure':
        this.nodeList.failure(ev.id, ev.kind, ev.message ?? '');
        this.latestEventReason.set(ev.id, ev.message ? `failure: ${ev.kind}: ${ev.message}` : `failure: ${ev.kind}`);
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
    // Plain `/ws` without `/tls/` or `/wss` is a browser's refusal — skip.
    const dialable: string[] = [];
    for (const addr of addrs) {
      if (/\/ws(?:\/|$)/.test(addr) && !/\/wss(?:\/|$)/.test(addr) && !/\/tls\//.test(addr)) {
        this.nodeList.failure(id, 'transport', `plain ws refused: ${addr}`, addr);
        continue;
      }
      dialable.push(addr);
    }
    if (this.stopped) return;
    if (dialable.length === 0) {
      // Nothing dialable: move the node to `retry` so the candidate
      // list drops it until the retry window elapses. Without this,
      // the node stays `new` and the next check hands the resolver
      // the same unreachable URL on every tick.
      const stillHere = this.nodeList.entry(id);
      if (stillHere && stillHere.status !== 'blacklisted') {
        this.nodeList.failure(id, 'transport', 'no dialable address');
        this.latestEventReason.set(id, 'failure: transport: no dialable address');
      }
      return;
    }

    // MESH_INTERFACE → The client's node list → "A node's addresses are
    // dialled as one operation". libp2p's dial queue joins every dial to
    // a peer into the one already in flight, so handing it address-by-
    // address meant a hung first dial held every later one with it; the
    // whole address list goes in one `dial(Multiaddr[])` call. The
    // deadline is `max(addrs.length · DIAL_TIMEOUT_MS, PEER_DIAL_MIN_MS)`
    // (MESH_INTERFACE → The client's node list, the DIAL_TIMEOUT_MS and
    // PEER_DIAL_MIN_MS rows).
    const multiaddrs = dialable.map((addr) => withPeerId(addr, id));
    const wholeDialMs = Math.max(dialable.length * DIAL_TIMEOUT_MS, PEER_DIAL_MIN_MS);
    const signal = AbortSignal.timeout(wholeDialMs);
    // Capture every `dial-queue:calculated-addresses` event libp2p's
    // dial queue fires — one `Address[]` per round of its dial, in the
    // sort order its `addressSorter` applied. The one
    // AggregateError.errors array holds one entry per address the
    // queue actually dialed, in the same positional order as these
    // events; a joined dial (`join()` recipient) only sees events
    // after it joins, so a mismatched count there falls to the
    // node-level failure path.
    const recorder = createDialProgressRecorder();
    try {
      await this.libp2p.dial(multiaddrs, { signal, onProgress: recorder.onProgress });
      return; // success — connection open
    } catch (e) {
      // libp2p throws `AggregateError('All multiaddr dials failed')`
      // when more than one address was dialed and every one errored;
      // when only one address was dialed it throws that single error
      // directly, with no AggregateError wrapper. `unwrapAggregate`
      // reads either shape as a flat list.
      // `attributeAggregateDialErrors` pairs each error with the
      // address libp2p reported at the matching position, so an address
      // libp2p never dialed (no transport, denied by its gater, or
      // deduped) never takes a failure attributed to it. `null` means
      // the reported list and the errors do not account for one
      // another — a joined dial, say — and the caller records a single
      // aggregate failure instead.
      const inner = unwrapAggregate(e);
      const attributed = attributeAggregateDialErrors(recorder.reported, inner);
      if (attributed !== null) {
        for (const row of attributed) {
          if (row.wrongKey !== null) {
            // The anchor's own list carries the addrs without the
            // `/p2p/<peer-id>` tail `withPeerId` adds for the dial;
            // reconcile by matching on the host-port prefix the two
            // forms share. `wrongKey` drops by exact string, so we
            // reconstruct the address from the dialable list.
            const bareAddr = findBareAddrForDialable(dialable, row.addr) ?? row.addr;
            this.nodeList.wrongKey(id, bareAddr, row.wrongKey.answeredPeerIdString);
          }
        }
      }
      const stillHere = this.nodeList.entry(id);
      if (!stillHere || stillHere.status === 'blacklisted') return;
      // MESH_INTERFACE → The client's node list — the wrong-key row:
      // "that address dropped for that key when the dial's failure
      // names it; the entry otherwise unchanged". When attribution
      // landed and every dialled address answered with the wrong key,
      // the dropped addresses carry the diagnostic alone — nothing
      // else moves. An address libp2p passed over (no transport, gated,
      // deduped) never reaches the reported list, so a passed-over
      // address still listed does not block this branch.
      if (attributed !== null && attributed.every((row) => row.wrongKey !== null)) {
        return;
      }
      // The dial failed on a kind that is not just wrong-key — bump the
      // retry counter once and set `lastFailure` to the aggregate's own
      // message. When attribution landed, each non-wrong-key row's
      // own failure also lands in `lastFailures[addr]` so a reader can
      // see which address failed how (MESH_INTERFACE → The client's
      // node list — "An entry keeps its last failure's kind and
      // message").
      if (attributed !== null) {
        for (const row of attributed) {
          if (row.wrongKey !== null) continue; // dropped by wrongKey already
          const bareAddr = findBareAddrForDialable(dialable, row.addr) ?? row.addr;
          this.nodeList.recordAddrFailure(id, bareAddr, row.kind, row.message);
        }
      }
      const kind = classifyDialError(e);
      const message = messageOf(e);
      this.nodeList.failure(id, kind, message);
      this.latestEventReason.set(id, message ? `failure: ${kind}: ${message}` : `failure: ${kind}`);
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
    const { transport, path } = classifyConnectionAddr(ma);
    this.state_.transport = transport;
    this.state_.path = path;
  }

  private refreshTransportPathAndEmit(): void {
    // MESH_INTERFACE → NAT / The client's node list — a connection
    // open/close changes the top-level pair for the latest routed
    // read's node and the entry pair for whichever peer the event
    // names. Both are read lazily from `getConnections()` at the
    // next `state()` call, so an unconditional emit is enough —
    // listeners see the fresh entries and top-level pair without
    // waiting for the next check.
    this.refreshTransportPath();
    this.emitStateChange();
  }

  private firstConnectionFor(notisId: string): Connection | null {
    // Same as `hasOpenConnection`: a bad notisId past `NodeList`'s door
    // is a bug upstream, not a signal to silently return null.
    const expected = toLibp2pPeerIdString(notisId);
    return pickConnectionForLabel(this.libp2p.getConnections(), expected);
  }

  /**
   * MESH_INTERFACE → The node endpoint — the mesh carries no new reader:
   * `/blocks/current` reads through `readCappedJson` under the route's
   * own cap (`HEIGHT_READ_BYTES`, `CONSTANTS → Client reads`). A hostile
   * node that sends more than the cap is cut off at the reader. The
   * result is classified per `MESH_INTERFACE → The client's node list`:
   * a transport or HTTP non-ok result moves the node by `failure`; an
   * answer whose body does not parse, overflows the cap, or parses but
   * is not a tip moves it by `lie` of kind `malformed` — a malformed
   * answer over a link authenticated to the key is the contract's lie
   * row. The classification applies to the node the read went to.
   */
  private async classifyTipRead(response: Response, nodeId: string): Promise<void> {
    const r = await readCappedJson<unknown>(response, HEIGHT_READ_BYTES);
    const nowMs = this.clock();
    if (!r.ok) {
      if (isBodyLevelFailure(r)) {
        this.applyEvent({
          id: nodeId,
          ev: 'lie',
          evidence: { kind: 'malformed', atMs: nowMs, detail: r.body },
        });
        return;
      }
      if (r.status === 0) {
        const kind: FailureKind = r.timedOut === true ? 'timeout' : 'transport';
        this.applyEvent({ id: nodeId, ev: 'failure', kind });
        return;
      }
      this.applyEvent({ id: nodeId, ev: 'failure', kind: 'refused' });
      return;
    }
    if (!isTipShape(r.data)) {
      this.applyEvent({
        id: nodeId,
        ev: 'lie',
        evidence: { kind: 'malformed', atMs: nowMs, detail: 'tip shape invalid' },
      });
      return;
    }
    this.state_.tip = { height: r.data.height, hash: r.data.hash };
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

/**
 * MESH_INTERFACE → The client's node list — the dial multiaddr libp2p
 * reads for a given `notisId`. The LAST `/p2p/<id>` component names
 * the destination (the circuit's target on a relayed address, the
 * node itself on a plain one); a relayed address has a FIRST
 * `/p2p/<relay>` that libp2p routes through, which this function must
 * never touch. Three forms:
 *   - `.../p2p/<relay>/p2p-circuit/p2p/<X>` → rewrite the last `/p2p/`.
 *   - `.../p2p/<X>` (no circuit)            → rewrite the last `/p2p/`.
 *   - `.../p2p-circuit` or no `/p2p/`       → append `/p2p/<target>`.
 *
 * Exported so a case can pin the three forms.
 */
export function withPeerId(addr: string, notisId: string): Multiaddr {
  const peerIdString = toLibp2pPeerIdString(notisId);
  // Rewrite only the trailing `/p2p/<id>` — on a relayed address the
  // FIRST `/p2p/<relay>` is a routing component (libp2p dials the
  // relay through it), and only the LAST one names the destination.
  // When no trailing `/p2p/<id>` is present (either no `/p2p/` at all,
  // or a `/p2p-circuit` with nothing after it), append `/p2p/<target>`.
  const trailing = /\/p2p\/[^/]+$/;
  if (trailing.test(addr)) {
    return multiaddr(addr.replace(trailing, `/p2p/${peerIdString}`));
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

/**
 * `AggregateError` from libp2p's dial queue (one error per address) is
 * flattened here so callers can inspect each cause (noise encryption
 * failure, timeout, transport failure, …) individually. A
 * non-aggregate error reads as a single-element list.
 */
export function unwrapAggregate(e: unknown): unknown[] {
  if (e !== null && typeof e === 'object' && 'errors' in e) {
    const errors = (e as { errors: unknown }).errors;
    if (Array.isArray(errors)) return errors;
  }
  return [e];
}

/**
 * MESH_INTERFACE → The client's node list → "A node's addresses are
 * dialled as one operation" — "When every address fails, each address
 * libp2p reports it dialled has its failure recorded against it,
 * matched in the order libp2p dialled them". Captures every address
 * libp2p's dial queue reports through its
 * `dial-queue:calculated-addresses` progress event — one `Address[]`
 * per round of its dial, in the sort order its `addressSorter`
 * applied — so `attributeAggregateDialErrors` can pair each report
 * with the error at the matching position. A joined dial (a caller
 * that joined an in-flight dial) only hears events after it joined;
 * the mismatched count there falls to the node-level failure path.
 *
 * The event name is the one libp2p emits; a release that renames it
 * breaks the pairing silently. MESH_INTERFACE → Place in the workspace
 * → "libp2p is pinned." — every reach into libp2p's internals is held
 * by a case against the real libp2p, so an upgrade that moves this
 * event name fails its case before it reaches here.
 */
export function createDialProgressRecorder(): {
  readonly reported: readonly string[];
  readonly onProgress: (ev: { type: string; detail: unknown }) => void;
} {
  const reportedMultiaddrs: string[] = [];
  const onProgress = (ev: { type: string; detail: unknown }): void => {
    if (ev.type !== 'dial-queue:calculated-addresses') return;
    const detail = ev.detail;
    if (!Array.isArray(detail)) return;
    for (const a of detail as Address[]) {
      reportedMultiaddrs.push(a.multiaddr.toString());
    }
  };
  return { reported: reportedMultiaddrs, onProgress };
}

/**
 * The dial list the client hands libp2p has a `/p2p/<peer-id>` tail on
 * every address (`withPeerId`). The anchor's own list carries the bare
 * address; `NodeList.wrongKey`/`recordAddrFailure` take the bare form.
 * This helper recovers the bare address matching one dialable address.
 */
function findBareAddrForDialable(bareList: readonly string[], dialableAddr: string): string | null {
  // The dialable address is `<bare>/p2p/<peer-id>` or `<bare-replaced>`:
  // `withPeerId` either appends `/p2p/<peer-id>` or rewrites the
  // existing `/p2p/<X>` tail. Match by prefix up to the final `/p2p/`.
  const idx = dialableAddr.lastIndexOf('/p2p/');
  const prefix = idx >= 0 ? dialableAddr.slice(0, idx) : dialableAddr;
  for (const bare of bareList) {
    const bareIdx = bare.lastIndexOf('/p2p/');
    const barePrefix = bareIdx >= 0 ? bare.slice(0, bareIdx) : bare;
    if (barePrefix === prefix) return bare;
  }
  return null;
}

function classifyDialError(e: unknown): FailureKind {
  const name = (e as { name?: unknown })?.name;
  if (typeof name === 'string' && /TimeoutError|AbortError/i.test(name)) return 'timeout';
  const msg = (e as { message?: unknown })?.message;
  if (typeof msg === 'string' && /timed? ?out/i.test(msg)) return 'timeout';
  return 'transport';
}

/**
 * Describe a throwable. An `Error` reads as `name: message`; a DOM
 * `Event` (no `message`, carries `type`) reads as `Event: <type>`; an
 * `ErrorEvent` (has `message`) reads its message; anything else goes
 * through `String()`. Export so scenarios and tests can call it on any
 * value they catch — a WebSocket's `error` event, say, which `String()`
 * reads as `[object Event]`.
 */
export function messageOf(e: unknown): string {
  if (e === null || e === undefined) return '';
  if (e instanceof Error) {
    const name = typeof e.name === 'string' ? e.name : '';
    const msg = typeof e.message === 'string' ? e.message : '';
    return name && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
  }
  // Event-shaped: has `type`. ErrorEvent-shaped: also has `message`.
  const anyE = e as { type?: unknown; message?: unknown };
  if (typeof anyE.message === 'string' && anyE.message !== '') return anyE.message;
  if (typeof anyE.type === 'string' && anyE.type !== '') return `Event: ${anyE.type}`;
  return String(e);
}

/**
 * MESH_INTERFACE → Transports / NAT — `transport` and `path` of a live
 * connection, read from the multiaddr's protocol components (not
 * substring tests on the string form). The rows:
 *   `/.../webrtc-direct/.../p2p/R/p2p-circuit/webrtc/p2p/X` → `{ webrtc, direct }`
 *   `/.../webrtc-direct/.../p2p/R/p2p-circuit/p2p/X`         → `{ webrtc-direct, relay }`
 *   `/.../tls/ws/p2p/R/p2p-circuit/p2p/X`                     → `{ wss, relay }`
 *   `/.../wss/p2p/R/p2p-circuit/p2p/X`                        → `{ wss, relay }`
 *   `/.../webrtc-direct/.../p2p/X`                            → `{ webrtc-direct, direct }`
 *   `/.../tls/ws/p2p/X`                                       → `{ wss, direct }`
 *   `/.../wss/p2p/X`                                          → `{ wss, direct }`
 *
 * The base transport comes from the components before any `p2p-circuit`:
 * a `webrtc-direct` component names `webrtc-direct`; a `tls` component
 * followed by `ws`, or a single `wss` component, names `wss` (the
 * client dials both forms — `isWSSAddr` reads either). When a
 * `p2p-circuit` is present, a `webrtc` or `webrtc-direct` component
 * after it names the upgraded transport with `path: 'direct'`;
 * otherwise the connection is still relayed through the base transport
 * and the path is `relay`.
 *
 * An address this function cannot name is a thrown error at the call,
 * not a `null` that hides a bug: the connection reached a state the
 * client did not expect, and the caller must surface it.
 */
export function classifyConnectionAddr(ma: string): {
  transport: 'webrtc-direct' | 'webrtc' | 'wss';
  path: 'direct' | 'relay';
} {
  const names = multiaddr(ma).getComponents().map((c) => c.name);
  const circuitIdx = names.indexOf('p2p-circuit');
  const before = circuitIdx === -1 ? names : names.slice(0, circuitIdx);

  let base: 'webrtc-direct' | 'wss' | null = null;
  if (before.includes('webrtc-direct')) base = 'webrtc-direct';
  else if (before.includes('wss')) base = 'wss';
  else {
    const tlsIdx = before.indexOf('tls');
    if (tlsIdx !== -1 && before[tlsIdx + 1] === 'ws') base = 'wss';
  }
  if (base === null) {
    throw new Error(`cannot classify multiaddr base transport: ${ma}`);
  }

  if (circuitIdx === -1) {
    return { transport: base, path: 'direct' };
  }

  const after = names.slice(circuitIdx + 1);
  if (after.includes('webrtc')) {
    return { transport: 'webrtc', path: 'direct' };
  }
  if (after.includes('webrtc-direct')) {
    return { transport: 'webrtc-direct', path: 'direct' };
  }
  return { transport: base, path: 'relay' };
}

/**
 * MESH_INTERFACE → NAT / The client's node list — every `nodes[]`
 * entry carries the pair `{ transport, path }` of its connection, read
 * with the same pick + classify the top-level pair uses
 * (`pickConnectionForLabel` + `classifyConnectionAddr`). An entry
 * with no open connection reads `null` / `null`; the pair for the
 * latest routed read's node agrees with `ClientState.transport` /
 * `ClientState.path`. Pure: the caller passes `getConnections()` in.
 * Called from `state()` and the initial state build, so entries
 * emitted anywhere carry the fresh pair; the connection open/close
 * listener re-emits so a new entry pair reaches listeners without
 * waiting for the next check.
 */
export function decorateEntries(
  entries: readonly NodeEntry[],
  connections: readonly Connection[],
  /**
   * MESH_INTERFACE → The client's node list — "A check" and the
   * behind row: `readMs` and `behindBy` the mesh client holds from
   * the latest check. Absent → both read `null`, so a caller that
   * does not yet carry per-check metrics (the initial state build
   * and the unit cases) stands unchanged.
   */
  metrics?: {
    readonly readMs: ReadonlyMap<string, number>;
    readonly behindBy: ReadonlyMap<string, number | null>;
  },
): NodeEntry[] {
  return entries.map((e) => {
    const expected = toLibp2pPeerIdString(e.notisId);
    const conn = pickConnectionForLabel(connections, expected);
    const base: NodeEntry = conn === null
      ? { ...e, transport: null, path: null }
      : (() => {
        const { transport, path } = classifyConnectionAddr(conn.remoteAddr.toString());
        return { ...e, transport, path };
      })();
    if (metrics === undefined) return base;
    return {
      ...base,
      readMs: metrics.readMs.get(e.notisId) ?? null,
      behindBy: metrics.behindBy.has(e.notisId) ? (metrics.behindBy.get(e.notisId) ?? null) : null,
    };
  });
}

/**
 * MESH_INTERFACE → NAT → "A relay carries data" + The client's node
 * list → "A read opens no connection" — a relayed link is not a
 * limited one; a limited open connection libp2p still holds (a
 * transient reservation, say) is not a path a read opens its stream
 * on. The page's `transport` and `path` name the connection a read
 * would open its stream on when one is available: open connections
 * only, direct first, unlimited preferred. Only when every open
 * connection to the peer is limited does this helper fall back to
 * a limited one — the display shows the one link the client holds,
 * with no read running on it. The read's own pick
 * (`pickConnectionForRead`) refuses that fallback.
 */
export function pickConnectionForLabel(
  connections: readonly Connection[],
  expectedPeerIdString: string,
): Connection | null {
  const open = connections.filter(
    (c) => c.remotePeer.toString() === expectedPeerIdString && c.status === 'open',
  );
  if (open.length === 0) return null;
  const directFirst = open.slice().sort((a, b) => {
    if (a.direct) return -1;
    if (b.direct) return 1;
    return 0;
  });
  const unlimited = directFirst.find((c) => c.limits == null);
  return unlimited ?? directFirst[0] ?? null;
}

/**
 * MESH_INTERFACE → The client's node list → "A read opens no
 * connection" — "an open one, a direct one first, never a limited
 * one". The strict read pick: `pickConnectionForLabel`'s result,
 * refused when it is limited. The shared part — open, right peer,
 * direct first, unlimited preferred — lives in the label pick.
 */
export function pickConnectionForRead(
  connections: readonly Connection[],
  expectedPeerIdString: string,
): Connection | null {
  const c = pickConnectionForLabel(connections, expectedPeerIdString);
  return c !== null && c.limits == null ? c : null;
}

/**
 * MESH_INTERFACE → The client's node list → "A node's addresses are
 * dialled as one operation" — "each address libp2p reports it dialled
 * has its failure recorded against it". A wrong-key answer under a
 * key-authenticated link shows up through two libp2p error types in
 * practice: `UnexpectedPeerError` from the upgrader's own identity check
 * (upgrader.ts), and `EncryptionFailedError` from the noise handshake
 * (`libp2p/src/errors.ts`), which wraps noise's `Payload peer id X does
 * not match expected remote peer id Y` as its message. This function
 * reads both and returns the answered peer-id string; it returns `null`
 * for every other error (a timeout, a plain refusal, …).
 */
export function wrongKeyInfo(e: unknown): { answeredPeerIdString: string } | null {
  if (e === null || e === undefined) return null;
  const named = e as { name?: unknown; message?: unknown };
  const name = typeof named.name === 'string' ? named.name : '';
  // Wrong-key arrives under two names, with two message formats:
  //   - Noise's refusal, both as `EncryptionFailedError` (Node:
  //     libp2p/src/errors.ts wraps noise's throw) and as
  //     `UnexpectedPeerError` (browser WebRTC-direct: libp2p 3.5
  //     surfaces the noise error under this name): `Payload peer id X
  //     does not match expected remote peer id Y`. X is the answered id.
  //   - The upgrader's own peer-id check (libp2p/src/upgrader.ts line
  //     314): `Expected remote peer X but connected to Y`. Y is the
  //     answered id.
  // Either name + either message carries; attribution rides the
  // message pattern.
  if (e instanceof UnexpectedPeerError
      || name === 'UnexpectedPeerError'
      || name === 'EncryptionFailedError') {
    const msg = typeof named.message === 'string' ? named.message : '';
    return readAnsweredFromWrongKeyMessage(msg);
  }
  // Nested aggregate / cause — fall through so a wrapped wrong-key still
  // reads.
  const errors = (e as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const r = wrongKeyInfo(inner);
      if (r !== null) return r;
    }
  }
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) return wrongKeyInfo(cause);
  return null;
}

function readAnsweredFromWrongKeyMessage(msg: string): { answeredPeerIdString: string } | null {
  // Noise's format first — "Payload peer id X does not match expected
  // remote peer id Y". X is the answered id.
  const noise = /Payload peer id\s+([^\s]+)\s+does not match/.exec(msg);
  if (noise) return { answeredPeerIdString: noise[1]! };
  // Upgrader's format — "Expected remote peer X but connected to Y".
  // Y is the answered id.
  const upgrader = /connected to\s+([^\s]+)/.exec(msg);
  if (upgrader) return { answeredPeerIdString: upgrader[1]! };
  return null;
}

/**
 * MESH_INTERFACE → The client's node list → "The secure WebSocket is the
 * fallback" — the client's one address order: WebRTC-direct, then WebRTC
 * signalled over a relay, then the secure WebSocket, then any other
 * address. Addresses of one transport keep libp2p's order among them
 * (loopback last, public first, circuit-relay last). The dial order
 * alone: `createLibp2p`'s `connectionManager.addressSorter` passes
 * this; attribution reads what libp2p reports it dialled, not a
 * client-side re-derivation.
 */
export function notisAddressSorter(a: Address, b: Address): -1 | 0 | 1 {
  const ra = transportRank(a.multiaddr);
  const rb = transportRank(b.multiaddr);
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return (
    loopbackAddressLast(a.multiaddr, b.multiaddr)
    || publicAddressesFirst(a.multiaddr, b.multiaddr)
    || circuitRelayAddressesLast(a.multiaddr, b.multiaddr)
    || 0
  );
}

function transportRank(ma: Multiaddr): number {
  // The multiaddr's string form carries every protocol in order. A
  // relayed path holds `/p2p-circuit/...` midway; a direct path does
  // not.
  const s = ma.toString();
  if (s.includes('/p2p-circuit/')) {
    if (/\/p2p-circuit\/webrtc(?:\/|$)/.test(s)) return 1;
    return 3;
  }
  if (/\/webrtc-direct(?:\/|$)/.test(s)) return 0;
  if (/\/webrtc(?:\/|$)/.test(s)) return 1;
  if (/\/wss(?:\/|$)/.test(s) || /\/tls\/ws(?:\/|$)/.test(s)) return 2;
  return 3;
}

/**
 * MESH_INTERFACE → The client's node list → "A node's addresses are
 * dialled as one operation" — "When every address fails, each address
 * libp2p reports it dialled has its failure recorded against it,
 * matched in the order libp2p dialled them". The reported list arrives
 * through libp2p's `dial-queue:calculated-addresses` progress event —
 * one address list per round of its dial, in the order its
 * `addressSorter` applied; the errors arrive as either a flat throw
 * (one address dialed) or an `AggregateError.errors` (more than one),
 * one entry per dialed address in that same positional order. This
 * helper returns one row per reported address, position-paired with
 * the error at that position: wrong-key (through `wrongKeyInfo`)
 * carries the answered id; every other error carries its message and
 * kind.
 *
 * Returns `null` when `reported.length !== errors.length` — the
 * joined-dial case (a caller joined an in-flight dial and only hears
 * the events after it joined) or an empty report with a single
 * aggregate failure. The caller records a single node-level failure
 * instead.
 */
export interface AttributedDialError {
  addr: string;
  wrongKey: { answeredPeerIdString: string } | null;
  kind: FailureKind;
  message: string;
}
export function attributeAggregateDialErrors(
  reported: readonly string[],
  errors: readonly unknown[],
): AttributedDialError[] | null {
  if (reported.length !== errors.length) return null;
  const out: AttributedDialError[] = [];
  for (let i = 0; i < reported.length; i += 1) {
    const addr = reported[i]!;
    const err = errors[i];
    const wk = wrongKeyInfo(err);
    out.push({
      addr,
      wrongKey: wk,
      kind: classifyDialError(err),
      message: messageOf(err),
    });
  }
  return out;
}

/**
 * MESH_INTERFACE → The node endpoint — `/blocks/current` answers
 * `{ height, hash }`: height a non-negative safe integer, hash either
 * 64 lowercase hex or null (the genesis marker). Mirrors
 * `packages/web/src/api/readers.ts` `readBlockCurrent` so the web
 * client and the mesh client refuse the same shapes.
 *
 * Exported for the mutation case that pins this against the node's
 * live answer.
 */
export function isTipShape(v: unknown): v is { height: number; hash: string | null } {
  if (!isRecord(v)) return false;
  const h = v['height'];
  const hash = v['hash'];
  if (!isNonNegSafeInt(h)) return false;
  if (hash !== null && !isHex64(hash)) return false;
  return true;
}
