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
  installTrackers,
  singleBranchNet,
  startCreator,
  teardownTrackers,
  testConfig,
} from './fork-resolution-fixtures.js';
import type { Trackers } from './fork-resolution-fixtures.js';

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
  const db = await import('../../src/store/db.js');

  // The driver's two reads over the store — same predicate as `getMissingBodies`
  // (NODE_INTERFACE → Store Interface → Posts DAG). Inline so the dep shape
  // the driver sees does not reach back to the store function's signature.
  const getMissingBodies = (): Array<{ id: string; contentHash: string }> => {
    const rows = db.getDb()
      .prepare(
        `SELECT id, content_hash FROM dag_posts
         WHERE content IS NULL AND withdrawn_at_height IS NULL
         ORDER BY block_height DESC, block_index DESC`,
      )
      .all() as Array<{ id: string; content_hash: string }>;
    return rows.map((r) => ({ id: r.id, contentHash: r.content_hash }));
  };
  const getStillPlaceholderIds = (ids: readonly string[]): string[] =>
    ids.filter((id) => {
      const row = posts.getPost(id);
      return row !== null && row.content === null && row.withdrawnAtHeight === null;
    });

  backfill.clearPending();
  const deps = {
    requestPostBodies: fake.deps.requestPostBodies,
    getConnectedPeers: fake.deps.getConnectedPeers,
    setPostBody: posts.setPostBody,
    getMissingBodies,
    getStillPlaceholderIds,
  };
  backfill.initBackfill(deps);
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
  const stub = singleBranchNet(peerId, [block]);
  const { handleOrderingBlock } = await import('../../src/services/handle-block.js');
  expect(handleOrderingBlock(block, peerId, stub)).toBe(true);
}

describe('the body puller', () => {
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
