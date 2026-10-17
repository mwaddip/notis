import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockHash, cumulativeWork } from '@dagsocial/validation';
import type { OrderingBlock } from '@dagsocial/types';
import type { NetNode } from '@dagsocial/net';
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
  startCreator,
  testConfig,
} from './fork-resolution-fixtures.js';

/**
 * Apply a block as the pipeline's extension would — direct `applyOrderingBlock`
 * is the funnel the extension enters too (NODE_INTERFACE → "Apply funnel:
 * validation and mutation phases"), so the post-commit behaviour the subject
 * here measures — the template, the journal line, the tip report — is the
 * same. Answers `true` when the block applied, `false` otherwise.
 */
async function applyAsRelay(block: OrderingBlock, _peerId = 'peer-a'): Promise<boolean> {
  const blockApply = await import('../../src/services/block-apply.js');
  return blockApply.applyOrderingBlock(block);
}

/**
 * Drive a reorg to the branch — the branch blocks are staged with the peer
 * that delivered the tip, and `reorg(f, hashes)` is called. Branch4 is the
 * tip of the branch here; branches have the shape `[branch2, branch3,
 * branch4]` above `f = 1`. A `'consensus'` body refusal marks the branch's
 * tip header and penalises the deliverer, matching the pipeline's own path
 * (NODE_INTERFACE → "A body-stage refusal marks the header.").
 */
interface BranchDrive {
  readonly penalties: Array<{ peerId: string; kind: 'misbehavior' | 'transient'; reason: string }>;
}
async function driveBranchReorg(
  branch: readonly OrderingBlock[],
  f: number,
  peerId: string,
): Promise<BranchDrive> {
  const { encodeOrderingBlock } = await import('@dagsocial/types');
  const { blockHash } = await import('@dagsocial/validation');
  const { stageBlock } = await import('../../src/store/header-tree.js');
  const forkResolution = await import('../../src/services/fork-resolution.js');
  const refused = await import('../../src/store/refused-headers.js');
  const { getCurrentHeight } = await import('../../src/store/ordering.js');
  const { insertRefusedHeader } = refused;
  const hashes = branch.map((b) => blockHash(b.header)).filter((h): h is string => h !== null);
  for (const b of branch) {
    const h = blockHash(b.header);
    if (h === null) continue;
    stageBlock(h, b.header.height, encodeOrderingBlock(b), peerId);
  }
  const penalties: Array<{ peerId: string; kind: 'misbehavior' | 'transient'; reason: string }> = [];
  try {
    forkResolution.reorg(f, hashes);
  } catch (err) {
    const { ReorgBlockRejectedError, ReorgAbortedError } = await import('../../src/services/corrupt-state.js');
    if (err instanceof ReorgBlockRejectedError) {
      insertRefusedHeader(err.hash, err.height, getCurrentHeight());
      penalties.push({ peerId, kind: 'misbehavior', reason: `reorg consensus refusal at height ${err.height}` });
    } else if (err instanceof ReorgAbortedError) {
      /* abort — no mark, no penalty */
    } else {
      throw err;
    }
  }
  return { penalties };
}

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
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not imported */ }
    const backfill = await import('../../src/services/backfill.js');
    backfill.clearPending();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    const intake = await import('../../src/services/intake.js');
    intake.resetIntakeForTests();
    intake.clearIntakeSeamsForTests();
    const pipeline = await import('../../src/services/header-pipeline.js');
    pipeline.resetPipelineForTests();
    vi.restoreAllMocks();
    vi.resetModules();
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
    
        expect(await applyAsRelay(refused, 'peer-a')).toBe(false);
    

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
    
        expect(await applyAsRelay(refused, 'peer-a')).toBe(false);
    

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
      
            expect(await applyAsRelay(refused, 'peer-a')).toBe(false);
      

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
      
      const startIdx = stdoutLines.length;
            expect(await applyAsRelay(refused, 'peer-a')).toBe(false);
      

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
    
        expect(await applyAsRelay(honest, 'peer-a')).toBe(true);
    

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
    
    const startIdx = stdoutLines.length;
        expect(await applyAsRelay(honest, 'peer-a')).toBe(true);
    

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
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not imported */ }
    const backfill = await import('../../src/services/backfill.js');
    backfill.clearPending();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    const intake = await import('../../src/services/intake.js');
    intake.resetIntakeForTests();
    intake.clearIntakeSeamsForTests();
    const pipeline = await import('../../src/services/header-pipeline.js');
    pipeline.resetPipelineForTests();
    vi.restoreAllMocks();
    vi.resetModules();
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

    const drive = await driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a');
    const branch4Hash = blockHash(sc.branch4.header)!;
        
    

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(drive.penalties.length).toBe(1);
    expect(drive.penalties[0]!.kind).toBe('misbehavior');

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
    const drive = await driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a');

    const startIdx = stdoutLines.length;
        
    

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(drive.penalties.length).toBe(1);
    expect(drive.penalties[0]!.kind).toBe('misbehavior');

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

    const drive = await driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a');
        
    

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(drive.penalties.length).toBe(1);
    expect(drive.penalties[0]!.kind).toBe('misbehavior');

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

    const drive = await driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a');
        
    

    expect(ordering.getCurrentHeight()).toBe(3);
    expect(ordering.getOrderingBlockHash(3)).toBe(blockHash(sc.ourTip3.header));
    const refused = await import('../../src/store/refused-headers.js');
    expect(refused.anyRefusedHeader([branch4Hash])).toBe(true);
    expect(drive.penalties.length).toBe(1);
    expect(drive.penalties[0]!.kind).toBe('misbehavior');

    const applied = appliedLinesFrom(logSpy.mock.calls, startIdx);
    const forbidden = applied.filter(
      (s) =>
        s.startsWith(`Applied ordering block height=2 hash=${branch2Hash}`) ||
        s.startsWith(`Applied ordering block height=3 hash=${branch3Hash}`),
    );
    expect(forbidden).toEqual([]);
  });

  it('a reorg that switches journals its post once its own transaction has committed', async () => {
    installStdoutCapture();
    const { initJournal } = await import('../../src/journal.js');
    initJournal();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: false });
    const ordering = await importOrdering();

    expect(sc.branchWork > sc.ourWork).toBe(true);

    // The chain's height at the moment the reorg's post emits `post_indexed`
    // (NODE_INTERFACE → "What follows the commit is the commit's"). The
    // post-commit loop runs with the switched tip in place, so this reads 4;
    // a loop inside the transaction reads the height the nested apply left.
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

    await driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a');
        
    

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

    await driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a');
        
    

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

// ---------------------------------------------------------------------------
// A throw from net's relay gate between the commit and the rebuild.
//
// NODE_INTERFACE → Triggers → "The template is voided at the commit that moves
// the tip, and nowhere else". The void runs before anything else that follows
// the commit (NODE_INTERFACE → "What follows the commit is the commit's"), so a
// throw after it leaves no template rather than one built on the tip the commit
// replaced. The funnel calls `addKarmaMember`/`removeKarmaMember` once its
// transaction committed; `reorg` calls `setKarmaMembers` once its transaction
// committed.
// ---------------------------------------------------------------------------

function throwingRelayGateNet(message: string): NetNode {
  return {
    addKarmaMember(_authorHex: string): void { throw new Error(message); },
    removeKarmaMember(_authorHex: string): void { throw new Error(message); },
    setKarmaMembers(_members: Iterable<string>): void { throw new Error(message); },
  } as unknown as NetNode;
}

describe('a throw after the commit leaves no template', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { setNet } = await import('../../src/services/net-instance.js');
    setNet(null as unknown as NetNode);
    try { (await importBlockCreator()).stopBlockCreator(); } catch { /* not imported */ }
    const backfill = await import('../../src/services/backfill.js');
    backfill.clearPending();
    const { setClock } = await import('../../src/services/difficulty.js');
    setClock(null);
    const intake = await import('../../src/services/intake.js');
    intake.resetIntakeForTests();
    intake.clearIntakeSeamsForTests();
    const pipeline = await import('../../src/services/header-pipeline.js');
    pipeline.resetPipelineForTests();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a block whose relay-gate call throws after it commits leaves the committed tip and no template', async () => {
    installStdoutCapture();
    await initChainStore();
    await startCreator(testConfig);
    const author = makeTestIdentity();
    const { tx: postTx } = await seedPostTx(author, 'the commit\'s');
    const bc = await importBlockCreator();
    const ordering = await importOrdering();
    await buildAndApply([[1, T1]]);

    const tplBefore = bc.getCurrentTemplate();
    expect(tplBefore).not.toBeNull();
    expect(tplBefore!.header.height).toBe(2);

    const block = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      utxoTxs: [postTx],
    });

    const { setNet } = await import('../../src/services/net-instance.js');
    setNet(throwingRelayGateNet('relay gate down'));

    await expect(applyAsRelay(block, 'peer-a')).rejects.toThrow('relay gate down');

    expect({
      height: ordering.getCurrentHeight(),
      hash: ordering.getOrderingBlockHash(ordering.getCurrentHeight()),
      template: bc.getCurrentTemplate(),
    }).toEqual({
      height: 2,
      hash: blockHash(block.header),
      template: null,
    });
  });

  it('a reorg whose relay-gate call throws after it commits leaves the switched tip and no template', async () => {
    installStdoutCapture();
    const { initJournal } = await import('../../src/journal.js');
    initJournal();
    const sc = await buildBranchSetting({ lyingAdProofsRoot: false });
    const bc = await importBlockCreator();
    const ordering = await importOrdering();

    expect(sc.ourWork > 0n).toBe(true);
    expect(sc.branchWork > sc.ourWork).toBe(true);
    const tplBefore = bc.getCurrentTemplate();
    expect(tplBefore).not.toBeNull();
    expect(tplBefore!.header.height).toBe(4);

    const { setNet } = await import('../../src/services/net-instance.js');
    setNet(throwingRelayGateNet('relay gate down'));

    await expect(driveBranchReorg([sc.branch2, sc.branch3, sc.branch4], 1, 'peer-a'))
      .rejects.toThrow('relay gate down');

    expect({
      height: ordering.getCurrentHeight(),
      hash: ordering.getOrderingBlockHash(ordering.getCurrentHeight()),
      template: bc.getCurrentTemplate(),
    }).toEqual({
      height: 4,
      hash: blockHash(sc.branch4.header),
      template: null,
    });
  });
});
