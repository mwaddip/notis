import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import {
  hex,
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makeTestIdentity,
  seedPostTx,
  signTransaction,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importPosts() {
  return await import('../../src/store/posts.js');
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getKarmaValue: (owner: Uint8Array) => bigint;
  };
}

async function importLikes() {
  return (await import('../../src/store/likes.js')) as {
    getLikeRecordCount: (postId: string) => number;
  };
}

// ---------------------------------------------------------------------------

function makePostWithdrawTx(
  author: ReturnType<typeof makeTestIdentity>,
  postId: string,
  karmaBox: KarmaBox,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [{ boxType: 'karma' as const, value: karmaBox.value, createdAtBlock: 0, owner: author.userId }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: {
      postId,
    },
  };
  signTransaction(tx, author.privateKey, hex(author.userId));
  return tx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
});

describe('phase-move: like(P) + postWithdraw(P) in one block', () => {
  it('accepts a block carrying a like and a postWithdraw of the same post', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: confirm the post
    const { tx: postTx, postId, content, commit } = await seedPostTx(author, 'like-and-withdraw');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: like(P) + postWithdraw(P)
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 200);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const withdrawKarma = makeKarmaBox(100n, author.userId, 0, 201);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, withdrawTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);
  });
});

describe('phase-move: a withdrawal does not erase a same-block like', () => {
  it('a postWithdraw in the same block as a like does not erase the like-record', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();
    const likes = await importLikes();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: confirm the post
    const { tx: postTx, postId, content, commit } = await seedPostTx(author, 'like-record-count');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: like(P) + postWithdraw(P) — the like-record should survive
    // the withdrawal (NODE_INTERFACE → Withdrawal transactions; the withdrawal
    // moves no value and empties no record but the post's own content).
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 400);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const withdrawKarma = makeKarmaBox(100n, author.userId, 0, 401);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, withdrawTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);

    expect(likes.getLikeRecordCount(postId)).toBe(1);
    expect(posts.isLivePost(posts.getPost(postId))).toBe(false);
  });
});

describe('phase-move: creator/applier settlement agreement', () => {
  it('a block with like(P) + postWithdraw(P) built by the creator is accepted by the applier', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: confirm the post
    const { tx: postTx, postId, content, commit } = await seedPostTx(author, 'agreement-test');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: like + postWithdraw — makeApplicableBlock uses the creator's
    // buildBlockSettlement, and applyOrderingBlock independently derives its
    // own settlement. If the two disagree, the block is rejected.
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 500);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const withdrawKarma = makeKarmaBox(100n, author.userId, 0, 501);
    utxo.insertBox(withdrawKarma);
    const withdrawTx = makePostWithdrawTx(author, postId, withdrawKarma);

    // The block's settlement is the creator's derivation. If the applier's
    // derivation diverges (§6.1), this apply fails — pinning the constraint.
    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, withdrawTx] });
    const applied = blockApply.applyOrderingBlock(block2);
    expect(applied).toBe(true);
  });
});
