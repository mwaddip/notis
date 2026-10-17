import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import {
  changeBoxOf,
  makeApplicableBlock,
  makeTestIdentity,
  seedPostTx,
  signTransaction,
  toHex,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
import {
  T1,
  buildAndApply,
  initChainStore,
  startCreator,
  testConfig,
} from './fork-resolution-fixtures.js';

// NODE_INTERFACE → Store Interface → Posts DAG → "Backfill after sync".

interface RecordedCall {
  wanted: Array<{ id: string; contentHash: string }>;
  peerId: string;
}

interface FakeNet {
  requestLog: RecordedCall[];
  release: () => void;
  deps: {
    getConnectedPeers: () => string[];
    requestPostBodies: (
      wanted: Array<{ id: string; contentHash: string }>,
      peerId: string,
    ) => Promise<Array<{ id: string; content: string }>>;
  };
}

function makeFakeNet(opts: {
  peers: string[];
  heldOpen?: boolean;
  bodies?: Map<string, string>;
}): FakeNet {
  const requestLog: RecordedCall[] = [];
  let release: () => void = () => {};
  const gate = opts.heldOpen
    ? new Promise<void>((resolve) => { release = resolve; })
    : Promise.resolve();
  const bodies = opts.bodies ?? new Map<string, string>();
  return {
    requestLog,
    release: () => release(),
    deps: {
      getConnectedPeers: () => opts.peers,
      requestPostBodies: async (wanted, peerId) => {
        requestLog.push({ wanted, peerId });
        await gate;
        const out: Array<{ id: string; content: string }> = [];
        for (const w of wanted) {
          const body = bodies.get(w.id);
          if (body !== undefined) out.push({ id: w.id, content: body });
        }
        return out;
      },
    },
  };
}

async function wireBackfill(fake: FakeNet): Promise<void> {
  const backfill = await import('../../src/services/backfill.js');
  const posts = await import('../../src/store/posts.js');

  // The driver's deps as `src/index.ts` wires them — the real store reads,
  // not re-implementations, so the fix a store commit lands reaches each case.
  backfill.clearPending();
  backfill.initBackfill({
    requestPostBodies: fake.deps.requestPostBodies,
    getConnectedPeers: fake.deps.getConnectedPeers,
    setPostBody: posts.setPostBody,
    getMissingBodies: posts.getMissingBodies,
    getStillPlaceholderIds: posts.getStillPlaceholderIds,
  });
}

function makePostWithdrawTx(
  author: TestIdentity,
  postId: string,
  karmaBox: KarmaBox,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      { boxType: 'karma', value: karmaBox.value, createdAtBlock: karmaBox.createdAtBlock, owner: author.userId } as never,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  };
  signTransaction(tx, author.privateKey, toHex(author.userId));
  return tx;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function applyNext(block: OrderingBlock, peerId = 'peer-a'): Promise<void> {
  // Direct-apply funnel + the placeholder registrations and backfill the
  // pipeline's extension performs on an applied block (NODE_INTERFACE →
  // Posts → "Backfill after sync"): the subject here is the body puller.
  // The backfill call is fire-and-forget, matching the pipeline's own path.
  const blockApply = await import('../../src/services/block-apply.js');
  expect(blockApply.applyOrderingBlock(block)).toBe(true);
  const backfill = await import('../../src/services/backfill.js');
  const { getPlaceholdersAt } = await import('../../src/store/index.js');
  for (const p of getPlaceholdersAt(block.header.height)) {
    backfill.registerPlaceholder(p.id, p.contentHash, block.header.height, peerId);
  }
  backfill.onBlockApplied(block.header.height).catch(() => {});
}

describe('the body puller', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const bc = await import('../../src/services/block-creator.js');
    try { bc.stopBlockCreator(); } catch { /* not imported */ }
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

  it('a placeholder is asked once while its request is open', async () => {
    await initChainStore();
    await startCreator(testConfig);
    const author = makeTestIdentity();
    const { tx: postTx } = await seedPostTx(author, 'the body');

    const fake = makeFakeNet({ peers: ['peer-a'], heldOpen: true });
    await wireBackfill(fake);

    await buildAndApply([[1, T1]]);
    const h2 = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      utxoTxs: [postTx],
    });
    await applyNext(h2, 'peer-a');
    await flushMicrotasks();
    expect(fake.requestLog).toHaveLength(1);

    const h3 = await makeApplicableBlock({ height: 3, createdAt: T1 + 2 * 60_000 });
    await applyNext(h3);
    await flushMicrotasks();
    const h4 = await makeApplicableBlock({ height: 4, createdAt: T1 + 3 * 60_000 });
    await applyNext(h4);
    await flushMicrotasks();
    const h5 = await makeApplicableBlock({ height: 5, createdAt: T1 + 4 * 60_000 });
    await applyNext(h5);
    await flushMicrotasks();

    expect(fake.requestLog).toHaveLength(1);
  });

  it('a placeholder the store holds at start is asked', async () => {
    await initChainStore();
    await startCreator(testConfig);
    const author = makeTestIdentity();
    const { tx: postTx, postId } = await seedPostTx(author, 'the body');

    // The driver has no deps yet; `registerPlaceholder` adds the row to its
    // in-memory map and `onBlockApplied` returns at the `!deps` guard.
    await buildAndApply([[1, T1]]);
    const h2 = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      utxoTxs: [postTx],
    });
    await applyNext(h2, 'peer-a');

    // The driver clears its in-memory map; the store still holds the row.
    const fake = makeFakeNet({ peers: ['peer-a'] });
    await wireBackfill(fake);

    const h3 = await makeApplicableBlock({ height: 3, createdAt: T1 + 2 * 60_000 });
    await applyNext(h3);
    await flushMicrotasks();

    expect(fake.requestLog.flatMap((c) => c.wanted.map((w) => w.id))).toContain(postId);
  });

  it('a placeholder whose post is withdrawn leaves unasked', async () => {
    await initChainStore();
    await startCreator(testConfig);
    const author = makeTestIdentity();
    const { tx: postTx, postId } = await seedPostTx(author, 'the body');

    const fake = makeFakeNet({ peers: ['peer-a'] });
    await wireBackfill(fake);

    await buildAndApply([[1, T1]]);
    const h2 = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      utxoTxs: [postTx],
    });
    await applyNext(h2, 'peer-a');
    await flushMicrotasks();

    expect(fake.requestLog).toHaveLength(1);

    const withdrawTx = makePostWithdrawTx(author, postId, changeBoxOf(postTx));
    const h3 = await makeApplicableBlock({
      height: 3,
      createdAt: T1 + 2 * 60_000,
      utxoTxs: [withdrawTx],
    });
    await applyNext(h3);
    await flushMicrotasks();

    expect(fake.requestLog).toHaveLength(1);
  });

  it('a placeholder is asked of its relaying peer first and its body leaves the driver when it answers', async () => {
    await initChainStore();
    await startCreator(testConfig);
    const author = makeTestIdentity();
    const { tx: postTx, postId } = await seedPostTx(author, 'the body');

    const bodies = new Map<string, string>([[postId, 'the body']]);
    const fake = makeFakeNet({ peers: ['peer-a'], bodies });
    await wireBackfill(fake);

    await buildAndApply([[1, T1]]);
    const h2 = await makeApplicableBlock({
      height: 2,
      createdAt: T1 + 60_000,
      utxoTxs: [postTx],
    });
    await applyNext(h2, 'peer-a');
    await flushMicrotasks();

    expect(fake.requestLog).toHaveLength(1);
    expect(fake.requestLog[0]!.peerId).toBe('peer-a');
    expect(fake.requestLog[0]!.wanted.map((w) => w.id)).toContain(postId);

    const posts = await import('../../src/store/posts.js');
    expect(posts.getPost(postId)?.content).toBe('the body');

    const backfill = await import('../../src/services/backfill.js');
    expect(backfill.getPendingCount()).toBe(0);
  });
});
