import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockHash, cumulativeWork } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';
import {
  makeApplicableBlock,
  makeTestIdentity,
  revertChainTo,
  seedPostTx,
  solveHeaderPow,
} from '../helpers.js';
import {
  T1,
  buildAndApply,
  importBlockCreator,
  importOrdering,
  initChainStore,
  installTrackers,
  settleResolveForks,
  singleBranchNet,
  startCreator,
  teardownTrackers,
  testConfig,
} from './fork-resolution-fixtures.js';
import type { Trackers } from './fork-resolution-fixtures.js';

// NODE_INTERFACE → Triggers → "The template is voided at the commit that moves the tip, and nowhere else"
// NODE_INTERFACE → "What follows the commit is the commit's"
// NODE_INTERFACE → Store Interface → Posts DAG → "Backfill after sync"
// JOURNAL_EVENTS → post_indexed
// MINING_INTERFACE → Template and submit

// ---------------------------------------------------------------------------
// Capture helpers — the stdout spy and the journal line reader share one
// shape across every case.
// ---------------------------------------------------------------------------

interface JournalLine {
  event?: string;
  post_id?: string;
}

function installStdoutCapture(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

function postIndexedIdsFrom(lines: readonly string[]): string[] {
  const ids: string[] = [];
  for (const raw of lines) {
    let parsed: JournalLine;
    try {
      parsed = JSON.parse(raw) as JournalLine;
    } catch {
      continue;
    }
    if (parsed.event === 'post_indexed' && typeof parsed.post_id === 'string') {
      ids.push(parsed.post_id);
    }
  }
  return ids;
}

function appliedLinesFrom(
  calls: ReadonlyArray<readonly unknown[]>,
  startIdx: number,
): string[] {
  return calls
    .slice(startIdx)
    .map((c) => String(c[0] ?? ''))
    .filter((s) => s.startsWith('Applied ordering block height='));
}

// ---------------------------------------------------------------------------
// A refused block at the next height.
// ---------------------------------------------------------------------------

describe('a refused block at the next height leaves what the commit left', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });

  afterEach(async () => {
    await teardownTrackers();
    const backfill = await import('../../src/services/backfill.js');
    backfill.clearPending();
  });

  it('a block refused at stateRoot leaves the template that stood', async () => {
    installStdoutCapture();
    await initChainStore();
    await startCreator(testConfig);
    const bc = await importBlockCreator();
    const ordering = await importOrdering();
    const [h1] = await buildAndApply([[1, T1]]);

    const tplBefore = bc.getCurrentTemplate();
    expect(tplBefore).not.toBeNull();
    expect(tplBefore!.header.height).toBe(2);

    const refused = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      stateRoot: 'ab'.repeat(33),
    });
    const net = singleBranchNet('peer-a', [refused]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(refused, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(1);
    expect(ordering.getOrderingBlockHash(1)).toBe(blockHash(h1!.header));

    expect(bc.getCurrentTemplate()).toBe(tplBefore);
  });

  it('a block refused at adProofsRoot leaves the template that stood', async () => {
    installStdoutCapture();
    await initChainStore();
    await startCreator(testConfig);
    const bc = await importBlockCreator();
    const ordering = await importOrdering();
    const [h1] = await buildAndApply([[1, T1]]);

    const tplBefore = bc.getCurrentTemplate();
    expect(tplBefore).not.toBeNull();
    expect(tplBefore!.header.height).toBe(2);

    const refused = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      adProofsRoot: 'ab'.repeat(32),
    });
    const net = singleBranchNet('peer-a', [refused]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(refused, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(1);
    expect(ordering.getOrderingBlockHash(1)).toBe(blockHash(h1!.header));

    expect(bc.getCurrentTemplate()).toBe(tplBefore);
  });

  it(
    'a solve of the standing template submits after a refused block has arrived',
    async () => {
      installStdoutCapture();
      await initChainStore();
      await startCreator(testConfig);
      const bc = await importBlockCreator();
      const ordering = await importOrdering();
      await buildAndApply([[1, T1]]);

      const tplBefore = bc.getCurrentTemplate();
      expect(tplBefore).not.toBeNull();
      expect(tplBefore!.header.height).toBe(2);
      const nonce = solveHeaderPow(tplBefore!.header);
      const expectedHash = blockHash({ ...tplBefore!.header, powNonce: nonce });
      expect(expectedHash).not.toBeNull();

      const refused = await makeApplicableBlock({
        height: 2,
        createdAt: T1 + 60_000,
        stateRoot: 'ab'.repeat(33),
      });
      const net = singleBranchNet('peer-a', [refused]);
      const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
      expect(handleOrderingBlock(refused, 'peer-a', net)).toBe(false);
      await settleResolveForks(ctx);

      expect(ordering.getCurrentHeight()).toBe(1);

      const submitResult = bc.submitMinedBlock(nonce, 2);
      expect({
        result: submitResult,
        height: ordering.getCurrentHeight(),
        hash: ordering.getOrderingBlockHash(ordering.getCurrentHeight()),
      }).toEqual({
        result: expectedHash,
        height: 2,
        hash: expectedHash,
      });
    },
  );

  it(
    'a post-carrying block refused at adProofsRoot journals no post as indexed',
    async () => {
      const stdoutLines = installStdoutCapture();
      await initChainStore();
      await startCreator(testConfig);
      const { initJournal } = await import('../../src/journal.js');
      initJournal();
      const author = makeTestIdentity();
      const { tx: postTx, postId } = await seedPostTx(author, 'the commit\'s');
      const bc = await importBlockCreator();
      const ordering = await importOrdering();
      const [h1] = await buildAndApply([[1, T1]]);

      const tplBefore = bc.getCurrentTemplate();
      expect(tplBefore).not.toBeNull();
      expect(tplBefore!.header.height).toBe(2);

      const posts = await import('../../src/store/posts.js');
      expect(posts.getPost(postId)).toBeNull();

      const refused = await makeApplicableBlock({
        height: 2,
        createdAt: T1 + 60_000,
        utxoTxs: [postTx],
        adProofsRoot: 'ab'.repeat(32),
      });
      const net = singleBranchNet('peer-a', [refused]);
      const startIdx = stdoutLines.length;
      const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
      expect(handleOrderingBlock(refused, 'peer-a', net)).toBe(false);
      await settleResolveForks(ctx);

      expect(ordering.getCurrentHeight()).toBe(1);
      expect(ordering.getOrderingBlockHash(1)).toBe(blockHash(h1!.header));
      expect(posts.getPost(postId)).toBeNull();

      expect(postIndexedIdsFrom(stdoutLines.slice(startIdx))).toEqual([]);
    },
  );

  it('a block with the roots it produces applies, and the template stood at h+1 before it arrived', async () => {
    installStdoutCapture();
    await initChainStore();
    await startCreator(testConfig);
    const bc = await importBlockCreator();
    const ordering = await importOrdering();
    await buildAndApply([[1, T1]]);

    const tplBefore = bc.getCurrentTemplate();
    expect(tplBefore).not.toBeNull();
    expect(tplBefore!.header.height).toBe(2);

    const honest = await makeApplicableBlock({ height: 2, createdAt: T1 + 60_000 });
    const net = singleBranchNet('peer-a', [honest]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(honest, 'peer-a', net)).toBe(true);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(2);
    expect(ordering.getOrderingBlockHash(2)).toBe(blockHash(honest.header));
  });

  it('a post-carrying block with the roots it produces journals its post as indexed', async () => {
    const stdoutLines = installStdoutCapture();
    await initChainStore();
    await startCreator(testConfig);
    const { initJournal } = await import('../../src/journal.js');
    initJournal();
    const author = makeTestIdentity();
    const { tx: postTx, postId } = await seedPostTx(author, 'the commit\'s');
    const bc = await importBlockCreator();
    const ordering = await importOrdering();
    await buildAndApply([[1, T1]]);

    expect(bc.getCurrentTemplate()!.header.height).toBe(2);

    const honest = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      utxoTxs: [postTx],
    });
    const net = singleBranchNet('peer-a', [honest]);
    const startIdx = stdoutLines.length;
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(honest, 'peer-a', net)).toBe(true);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(2);
    expect(postIndexedIdsFrom(stdoutLines.slice(startIdx))).toEqual([postId]);
  });
});

// ---------------------------------------------------------------------------
// A heavier branch whose last block is refused — a reorg that rolls back.
// ---------------------------------------------------------------------------

interface BranchSetting {
  readonly shared1: OrderingBlock;
  readonly branch2: OrderingBlock;
  readonly branch3: OrderingBlock;
  readonly branch4: OrderingBlock;
  readonly postId: string;
  readonly ourTip3: OrderingBlock;
  readonly ourWork: bigint;
  readonly branchWork: bigint;
}

async function buildBranchSetting(opts: { lyingAdProofsRoot: boolean }): Promise<BranchSetting> {
  await initChainStore();
  await startCreator(testConfig);
  const author = makeTestIdentity();
  const { tx: postTx, postId } = await seedPostTx(author, 'the commit\'s');
  const [shared1] = await buildAndApply([[1, T1]]);

  // Each chain paces one block per `idealMs` so the schedule leaves the target
  // where it stood (MINING_INTERFACE → Difficulty Schedule); two branch blocks
  // and two of this node's own carry equal work, and the branch is heavier
  // only when its third block is in the sum.
  const spacing = 60_000;
  const { applyOrderingBlock } = (await import('../../src/services/block-apply.js')) as {
    applyOrderingBlock: (b: OrderingBlock) => boolean;
  };
  const branch2 = await makeApplicableBlock({
    height: 2,
    createdAt: T1 + spacing,
    utxoTxs: [postTx],
  });
  expect(applyOrderingBlock(branch2)).toBe(true);
  const branch3 = await makeApplicableBlock({ height: 3, createdAt: T1 + 2 * spacing });
  expect(applyOrderingBlock(branch3)).toBe(true);
  const branch4 = await makeApplicableBlock({
    height: 4,
    createdAt: T1 + 3 * spacing,
    ...(opts.lyingAdProofsRoot ? { adProofsRoot: 'ab'.repeat(32) } : {}),
  });

  await revertChainTo(1);

  const posts = await import('../../src/store/posts.js');
  expect(posts.getPost(postId)).not.toBeNull();
  posts.deletePendingPost(postId);
  expect(posts.getPost(postId)).toBeNull();

  const [ourTip2, ourTip3] = await buildAndApply([
    [2, T1 + spacing],
    [3, T1 + 2 * spacing],
  ]);

  const branchWork = cumulativeWork([branch2.header, branch3.header, branch4.header]);
  const ourWork = cumulativeWork([ourTip2!.header, ourTip3!.header]);

  return {
    shared1: shared1!,
    branch2,
    branch3,
    branch4,
    postId,
    ourTip3: ourTip3!,
    ourWork,
    branchWork,
  };
}

describe('a reorg that rolls back leaves what the commit left', () => {
  const ctx: Trackers = { caughtCorrupt: [] };

  beforeEach(() => {
    ctx.caughtCorrupt = [];
    vi.resetModules();
    installTrackers(ctx);
  });

  afterEach(async () => {
    await teardownTrackers();
    const backfill = await import('../../src/services/backfill.js');
    backfill.clearPending();
  });

  it('a reorg that rolls back leaves the template that stood', async () => {
    installStdoutCapture();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: true });
    const bc = await importBlockCreator();
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);
    const tplBefore = bc.getCurrentTemplate();
    expect(tplBefore).not.toBeNull();
    expect(tplBefore!.header.height).toBe(4);

    const net = singleBranchNet('peer-a', [sc.shared1, sc.branch2, sc.branch3, sc.branch4]);
    const branch4Hash = blockHash(sc.branch4.header)!;
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branch4, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(net.penalties.length).toBe(1);
    expect(net.penalties[0]!.kind).toBe('misbehavior');

    expect(bc.getCurrentTemplate()).toBe(tplBefore);
  });

  it('a reorg that rolls back journals no post as indexed', async () => {
    const stdoutLines = installStdoutCapture();
    const { initJournal } = await import('../../src/journal.js');
    initJournal();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: true });
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);
    const branch4Hash = blockHash(sc.branch4.header)!;
    const net = singleBranchNet('peer-a', [sc.shared1, sc.branch2, sc.branch3, sc.branch4]);

    const startIdx = stdoutLines.length;
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branch4, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(net.penalties.length).toBe(1);
    expect(net.penalties[0]!.kind).toBe('misbehavior');

    expect(postIndexedIdsFrom(stdoutLines.slice(startIdx))).toEqual([]);
  });

  it('a reorg that rolls back leaves the backfill driver as it was', async () => {
    installStdoutCapture();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: true });
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);
    const branch4Hash = blockHash(sc.branch4.header)!;
    const backfill = await import('../../src/services/backfill.js');
    const pendingBefore = backfill.getPendingCount();

    const net = singleBranchNet('peer-a', [sc.shared1, sc.branch2, sc.branch3, sc.branch4]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branch4, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(net.penalties.length).toBe(1);
    expect(net.penalties[0]!.kind).toBe('misbehavior');

    expect(backfill.getPendingCount()).toBe(pendingBefore);
  });

  it('a reorg that rolls back logs no applied-block line for any of its blocks', async () => {
    installStdoutCapture();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: true });
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);
    const branch4Hash = blockHash(sc.branch4.header)!;
    const branch2Hash = blockHash(sc.branch2.header);
    const branch3Hash = blockHash(sc.branch3.header);

    const logSpy = vi.spyOn(console, 'log');
    const startIdx = logSpy.mock.calls.length;

    const net = singleBranchNet('peer-a', [sc.shared1, sc.branch2, sc.branch3, sc.branch4]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branch4, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(net.penalties.length).toBe(1);
    expect(net.penalties[0]!.kind).toBe('misbehavior');

    const applied = appliedLinesFrom(logSpy.mock.calls, startIdx);
    const forbidden = applied.filter(
      (s) =>
        s.startsWith(`Applied ordering block height=2 hash=${branch2Hash}`) ||
        s.startsWith(`Applied ordering block height=3 hash=${branch3Hash}`),
    );
    expect(forbidden).toEqual([]);
  });

  it('a reorg\'s post emits post_indexed with the switched tip as the chain\'s height — the commit\'s own', async () => {
    installStdoutCapture();
    const { initJournal } = await import('../../src/journal.js');
    initJournal();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: false });
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);

    // The chain's height at the moment the reorg's post emits `post_indexed`
    // (NODE_INTERFACE → "What follows the commit is the commit's"). The
    // post-commit loop runs with the switched tip in place, so this reads 4;
    // a loop inside the transaction reads the savepoint's own committed
    // height.
    let heightAtIndexed: number | null = null;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      const line = String(chunk);
      try {
        const parsed = JSON.parse(line) as JournalLine;
        if (parsed.event === 'post_indexed' && parsed.post_id === sc.postId && heightAtIndexed === null) {
          heightAtIndexed = ordering.getCurrentHeight();
        }
      } catch { /* a non-JSON stdout line */ }
      return true;
    });

    const net = singleBranchNet('peer-a', [sc.shared1, sc.branch2, sc.branch3, sc.branch4]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branch4, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(4);
    expect(heightAtIndexed).toBe(4);
  });

  it('the same branch with an honest last block switches the chain and records every effect', async () => {
    const stdoutLines = installStdoutCapture();
    const { initJournal } = await import('../../src/journal.js');
    initJournal();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: false });
    const bc = await importBlockCreator();
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);
    const backfill = await import('../../src/services/backfill.js');
    const pendingBefore = backfill.getPendingCount();

    const logSpy = vi.spyOn(console, 'log');
    const logStart = logSpy.mock.calls.length;
    const stdoutStart = stdoutLines.length;

    const net = singleBranchNet('peer-a', [sc.shared1, sc.branch2, sc.branch3, sc.branch4]);
    const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
    expect(handleOrderingBlock(sc.branch4, 'peer-a', net)).toBe(false);
    await settleResolveForks(ctx);

    expect(ordering.getCurrentHeight()).toBe(4);
    expect(ordering.getOrderingBlockHash(4)).toBe(blockHash(sc.branch4.header));

    expect(postIndexedIdsFrom(stdoutLines.slice(stdoutStart))).toEqual([sc.postId]);
    expect(backfill.getPendingCount()).toBe(pendingBefore + 1);

    const applied = appliedLinesFrom(logSpy.mock.calls, logStart);
    expect(
      applied.some((s) => s.startsWith(`Applied ordering block height=2 hash=${blockHash(sc.branch2.header)}`)),
    ).toBe(true);
    expect(
      applied.some((s) => s.startsWith(`Applied ordering block height=3 hash=${blockHash(sc.branch3.header)}`)),
    ).toBe(true);
    expect(
      applied.some((s) => s.startsWith(`Applied ordering block height=4 hash=${blockHash(sc.branch4.header)}`)),
    ).toBe(true);

    expect(bc.getCurrentTemplate()).not.toBeNull();
    expect(bc.getCurrentTemplate()!.header.height).toBe(5);
  });
});
