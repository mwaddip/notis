import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { encodeOrderingBlock } from '@dagsocial/types';
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
  insertRefusedHeader,
  pruneHeadersBelow,
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
  type AdmitVerdict,
  type PageVerdict,
  type PipelineContext,
} from './header-pipeline.js';
import * as blockApply from './block-apply.js';
import type { ApplyVerdict } from './block-apply.js';
import { reorg as realReorg } from './fork-resolution.js';
import { ReorgAbortedError, ReorgBlockRejectedError, UnreachableForkPointError } from './corrupt-state.js';
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
 * NODE_INTERFACE → Fork choice decides on verified headers → "A served block
 * is bound to its header before it is kept.": the three checks run in order
 * against the tree row. On the first failure, nothing is staged and the
 * deliverer is penalised `misbehavior`; a block whose header is stored off
 * best is dropped with no penalty; a block whose header is not in the tree
 * is refused `misbehavior`.
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
    // Off-best, dropped silently.
    return null;
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
 * header leaves the tree with every descendant.
 */
function markRefused(hash: string, height: number, fromPeer: string, reason: string): void {
  penalize(fromPeer, 'misbehavior', reason);
  insertRefusedHeader(hash, height, getCurrentHeight());
  removeHeaderSubtree(hash);
  // The best chain is chosen again — the callback announces the move.
  cb().chainMoved();
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "Extension." +
 * "The window.": while the best chain contains the applied tip, apply the
 * block at `appliedTip + 1` from staging; the loop stops at an empty
 * staging row, at the window's edge, or at a switch condition.
 */
function drainExtension(): void {
  const c = ctxOrThrow();
  // One pass runs until we have no more applicable staged block or an abort/mark fires.
  for (;;) {
    const bestTip = getBestTip();
    if (bestTip === null) return;
    const applied = getCurrentHeight();
    // The best-chain-contains-applied-tip gate: extension only runs while the
    // best chain's row at `applied` is this node's applied block's hash
    // (NODE_INTERFACE → Fork choice decides on verified headers → "The switch.").
    if (applied > 0) {
      const appliedHash = getOrderingBlockHash(applied);
      const bestAtApplied = getBestHashAt(applied);
      if (appliedHash === null || bestAtApplied !== appliedHash) {
        // A switch condition — not extension.
        return;
      }
    }
    if (applied >= bestTip.height) return;
    // The window's edge.
    if (applied >= S + c.maxReorgDepth) return;
    const nextH = applied + 1;
    const nextHash = getBestHashAt(nextH);
    if (nextHash === null) return;
    const staged = getStagedBlock(nextHash);
    if (staged === null) return;
    const verdict = applyFn(staged.block);
    if (verdict.applied) {
      unstageBlock(nextHash);
      // NODE_INTERFACE → Posts → "Backfill after sync": placeholders this
      // block's commit left are handed to the body puller, naming the peer
      // the block came through.
      for (const p of getPlaceholdersAt(nextH)) {
        registerPlaceholder(p.id, p.contentHash, nextH, staged.fromPeer);
      }
      onBlockApplied(nextH).catch((err) =>
        console.warn(`Backfill error at height ${nextH}: ${String(err)}`),
      );
      // Pruning runs at each apply (NODE_INTERFACE → Fork choice decides on
      // verified headers → "Pruning."). The journals are purged by
      // `applyBlockBody`'s own call to `purgeOldJournals`.
      pruneHeaderTree(reachFloor());
      continue;
    }
    if (verdict.class === 'consensus') {
      markRefused(nextHash, nextH, staged.fromPeer, `consensus refusal at height ${nextH}`);
      return;
    }
    // Abort: an acceptance, local or unbound refusal drops the staged row so
    // its id is wanted and asked again.
    unstageBlock(nextHash);
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
  const appliedTipHash = appliedHash;
  const appliedTipRow = getHeaderRow(appliedTipHash);
  if (appliedTipRow === null) return;
  const targetWork = appliedTipRow.chainWork;
  const prefixHashes: string[] = [];
  for (let h = f + 1; h <= bestTip.height; h++) {
    const hAtBest = getBestHashAt(h);
    if (hAtBest === null) return;
    prefixHashes.push(hAtBest);
    const row = getHeaderRow(hAtBest);
    if (row === null) return;
    if (row.chainWork > targetWork) break;
  }
  // Every hash of the prefix must be staged before we fire reorg; `reorg`
  // itself reads each body out of `staged_blocks` one at a time inside its
  // transaction, so one body is in memory at a time.
  for (const h of prefixHashes) {
    if (getStagedBlock(h) === null) return;
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
  const c = ctxOrThrow();
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
    if (getStagedBlock(hashAt) === null) out.push({ id: hashAt, height: h });
    const row = getHeaderRow(hashAt);
    if (row === null) break;
    if (row.chainWork > targetWork) break;
  }
  // Scope-mark the var so lint stays quiet; `c` carries no bound here.
  void c;
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
    if (getStagedBlock(hashAt) === null) out.push({ id: hashAt, height: h });
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
 * miner for. A node whose intake has not been initialized has no `S` to
 * compare and no window to hold; the gate answers open, because the
 * absent-template 404 answers first in that state.
 */
export function windowOpen(): boolean {
  if (context === null) return true;
  return getCurrentHeight() < S + context.maxReorgDepth;
}

/** NET_INTERFACE → Sync Handler Registration: `fullyApplied()`. */
export function fullyApplied(): boolean {
  const best = getBestTip();
  if (!best) return true;
  return getCurrentHeight() >= best.height;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". The body of a `Headers` page delivery.
 */
export async function deliverHeaders(
  peerId: string,
  claimHash: string,
  headers: BlockHeader[],
): Promise<boolean> {
  const c = ctxOrThrow();
  const pipelineCb = {
    penalize: (p: string, k: 'misbehavior' | 'transient', r: string) => penalize(p, k, r),
    chainMoved: () => cb().chainMoved(),
  };
  const verdict: PageVerdict = admitPage(peerId, claimHash, headers, c, pipelineCb);
  // A pending gossiped block whose parent now stands may be bindable.
  processPendingAfterAdmit();
  drainExtension();
  trySwitch();
  return verdict.accepted && verdict.outcome !== 'refused';
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". The body of a `Blocks` answer delivery.
 */
export async function deliverBlocks(peerId: string, blocks: OrderingBlock[]): Promise<void> {
  for (const block of blocks) {
    const hash = blockHash(block.header);
    const row = bindBlock(peerId, block, hash);
    if (row === null) continue;
    stageBlock(row.hash, row.height, encodeOrderingBlock(block), peerId);
  }
  drainExtension();
  trySwitch();
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". A gossiped block past Stage 1.
 */
export async function deliverGossipedBlock(peerId: string, block: OrderingBlock): Promise<void> {
  const c = ctxOrThrow();
  const hash = blockHash(block.header);
  if (hash === null) {
    penalize(peerId, 'misbehavior', 'unhashable gossiped block header');
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
  if (bindRow === null) {
    drainExtension();
    trySwitch();
    return;
  }
  stageBlock(bindRow.hash, bindRow.height, encodeOrderingBlock(block), peerId);
  drainExtension();
  trySwitch();
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time". This node's own mined block.
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
  // NODE_INTERFACE → Fork choice decides on verified headers → "The window.":
  // S is net's gate. For a mined block the node trusts the chain by
  // construction — the window is a bound on applying peer-delivered blocks,
  // not on applying one this node mined. Lift S to the new best tip's height
  // so the extension drains this height.
  gateHeld();
  drainExtension();
  // Answer the verdict the apply left: the staged row leaves on apply.
  if (getStagedBlock(hash) === null && getOrderingBlockHash(bindRow.height) === hash) {
    return { applied: true, indexed: [] };
  }
  return { applied: false, class: 'local', detail: 'mined block did not apply through extension' };
}

/**
 * A pending block whose relayer's header walk admitted the parent is bindable
 * now. On every admit we check each pending — the admit landed a row the
 * pending's header's `prevBlockHash` matches.
 */
function processPendingAfterAdmit(): void {
  if (pendingBlocks.size === 0) return;
  for (const [peerId, block] of pendingBlocks) {
    const parentRow = getHeaderRow(block.header.prevBlockHash);
    if (parentRow === null) continue;
    const hash = blockHash(block.header);
    if (hash === null) {
      pendingBlocks.delete(peerId);
      continue;
    }
    const held = getHeaderRow(hash);
    if (held === null) continue;
    const bestAt = getBestHashAt(held.height);
    if (bestAt !== hash) {
      pendingBlocks.delete(peerId);
      continue;
    }
    const bindRow = bindBlock(peerId, block, hash);
    pendingBlocks.delete(peerId);
    if (bindRow === null) continue;
    stageBlock(bindRow.hash, bindRow.height, encodeOrderingBlock(block), peerId);
  }
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

// Imports kept live.
void pruneHeadersBelow;
export type { AdmitVerdict, PageVerdict, PipelineContext };
