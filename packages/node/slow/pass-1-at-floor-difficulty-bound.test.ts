import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initDb } from '../src/store/db.js';
import {
  admitHeader,
  admitPage,
  resetPipelineForTests,
  type PageOutcome,
  type PipelineCallbacks,
  type PipelineContext,
} from '../src/services/header-pipeline.js';
import { getBestTip } from '../src/store/index.js';
import { blockWork, level } from '@dagsocial/validation';
import { updateInterlinks } from '@dagsocial/types';
import { defaultParams, makeChain, makeHeader, type ParentHeaderInfo } from '../test/helpers/make-header.js';
import type { BlockHeader } from '@dagsocial/types';

// NODE_INTERFACE → Fork choice decides on verified headers → "A side branch
// is stored only once it is heavier" → "The walk needs no cap": pass 1 scores
// a side branch across pages until the branch's work passes the best tip's.
// A floor-priced branch above a reach-floor base takes at most
// `⌈ourWorkAbove_f / floorWork⌉ + 400` headers to decide — the one full page
// past the ideal threshold.

const PARAMS = defaultParams({
  anchorBits: 2560,
  floorBits: 2304,
  ceilingBits: 4096,
  idealMs: 60_000,
});

const ANCHOR = 1_700_000_000_000;
// `delta = parent.createdAt - pathTa - idealMs × (parent.height - 1)`;
// `floorBits` fires at `delta ≥ halflifeMs`. The branch's first header lags
// its parent by `halflifeMs + idealMs`, so every branch header past it has
// delta exactly `halflifeMs`.
const BRANCH_LAG_MS = PARAMS.halflifeMs + PARAMS.idealMs;

async function schedule() {
  return (await import('../src/config.js')).config.protocolVersionSchedule;
}

function recorder(): { penalties: number; callbacks: PipelineCallbacks } {
  let penalties = 0;
  return {
    get penalties() { return penalties; },
    callbacks: {
      penalize: () => { penalties += 1; },
      chainMoved: () => {},
    },
  };
}

async function ctx(): Promise<PipelineContext> {
  return {
    params: PARAMS,
    schedule: await schedule(),
    nowMs: () => ANCHOR + 4_000 * PARAMS.idealMs,
    maxReorgDepth: 50_000,
    genesisId: '',
    lowestJournalHeight: () => null,
    appliedTipHeight: () => 0,
    canExtendAppliedTipAsBlockInHand: () => false,
  };
}

/**
 * Build a floor-priced side branch above `base` (at height `F`). The first
 * branch header's `createdAt` lags its parent by `BRANCH_LAG_MS`, so the
 * schedule clamps every header above it to the floor. The first header is
 * at anchor bits (its delta from the base is 0); every header above it is
 * at floor bits.
 */
function makeFloorPricedSideBranch(
  base: ParentHeaderInfo,
  n: number,
  scheduleArr: Awaited<ReturnType<typeof schedule>>,
): ParentHeaderInfo[] {
  const branch: ParentHeaderInfo[] = [];
  let prev = base;
  // The branch's first header's parent is `base`, whose level the yardstick
  // can answer (`ours` is anchor-priced). Above that, a parent's level may be
  // null — the vector passes through unchanged, as `updateInterlinks` answers
  // for null. Interlinks are precomputed so `makeHeader` reads them rather
  // than recomputing from `level` (which would throw on a null answer).
  const baseLevel = level(base.header, PARAMS.anchorBits);
  if (baseLevel === null) throw new Error('base level is null — the yardstick cannot answer the base');
  let expected = updateInterlinks(base.interlinks, base.hash, baseLevel);
  for (let i = 0; i < n; i++) {
    const createdAt = i === 0
      ? base.header.createdAt + BRANCH_LAG_MS
      : prev.header.createdAt + PARAMS.idealMs;
    const row = makeHeader({
      height: base.header.height + 1 + i,
      parent: prev,
      params: PARAMS,
      schedule: scheduleArr,
      createdAt,
      interlinks: expected,
    });
    branch.push(row);
    expected = updateInterlinks(expected, row.hash, level(row.header, PARAMS.anchorBits));
    prev = row;
  }
  return branch;
}

describe('pass 1 at floor difficulty is bounded', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetPipelineForTests();
  });
  afterEach(() => { closeDb(); });

  it('a floor-priced side branch decides pass 1 within ⌈ourWorkAbove_f / floorWork⌉ + 400 headers, then pass 2 stores and the best chain switches', async () => {
    const sched = await schedule();
    // Our chain: 50 anchor-priced headers, admitted one at a time so each
    // extends the best chain. The best tip's `chain_work` is 50 anchor-works.
    // `N` and `F` are chosen so the branch's cumulative work does not pass
    // the best tip's inside its first page: anchor-work is twice floor-work,
    // so page 1 adds `anchorWork + 49 × floorWork = 51 × floorWork` and the
    // best tip stands at `2N × floorWork`. With `N = 50` and `F = 20` the
    // branch sits at `40 + 51 = 91 × floorWork` after page 1 — under the
    // best tip's `100 × floorWork` — and page 2 pushes it to `141 × floorWork`,
    // winning on a page other than its first and firing `'again'`.
    const N = 50;
    const F = 20;
    const ours = makeChain({ parent: null, n: N, params: PARAMS, schedule: sched });
    const { callbacks: cb0 } = recorder();
    for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', await ctx(), cb0);
    const ourTip = getBestTip()!;
    const ourWork = ourTip.chainWork;

    // Fork at height F. The branch's first header is anchor-priced; every
    // header above it is floor-priced.
    const base = ours[F - 1]!;
    const anchorWork = blockWork(PARAMS.anchorBits)!;
    const floorWork = blockWork(PARAMS.floorBits)!;
    const ourWorkAboveF = BigInt(N - F) * anchorWork;
    const bound = Math.ceil(Number(ourWorkAboveF) / Number(floorWork)) + 400;

    // Build the branch longer than the bound would need, so a run with no
    // bound would keep going past it.
    const branchLength = bound + 50;
    const theirs = makeFloorPricedSideBranch(base, branchLength, sched);
    // Sanity: every header above the first is at floor bits.
    for (let i = 1; i < theirs.length; i++) {
      expect(theirs[i]!.header.powTargetBits).toBe(PARAMS.floorBits);
    }
    expect(theirs[0]!.header.powTargetBits).toBe(PARAMS.anchorBits);

    // Pass 1 — deliver pages until the first `'again'`.
    const PAGE = 50;
    let deliveredPass1 = 0;
    let firstAgainAt = -1;
    while (deliveredPass1 < theirs.length) {
      const slice = theirs.slice(deliveredPass1, deliveredPass1 + PAGE);
      const page: BlockHeader[] = slice.map((p) => p.header);
      const rec = recorder();
      const v = admitPage('peerB', theirs[theirs.length - 1]!.hash, page, await ctx(), rec.callbacks);
      deliveredPass1 += slice.length;
      expect(rec.penalties).toBe(0);
      expect(v.outcome).not.toBe('refused');
      if (v.outcome === 'again') {
        firstAgainAt = deliveredPass1;
        break;
      }
    }
    expect(firstAgainAt).toBeGreaterThan(0);

    // Pass 2 — the scheduler re-asks from the branch's base; deliver page by
    // page. The running branch's 'taken' arrives at the last recorded pass-1
    // height; the pages above it extend the new best tip through the normal
    // extension arm.
    let deliveredPass2 = 0;
    const outcomes: PageOutcome[] = [];
    while (deliveredPass2 < theirs.length) {
      const slice = theirs.slice(deliveredPass2, deliveredPass2 + PAGE);
      const page: BlockHeader[] = slice.map((p) => p.header);
      const rec = recorder();
      const v = admitPage('peerB', theirs[theirs.length - 1]!.hash, page, await ctx(), rec.callbacks);
      outcomes.push(v.outcome);
      expect(rec.penalties).toBe(0);
      expect(v.outcome).not.toBe('refused');
      deliveredPass2 += slice.length;
    }

    // Pass 2 stored the branch; the switch moved the best tip to the branch's
    // last header. The branch's cumulative work above the fork — one anchor
    // header plus `(branchLength − 1)` floor headers — exceeds our tip's.
    const branchTotalWork = BigInt(F) * anchorWork + anchorWork + BigInt(branchLength - 1) * floorWork;
    expect(branchTotalWork).toBeGreaterThan(ourWork);
    expect(getBestTip()!.hash).toBe(theirs[theirs.length - 1]!.hash);

    // The last assertion names the rule: pass 1 decided — the first `'again'`
    // fired — within `⌈ourWorkAbove_f / floorWork⌉ + 400` headers.
    expect(firstAgainAt).toBeLessThanOrEqual(bound);
  }, 180_000);
});
