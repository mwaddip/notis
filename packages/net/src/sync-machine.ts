import { GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import type { NetConfig } from './types.js';
import {
  MSG_HANDSHAKE,
  MSG_SYNC_INFO,
  MSG_INV,
  MSG_MODIFIER_REQUEST,
  MSG_MODIFIER_RESPONSE,
  MODIFIER_ORDERING_BLOCK,
  BACKFILL_BATCH_IDS,
} from './types.js';
import { isHeight, MAX_INV_IDS, MAX_SERVE_BODY_BYTES } from './msg-guards.js';
import type { SyncInfo, Inv, ModifierRequest, ModifierResponse, SyncState } from './sync-types.js';
import {
  encodeSyncInfo,
  decodeSyncInfo,
  encodeInv,
  decodeInv,
  encodeModifierRequest,
  decodeModifierRequest,
  encodeModifierResponse,
  decodeModifierResponse,
} from './sync-codec.js';

// ---------------------------------------------------------------------------
// SyncStore — bridge to the node's storage layer
// ---------------------------------------------------------------------------

export interface SyncStore {
  /** Full ordering block by height, or null if not available. */
  getOrderingBlock(height: number): unknown | null;
  /** Encoded ordering block bytes for a given height, or null. */
  serializeOrderingBlock(height: number): Uint8Array | null;
  /** Block ID (hash) for a given height, or null if not available. */
  getOrderingBlockId(height: number): string | null;
  /** Height holding a block id, or null for an unknown id (NET_INTERFACE → Sync Handler Registration). */
  heightByBlockId(id: string): number | null;
  /** Current best-chain tip height — one provider call, O(1) (ARCHITECTURE → Correct and cheap are separate obligations). */
  chainHeight(): number;
  /** Anchors for sync (height + block ID pairs across the chain). */
  getAnchors(): { height: number; blockId: string }[];
  /** Persist received headers. */
  appendHeaders(headers: unknown[]): void;
  /** Persist received full blocks. */
  appendBlocks(blocks: unknown[], peerId: string): void;
  /** Mark a height as fully validated (headers + body + signatures). */
  setValidatedHeight(height: number): void;
  /** Flush pending writes to durable storage. */
  flush(): void;
}

// ---------------------------------------------------------------------------
// Event types for biased event loop
// ---------------------------------------------------------------------------

/** Control events — unbounded channel, never dropped. */
type ControlEvent =
  | { type: 'peer-active'; peerId: string; peerHeight: number; direction: 'inbound' | 'outbound' }
  | { type: 'peer-disconnect'; peerId: string }
  | { type: 'sync-info'; peerId: string; info: SyncInfo };

/** Data events — bounded channel, lossy. */
type DataEvent =
  | { type: 'inv'; peerId: string; inv: Inv }
  | { type: 'modifier-request'; peerId: string; req: ModifierRequest }
  | { type: 'modifier-response'; peerId: string; resp: ModifierResponse };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 60 seconds without real progress triggers a peer rotation. */
const STALL_TIMEOUT_MS = 60_000;
/**
 * Cap on the total number of outstanding requested modifier ids (audit M-10).
 *
 * New requests are trimmed rather than growing the set past this. One Inv
 * announces at most MAX_INV_IDS ids and responses are byte-capped, so several
 * requested batches can legitimately be in flight at once; four batches keep
 * the worst case around 100 KB of id strings. There is no per-request timer —
 * stall rotation clears the set, so a wedged budget self-heals within one
 * stall window.
 */
const MAX_OUTSTANDING_IDS = 4 * MAX_INV_IDS;
/** Send SyncInfo to sync peer every 30 seconds while active. */
const SYNCED_POLL_INTERVAL_MS = 30_000;
/** NET_INTERFACE → Serve Side, "The reply is movement-gated": floor for no-movement replies. */
const MIN_SYNCINFO_INTERVAL_MS = 15_000;
/** Maximum data events in the queue before dropping oldest. */
const MAX_DATA_QUEUE = 64;
/**
 * How often the loop runs its own timer tick.
 *
 * The tick services two deadlines — stall rotation at STALL_TIMEOUT_MS and the
 * periodic SyncInfo at SYNCED_POLL_INTERVAL_MS — so the period only has to be
 * fine enough to add no meaningful skew to the shorter of them. One second
 * bounds that skew at a second and costs one wakeup per second on an idle node.
 * This is the machine's own cadence: the node layer drives nothing.
 */
const TIMER_TICK_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// SyncMachine
// ---------------------------------------------------------------------------

/**
 * Core sync state machine with biased event loop.
 *
 * Event-driven — the node calls `onPeerActive`, `handleMessage`, and
 * `onPeerDisconnect`. The machine owns sync phase, peer selection, stall
 * detection, rotation, and its own timer cadence.
 *
 * **Biased event loop** (call `start()` to begin):
 * 1. Control events (peer connect/disconnect, sync-info) — unbounded, never dropped
 * 2. Data events (inv, modifier req/resp) — bounded, lossy above MAX_DATA_QUEUE
 * 3. Timer tick — fallback, lowest priority, every TIMER_TICK_INTERVAL_MS
 * 4. Idle — parks until an enqueue or the tick deadline; it does not re-poll
 *
 * Call `flush()` to synchronously drain all queued events (useful in tests).
 */
export class SyncMachine {
  private state: SyncState = {
    phase: 'idle',
    syncPeerId: null,
    stalledPeers: new Set(),
    downloadedHeight: 0,
    stateAppliedHeight: 0,
  };

  private lastProgressMs: number = 0;
  private lastSyncInfoMs: number = 0;

  // NET_INTERFACE → Sync State Machine, Pick: retained peer heights and direction
  private peerHeights = new Map<string, number>();
  private peerDirections = new Map<string, 'inbound' | 'outbound'>();

  // NET_INTERFACE → Serve Side, "The reply is movement-gated"
  private lastSentTip = new Map<string, number>();
  private lastReportedTip = new Map<string, number>();
  private lastSentMs = new Map<string, number>();

  /**
   * Outstanding requested modifier ids, keyed by the peer the request was sent
   * to (audit M-10). A response modifier is accepted only if its id is present
   * under its sender's key — "this sender was sent a request containing this
   * id" — so no peer can push blocks into the store via the sync path
   * unsolicited. Bounded by MAX_OUTSTANDING_IDS across all keys; cleared on
   * peer rotation and on sync-peer disconnect.
   */
  private outstanding = new Map<string, Set<string>>();

  private readonly magic: number;

  private onSyncedCallbacks: Array<() => void> = [];

  // NET_INTERFACE → Sync Handler Registration: post body seams
  private onPostBodyCallback: ((postId: string, content: string, fromPeerId: string) => boolean) | null = null;
  private missingBodiesProvider: ((limit: number) => { id: string; contentHash: Uint8Array }[]) | null = null;
  private pullPostBodiesFn: ((entries: { id: string; contentHash: Uint8Array }[], peerId: string) => Promise<{ id: string; content: string }[]>) | null = null;
  private getConnectedPeersFn: (() => string[]) | null = null;
  private backfillAskedPeers = new Set<string>();

  // -----------------------------------------------------------------------
  // Biased event queues
  // -----------------------------------------------------------------------

  /** Control events: unbounded, never dropped. */
  private controlQueue: ControlEvent[] = [];

  /** Data events: bounded, lossy. Oldest dropped when full. */
  private dataQueue: DataEvent[] = [];

  /** Whether the background event loop is running. */
  private running = false;

  /**
   * Resolver for a parked event loop, or null while the loop is not parked.
   * Set under `parkUntilWork`, called by `wake`.
   */
  private idleWakeup: (() => void) | null = null;

  /** Epoch ms at which the loop's next timer tick falls due. */
  private nextTickMs = 0;

  /**
   * @param onProtocolViolation Called when a message fails the decode boundary,
   *   so the node layer can penalize the sending peer. Defaults to a no-op for
   *   callers that only want the state machine.
   */
  constructor(
    private config: NetConfig,
    private store: SyncStore,
    private sendToPeer: (peerId: string, data: Uint8Array) => void,
    private onProtocolViolation: (peerId: string, reason: string) => void = () => {},
  ) {
    this.magic = config.magic;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the background event loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.eventLoop().catch((err) => {
      // Unreachable while every dispatch is isolated, but if the loop ever does
      // die, clear the flag so `start()` can bring it back instead of being a
      // permanent no-op.
      this.running = false;
      console.error('[sync-machine] event loop crashed:', err);
    });
  }

  /** Stop the background event loop. Idempotent. */
  stop(): void {
    this.running = false;
    // A parked loop is holding a tick timer; waking it lets the `running` check
    // retire both on this turn rather than at the next deadline.
    this.wake();
  }

  // -----------------------------------------------------------------------
  // Background event loop
  // -----------------------------------------------------------------------

  /**
   * Biased event loop.
   *
   * Priority order:
   * 1. Drain ALL control events (unbounded, never dropped)
   * 2. Process ONE data event (bounded, lossy)
   * 3. Timer tick, once TIMER_TICK_INTERVAL_MS is due (fallback, lowest priority)
   *
   * With work pending the loop yields between iterations, so one data event per
   * turn stays the fairness bound and I/O keeps its share of the thread. With
   * both queues empty it parks in `parkUntilWork` until an enqueue, `stop()`, or
   * the tick deadline — NET_INTERFACE → Biased Event Loop, clause 4.
   *
   * Every dispatch is isolated (see `dispatchControlEvent`) — a throwing
   * handler must degrade one message, never abandon the loop.
   */
  private async eventLoop(): Promise<void> {
    this.nextTickMs = Date.now();

    while (this.running) {
      // 1. Drain control events first (never dropped)
      while (this.controlQueue.length > 0) {
        const event = this.controlQueue.shift()!;
        this.dispatchControlEvent(event);
      }

      // 2. Process one data event
      const dataEvent = this.dataQueue.shift();
      if (dataEvent) {
        this.dispatchDataEvent(dataEvent);
      }

      // 3. Fallback: timer tick, on its own deadline
      if (Date.now() >= this.nextTickMs) {
        this.dispatchTimerTick();
        this.nextTickMs = Date.now() + TIMER_TICK_INTERVAL_MS;
      }

      if (this.controlQueue.length > 0 || this.dataQueue.length > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      } else {
        await this.parkUntilWork();
      }
    }
  }

  /**
   * Block until an enqueue, `stop()`, or the next tick deadline — whichever
   * lands first.
   *
   * The emptiness check above and the assignment below both run on this same
   * turn, so no enqueue can slip between them and leave the loop parked on work
   * it already has.
   */
  private parkUntilWork(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.idleWakeup = null;
        resolve();
      }, Math.max(0, this.nextTickMs - Date.now()));

      this.idleWakeup = () => {
        clearTimeout(timer);
        this.idleWakeup = null;
        resolve();
      };
    });
  }

  /**
   * Resume a parked loop. Every path that makes work available calls this —
   * `pushControl`, `pushData`, `stop()` — so a newly queued event is dispatched
   * on the next turn instead of waiting out the tick deadline.
   */
  private wake(): void {
    this.idleWakeup?.();
  }

  // -----------------------------------------------------------------------
  // Synchronous flush — drains all queued events (test support)
  // -----------------------------------------------------------------------

  /**
   * Synchronously drain all queued events.
   *
   * Processes control events first (all of them), then data events (one at a
   * time, interleaving with control drain between each). Does NOT run the
   * timer tick — use `onTimerTick()` directly if needed.
   */
  flush(): void {
    while (this.controlQueue.length > 0 || this.dataQueue.length > 0) {
      // Drain all control events
      while (this.controlQueue.length > 0) {
        const event = this.controlQueue.shift()!;
        this.dispatchControlEvent(event);
      }

      // Process one data event
      const dataEvent = this.dataQueue.shift();
      if (dataEvent) {
        this.dispatchDataEvent(dataEvent);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — isolated dispatch
  //
  // A handler that throws must degrade one message, not the subsystem. In the
  // background loop an escaping error rejects the `eventLoop` promise and
  // abandons `while (this.running)` — sync then stays dead until the process
  // restarts. `flush()` shares these helpers so both paths behave the same.
  // -----------------------------------------------------------------------

  private dispatchControlEvent(event: ControlEvent): void {
    try {
      this.handleControlEvent(event);
    } catch (err) {
      console.error(
        `[sync-machine] control event '${event.type}' from ${event.peerId} failed: ${String(err)}`,
      );
    }
  }

  private dispatchDataEvent(event: DataEvent): void {
    try {
      this.handleDataEvent(event);
    } catch (err) {
      console.error(
        `[sync-machine] data event '${event.type}' from ${event.peerId} failed: ${String(err)}`,
      );
    }
  }

  private dispatchTimerTick(): void {
    try {
      this.onTimerTick();
    } catch (err) {
      console.error(`[sync-machine] timer tick failed: ${String(err)}`);
    }
  }

  /** Read-only snapshot of current sync state. */
  getState(): Readonly<SyncState> {
    return this.state;
  }

  /**
   * Register a callback that fires when the sync machine transitions to the
   * 'synced' phase (peer tip height matches our tip height).
   */
  onSynced(cb: () => void): void {
    this.onSyncedCallbacks.push(cb);
  }

  setOnPostBody(cb: (postId: string, content: string, fromPeerId: string) => boolean): void {
    this.onPostBodyCallback = cb;
  }

  setMissingBodiesProvider(cb: (limit: number) => { id: string; contentHash: Uint8Array }[]): void {
    this.missingBodiesProvider = cb;
  }

  setPullPostBodies(cb: (entries: { id: string; contentHash: Uint8Array }[], peerId: string) => Promise<{ id: string; content: string }[]>): void {
    this.pullPostBodiesFn = cb;
  }

  setGetConnectedPeers(cb: () => string[]): void {
    this.getConnectedPeersFn = cb;
  }

  // -----------------------------------------------------------------------
  // Public events (called by the node layer)
  // -----------------------------------------------------------------------

  /**
   * Called after handshake reveals a peer's tip height.
   *
   * The height is peer-supplied and feeds `servePeer`, which walks the chain
   * one height at a time — so it is bounds-checked here, at the boundary,
   * before it can reach a loop.
   *
   * Enqueues a control event — the event loop processes it with top priority.
   */
  onPeerActive(peerId: string, peerHeight: number, direction: 'inbound' | 'outbound' = 'outbound'): void {
    if (!isHeight(peerHeight)) {
      this.rejectMessage(peerId, MSG_HANDSHAKE, `advertised height out of range: ${String(peerHeight)}`);
      return;
    }
    this.pushControl({ type: 'peer-active', peerId, peerHeight, direction });
  }

  /**
   * Dispatch an incoming framed message from a peer.
   *
   * The `body` is the positional payload (already stripped of the frame
   * envelope by the caller).
   *
   * Every body is decoded through its positional codec and domain-checked
   * before it is queued: a message that fails the boundary — malformed,
   * truncated, over-cap, nonEmpty violation — is dropped here and attributed
   * to the sender, so no unvalidated value ever reaches a handler.
   *
   * Routes to control queue (SyncInfo) or data queue (everything else).
   */
  handleMessage(peerId: string, code: number, body: Uint8Array): void {
    switch (code) {
      case MSG_SYNC_INFO: {
        const info = decodeSyncInfo(body);
        if (!info) {
          this.rejectMessage(peerId, code, 'malformed SyncInfo');
          return;
        }
        this.pushControl({ type: 'sync-info', peerId, info });
        break;
      }
      case MSG_INV: {
        const inv = decodeInv(body);
        if (!inv) {
          this.rejectMessage(peerId, code, 'malformed Inv');
          return;
        }
        this.pushData({ type: 'inv', peerId, inv });
        break;
      }
      case MSG_MODIFIER_REQUEST: {
        const req = decodeModifierRequest(body);
        if (!req) {
          this.rejectMessage(peerId, code, 'malformed ModifierRequest');
          return;
        }
        this.pushData({ type: 'modifier-request', peerId, req });
        break;
      }
      case MSG_MODIFIER_RESPONSE: {
        const resp = decodeModifierResponse(body);
        if (!resp) {
          this.rejectMessage(peerId, code, 'malformed ModifierResponse');
          return;
        }
        this.pushData({ type: 'modifier-response', peerId, resp });
        break;
      }
      // Unknown message types are silently ignored.
    }
  }

  /**
   * Drop a message that failed the decode boundary and attribute the failure to
   * the peer that sent it.
   */
  private rejectMessage(peerId: string, code: number, reason: string): void {
    console.warn(`[sync-machine] dropping code=${code} from ${peerId}: ${reason}`);
    try {
      this.onProtocolViolation(peerId, reason);
    } catch (err) {
      console.warn(`[sync-machine] onProtocolViolation handler error: ${String(err)}`);
    }
  }

  /**
   * Periodic timer tick.
   *
   * Driven by the event loop every TIMER_TICK_INTERVAL_MS as its lowest-priority
   * fallback. Public so a caller without a running loop can step it directly.
   *
   * - Checks for stall (no progress in STALL_TIMEOUT_MS).
   * - Sends periodic SyncInfo while syncing/synced.
   */
  onTimerTick(): void {
    const now = Date.now();

    if (this.state.phase === 'syncing' || this.state.phase === 'backfill') {
      if (
        now - this.lastProgressMs > STALL_TIMEOUT_MS &&
        this.state.syncPeerId
      ) {
        this.rotatePeer();
        return;
      }
    }

    if (
      this.state.phase !== 'idle' &&
      this.state.syncPeerId &&
      now - this.lastSyncInfoMs > SYNCED_POLL_INTERVAL_MS
    ) {
      this.sendSyncInfo(this.state.syncPeerId);
    }
  }

  /**
   * Called when a peer disconnects.
   *
   * Enqueues a control event — processed with top priority.
   */
  onPeerDisconnect(peerId: string): void {
    this.pushControl({ type: 'peer-disconnect', peerId });
  }

  // -----------------------------------------------------------------------
  // Internal — control event handler
  // -----------------------------------------------------------------------

  private handleControlEvent(event: ControlEvent): void {
    switch (event.type) {
      case 'peer-active':
        this.handlePeerActive(event.peerId, event.peerHeight, event.direction);
        break;
      case 'peer-disconnect':
        this.handlePeerDisconnect(event.peerId);
        break;
      case 'sync-info':
        this.handleSyncInfoMsg(event.peerId, event.info);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — data event handler
  // -----------------------------------------------------------------------

  private handleDataEvent(event: DataEvent): void {
    switch (event.type) {
      case 'inv':
        this.handleInvMsg(event.peerId, event.inv);
        break;
      case 'modifier-request':
        this.handleModifierRequestMsg(event.peerId, event.req);
        break;
      case 'modifier-response':
        this.handleModifierResponseMsg(event.peerId, event.resp);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — queue enqueue
  //
  // The two queues are reachable only through these, and both wake the loop, so
  // clause 4's "the loop parks until an enqueue" cannot be broken by a future
  // caller that pushes and forgets.
  // -----------------------------------------------------------------------

  /** Enqueue a control event. Unbounded — control events are never dropped. */
  private pushControl(event: ControlEvent): void {
    this.controlQueue.push(event);
    this.wake();
  }

  /**
   * Enqueue a data event. If the queue is at capacity, the oldest event is
   * dropped to make room (lossy behavior).
   */
  private pushData(event: DataEvent): void {
    if (this.dataQueue.length >= MAX_DATA_QUEUE) {
      // Drop the oldest event to make room
      this.dataQueue.shift();
    }
    this.dataQueue.push(event);
    this.wake();
  }

  // -----------------------------------------------------------------------
  // Control event handlers
  // -----------------------------------------------------------------------

  /**
   * Handle a peer becoming active (post-handshake).
   *
   * - If the peer is ahead and we're idle → enter syncing phase.
   * - If the peer is behind → serve them an Inv so they can catch up.
   */
  private handlePeerActive(peerId: string, peerHeight: number, direction: 'inbound' | 'outbound'): void {
    this.peerHeights.set(peerId, peerHeight);
    this.peerDirections.set(peerId, direction);
    this.state.stalledPeers.delete(peerId);
    const ourHeight = this.store.chainHeight();
    if (peerHeight < ourHeight) {
      this.servePeer(peerId, peerHeight);
    }
    this.pickSyncPeer();
  }

  /**
   * Handle a peer disconnecting.
   *
   * If the disconnected peer was our sync peer, add it to the stalled set and
   * reset phase so the node can pick a new peer.
   */
  private handlePeerDisconnect(peerId: string): void {
    this.peerHeights.delete(peerId);
    this.peerDirections.delete(peerId);
    this.lastSentTip.delete(peerId);
    this.lastReportedTip.delete(peerId);
    this.lastSentMs.delete(peerId);

    if (this.state.syncPeerId === peerId) {
      this.state.stalledPeers.add(peerId);
      this.state.syncPeerId = null;
      // NET_INTERFACE → Sync Integrity → "Response binding"
      this.outstanding.clear();
      if (this.state.phase === 'syncing' || this.state.phase === 'backfill' || this.state.phase === 'synced') {
        this.state.phase = 'idle';
      }
      this.pickSyncPeer();
    }
  }

  // -----------------------------------------------------------------------
  // Internal — message handlers (dispatched from control/data event handlers)
  // -----------------------------------------------------------------------

  /**
   * Process a SyncInfo message from a peer.
   *
   * - Peer ahead + we're idle → start syncing.
   * - Peer behind → serve them an Inv.
   * - Equal height + we were syncing → transition to synced.
   */
  private handleSyncInfoMsg(peerId: string, info: SyncInfo): void {
    const ourHeight = this.store.chainHeight();

    this.peerHeights.set(peerId, info.tipHeight);

    // NET_INTERFACE → Serve Side, rule 1: reply to the sender
    this.replySyncInfo(peerId, info.tipHeight);

    // NET_INTERFACE → Serve Side, rule 2: behind sender earns Inv after the reply
    if (info.tipHeight < ourHeight) {
      this.servePeer(peerId, info.tipHeight);
    }

    // NET_INTERFACE → Sync State Machine: equal height from sync peer → backfill
    if (info.tipHeight === ourHeight && this.state.phase === 'syncing' &&
        this.state.syncPeerId === peerId) {
      this.enterBackfill();
      return;
    }

    if (info.tipHeight > ourHeight) {
      this.state.stalledPeers.delete(peerId);
    }
    this.pickSyncPeer();
  }

  /**
   * Process an Inv (inventory) message.
   *
   * Only the current sync peer's Invs are honoured (request provenance, audit
   * M-10): a third party's Inv must neither cause requests nor grow the
   * outstanding set. Dropped without penalty — Invs from other peers are
   * legitimate gossip-adjacent noise.
   *
   * IDs we already have, and IDs already outstanding, are filtered before
   * requesting. Every id actually requested is recorded as outstanding for the
   * sync peer; the set never grows past MAX_OUTSTANDING_IDS — the request is
   * trimmed instead.
   *
   * NET_INTERFACE → Sync Handler Registration: one id is one provider call,
   * never a chain walk — k ids cost k point lookups.
   */
  private handleInvMsg(peerId: string, inv: Inv): void {
    const syncPeerId = this.state.syncPeerId;
    if (this.state.phase !== 'syncing' || !syncPeerId) return;
    if (peerId !== syncPeerId) return;
    // Unknown modifier types are dropped before any store work is done.
    if (inv.typeId !== MODIFIER_ORDERING_BLOCK) return;

    const requested = this.outstanding.get(syncPeerId);
    // A Set both deduplicates ids repeated within one Inv and preserves
    // announcement order for the trim below.
    const fresh = new Set<string>();
    for (const id of inv.ids) {
      if (this.store.heightByBlockId(id) !== null || requested?.has(id)) continue;
      fresh.add(id);
    }
    if (fresh.size === 0) return;

    const budget = MAX_OUTSTANDING_IDS - this.outstandingTotal();
    if (budget <= 0) return;
    const ids = [...fresh].slice(0, budget);

    let target = requested;
    if (!target) {
      target = new Set();
      this.outstanding.set(syncPeerId, target);
    }
    for (const id of ids) target.add(id);

    const req: ModifierRequest = { typeId: inv.typeId, ids };
    this.sendToPeer(syncPeerId, encodeModifierRequest(this.magic, req));
  }

  /** Total outstanding requested ids across all request targets. */
  private outstandingTotal(): number {
    let total = 0;
    for (const set of this.outstanding.values()) total += set.size;
    return total;
  }

  /**
   * Process a ModifierRequest from a peer — serve the requested data from
   * our local store.
   *
   * The ID list was capped on receipt. Each id is resolved through a single
   * heightByBlockId point lookup (NET_INTERFACE → Sync Handler Registration).
   * The assembled body is byte-bounded: a response is truncated at
   * MAX_SERVE_BODY_BYTES so it always fits inside the requester's stream cap.
   * The first matching block is always included, so an oversized block still
   * moves rather than wedging sync.
   */
  private handleModifierRequestMsg(peerId: string, req: ModifierRequest): void {
    if (req.typeId === MODIFIER_ORDERING_BLOCK) {
      this.serveOrderingBlocks(peerId, req);
    }
  }

  // NET_INTERFACE → ModifierRequest: ordering blocks served from the chain
  private serveOrderingBlocks(peerId: string, req: ModifierRequest): void {
    const modifiers: { id: string; data: Uint8Array }[] = [];
    let bodyBytes = 0;

    for (const id of req.ids) {
      const height = this.store.heightByBlockId(id);
      if (height === null) continue;
      const data = this.store.serializeOrderingBlock(height);
      if (!data) continue;
      if (modifiers.length > 0 && bodyBytes + data.length > MAX_SERVE_BODY_BYTES) break;
      bodyBytes += data.length;
      modifiers.push({ id, data });
    }

    if (modifiers.length > 0) {
      const resp: ModifierResponse = { typeId: req.typeId, modifiers };
      this.sendToPeer(peerId, encodeModifierResponse(this.magic, resp));
    }
  }

  /**
   * Process a ModifierResponse — apply received blocks to the store.
   *
   * Response binding (audit M-10): a modifier is accepted only if its id is
   * still outstanding for THIS sender, i.e. it answers a ModifierRequest we
   * previously sent to that same peer. Anything else — a response from a peer
   * we never asked, or ids we never requested — is dropped without penalty: a
   * response can legitimately cross a peer rotation in flight. Partial
   * responses are normal (the serve side truncates at MAX_SERVE_BODY_BYTES);
   * unanswered ids stay outstanding for a later response.
   */
  private handleModifierResponseMsg(peerId: string, resp: ModifierResponse): void {
    if (resp.typeId === MODIFIER_ORDERING_BLOCK) {
      if (resp.modifiers.length === 0) return;
      this.receiveOrderingBlocks(peerId, resp);
    }
  }

  private receiveOrderingBlocks(peerId: string, resp: ModifierResponse): void {
    const requested = this.outstanding.get(peerId);
    if (!requested || requested.size === 0) return;

    const blocks: unknown[] = [];
    for (const mod of resp.modifiers) {
      // Unsolicited and already-consumed ids are dropped; a duplicate id
      // within one response processes once (the first occurrence consumes it).
      if (!requested.has(mod.id)) continue;
      // An empty payload answers nothing — the id stays outstanding so a
      // later response can still deliver it; a peer abusing this makes no
      // progress and stalls out.
      if (mod.data.length === 0) continue;
      requested.delete(mod.id);
      blocks.push(mod.data);
    }
    if (requested.size === 0) this.outstanding.delete(peerId);
    if (blocks.length === 0) return;

    const heightBefore = this.store.chainHeight();
    this.store.appendBlocks(blocks, peerId);
    const newHeight = this.store.chainHeight();

    // Stall progress = chain height (audit M-10): the stall clock advances
    // only when applying a response strictly increased the chain — junk and
    // already-known blocks leave it untouched, so a peer feeding non-advancing
    // responses is rotated away within one stall window.
    if (newHeight > heightBefore) {
      this.lastProgressMs = Date.now();
      // NET_INTERFACE → Sync State Machine, Sync: advancing batch sends next SyncInfo
      if (this.state.syncPeerId) {
        this.sendSyncInfo(this.state.syncPeerId);
      }
    }

    this.state.downloadedHeight = Math.max(
      this.state.downloadedHeight,
      newHeight,
    );
    this.state.stateAppliedHeight = Math.max(
      this.state.stateAppliedHeight,
      newHeight,
    );
  }

  // -----------------------------------------------------------------------
  // Internal — serving
  // -----------------------------------------------------------------------

  /**
   * Serve a peer that is behind us by sending an Inv with continuation
   * from their height.
   *
   * Capped at MAX_INV_IDS to avoid oversized messages.
   *
   * Precondition: `peerHeight` has passed `isHeight`. Both callers take it from
   * a bounds-checked boundary (`onPeerActive`, `decodeSyncInfo`) — the loop
   * below reads the store once per height, so a negative value here would scan
   * ~10⁹ heights on the main thread.
   */
  private servePeer(peerId: string, peerHeight: number): void {
    const startHeight = peerHeight + 1;
    const ourHeight = this.store.chainHeight();

    if (startHeight > ourHeight) return;

    const ids: string[] = [];
    for (let h = startHeight; h <= ourHeight && ids.length < MAX_INV_IDS; h++) {
      const id = this.store.getOrderingBlockId(h);
      if (id) {
        ids.push(id);
      }
    }

    if (ids.length > 0) {
      const inv: Inv = { typeId: MODIFIER_ORDERING_BLOCK, ids };
      this.sendToPeer(peerId, encodeInv(this.magic, inv));
    }
  }

  // -----------------------------------------------------------------------
  // Backfill — NET_INTERFACE → Sync State Machine
  // -----------------------------------------------------------------------

  private enterBackfill(): void {
    this.state.phase = 'backfill';
    this.backfillAskedPeers.clear();
    this.lastProgressMs = Date.now();
    this.requestBackfillBatch();
  }

  private requestBackfillBatch(): void {
    const provider = this.missingBodiesProvider;
    if (!provider) {
      this.enterSynced();
      return;
    }
    const entries = provider(BACKFILL_BATCH_IDS);
    if (entries.length === 0) {
      this.enterSynced();
      return;
    }

    const peerId = this.state.syncPeerId;
    if (!peerId) {
      this.enterSynced();
      return;
    }

    const pull = this.pullPostBodiesFn;
    if (!pull) {
      this.enterSynced();
      return;
    }

    this.backfillAskedPeers.add(peerId);
    const wantedIds = new Set(entries.map(e => e.id));

    pull(entries, peerId).then(bodies => {
      if (this.state.phase !== 'backfill') return;
      if (this.state.syncPeerId !== peerId) return;

      for (const { id, content } of bodies) {
        if (!wantedIds.has(id)) continue;
        wantedIds.delete(id);
        const isProgress = this.onPostBodyCallback?.(id, content, peerId) ?? false;
        if (isProgress) this.lastProgressMs = Date.now();
      }

      if (wantedIds.size > 0) {
        this.backfillRotateToNextPeer();
      } else {
        this.requestBackfillBatch();
      }
    }).catch(err => {
      console.warn(`[sync-machine] backfill pull failed for ${peerId}: ${String(err)}`);
      if (this.state.phase === 'backfill') this.backfillRotateToNextPeer();
    });
  }

  private backfillRotateToNextPeer(): void {
    if (this.state.phase !== 'backfill') return;

    const connected = this.getConnectedPeersFn?.() ?? [];
    const next = connected.find(p =>
      !this.backfillAskedPeers.has(p) && !this.state.stalledPeers.has(p));

    if (!next) {
      this.enterSynced();
      return;
    }

    this.state.syncPeerId = next;
    this.backfillAskedPeers.add(next);
    this.lastProgressMs = Date.now();
    this.requestBackfillBatch();
  }

  private enterSynced(): void {
    this.state.phase = 'synced';
    this.state.stalledPeers.clear();
    for (const cb of this.onSyncedCallbacks) {
      try { cb(); } catch (err) {
        console.warn(`[sync-machine] onSynced callback error: ${String(err)}`);
      }
    }
    // NET_INTERFACE → Sync State Machine, Pick: runs at every entry into synced
    this.pickSyncPeer();
  }

  // -----------------------------------------------------------------------
  // Internal — reply and pick
  // -----------------------------------------------------------------------

  /** NET_INTERFACE → Serve Side, "The reply is movement-gated". */
  private replySyncInfo(peerId: string, theirTip: number): void {
    const ourTip = this.store.chainHeight();
    const prevReported = this.lastReportedTip.get(peerId);
    const prevSentTip = this.lastSentTip.get(peerId);

    this.lastReportedTip.set(peerId, theirTip);

    const theirMovement = prevReported === undefined || theirTip !== prevReported;
    const ourMovement = prevSentTip === undefined || ourTip !== prevSentTip;

    if (theirMovement || ourMovement) {
      this.sendSyncInfo(peerId);
      return;
    }

    const lastSent = this.lastSentMs.get(peerId) ?? 0;
    if (Date.now() - lastSent >= MIN_SYNCINFO_INTERVAL_MS) {
      this.sendSyncInfo(peerId);
    }
  }

  /**
   * NET_INTERFACE → Sync State Machine, Pick / Switch.
   *
   * Two-pass outbound preference: outbound candidates first, the full set
   * only when no outbound candidate exists.
   */
  private pickSyncPeer(): void {
    const ourHeight = this.store.chainHeight();

    if (this.state.phase === 'syncing' && this.state.syncPeerId) {
      const currentRetained = this.peerHeights.get(this.state.syncPeerId);
      if (currentRetained === undefined) return;

      const best = this.bestCandidate(ourHeight);

      // NET_INTERFACE → Sync State Machine, Switch
      if (best && best.peer !== this.state.syncPeerId &&
          best.height > ourHeight && best.height > currentRetained + 1) {
        this.outstanding.clear();
        this.lastProgressMs = Date.now();
        this.state.syncPeerId = best.peer;
        this.sendSyncInfo(best.peer);
      }
      return;
    }

    if (this.state.phase === 'backfill') return;

    const best = this.bestCandidate(ourHeight);

    if (best) {
      this.state.phase = 'syncing';
      this.state.syncPeerId = best.peer;
      this.lastProgressMs = Date.now();
      this.sendSyncInfo(best.peer);
    }
  }

  /** Outbound-preferred best candidate above `minHeight`, stalled excluded. */
  private bestCandidate(minHeight: number): { peer: string; height: number } | null {
    let outBest: { peer: string; height: number } | null = null;
    let anyBest: { peer: string; height: number } | null = null;
    for (const [peer, height] of this.peerHeights) {
      if (this.state.stalledPeers.has(peer)) continue;
      if (height <= minHeight) continue;
      const dir = this.peerDirections.get(peer);
      if (dir === 'outbound' && (!outBest || height > outBest.height)) {
        outBest = { peer, height };
      }
      if (!anyBest || height > anyBest.height) {
        anyBest = { peer, height };
      }
    }
    return outBest ?? anyBest;
  }

  // -----------------------------------------------------------------------
  // Internal — helpers
  // -----------------------------------------------------------------------

  private sendSyncInfo(peerId: string): void {
    const tipHeight = this.store.chainHeight();
    const tipBlockId = this.store.getOrderingBlockId(tipHeight) ?? GENESIS_PREV_BLOCK_HASH;

    const info: SyncInfo = {
      tipHeight,
      tipBlockId,
      anchors: this.store.getAnchors(),
    };

    this.sendToPeer(peerId, encodeSyncInfo(this.magic, info));
    const now = Date.now();
    this.lastSyncInfoMs = now;
    this.lastSentTip.set(peerId, tipHeight);
    this.lastSentMs.set(peerId, now);
  }

  /**
   * Rotate away from the current sync peer (stall detected).
   *
   * Adds the peer to the stalled set so the node won't immediately
   * reconnect to it for sync, then resets to idle so the node layer
   * picks a new peer on the next `onPeerActive` call.
   */
  private rotatePeer(): void {
    if (this.state.syncPeerId) {
      this.state.stalledPeers.add(this.state.syncPeerId);
    }
    this.state.syncPeerId = null;
    this.outstanding.clear();

    if (this.state.phase === 'backfill') {
      this.backfillRotateToNextPeer();
    } else {
      this.state.phase = 'idle';
      this.pickSyncPeer();
    }
  }
}
