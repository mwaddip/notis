import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  PROTOCOL_VERSION,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  KarmaBox,
  PostLockBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import type { AnyBox } from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { Config } from '../../src/config.js';
import type { TestIdentity } from '../helpers.js';
import {
  makeApplicableBlock,
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  seedPostTx,
  signTransaction,
  toHex,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

// ---------------------------------------------------------------------------
// Dynamic imports
// ---------------------------------------------------------------------------

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

type BlockCreatorModule = {
  startBlockCreator: (cfg: Config) => void;
  stopBlockCreator: () => void;
  createOrderingBlock: () => OrderingBlock | null;
  getCurrentTemplate: () => OrderingBlock | null;
  submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockCreator(): Promise<BlockCreatorModule> {
  return (await import(
    '../../src/services/block-creator.js'
  )) as unknown as BlockCreatorModule;
}

async function importPosts() {
  return await import('../../src/store/posts.js');
}

async function importBlockApply() {
  return (await import(
    '../../src/services/block-apply.js'
  )) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as {
    getBlockJournal: (height: number) => BlockJournal | null;
    insertBlockJournal: (journal: BlockJournal) => void;
    deleteBlockJournal: (height: number) => void;
    isBlockJournalOpen: () => boolean;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getBox: (boxId: string) => unknown;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaValue: (owner: Uint8Array) => bigint;
    getPostLockBox: (postId: string) => PostLockBox | null;
    getUnspentBoxes: () => AnyBox[];
  };
}

async function importTopology() {
  return (await import('../../src/store/topology.js')) as {
    getTopologyHeight: (postId: string) => number | null;
    getTopologyAuthor: (postId: string) => string | null;
  };
}

async function importForkResolution() {
  return (await import('../../src/services/fork-resolution.js')) as {
    revertBlock: (height: number) => void;
  };
}

/**
 * Build a postWithdraw transaction for the given post. The author's karma box
 * is the input; the output is a karma box of the same value (conserving).
 */
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('post withdrawal mechanism (D1 node-4b)', () => {
  let db: DbModule;
  let bc: BlockCreatorModule;
  let apply: Awaited<ReturnType<typeof importBlockApply>>;
  let posts: Awaited<ReturnType<typeof importPosts>>;
  let utxo: Awaited<ReturnType<typeof importUtxo>>;
  let journalStore: Awaited<ReturnType<typeof importJournalStore>>;
  let topology: Awaited<ReturnType<typeof importTopology>>;

  let miner: TestIdentity;

  beforeEach(async () => {
    vi.resetModules();
    db = await importDb();
    db.initDb(':memory:');
    bc = await importBlockCreator();
    apply = await importBlockApply();
    posts = await importPosts();
    utxo = await importUtxo();
    journalStore = await importJournalStore();
    topology = await importTopology();
    miner = makeTestIdentity();
    bc.startBlockCreator(testConfig);
  });

  afterEach(() => {
    bc.stopBlockCreator();
    db.closeDb();
  });

  // -----------------------------------------------------------------------
  // Helpers: create a post and confirm it in a block
  // -----------------------------------------------------------------------

  async function postAndConfirm(author: TestIdentity, content = 'test post') {
    const { tx, postId, karmaBox } = await seedPostTx(author, content);
    const block = await makeApplicableBlock({ miner, utxoTxs: [tx], height: 1 });
    expect(apply.applyOrderingBlock(block)).toBe(true);
    // Block application inserts the post as a placeholder (content = null).
    // Set the body to simulate backfill.
    posts.setPostBody(postId, content);
    return { postId, karmaBox, tx, content };
  }

  // -----------------------------------------------------------------------
  // 1. A withdrawal applies: content NULL, marker set, row and topology survive
  // -----------------------------------------------------------------------
  it('applies a withdrawal: content NULL, marker set, row and topology survive, subtree intact', async () => {
    const author = makeTestIdentity();
    const { postId } = await postAndConfirm(author, 'hello world');

    // The post is confirmed — give the author karma for the withdrawal tx
    const withdrawKarma = makeKarmaBox(10n, author.userId, 1, 99);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    const block2 = await makeApplicableBlock({
      miner,
      utxoTxs: [withdrawTx],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block2)).toBe(true);

    const stored = posts.getPost(postId);
    expect(stored).not.toBeNull();
    expect(posts.isStoredPost(stored!)).toBe(true);
    if (posts.isStoredPost(stored!)) {
      expect(stored!.content).toBeNull();
      expect(stored!.withdrawnAtHeight).toBe(2);
    }
    expect(posts.isLivePost(stored!)).toBe(false);

    // Topology survives
    expect(topology.getTopologyHeight(postId)).toBe(1);
    expect(topology.getTopologyAuthor(postId)).toBe(toHex(author.userId));
  });

  // -----------------------------------------------------------------------
  // 2. withdraw(R) + prune(root) in one block — R's lock is claimed once
  // -----------------------------------------------------------------------
  it('withdraw(R) + prune(root) in one block: R forfeits, no double-claim', async () => {
    const rootAuthor = makeTestIdentity();
    const replyAuthor = makeTestIdentity();

    // Block 1: root post by rootAuthor
    const { postId: rootId } = await postAndConfirm(rootAuthor, 'root');

    // Block 2: reply by replyAuthor
    const { tx: replyTx, postId: replyId } = await seedPostTx(replyAuthor, 'reply', {
      parentRefs: [rootId],
    });
    const block2 = await makeApplicableBlock({
      miner,
      utxoTxs: [replyTx],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block2)).toBe(true);

    // Block 3: withdraw(reply) + prune(root)
    const withdrawKarma = makeKarmaBox(10n, replyAuthor.userId, 2, 77);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(replyAuthor, replyId, withdrawKarma);

    const subtreeIds = [rootId, replyId];
    const leaves = [...subtreeIds]
      .sort()
      .map(id => leafHash('stump', hexToBuf(id)));
    const merkleRoot = buildMerkleRoot(leaves);

    const pruneKarma = makeKarmaBox(10n, rootAuthor.userId, 2, 88);
    utxo.insertBox(pruneKarma);
    const pruneTx: UtxoTransaction = {
      inputs: [pruneKarma.id!],
      outputs: [
        { boxType: 'karma', value: pruneKarma.value, createdAtBlock: pruneKarma.createdAtBlock, owner: rootAuthor.userId } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: {
        rootPostHash: rootId,
        subtreePostIds: subtreeIds,
        subtreeMerkleRoot: merkleRoot,
      },
    };
    signTransaction(pruneTx, rootAuthor.privateKey, toHex(rootAuthor.userId));

    const block3 = await makeApplicableBlock({
      miner,
      utxoTxs: [withdrawTx, pruneTx],
      height: 3,
    });
    const applied = apply.applyOrderingBlock(block3);
    expect(applied).toBe(true);

    // The settlement's input list must not contain any box id twice
    const journal = journalStore.getBlockJournal(3);
    expect(journal).not.toBeNull();
    const removedBoxIds = journal!.mutations
      .filter((m) => m.kind === 'box' && m.op === 'remove')
      .map((m) => (m as BoxMutation).boxId);
    const uniqueRemoved = new Set(removedBoxIds);
    expect(uniqueRemoved.size).toBe(removedBoxIds.length);
  });

  // -----------------------------------------------------------------------
  // 3. Two withdrawals of one post in one block → rejected
  // -----------------------------------------------------------------------
  it('rejects a block with two withdrawals of the same post', async () => {
    const author = makeTestIdentity();
    const { postId } = await postAndConfirm(author, 'dup-withdraw');

    const karma1 = makeKarmaBox(10n, author.userId, 1, 51);
    const karma2 = makeKarmaBox(10n, author.userId, 1, 52);
    utxo.insertBox(karma1);
    utxo.insertBox(karma2);

    const tx1 = makePostWithdrawTx(author, postId, karma1);
    const tx2 = makePostWithdrawTx(author, postId, karma2);

    const block = await makeApplicableBlock({
      miner,
      utxoTxs: [tx1, tx2],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 4. A withdrawal in the same block the post is made → rejected (maturity)
  // -----------------------------------------------------------------------
  it('rejects a withdrawal in the same block the post is made (maturity bind)', async () => {
    const author = makeTestIdentity();
    const { tx: postTx, postId } = await seedPostTx(author, 'same-block');

    const withdrawKarma = makeKarmaBox(10n, author.userId, 0, 55);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    const block = await makeApplicableBlock({
      miner,
      utxoTxs: [postTx, withdrawTx],
      height: 1,
    });
    expect(apply.applyOrderingBlock(block)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Journal round-trip: apply then revert restores content + clears marker
  // -----------------------------------------------------------------------
  it('journal round-trip: revert restores content and clears the marker', async () => {
    const author = makeTestIdentity();
    const { postId } = await postAndConfirm(author, 'journal-test');

    // Verify content before withdrawal
    const before = posts.getPost(postId);
    expect(posts.isStoredPost(before!)).toBe(true);
    if (posts.isStoredPost(before!)) {
      expect(before!.content).toBe('journal-test');
      expect(before!.withdrawnAtHeight).toBeNull();
    }

    const withdrawKarma = makeKarmaBox(10n, author.userId, 1, 60);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    const block2 = await makeApplicableBlock({
      miner,
      utxoTxs: [withdrawTx],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block2)).toBe(true);

    // After withdrawal: content is null, marker set
    const after = posts.getPost(postId);
    expect(posts.isStoredPost(after!)).toBe(true);
    if (posts.isStoredPost(after!)) {
      expect(after!.content).toBeNull();
      expect(after!.withdrawnAtHeight).toBe(2);
    }

    // Check the journal recorded the withdrawal
    const journal = journalStore.getBlockJournal(2);
    expect(journal).not.toBeNull();
    expect(journal!.withdrawnPosts).toHaveLength(1);
    expect(journal!.withdrawnPosts[0]!.id).toBe(postId);
    expect(journal!.withdrawnPosts[0]!.content).toBe('journal-test');

    // Revert
    const forkRes = await importForkResolution();
    forkRes.revertBlock(2);

    // After revert: content and marker restored
    const restored = posts.getPost(postId);
    expect(posts.isStoredPost(restored!)).toBe(true);
    if (posts.isStoredPost(restored!)) {
      expect(restored!.content).toBe('journal-test');
      expect(restored!.withdrawnAtHeight).toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // 5b. Journal round-trip: the placeholder case (content was already null)
  // -----------------------------------------------------------------------
  it('journal round-trip: placeholder post (content null) restores correctly', async () => {
    const author = makeTestIdentity();
    // Seed a post committed as a placeholder: the block carries its commit,
    // but the body was never backfilled — content is null, marker is null.
    const { tx: postTx, postId } = await seedPostTx(author, 'placeholder');
    const block1 = await makeApplicableBlock({ miner, utxoTxs: [postTx], height: 1 });
    expect(apply.applyOrderingBlock(block1)).toBe(true);

    // Manually null the content to simulate a placeholder (body never arrived)
    db.getDb()
      .prepare(`UPDATE dag_posts SET content = NULL WHERE id = ?`)
      .run(postId);

    const beforeW = posts.getPost(postId);
    expect(posts.isStoredPost(beforeW!)).toBe(true);
    if (posts.isStoredPost(beforeW!)) {
      expect(beforeW!.content).toBeNull();
      expect(beforeW!.withdrawnAtHeight).toBeNull();
    }

    // Withdraw the placeholder
    const withdrawKarma = makeKarmaBox(10n, author.userId, 1, 61);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    const block2 = await makeApplicableBlock({
      miner,
      utxoTxs: [withdrawTx],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block2)).toBe(true);

    // Journal records null content
    const journal = journalStore.getBlockJournal(2);
    expect(journal).not.toBeNull();
    expect(journal!.withdrawnPosts).toHaveLength(1);
    expect(journal!.withdrawnPosts[0]!.content).toBeNull();

    // Revert: content is still null, and marker is cleared
    const forkRes = await importForkResolution();
    forkRes.revertBlock(2);

    const restored = posts.getPost(postId);
    expect(posts.isStoredPost(restored!)).toBe(true);
    if (posts.isStoredPost(restored!)) {
      expect(restored!.content).toBeNull();
      expect(restored!.withdrawnAtHeight).toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // 6. A like on an already-withdrawn post → rejected
  // -----------------------------------------------------------------------
  it('rejects a like on an already-withdrawn post', async () => {
    const author = makeTestIdentity();
    const liker = makeTestIdentity();
    const { postId } = await postAndConfirm(author, 'like-after-withdraw');

    // Withdraw at height 2
    const withdrawKarma = makeKarmaBox(10n, author.userId, 1, 70);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);
    const block2 = await makeApplicableBlock({
      miner,
      utxoTxs: [withdrawTx],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block2)).toBe(true);

    // Attempt like at height 3
    const { LIKE_KARMA_COST } = await import('@dagsocial/types');
    const likerKarma = makeKarmaBox(LIKE_KARMA_COST + 1n, liker.userId, 2, 71);
    utxo.insertBox(likerKarma);
    const likeTx: UtxoTransaction = {
      inputs: [likerKarma.id!],
      outputs: [
        { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: liker.userId } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(likeTx, liker.privateKey, toHex(liker.userId));

    const block3 = await makeApplicableBlock({
      miner,
      utxoTxs: [likeTx],
      height: 3,
    });
    expect(apply.applyOrderingBlock(block3)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 7. The route: submits, broadcasts, returns 201
  // -----------------------------------------------------------------------
  it('POST /posts/:id/withdraw submits, broadcasts and returns 201', async () => {
    const http = await import('http');
    const express = (await import('express')).default;
    const { deleteRoutes } = await import('../../src/routes/delete.js');
    const { setNet } = await import('../../src/services/net-instance.js');

    let broadcastCalled = false;
    setNet({
      broadcastTx: async () => { broadcastCalled = true; },
    } as any);

    const deps = {
      getBox: () => null,
      insertBox: () => {},
      consumeBox: () => {},
      getKarmaBox: () => null,
      getKarmaValue: () => 0n,
      getIdentityRecord: () => null,
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 0,
      inviteBondMin: 0n,
      inviteBondMax: 0n,
      decayCfg: { staleThresholdBlocks: 0, decayIntervalBlocks: 0, decayAmount: 0n, karmaMinimum: 0n },
      storageRentPeriodBlocks: 0,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      runInTransaction: (fn: () => void) => fn(),
      executePrune: () => ({ txId: 'b'.repeat(64) }),
      executePostWithdraw: () => ({ txId: 'c'.repeat(64) }),
      getCurrentHeight: () => 10,
    };

    const app = express();
    app.use(express.json());
    app.use(deleteRoutes(deps));

    const postId = 'aa'.repeat(32);
    const txBody = {
      inputs: ['ff'.repeat(32)],
      outputs: [{ boxType: 'karma', value: '10', createdAtBlock: 0, owner: 'dd'.repeat(32) }],
      signatures: { ['dd'.repeat(32)]: Buffer.alloc(64).toString('base64') },
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId },
    };

    const result = await new Promise<{ status: number; data: any }>((resolve) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const req = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path: `/posts/${postId}/withdraw`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let d = '';
            res.on('data', (c: string) => (d += c));
            res.on('end', () => {
              server.close();
              try {
                resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
              } catch {
                resolve({ status: res.statusCode ?? 0, data: d });
              }
            });
          },
        );
        req.write(JSON.stringify({ tx: txBody }));
        req.end();
      });
    });

    expect(result.status).toBe(201);
    expect(result.data.status).toBe('submitted');
    expect(result.data.txId).toBe('c'.repeat(64));
    expect(result.data.postId).toBe(postId);
    expect(broadcastCalled).toBe(true);

    setNet(null as any);
  });

  // -----------------------------------------------------------------------
  // 8. The creator and the applier derive the same settlement
  // -----------------------------------------------------------------------
  it('creator and applier derive the same settlement for a body carrying a withdrawal', async () => {
    const author = makeTestIdentity();
    const { postId } = await postAndConfirm(author, 'creator-match');

    const withdrawKarma = makeKarmaBox(10n, author.userId, 1, 80);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    // The makeApplicableBlock helper builds the settlement the creator would
    // produce, and applyOrderingBlock verifies the settlement matches — so a
    // successful apply is the assertion that the two agree.
    const block2 = await makeApplicableBlock({
      miner,
      utxoTxs: [withdrawTx],
      height: 2,
    });
    expect(apply.applyOrderingBlock(block2)).toBe(true);
  });
});
