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
} from './fork-resolution-fixtures.js';

// ---------------------------------------------------------------------------
// NODE_INTERFACE → Fork choice decides on verified headers
//
// Nine cases, written against the rule the contract leads. The first is a
// plain `it` that proves the mechanism of a reorg from a non-extending block;
// the rest are `it.fails` — the predicates the rule holds the code to, each
// pinning what the current tree does with the subject's own predicted value
// (NODE_INTERFACE → Fork choice decides on verified headers → "One resolution
// at a time").
// ---------------------------------------------------------------------------

interface Trackers {
  pending: Array<Promise<unknown>>;
  caughtCorrupt: Array<unknown>;
}

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "Both entries
 * converge". The runner's launched resolution promise is not the caller's to
 * hold, so a case captures it through a thin wrapper around the real
 * `resolveFork` export and swaps the fail-stop boundary for one that records
 * rather than exits — the two moves give a case the awaitable settlement and
 * the family that passed through the boundary.
 */
function installTrackers(ctx: Trackers, configOverride?: Partial<ReturnType<typeof makeTestConfig>>): void {
  if (configOverride) {
    const cfg = makeTestConfig(configOverride);
    vi.doMock('../../src/config.js', () => ({ config: cfg, loadConfig: () => cfg }));
  }
  vi.doMock('../../src/services/fork-resolution.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/fork-resolution.js')>();
    const wrapped: typeof actual.resolveFork = (block, net, peer) => {
      const p = actual.resolveFork(block, net, peer);
      ctx.pending.push(p.then(() => undefined, () => undefined));
      return p;
    };
    return { ...actual, resolveFork: wrapped };
  });
  vi.doMock('../../src/services/corrupt-state.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/corrupt-state.js')>();
    const wrapped: typeof actual.failStopIfCorruptChain = ((err: unknown): never => {
      if (err instanceof actual.CorruptChainStateError) {
        ctx.caughtCorrupt.push(err);
        return undefined as never;
      }
      throw err;
    }) as typeof actual.failStopIfCorruptChain;
    return { ...actual, failStopIfCorruptChain: wrapped };
  });
}

async function teardownTrackers(): Promise<void> {
  try {
    const bc = await importBlockCreator();
    bc.stopBlockCreator();
  } catch { /* not started */ }
  try {
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
  } catch { /* not imported */ }
  vi.doUnmock('../../src/services/fork-resolution.js');
  vi.doUnmock('../../src/services/corrupt-state.js');
  vi.doUnmock('../../src/config.js');
  vi.restoreAllMocks();
  vi.resetModules();
}

/**
 * Wait for every launched resolution to settle, including ones that start
 * after an earlier one ends (NODE_INTERFACE → Fork choice decides on verified
 * headers → "A resolution that ends because the tip moved hands its own
 * block back the same way").
 */
async function settleResolveForks(ctx: Trackers): Promise<void> {
  while (true) {
    const before = ctx.pending.length;
    if (before === 0) break;
    await Promise.all(ctx.pending.slice());
    // A pending-queue step may have launched further resolutions.
    if (ctx.pending.length === before) break;
  }
  // Flush any synchronous post-settlement work from the handleOrderingBlock
  // catch chain and the apply path triggered by a block handed back.
  await Promise.resolve();
  await Promise.resolve();
}

/** The devnet far-future stamp the whole file runs under, well inside drift. */
const T1 = 1_700_000_000_000;
const HL = 288 * 60_000;
const FAR_FUTURE = T1 + 40 * 86_400_000;

async function initChainStore(): Promise<void> {
  const db = await importDb();
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const { setClock } = await import('../../src/services/difficulty.js');
  setClock(() => FAR_FUTURE);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

async function startCreator(cfg: ReturnType<typeof makeTestConfig>): Promise<void> {
  const bc = await importBlockCreator();
  bc.startBlockCreator(cfg);
}

async function buildAndApply(specs: Array<[number, number]>): Promise<OrderingBlock[]> {
  const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
  const out: OrderingBlock[] = [];
  for (const [h, c] of specs) {
    const b = await makeApplicableBlock({ height: h, createdAt: c });
    expect(applyOrderingBlock(b)).toBe(true);
    out.push(b);
  }
  return out;
}

interface StubNetOptions {
  readonly headerGate?: Promise<void>;
  readonly blockGate?: Promise<void>;
  readonly onHeaderCall?: () => void;
  readonly onBlockCall?: () => void;
}

interface StubNet extends ForkResolutionNet {
  readonly penalties: Array<{ peerId: string; kind: string; reason: string }>;
  readonly headerCalls: { count: number };
  readonly blockCalls: { count: number };
}

/**
 * The net surface fork resolution uses (NODE_INTERFACE → "The `net` surface
 * fork resolution uses"). Headers paged down from the request's start, blocks
 * drawn by the asked range, both optionally gated by a promise the case
 * releases — a scheduled order of events, not a sleep.
 */
function singleBranchNet(
  peerId: string,
  blocks: readonly OrderingBlock[],
  opts: StubNetOptions = {},
): StubNet {
  const headers = blocks.map((b) => b.header);
  const tip = headers.length > 0 ? Math.max(...headers.map((h) => h.height)) : 0;
  const penalties: Array<{ peerId: string; kind: string; reason: string }> = [];
  const headerCalls = { count: 0 };
  const blockCalls = { count: 0 };
  return {
    penalties,
    headerCalls,
    blockCalls,
    getConnectedPeers: () => [peerId],
    requestHeaders: async (startHeight, maxCount) => {
      headerCalls.count++;
      opts.onHeaderCall?.();
      if (opts.headerGate) await opts.headerGate;
      const clamped = tip === 0 ? startHeight : Math.min(startHeight, tip);
      return headers
        .filter((h) => h.height <= clamped)
        .sort((a, b) => b.height - a.height)
        .slice(0, maxCount);
    },
    requestBlocks: async (startHeight, endHeight) => {
      blockCalls.count++;
      opts.onBlockCall?.();
      if (opts.blockGate) await opts.blockGate;
      return blocks.filter(
        (b) => b.header.height >= startHeight && b.header.height <= endHeight,
      );
    },
    penalizePeer: (p, k, r) => { penalties.push({ peerId: p, kind: k, reason: r }); },
    peerTipHeight: () => (tip === 0 ? null : tip),
  };
}

// ===========================================================================
// Case 1 — control. A non-extending block of a heavier branch switches the
// chain. Plain `it`: it proves the net, the branch builder and the counting
// (NODE_INTERFACE → Fork choice decides on verified headers, steps 1–10).
// ===========================================================================

describe('a non-extending block of a heavier branch switches the chain', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };

  beforeEach(() => {
    ctx.pending = [];
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
// Case 2 — one walk at a time. NODE_INTERFACE → Fork choice decides on
// verified headers → "One resolution at a time": the runner runs resolveFork
// for one block at a time, so N deliveries never put N walks in flight.
// ===========================================================================

describe('one resolution runs at a time, however many deliveries arrive', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it.fails('500 deliveries put at most 1 walk in flight', async () => {
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
// Case 3 — a block that arrives during a switch and extends the new tip is
// applied. NODE_INTERFACE → Fork choice decides on verified headers → "One
// resolution at a time": a block kept pending is handed back when the running
// resolution ends, and judged on the tip that then stands.
// ===========================================================================

describe('a block that arrives during a switch and extends the new tip is applied', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it.fails('tip ends at the extension', async () => {
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
    void ourh2; void ourh3;

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
// Case 4 — two overlapping resolutions never end on the lighter chain.
// NODE_INTERFACE → Fork choice decides on verified headers → "A resolution
// that ends because the tip moved hands its own block back the same way":
// step 9's re-read is a height AND a hash, so a resolution that scored
// against our old tip cannot land on a chain lighter than the one that moved
// us under it.
// ===========================================================================

describe('two overlapping resolutions never end on the lighter chain', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it.fails('the heavier concurrent switch stands', async () => {
    await initChainStore();
    await startCreator(testConfig);

    // Shared genesis block at height 1, slow A at 2-3, fast B at 2-3,
    // medium D at 2-3. Their work ordering is pinned below with
    // `cumulativeWork` — work(B) > work(D) > work(A), per
    // VALIDATION_INTERFACE → cumulativeWork.
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
    // Pre-checks: the three branches relate as the subject requires.
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

    // The record of what the branches were: work(B) > work(D), the subject's
    // predicate. The tip's hash is B3's, not D3's.
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(B3!.header));
  });
});

// ===========================================================================
// Case 5 — an overlap marks no valid block refused. NODE_INTERFACE → Fork
// choice decides on verified headers → "What is remembered, and what is not":
// a persisted mark is only as right as the node that wrote it, and a chain
// scored against a tip that moved before its switch is not a verdict on the
// chain served.
// ===========================================================================

describe('an overlapping resolution marks no valid block refused', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it.fails('no row in refused_headers and no penalty on the valid branch', async () => {
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

    // The one subject's prediction, kept whole: a valid chain is marked
    // nowhere and its peer carries no penalty.
    expect({
      refused: refusedHeaders.anyRefusedHeader([c3Hash]),
      penalties: netC.penalties.map((p) => p.kind),
    }).toEqual({ refused: false, penalties: [] });
  });
});

// ===========================================================================
// Case 6 — a fork below the journals kept is past the horizon.
// NODE_INTERFACE → Fork choice decides on verified headers → "The walk reaches
// as deep as the journals do, and no deeper": step 3 bounds the fork walk by
// the lowest journal kept, so a branch that forks below it is past the
// horizon — no decision, no penalty, nothing of the corrupt-state family.
// ===========================================================================

describe('a fork below the lowest journal kept is past the horizon', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };
  // D=6, base_top=4, A=5 slow blocks (heights 5..9), B=2 fast (5..6),
  // F2=1. Pre-reorg tip 9 purges below 3; after shortening to 6 journals
  // 3..6 are kept, so revertBlock(2) under a C-branch reorg is missing
  // (NODE_INTERFACE → Block Journal, "Rollback").
  const D = 6;
  const BASE_TOP = 4;
  const F2 = 1;

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx, { maxReorgDepth: D });
  });
  afterEach(teardownTrackers);

  it.fails('no decision and no corrupt-state throw', async () => {
    await initChainStore();
    const cfg = makeTestConfig({ maxReorgDepth: D });
    await startCreator(cfg);

    const base: OrderingBlock[] = [];
    for (let h = 1; h <= BASE_TOP; h++) {
      base.push(...(await buildAndApply([[h, T1 + (h - 1) * 60_000]])));
    }

    // C: 6 fast blocks above F2 (heights 2..7), heavy enough to outweigh
    // our chain above F2 after the shortening below. Kept short so no
    // apply during the build triggers `purgeOldJournals` (NODE_INTERFACE
    // → Block Journal, "Rollback").
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

    // Now the C-branch delivery.
    const netC = singleBranchNet('peer-C', [base[0]!, ...C]);
    handleOrderingBlock(C[C.length - 1]!, 'peer-C', netC);
    await settleResolveForks(ctx);

    // The one subject's prediction: nothing of the corrupt-state family
    // reached the fail-stop boundary.
    expect(ctx.caughtCorrupt.map((e) => (e as Error).constructor.name)).toEqual([]);
  });
});

// ===========================================================================
// Case 7 — a block delivered while a shortening switch runs is judged after
// it. NODE_INTERFACE → Fork choice decides on verified headers → "A resolution
// that ends because the tip moved hands its own block back the same way": a
// resolution in flight when the tip drops under it must not read a header
// row the switch deleted and raise a corrupt-state throw.
// ===========================================================================

describe('a block delivered while a shortening switch runs is judged after it', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };
  const D = 6;
  const BASE_TOP = 4;

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx, { maxReorgDepth: D });
  });
  afterEach(teardownTrackers);

  it.fails('no corrupt-state throw from the in-flight resolution', async () => {
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

    // A: five slow blocks above base.
    const t_top = base[BASE_TOP - 1]!.header.createdAt;
    const A: OrderingBlock[] = [];
    for (let i = 0; i < 5; i++) {
      A.push(...(await buildAndApply([[BASE_TOP + 1 + i, t_top + 3 * HL + i]])));
    }
    // A2: a sibling slow branch (different stamps, different hashes), built
    // over the same base so the slow peer serves it to the in-flight
    // resolution without matching our chain's hashes above base
    // (NODE_INTERFACE → Fork choice decides on verified headers, step 3).
    await revertChainTo(BASE_TOP);
    const A2: OrderingBlock[] = [];
    for (let i = 0; i < 5; i++) {
      A2.push(...(await buildAndApply([[BASE_TOP + 1 + i, t_top + 3 * HL + 100 + i]])));
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

    // In-flight resolution: a slow peer that serves the A2 sibling branch
    // and holds at the fork-walk's first header request. The gate holds
    // this resolution open while the shortening switch below runs.
    const chainA2 = [...base, ...A2];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const slow = singleBranchNet('peer-slow', chainA2, { headerGate: gate });

    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    handleOrderingBlock(A2[A2.length - 1]!, 'peer-slow', slow);
    await vi.waitFor(() => {
      expect(slow.headerCalls.count).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    // The shortening switch via B runs to its switch.
    const netB = singleBranchNet('peer-B', [...base, ...B]);
    handleOrderingBlock(B[1]!, 'peer-B', netB);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ordering.getCurrentHeight()).toBe(BASE_TOP + 2);

    open();
    await settleResolveForks(ctx);

    // The one subject's prediction: nothing of the corrupt-state family
    // reached the fail-stop boundary (NODE_INTERFACE → "What the funnel's
    // totality catch is FOR").
    expect(ctx.caughtCorrupt.map((e) => (e as Error).constructor.name)).toEqual([]);
  });
});

// ===========================================================================
// Case 8 — a resolution that ends because the tip moved judges its block
// again. NODE_INTERFACE → Fork choice decides on verified headers →
// "A resolution that ends because the tip moved hands its own block back
// the same way": the block is handed back to the runner, not dropped.
// ===========================================================================

describe('a resolution that ends because the tip moved judges its block again', () => {
  const ctx: Trackers = { pending: [], caughtCorrupt: [] };

  beforeEach(() => {
    ctx.pending = [];
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });
  afterEach(teardownTrackers);

  it.fails('the node ends on the still-heavier peer branch', async () => {
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

    // Our own next block applies — nothing serialises an apply against a
    // paused resolution today.
    await mineNextBlock(await importBlockCreator());
    expect(ordering.getCurrentHeight()).toBe(4);

    open();
    await settleResolveForks(ctx);

    // Rule: the aborted resolution hands the block back; the runner
    // re-judges it on the tip that stands (now 4). The peer's branch is
    // still heavier, so the second judgment reorgs to it.
    expect(ordering.getOrderingBlockHash(peerTip.header.height)).toBe(
      blockHash(peerTip.header),
    );
  });
});

// ===========================================================================
// Case 9 — a stored row that will not decode is the corrupt-state family's.
// NODE_INTERFACE → Store Interface → Ordering blocks, `getInterlinks`:
// "a row that will not decode is `UnreadableStoredBlockError`"; and
// Block Journal, `getBlockJournal`: the same guard.
// ===========================================================================

describe('a stored interlinks row that will not decode is the corrupt-state family', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not started */ }
    try {
      const { setClock } = await import('../../src/services/difficulty.js');
      setClock(null);
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.fails('getInterlinks raises UnreadableStoredBlockError for garbage bytes', async () => {
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

    // The one subject's prediction.
    expect(() => ordering.getInterlinks(2)).toThrow(corrupt.UnreadableStoredBlockError);
  });
});

describe('a stored journal row that will not decode is the corrupt-state family', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not started */ }
    try {
      const { setClock } = await import('../../src/services/difficulty.js');
      setClock(null);
    } catch { /* not imported */ }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.fails('getBlockJournal raises UnreadableStoredBlockError for garbage bytes', async () => {
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

    // The one subject's prediction.
    expect(() => journal.getBlockJournal(2)).toThrow(corrupt.UnreadableStoredBlockError);
  });
});

// Suppress an unused-variable warning for `BlockHeader` and `StubNetOptions`
// — exports a type-level reference keeps TS happy under isolatedModules.
export type _CaseFileTypeAnchors = BlockHeader | StubNetOptions;
