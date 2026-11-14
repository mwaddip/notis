// MESH_INTERFACE → Transports / Discovery / The client's node list / The
// node endpoint — a client is a libp2p host with a fresh Ed25519 key over
// the browser transports alone (`webRTCDirect`, `webRTC`,
// `circuitRelayTransport`, `webSockets` for secure addresses only), the DHT
// as a client on `dhtProtocol(network)`, and no `@libp2p/bootstrap`: it
// dials its first-contact nodes itself, per address, with libp2p's own unexpected-peer
// classification routed to `NodeList.wrongKey` and every other dial
// failure to `NodeList.failure`.
//
// Browser-safe (`MESH_INTERFACE → Place in the workspace`): no `node:`
// import, `performance.now()` the default clock, every timer capped at
// `MAX_TIMER_MS` (2^31 − 1).

import { createLibp2p, type Libp2p } from 'libp2p';
import { TopicValidatorResult } from '@libp2p/gossipsub';
import type { GossipSub } from '@libp2p/gossipsub';
import { UnexpectedPeerError } from '@libp2p/interface';
import type { Connection, PeerId } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { Address } from '@libp2p/interface';
import {
  isPrivate,
  loopbackAddressLast,
  publicAddressesFirst,
  circuitRelayAddressesLast,
} from '@libp2p/utils';
import { peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPair, PROTOCOL_VERSION } from '@dagsocial/types';
import type { NetworkProfile, OrderingBlock } from '@dagsocial/types';
import { resolveTip, DEFAULT_M, DEFAULT_K, verifierProfile } from '@dagsocial/nipopow-client';
import type { Anchor } from '@dagsocial/nipopow-client';
import { decodeNipopowProof, encodeNipopowProof, verifyProof } from '@dagsocial/nipopow';
import type { NipopowProof, VerifyResult } from '@dagsocial/nipopow';
import { judgeByMemory, nodesToRemember, forkKey } from './memory.js';
import { compareProofs } from '@dagsocial/nipopow';
import type { MemorySnapshot } from './memory-store.js';
import { REMEMBERED_NODES_MAX, ANSWERED_FORKS_MAX } from './protocols.js';
import { readCappedJson, HEIGHT_READ_BYTES, isRecord } from '@dagsocial/node-reads';
import type { HttpFetch, NodeError } from '@dagsocial/node-reads';
import { isNonNegSafeInt } from '@dagsocial/node-reads';
import { isHex64 } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import {
  blockHash,
  verifyHeaderFieldDomains,
  verifyProtocolVersion,
  verifyOrderingBlockPoW,
  verifyValidatorSignature,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
} from '@dagsocial/validation';
import {
  BlockCheck,
  type BlockVerdict,
  gossipTopics,
  MeshKeyError,
  nodeKeyFromKeyPair,
  notisIdFromPeerId,
  peerIdFromNotisId,
  meshBaseUrl,
  idOfMeshUrl,
  meshFetchOverConnection,
  MeshFetchError,
  readerLibp2pOptions,
  readerHandshake,
  servesChain,
  SERVING_READER_CAPABILITIES,
  SYNC_PROTOCOL,
  postTextsHandler,
  type PostTextProvider,
} from '@dagsocial/net/browser';
import { HeldChain, type Placement } from './held-chain.js';
import { headerFromJson } from './header-json.js';
import { MeshConfigError, assertNoDns, assertApiBase } from './config.js';
import {
  NodeList,
  type MeshContact,
  type FailureKind,
  type NodeEntry,
} from './node-list.js';
import { tipEvent, type TipEvent } from './tip-events.js';
import { pickServer, orderServers, type OrderCandidate, type ReadNeed } from './server-pick.js';
import { agreementCounts, type AgreementCounts, type AgreementEntry } from './agreement.js';
import { stunServersFor } from './stun-list.js';
import {
  CHECK_INTERVAL_MS,
  DIAL_TIMEOUT_MS,
  PEER_DIAL_MIN_MS,
  STUN_SERVERS_MAX,
  BLOCK_READ_BYTES,
  type NetworkName,
} from './protocols.js';
export type { ReadNeed } from './server-pick.js';

/**
 * MESH_INTERFACE → NAT — the client refuses an ICE server named by anything
 * but an IP literal: `stun:<IPv4>:<port>` or `stun:[<IPv6>]:<port>`.
 */
const STUN_IPV4_RE = /^stun:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/;
const STUN_IPV6_RE = /^stun:\[([0-9a-fA-F:]+)\]:(\d{1,5})$/;
// MESH_INTERFACE → Identity — the Notis spelling of a key: 64 lowercase
// hex characters. Also what `NodeList.addByHand` would refuse (as
// `MeshKeyError`), but we check it here so the refusal is a
// `MeshConfigError` as `MESH_INTERFACE → Discovery → "A node added by
// hand"` specifies.
const HEX64_RE = /^[0-9a-f]{64}$/;

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
 * MESH_INTERFACE → Block gossip → "A client is a reader of every node
 * it holds a connection to". A read whose handshake answered
 * `READER_CAPABILITIES` is signalled with this error so the check's
 * phase 2 skips the entry and no failure event is applied — the entry
 * stays at its pre-handshake state.
 */
class HandshakeNoChainServiceError extends Error {
  override readonly name = 'HandshakeNoChainServiceError';
  constructor(public readonly notisId: string) {
    super(`handshake: no chain service (${notisId})`);
  }
}

/**
 * MESH_INTERFACE → Discovery / NAT / The client's node list — the client's
 * config refusals as a pure, synchronous function. One check, called from
 * `startMeshClient` as its first statement and reused by any caller (such as
 * the page) that wants to refuse a config before starting a libp2p node. A
 * `MeshConfigError` is thrown for a `/dns4/`, `/dns6/`, `/dnsaddr/`
 * first-contact or known-node address, an ICE server that is not `stun:<IPv4>:<port>` /
 * `stun:[<IPv6>]:<port>`, an `api` base that is not `http://` or `https://`
 * or has a trailing `/`, or an entry that carries neither addrs nor api
 * (`→ The client's node list → "An entry may carry an API base"`).
 */
export function assertClientConfig(o: {
  firstContact: readonly MeshContact[];
  seeds?: readonly MeshContact[];
}): void {
  for (const a of o.firstContact) {
    assertNoDns('firstContact', a.addrs);
    if (a.api !== undefined) assertApiBase('firstContact', a.api);
    if (a.addrs.length === 0 && (a.api === undefined || a.api === '')) {
      throw new MeshConfigError(
        `firstContact refused: ${a.notisId} carries neither addrs nor api`,
      );
    }
  }
  if (o.seeds !== undefined) {
    for (const s of o.seeds) {
      assertNoDns('seed', s.addrs);
      if (s.api !== undefined) assertApiBase('seed', s.api);
    }
  }
}

/**
 * MESH_INTERFACE → Transports → "A client dials a private address only
 * when its own configuration names it" — the client's `denyDialMultiaddr`,
 * passed to libp2p's `connectionGater` in every runtime (Node.js and
 * browser alike). `true` denies the dial, `false` allows it; libp2p's
 * dial queue calls this inside `calculateMultiaddrs` before the
 * per-address progress event fires, so a dial whose every address this
 * function denies throws `DialDeniedError` and no
 * `dial-queue:calculated-addresses` entry is recorded for them.
 *
 * The rules, in order:
 *   - a plain `/ws` without `/tls/` or `/wss` is denied, matching
 *     libp2p's browser default gater's first branch.
 *   - a non-private address is allowed.
 *   - a private address with no trailing `/p2p/<id>` is denied: there
 *     is no key for the gater to look up.
 *   - a private address with a trailing `/p2p/<id>` is denied unless
 *     the dial multiaddr with that tail removed equals a
 *     `configuredAddrsOf(<id as notisId>)` entry with its own trailing
 *     `/p2p/` removed. A relayed address is judged by its relay hop —
 *     libp2p dials the relay first, and the relay's own key names the
 *     trailing `/p2p/` the gater reads.
 *
 * `configuredAddrsOf(notisId)` reads the addresses the client's own
 * configuration names for a key — a first-contact node's given addresses
 * and those entered by hand, never one merged from the DHT or a seed —
 * through `NodeList.configuredAddrs`. A peer id of a non-Notis key
 * type reads as the empty list and the address is refused.
 */
export function clientDenyDialMultiaddr(
  ma: Multiaddr,
  configuredAddrsOf: (notisId: string) => readonly string[],
): boolean {
  const components = ma.getComponents();
  const names = components.map((c) => c.name);
  // Plain `/ws` without `/tls/` or `/wss`.
  if (names.includes('ws') && !names.includes('wss') && !names.includes('tls')) {
    return true;
  }
  if (!isPrivate(ma)) return false;
  // Private: read the trailing `/p2p/<id>`.
  const last = components[components.length - 1];
  if (last === undefined || last.name !== 'p2p') return true;
  const peerIdString = typeof last.value === 'string' ? last.value : String(last.value ?? '');
  let notisId: string;
  try {
    notisId = notisIdFromPeerId(peerIdFromString(peerIdString));
  } catch {
    return true; // not a Notis-shaped Ed25519 peer id
  }
  const configured = configuredAddrsOf(notisId);
  if (configured.length === 0) return true;
  const bareMa = stripTrailingP2p(ma.toString());
  for (const cfg of configured) {
    if (stripTrailingP2p(cfg) === bareMa) return false;
  }
  return true;
}

function stripTrailingP2p(s: string): string {
  return s.replace(/\/p2p\/[^/]+$/, '');
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

/**
 * MESH_INTERFACE → The client's node list → "A check" — the cumulative
 * byte totals the timed fetch records by path over the life of the
 * client: `/blocks/current` → `tipBytes`, `/blocks/<n>` → `headerBytes`,
 * `/nipopow/proof/...` → `proofBytes` and one `proofReads` per proof
 * read. `gossipBytes` and `forwarded` stay `0` here.
 */
export interface ClientTraffic {
  tipBytes: number;
  proofBytes: number;
  headerBytes: number;
  gossipBytes: number;
  proofReads: number;
  forwarded: number;
}

export function emptyTraffic(): ClientTraffic {
  return {
    tipBytes: 0,
    proofBytes: 0,
    headerBytes: 0,
    gossipBytes: 0,
    proofReads: 0,
    forwarded: 0,
  };
}

/**
 * MESH_INTERFACE → Discovery → "A node added by hand" / "A
 * disagreement is the reader's question, never the client's choice" —
 * the shape of a standing disagreement: which disagreement it is,
 * your node's tip, the other tip (`null` under `memory`, where the
 * kept chain itself is the other), and the fork — the hash of the
 * highest header `compareProofs` finds in both proofs. `yours` and
 * `other` carry the lowercase hex `blockHash`.
 */
export interface Disagreement {
  which: 'memory' | 'heavier';
  yours: { height: number; hash: string };
  other: { height: number; hash: string } | null;
  fork: string;
}

export interface ClientState {
  nodeId: string | null;
  transport: 'webrtc-direct' | 'webrtc' | 'wss' | null;
  path: 'direct' | 'relay' | null;
  lastLeft: { nodeId: string; reason: string } | null;
  tip: { height: number; hash: string | null } | null;
  /**
   * MESH_INTERFACE → What the client remembers → "The agreement counts"
   * — after each check, how many nodes named a tip on the client's
   * chain within its last `k` headers, and how many named one off
   * those headers. `null` before the first check; written from each
   * check's `TipResult` thereafter.
   */
  agreement: AgreementCounts | null;
  /**
   * MESH_INTERFACE → Discovery → "Your node takes precedence" / "A
   * disagreement is the reader's question, never the client's choice"
   * — while your node and the evidence disagree, this names the two
   * tips and their fork, and the client's chain does not move until
   * the reader answers. `null` at start and when no disagreement
   * stands; written at the end of a check that raises or clears one.
   * `which: 'memory'` is your node losing to the kept proof; `which:
   * 'heavier'` is another node's proof beating your node's. `other`
   * is `null` for the memory case (the kept chain is the other);
   * `fork` is the hash of the highest header `compareProofs` finds in
   * both.
   */
  disagreement: Disagreement | null;
  /**
   * MESH_INTERFACE → The client's node list → "A routed read goes to
   * a node its need allows" — "how many checks it has completed, so
   * a reader can tell one check's state from the next". `0` at
   * start; incremented once at the end of each `runCheck`.
   */
  checks: number;
  traffic: ClientTraffic;
  nodes: NodeEntry[];
  /**
   * The chain is settled — a proof has verified and seated the window and
   * block 1 (MESH_INTERFACE → The client's node list → "The client's chain").
   * `false` at start; `true` from the first check that settles a chain and
   * for every state write after.
   */
  seated: boolean;
  /**
   * The last check's proof reads, counted from its `NodeTipResult`s: `asked`
   * per URL asked, `verified` the number verified, `invalid` the number with
   * `refuseCode === 'invalid'`, `tooShort` the number with `refuseCode ===
   * 'too-short'`. `null` before the first check and on a check that read no
   * proof — a check that places every tip reads none, and the field then
   * keeps the last check's that read one.
   */
  proofs: { asked: number; verified: number; invalid: number; tooShort: number } | null;
  /**
   * The two ends of the client's chain — the tip and the suffix head — moving
   * with every gossiped block the chain links and every re-seat
   * (WEB_INTERFACE → The extension → "The verified figures" → "The anchor").
   * Non-null when and only when the chain is seated and the window holds `k`.
   */
  anchor: Anchor | null;
  /**
   * The lowercase hex `blockHash` of block 1 — the chain's name
   * (WEB_INTERFACE → The extension → "The chain's name"). Non-null whenever
   * the chain is seated; the post cache's database name reads it, and nothing
   * else does.
   */
  chain: string | null;
  /**
   * MESH_INTERFACE → What the client remembers — "When no node continues
   * it — no node names a tip on the client's chain and one or more name one
   * off it — the client keeps its own chain and says so". True at the end
   * of a check where `this.kept !== null`, no node's verdict is `'on'` and
   * at least one is `'off'`; false otherwise and at start.
   */
  notContinued: boolean;
}

export interface MeshClient {
  /**
   * MESH_INTERFACE → The mesh URL / The client's node list → "An entry may
   * carry an API base" — a `notis-mesh://<id>…` URL is sent over the
   * connection the client holds to that key; an `http:` or `https:` URL is
   * sent over `httpFetch` (the fetch an API base is read with). Anything
   * else rejects as `MeshFetchError` of kind `transport`.
   */
  fetch: HttpFetch;
  /**
   * MESH_INTERFACE → The client's node list → "A routed read goes to a
   * node its need allows" — picks a server by the read's `need` and the
   * fast set: a node reached over the mesh, as today; when none, an API
   * base of an entry the need allows, by the same need and speed; before
   * the first check ends, any first-contact node over its connection if
   * it holds one, else at its base. Sets `state.nodeId / transport / path` to the
   * serving node. Returns the serving node's id beside the response and
   * the route it took so the caller can log it without a `state()` race.
   * Rejects as `MeshFetchError` of kind `transport` and triggers an
   * immediate check when no node is allowed for the need, or when the
   * fetch itself fails.
   */
  read(path: string, need: ReadNeed): Promise<{
    response: Response;
    nodeId: string;
    route: 'mesh' | 'api';
  }>;
  /**
   * MESH_INTERFACE → The client's node list → "The client's order for a
   * need" — every node the need allows reached over the mesh, the fast
   * set first, as `notis-mesh://<id>` bases, then the API bases of the
   * entries it allows in the same order; before the first check ends,
   * every first-contact node (its mesh base if connected, else its API
   * base). Duplicates dropped. A write and a resolve walk this order.
   */
  order(need: ReadNeed): string[];
  check(): Promise<void>;
  state(): ClientState;
  onState(cb: (s: ClientState) => void): () => void;
  stop(): Promise<void>;
  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — the reader
   * adds a node by its key and an address. Refuses with
   * `MeshConfigError` a key that is not 64 lowercase hex, an address
   * with a `/dns4/`, `/dns6/` or `/dnsaddr/` component, or an address
   * without `/webrtc-direct/`. Otherwise adds through `NodeList.addByHand`
   * (firstContact = trusted, byHand = true) and triggers an immediate check.
   */
  addByHand(notisId: string, addrs: string[], trusted: boolean): void;
  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — drops the
   * entry a reader added by hand. An entry that is also a build node
   * is not removed: the build's nodes are the client's own list, not
   * something the settings row can take away. An id the list does
   * not hold is a no-op. Refuses with `MeshConfigError` an id that
   * is not 64 lowercase hex.
   */
  removeByHand(notisId: string): void;
  /**
   * MESH_INTERFACE → Discovery → "A disagreement is the reader's
   * question, never the client's choice" — the reader's answer to a
   * standing disagreement. With no disagreement, nothing. *continue*:
   * settle the chain to your node's proof (the proof read in the
   * check that raised it), move the kept proof to it, record the
   * competing proof so the same branch growing does not ask again
   * (at most `ANSWERED_FORKS_MAX` answered branches kept, the oldest
   * dropped), the next snapshot `replace: true`, the disagreement
   * cleared, a check at once. *disable*: `removeByHand` on your node,
   * the disagreement cleared, a check at once.
   */
  answer(decision: 'continue' | 'disable'): void;
  /**
   * MESH_INTERFACE → The client's node list → "A routed read goes
   * to a node its need allows" — the base a routed read of the
   * given need would use now: the first pick `read` makes, by the
   * same order — mesh first, the fast set at random, else an API
   * base, else a first-contact node before the first check ends. `null`
   * when no node is allowed for the need. Pure — the client's state
   * stays unchanged; no connection is opened; the random source
   * is read once.
   */
  base(need: ReadNeed): string | null;
  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — the
   * addresses the client's own configuration names for the key: a
   * first-contact node's given addresses and those entered by hand,
   * never one merged from the DHT or a seed. The gater reads this list through
   * `NodeList.configuredAddrs` on every dial.
   */
  configuredAddrs(notisId: string): readonly string[];
  /**
   * MESH_INTERFACE → NAT → "A client's STUN list comes from the public
   * nodes it holds" — the ICE configuration the webRTC transport reads
   * at each dial, derived from the client's current node entries. Never
   * `undefined` `iceServers`: libp2p falls back to DNS-named defaults
   * when `iceServers` is absent, so the function always answers
   * `{ iceServers: [...] }`,
   * including an empty array when no public node is held.
   */
  iceConfiguration(): { iceServers: RTCIceServer[] };
  /**
   * MESH_INTERFACE → What the client remembers — the snapshot to persist
   * at the end of a check or on stop: the kept proof's bytes (or null),
   * the known nodes the client would dial at its next start — latest first,
   * at most `REMEMBERED_NODES_MAX` — the keys blacklisted this session (to
   * drop from the stored list), and the answered branches' competing
   * proofs as their `encodeNipopowProof` bytes, oldest first. `replace:
   * false` so the store moves the kept proof only when `continues`
   * answers so.
   */
  toRemember(): MemorySnapshot;
  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the nodes
   * it reads" — flip the client's serving setting. With no `serving`
   * option: resolves and does nothing. An unchanged value does nothing.
   * A change registers or unregisters `postTextsHandler` on
   * `SYNC_PROTOCOL`, closes every connection the client holds and dials
   * again, so each new handshake declares the new set. Calls are
   * serialised; the last of several quick calls decides.
   */
  setServing(on: boolean): Promise<void>;
  /**
   * Test seam: the libp2p node under the client. The suite dispatches a
   * `peer:discovery` event here so the "a discovered node is added before
   * any event names it" case can hold its guard without a three-node DHT
   * walk (MESH_INTERFACE → Discovery). Not meant for ordinary callers.
   */
  readonly libp2p: Libp2p;
}

export interface StartMeshClientOptions {
  firstContact: MeshContact[];
  /**
   * MESH_INTERFACE → Discovery → "Known nodes" — contacts the client holds
   * without trusting them. A seed is a candidate like any node the DHT
   * finds; a seed carries no trust assertion of its own. Addresses meet
   * the same refusals as a first-contact node's.
   */
  seeds?: MeshContact[];
  network: NetworkName;
  profile: NetworkProfile;
  /**
   * NET_INTERFACE → Handshake — the agent name the reader's handshake
   * declares. One string per caller: the page passes `notis-mesh-poc`,
   * the extension its own.
   */
  agentName: string;
  /**
   * The client's own log sink; a line per unexpected event the client
   * catches — a periodic check that threw, a state listener that threw.
   * Absent: nothing is logged.
   */
  log?: (line: string) => void;
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
  /**
   * MESH_INTERFACE → The client's node list → "An entry may carry an API
   * base" — the fetch an `http:` or `https:` URL is read with (an entry's
   * API base and the paths the client appends to it). Default:
   * `globalThis.fetch.bind(globalThis)`.
   */
  httpFetch?: HttpFetch;
  /**
   * MESH_INTERFACE → What the client remembers — the record the client
   * resumes from: the last kept proof's bytes and the answered branches
   * as their competing proofs. The proof is decoded and verified at
   * construct; one that does not decode or verify is dropped and the
   * client starts with no chain (`→ "The kept proof"`). Each answered
   * proof is decoded alone; one that does not decode is dropped alone
   * (`WEB_INTERFACE → The extension → "What the extension remembers"`).
   */
  memory?: { proof: Uint8Array; answered: Uint8Array[] };
  /**
   * MESH_INTERFACE → What the client remembers — called at the end of
   * every check with `toRemember()`, after `emitStateChange()`. The call
   * is direct — no `try` around it — so a throw from the callback is the
   * caller's and propagates.
   */
  onChecked?: (s: MemorySnapshot) => void;
  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the nodes
   * it reads" — the setting the client starts under, and the way it answers
   * `ModifierRequest`. Absent: the client never serves and never declares
   * `ModifierRequest`. Present with `on: true`: the handshake declares
   * `SERVING_READER_CAPABILITIES` and `postTextsHandler` is registered on
   * `SYNC_PROTOCOL`. The setting is moved later through `setServing`.
   */
  serving?: { on: boolean; texts: PostTextProvider };
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

  // MESH_INTERFACE → NAT → "A client's STUN list comes from the public
  // nodes it holds" — the ICE list reaches `readerLibp2pOptions` as a
  // function the WebRTC transport reads on every dial, so the derived
  // list flows into every new peer connection. The holder is
  // reassigned once the client exists; before then, no dial has run,
  // and the fallback `[]` keeps libp2p off its DNS-named defaults.
  const iceHolder: { current: () => RTCIceServer[] } = {
    current: () => [],
  };

  // MESH_INTERFACE → Transports → "A client dials a private address
  // only when its own configuration names it" — the client's own
  // `denyDialMultiaddr`, passed through `readerLibp2pOptions` so the
  // rule is the same in Node and in a browser. The reader of
  // configured addresses is a holder reassigned once the client (and
  // so its node list) exists; before then, libp2p's start-time code
  // does not call the gater (which fires only inside the dial queue),
  // and the fallback reader answers no key.
  const configuredHolder: { current: (notisId: string) => readonly string[] } = {
    current: () => [],
  };
  const denyDialMultiaddr = (ma: Multiaddr): boolean =>
    clientDenyDialMultiaddr(ma, configuredHolder.current);

  // NET_INTERFACE → The browser entry — `readerLibp2pOptions` carries
  // the browser transports, Noise, yamux, `identify`, `ping`, the
  // Notis DHT in client mode and gossipsub with `net`'s options for
  // the ordering-block topic; the client adds the dial queue's
  // `addressSorter` for its one address order (MESH_INTERFACE → The
  // client's node list → "The secure WebSocket is the fallback").
  const node = await createLibp2p(readerLibp2pOptions({
    privateKey: key.privateKey,
    magic: o.profile.magic,
    network: o.network,
    iceServers: () => iceHolder.current(),
    denyDialMultiaddr,
    addressSorter: notisAddressSorter,
  }));

  const random = o.random ?? Math.random;
  const httpFetch = o.httpFetch ?? ((url, init) => globalThis.fetch(url, init));
  const client = new MeshClientImpl(node, key.notisId, o, clock, wallClock, random, resolveFn, httpFetch);
  // MESH_INTERFACE → NAT → "A client's STUN list comes from the
  // public nodes it holds" — the client holds its node list, so
  // the holder derives the ICE configuration from it. `webRTC` reads
  // the function on every dial, so the next dial sees the live list.
  iceHolder.current = () => client.iceConfiguration().iceServers;
  // MESH_INTERFACE → Transports → "A client dials a private address
  // only when its own configuration names it" — the gater reads the
  // live node list, so a hand-add or an update of the list is visible
  // to the next dial.
  configuredHolder.current = (notisId) => client.configuredAddrs(notisId);
  await client.start();
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

/**
 * MESH_INTERFACE → Block gossip → "A refused block is evidence as `net`
 * weighs it" — a lie is the propagation source's key, "the client
 * blacklists that key", and no one else's. `lieTarget` answers the key
 * when all four conditions hold — the verdict is a reject, it is a lie,
 * the source peer id reads as a Notis key, and the list holds that key
 * — and `null` otherwise, so a reject that is not a lie, a lie from a
 * peer id that is not an Ed25519 key, and a lie from a key the list
 * does not hold all leave the list unchanged.
 */
export function lieTarget(
  verdict: BlockVerdict,
  sourceNotisId: string | null,
  held: (id: string) => boolean,
): string | null {
  if (verdict.result !== 'reject') return null;
  if (!verdict.lie) return null;
  if (sourceNotisId === null) return null;
  if (!held(sourceNotisId)) return null;
  return sourceNotisId;
}

class MeshClientImpl implements MeshClient {
  readonly libp2p: Libp2p;
  private readonly clock: () => number;
  private readonly resolveFn: typeof resolveTip;
  private readonly profile: NetworkProfile;
  private readonly agentName: string;
  private readonly log: ((line: string) => void) | undefined;
  private readonly nodeList: NodeList;
  private readonly listeners = new Set<(s: ClientState) => void>();
  private readonly state_: ClientState;
  private readonly meshFetchFn: HttpFetch;
  private readonly httpFetchFn: HttpFetch;
  private readonly latestEventReason = new Map<string, string>();
  private readonly wallClock: () => number;
  private readonly random: () => number;
  /**
   * MESH_INTERFACE → The client's node list → "A check" — a check reads
   * every candidate's tip timed from the request to the end of the
   * body, and that time is the node's speed until the next check. A
   * speed holds until the next check writes a fresh one, so a check
   * populates a FRESH map while it runs and swaps references when
   * `resolveTip` answers. A routed read reaching the live map during
   * the hold sees the previous check's values.
   */
  private readMsMap: Map<string, number> = new Map();
  /**
   * MESH_INTERFACE → The client's node list — the latest check's
   * `TipResult.nodes[i].behind` per node. Written into a fresh map
   * during the check and swapped in with `readMsMap` when
   * `resolveTip` answers.
   */
  private behindByMap: Map<string, number | null> = new Map();
  /**
   * MESH_INTERFACE → The client's node list → "A tip whose proof
   * verified and lost keeps its verdict" — the set of tip hashes
   * whose proofs verified and lost. A node naming the hash again
   * at the next check gates the proof read (the pass over the
   * final chain writes its event, distance and agreement verdict);
   * cleared when `chain.settle` moves to a new winner, and a hash
   * leaves when no node named it at a check.
   */
  private readonly keptVerdicts: Set<string> = new Set();
  private readonly chain: HeldChain;
  /**
   * MESH_INTERFACE → What the client remembers — "The kept proof is the
   * last proof the client verified of the chain it holds — a check's
   * winner, a switch, its own tip's proof". Seated from `memory.proof` at
   * construct when it decodes and verifies, moved forward in a check
   * whose settle's winning proof `continues` the kept one, cleared on a
   * `foreign` judgement.
   */
  private kept: NipopowProof | null = null;
  /**
   * MESH_INTERFACE → Discovery → "A disagreement is the reader's
   * question, never the client's choice" — the state held with a
   * standing disagreement: your node's id, the proof read in the
   * check that raised it, and the verified `VerifyResult` so the
   * reader's *continue* can settle the chain without a second
   * verification. `null` whenever no disagreement stands.
   */
  private standingDisagreement: {
    yourId: string;
    proof: NipopowProof;
    verifyResult: VerifyResult;
    /**
     * MESH_INTERFACE → Discovery → "A disagreement is the reader's
     * question, never the client's choice" — the competing proof the
     * raise named: the other node's proof for `heavier`, the kept
     * proof your node did not continue for `memory`. The reader's
     * *continue* pushes this into `answeredProofs`.
     */
    competing: NipopowProof;
  } | null = null;
  /**
   * MESH_INTERFACE → Discovery → "A disagreement is the reader's
   * question, never the client's choice" — "the next snapshot
   * `replace: true`" after the reader's *continue*. Flipped back
   * once `toRemember()` reads it.
   */
  private replaceNextSnapshot: boolean = false;
  /**
   * MESH_INTERFACE → What the client remembers — the competing proofs
   * the reader answered, held through the session and carried through
   * `toRemember()` as their `encodeNipopowProof` bytes. Seated from
   * `memory.answered` at construct: each entry decoded alone; one
   * that does not decode is dropped alone. A later check that finds
   * a competing proof whose highest shared header with an entry is
   * that entry's tip replaces the entry with the competing one — so
   * the branch the record names follows it as it grows
   * (`MESH_INTERFACE → Discovery → "An answered branch growing asks
   * nothing more"`).
   */
  private readonly answeredProofs: NipopowProof[];
  private readonly ownId: string;
  private readonly onChecked: ((s: MemorySnapshot) => void) | undefined;
  /**
   * MESH_INTERFACE → Block gossip → "A block is checked before it is
   * forwarded, and never applied" — net's Stage 1 run over every
   * gossiped block. The context reads the client's HeldChain for the
   * schedule and the standing (seen-accepted memory lives inside the
   * check itself, under `GOSSIP_SEEN_WINDOW_MS`), and the monotonic
   * clock for that memory.
   */
  private readonly blockCheck: BlockCheck;
  /**
   * NET_INTERFACE → Inbound Processing → "A gossiped message is decoded
   * once" — the validator writes the accepted block here keyed by the
   * router's message object, and the delivery listener reads that one
   * value. Gossipsub passes the same message object to the topic
   * validator and to the `gossipsub:message` event.
   */
  private readonly decodedByMessage: WeakMap<object, OrderingBlock> = new WeakMap();
  private checkInProgress: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly onDiscovery: (evt: CustomEvent<{ id: PeerId; multiaddrs: Multiaddr[] }>) => void;
  private readonly onConnectionOpen: (evt: CustomEvent<Connection>) => void;
  private readonly onConnectionClose: (evt: CustomEvent<Connection>) => void;
  /**
   * MESH_INTERFACE → Block gossip → "A client is a reader of every
   * node it holds a connection to" — the handshake outcome keyed by
   * `conn.id`: `passed` is the one state a read goes out on; `failed`
   * carries the handshake reason to a `retry` event; `no-chain` leaves
   * the node unread.
   */
  private readonly handshakeResults: Map<string, 'passed' | 'failed' | 'no-chain'> = new Map();
  /**
   * The handshake's reason from the dialler's side, kept so a read's
   * failure carries the handshake's message (`handshake: <reason>`)
   * rather than the read's own `no open connection`.
   */
  private readonly handshakeReasons: Map<string, string> = new Map();
  /**
   * MESH_INTERFACE → Block gossip → "A client is a reader of every
   * node it holds a connection to". A notisId lands here once a
   * handshake to it declared `READER_CAPABILITIES`; the check skips
   * it in every phase and no read goes out on it.
   */
  private readonly notAChainNodes: Set<string> = new Set();
  /**
   * MESH_INTERFACE → Block gossip → "A client is a reader of every
   * node it holds a connection to". The per-connection promise
   * resolves to the handshake's final state so a read awaits the
   * handshake once; cleared on `connection:close`.
   */
  private readonly handshakeDone: Map<string, Promise<'passed' | 'failed' | 'no-chain'>> = new Map();
  // MESH_INTERFACE → Block gossip — the delivery listener, kept as a
  // bound reference so `removeEventListener` reads the same identity
  // on stop.
  private readonly onGossipMessage: (ev: unknown) => void;
  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the
   * nodes it reads" — the reader's own way to serve posts' text. `null`
   * when the client was handed no `serving` option; a call of
   * `setServing` then answers and does nothing.
   */
  private readonly servingTexts: PostTextProvider | null;
  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the
   * nodes it reads" — whether the client declares
   * `SERVING_READER_CAPABILITIES` in its handshake and `SYNC_PROTOCOL`
   * is registered on its libp2p. False when `servingTexts` is null.
   */
  private servingOn: boolean;
  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the
   * nodes it reads" — "Calls are serialised — a call made while another
   * runs waits for it — so the last call's value is the state that
   * stands". The chain of applied setServing promises; the next call's
   * work runs after this resolves.
   */
  private servingLock: Promise<void> = Promise.resolve();

  constructor(
    node: Libp2p,
    ownId: string,
    o: StartMeshClientOptions,
    clock: () => number,
    wallClock: () => number,
    random: () => number,
    resolveFn: typeof resolveTip,
    httpFetch: HttpFetch,
  ) {
    this.libp2p = node;
    this.clock = clock;
    this.wallClock = wallClock;
    this.random = random;
    this.resolveFn = resolveFn;
    this.profile = o.profile;
    this.agentName = o.agentName;
    this.log = o.log;
    this.httpFetchFn = httpFetch;
    this.nodeList = new NodeList(o.firstContact, ownId, clock);
    this.chain = new HeldChain(o.profile, DEFAULT_K);
    // MESH_INTERFACE → Discovery → "Known nodes" — a seed is a candidate
    // like any node the DHT finds. Added before the first check, so a seed
    // is in the candidates `resolveTip` reads from the start;
    // `NodeList.add` records them as entries outside the first-contact
    // list, so a seed carries no `firstContact`. The client's own key is
    // dropped the same way the first-contact list's own-key entry is.
    // Each seed's entry carries `known: true` so `orderServers`'
    // before-first-check branch reaches it after a first-contact node.
    if (o.seeds !== undefined) {
      for (const s of o.seeds) {
        if (s.notisId === ownId) continue;
        this.nodeList.add(s.notisId, s.addrs, true, s.api ?? null);
      }
    }
    this.ownId = ownId;
    this.answeredProofs = [];
    this.onChecked = o.onChecked;
    // MESH_INTERFACE → What the client remembers — "The kept proof is the
    // last proof the client verified of the chain it holds". At construct,
    // decode and verify `memory.proof`: one that does not decode or verify
    // is dropped (the client starts with no chain); one that verifies seats
    // the chain as a check's winner does and is held as `this.kept`. Each
    // answered proof decodes alone; one that does not decode is dropped
    // alone (`WEB_INTERFACE → The extension → "What the extension
    // remembers"`).
    if (o.memory !== undefined) {
      let decoded: NipopowProof | null = null;
      try {
        decoded = decodeNipopowProof(o.memory.proof);
      } catch { /* bad bytes — drop */ }
      if (decoded !== null) {
        const vr = verifyProof(
          decoded,
          { m: DEFAULT_M, k: DEFAULT_K },
          verifierProfile(o.profile, this.wallClock()),
        );
        if (vr.ok) {
          const suffix: BlockHeader[] = [decoded.suffixHead.header, ...decoded.suffixTail];
          this.chain.settle(suffix, vr.headers[0]!);
          this.kept = decoded;
        }
      }
      for (const bytes of o.memory.answered) {
        try {
          this.answeredProofs.push(decodeNipopowProof(bytes));
        } catch { /* bad bytes for this entry — drop it alone */ }
      }
    }
    this.state_ = {
      nodeId: null,
      transport: null,
      path: null,
      lastLeft: null,
      tip: null,
      agreement: null,
      checks: 0,
      traffic: emptyTraffic(),
      nodes: decorateEntries(this.nodeList.entries(), node.getConnections()),
      seated: this.chain.settled(),
      proofs: null,
      anchor: null,
      chain: null,
      notContinued: false,
      disagreement: null,
    };
    // MESH_INTERFACE → The client's node list → "A read opens no
    // connection" — the client's reads open their stream on a
    // connection the client already holds for the key, picked by
    // `pickReadyConnection` (strict: open, direct first, never
    // limited, handshake passed). A read with no ready connection
    // rejects as a transport failure.
    const innerFetch = meshFetchOverConnection((notisId) =>
      this.pickReadyConnection(notisId),
    );
    // MESH_INTERFACE → Block gossip → "A client is a reader of every
    // node it holds a connection to" — await the handshake for a
    // connection the pick would open its stream on, then hand off to
    // the inner mesh fetch. No connection, or every one of theirs
    // failed: the inner fetch rejects as transport.
    this.meshFetchFn = async (url, init) => {
      const notisId = idOfMeshUrl(url);
      await this.awaitHandshakeForNode(notisId);
      return innerFetch(url, init);
    };
    this.onDiscovery = (evt): void => this.handleDiscovery(evt.detail);
    this.onConnectionOpen = (evt): void => {
      const conn = evt.detail;
      const promise = this.runHandshake(conn);
      this.handshakeDone.set(conn.id, promise);
      this.refreshTransportPathAndEmit();
    };
    this.onConnectionClose = (evt): void => {
      this.handshakeDone.delete(evt.detail.id);
      this.handshakeResults.delete(evt.detail.id);
      this.handshakeReasons.delete(evt.detail.id);
      this.refreshTransportPathAndEmit();
    };
    // MESH_INTERFACE → Block gossip → "A block is checked before it is
    // forwarded, and never applied" — net's `BlockCheck` runs its
    // Stage 1 checks over every gossiped block. Validators are
    // `@dagsocial/validation`'s functions (the one copy the Node and
    // the browser share — `ARCHITECTURE → Package boundaries`); the
    // context reads the client's HeldChain for the schedule and the
    // standing, and the monotonic clock for the seen-accepted memory
    // BlockCheck holds inside the window.
    this.blockCheck = new BlockCheck(
      {
        verifyHeaderFieldDomains,
        verifyProtocolVersion,
        verifyOrderingBlockPoW,
        verifyValidatorSignature,
        verifyOrderingBlockStructure,
        verifyUtxoTxRoot,
        blockHash,
      },
      {
        schedule: o.profile.protocolVersionSchedule,
        floorBits: o.profile.orderingBlockPowTargetFloorBits,
        scheduledTargetBits: (h) => this.chain.scheduledTargetBits(h),
        standing: (hash, height) => this.chain.standing(hash, height),
        nowMs: () => this.clock(),
      },
    );
    this.onGossipMessage = (ev): void => this.handleGossipMessage(ev);
    // MESH_INTERFACE → Block gossip → "A client that serves answers the
    // nodes it reads" — absent `serving` leaves the reader in the
    // reader's default set and registers no handler.
    this.servingTexts = o.serving?.texts ?? null;
    this.servingOn = this.servingTexts !== null && (o.serving?.on ?? false);
  }

  async start(): Promise<void> {
    // The DHT reports a peer the first time it hears of one; every one
    // becomes a `NodeList` entry before any later event can name it
    // (MESH_INTERFACE → Discovery).
    this.libp2p.addEventListener('peer:discovery', this.onDiscovery);
    this.libp2p.addEventListener('connection:open', this.onConnectionOpen);
    this.libp2p.addEventListener('connection:close', this.onConnectionClose);
    // MESH_INTERFACE → Block gossip — subscribe to the ordering-block
    // topic alone, set the topic validator (BlockCheck), and attach
    // the delivery listener. The subscribe comes before the first
    // check, so a mesh service it reaches finds it already in the
    // topic's mesh.
    this.startGossip();
    // MESH_INTERFACE → Block gossip → "A client that serves answers the
    // nodes it reads" — the handler stands before the first connection
    // opens, so a node can ask on the first connection whose handshake
    // has passed.
    if (this.servingOn && this.servingTexts !== null) {
      await this.libp2p.handle(SYNC_PROTOCOL, this.makeServingHandler(this.servingTexts));
    }
    // The first check runs at start (MESH_INTERFACE → The client's node
    // list → "A check"); a failure here does not take the client down, it
    // is reflected in the state and the next check comes on the ordinary
    // cadence.
    this.scheduleNextCheck(0);
  }

  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the
   * nodes it reads" — build the handler each registration uses: the
   * network's magic, this client's provider, the accept gate reading
   * the handshake's verdict for the connection id (`passed` alone).
   */
  private makeServingHandler(texts: PostTextProvider): ReturnType<typeof postTextsHandler> {
    return postTextsHandler({
      magic: this.profile.magic,
      texts,
      timeoutMs: 10_000,
      accept: (id) => this.handshakeResults.get(id) === 'passed',
    });
  }

  private getPubsub(): GossipSub & {
    reportMessageValidationResult(
      msgId: string,
      propagationSource: string,
      acceptance: TopicValidatorResult,
    ): void;
  } {
    return (this.libp2p as unknown as {
      services: { pubsub: GossipSub & {
        reportMessageValidationResult(
          msgId: string,
          propagationSource: string,
          acceptance: TopicValidatorResult,
        ): void;
      } };
    }).services.pubsub;
  }

  private startGossip(): void {
    const pubsub = this.getPubsub();
    const topic = gossipTopics(this.profile.magic).orderingBlock;
    pubsub.topicValidators.set(topic, (peer, msg) =>
      this.validateGossipMessage(peer, msg),
    );
    pubsub.subscribe(topic);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).addEventListener('gossipsub:message', this.onGossipMessage);
  }

  /**
   * MESH_INTERFACE → Block gossip → "A block is checked before it is
   * forwarded, and never applied" / "A refused block is evidence as
   * `net` weighs it". The topic validator runs net's Stage 1 as a
   * `BlockCheck`, counts the message's bytes against
   * `traffic.gossipBytes`, and maps the verdict to a
   * `TopicValidatorResult`. A reject with `lie` is the propagation
   * source's: when its peer id reads as a Notis key and the list
   * holds that entry, the entry blacklists with evidence of kind
   * `gossip-block`. A peer whose id is not an Ed25519 key, or whose
   * key the list does not hold, is refused with no list change.
   */
  private validateGossipMessage(
    peer: PeerId,
    msg: { topic: string; data: Uint8Array },
  ): TopicValidatorResult {
    // Count every message the validator weighs — accept, ignore or reject
    // (MESH_INTERFACE → Block gossip). The length is from the message's
    // `data`.
    this.state_.traffic.gossipBytes += msg.data.length;
    const data = new Uint8Array(msg.data);
    const verdict = this.blockCheck.check(data);
    if (verdict.result === 'ignore') return TopicValidatorResult.Ignore;
    if (verdict.result === 'reject') {
      let sourceNotisId: string | null = null;
      try {
        sourceNotisId = notisIdFromPeerId(peer);
      } catch (e) {
        // MeshKeyError: a peer id that is not an Ed25519 key, or
        // whose public key is not 32 bytes. Not a Notis peer; the
        // reject stands with no list change.
        if (!(e instanceof MeshKeyError)) throw e;
      }
      const target = lieTarget(
        verdict,
        sourceNotisId,
        (id) => this.nodeList.entry(id) !== undefined,
      );
      if (target !== null) {
        // `lieTarget` returns a key only when `verdict` is a
        // `reject` with `lie: true`, so `verdict.detail` is reachable
        // under this branch.
        this.nodeList.lie(target, {
          kind: 'gossip-block',
          atMs: this.clock(),
          detail: verdict.detail,
        });
        this.latestEventReason.set(target, 'lie: gossip-block');
        this.emitStateChange();
      }
      return TopicValidatorResult.Reject;
    }
    // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded once"
    this.decodedByMessage.set(msg, verdict.block);
    return TopicValidatorResult.Accept;
  }

  /**
   * MESH_INTERFACE → Block gossip → "A block is checked before it is
   * forwarded, and never applied" / "The client's chain" — on
   * delivery (asyncValidation: the message passed the topic
   * validator), report Accept so the router forwards it, count
   * `traffic.forwarded`, and either extend the chain (`extended` →
   * `state.tip` moves) or trigger an immediate check (`fork`, `gap`).
   * Before the first check settles a chain, the block adds nothing;
   * it is still counted as forwarded.
   */
  private handleGossipMessage(ev: unknown): void {
    const detail = (ev as { detail?: {
      msg?: { topic: string; data: Uint8Array };
      msgId?: string;
      propagationSource?: { toString(): string };
    } }).detail;
    if (!detail) return;
    const msg = detail.msg;
    const topic = gossipTopics(this.profile.magic).orderingBlock;
    if (!msg || msg.topic !== topic) return;
    const msgId = detail.msgId;
    if (msgId === undefined) return;
    const relayPeerId = detail.propagationSource?.toString() ?? '';
    const pubsub = this.getPubsub();
    pubsub.reportMessageValidationResult(
      msgId,
      relayPeerId,
      TopicValidatorResult.Accept,
    );

    this.state_.traffic.forwarded += 1;
    // NET_INTERFACE → Inbound Processing → "A gossiped message is decoded once"
    const block = this.decodedByMessage.get(msg);
    if (block === undefined) {
      // An accepted message with no value kept against it is this
      // node's bug, logged as one and delivered to no handler, and it
      // penalises no peer.
      this.log?.('[mesh-client] accepted gossip delivery without a kept value — this node\'s bug');
      this.emitStateChange();
      return;
    }

    if (!this.chain.settled()) {
      this.emitStateChange();
      return;
    }
    // MESH_INTERFACE → The client's node list → "The client's chain" —
    // "a gossiped block whose parent is held below the tip, or not held
    // at all, runs a check at once — unless a question stands"; →
    // Discovery → "while a question stands, a gossiped block runs no
    // check: the chain is held, and the checks on the client's cadence
    // read the question again". Every gossiped block is dropped and
    // no check is run while a disagreement stands.
    if (this.state_.disagreement !== null) {
      this.emitStateChange();
      return;
    }
    const r = this.chain.extend(block.header);
    if (r === 'extended') {
      const h = blockHash(block.header);
      this.state_.tip = { height: block.header.height, hash: h };
      this.emitStateChange();
      return;
    }
    // 'fork' | 'gap' — a check runs at once (MESH_INTERFACE → The
    // client's node list → "The client's chain").
    this.emitStateChange();
    this.triggerImmediateCheck();
  }

  // MESH_INTERFACE → The mesh URL / The client's node list → "An entry may
  // carry an API base" — route by URL scheme: `notis-mesh://…` goes over
  // the connection the client holds to the key, `http:` / `https:` goes
  // over `httpFetch`. Anything else is a transport failure.
  readonly fetch: HttpFetch = (url, init) => {
    if (url.startsWith('notis-mesh://')) return this.meshFetchFn(url, init);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return this.httpFetchFn(url, init);
    }
    return Promise.reject(
      new MeshFetchError('transport', `unsupported URL scheme: ${url}`),
    );
  };

  async check(): Promise<void> {
    if (this.checkInProgress) return this.checkInProgress;
    // MESH_INTERFACE → The client's node list → "A check" — the client
    // runs one check at a time; a trigger that fires while a check is in
    // flight is that check. The marker is set before `runCheck`'s own
    // code runs, so a `triggerImmediateCheck` fired from inside the
    // check (the routed-tip read finding no node, say) sees the running
    // check and does not schedule a 0 ms recurrence.
    this.checkInProgress = Promise.resolve()
      .then(() => this.runCheck())
      .finally(() => { this.checkInProgress = null; });
    return this.checkInProgress;
  }

  async read(path: string, need: ReadNeed): Promise<{
    response: Response;
    nodeId: string;
    route: 'mesh' | 'api';
  }> {
    // MESH_INTERFACE → The client's node list → "A routed read goes to a
    // node its need allows", → "Over the mesh first", → "Before the first
    // check ends a node the client started from serves any need". The mesh
    // pick uses the strict
    // read pick's non-null result over the same connection list the fetch
    // opens its stream on; the API fallback uses the entry's api base.
    const entries = this.nodeList.entries();
    // MESH_INTERFACE → Discovery → "Your node takes precedence" — the
    // client marks a candidate `yours` only while the entry is `yours`
    // and no disagreement stands (→ "A disagreement is the reader's
    // question, never the client's choice"). While a disagreement
    // stands, routed reads go on with no preference for your node.
    const yoursActive = this.state_.disagreement === null;
    const meshCandidates = entries.map((e) => ({
      id: e.notisId,
      status: e.status,
      readMs: this.readMsMap.get(e.notisId) ?? null,
      usable: this.pickReadyConnection(e.notisId) !== null,
      yours: yoursActive && e.yours,
    }));
    const meshPicked = pickServer(meshCandidates, need, this.random);

    let pickedId: string | null = null;
    let route: 'mesh' | 'api' = 'mesh';
    let url: string = '';
    if (meshPicked !== null) {
      pickedId = meshPicked;
      route = 'mesh';
      url = meshBaseUrl(meshPicked) + path;
    } else {
      // Mesh had none allowed: fall back to API bases of entries the need
      // allows. Same need and speed rule as the mesh pick; the API entry
      // is `usable` by virtue of holding an api, with its readMs the
      // check's last base-read time.
      const apiCandidates = entries
        .filter((e) => e.api !== null)
        .map((e) => ({
          id: e.notisId,
          status: e.status,
          readMs: this.readMsMap.get(e.notisId) ?? null,
          usable: true,
          yours: yoursActive && e.yours,
        }));
      const apiPicked = pickServer(apiCandidates, need, this.random);
      if (apiPicked !== null) {
        const entry = entries.find((e) => e.notisId === apiPicked);
        // `pickServer` picks only from the candidates list, which was
        // built from entries carrying `api !== null` — the find is
        // known to answer, and the exclamation is defensive.
        if (entry && entry.api !== null) {
          pickedId = apiPicked;
          route = 'api';
          url = entry.api + path;
        }
      }
    }

    // MESH_INTERFACE → The client's node list → "Before the first check
    // ends a node the client started from serves any need" —
    // first-contact entries first, then known entries, in list order.
    // Status alone does not refuse here — but `blacklisted` always does
    // (the "lie" row stays "never a candidate" at every stage).
    const firstCheckEnded = this.state_.checks > 0;
    if (pickedId === null && !firstCheckEnded) {
      for (const e of entries) {
        if (!e.firstContact) continue;
        if (e.status === 'blacklisted') continue;
        if (this.pickReadyConnection(e.notisId) !== null) {
          pickedId = e.notisId;
          route = 'mesh';
          url = meshBaseUrl(e.notisId) + path;
          break;
        } else if (e.api !== null) {
          pickedId = e.notisId;
          route = 'api';
          url = e.api + path;
          break;
        }
      }
      if (pickedId === null) {
        for (const e of entries) {
          if (e.firstContact) continue;
          if (!e.known) continue;
          if (e.status === 'blacklisted') continue;
          if (this.pickReadyConnection(e.notisId) !== null) {
            pickedId = e.notisId;
            route = 'mesh';
            url = meshBaseUrl(e.notisId) + path;
            break;
          } else if (e.api !== null) {
            pickedId = e.notisId;
            route = 'api';
            url = e.api + path;
            break;
          }
        }
      }
    }

    if (pickedId === null) {
      // Trigger a check so the next read may find an allowed node.
      // During a running check (phase 5's own tip read) the trigger
      // is a no-op — `checkInProgress !== null`.
      this.triggerImmediateCheck();
      throw new MeshFetchError('transport', `no node allowed for a ${need} read`);
    }
    try {
      const response = await this.fetch(url, undefined);
      this.state_.nodeId = pickedId;
      this.refreshTransportPath();
      this.emitStateChange();
      return { response, nodeId: pickedId, route };
    } catch (e) {
      // MESH_INTERFACE → The client's node list → "A read opens no
      // connection" — "a failed routed read runs a check at once,
      // which dials from the list".
      this.triggerImmediateCheck();
      throw e;
    }
  }

  order(need: ReadNeed): string[] {
    const entries = this.nodeList.entries();
    const firstCheckEnded = this.state_.checks > 0;
    const yoursActive = this.state_.disagreement === null;
    const candidates: OrderCandidate[] = entries.map((e) => ({
      id: e.notisId,
      status: e.status,
      readMs: this.readMsMap.get(e.notisId) ?? null,
      meshUsable: this.pickReadyConnection(e.notisId) !== null,
      firstContact: e.firstContact,
      known: e.known,
      yours: yoursActive && e.yours,
      api: e.api,
      meshBase: meshBaseUrl(e.notisId),
    }));
    return orderServers(candidates, need, firstCheckEnded);
  }

  state(): ClientState {
    // MESH_INTERFACE → The client's node list → "The client's chain";
    // WEB_INTERFACE → The extension → "The verified figures" → "The anchor",
    // → "The chain's name" — `seated`, `anchor` and `chain` are the chain's
    // own answers, read off the live `HeldChain` so a gossiped block linked
    // between a write and a read of state carries through to `onState`.
    const seated = this.chain.settled();
    const tipHdr = this.chain.tip();
    const suffixHeadHdr = this.chain.suffixHead();
    const anchor: Anchor | null = tipHdr !== null && suffixHeadHdr !== null
      ? { tip: tipHdr, suffixHead: suffixHeadHdr }
      : null;
    const chain = this.chain.block1Hash();
    return {
      ...this.state_,
      nodes: decorateEntries(this.nodeList.entries(), this.libp2p.getConnections(), {
        readMs: this.readMsMap,
        behindBy: this.behindByMap,
      }),
      seated,
      anchor,
      chain,
    };
  }

  /**
   * MESH_INTERFACE → NAT — "the ICE configuration names no server"
   * when no public node is held. The derivation reads the current
   * (decorated) entries — a node moved to `blacklisted`, a new
   * speed from the latest check, or a hand-added node's address
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

  /**
   * MESH_INTERFACE → What the client remembers — "After each check it
   * records every node naming a tip on its chain, `ok` or `trailing`,
   * with the addresses it would dial — no private address, never its own
   * key — the most recently seen first, at most `REMEMBERED_NODES_MAX`".
   * `proof`: the kept proof's bytes or `null`; `nodes`: the entries to
   * remember; `dropped`: the keys blacklisted this session, so the store
   * drops them from the merged list; `answered`: the competing proofs
   * the reader answered, each as its `encodeNipopowProof` bytes, oldest
   * first; `replace: false` so the store moves the stored proof only
   * when `continues` answers so.
   */
  toRemember(): MemorySnapshot {
    const entries = this.nodeList.entries();
    const nodes = nodesToRemember(entries, this.ownId, REMEMBERED_NODES_MAX);
    const dropped: string[] = [];
    for (const e of entries) {
      if (e.status === 'blacklisted') dropped.push(e.notisId);
    }
    const replace = this.replaceNextSnapshot;
    this.replaceNextSnapshot = false;
    return {
      proof: this.kept !== null ? encodeNipopowProof(this.kept) : null,
      nodes,
      dropped,
      answered: this.answeredProofs.map((p) => encodeNipopowProof(p)),
      replace,
    };
  }

  /**
   * MESH_INTERFACE → Discovery → "An answered branch growing asks
   * nothing more" — the index in `answeredProofs` the given competing
   * proof names as its branch, or `null`. A competing proof names an
   * answered branch when the highest header `compareProofs` finds in
   * it and the answered proof is the answered proof's tip, or when it
   * is that proof (same tip); `compareProofs`'s `incomparable` arm —
   * reachable only on a network pinning no `genesisId` — is no match.
   */
  private findAnsweredMatch(competing: NipopowProof): number | null {
    const vp = verifierProfile(this.profile, this.wallClock());
    const params = { m: DEFAULT_M, k: DEFAULT_K };
    for (let i = 0; i < this.answeredProofs.length; i++) {
      const a = this.answeredProofs[i]!;
      const aTipHdr = a.suffixTail.length > 0
        ? a.suffixTail[a.suffixTail.length - 1]!
        : a.suffixHead.header;
      const aTipHash = blockHash(aTipHdr);
      if (aTipHash === null) continue;
      const r = compareProofs(competing, a, params, vp);
      if (r.verdict === 'incomparable') continue;
      if (blockHash(r.lca) === aTipHash) return i;
    }
    return null;
  }

  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — refuses with
   * `MeshConfigError` before touching the list, adds through
   * `NodeList.addByHand`, then triggers an immediate check. The three
   * refusals: a key that is not 64 lowercase hex, an address with a
   * `/dns4/`, `/dns6/` or `/dnsaddr/` component (through `assertNoDns`),
   * and an address without a `/webrtc-direct/` component. A trusted
   * node is a first-contact node (`firstContact = true`); an untrusted one is a
   * candidate. `NodeList.addByHand` is also what writes the gater's
   * `configuredAddrs` list for the key.
   */
  addByHand(notisId: string, addrs: string[], trusted: boolean): void {
    if (!HEX64_RE.test(notisId)) {
      throw new MeshConfigError(`addByHand key refused: ${notisId} is not 64 lowercase hex characters`);
    }
    assertNoDns('addByHand', addrs);
    for (const a of addrs) {
      if (!a.includes('/webrtc-direct/')) {
        throw new MeshConfigError(`addByHand address refused: ${a} carries no /webrtc-direct/ component`);
      }
    }
    this.nodeList.addByHand(notisId, addrs, trusted);
    this.triggerImmediateCheck();
  }

  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — drops the
   * entry a reader added by hand. A build node is never removed:
   * the `NodeList.removeByHand` check guards that. Refuses with
   * `MeshConfigError` an id that is not 64 lowercase hex, then
   * delegates; an id the list does not hold is a no-op.
   */
  removeByHand(notisId: string): void {
    if (!HEX64_RE.test(notisId)) {
      throw new MeshConfigError(`removeByHand key refused: ${notisId} is not 64 lowercase hex characters`);
    }
    this.nodeList.removeByHand(notisId);
  }

  /**
   * MESH_INTERFACE → Discovery → "A disagreement is the reader's
   * question, never the client's choice" — the reader's answer. With
   * no disagreement, nothing. *continue*: settle the chain to your
   * node's proof, move `this.kept` to it, record the competing proof
   * as an answered branch, the next snapshot `replace: true`, the
   * disagreement cleared, a check at once; `onChecked` fires once
   * before the check so the answered branch persists even before the
   * check lands. *disable*: `removeByHand` on your node, the
   * disagreement cleared, a check at once.
   */
  answer(decision: 'continue' | 'disable'): void {
    const d = this.state_.disagreement;
    if (d === null) return;
    const standing = this.standingDisagreement;
    this.state_.disagreement = null;
    this.standingDisagreement = null;
    if (decision === 'continue') {
      if (standing !== null) {
        // Settle the chain to your node's proof (the proof kept with
        // the disagreement). The suffix is `[suffixHead.header,
        // ...suffixTail]`; the window's first header is the proof's
        // verified tip's own block 1. `this.kept` moves to the proof;
        // the competing proof joins `answeredProofs`, at most
        // ANSWERED_FORKS_MAX with the oldest dropped; the next
        // snapshot `replace: true`.
        const proof = standing.proof;
        const vr = standing.verifyResult;
        if (vr.ok === true) {
          const suffix: BlockHeader[] = [proof.suffixHead.header, ...proof.suffixTail];
          this.chain.settle(suffix, vr.headers[0]!);
          this.keptVerdicts.clear();
        }
        this.kept = proof;
        this.answeredProofs.push(standing.competing);
        while (this.answeredProofs.length > ANSWERED_FORKS_MAX) {
          this.answeredProofs.shift();
        }
        this.replaceNextSnapshot = true;
      }
    } else {
      // disable: remove your node from the list.
      this.nodeList.removeByHand(standing !== null ? standing.yourId : '');
    }
    this.emitStateChange();
    // MESH_INTERFACE → What the client remembers — "written when the
    // reader answers". The snapshot carries the answered branches'
    // bytes so the extension's seam persists them before the
    // immediate check lands.
    if (decision === 'continue' && this.onChecked !== undefined) {
      this.onChecked(this.toRemember());
    }
    this.triggerImmediateCheck();
  }

  /**
   * MESH_INTERFACE → The client's node list → "A routed read goes
   * to a node its need allows" — the base a routed read of the
   * given need would use now. Mirrors `read`'s pick: mesh first,
   * the fast set at random, else an API base, else a first-contact
   * node before the first check ends. `null` when no node is allowed.
   */
  base(need: ReadNeed): string | null {
    const entries = this.nodeList.entries();
    const yoursActive = this.state_.disagreement === null;
    const meshCandidates = entries.map((e) => ({
      id: e.notisId,
      status: e.status,
      readMs: this.readMsMap.get(e.notisId) ?? null,
      usable: this.pickReadyConnection(e.notisId) !== null,
      yours: yoursActive && e.yours,
    }));
    const meshPicked = pickServer(meshCandidates, need, this.random);
    if (meshPicked !== null) return meshBaseUrl(meshPicked);

    const apiCandidates = entries
      .filter((e) => e.api !== null)
      .map((e) => ({
        id: e.notisId,
        status: e.status,
        readMs: this.readMsMap.get(e.notisId) ?? null,
        usable: true,
        yours: yoursActive && e.yours,
      }));
    const apiPicked = pickServer(apiCandidates, need, this.random);
    if (apiPicked !== null) {
      const entry = entries.find((e) => e.notisId === apiPicked);
      if (entry && entry.api !== null) return entry.api;
    }

    const firstCheckEnded = this.state_.checks > 0;
    if (!firstCheckEnded) {
      for (const e of entries) {
        if (!e.firstContact) continue;
        if (e.status === 'blacklisted') continue;
        if (this.pickReadyConnection(e.notisId) !== null) {
          return meshBaseUrl(e.notisId);
        }
        if (e.api !== null) return e.api;
      }
      for (const e of entries) {
        if (e.firstContact) continue;
        if (!e.known) continue;
        if (e.status === 'blacklisted') continue;
        if (this.pickReadyConnection(e.notisId) !== null) {
          return meshBaseUrl(e.notisId);
        }
        if (e.api !== null) return e.api;
      }
    }
    return null;
  }

  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — the
   * addresses the client's own configuration names for the key, read
   * by the gater's `configuredHolder` on every dial. The list is
   * passed through `NodeList.configuredAddrs`.
   */
  configuredAddrs(notisId: string): readonly string[] {
    return this.nodeList.configuredAddrs(notisId);
  }

  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the
   * nodes it reads" — flip the client's serving setting. With no
   * `serving` option the client never serves; a call then resolves and
   * does nothing. Calls are serialised through `servingLock`; two
   * quick calls run in order and the last stands. An unchanged value
   * does nothing.
   */
  setServing(on: boolean): Promise<void> {
    if (this.servingTexts === null) return Promise.resolve();
    const next = this.servingLock.then(() => this.applyServing(on));
    // The chain survives a throw: one call's failure does not strand
    // the calls after it.
    this.servingLock = next.catch(() => undefined);
    return next;
  }

  /**
   * MESH_INTERFACE → Block gossip → "A client that serves answers the
   * nodes it reads" — the body serving each `setServing` call runs
   * inside `servingLock`. An unchanged value is a no-op; a change
   * registers or unregisters `postTextsHandler` on `SYNC_PROTOCOL`,
   * closes every connection the client holds and dials again
   * (`triggerImmediateCheck`), so each new handshake declares the new
   * set.
   */
  private async applyServing(on: boolean): Promise<void> {
    if (this.stopped) return;
    if (on === this.servingOn) return;
    this.servingOn = on;
    if (on) {
      await this.libp2p.handle(SYNC_PROTOCOL, this.makeServingHandler(this.servingTexts!));
    } else {
      await this.libp2p.unhandle(SYNC_PROTOCOL);
    }
    // A check in flight is reading over the connections this close is
    // about to tear down, and `triggerImmediateCheck` is a no-op while
    // one runs — so the next check is `CHECK_INTERVAL_MS` away. Wait
    // for the in-flight check to end before the close, and the
    // trigger below schedules at 0 as the rule asks.
    if (this.checkInProgress !== null) {
      try { await this.checkInProgress; } catch { /* already surfaced to its caller */ }
    }
    if (this.stopped) return;
    // Close every connection the client holds; a new one's handshake
    // declares the current `servingOn`'s set.
    const conns = this.libp2p.getConnections();
    await Promise.all(conns.map((c) => c.close().catch(() => undefined)));
    this.triggerImmediateCheck();
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
    // MESH_INTERFACE → Block gossip — detach the gossipsub listener
    // before libp2p.stop so the handler does not run against a
    // torn-down pubsub. Wrapped: libp2p's own stop fires final events,
    // but a listener-removal failure must not stop the shutdown.
    try {
      const pubsub = this.getPubsub();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).removeEventListener('gossipsub:message', this.onGossipMessage);
    } catch { /* already torn down */ }
    await this.libp2p.stop();
  }

  private triggerImmediateCheck(): void {
    if (this.stopped) return;
    // MESH_INTERFACE → The client's node list → "A check" — the client
    // runs one check at a time; a trigger that fires while a check is in
    // flight is that check. The ongoing check is the response; a
    // trigger during it adds no second check.
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
          this.log?.(`[mesh-client] check threw: ${messageOf(e)}`);
        })
        .finally(() => this.scheduleNextCheck(CHECK_INTERVAL_MS));
    }, ms);
  }

  private async runCheck(): Promise<void> {
    // Snapshot ok/trailing before the check runs so `lastLeft` names
    // any node that leaves the set — the pre-dial itself may move a
    // node to retry, so the snapshot has to sit before phase 1.
    const okTrailingBefore = new Set<string>();
    for (const e of this.nodeList.entries()) {
      if (e.status === 'ok' || e.status === 'trailing') okTrailingBefore.add(e.notisId);
    }

    // MESH_INTERFACE → The client's node list → "A tip the check has
    // outrun is read again" — the chain's tip at check start, used at
    // the end of phase 4 to know whether a proof settling the chain
    // or a fill linking moved the tip.
    const tipAtStart = this.chain.tip();
    const tipHashAtStart = tipAtStart !== null ? blockHash(tipAtStart) : null;

    // WEB_INTERFACE → The extension → "The verified tip" — the last check's
    // proof reads, accumulated across every `resolveFn` call in phase 4; the
    // field is written at end-of-check only when `asked > 0`, so a check that
    // places every tip and reads no proof leaves the previous value standing.
    const proofsThisCheck = { asked: 0, verified: 0, invalid: 0, tooShort: 0 };

    // MESH_INTERFACE → Discovery → "A disagreement is the reader's
    // question, never the client's choice" — the disagreement this
    // check detected (`null` where none), set in phase 4 after
    // `judgeByMemory` on the first pass that raises one. "A check
    // that no longer finds the disagreement clears it": the write to
    // `this.state_.disagreement` at end of check is this value, so
    // the standing clears when no pass raises one this check.
    let raisedThisCheck: Disagreement | null = null;
    let standingRaisedThisCheck: {
      yourId: string;
      proof: NipopowProof;
      verifyResult: VerifyResult;
      competing: NipopowProof;
    } | null = null;

    // Phase 1: pre-dial every candidate the client has not already
    // connected to, so libp2p's unexpected-peer failure is caught per
    // address instead of folded into a generic transport failure.
    // MESH_INTERFACE → Block gossip → "A client is a reader of every
    // node it holds a connection to" — phase 1 and phase 2 drop a
    // candidate whose handshake answered with no chain service.
    // MESH_INTERFACE → The client's node list → "An entry may carry an
    // API base" — an entry with api but no addrs still needs no dial;
    // one with addrs whose dial fails and no api is skipped as before;
    // a retry entry's mesh dial waits for its retry window even when
    // it carries an api (the api read takes the retry window's place
    // in phase 2).
    const beforeIds = this.nodeList.candidates().filter((id) => !this.notAChainNodes.has(id));
    const nowMsPhase1 = this.clock();
    for (const id of beforeIds) {
      if (this.stopped) break;
      if (this.hasOpenConnection(id)) continue;
      const entry = this.nodeList.entry(id);
      if (!entry || entry.addrs.length === 0) continue; // api-only or no addresses: no dial
      if (entry.status === 'retry' && nowMsPhase1 < entry.retryAtMs) continue;
      await this.dialByAddresses(id);
    }

    // Phase 2: read each candidate's `/blocks/current` through the
    // timed fetch; its time to the body's end is the node's speed
    // (`readMsMap`). The new readings land in a FRESH map; the live
    // one still answers routed reads with the previous check's speeds
    // until phase 4 finishes (MESH_INTERFACE → The client's node list
    // → "A check"). A failure is a transport/timeout/refused
    // failure; a body-level overflow or unparse, or a shape that is
    // not a tip, is a `malformed` event — on the mesh a lie, at an API
    // base a `retry` (the client's node-list table's API-base row).
    //
    // After phase 1, pick each candidate's base: its mesh base when the
    // client holds a ready (handshake-passed) connection to it, else
    // its API base where it has one. The map is used by the timed fetch
    // to attribute speed and bytes to the right entry, and by phase 4's
    // `urlToHash` loop to read the id back from the URL `resolveTip`
    // echoes (MESH_INTERFACE → The client's node list → "An entry may
    // carry an API base" — "Every place the check maps a URL back to
    // its entry … maps an API base's URL to its entry too, by the base
    // the check asked, never by parsing a key out of it").
    const afterIds = this.nodeList.candidates().filter((id) => !this.notAChainNodes.has(id));
    const baseById = new Map<string, { url: string; route: 'mesh' | 'api' }>();
    const idByBase = new Map<string, string>();
    for (const id of afterIds) {
      const base = this.checkBase(id);
      baseById.set(id, base);
      idByBase.set(base.url, id);
    }
    const pendingReadMs = new Map<string, number>();
    const pendingBehindBy = new Map<string, number | null>();
    const timedFetch = this.makeTimedFetch(pendingReadMs, idByBase);
    const perNodeVerdict = new Map<string, 'on' | 'off' | 'none'>();
    for (const id of afterIds) perNodeVerdict.set(id, 'none');
    // Ids whose phase 4 resolve answered a failure or a lie: the pass
    // keeps their status and event, so a proof read's own failure or
    // lie lands as it was read (MESH_INTERFACE → The client's node
    // list → "A node is judged against the chain the check leaves"
    // — "A lie and a failure land as they were read"). A `retry`
    // from phase 1's dial alone is not here; the pass places such a
    // node by its tip read.
    const phase4Downgraded = new Set<string>();

    interface TipRead { id: string; height: number; hash: string | null; }
    const tipReads: TipRead[] = [];
    for (const id of afterIds) {
      if (this.stopped) break;
      const base = baseById.get(id)!; // `afterIds` is the key set of `baseById`
      let response: Response;
      try {
        response = await timedFetch(base.url + '/blocks/current', undefined);
      } catch (e) {
        // MESH_INTERFACE → Block gossip → "A client is a reader of
        // every node it holds a connection to" — a handshake with no
        // chain service leaves the entry unread; no failure event.
        if (e instanceof HandshakeNoChainServiceError) continue;
        const message = e instanceof Error ? e.message : String(e);
        this.applyEvent({ id, ev: 'failure', kind: 'transport', message }, base.route);
        continue;
      }
      const cls = await this.classifyTipRead(response, id, base.route);
      if (cls.kind === 'tip') {
        tipReads.push({ id, height: cls.height, hash: cls.hash });
      }
      // `failure` and `lie` events were applied inside classifyTipRead.
    }

    // `above` fills first — highest named height first, each from the
    // client's tip as it then stands; a node whose tip is placed by an
    // earlier fill is not read again. A fill reads the serving node's
    // headers by height from its tip down to the client's, the client's
    // tip moving when the fill links (MESH_INTERFACE → The client's
    // node list → "The client's chain"). The sort by height descending
    // lets the tallest fill move the tip once; lower `above` reads then
    // place from the extended
    // chain without a header read of their own.
    const aboveCandidates = tipReads
      .filter((r) => r.hash !== null)
      .slice()
      .sort((a, b) => b.height - a.height);
    for (const read of aboveCandidates) {
      if (this.stopped) break;
      const chainTipNow = this.chain.tip();
      if (chainTipNow === null) break; // chain unsettled — all 'above' falls to phase 4
      const placement = this.chain.place(read.hash!, read.height);
      if (placement !== 'above') continue; // placed by an earlier fill
      const gap = read.height - chainTipNow.height;
      if (gap > DEFAULT_K) continue; // more than k above — stays unplaced for phase 4
      const base = baseById.get(read.id)!;
      const headers: BlockHeader[] = [];
      let fillAborted = false;
      for (let h = read.height; h > chainTipNow.height; h -= 1) {
        const result = await this.readHeaderAt(base.url, h, timedFetch);
        if (result.kind !== 'header') {
          this.applyHeaderReadFailure(read.id, result, base.route);
          fillAborted = true;
          break;
        }
        headers.push(result.header); // highest-first — chain.link's input shape
      }
      if (fillAborted) continue;
      if (headers.length === 0 || blockHash(headers[0]!) !== read.hash) continue;
      this.chain.link(headers);
    }

    // Phase 3b: place EVERY tip read once against the chain as it then
    // stands; land each event and verdict, and `behindBy` for placed
    // nodes (0 at the tip, 1 one below, the count below for `below`,
    // the matched `under`'s distance). `above`, `under` and `unplaced`
    // (including a hash the window holds but doesn't match) move on
    // (`under` → phase 3c; the rest → phase 4).
    const placements = new Map<string, Placement>();
    const placedAtTip = new Set<string>();
    // Ids whose `under` placement phase 3c matched against the chain's
    // own header at that height: on the chain, further down than the
    // held headers (MESH_INTERFACE → The client's node list → "A
    // check"). Cleared on a chain switch, since the match was against
    // the chain the check started on.
    const underMatched = new Set<string>();
    for (const read of tipReads) {
      if (read.hash === null) {
        this.applyEvent({ id: read.id, ev: 'behind' });
        // Verdict stays `none`: a null hash places nowhere and reads
        // no proof.
        continue;
      }
      const placement = this.chain.place(read.hash, read.height);
      placements.set(read.id, placement);
      const chainTipAfterFills = this.chain.tip();
      if (placement === 'tip') {
        this.applyEvent({ id: read.id, ev: 'success' });
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, 0);
        placedAtTip.add(read.id);
      } else if (placement === 'one-below') {
        this.applyEvent({ id: read.id, ev: 'trailing' });
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, 1);
      } else if (placement === 'below') {
        this.applyEvent({ id: read.id, ev: 'behind' });
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, chainTipAfterFills!.height - read.height);
      }
    }

    // Phase 3c: `under` — read the chain's own header at that height
    // from the first node placed `tip` this check; a match reads
    // `behind` with no proof, a mismatch falls to phase 4.
    for (const read of tipReads) {
      if (this.stopped) break;
      if (placements.get(read.id) !== 'under') continue;
      const firstAtTip = this.firstNodeAtChainTip(placedAtTip);
      if (firstAtTip === null) continue;
      const base = baseById.get(firstAtTip)!;
      const result = await this.readHeaderAt(base.url, read.height, timedFetch);
      if (result.kind !== 'header') {
        this.applyHeaderReadFailure(firstAtTip, result, base.route);
        continue;
      }
      if (blockHash(result.header) === read.hash) {
        this.applyEvent({ id: read.id, ev: 'behind' });
        perNodeVerdict.set(read.id, 'on');
        const chainTipNow = this.chain.tip();
        pendingBehindBy.set(read.id, chainTipNow!.height - read.height);
        underMatched.add(read.id);
      }
    }

    // Phase 4: proof read per distinct unplaced hash, from the first
    // node naming it (by candidate rank); while the chain is settled,
    // prepend the URL of the first node at the client's tip so a tie
    // keeps the chain. A hash whose proof is refused is asked again
    // of the next node naming it, in a further `resolveTip` over the
    // own-tip URL and the replacements, until each hash has a verdict
    // or no node naming it is left; each refused node its own
    // evidence. After a switch, every tip this check read is placed
    // again against the new chain with no new read; a tip still
    // unplaced and with no proof verdict of its own reads `behind`.
    const groups = new Map<string, string[]>(); // hash → ids in rank order
    for (const read of tipReads) {
      if (read.hash === null) continue;
      if (perNodeVerdict.get(read.id) === 'on') continue;
      const entry = this.nodeList.entry(read.id);
      if (entry && entry.status === 'blacklisted') continue;
      // MESH_INTERFACE → The client's node list → "A check" — "A tip
      // whose proof verified and lost keeps its verdict while the
      // client's chain stands: a node naming it again is placed off
      // the chain with no proof read". The node's own event, distance
      // and agreement verdict come from the single pass over the
      // final chain (MESH_INTERFACE → "A node is judged against the
      // chain the check leaves"); the kept-verdict lookup only gates
      // the proof read here.
      if (this.keptVerdicts.has(read.hash)) continue;
      let list = groups.get(read.hash);
      if (list === undefined) { list = []; groups.set(read.hash, list); }
      list.push(read.id);
    }
    const triedPerHash = new Map<string, Set<string>>();
    for (const h of groups.keys()) triedPerHash.set(h, new Set<string>());
    const verifiedHashes = new Set<string>();
    const urlToHash = new Map<string, string>();

    while (!this.stopped) {
      const passUrls: string[] = [];
      // The own-tip URL first, while the chain is settled. The base is
      // whichever route placed the node at tip this check — mesh if
      // dialled, API if not (baseById).
      if (this.chain.settled()) {
        const firstAtTip = this.firstNodeAtChainTip(placedAtTip);
        if (firstAtTip !== null) {
          const base = baseById.get(firstAtTip)!;
          passUrls.push(base.url);
        }
      }
      // Next untried node for each hash still without a verified
      // result.
      let anyReplacement = false;
      for (const [hash, ids] of groups) {
        if (verifiedHashes.has(hash)) continue;
        const tried = triedPerHash.get(hash)!;
        const next = ids.find((id) => !tried.has(id));
        if (next === undefined) continue;
        tried.add(next);
        const base = baseById.get(next)!;
        passUrls.push(base.url);
        urlToHash.set(base.url, hash);
        anyReplacement = true;
      }
      if (!anyReplacement) break;

      // MESH_INTERFACE → "Two clocks" — the verifier reads the wall
      // clock (`wallClock`); the node list keeps its monotonic clock
      // for retries. A header's `createdAt` is wall-clock time.
      const result = await this.resolveFn(
        passUrls,
        DEFAULT_M,
        DEFAULT_K,
        this.profile,
        this.wallClock,
        timedFetch,
      );

      // WEB_INTERFACE → The extension → "The verified tip" — count this
      // resolveFn's reads into the check's running total. `asked` is the
      // nodes asked, `verified`, `invalid` and `tooShort` the classes the
      // verdict's rows 2 and 3 read.
      for (const n of result.nodes) {
        proofsThisCheck.asked += 1;
        if (n.verified) proofsThisCheck.verified += 1;
        if (n.refuseCode === 'invalid') proofsThisCheck.invalid += 1;
        if (n.refuseCode === 'too-short') proofsThisCheck.tooShort += 1;
      }

      const nowMs = this.clock();
      for (const n of result.nodes) {
        // MESH_INTERFACE → The client's node list → "An entry may carry
        // an API base" — map the URL back to its entry by the base the
        // check asked, never by parsing a key out of it. `idByBase`
        // holds every base this check used; a URL outside it falls to
        // `idOfMeshUrl` for a mesh URL, else a bug upstream.
        const nid = idByBase.get(n.url) ?? idOfMeshUrl(n.url);
        const route = baseById.get(nid)?.route ?? 'mesh';
        // A resolve failure or a lie applies through `tipEvent` so a
        // proof-read defect reaches the node list; the per-chain
        // verdict and distance of a verified node are rewritten in
        // the single pass after the chain is final
        // (MESH_INTERFACE → The client's node list → "A node is
        // judged against the chain the check leaves"). The read
        // against the final chain, never the resolve's winner-relative
        // `n.behind`, decides event and distance.
        const tipEv = tipEvent(nid, n, nowMs);
        if (!n.verified) {
          this.applyEvent(tipEv, route);
          if (tipEv.ev === 'failure' || tipEv.ev === 'lie') {
            phase4Downgraded.add(nid);
          }
        }

        if (n.verified) {
          const hash = urlToHash.get(n.url);
          if (hash !== undefined) {
            verifiedHashes.add(hash);
            // MESH_INTERFACE → The client's node list → "A check" —
            // a verified proof whose hash is not the winner's is a
            // lost tip the client keeps the verdict of, so the next
            // check needs no proof while the chain stands. The lost
            // tip's event and distance come from the pass over the
            // final chain (MESH_INTERFACE → "A node is judged
            // against the chain the check leaves").
            if (n.behind !== 0) {
              this.keptVerdicts.add(hash);
            }
          }
        }
      }

      // MESH_INTERFACE → What the client remembers — "The kept proof
      // is a contestant in every check that reads proofs": with
      // `this.kept !== null`, `judgeByMemory` picks the lost, the best
      // and `foreign` over `result.nodes` against the kept. A lost
      // proof's hash is kept as a lost tip so the next check reads no
      // proof while the chain stands; the settle below uses `best`'s
      // proof and tip in place of `result.winner` / `result.tip`,
      // `best === null` settles nothing, and `foreign` drops the kept
      // and takes the winner. The lost node's own event, distance and
      // agreement verdict come from the single pass over the final
      // chain (MESH_INTERFACE → "A node is judged against the chain
      // the check leaves").
      let judgedWinner: typeof result.winner = result.winner;
      let judgedTip: typeof result.tip = result.tip;
      if (this.kept !== null) {
        const judgment = judgeByMemory(this.kept, result.nodes, this.profile, this.wallClock());
        for (const idx of judgment.lost) {
          const n = result.nodes[idx]!;
          if (!n.verified || n.proof === null || n.verifyResult === null || !n.verifyResult.ok) continue;
          const hash = blockHash(n.verifyResult.tip);
          if (hash !== null) {
            this.keptVerdicts.add(hash);
            verifiedHashes.add(hash);
          }
        }
        if (judgment.foreign) {
          // The kept proof shares no block with any verified proof:
          // it is dropped, and the settle below takes the resolve's
          // winner. `judgedWinner` / `judgedTip` already name those.
          this.kept = null;
        } else if (judgment.best !== null) {
          const b = result.nodes[judgment.best]!;
          judgedWinner = b;
          judgedTip = b.verifyResult !== null && b.verifyResult.ok ? b.verifyResult.tip : null;
        } else {
          judgedWinner = null;
          judgedTip = null;
        }
      }

      // MESH_INTERFACE → Discovery → "Your node takes precedence" / "A
      // disagreement is the reader's question, never the client's
      // choice" — detection after the memory judgement.
      if (raisedThisCheck === null) {
        // Find your node's verified result in this pass.
        const yoursIds = new Set<string>();
        for (const e of this.nodeList.entries()) if (e.yours) yoursIds.add(e.notisId);
        let yIndex = -1;
        let yId: string | null = null;
        for (let i = 0; i < result.nodes.length; i++) {
          const n = result.nodes[i]!;
          if (!n.verified || n.proof === null || n.verifyResult === null || !n.verifyResult.ok) continue;
          const nid = idByBase.get(n.url) ?? idOfMeshUrl(n.url);
          if (yoursIds.has(nid)) { yIndex = i; yId = nid; break; }
        }
        if (yIndex >= 0 && yId !== null) {
          const y = result.nodes[yIndex]!;
          const yProof = y.proof!;
          const yVr = y.verifyResult as VerifyResult & { ok: true };
          const yTip = yVr.tip;
          const yTipHash = blockHash(yTip);
          if (yTipHash !== null) {
            // which: 'memory' — y is in `judgeByMemory`'s lost.
            let memoryCase = false;
            let lostSet = new Set<number>();
            if (this.kept !== null) {
              const judgment = judgeByMemory(this.kept, result.nodes, this.profile, this.wallClock());
              lostSet = new Set(judgment.lost);
              memoryCase = lostSet.has(yIndex);
            }
            if (memoryCase) {
              // MESH_INTERFACE → Discovery → "A node added by hand" —
              // "a node behind on the same chain does not" raise a
              // disagreement. `forkKey(kept, y)` equals `yTipHash` iff
              // `y` is a prefix of the kept chain (lca is y's tip) —
              // y is behind on the same chain, no disagreement. A
              // fork strictly below y's tip does disagree.
              const fork = forkKey(this.kept!, yProof, this.profile, this.wallClock());
              if (fork !== null && fork !== yTipHash) {
                // MESH_INTERFACE → Discovery → "An answered branch
                // growing asks nothing more" — the competing proof for
                // `memory` is the kept proof your node did not
                // continue. Where that proof extends an answered
                // branch, nothing is raised and the answered proof is
                // replaced by it.
                const matchIdx = this.findAnsweredMatch(this.kept!);
                if (matchIdx !== null) {
                  this.answeredProofs[matchIdx] = this.kept!;
                } else {
                  raisedThisCheck = {
                    which: 'memory',
                    yours: { height: yTip.height, hash: yTipHash },
                    other: null,
                    fork,
                  };
                  standingRaisedThisCheck = {
                    yourId: yId,
                    proof: yProof,
                    verifyResult: yVr,
                    competing: this.kept!,
                  };
                }
              }
            } else {
              // which: 'heavier' — a verified, not-lost o ≠ y whose tip
              // y's proof does not hold and whose proof beats y's.
              const ySuffixHeaders = [yProof.suffixHead.header, ...yProof.suffixTail];
              const ySuffixHashes = new Set<string>();
              for (const h of ySuffixHeaders) {
                const hh = blockHash(h);
                if (hh !== null) ySuffixHashes.add(hh);
              }
              const yB1 = blockHash(yVr.headers[0]!);
              if (yB1 !== null) ySuffixHashes.add(yB1);
              const vp = verifierProfile(this.profile, this.wallClock());
              const params = { m: DEFAULT_M, k: DEFAULT_K };
              const cands: { index: number; tipHdr: BlockHeader; proof: NipopowProof }[] = [];
              for (let i = 0; i < result.nodes.length; i++) {
                if (i === yIndex) continue;
                if (lostSet.has(i)) continue;
                const o = result.nodes[i]!;
                if (!o.verified || o.proof === null || o.verifyResult === null || !o.verifyResult.ok) continue;
                const oTip = (o.verifyResult as VerifyResult & { ok: true }).tip;
                const oHash = blockHash(oTip);
                if (oHash === null) continue;
                if (ySuffixHashes.has(oHash)) continue;
                const cmp = compareProofs(yProof, o.proof, params, vp);
                if (cmp.verdict !== 'b') continue;
                cands.push({ index: i, tipHdr: oTip, proof: o.proof });
              }
              if (cands.length > 0) {
                // Best by the same comparison: the one no other beats.
                let best = cands[0]!;
                for (const c of cands.slice(1)) {
                  const cmp = compareProofs(best.proof, c.proof, params, vp);
                  if (cmp.verdict === 'b') best = c;
                }
                const fork = forkKey(yProof, best.proof, this.profile, this.wallClock());
                // MESH_INTERFACE → Discovery → "A node added by hand"
                // — heavier needs the other node's tip off y's chain:
                // `forkKey(y, o)` strictly below y's tip. Where it is
                // y's tip (o extends y), nothing is raised and o's
                // result is no evidence against y — the ordinary
                // settle advances the chain to o's.
                if (fork !== null && fork !== yTipHash) {
                  // MESH_INTERFACE → Discovery → "An answered branch
                  // growing asks nothing more" — the competing proof
                  // for `heavier` is the other node's. Where that
                  // proof extends an answered branch, nothing is
                  // raised, the chain settles to your node's and
                  // the answered proof is replaced. o's event,
                  // distance and agreement verdict come from the
                  // single pass over the final chain (MESH_INTERFACE
                  // → "A node is judged against the chain the check
                  // leaves").
                  const matchIdx = this.findAnsweredMatch(best.proof);
                  if (matchIdx !== null) {
                    this.answeredProofs[matchIdx] = best.proof;
                    judgedWinner = y;
                    judgedTip = yTip;
                  } else {
                    const bestTipHash = blockHash(best.tipHdr);
                    if (bestTipHash !== null) {
                      raisedThisCheck = {
                        which: 'heavier',
                        yours: { height: yTip.height, hash: yTipHash },
                        other: { height: best.tipHdr.height, hash: bestTipHash },
                        fork,
                      };
                      standingRaisedThisCheck = {
                        yourId: yId,
                        proof: yProof,
                        verifyResult: yVr,
                        competing: best.proof,
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }

      // MESH_INTERFACE → The client's node list → "The client's
      // chain" — "The tip moves only by a header carrying its work on
      // the client's chain, never by a node's word". A winner whose
      // tip is held by the window — the chain's own tip, or a header
      // below it that the window still keeps, as when gossip extended
      // the chain while this proof read was in flight — is no switch;
      // the chain stands. When the hash is not held, settle to the
      // winner and re-place every tip this check read against the
      // new chain.
      // MESH_INTERFACE → Discovery → "A disagreement is the reader's
      // question, never the client's choice" — "the check settles
      // nothing" while a disagreement stands.
      if (raisedThisCheck !== null || this.state_.disagreement !== null) {
        judgedWinner = null;
        judgedTip = null;
      }
      if (judgedWinner !== null && judgedTip !== null) {
        const winnerTipHash = blockHash(judgedTip);
        const vr = judgedWinner.verifyResult;
        const proof = judgedWinner.proof;
        if (winnerTipHash !== null
            && vr !== null && vr.ok === true && proof !== null) {
          // MESH_INTERFACE → What the client remembers — the kept proof
          // is "the last proof the client verified of the chain it holds —
          // a check's winner, a switch, its own tip's proof". It moves
          // forward to this proof: `judgeByMemory`'s `best` excludes
          // every proof that loses to the kept one (`judgment.lost`),
          // and a `foreign` judgement clears the kept proof before
          // this write — so the proof `judgedWinner` names here either
          // continues the kept chain (reached only when `kept !== null`
          // and `best` selected it) or starts a new chain
          // (`kept === null` here, either never-held or just cleared
          // by `foreign`).
          this.kept = proof;
          if (this.chain.standing(winnerTipHash, judgedTip.height) !== 'held') {
            const suffix: BlockHeader[] = [proof.suffixHead.header, ...proof.suffixTail];
            this.chain.settle(suffix, vr.headers[0]!);
            // MESH_INTERFACE → The client's node list → "A check" —
            // the kept verdicts are dropped when the chain switches.
            this.keptVerdicts.clear();
            // MESH_INTERFACE → The client's node list → "A node is
            // judged against the chain the check leaves" — phase
            // 3c's match was against the chain the check started
            // on; a settle to a new tip voids the match the same
            // way the kept verdicts clear. The pass judges every
            // tip against the chain as it stands here.
            underMatched.clear();
            // Rebuild `placedAtTip` against the new chain: phase 4's
            // next iteration reads it through `firstNodeAtChainTip`
            // to prepend the own-tip URL.
            placedAtTip.clear();
            for (const read of tipReads) {
              if (read.hash === null) continue;
              const newPlacement = this.chain.place(read.hash, read.height);
              if (newPlacement === 'tip') placedAtTip.add(read.id);
            }
          }
        }
      }
    }

    // MESH_INTERFACE → The client's node list → "A node is judged
    // against the chain the check leaves" — the check's one
    // placement after the settle, over every tip the check read: the
    // node's event, distance and agreement verdict are read against
    // the client's chain as it stands here. A hash the chain holds
    // reads its placement's event and distance; an `under` hash
    // phase 3c matched against the chain's own header at that
    // height lies on the chain, further down than the held headers,
    // and reads `behind` with its distance; any other `under`,
    // `above` or `unplaced` reads `behind` with `behindBy` null and
    // `off` in the agreement. A lie and a failure land as they were
    // read: an entry phase 4's proof read moved to `retry` and one
    // the same path left `blacklisted` keep that status and its
    // event — the pass writes no event over it — while its count in
    // the agreement and its distance follow its tip read's placement
    // as any node's do, since the counts say what the nodes name
    // (→ What the client remembers → "The agreement counts"). A
    // tip answered with no hash was placed by phase 3b with the
    // `behind` event and no agreement verdict. A retry from phase
    // 1's dial alone is not held here — the api that served the
    // tip reads is the base the pass writes against. The pass
    // writes `placements`: the outrun re-read below reads it to
    // pick whom to re-read against the settled chain.
    for (const read of tipReads) {
      if (read.hash === null) continue;
      const base = baseById.get(read.id);
      if (base === undefined) continue;
      const entry = this.nodeList.entry(read.id);
      const keepStatus = phase4Downgraded.has(read.id)
        || (entry !== undefined && entry.status === 'blacklisted');
      const placement = this.chain.place(read.hash, read.height);
      placements.set(read.id, placement);
      const chainTipNow = this.chain.tip();
      if (placement === 'tip') {
        if (!keepStatus) this.applyEvent({ id: read.id, ev: 'success' }, base.route);
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, 0);
      } else if (placement === 'one-below') {
        if (!keepStatus) this.applyEvent({ id: read.id, ev: 'trailing' }, base.route);
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, 1);
      } else if (placement === 'below') {
        if (!keepStatus) this.applyEvent({ id: read.id, ev: 'behind' }, base.route);
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, chainTipNow!.height - read.height);
      } else if (placement === 'under' && underMatched.has(read.id)) {
        if (!keepStatus) this.applyEvent({ id: read.id, ev: 'behind' }, base.route);
        perNodeVerdict.set(read.id, 'on');
        pendingBehindBy.set(read.id, chainTipNow!.height - read.height);
      } else {
        // 'above', 'under' (unmatched) or 'unplaced': the tip lies off the chain.
        if (!keepStatus) this.applyEvent({ id: read.id, ev: 'behind' }, base.route);
        perNodeVerdict.set(read.id, 'off');
        pendingBehindBy.set(read.id, null);
      }
    }

    // MESH_INTERFACE → The client's node list → "A tip the check has
    // outrun is read again" — where a check moves the client's tip
    // (a proof settling the chain, or a fill linking), each node
    // whose tip read then places below the client's tip is read
    // again, once in that check, after its proofs and fills. The
    // first read's time stays the node's speed, so the re-reads use
    // a throw-away `readMs` target; a failed re-read is a failure as
    // any read's is; a re-read that names a tip no placement holds
    // leaves the node as its first read placed it.
    const tipAfter = this.chain.tip();
    const tipHashAfter = tipAfter !== null ? blockHash(tipAfter) : null;
    if (tipHashAfter !== null && tipHashAfter !== tipHashAtStart) {
      const toReRead: string[] = [];
      for (const read of tipReads) {
        if (read.hash === null) continue;
        const p = placements.get(read.id);
        if (p === 'one-below' || p === 'below' || p === 'under') {
          toReRead.push(read.id);
        }
      }
      const discardReadMs = new Map<string, number>();
      const rereadFetch = this.makeTimedFetch(discardReadMs, idByBase);
      for (const id of toReRead) {
        if (this.stopped) break;
        const base = baseById.get(id)!;
        let response: Response;
        try {
          response = await rereadFetch(base.url + '/blocks/current', undefined);
        } catch (e) {
          if (e instanceof HandshakeNoChainServiceError) continue;
          const message = e instanceof Error ? e.message : String(e);
          this.applyEvent({ id, ev: 'failure', kind: 'transport', message }, base.route);
          pendingBehindBy.set(id, null);
          continue;
        }
        const cls = await this.classifyTipRead(response, id, base.route);
        if (cls.kind !== 'tip') continue; // failure or lie applied inside
        if (cls.hash === null) continue; // no placeable tip — keep first read's
        const newPlacement = this.chain.place(cls.hash, cls.height);
        if (newPlacement === 'tip') {
          this.applyEvent({ id, ev: 'success' });
          perNodeVerdict.set(id, 'on');
          pendingBehindBy.set(id, 0);
        } else if (newPlacement === 'one-below') {
          this.applyEvent({ id, ev: 'trailing' });
          perNodeVerdict.set(id, 'on');
          pendingBehindBy.set(id, 1);
        } else if (newPlacement === 'below') {
          this.applyEvent({ id, ev: 'behind' });
          perNodeVerdict.set(id, 'on');
          const tipNow = this.chain.tip();
          if (tipNow !== null) pendingBehindBy.set(id, tipNow.height - cls.height);
        } else if (newPlacement === 'above') {
          // Try one fill from this node, bottom-up. A fill that links
          // extends the chain, placing this re-read at the new tip;
          // a fill that fails leaves the node as its first read placed
          // it, under "a tip no placement holds".
          const tipNow = this.chain.tip();
          if (tipNow === null) continue;
          const gap = cls.height - tipNow.height;
          if (gap > DEFAULT_K) continue;
          const headers: BlockHeader[] = [];
          let fillAborted = false;
          for (let h = cls.height; h > tipNow.height; h -= 1) {
            const result = await this.readHeaderAt(base.url, h, rereadFetch);
            if (result.kind !== 'header') {
              this.applyHeaderReadFailure(id, result, base.route);
              fillAborted = true;
              break;
            }
            headers.push(result.header);
          }
          if (fillAborted) continue;
          if (headers.length === 0 || blockHash(headers[0]!) !== cls.hash) continue;
          const linkResult = this.chain.link(headers);
          if (linkResult === 'linked') {
            this.applyEvent({ id, ev: 'success' });
            perNodeVerdict.set(id, 'on');
            pendingBehindBy.set(id, 0);
          }
        }
        // 'under' or 'unplaced' — keep first read's placement.
      }
    }

    this.readMsMap = pendingReadMs;
    this.behindByMap = pendingBehindBy;

    // MESH_INTERFACE → The client's node list → "A check" — the
    // memory never outgrows the tips last seen: a hash leaves when
    // no node named it at a check.
    const seenHashes = new Set<string>();
    for (const read of tipReads) {
      if (read.hash !== null) seenHashes.add(read.hash);
    }
    for (const h of [...this.keptVerdicts.keys()]) {
      if (!seenHashes.has(h)) this.keptVerdicts.delete(h);
    }

    // MESH_INTERFACE → The client's node list → "A routed read goes
    // to a node its need allows" — "how many checks it has completed,
    // so a reader can tell one check's state from the next". The
    // counter increments once per `runCheck`; it moves BEFORE the
    // routed tip read below so the read sees the first-check-ended
    // branch of `order` and `read` (the before-first-check
    // first-contact fallback never fires from inside the check itself).
    this.state_.checks += 1;

    // The routed tip read runs the classification so a failure or a lie
    // moves the serving node (MESH_INTERFACE → The client's node list);
    // `state.tip` is the client's chain's (→ "The client's chain"), set
    // below.
    try {
      const tipRead = await this.read('/blocks/current', 'tip');
      await this.classifyTipRead(tipRead.response, tipRead.nodeId, tipRead.route);
    } catch (e) {
      // A MeshFetchError (no allowed node, or a fetch failure) is a
      // no-op here: state.tip comes from the chain. A throw from
      // classifyTipRead itself is a bug — surface it.
      if (!(e instanceof MeshFetchError)) throw e;
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

    // state.tip from the chain — never from a node's word.
    const chainTip = this.chain.tip();
    if (chainTip !== null) {
      const h = blockHash(chainTip);
      this.state_.tip = { height: chainTip.height, hash: h };
    } else {
      this.state_.tip = null;
    }

    // Agreement counts off the per-tip verdicts.
    const entries: AgreementEntry[] = [];
    for (const [, verdict] of perNodeVerdict) {
      entries.push({ verdict });
    }
    this.state_.agreement = agreementCounts(entries);

    // WEB_INTERFACE → The extension → "The verified tip" — the field keeps
    // the last check's that read one, so a check that placed every tip and
    // read no proof leaves `proofs` standing.
    if (proofsThisCheck.asked > 0) {
      this.state_.proofs = proofsThisCheck;
    }
    // MESH_INTERFACE → What the client remembers — "When no node continues
    // it — no node names a tip on the client's chain and one or more name
    // one off it — the client keeps its own chain and says so".
    let anyOn = false;
    let anyOff = false;
    for (const v of perNodeVerdict.values()) {
      if (v === 'on') anyOn = true;
      if (v === 'off') anyOff = true;
    }
    this.state_.notContinued = this.kept !== null && !anyOn && anyOff;
    // MESH_INTERFACE → Discovery → "A disagreement is the reader's
    // question, never the client's choice" — "A check that no longer
    // finds the disagreement clears it": the write is the pass's
    // detection (`null` where nothing was found).
    this.state_.disagreement = raisedThisCheck;
    this.standingDisagreement = standingRaisedThisCheck;
    this.emitStateChange();
    // MESH_INTERFACE → What the client remembers — called after
    // `emitStateChange()`, directly: a throw from the callback is the
    // caller's and propagates.
    if (this.onChecked !== undefined) {
      this.onChecked(this.toRemember());
    }
  }

  /**
   * MESH_INTERFACE → The client's node list → "A check" — read a
   * single header at `height` from `nodeId` through the timed fetch
   * (`/blocks/<height>` → `headerBytes`), under the fill's own cap
   * (`BLOCK_READ_BYTES`, the constants-table row). One of:
   *   - `{ kind: 'header', header }` — the parsed header;
   *   - `{ kind: 'failure', failureKind, message? }` — a fetch that
   *     threw or timed out, or a non-2xx answer (the `retry` row of
   *     "The client's node list");
   *   - `{ kind: 'lie', detail }` — a body over the cap or that does
   *     not parse, a missing `header`, or `headerFromJson` answering
   *     `null` (the lie row of "The client's node list").
   * The caller applies the failure or the lie to the serving node;
   * `readHeaderAt` itself writes no event. The split
   * `classifyTipRead` makes is shared through `classifyNonOkRead`.
   */
  private async readHeaderAt(
    baseUrl: string,
    height: number,
    timedFetch: HttpFetch,
  ): Promise<HeaderReadResult> {
    const url = baseUrl + `/blocks/${String(height)}`;
    let response: Response;
    try {
      response = await timedFetch(url, undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { kind: 'failure', failureKind: 'transport', message };
    }
    const r = await readCappedJson<unknown>(response, BLOCK_READ_BYTES);
    if (!r.ok) {
      const c = classifyNonOkRead(r);
      if (c.kind === 'lie') return { kind: 'lie', detail: c.detail };
      return { kind: 'failure', failureKind: c.failureKind };
    }
    const data = r.data;
    if (!isRecord(data)) return { kind: 'lie', detail: 'block JSON is not an object' };
    const header = headerFromJson(data['header']);
    if (header === null) return { kind: 'lie', detail: 'header shape invalid' };
    return { kind: 'header', header };
  }

  /**
   * MESH_INTERFACE → The client's node list → "An entry may carry an API
   * base" — the base a check reads an id at, with its route: the mesh
   * base when the client holds an open connection to the key (the timed
   * fetch awaits the handshake there — the handshake belongs to the
   * connection, not the read), else the entry's api when it has one,
   * else the mesh base again so the read fails as transport by the
   * retry row (no api means no API-base route; the dial already failed).
   */
  private checkBase(id: string): { url: string; route: 'mesh' | 'api' } {
    if (this.hasOpenConnection(id)) {
      return { url: meshBaseUrl(id), route: 'mesh' };
    }
    const entry = this.nodeList.entry(id);
    if (entry && entry.api !== null) {
      return { url: entry.api, route: 'api' };
    }
    return { url: meshBaseUrl(id), route: 'mesh' };
  }

  /**
   * The first node (by candidate rank) whose tip read THIS check placed
   * `tip` against the final chain (MESH_INTERFACE → The client's node
   * list → "A check"). A `yours` entry in that set comes first — the
   * held tip's proof comes from your node when it is placed at the
   * client's tip (`→ Discovery → "Your node takes precedence"`); the
   * `under` reader and the own-tip prepend both want a node the chain
   * has just placed at the tip.
   */
  private firstNodeAtChainTip(placedAtTip: ReadonlySet<string>): string | null {
    for (const e of this.nodeList.entries()) {
      if (e.yours && placedAtTip.has(e.notisId)) return e.notisId;
    }
    for (const id of this.nodeList.candidates()) {
      if (placedAtTip.has(id)) return id;
    }
    return null;
  }

  /**
   * MESH_INTERFACE → The client's node list → "A check" — a check reads
   * every candidate's tip, `GET /blocks/current`, timed from the
   * request to the end of the body, and that time is the node's speed
   * until the next check. Only a `/blocks/current` read's time ends up
   * in the `readMs` target — the header reads for `above`/`under` and
   * the proof reads for an unplaced tip go through the same wrapper
   * but never overwrite a node's speed. The target map is a fresh one
   * for each check so a routed read in flight still answers from the
   * previous check's values until the swap at the end of the check.
   *
   * Traffic is cumulative over the client's life: a `/blocks/current`
   * read's bytes land in `tipBytes`, a `/blocks/<n>` read's in
   * `headerBytes`, a `/nipopow/proof/...` read's in `proofBytes`, and
   * one `proofReads` fires at the start of each proof read.
   */
  private makeTimedFetch(
    target: Map<string, number>,
    idByBase: ReadonlyMap<string, string> = new Map<string, string>(),
  ): HttpFetch {
    return async (url, init) => {
      // MESH_INTERFACE → The client's node list → "An entry may carry an
      // API base" — the URL may be a mesh URL or an http(s) one the
      // check asked at an entry's api base. `idByBase` holds every base
      // this check used (populated in `runCheck` before this helper
      // runs); a URL outside the map falls to `idOfMeshUrl` (bug
      // upstream for an http URL that was not registered).
      const baseAndPath = splitBaseAndPath(url);
      const id = idByBase.get(baseAndPath.base) ?? idOfMeshUrl(url);
      const path = baseAndPath.path;
      const bytesBucket: keyof ClientTraffic | null =
        path === '/blocks/current' ? 'tipBytes'
        : path.startsWith('/blocks/') ? 'headerBytes'
        : path.startsWith('/nipopow/proof/') ? 'proofBytes'
        : null;
      if (path.startsWith('/nipopow/proof/')) {
        this.state_.traffic.proofReads += 1;
      }
      const recordReadMs = path === '/blocks/current';
      // MESH_INTERFACE → The client's node list → "A check" — "timed
      // from the request to the end of the body". For a mesh URL the
      // connection's handshake is the connection's, not the read's, so
      // the clock starts once it is done; an API-base URL opens no
      // connection, so there is no handshake to await.
      if (url.startsWith('notis-mesh://')) await this.awaitHandshakeForNode(id);
      const startMs = this.clock();
      const response = await this.fetch(url, init);
      if (!response.body) {
        if (recordReadMs) target.set(id, this.clock() - startMs);
        return response;
      }
      const original = response.body;
      const clock = this.clock;
      const nid = id;
      const traffic = this.state_.traffic;
      const wrapped = new ReadableStream<Uint8Array>({
        start(controller) {
          const reader = original.getReader();
          void (async () => {
            try {
              for (;;) {
                const r = await reader.read();
                if (r.done) {
                  if (recordReadMs) target.set(nid, clock() - startMs);
                  controller.close();
                  return;
                }
                if (bytesBucket !== null && r.value !== undefined) {
                  traffic[bytesBucket] += r.value.length;
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

  private applyEvent(ev: TipEvent, route: 'mesh' | 'api' = 'mesh'): void {
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
        // MESH_INTERFACE → The client's node list — the API-base row:
        // "a malformed answer, a proof that fails verification … the
        // same at an entry's API base — the host, not the key —
        // HTTPS authenticates a name, never a node key — `retry`, as
        // a transport failure; never `blacklisted`". The evidence
        // detail rides as the failure's message so the page shows why.
        if (route === 'api') {
          const detail = `api ${ev.evidence.kind}: ${ev.evidence.detail}`;
          this.nodeList.failure(ev.id, 'transport', detail);
          this.latestEventReason.set(ev.id, `failure: transport: ${detail}`);
        } else {
          this.nodeList.lie(ev.id, ev.evidence);
          this.latestEventReason.set(ev.id, `lie: ${ev.evidence.kind}`);
        }
        break;
    }
  }

  private async dialByAddresses(id: string): Promise<void> {
    const entry = this.nodeList.entry(id);
    if (!entry) return;
    const addrs = [...entry.addrs];
    // Plain `/ws` without `/tls/` or `/wss` is the client's own refusal
    // (MESH_INTERFACE → Transports → "A client dials a private address
    // only when its own configuration names it"): the client's gater
    // refuses it in every runtime; this pre-filter also records the
    // per-address diagnostic so a reader sees which address failed how
    // (the gater's bulk refusal lands as one `DialDeniedError`).
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
            // The first-contact list carries the addrs without the
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
    const connections = this.libp2p.getConnections();
    const expected = toLibp2pPeerIdString(inUse);
    const conn = pickConnectionForLabel(connections, expected);
    if (!conn) {
      this.state_.transport = null;
      this.state_.path = null;
      return;
    }
    const ma = conn.remoteAddr.toString();
    const { transport, path } = classifyConnectionAddr(ma, connections);
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
   * row. The classification applies to the node the read went to. The
   * returned shape tells the caller — the check's phase 2 — the tip
   * height and hash for placement; the routed tip read discards it,
   * since `state.tip` is the chain's below.
   */
  private async classifyTipRead(
    response: Response,
    nodeId: string,
    route: 'mesh' | 'api' = 'mesh',
  ): Promise<TipClassification> {
    const r = await readCappedJson<unknown>(response, HEIGHT_READ_BYTES);
    const nowMs = this.clock();
    if (!r.ok) {
      const c = classifyNonOkRead(r);
      if (c.kind === 'lie') {
        this.applyEvent({
          id: nodeId,
          ev: 'lie',
          evidence: { kind: 'malformed', atMs: nowMs, detail: c.detail },
        }, route);
        return { kind: 'lie' };
      }
      this.applyEvent({ id: nodeId, ev: 'failure', kind: c.failureKind }, route);
      return { kind: 'failure' };
    }
    if (!isTipShape(r.data)) {
      this.applyEvent({
        id: nodeId,
        ev: 'lie',
        evidence: { kind: 'malformed', atMs: nowMs, detail: 'tip shape invalid' },
      }, route);
      return { kind: 'lie' };
    }
    return { kind: 'tip', height: r.data.height, hash: r.data.hash };
  }

  /**
   * Apply a `readHeaderAt` failure or lie to the serving node: a
   * failure moves it by `applyEvent({ ev: 'failure', ... })` (the
   * `retry` row of MESH_INTERFACE → The client's node list), a lie
   * by a `malformed` evidence (the lie row). The caller leaves the
   * tip unplaced.
   */
  private applyHeaderReadFailure(
    nodeId: string,
    result: Extract<HeaderReadResult, { kind: 'failure' } | { kind: 'lie' }>,
    route: 'mesh' | 'api' = 'mesh',
  ): void {
    if (result.kind === 'failure') {
      this.applyEvent({ id: nodeId, ev: 'failure', kind: result.failureKind, message: result.message }, route);
    } else {
      this.applyEvent({
        id: nodeId,
        ev: 'lie',
        evidence: { kind: 'malformed', atMs: this.clock(), detail: result.detail },
      }, route);
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

  /**
   * MESH_INTERFACE → The client's node list → "A read opens no
   * connection" — the strict read pick, gated on the handshake. The
   * open-direct-unlimited pick (`pickConnectionForRead`) is refused
   * when the connection's handshake has not completed with
   * `servesChain(capabilities)` true — no read goes out on the
   * connection before then.
   */
  private pickReadyConnection(notisId: string): Connection | null {
    const conn = pickConnectionForRead(
      this.libp2p.getConnections(),
      toLibp2pPeerIdString(notisId),
    );
    if (conn === null) return null;
    return this.handshakeResults.get(conn.id) === 'passed' ? conn : null;
  }

  /**
   * MESH_INTERFACE → Block gossip → "A client is a reader of every
   * node it holds a connection to" — on each connection the client
   * opens, run `net`'s handshake as the dialler with a reader's body:
   * the client's held chain's tip height (0 before it holds one), its
   * build's `PROTOCOL_VERSION`, an `agentName` naming the client. A
   * failed handshake moves the node to `retry` with the handshake's
   * reason named, never a lie, never `blacklisted`; a handshake that
   * declares no chain service (`!servesChain(capabilities)`) leaves
   * the node unread — it is not a node.
   */
  private async runHandshake(conn: Connection): Promise<'passed' | 'failed' | 'no-chain'> {
    if (this.stopped) return 'failed';
    const existing = this.handshakeResults.get(conn.id);
    if (existing !== undefined) return existing;
    try {
      notisIdFromPeerId(conn.remotePeer);
    } catch (e) {
      if (!(e instanceof MeshKeyError)) throw e;
      // A peer id that is not an Ed25519 key is not a Notis node;
      // the handshake reason below carries this to the read's failure.
    }
    const tip = this.chain.tip();
    const chainHeight = tip !== null ? tip.height : 0;
    // MESH_INTERFACE → Block gossip → "A client that serves answers
    // the nodes it reads" — the dialler declares
    // `SERVING_READER_CAPABILITIES` while the reader has been set to
    // serve, and the reader's default empty set otherwise.
    const result = await readerHandshake(conn, {
      magic: this.profile.magic,
      protocolVersion: PROTOCOL_VERSION,
      agentName: this.agentName,
      chainHeight,
      timeoutMs: 10_000,
      capabilities: this.servingOn ? SERVING_READER_CAPABILITIES : undefined,
    });
    if (this.stopped) return 'failed';
    if (!result.ok) {
      this.handshakeResults.set(conn.id, 'failed');
      this.handshakeReasons.set(conn.id, result.reason);
      this.emitStateChange();
      return 'failed';
    }
    if (!servesChain(result.capabilities)) {
      this.handshakeResults.set(conn.id, 'no-chain');
      this.handshakeReasons.set(conn.id, 'no chain service');
      try {
        const notisId = notisIdFromPeerId(conn.remotePeer);
        this.notAChainNodes.add(notisId);
      } catch (e) {
        if (!(e instanceof MeshKeyError)) throw e;
      }
      this.emitStateChange();
      return 'no-chain';
    }
    this.handshakeResults.set(conn.id, 'passed');
    this.emitStateChange();
    return 'passed';
  }

  /**
   * MESH_INTERFACE → Block gossip → "A client is a reader of every
   * node it holds a connection to" — await the handshake for the
   * connection the client's pick would open its stream on (open,
   * direct first, never limited). A handshake that declares no chain
   * service throws `HandshakeNoChainServiceError`, which the
   * read-caller catches and skips without a failure event (the entry
   * is not a node). A failed handshake throws `MeshFetchError` of
   * kind `transport` whose message starts with `handshake:`, so the
   * caller's failure event names it directly, never a lie. No open
   * connection: return at once; the inner fetch rejects with its own
   * transport reason.
   */
  private async awaitHandshakeForNode(notisId: string): Promise<void> {
    const conn = pickConnectionForRead(
      this.libp2p.getConnections(),
      toLibp2pPeerIdString(notisId),
    );
    if (conn === null) return;
    const pending = this.handshakeDone.get(conn.id);
    if (pending !== undefined) {
      try { await pending; } catch { /* reflected in handshakeResults */ }
    }
    const state = this.handshakeResults.get(conn.id);
    if (state === 'passed') return;
    if (state === 'no-chain') {
      throw new HandshakeNoChainServiceError(notisId);
    }
    const reason = this.handshakeReasons.get(conn.id) ?? 'failed';
    throw new MeshFetchError('transport', `handshake: ${reason}`);
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
        this.log?.(`[mesh-client] onState listener threw: ${messageOf(e)}`);
      }
    }
  }
}

function isBodyLevelFailure(r: NodeError): boolean {
  return r.body.startsWith(BODY_OVER_CAP) || r.body.startsWith(BODY_UNPARSEABLE);
}

/**
 * MESH_INTERFACE → The client's node list — the split a non-ok
 * `NodeResult` reads into: a `malformed` lie (a body over its cap or
 * that does not parse), or a failure of kind `timeout`, `transport`
 * or `refused` (the `retry` row of the table). Shared by the two
 * reads the client makes under this table — `classifyTipRead` and
 * `readHeaderAt`.
 */
function classifyNonOkRead(
  r: NodeError,
): { kind: 'lie'; detail: string } | { kind: 'failure'; failureKind: FailureKind } {
  if (isBodyLevelFailure(r)) return { kind: 'lie', detail: r.body };
  if (r.status === 0) {
    return { kind: 'failure', failureKind: r.timedOut === true ? 'timeout' : 'transport' };
  }
  return { kind: 'failure', failureKind: 'refused' };
}

type TipClassification =
  | { kind: 'tip'; height: number; hash: string | null }
  | { kind: 'failure' }
  | { kind: 'lie' };

type HeaderReadResult =
  | { kind: 'header'; header: BlockHeader }
  | { kind: 'failure'; failureKind: FailureKind; message?: string }
  | { kind: 'lie'; detail: string };

/**
 * Split a mesh or http(s) URL into its base (`notis-mesh://<id>` or
 * `<scheme>://<host>[:<port>]`) and its path (starting with `/`). The
 * fragments are the pair `urlToHash` and `idByBase` walk — a consistent
 * split for either scheme, so the check's traffic bucket and its
 * speed-record key read the same way whichever route served the read.
 */
function splitBaseAndPath(url: string): { base: string; path: string } {
  if (url.startsWith('notis-mesh://')) {
    const rest = url.slice('notis-mesh://'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return { base: url, path: '' };
    return { base: 'notis-mesh://' + rest.slice(0, slash), path: rest.slice(slash) };
  }
  // http(s)://host[:port]/path — find the first '/' after the scheme's `//`.
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return { base: url, path: '' };
  const after = schemeEnd + 3;
  const slash = url.indexOf('/', after);
  if (slash === -1) return { base: url, path: '' };
  return { base: url.slice(0, slash), path: url.slice(slash) };
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
 * every address (`withPeerId`). The first-contact list carries the bare
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
 *   `/.../tcp/.../p2p/R/p2p-circuit/webrtc/p2p/X`           → `{ webrtc, direct }`
 *   `/.../webrtc-direct/.../p2p/R/p2p-circuit/p2p/X`         → `{ webrtc-direct, relay }`
 *   `/.../tls/ws/p2p/R/p2p-circuit/p2p/X`                     → `{ wss, relay }`
 *   `/.../wss/p2p/R/p2p-circuit/p2p/X`                        → `{ wss, relay }`
 *   `/.../tcp/.../p2p/R/p2p-circuit/p2p/X`                    → the relay-peer connection's transport, `relay`
 *   `/.../webrtc-direct/.../p2p/X`                            → `{ webrtc-direct, direct }`
 *   `/.../tls/ws/p2p/X`                                       → `{ wss, direct }`
 *   `/.../wss/p2p/X`                                          → `{ wss, direct }`
 *
 * A circuit connection is named by what follows `p2p-circuit` first: a
 * `webrtc` or `webrtc-direct` component names an upgraded transport
 * with `path: 'direct'` and needs no base read. For a plain circuit
 * (no component after `p2p-circuit`) the base transport comes from
 * the relay hop's own components when that is a browser transport
 * (webrtc-direct, wss); otherwise libp2p reuses the browser's open
 * connection to the relay — whatever transport the relay hop names —
 * so the caller passes the client's connection list and the relay
 * peer's open connection's own transport names the base.
 *
 * No circuit: the base transport comes from the hop's own components
 * (a `webrtc-direct` component names `webrtc-direct`; a `tls`
 * component followed by `ws`, or a single `wss` component, names
 * `wss` — the client dials both forms, `isWSSAddr` reads either).
 *
 * An address this function cannot name is a thrown error at the call,
 * not a `null` that hides a bug: the connection reached a state the
 * client did not expect, and the caller must surface it.
 */
export function classifyConnectionAddr(
  ma: string,
  connections?: readonly Connection[],
): {
  transport: 'webrtc-direct' | 'webrtc' | 'wss';
  path: 'direct' | 'relay';
} {
  const components = multiaddr(ma).getComponents();
  const names = components.map((c) => c.name);
  const circuitIdx = names.indexOf('p2p-circuit');
  const before = circuitIdx === -1 ? names : names.slice(0, circuitIdx);

  const readBaseTransport = (slice: readonly string[]): 'webrtc-direct' | 'wss' | null => {
    if (slice.includes('webrtc-direct')) return 'webrtc-direct';
    if (slice.includes('wss')) return 'wss';
    const tlsIdx = slice.indexOf('tls');
    if (tlsIdx !== -1 && slice[tlsIdx + 1] === 'ws') return 'wss';
    return null;
  };

  if (circuitIdx === -1) {
    const base = readBaseTransport(before);
    if (base === null) {
      throw new Error(`cannot classify multiaddr base transport: ${ma}`);
    }
    return { transport: base, path: 'direct' };
  }

  // Circuit present. What follows `p2p-circuit` decides first.
  const after = names.slice(circuitIdx + 1);
  if (after.includes('webrtc')) {
    return { transport: 'webrtc', path: 'direct' };
  }
  if (after.includes('webrtc-direct')) {
    return { transport: 'webrtc-direct', path: 'direct' };
  }

  // Plain circuit. The relay hop's own components when that is a
  // browser transport; otherwise the client's open connection to the
  // relay peer names the actual base transport.
  const relayHopBase = readBaseTransport(before);
  if (relayHopBase !== null) {
    return { transport: relayHopBase, path: 'relay' };
  }
  if (connections !== undefined) {
    const relayComp = components[circuitIdx - 1];
    if (relayComp !== undefined && relayComp.name === 'p2p') {
      const relayPeerIdStr = typeof relayComp.value === 'string'
        ? relayComp.value
        : String(relayComp.value ?? '');
      if (relayPeerIdStr !== '') {
        const relayConn = pickConnectionForLabel(connections, relayPeerIdStr);
        if (relayConn !== null) {
          const classifiedRelay = classifyConnectionAddr(
            relayConn.remoteAddr.toString(),
            connections,
          );
          return { transport: classifiedRelay.transport, path: 'relay' };
        }
      }
    }
  }
  throw new Error(`cannot classify multiaddr base transport: ${ma}`);
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
        const { transport, path } = classifyConnectionAddr(conn.remoteAddr.toString(), connections);
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
 * connection" — "an open one, a direct one first, a relayed one when
 * that is all there is, never a limited one". The strict read pick:
 * `pickConnectionForLabel`'s result, refused when it is limited. The
 * shared part — open, right peer, direct first, unlimited preferred —
 * lives in the label pick.
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
