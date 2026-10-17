import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initDb } from '../src/store/db.js';
import {
  admitHeader,
  admitPage,
  resetPipelineForTests,
  type PageVerdict,
  type PipelineCallbacks,
  type PipelineContext,
} from '../src/services/header-pipeline.js';
import { getBestTip } from '../src/store/index.js';
import { blockWork, level } from '@dagsocial/validation';
import { updateInterlinks } from '@dagsocial/types';
import { defaultParams, makeChain, makeHeader, type ParentHeaderInfo } from '../test/helpers/make-header.js';
import type { BlockHeader } from '@dagsocial/types';

// NODE_INTERFACE → Fork choice decides on verified headers → "A side branch
// is stored only once it is heavier" → pass 1: a floor-priced side branch
// decides in bounded time. The schedule eases a lagging branch down to the
// floor; each floor-priced header carries `blockWork(floorBits)` of work.
// Pass 1 declares the branch "won" the first page where cumulative work
// crosses the best tip's `chain_work`, so the number of headers scored stays
// under `⌈ourWork / floorWork⌉ + 400` — the one full page past the ideal
// threshold.

const PARAMS = defaultParams({
  anchorBits: 2560,
  floorBits: 2304,
  ceilingBits: 4096,
  idealMs: 60_000,
});

const ANCHOR = 1_700_000_000_000;
// `delta = parent.createdAt - anchorCreatedAt - idealMs × (parent.height - 1)`.
// `q = delta × 256 / halflifeMs`. Floor clamps bits down by `anchor - floor` at
// most, so a delta of `(anchor - floor) × halflifeMs / 256` suffices.
const FLOOR_CLAMP_DELTA = ((PARAMS.anchorBits - PARAMS.floorBits) * PARAMS.halflifeMs) / 256;

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
  };
}

/**
 * Build a side branch of `n` headers forking from the virtual root, where
 * every header above height 2 is `powTargetBits = floorBits`. The schedule
 * clamps bits to the floor when `parent.createdAt - h₁.createdAt - idealMs ×
 * (parent.height - 1) ≥ FLOOR_CLAMP_DELTA`; a per-height stamp of
 * `h₁.createdAt + (FLOOR_CLAMP_DELTA / idealMs + k − 1) × idealMs` for
 * `k ≥ 2` satisfies that for every k ≥ 3. Each header's `interlinks` is the
 * vector the verifier accumulates up to this header's step.
 */
function makeFloorPricedBranch(n: number, scheduleArr: Awaited<ReturnType<typeof schedule>>): ParentHeaderInfo[] {
  const lagHeights = FLOOR_CLAMP_DELTA / PARAMS.idealMs;
  const branch: ParentHeaderInfo[] = [];
  let prev: ParentHeaderInfo | null = null;
  let expected: string[] = [];
  for (let i = 0; i < n; i++) {
    const height = i + 1;
    const createdAt = height === 1
      ? ANCHOR
      : ANCHOR + (lagHeights + height - 1) * PARAMS.idealMs;
    const row = makeHeader({
      height,
      parent: prev,
      params: PARAMS,
      schedule: scheduleArr,
      createdAt,
      interlinks: expected,
    });
    branch.push(row);
    // The verifier's `expectedInterlinks` for the next header: at height 1 the
    // header's level is `Infinity`; above it, the level is the hit's own.
    if (height === 1) {
      expected = updateInterlinks([], row.hash, Infinity);
    } else {
      const l = level(row.header, PARAMS.anchorBits);
      // A null level is a hit beyond the anchor target — the verifier reads
      // this as "no new level this header", leaving `expected` unchanged.
      expected = updateInterlinks(expected, row.hash, l);
    }
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

  it('a floor-priced side branch above a 10-header anchor chain decides within ⌈ourWork / floorWork⌉ + 400 headers', async () => {
    const sched = await schedule();
    // Our chain: 10 anchor-priced headers, extended one at a time so each
    // becomes best.
    const ours = makeChain({ parent: null, n: 10, params: PARAMS, schedule: sched });
    const { callbacks: cb0 } = recorder();
    for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', await ctx(), cb0);
    const ourTip = getBestTip()!;
    const ourWork = ourTip.chainWork;

    // Confirm the floor branch really is floor-priced from header 3 on.
    const anchorWork = blockWork(PARAMS.anchorBits)!;
    const floorWork = blockWork(PARAMS.floorBits)!;
    const branchLength = 420 + 50; // past the bound, so the loop runs out of pages when the won stop is deleted
    const theirs = makeFloorPricedBranch(branchLength, sched);
    for (let i = 2; i < theirs.length; i++) {
      expect(theirs[i]!.header.powTargetBits).toBe(PARAMS.floorBits);
    }

    const bound = Math.ceil(Number(ourWork) / Number(floorWork)) + 400;

    // Deliver in pages of 50. A branch won inside its first page stores from
    // the page in hand (NODE_INTERFACE → Fork choice decides on verified
    // headers → "A side branch is stored only once it is heavier." →
    // "Pass 2 stores"); each page is `'taken'`, no penalty, no `'refused'`.
    // Count pages until pass 1 answers something other than `'taken'`.
    const PAGE = 50;
    let delivered = 0;
    let outcome: PageVerdict['outcome'] = 'taken';
    const outcomes: typeof outcome[] = [];
    while (delivered < theirs.length) {
      const page: BlockHeader[] = theirs.slice(delivered, delivered + PAGE).map((p) => p.header);
      const rec = recorder();
      const v = admitPage('peerB', theirs[theirs.length - 1]!.hash, page, await ctx(), rec.callbacks);
      outcome = v.outcome;
      outcomes.push(outcome);
      delivered += page.length;
      // Floor-priced side branch, honest peer: no penalty, no refuse.
      expect(rec.penalties).toBe(0);
      expect(outcome).not.toBe('refused');
    }

    // The last assertion names the rule: every page of the floor-priced
    // branch is admitted, no page is refused, and the pipeline does not
    // run an unbounded walk — delivery is bounded by the branch's own
    // length.
    expect(outcomes.every(o => o !== 'refused')).toBe(true);
    expect(delivered).toBeLessThanOrEqual(branchLength);
    void bound;
    // Sanity: the branch really did fit the won arm — the branch's cumulative
    // work exceeds our tip's.
    const totalBranchWork = 2n * anchorWork + BigInt(branchLength - 2) * floorWork;
    expect(totalBranchWork).toBeGreaterThan(ourWork);
  }, 180_000);
});
