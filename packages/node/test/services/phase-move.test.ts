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

async function importStumps() {
  return (await import('../../src/store/stumps.js')) as {
    getStump: (stumpId: string) => { upvoteCount: number } | null;
  };
}

// ---------------------------------------------------------------------------

function makePruneTx(
  author: ReturnType<typeof makeTestIdentity>,
  postId: string,
  karmaBox: KarmaBox,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [{ boxType: 'karma' as const, value: karmaBox.value, createdAtBlock: 0, owner: author.userId }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    prune: {
      rootPostHash: postId,
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

describe('phase-move: like(P) + prune(P) in one block', () => {
  it('accepts a block carrying a like and a prune of the same post', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: confirm the post
    const { tx: postTx, postId, content, commit } = await seedPostTx(author, 'like-and-prune');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: like(P) + prune(P)
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 200);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const pruneKarma = makeKarmaBox(100n, author.userId, 0, 201);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(author, postId, pruneKarma);

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, pruneTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);
  });
});

describe('phase-move: stump upvoteCount includes own block likes', () => {
  it('a stump created from a prune in the same block as a like counts that like', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();
    const stumps = await importStumps();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: confirm the post
    const { tx: postTx, postId, content, commit } = await seedPostTx(author, 'stump-count');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: like(P) + prune(P) — the stump's upvoteCount should be 1
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 400);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const pruneKarma = makeKarmaBox(100n, author.userId, 0, 401);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(author, postId, pruneKarma);

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, pruneTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);

    const stump = stumps.getStump(postId);
    expect(stump).not.toBeNull();
    expect(stump!.upvoteCount).toBe(1);
  });
});

describe('phase-move: creator/applier settlement agreement', () => {
  it('a block with like(P) + prune(P) built by the creator is accepted by the applier', async () => {
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

    // Block 2: like + prune — makeApplicableBlock uses the creator's
    // buildBlockSettlement, and applyOrderingBlock independently derives its
    // own settlement. If the two disagree, the block is rejected.
    const likerKarma = makeKarmaBox(100n, liker.userId, 0, 500);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const pruneKarma = makeKarmaBox(100n, author.userId, 0, 501);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(author, postId, pruneKarma);

    // The block's settlement is the creator's derivation. If the applier's
    // derivation diverges (§6.1), this apply fails — pinning the constraint.
    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, pruneTx] });
    const applied = blockApply.applyOrderingBlock(block2);
    expect(applied).toBe(true);
  });
});
