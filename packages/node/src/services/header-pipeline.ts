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
import { MAX_CHAIN_RESPONSE_ITEMS } from '@dagsocial/net';

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
  mode: 'scoring' | 'storing';
  baseHash: string;
  baseHeight: number;
  basePathTa: number | null;
  baseIsVirtualRoot: boolean;
  /** Base chainWork — the stored parent's chainWork, 0 at the virtual root. */
  baseChainWork: bigint;
  /** The anchor at the branch's base — the stored parent of the first header. */
  baseAnchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null };
  baseTa: number | null;
  /** Pass 1's running anchor as it advances page by page. */
  nextAnchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null };
  nextTa: number | null;
  runningWork: bigint;
  recordedHashes: string[];
  recordedHeights: number[];
  topHeight: number;
  topHash: string;
  /**
   * Pass 2 continuation state (`NODE_INTERFACE → Fork choice decides on
   * verified headers → "A side branch is stored only once it is heavier."`
   * → "Pass 2 stores"). Each pass-2 page continues from the last stored
   * header's anchor, matches every recorded height in its range, stores every
   * header, and the switch fires at the header whose cumulative work exceeds
   * the best tip's — pages before the crossing store rows that are not best.
   */
  storedUpTo: number;
  storedTopHash: string;
  storedAnchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null };
  storedTa: number | null;
  storedWork: bigint;
  storedHashes: string[];
  switched: boolean;
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
 * "An admitted header is stored when it extends the best chain." A `stored`
 * verdict extends best; a side-branch header is `scored`.
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

  // Side branch — `NODE_INTERFACE → Fork choice decides on verified headers →
  // "A side branch is stored only once it is heavier."`: side-branch headers
  // reach the tree only through pass 2 of their peer's running branch. A
  // single header's work is at most the anchor target's `blockWork` ·—· and a
  // side branch outweighing best requires at least that same unit of margin
  // over the parent's chain, which with same-era headers can never fire via a
  // single gossip. A gossiped header on an old branch that would in principle
  // outweigh is handled when the branch's own peer drives it through
  // `admitPage`'s pass 1 and pass 2.
  const _unused = chainWork;
  void _unused;
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
 * `held` / `refused` / `stored` / `scored` / `parent-unknown`, firing
 * `callbacks.penalize` on a refusal that carries one and
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

  let running = runningBranches.get(peerId);

  // One branch per peer: a page toward a newer non-empty claim replaces its
  // running branch (NODE_INTERFACE → Fork choice decides on verified headers
  // → "One branch per peer").
  if (running !== undefined && running.claimHash !== claimHash && claimHash !== '') {
    runningBranches.delete(peerId);
    running = undefined;
  }

  if (running === undefined) {
    // Start a new running branch at the first header's parent.
    const first = headers[0]!;
    const started = startRunningBranch(peerId, claimHash, first, ctx);
    if (started === null) {
      callbacks.penalize(peerId, 'misbehavior', 'page first header has no tree parent');
      return { accepted: false, outcome: 'refused', refusedAt: { index: 0, kind: 'misbehavior', reason: 'first-parent-unknown' } };
    }
    running = started;
  }

  // Verify the page: pass 1 continues from `nextAnchor`, pass 2 from
  // `storedAnchor` — each page builds on the anchor the previous page/base
  // left. The anchor's `prevBlockHash` is the running branch's current top
  // (pass 1) or last-stored (pass 2); `verifyHeaderChain`'s link step refuses
  // a page whose first header does not continue it.
  const anchorForVerify = running.mode === 'storing' ? running.storedAnchor : running.nextAnchor;
  const taForVerify = running.mode === 'storing' ? running.storedTa : running.nextTa;
  const verdict = verifyHeaderChain(headers, anchorForVerify, ctx.params, taForVerify, ctx.nowMs(), ctx.schedule);
  if (!verdict.ok) {
    if (verdict.reason === 'clock') {
      // No memo, no penalty.
      return { accepted: false, outcome: 'refused', refusedAt: { index: verdict.index, kind: 'none', reason: 'clock' } };
    }
    const kind: 'misbehavior' | 'transient' = verdict.reason === 'version' ? 'transient' : 'misbehavior';
    callbacks.penalize(peerId, kind, `page verify: ${verdict.reason}`);
    return { accepted: false, outcome: 'refused', refusedAt: { index: verdict.index, kind, reason: verdict.reason } };
  }

  // Any header in the page marked as refused?
  if (anyRefusedHeader(verdict.hashes)) {
    runningBranches.delete(peerId);
    callbacks.penalize(peerId, 'misbehavior', 'page contains a refused header');
    return { accepted: false, outcome: 'refused', refusedAt: { index: 0, kind: 'misbehavior', reason: 'contains-refused' } };
  }

  // Mode: scoring (pass 1) or storing (pass 2).
  if (running.mode === 'storing') {
    // Pass 2 (NODE_INTERFACE → Fork choice decides on verified headers →
    // "A side branch is stored only once it is heavier."): every recorded
    // height the page reaches must match pass 1's hash at that height; the
    // page is stored only once every one matches; the switch fires at the
    // header whose cumulative work exceeds the best tip's — pages before the
    // crossing store rows that are not best.
    const firstHeight = headers[0]!.height;
    const lastHeight = headers[headers.length - 1]!.height;
    for (let i = 0; i < running.recordedHeights.length; i++) {
      const rh = running.recordedHeights[i]!;
      if (rh < firstHeight || rh > lastHeight) continue;
      const localIdx = rh - firstHeight;
      if (verdict.hashes[localIdx] !== running.recordedHashes[i]) {
        callbacks.penalize(peerId, 'transient', 'pass-2 header off a recorded hash');
        return { accepted: false, outcome: 'refused', refusedAt: { index: localIdx, kind: 'transient', reason: 'recorded-mismatch' } };
      }
    }

    // The parent for the first header is either the virtual root pseudo-row
    // or the row at `storedTopHash` (either the branch's base or the last
    // stored header from a prior page).
    let parent: HeaderRow;
    if (running.storedUpTo === 0 && running.baseIsVirtualRoot) {
      parent = { hash: GENESIS_PREV_BLOCK_HASH, height: 0, prevHash: GENESIS_PREV_BLOCK_HASH, header: headers[0]!, interlinks: [], chainWork: 0n, pathTa: 0 };
    } else {
      const row = getHeaderRow(running.storedTopHash);
      if (row === null) {
        runningBranches.delete(peerId);
        return { accepted: false, outcome: 'refused', refusedAt: { index: 0, kind: 'none', reason: 'storedTop-missing' } };
      }
      parent = row;
    }

    // Store each header; track cumulative work; detect the crossing.
    const best = getBestTip();
    const bestWork = best ? best.chainWork : 0n;
    let cumulativeWork = running.storedWork;
    const freshHashes: string[] = [];
    let crossingIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]!;
      const hash = verdict.hashes[i]!;
      cumulativeWork += workOrZero(h.powTargetBits);
      const parentIsVirtual = parent.height === 0 && parent.hash === GENESIS_PREV_BLOCK_HASH;
      const parentLevel = parentIsVirtual ? null : level(parent.header, ctx.params.anchorBits);
      const storedInterlinks = h.height === 1
        ? []
        : (parentLevel === null ? [] : updateInterlinks(parent.interlinks, parent.hash, parentLevel));
      const pathTa = h.height === 1 ? h.createdAt : parent.pathTa;
      const row: HeaderRow = {
        hash,
        height: h.height,
        prevHash: h.prevBlockHash,
        header: h,
        interlinks: storedInterlinks,
        chainWork: cumulativeWork,
        pathTa,
      };
      insertHeader(row);
      freshHashes.push(hash);
      if (crossingIdx === -1 && !running.switched && cumulativeWork > bestWork) {
        crossingIdx = i;
      }
      parent = row;
    }

    // Switch at the crossing, or extend if already switched. Reachability
    // (precision 1) is checked only on the first switch: the candidate's fork
    // with the applied chain is `min(fork with best = baseHeight,
    // bestChainForkWithApplied)`.
    const branchHashesAfterPage = running.storedHashes.concat(freshHashes);
    const crossedThisPage = crossingIdx !== -1;
    if (crossedThisPage || running.switched) {
      if (crossedThisPage && !running.switched) {
        const candidateForkWithApplied = Math.min(running.baseHeight, bestChainForkWithApplied);
        if (candidateForkWithApplied < reachFloor(ctx)) {
          runningBranches.delete(peerId);
          return { accepted: false, outcome: 'refused', refusedAt: { index: crossingIdx, kind: 'none', reason: 'unreachable' } };
        }
        running.switched = true;
        bestChainForkWithApplied = Math.min(bestChainForkWithApplied, running.baseHeight);
      }
      rewriteBestChain(running.baseHeight, branchHashesAfterPage);
      scoredLighter.clear();
      callbacks.chainMoved();
    }

    // Update stored state.
    running.storedUpTo = headers[headers.length - 1]!.height;
    running.storedTopHash = verdict.hashes[verdict.hashes.length - 1]!;
    running.storedAnchor = {
      prevBlockHash: verdict.next.prevBlockHash,
      height: verdict.next.height,
      interlinks: verdict.next.interlinks,
      createdAt: verdict.next.createdAt,
    };
    running.storedTa = verdict.next.t_a;
    running.storedWork = cumulativeWork;
    running.storedHashes = branchHashesAfterPage;

    // Branch done when stored up to the last recorded height.
    const lastRecordedHeight = running.recordedHeights[running.recordedHeights.length - 1] ?? running.baseHeight;
    if (running.storedUpTo >= lastRecordedHeight) {
      runningBranches.delete(peerId);
      return { accepted: true, outcome: 'stored-from-pass-2' };
    }
    return { accepted: true, outcome: 'scored-partial' };
  }

  // Pass 1: update running state.
  running.topHeight = headers[headers.length - 1]!.height;
  running.topHash = verdict.hashes[verdict.hashes.length - 1]!;
  running.runningWork += verdict.work;
  running.nextAnchor = {
    prevBlockHash: verdict.next.prevBlockHash,
    height: verdict.next.height,
    interlinks: verdict.next.interlinks,
    createdAt: verdict.next.createdAt,
  };
  running.nextTa = verdict.next.t_a;
  // Record the last hash of this page (NODE_INTERFACE → Fork choice decides
  // on verified headers → "A side branch is stored only once it is heavier"):
  // when pages are 400 long these coincide with `f + 400k`.
  running.recordedHashes.push(running.topHash);
  running.recordedHeights.push(running.topHeight);

  const best = getBestTip();
  const bestWork = best ? best.chainWork : 0n;

  // Won: the branch's work exceeds the best tip's `chain_work`.
  if (running.runningWork > bestWork) {
    running.mode = 'storing';
    return { accepted: true, outcome: 'won' };
  }

  // Lighter at the claim: write memo, drop the running branch.
  if (claimHash !== '' && running.topHash === claimHash) {
    scoredLighter.set(peerId, claimHash);
    runningBranches.delete(peerId);
    return { accepted: true, outcome: 'lighter' };
  }

  // No-claim run (NET_INTERFACE → Sync Handler Registration): branch ends at
  // the peer's tip, the first page shorter than `MAX_CHAIN_RESPONSE_ITEMS`.
  if (claimHash === '' && headers.length < MAX_CHAIN_RESPONSE_ITEMS) {
    runningBranches.delete(peerId);
    return { accepted: true, outcome: 'lighter' };
  }

  return { accepted: true, outcome: 'scored-partial' };
}

/**
 * Start a new running branch at `first.prevBlockHash` — either the virtual
 * root at height 0 or a tree row's hash. Returns `null` when the base is not
 * discoverable.
 */
function startRunningBranch(
  peerId: string,
  claimHash: string,
  first: BlockHeader,
  ctx: PipelineContext,
): RunningBranch | null {
  if (first.height === 1) {
    if (first.prevBlockHash !== GENESIS_PREV_BLOCK_HASH) return null;
    const anchor = { prevBlockHash: GENESIS_PREV_BLOCK_HASH, height: 0, interlinks: [] as string[], createdAt: null as number | null };
    const r: RunningBranch = {
      claimHash,
      mode: 'scoring',
      baseHash: GENESIS_PREV_BLOCK_HASH,
      baseHeight: 0,
      basePathTa: null,
      baseIsVirtualRoot: true,
      baseChainWork: 0n,
      baseAnchor: anchor,
      baseTa: null,
      nextAnchor: { ...anchor },
      nextTa: null,
      runningWork: 0n,
      recordedHashes: [],
      recordedHeights: [],
      topHeight: 0,
      topHash: GENESIS_PREV_BLOCK_HASH,
      storedUpTo: 0,
      storedTopHash: GENESIS_PREV_BLOCK_HASH,
      storedAnchor: { ...anchor },
      storedTa: null,
      storedWork: 0n,
      storedHashes: [],
      switched: false,
    };
    runningBranches.set(peerId, r);
    return r;
  }
  const parent = getHeaderRow(first.prevBlockHash);
  if (parent === null) return null;
  const parentLevel = level(parent.header, ctx.params.anchorBits);
  if (parentLevel === null) return null;
  const anchor = {
    prevBlockHash: parent.hash,
    height: parent.height,
    interlinks: updateInterlinks(parent.interlinks, parent.hash, parentLevel),
    createdAt: parent.header.createdAt as number | null,
  };
  const r: RunningBranch = {
    claimHash,
    mode: 'scoring',
    baseHash: parent.hash,
    baseHeight: parent.height,
    basePathTa: parent.pathTa,
    baseIsVirtualRoot: false,
    baseChainWork: parent.chainWork,
    baseAnchor: anchor,
    baseTa: parent.pathTa,
    nextAnchor: { ...anchor },
    nextTa: parent.pathTa,
    runningWork: parent.chainWork,
    recordedHashes: [],
    recordedHeights: [],
    topHeight: parent.height,
    topHash: parent.hash,
    storedUpTo: parent.height,
    storedTopHash: parent.hash,
    storedAnchor: { ...anchor },
    storedTa: parent.pathTa,
    storedWork: parent.chainWork,
    storedHashes: [],
    switched: false,
  };
  runningBranches.set(peerId, r);
  return r;
}

/** NET_INTERFACE → Sync Handler Registration. */
export function knowsTip(peerId: string, hash: string): boolean {
  if (getHeaderRow(hash) !== null) return true;
  return scoredLighter.get(peerId) === hash;
}

/**
 * NET_INTERFACE → Sync Handler Registration. The locator follows
 * NET_INTERFACE → `GetHeaders` / `GetBlocks` responses: `h₀ = tip`,
 * `hᵢ₊₁ = hᵢ − 2ⁱ` while `≥ 1`, then height 1; at most `MAX_LOCATOR_HASHES`
 * entries; a node with no chain sends the root alone; a requester continuing
 * a branch it is scoring puts that branch's last scored hash first.
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
