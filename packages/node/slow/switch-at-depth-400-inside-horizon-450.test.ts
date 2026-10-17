import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDb, initDb } from '../src/store/db.js';
import {
  admitHeader,
  admitPage,
  resetPipelineForTests,
  type PipelineCallbacks,
  type PipelineContext,
} from '../src/services/header-pipeline.js';
import { getBestTip } from '../src/store/index.js';
import { defaultParams, makeChain, type ParentHeaderInfo } from '../test/helpers/make-header.js';
import type { BlockHeader } from '@dagsocial/types';

// NODE_INTERFACE → Fork choice decides on verified headers → "A side branch
// is stored only once it is heavier": pass 1 scores across pages until the
// branch outweighs the current best; pass 2 then stores page by page, each
// page's verify picking up from the anchor the previous page left.
//
// This case: a 450-horizon profile (maxReorgDepth 450). Our chain has 450
// headers. A competing branch forks at height 50 (depth 400 from our tip)
// and runs 451 headers above the fork — just enough to outweigh us. Pass 2
// delivers it in two pages: a first page of 400 headers that stores rows
// without switching, and a second page whose crossing header passes the
// shortest-heavier threshold and rewrites the best chain.

const PARAMS = defaultParams({
  anchorBits: 2304,
  floorBits: 2304,
  ceilingBits: 4096,
  idealMs: 60_000,
});

async function schedule() {
  return (await import('../src/config.js')).config.protocolVersionSchedule;
}

function recorder(): { chainMoves: () => number; callbacks: PipelineCallbacks } {
  let moves = 0;
  return {
    chainMoves: () => moves,
    callbacks: {
      penalize: () => {},
      chainMoved: () => { moves += 1; },
    },
  };
}

async function ctx(appliedTip = 0): Promise<PipelineContext> {
  return {
    params: PARAMS,
    schedule: await schedule(),
    nowMs: () => 1_700_000_000_000 + 300_000_000_000,
    maxReorgDepth: 450,
    genesisId: '',
    lowestJournalHeight: () => null,
    appliedTipHeight: () => appliedTip,
  };
}

describe('switch at depth 400 inside horizon 450', () => {
  beforeEach(async () => {
    vi.doMock('../src/config.js', async (orig) => {
      const actual = await (orig as () => Promise<typeof import('../src/config.js')>)();
      return {
        ...actual,
        config: { ...actual.config, maxReorgDepth: 450 },
      };
    });
    initDb(':memory:');
    resetPipelineForTests();
  });

  afterEach(() => {
    closeDb();
    vi.doUnmock('../src/config.js');
    vi.resetModules();
  });

  it('a competing branch of 451 headers above a fork at height 50 switches best over two pass-2 pages', async () => {
    // Our chain: 450 honest headers above the virtual root, admitted one at
    // a time so each extends the best chain.
    const ours = makeChain({ parent: null, n: 450, params: PARAMS, schedule: await schedule() });
    const { callbacks: cb0 } = recorder();
    for (const h of ours) admitHeader(h.header, 'headers-page', 'peerA', await ctx(), cb0);
    expect(getBestTip()!.hash).toBe(ours[449]!.hash);

    // Their branch: 451 headers above our height-50 header; same anchor bits,
    // one header heavier than our chain.
    const base: ParentHeaderInfo = ours[49]!;
    const theirs = makeChain({
      parent: base,
      n: 451,
      params: PARAMS,
      schedule: await schedule(),
      startAt: base.header.createdAt + PARAMS.idealMs + 1,
    });

    // Pass 1 across two pages — the first page's 400 headers add 400 anchor-
    // works to a base of 50, still 50 short of our 450; the second page's 51
    // headers tip the balance.
    const page1: BlockHeader[] = theirs.slice(0, 400).map((p) => p.header);
    const page2: BlockHeader[] = theirs.slice(400, 451).map((p) => p.header);
    const { callbacks: cbS } = recorder();
    const p1v1 = admitPage('peerB', theirs[450]!.hash, page1, await ctx(), cbS);
    expect(p1v1.accepted).toBe(true);
    expect(p1v1.outcome).toBe('scored-partial');
    const p1v2 = admitPage('peerB', theirs[450]!.hash, page2, await ctx(), cbS);
    expect(p1v2.accepted).toBe(true);
    expect(p1v2.outcome).toBe('won');

    // Pass 2 page 1 — 400 rows stored, cumulative work at page end equals
    // our best's 450 anchor-works, so nothing switches.
    const { chainMoves: moves1, callbacks: cb1 } = recorder();
    const p2v1 = admitPage('peerB', theirs[450]!.hash, page1, await ctx(), cb1);
    expect(p2v1.accepted).toBe(true);
    expect(p2v1.outcome).toBe('scored-partial');
    expect(moves1()).toBe(0);
    expect(getBestTip()!.hash).toBe(ours[449]!.hash);

    // Pass 2 page 2 — the second page's verify picks up from the anchor the
    // first page left; the first header crosses, the switch fires, the
    // remaining headers extend the new best.
    const { chainMoves: moves2, callbacks: cb2 } = recorder();
    const p2v2 = admitPage('peerB', theirs[450]!.hash, page2, await ctx(), cb2);
    // The last assertion names the rule: the best tip is the competing
    // branch's own tip (NODE_INTERFACE → Fork choice decides on verified
    // headers → "A side branch is stored only once it is heavier").
    expect(p2v2.accepted).toBe(true);
    expect(p2v2.outcome).toBe('stored-from-pass-2');
    expect(moves2()).toBeGreaterThan(0);
    expect(getBestTip()!.hash).toBe(theirs[450]!.hash);
  }, 120_000);
});
