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
import { PROTOCOL_VERSION, decodeOrderingBlock, encodeOrderingBlock, decodePostBody } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { ReaderError } from '@dagsocial/wire';
import type {
  NetConfig, NetValidators, Peer, PeerEntryMsg,
  GetHeadersMsg, GetBlocksMsg,
} from './types.js';
import { PeerState, PenaltyKind } from './types.js';
import type { Libp2pGossip, GossipHandlers } from './gossip.js';
import { PeerManager } from './peer-mgr.js';
import { subscribeTopics, broadcastOrderingBlock, broadcastTx } from './gossip.js';
import {
  SYNC_PROTOCOL,
  requestHeaders,
  requestBlocks,
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
  decodeModifierResponse,
} from './sync-codec.js';
import { encodeServableOrderingBlock } from './serve-encode.js';
import { isBogusAddress } from './bogus-addr.js';
import { readStreamBounded } from './util.js';
import { MAX_CHAIN_RESPONSE_ITEMS, MAX_SERVE_BODY_BYTES, MAX_STREAM_BYTES } from './msg-guards.js';
import { PeerDb, type PeerStorage } from './peerdb.js';
import { SyncMachine } from './sync-machine.js';
import type { SyncStore } from './sync-machine.js';
import { OutboundManager } from './outbound-mgr.js';
import { encodeFrame, decodeFrame, KNOWN_FRAME_MAGICS } from './frame.js';
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
  MSG_MODIFIER_RESPONSE,
  MODIFIER_POST_BODY,
} from './types.js';

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
  | { kind: 'legacy'; body: Uint8Array }
  | { kind: 'reject'; code: 'wrong-magic' | 'unsupported-version' | 'checksum-mismatch' };

/**
 * Decode a handshake payload per the frame error-code policy
 * (WIRE_INTERFACE → ReaderError codes):
 *
 * - a valid frame yields its body;
 * - a frame bearing a recognized foreign network magic is a wrong-network
 *   peer — closed, never retried as raw CBOR;
 * - a frame with our magic but a version above ours (a newer peer) or a
 *   failed checksum (corrupt or forged body) is rejected — falling through
 *   to the raw-CBOR parser would feed it frame bytes and misclassify the
 *   peer as adversarial (`malformed` → permanent ban);
 * - anything else — a truncated frame, or a payload whose leading bytes are
 *   no frame magic at all — falls back to the legacy unframed raw-CBOR
 *   handshake and is validated on its own merits.
 *
 * Shared by the inbound handler and the outbound response path so the two
 * cannot drift apart.
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
          break; // not a frame at all — try the legacy path
        }
        case 'unsupported-version':
        case 'checksum-mismatch':
          return { kind: 'reject', code: err.code };
        default:
          break; // truncated etc. — try the legacy path
      }
    }
    return { kind: 'legacy', body: data };
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

  /** Validators reach this class for one reason: `serializeOrderingBlock` serves a stored row. */
  constructor(private readonly validators: NetValidators) {}

  setOrderingBlockFn(fn: (height: number) => unknown | null): void {
    this._getOrderingBlock = fn;
  }

  setBlocksHandler(fn: BlocksHandlerFn): void {
    this._blocksHandler = fn;
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

  getOrderingBlockHeader(height: number): unknown | null {
    const block = this._getOrderingBlock?.(height);
    if (block && typeof block === 'object' && 'header' in block) {
      return (block as { header: unknown }).header;
    }
    return null;
  }

  getOrderingBlockId(height: number): string | null {
    const block = this._getOrderingBlock?.(height);
    if (block && typeof block === 'object' && 'header' in block) {
      const header = (block as { header: unknown }).header;
      if (header && typeof header === 'object') {
        // No `try`/`catch` here, and none is needed: `blockHash` enforces its
        // own precondition and returns `null` on exactly the headers
        // `verifyHeaderFieldDomains` rejects (VALIDATION_INTERFACE → blockHash).
        // So this method absorbs an *absence* and gains no knowledge of what a
        // well-formed header is.
        //
        // `null` is the right answer for a header that is out of domain but
        // still encodable (`createdAt: NaN`, a negative `height`, a non-hex
        // `prevBlockHash`): under a positional encoder those headers share one
        // `blockHash` by sentinel collision, so serving an id for them would be
        // advertising a colliding anchor.
        return blockHash(header as Parameters<typeof blockHash>[0]);
      }
    }
    return null;
  }

  chainHeight(): number {
    if (!this._getOrderingBlock) return 0;
    // Walk up from 1 until we find a gap
    let h = 1;
    while (this._getOrderingBlock(h)) h++;
    return h - 1;
  }

  getAnchors(): { height: number; blockId: string }[] {
    if (!this._getOrderingBlock) return [];
    const h = this.chainHeight();
    if (h < 1) return [];
    const anchors: { height: number; blockId: string }[] = [];
    const seen = new Set<number>();
    for (const candidate of [h, h - 16, h - 128, h - 512]) {
      if (candidate < 1) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const id = this.getOrderingBlockId(candidate);
      if (id) anchors.push({ height: candidate, blockId: id });
    }
    return anchors;
  }

  appendHeaders(_headers: unknown[]): void {
    // Mutations are handled by the node layer directly via applyOrderingBlock.
    // The sync machine may call this; it's a no-op here because the node layer
    // owns persistence.
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

  setValidatedHeight(_height: number): void {
    // Node layer tracks validation state.
  }

  flush(): void {
    // Node layer flushes via its own DB lifecycle.
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
// each loop reads the store once per height into an in-memory array, so that
// second bound is what keeps the *length* of that array off the peer's control
// panel.
//
// A count bounds a length and says nothing about a weight, so the blocks loop
// carries a second, independent bound: it accumulates encoded bytes and stops
// before exceeding `MAX_SERVE_BODY_BYTES` (NET_INTERFACE → Validation (and
// untrusted-input safety)). Blocks are bounded individually by
// `MAX_BLOCK_BODY_BYTES`, and 400 of those is far past what any requester will
// read off a stream.
//
// The headers loop is bounded by count alone, because a header cannot be heavy:
// four fixed-width fields and five VLQs put its ceiling at 157 bytes, so 400 of
// them reach ~61 KiB — 1.5% of `MAX_SERVE_BODY_BYTES`.
//
// `ourHeight` clamps both loops to our own tip: we cannot serve what we do not
// have, so this never truncates a legitimate request, and a peer asking for
// height 1e15 costs us nothing.
//
// Both throw only if a block *we* hold has no encoding — a corrupt local store,
// not a peer's doing. The caller's `catch` answers with zero bytes, as it does
// for every other local failure.
// ---------------------------------------------------------------------------

/** Frame a `Headers` (15) response: our chain walking down from `startHeight`. */
export function serveHeadersResponse(
  magic: number,
  request: GetHeadersMsg,
  ourHeight: number,
  getBlock: (height: number) => OrderingBlock | null,
): Uint8Array {
  const headers: BlockHeader[] = [];
  const maxCount = Math.min(request.maxCount, MAX_CHAIN_RESPONSE_ITEMS);
  for (let h = Math.min(request.startHeight, ourHeight); h > 0 && headers.length < maxCount; h--) {
    const block = getBlock(h);
    if (block) headers.push(block.header);
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
 * block too large to share a response with anything still moves on its own
 * instead of wedging sync behind it. A truncated response costs the requester
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
export const OUTBOUND_TICK_INTERVAL_MS = 30_000;

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
 * Intake one Peers response body into PeerDb, stamping every recorded entry
 * with `nowMs` — the sender's opinion of when a peer was last seen is hearsay
 * and never travels on the wire.
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
    nowMs: number;
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
      lastSeenMs: deps.nowMs,
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
  private orderingBlockHandlers: OrderingBlockCallback[] = [];
  private txHandlers: TxCallback[] = [];
  private started = false;

  // New sync infrastructure
  private peerDb: PeerDb | null = null;
  private peerStorage: PeerStorage | null;
  private syncMachine: SyncMachine | null = null;
  private outboundMgr: OutboundManager | null = null;
  private syncStore: LazySyncStore;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeHandlerRegistered = false;
  private syncHandlerRegistered = false;
  /**
   * The block provider for `GetHeaders` (14) and `GetBlocks` (16), read at
   * request time rather than closed over at registration. NET_INTERFACE → Sync
   * Handler Registration: setters are order-independent, so the sync protocol is
   * registered by start() whether or not a provider exists yet, and a query that
   * arrives without one is answered with zero bytes.
   */
  private headersProvider: ((height: number) => OrderingBlock | null) | null = null;
  private syncCompleteHandlers: Array<() => void> = [];
  private peerActiveHandlers: Array<(peerId: string, direction: 'inbound' | 'outbound') => void> = [];
  private peerDisconnectedHandlers: Array<(peerId: string, reason: string) => void> = [];
  private peerPenalisedHandlers: Array<(peerId: string, kind: string, detail: string | null) => void> = [];
  // NET_INTERFACE → Sync Handler Registration: post body seams
  private postBodyProvider: ((postId: string) => string | null) | null = null;
  private postBodyCommitmentProvider: ((postId: string) => Uint8Array | null) | null = null;
  private postBodyHandlers: Array<(postId: string, content: string, fromPeerId: string) => boolean> = [];
  private pendingBootstrapDials: Set<string> = new Set();
  private lastGetPeersSentMs: Map<string, number> = new Map();

  constructor(config: NetConfig, validators: NetValidators, peerStorage?: PeerStorage) {
    this.config = config;
    this.validators = validators;
    this.syncStore = new LazySyncStore(validators);
    // Omitted in tests/embedded use — PeerDb then runs ephemeral (contract:
    // "Persistence seam"), which is the valid non-production configuration.
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
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;

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
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
        }),
        identify: identify(),
        ping: ping(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
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

    // Wire post body seams — delegates read at call time, order-independent
    this.syncMachine.setPostBodyProvider((id) => this.postBodyProvider?.(id) ?? null);
    this.syncMachine.setPostBodyCommitmentProvider((id) => this.postBodyCommitmentProvider?.(id) ?? null);
    this.syncMachine.setPostBodyVerifier((content, hash) =>
      this.validators.verifyPostBody(content, hash));
    this.syncMachine.setOnPostBody((postId, content, fromPeerId) => {
      for (const cb of this.postBodyHandlers) {
        try {
          if (cb(postId, content, fromPeerId)) return true;
        } catch (err) {
          console.warn(`[net] onPostBody handler error: ${String(err)}`);
        }
      }
      return false;
    });
    this.syncMachine.setOnMisbehavior((peerId, reason) => {
      this.peerMgr.recordPenalty('misbehavior', peerId, 100, reason);
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
      this.karmaMembers,
    );

    // Log listen addresses
    console.log(`[net] listening on: ${listenAddrs.map(a => a.toString()).join(', ')}`);

    // Connect to bootstrap peers (awaited — must complete before caller
    // registers blocksHandler so the initial sync burst isn't dropped).
    for (const addr of this.config.bootstrapPeers) {
      await this.dialBootstrapPeer(addr);
    }

    // Start periodic timer: outbound manager + peer discovery. The sync machine
    // keeps its own tick cadence inside its event loop.
    this.syncTimer = setInterval(() => {
      if (this.libp2p && this.outboundMgr) {
        // Both phases count outbound connections only — inbound connections
        // filling our slots must never suppress our own dialing (eclipse
        // setup). planTick also feeds the connected addresses into the fill
        // phase's exclude set.
        const plan = this.outboundMgr.planTick(this.libp2p.getConnections());

        // Floor phase: re-dial bootstrap peers while outbound < minPeers.
        if (plan.dialBootstrap) {
          for (const addr of this.config.bootstrapPeers) {
            this.dialBootstrapPeer(addr);
          }
        }

        // Fill phase: dial one PeerDb candidate per tick
        const candidate = plan.candidate;
        if (candidate) {
          console.log(`[net] outbound manager dialing: ${candidate}`);
          this.libp2p.dial(multiaddr(candidate)).then((conn) => {
            console.log(`[net] outbound dial succeeded: ${candidate} -> peer=${conn.remotePeer.toString()}`);
            this.outboundMgr?.recordDialResult(candidate, true);
          }).catch((err: any) => {
            console.warn(`[net] outbound dial FAILED: ${candidate} — ${err?.message ?? err}`);
            this.outboundMgr?.recordDialResult(candidate, false);
          });
        }
      }

      // Peer discovery cadence: GetPeers to each Active peer every
      // GET_PEERS_INTERVAL_MS, riding this tick rather than a second timer.
      if (this.libp2p) {
        for (const peerId of duePeerExchange(this.peerMgr, this.lastGetPeersSentMs, Date.now())) {
          this.requestPeers(peerId);
        }
      }
    }, OUTBOUND_TICK_INTERVAL_MS);

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.libp2p) return;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingBootstrapDials.clear();
    this.lastGetPeersSentMs.clear();
    await this.libp2p.stop();
    this.libp2p = null;
    this.peerDb = null;
    this.syncMachine?.stop();
    this.syncMachine = null;
    this.outboundMgr = null;
    this.started = false;
  }

  /**
   * Dial a bootstrap peer (or any multiaddr), run the outbound handshake,
   * and notify the sync machine + peer-active callbacks on success.
   *
   * Returns a Promise that resolves to `true` when the handshake succeeds,
   * `false` otherwise.  Safe to call from the periodic timer without
   * awaiting — concurrent dials to the same address are deduplicated via
   * `pendingBootstrapDials`.
   */
  private async dialBootstrapPeer(addr: string): Promise<boolean> {
    if (!this.libp2p || !this.outboundMgr) return false;
    if (this.pendingBootstrapDials.has(addr)) return false;
    this.pendingBootstrapDials.add(addr);

    console.log(`[net] dialing bootstrap peer: ${addr}`);
    try {
      const conn = await this.libp2p.dial(multiaddr(addr));
      this.pendingBootstrapDials.delete(addr);
      console.log(`[net] bootstrap dial succeeded: ${addr} -> peer=${conn.remotePeer.toString()}`);

      try {
        const result = await this.runOutboundHandshake(conn.remotePeer.toString());
        if (result.ok) {
          this.peerMgr.setPeerState(conn.remotePeer.toString(), PeerState.Active);
          this.peerMgr.setPeerAddress(conn.remotePeer.toString(), addr);
          this.peerDb?.record({
            address: addr,
            lastSeenMs: Date.now(),
            agentName: 'bootstrap',
            nodeName: '',
            protocolVersion: PROTOCOL_VERSION,
            capabilities: result.peerCapabilities,
          });
          this.syncMachine?.onPeerActive(conn.remotePeer.toString(), result.peerHeight);
          const dir = (conn.direction ?? 'outbound') as 'inbound' | 'outbound';
          for (const cb of this.peerActiveHandlers) {
            try { cb(conn.remotePeer.toString(), dir); } catch (err) {
              console.warn(`[net] peerActive handler error: ${String(err)}`);
            }
          }
          return true;
        }
        return false;
      } catch (handshakeErr: any) {
        console.warn(`[net] handshake with bootstrap peer ${addr} failed: ${handshakeErr?.message ?? handshakeErr}`);
        return false;
      }
    } catch (err: any) {
      this.pendingBootstrapDials.delete(addr);
      console.warn(`[net] bootstrap dial FAILED: ${addr} — ${err?.message ?? err}`);
      this.outboundMgr?.recordDialResult(addr, false);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Handshake — inbound handler registration
  // -----------------------------------------------------------------------

  private registerHandshakeHandler(libp2p: Libp2p): void {
    if (this.handshakeHandlerRegistered) return;
    const magic = this.config.magic;

    libp2p.handle('/dagsocial/handshake/1', async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();
      try {
        const data = await readStreamBounded(stream.source);
        if (data === null) {
          console.warn(`[net] handshake stream from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'handshake stream exceeds byte cap',
          );
          await stream.sink([new Uint8Array(0)]);
          return;
        }
        if (data.length === 0) {
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        const decoded = decodeHandshakePayload(magic, data);
        if (decoded.kind === 'reject') {
          // Wrong network, newer frame version, or corrupt body — close the
          // stream without the raw-CBOR retry. No penalty: none of these are
          // evidence of misbehavior (see decodeHandshakePayload).
          console.warn(`[net] inbound handshake frame from ${peerId} rejected: ${decoded.code}`);
          await stream.sink([new Uint8Array(0)]);
          return;
        }
        const body = decoded.body;

        const result = validateHandshake(parseHandshakeBody(body), [PROTOCOL_VERSION]);
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
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        const msg = result.msg;
        console.log(`[net] inbound handshake from ${peerId}: ok=true height=${msg.chainHeight}`);

        const addr = msg.declaredAddress ?? connection.remoteAddr?.toString() ?? peerId;
        this.peerMgr.setPeerAddress(peerId, addr);
        this.peerDb?.record({
          address: addr,
          lastSeenMs: Date.now(),
          agentName: msg.agentName,
          nodeName: msg.nodeName,
          protocolVersion: msg.protocolVersion,
          capabilities: msg.capabilities,
        });

        this.peerMgr.setPeerState(peerId, PeerState.Active);
        this.syncMachine?.onPeerActive(peerId, result.peerHeight);
        const dir = (connection.direction ?? 'inbound') as 'inbound' | 'outbound';
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
          await stream.sink([new Uint8Array(0)]);
          return;
        }
        await stream.sink([response]);
      } catch (err) {
        // The empty frame is all we can say to a peer whose handshake did not
        // complete; the log is what separates that from a peer that never
        // dialled. `warn`, not `error` — an ordinary dropped connection lands
        // here too.
        console.warn(`[net] inbound handshake handler failed for ${peerId}: ${String(err)}`);
        try { await stream.sink([new Uint8Array(0)]); } catch { /* the peer is already gone */ }
      }
    });

    this.handshakeHandlerRegistered = true;
  }

  // -----------------------------------------------------------------------
  // Sync stream handler — framed protocol
  // -----------------------------------------------------------------------

  private registerSyncStreamHandler(libp2p: Libp2p): void {
    if (this.syncHandlerRegistered) return;
    const magic = this.config.magic;

    libp2p.handle(SYNC_PROTOCOL, async ({ stream, connection }) => {
      const peerId = connection.remotePeer.toString();

      /**
       * "I have no answer for you" — the protocol courtesy that stops the peer
       * hanging until its own timeout. Used only on paths that failed to
       * produce a real response; the success paths sink their own frames.
       *
       * It answers the peer and nothing more: every path that reaches it after a
       * *failure* logs first, so the empty frame is never the whole record of
       * one. The silent callers are the paths where declining is routine policy
       * — the not-Active drop just below, and a query for which we hold no
       * provider or handler at all.
       */
      const replyEmpty = async (): Promise<void> => {
        try {
          await stream.sink([new Uint8Array(0)]);
        } catch {
          // The peer is already gone. Nothing left to say, and no way to say it.
        }
      };

      // Drop messages from peers that are not in Active state
      if (!this.peerMgr.isPeerActive(peerId)) {
        await replyEmpty();
        return;
      }

      /**
       * The decline paths `MSG_GET_HEADERS` and `MSG_GET_BLOCKS` share.
       *
       * Every one of them answers — see the arms below for why silence is the
       * failure mode to design against on this stream. The two arms differ
       * only in which decoder produced `request` and which serve loop turns it
       * into a frame, so both live at the call site and everything around them
       * lives here.
       */
      const serveChainQuery = async <T>(
        code: number,
        request: T | null,
        serve: (
          request: T,
          ourHeight: number,
          getBlock: (height: number) => OrderingBlock | null,
        ) => Uint8Array,
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

        const getBlock = this.headersProvider;
        if (!getBlock) {
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
          response = serve(request, this.syncStore.chainHeight(), getBlock);
        } catch (err) {
          console.error(
            `[net] cannot serve chain query (code ${code}) for ${peerId}: ${String(err)}`,
          );
          await replyEmpty();
          return;
        }
        await stream.sink([response]);
      };

      try {
        const data = await readStreamBounded(stream.source);
        if (data === null) {
          console.warn(`[net] sync stream from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
          this.peerMgr.recordPenaltyKind(
            PenaltyKind.ProtocolViolation,
            peerId,
            'sync stream exceeds byte cap',
          );
          await stream.sink([new Uint8Array(0)]);
          return;
        }
        if (data.length === 0) {
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        // Try framed decode first
        let code: number;
        let body: Uint8Array;
        try {
          const framed = decodeFrame(magic, data);
          code = framed.code;
          body = framed.body;
        } catch {
          // An undecodable request on this protocol. Answering zero bytes is
          // the arm's "I cannot answer" signal (NET_INTERFACE → Pull Requests)
          // and attributes nothing to the peer.
          await stream.sink([new Uint8Array(0)]);
          return;
        }

        // Handle peer discovery requests (MSG_GET_PEERS). No registered
        // handler callback — PeerDb is internal to net. Served whatever our
        // sync phase is; an empty PeerDb still answers { peers: [] }.
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
          if (response) await stream.sink([response]);
          return;
        }

        // Handle fork resolution's two chain queries (MSG_GET_HEADERS,
        // MSG_GET_BLOCKS). Both read `this.headersProvider` at request time, so
        // setter order does not matter (NET_INTERFACE → Sync Handler
        // Registration).
        //
        // ⚠ **Every path in both arms answers, including the ones that
        // decline.** An unrecognized code falls through to
        // `syncMachine.handleMessage`, whose switch answers nothing, and an
        // unanswered stream blocks the caller for its whole timeout — 5× for
        // blocks. Zero bytes ("I cannot answer") stays distinct from a framed
        // `vlqU(0)` ("I consulted my chain and have nothing"): a node holding no
        // provider has no chain to consult, so it cannot honestly send the
        // second.
        //
        // `serveChainQuery` owns the decline paths both arms share; each arm
        // owns its own decoder, because the code pair is the discriminator.
        if (code === MSG_GET_HEADERS) {
          await serveChainQuery(code, decodeGetHeaders(body), (request, ourHeight, getBlock) =>
            serveHeadersResponse(magic, request, ourHeight, getBlock));
          return;
        }

        if (code === MSG_GET_BLOCKS) {
          await serveChainQuery(code, decodeGetBlocks(body), (request, ourHeight, getBlock) =>
            serveBlocksResponse(magic, request, ourHeight, getBlock));
          return;
        }

        // Dispatch to sync machine for all other message types
        console.log(`[net] sync handler: received code=${code} body_len=${body.length} from ${peerId}`);
        // Its own span, for the same reason. `handleMessage` decodes the body
        // and applies the inbound caps, then enqueues — the queued work is
        // isolated later by `dispatchDataEvent`. So a throw *here* is a bug in
        // net's own decode/guard layer, which is exactly the thing that must
        // not be answered with a silent empty frame.
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
      }
    });

    this.syncHandlerRegistered = true;
  }

  // -----------------------------------------------------------------------
  // Handshake — outbound
  // -----------------------------------------------------------------------

  private buildOurHandshake(): import('./handshake.js').HandshakeMsg {
    const listenAddrs = this.libp2p?.getMultiaddrs() ?? [];
    return {
      agentName: 'dagsocial',
      protocolVersion: PROTOCOL_VERSION,
      nodeName: this.peerId().slice(0, 12),
      chainHeight: this.syncStore.chainHeight(),
      declaredAddress: listenAddrs[0]?.toString(),
      capabilities: [],
      sessionMagic: Math.floor(Math.random() * 0x100000000),
    };
  }

  private async runOutboundHandshake(peerId: string): Promise<HandshakeResult> {
    if (!this.libp2p) throw new Error('Not started');
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) throw new Error(`Peer ${peerId} not connected`);

    const magic = this.config.magic;

    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, '/dagsocial/handshake/1', {
        signal: AbortSignal.timeout(this.config.syncRequestTimeoutMs),
      });

      // Send our handshake
      const ourMsg = this.buildOurHandshake();
      await stream.sink([buildHandshakeFrame(magic, ourMsg)]);

      // Read their response
      const data = await readStreamBounded(stream.source);
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
        // Same policy as the inbound handler: close without the raw-CBOR
        // retry and without a penalty. Pre-taxonomy this fell through to the
        // CBOR parser, which misclassified the peer as malformed (permanent
        // ban) for what is a network mismatch or a corrupt link.
        console.warn(`[net] outbound handshake with ${peerId}: frame rejected (${decoded.code})`);
        return {
          ok: false,
          error: `handshake frame rejected: ${decoded.code}`,
          peerHeight: 0,
          peerCapabilities: [],
        };
      }
      const body = decoded.body;

      const result = validateHandshake(parseHandshakeBody(body), [PROTOCOL_VERSION]);
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
    } finally {
      // A rejecting close must not replace what this function already
      // determined — the caller logs the handshake's own outcome, not ours.
      if (stream) await stream.close().catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Sync helpers
  // -----------------------------------------------------------------------

  private sendToPeer(peerId: string, data: Uint8Array): void {
    if (!this.libp2p) return;
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] sendToPeer: peer ${peerId} not found in libp2p.getPeers() (have ${this.libp2p.getPeers().length} peers)`);
      return;
    }

    this.libp2p.dialProtocol(peer, SYNC_PROTOCOL).then(async (stream) => {
      try {
        await stream.sink([data]);
      } catch {
        // ignore write errors
      } finally {
        await stream.close().catch(() => {});
      }
    }).catch(() => {
      // ignore dial errors
    });
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

  // -----------------------------------------------------------------------
  // Outbound broadcast
  // -----------------------------------------------------------------------

  async broadcastOrderingBlock(block: OrderingBlock): Promise<void> {
    if (!this.libp2p) return;
    await broadcastOrderingBlock(asGossip(this.libp2p), block);
  }

  async broadcastTx(tx: UtxoTransaction, content?: string): Promise<void> {
    if (!this.libp2p) return;
    await broadcastTx(asGossip(this.libp2p), tx, content);
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
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) {
      console.warn(`[net] requestPeers: peer ${peerId} not found`);
      return;
    }
    const magic = this.config.magic;
    const request = encodeGetPeers(magic);
    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, SYNC_PROTOCOL);
      await stream.sink([request]);
      const data = await readStreamBounded(stream.source);
      if (data === null) {
        console.warn(`[net] requestPeers: response from ${peerId} exceeded ${MAX_STREAM_BYTES} bytes`);
        return;
      }
      if (data.length === 0) {
        return;
      }
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
        nowMs: Date.now(),
      });
      if (usable !== null && usable > 0) {
        console.log(`[net] Peers from ${peerId}: recorded ${usable} address(es)`);
      }
    } catch (err) {
      console.warn(`[net] requestPeers failed for peer ${peerId}: ${String(err)}`);
    } finally {
      if (stream) await stream.close().catch(() => {});
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
   * Register the block provider for header-first sync. Wires the sync machine's
   * store adapter and the `GetHeaders` / `GetBlocks` serve arms, both of which
   * read the provider when they need it — so this is valid before or after
   * `start()`, and a later call replaces the provider (NET_INTERFACE → Sync
   * Handler Registration).
   */
  setHeadersHandler(getBlock: (height: number) => OrderingBlock | null): void {
    this.syncStore.setOrderingBlockFn((h) => getBlock(h));
    this.headersProvider = getBlock;
  }

  // -----------------------------------------------------------------------
  // Post body seams — NET_INTERFACE → Sync Handler Registration
  // -----------------------------------------------------------------------

  setPostBodyProvider(cb: (postId: string) => string | null): void {
    this.postBodyProvider = cb;
  }

  setMissingBodiesProvider(cb: (limit: number) => { id: string; contentHash: Uint8Array }[]): void {
    this.syncMachine?.setMissingBodiesProvider(cb);
  }

  setPostBodyCommitmentProvider(cb: (postId: string) => Uint8Array | null): void {
    this.postBodyCommitmentProvider = cb;
  }

  onPostBody(cb: (postId: string, content: string, fromPeerId: string) => boolean): void {
    this.postBodyHandlers.push(cb);
  }

  async requestPostBodies(
    ids: { id: string; contentHash: Uint8Array }[],
    peerId: string,
  ): Promise<{ id: string; content: string }[]> {
    if (!this.libp2p) throw new Error('NetNode not started');
    const peer = this.libp2p.getPeers().find(p => p.toString() === peerId);
    if (!peer) throw new Error(`Peer ${peerId} not connected`);

    const commitments = new Map<string, Uint8Array>();
    for (const entry of ids) commitments.set(entry.id, entry.contentHash);

    const req: import('./sync-types.js').ModifierRequest = {
      typeId: MODIFIER_POST_BODY,
      ids: ids.map(e => e.id),
    };
    const magic = this.config.magic;
    let stream: import('@libp2p/interface').Stream | undefined;
    try {
      stream = await this.libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
        signal: AbortSignal.timeout(this.config.syncRequestTimeoutMs),
      });
      await stream.sink([encodeModifierRequest(magic, req)]);
      const raw = await readStreamBounded(stream.source);
      if (raw === null || raw.length === 0) return [];
      const frame = decodeFrame(magic, raw);
      if (frame.code !== MSG_MODIFIER_RESPONSE) return [];
      const resp = decodeModifierResponse(frame.body);
      if (!resp || resp.typeId !== MODIFIER_POST_BODY) return [];

      const results: { id: string; content: string }[] = [];
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
      return results;
    } finally {
      if (stream) await stream.close();
    }
  }

  // Expose for node to register storage-backed handler
  get libp2pNode(): Libp2p | null {
    return this.libp2p;
  }
}
