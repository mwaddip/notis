import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';

import type { Libp2p } from 'libp2p';
import type { OrderingBlock, UtxoTransaction, BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION, protocolVersionAt, encodeOrderingBlock, decodePostBody, encodePostBody } from '@dagsocial/types';
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
  gossipTopics,
  gossipMessageId,
  GOSSIP_SEEN_WINDOW_MS,
} from './gossip.js';
import {
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
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_HANDSHAKE_FRAME_BYTES,
  MAX_INBOUND_HANDSHAKE_STREAMS,
  MAX_INBOUND_SYNC_STREAMS,
  MAX_INV_IDS,
  MAX_SERVE_BODY_BYTES,
  MAX_STREAM_BYTES,
} from './msg-guards.js';
import { PeerDb, type PeerStorage } from './peerdb.js';
import { SyncMachine } from './sync-machine.js';
import type { SyncStore } from './sync-machine.js';
import { OutboundManager } from './outbound-mgr.js';
import { decodeFrame, KNOWN_FRAME_MAGICS } from './frame.js';
import {
  buildHandshakeFrame,
  handshakePenalty,
  parseHandshakeBody,
  validateHandshake,
} from './handshake.js';
import type { HandshakeResult } from './handshake.js';
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

type OrderingBlockCallback = (block: OrderingBlock, fromPeerId: string) => void;
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
 * (NET_INTERFACE → "Ban surfaces are unified"). Returns the framed Peers
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
 * Which peers are due a GetPeers this tick: Active state, and no send within
 * the last GET_PEERS_INTERVAL_MS. Stamps `lastSentMs` for every returned id,
 * so a peer is never picked twice inside one interval. A peer with no stamp
 * (fresh handshake) is due immediately — the bootstrap flow sends GetPeers
 * right after handshake, not two minutes later.
 */
export function duePeerExchange(
  peerMgr: PeerManager,
  lastSentMs: Map<string, number>,
  nowMs: number,
): string[] {
  const due: string[] = [];
  for (const peer of peerMgr.getPeers()) {
    if (!peerMgr.isPeerActive(peer.id)) continue;
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
   * Per-connection timers that close a connection whose handshake has not
   * completed `HANDSHAKE_DEADLINE_FACTOR × syncRequestTimeoutMs` after its
   * open (NET_INTERFACE → Handshake →
   * "A connection handshakes within its deadline, or is closed"). Each timer
   * is `unref`ed, so a live one never holds the process open; cleared at
   * `connection:close` and at `stop()`.
   */
  private handshakeDeadlines: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: NetConfig, validators: NetValidators, peerStorage?: PeerStorage) {
    this.config = config;
    this.validators = validators;
    this.syncStore = new LazySyncStore(validators);
    // Omitted in tests/embedded use — PeerDb then runs ephemeral (NET_INTERFACE →
    // Persistence seam), which is the valid non-production configuration.
    this.peerStorage = peerStorage ?? null;
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

    // createLibp2p options cast to `any` works around @libp2p/interface version
    // mismatches in the dependency tree (v1.7, v2.11, v3.2 coexist).  The
    // runtime behaviour is correct; only the static types disagree.
    const libp2p = await createLibp2p({
      addresses: {
        listen: [this.config.listenAddrs],
      },
      transports: [tcp()],
      connectionEncryption: [noise()],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamMuxers: [yamux() as any],
      services: {
        // NET_INTERFACE → libp2p Stack.
        pubsub: gossipsub({
          // NET_INTERFACE → Gossip Topics →
          // "A message is its topic and its data"
          // The router refuses a signed envelope and emits none.
          globalSignaturePolicy: 'StrictNoSign',
          // NET_INTERFACE → Gossip Topics → "A message is named by its bytes".
          msgIdFn: (msg) => gossipMessageId(msg.topic, msg.data),
          // NET_INTERFACE → Gossip Topics →
          // "A message is heard once in a seen window"
          seenTTL: GOSSIP_SEEN_WINDOW_MS,
          // NET_INTERFACE → Gossip →
          // "A broadcast that sends nothing still resolves"
          // A publish of bytes this node has seen inside the window resolves
          // without sending.
          ignoreDuplicatePublishError: true,
          // NET_INTERFACE → Gossip Topics →
          // "A topic is named for its network"
          // The two topic strings are the whole of what the router hears; a
          // subscription or a message on any other topic is passed over before
          // the router names, caches or forwards anything.
          allowedTopics: [topics.orderingBlock, topics.tx],
          allowPublishToZeroTopicPeers: true,
          // NET_INTERFACE → Forwarding Rule → "An ordering block is forwarded
          // once Stage 1 passes; a transaction once this node admits it":
          // the router holds a message that passed its topic validator in the
          // message cache until the listener reports Accept, Ignore or Reject.
          asyncValidation: true,
        }),
        identify: identify(),
        ping: ping(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // NET_INTERFACE → "A banned peer's inbound connection is refused at the transport"
      connectionGater: {
        denyInboundEncryptedConnection: (peerId: { toString(): string }) =>
          this.peerMgr.isBanned(peerId.toString()),
      },
      connectionManager: {
        maxConnections: this.config.maxPeers,
        minConnections: 0,
      },
      // Disable the built-in connection monitor heartbeat.  When enabled it
      // pings peers every 10 s via /ipfs/ping/1.0.0 and aborts the connection
      // if the ping fails.  The AdaptiveTimeout uses a 2 s floor derived from
      // an uninitialised moving average, so the first heartbeat almost always
      // times out and kills the connection.  Explicit pings are still available
      // via @libp2p/ping if needed.
      connectionMonitor: {
        enabled: false,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    this.libp2p = libp2p;

    try {
      // Create PeerDb with self-address filtering
      const listenAddrs = this.libp2p.getMultiaddrs();
      const selfAddrs = listenAddrs.map(a => a.toString());
      this.peerDb = new PeerDb(this.peerStorage, this.config.peerDbCap ?? 1000, selfAddrs);

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

      // Register handshake stream handler
      this.registerHandshakeHandler(libp2p);

      // Register sync stream handler (framed protocol)
      this.registerSyncStreamHandler(libp2p);

      // Track peers on connect/disconnect.
      // Listen for all four event types because the timing and payload differ:
      //   connection:open  — fires first, has full Connection object (addr, direction)
      //   peer:connect     — fires after, only has PeerId
      //   connection:close — fires first, has full Connection object + timeline
      //   peer:disconnect  — fires after, only has PeerId
      this.libp2p.addEventListener('connection:open', (evt: any) => {
        const conn = evt.detail;
        const peerId = conn?.remotePeer?.toString() ?? 'unknown';
        const direction = conn?.direction ?? '?';
        console.log(`[net] connection:open peer=${peerId} dir=${direction}`);
        // NET_INTERFACE → Handshake →
        // "A connection handshakes within its deadline, or is closed":
        // the deadline starts at connection:open, per connection id.
        if (typeof conn?.id === 'string') this.startHandshakeDeadline(conn);
      });

      this.libp2p.addEventListener('peer:connect', (evt: any) => {
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

      this.libp2p.addEventListener('connection:close', (evt: any) => {
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
          const timer = this.handshakeDeadlines.get(conn.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            this.handshakeDeadlines.delete(conn.id);
          }
        }
        console.log(`[net] connection:close peer=${peerId} addr=${remoteAddr} dir=${direction} durationMs=${durationMs} opened=${openTs} closed=${closeTs}`);
      });

      this.libp2p.addEventListener('peer:disconnect', (evt: any) => {
        const peerId = evt.detail?.toString() ?? 'unknown';
        console.log(`[net] peer:disconnect ${peerId} (total=${Math.max(0, this.peerMgr.getPeerCount() - 1)})`);
        this.peerMgr.removePeer(peerId);
        this.lastGetPeersSentMs.delete(peerId);
        // NET_INTERFACE → Stream Protocols → "A peer's sync streams are served one at a time":
        // per-peer state goes when the peer does.
        this.peerStreamQueues.delete(peerId);
        this.syncMachine?.onPeerDisconnect(peerId);
        for (const cb of this.peerDisconnectedHandlers) {
          try { cb(peerId, ''); } catch (err) {
            console.warn(`[net] peerDisconnected handler error: ${String(err)}`);
          }
        }
      });

      // Log identify completion — confirms the connection was fully upgraded
      this.libp2p.addEventListener('peer:identify', (evt: any) => {
        const result = evt.detail;
        const peerId = result?.peerId?.toString() ?? '?';
        console.log(`[net] peer:identify ${peerId}`);
      });

      // Subscribe to gossip topics
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
        asGossip(this.libp2p),
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
      console.log(`[net] listening on: ${listenAddrs.map(a => a.toString()).join(', ')}`);

      // NET_INTERFACE → Handshake →
      // "A connection handshakes within its deadline, or is closed":
      // `createLibp2p` has already begun listening by the time the
      // `connection:open` listener attaches, so a connection that opens in
      // that window has no timer yet. Sweep every connection libp2p is
      // holding and start the deadline for it; `startHandshakeDeadline` is
      // idempotent on a connection whose timer is already running.
      for (const conn of this.libp2p.getConnections()) {
        this.startHandshakeDeadline(conn);
      }

      // Dial each configured bootstrap peer. Each dial reports settled
      // (Active, failed or self) through `markBootstrapSettled`, which the
      // scheduler reads under NET_INTERFACE → Sync State Machine → "The gate
      // bounds how far blocks apply."
      for (const addr of this.config.bootstrapPeers) {
        await this.dialAndHandshake(addr, 'seed');
      }

      // Start periodic timer: outbound manager + peer discovery. The sync machine
      // keeps its own tick cadence inside its event loop. A method, not an
      // inline closure, so a test can drive one tick without waiting
      // OUTBOUND_TICK_INTERVAL_MS.
      this.syncTimer = setInterval(() => this.outboundTick(), OUTBOUND_TICK_INTERVAL_MS);

      this.started = true;
    } catch (err) {
      // NET_INTERFACE → API → Node Lifecycle →
      // "A start that throws stops what it started". Everything after
      // createLibp2p runs inside the try above; on a throw, the libp2p
      // node and whatever startup reached is torn down before the error
      // leaves start().
      if (this.syncTimer) {
        clearInterval(this.syncTimer);
        this.syncTimer = null;
      }
      this.syncMachine?.stop();
      this.syncMachine = null;
      this.outboundMgr = null;
      this.peerDb = null;
      this.topics = null;
      this.bootstrapSettledAddrs.clear();
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
  private startHandshakeDeadline(conn: { id: string; close(): Promise<void> }): void {
    if (this.handshakeDeadlines.has(conn.id)) return;
    const deadlineMs = HANDSHAKE_DEADLINE_FACTOR * this.config.syncRequestTimeoutMs;
    const timer = setTimeout(() => {
      this.handshakeDeadlines.delete(conn.id);
      if (this.completedConnections.has(conn.id)) return;
      // The close hangs the connection up. The connection:close event the
      // close raises clears every per-connection fact, so this fires once.
      void conn.close().catch(() => { /* already gone */ });
    }, deadlineMs);
    timer.unref();
    this.handshakeDeadlines.set(conn.id, timer);
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

      // NET_INTERFACE → "A banned peer's handshake is refused unread": the
      // funnel checks the peer id the dial resolved to next, before
      // recordSeedPeer and before the handshake stream opens — closed,
      // unrecorded, and the dialled address joins the peer's ban (→
      // "A ban carries every address its peer has been tied to").
      const remote = conn.remotePeer.toString();
      if (this.peerMgr.isBanned(remote)) {
        console.log(`[net] dial to ${addr} resolved to banned peer ${remote} — closing`);
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
      // returned connection is one the peer opened, or one that has
      // carried a handshake, the funnel opens no handshake stream on it;
      // it counts connected when the peer is Active, and otherwise leaves
      // the connection to its deadline.
      const connId = conn.id;
      const connDirection = conn.direction;
      if (connDirection === 'inbound' || this.handshakenConnections.has(connId)) {
        if (source === 'seed') this.markBootstrapSettled(addr);
        return this.peerMgr.isPeerActive(remote);
      }
      // NET_INTERFACE → Handshake → "A connection carries one handshake,
      // opened by the side that dialled it": the dialler marks when it
      // opens one.
      this.handshakenConnections.add(connId);

      try {
        const result = await this.runOutboundHandshake(conn);
        if (result.ok && result.msg) {
          const dir = (conn.direction ?? 'outbound') as 'inbound' | 'outbound';
          // NET_INTERFACE → Handshake →
          // "A connection handshakes within its deadline, or is closed":
          // the dialler's handshake has completed on this connection; the
          // deadline leaves it alone.
          this.completedConnections.add(connId);
          // NET_INTERFACE → Handshake → "A peer becomes Active once": a
          // handshake that completes for a peer already Active records and
          // raises nothing.
          if (!this.peerMgr.isPeerActive(remote)) {
            this.peerMgr.setPeerState(remote, PeerState.Active);
            this.peerMgr.setPeerAddress(remote, addr);
            // The record and the metadata keep the peer's declared version,
            // not ours — it is what the boundary sweep reads
            // (NET_INTERFACE → PeerDb; → Post-Handshake Routing).
            this.peerMgr.setPeerVersion(remote, result.msg.protocolVersion);
            this.peerDb?.record({
              address: addr,
              lastSeenMs: Date.now(),
              agentName: result.msg.agentName,
              nodeName: result.msg.nodeName,
              protocolVersion: result.msg.protocolVersion,
              capabilities: result.peerCapabilities,
            });
            this.syncMachine?.onPeerActive(remote, result.peerHeight, dir);
            for (const cb of this.peerActiveHandlers) {
              try { cb(remote, dir); } catch (err) {
                console.warn(`[net] peerActive handler error: ${String(err)}`);
              }
            }
          }
          if (source === 'seed') this.markBootstrapSettled(addr);
          return true;
        }
        // NET_INTERFACE → Handshake →
        // "A handshake that does not complete ends its connection"; →
        // Outbound Manager, fill phase: an address a dialler's handshake did
        // not complete joins the redial cooldown as a failed dial does.
        await conn.close().catch(() => { /* already gone */ });
        this.outboundMgr?.recordDialResult(addr, false);
        if (source === 'seed') this.markBootstrapSettled(addr);
        return false;
      } catch (handshakeErr: any) {
        console.warn(`[net] handshake with ${addr} failed: ${handshakeErr?.message ?? handshakeErr}`);
        // NET_INTERFACE → Handshake →
        // "A handshake that does not complete ends its connection"; →
        // Outbound Manager, fill phase: an address a dialler's handshake did
        // not complete joins the redial cooldown as a failed dial does.
        await conn.close().catch(() => { /* already gone */ });
        this.outboundMgr?.recordDialResult(addr, false);
        if (source === 'seed') this.markBootstrapSettled(addr);
        return false;
      }
    } catch (err: any) {
      this.pendingDials.delete(addr);
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

  private registerHandshakeHandler(libp2p: Libp2p): void {
    const magic = this.config.magic;

    libp2p.handle('/dagsocial/handshake/1', async ({ stream, connection }) => {
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
        const data = await readStreamBounded(stream.source, MAX_HANDSHAKE_FRAME_BYTES, AbortSignal.timeout(deadlineMs));
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

        const result = validateHandshake(parseHandshakeBody(body), era);
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
        console.log(`[net] inbound handshake from ${peerId}: ok=true height=${msg.chainHeight}`);

        // NET_INTERFACE → Handshake → "A peer becomes Active once": a
        // handshake that completes for a peer already Active is answered
        // when this node is the listener, and records and raises nothing.
        if (!this.peerMgr.isPeerActive(peerId)) {
          // The metadata keeps the peer's declared version, not ours — it
          // is what the boundary sweep reads
          // (NET_INTERFACE → Post-Handshake Routing).
          this.peerMgr.setPeerVersion(peerId, msg.protocolVersion);
          // NET_INTERFACE → Handshake →
          // "A declared address is hearsay until a dial names it": the
          // listener records the dialler's declared address only when it
          // is no bogus address and its `/p2p/` component names the peer
          // id the connection proved, at lastSeenMs 0; a handshake that
          // declares no address records none.
          const declared = msg.declaredAddress;
          if (
            declared !== undefined
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
          this.syncMachine?.onPeerActive(peerId, result.peerHeight, dir);
          for (const cb of this.peerActiveHandlers) {
            try { cb(peerId, dir); } catch (err) {
              console.warn(`[net] peerActive handler error: ${String(err)}`);
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

  private registerSyncStreamHandler(libp2p: Libp2p): void {
    const magic = this.config.magic;

    libp2p.handle(SYNC_PROTOCOL, async ({ stream, connection }) => {
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
      const data = await readStreamBounded(stream.source, MAX_STREAM_BYTES, AbortSignal.timeout(this.config.syncRequestTimeoutMs));
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
      capabilities: [],
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
      (signal) => conn.newStream('/dagsocial/handshake/1', { signal }),
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

    const result = validateHandshake(parseHandshakeBody(body), this.currentEra());
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
    console.log(`[net] outbound handshake with ${peerId}: ok=true height=${result.peerHeight} caps=${result.peerCapabilities.length}`);
    return result;
  }

  // -----------------------------------------------------------------------
  // Sync helpers
  // -----------------------------------------------------------------------

  private sendToPeer(peerId: string, data: Uint8Array): Promise<void> {
    if (!this.libp2p) return Promise.resolve();
    const peer = this.libp2p.getPeers().find((p) => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] sendToPeer: peer ${peerId} not found in libp2p.getPeers() (have ${this.libp2p.getPeers().length} peers)`);
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

  /** Return the peer IDs of all currently Active peers. */
  getConnectedPeers(): string[] {
    return this.peerMgr.getPeers()
      .filter(p => this.peerMgr.isPeerActive(p.id))
      .map(p => p.id);
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
      this.peerMgr.recordPenalty('misbehavior', peerId, 100, reason);
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
          this.peerMgr.recordPenalty('misbehavior', peerId, 100,
            `post body decode failed for ${mod.id}`);
          continue;
        }
        const vr = this.validators.verifyPostBody(content, commitment);
        if (!vr.valid) {
          this.peerMgr.recordPenalty('misbehavior', peerId, 100,
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
