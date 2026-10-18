import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { encodeOrderingBlock, GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import {
  blockHash,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import {
  getBestHashAt,
  getBestTip,
  getCurrentHeight,
  getHeaderRow,
  getOrderingBlockHash,
  getPlaceholdersAt,
  getStagedBlock,
  hasStagedBlock,
  insertRefusedHeader,
  removeHeaderSubtree,
  stageBlock,
  unstageBlock,
} from '../store/index.js';
import { onBlockApplied, registerPlaceholder } from './backfill.js';
import {
  admitHeader,
  admitPage,
  onPeerDisconnected as pipelineOnPeerDisconnected,
  pruneHeaderTree,
  rechooseAfterApply,
  rechooseBestChain,
  type AdmitVerdict,
  type PageOutcome,
  type PageVerdict,
  type PipelineContext,
} from './header-pipeline.js';
import * as blockApply from './block-apply.js';
import type { ApplyVerdict } from './block-apply.js';
import { reorg as realReorg } from './fork-resolution.js';
import { InconsistentHeaderTreeError, ReorgAbortedError, ReorgBlockRejectedError, UnreachableForkPointError } from './corrupt-state.js';
import { config } from '../config.js';

/**
 * The intake calls the apply funnel and `reorg` through two module-level
 * references. Tests redirect them through `setIntakeSeamsForTests` to
 * override the behaviour without re-wiring the module graph. `applyFn` reads
 * through the `blockApply` namespace so a module cycle (block-apply →
 * block-creator → intake → block-apply) resolves on live binding instead of
 * capturing a `undefined` at load time.
 */
let applyOverride: ((block: OrderingBlock) => ApplyVerdict) | null = null;
let reorgFn: (forkHeight: number, hashes: readonly string[]) => void = realReorg;

function applyFn(block: OrderingBlock): ApplyVerdict {
  return (applyOverride ?? blockApply.applyOrderingBlockVerdict)(block);
}

/** Tests only. */
export function setIntakeSeamsForTests(seams: {
  apply?: (block: OrderingBlock) => ApplyVerdict;
  reorg?: (forkHeight: number, hashes: readonly string[]) => void;
}): void {
  if (seams.apply !== undefined) applyOverride = seams.apply;
  if (seams.reorg !== undefined) reorgFn = seams.reorg;
}

/** Tests only. */
export function clearIntakeSeamsForTests(): void {
  applyOverride = null;
  reorgFn = realReorg;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The pipeline
 * names the blocks it wants": the bound on how far an extension's wanted set
 * reaches above the applied tip. Literal (CONSTANTS → node).
 */
export const BLOCK_FETCH_WINDOW = 400;

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The intake owns
 * what it runs": every penalty, every `best chain moved` event, and every
 * `needHeaders(peer)` ask leaves the intake through callbacks the wiring
 * injects.
 */
export interface IntakeCallbacks {
  penalize(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void;
  chainMoved(): void;
  needHeaders(peerId: string): void;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". `S` is the window's hold; `pendingBlocks` keeps one gossiped
 * block per peer whose header's parent the tree does not hold.
 */
let callbacks: IntakeCallbacks | null = null;
let context: PipelineContext | null = null;
let S = 0;
const pendingBlocks = new Map<string, OrderingBlock>();

/** NODE_INTERFACE → Fork choice decides on verified headers. */
export function initIntake(cb: IntakeCallbacks, ctx: PipelineContext): void {
  callbacks = cb;
  context = ctx;
  S = 0;
  pendingBlocks.clear();
}

/** Whether `initIntake` was called since the last reset. */
export function isIntakeInitialized(): boolean {
  return callbacks !== null && context !== null;
}

/** Tests only. */
export function resetIntakeForTests(): void {
  callbacks = null;
  context = null;
  S = 0;
  pendingBlocks.clear();
}

function cb(): IntakeCallbacks {
  if (callbacks === null) throw new Error('intake: initIntake was not called');
  return callbacks;
}

function ctxOrThrow(): PipelineContext {
  if (context === null) throw new Error('intake: initIntake was not called');
  return context;
}

/**
 * `penalize` filter: a block delivered by this node itself carries `fromPeer`
 * of `''`; a refusal of our own block is logged, never penalised
 * (NODE_INTERFACE → Fork choice decides on verified headers → "A body-stage
 * refusal marks the header.").
 */
function penalize(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void {
  if (peerId === '') {
    console.warn(`intake: self-delivered block refused — ${kind}: ${reason}`);
    return;
  }
  cb().penalize(peerId, kind, reason);
}

function reachFloor(): number {
  const c = ctxOrThrow();
  const lowest = c.lowestJournalHeight() ?? getCurrentHeight() + 1;
  return Math.max(getCurrentHeight() - c.maxReorgDepth, lowest - 1);
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A block in
 * hand extends the applied tip": the one predicate the store rule and the
 * binding both read. True when the parent is the applied tip, the window
 * allows extension and the best tip stands at most `maxReorgDepth` heights
 * above the applied tip.
 */
export function canExtendAppliedTipAsBlockInHand(parentHash: string, parentHeight: number): boolean {
  if (context === null) return false;
  const applied = getCurrentHeight();
  if (parentHeight !== applied) return false;
  const appliedHash = applied === 0 ? GENESIS_PREV_BLOCK_HASH : getOrderingBlockHash(applied);
  if (parentHash !== appliedHash) return false;
  if (!windowOpen()) return false;
  const bestTip = getBestTip();
  if (bestTip === null) return false;
  if (bestTip.height - applied > context.maxReorgDepth) return false;
  return true;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A served block
 * is bound to its header before it is kept.": the three checks — structure,
 * `utxoTxRoot`, validator signature — run in order against the tree row.
 * The first failure penalises the deliverer `misbehavior` and leaves no
 * stage row. A header that is not in the tree is refused `misbehavior`. A
 * stored header off the best chain is dropped silently unless the
 * `canExtendAppliedTipAsBlockInHand` predicate holds for it — then the
 * three checks run and the block is bound as a block in hand (→ "A block
 * in hand extends the applied tip.").
 *
 * Returns the row to stage onto, or `null` if the block is refused or dropped.
 */
function bindBlock(
  peerId: string,
  block: OrderingBlock,
  hash: string | null,
): { height: number; hash: string } | null {
  if (hash === null) {
    penalize(peerId, 'misbehavior', 'unhashable block header');
    return null;
  }
  const row = getHeaderRow(hash);
  if (row === null) {
    penalize(peerId, 'misbehavior', 'block header not in the tree');
    return null;
  }
  const bestHash = getBestHashAt(row.height);
  if (bestHash !== hash) {
    // Off-best: a block whose header is a stored row whose parent is the
    // applied tip, inside the window and the height bound, binds as a
    // block in hand; any other off-best delivery is dropped silently
    // (NODE_INTERFACE → Fork choice decides on verified headers →
    // "A served block is bound to its header before it is kept.").
    if (!canExtendAppliedTipAsBlockInHand(row.header.prevBlockHash, row.height - 1)) {
      return null;
    }
  }
  const structure = verifyOrderingBlockStructure(block);
  if (!structure.valid) {
    penalize(peerId, 'misbehavior', `structure: ${structure.error}`);
    return null;
  }
  if (!verifyUtxoTxRoot(block)) {
    penalize(peerId, 'misbehavior', 'utxoTxRoot does not bind');
    return null;
  }
  if (!verifyValidatorSignature(block.header, block.validatorSignature)) {
    penalize(peerId, 'misbehavior', 'validator signature does not bind');
    return null;
  }
  return { height: row.height, hash };
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A body-stage
 * refusal marks the header.": after the funnel's `'consensus'` rejection, the
 * mark is written in its own write, the deliverer is penalised, and the
 * header leaves the tree with every descendant. The best chain is then
 * chosen again — the heaviest stored header whose branch is reachable
 * (NODE_INTERFACE → Fork choice decides on verified headers → "The best
 * chain is the heaviest reachable branch.") — and the memo is cleared on
 * that move.
 */
function markRefused(hash: string, height: number, fromPeer: string, reason: string): void {
  penalize(fromPeer, 'misbehavior', reason);
  insertRefusedHeader(hash, height, getCurrentHeight());
  removeHeaderSubtree(hash);
  const c = ctxOrThrow();
  const pipelineCb = {
    penalize: (p: string, k: 'misbehavior' | 'transient', r: string) => penalize(p, k, r),
    chainMoved: () => cb().chainMoved(),
  };
  rechooseBestChain(c, pipelineCb);
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A block in
 * hand extends the applied tip": the choice `rechooseAfterApply` makes, wired
 * through the intake's callbacks.
 */
function rechooseAfterApplyFromIntake(): void {
  const c = ctxOrThrow();
  const pipelineCb = {
    penalize: (p: string, k: 'misbehavior' | 'transient', r: string) => penalize(p, k, r),
    chainMoved: () => cb().chainMoved(),
  };
  rechooseAfterApply(c, pipelineCb);
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A block in
 * hand extends the applied tip": the per-block apply the extension loop and
 * the block-in-hand delivery path both call. The funnel's classified entry
 * runs the block; on apply the staged row leaves, `chainMoved` fires, the
 * placeholders go to the body puller, `onBlockApplied` runs and the header
 * tree is pruned; on a consensus refusal the header is marked and the best
 * chain is chosen again; on an abort the staged row leaves.
 */
function applyStagedBlockAtHeight(hash: string, height: number): 'applied' | 'marked' | 'aborted' {
  const staged = getStagedBlock(hash);
  if (staged === null) return 'aborted';
  const verdict = applyFn(staged.block);
  if (verdict.applied) {
    unstageBlock(hash);
    cb().chainMoved();
    // NODE_INTERFACE → Posts → "Backfill after sync": placeholders this
    // block's commit left are handed to the body puller, naming the peer
    // the block came through.
    for (const p of getPlaceholdersAt(height)) {
      registerPlaceholder(p.id, p.contentHash, height, staged.fromPeer);
    }
    onBlockApplied(height).catch((err) =>
      console.warn(`Backfill error at height ${height}: ${String(err)}`),
    );
    // Pruning runs at each apply (NODE_INTERFACE → Fork choice decides on
    // verified headers → "Pruning."). The journals are purged by
    // `applyBlockBody`'s own call to `purgeOldJournals`.
    pruneHeaderTree(reachFloor());
    return 'applied';
  }
  if (verdict.class === 'consensus') {
    markRefused(hash, height, staged.fromPeer, `consensus refusal at height ${height}`);
    return 'marked';
  }
  // Abort: an acceptance, local or unbound refusal drops the staged row so
  // its id is wanted and asked again.
  unstageBlock(hash);
  return 'aborted';
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "Extension." +
 * "The window.": when `best_chain`'s entry at the applied height is this
 * node's applied hash, apply the block at `appliedTip + 1` from staging —
 * the per-block apply above fires the funnel. The loop stops at an empty
 * staging row, at the window's edge, or when the best chain no longer
 * holds the applied tip (a switch condition the next item answers through
 * `trySwitch`). A block in hand off the best chain is applied by the
 * delivery path, not this loop (→ "A block in hand extends the applied
 * tip.").
 */
function drainExtension(): void {
  const c = ctxOrThrow();
  // One pass runs until we have no more applicable staged block or an abort/mark fires.
  for (;;) {
    const bestTip = getBestTip();
    if (bestTip === null) return;
    const applied = getCurrentHeight();
    // Extension runs along the best chain while the best chain's row at
    // `applied` is this node's applied block's hash. Off that gate it is a
    // switch condition (NODE_INTERFACE → Fork choice decides on verified
    // headers → "The switch.").
    if (applied > 0) {
      const appliedHash = getOrderingBlockHash(applied);
      const bestAtApplied = getBestHashAt(applied);
      if (appliedHash === null || bestAtApplied !== appliedHash) return;
    }
    if (applied >= bestTip.height) return;
    // The window's edge.
    if (applied >= S + c.maxReorgDepth) return;
    const nextH = applied + 1;
    const nextHash = getBestHashAt(nextH);
    if (nextHash === null) return;
    if (!hasStagedBlock(nextHash)) return;
    const outcome = applyStagedBlockAtHeight(nextHash, nextH);
    if (outcome === 'applied') continue;
    return;
  }
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The switch.".
 * If the best chain forks below the applied tip, hand the shortest heavier
 * prefix (all its staged hashes in height order) to `reorg`. The call runs
 * synchronously over better-sqlite3; `ReorgBlockRejectedError` marks the
 * header and `ReorgAbortedError` drops the aborted block's staged row.
 */
function trySwitch(): void {
  const bestTip = getBestTip();
  if (bestTip === null) return;
  const applied = getCurrentHeight();
  if (applied === 0) return;
  const appliedHash = getOrderingBlockHash(applied);
  const bestAtApplied = getBestHashAt(applied);
  if (appliedHash === null) return;
  // No switch while the best chain contains the applied tip.
  if (bestAtApplied === appliedHash) return;

  // Fork height: the highest height on both chains with matching hashes,
  // bounded below by the reach floor. Admission's age rule holds every
  // stored header's parent at or above the floor (NODE_INTERFACE → Fork
  // choice decides on verified headers → "The reach floor is the horizon,
  // one rule for every fork point."), so a walk that reaches the floor
  // without a match is local corruption and fail-stops.
  const floor = reachFloor();
  let f = applied - 1;
  while (f > floor) {
    const ourHash = getOrderingBlockHash(f);
    const theirHash = getBestHashAt(f);
    if (ourHash !== null && ourHash === theirHash) break;
    f -= 1;
  }
  if (f <= floor) {
    const ourHash = f === 0 ? null : getOrderingBlockHash(f);
    const theirHash = f === 0 ? null : getBestHashAt(f);
    const matchAtFloor = f > 0 && ourHash !== null && ourHash === theirHash;
    const floorIsVirtualRoot = floor === 0 && f === 0;
    if (!matchAtFloor && !floorIsVirtualRoot) {
      throw new UnreachableForkPointError('trySwitch', applied, floor);
    }
  }
  // Shortest heavier prefix: walk the best chain above f collecting hashes
  // until the cumulative chainWork at that height exceeds the applied tip's.
  // The applied tip's row is a `block_headers` entry by construction —
  // every applied header is a tree row (NODE_INTERFACE → Header tree → "The
  // applied chain's headers are rows too") — so a missing row contradicts the
  // store.
  const appliedTipRow = getHeaderRow(appliedHash);
  if (appliedTipRow === null) {
    throw new InconsistentHeaderTreeError('trySwitch', applied, 'applied header has no block_headers row');
  }
  const targetWork = appliedTipRow.chainWork;
  const prefixHashes: string[] = [];
  for (let h = f + 1; h <= bestTip.height; h++) {
    const hAtBest = getBestHashAt(h);
    if (hAtBest === null) {
      throw new InconsistentHeaderTreeError('trySwitch', h, 'best_chain gap below its tip');
    }
    prefixHashes.push(hAtBest);
    const row = getHeaderRow(hAtBest);
    if (row === null) {
      throw new InconsistentHeaderTreeError('trySwitch', h, 'best_chain hash has no block_headers row');
    }
    if (row.chainWork > targetWork) break;
  }
  // Every hash of the prefix must be staged before we fire reorg; `reorg`
  // itself reads each body out of `staged_blocks` one at a time inside its
  // transaction, so one body is in memory at a time. A missing staged row
  // for an id this node did not ask for is reachable state — the switch
  // waits.
  for (const h of prefixHashes) {
    if (!hasStagedBlock(h)) return;
  }

  try {
    reorgFn(f, prefixHashes);
  } catch (err) {
    if (err instanceof ReorgBlockRejectedError) {
      // The failing block's staged row names the deliverer — read it before
      // the subtree remove drops the row.
      const staged = getStagedBlock(err.hash);
      const fromPeer = staged?.fromPeer ?? '';
      markRefused(err.hash, err.height, fromPeer, `reorg consensus refusal at height ${err.height}`);
      return;
    }
    if (err instanceof ReorgAbortedError) {
      unstageBlock(err.hash);
      return;
    }
    throw err;
  }
  // Switch succeeded; extension continues.
  drainExtension();
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The pipeline
 * names the blocks it wants".
 */
export function wantedBlocks(): { id: string; height: number }[] {
  ctxOrThrow();
  const bestTip = getBestTip();
  if (bestTip === null) return [];
  if (bestTip.chainWork < config.profile.minimumChainWork) return [];
  const applied = getCurrentHeight();
  if (applied === 0) {
    // Fresh node — every best-chain block above 0 up to the window edge.
    return wantedForExtension(0, bestTip.height);
  }
  const appliedHash = getOrderingBlockHash(applied);
  const bestAtApplied = getBestHashAt(applied);
  if (appliedHash !== null && bestAtApplied === appliedHash) {
    return wantedForExtension(applied, bestTip.height);
  }
  // Switch: the whole shortest heavier prefix above the fork height.
  // Bounded at the reach floor — admission holds every stored header's
  // parent at or above it; the walk reaching the floor without a match is
  // local corruption, named by `trySwitch` on its own call.
  const floor = reachFloor();
  let f = applied - 1;
  while (f > floor) {
    const ourHash = getOrderingBlockHash(f);
    const theirHash = getBestHashAt(f);
    if (ourHash !== null && ourHash === theirHash) break;
    f -= 1;
  }
  const appliedTipRow = appliedHash === null ? null : getHeaderRow(appliedHash);
  const targetWork = appliedTipRow?.chainWork ?? 0n;
  const out: { id: string; height: number }[] = [];
  for (let h = f + 1; h <= bestTip.height; h++) {
    const hashAt = getBestHashAt(h);
    if (hashAt === null) break;
    if (!hasStagedBlock(hashAt)) out.push({ id: hashAt, height: h });
    const row = getHeaderRow(hashAt);
    if (row === null) break;
    if (row.chainWork > targetWork) break;
  }
  return out;
}

function wantedForExtension(applied: number, bestHeight: number): { id: string; height: number }[] {
  const c = ctxOrThrow();
  const upperWindow = applied + BLOCK_FETCH_WINDOW;
  const upperGate = S + c.maxReorgDepth;
  const upper = Math.min(bestHeight, upperWindow, upperGate);
  const out: { id: string; height: number }[] = [];
  for (let h = applied + 1; h <= upper; h++) {
    const hashAt = getBestHashAt(h);
    if (hashAt === null) break;
    if (!hasStagedBlock(hashAt)) out.push({ id: hashAt, height: h });
  }
  return out;
}

/** NODE_INTERFACE → Fork choice decides on verified headers → "The window.". */
export function gateHeld(): void {
  const best = getBestTip();
  S = best?.height ?? 0;
}

/**
 * MINING_INTERFACE → The window gate: `appliedTip < S + maxReorgDepth`. The
 * template route reads this to withhold a template while the window holds
 * extension — a block the node could not apply is a block it does not ask a
 * miner for. A node whose intake has not been initialized has no path to
 * apply what a miner would solve; the gate holds, and the template route
 * answers the absent-template 404 at serve.
 */
export function windowOpen(): boolean {
  if (context === null) return false;
  return getCurrentHeight() < S + context.maxReorgDepth;
}

/** NET_INTERFACE → Sync Handler Registration: `fullyApplied()`. */
export function fullyApplied(): boolean {
  const best = getBestTip();
  if (!best) return true;
  return getCurrentHeight() >= best.height;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A pending block
 * is tried again at the end of every item". The admit-bind-stage-apply body
 * both `deliverGossipedBlock` and `processPendingPass` call for a gossiped
 * block, without `drainExtension` or `trySwitch` — those run at the end of
 * the item that drives the pass, so the pass never recurses.
 */
function gossipedBody(peerId: string, block: OrderingBlock): void {
  const c = ctxOrThrow();
  const hash = blockHash(block.header);
  if (hash === null) {
    // Net's Stage 1 refuses an unhashable header before delivery; a block
    // whose header will not hash has no identity to be kept by, logged and
    // dropped with no penalty (NODE_INTERFACE → Fork choice decides on
    // verified headers → "One intake, one at a time").
    console.warn(`intake: gossiped block from ${peerId} has an unhashable header; dropped`);
    return;
  }
  const pipelineCb = {
    penalize: (p: string, k: 'misbehavior' | 'transient', r: string) => penalize(p, k, r),
    chainMoved: () => cb().chainMoved(),
  };
  const verdict: AdmitVerdict = admitHeader(block.header, 'gossip', peerId, c, pipelineCb);
  if (verdict.kind === 'parent-unknown') {
    pendingBlocks.set(peerId, block);
    cb().needHeaders(peerId);
    return;
  }
  if (verdict.kind === 'scored') {
    // A gossiped header on a side branch: the block is dropped and
    // `needHeaders(relayer)` is called so the branch's pass can run.
    cb().needHeaders(peerId);
    return;
  }
  if (verdict.kind === 'refused') return;
  // `held` or `stored`: proceed to bind.
  const bindRow = bindBlock(peerId, block, hash);
  if (bindRow === null) return;
  stageBlock(bindRow.hash, bindRow.height, encodeOrderingBlock(block), peerId);
  // Block in hand off-best → apply in this item, then choose the best
  // chain again (NODE_INTERFACE → Fork choice decides on verified headers →
  // "A block in hand extends the applied tip.").
  if (getBestHashAt(bindRow.height) !== bindRow.hash) {
    if (applyStagedBlockAtHeight(bindRow.hash, bindRow.height) === 'applied') {
      rechooseAfterApplyFromIntake();
    }
  }
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "A pending block
 * is tried again at the end of every item". A pending entry leaves the map
 * before its block runs through the shared gossiped body; a block that runs
 * can be the parent of another, so the loop iterates until no remaining
 * pending block's parent is held. Each peer is attempted at most once per
 * pass, bounding the loop by the pending map's size at pass start.
 */
function processPendingPass(): void {
  if (pendingBlocks.size === 0) return;
  const attempted = new Set<string>();
  for (;;) {
    let candidate: { peerId: string; block: OrderingBlock } | null = null;
    for (const [peerId, block] of pendingBlocks) {
      if (attempted.has(peerId)) continue;
      if (getHeaderRow(block.header.prevBlockHash) === null) continue;
      candidate = { peerId, block };
      break;
    }
    if (candidate === null) return;
    attempted.add(candidate.peerId);
    pendingBlocks.delete(candidate.peerId);
    gossipedBody(candidate.peerId, candidate.block);
  }
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". The body of a `Headers` page delivery, closing with the pass
 * (NODE_INTERFACE → Fork choice decides on verified headers → "A pending
 * block is tried again at the end of every item").
 */
export async function deliverHeaders(
  peerId: string,
  claimHash: string,
  headers: BlockHeader[],
): Promise<PageOutcome> {
  const c = ctxOrThrow();
  const pipelineCb = {
    penalize: (p: string, k: 'misbehavior' | 'transient', r: string) => penalize(p, k, r),
    chainMoved: () => cb().chainMoved(),
  };
  const verdict: PageVerdict = admitPage(peerId, claimHash, headers, c, pipelineCb);
  processPendingPass();
  drainExtension();
  trySwitch();
  return verdict.outcome;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". The body of a `Blocks` answer delivery, closing with the pass
 * (NODE_INTERFACE → Fork choice decides on verified headers → "A pending
 * block is tried again at the end of every item").
 */
export async function deliverBlocks(peerId: string, blocks: OrderingBlock[]): Promise<void> {
  for (const block of blocks) {
    const hash = blockHash(block.header);
    const row = bindBlock(peerId, block, hash);
    if (row === null) continue;
    stageBlock(row.hash, row.height, encodeOrderingBlock(block), peerId);
    // A block in hand off the best chain whose parent is the applied tip
    // applies in the item that delivers it (NODE_INTERFACE → Fork choice
    // decides on verified headers → "A block in hand extends the applied
    // tip."); extension picks up a staged on-best child in `drainExtension`
    // below. After the apply the best chain is chosen again.
    if (getBestHashAt(row.height) !== row.hash) {
      if (applyStagedBlockAtHeight(row.hash, row.height) === 'applied') {
        rechooseAfterApplyFromIntake();
      }
    }
  }
  processPendingPass();
  drainExtension();
  trySwitch();
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". A gossiped block past Stage 1 runs through the shared body,
 * then the pass closes the item (NODE_INTERFACE → Fork choice decides on
 * verified headers → "A pending block is tried again at the end of every
 * item").
 */
export async function deliverGossipedBlock(peerId: string, block: OrderingBlock): Promise<void> {
  gossipedBody(peerId, block);
  processPendingPass();
  drainExtension();
  trySwitch();
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". This node's own mined block. The mined block's verdict is
 * answered before the pass runs (NODE_INTERFACE → Fork choice decides on
 * verified headers → "A pending block is tried again at the end of every
 * item").
 */
export function deliverMinedBlock(block: OrderingBlock): ApplyVerdict {
  const c = ctxOrThrow();
  const hash = blockHash(block.header);
  const pipelineCb = {
    penalize: (p: string, k: 'misbehavior' | 'transient', r: string) => penalize(p, k, r),
    chainMoved: () => cb().chainMoved(),
  };
  // Admission uses `'headers-page'` with peer `''`; a mined block whose parent
  // is the applied tip never answers `parent-unknown` (we mine on our tip),
  // and `penalize('')` is logged, never relayed.
  const admit: AdmitVerdict = admitHeader(block.header, 'headers-page', '', c, pipelineCb);
  if (admit.kind === 'refused') {
    return { applied: false, class: 'local', detail: `mined header admission refused: ${admit.reason}` };
  }
  if (hash === null) {
    return { applied: false, class: 'local', detail: 'mined header unhashable' };
  }
  const bindRow = bindBlock('', block, hash);
  if (bindRow === null) {
    return { applied: false, class: 'local', detail: 'mined block did not bind' };
  }
  stageBlock(bindRow.hash, bindRow.height, encodeOrderingBlock(block), '');
  // The node's own block raises neither a penalty nor the window's `S`
  // (NODE_INTERFACE → Block finalization → "A mined block is applied through
  // the pipeline's intake"); `S` moves only through net's gate hold. A mined
  // block in hand off the best chain whose parent is the applied tip
  // applies here, and the best chain is chosen again (NODE_INTERFACE → Fork
  // choice decides on verified headers → "A block in hand extends the
  // applied tip.").
  if (getBestHashAt(bindRow.height) !== bindRow.hash) {
    if (applyStagedBlockAtHeight(bindRow.hash, bindRow.height) === 'applied') {
      rechooseAfterApplyFromIntake();
    }
  }
  drainExtension();
  // The verdict reads the mined block's own apply before the pass runs.
  const minedVerdict: ApplyVerdict =
    !hasStagedBlock(hash) && getOrderingBlockHash(bindRow.height) === hash
      ? { applied: true, indexed: [] }
      : { applied: false, class: 'local', detail: 'mined block did not apply through extension' };
  processPendingPass();
  drainExtension();
  return minedVerdict;
}

/** NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one at a time". */
export function onPeerDisconnected(peerId: string): void {
  pendingBlocks.delete(peerId);
  pipelineOnPeerDisconnected(peerId);
}

/** Tests only. */
export function getPendingBlockForTests(peerId: string): OrderingBlock | undefined {
  return pendingBlocks.get(peerId);
}

/** Tests only. */
export function getSForTests(): number {
  return S;
}

export type { AdmitVerdict, PageOutcome, PageVerdict, PipelineContext };
