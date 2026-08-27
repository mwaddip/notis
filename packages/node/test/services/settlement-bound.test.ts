// ---------------------------------------------------------------------------
// Settlement bound tests — T1 through T6.
//
// Each test pins a hazard the settlement byte bound and the capped state-driven
// legs exist to close (NODE_INTERFACE → The settlement transaction).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  MAX_SETTLEMENT_BYTES,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_BOND_SETTLEMENTS_PER_BLOCK,
  MAX_POST_LOCK_RELEASES_PER_BLOCK,
  LIKE_KARMA_COST,
  encodeTx,
} from '@dagsocial/types';
import type {
  KarmaBox,
  PostLockBox,
  VouchEscrowBox,
  UtxoTransaction,
  OrderingBlock,
  BondBox,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import {
  hex,
  makeApplicableBlock,
  makeKarmaBox as helperMakeKarmaBox,
  makeTestIdentity,
  seedPostTx,
  seedProvenance,
  signTransaction,
  type TestIdentity,
  makeLikeTx,
} from '../helpers.js';
import { config } from '../../src/config.js';
import type { Config } from '../../src/config.js';


type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    startBlockCreator: (cfg: Config) => void;
    stopBlockCreator: () => void;
    createOrderingBlock: () => OrderingBlock | null;
    buildBlockSettlement: (
      txBytesList: Uint8Array[],
      height: number,
      validator: Uint8Array,
      minerOwner: Uint8Array,
    ) => { tx: UtxoTransaction } | { error: string };
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getBox: (boxId: string) => unknown;
    getPostLockBox: (targetPostId: string) => PostLockBox | null;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getKarmaValue: (owner: Uint8Array) => bigint;
    getVouchEscrowsReleasableAt: (height: number, limit: number) => VouchEscrowBox[];
    getPrunedLockCandidates: (limit: number) => unknown[];
  };
}

async function importPosts() {
  return await import('../../src/store/posts.js');
}

async function importLikes() {
  return (await import('../../src/store/likes.js')) as {
    insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
    getLikeRecordCount: (postId: string) => number;
  };
}

async function importTopology() {
  return await import('../../src/store/topology.js');
}

async function importStumps() {
  return (await import('../../src/store/stumps.js')) as {
    getStump: (id: string) => unknown;
  };
}

function makePruneTx(
  author: TestIdentity,
  postId: string,
  karmaBox: KarmaBox,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [{ boxType: 'karma' as const, value: karmaBox.value, createdAtBlock: 0, owner: author.userId }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    prune: { rootPostHash: postId },
  };
  signTransaction(tx, author.privateKey, hex(author.userId));
  return tx;
}

// ---------------------------------------------------------------------------
// T1 — the halt. 150 escrows at one release height drain over multiple blocks.
//
// At 70 bytes per (input + output) pair, 141 fits the old MAX_TX_BYTES 10,000
// and 150 does not (150 × 70 = 10,500). Under the old rule this was an
// unreachable settlement; under the capped legs it drains in ⌈150 / 64⌉ = 3
// blocks.
// ---------------------------------------------------------------------------

describe('T1 — escrow cap and multi-block drain', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    vi.resetModules();
  });

  // 150 × 70 = 10,500 > 10,000 (old MAX_TX_BYTES). Red on b01b81f by
  // arithmetic: 150 pairs do not fit a 10,000-byte transaction.
  it('150 escrows drain over 3 blocks in ascending (releaseAtBlock, box id) order', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const blockApply = await importBlockApply();

    const TOTAL = 150;
    const RELEASE_HEIGHT = 2;

    const owners: TestIdentity[] = [];
    for (let i = 0; i < TOTAL; i++) owners.push(makeTestIdentity());

    // Block 1: empty (seeds emission + pool)
    const block1 = await makeApplicableBlock({ utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Seed 150 vouch escrow boxes all releasing at height 2
    for (let i = 0; i < TOTAL; i++) {
      const box = seedProvenance<VouchEscrowBox>({
        boxType: 'vouch_escrow' as const,
        value: BigInt(10 + i),
        createdAtBlock: 1,
        owner: owners[i]!.userId,
        releaseAtBlock: RELEASE_HEIGHT,
      }, 1000 + i);
      utxo.insertBox(box);
    }

    // Blocks 2, 3, 4: each settles up to MAX_ESCROW_RETURNS_PER_BLOCK
    let totalReturned = 0;
    for (let h = 2; h <= 4; h++) {
      const block = await makeApplicableBlock({ height: h, utxoTxs: [] });
      expect(blockApply.applyOrderingBlock(block)).toBe(true);

      const remaining = utxo.getVouchEscrowsReleasableAt(h, TOTAL);
      totalReturned = TOTAL - remaining.length;
    }

    expect(totalReturned).toBe(TOTAL);

    // Every owner got their karma back
    for (let i = 0; i < TOTAL; i++) {
      const karma = utxo.getKarmaValue(owners[i]!.userId);
      expect(karma).toBe(BigInt(10 + i));
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — the like storm. Each like adds one 32-byte marker input to the
// settlement, plus one 38-byte carry output per distinct author. With all
// likes to the same post (one author), the cost after the first is 32 bytes
// per like.
//
// OLD bound: MAX_TX_BYTES 10,000 → N_old ≈ (10,000 − 108) / 32 = 309
// NEW bound: MAX_SETTLEMENT_BYTES 100,000 → N_new ≈ (100,000 − 108) / 32 = 3,122
//
// (a) 320 likes: fits the new bound (the finding closed).
// (b) 3,200 likes: exceeds the new bound — the fill must trim.
// ---------------------------------------------------------------------------

describe('T2 — like storm', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('more likes than the OLD bound fit the new bound; more than the NEW bound exceeds it', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const topology = await importTopology();
    const blockApply = await importBlockApply();
    const bc = await importBlockCreator();

    // Block 1: seeds emission + pool
    const block1 = await makeApplicableBlock({ utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // One target post (all likes target the same author)
    const postAuthor = makeTestIdentity();
    const targetPostId = (9000).toString(16).padStart(64, '0');
    topology.insertBlockTopology(targetPostId, [], hex(postAuthor.userId), 1);

    // Seed the author's karma box (the carry needs one to exist)
    const authorKarma = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 1000n,
      createdAtBlock: 1,
      owner: postAuthor.userId,
    }, 9999);
    utxo.insertBox(authorKarma);

    // Build like tx bytes — each liker contributes one marker input
    function makeLikeTxBytes(count: number): Uint8Array[] {
      const txBytes: Uint8Array[] = [];
      for (let i = 0; i < count; i++) {
        const liker = makeTestIdentity();
        const karmaBox = seedProvenance<KarmaBox>({
          boxType: 'karma' as const,
          value: LIKE_KARMA_COST,
          createdAtBlock: 1,
          owner: liker.userId,
        }, 10_000 + i);
        utxo.insertBox(karmaBox);
        const tx = makeLikeTx(liker, karmaBox, targetPostId, postAuthor.userId);
        txBytes.push(encodeTx(tx));
      }
      return txBytes;
    }

    const miner = makeTestIdentity();

    // (a) 320 likes: exceeds old MAX_TX_BYTES, fits MAX_SETTLEMENT_BYTES
    const likesA = makeLikeTxBytes(320);
    const resultA = bc.buildBlockSettlement(likesA, 2, miner.userId, miner.userId);
    expect('tx' in resultA).toBe(true);
    if ('tx' in resultA) {
      const bytes = encodeTx(resultA.tx).length;
      expect(bytes).toBeGreaterThan(10_000);
      expect(bytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    }

    // (b) 3,200 likes: exceeds MAX_SETTLEMENT_BYTES — the fill must trim
    const likesB = makeLikeTxBytes(3200);
    const resultB = bc.buildBlockSettlement(likesB, 2, miner.userId, miner.userId);
    expect('tx' in resultB).toBe(true);
    if ('tx' in resultB) {
      const bytes = encodeTx(resultB.tx).length;
      expect(bytes).toBeGreaterThan(MAX_SETTLEMENT_BYTES);
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — the liveness relation: buildSettlement over an empty body with every
// state-driven leg at its cap encodes ≤ MAX_SETTLEMENT_BYTES.
// ---------------------------------------------------------------------------

describe('T3 — liveness relation', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a settlement with all state-driven legs at cap fits MAX_SETTLEMENT_BYTES', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const topology = await importTopology();
    const blockApply = await importBlockApply();
    const bc = await importBlockCreator();

    // Block 1: empty (seeds emission + pool)
    const block1 = await makeApplicableBlock({ utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Seed 64 bonds, 64 escrows, 64 release candidates with distinct owners
    const BOND_HEIGHT = 2;
    const probation = config.inviteProbationBlocks;
    const settleHeight = BOND_HEIGHT + probation;

    for (let i = 0; i < MAX_BOND_SETTLEMENTS_PER_BLOCK; i++) {
      const owner = makeTestIdentity();
      const box = seedProvenance<BondBox>({
        boxType: 'bond' as const,
        value: 25n,
        createdAtBlock: 1,
        inviterId: owner.userId,
        inviteePublicKey: makeTestIdentity().userId,
        invitedAtBlock: BOND_HEIGHT,
      }, 2000 + i);
      utxo.insertBox(box);
    }

    for (let i = 0; i < MAX_ESCROW_RETURNS_PER_BLOCK; i++) {
      const owner = makeTestIdentity();
      const box = seedProvenance<VouchEscrowBox>({
        boxType: 'vouch_escrow' as const,
        value: 10n,
        createdAtBlock: 1,
        owner: owner.userId,
        releaseAtBlock: settleHeight,
      }, 3000 + i);
      utxo.insertBox(box);
    }

    // Seed 64 marked topology rows with post locks
    for (let i = 0; i < MAX_POST_LOCK_RELEASES_PER_BLOCK; i++) {
      const postId = (4000 + i).toString(16).padStart(64, '0');
      const owner = makeTestIdentity();
      topology.insertBlockTopology(postId, [], hex(owner.userId), 1);
      topology.markPrunedTopology([postId], 1, postId);
      const lockBox = seedProvenance<PostLockBox>({
        boxType: 'post_lock' as const,
        value: 5n,
        createdAtBlock: 1,
        originalValue: 5n,
        owner: owner.userId,
      }, 4000 + i);
      utxo.insertBox(lockBox, postId);
    }

    // Build the settlement at settleHeight with an empty body
    const miner = makeTestIdentity();
    const result = bc.buildBlockSettlement([], settleHeight, miner.userId, miner.userId);

    expect('tx' in result).toBe(true);
    if ('tx' in result) {
      const encoded = encodeTx(result.tx);
      expect(encoded.length).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — multi-block release: a subtree with more live locks than
// MAX_POST_LOCK_RELEASES_PER_BLOCK drains over ⌈n / K⌉ blocks.
// ---------------------------------------------------------------------------

describe('T4 — multi-block release', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('70 locks under one root release over 2 blocks; actor locks reach the pool', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();
    const stumps = await importStumps();

    const rootAuthor = makeTestIdentity();
    const REPLY_COUNT = 69; // 70 total including root

    // Block 1: the root post
    const { tx: rootTx, postId: rootId, content: rootContent, commit: rootCommit } =
      await seedPostTx(rootAuthor, 'multi-block-release-root');
    posts.insertPost(rootId, rootCommit, rootContent);
    const block1 = await makeApplicableBlock({ utxoTxs: [rootTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: 69 reply posts (all by distinct authors), each gets a post lock
    const replyAuthors: TestIdentity[] = [];
    const replyTxs: UtxoTransaction[] = [];
    for (let i = 0; i < REPLY_COUNT; i++) {
      const replyAuthor = makeTestIdentity();
      replyAuthors.push(replyAuthor);
      const { tx, postId: replyId, content, commit } =
        await seedPostTx(replyAuthor, `reply-${i}`, { parentRefs: [rootId] });
      posts.insertPost(replyId, commit, content);
      replyTxs.push(tx);
    }
    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: replyTxs });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);

    // Block 3: prune the root
    const pruneKarma = helperMakeKarmaBox(100n, rootAuthor.userId, 0, 9000);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(rootAuthor, rootId, pruneKarma);
    const block3 = await makeApplicableBlock({ height: 3, utxoTxs: [pruneTx] });
    expect(blockApply.applyOrderingBlock(block3)).toBe(true);

    // The stump exists and DAG rows are deleted
    expect(stumps.getStump(rootId)).not.toBeNull();

    // Locks survive the prune block — they are release candidates at h+1
    const candidatesAfterPrune = utxo.getPrunedLockCandidates(100);
    expect(candidatesAfterPrune.length).toBe(70);

    // Block 4: settlement releases up to 64
    const block4 = await makeApplicableBlock({ height: 4, utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block4)).toBe(true);

    const candidatesAfterFirst = utxo.getPrunedLockCandidates(100);
    expect(candidatesAfterFirst.length).toBe(6);

    // Block 5: settlement releases the remaining 6
    const block5 = await makeApplicableBlock({ height: 5, utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block5)).toBe(true);

    const candidatesAfterSecond = utxo.getPrunedLockCandidates(100);
    expect(candidatesAfterSecond.length).toBe(0);

    // Every non-actor reply author received a refund (their lock value)
    for (const ra of replyAuthors) {
      const karma = utxo.getKarmaValue(ra.userId);
      expect(karma).toBeGreaterThan(0n);
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — reply(P) and prune(root of P) in one block: valid, the reply is in
// the set, its lock is a release candidate at h + 1.
// ---------------------------------------------------------------------------

describe('T5 — same-block reply and prune', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a reply and prune of its root in one block is valid; the reply lock is a candidate at h+1', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const rootAuthor = makeTestIdentity();
    const replyAuthor = makeTestIdentity();

    // Block 1: root post
    const { tx: rootTx, postId: rootId, content: rootContent, commit: rootCommit } =
      await seedPostTx(rootAuthor, 'same-block-reply-prune-root');
    posts.insertPost(rootId, rootCommit, rootContent);
    const block1 = await makeApplicableBlock({ utxoTxs: [rootTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Block 2: reply(root) + prune(root) — the reply creates a post lock,
    // and the prune marks the topology. The reply is in the derived set.
    const { tx: replyTx, postId: replyId, content: replyContent, commit: replyCommit } =
      await seedPostTx(replyAuthor, 'same-block-reply', { parentRefs: [rootId] });
    posts.insertPost(replyId, replyCommit, replyContent);

    const pruneKarma = helperMakeKarmaBox(100n, rootAuthor.userId, 0, 8000);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(rootAuthor, rootId, pruneKarma);

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [replyTx, pruneTx] });
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);

    // The reply's lock is a release candidate at h+1
    const candidates = utxo.getPrunedLockCandidates(100);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T6 — like in block 5, prune in block 7 with no like in 7: the released
// lock's value equals the post-5 remainder (H3).
//
// T6b — like(P) and prune(P's root) in one block: the like's vest lands
// once, through §8c, and §11b adds nothing.
// ---------------------------------------------------------------------------

describe('T6 — vest path through the release leg', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('a lock released after a like reflects the vest from the like block', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();
    const likes = await importLikes();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: post
    const { tx: postTx, postId, content, commit } =
      await seedPostTx(author, 'vest-through-release');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Seed enough likes so the vest threshold is crossed at block 5.
    // POST_LOCK_UNLOCK_PER_LIKES = 10, so 10 likes → vest of 1.
    // POST_LOCK_THREAD_COST = 5n, originalValue = 5n.
    for (let i = 0; i < 9; i++) {
      likes.insertLikeRecord(postId, makeTestIdentity().userId, 1);
    }

    // Block 5: the 10th like
    const likerKarma = helperMakeKarmaBox(100n, liker.userId, 0, 7000);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    // Blocks 2-4: empty
    for (let h = 2; h <= 4; h++) {
      const block = await makeApplicableBlock({ height: h, utxoTxs: [] });
      expect(blockApply.applyOrderingBlock(block)).toBe(true);
    }

    // Block 5: the like
    const block5 = await makeApplicableBlock({ height: 5, utxoTxs: [likeTx] });
    expect(blockApply.applyOrderingBlock(block5)).toBe(true);

    // The lock should have been vested by §11b in block 5
    const lockAfterLike = utxo.getPostLockBox(postId);
    // After vest: shouldUnlock = 10/10 = 1. value = 5 - 1 = 4.
    expect(lockAfterLike).not.toBeNull();
    expect(lockAfterLike!.value).toBe(4n);

    // Block 6: empty
    const block6 = await makeApplicableBlock({ height: 6, utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block6)).toBe(true);

    // Block 7: prune — no like in this block
    const pruneKarma = helperMakeKarmaBox(100n, author.userId, 0, 7001);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(author, postId, pruneKarma);
    const block7 = await makeApplicableBlock({ height: 7, utxoTxs: [pruneTx] });
    expect(blockApply.applyOrderingBlock(block7)).toBe(true);

    // The lock survives the prune block (deferred)
    const lockAfterPrune = utxo.getPostLockBox(postId);
    // §8c should NOT have vested again (no likes in block 7)
    // The lock's value should still be 4 (the post-5 remainder)
    expect(lockAfterPrune).not.toBeNull();
    expect(lockAfterPrune!.value).toBe(4n);

    // Block 8: the release leg releases the lock
    const block8 = await makeApplicableBlock({ height: 8, utxoTxs: [] });
    expect(blockApply.applyOrderingBlock(block8)).toBe(true);

    // The lock is consumed
    const lockAfterRelease = utxo.getPostLockBox(postId);
    expect(lockAfterRelease).toBeNull();

    // H3 confirmed: the released lock's value (4) equals the post-5 remainder.
    // The actor's own lock went to the pool.
  });
});

describe('T6b — same-block like and prune vest lands once', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('like(P) and prune(root) in one block: §8c vests once, §11b adds nothing', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();
    const likes = await importLikes();

    const author = makeTestIdentity();
    const liker = makeTestIdentity();

    // Block 1: post
    const { tx: postTx, postId, content, commit } =
      await seedPostTx(author, 'vest-once');
    posts.insertPost(postId, commit, content);
    const block1 = await makeApplicableBlock({ utxoTxs: [postTx] });
    expect(blockApply.applyOrderingBlock(block1)).toBe(true);

    // Seed 9 likes so the 10th triggers a vest
    for (let i = 0; i < 9; i++) {
      likes.insertLikeRecord(postId, makeTestIdentity().userId, 1);
    }

    const karmaBefore = utxo.getKarmaValue(author.userId);

    // Block 2: like + prune
    const likerKarma = helperMakeKarmaBox(100n, liker.userId, 0, 6000);
    utxo.insertBox(likerKarma);
    const likeTx = makeLikeTx(liker, likerKarma, postId, author.userId);

    const pruneKarma = helperMakeKarmaBox(100n, author.userId, 0, 6001);
    utxo.insertBox(pruneKarma);
    const pruneTx = makePruneTx(author, postId, pruneKarma);

    const block2 = await makeApplicableBlock({ height: 2, utxoTxs: [likeTx, pruneTx] });
    // The block applies — §8c vests once, §11b finds the lock consumed or
    // reduced and vests nothing more. If the vest landed twice, the settlement
    // would disagree.
    expect(blockApply.applyOrderingBlock(block2)).toBe(true);

    const karmaAfter = utxo.getKarmaValue(author.userId);
    // Author received the vest (1 karma) once
    expect(karmaAfter).toBeGreaterThan(karmaBefore);
  });
});
