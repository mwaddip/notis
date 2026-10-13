import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { blockHash, cumulativeWork } from '@dagsocial/validation';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import type { ForkResolutionNet } from '../../src/services/fork-resolution.js';
import {
  makeApplicableBlock,
  makeTestConfig,
  mineNextBlock,
  revertChainTo,
} from '../helpers.js';
import {
  testConfig,
  importDb,
  importBlockCreator,
  importOrdering,
  installTrackers,
  teardownTrackers,
  settleResolveForks,
  T1,
  HL,
  initChainStore,
  startCreator,
  buildAndApply,
  singleBranchNet,
} from './fork-resolution-fixtures.js';
import type { Trackers, StubNet, StubNetOptions } from './fork-resolution-fixtures.js';

// ---------------------------------------------------------------------------
// NODE_INTERFACE → Fork choice decides on verified headers
//
// The first case is a plain `it` that proves the mechanism of a reorg from a
// non-extending block; the rest exercise one rule each — one resolution at a
// time, a block handed back on a moved tip, the walk bounded by the journals
// kept, a stored row that will not decode.
// ---------------------------------------------------------------------------

// ===========================================================================
// Control. A non-extending block of a heavier branch switches the chain. Plain
// `it`: it proves the net, the branch builder and the counting
// (NODE_INTERFACE → Fork choice decides on verified headers, steps 1–10).
// ===========================================================================

describe('a non-extending block of a heavier branch switches the chain', () => {
  const ctx: Trackers = {caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('reorgs to the heavier branch on one delivery', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [heavy2, heavy3] = await buildAndApply([[2, T1 + 1], [3, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const net = singleBranchNet('peer-heavy', [shared1!, heavy2!, heavy3!]);
    expect(handleOrderingBlock(heavy3!, 'peer-heavy', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(heavy3!.header));
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time"
// The runner runs resolveFork for one block at a time, so N deliveries never
// put N walks in flight.
// ===========================================================================

describe('one resolution runs at a time, however many deliveries arrive', () => {
  const ctx: Trackers = {caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('500 deliveries put at most 1 walk in flight', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };
    await mineNextBlock(await importBlockCreator());
    await mineNextBlock(await importBlockCreator());
    const side = await makeApplicableBlock({ height: 3 });
    expect(applyOrderingBlock(side)).toBe(true);
    await revertChainTo(2);
    await mineNextBlock(await importBlockCreator());
    await mineNextBlock(await importBlockCreator());

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(4);
    expect(ordering.getOrderingBlockHash(3)).not.toBe(blockHash(side.header));

    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const net: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-replay'],
      peerTipHeight: () => 3,
      penalizePeer: () => undefined,
      requestBlocks: async () => [],
      requestHeaders: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return [];
      },
    };

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const K = 500;
    for (let i = 0; i < K; i++) handleOrderingBlock(side, 'peer-replay', net);

    release();
    await settleResolveForks(ctx);

    expect(peak).toBe(1);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time"
// A block kept pending is handed back when the running resolution ends, and
// judged on the tip that then stands.
// ===========================================================================

describe('a block that arrives during a switch and extends the new tip is applied', () => {
  const ctx: Trackers = {caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('tip ends at the extension', async () => {
    await initChainStore();
    await startCreator(testConfig);

    // Our chain = one shared block at height 1.
    const [shared1] = await buildAndApply([[1, T1]]);
    // Peer branch forks at height 1 and reaches 7, with stamps a halflife
    // past our chain's — lighter per block than ours.
    const peer = await buildAndApply([
      [2, T1 + HL + 1], [3, T1 + HL + 2], [4, T1 + HL + 3],
      [5, T1 + HL + 4], [6, T1 + HL + 5], [7, T1 + HL + 6],
    ]);
    await revertChainTo(1);
    // Our chain re-mines heights 2, 3 — heavier per block via a fast stamp.
    const [ourh2, ourh3] = await buildAndApply([[2, T1 + 1], [3, T1 + 2]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    const B6 = peer[4]!;
    const B7 = peer[5]!;
    // The scored residual (peer2 and peer3 drawn from the fork walk's
    // descent) is lighter than our two blocks; the next scoring page
    // (peer4..peer_tip) must tip the sum over ours. The pre-check pins
    // this against the fixtures.
    const ourWork = cumulativeWork([ourh2!.header, ourh3!.header]);
    const residualWork = cumulativeWork([peer[0]!.header, peer[1]!.header]);
    const peerThroughSix = cumulativeWork(peer.slice(0, 5).map((b) => b.header));
    expect(residualWork < ourWork).toBe(true);
    expect(peerThroughSix > ourWork).toBe(true);

    let peerTip = 6;
    let blockCalls = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const allBlocks = [shared1!, ...peer];
    const allHeaders = allBlocks.map((b) => b.header);
    const net: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-heavy'],
      peerTipHeight: () => peerTip,
      penalizePeer: () => undefined,
      requestHeaders: async (startHeight, maxCount) => {
        const clamped = Math.min(startHeight, peerTip);
        return allHeaders
          .filter((h) => h.height <= clamped)
          .sort((a, b) => b.height - a.height)
          .slice(0, maxCount);
      },
      requestBlocks: async (startHeight, endHeight) => {
        blockCalls++;
        await gate;
        return allBlocks.filter(
          (b) => b.header.height >= startHeight && b.header.height <= endHeight,
        );
      },
    };

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    // Deliver B6 — the peer still only has heights up to 6. R(B6) walks
    // under `peerTip = 6` and sits on its block fetch.
    handleOrderingBlock(B6, 'peer-heavy', net);
    await vi.waitFor(() => {
      expect(blockCalls).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // The peer gains height 7 and delivers it while R(B6) is held.
    peerTip = 7;
    handleOrderingBlock(B7, 'peer-heavy', net);
    await Promise.resolve();
    await Promise.resolve();

    open();
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(7);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends because the tip moved hands its own block back the same way"
// Step 9's re-read is a height AND a hash, so a resolution that scored against
// our old tip cannot land on a chain lighter than the one that moved us under
// it.
// ===========================================================================

describe('two overlapping resolutions never end on the lighter chain', () => {
  const ctx: Trackers = {caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the heavier concurrent switch stands', async () => {
    await initChainStore();
    await startCreator(testConfig);

    // Shared genesis block at height 1, slow A at 2-3, fast B at 2-3,
    // medium D at 2-3. Their work ordering is pinned below with
    // `cumulativeWork` — work(B) > work(D) > work(A), per
    // VALIDATION_INTERFACE → blockWork / cumulativeWork.
    const [shared1] = await buildAndApply([[1, T1]]);
    const [A2, A3] = await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);
    await revertChainTo(1);
    const [B2, B3] = await buildAndApply([
      [2, T1 + 1],
      [3, T1 + 2],
    ]);
    await revertChainTo(1);
    const [D2, D3] = await buildAndApply([
      [2, T1 + 60_000],
      [3, T1 + 60_001],
    ]);
    await revertChainTo(1);

    // Our chain = A, applied last so A2, A3 sit in the store.
    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };
    expect(applyOrderingBlock(A2!)).toBe(true);
    expect(applyOrderingBlock(A3!)).toBe(true);

    const workA = cumulativeWork([A2!.header, A3!.header]);
    const workB = cumulativeWork([B2!.header, B3!.header]);
    const workD = cumulativeWork([D2!.header, D3!.header]);
    // Pre-checks: the three branches relate as the rule requires.
    expect(workD > workA).toBe(true);
    expect(workD < workB).toBe(true);

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const netD = singleBranchNet('peer-D', [shared1!, D2!, D3!], { blockGate: gate });
    const netB = singleBranchNet('peer-B', [shared1!, B2!, B3!]);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    // R(D) delivered first, held on its block fetch.
    handleOrderingBlock(D3!, 'peer-D', netD);
    await vi.waitFor(() => {
      expect(netD.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // R(B) runs synchronously to its switch — netB has no gate.
    handleOrderingBlock(B3!, 'peer-B', netB);
    // Allow R(B)'s resolveFork to run through its awaits.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const ordering = await importOrdering();

    open();
    await settleResolveForks(ctx);

    // The record of what the branches were: work(B) > work(D), the rule's
    // predicate. The tip's hash is B3's, not D3's.
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(B3!.header));
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "What is remembered, and what is not"
// A persisted mark is only as right as the node that wrote it, and a chain
// scored against a tip that moved before its switch is not a verdict on the
// chain served.
// ===========================================================================

describe('an overlapping resolution marks no valid block refused', () => {
  const ctx: Trackers = {caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('no row in refused_headers and no penalty on the valid branch', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    // A: slow — the victim's chain.
    const [A2, A3] = await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);
    await revertChainTo(2);
    // C: forks at A2 (height 2), heavier than A3 alone above A2.
    const [C3, C4] = await buildAndApply([
      [3, A2!.header.createdAt + 5],
      [4, A2!.header.createdAt + 6],
    ]);
    await revertChainTo(1);
    // B: forks at the shared block (height 1), heavier than A above the
    // shared fork.
    const [B2, B3] = await buildAndApply([
      [2, T1 + 1],
      [3, T1 + 2],
    ]);
    await revertChainTo(1);

    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };
    expect(applyOrderingBlock(A2!)).toBe(true);
    expect(applyOrderingBlock(A3!)).toBe(true);

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const netC = singleBranchNet('peer-C', [shared1!, A2!, C3!, C4!], { blockGate: gate });
    const netB = singleBranchNet('peer-B', [shared1!, B2!, B3!]);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    handleOrderingBlock(C4!, 'peer-C', netC);
    await vi.waitFor(() => {
      expect(netC.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    handleOrderingBlock(B3!, 'peer-B', netB);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    open();
    await settleResolveForks(ctx);

    const refusedHeaders = (await import('../../src/store/refused-headers.js')) as {
      anyRefusedHeader: (hashes: string[]) => boolean;
    };
    const c3Hash = blockHash(C3!.header)!;

    // The rule, kept whole: a valid chain is marked
    // nowhere and its peer carries no penalty.
    expect({
      refused: refusedHeaders.anyRefusedHeader([c3Hash]),
      penalties: netC.penalties.map((p) => p.kind),
    }).toEqual({ refused: false, penalties: [] });
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "The walk reaches as deep as the journals do, and no deeper"
// Step 3 bounds the fork walk by the lowest journal kept, so a branch that
// forks below it is past the horizon — no decision, no penalty, nothing of the
// corrupt-state family.
// ===========================================================================

describe('a fork below the lowest journal kept is past the horizon', () => {
  const ctx: Trackers = {caughtCorrupt: [] };
  // D=6, base_top=4, A=5 slow blocks (heights 5..9), B=2 fast (5..6),
  // F2=1. Pre-reorg tip 9 purges below 3; after shortening to 6 journals
  // 3..6 are kept, so revertBlock(2) under a C-branch reorg is missing
  // (NODE_INTERFACE → Block Journal: a revert needs the block's journal).
  const D = 6;
  const BASE_TOP = 4;
  const F2 = 1;

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx, { maxReorgDepth: D });
  });
  afterEach(teardownTrackers);

  it('no decision and no corrupt-state throw', async () => {
    await initChainStore();
    const cfg = makeTestConfig({ maxReorgDepth: D });
    await startCreator(cfg);

    const base: OrderingBlock[] = [];
    for (let h = 1; h <= BASE_TOP; h++) {
      base.push(...(await buildAndApply([[h, T1 + (h - 1) * 60_000]])));
    }

    // C: 6 fast blocks above F2 (heights 2..7), heavy enough to outweigh
    // our chain above F2 after the shortening below. Kept short so no
    // apply during the build triggers `purgeOldJournals` (NODE_INTERFACE →
    // Block Journal: a revert needs the block's journal).
    await revertChainTo(F2);
    const C: OrderingBlock[] = [];
    for (let i = 0; i < 6; i++) {
      C.push(...(await buildAndApply([[F2 + 1 + i, T1 + i + 1]])));
    }
    await revertChainTo(F2);
    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };
    for (let i = 1; i < base.length; i++) {
      expect(applyOrderingBlock(base[i]!)).toBe(true);
    }

    // A: 5 slow blocks above base — A[0] carries the anchor's bits and
    // A[1..4] carry the ASERT-reduced bits that reflect three halflifes
    // past the ideal rate. The pre-reorg tip is BASE_TOP + 5 = 9, so
    // journals purge below 9 − 6 = 3 at that apply.
    const t_top = base[BASE_TOP - 1]!.header.createdAt;
    const A: OrderingBlock[] = [];
    for (let i = 0; i < 5; i++) {
      A.push(...(await buildAndApply([[BASE_TOP + 1 + i, t_top + 3 * HL + i]])));
    }
    await revertChainTo(BASE_TOP);
    const B = await buildAndApply([
      [BASE_TOP + 1, t_top + 1],
      [BASE_TOP + 2, t_top + 2],
    ]);
    await revertChainTo(BASE_TOP);
    for (const b of A) expect(applyOrderingBlock(b)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 5);

    // The shortening switch (B outweighs the 5-slow A).
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const netB = singleBranchNet('peer-B', [...base, ...B]);
    handleOrderingBlock(B[1]!, 'peer-B', netB);
    await settleResolveForks(ctx);
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 2);

    // Setup pre-check: F2 + 1 sits below the lowest journal still kept.
    const journal = (await import('../../src/store/journal.js')) as {
      getBlockJournal: (h: number) => unknown;
    };
    let lowestJournal: number | null = null;
    for (let h = 1; h <= ordering.getCurrentHeight(); h++) {
      if (journal.getBlockJournal(h) !== null) { lowestJournal = h; break; }
    }
    expect(lowestJournal).not.toBeNull();
    expect(F2 + 1 < lowestJournal!).toBe(true);

    // The C-branch delivery.
    const netC = singleBranchNet('peer-C', [base[0]!, ...C]);
    handleOrderingBlock(C[C.length - 1]!, 'peer-C', netC);
    await settleResolveForks(ctx);

    // The rule: nothing of the corrupt-state family
    // reached the fail-stop boundary.
    expect(ctx.caughtCorrupt.map((e) => (e as Error).constructor.name)).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends because the tip moved hands its own block back the same way"
// A resolution in flight when the tip drops under it must not read a header
// row the switch deleted and raise a corrupt-state throw.
// ===========================================================================

describe('a block delivered while a shortening switch runs is judged after it', () => {
  const ctx: Trackers = {caughtCorrupt: [] };
  const D = 6;
  const BASE_TOP = 4;

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx, { maxReorgDepth: D });
  });
  afterEach(teardownTrackers);

  it('the pending block is judged on the shortened tip without a corrupt-state throw', async () => {
    await initChainStore();
    const cfg = makeTestConfig({ maxReorgDepth: D });
    await startCreator(cfg);

    const base: OrderingBlock[] = [];
    for (let h = 1; h <= BASE_TOP; h++) {
      base.push(...(await buildAndApply([[h, T1 + (h - 1) * 60_000]])));
    }
    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };

    // A: five slow blocks above base — the lighter chain the shortening
    // replaces.
    const t_top = base[BASE_TOP - 1]!.header.createdAt;
    const A: OrderingBlock[] = [];
    for (let i = 0; i < 5; i++) {
      A.push(...(await buildAndApply([[BASE_TOP + 1 + i, t_top + 3 * HL + i]])));
    }
    await revertChainTo(BASE_TOP);
    // B: two fast blocks above base — the shortening.
    const B = await buildAndApply([
      [BASE_TOP + 1, t_top + 1],
      [BASE_TOP + 2, t_top + 2],
    ]);
    await revertChainTo(BASE_TOP);
    // X: a sibling two-block branch above base, with its own stamps — the
    // other block, delivered while the shortening runs. Non-extending from
    // the shortened tip too.
    const X: OrderingBlock[] = [];
    for (let i = 0; i < 2; i++) {
      X.push(...(await buildAndApply([[BASE_TOP + 1 + i, t_top + 500 + i]])));
    }
    await revertChainTo(BASE_TOP);
    for (const b of A) expect(applyOrderingBlock(b)).toBe(true);

    const ordering = await importOrdering();
    // The pre-switch tip — one of the two tips that prove the shortening is
    // one.
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 5);

    // The shortening switch's resolution is the one running, held at its
    // block fetch under `gate`.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const netB = singleBranchNet('peer-B', [...base, ...B], { blockGate: gate });
    const netX = singleBranchNet('peer-X', [...base, ...X]);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(B[1]!, 'peer-B', netB);
    await vi.waitFor(() => {
      expect(netB.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // The other block, delivered while the shortening runs, is peer-X's
    // pending block.
    handleOrderingBlock(X[1]!, 'peer-X', netX);

    open();
    await settleResolveForks(ctx);

    // The post-switch tip — the second of the two tips. The lowest journal
    // kept is `tip − maxReorgDepth` at the moment the shortening landed:
    // at the pre-switch tip of 9, apply purged below 9 − 6 = 3, so the row
    // at height 3 stands after the shortening to 6.
    const journal = (await import('../../src/store/journal.js')) as {
      getLowestJournalHeight: () => number | null;
    };
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 2);
    expect(journal.getLowestJournalHeight()).toBe(3);

    // The rule: the pending block is judged on the shortened tip (so its
    // net is asked for headers), and nothing of the corrupt-state family
    // reaches the boundary.
    expect(netX.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends because the tip moved hands its own block back the same way"
// The block is handed back to the runner, not dropped.
// ===========================================================================

describe('a resolution that ends because the tip moved judges its block again', () => {
  const ctx: Trackers = {caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the node ends on the still-heavier peer branch', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    // Peer heavier branch, 4 blocks above the shared fork.
    const peer = await buildAndApply([
      [2, T1 + 1], [3, T1 + 2], [4, T1 + 3], [5, T1 + 4],
    ]);
    await revertChainTo(1);
    // Our chain re-mines heights 2, 3 — lighter.
    await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    const peerTip = peer[peer.length - 1]!;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const net = singleBranchNet('peer-heavy', [shared1!, ...peer], { blockGate: gate });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    // Peer tip delivered first; its resolution scores and holds on the
    // block fetch (NODE_INTERFACE → Fork choice decides on verified
    // headers, step 8).
    handleOrderingBlock(peerTip, 'peer-heavy', net);
    await vi.waitFor(() => {
      expect(net.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // Our own next block applies while the resolution is paused.
    await mineNextBlock(await importBlockCreator());
    expect(ordering.getCurrentHeight()).toBe(4);

    // The peer's branch is still the heavier above the fork point.
    const store = (await import('../../src/store/ordering.js')) as {
      getHeadersAbove: (height: number, n: number) => BlockHeader[];
    };
    const ourWork = cumulativeWork(store.getHeadersAbove(1, 3));
    const peerWork = cumulativeWork(peer.map((b) => b.header));
    expect(peerWork > ourWork).toBe(true);

    open();
    await settleResolveForks(ctx);

    // Rule: the aborted resolution hands the block back; the runner
    // re-judges it on the tip that stands (4). The peer's branch is
    // still heavier, so the second judgment reorgs to it.
    expect(ordering.getOrderingBlockHash(peerTip.header.height)).toBe(
      blockHash(peerTip.header),
    );
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends in a switch hands its own block back too"
// The switch lands on the shortest heavier prefix a page reaches, which can
// end below the block the resolution started from. The block is handed back
// and extends the new tip directly.
// ===========================================================================

describe('a resolution that switches below the delivered block hands it back', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the delivered block extends the switched tip and is applied', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const peer = await buildAndApply([
      [2, T1 + 1], [3, T1 + 2], [4, T1 + 3],
    ]);
    await revertChainTo(1);
    const our = await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    // Setup pre-check: peer2+peer3 outweighs our chain above the shared
    // fork, so the shortest heavier prefix a page reaches is [peer2,peer3]
    // and the switch lands at height 3 — one below the delivered block.
    const ourWork = cumulativeWork(our.map((b) => b.header));
    const peerPrefix = cumulativeWork([peer[0]!.header, peer[1]!.header]);
    expect(peerPrefix > ourWork).toBe(true);

    const deliveredBlock = peer[2]!;  // height 4
    const net = singleBranchNet('peer-heavy', [shared1!, ...peer]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(deliveredBlock, 'peer-heavy', net);
    await settleResolveForks(ctx);

    // The rule: the switched tip is at height 3 (peer3); the delivered
    // block (peer4) extends it and is applied, so the chain ends at the
    // delivered block.
    expect(ordering.getCurrentHeight()).toBe(deliveredBlock.header.height);
    expect(ordering.getOrderingBlockHash(deliveredBlock.header.height)).toBe(
      blockHash(deliveredBlock.header),
    );
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends in a switch hands its own block back too"
// Handed back, the block starts a resolution that fetches the rest of its
// branch — the net is asked for blocks twice, and the second ask starts above
// the first switch's tip.
// ===========================================================================

describe('a resolution that switches two below the delivered block fetches the rest', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('a second block fetch runs above the first switch tip', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const peer = await buildAndApply([
      [2, T1 + 1], [3, T1 + 2], [4, T1 + 3], [5, T1 + 4], [6, T1 + 5],
    ]);
    await revertChainTo(1);
    const our = await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    // Setup pre-check: peer2+peer3 outweighs our chain above the shared
    // fork, so the first switch lands at height 3 — three below the
    // delivered block at height 6.
    const ourWork = cumulativeWork(our.map((b) => b.header));
    const peerPrefix = cumulativeWork([peer[0]!.header, peer[1]!.header]);
    expect(peerPrefix > ourWork).toBe(true);

    const branch = [shared1!, ...peer];
    const headers = branch.map((b) => b.header);
    const peerTip = Math.max(...headers.map((h) => h.height));
    const blockRanges: Array<{ start: number; end: number }> = [];
    const net: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-heavy'],
      peerTipHeight: () => peerTip,
      penalizePeer: () => undefined,
      requestHeaders: async (startHeight, maxCount) => {
        const clamped = Math.min(startHeight, peerTip);
        return headers
          .filter((h) => h.height <= clamped)
          .sort((a, b) => b.height - a.height)
          .slice(0, maxCount);
      },
      requestBlocks: async (startHeight, endHeight) => {
        blockRanges.push({ start: startHeight, end: endHeight });
        return branch.filter(
          (b) => b.header.height >= startHeight && b.header.height <= endHeight,
        );
      },
    };

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const deliveredBlock = peer[peer.length - 1]!;
    handleOrderingBlock(deliveredBlock, 'peer-heavy', net);
    await settleResolveForks(ctx);

    // The rule: a second resolution ran above the first switch's tip, so
    // the net was asked for blocks twice and the second ask starts above
    // the first ask's end.
    expect(blockRanges.length).toBe(2);
    expect(blockRanges[1]!.start).toBeGreaterThan(blockRanges[0]!.end);
    expect(ordering.getCurrentHeight()).toBe(deliveredBlock.header.height);
    expect(ordering.getOrderingBlockHash(deliveredBlock.header.height)).toBe(
      blockHash(deliveredBlock.header),
    );
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends in a switch hands its own block back too"
// A block the switch already reached is held when handed back, so the net is
// asked nothing further.
// ===========================================================================

describe('a resolution that switches to the delivered block hands back a no-op', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the hand-back is already held, so the net is asked nothing further', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [peer2, peer3] = await buildAndApply([[2, T1 + 1], [3, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    const net = singleBranchNet('peer-heavy', [shared1!, peer2!, peer3!]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(peer3!, 'peer-heavy', net);
    await settleResolveForks(ctx);

    // The rule: the switch reached the delivered block, the hand-back saw
    // it as already held, and the net was asked exactly once for headers
    // and once for blocks — the first resolution's pages, nothing beyond.
    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(peer3!.header));
    expect(net.headerCalls.count).toBe(1);
    expect(net.blockCalls.count).toBe(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends in a switch hands its own block back too"
// Unless its peer has a later block pending — then the earlier is not
// re-judged, and the later alone goes through.
// ===========================================================================

describe('a switching resolution with a later peer pending drops the earlier', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it("the earlier block's net is asked exactly once", async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const peer = await buildAndApply([
      [2, T1 + 1], [3, T1 + 2], [4, T1 + 3], [5, T1 + 4],
    ]);
    await revertChainTo(1);
    await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    const earlierBlock = peer[2]!;  // height 4
    const laterBlock = peer[peer.length - 1]!;  // height 5

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const netEarlier = singleBranchNet('peer-A', [shared1!, ...peer], {
      blockGate: gate,
      peerTipOverride: 15,
    });
    const netLater = singleBranchNet('peer-A', [shared1!, ...peer], { peerTipOverride: 16 });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    handleOrderingBlock(earlierBlock, 'peer-A', netEarlier);
    await vi.waitFor(() => {
      expect(netEarlier.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // The later block from the same peer waits as peer-A's pending block.
    handleOrderingBlock(laterBlock, 'peer-A', netLater);

    open();
    await settleResolveForks(ctx);

    // The rule: the first resolution switches, peer-A has a later block
    // pending, so the earlier block is not handed back. netEarlier is
    // asked exactly once (its own fork walk); netLater runs its own
    // resolution.
    expect(netEarlier.headerCalls.count).toBe(1);
    expect(netLater.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends in a switch hands its own block back too"
// The hand-back is conditioned on a completed `reorg(…)`: a switch the funnel
// refuses throws out of the transaction and the catch returns `'done'`, so no
// block is handed back and the net is asked nothing further.
// ===========================================================================

describe('a reorg the funnel refuses hands nothing back', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the forged branch is marked and the net is asked nothing further', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [peer2] = await buildAndApply([[2, T1 + 1]]);
    const { makeTestIdentity } = await import('../helpers.js');
    const forger = makeTestIdentity();
    const peer3Forged = await makeApplicableBlock({
      height: 3,
      createdAt: T1 + 2,
      signWith: forger.privateKey,
    });
    await revertChainTo(1);
    await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);
    const ourTipHash = ordering.getOrderingBlockHash(3);

    const net = singleBranchNet('peer-forger', [shared1!, peer2!, peer3Forged]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(peer3Forged, 'peer-forger', net);
    await settleResolveForks(ctx);

    const refusedHeaders = (await import('../../src/store/refused-headers.js')) as {
      anyRefusedHeader: (hashes: string[]) => boolean;
    };
    const forgedHash = blockHash(peer3Forged.header)!;

    // The rule: the funnel refused the forged block, the mark is written,
    // the chain stayed on our tip, the peer is penalised misbehavior, and
    // the net was asked exactly once for headers and once for blocks —
    // nothing after the refusal.
    expect(refusedHeaders.anyRefusedHeader([forgedHash])).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(ourTipHash);
    expect(net.headerCalls.count).toBe(1);
    expect(net.blockCalls.count).toBe(1);
    expect(net.penalties.map((p) => p.kind)).toEqual(['misbehavior']);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// A stored row that will not decode is the corrupt-state family's:
// NODE_INTERFACE → Ordering blocks answers `getInterlinks` with
// `UnreadableStoredBlockError` for such a row, and NODE_INTERFACE → Block
// Journal answers `getBlockJournal` the same way.
// ===========================================================================

describe('a stored interlinks row that will not decode is the corrupt-state family', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    (await importBlockCreator()).stopBlockCreator();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('getInterlinks raises UnreadableStoredBlockError for garbage bytes', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [b1] = await buildAndApply([[1, T1]]);
    const [b2] = await buildAndApply([[2, T1 + 60_000]]);
    void b1; void b2;

    const ordering = (await import('../../src/store/ordering.js')) as {
      getInterlinks: (h: number) => string[] | null;
    };
    const corrupt = (await import('../../src/services/corrupt-state.js')) as {
      UnreadableStoredBlockError: new (...args: never[]) => Error;
    };

    // Control: the row answered the decoded vector before the overwrite.
    expect(ordering.getInterlinks(2)).toEqual(expect.any(Array));

    const db = await importDb();
    db.getDb()
      .prepare('UPDATE ordering_blocks SET interlinks = ? WHERE height = ?')
      .run(Buffer.from([0xff]), 2);

    // The rule.
    expect(() => ordering.getInterlinks(2)).toThrow(corrupt.UnreadableStoredBlockError);
  });
});

describe('a stored journal row that will not decode is the corrupt-state family', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    (await importBlockCreator()).stopBlockCreator();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('getBlockJournal raises UnreadableStoredBlockError for garbage bytes', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [b1] = await buildAndApply([[1, T1]]);
    const [b2] = await buildAndApply([[2, T1 + 60_000]]);
    void b1; void b2;

    const journal = (await import('../../src/store/journal.js')) as {
      getBlockJournal: (h: number) => unknown;
    };
    const corrupt = (await import('../../src/services/corrupt-state.js')) as {
      UnreadableStoredBlockError: new (...args: never[]) => Error;
    };

    // Control: the row answered its decoded value before the overwrite.
    expect(journal.getBlockJournal(2)).not.toBeNull();

    const db = await importDb();
    // 0x1b opens an 8-byte unsigned integer major-type field but the
    // seven following bytes are absent — cbor-x refuses the truncation.
    db.getDb()
      .prepare('UPDATE block_journal SET journal_cbor = ? WHERE block_height = ?')
      .run(Buffer.from([0x1b]), 2);

    // The rule.
    expect(() => journal.getBlockJournal(2)).toThrow(corrupt.UnreadableStoredBlockError);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time"
// Only one pending block is kept per peer; a later block from one peer
// replaces the earlier, a block that is the running one for that peer or the
// one pending for it is dropped, and blocks from two peers both wait and are
// judged in the order they arrived.
// ===========================================================================
describe('a pending block is kept at most once per peer', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('later replaces earlier, repeats drop, two peers both run in arrival order', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    // Four non-extending blocks of the shared fork at height 1 — distinct
    // because their stamps differ.
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    const [b2] = await buildAndApply([[2, T1 + 2]]);
    await revertChainTo(1);
    const [c2] = await buildAndApply([[2, T1 + 3]]);
    await revertChainTo(1);
    const [d2] = await buildAndApply([[2, T1 + 4]]);
    await revertChainTo(1);
    // Our chain = a slow block at 2 so none of a2..d2 extends us.
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    // Each delivery carries its own net. The runner stores the net it
    // received the block through, so the pending slot's net is the one
    // its resolution asks for headers from. Each net's headerCalls.count
    // therefore reports whether that delivery ran.
    let openPeerA!: () => void;
    const gateA = new Promise<void>((r) => { openPeerA = r; });
    // NODE_INTERFACE → "Re-scoring is memoised": the memo is keyed on
    // `{atOurTip, theirTip}`. Each delivery reports a distinct `peerTip` so
    // the running block's memo write does not short-circuit the hand-backs.
    // NODE_INTERFACE → "Re-scoring is memoised": the memo is keyed on
    // `{atOurTip, theirTip}`. Each delivery reports a distinct `peerTip` so
    // the running block's memo write does not short-circuit the hand-backs.
    const netA_run = singleBranchNet('peer-A', [shared1!, a2!], {
      headerGate: gateA,
      peerTipOverride: 10,
    });
    const netA_mid = singleBranchNet('peer-A', [shared1!, b2!], { peerTipOverride: 11 });
    const netA_late = singleBranchNet('peer-A', [shared1!, c2!], { peerTipOverride: 12 });
    const netA_lateRepeat = singleBranchNet('peer-A', [shared1!, c2!], { peerTipOverride: 13 });
    const netA_runRepeat = singleBranchNet('peer-A', [shared1!, a2!], { peerTipOverride: 14 });
    const netB = singleBranchNet('peer-B', [shared1!, d2!], { peerTipOverride: 20 });
    const netB_repeat = singleBranchNet('peer-B', [shared1!, d2!], { peerTipOverride: 21 });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    // Peer A delivers a2 — the running resolution starts and sits at the
    // header fetch under `gateA`.
    handleOrderingBlock(a2!, 'peer-A', netA_run);
    await vi.waitFor(() => {
      expect(netA_run.headerCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // Peer A delivers b2 — kept as peer-A's pending block.
    handleOrderingBlock(b2!, 'peer-A', netA_mid);
    // Peer A delivers c2 — replaces b2 as peer-A's pending block.
    handleOrderingBlock(c2!, 'peer-A', netA_late);
    // Peer A delivers c2 again — dropped (one pending per peer).
    handleOrderingBlock(c2!, 'peer-A', netA_lateRepeat);
    // Peer A delivers a2 again — dropped (same as the one running for it).
    handleOrderingBlock(a2!, 'peer-A', netA_runRepeat);
    // Peer B delivers d2 — kept as peer-B's pending block.
    handleOrderingBlock(d2!, 'peer-B', netB);
    // Peer B delivers d2 again — dropped (same as its pending block).
    handleOrderingBlock(d2!, 'peer-B', netB_repeat);

    openPeerA();
    await settleResolveForks(ctx);

    // The running delivery, the surviving peer-A pending (c2), and the
    // peer-B pending (d2) each ran. The dropped ones were not asked.
    expect(netA_run.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(netA_late.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(netB.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(netA_mid.headerCalls.count).toBe(0);
    expect(netA_lateRepeat.headerCalls.count).toBe(0);
    expect(netA_runRepeat.headerCalls.count).toBe(0);
    expect(netB_repeat.headerCalls.count).toBe(0);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time" + "Re-scoring is memoised"
// A peer that leaves loses its pending block and its memo entry.
// ⚠ `src/index.ts`'s own `net.onPeerDisconnected` registration starts a node
// when imported and sits outside every suite — the function it calls is
// `onPeerDisconnectedForForkResolution`, and that function is what this case
// drives.
// ===========================================================================
describe('a peer that disconnects takes its pending block and its memo entry', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the pending block never runs after disconnect', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    const [b2] = await buildAndApply([[2, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    let openPeerA!: () => void;
    const gateA = new Promise<void>((r) => { openPeerA = r; });
    const netA = singleBranchNet('peer-A', [shared1!, a2!], { headerGate: gateA });
    const netB = singleBranchNet('peer-B', [shared1!, b2!]);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const { onPeerDisconnectedForForkResolution } = await import(
      '../../src/services/fork-resolution-runner.js'
    );

    handleOrderingBlock(a2!, 'peer-A', netA);
    await vi.waitFor(() => {
      expect(netA.headerCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });
    handleOrderingBlock(b2!, 'peer-B', netB);

    onPeerDisconnectedForForkResolution('peer-B');

    openPeerA();
    await settleResolveForks(ctx);

    // peer-B's pending block was dropped on disconnect, so its net was
    // never asked for headers.
    expect(netB.headerCalls.count).toBe(0);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Block Journal: `getLowestJournalHeight`.
// ===========================================================================
describe('getLowestJournalHeight answers the lowest row', () => {
  afterEach(async () => {
    (await importBlockCreator()).stopBlockCreator();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('null on empty, lowest after applies, lowest after purge', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const journal = (await import('../../src/store/journal.js')) as {
      getBlockJournal: (h: number) => unknown;
      getLowestJournalHeight: () => number | null;
      purgeOldJournals: (belowHeight: number) => void;
    };

    expect(journal.getLowestJournalHeight()).toBeNull();

    await buildAndApply([[1, T1]]);
    await buildAndApply([[2, T1 + 60_000]]);
    await buildAndApply([[3, T1 + 60_000 * 2]]);
    expect(journal.getLowestJournalHeight()).toBe(1);

    journal.purgeOldJournals(3);
    expect(journal.getLowestJournalHeight()).toBe(3);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "The walk reaches as deep as the journals do, and no deeper"
// The genesis fall-through takes `ourTip ≤ maxReorgDepth` AND
// `lowestJournal ≤ 1`. A tip brought from above `maxReorgDepth` to at or
// below it has journals that no longer reach height 1, so a branch that
// shares nothing with ours gets no decision and no penalty.
// ===========================================================================
describe('a tip at or below the horizon with journals not reaching 1 gives no genesis fall-through', () => {
  const D = 6;
  const BASE_TOP = 4;

  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx, { maxReorgDepth: D });
  });
  afterEach(teardownTrackers);

  it('no decision, no penalty, no corrupt-state throw', async () => {
    await initChainStore();
    const cfg = makeTestConfig({ maxReorgDepth: D });
    await startCreator(cfg);

    // Setup: BASE of 4 blocks, a C fork of 6 fast blocks above F2=1, an A
    // of 5 slow blocks above BASE, a B of 2 fast blocks above BASE. C is
    // built FIRST on the base-of-1 so the revert never has to go below the
    // horizon. Then BASE 2..4, A 5..9, and the shortening B 5..6 are
    // staged with their journals.
    const F2 = 1;
    const [shared1] = await buildAndApply([[F2, T1]]);
    const C: OrderingBlock[] = [];
    for (let i = 0; i < 6; i++) {
      C.push(...(await buildAndApply([[F2 + 1 + i, T1 + i + 1]])));
    }
    await revertChainTo(F2);

    const base: OrderingBlock[] = [shared1!];
    for (let h = 2; h <= BASE_TOP; h++) {
      base.push(...(await buildAndApply([[h, T1 + (h - 1) * 60_000]])));
    }
    const t_top = base[BASE_TOP - 1]!.header.createdAt;
    const A: OrderingBlock[] = [];
    for (let i = 0; i < 5; i++) {
      A.push(...(await buildAndApply([[BASE_TOP + 1 + i, t_top + 3 * HL + i]])));
    }
    await revertChainTo(BASE_TOP);
    const B = await buildAndApply([
      [BASE_TOP + 1, t_top + 1],
      [BASE_TOP + 2, t_top + 2],
    ]);
    await revertChainTo(BASE_TOP);
    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };
    for (const b of A) expect(applyOrderingBlock(b)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 5);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const netB = singleBranchNet('peer-B', [...base, ...B]);
    handleOrderingBlock(B[1]!, 'peer-B', netB);
    await settleResolveForks(ctx);
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 2);

    const journal = (await import('../../src/store/journal.js')) as {
      getLowestJournalHeight: () => number | null;
    };
    // Journals: the A apply at tip 9 purged below 9 − 6 = 3, so heights
    // 3..6 stand after the shortening to 6; F2 + 1 = 2 sits below the
    // lowest.
    expect(journal.getLowestJournalHeight()).toBe(3);

    // The C delivery — fork point F2 + 1 = 2 is below the lowest journal.
    // The rule: no decision, no penalty, no corrupt-state throw.
    const netC = singleBranchNet('peer-C', [shared1!, ...C]);
    handleOrderingBlock(C[C.length - 1]!, 'peer-C', netC);
    await settleResolveForks(ctx);

    expect(ctx.caughtCorrupt.map((e) => (e as Error).constructor.name)).toEqual([]);
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 2);
    expect(netC.penalties).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers, step 9:
// "the tip a resolution read at its start is a height **and a hash**".
//
// Nothing a node runs itself switches the chain at one height without
// extending it, so this case does so by hand, through the ordering store's
// writer, and names in a comment why: the resolution ends as for a tip that
// moved and the block is judged again.
// ===========================================================================
describe('a tip switched at one height ends the resolution the same way a height move does', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('step 9 reads the hash and treats the swap as a tip that moved', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [ourh2] = await buildAndApply([[2, T1 + 60_000 + HL]]);
    await revertChainTo(1);
    const [peer2, peer3] = await buildAndApply([
      [2, T1 + 1],
      [3, T1 + 2],
    ]);
    await revertChainTo(1);
    // An alternate height-2 block whose hash differs from ourh2. The chain
    // is swapped from ourh2 to alt2 under the gate below, through the apply
    // path, so the resolution's step 9 reads the same height with a
    // different hash and no store row is left corrupt — alt2 has its own
    // journal and ordering_blocks row.
    const [alt2] = await buildAndApply([[2, T1 + 120_000]]);
    await revertChainTo(1);
    const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (b: OrderingBlock) => boolean;
    };
    expect(applyOrderingBlock(ourh2!)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);
    const ourh2Hash = blockHash(ourh2!.header);
    expect(ordering.getOrderingBlockHash(2)).toBe(ourh2Hash);

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const net = singleBranchNet('peer-heavy', [shared1!, peer2!, peer3!], {
      blockGate: gate,
    });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(peer3!, 'peer-heavy', net);
    await vi.waitFor(() => {
      expect(net.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // Swap height 2 to alt2 through the apply path: `revertChainTo(1)`
    // reverses ourh2 cleanly, and `applyOrderingBlock(alt2)` reinstates
    // height 2 with alt2's hash. The height is unchanged, the hash is not.
    await revertChainTo(1);
    expect(applyOrderingBlock(alt2!)).toBe(true);
    expect(ordering.getCurrentHeight()).toBe(2);
    expect(ordering.getOrderingBlockHash(2)).toBe(blockHash(alt2!.header));

    open();
    await settleResolveForks(ctx);

    // The predicate: the resolution ended as 'tip-moved' and handed its
    // block back, so the net was asked for blocks a second time — the
    // first fetch was gated and aborted; the hand-back's own fetch ran. A
    // hash-only check at step 9 is what distinguishes the two: with the
    // comparison out, the first resolution reorgs and no hand-back fires,
    // so this count is 1.
    expect(net.blockCalls.count).toBeGreaterThanOrEqual(2);
    expect(ctx.caughtCorrupt).toEqual([]);
    // The chain ends with the heavier branch over the shared fork.
    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(peer3!.header));
  });
});

// ===========================================================================
// NODE_INTERFACE → "An unhandled rejection is logged, and the node keeps
// running".
// The handler is a pure function: a corrupt-state reason reaches the
// fail-stop boundary, any other reason is logged and the function returns.
// ===========================================================================
describe('handleUnhandledRejection routes by class', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await importBlockCreator()).stopBlockCreator();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a corrupt-state subclass fails stop; a plain Error is logged and the function returns', async () => {
    await initChainStore();
    const corrupt = await import('../../src/services/corrupt-state.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The internal call to `failStopIfCorruptChain` is a same-module
    // reference, so a module-level mock does not intercept it. The exit is
    // stubbed to a recorded no-op instead.
    const exitCalls: number[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null | undefined,
    ) => {
      exitCalls.push(typeof code === 'number' ? code : 0);
      return undefined as never;
    }) as typeof process.exit);

    const familyMember = new corrupt.MissingStoredBlockError('case', 42);
    // `process.exit` is a stub, so `failStopIfCorruptChain`'s `throw err`
    // reaches here. In production the exit lands before the throw.
    expect(() => corrupt.handleUnhandledRejection(familyMember)).toThrow(
      corrupt.MissingStoredBlockError,
    );
    expect(exitCalls).toEqual([1]);

    const plain = new Error('a plain error');
    corrupt.handleUnhandledRejection(plain);

    // The handler returned (did not fail-stop) and the error landed in the
    // log with its stack.
    const stackMessages = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(stackMessages.some((m) => m.includes('a plain error'))).toBe(true);
    expect(exitCalls).toEqual([1]);

    exitSpy.mockRestore();
  });
});

// ===========================================================================
// NODE_INTERFACE → "An unhandled rejection is logged, and the node keeps
// running": the runner owns each resolution's promise, so a non-family throw
// ends that resolution and the next pending block is judged.
// ===========================================================================
describe('a resolution that throws something else ends and the next is judged', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the next pending block is judged after a throw', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    const [b2] = await buildAndApply([[2, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    let openA!: () => void;
    const gateA = new Promise<void>((r) => { openA = r; });
    const throwingNet: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-throws'],
      peerTipHeight: () => 2,
      penalizePeer: () => undefined,
      requestBlocks: async () => [],
      requestHeaders: async () => {
        await gateA;
        throw new Error('a non-family throw from the stub');
      },
    };
    const netB = singleBranchNet('peer-B', [shared1!, b2!]);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(a2!, 'peer-throws', throwingNet);
    // Give the runner one microtask to seat the resolution before the
    // second delivery lands.
    await Promise.resolve();
    handleOrderingBlock(b2!, 'peer-B', netB);

    openA();
    await settleResolveForks(ctx);

    expect(ctx.caughtCorrupt).toEqual([]);
    // peer-B's resolution was asked for headers after peer-throws' threw.
    expect(netB.headerCalls.count).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time"
// A delivery that lands between the drain and the hand-back must still be
// judged. The runner's rule is that nothing waits between a resolution's end
// and its first `handleOrderingBlock` call; the case lands a delivery in that
// moment and asserts the block ran. The microtask budget below is the
// deadline — a buggy runner leaves `pendingByPeer` holding a block and
// nothing dispatches it, so `netB` is never asked for headers.
// ===========================================================================
describe('a block delivered as a resolution ends is judged', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the pending block never strands between the drain and the hand-back', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    const [b2] = await buildAndApply([[2, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    const netB = singleBranchNet('peer-A', [shared1!, b2!], { peerTipOverride: 11 });

    // netA serves no headers. The resolution reaches `requestHeaders`, which
    // schedules a chained-microtask delivery of b2 so the delivery lands
    // after `runResolution`'s drain of the pending set. Any such moment is
    // covered by the rule — the dispatch runs synchronously beside
    // `running = null` — not this one alone.
    let delivered = false;
    const netA: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-A'],
      peerTipHeight: () => 10,
      penalizePeer: () => undefined,
      requestBlocks: async () => [],
      requestHeaders: async () => {
        if (!delivered) {
          delivered = true;
          queueMicrotask(() =>
            queueMicrotask(() =>
              queueMicrotask(() => handleOrderingBlock(b2!, 'peer-A', netB)),
            ),
          );
        }
        return [];
      },
    };

    handleOrderingBlock(a2!, 'peer-A', netA);

    // The microtask budget is the deadline: a healthy run drains well inside
    // 500 microtasks, and a buggy runner leaves `netB.headerCalls.count` at
    // zero whatever budget stands here.
    for (let i = 0; i < 500; i++) {
      await Promise.resolve();
    }

    expect(netB.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time"
// Two blocks differing only in a header field a hand comparison on six of
// eleven fields skips are two blocks to the runner — the identity is the
// hash, which reads the whole header. The field this case differs in is
// `adProofsRoot`.
// ===========================================================================
describe('two blocks differing only in adProofsRoot are two blocks', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the second is kept as peer-A pending and ran after the first ends', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    // Clone a2 with a different `adProofsRoot`. The six fields a hand
    // comparison looks at (height, prevBlockHash, utxoTxRoot, stateRoot,
    // powNonce, createdAt) all match; the hash does not.
    const b2: OrderingBlock = {
      ...a2!,
      header: { ...a2!.header, adProofsRoot: 'ff'.repeat(32) },
    };
    expect(blockHash(a2!.header)).not.toBe(blockHash(b2.header));

    let open!: () => void;
    const gateA = new Promise<void>((r) => { open = r; });

    const netA_run = singleBranchNet('peer-A', [shared1!, a2!], {
      headerGate: gateA,
      peerTipOverride: 10,
    });
    const netA_second = singleBranchNet('peer-A', [shared1!, b2], { peerTipOverride: 11 });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    handleOrderingBlock(a2!, 'peer-A', netA_run);
    await vi.waitFor(() => {
      expect(netA_run.headerCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // b2 is NOT the running block (hashes differ). Kept as peer-A pending.
    handleOrderingBlock(b2, 'peer-A', netA_second);

    open();
    await settleResolveForks(ctx);

    expect(netA_run.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(netA_second.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time"
// The same block from a second peer waits as that peer's pending block —
// the node's second chance at the branch when the first counterparty serves
// nothing.
// ===========================================================================
describe('the same block from a second peer waits and is judged', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it("the second peer's net serves the branch and the chain switches", async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const peer = await buildAndApply([[2, T1 + 1], [3, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    let open!: () => void;
    const gateA = new Promise<void>((r) => { open = r; });

    // peer-A answers one empty page under gateA.
    const netA: StubNet = {
      penalties: [],
      headerCalls: { count: 0 },
      blockCalls: { count: 0 },
      getConnectedPeers: () => ['peer-A'],
      peerTipHeight: () => 3,
      penalizePeer: () => undefined,
      requestBlocks: async () => [],
      requestHeaders: async () => {
        netA.headerCalls.count++;
        await gateA;
        return [];
      },
    };
    const netB = singleBranchNet('peer-B', [shared1!, ...peer]);

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const peerTip = peer[peer.length - 1]!;

    handleOrderingBlock(peerTip, 'peer-A', netA);
    await vi.waitFor(() => {
      expect(netA.headerCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // The same block delivered by peer-B is peer-B's pending block, not a
    // repeat of what is running for peer-A.
    handleOrderingBlock(peerTip, 'peer-B', netB);

    open();
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(peerTip.header));
    expect(netB.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends because the tip moved hands its own block back the same way"
// Unless its peer has a later block pending — then the earlier is not
// re-judged, and the later alone goes through.
// ===========================================================================
describe('a tip-moved resolution with a later peer-A pending drops the earlier', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('the earlier block is not asked for a second time', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    // Peer heavier branch, 4 blocks above the shared fork.
    const peer = await buildAndApply([
      [2, T1 + 1], [3, T1 + 2], [4, T1 + 3], [5, T1 + 4],
    ]);
    await revertChainTo(1);
    // Our chain re-mines heights 2, 3 — lighter per block than peer's.
    await buildAndApply([
      [2, T1 + 60_000 + HL],
      [3, T1 + 60_000 + HL + 1000],
    ]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(3);

    const earlierBlock = peer[2]!;  // height 4
    const laterBlock = peer[peer.length - 1]!;  // height 5

    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const netA_earlier = singleBranchNet('peer-A', [shared1!, ...peer], {
      blockGate: gate,
      peerTipOverride: 15,
    });
    const netA_later = singleBranchNet('peer-A', [shared1!, ...peer], { peerTipOverride: 16 });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    // Peer-A delivers the earlier block. Its resolution starts and holds on
    // the block fetch at step 8.
    handleOrderingBlock(earlierBlock, 'peer-A', netA_earlier);
    await vi.waitFor(() => {
      expect(netA_earlier.blockCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // The node mines its own next block, moving the tip from 3 to 4.
    await mineNextBlock(await importBlockCreator());
    expect(ordering.getCurrentHeight()).toBe(4);

    // Peer-A delivers a later block of the same branch — kept as peer-A's
    // pending block.
    handleOrderingBlock(laterBlock, 'peer-A', netA_later);

    open();
    await settleResolveForks(ctx);

    // Rule: the earlier block's resolution ends 'tip-moved' and its peer has
    // a later block pending, so it is not handed back; the pending block
    // alone is judged. netA_earlier is asked exactly once (its original
    // resolution's fork walk), netA_later is asked for its own resolution.
    expect(netA_earlier.headerCalls.count).toBe(1);
    expect(netA_later.headerCalls.count).toBeGreaterThanOrEqual(1);
    expect(ctx.caughtCorrupt).toEqual([]);
  });
});

// ===========================================================================
// NODE_INTERFACE → Fork choice decides on verified headers →
// "One resolution at a time" + NODE_INTERFACE → "What the funnel's totality catch is FOR"
// A resolution ending in the corrupt-state family leaves the runner holding
// nothing — pending blocks are abandoned alongside the one that ran, and the
// idle wait returns.
// ===========================================================================
describe('a resolution ending in a corrupt-state throw leaves the idle wait resting', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it('pending is cleared and waitForForkResolutionIdle returns', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    const [b2] = await buildAndApply([[2, T1 + 2]]);
    await revertChainTo(1);
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    const corrupt = (await import('../../src/services/corrupt-state.js')) as {
      MissingStoredBlockError: new (site: string, height: number) => Error;
    };

    let open!: () => void;
    const gateA = new Promise<void>((r) => { open = r; });
    const netA: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-A'],
      peerTipHeight: () => 10,
      penalizePeer: () => undefined,
      requestBlocks: async () => [],
      requestHeaders: async () => {
        await gateA;
        throw new corrupt.MissingStoredBlockError('resolveFork fixture', 1);
      },
    };
    const netB = singleBranchNet('peer-B', [shared1!, b2!], { peerTipOverride: 11 });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    const { waitForForkResolutionIdle } = await import(
      '../../src/services/fork-resolution-runner.js'
    );

    handleOrderingBlock(a2!, 'peer-A', netA);
    await Promise.resolve();
    await Promise.resolve();
    handleOrderingBlock(b2!, 'peer-B', netB);

    open();

    // A microtask-budget flag detects whether the idle wait settles — the
    // waiter spins microtasks forever if the runner holds pending after a
    // corrupt-state throw.
    let idle = false;
    waitForForkResolutionIdle().then(() => { idle = true; });
    for (let i = 0; i < 500; i++) {
      await Promise.resolve();
    }

    expect(idle).toBe(true);
    expect(ctx.caughtCorrupt.map((e) => (e as Error).constructor.name)).toEqual([
      'MissingStoredBlockError',
    ]);
    // The pending block never ran — the runner held nothing past the throw.
    expect(netB.headerCalls.count).toBe(0);
  });
});

// ===========================================================================
// NODE_INTERFACE → "An unhandled rejection is logged, and the node keeps
// running".
// The runner owns the hand-back loop's throws too: a corrupt-state throw
// reaches the fail-stop boundary, any other throw is logged and the remaining
// pending blocks are still handed back.
// ===========================================================================
describe('a hand-back that throws a plain error does not strand the pending blocks behind it', () => {
  const ctx: Trackers = { caughtCorrupt: [] };
  const armBox: { armed: boolean } = { armed: false };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    armBox.armed = false;
    vi.resetModules();
    installTrackers(ctx);
    // The throw is staged inside the real `handleOrderingBlock` by wrapping
    // one of its direct imports — `extendsOurTip`, called by the handler and
    // by nothing else in the tree (`services/handle-block.ts`). The wrapper
    // throws on its next call when `armBox.armed` is set and clears the arm
    // in the same step, so one hand-back raises a plain `Error` and the next
    // runs through the real implementation.
    vi.doMock('../../src/services/fork-resolution.js', async (importOriginal) => {
      const actual = await importOriginal<
        typeof import('../../src/services/fork-resolution.js')
      >();
      return {
        ...actual,
        extendsOurTip: (block: OrderingBlock) => {
          if (armBox.armed) {
            armBox.armed = false;
            throw new Error('a plain error from a stubbed store read');
          }
          return actual.extendsOurTip(block);
        },
      };
    });
  });

  afterEach(async () => {
    vi.doUnmock('../../src/services/fork-resolution.js');
    await teardownTrackers();
  });

  it('the second pending block is still judged after the first throws', async () => {
    await initChainStore();
    await startCreator(testConfig);

    const [shared1] = await buildAndApply([[1, T1]]);
    // Three non-extending blocks of the shared fork at height 1, each with a
    // distinct stamp so their hashes differ.
    const [a2] = await buildAndApply([[2, T1 + 1]]);
    await revertChainTo(1);
    const [b2] = await buildAndApply([[2, T1 + 2]]);
    await revertChainTo(1);
    const [c2] = await buildAndApply([[2, T1 + 3]]);
    await revertChainTo(1);
    // Our chain = a slow height-2 block so a2, b2 and c2 are all non-extending.
    await buildAndApply([[2, T1 + 60_000 + HL]]);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(2);

    let openRun!: () => void;
    const gateRun = new Promise<void>((r) => { openRun = r; });
    // The running block's net serves no headers — resolveFork reads an empty
    // page and ends with 'done' (NODE_INTERFACE → Fork choice decides on
    // verified headers, step 3).
    const netRun: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-RUN'],
      peerTipHeight: () => 10,
      penalizePeer: () => undefined,
      requestBlocks: async () => [],
      requestHeaders: async () => {
        await gateRun;
        return [];
      },
    };
    const netA = singleBranchNet('peer-A', [shared1!, a2!], { peerTipOverride: 11 });
    const netB = singleBranchNet('peer-B', [shared1!, b2!], { peerTipOverride: 12 });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      // peer-RUN's resolution starts and holds at its header fetch — a
      // microtask settles the dispatch past `requestHeaders`'s suspension on
      // the gate, so the running slot is seated by the time the pending
      // deliveries arrive.
      handleOrderingBlock(c2!, 'peer-RUN', netRun);
      await Promise.resolve();
      await Promise.resolve();
      // peer-A and peer-B each deliver a non-extending block that waits.
      handleOrderingBlock(a2!, 'peer-A', netA);
      handleOrderingBlock(b2!, 'peer-B', netB);

      // Arm the stubbed extendsOurTip so the next call — the first hand-back
      // — throws. The arm sits between the gate release and the hand-back
      // loop; nothing between the two statements calls extendsOurTip.
      armBox.armed = true;
      openRun();
      await settleResolveForks(ctx);

      // The rule: peer-A's hand-back threw a plain Error and peer-B's
      // hand-back still ran, so netB was asked for headers.
      expect(netB.headerCalls.count).toBeGreaterThanOrEqual(1);
      expect(ctx.caughtCorrupt).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

// Suppress an unused-variable warning for `BlockHeader` and `StubNetOptions`
// — exports a type-level reference keeps TS happy under isolatedModules.
export type _CaseFileTypeAnchors = BlockHeader | StubNetOptions;
