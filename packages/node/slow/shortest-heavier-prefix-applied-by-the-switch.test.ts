import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OrderingBlock } from '@dagsocial/types';
import { encodeOrderingBlock } from '@dagsocial/types';
import {
  importBlockCreator,
  importDb,
  initChainStore,
  startCreator,
  testConfig,
} from '../test/services/fork-resolution-fixtures.js';
import { mineNextBlock } from '../test/helpers.js';
import { makeChain } from '../test/helpers/make-header.js';
import type { RetargetParams } from '@dagsocial/validation';
import {
  admitPage,
  resetPipelineForTests,
  type PipelineCallbacks,
  type PipelineContext,
} from '../src/services/header-pipeline.js';
import { stageBlock } from '../src/store/header-tree.js';

// NODE_INTERFACE → Fork choice decides on verified headers → "The switch of
// the index": a reorg applies the shortest heavier prefix of the best chain
// above the fork — the walk collects best-chain hashes until the cumulative
// `chain_work` passes the applied tip's and stops at that height, so the
// branch's remaining headers extend the new best through staging.
//
// Setup: an applied chain of two mined blocks (bestWork at tip = 2 × anchor
// work). A competing branch of five headers above the virtual root is
// admitted through the pipeline — pass 2 rewrites `best_chain` to the new
// branch. The switch is triggered by `trySwitch`, which prepares the prefix
// before firing `reorgFn`; a stub for `reorgFn` records the prefix it was
// handed.

async function sched() {
  return (await import('../src/config.js')).config.protocolVersionSchedule;
}

async function branchParams(): Promise<RetargetParams> {
  const { retargetParams } = await import('../src/services/difficulty.js');
  return retargetParams();
}

function recorder(): { chainMoves: number; callbacks: PipelineCallbacks } {
  const state = { chainMoves: 0 };
  const callbacks: PipelineCallbacks = {
    penalize: () => {},
    chainMoved: () => { state.chainMoves += 1; },
  };
  return new Proxy(state, {
    get: (t, k) => k === 'callbacks' ? callbacks : (t as Record<string | symbol, unknown>)[k],
  }) as { chainMoves: number; callbacks: PipelineCallbacks };
}

async function pipelineCtx(appliedTip: number): Promise<PipelineContext> {
  return {
    params: await branchParams(),
    schedule: await sched(),
    nowMs: () => 1_700_000_000_000 + 300_000_000_000,
    maxReorgDepth: 1_000,
    genesisId: '',
    // A joiner node holds every journal down to height 1, so every fork point
    // at or above the virtual root is reachable (NODE_INTERFACE → Fork choice
    // decides on verified headers → "The reach floor is the horizon").
    lowestJournalHeight: () => 1,
    appliedTipHeight: () => appliedTip,
    canExtendAppliedTipAsBlockInHand: () => false,
  };
}

describe('the switch applies the shortest heavier prefix of the best chain', () => {
  beforeEach(async () => {
    await initChainStore();
    resetPipelineForTests();
  });

  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not imported */ }
    const { clearIntakeSeamsForTests } = await import('../src/services/intake.js');
    clearIntakeSeamsForTests();
    const db = await importDb();
    db.closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('reorg is handed the first three branch hashes — the first height whose chainWork exceeds the applied tip\'s', async () => {
    // Apply two anchor-priced blocks of our chain. Each adds anchorWork, so
    // the applied tip's `chain_work` is 2 anchor-works.
    await startCreator(testConfig);
    const bc = await importBlockCreator();
    const a1 = await mineNextBlock(bc);
    const a2 = await mineNextBlock(bc);
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();

    // Build the competing branch — 5 headers forking from the virtual root.
    // Each header carries one anchor-work of cumulative work:
    //   theirs[0]: 1 anchor-work  — not heavier than applied tip (2)
    //   theirs[1]: 2 anchor-works — equal, not heavier
    //   theirs[2]: 3 anchor-works — first heavier, where the prefix stops
    //   theirs[3]: 4 anchor-works
    //   theirs[4]: 5 anchor-works
    const params = await branchParams();
    const theirs = makeChain({
      parent: null,
      n: 5,
      params,
      schedule: await sched(),
      startAt: 1_900_000_000_000,
    });
    // The branch's path has to switch each header off ours; override the
    // first so its hash differs from the applied height-1 block. `makeChain`
    // already produces independent headers.

    // Admit through the pipeline — pass 1 wins, pass 2 stores and rewrites.
    const headers = theirs.map((p) => p.header);
    const { callbacks: cb1 } = recorder();
    const p1 = admitPage('peerB', theirs[4]!.hash, headers, await pipelineCtx(2), cb1);
    expect(p1.outcome).toBe('taken');

    // Stage valid-decoding bodies for every competing hash — `trySwitch`
    // reads each prefix hash through `getStagedBlock`, and a null answer
    // leaves the switch deferred.
    for (const t of theirs) {
      const body: OrderingBlock = {
        header: t.header,
        utxoTxTree: { utxoTxIds: [], utxoTxs: [] },
        validatorSignature: new Uint8Array(64),
      };
      stageBlock(t.hash, t.header.height, encodeOrderingBlock(body), 'peerB');
    }

    // Stub `reorgFn` to record the prefix it is given — the shortest heavier
    // prefix the switch collected.
    const intake = await import('../src/services/intake.js');
    let captured: { f: number; hashes: readonly string[] } | null = null;
    intake.setIntakeSeamsForTests({
      reorg: (f, hs) => { captured = { f, hashes: hs.slice() }; },
    });

    // The pipeline's own callbacks are wired now; initialising the intake
    // lets `trySwitch` run — the chain view's state is what the test holds.
    intake.initIntake(
      { penalize: () => {}, chainMoved: () => {}, needHeaders: () => {} },
      await pipelineCtx(2),
    );

    // Pass 2 — rewrites `best_chain` to the competing branch. `trySwitch`
    // fires inside `admitPage`'s drain seam; the stub records the prefix.
    const { callbacks: cb2 } = recorder();
    const p2 = admitPage('peerB', theirs[4]!.hash, headers, await pipelineCtx(2), cb2);
    if (p2.outcome === 'refused') throw new Error(`pass 2 refused: ${JSON.stringify(p2)}`);
    expect(p2.outcome).toBe('taken');

    // `admitPage` itself does not call trySwitch; it is the intake's
    // deliverHeaders that does, after admitPage. Fire the intake delivery
    // against a page the pipeline sees as a no-op (empty) to trigger
    // `trySwitch` without changing the tree further.
    await intake.deliverHeaders('peerB', theirs[4]!.hash, []);

    expect(captured).not.toBeNull();
    // The last assertion names the rule: the prefix is the shortest run of
    // best-chain hashes whose cumulative work exceeds the applied tip's.
    expect(captured!.hashes.length).toBe(3);
    expect(captured!.hashes).toEqual([theirs[0]!.hash, theirs[1]!.hash, theirs[2]!.hash]);
    expect(captured!.f).toBe(0);
  }, 180_000);
});
