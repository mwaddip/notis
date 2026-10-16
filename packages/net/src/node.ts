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
import { PROTOCOL_VERSION, protocolVersionAt, decodeOrderingBlock, encodeOrderingBlock, decodePostBody, encodePostBody } from '@dagsocial/types';
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
import { encodeServableOrderingBlock } from './serve-encode.js';
import { isBogusAddress, isLoopbackAddress } from './bogus-addr.js';
import { readStreamBounded, sinkWithDeadline } from './util.js';
import { MAX_CHAIN_RESPONSE_ITEMS, MAX_INBOUND_SYNC_STREAMS, MAX_INV_IDS, MAX_SERVE_BODY_BYTES, MAX_STREAM_BYTES } from './msg-guards.js';
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
  MSG_GET_HEADERS,
  MSG_GET_BLOCKS,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_POST_BODY,
} from './types.js';
import type { ModifierRequest, ModifierResponse } from './sync-types.js';

type OrderingBlockCallback = (block: OrderingBlock, fromPeerId: string) => void;
type TxCallback = (tx: UtxoTransaction, content: string | undefined, fromPeerId: string) => void;
type BlocksHandlerFn = (block: OrderingBlock, fromPeerId: string) => boolean;

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
 * after construction (via setBlocksHandler / setHeadersHandler).
 *
 * Exported for the same reason `servePeersBody` and `decodeHandshakePayload`
 * are: so tests drive **this** code rather than a copy of it. It is not part of
 * net's published surface — `src/index.ts` is an explicit named allowlist, not
 * `export *`, and `package.json` publishes only `"."` → `dist/index.js`, so this
 * class is reachable only by a source-relative import from inside the package.
 * `dist/index.d.ts` is asserted free of it by `sync-store.test.ts`.
 */
export class LazySyncStore implements SyncStore {
  private _getOrderingBlock: ((height: number) => unknown | null) | null = null;
  private _blocksHandler: BlocksHandlerFn | null = null;
  private _chainHeightProvider: (() => number) | null = null;
  private _blockIdProvider: ((height: number) => string | null) | null = null;
  private _heightByBlockIdProvider: ((id: string) => number | null) | null = null;

  /** Validators reach this class for one reason: `serializeOrderingBlock` serves a stored row. */
  constructor(private readonly validators: NetValidators) {}

  setOrderingBlockFn(fn: (height: number) => unknown | null): void {
    this._getOrderingBlock = fn;
  }

  setBlocksHandler(fn: BlocksHandlerFn): void {
    this._blocksHandler = fn;
  }

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

  getOrderingBlock(height: number): unknown | null {
    return this._getOrderingBlock?.(height) ?? null;
  }

  serializeOrderingBlock(height: number): Uint8Array | null {
    const block = this._getOrderingBlock?.(height);
    if (!block) return null;
    // A row we cannot encode is skipped from the ModifierResponse exactly as an
    // absent one is (`sync-machine.handleModifierRequestMsg`) — the rest of the
    // batch still serves.
    return encodeServableOrderingBlock(block, this.validators, `height ${height}`);
  }

  // NET_INTERFACE → Sync Handler Registration: the id is the store's own,
  // written at block application; net never computes an id from a header.
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

  appendBlocks(_blocks: unknown[], peerId: string): void {
    if (!this._blocksHandler) return;
    for (const raw of _blocks) {
      if (!(raw instanceof Uint8Array)) continue;

      // The `try` covers the decode and nothing else. Widening it over the
      // handler call would report every throw out of `applyOrderingBlock` —
      // node's block-apply funnel — as "failed to decode block". Malformed peer
      // bytes and a failure inside consensus apply are different events with
      // different owners; one label for both is a misattribution that sends the
      // reader to the wrong package.
      let block: OrderingBlock;
      try {
        block = decodeOrderingBlock(raw);
      } catch (err) {
        // This one really is the sender's fault, and it is per-modifier: the
        // other blocks in the batch decode independently, so skipping this
        // entry costs nothing and loses nothing.
        console.warn(`[net] appendBlocks: failed to decode block: ${String(err)}`);
        continue;
      }

      // A handler throw is deliberately NOT caught here.
      //
      // `applyOrderingBlock` is contractually total: it returns `false` for a
      // block it rejects and reserves throwing for conditions that are not
      // about this block's validity — corrupt local state, or a bug. Catching
      // those here would hide exactly the class of failure that must not be
      // hidden, and — this being inside the loop — would carry on and apply the
      // *following* blocks, which are chain-linked to the one that just failed.
      //
      // Propagating lands in `SyncMachine.dispatchDataEvent`, which logs the
      // event type and the peer and contains the failure to one message. That
      // is net's "one bad message degrades one message, not the subsystem"
      // invariant, already built there and covering both drain paths (the
      // background loop and `flush()`). Stopping the rest of the batch is then
      // a consequence of a stated design rather than of where a brace sits.
      const ok = this._blocksHandler(block, peerId);
      if (!ok) break;
    }
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
// `MAX_CHAIN_RESPONSE_ITEMS`. `endHeight` and `maxCount` are peer-chosen and
// each loop reads what it needs for one height per step, so that second bound
// is what keeps the length of the response off the peer's control panel.
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
// `ourHeight` clamps both loops to our own tip: we cannot serve what we do not
// have, so this never truncates a legitimate request, and a peer asking for
// height 1e15 costs us nothing.
//
// Both throw only if a block *we* hold has no encoding — a corrupt local store,
// not a peer's doing. The caller's `catch` answers with zero bytes, as it does
// for every other local failure.
// ---------------------------------------------------------------------------

/**
 * Frame a `Headers` (15) response: our chain walking down from
 * `startHeight`. Reads headers directly through the header provider — one
 * height is one provider call (NET_INTERFACE → Sync Handler Registration).
 */
export function serveHeadersResponse(
  magic: number,
  request: GetHeadersMsg,
  ourHeight: number,
  getHeader: (height: number) => BlockHeader | null,
): Uint8Array {
  const headers: BlockHeader[] = [];
  const maxCount = Math.min(request.maxCount, MAX_CHAIN_RESPONSE_ITEMS);
  for (let h = Math.min(request.startHeight, ourHeight); h > 0 && headers.length < maxCount; h--) {
    const header = getHeader(h);
    if (header) headers.push(header);
    else break; // gap — the chain below this height is not ours to serve
  }
  return encodeHeaders(magic, headers);
}

/**
 * Frame a `Blocks` (17) response: our chain across an inclusive height range.
 *
 * Each block is encoded once, here: the encoding is both what the response
 * carries and what the byte bound weighs, and `encodeBlocks` frames the result
 * rather than re-deriving it.
 *
 * The byte bound is `handleModifierRequestMsg`'s — accumulate, stop before
 * exceeding `MAX_SERVE_BODY_BYTES`, and **always include the first block**, so a
 * request is never answered with nothing while the server holds what was asked
 * (NET_INTERFACE → Validation →
 * "Every arm that assembles more than one stored object into a response is bounded by BYTES, not by item count alone.").
 * A truncated response costs the requester
 * one round trip; it re-asks for the remainder on the next `SyncInfo` round.
 */
export function serveBlocksResponse(
  magic: number,
  request: GetBlocksMsg,
  ourHeight: number,
  getBlock: (height: number) => OrderingBlock | null,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  let bodyBytes = 0;
  const endHeight = Math.min(request.endHeight, ourHeight);
  for (
    let h = request.startHeight;
    h <= endHeight && blocks.length < MAX_CHAIN_RESPONSE_ITEMS;
    h++
  ) {
    const block = getBlock(h);
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
 * recently-seen PeerDb entries, excluding the requester's own address. Returns
 * the framed Peers response — `{ peers: [] }` when PeerDb has nothing, so the
 * requester is answered rather than left to time out — or `null` for a
 * malformed request, which is a protocol violation (permanent ban).
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
    requesterAddr: string | null;
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
  if (deps.requesterAddr !== null) exclude.add(deps.requesterAddr);
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
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The whole-block provider for `GetBlocks` (16) and the blocks a
   * `ModifierResponse` serves. NET_INTERFACE → Sync Handler Registration:
   * setters are order-independent, so the sync protocol is registered by
   * start() whether or not a provider exists yet, and a query that arrives
   * without one is answered with zero bytes.
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
  // NET_INTERFACE → Sync Handler Registration → setHeaderStandingProvider
  private headerStandingProvider: ((hash: string, height: number) => 'held' | 'refused' | null) | null = null;
  // NET_INTERFACE → Sync Handler Registration: post body seams
  private postBodyProvider: ((postId: string) => string | null) | null = null;
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

      // Create SyncMachine with lazy store bridge
      this.syncMachine = new SyncMachine(
        this.config,
        this.syncStore,
        (peerId: string, data: Uint8Array) => this.sendToPeer(peerId, data),
        (peerId: string, reason: string) => {
          this.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, peerId, reason);
        },
      );
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
        onTx: (tx, content, fromPeerId) => { for (const cb of this.txHandlers) cb(tx, content, fromPeerId); },
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

      // Connect to bootstrap peers (awaited — must complete before caller
      // registers blocksHandler so the initial sync burst isn't dropped).
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
        if (source === 'seed') this.outboundMgr?.recordSeedSelf(addr);
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
        return false;
      }

      // NET_INTERFACE → Outbound Manager, Floor phase: the floor skips a seed
      // whose peer holds a live connection; a bare seed has no peer id of its
      // own, so remember the peer this dial resolved to.
      if (source === 'seed') {
        this.outboundMgr?.recordSeedPeer(addr, conn.remotePeer.toString());
      }
      console.log(`[net] dial succeeded: ${addr} -> peer=${conn.remotePeer.toString()}`);

      try {
        const result = await this.runOutboundHandshake(conn.remotePeer.toString());
        if (result.ok && result.msg) {
          this.peerMgr.setPeerState(conn.remotePeer.toString(), PeerState.Active);
          this.peerMgr.setPeerAddress(conn.remotePeer.toString(), addr);
          // The record and the metadata keep the peer's declared version, not
          // ours — it is what the boundary sweep reads (NET_INTERFACE → PeerDb;
          // → Post-Handshake Routing).
          this.peerMgr.setPeerVersion(conn.remotePeer.toString(), result.msg.protocolVersion);
          this.peerDb?.record({
            address: addr,
            lastSeenMs: Date.now(),
            agentName: result.msg.agentName,
            nodeName: result.msg.nodeName,
            protocolVersion: result.msg.protocolVersion,
            capabilities: result.peerCapabilities,
          });
          const dir = (conn.direction ?? 'outbound') as 'inbound' | 'outbound';
          this.syncMachine?.onPeerActive(conn.remotePeer.toString(), result.peerHeight, dir);
          for (const cb of this.peerActiveHandlers) {
            try { cb(conn.remotePeer.toString(), dir); } catch (err) {
              console.warn(`[net] peerActive handler error: ${String(err)}`);
            }
          }
          return true;
        }
        return false;
      } catch (handshakeErr: any) {
        console.warn(`[net] handshake with ${addr} failed: ${handshakeErr?.message ?? handshakeErr}`);
        return false;
      }
    } catch (err: any) {
      this.pendingDials.delete(addr);
      console.warn(`[net] dial FAILED: ${addr} — ${err?.message ?? err}`);
      this.outboundMgr?.recordDialResult(addr, false);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Handshake — inbound handler registration
  // -----------------------------------------------------------------------

  private registerHandshakeHandler(libp2p: Libp2p): void {
    const magic = this.config.magic;

    libp2p.handle('/dagsocial/handshake/1', async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
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

      // NET_INTERFACE → "A banned peer's handshake is refused unread". The gater
      // refuses the same predicate one layer down, at the transport; this check
      // covers a peer banned between its connection's upgrade and its handshake,
      // and the interval before a ban's hang-up completes.
      if (this.peerMgr.isBanned(peerId)) {
        await stream.close().catch(() => { /* the peer is already gone */ });
        return;
      }
      // NET_INTERFACE →
      // "A connection whose remote peer id is this node's own is never a peer":
      // refused the way any other handshake stream is —
      // an empty frame — with no penalty, there being nobody to penalise.
      if (peerId === libp2p.peerId.toString()) {
        console.log(`[net] inbound handshake from ${peerId}: this is our own peer id — refusing`);
        await replyEmpty();
        return;
      }
      try {
        const data = await readStreamBounded(stream.source, MAX_STREAM_BYTES, AbortSignal.timeout(deadlineMs));
        if (data === null) {
          console.warn(`[net] handshake stream from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'handshake stream exceeds byte cap',
          );
          await replyEmpty();
          return;
        }
        if (data.length === 0) {
          await replyEmpty();
          return;
        }

        const decoded = decodeHandshakePayload(magic, data);
        if (decoded.kind === 'reject') {
          // NET_INTERFACE → "Ban policy": frame-tier reject — stream closed, no penalty.
          console.warn(`[net] inbound handshake frame from ${peerId} rejected: ${decoded.code}`);
          await replyEmpty();
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
          return;
        }

        const msg = result.msg;
        console.log(`[net] inbound handshake from ${peerId}: ok=true height=${msg.chainHeight}`);

        const addr = msg.declaredAddress ?? connection.remoteAddr?.toString() ?? peerId;
        this.peerMgr.setPeerAddress(peerId, addr);
        // The record and the metadata both keep the peer's declared version, not
        // ours — it is what the boundary sweep reads (NET_INTERFACE → PeerDb;
        // → Post-Handshake Routing).
        this.peerMgr.setPeerVersion(peerId, msg.protocolVersion);
        this.peerDb?.record({
          address: addr,
          lastSeenMs: Date.now(),
          agentName: msg.agentName,
          nodeName: msg.nodeName,
          protocolVersion: msg.protocolVersion,
          capabilities: msg.capabilities,
        });

        this.peerMgr.setPeerState(peerId, PeerState.Active);
        const dir = (connection.direction ?? 'inbound') as 'inbound' | 'outbound';
        this.syncMachine?.onPeerActive(peerId, result.peerHeight, dir);
        for (const cb of this.peerActiveHandlers) {
          try { cb(peerId, dir); } catch (err) {
            console.warn(`[net] peerActive handler error: ${String(err)}`);
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
          return;
        }
        await sinkFrame(response);
      } catch (err) {
        // The empty frame is all we can say to a peer whose handshake did not
        // complete; the log is what separates that from a peer that never
        // dialled. `warn`, not `error` — an ordinary dropped connection lands
        // here too.
        console.warn(`[net] inbound handshake handler failed for ${peerId}: ${String(err)}`);
        await replyEmpty();
      }
    });
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
      const next = prev.then(() => this.serveOneSyncStream(magic, peerId, stream, connection));
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
    connection: { remoteAddr?: { toString(): string } },
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
        // Prefer the requester's declared address: an inbound connection's
        // remoteAddr carries an ephemeral source port, which would make the
        // requester-exclusion in servePeersBody a no-op.
        const response = servePeersBody(body, {
          peerDb: this.peerDb,
          peerMgr: this.peerMgr,
          peerId,
          requesterAddr: this.peerMgr.getPeerMetadata(peerId)?.address
            ?? connection.remoteAddr?.toString()
            ?? null,
          magic,
        });
        if (response) await sinkDeadline(response);
        else await replyEmpty();
        return;
      }

      if (code === MSG_GET_HEADERS) {
        await serveChainQuery(code, decodeGetHeaders(body), this.headerProvider,
          (request, ourHeight, getHeader) => serveHeadersResponse(magic, request, ourHeight, getHeader), 1);
        return;
      }

      if (code === MSG_GET_BLOCKS) {
        await serveChainQuery(code, decodeGetBlocks(body), this.headersProvider,
          (request, ourHeight, getBlock) => serveBlocksResponse(magic, request, ourHeight, getBlock), 5);
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
        // Type 101 is a block request. The sync machine serves it on a new
        // stream it opens through sendToPeer; this one carried the request
        // and ends here — NET_INTERFACE → Stream Protocols → "Every inbound stream ends".
        this.syncMachine?.handleMessage(peerId, code, body);
        return;
      }

      // Dispatch to sync machine for all other one-way messages (SyncInfo,
      // Inv, ModifierResponse). Each is a one-way: its stream carried the
      // message and ends here.
      //
      // `handleMessage` decodes the body and applies the inbound caps, then
      // enqueues — the queued work is isolated later by `dispatchDataEvent`.
      // A throw here is a bug in net's own decode/guard layer, which is
      // exactly the thing that must not be answered with a silent empty frame.
      try {
        this.syncMachine?.handleMessage(peerId, code, body);
      } catch (err) {
        console.error(`[net] sync dispatch failed for code=${code} from ${peerId}: ${String(err)}`);
        await replyEmpty();
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
      sessionMagic: Math.floor(Math.random() * 0x100000000),
    };
  }

  private async runOutboundHandshake(peerId: string): Promise<HandshakeResult> {
    if (!this.libp2p) throw new Error('Not started');
    const peer = connectedPeer(this.libp2p, peerId);
    const magic = this.config.magic;
    const ourMsg = this.buildOurHandshake();

    const data = await oneRoundTrip(
      this.libp2p,
      peer,
      '/dagsocial/handshake/1',
      buildHandshakeFrame(magic, ourMsg),
      this.config,
    );

    if (data === null) {
      console.warn(`[net] handshake response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
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
   * Register a callback that fires when the sync machine transitions to
   * the 'synced' phase (peer tip height matches our tip height).
   */
  onSyncComplete(cb: () => void): void {
    this.syncCompleteHandlers.push(cb);
  }

  /** NET_INTERFACE → API → Node Lifecycle. */
  syncPhase(): 'idle' | 'syncing' | 'synced' {
    return this.syncMachine?.getState().phase ?? 'idle';
  }

  /** NET_INTERFACE → Pull Requests. */
  peerTipHeight(peerId: string): number | null {
    return this.syncMachine?.peerHeight(peerId) ?? null;
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

  async requestHeaders(startHeight: number, maxCount: number, peerId: string): Promise<BlockHeader[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestHeaders(this.libp2p, startHeight, maxCount, peerId, this.config);
  }

  async requestBlocks(startHeight: number, endHeight: number, peerId: string): Promise<OrderingBlock[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    return requestBlocks(this.libp2p, startHeight, endHeight, peerId, this.config);
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
    try {
      const data = await oneRoundTrip(this.libp2p, peer, SYNC_PROTOCOL, request, this.config);
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
   * Register a handler for blocks received via the sync machine's pull path
   * (ModifierResponse during sync). The handler's return is the
   * batch's continue signal: `true` for a block the handler applied or already
   * held, `false` for one it rejected. `appendBlocks` stops the batch at the
   * first `false` (NET_INTERFACE → Sync Handler Registration).
   */
  setBlocksHandler(handler: BlocksHandlerFn): void {
    this.syncStore.setBlocksHandler(handler);
  }

  /**
   * Register the whole-block provider for `GetBlocks` and the blocks a
   * `ModifierResponse` serves. The provider reads at request time rather
   * than closed over at registration — so this is valid before or after
   * `start()`, and a later call replaces the provider (NET_INTERFACE → Sync
   * Handler Registration).
   */
  setHeadersHandler(getBlock: (height: number) => OrderingBlock | null): void {
    this.syncStore.setOrderingBlockFn((h) => getBlock(h));
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

  // NET_INTERFACE → Sync Handler Registration → setHeaderStandingProvider.
  // The ordering-block topic validator reads it on each header, before the
  // body is decoded (NET_INTERFACE → Stage 1 → "A header this node knows is
  // Ignored"). Held like the scheduled-target provider — the validator closed
  // over this NetNode at `subscribeTopics` time and reads the field at call
  // time, so a late set takes effect without re-registering.
  setHeaderStandingProvider(
    cb: (hash: string, height: number) => 'held' | 'refused' | null,
  ): void {
    this.headerStandingProvider = cb;
  }

  setPostBodyProvider(cb: (postId: string) => string | null): void {
    this.postBodyProvider = cb;
  }

  async requestPostBodies(
    ids: { id: string; contentHash: Uint8Array }[],
    peerId: string,
  ): Promise<{ id: string; content: string }[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    const peer = connectedPeer(this.libp2p, peerId);

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
      const raw = await oneRoundTrip(this.libp2p, peer, SYNC_PROTOCOL, encodeModifierRequest(magic, req), this.config);
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
