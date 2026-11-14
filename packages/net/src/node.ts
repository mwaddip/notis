import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@libp2p/gossipsub';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';

import type { Libp2p } from '@libp2p/interface';
import type { OrderingBlock, UtxoTransaction, BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION, protocolVersionAt, encodeOrderingBlock, decodePostBody, encodePostBody } from '@dagsocial/types';
import { derivePublicKeyFromSeed, seedOfSecretKey, NodeKeyError } from './node-key.js';
import { ReaderError } from '@dagsocial/wire';
import type {
  NetConfig, NetValidators, Peer, PeerEntryMsg,
  GetHeadersMsg, GetBlocksMsg,
} from './types.js';
import { PeerState, PenaltyKind } from './types.js';
import type { Libp2pGossip, GossipHandlers, GossipTopics } from './gossip.js';
import { PeerManager } from './peer-mgr.js';
import {
  subscribeTopics,
  broadcastOrderingBlock,
  broadcastTx,
} from './gossip.js';
import { gossipTopics, gossipsubOptions } from './gossip-rules.js';
import {
  HANDSHAKE_PROTOCOL,
  SYNC_PROTOCOL,
  requestHeaders,
  requestBlocks,
  oneRoundTrip,
  connectedPeer,
} from './sync.js';
import {
  encodeGetPeers,
  decodeGetPeers,
  encodePeers,
  decodePeers,
  decodeGetHeaders,
  decodeGetBlocks,
  encodeBlocks,
  encodeHeaders,
  encodeModifierRequest,
  decodeModifierRequest,
  encodeModifierResponse,
  decodeModifierResponse,
} from './sync-codec.js';
import { isBogusAddress, isLoopbackAddress } from './bogus-addr.js';
import { readStreamBounded, sinkWithDeadline, addressWithoutPeerId, peerIdOfAddress } from './util.js';
import {
  HANDSHAKE_DEADLINE_FACTOR,
  HANDSHAKE_SLACK,
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_INBOUND_HANDSHAKE_STREAMS,
  MAX_INBOUND_SYNC_STREAMS,
  MAX_INV_IDS,
  MAX_SERVE_BODY_BYTES,
  MAX_STREAM_BYTES,
  YAMUX_STREAM_WINDOW_BYTES,
} from './msg-guards.js';
import { PeerDb, type PeerStorage } from './peerdb.js';
import { SyncMachine } from './sync-machine.js';
import type { SyncStore } from './sync-machine.js';
import { OutboundManager } from './outbound-mgr.js';
import { NODE_CAPABILITIES, servesChain, declares } from './capabilities.js';
import { decodeFrame, KNOWN_FRAME_MAGICS } from './frame.js';
import {
  buildHandshakeFrame,
  decodeHandshakeBody,
  handshakePenalty,
  validateHandshake,
} from './handshake.js';
import type { HandshakeResult } from './handshake.js';

/**
 * The outcome of `admitOutboundConnection` — the handshake succeeded and
 * the peer was admitted (or found already Active), or the handshake or an
 * admission check closed the connection. The shared Promise's value: the
 * dial funnel reads `ok` to decide its source-specific bookkeeping
 * (NET_INTERFACE → Outbound Manager — `markBootstrapSettled`,
 * `recordDialResult`), and reads `handshake` for the agent and node names
 * the dialled-address PeerDb record keeps.
 */
interface OutboundAdmissionResult {
  ok: boolean;
  handshake?: HandshakeResult;
}
import {
  MSG_GET_PEERS,
  MSG_PEERS,
  MSG_SYNC_INFO,
  MSG_GET_HEADERS,
  MSG_GET_BLOCKS,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_POST_BODY,
} from './types.js';
import type { ModifierRequest, ModifierResponse } from './sync-types.js';
import { FaultTolerance } from '@libp2p/interface';
import { assertMeshConfig, type WssConfig } from './mesh/config.js';
import { assertStateDirIntegrity, openMeshDatastore } from './mesh/state-dir.js';
import { stunSettingFor } from './mesh/stun-setting.js';
import { startStunServer } from './mesh/stun.js';
import {
  meshListenAddrs,
  meshPublicServices,
  meshPrivateServices,
  meshPrivateCircuitTransport,
  meshPrivateWebRTCTransport,
  meshWebRTCDirectTransport,
  privateAnnounceFilter,
  effectiveAnnounce,
} from './mesh/libp2p-options.js';
import { startRelayRetry, type RelayRetry } from './mesh/relay-retry.js';
import { RETRY_BASE_MS, RETRY_CAP_MS } from './mesh/constants.js';
import {
  notisIdFromPeerId,
  localAddrsFor,
} from './mesh/identity.js';
import { acmeSource, type CertificateSource, type IpCertificate } from './mesh/acme.js';
import {
  initialCertificate,
  startWssRenewal,
  type WssOptions,
  type WssRenewal,
} from './mesh/wss.js';
import { webSockets } from '@libp2p/websockets';
import { isIPv6 } from 'node:net';

type OrderingBlockCallback = (block: OrderingBlock, fromPeerId: string) => void;

/**
 * NET_INTERFACE → The mesh — the mesh identity `meshIdentity()` answers
 * once a mesh node's addresses are announced; `null` with no mesh.
 */
export interface MeshIdentity {
  readonly notisId: string;
  readonly peerId: string;
  readonly multiaddrs: readonly string[];
  readonly localAddrs: readonly string[];
}

/**
 * Flatten every transport listener's own `getAddrs()` — the
 * WebRTC-direct listener splices its `/certhash/` onto its listen
 * address at read time (`@libp2p/webrtc`
 * `private-to-public/listener.ts`), so an identity line's
 * `localAddrs` can see the certhash from this source.
 */
function listenerAddrsOf(node: Libp2p): string[] {
  const components = (node as unknown as {
    components?: {
      transportManager?: {
        getListeners(): Array<{ getAddrs(): Array<{ toString(): string }> }>;
      };
    };
  }).components;
  const tm = components?.transportManager;
  if (!tm) return [];
  const out: string[] = [];
  for (const l of tm.getListeners()) {
    for (const a of l.getAddrs()) out.push(a.toString());
  }
  return out;
}
type TxCallback = (tx: UtxoTransaction, content: string | undefined, fromPeerId: string) => boolean;

/**
 * Return the libp2p node cast to the Libp2pGossip interface expected by the
 * gossip module.  The createLibp2p call configures gossipsub as a service so
 * the runtime shape is correct; this cast bridges the gap between the concrete
 * libp2p generic and the structural interface gossip.ts uses.
 */
function asGossip(libp2p: Libp2p): Libp2pGossip {
  return libp2p as unknown as Libp2pGossip;
}

/**
 * The two methods net's local gossipsub patch adds to `GossipSub` after
 * construction (MESH_INTERFACE → Place in the workspace → "libp2p is
 * pinned"). Not published on `@libp2p/gossipsub`'s `GossipSub`
 * interface, so the pubsub service is read through this local
 * intersection type at the call sites — the shape `gossip.ts`'
 * `Libp2pGossip` uses for `reportMessageValidationResult`
 * (NET_INTERFACE → Readers → "A reader is its node's gossip direct peer";
 * MESH_INTERFACE → Block gossip → "A node's readers are its router's
 * direct peers").
 */
interface DirectPeerRouter {
  services: {
    pubsub: {
      addDirectPeer(id: string): void;
      removeDirectPeer(id: string): void;
    };
  };
}
function asDirectPeerRouter(libp2p: Libp2p): DirectPeerRouter {
  return libp2p as unknown as DirectPeerRouter;
}

/** First 4 bytes as a big-endian u32 (unsigned — see decodeFrame), or null if shorter. */
function leadingMagic(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  return ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
}

export type HandshakePayload =
  | { kind: 'framed'; body: Uint8Array }
  | { kind: 'reject'; code: 'wrong-magic' | 'unsupported-version' | 'checksum-mismatch' | 'not-a-frame' };

/**
 * Decode a handshake payload as a frame — NET_INTERFACE → "A handshake is
 * a frame or it is nothing."
 *
 * A valid frame yields its body. Every failure is a reject: recognized
 * foreign magic (`wrong-magic`), unsupported frame version, checksum
 * mismatch, or anything else — truncated data, leading bytes matching no
 * known magic (`not-a-frame`). No payload reaches a positional decoder
 * except as the body of a checksum-verified frame.
 *
 * NET_INTERFACE → "Ban policy": every code this function returns is
 * frame-tier — stream closed, no penalty.
 */
export function decodeHandshakePayload(magic: number, data: Uint8Array): HandshakePayload {
  try {
    return { kind: 'framed', body: decodeFrame(magic, data).body };
  } catch (err) {
    if (err instanceof ReaderError) {
      switch (err.code) {
        case 'wrong-magic': {
          const lead = leadingMagic(data);
          if (lead !== null && KNOWN_FRAME_MAGICS.includes(lead)) {
            return { kind: 'reject', code: 'wrong-magic' };
          }
          return { kind: 'reject', code: 'not-a-frame' };
        }
        case 'unsupported-version':
        case 'checksum-mismatch':
          return { kind: 'reject', code: err.code };
        default:
          return { kind: 'reject', code: 'not-a-frame' };
      }
    }
    return { kind: 'reject', code: 'not-a-frame' };
  }
}

/**
 * Lazy adapter implementing SyncStore by delegating to functions that are set
 * after construction.
 *
 * Exported for the same reason `servePeersBody` and `decodeHandshakePayload`
 * are: so tests drive **this** code rather than a copy of it. It is not part of
 * net's published surface — `src/index.ts` is an explicit named allowlist, not
 * `export *`, and `package.json` publishes only `"."` → `dist/index.js`, so this
 * class is reachable only by a source-relative import from inside the package.
 * `dist/index.d.ts` is asserted free of it by `sync-store.test.ts`.
 */
export class LazySyncStore implements SyncStore {
  private _chainHeightProvider: (() => number) | null = null;
  private _blockIdProvider: ((height: number) => string | null) | null = null;
  private _heightByBlockIdProvider: ((id: string) => number | null) | null = null;

  constructor(_validators: NetValidators) {}

  setChainHeightProvider(fn: () => number): void {
    this._chainHeightProvider = fn;
  }

  // NET_INTERFACE → Sync Handler Registration
  setBlockIdProvider(fn: (height: number) => string | null): void {
    this._blockIdProvider = fn;
  }

  // NET_INTERFACE → Sync Handler Registration
  setHeightByBlockIdProvider(fn: (id: string) => number | null): void {
    this._heightByBlockIdProvider = fn;
  }

  // NET_INTERFACE → Sync Handler Registration: the id this arm announces is
  // the store's own, read through the provider.
  getOrderingBlockId(height: number): string | null {
    return this._blockIdProvider?.(height) ?? null;
  }

  // NET_INTERFACE → Sync Handler Registration: one id is one provider call.
  heightByBlockId(id: string): number | null {
    return this._heightByBlockIdProvider?.(id) ?? null;
  }

  chainHeight(): number {
    return this._chainHeightProvider?.() ?? 0;
  }
}

// ---------------------------------------------------------------------------
// GetHeaders (14) / GetBlocks (16) serve side
//
// One function per code, because the code pair is the discriminator: a single
// function branching on a field inside the body would be re-erecting the `mode`
// field the positional requests drop (NET_INTERFACE → `GetHeaders` /
// `GetBlocks` responses).
//
// Module-level and exported for the reason `servePeersBody`,
// `decodeHandshakePayload` and `LazySyncStore` are: the tests drive **these**
// functions rather than a copy of the serve loops. A test double that
// re-implements those loops stays green through a change to the response wire
// format, which is the one thing a protocol suite exists to notice.
//
// Both are bounded by what the peer asked for and by
// `MAX_CHAIN_RESPONSE_ITEMS`. The locator (headers) and the ids (blocks) are
// peer-chosen, each capped at the wire bound of its codec; the response reads
// at most `MAX_CHAIN_RESPONSE_ITEMS` entries, which keeps the length of the
// response off the peer's control panel.
//
// A count bounds a length and says nothing about a weight, so the blocks loop
// carries a second, independent bound: it accumulates encoded bytes and stops
// before exceeding `MAX_SERVE_BODY_BYTES` (NET_INTERFACE → Validation (and
// untrusted-input safety)). Blocks are bounded individually by
// `MAX_BLOCK_BODY_BYTES`, and 400 of those is far past what any requester will
// read off a stream.
//
// The headers loop reads headers directly through the header provider (one
// height is one provider call) and is bounded by count alone: a header's
// ceiling is `MAX_HEADER_BYTES`, so 400 of them stay well under the serve
// byte cap — the argument the contract spells out at NET_INTERFACE → Stream
// Protocols, the `Headers` arm bullet of `GetHeaders` / `GetBlocks`
// responses.
//
// `ourHeight` clamps the headers loop to our own tip (unread in the blocks
// loop; see the arm's own doc): we cannot serve what we do not have, so this
// never truncates a legitimate request, and a peer asking for height 1e15
// costs us nothing.
//
// Both throw only if a block *we* hold has no encoding — a corrupt local store,
// not a peer's doing. The caller's `catch` answers with zero bytes, as it does
// for every other local failure.
// ---------------------------------------------------------------------------

/**
 * Frame a `Headers` (15) response.
 *
 * NET_INTERFACE → `GetHeaders` / `GetBlocks` responses →
 * "A `Headers` page has one shape, and a requester holds a page to it":
 * the serve arm takes the first locator entry its applied chain holds —
 * the highest, the locator running from the tip down — and answers the
 * headers above it, ascending, for `MAX_CHAIN_RESPONSE_ITEMS` headers or
 * up to its tip; a locator it holds no entry of is answered from
 * height 1, and one whose highest held entry is its tip with an empty
 * list.
 */
export function serveHeadersResponse(
  magic: number,
  request: GetHeadersMsg,
  ourHeight: number,
  heightByBlockId: (id: string) => number | null,
  getHeader: (height: number) => BlockHeader | null,
): Uint8Array {
  let aboveHeight = 0;
  for (const hash of request.locator) {
    const matched = heightByBlockId(hash);
    if (matched !== null) {
      aboveHeight = matched;
      break;
    }
  }
  const headers: BlockHeader[] = [];
  const first = aboveHeight + 1;
  const last = Math.min(ourHeight, aboveHeight + MAX_CHAIN_RESPONSE_ITEMS);
  for (let h = first; h <= last; h++) {
    const header = getHeader(h);
    if (!header) break; // gap — the chain above the locator match is not ours to serve
    headers.push(header);
  }
  return encodeHeaders(magic, headers);
}

/**
 * Frame a `Blocks` (17) response.
 *
 * NET_INTERFACE → `GetHeaders` / `GetBlocks` responses →
 * "The `Blocks` arm answers the ids asked that its applied chain holds":
 * each id is resolved by point lookup (`heightByBlockId`) and its block
 * read once through the headers handler, in the order asked; an id this
 * chain does not hold is omitted — "not held", never a refusal.
 *
 * Each block is encoded once, here: the encoding is both what the response
 * carries and what the byte bound weighs. The byte bound accumulates and
 * stops before exceeding `MAX_SERVE_BODY_BYTES`, and **always includes the
 * first block**, so a request is never answered with nothing while the
 * server holds what was asked (NET_INTERFACE → `GetHeaders` / `GetBlocks`
 * responses → "always include the first block"). NET_INTERFACE →
 * `GetHeaders` / `GetBlocks` responses → "An id asked twice is answered
 * twice": the arm reads the ids in order and keeps no cross-id state.
 *
 * `ourHeight` is unread here: `heightByBlockId` answers only heights of
 * the applied chain, in the same synchronous call as the one `chainHeight()`
 * reads, so a height above the tip is unreachable through this seam. The
 * parameter stands for the shared `serveChainQuery` signature the arm's
 * caller passes it under.
 */
export function serveBlocksResponse(
  magic: number,
  request: GetBlocksMsg,
  _ourHeight: number,
  heightByBlockId: (id: string) => number | null,
  getBlock: (height: number) => OrderingBlock | null,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  let bodyBytes = 0;
  for (const id of request.ids) {
    const height = heightByBlockId(id);
    if (height === null) continue;
    const block = getBlock(height);
    if (!block) continue;
    const data = encodeOrderingBlock(block);
    if (blocks.length > 0 && bodyBytes + data.length > MAX_SERVE_BODY_BYTES) break;
    bodyBytes += data.length;
    blocks.push(data);
  }
  return encodeBlocks(magic, blocks);
}

// ---------------------------------------------------------------------------
// Post body serve (MODIFIER_POST_BODY 103 — NET_INTERFACE → ModifierRequest)
//
// Served on the request's own stream, never relayed. Module-level and exported
// so the tests drive the same code the stream handler calls.
// ---------------------------------------------------------------------------

/**
 * Frame a `ModifierResponse` (5) for post bodies: the bodies we hold,
 * byte-bounded. Returns `null` when no requested body is available — the
 * caller answers with zero bytes (NET_INTERFACE → ModifierResponse).
 */
export function servePostBodiesResponse(
  magic: number,
  req: ModifierRequest,
  provider: (id: string) => string | null,
): Uint8Array | null {
  const modifiers: { id: string; data: Uint8Array }[] = [];
  let bodyBytes = 0;

  for (const id of req.ids) {
    const content = provider(id);
    if (content === null) continue;
    const data = encodePostBody(content);
    if (modifiers.length > 0 && bodyBytes + data.length > MAX_SERVE_BODY_BYTES) break;
    bodyBytes += data.length;
    modifiers.push({ id, data });
  }

  if (modifiers.length === 0) return null;
  const resp: ModifierResponse = { typeId: req.typeId, modifiers };
  return encodeModifierResponse(magic, resp);
}

// ---------------------------------------------------------------------------
// Peer exchange (GetPeers / Peers — NET_INTERFACE → Peer Discovery)
//
// The serve, intake, and cadence decisions live in module-level functions so
// the tests drive the same code the stream handler and timer call — not a
// copy. The stream plumbing around them is exercised by the integration suite.
// ---------------------------------------------------------------------------

/**
 * Cadence of the outbound manager's tick — the floor phase's bootstrap re-dial
 * and the fill phase's one dial per tick (NET_INTERFACE → Outbound Manager).
 *
 * **Fixed, not configurable, because two other cadences are sized against it.**
 * A knob here would let an operator move a number that other components treat
 * as a constant, and neither of them can see the change:
 *
 * - `GET_PEERS_INTERVAL_MS` below is a deadline this tick samples, so the
 *   realised peer-exchange cadence is a multiple of this value. Above 120s,
 *   this interval — not that one — is what governs discovery.
 * - `DISCOVERY_WINDOW_MS` in `@dagsocial/node`'s peer-readiness service spans
 *   one tick with margin, so a bootstrap dial that fails gets a second attempt
 *   before the node concludes it is alone. Above 45s, that window expires
 *   first and a node that had a peer available strands itself.
 */
const OUTBOUND_TICK_INTERVAL_MS = 30_000;

/** Cadence for sending GetPeers to each Active peer. */
export const GET_PEERS_INTERVAL_MS = 120_000;

/** Most entries served in one Peers response ("up to 8"). */
export const GET_PEERS_RESPONSE_LIMIT = 8;

/**
 * Serve one GetPeers request body: reply with up to GET_PEERS_RESPONSE_LIMIT
 * recently-seen PeerDb entries, leaving out every address the requester's
 * metadata carries — the address this node dialled, when there is one
 * (NET_INTERFACE → Ban surfaces are unified). Returns the framed Peers
 * response — `{ peers: [] }` when PeerDb has nothing, so the requester is
 * answered rather than left to time out — or `null` for a malformed request,
 * which is a protocol violation (permanent ban).
 *
 * Each address goes into the exclude set normalised through
 * `addressWithoutPeerId`, so a candidate `recent()` compares bare matches a
 * seed, a dialled or a declared spelling of the same host alike
 * (NET_INTERFACE → PeerDb).
 *
 * Discovery is served whatever our own sync phase is: nothing here consults
 * the sync machine.
 */
export function servePeersBody(
  body: Uint8Array,
  deps: {
    peerDb: PeerDb | null;
    peerMgr: PeerManager;
    peerId: string;
    magic: number;
  },
): Uint8Array | null {
  const request = decodeGetPeers(body);
  if (!request) {
    console.warn(`[net] malformed GetPeers from ${deps.peerId}, dropping`);
    deps.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, deps.peerId, 'malformed GetPeers');
    return null;
  }
  const exclude = new Set<string>();
  const meta = deps.peerMgr.getPeerMetadata(deps.peerId);
  if (meta?.address) exclude.add(addressWithoutPeerId(meta.address));
  if (meta?.declaredAddress) exclude.add(addressWithoutPeerId(meta.declaredAddress));
  const records = deps.peerDb?.recent(GET_PEERS_RESPONSE_LIMIT, exclude) ?? [];
  const peers: PeerEntryMsg[] = records.map((r) => ({
    address: r.address,
    agentName: r.agentName,
    nodeName: r.nodeName,
    protocolVersion: r.protocolVersion,
    capabilities: r.capabilities,
  }));
  return encodePeers(deps.magic, { peers });
}

/**
 * Intake one Peers response body into PeerDb. A gossiped address is hearsay — a
 * third party's claim about a peer we may never have met — so every recorded
 * entry is stamped `lastSeenMs: 0`, below any peer we have actually connected to
 * (NET_INTERFACE → "A gossiped address is a hint below a seen peer"). It fills
 * only cold capacity and is the first evicted, so a flood of junk addresses
 * cannot displace a peer we have seen; and because `record` merges by the newer
 * `lastSeenMs`, hearsay never advances an existing entry's recency either.
 *
 * A body that fails decode (malformed, or over the 64-entry cap) permanently
 * bans the sender. A bogus address inside a valid body is dropped silently
 * with NO penalty — a NAT'd peer advertising its private address is normal
 * operation, not misbehavior. Self and banned addresses are refused by
 * `PeerDb.record` itself.
 *
 * Returns the number of entries handed to PeerDb, or `null` when the body was
 * malformed.
 */
export function intakePeersBody(
  body: Uint8Array,
  deps: {
    peerDb: PeerDb | null;
    peerMgr: PeerManager;
    peerId: string;
    magic: number;
  },
): number | null {
  const msg = decodePeers(body);
  if (!msg) {
    console.warn(`[net] malformed Peers from ${deps.peerId}, banning`);
    deps.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, deps.peerId, 'malformed Peers response');
    return null;
  }
  let usable = 0;
  for (const e of msg.peers) {
    if (isBogusAddress(e.address, deps.magic)) continue;
    deps.peerDb?.record({
      address: e.address,
      lastSeenMs: 0,
      agentName: e.agentName,
      nodeName: e.nodeName,
      protocolVersion: e.protocolVersion,
      capabilities: e.capabilities,
    });
    usable++;
  }
  return usable;
}

/**
 * Which peers are due a GetPeers this tick: Active state, `servesChain` of
 * its declared capabilities, and no send within the last
 * GET_PEERS_INTERVAL_MS. Stamps `lastSentMs` for every returned id, so a
 * peer is never picked twice inside one interval. A peer with no stamp
 * (fresh handshake) is due immediately — the bootstrap flow sends GetPeers
 * right after handshake, not two minutes later. NET_INTERFACE → Readers —
 * "A reader is never asked for chain data": readers are skipped.
 */
export function duePeerExchange(
  peerMgr: PeerManager,
  lastSentMs: Map<string, number>,
  nowMs: number,
): string[] {
  const due: string[] = [];
  for (const peer of peerMgr.getPeers()) {
    if (!peerMgr.isPeerActive(peer.id)) continue;
    const caps = peer.capabilities;
    if (!caps || !servesChain(caps)) continue;
    const last = lastSentMs.get(peer.id);
    if (last !== undefined && nowMs - last < GET_PEERS_INTERVAL_MS) continue;
    lastSentMs.set(peer.id, nowMs);
    due.push(peer.id);
  }
  return due;
}

export class NetNode {
  private libp2p: Libp2p | null = null;
  private peerMgr: PeerManager;
  private config: NetConfig;
  private validators: NetValidators;
  /**
   * The relay-path membership set — see `KarmaMembers` in gossip.ts. Owned here
   * so the topic validator reads one object rather than calling across the
   * package seam per message; node moves it on the two events that change it.
   */
  private karmaMembers = new Set<string>();
  // The two topic strings this node hears (NET_INTERFACE → Gossip Topics →
  // "A topic is named for its network"). Built from `config.magic` at
  // `start()`; broadcasts, subscriptions and the listener's `topic` compare
  // all read this one pair.
  private topics: GossipTopics | null = null;
  private orderingBlockHandlers: OrderingBlockCallback[] = [];
  private txHandlers: TxCallback[] = [];
  private started = false;
  /**
   * The era in force — the version scheduled at the tip this node has applied.
   * Initialised at start() from chainHeight() + 1 and moved by tipApplied when a
   * boundary is crossed (NET_INTERFACE → Post-Handshake Routing). The base era is
   * always 1 (every schedule's first era is { version: 1, fromHeight: 0 }).
   */
  private eraInForce = 1;

  // New sync infrastructure
  private peerDb: PeerDb | null = null;
  private peerStorage: PeerStorage | null;
  private syncMachine: SyncMachine | null = null;
  private outboundMgr: OutboundManager | null = null;
  private syncStore: LazySyncStore;
  /**
   * The set of configured bootstrap addresses whose first dial has
   * ended — Active, failed, or retired as this node's own
   * (NET_INTERFACE → Sync State Machine → "The gate bounds how far
   * blocks apply."). Settled stays settled; redials never reopen the
   * pending state.
   */
  private bootstrapSettledAddrs = new Set<string>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The whole-block provider for `GetBlocks` (16). NET_INTERFACE → Sync
   * Handler Registration: setters are order-independent, so the sync protocol
   * is registered by start() whether or not a provider exists yet, and a
   * query that arrives without one is answered with zero bytes.
   */
  private headersProvider: ((height: number) => OrderingBlock | null) | null = null;
  /**
   * The header-at-height provider for `GetHeaders` (14). One height is one
   * provider call — a whole-block read there decodes up to 400 bodies of
   * up to `MAX_BLOCK_BODY_BYTES` for a seven-byte request
   * (NET_INTERFACE → Sync Handler Registration).
   */
  private headerProvider: ((height: number) => BlockHeader | null) | null = null;
  private syncCompleteHandlers: Array<() => void> = [];
  private peerActiveHandlers: Array<(peerId: string, direction: 'inbound' | 'outbound') => void> = [];
  private readerActiveHandlers: Array<(peerId: string) => void> = [];
  private peerDisconnectedHandlers: Array<(peerId: string, reason: string) => void> = [];
  private peerPenalisedHandlers: Array<(peerId: string, kind: string, detail: string | null) => void> = [];
  // NET_INTERFACE → Sync Handler Registration
  private scheduledTargetProvider: ((header: BlockHeader) => number | null) | null = null;
  // The header-standing seam `setHeaderStandingProvider` carries
  // (NET_INTERFACE → Sync Handler Registration).
  private headerStandingProvider: ((hash: string, height: number) => 'held' | 'refused' | null) | null = null;
  // NET_INTERFACE → Sync Handler Registration: post body seams
  private postBodyProvider: ((postId: string) => string | null) | null = null;
  // NET_INTERFACE → Sync Handler Registration: setPipeline / setChainView —
  // held at construction, handed to the scheduler at start() (handler
  // setters are order-independent).
  private pipeline: import('./sync-types.js').PipelineIntake | null = null;
  private chainViewRegistered: import('./sync-types.js').ChainView | null = null;
  private pendingDials: Set<string> = new Set();
  private lastGetPeersSentMs: Map<string, number> = new Map();
  /**
   * Per-peer serve queue — NET_INTERFACE → Stream Protocols → "A peer's sync
   * streams are served one at a time". Each incoming sync stream from a peer
   * chains onto that peer's tail, so a stream is read only once its turn
   * arrives and its read deadline starts there. The entry is dropped when the
   * peer disconnects, so a disconnected peer's queue does not accrue.
   */
  private peerStreamQueues: Map<string, Promise<void>> = new Map();
  /**
   * The ids of connections that have carried a handshake stream — a fact
   * kept by connection id while the connection stands, dropped at its close
   * (NET_INTERFACE → Handshake → "A connection carries one handshake,
   * opened by the side that dialled it"). The listener marks on arrival;
   * `connection:close` drops.
   */
  private handshakenConnections: Set<string> = new Set();
  /**
   * The ids of connections whose handshake has completed — the listener
   * marks after it answers a valid handshake, the dialler after its own
   * handshake returns ok (NET_INTERFACE → Handshake →
   * "A connection handshakes within its deadline, or is closed"). The
   * deadline timer reads this set and closes the connection when the
   * handshake has not completed by its expiry.
   */
  private completedConnections: Set<string> = new Set();
  /**
   * The shared outbound-admission Promise for each outbound connection
   * (NET_INTERFACE → Handshake → "Every connection this node dialled carries
   * its handshake, whoever within the node dialled it"). The ownership mark:
   * the first writer runs the handshake; every later caller — the dial
   * funnel awaiting its own dial, or a second open hook on the same
   * connection id — reads this map and awaits the Promise rather than
   * opening a second handshake stream. Dropped at `connection:close` and
   * cleared at `stop()`.
   */
  private outboundAdmissions: Map<string, Promise<OutboundAdmissionResult>> = new Map();
  /**
   * Per-connection timers that close a connection whose handshake has not
   * completed `HANDSHAKE_DEADLINE_FACTOR × syncRequestTimeoutMs` after its
   * open (NET_INTERFACE → Handshake →
   * "A connection handshakes within its deadline, or is closed"). Each timer
   * is `unref`ed, so a live one never holds the process open; cleared at
   * `connection:close` and at `stop()`.
   */
  private handshakeDeadlines: Map<string, NodeJS.Timeout> = new Map();

  /**
   * NET_INTERFACE → The mesh — the STUN server that rides a public
   * mesh node. Opened after libp2p at `start`, closed before libp2p
   * at `stop` (`MESH_INTERFACE → NAT`). `null` when no mesh is set,
   * or when the mesh is set with `stun: null` or no WebRTC-direct
   * listen was picked.
   */
  private meshStun: { close(): Promise<void> } | null = null;
  /**
   * NET_INTERFACE → The mesh — the callers subscribed through
   * `onMeshAddresses`. Fires for each change of the announced set
   * (`self:peer:update` from libp2p).
   */
  private meshAddressHandlers: Array<(id: MeshIdentity) => void> = [];
  /**
   * The `self:peer:update` listener registered with libp2p, kept for
   * removal at `stop` (`MESH_INTERFACE → NAT`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private meshSelfPeerUpdateListener: ((ev: any) => void) | null = null;
  /**
   * NET_INTERFACE → The mesh — a private mesh node's relay-listen
   * retries, one per `bootstrapPeers` entry. Started after libp2p's
   * floor dial has opened the TCP connection to each seed, stopped
   * before libp2p at `stop` (`MESH_INTERFACE → NAT → "A relay that
   * does not answer never stops a private node"`).
   */
  private relayRetries: RelayRetry[] = [];
  /**
   * NET_INTERFACE → The mesh — a public mesh node's WSS renewal
   * driver (`MESH_INTERFACE → The IP certificate`). Started after
   * libp2p when `mesh.wss` is set and the state directory holds a
   * valid certificate or `obtain()` succeeds at start; stopped
   * before libp2p at `stop`.
   */
  private wssRenewal: WssRenewal | null = null;
  /**
   * `MESH_INTERFACE → The IP certificate` — the factory the mesh
   * branch of `start()` builds its `CertificateSource` from. Absent,
   * `acmeSource(...)` runs the production path. The seam mirrors
   * `peerStorage`'s standing on the constructor — an optional
   * dependency a caller (a test) hands in, never a private field a
   * test reaches past the type.
   */
  private readonly certificateSource:
    | ((wss: WssConfig, stateDir: string) => CertificateSource)
    | null;

  constructor(
    config: NetConfig,
    validators: NetValidators,
    peerStorage?: PeerStorage,
    certificateSource?: (wss: WssConfig, stateDir: string) => CertificateSource,
  ) {
    this.config = config;
    this.validators = validators;
    this.syncStore = new LazySyncStore(validators);
    // Omitted in tests/embedded use — PeerDb then runs ephemeral (NET_INTERFACE →
    // Persistence seam), which is the valid non-production configuration.
    this.peerStorage = peerStorage ?? null;
    this.certificateSource = certificateSource ?? null;
    // Ban hooks late-bind this.peerDb: it is created in start(), and the
    // closures read it at call time, so bans imposed before start (or after
    // stop) simply have no address surface to propagate to.
    this.peerMgr = new PeerManager(config, {
      onBan: (address) => this.peerDb?.ban(address),
      onUnban: (address) => this.peerDb?.unban(address),
      onPenalty: (peerId, kind, detail) => {
        for (const cb of this.peerPenalisedHandlers) {
          try { cb(peerId, kind, detail); } catch (err) {
            console.warn(`[net] peerPenalised handler error: ${String(err)}`);
          }
        }
      },
      // NET_INTERFACE → "A ban ends the connection"
      onBanned: (peerId) => {
        this.disconnectPeer(peerId);
        this.syncMachine?.onPeerDisconnect(peerId);
      },
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;

    // The era in force at the tip we start from (NET_INTERFACE →
    // Post-Handshake Routing). A valid schedule and a non-negative height place
    // us in an era; the base era 1 stands if they somehow do not.
    this.eraInForce = this.currentEra() ?? 1;

    // NET_INTERFACE → Gossip Topics → "A topic is named for its network".
    // A magic that is not an unsigned 32-bit integer throws here — a node with
    // no network does not start on a topic of its own.
    this.topics = gossipTopics(this.config.magic);
    const topics = this.topics;

    // NET_INTERFACE → The node key → "`net` runs under the key its caller hands it".
    // The pair's `publicKey` must be its seed's; a cross-wired pair would build
    // a libp2p identity the private key cannot sign for. The throw lands before
    // `createLibp2p`, so nothing listens behind it (NET_INTERFACE → Node Lifecycle).
    const nodeKey = this.config.nodeKey;
    const seed = seedOfSecretKey(nodeKey.secretKey);
    const derivedPub = await derivePublicKeyFromSeed(seed);
    if (derivedPub.length !== nodeKey.publicKey.length
        || !derivedPub.every((b, i) => b === nodeKey.publicKey[i])) {
      throw new NodeKeyError("nodeKey.publicKey does not match the seed of nodeKey.secretKey");
    }
    // `@libp2p/crypto` reads a 64-byte Ed25519 raw private key as seed ‖ publicKey;
    // its 32-byte form is read as secp256k1, so the length disambiguates the key
    // type.
    const rawPrivate = new Uint8Array(64);
    rawPrivate.set(seed, 0);
    rawPrivate.set(nodeKey.publicKey, 32);
    const libp2pPrivateKey = privateKeyFromRaw(rawPrivate);

    // NET_INTERFACE → The mesh — with `mesh`, hold every refusal
    // `MESH_INTERFACE` names and the state-directory refusal before
    // any socket opens, and derive the STUN setting now (no socket
    // reach). Without `mesh`, nothing of this runs.
    const mesh = this.config.mesh;
    let meshDatastore: ReturnType<typeof openMeshDatastore> | null = null;
    let meshStunSetting: { host: string; port: number } | undefined = undefined;
    // `MESH_INTERFACE → The IP certificate` — the WSS listener needs
    // its TLS certificate and key at libp2p construction time, so
    // the initial certificate is resolved before `createLibp2p` runs.
    // `initialCertificate` returns null when `current()` reads
    // nothing (or an expired cert) and `obtain()` fails: the node
    // then starts without the WSS listener and the renewal timer
    // retries every `CERT_RETRY_MS` until a certificate arrives.
    // The WSS fallback never takes the node down.
    let wssOptions: WssOptions | null = null;
    let wssInitialCert: IpCertificate | null = null;
    if (mesh !== undefined) {
      assertMeshConfig(mesh);
      await assertStateDirIntegrity(mesh.stateDir);
      meshDatastore = openMeshDatastore(mesh.stateDir);
      meshStunSetting = stunSettingFor(mesh.role, mesh.listen, mesh.stun);
      if (mesh.wss !== undefined) {
        const source: CertificateSource = this.certificateSource !== null
          ? this.certificateSource(mesh.wss, mesh.stateDir)
          : acmeSource({
              directoryUrl: mesh.wss.acmeDirectory,
              ip: mesh.wss.ip,
              stateDir: mesh.stateDir,
              challengePort: mesh.wss.challengePort,
            });
        wssOptions = { ip: mesh.wss.ip, port: mesh.wss.port, source };
        wssInitialCert = await initialCertificate(wssOptions);
      }
    }

    // NET_INTERFACE → "A peer's sync streams are served one at a time":
    // the stream window is pinned at `YAMUX_STREAM_WINDOW_BYTES` for the
    // initial size and the maximum alike, and the receive-buffer cap is
    // pinned at the same bound. The window bounds what a reading stream
    // may buffer between drains, and the receive-buffer cap bounds what
    // a waiting stream (no reader attached yet) may hold — a sync stream
    // whose turn has not come stays at one window's worth of bytes.
    const streamMuxers = [yamux({
      streamOptions: {
        initialStreamWindowSize: YAMUX_STREAM_WINDOW_BYTES,
        maxStreamWindowSize: YAMUX_STREAM_WINDOW_BYTES,
        maxReadBufferLength: YAMUX_STREAM_WINDOW_BYTES,
      },
    })];
    const plainServices = {
      // NET_INTERFACE → libp2p Stack — gossipsub built from the one
      // options object `./gossip-rules.ts`' `gossipsubOptions` answers;
      // each field cites its rule.
      pubsub: gossipsub(gossipsubOptions(this.config.magic, [topics.orderingBlock, topics.tx])),
      identify: identify(),
      ping: ping(),
    };
    const connectionGater = {
      // NET_INTERFACE → "A banned peer's inbound connection is refused at the transport"
      denyInboundEncryptedConnection: (peerId: { toString(): string }) =>
        this.peerMgr.isBanned(peerId.toString()),
    };
    const connectionManager = {
      // NET_INTERFACE → Readers → "Readers have a budget of their own":
      // libp2p's connection ceiling is `maxPeers + maxReaders +
      // HANDSHAKE_SLACK`, so a connection is counted by the kind its
      // handshake declares and libp2p refuses an inbound past the
      // ceiling at the upgrade before any handler runs (verified in
      // `libp2p@3.5.1`, `src/connection-manager/index.ts:688` —
      // `getConnections().length < maxConnections` admits, otherwise the
      // inbound is refused at `maConnection()`).
      maxConnections: this.config.maxPeers + this.config.maxReaders + HANDSHAKE_SLACK,
    };
    // Disable the built-in connection monitor heartbeat.  When enabled it
    // pings peers every 10 s via /ipfs/ping/1.0.0 and aborts the connection
    // if the ping fails.  The AdaptiveTimeout uses a 2 s floor derived from
    // an uninitialised moving average, so the first heartbeat almost always
    // times out and kills the connection.  Explicit pings are still available
    // via @libp2p/ping if needed.
    const connectionMonitor = { enabled: false };

    let libp2p: Libp2p;
    if (mesh !== undefined && meshDatastore !== null) {
      // NET_INTERFACE → The mesh — the public role adds WebRTC-direct
      // beside TCP, the keychain, the Notis DHT, AutoNAT v2, the
      // circuit-relay server and `@libp2p/http`; the private role adds
      // WebRTC and the circuit-relay transport, DCUtR, and runs the
      // DHT in client mode. `addresses.listen` prepends the plain
      // listen so an existing TCP sync peer still reaches the node by
      // its plain address.
      if (mesh.role === 'public') {
        // `MESH_INTERFACE → The IP certificate` — with an initial
        // certificate held, the WSS transport and its `/tls/ws`
        // listen address go up with libp2p; without one (no stored
        // cert and `obtain()` failed), the node starts with every
        // other transport up and the renewal driver wires the WSS
        // listener in on the first successful `obtain()`.
        const publicListen = meshListenAddrs(this.config.listenAddrs, mesh);
        if (wssInitialCert !== null && mesh.wss !== undefined) {
          const ipFamily = isIPv6(mesh.wss.ip) ? 'ip6' : 'ip4';
          publicListen.push(
            `/${ipFamily}/${mesh.wss.ip}/tcp/${mesh.wss.port}/tls/ws`,
          );
        }
        const publicTransports: unknown[] = [tcp(), meshWebRTCDirectTransport()];
        if (wssInitialCert !== null) {
          publicTransports.push(
            webSockets({
              https: { cert: wssInitialCert.certPem, key: wssInitialCert.keyPem },
            }),
          );
        }
        // `MESH_INTERFACE → NAT → "A public node announces its listen addresses from the start"`
        // — the public role's announce holds every listen address
        // with a concrete port; the WSS listen is appended above
        // when the initial certificate is held, so it rides along.
        const publicAnnounce = effectiveAnnounce(publicListen, mesh);
        // NET_INTERFACE → Node Lifecycle →
        // "Every connection libp2p opens reaches net's hooks": libp2p is
        // created stopped, so `createLibp2p` resolves a libp2p that has
        // opened nothing — its own redial of a stored `keep-alive` peer
        // (NET_INTERFACE → Handshake →
        // "Every connection this node dialled carries its handshake,
        // whoever within the node dialled it") waits on the explicit
        // `libp2p.start()` below, by then with every listener and both
        // protocol handlers in place.
        libp2p = await createLibp2p({
          start: false,
          privateKey: libp2pPrivateKey,
          datastore: meshDatastore,
          addresses: {
            listen: publicListen,
            ...(publicAnnounce !== undefined ? { announce: publicAnnounce } : {}),
          },
          transports: publicTransports as never,
          connectionEncrypters: [noise()],
          streamMuxers,
          services: { ...plainServices, ...meshPublicServices(mesh, meshDatastore) },
          connectionGater,
          connectionManager,
          connectionMonitor,
        }) as Libp2p;
      } else {
        // `MESH_INTERFACE → NAT → "A relay that does not answer never
        // stops a private node"` — the initial listen has no circuit
        // entries (they come from `bootstrapPeers` through
        // `startRelayRetry` after start). The announce filter keeps
        // `/p2p-circuit`-bearing addresses alone. `faultTolerance:
        // NO_FATAL` is a defence in depth for a listener that fails
        // after start — the private role must never take libp2p down.
        const relayCount = Math.max(1, this.config.bootstrapPeers.length);
        const stunServers = mesh.stunServers ?? [];
        // NET_INTERFACE → Node Lifecycle →
        // "Every connection libp2p opens reaches net's hooks": see the
        // public-role `createLibp2p` call above for why libp2p is created
        // stopped.
        libp2p = await createLibp2p({
          start: false,
          privateKey: libp2pPrivateKey,
          datastore: meshDatastore,
          addresses: {
            listen: meshListenAddrs(this.config.listenAddrs, mesh),
            announceFilter: privateAnnounceFilter,
          },
          transports: [
            tcp(),
            meshWebRTCDirectTransport(),
            meshPrivateWebRTCTransport(stunServers),
            meshPrivateCircuitTransport(relayCount),
          ],
          connectionEncrypters: [noise()],
          streamMuxers,
          services: { ...plainServices, ...meshPrivateServices(mesh, meshDatastore) },
          connectionGater,
          connectionManager,
          connectionMonitor,
          transportManager: { faultTolerance: FaultTolerance.NO_FATAL },
        }) as Libp2p;
      }
    } else {
      // NET_INTERFACE → Node Lifecycle →
      // "Every connection libp2p opens reaches net's hooks": see the
      // public-role `createLibp2p` call above for why libp2p is created
      // stopped.
      libp2p = await createLibp2p({
        start: false,
        privateKey: libp2pPrivateKey,
        addresses: { listen: [this.config.listenAddrs] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers,
        services: plainServices,
        connectionGater,
        connectionManager,
        connectionMonitor,
      });
    }
    this.libp2p = libp2p;

    try {
      // NET_INTERFACE → The mesh — `onMeshAddresses` fires on each change
      // of the announced set; libp2p's `self:peer:update` is the one
      // event that carries that signal. Attached on a stopped libp2p so
      // the first announce at start fires on this hook
      // (NET_INTERFACE → Node Lifecycle →
      // "Every connection libp2p opens reaches net's hooks").
      if (mesh !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const listener = (_ev: any): void => {
          const id = this.meshIdentity();
          if (id === null) return;
          for (const cb of this.meshAddressHandlers) {
            try { cb(id); } catch (err) {
              console.warn(`[net] onMeshAddresses handler error: ${String(err)}`);
            }
          }
        };
        libp2p.addEventListener('self:peer:update', listener);
        this.meshSelfPeerUpdateListener = listener;
      }

      // NET_INTERFACE → PeerDb — a PeerDb built before `libp2p.start()`
      // opens with an empty self set, the storage pass filtering nothing;
      // `setSelfAddresses` below hands in the addresses once libp2p lists
      // them and drops every entry that matches.
      this.peerDb = new PeerDb(this.peerStorage, this.config.peerDbCap, []);

      // Create SyncMachine with lazy store bridge and wire the scheduler's
      // injected shape (NET_INTERFACE → Sync Handler Registration).
      this.syncMachine = new SyncMachine(
        this.config,
        this.syncStore,
        (peerId: string, data: Uint8Array) => this.sendToPeer(peerId, data),
        (peerId: string, reason: string) => {
          this.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, reason);
        },
      );
      this.syncMachine.setConnectedPeers(() => new Set(this.getConnectedPeers()));
      this.syncMachine.setPenalize((peerId, kind, reason) => this.penalizePeer(peerId, kind, reason));
      this.syncMachine.setRequestHeaders((locator, peerId) => this.requestHeaders(locator, peerId));
      this.syncMachine.setRequestBlocks((ids, peerId) => this.requestBlocks(ids, peerId));
      this.syncMachine.setBootstrapAllSettled(() => this.allBootstrapSettled());
      if (this.pipeline) this.syncMachine.setPipeline(this.pipeline);
      if (this.chainViewRegistered) this.syncMachine.setChainView(this.chainViewRegistered);
      this.syncMachine.start();

      // Wire sync-complete callback: when the sync machine reaches 'synced',
      // fire all registered onSyncComplete handlers.
      this.syncMachine.onSynced(() => {
        for (const cb of this.syncCompleteHandlers) {
          try { cb(); } catch (err) {
            console.warn(`[net] syncComplete handler error: ${String(err)}`);
          }
        }
      });

      // Create OutboundManager
      this.outboundMgr = new OutboundManager(this.config, this.peerDb);

      // NET_INTERFACE → Node Lifecycle →
      // "Every connection libp2p opens reaches net's hooks": both
      // protocol handlers and every event listener are in place on a
      // stopped libp2p, so libp2p's own redial of a stored `keep-alive`
      // peer at start (NET_INTERFACE → Handshake →
      // "Every connection this node dialled carries its handshake,
      // whoever within the node dialled it") reaches them. The
      // `libp2p.handle` call sets the registrar's handler map
      // synchronously and writes the protocol into the peer store in
      // an awaited step, so by the time `libp2p.start()` runs below
      // the registrar lists both protocols
      // (`libp2p@3.5.1` `registrar.ts` `handle`).
      await this.registerHandshakeHandler(libp2p);
      await this.registerSyncStreamHandler(libp2p);

      // Track peers on connect/disconnect.
      // Listen for all four event types because the timing and payload differ:
      //   connection:open  — fires first, has full Connection object (addr, direction)
      //   peer:connect     — fires after, only has PeerId
      //   connection:close — fires first, has full Connection object + timeline
      //   peer:disconnect  — fires after, only has PeerId
      libp2p.addEventListener('connection:open', (evt: any) => {
        const conn = evt.detail;
        const peerId = conn?.remotePeer?.toString() ?? 'unknown';
        const direction = conn?.direction ?? '?';
        const connId = conn?.id ?? '?';
        const remoteAddr = conn?.remoteAddr?.toString() ?? '?';
        console.log(`[net] connection:open id=${connId} peer=${peerId} dir=${direction} addr=${remoteAddr}`);
        // NET_INTERFACE → Handshake →
        // "A connection handshakes within its deadline, or is closed":
        // the deadline starts at connection:open, per connection id.
        if (typeof conn?.id === 'string') this.startHandshakeDeadline(conn);
        // NET_INTERFACE → Handshake →
        // "Every connection this node dialled carries its handshake,
        // whoever within the node dialled it": libp2p opens outbound
        // connections on the node's behalf outside the dial funnel — a
        // relay reservation, a DHT query, AutoNAT's dial-back. Whichever
        // reaches the connection first — this open hook, or the funnel's
        // own continuation of `await libp2p.dial(...)` — runs the handshake
        // through `ensureOutboundAdmission`, and the other awaits that one.
        // The admission carries its own self-check and banned-check, so
        // correctness is not tied to which side claims first.
        if (direction === 'outbound' && typeof conn?.id === 'string') {
          void this.ensureOutboundAdmission(conn);
        }
      });

      libp2p.addEventListener('peer:connect', (evt: any) => {
        const peerId = evt.detail?.toString() ?? 'unknown';
        // NET_INTERFACE →
        // "A connection whose remote peer id is this node's own is never a peer":
        // never added, so peers() never lists it even
        // between the upgrade and the funnel's close.
        if (peerId === libp2p.peerId.toString()) return;
        console.log(`[net] peer:connect ${peerId} (total=${this.peerMgr.getPeerCount() + 1})`);
        this.peerMgr.addPeer({
          id: peerId,
          multiaddrs: [],
          protocols: [],
          connectedAt: Date.now(),
        });
      });

      libp2p.addEventListener('connection:close', (evt: any) => {
        const conn = evt.detail;
        const peerId = conn?.remotePeer?.toString() ?? 'unknown';
        const remoteAddr = conn?.remoteAddr?.toString() ?? '?';
        const direction = conn?.direction ?? '?';
        const timeline = conn?.timeline;
        const openTs = timeline?.open ? new Date(timeline.open).toISOString() : '?';
        const closeTs = timeline?.close ? new Date(timeline.close).toISOString() : '?';
        const durationMs = (timeline?.close && timeline?.open)
          ? timeline.close - timeline.open
          : '?';
        // NET_INTERFACE → Handshake → "A connection carries one handshake,
        // opened by the side that dialled it": the mark lives while the
        // connection stands.
        if (typeof conn?.id === 'string') {
          this.handshakenConnections.delete(conn.id);
          // NET_INTERFACE → Handshake →
          // "A connection handshakes within its deadline, or is closed":
          // the deadline timer and the "completed" fact live with the
          // connection, dropped at its close.
          this.completedConnections.delete(conn.id);
          // NET_INTERFACE → Handshake →
          // "Every connection this node dialled carries its handshake,
          // whoever within the node dialled it": the ownership mark lives
          // with the connection.
          this.outboundAdmissions.delete(conn.id);
          const timer = this.handshakeDeadlines.get(conn.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            this.handshakeDeadlines.delete(conn.id);
          }
        }
        console.log(`[net] connection:close id=${conn?.id ?? '?'} peer=${peerId} addr=${remoteAddr} dir=${direction} durationMs=${durationMs} opened=${openTs} closed=${closeTs}`);
      });

      libp2p.addEventListener('peer:disconnect', (evt: any) => {
        const peerId = evt.detail?.toString() ?? 'unknown';
        console.log(`[net] peer:disconnect ${peerId} (total=${Math.max(0, this.peerMgr.getPeerCount() - 1)})`);
        // NET_INTERFACE → Readers → "A reader is its node's gossip direct
        // peer": the router lets the peer go when the node holds no
        // connection to it. The call is idempotent, so a chain-serving
        // peer or any peer the router never held as direct is a no-op.
        asDirectPeerRouter(libp2p).services.pubsub.removeDirectPeer(peerId);
        // NET_INTERFACE → Readers → "The peer hooks see chain-serving peers
        // alone": read the peer's declared capabilities from the metadata
        // before `removePeer` drops it so the chain-serving check still has
        // something to answer.
        const meta = this.peerMgr.getPeerMetadata(peerId);
        const wasChainServing =
          meta?.state === PeerState.Active
          && meta.capabilities !== null
          && servesChain(meta.capabilities);
        this.peerMgr.removePeer(peerId);
        this.lastGetPeersSentMs.delete(peerId);
        // NET_INTERFACE → Stream Protocols → "A peer's sync streams are served one at a time":
        // per-peer state goes when the peer does.
        this.peerStreamQueues.delete(peerId);
        this.syncMachine?.onPeerDisconnect(peerId);
        if (wasChainServing) {
          for (const cb of this.peerDisconnectedHandlers) {
            try { cb(peerId, ''); } catch (err) {
              console.warn(`[net] peerDisconnected handler error: ${String(err)}`);
            }
          }
        }
      });

      // Log identify completion — confirms the connection was fully upgraded
      libp2p.addEventListener('peer:identify', (evt: any) => {
        const result = evt.detail;
        const peerId = result?.peerId?.toString() ?? '?';
        console.log(`[net] peer:identify ${peerId}`);
      });

      // NET_INTERFACE → Node Lifecycle →
      // "Every connection libp2p opens reaches net's hooks": with both
      // protocol handlers and every event listener in place, libp2p is
      // started. A `libp2p.start()` that throws is caught below and the
      // catch tears libp2p down with the rest (NET_INTERFACE → Node
      // Lifecycle → "A start that throws stops what it started").
      await libp2p.start();

      // NET_INTERFACE → The mesh — STUN is bound after `libp2p.start()`
      // so a bind failure tears libp2p down through the catch below
      // (`MESH_INTERFACE → NAT`). The STUN server is a plain UDP bind,
      // apart from libp2p.
      if (mesh !== undefined && meshStunSetting !== undefined) {
        this.meshStun = await startStunServer(meshStunSetting);
      }

      // `MESH_INTERFACE → The IP certificate` — the renewal driver
      // swaps the WSS listener's certificate in place at half the
      // lifetime, closes it at `notAfter`, and with no initial cert
      // retries `obtain()` every `CERT_RETRY_MS` and wires the
      // listener in on the first successful retry. Started after
      // `libp2p.start()` because its first tick runs
      // `transportManager.listen()`, which answers only on a started
      // libp2p; its `resolveInternals` read of the shared bus reaches
      // a started node alone.
      if (wssOptions !== null) {
        this.wssRenewal = startWssRenewal(libp2p, wssOptions, {
          cert: wssInitialCert,
          lastFailureMs: wssInitialCert === null ? Date.now() : null,
        });
      }

      // NET_INTERFACE → PeerDb — hand PeerDb the listen addresses
      // `libp2p.getMultiaddrs()` lists (answered only on a started
      // libp2p), so `record` filters our own addresses out and any
      // entry the storage pass loaded that normalises to one of them
      // is dropped.
      const listenAddrs = libp2p.getMultiaddrs();
      const selfAddrs = listenAddrs.map((a) => a.toString());
      this.peerDb.setSelfAddresses(selfAddrs);

      // Subscribe to gossip topics. Gossipsub's `subscribe` throws on a
      // stopped node (`@libp2p/gossipsub@17.2.1` `gossipsub.ts`
      // `subscribe` — `Pubsub has not started`), so this runs after
      // `libp2p.start()`. The topic validators and the message listener
      // are installed by the same call.
      const handlers: GossipHandlers = {
        onOrderingBlock: (block, fromPeerId) => {
          for (const cb of this.orderingBlockHandlers) cb(block, fromPeerId);
        },
        onTx: (tx, content, fromPeerId) => {
          // NET_INTERFACE → Inbound Processing → "A transaction is forwarded
          // when a handler admits it": Accept when any registered handler
          // returned `true`; a handler that throws answers nothing for itself
          // and is logged.
          let admitted = false;
          for (const cb of this.txHandlers) {
            try {
              if (cb(tx, content, fromPeerId) === true) admitted = true;
            } catch (err) {
              console.error(`[net] tx handler threw: ${String(err)}`);
            }
          }
          return admitted;
        },
      };

      await subscribeTopics(
        asGossip(libp2p),
        this.validators,
        this.peerMgr,
        handlers,
        topics,
        this.karmaMembers,
        this.config.protocolVersionSchedule,
        () => this.syncStore.chainHeight(),
        this.config.orderingBlockPowTargetFloorBits,
        (header) => this.scheduledTargetProvider?.(header) ?? null,
        (hash, height) => this.headerStandingProvider?.(hash, height) ?? null,
      );

      // Log listen addresses
      console.log(`[net] listening on: ${listenAddrs.map((a) => a.toString()).join(', ')}`);

      // Dial each configured bootstrap peer. Each dial reports settled
      // (Active, failed or self) through `markBootstrapSettled`, which the
      // scheduler reads under NET_INTERFACE → Sync State Machine → "The gate
      // bounds how far blocks apply."
      for (const addr of this.config.bootstrapPeers) {
        await this.dialAndHandshake(addr, 'seed');
      }

      // `MESH_INTERFACE → NAT → "A node's role is its operator's setting"`
      // — a private node takes a relay reservation on each of its
      // bootstrap peers over the connection `net` already holds to
      // that peer, never by searching. Each bootstrap entry becomes
      // a `<entry>/p2p-circuit` listen address added after start; a
      // reservation that cannot complete is tried again on the retry
      // cadence. A private node with `bootstrapPeers: []` asks no
      // relay and starts on its own addresses alone.
      if (mesh !== undefined && mesh.role === 'private') {
        const baseMs = mesh.relayRetryBaseMs ?? RETRY_BASE_MS;
        const capMs = mesh.relayRetryCapMs ?? RETRY_CAP_MS;
        const listenTimeoutMs = mesh.relayListenTimeoutMs;
        for (const addr of this.config.bootstrapPeers) {
          this.relayRetries.push(startRelayRetry(libp2p, `${addr}/p2p-circuit`, {
            baseMs, capMs, listenTimeoutMs,
          }));
        }
      }

      // Start periodic timer: outbound manager + peer discovery. The sync machine
      // keeps its own tick cadence inside its event loop. A method, not an
      // inline closure, so a test can drive one tick without waiting
      // OUTBOUND_TICK_INTERVAL_MS.
      this.syncTimer = setInterval(() => this.outboundTick(), OUTBOUND_TICK_INTERVAL_MS);

      this.started = true;
    } catch (err) {
      // NET_INTERFACE → API → Node Lifecycle →
      // "A start that throws stops what it started". Every step after
      // `createLibp2p` runs inside the try above; on a throw — including
      // one from `libp2p.start()` itself — the libp2p node and whatever
      // startup reached is torn down before the error leaves start().
      if (this.syncTimer) {
        clearInterval(this.syncTimer);
        this.syncTimer = null;
      }
      for (const r of this.relayRetries) r.stop();
      this.relayRetries = [];
      if (this.wssRenewal !== null) {
        this.wssRenewal.stop();
        this.wssRenewal = null;
      }
      if (this.meshStun !== null) {
        try { await this.meshStun.close(); } catch { /* already down */ }
        this.meshStun = null;
      }
      this.syncMachine?.stop();
      this.syncMachine = null;
      this.outboundMgr = null;
      this.peerDb = null;
      this.topics = null;
      this.bootstrapSettledAddrs.clear();
      if (this.meshSelfPeerUpdateListener !== null) {
        try { libp2p.removeEventListener('self:peer:update', this.meshSelfPeerUpdateListener); } catch { /* already gone */ }
        this.meshSelfPeerUpdateListener = null;
      }
      try { await libp2p.stop(); } catch { /* already down */ }
      this.libp2p = null;
      throw err;
    }
  }

  /**
   * One outbound-timer tick: the floor and fill phases (NET_INTERFACE →
   * Outbound Manager), then the peer-discovery cadence they ride.
   */
  private outboundTick(): void {
    if (this.libp2p && this.outboundMgr) {
      // Both phases count outbound connections only — inbound connections
      // filling our slots must never suppress our own dialing (eclipse
      // setup). planTick also feeds the connected addresses into the fill
      // phase's exclude set.
      const plan = this.outboundMgr.planTick(this.libp2p.getConnections());

      // Floor phase: dial the bootstrap seeds the manager selected — each
      // whose peer is not already connected (NET_INTERFACE → Outbound
      // Manager, Floor phase).
      for (const addr of plan.bootstrapDials) {
        this.dialAndHandshake(addr, 'seed');
      }

      // Fill phase: dial one PeerDb candidate per tick, through the same
      // funnel as a seed — the dial, the own-peer check, then the outbound
      // handshake (NET_INTERFACE → Outbound Manager).
      const candidate = plan.candidate;
      if (candidate) {
        this.dialAndHandshake(candidate, 'candidate');
      }
    }

    // Peer discovery cadence: GetPeers to each Active peer every
    // GET_PEERS_INTERVAL_MS, riding this tick rather than a second timer.
    if (this.libp2p) {
      for (const peerId of duePeerExchange(this.peerMgr, this.lastGetPeersSentMs, Date.now())) {
        this.requestPeers(peerId);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started || !this.libp2p) return;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingDials.clear();
    this.lastGetPeersSentMs.clear();
    this.bootstrapSettledAddrs.clear();
    // NET_INTERFACE → Handshake →
    // "A connection handshakes within its deadline, or is closed":
    // every per-connection deadline clears with the node that owns it.
    for (const timer of this.handshakeDeadlines.values()) clearTimeout(timer);
    this.handshakeDeadlines.clear();
    this.handshakenConnections.clear();
    this.completedConnections.clear();
    this.outboundAdmissions.clear();
    // NET_INTERFACE → The mesh — a private node's relay-listen
    // retries stop first, then STUN closes before libp2p's stop so a
    // bind failure is surfaced over the libp2p teardown
    // (`MESH_INTERFACE → NAT`); the `self:peer:update` listener is
    // removed first so a late update never re-fires `onMeshAddresses`
    // through this node.
    for (const r of this.relayRetries) r.stop();
    this.relayRetries = [];
    // `MESH_INTERFACE → The IP certificate` — stop the WSS renewal
    // driver before libp2p's teardown so a pending `obtain()` or a
    // scheduled renewal does not reach the dying transport manager.
    if (this.wssRenewal !== null) {
      this.wssRenewal.stop();
      this.wssRenewal = null;
    }
    if (this.meshSelfPeerUpdateListener !== null) {
      this.libp2p.removeEventListener('self:peer:update', this.meshSelfPeerUpdateListener);
      this.meshSelfPeerUpdateListener = null;
    }
    if (this.meshStun !== null) {
      await this.meshStun.close();
      this.meshStun = null;
    }
    await this.libp2p.stop();
    this.libp2p = null;
    this.topics = null;
    this.peerDb = null;
    this.syncMachine?.stop();
    this.syncMachine = null;
    this.outboundMgr = null;
    this.started = false;
  }

  /**
   * Start a handshake deadline for a connection. Idempotent — a connection
   * whose timer already runs is left alone; the deadline runs from the open
   * time, never resets on a second call.
   *
   * NET_INTERFACE → Handshake →
   * "A connection handshakes within its deadline, or is closed". The timer
   * closes the connection on expiry when its handshake has not completed;
   * a completed connection is left alone. The timer is `unref`ed, so a live
   * one never holds the process open.
   */
  private startHandshakeDeadline(
    conn: {
      id: string;
      close(): Promise<void>;
      remotePeer?: { toString(): string };
    },
  ): void {
    if (this.handshakeDeadlines.has(conn.id)) return;
    const deadlineMs = HANDSHAKE_DEADLINE_FACTOR * this.config.syncRequestTimeoutMs;
    const timer = setTimeout(() => {
      this.handshakeDeadlines.delete(conn.id);
      if (this.completedConnections.has(conn.id)) return;
      // NET_INTERFACE → Handshake →
      // "A connection handshakes within its deadline, or is closed": the
      // close names the peer and that the handshake did not complete, so
      // a service-opened connection that never handshakes is audible to
      // the operator.
      const peerId = conn.remotePeer?.toString() ?? 'unknown';
      console.log(`[net] handshake deadline: closing connection id=${conn.id} to ${peerId} — handshake did not complete in time`);
      // The close hangs the connection up. The connection:close event the
      // close raises clears every per-connection fact, so this fires once.
      void conn.close().catch(() => { /* already gone */ });
    }, deadlineMs);
    timer.unref();
    this.handshakeDeadlines.set(conn.id, timer);
  }

  /**
   * NET_INTERFACE → Handshake →
   * "Every connection this node dialled carries its handshake, whoever
   * within the node dialled it": the ownership mark that gives a connection
   * exactly one handshake. The first caller — the open hook on the
   * outbound connection — stores a Promise in `outboundAdmissions`; every
   * later caller (the dial funnel after `libp2p.dial()` returns the same
   * connection) reads that Promise and awaits it. The funnel's own
   * handshake and this one are the same handshake, never two.
   *
   * Returns the shared admission Promise, which resolves when the handshake
   * on `conn` has completed (ok or not) and its consequences — Active,
   * capabilities, maxPeers close for a chain-serving peer past the budget
   * — have been applied.
   */
  private ensureOutboundAdmission(
    conn: import('@libp2p/interface').Connection,
  ): Promise<OutboundAdmissionResult> {
    const existing = this.outboundAdmissions.get(conn.id);
    if (existing !== undefined) return existing;
    // NET_INTERFACE → Handshake → "A connection carries one handshake,
    // opened by the side that dialled it": the mark the inbound handler
    // reads to refuse a later handshake stream on the same connection
    // (`registerHandshakeHandler`). Set before the stream opens.
    this.handshakenConnections.add(conn.id);
    const promise = this.admitOutboundConnection(conn);
    this.outboundAdmissions.set(conn.id, promise);
    void promise.catch((err) => {
      console.warn(`[net] outbound admission on ${conn.remotePeer.toString()} threw: ${String(err)}`);
    });
    return promise;
  }

  /**
   * Run the outbound handshake on an outbound connection and admit its
   * peer (NET_INTERFACE → Handshake → "Every connection this node dialled
   * carries its handshake, whoever within the node dialled it"). Called
   * through `ensureOutboundAdmission`, so this runs at most once per
   * connection id. The caller (funnel or open hook) awaits the shared
   * Promise and reads the result to decide source-specific bookkeeping.
   *
   * On handshake success: the peer becomes Active with its declared
   * version and capabilities (NET_INTERFACE → Handshake → "A peer becomes
   * Active once"); a peer that declares no chain service is closed
   * (→ Readers → "A peer dialled for chain service that declares none is
   * closed"); a chain-serving peer past `maxPeers` is closed (→ Readers).
   * On handshake failure: the connection is closed; no `recordDialResult`
   * — that is the funnel's job over `addr`, and a service dial (relay
   * reservation, DHT, AutoNAT) names no `addr`.
   */
  private async admitOutboundConnection(
    conn: import('@libp2p/interface').Connection,
  ): Promise<OutboundAdmissionResult> {
    const peerId = conn.remotePeer.toString();
    const connId = conn.id;
    const libp2p = this.libp2p;
    if (!libp2p) return { ok: false };

    // NET_INTERFACE →
    // "A connection whose remote peer id is this node's own is never a peer":
    // libp2p already refuses a self-dial, but a defensive hang-up catches
    // any path that reaches here.
    if (peerId === libp2p.peerId.toString()) {
      await conn.close().catch(() => { /* already gone */ });
      return { ok: false };
    }

    // NET_INTERFACE → "A banned peer's handshake is refused unread": a
    // connection that resolved to a banned peer is closed with the
    // address joining the peer's ban. The one log for this close, on
    // either path (funnel or service dial), lives here.
    if (this.peerMgr.isBanned(peerId)) {
      const remoteAddr = conn.remoteAddr?.toString();
      console.log(`[net] dial resolved to banned peer ${peerId} — closing`);
      await conn.close().catch(() => { /* already gone */ });
      if (remoteAddr) this.peerMgr.extendBan(peerId, remoteAddr);
      return { ok: false };
    }

    let result: HandshakeResult;
    try {
      result = await this.runOutboundHandshake(conn);
    } catch (handshakeErr: any) {
      console.warn(`[net] outbound handshake with ${peerId} failed: ${handshakeErr?.message ?? handshakeErr}`);
      await conn.close().catch(() => { /* already gone */ });
      return { ok: false };
    }

    if (!result.ok || !result.msg) {
      // NET_INTERFACE → Handshake →
      // "A handshake that does not complete ends its connection".
      await conn.close().catch(() => { /* already gone */ });
      return { ok: false, handshake: result };
    }

    // NET_INTERFACE → Handshake →
    // "A connection handshakes within its deadline, or is closed":
    // the dialler's handshake has completed on this connection; the
    // deadline leaves it alone.
    this.completedConnections.add(connId);

    const peerServesChain = servesChain(result.peerCapabilities);
    // NET_INTERFACE → Readers → "A peer dialled for chain service that
    // declares none is closed". A relay we dialled serves the chain, so
    // this close does not fire for the mesh's service connections; it
    // fires for a reader-only build that was dialled as a seed.
    if (!peerServesChain) {
      console.log(`[net] outbound handshake with ${peerId} declares no chain service — closing`);
      await conn.close().catch(() => { /* already gone */ });
      return { ok: false, handshake: result };
    }
    // NET_INTERFACE → Readers — "a chain-serving peer past `maxPeers` is
    // closed after its handshake as well".
    if (
      !this.peerMgr.isPeerActive(peerId)
      && this.getConnectedPeers().length >= this.config.maxPeers
    ) {
      console.log(`[net] outbound handshake with ${peerId} past maxPeers — closing`);
      await conn.close().catch(() => { /* already gone */ });
      return { ok: false, handshake: result };
    }

    // NET_INTERFACE → Handshake → "A peer becomes Active once": a
    // handshake that completes for a peer already Active records and
    // raises nothing.
    if (!this.peerMgr.isPeerActive(peerId)) {
      this.peerMgr.setPeerState(peerId, PeerState.Active);
      // The dialled address joins `peerMgr.setPeerAddress` only when the
      // funnel knows it; `conn.remoteAddr` is a resolved multiaddr — the
      // funnel overwrites with the seed-list spelling after the admission.
      const remoteAddr = conn.remoteAddr?.toString();
      if (remoteAddr) this.peerMgr.setPeerAddress(peerId, remoteAddr);
      // The record and the metadata keep the peer's declared version,
      // not ours — it is what the boundary sweep reads
      // (NET_INTERFACE → PeerDb; → Post-Handshake Routing).
      this.peerMgr.setPeerVersion(peerId, result.msg.protocolVersion);
      this.peerMgr.setPeerCapabilities(peerId, result.peerCapabilities);
      // PeerDb for a service-opened connection is keyed by `conn.remoteAddr`
      // — a resolved multiaddr; the funnel, when it dialled, adds a second
      // record under the seed-list spelling after this admission returns.
      if (remoteAddr) {
        this.peerDb?.record({
          address: remoteAddr,
          lastSeenMs: Date.now(),
          agentName: result.msg.agentName,
          nodeName: result.msg.nodeName,
          protocolVersion: result.msg.protocolVersion,
          capabilities: result.peerCapabilities,
        });
      }
      const dir = (conn.direction ?? 'outbound') as 'inbound' | 'outbound';
      // NET_INTERFACE → Readers → "A peer dialled for chain service that
      // declares none is closed": a reader has no path to here, so the
      // scheduler and the peerActive handlers fire for a chain-serving
      // peer alone.
      this.syncMachine?.onPeerActive(peerId, result.peerHeight, dir);
      for (const cb of this.peerActiveHandlers) {
        try { cb(peerId, dir); } catch (err) {
          console.warn(`[net] peerActive handler error: ${String(err)}`);
        }
      }
    }
    return { ok: true, handshake: result };
  }

  /**
   * Dial a bootstrap seed or a PeerDb candidate and run the outbound
   * handshake, notifying the sync machine + peer-active callbacks on
   * success. The one dial funnel for both outbound paths — `start()`'s seed
   * loop, the floor, and the fill all call this (NET_INTERFACE → Outbound
   * Manager).
   *
   * Returns a Promise that resolves to `true` when the handshake succeeds,
   * `false` otherwise.  Safe to call from the periodic timer without
   * awaiting — concurrent dials to the same address are deduplicated via
   * `pendingDials`.
   */
  private async dialAndHandshake(addr: string, source: 'seed' | 'candidate'): Promise<boolean> {
    if (!this.libp2p || !this.outboundMgr) return false;
    if (this.pendingDials.has(addr)) return false;
    this.pendingDials.add(addr);
    const libp2p = this.libp2p;

    console.log(`[net] dialing ${source}: ${addr}`);
    try {
      const conn = await libp2p.dial(multiaddr(addr));
      this.pendingDials.delete(addr);

      // NET_INTERFACE →
      // "A connection whose remote peer id is this node's own is never a peer":
      // closed the moment it resolves,
      // before any handshake and before any record.
      if (conn.remotePeer.toString() === libp2p.peerId.toString()) {
        console.log(`[net] dial to ${addr} resolved to our own peer id — closing`);
        await conn.close().catch(() => { /* already gone */ });
        if (source === 'seed') {
          this.outboundMgr?.recordSeedSelf(addr);
          this.markBootstrapSettled(addr);
        }
        else this.peerDb?.forgetSelf(addr);
        return false;
      }

      // NET_INTERFACE → "A banned peer's handshake is refused unread":
      // the admission's own banned-check closes the connection and logs
      // the one line. The funnel's duty here is its source-specific
      // bookkeeping — extend the ban to the dialled address, settle the
      // seed — with no second log and no redial cooldown (a ban is
      // stronger than a cooldown).
      const remote = conn.remotePeer.toString();
      if (this.peerMgr.isBanned(remote)) {
        await conn.close().catch(() => { /* already gone */ });
        this.peerMgr.extendBan(remote, addr);
        if (source === 'seed') this.markBootstrapSettled(addr);
        return false;
      }

      // NET_INTERFACE → Outbound Manager, Floor phase: the floor skips a seed
      // whose peer holds a live connection; a bare seed has no peer id of its
      // own, so remember the peer this dial resolved to.
      if (source === 'seed') {
        this.outboundMgr?.recordSeedPeer(addr, conn.remotePeer.toString());
      }
      console.log(`[net] dial succeeded: ${addr} -> peer=${conn.remotePeer.toString()}`);

      // NET_INTERFACE → Handshake →
      // "The dial funnel handshakes only a connection it opened": when the
      // returned connection is one the peer opened — libp2p answers a dial
      // naming a connected peer id with a connection it holds — the funnel
      // opens no handshake stream on it; it counts connected when the peer
      // is Active, and otherwise leaves the connection to its deadline.
      if (conn.direction === 'inbound') {
        if (source === 'seed') this.markBootstrapSettled(addr);
        return this.peerMgr.isPeerActive(remote);
      }

      // NET_INTERFACE → Handshake →
      // "Every connection this node dialled carries its handshake, whoever
      // within the node dialled it": the open hook started the handshake
      // the moment this connection opened. The funnel awaits that shared
      // admission — the funnel's own and the open hook's are the same
      // handshake, never two.
      const admission = await this.ensureOutboundAdmission(conn);
      // After the admission completes, the dialled address — the funnel's
      // own spelling, not the open hook's `conn.remoteAddr` — joins PeerDb
      // and `peerMgr.setPeerAddress` with the time stamp, so a later fill
      // phase can redial by the same string the seed list holds.
      if (admission.ok) {
        const msg = admission.handshake?.msg;
        const caps = admission.handshake?.peerCapabilities;
        if (msg && caps) {
          this.peerMgr.setPeerAddress(remote, addr);
          this.peerDb?.record({
            address: addr,
            lastSeenMs: Date.now(),
            agentName: msg.agentName,
            nodeName: msg.nodeName,
            protocolVersion: msg.protocolVersion,
            capabilities: [...caps],
          });
        }
        if (source === 'seed') this.markBootstrapSettled(addr);
        return true;
      }
      // NET_INTERFACE → Handshake →
      // "A handshake that does not complete ends its connection"; →
      // Outbound Manager, fill phase: an address a dialler's handshake did
      // not complete joins the redial cooldown as a failed dial does. A
      // service dial (libp2p's own — relay reservation, DHT, AutoNAT) runs
      // no funnel path at all, so no `recordDialResult` is called on its
      // failure; libp2p handles its own service retry, and the next tick's
      // floor/fill is driven by the funnel.
      this.outboundMgr?.recordDialResult(addr, false);
      if (source === 'seed') this.markBootstrapSettled(addr);
      return false;
    } catch (err: any) {
      this.pendingDials.delete(addr);
      // NET_INTERFACE →
      // "A connection whose remote peer id is this node's own is never a peer":
      // libp2p 3.x throws `InvalidPeerIdError('Can not dial self')` from the
      // dial path rather than resolving to a connection, so the self-dial
      // cleanup runs on the error branch too — the address is forgotten (a
      // candidate) or recorded as self (a seed) with no `dial FAILED` noise.
      const name: unknown = err?.name;
      const message: string = typeof err?.message === 'string' ? err.message : String(err);
      if (name === 'InvalidPeerIdError' && message.toLowerCase().includes('dial self')) {
        console.log(`[net] dial to ${addr} resolved to our own peer id — closing`);
        if (source === 'seed') {
          this.outboundMgr?.recordSeedSelf(addr);
          this.markBootstrapSettled(addr);
        }
        else this.peerDb?.forgetSelf(addr);
        return false;
      }
      // NET_INTERFACE → "A banned peer's handshake is refused unread":
      // the admission's banned-check runs on `connection:open` and closes
      // the connection before libp2p's dial resolves, so libp2p throws
      // "Remote closed connection during opening" here. A ban is stronger
      // than a dial cooldown — the floor keeps listing a banned seed by
      // design (NET_INTERFACE → Outbound Manager, Floor phase), so an
      // addr the admission just banned takes no `recordDialResult`.
      if (this.peerDb?.isBanned(addr) === true) {
        if (source === 'seed') this.markBootstrapSettled(addr);
        return false;
      }
      console.warn(`[net] dial FAILED: ${addr} — ${err?.message ?? err}`);
      this.outboundMgr?.recordDialResult(addr, false);
      if (source === 'seed') this.markBootstrapSettled(addr);
      return false;
    }
  }

  /**
   * NET_INTERFACE → Sync State Machine → "The gate bounds how far
   * blocks apply." A configured bootstrap address is settled once its
   * first dial has ended; settled stays settled, and the scheduler is
   * told so it can re-evaluate the gate on the next loop pass.
   */
  private markBootstrapSettled(addr: string): void {
    if (!this.config.bootstrapPeers.includes(addr)) return;
    if (this.bootstrapSettledAddrs.has(addr)) return;
    this.bootstrapSettledAddrs.add(addr);
    this.syncMachine?.bootstrapSettled();
  }

  /**
   * True once every configured bootstrap address has settled, deduped
   * across any that appear twice in `bootstrapPeers` (NET_INTERFACE →
   * Sync State Machine → "The gate bounds how far blocks apply.").
   * With no bootstrap addresses the gate holds vacuously.
   */
  private allBootstrapSettled(): boolean {
    for (const addr of this.config.bootstrapPeers) {
      if (!this.bootstrapSettledAddrs.has(addr)) return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Handshake — inbound handler registration
  // -----------------------------------------------------------------------

  private async registerHandshakeHandler(libp2p: Libp2p): Promise<void> {
    const magic = this.config.magic;

    await libp2p.handle(HANDSHAKE_PROTOCOL, async (stream, connection) => {
      const peerId = connection.remotePeer.toString();
      const connId = connection.id;
      // NET_INTERFACE → Validation → "A stream write is bounded in time as
      // well": every answer on this stream is raced against the deadline the
      // reader on the other side holds (`syncRequestTimeoutMs`).
      const deadlineMs = this.config.syncRequestTimeoutMs;
      const sinkFrame = async (data: Uint8Array): Promise<void> =>
        sinkWithDeadline(stream, data, deadlineMs);
      // NET_INTERFACE → Stream Protocols → "A stream handler never rejects":
      // the failure-path empty answer to a peer that has gone ends the
      // stream with nothing more to say.
      const replyEmpty = async (): Promise<void> => {
        try { await sinkFrame(new Uint8Array(0)); } catch { /* peer gone */ }
      };
      // NET_INTERFACE → Handshake →
      // "A handshake that does not complete ends its connection":
      // every return path that does not complete the handshake closes the
      // connection it ran on, after whatever the Ban policy records for it.
      const endConnection = async (): Promise<void> => {
        try { await connection.close(); } catch { /* peer gone */ }
      };

      // NET_INTERFACE → Handshake → "A connection carries one handshake,
      // opened by the side that dialled it": a connection that has already
      // carried a handshake stream closes every later one unread, with no
      // penalty. The connection it rode on keeps the handshake it carried,
      // so this is the one return path that closes the stream alone.
      if (typeof connId === 'string' && this.handshakenConnections.has(connId)) {
        await stream.close().catch(() => { /* the peer is already gone */ });
        return;
      }
      if (typeof connId === 'string') this.handshakenConnections.add(connId);

      // NET_INTERFACE → "A banned peer's handshake is refused unread". The gater
      // refuses the same predicate one layer down, at the transport; this check
      // covers a peer banned between its connection's upgrade and its handshake,
      // and the interval before a ban's hang-up completes.
      if (this.peerMgr.isBanned(peerId)) {
        await stream.close().catch(() => { /* the peer is already gone */ });
        await endConnection();
        return;
      }
      // NET_INTERFACE →
      // "A connection whose remote peer id is this node's own is never a peer":
      // refused the way any other handshake stream is —
      // an empty frame — with no penalty, there being nobody to penalise.
      if (peerId === libp2p.peerId.toString()) {
        console.log(`[net] inbound handshake from ${peerId}: this is our own peer id — refusing`);
        await replyEmpty();
        await endConnection();
        return;
      }
      try {
        const data = await readStreamBounded(stream, MAX_HANDSHAKE_FRAME_BYTES, AbortSignal.timeout(deadlineMs));
        if (data === null) {
          console.warn(`[net] handshake stream from ${peerId} exceeded ${MAX_HANDSHAKE_FRAME_BYTES} bytes`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'handshake stream exceeds byte cap',
          );
          await replyEmpty();
          await endConnection();
          return;
        }
        if (data.length === 0) {
          await replyEmpty();
          await endConnection();
          return;
        }

        const decoded = decodeHandshakePayload(magic, data);
        if (decoded.kind === 'reject') {
          // NET_INTERFACE → "Ban policy": frame-tier reject — stream closed, no penalty.
          console.warn(`[net] inbound handshake frame from ${peerId} rejected: ${decoded.code}`);
          await replyEmpty();
          await endConnection();
          return;
        }
        const body = decoded.body;

        // Reading our era goes through node's store callback, so a failure here
        // is local — attributed to the store, not to the outer handshake span,
        // and never a penalty on the peer (same reasoning as our reply below).
        let era: number | null;
        try {
          era = this.currentEra();
        } catch (err) {
          console.error(`[net] cannot read our era for ${peerId}: ${String(err)}`);
          await replyEmpty();
          await endConnection();
          return;
        }

        const result = validateHandshake(decodeHandshakeBody(body), era);
        if (!result.ok || !result.msg) {
          // Contract: the stream closes either way, but the ban does not —
          // malformed input is banned permanently, an unsupported version is
          // only cooled down (see `handshakePenalty`).
          console.warn(`[net] inbound handshake from ${peerId} rejected: ${result.error}`);
          const hsPenKind = handshakePenalty(result.rejection);
          this.peerMgr.recordPenaltyKind(
            hsPenKind,
            peerId,
            `handshake: ${result.error}`,
          );
          await replyEmpty();
          await endConnection();
          return;
        }

        const msg = result.msg;
        console.log(`[net] inbound handshake from ${peerId} on id=${connId}: ok=true height=${msg.chainHeight}`);

        // NET_INTERFACE → Handshake → "A peer becomes Active once": a
        // handshake that completes for a peer already Active is answered
        // when this node is the listener, and records and raises nothing.
        const peerServesChain = servesChain(msg.capabilities);
        // NET_INTERFACE → Readers → "Readers have a budget of their own": a
        // reader past `maxReaders` is closed after its handshake, and so
        // is a chain-serving peer past `maxPeers`. Checked before the
        // state transitions so the budgets count the held peers, not the
        // one arriving.
        let closeAfterReply = false;
        if (!this.peerMgr.isPeerActive(peerId)) {
          if (peerServesChain) {
            if (this.getConnectedPeers().length >= this.config.maxPeers) {
              closeAfterReply = true;
            }
          } else {
            if (this.getConnectedReaders().length >= this.config.maxReaders) {
              closeAfterReply = true;
            }
          }
        }

        if (!closeAfterReply && !this.peerMgr.isPeerActive(peerId)) {
          // The metadata keeps the peer's declared version, not ours — it
          // is what the boundary sweep reads
          // (NET_INTERFACE → Post-Handshake Routing).
          this.peerMgr.setPeerVersion(peerId, msg.protocolVersion);
          this.peerMgr.setPeerCapabilities(peerId, msg.capabilities);
          // NET_INTERFACE → Handshake →
          // "A declared address is hearsay until a dial names it": the
          // listener records the dialler's declared address only when it
          // is no bogus address and its `/p2p/` component names the peer
          // id the connection proved, at lastSeenMs 0; a handshake that
          // declares no address records none. NET_INTERFACE → Readers —
          // "a reader declares no address, so it never enters `PeerDb`":
          // only a chain-serving peer's declared address is kept.
          const declared = msg.declaredAddress;
          if (
            peerServesChain
            && declared !== undefined
            && !isBogusAddress(declared, this.config.magic)
            && peerIdOfAddress(declared) === peerId
          ) {
            this.peerMgr.setPeerDeclaredAddress(peerId, declared);
            this.peerDb?.record({
              address: declared,
              lastSeenMs: 0,
              agentName: msg.agentName,
              nodeName: msg.nodeName,
              protocolVersion: msg.protocolVersion,
              capabilities: msg.capabilities,
            });
          }

          this.peerMgr.setPeerState(peerId, PeerState.Active);
          const dir = (connection.direction ?? 'inbound') as 'inbound' | 'outbound';
          // NET_INTERFACE → Readers → "The peer hooks see chain-serving
          // peers alone": the scheduler and the peerActive handlers fire
          // for a chain-serving peer alone. NET_INTERFACE → Readers →
          // "A reader's arrival has a hook of its own": the else branch
          // fires onReaderActive for a reader, never for a reader closed
          // for maxReaders — the budget check above returns before this
          // one does.
          if (peerServesChain) {
            this.syncMachine?.onPeerActive(peerId, result.peerHeight, dir);
            for (const cb of this.peerActiveHandlers) {
              try { cb(peerId, dir); } catch (err) {
                console.warn(`[net] peerActive handler error: ${String(err)}`);
              }
            }
          } else {
            // NET_INTERFACE → Readers → "A reader is its node's gossip
            // direct peer": the router takes the reader as a direct
            // peer when the handshake completes. The call is
            // idempotent.
            asDirectPeerRouter(libp2p).services.pubsub.addDirectPeer(peerId);
            for (const cb of this.readerActiveHandlers) {
              try { cb(peerId); } catch (err) {
                console.warn(`[net] readerActive handler error: ${String(err)}`);
              }
            }
          }
        }

        // Building our reply reads the chain height through node's store
        // callback, so a failure here is local and is not the stream I/O the
        // outer catch answers for. Own span, own message.
        let response: Uint8Array;
        try {
          response = buildHandshakeFrame(magic, this.buildOurHandshake());
        } catch (err) {
          console.error(`[net] cannot build our handshake for ${peerId}: ${String(err)}`);
          await replyEmpty();
          await endConnection();
          return;
        }
        await sinkFrame(response);
        // NET_INTERFACE → Handshake →
        // "A connection handshakes within its deadline, or is closed":
        // the listener's handshake has completed on this connection; the
        // deadline leaves it alone.
        if (typeof connId === 'string') this.completedConnections.add(connId);
        if (closeAfterReply) {
          // NET_INTERFACE → Readers — "Readers have a budget of their
          // own": a reader past `maxReaders`, and a chain-serving peer
          // past `maxPeers`, is closed after its handshake.
          const kind = peerServesChain ? 'chain peer past maxPeers' : 'reader past maxReaders';
          console.log(`[net] inbound handshake ${peerId}: ${kind} — closing`);
          await endConnection();
        }
      } catch (err) {
        // The empty frame is all we can say to a peer whose handshake did not
        // complete; the log is what separates that from a peer that never
        // dialled. `warn`, not `error` — an ordinary dropped connection lands
        // here too.
        console.warn(`[net] inbound handshake handler failed for ${peerId}: ${String(err)}`);
        await replyEmpty();
        await endConnection();
      }
    }, { maxInboundStreams: MAX_INBOUND_HANDSHAKE_STREAMS });
  }

  // -----------------------------------------------------------------------
  // Sync stream handler — framed protocol
  // -----------------------------------------------------------------------

  private async registerSyncStreamHandler(libp2p: Libp2p): Promise<void> {
    const magic = this.config.magic;

    await libp2p.handle(SYNC_PROTOCOL, async (stream, connection) => {
      const peerId = connection.remotePeer.toString();

      // NET_INTERFACE → Stream Protocols → "A peer's sync streams are served
      // one at a time". A not-Active peer's stream is refused at once and
      // holds no turn — it leaves the queue untouched. The write to a peer
      // that may have gone swallows its own error (→ "A stream handler
      // never rejects").
      if (!this.peerMgr.isPeerActive(peerId)) {
        try { await sinkWithDeadline(stream, new Uint8Array(0), this.config.syncRequestTimeoutMs); }
        catch { /* peer gone */ }
        await stream.close().catch(() => { /* already gone */ });
        return;
      }

      // Chain onto the peer's tail. The read, the serve and the close all
      // run inside `serveOneSyncStream`, so a stream's read deadline starts
      // when its turn arrives rather than when libp2p accepted it. The
      // stored tail swallows a rejection — one stream's fault never stalls
      // the peer's next stream — but the handler awaits `next` itself, so
      // a fault nobody foresaw surfaces as an unhandled rejection and the
      // node's backstop logs it.
      const prev = this.peerStreamQueues.get(peerId) ?? Promise.resolve();
      const next = prev.then(() => this.serveOneSyncStream(magic, peerId, stream));
      this.peerStreamQueues.set(peerId, next.catch(() => { /* a per-stream fault leaves the lane open */ }));
      await next;
    }, { maxInboundStreams: MAX_INBOUND_SYNC_STREAMS });
  }

  /**
   * One sync stream, whole: read, decode, dispatch or serve, close.
   *
   * Every path ends the stream before returning (NET_INTERFACE → Stream
   * Protocols → "Every inbound stream ends"). A one-way message's stream
   * closes once its body is handed on; a query's closes after its answer
   * (zero bytes included); an undecodable frame or an unserved code closes
   * unanswered. Called under the per-peer serial queue in
   * `registerSyncStreamHandler`.
   */
  private async serveOneSyncStream(
    magic: number,
    peerId: string,
    stream: import('@libp2p/interface').Stream,
  ): Promise<void> {
    // Default write deadline — the deadline the reader on the other side
    // holds. A `Blocks` answer is ×5 (NET_INTERFACE → Validation →
    // "A stream write is bounded in time as well").
    const deadlineMs = this.config.syncRequestTimeoutMs;
    const sinkDeadline = async (data: Uint8Array, mul = 1): Promise<void> =>
      sinkWithDeadline(stream, data, deadlineMs * mul);
    // NET_INTERFACE → Stream Protocols → "A stream handler never rejects":
    // the failure-path empty answer to a peer that has gone ends the stream
    // with nothing more to say.
    const replyEmpty = async (): Promise<void> => {
      try { await sinkDeadline(new Uint8Array(0)); } catch { /* peer gone */ }
    };
    const closeNow = async (): Promise<void> => {
      await stream.close().catch(() => { /* already gone */ });
    };

    const serveChainQuery = async <T, P>(
      code: number,
      request: T | null,
      provider: P | null,
      serve: (
        request: T,
        ourHeight: number,
        provider: P,
      ) => Uint8Array,
      writeMultiplier: number,
    ): Promise<void> => {
      if (request === null) {
        console.warn(`[net] malformed chain query (code ${code}) from ${peerId}, dropping`);
        this.peerMgr.recordPenaltyKind(
          PenaltyKind.ProtocolViolation,
          peerId,
          `malformed chain query (code ${code})`,
        );
        await replyEmpty();
        return;
      }

      // NET_INTERFACE → Sync Handler Registration: a node that has
      // registered no provider for a query answers it zero bytes.
      if (!provider) {
        await replyEmpty();
        return;
      }

      // The serve loops read our own store through node's provider, so a
      // throw here is a row we hold and cannot encode — ours, not the peer's,
      // and no reason to penalise the sender (NET_INTERFACE → Penalty
      // Attribution). Its own span for the same reason the posts callback has
      // one.
      let response: Uint8Array;
      try {
        response = serve(request, this.syncStore.chainHeight(), provider);
      } catch (err) {
        console.error(
          `[net] cannot serve chain query (code ${code}) for ${peerId}: ${String(err)}`,
        );
        await replyEmpty();
        return;
      }
      await sinkDeadline(response, writeMultiplier);
    };

    try {
      const data = await readStreamBounded(stream, MAX_STREAM_BYTES, AbortSignal.timeout(this.config.syncRequestTimeoutMs));
      if (data === null) {
        console.warn(`[net] sync stream from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        this.peerMgr.recordPenaltyKind(
          PenaltyKind.ProtocolViolation,
          peerId,
          'sync stream exceeds byte cap',
        );
        await replyEmpty();
        return;
      }
      if (data.length === 0) {
        await replyEmpty();
        return;
      }

      let code: number;
      let body: Uint8Array;
      try {
        const framed = decodeFrame(magic, data);
        code = framed.code;
        body = framed.body;
      } catch {
        // NET_INTERFACE → Sync Handler Registration: a code no arm serves
        // is closed unanswered, and the same posture applies to an
        // undecodable frame.
        return;
      }

      if (code === MSG_GET_PEERS) {
        // `servePeersBody` reads the requester's metadata itself, so the
        // dialled and the declared addresses it holds are both excluded
        // (NET_INTERFACE → Handshake →
        // "A declared address is hearsay until a dial names it").
        const response = servePeersBody(body, {
          peerDb: this.peerDb,
          peerMgr: this.peerMgr,
          peerId,
          magic,
        });
        if (response) await sinkDeadline(response);
        else await replyEmpty();
        return;
      }

      if (code === MSG_GET_HEADERS) {
        await serveChainQuery(code, decodeGetHeaders(body), this.headerProvider,
          (request, ourHeight, getHeader) => serveHeadersResponse(
            magic, request, ourHeight,
            (id) => this.syncStore.heightByBlockId(id), getHeader,
          ), 1);
        return;
      }

      if (code === MSG_GET_BLOCKS) {
        await serveChainQuery(code, decodeGetBlocks(body), this.headersProvider,
          (request, ourHeight, getBlock) => serveBlocksResponse(
            magic, request, ourHeight,
            (id) => this.syncStore.heightByBlockId(id), getBlock,
          ), 5);
        return;
      }

      if (code === MSG_MODIFIER_REQUEST) {
        const req = decodeModifierRequest(body);
        if (!req) {
          console.warn(`[net] malformed ModifierRequest from ${peerId}, dropping`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'malformed ModifierRequest',
          );
          await replyEmpty();
          return;
        }
        if (req.typeId === MODIFIER_POST_BODY) {
          const provider = this.postBodyProvider;
          if (!provider) {
            await replyEmpty();
            return;
          }
          const response = servePostBodiesResponse(magic, req, provider);
          if (response === null) {
            await replyEmpty();
            return;
          }
          await sinkDeadline(response);
          return;
        }
        // NET_INTERFACE → ModifierRequest (code 4): type 101 is retired, so
        // an unknown type id — decoded and dropped, unpenalised.
        await replyEmpty();
        return;
      }

      // NET_INTERFACE → Sync Handler Registration. The scheduler reads
      // only `SyncInfo` through `handleMessage`; any other code reaching
      // this fallthrough is dropped as unknown.
      if (code === MSG_SYNC_INFO) {
        try {
          this.syncMachine?.handleMessage(peerId, code, body);
        } catch (err) {
          console.error(`[net] sync dispatch failed for code=${code} from ${peerId}: ${String(err)}`);
          await replyEmpty();
        }
      }
    } catch (err) {
      // What is left after the two narrow spans above: stream I/O, the frame
      // decode fallback, and the chain-query / peer-exchange serve paths. A
      // dropped connection mid-stream is ordinary and lands here, which is
      // why this is `warn` rather than `error`.
      console.warn(`[net] sync stream handler failed for ${peerId}: ${String(err)}`);
      await replyEmpty();
    } finally {
      await closeNow();
    }
  }

  // -----------------------------------------------------------------------
  // Handshake — outbound
  // -----------------------------------------------------------------------

  /**
   * The era of the next block this node would apply — what the handshake checks
   * a peer against (NET_INTERFACE → Handshake). `null` only if the chain height
   * is out of the schedule's domain, which a valid profile and a non-negative
   * `SyncStore` height rule out.
   */
  private currentEra(): number | null {
    return protocolVersionAt(this.config.protocolVersionSchedule, this.syncStore.chainHeight() + 1);
  }

  private buildOurHandshake(): import('./handshake.js').HandshakeMsg {
    return {
      agentName: 'dagsocial',
      protocolVersion: PROTOCOL_VERSION,
      nodeName: this.peerId().slice(0, 12),
      chainHeight: this.syncStore.chainHeight(),
      // NET_INTERFACE → Handshake Body, the `declaredAddress` row: the first
      // listen address that is not loopback, absent when every one is — a
      // loopback address advertised to a peer is one no peer can dial.
      declaredAddress: (this.libp2p?.getMultiaddrs() ?? [])
        .map((a) => a.toString())
        .find((a) => !isLoopbackAddress(a)),
      // NET_INTERFACE → Readers → "A peer's capabilities say what it
      // serves": the request codes a full node answers.
      capabilities: [...NODE_CAPABILITIES],
    };
  }

  private async runOutboundHandshake(
    conn: import('@libp2p/interface').Connection,
  ): Promise<HandshakeResult> {
    const peerId = conn.remotePeer.toString();
    const magic = this.config.magic;
    const ourMsg = this.buildOurHandshake();

    // NET_INTERFACE → Handshake → "The dial funnel handshakes only a
    // connection it opened": the stream opens on this connection, not on
    // whichever one libp2p's dial queue picks.
    const data = await oneRoundTrip(
      (signal) => conn.newStream(HANDSHAKE_PROTOCOL, { signal }),
      buildHandshakeFrame(magic, ourMsg),
      this.config,
      1,
      MAX_HANDSHAKE_FRAME_BYTES,
    );

    if (data === null) {
      console.warn(`[net] handshake response from ${peerId} exceeded ${MAX_HANDSHAKE_FRAME_BYTES} bytes`);
      this.peerMgr.recordPenaltyKind(
        PenaltyKind.ProtocolViolation,
        peerId,
        'handshake stream exceeds byte cap',
      );
      return {
        ok: false,
        error: 'handshake response exceeds byte cap',
        rejection: 'malformed',
        peerHeight: 0,
        peerCapabilities: [],
      };
    }

    if (data.length === 0) {
      return { ok: false, error: 'empty handshake response', peerHeight: 0, peerCapabilities: [] };
    }

    const decoded = decodeHandshakePayload(magic, data);
    if (decoded.kind === 'reject') {
      // NET_INTERFACE → "Ban policy": frame-tier reject — no penalty.
      console.warn(`[net] outbound handshake with ${peerId}: frame rejected (${decoded.code})`);
      return {
        ok: false,
        error: `handshake frame rejected: ${decoded.code}`,
        peerHeight: 0,
        peerCapabilities: [],
      };
    }
    const body = decoded.body;

    const result = validateHandshake(decodeHandshakeBody(body), this.currentEra());
    if (!result.ok) {
      console.warn(`[net] outbound handshake with ${peerId} rejected: ${result.error}`);
      const outHsPenKind = handshakePenalty(result.rejection);
      this.peerMgr.recordPenaltyKind(
        outHsPenKind,
        peerId,
        `handshake: ${result.error}`,
      );
      return result;
    }
    console.log(`[net] outbound handshake with ${peerId} on id=${conn.id}: ok=true height=${result.peerHeight} caps=${result.peerCapabilities.length}`);
    return result;
  }

  // -----------------------------------------------------------------------
  // Sync helpers
  // -----------------------------------------------------------------------

  private sendToPeer(peerId: string, data: Uint8Array): Promise<void> {
    if (!this.libp2p) return Promise.resolve();
    const libp2p = this.libp2p;
    let peer;
    try {
      peer = connectedPeer(libp2p, peerId);
    } catch {
      console.warn(`[net] sendToPeer: peer ${peerId} not found in libp2p.getPeers() (have ${libp2p.getPeers().length} peers)`);
      return Promise.resolve();
    }

    // Return a promise that settles when the write ends (taken, failed or
    // aborted). The sync machine awaits it to learn when the next block
    // answer to the same peer may go out (NET_INTERFACE → Serve Side →
    // "A peer is served one block answer at a time").
    const deadlineMs = this.config.syncRequestTimeoutMs;
    return this.libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(deadlineMs),
    }).then(async (stream) => {
      try {
        // The write is raced against the deadline the reader on the other
        // side runs under — a push that outlasts it aborts the stream and
        // never a penalty (NET_INTERFACE → Validation → "A stream write is
        // bounded in time as well").
        await sinkWithDeadline(stream, data, deadlineMs);
      } catch { /* the write did not take — a dead connection, nothing to retry */ }
      await stream.close().catch(() => { /* already gone */ });
    }).catch(() => { /* a failed dial has no retry here; the pick path handles rotation */ });
  }

  // -----------------------------------------------------------------------
  // Identity + peers
  // -----------------------------------------------------------------------

  peerId(): string {
    if (!this.libp2p) throw new Error('NetNode not started');
    return this.libp2p.peerId.toString();
  }

  peers(): Peer[] {
    return this.peerMgr.getPeers();
  }

  /**
   * NET_INTERFACE → API → Node Lifecycle → `getConnectedPeers`: the peer ids
   * of the Active chain-serving peers — the handshake completed and
   * `servesChain` of its capabilities (NET_INTERFACE → Readers).
   */
  getConnectedPeers(): string[] {
    const out: string[] = [];
    for (const peer of this.peerMgr.getPeers()) {
      if (!this.peerMgr.isPeerActive(peer.id)) continue;
      const caps = peer.capabilities;
      if (!caps || !servesChain(caps)) continue;
      out.push(peer.id);
    }
    return out;
  }

  /**
   * NET_INTERFACE → API → Node Lifecycle → `getConnectedReaders`: the peer
   * ids of the Active readers (NET_INTERFACE → Readers → "A peer's
   * capabilities say what it serves" — a peer that is not chain-serving is
   * a reader).
   */
  getConnectedReaders(): string[] {
    const out: string[] = [];
    for (const peer of this.peerMgr.getPeers()) {
      if (!this.peerMgr.isPeerActive(peer.id)) continue;
      const caps = peer.capabilities;
      if (!caps) continue;
      if (servesChain(caps)) continue;
      out.push(peer.id);
    }
    return out;
  }

  /**
   * NET_INTERFACE → API → Node Lifecycle → `getServingReaders`: the peer
   * ids of the Active readers whose handshake declared `ModifierRequest`
   * (NET_INTERFACE → Readers → "A reader is never asked for chain data").
   */
  getServingReaders(): string[] {
    const out: string[] = [];
    for (const peer of this.peerMgr.getPeers()) {
      if (!this.peerMgr.isPeerActive(peer.id)) continue;
      const caps = peer.capabilities;
      if (!caps) continue;
      if (servesChain(caps)) continue;
      if (!declares(caps, MSG_MODIFIER_REQUEST)) continue;
      out.push(peer.id);
    }
    return out;
  }

  /**
   * NET_INTERFACE → API → Node Lifecycle → `peerCapabilities`: the
   * capabilities an Active peer's handshake declared; `null` for a peer
   * not Active.
   */
  peerCapabilities(peerId: string): readonly number[] | null {
    if (!this.peerMgr.isPeerActive(peerId)) return null;
    return this.peerMgr.getPeerMetadata(peerId)?.capabilities ?? null;
  }

  /**
   * NET_INTERFACE → The mesh — the mesh node's identity, once its
   * addresses are announced: its Notis spelling, its peer id, the
   * addresses it announces and its local WebRTC-direct addresses.
   * `null` with no mesh, or before libp2p has started.
   */
  meshIdentity(): MeshIdentity | null {
    const mesh = this.config.mesh;
    if (mesh === undefined) return null;
    if (this.libp2p === null) return null;
    const node = this.libp2p;
    const notisId = notisIdFromPeerId(node.peerId);
    const peerId = node.peerId.toString();
    const multiaddrs = node.getMultiaddrs().map((a) => a.toString());
    // Private role lists its local WebRTC-direct listen with certhash
    // and the peer id (`MESH_INTERFACE → Discovery → "A node added by
    // hand"`); public lists none (announces its listen addresses
    // already).
    const localAddrs = localAddrsFor(mesh.role, listenerAddrsOf(node), peerId);
    return { notisId, peerId, multiaddrs, localAddrs };
  }

  /**
   * NET_INTERFACE → The mesh — register a callback for each change of
   * the mesh node's announced address set.
   */
  onMeshAddresses(cb: (id: MeshIdentity) => void): void {
    this.meshAddressHandlers.push(cb);
  }

  /**
   * The node reports each applied tip — every successful apply and the tip a
   * reorg leaves (NET_INTERFACE → API → Node Lifecycle). When the era at the
   * next height rises above the era in force, the boundary sweep drops every
   * Active peer whose declared version is below the new era, so every Active peer
   * implements the era this node is applying (NET_INTERFACE → Post-Handshake
   * Routing). Inside an era it does nothing, and iterates nothing.
   */
  tipApplied(height: number): void {
    const era = protocolVersionAt(this.config.protocolVersionSchedule, height + 1);
    if (era === null || era <= this.eraInForce) return;
    for (const peerId of this.peerMgr.activePeersBelowVersion(era)) {
      this.disconnectPeer(peerId);
    }
    this.eraInForce = era;
  }

  /**
   * Close a peer's libp2p connection and drop it from the manager. Called by
   * the boundary sweep (tipApplied) and by the onBanned binding. The PeerId
   * comes from the live connection, so no id-parsing dependency is needed.
   * The manager row is removed here so the peer is no longer Active at once;
   * the `peer:disconnect` event the hang-up raises repeats the removal
   * idempotently.
   */
  private disconnectPeer(peerId: string): void {
    const conn = this.libp2p?.getConnections().find((c) => c.remotePeer.toString() === peerId);
    if (conn) void Promise.resolve(this.libp2p!.hangUp(conn.remotePeer)).catch(() => {});
    this.peerMgr.removePeer(peerId);
  }

  // -----------------------------------------------------------------------
  // Outbound broadcast
  // -----------------------------------------------------------------------

  async broadcastOrderingBlock(block: OrderingBlock): Promise<void> {
    if (!this.libp2p || !this.topics) return;
    await broadcastOrderingBlock(asGossip(this.libp2p), this.topics, block);
  }

  async broadcastTx(tx: UtxoTransaction, content?: string): Promise<void> {
    if (!this.libp2p || !this.topics) return;
    await broadcastTx(asGossip(this.libp2p), this.topics, tx, content);
  }

  // -----------------------------------------------------------------------
  // Inbound handlers
  // -----------------------------------------------------------------------

  onOrderingBlock(cb: OrderingBlockCallback): void {
    this.orderingBlockHandlers.push(cb);
  }

  onTx(cb: TxCallback): void {
    this.txHandlers.push(cb);
  }

  /**
   * Register a callback that fires when the sync machine enters the 'synced'
   * phase (NET_INTERFACE → Sync State Machine → "The phases.").
   */
  onSyncComplete(cb: () => void): void {
    this.syncCompleteHandlers.push(cb);
  }

  /** NET_INTERFACE → API → Node Lifecycle. */
  syncPhase(): 'idle' | 'syncing' | 'synced' {
    return this.syncMachine?.getState().phase ?? 'idle';
  }

  /** NET_INTERFACE → Sync Handler Registration. */
  onPeerActive(cb: (peerId: string, direction: 'inbound' | 'outbound') => void): void {
    this.peerActiveHandlers.push(cb);
  }

  /** NET_INTERFACE → Sync Handler Registration — the `onReaderActive` row. */
  onReaderActive(cb: (peerId: string) => void): void {
    this.readerActiveHandlers.push(cb);
  }

  /** NET_INTERFACE → Sync Handler Registration. */
  onPeerDisconnected(cb: (peerId: string, reason: string) => void): void {
    this.peerDisconnectedHandlers.push(cb);
  }

  /** NET_INTERFACE → Sync Handler Registration. */
  onPeerPenalised(cb: (peerId: string, kind: string, detail: string | null) => void): void {
    this.peerPenalisedHandlers.push(cb);
  }

  // -----------------------------------------------------------------------
  // Sync — outbound requests
  // -----------------------------------------------------------------------

  async requestHeaders(locator: string[], peerId: string): Promise<BlockHeader[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestHeaders(this.libp2p, locator, peerId, this.config);
  }

  async requestBlocks(ids: string[], peerId: string): Promise<OrderingBlock[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestBlocks(this.libp2p, ids, peerId, this.config);
  }

  /**
   * Ask `peerId` for its recent peers and feed the response into PeerDb
   * (NET_INTERFACE → GetPeers / Peers Intake). A malformed Peers response is
   * a protocol violation — permanent ban of the sender; bogus addresses in a
   * valid response are dropped silently, without penalty.
   */
  async requestPeers(peerId: string): Promise<void> {
    if (!this.libp2p) return;
    let peer;
    try {
      peer = connectedPeer(this.libp2p, peerId);
    } catch {
      console.warn(`[net] requestPeers: peer ${peerId} not found`);
      return;
    }
    const magic = this.config.magic;
    const request = encodeGetPeers(magic);
    const libp2p = this.libp2p;
    try {
      const data = await oneRoundTrip(
        (signal) => libp2p.dialProtocol(peer, SYNC_PROTOCOL, { signal }),
        request,
        this.config,
      );
      if (data === null) {
        console.warn(`[net] requestPeers: response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        return;
      }
      if (data.length === 0) return;
      const frame = decodeFrame(magic, data);
      if (frame.code !== MSG_PEERS) {
        console.warn(`[net] requestPeers: unexpected response code ${frame.code}`);
        return;
      }
      const usable = intakePeersBody(frame.body, {
        peerDb: this.peerDb,
        peerMgr: this.peerMgr,
        peerId,
        magic,
      });
      if (usable !== null && usable > 0) {
        console.log(`[net] Peers from ${peerId}: recorded ${usable} address(es)`);
      }
    } catch (err) {
      console.warn(`[net] requestPeers failed for peer ${peerId}: ${String(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Sync — handler registration
  // -----------------------------------------------------------------------

  /**
   * Replace the relay-path karma membership set — see `KarmaMembers` in
   * gossip.ts. Node owns the membership; net only reads it.
   *
   * The set is mutated in place rather than reassigned, because the topic
   * validator closed over this object at `subscribeTopics` time. Reassigning the
   * field would leave that closure reading a set that never changes again — a
   * gate that silently stops tracking, which is the failure mode this method's
   * shape exists to prevent.
   */
  setKarmaMembers(members: Iterable<string>): void {
    this.karmaMembers.clear();
    for (const m of members) this.karmaMembers.add(m);
  }

  /** Admit an identity to the relay gate — it first received karma. */
  addKarmaMember(authorHex: string): void {
    this.karmaMembers.add(authorHex);
  }

  /** Drop an identity from the relay gate — its karma balance reached zero. */
  removeKarmaMember(authorHex: string): void {
    this.karmaMembers.delete(authorHex);
  }

  /**
   * Node's one call into the penalty system (NET_INTERFACE → Peer Penalty
   * System). Records the named tier against the peer with the reason string;
   * accrual, decay and the ban threshold apply unchanged.
   */
  penalizePeer(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void {
    if (kind === 'misbehavior') {
      this.peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId, reason);
    } else {
      this.peerMgr.recordPenaltyKind(PenaltyKind.Transient, peerId, reason);
    }
  }

  /**
   * Register the whole-block provider for `GetBlocks` (16). The provider
   * reads at request time rather than closed over at registration — so this
   * is valid before or after `start()`, and a later call replaces the
   * provider (NET_INTERFACE → Sync Handler Registration).
   */
  setHeadersHandler(getBlock: (height: number) => OrderingBlock | null): void {
    this.headersProvider = getBlock;
  }

  /**
   * Register the header-at-height provider for `GetHeaders` (NET_INTERFACE
   * → Sync Handler Registration). One height is one
   * provider call; unset, `GetHeaders` is answered zero bytes.
   */
  setHeaderProvider(cb: (height: number) => BlockHeader | null): void {
    this.headerProvider = cb;
  }

  // NET_INTERFACE → Sync Handler Registration
  setChainHeightProvider(cb: () => number): void {
    this.syncStore.setChainHeightProvider(cb);
  }

  // NET_INTERFACE → Sync Handler Registration
  setBlockIdProvider(cb: (height: number) => string | null): void {
    this.syncStore.setBlockIdProvider(cb);
  }

  // NET_INTERFACE → Sync Handler Registration
  setHeightByBlockIdProvider(cb: (id: string) => number | null): void {
    this.syncStore.setHeightByBlockIdProvider(cb);
  }

  // -----------------------------------------------------------------------
  // Post body seams — NET_INTERFACE → Sync Handler Registration
  // -----------------------------------------------------------------------

  // NET_INTERFACE → Sync Handler Registration
  setScheduledTargetProvider(cb: (header: BlockHeader) => number | null): void {
    this.scheduledTargetProvider = cb;
  }

  // NET_INTERFACE → Sync Handler Registration. The ordering-block topic
  // validator reads this provider on each header, before the body is decoded
  // (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"). Held
  // like the scheduled-target provider — the validator closed over this
  // NetNode at `subscribeTopics` time and reads the field at call time, so a
  // late set takes effect without re-registering.
  setHeaderStandingProvider(
    cb: (hash: string, height: number) => 'held' | 'refused' | null,
  ): void {
    this.headerStandingProvider = cb;
  }

  setPostBodyProvider(cb: (postId: string) => string | null): void {
    this.postBodyProvider = cb;
  }

  /** NET_INTERFACE → Sync Handler Registration — the `setPipeline` row. */
  setPipeline(intake: import('./sync-types.js').PipelineIntake): void {
    this.pipeline = intake;
    this.syncMachine?.setPipeline(intake);
  }

  /** NET_INTERFACE → Sync Handler Registration — the `setChainView` row. */
  setChainView(view: import('./sync-types.js').ChainView): void {
    this.chainViewRegistered = view;
    this.syncMachine?.setChainView(view);
  }

  /** NET_INTERFACE → Pipeline events — `needHeaders(peerId)`. */
  needHeaders(peerId: string): void {
    this.syncMachine?.needHeaders(peerId);
  }

  /** NET_INTERFACE → Pipeline events — `chainMoved()`. */
  chainMoved(): void {
    this.syncMachine?.chainMoved();
  }

  async requestPostBodies(
    ids: { id: string; contentHash: Uint8Array }[],
    peerId: string,
  ): Promise<{ id: string; content: string }[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    // NET_INTERFACE → Readers → "A peer is asked for a code only if it
    // declares it": a caller's list of peers may be stale (a reader
    // selected by a caller that filtered on the wrong moment); the guard
    // refuses rather than open a stream against a peer that would close
    // it unanswered.
    const caps = this.peerMgr.getPeerMetadata(peerId)?.capabilities ?? null;
    if (caps === null || !declares(caps, MSG_MODIFIER_REQUEST)) return [];
    const libp2p = this.libp2p;
    const peer = connectedPeer(libp2p, peerId);

    const commitments = new Map<string, Uint8Array>();
    for (const entry of ids) commitments.set(entry.id, entry.contentHash);

    const magic = this.config.magic;
    const results: { id: string; content: string }[] = [];
    // NET_INTERFACE → Pull Requests: any number of ids, asked in requests
    // of at most MAX_INV_IDS, one after another, the answers merged; a
    // request that fails fails the call, as one request does.
    for (let i = 0; i < ids.length; i += MAX_INV_IDS) {
      const chunk = ids.slice(i, i + MAX_INV_IDS);
      const req: import('./sync-types.js').ModifierRequest = {
        typeId: MODIFIER_POST_BODY,
        ids: chunk.map((e) => e.id),
      };
      const raw = await oneRoundTrip(
        (signal) => libp2p.dialProtocol(peer, SYNC_PROTOCOL, { signal }),
        encodeModifierRequest(magic, req),
        this.config,
      );
      if (raw === null || raw.length === 0) continue;
      const frame = decodeFrame(magic, raw);
      if (frame.code !== MSG_MODIFIER_RESPONSE) continue;
      const resp = decodeModifierResponse(frame.body);
      if (!resp || resp.typeId !== MODIFIER_POST_BODY) continue;

      for (const mod of resp.modifiers) {
        const commitment = commitments.get(mod.id);
        if (!commitment) continue;
        let content: string;
        try {
          content = decodePostBody(mod.data);
        } catch {
          this.peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId,
            `post body decode failed for ${mod.id}`);
          continue;
        }
        const vr = this.validators.verifyPostBody(content, commitment);
        if (!vr.valid) {
          this.peerMgr.recordPenaltyKind(PenaltyKind.Misbehavior, peerId,
            `post body commitment mismatch for ${mod.id}`);
          continue;
        }
        results.push({ id: mod.id, content });
      }
    }
    return results;
  }

  // Expose for node to register storage-backed handler
  get libp2pNode(): Libp2p | null {
    return this.libp2p;
  }
}
