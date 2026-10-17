import type { NetConfig } from './types.js';
import { MSG_HANDSHAKE, MSG_SYNC_INFO } from './types.js';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import {
  isHeight,
  MAX_CHAIN_RESPONSE_ITEMS,
  MAX_STALL_MARKS,
  STALL_MARK_EXPIRY_MS,
  SYNC_INFO_MIN_INTERVAL_MS,
} from './msg-guards.js';
import type { SyncInfo, SyncState, PipelineIntake, ChainView } from './sync-types.js';
import { encodeSyncInfo, decodeSyncInfo } from './sync-codec.js';
import { holdsPageShape } from './sync.js';

// ---------------------------------------------------------------------------
// SyncStore — the node's storage seams the scheduler reads (NET_INTERFACE →
// Sync Handler Registration). `chainHeight` backs the handshake and the
// `SyncInfo` this node sends; `getOrderingBlockId` the claim's hash;
// `heightByBlockId` the serve arms.
// ---------------------------------------------------------------------------

export interface SyncStore {
  getOrderingBlockId(height: number): string | null;
  heightByBlockId(id: string): number | null;
  chainHeight(): number;
}

// ---------------------------------------------------------------------------
// Control events — NET_INTERFACE → Biased Event Loop clause 1
// ---------------------------------------------------------------------------

type ControlEvent =
  | { type: 'peer-active'; peerId: string; peerHeight: number; direction: 'inbound' | 'outbound' }
  | { type: 'peer-disconnect'; peerId: string }
  | { type: 'sync-info'; peerId: string; info: SyncInfo }
  | { type: 'need-headers'; peerId: string }
  | { type: 'chain-moved' }
  | { type: 'bootstrap-settled' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** NET_INTERFACE → Sync State Machine → "A claim is the peer's applied tip,
 * height and hash" — the poll cadence of this node's own `SyncInfo`. */
const SYNCED_POLL_INTERVAL_MS = 30_000;

/** NET_INTERFACE → Serve Side → "The reply is movement-gated, so replying
 * to replies terminates" — floor for no-movement replies. */
const MIN_SYNCINFO_INTERVAL_MS = 15_000;

/** How often the loop runs its own timer tick. One second bounds the skew
 * on the 30-second poll and the stall-mark expiry both to within a tick,
 * at one wakeup per second on an idle node. */
const TIMER_TICK_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Scheduler state
// ---------------------------------------------------------------------------

/** NET_INTERFACE → Sync State Machine → "A claim is the peer's applied tip,
 * height and hash." Retained per Active peer from the latest `SyncInfo`
 * acted on; dropped at disconnect or ban. The handshake's `chainHeight`
 * alone is no claim. */
interface Claim {
  tipHeight: number;
  tipHash: string;
}

// ---------------------------------------------------------------------------
// SyncMachine
// ---------------------------------------------------------------------------

/**
 * NET_INTERFACE → Sync State Machine — "The scheduler holds peers' claims,
 * this node's open requests and its stall marks — nothing about the chain."
 *
 * The node registers a pipeline intake (`setPipeline`), a chain view
 * (`setChainView`), a request shim (`setRequestHeaders` / `setRequestBlocks`),
 * a connected-peers reader (`setConnectedPeers`), a penalty call
 * (`setPenalize`) and a bootstrap-settled reader
 * (`setBootstrapAllSettled`), and drives the scheduler through its public
 * events — `onPeerActive`, `handleMessage(MSG_SYNC_INFO)`,
 * `onPeerDisconnect`, `needHeaders`, `chainMoved` and `bootstrapSettled`.
 */
export class SyncMachine {
  // ---- State the scheduler holds (NET_INTERFACE → Sync State Machine) ----
  private state: SyncState = {
    phase: 'idle',
  };

  /** Claims by peer id — the retained claim from the latest `SyncInfo` the
   * scheduler acted on. Dropped at disconnect. */
  private claims = new Map<string, Claim>();

  /** The connection's direction, written at peer-active and dropped at
   * disconnect. The gate counts outbound peers; the direction travels
   * with the peer id, not with the claim. */
  private directions = new Map<string, 'inbound' | 'outbound'>();

  /** NET_INTERFACE → Stall Detection — "A mark clears only when this node
   * enters `synced`, or `STALL_MARK_EXPIRY_MS` after it was set." Keyed by
   * peer id, insertion-ordered; oldest dropped past `MAX_STALL_MARKS`. */
  private stallMarks = new Map<string, number>();

  /** NET_INTERFACE → Sync State Machine → "One header request per peer,
   * every peer at once." The set names the peers whose header-sync worker
   * is in flight; a second trigger for one of them opens no second run. */
  private openHeaderRuns = new Set<string>();

  /** NET_INTERFACE → Sync State Machine → "Blocks are asked by id, from a
   * peer that has them." — one block request open per peer; a second
   * trigger adds no second run. */
  private openBlockRuns = new Set<string>();

  /** The peer each in-flight block id is currently asked of. An id already
   * asked of one peer stays with it until the request ends (answer,
   * omission, deadline or mark). */
  private inFlightBlockId = new Map<string, string>();

  /** NET_INTERFACE → Sync State Machine → "An id a peer's answer omits is
   * not asked of that peer again until its claim changes." Cleared when
   * the peer's claimed hash moves; purged each round to ids
   * `wantedBlocks()` still names, so the set stays bounded by the
   * pipeline's wanted window. */
  private omittedByPeer = new Map<string, Set<string>>();

  /** Phase 'idle' holds until the first claim settles (NET_INTERFACE →
   * Sync State Machine → "The phases"). */
  private anyClaimEverSettled = false;

  // ---- Movement gate (NET_INTERFACE → Serve Side) ----
  private lastSentTip = new Map<string, number>();
  private lastReportedTip = new Map<string, number>();
  private lastSentMs = new Map<string, number>();

  // ---- Interval gate (NET_INTERFACE → Serve Side → "A peer's SyncInfo is
  // acted on at most once per SYNC_INFO_MIN_INTERVAL_MS") ----
  private lastActedOnSyncInfoMs = new Map<string, number>();
  private pendingSyncInfo = new Map<string, SyncInfo>();

  /** NET_INTERFACE → Sync State Machine → "A claim is the peer's applied
   * tip, height and hash" — poll stamp per peer for the 30 s send. */
  private lastPolledMs = new Map<string, number>();

  private readonly magic: number;
  private onSyncedCallbacks: Array<() => void> = [];

  // ---- Injected deps (NET_INTERFACE → Sync Handler Registration) ----
  private pipeline: PipelineIntake | null = null;
  private chainView: ChainView | null = null;
  private requestHeadersFn: ((locator: string[], peerId: string) => Promise<BlockHeader[]>) | null = null;
  private requestBlocksFn: ((ids: string[], peerId: string) => Promise<OrderingBlock[]>) | null = null;
  private connectedPeersFn: (() => Set<string>) | null = null;
  private penalizeFn: ((peerId: string, kind: 'misbehavior' | 'transient', reason: string) => void) | null = null;
  /** NET_INTERFACE → Sync State Machine → "The gate bounds how far blocks
   * apply." The scheduler reads bootstrap-settled through this function;
   * `null` while the node has not supplied one, which is treated as
   * settled (a test harness with no bootstrap concept, equivalent to no
   * configured bootstrap addresses). */
  private bootstrapAllSettledFn: (() => boolean) | null = null;

  // ---- Event loop ----
  private controlQueue: ControlEvent[] = [];
  private running = false;
  private idleWakeup: (() => void) | null = null;
  private nextTickMs = 0;

  constructor(
    config: NetConfig,
    private store: SyncStore,
    private sendToPeer: (peerId: string, data: Uint8Array) => unknown,
    private onProtocolViolation: (peerId: string, reason: string) => void = () => {},
  ) {
    this.magic = config.magic;
  }

  // -------- Setters: NET_INTERFACE → Sync Handler Registration --------

  setPipeline(intake: PipelineIntake): void {
    this.pipeline = intake;
  }

  setChainView(view: ChainView): void {
    this.chainView = view;
    // A view that answers may have settled claims or wanted blocks
    // already — recompute at once.
    this.recomputePhase();
    this.evaluateGate();
    this.kickBlockPump();
  }

  setRequestHeaders(fn: (locator: string[], peerId: string) => Promise<BlockHeader[]>): void {
    this.requestHeadersFn = fn;
  }

  setRequestBlocks(fn: (ids: string[], peerId: string) => Promise<OrderingBlock[]>): void {
    this.requestBlocksFn = fn;
  }

  setConnectedPeers(fn: () => Set<string>): void {
    this.connectedPeersFn = fn;
  }

  setPenalize(fn: (peerId: string, kind: 'misbehavior' | 'transient', reason: string) => void): void {
    this.penalizeFn = fn;
  }

  setBootstrapAllSettled(fn: () => boolean): void {
    this.bootstrapAllSettledFn = fn;
    // A newly supplied function may answer true right away — evaluate once.
    this.evaluateGate();
  }

  // -------- Lifecycle --------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.eventLoop().catch((err) => {
      this.running = false;
      console.error('[sync-machine] event loop crashed:', err);
    });
  }

  stop(): void {
    this.running = false;
    this.wake();
  }

  // -------- Event loop (NET_INTERFACE → Biased Event Loop) --------

  private async eventLoop(): Promise<void> {
    this.nextTickMs = Date.now();
    while (this.running) {
      while (this.controlQueue.length > 0) {
        const event = this.controlQueue.shift()!;
        this.dispatchControlEvent(event);
      }
      if (Date.now() >= this.nextTickMs) {
        this.dispatchTimerTick();
        this.nextTickMs = Date.now() + TIMER_TICK_INTERVAL_MS;
      }
      if (this.controlQueue.length > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      } else {
        await this.parkUntilWork();
      }
    }
  }

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

  private wake(): void {
    this.idleWakeup?.();
  }

  /** Synchronous drain for tests. */
  flush(): void {
    while (this.controlQueue.length > 0) {
      const event = this.controlQueue.shift()!;
      this.dispatchControlEvent(event);
    }
  }

  private dispatchControlEvent(event: ControlEvent): void {
    try {
      this.handleControlEvent(event);
    } catch (err) {
      const peer = 'peerId' in event ? (event as { peerId: string }).peerId : '-';
      console.error(`[sync-machine] control event '${event.type}' from ${peer} failed: ${String(err)}`);
    }
  }

  private dispatchTimerTick(): void {
    try {
      this.onTimerTick();
    } catch (err) {
      console.error(`[sync-machine] timer tick failed: ${String(err)}`);
    }
  }

  // -------- Public introspection --------

  getState(): Readonly<SyncState> {
    return this.state;
  }

  onSynced(cb: () => void): void {
    this.onSyncedCallbacks.push(cb);
  }

  /** Test introspection — the stall marks map. */
  getMarksForTest(): Map<string, number> {
    return this.stallMarks;
  }

  /** Test introspection — the retained claims map. */
  getClaimsForTest(): Map<string, Claim> {
    return this.claims;
  }

  /** Test introspection — the direction recorded at peer-active. */
  getDirectionForTest(peerId: string): 'inbound' | 'outbound' | null {
    return this.directions.get(peerId) ?? null;
  }

  /** Test introspection — the pending `SyncInfo` held by its peer id. */
  getPendingSyncInfoForTest(): Map<string, SyncInfo> {
    return this.pendingSyncInfo;
  }

  /** Test introspection — the peers whose header run has been added
   * but not yet removed. */
  getOpenHeaderRunsForTest(): Set<string> {
    return this.openHeaderRuns;
  }

  /** Test introspection — the peers whose block run has been added
   * but not yet removed. */
  getOpenBlockRunsForTest(): Set<string> {
    return this.openBlockRuns;
  }

  /** Test introspection — the per-peer set of omitted ids. */
  getOmittedByPeerForTest(): Map<string, Set<string>> {
    return this.omittedByPeer;
  }

  /** Test hook — mark a peer; the run loop reads the mark at its next
   * iteration. */
  markPeerForTest(peerId: string): void {
    this.markPeer(peerId);
  }

  // -------- Public events --------

  onPeerActive(peerId: string, peerHeight: number, direction: 'inbound' | 'outbound' = 'outbound'): void {
    if (!isHeight(peerHeight)) {
      this.rejectMessage(peerId, MSG_HANDSHAKE, `advertised height out of range: ${String(peerHeight)}`);
      return;
    }
    this.pushControl({ type: 'peer-active', peerId, peerHeight, direction });
  }

  onPeerDisconnect(peerId: string): void {
    this.pushControl({ type: 'peer-disconnect', peerId });
  }

  handleMessage(peerId: string, code: number, body: Uint8Array): void {
    // NET_INTERFACE → Sync Handler Registration. The scheduler decodes
    // only `SyncInfo`; every other code is dropped silently as a code
    // no arm serves.
    if (code !== MSG_SYNC_INFO) return;
    const info = decodeSyncInfo(body);
    if (!info) {
      this.rejectMessage(peerId, code, 'malformed SyncInfo');
      return;
    }
    this.pushControl({ type: 'sync-info', peerId, info });
  }

  /** NET_INTERFACE → Pipeline events. */
  needHeaders(peerId: string): void {
    this.pushControl({ type: 'need-headers', peerId });
  }

  /** NET_INTERFACE → Pipeline events. */
  chainMoved(): void {
    this.pushControl({ type: 'chain-moved' });
  }

  /** NET_INTERFACE → Sync State Machine → "The gate bounds how far blocks
   * apply." The node reports a bootstrap dial settling; the scheduler
   * re-evaluates the gate on the next loop pass. */
  bootstrapSettled(): void {
    this.pushControl({ type: 'bootstrap-settled' });
  }

  private rejectMessage(peerId: string, code: number, reason: string): void {
    console.warn(`[sync-machine] dropping code=${code} from ${peerId}: ${reason}`);
    try {
      this.onProtocolViolation(peerId, reason);
    } catch (err) {
      console.warn(`[sync-machine] onProtocolViolation handler error: ${String(err)}`);
    }
  }

  // -------- Timer tick --------

  onTimerTick(): void {
    const now = Date.now();

    // Drain pending `SyncInfo` reports past their interval.
    for (const [peerId, info] of this.pendingSyncInfo) {
      const last = this.lastActedOnSyncInfoMs.get(peerId) ?? 0;
      if (now - last < SYNC_INFO_MIN_INTERVAL_MS) continue;
      this.pendingSyncInfo.delete(peerId);
      this.actOnSyncInfo(peerId, info, now);
    }

    // Expire stall marks older than STALL_MARK_EXPIRY_MS.
    let markExpired = false;
    for (const [peerId, setAt] of this.stallMarks) {
      if (now - setAt > STALL_MARK_EXPIRY_MS) {
        this.stallMarks.delete(peerId);
        markExpired = true;
      }
    }

    // NET_INTERFACE → Sync State Machine → "A claim is the peer's applied
    // tip, height and hash" — send `SyncInfo` to every Active peer every
    // `SYNCED_POLL_INTERVAL_MS`.
    const connected = this.connectedPeersFn?.() ?? new Set<string>();
    for (const peerId of connected) {
      const last = this.lastPolledMs.get(peerId) ?? 0;
      if (now - last < SYNCED_POLL_INTERVAL_MS) continue;
      this.lastPolledMs.set(peerId, now);
      this.sendSyncInfo(peerId);
    }

    this.recomputePhase();
    // NET_INTERFACE → Sync State Machine → "The gate bounds how far blocks
    // apply." The tick carries the vacuous case and the mark-expiry case.
    this.evaluateGate();
    if (markExpired) this.kickBlockPump();
  }

  // -------- Control event dispatch --------

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
      case 'need-headers':
        this.handleNeedHeaders(event.peerId);
        break;
      case 'chain-moved':
        this.handleChainMoved();
        break;
      case 'bootstrap-settled':
        this.evaluateGate();
        break;
    }
  }

  private pushControl(event: ControlEvent): void {
    this.controlQueue.push(event);
    this.wake();
  }

  // -------- Peer lifecycle --------

  private handlePeerActive(peerId: string, _peerHeight: number, direction: 'inbound' | 'outbound'): void {
    // NET_INTERFACE → Sync State Machine → "An event for a peer no longer
    // connected is ignored." The connected set is the funnel.
    if (!this.isConnected(peerId)) return;

    // Record the connection's direction — the gate counts outbound peers.
    this.directions.set(peerId, direction);

    // Send our own `SyncInfo` to this new Active peer.
    this.sendSyncInfo(peerId);
    this.lastPolledMs.set(peerId, Date.now());

    this.recomputePhase();
    this.evaluateGate();
  }

  private handlePeerDisconnect(peerId: string): void {
    this.claims.delete(peerId);
    this.directions.delete(peerId);
    this.openHeaderRuns.delete(peerId);
    this.openBlockRuns.delete(peerId);
    this.omittedByPeer.delete(peerId);
    // Free the peer's in-flight block ids for reassignment.
    for (const [id, pid] of this.inFlightBlockId) {
      if (pid === peerId) this.inFlightBlockId.delete(id);
    }
    this.lastSentTip.delete(peerId);
    this.lastReportedTip.delete(peerId);
    this.lastSentMs.delete(peerId);
    this.lastActedOnSyncInfoMs.delete(peerId);
    this.pendingSyncInfo.delete(peerId);
    this.lastPolledMs.delete(peerId);
    this.recomputePhase();
    this.evaluateGate();
    this.kickBlockPump();
  }

  // -------- SyncInfo intake --------

  private handleSyncInfoMsg(peerId: string, info: SyncInfo): void {
    if (!this.isConnected(peerId)) return;

    const now = Date.now();
    const lastActedOnMs = this.lastActedOnSyncInfoMs.get(peerId);
    if (lastActedOnMs !== undefined && now - lastActedOnMs < SYNC_INFO_MIN_INTERVAL_MS) {
      // NET_INTERFACE → Serve Side → "A peer's `SyncInfo` is acted on at
      // most once per `SYNC_INFO_MIN_INTERVAL_MS`" — held, later report
      // replaces it, tick acts on it.
      this.pendingSyncInfo.set(peerId, info);
      return;
    }
    this.actOnSyncInfo(peerId, info, now);
  }

  private actOnSyncInfo(peerId: string, info: SyncInfo, nowMs: number): void {
    this.lastActedOnSyncInfoMs.set(peerId, nowMs);

    // NET_INTERFACE → Sync State Machine → "An id a peer's answer omits
    // is not asked of that peer again until its claim changes." A moved
    // hash clears what the peer owed us from under its old chain.
    const prev = this.claims.get(peerId);
    if (!prev || prev.tipHash !== info.tipHash) {
      this.omittedByPeer.delete(peerId);
    }

    const claim: Claim = {
      tipHeight: info.tipHeight,
      tipHash: info.tipHash,
    };
    this.claims.set(peerId, claim);

    // NET_INTERFACE → Serve Side — reply to the sender, movement-gated.
    this.replySyncInfo(peerId, info.tipHeight);

    // NET_INTERFACE → Sync State Machine → "A claim the tree lacks is a
    // header request." A claim the view knows is settled on arrival.
    // A marked peer's run returns at `runHeaders`' mark check; the
    // one-run-per-peer rule is held by `startHeaderRun`.
    if (this.chainView?.knowsTip(peerId, info.tipHash)) {
      this.anyClaimEverSettled = true;
    } else {
      void this.startHeaderRun(peerId);
    }

    this.recomputePhase();
    // A new claim may permit new block requests.
    this.kickBlockPump();
  }

  // -------- Pipeline events --------

  private handleNeedHeaders(peerId: string): void {
    // NET_INTERFACE → Pull Requests → "A gossiped block's relayer is asked
    // for the headers the tree lacks": with no claim, the run reads the
    // claim as it arrives at each iteration; a run that stays no-claim
    // ends on the first short page. The connected-set, mark and
    // one-run-per-peer gates live on `startHeaderRun`.
    void this.startHeaderRun(peerId);
  }

  private handleChainMoved(): void {
    if (!this.chainView) return;
    for (const [peerId, claim] of this.claims) {
      if (!this.chainView.knowsTip(peerId, claim.tipHash)) {
        void this.startHeaderRun(peerId);
      }
    }
    this.kickBlockPump();
    this.recomputePhase();
  }

  // -------- Header runs (NET_INTERFACE → Sync State Machine → "One header
  // request per peer, every peer at once") --------

  private async startHeaderRun(peerId: string): Promise<void> {
    if (!this.requestHeadersFn || !this.pipeline || !this.chainView) return;
    // The launch opens no run for a peer whose run would return on the
    // loop's first check — otherwise the add/delete pair flickers the
    // phase (synced → syncing → synced), firing `onSynced` again and
    // clearing every stall mark.
    if (!this.isConnected(peerId)) return;
    if (this.stallMarks.has(peerId)) return;
    if (this.openHeaderRuns.has(peerId)) return;
    this.openHeaderRuns.add(peerId);
    try {
      await this.runHeaders(peerId);
    } catch (err) {
      // A throw from `locatorFor` or `knowsTip` reaches here; one bad
      // run degrades that one run, not the subsystem.
      console.warn(`[sync-machine] header run for ${peerId} threw: ${String(err)}`);
    } finally {
      this.openHeaderRuns.delete(peerId);
      this.recomputePhase();
      this.evaluateGate();
      // A header run ending may have added wanted blocks the pump can serve.
      this.kickBlockPump();
    }
  }

  /**
   * A header run reads the peer's current claim at every iteration — hash
   * and height together — so a claim replaced mid-run drives the next
   * page's `deliverHeaders` and refute test. A run opened with no claim
   * hands `''` to `deliverHeaders` (NET_INTERFACE → Sync Handler
   * Registration) and ends on the first short page.
   */
  private async runHeaders(peerId: string): Promise<void> {
    const view = this.chainView!;
    const pipeline = this.pipeline!;
    const requestHeaders = this.requestHeadersFn!;

    for (;;) {
      if (!this.isConnected(peerId)) return;
      if (this.stallMarks.has(peerId)) return;

      const locator = view.locatorFor(peerId);
      // Capture the claim as the request goes out. The refute test
      // reads this one: an honest peer whose tip rose during the
      // delivery is refuted only if the page fails against the claim
      // the page was asked toward.
      const claimAtRequest = this.claims.get(peerId);
      const claimHashAtRequest = claimAtRequest?.tipHash ?? '';
      let page: BlockHeader[];
      try {
        page = await requestHeaders(locator, peerId);
      } catch {
        // NET_INTERFACE → Sync State Machine → "A request passes its
        // deadline" — mark, no penalty.
        this.markPeer(peerId);
        return;
      }

      if (!this.isConnected(peerId)) return;

      // NET_INTERFACE → `GetHeaders` / `GetBlocks` responses → "A `Headers`
      // page has one shape, and a requester holds a page to it". Fail →
      // misbehavior, no mark.
      if (!holdsPageShape(page, locator)) {
        this.penalizeFn?.(peerId, 'misbehavior', 'headers page violates its shape');
        return;
      }

      // Deliver toward the current claim — the pipeline wants the
      // latest hash a settlement reads against.
      const claim = this.claims.get(peerId);
      const claimHash = claim?.tipHash ?? '';
      let accepted: boolean;
      try {
        accepted = await pipeline.deliverHeaders(peerId, claimHash, page);
      } catch (err) {
        console.warn(`[sync-machine] deliverHeaders(${peerId}) threw: ${String(err)}`);
        return;
      }
      if (!accepted) return;

      if (!this.isConnected(peerId)) return;

      const claimAfter = this.claims.get(peerId);
      const claimHashAfter = claimAfter?.tipHash ?? '';

      if (claimHashAfter && view.knowsTip(peerId, claimHashAfter)) {
        this.anyClaimEverSettled = true;
        return;
      }

      // The claim the request was asked under is what the refute test
      // reads. A claim replaced between request and delivery leaves the
      // next page to continue against the new one.
      if (claimHashAfter !== claimHashAtRequest) {
        continue;
      }

      const reachedClaimedHeight = claimAtRequest !== undefined && page.length > 0
        && page[page.length - 1]!.height >= claimAtRequest.tipHeight;
      if (page.length < MAX_CHAIN_RESPONSE_ITEMS || reachedClaimedHeight) {
        if (claimHashAtRequest) {
          this.penalizeFn?.(peerId, 'transient', 'headers page refutes the claim');
          this.markPeer(peerId);
        } else {
          // No claim to refute — a short page settles the run.
          this.anyClaimEverSettled = true;
        }
        return;
      }
      // Full page under the claimed height — ask again, loop.
    }
  }

  // -------- Block runs (NET_INTERFACE → Sync State Machine →
  // "Blocks are asked by id, from a peer that has them.") --------

  /**
   * Ask every eligible peer for the ids its claim covers and the omission
   * memory and in-flight set have not already placed. One block request
   * per peer; nothing is asked when `wantedBlocks()` is empty.
   */
  private kickBlockPump(): void {
    if (!this.chainView) return;
    if (!this.requestBlocksFn) return;
    const wanted = this.chainView.wantedBlocks();
    if (wanted.length === 0) {
      // Purge omission memory — ids no longer wanted drop out so the
      // per-peer set stays bounded by the pipeline's wanted window.
      this.omittedByPeer.clear();
      this.inFlightBlockId.clear();
      return;
    }
    const wantedIds = new Set<string>();
    for (const w of wanted) wantedIds.add(w.id);
    for (const [peerId, set] of this.omittedByPeer) {
      for (const id of set) if (!wantedIds.has(id)) set.delete(id);
      if (set.size === 0) this.omittedByPeer.delete(peerId);
    }
    for (const id of [...this.inFlightBlockId.keys()]) {
      if (!wantedIds.has(id)) this.inFlightBlockId.delete(id);
    }

    const sorted = [...wanted].sort((a, b) => a.height - b.height);
    for (const [peerId, claim] of this.claims) {
      // NET_INTERFACE → Sync State Machine — the peer's claim must be
      // one the view knows (settled). An unsettled claim opens no
      // block request.
      if (!this.chainView.knowsTip(peerId, claim.tipHash)) continue;
      const omitted = this.omittedByPeer.get(peerId) ?? new Set<string>();
      const batch: string[] = [];
      for (const w of sorted) {
        if (batch.length >= MAX_CHAIN_RESPONSE_ITEMS) break;
        if (w.height > claim.tipHeight) continue;
        if (omitted.has(w.id)) continue;
        if (this.inFlightBlockId.has(w.id)) continue;
        batch.push(w.id);
      }
      if (batch.length === 0) continue;
      void this.startBlockRun(peerId, batch);
    }
  }

  private async startBlockRun(peerId: string, ids: string[]): Promise<void> {
    if (!this.requestBlocksFn || !this.pipeline) return;
    // The launch opens no run for a peer whose first check would return —
    // the parallel to `startHeaderRun`'s discipline, so a block run that
    // would not ask never flickers the phase and `synced`-entry never
    // clears a stall mark it shouldn't.
    if (!this.isConnected(peerId)) return;
    if (this.stallMarks.has(peerId)) return;
    if (this.openBlockRuns.has(peerId)) return;
    if (ids.length === 0) return;
    this.openBlockRuns.add(peerId);
    for (const id of ids) this.inFlightBlockId.set(id, peerId);
    // The open run makes the phase `syncing`
    // (NET_INTERFACE → Sync State Machine → "The phases.").
    this.recomputePhase();
    try {
      let blocks: OrderingBlock[];
      try {
        blocks = await this.requestBlocksFn(ids, peerId);
      } catch {
        // NET_INTERFACE → Stall Detection — the deadline marks the peer.
        this.markPeer(peerId);
        return;
      }
      if (!this.isConnected(peerId)) return;
      try {
        await this.pipeline.deliverBlocks(peerId, blocks);
      } catch (err) {
        console.warn(`[sync-machine] deliverBlocks(${peerId}) threw: ${String(err)}`);
        return;
      }
      // NET_INTERFACE → Sync Integrity. An id still in `wantedBlocks()`
      // the peer owed us but we did not take is one the peer does not
      // get asked again until its claim changes — the pipeline's
      // refusal of a bound mismatch also lands there.
      const stillWanted = new Set<string>();
      if (this.chainView) {
        for (const w of this.chainView.wantedBlocks()) stillWanted.add(w.id);
      }
      let omitted = this.omittedByPeer.get(peerId);
      for (const id of ids) {
        if (stillWanted.has(id)) {
          if (!omitted) {
            omitted = new Set<string>();
            this.omittedByPeer.set(peerId, omitted);
          }
          omitted.add(id);
        }
      }
    } finally {
      for (const id of ids) {
        if (this.inFlightBlockId.get(id) === peerId) this.inFlightBlockId.delete(id);
      }
      this.openBlockRuns.delete(peerId);
      this.recomputePhase();
      this.kickBlockPump();
    }
  }

  // -------- Stall marks (NET_INTERFACE → Stall Detection) --------

  private markPeer(peerId: string): void {
    const now = Date.now();
    if (this.stallMarks.has(peerId)) this.stallMarks.delete(peerId);
    this.stallMarks.set(peerId, now);
    while (this.stallMarks.size > MAX_STALL_MARKS) {
      const oldest = this.stallMarks.keys().next().value;
      if (oldest === undefined) break;
      this.stallMarks.delete(oldest);
    }
    // A marked outbound peer's open header run no longer holds the gate.
    this.evaluateGate();
    // Its in-flight block ids free up for another covering peer.
    for (const [id, pid] of this.inFlightBlockId) {
      if (pid === peerId) this.inFlightBlockId.delete(id);
    }
    this.kickBlockPump();
  }

  // -------- The gate (NET_INTERFACE → Sync State Machine →
  // "The gate bounds how far blocks apply.") --------

  private evaluateGate(): void {
    if (!this.chainView) return;
    // The gate counts unmarked outbound peers with an open header run.
    for (const peerId of this.openHeaderRuns) {
      if (this.stallMarks.has(peerId)) continue;
      if (this.directions.get(peerId) !== 'outbound') continue;
      return;
    }
    // Every configured bootstrap address's dial has settled; the node's
    // reader is the single source of that answer.
    if (this.bootstrapAllSettledFn && !this.bootstrapAllSettledFn()) return;
    try {
      this.chainView.gateHeld();
    } catch (err) {
      console.warn(`[sync-machine] gateHeld threw: ${String(err)}`);
    }
  }

  // -------- Phases --------

  private recomputePhase(): void {
    const next = this.computePhase();
    const was = this.state.phase;
    this.state.phase = next;
    if (next === 'synced' && was !== 'synced') {
      // NET_INTERFACE → Sync State Machine → "The phases" — entering
      // `synced` clears every stall mark.
      this.stallMarks.clear();
      for (const cb of this.onSyncedCallbacks) {
        try { cb(); } catch (err) {
          console.warn(`[sync-machine] onSynced callback error: ${String(err)}`);
        }
      }
    }
  }

  private computePhase(): 'idle' | 'syncing' | 'synced' {
    if (this.openHeaderRuns.size > 0) return 'syncing';
    if (this.openBlockRuns.size > 0) return 'syncing';
    if (this.chainView && !this.chainView.fullyApplied()) return 'syncing';
    if (!this.anyClaimEverSettled) return 'idle';

    const connected = this.connectedPeersFn?.() ?? new Set<string>();
    for (const peerId of connected) {
      if (this.stallMarks.has(peerId)) continue;
      const claim = this.claims.get(peerId);
      if (!claim) return 'syncing';
      if (!this.chainView?.knowsTip(peerId, claim.tipHash)) return 'syncing';
    }
    return 'synced';
  }

  // -------- Sending `SyncInfo` --------

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

  private sendSyncInfo(peerId: string): void {
    const tipHeight = this.store.chainHeight();
    const tipHash = this.store.getOrderingBlockId(tipHeight) ?? GENESIS_PREV_BLOCK_HASH;
    this.sendToPeer(peerId, encodeSyncInfo(this.magic, { tipHeight, tipHash }));
    const now = Date.now();
    this.lastSentTip.set(peerId, tipHeight);
    this.lastSentMs.set(peerId, now);
  }

  // -------- Helpers --------

  private isConnected(peerId: string): boolean {
    // Without a `connectedPeersFn` the scheduler accepts every event — the
    // node sets the function at `start()` time; a scheduler constructed
    // without it runs in test harness mode (NET_INTERFACE → Sync Handler
    // Registration — setters are order-independent).
    const fn = this.connectedPeersFn;
    if (!fn) return true;
    return fn().has(peerId);
  }
}
