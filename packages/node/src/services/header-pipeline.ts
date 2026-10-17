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
  getOrderingBlockHash,
  headersHeavierThan,
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

/**
 * NODE_INTERFACE → Sync handlers (pull-path) → "setPipeline(intake)": the
 * three verdicts of a page.
 */
export type PageOutcome = 'taken' | 'again' | 'refused';

/** Verdict for `admitPage`. */
export interface PageVerdict {
  outcome: PageOutcome;
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
 * The fork point of a branch, read from the branch's base.
 *
 * The invariant the result rests on (NODE_INTERFACE → Fork choice decides on
 * verified headers → "The reach floor is the horizon, one rule for every
 * fork point."): the best chain is chosen reachable, the applied tip moves
 * only along the best chain, and the floor moves only with the applied tip,
 * so a base on the best chain shares a fork point with the applied chain
 * at or above the floor — and returning the base's own height on first match
 * is correct. The applied-chain match is the direct one; the best-chain
 * match rides the invariant.
 *
 * Walks `prev_hash` down from the base to the first row on the applied
 * chain (`getOrderingBlockHash(h) === hash`), or on the best chain
 * (`getBestHashAt(h) === hash`); stops below the reach floor and answers
 * `-Infinity` (unreachable by construction). Height 0 is the virtual root,
 * a common ancestor at depth = our height, and resolves as `0`.
 */
function forkPointHeight(baseHash: string, baseHeight: number, floor: number): number {
  if (baseHeight === 0) return 0;
  let h = baseHash;
  let height = baseHeight;
  while (height >= 1 && height >= floor) {
    if (getOrderingBlockHash(height) === h) return height;
    const bestAtHeight = getBestHashAt(height);
    if (bestAtHeight === h) return height;
    const row = getHeaderRow(h);
    if (row === null) return -Infinity;
    h = row.prevHash;
    height = row.height - 1;
    if (height === 0) return 0;
  }
  return -Infinity;
}

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
   * Pass 2 continuation state: the last stored header on the branch, its
   * anchor and its cumulative work. The first pass-2 page's parent is
   * `baseHash` (nothing stored); each page after it, the hash it last stored.
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
 * The interlinks a header commits to — read from the parent's vector via
 * `updateInterlinks` (TYPES_INTERFACE → Interlink vector).
 */
function interlinksCommitFromParent(parent: HeaderRow, anchorBits: number): string[] {
  if (parent.height === 0 && parent.hash === GENESIS_PREV_BLOCK_HASH) return [];
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
  let parentRow: HeaderRow | null = null;
  let parentIsVirtualRoot = false;
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
    parentIsVirtualRoot = true;
  } else {
    const row = getHeaderRow(header.prevBlockHash);
    if (row === null) {
      if (source === 'gossip') return { kind: 'parent-unknown' };
      callbacks.penalize(peerId, 'misbehavior', 'parent is not in the header tree');
      return { kind: 'refused', reason: 'parent-unknown' };
    }
    parentRow = row;
  }

  // 3. Age rule.
  const parentHeight = parentIsVirtualRoot ? 0 : parentRow!.height;
  if (parentHeight < reachFloor(ctx)) {
    return { kind: 'refused', reason: 'below-reach-floor' };
  }

  // 4. Verification.
  const anchor = parentIsVirtualRoot
    ? { prevBlockHash: GENESIS_PREV_BLOCK_HASH, height: 0, interlinks: [] as string[], createdAt: null as number | null }
    : {
        prevBlockHash: parentRow!.hash,
        height: parentRow!.height,
        interlinks: interlinksCommitFromParent(parentRow!, ctx.params.anchorBits),
        createdAt: parentRow!.header.createdAt as number | null,
      };
  const anchorTa = parentIsVirtualRoot ? null : parentRow!.pathTa;
  const verdict = verifyHeaderChain([header], anchor, ctx.params, anchorTa, ctx.nowMs(), ctx.schedule);
  if (!verdict.ok) {
    if (verdict.reason === 'clock') {
      return { kind: 'refused', reason: 'clock' };
    }
    const kind: 'misbehavior' | 'transient' = verdict.reason === 'version' ? 'transient' : 'misbehavior';
    callbacks.penalize(peerId, kind, `verifyHeaderChain: ${verdict.reason}`);
    return { kind: 'refused', reason: verdict.reason };
  }

  // Store or score. A header extends the best chain when its parent is the
  // best tip (or the root while there is no best); any other admitted header
  // belongs to a side branch, and a side branch reaches the tree through its
  // passes alone.
  const parentChainWork = parentIsVirtualRoot ? 0n : parentRow!.chainWork;
  const chainWork = parentChainWork + verdict.work;
  const best = getBestTip();
  const extendsBest = best === null ? parentIsVirtualRoot : (parentRow !== null && parentRow.hash === best.hash);
  const pathTa = header.height === 1 ? header.createdAt : (parentIsVirtualRoot ? 0 : parentRow!.pathTa);
  const storedInterlinks = parentIsVirtualRoot
    ? []
    : interlinksCommitFromParent(parentRow!, ctx.params.anchorBits);

  if (extendsBest) {
    const row: HeaderRow = {
      hash,
      height: header.height,
      prevHash: header.prevBlockHash,
      header,
      interlinks: storedInterlinks,
      chainWork,
      pathTa,
    };
    insertHeader(row);
    rewriteBestChain(parentHeight, [hash]);
    scoredLighter.clear();
    callbacks.chainMoved();
    return { kind: 'stored', wasBest: true };
  }

  // A single header on a side branch is scored, not stored (the branch's
  // own pass drives any store).
  return { kind: 'scored' };
}

/** The parent row at the start of a running branch. */
interface BranchBase {
  isVirtualRoot: boolean;
  row: HeaderRow | null;
  hash: string;
  height: number;
  chainWork: bigint;
  interlinks: string[];
  createdAt: number | null;
  pathTa: number | null;
}

function resolveBase(parentHash: string, parentHeight: number): BranchBase | null {
  if (parentHeight === 0 && parentHash === GENESIS_PREV_BLOCK_HASH) {
    return {
      isVirtualRoot: true, row: null,
      hash: GENESIS_PREV_BLOCK_HASH, height: 0, chainWork: 0n,
      interlinks: [], createdAt: null, pathTa: null,
    };
  }
  const row = getHeaderRow(parentHash);
  if (row === null) return null;
  if (row.height !== parentHeight) return null;
  return {
    isVirtualRoot: false, row,
    hash: row.hash, height: row.height, chainWork: row.chainWork,
    interlinks: [], // filled by the caller when a verify anchor is needed
    createdAt: row.header.createdAt as number | null,
    pathTa: row.pathTa,
  };
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers →
 * "A side branch is stored only once it is heavier".
 *
 * Admit a page of headers. Resolves to one of three outcomes
 * (NODE_INTERFACE → Sync handlers (pull-path) → "setPipeline(intake)"):
 * `'taken'`, `'again'`, `'refused'`.
 */
export function admitPage(
  peerId: string,
  claimHash: string,
  headers: BlockHeader[],
  ctx: PipelineContext,
  callbacks: PipelineCallbacks,
): PageVerdict {
  if (headers.length === 0) return { outcome: 'taken' };

  // Skip leading headers the tree already holds — they are no-ops.
  let startIdx = 0;
  while (startIdx < headers.length && getHeaderRow(blockHash(headers[startIdx]!) ?? '') !== null) {
    startIdx += 1;
  }
  if (startIdx === headers.length) return { outcome: 'taken' };

  const firstFresh = headers[startIdx]!;
  const firstFreshParent = firstFresh.prevBlockHash;

  // Decide which branch this page belongs to. The parent of the first
  // not-held header names the branch:
  //   - a running branch's last stored header in pass 2 → that pass-2 run,
  //   - its last scored header in pass 1 → that pass-1 run,
  //   - the root or any stored row → a new admission (any running branch dropped).
  let running = runningBranches.get(peerId);
  let continuesPass1 = false;
  let continuesPass2 = false;
  if (running !== undefined) {
    if (running.mode === 'storing' && firstFreshParent === running.storedTopHash) {
      continuesPass2 = true;
    } else if (running.mode === 'scoring' && firstFreshParent === running.topHash) {
      continuesPass1 = true;
    } else {
      // Any other parent — including a claim mismatch mid-scoring — drops
      // the running branch (NODE_INTERFACE → Fork choice decides on verified
      // headers → "A side branch is stored only once it is heavier." →
      // "One branch per peer").
      runningBranches.delete(peerId);
      running = undefined;
    }
  }

  // At height 1 the parent is the virtual root; otherwise the first fresh
  // header's parent must be a tree row (continuing branch) or we admit a
  // new branch from a stored row or the root.
  let base: BranchBase | null;
  if (continuesPass1 || continuesPass2) {
    base = {
      isVirtualRoot: running!.baseIsVirtualRoot,
      row: running!.baseIsVirtualRoot ? null : getHeaderRow(running!.baseHash),
      hash: running!.baseHash,
      height: running!.baseHeight,
      chainWork: running!.baseChainWork,
      interlinks: running!.baseAnchor.interlinks,
      createdAt: running!.baseAnchor.createdAt,
      pathTa: running!.baseTa,
    };
  } else if (firstFresh.height === 1) {
    if (firstFreshParent !== GENESIS_PREV_BLOCK_HASH) {
      callbacks.penalize(peerId, 'misbehavior', 'page first header does not point at the virtual root');
      return { outcome: 'refused', refusedAt: { index: startIdx, kind: 'misbehavior', reason: 'parent-not-virtual-root' } };
    }
    if (ctx.genesisId !== '') {
      const h0 = blockHash(firstFresh);
      if (h0 !== ctx.genesisId) {
        callbacks.penalize(peerId, 'misbehavior', 'page first header mismatches the pinned genesisId');
        return { outcome: 'refused', refusedAt: { index: startIdx, kind: 'misbehavior', reason: 'genesis-id-mismatch' } };
      }
    }
    base = {
      isVirtualRoot: true, row: null,
      hash: GENESIS_PREV_BLOCK_HASH, height: 0, chainWork: 0n,
      interlinks: [], createdAt: null, pathTa: null,
    };
    // Age rule: a parent below the reach floor refuses the page with no
    // penalty — the root at height 0 included (NODE_INTERFACE → Fork choice
    // decides on verified headers → "The reach floor is the horizon, one
    // rule for every fork point.").
    if (base.height < reachFloor(ctx)) {
      return { outcome: 'refused', refusedAt: { index: startIdx, kind: 'none', reason: 'below-reach-floor' } };
    }
  } else {
    const resolved = resolveBase(firstFreshParent, firstFresh.height - 1);
    if (resolved === null) {
      callbacks.penalize(peerId, 'misbehavior', 'page first header has no tree parent');
      return { outcome: 'refused', refusedAt: { index: startIdx, kind: 'misbehavior', reason: 'first-parent-unknown' } };
    }
    base = resolved;
    if (base.height < reachFloor(ctx)) {
      return { outcome: 'refused', refusedAt: { index: startIdx, kind: 'none', reason: 'below-reach-floor' } };
    }
  }

  // The anchor and ta for verification: pass 2 reads the last-stored anchor,
  // pass 1 the last-scored one; a new branch reads the base's.
  let anchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null };
  let anchorTa: number | null;
  if (continuesPass2) {
    anchor = { ...running!.storedAnchor };
    anchorTa = running!.storedTa;
  } else if (continuesPass1) {
    anchor = { ...running!.nextAnchor };
    anchorTa = running!.nextTa;
  } else {
    anchor = base.isVirtualRoot
      ? { prevBlockHash: GENESIS_PREV_BLOCK_HASH, height: 0, interlinks: [], createdAt: null }
      : {
          prevBlockHash: base.row!.hash,
          height: base.row!.height,
          interlinks: interlinksCommitFromParent(base.row!, ctx.params.anchorBits),
          createdAt: base.row!.header.createdAt as number | null,
        };
    anchorTa = base.isVirtualRoot ? null : base.row!.pathTa;
  }

  const freshHeaders = headers.slice(startIdx);
  const verdict = verifyHeaderChain(freshHeaders, anchor, ctx.params, anchorTa, ctx.nowMs(), ctx.schedule);
  if (!verdict.ok) {
    if (verdict.reason === 'clock') {
      return { outcome: 'refused', refusedAt: { index: startIdx + verdict.index, kind: 'none', reason: 'clock' } };
    }
    const kind: 'misbehavior' | 'transient' = verdict.reason === 'version' ? 'transient' : 'misbehavior';
    callbacks.penalize(peerId, kind, `page verify: ${verdict.reason}`);
    runningBranches.delete(peerId);
    return { outcome: 'refused', refusedAt: { index: startIdx + verdict.index, kind, reason: verdict.reason } };
  }

  if (anyRefusedHeader(verdict.hashes)) {
    runningBranches.delete(peerId);
    callbacks.penalize(peerId, 'misbehavior', 'page contains a refused header');
    return { outcome: 'refused', refusedAt: { index: startIdx, kind: 'misbehavior', reason: 'contains-refused' } };
  }

  // Pass 2 — recorded-height match and store.
  if (continuesPass2) {
    return handlePass2(running!, verdict, freshHeaders, ctx, callbacks, peerId, startIdx);
  }

  // The base's parent is the best chain's tip (or the root while there is no
  // best) → extension. Store every header in the page as it is admitted.
  const bestTip = getBestTip();
  const extendsBest = bestTip === null ? base.isVirtualRoot : base.hash === bestTip.hash;
  if (extendsBest) {
    runningBranches.delete(peerId);
    let currentParent: HeaderRow | null = base.isVirtualRoot ? null : base.row;
    const freshHashes: string[] = [];
    let cumulativeWork = base.chainWork;
    for (let i = 0; i < freshHeaders.length; i++) {
      const h = freshHeaders[i]!;
      const hash = verdict.hashes[i]!;
      cumulativeWork += workOrZero(h.powTargetBits);
      const storedInterlinks = currentParent === null
        ? []
        : interlinksCommitFromParent(currentParent, ctx.params.anchorBits);
      const pathTa = h.height === 1 ? h.createdAt : (currentParent !== null ? currentParent.pathTa : h.createdAt);
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
      currentParent = row;
    }
    rewriteBestChain(base.height, freshHashes);
    scoredLighter.clear();
    callbacks.chainMoved();
    return { outcome: 'taken' };
  }

  // Pass 1 — score a side branch.
  // Initialise the running branch if this is its first page.
  let r: RunningBranch;
  if (!continuesPass1 || running === undefined) {
    r = {
      claimHash,
      mode: 'scoring',
      baseHash: base.hash,
      baseHeight: base.height,
      baseIsVirtualRoot: base.isVirtualRoot,
      baseChainWork: base.chainWork,
      baseAnchor: { prevBlockHash: anchor.prevBlockHash, height: anchor.height, interlinks: [...anchor.interlinks], createdAt: anchor.createdAt },
      baseTa: anchorTa,
      nextAnchor: { prevBlockHash: anchor.prevBlockHash, height: anchor.height, interlinks: [...anchor.interlinks], createdAt: anchor.createdAt },
      nextTa: anchorTa,
      runningWork: base.chainWork,
      recordedHashes: [],
      recordedHeights: [],
      topHeight: base.height,
      topHash: base.hash,
      storedUpTo: base.height,
      storedTopHash: base.hash,
      storedAnchor: { prevBlockHash: anchor.prevBlockHash, height: anchor.height, interlinks: [...anchor.interlinks], createdAt: anchor.createdAt },
      storedTa: anchorTa,
      storedWork: base.chainWork,
      storedHashes: [],
      switched: false,
    };
    runningBranches.set(peerId, r);
  } else {
    r = running;
  }

  r.runningWork += verdict.work;
  r.topHeight = freshHeaders[freshHeaders.length - 1]!.height;
  r.topHash = verdict.hashes[verdict.hashes.length - 1]!;
  r.nextAnchor = {
    prevBlockHash: verdict.next.prevBlockHash,
    height: verdict.next.height,
    interlinks: verdict.next.interlinks,
    createdAt: verdict.next.createdAt,
  };
  r.nextTa = verdict.next.t_a;
  r.recordedHashes.push(r.topHash);
  r.recordedHeights.push(r.topHeight);

  const bestTipForScore = getBestTip();
  const bestWork = bestTipForScore ? bestTipForScore.chainWork : 0n;

  // Won: the branch's work exceeds the best tip's.
  if (r.runningWork > bestWork) {
    // Won on the first page the branch opens in: store from the page in hand.
    const isFirstPage = r.recordedHashes.length === 1;
    if (isFirstPage) {
      return storeFirstWinningPage(peerId, r, verdict, freshHeaders, ctx, callbacks);
    }
    // Won on a later page: re-fetch from the base — the locator's base is
    // first, every page continues from the last header stored.
    r.mode = 'storing';
    return { outcome: 'again' };
  }

  // Lighter at the claim: the claim lies among this page's scored hashes
  // with the branch not won (NODE_INTERFACE → Fork choice decides on
  // verified headers → "A side branch is stored only once it is heavier." →
  // "The stop rules"). A peer whose tip grew past its claim serves a page
  // that passes the claimed hash without ending on it; the memo covers it,
  // and the chain view answers `knowsTip(claim)` true so net's refute test
  // marks no honest peer.
  if (claimHash !== '' && verdict.hashes.includes(claimHash)) {
    scoredLighter.set(peerId, claimHash);
    runningBranches.delete(peerId);
    return { outcome: 'taken' };
  }

  // No-claim run: the branch ends at the peer's tip, the first page shorter
  // than `MAX_CHAIN_RESPONSE_ITEMS`.
  if (claimHash === '' && headers.length < MAX_CHAIN_RESPONSE_ITEMS) {
    runningBranches.delete(peerId);
    return { outcome: 'taken' };
  }

  return { outcome: 'taken' };
}

/**
 * Store the first winning pass-1 page as pass 2 would, and switch if the
 * branch is reachable. The branch is dropped after the page is stored (it
 * was won inside the page it started in).
 */
function storeFirstWinningPage(
  peerId: string,
  r: RunningBranch,
  verdict: Extract<ReturnType<typeof verifyHeaderChain>, { ok: true }>,
  freshHeaders: BlockHeader[],
  ctx: PipelineContext,
  callbacks: PipelineCallbacks,
): PageVerdict {
  const floor = reachFloor(ctx);
  const fork = forkPointHeight(r.baseHash, r.baseHeight, floor);
  if (fork < floor) {
    runningBranches.delete(peerId);
    return { outcome: 'refused', refusedAt: { index: 0, kind: 'none', reason: 'unreachable' } };
  }
  const parentRow: HeaderRow | null = r.baseIsVirtualRoot ? null : getHeaderRow(r.baseHash);
  const freshHashes: string[] = [];
  let cumulativeWork = r.baseChainWork;
  let currentParent: HeaderRow | null = parentRow;
  for (let i = 0; i < freshHeaders.length; i++) {
    const h = freshHeaders[i]!;
    const hash = verdict.hashes[i]!;
    cumulativeWork += workOrZero(h.powTargetBits);
    const storedInterlinks = currentParent === null
      ? []
      : interlinksCommitFromParent(currentParent, ctx.params.anchorBits);
    const pathTa = h.height === 1 ? h.createdAt : (currentParent !== null ? currentParent.pathTa : h.createdAt);
    const row: HeaderRow = {
      hash, height: h.height, prevHash: h.prevBlockHash, header: h,
      interlinks: storedInterlinks, chainWork: cumulativeWork, pathTa,
    };
    insertHeader(row);
    freshHashes.push(hash);
    currentParent = row;
  }
  rewriteBestChain(r.baseHeight, freshHashes);
  scoredLighter.clear();
  callbacks.chainMoved();
  runningBranches.delete(peerId);
  return { outcome: 'taken' };
}

/**
 * Pass 2 — recorded-height match, store rows, detect the switch, continue
 * until the last recorded height is reached.
 */
function handlePass2(
  r: RunningBranch,
  verdict: Extract<ReturnType<typeof verifyHeaderChain>, { ok: true }>,
  freshHeaders: BlockHeader[],
  ctx: PipelineContext,
  callbacks: PipelineCallbacks,
  peerId: string,
  startIdx: number,
): PageVerdict {
  const firstHeight = freshHeaders[0]!.height;
  const lastHeight = freshHeaders[freshHeaders.length - 1]!.height;
  for (let i = 0; i < r.recordedHeights.length; i++) {
    const rh = r.recordedHeights[i]!;
    if (rh < firstHeight || rh > lastHeight) continue;
    const localIdx = rh - firstHeight;
    if (verdict.hashes[localIdx] !== r.recordedHashes[i]) {
      runningBranches.delete(peerId);
      callbacks.penalize(peerId, 'transient', 'pass-2 header off a recorded hash');
      return { outcome: 'refused', refusedAt: { index: startIdx + localIdx, kind: 'transient', reason: 'recorded-mismatch' } };
    }
  }

  const storedTopIsVirtualRoot = r.baseIsVirtualRoot && r.storedUpTo === 0;
  let currentParent: HeaderRow | null = storedTopIsVirtualRoot
    ? null
    : getHeaderRow(r.storedTopHash);
  const best = getBestTip();
  const bestWork = best ? best.chainWork : 0n;
  let cumulativeWork = r.storedWork;
  const freshHashes: string[] = [];
  let crossedThisPage = false;
  for (let i = 0; i < freshHeaders.length; i++) {
    const h = freshHeaders[i]!;
    const hash = verdict.hashes[i]!;
    cumulativeWork += workOrZero(h.powTargetBits);
    const storedInterlinks = currentParent === null
      ? []
      : interlinksCommitFromParent(currentParent, ctx.params.anchorBits);
    const pathTa = h.height === 1 ? h.createdAt : (currentParent !== null ? currentParent.pathTa : h.createdAt);
    const row: HeaderRow = {
      hash, height: h.height, prevHash: h.prevBlockHash, header: h,
      interlinks: storedInterlinks, chainWork: cumulativeWork, pathTa,
    };
    insertHeader(row);
    freshHashes.push(hash);
    if (!crossedThisPage && !r.switched && cumulativeWork > bestWork) crossedThisPage = true;
    currentParent = row;
  }

  const branchHashesAfterPage = r.storedHashes.concat(freshHashes);
  if (crossedThisPage || r.switched) {
    if (crossedThisPage && !r.switched) {
      // Reachability: the branch's fork with the applied chain is the base's
      // fork — a walk from the base through `prev_hash` to the first row on
      // the applied chain. Below the floor is unreachable.
      const floor = reachFloor(ctx);
      const fork = forkPointHeight(r.baseHash, r.baseHeight, floor);
      if (fork < floor) {
        runningBranches.delete(peerId);
        return { outcome: 'refused', refusedAt: { index: 0, kind: 'none', reason: 'unreachable' } };
      }
      r.switched = true;
    }
    rewriteBestChain(r.baseHeight, branchHashesAfterPage);
    scoredLighter.clear();
    callbacks.chainMoved();
  }

  r.storedUpTo = freshHeaders[freshHeaders.length - 1]!.height;
  r.storedTopHash = verdict.hashes[verdict.hashes.length - 1]!;
  r.storedAnchor = {
    prevBlockHash: verdict.next.prevBlockHash,
    height: verdict.next.height,
    interlinks: verdict.next.interlinks,
    createdAt: verdict.next.createdAt,
  };
  r.storedTa = verdict.next.t_a;
  r.storedWork = cumulativeWork;
  r.storedHashes = branchHashesAfterPage;

  const lastRecordedHeight = r.recordedHeights[r.recordedHeights.length - 1] ?? r.baseHeight;
  if (r.storedUpTo >= lastRecordedHeight) {
    runningBranches.delete(peerId);
    return { outcome: 'taken' };
  }
  return { outcome: 'again' };
}

/**
 * NET_INTERFACE → Sync Handler Registration. The chain view knows the root
 * (NODE_INTERFACE → Fork choice decides on verified headers → "The header
 * tree is every stored header." → virtual root).
 */
export function knowsTip(peerId: string, hash: string): boolean {
  if (hash === GENESIS_PREV_BLOCK_HASH) return true;
  if (getHeaderRow(hash) !== null) return true;
  return scoredLighter.get(peerId) === hash;
}

/**
 * NET_INTERFACE → Sync Handler Registration. The locator follows
 * NET_INTERFACE → `GetHeaders` / `GetBlocks` responses: `h₀ = tip`,
 * `hᵢ₊₁ = hᵢ − 2ⁱ` while `≥ 1`, then height 1; at most `MAX_LOCATOR_HASHES`
 * entries; a node with no chain sends the root alone; a requester continuing
 * a branch it is scoring puts the last scored hash first; one re-fetching a
 * branch it scored heavier puts the branch's last stored header — its base,
 * before any is stored — first.
 */
export function locatorFor(peerId: string): string[] {
  const tip = getBestTip();
  const running = runningBranches.get(peerId);
  const out: string[] = [];
  if (running !== undefined) {
    if (running.mode === 'storing') {
      out.push(running.storedTopHash);
    } else {
      out.push(running.topHash);
    }
  }
  if (tip === null) {
    if (out.length === 0) out.push(GENESIS_PREV_BLOCK_HASH);
    return out;
  }
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
 * NODE_INTERFACE → Fork choice decides on verified headers → "The best chain
 * is the heaviest reachable branch.": after a mark removes a header from
 * under the best chain, read `headersHeavierThan(incumbentWork)` in order;
 * the first row whose branch is reachable is the new tip, and `best_chain`
 * is rewritten from where its path meets the current index. None reachable
 * keeps what remains.
 */
export function rechooseBestChain(ctx: PipelineContext, callbacks: PipelineCallbacks): void {
  const floor = reachFloor(ctx);
  const incumbent = getBestTip();
  const incumbentWork = incumbent === null ? 0n : incumbent.chainWork;
  const candidates = headersHeavierThan(incumbentWork);
  for (const row of candidates) {
    // Walk down the row's prev_hash to the fork point with what remains of
    // the best chain (an on-chain row the index still holds) or to the root.
    const branchHashes: string[] = [];
    let h: HeaderRow | null = row;
    let forkHeight = 0;
    let unreachable = false;
    while (h !== null) {
      if (h.height === 0) { forkHeight = 0; break; }
      const bestAtHeight = getBestHashAt(h.height);
      if (bestAtHeight === h.hash) { forkHeight = h.height; break; }
      branchHashes.unshift(h.hash);
      if (h.height - 1 < floor) { unreachable = true; break; }
      if (h.height === 1) { forkHeight = 0; break; }
      h = getHeaderRow(h.prevHash);
    }
    if (unreachable || h === null) continue;
    rewriteBestChain(forkHeight, branchHashes);
    scoredLighter.clear();
    callbacks.chainMoved();
    return;
  }
  // No reachable header heavier than the incumbent — keep what remains.
  scoredLighter.clear();
  callbacks.chainMoved();
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
}

/** Internal helper for cases that argue work bounds. */
export function headerWork(header: BlockHeader): bigint {
  return workOrZero(header.powTargetBits);
}
