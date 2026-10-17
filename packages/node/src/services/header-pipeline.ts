import type { BlockHeader, ProtocolEra } from '@dagsocial/types';
import {
  GENESIS_PREV_BLOCK_HASH,
  updateInterlinks,
} from '@dagsocial/types';
import {
  blockHash,
  blockWork,
  level,
  verifyHeaderChain,
  type RetargetParams,
} from '@dagsocial/validation';
import { MAX_LOCATOR_HASHES } from '@dagsocial/net';
import {
  anyRefusedHeader,
  getBestHashAt,
  getBestTip,
  getHeaderRow,
  insertHeader,
  pruneHeadersBelow,
  rewriteBestChain,
  type HeaderRow,
} from '../store/index.js';

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The intake owns
 * what it runs": every penalty and the "best chain moved" event leave the
 * pipeline through callbacks the intake injects.
 */
export interface PipelineCallbacks {
  penalize(peerId: string, kind: 'misbehavior' | 'transient', reason: string): void;
  chainMoved(): void;
}

/** NODE_INTERFACE → Fork choice decides on verified headers. */
export type AdmitVerdict =
  | { kind: 'held' }
  | { kind: 'refused'; reason: string }
  | { kind: 'stored'; wasBest: boolean }
  | { kind: 'stored-switched'; forkHeight: number }
  | { kind: 'scored' }
  | { kind: 'parent-unknown' };

export type AdmitSource = 'headers-page' | 'gossip';

/** Verdict for `admitPage`. */
export interface PageVerdict {
  accepted: boolean;
  outcome:
    | 'extended'
    | 'scored-partial'
    | 'won'
    | 'lighter'
    | 'stored-from-pass-2'
    | 'held'
    | 'refused';
  refusedAt?: { index: number; kind: 'misbehavior' | 'transient' | 'none'; reason: string };
}

export interface PipelineContext {
  params: RetargetParams;
  schedule: readonly ProtocolEra[];
  nowMs(): number;
  maxReorgDepth: number;
  genesisId: string;
  lowestJournalHeight(): number | null;
  appliedTipHeight(): number;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The reach floor
 * is the horizon, one rule for every fork point": a fork point at height `f`
 * is reachable when `f ≥ max(appliedTip − maxReorgDepth, lowestJournal − 1)`.
 */
function reachFloor(ctx: PipelineContext): number {
  const lowest = ctx.lowestJournalHeight() ?? ctx.appliedTipHeight() + 1;
  return Math.max(ctx.appliedTipHeight() - ctx.maxReorgDepth, lowest - 1);
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The best chain
 * is the heaviest reachable branch": the fork point of the best chain with the
 * applied chain. Tracked here because `admitHeader` needs it to decide an
 * `outweighs` arm's reachability without re-walking.
 */
let bestChainForkWithApplied: number = 0;

/**
 * The one-branch-per-peer presync state (NODE_INTERFACE → "A side branch is
 * stored only once it is heavier"): the branch's base — the stored header it
 * forks from — its continuation anchor, running work, the recorded hashes
 * (32 bytes per 400 headers plus the last), the claim the page was asked
 * toward, and the top height scored so far.
 */
interface RunningBranch {
  claimHash: string;
  baseHash: string;
  baseHeight: number;
  basePathTa: number;
  nextAnchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null };
  nextTa: number | null;
  runningWork: bigint;
  recordedHashes: string[];
  recordedHeights: number[];
  topHeight: number;
  topHash: string;
}

const runningBranches = new Map<string, RunningBranch>();

/** NODE_INTERFACE → Fork choice decides on verified headers → "Re-scoring is memoised". */
const scoredLighter = new Map<string, string>();

function workOrZero(bits: number): bigint {
  const w = blockWork(bits);
  return w === null ? 0n : w;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "An admitted header is stored when it extends the best chain or outweighs
 * it". A `stored` verdict either extends best (`stored` with `wasBest: true`)
 * or outweighs it after a reachability check (`stored-switched`).
 */
function tryStoreOrSwitch(
  header: BlockHeader,
  hash: string,
  parent: HeaderRow,
  verifiedWork: bigint,
  ctx: PipelineContext,
  callbacks: PipelineCallbacks,
): AdmitVerdict {
  const chainWork = parent.chainWork + verifiedWork;
  // Interlinks the stored row commits to — the vector the header's
  // `interlinkRoot` is derived from (TYPES_INTERFACE → Interlink vector).
  const storedInterlinks = ensureStoredInterlinks(header, parent, ctx.params.anchorBits);
  // `parent.pathTa` carries block 1's `createdAt` on this header's path; the
  // virtual root at height 0 has no row, so height-1 admissions supply their
  // own `pathTa`.
  const pathTa = header.height === 1 ? header.createdAt : parent.pathTa;
  const row: HeaderRow = {
    hash,
    height: header.height,
    prevHash: header.prevBlockHash,
    header,
    interlinks: storedInterlinks,
    chainWork,
    pathTa,
  };

  const best = getBestTip();
  const bestWork = best ? best.chainWork : 0n;

  if (!best || parent.hash === best.hash) {
    // Extension of best.
    insertHeader(row);
    rewriteBestChain(parent.height, [hash]);
    scoredLighter.clear();
    callbacks.chainMoved();
    // The best chain's fork with the applied chain is unchanged by extension
    // (the extension's new tip sits above the fork).
    return { kind: 'stored', wasBest: true };
  }

  if (chainWork > bestWork) {
    // Outweighs: find the fork point with the best chain by walking
    // `prev_hash` up through the tree until a `best_chain` row is found.
    // Bounded by the side branch's length (NODE_INTERFACE → Fork choice
    // decides on verified headers → "A side branch is stored only once it is
    // heavier").
    const branchHashes: string[] = [hash];
    let cursorPrevHash = header.prevBlockHash;
    let cursorHeight = header.height - 1;
    let bestForkHeight: number | null = null;
    while (cursorHeight >= 0) {
      const bestAt = getBestHashAt(cursorHeight);
      if (bestAt === cursorPrevHash || (cursorHeight === 0 && cursorPrevHash === GENESIS_PREV_BLOCK_HASH)) {
        bestForkHeight = cursorHeight;
        break;
      }
      const walk = getHeaderRow(cursorPrevHash);
      if (walk === null) break;
      branchHashes.push(cursorPrevHash);
      cursorPrevHash = walk.prevHash;
      cursorHeight = walk.height - 1;
    }
    if (bestForkHeight === null) {
      // Should never happen in production: a stored parent chain always meets
      // the best chain at height 0 (virtual root). Treat as refusal rather
      // than throw.
      return { kind: 'refused', reason: 'no-fork-with-best' };
    }
    // Reachability — NODE_INTERFACE → "The best chain is the heaviest
    // reachable branch". The candidate's fork with the applied chain is
    // `min(bestForkHeight, bestChainForkWithApplied)`.
    const candidateForkWithApplied = Math.min(bestForkHeight, bestChainForkWithApplied);
    if (candidateForkWithApplied < reachFloor(ctx)) {
      // Unreachable: do not store, do not switch.
      return { kind: 'refused', reason: 'unreachable-fork' };
    }
    insertHeader(row);
    const newEntries = branchHashes.slice().reverse();
    rewriteBestChain(bestForkHeight, newEntries);
    bestChainForkWithApplied = Math.min(bestChainForkWithApplied, bestForkHeight);
    scoredLighter.clear();
    callbacks.chainMoved();
    return { kind: 'stored-switched', forkHeight: bestForkHeight };
  }

  // On a side branch, equal or lighter — scored, not stored (unless this is
  // pass 2 which does its own store). The admission itself does not score the
  // single-header path; a tree row only lands on `extends` or `outweighs`.
  return { kind: 'scored' };
}

/**
 * The interlinks the header commits to — read from the header's own
 * `interlinks` field is not available; headers do not carry the full vector,
 * only `interlinkRoot`. The vector is derived from the parent's interlinks
 * via `updateInterlinks`. For a stored row we record what the admitted header
 * commits to, which is the derived vector.
 */
function ensureStoredInterlinks(_header: BlockHeader, parent: HeaderRow, anchorBits: number): string[] {
  if (_header.height === 1) return [];
  const parentLevel = level(parent.header, anchorBits);
  if (parentLevel === null) throw new Error('header-pipeline: parent level is null');
  return updateInterlinks(parent.interlinks, parent.hash, parentLevel);
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers.
 *
 * Admit one header. Returns a verdict after it has resolved to one of
 * `held` / `refused` / `stored` / `stored-switched` / `scored` / `parent-unknown`,
 * firing `callbacks.penalize` on a refusal that carries one and
 * `callbacks.chainMoved` when the best chain moves.
 */
export function admitHeader(
  header: BlockHeader,
  source: AdmitSource,
  peerId: string,
  ctx: PipelineContext,
  callbacks: PipelineCallbacks,
): AdmitVerdict {
  // 1. Hash.
  const hash = blockHash(header);
  if (hash === null) {
    callbacks.penalize(peerId, 'misbehavior', 'unhashable header');
    return { kind: 'refused', reason: 'unhashable' };
  }
  const held = getHeaderRow(hash);
  if (held !== null) return { kind: 'held' };
  if (anyRefusedHeader([hash])) {
    callbacks.penalize(peerId, 'misbehavior', 'header marked in refused_headers');
    return { kind: 'refused', reason: 'marked' };
  }

  // 2. Parent.
  let parent: HeaderRow | 'virtual-root';
  if (header.height === 1) {
    if (header.prevBlockHash !== GENESIS_PREV_BLOCK_HASH) {
      if (source === 'gossip') return { kind: 'parent-unknown' };
      callbacks.penalize(peerId, 'misbehavior', 'height-1 header does not point at the virtual root');
      return { kind: 'refused', reason: 'parent-not-virtual-root' };
    }
    if (ctx.genesisId !== '' && hash !== ctx.genesisId) {
      callbacks.penalize(peerId, 'misbehavior', 'height-1 header mismatches the pinned genesisId');
      return { kind: 'refused', reason: 'genesis-id-mismatch' };
    }
    parent = 'virtual-root';
  } else {
    const row = getHeaderRow(header.prevBlockHash);
    if (row === null) {
      if (source === 'gossip') return { kind: 'parent-unknown' };
      callbacks.penalize(peerId, 'misbehavior', 'parent is not in the header tree');
      return { kind: 'refused', reason: 'parent-unknown' };
    }
    parent = row;
  }

  // 3. Age rule.
  const parentHeight = parent === 'virtual-root' ? 0 : parent.height;
  if (parentHeight < reachFloor(ctx)) {
    return { kind: 'refused', reason: 'below-reach-floor' };
  }

  // 4. Verification.
  const anchor = parent === 'virtual-root'
    ? { prevBlockHash: GENESIS_PREV_BLOCK_HASH, height: 0, interlinks: [] as string[], createdAt: null as number | null }
    : {
        prevBlockHash: parent.hash,
        height: parent.height,
        interlinks: parent.height === 0 ? [] : updateInterlinks(parent.interlinks, parent.hash, level(parent.header, ctx.params.anchorBits) ?? 0),
        createdAt: parent.header.createdAt as number | null,
      };
  const anchorTa = parent === 'virtual-root' ? null : parent.pathTa;
  const verdict = verifyHeaderChain([header], anchor, ctx.params, anchorTa, ctx.nowMs(), ctx.schedule);
  if (!verdict.ok) {
    if (verdict.reason === 'clock') {
      return { kind: 'refused', reason: 'clock' };
    }
    const kind: 'misbehavior' | 'transient' = verdict.reason === 'version' ? 'transient' : 'misbehavior';
    callbacks.penalize(peerId, kind, `verifyHeaderChain: ${verdict.reason}`);
    return { kind: 'refused', reason: verdict.reason };
  }

  // Store or switch.
  const parentRow: HeaderRow = parent === 'virtual-root'
    ? { hash: GENESIS_PREV_BLOCK_HASH, height: 0, prevHash: GENESIS_PREV_BLOCK_HASH, header: header, interlinks: [], chainWork: 0n, pathTa: 0 }
    : parent;
  return tryStoreOrSwitch(header, hash, parentRow, verdict.work, ctx, callbacks);
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A side branch is stored only once it is heavier": pass 1 scores and pass 2
 * stores a won branch — this is one entry for both. `claimHash === ''` for a
 * run net opened with no claim (NET_INTERFACE → Sync Handler Registration):
 * the branch ends at the peer's tip, the first page shorter than
 * `MAX_CHAIN_RESPONSE_ITEMS`.
 */
export function admitPage(
  peerId: string,
  claimHash: string,
  headers: BlockHeader[],
  ctx: PipelineContext,
  callbacks: PipelineCallbacks,
): PageVerdict {
  if (headers.length === 0) return { accepted: true, outcome: 'held' };
  // Follow-up commit lands the pass-1/pass-2 logic.
  void peerId; void claimHash; void runningBranches; void ctx; void callbacks;
  return { accepted: false, outcome: 'refused', refusedAt: { index: 0, kind: 'none', reason: 'not-implemented' } };
}

/** NODE_INTERFACE → Sync Handler Registration → `setChainView` row. */
export function knowsTip(peerId: string, hash: string): boolean {
  if (getHeaderRow(hash) !== null) return true;
  return scoredLighter.get(peerId) === hash;
}

/**
 * NODE_INTERFACE → Sync Handler Registration → `setChainView` row:
 * `GetHeaders` / `GetBlocks` responses: `h₀ = tip`, `hᵢ₊₁ = hᵢ − 2ⁱ` while
 * `≥ 1`, then height 1; at most `MAX_LOCATOR_HASHES` entries; a node with no
 * chain sends the root alone; a requester continuing a branch it is scoring
 * puts that branch's last scored hash first.
 */
export function locatorFor(peerId: string): string[] {
  const tip = getBestTip();
  if (tip === null) return [GENESIS_PREV_BLOCK_HASH];
  const out: string[] = [];
  const running = runningBranches.get(peerId);
  if (running !== undefined) out.push(running.topHash);
  let h = tip.height;
  let step = 0;
  while (h >= 1 && out.length < MAX_LOCATOR_HASHES) {
    const hashAt = getBestHashAt(h);
    if (hashAt !== null) out.push(hashAt);
    if (h === 1) break;
    const next = h - (1 << step);
    step += 1;
    h = next >= 1 ? next : 1;
  }
  if (out.length > MAX_LOCATOR_HASHES) out.length = MAX_LOCATOR_HASHES;
  return out;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "Pruning":
 * called beside `purgeOldJournals`.
 */
export function pruneHeaderTree(belowHeight: number): void {
  pruneHeadersBelow(belowHeight);
  for (const [peerId, running] of runningBranches.entries()) {
    if (running.baseHeight < belowHeight) runningBranches.delete(peerId);
  }
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "One intake, one
 * at a time": a peer's disconnect takes its pending block, its presync and
 * its memo entry.
 */
export function onPeerDisconnected(peerId: string): void {
  runningBranches.delete(peerId);
  scoredLighter.delete(peerId);
}

/** Tests only. */
export function resetPipelineForTests(): void {
  runningBranches.clear();
  scoredLighter.clear();
  bestChainForkWithApplied = 0;
}

/** Internal helper for cases that argue work bounds. */
export function headerWork(header: BlockHeader): bigint {
  return workOrZero(header.powTargetBits);
}
