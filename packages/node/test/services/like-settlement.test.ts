import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  LIKES_PER_KARMA_PAYOUT,
  REPLY_AUTHOR_SHARE,
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
  type TestIdentity,
  activateProverOverStore,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// P2-D N2b: per-block like settlement (NODE_INTERFACE → Per-block like
// settlement; ARCHITECTURE → Likes). The settlement is entirely derived —
// nothing rides in the block — so what these tests pin is the one shared
// implementation both producer and verifier run:
//
//   - apply-time like rules (confirmed + live target, author from topology,
//     structural dedup, liker = karma input owner) — any failure rejects the
//     whole block;
//   - author settlement arithmetic (carry, integer payout, the
//     grouping-independence property) and mint identity;
//   - exact inverses for every new mutation class (apply → revert → re-apply
//     round-trips through the real reorg path, digest identity included).
//
// Blocks are hand-built via makeApplicableBlock — including its P2-D
// `utxoTxs` embedding, which is the validator-embeds-a-tx shape that
// bypasses every gateway. That is deliberate: apply-time rules are consensus,
// not gateway courtesy, so the suite reaches them without the gateway's help.
// ---------------------------------------------------------------------------

const X = BigInt(LIKES_PER_KARMA_PAYOUT);

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

async function importForkResolution() {
  return (await import('../../src/services/fork-resolution.js')) as {
    reorg: (forkHeight: number, newBlocks: OrderingBlock[]) => void;
    revertBlock: (height: number) => unknown;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => { id?: string; value: bigint } | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaValue: (owner: Uint8Array) => bigint;
    getLikeCarryBox: (
      author: Uint8Array,
      exclude: Set<string>,
    ) => { value: bigint; author: Uint8Array; id?: string } | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importPosts() {
  return await import('../../src/store/posts.js');
}

async function importLikeRecords() {
  return (await import('../../src/store/likes.js')) as {
    insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
    hasLikeRecord: (targetPostId: string, likerId: Uint8Array) => boolean;
    getLikeRecordCount: (postId: string) => number;
  };
}

async function importRecords() {
  return (await import('../../src/store/identity-records.js')) as {
    getIdentityRecord: (
      id: Uint8Array,
    ) => { lastActivityBlock: number; lastDecayBlock: number; lifetimeLikesReceived: bigint, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } | null;
  };
}

async function importJournalStore() {
  return (await import('../../src/store/journal.js')) as typeof import('../../src/store/journal.js');
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
  };
}

async function importAvl() {
  return (await import('../../src/state/avl-prover.js')) as typeof import('../../src/state/avl-prover.js');
}

// ---------------------------------------------------------------------------
// Harness (the journal-roundtrip idiom, extended with `like_records` — the
// suite's own mutation class must be part of DB identity or a revert that
// leaked a record would pass)
// ---------------------------------------------------------------------------

function dumpState(db: Database.Database) {
  return {
    boxes: db.prepare('SELECT * FROM utxo_boxes ORDER BY id').all(),
    likeRecords: db
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all(),
    identityRecords: db
      .prepare('SELECT * FROM identity_records ORDER BY identity_id')
      .all(),
  };
}

async function activateProver() {
  // Ordering lives in the shared helper: committed state into the store, then
  // the tree built from it (helpers.ts → `activateProverOverStore`).
  const handle = await activateProverOverStore();
  expect((await importAvl()).tryGetAvlProver()).not.toBeNull();
  return handle;
}

function digestOf(handle: { prover: { digest(): Uint8Array | null } }): Uint8Array {
  const d = handle.prover.digest();
  expect(d).not.toBeNull();
  return new Uint8Array(d!);
}

interface Snapshot {
  height: number;
  state: ReturnType<typeof dumpState>;
  digest: Uint8Array;
}

function takeSnapshot(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  height: number,
): Snapshot {
  return { height, state: dumpState(db.getDb()), digest: digestOf(handle) };
}

/** Apply → revert → re-apply for a settlement class block: DB identity
 *  (like_records included), digest identity, re-apply identity. */
async function assertRoundTrip(
  db: DbModule,
  handle: { prover: { digest(): Uint8Array | null } },
  pre: Snapshot,
  classBlock: OrderingBlock,
): Promise<void> {
  const postDigest = digestOf(handle);
  expect(Buffer.from(postDigest).equals(Buffer.from(pre.digest))).toBe(false);

  const forkResolution = await importForkResolution();
  forkResolution.reorg(pre.height, []);

  const ordering = await importOrdering();
  expect(ordering.getCurrentHeight()).toBe(pre.height);
  expect(dumpState(db.getDb())).toEqual(pre.state);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(pre.digest))).toBe(true);

  // Re-apply must succeed and land on the same digest — the reorg flip-flop.
  const blockApply = await importBlockApply();
  expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
  expect(Buffer.from(digestOf(handle)).equals(Buffer.from(postDigest))).toBe(true);
}

/**
 * Confirm a post at the next height by carrying its creating TRANSACTION.
 *
 * ⛔ The block no longer carries a claim about a post; it carries the post. So a
 * fixture has to hand over the transaction, not an id and an author.
 */
async function confirmPostBlock(
  postTx: UtxoTransaction,
  height = 1,
): Promise<OrderingBlock> {
  return makeApplicableBlock({ height, utxoTxs: [postTx] });
}

/** n fresh likers, each with a seeded 2n karma box (nonce-distinct). */
async function seedLikers(n: number, nonceBase = 0): Promise<Array<{ id: TestIdentity; box: KarmaBox }>> {
  const utxo = await importUtxo();
  const likers: Array<{ id: TestIdentity; box: KarmaBox }> = [];
  for (let i = 0; i < n; i++) {
    const id = makeTestIdentity();
    const box = makeKarmaBox(2n, id.userId, 0, nonceBase + i);
    utxo.insertBox(box);
    likers.push({ id, box });
  }
  return likers;
}

/**
 * The karma a `seedPostTx` author keeps: the fixture spends a box holding the
 * lock cost plus one, so every author here starts with a 1-karma change box that
 * later payouts merge into rather than mint beside.
 */
const POST_CHANGE = 1n;


/**
 * The author's outstanding accrual, read off the ledger.
 *
 * ⛔ **THE BOX IS THE CARRY.** The karma sits in a `LikeAccrualBox`, so the
 * box *is* the carry — a counter beside it would be two representations of
 * one quantity free to disagree (ARCHITECTURE → Likes).
 *
 * ⚠ **Read AFTER the block applies**, when this block's markers are spent — a
 * marker and a carry box share a type and are told apart only by lifetime, so
 * the exclusion set may be empty only once the markers are gone.
 */
async function carryOf(author: Uint8Array): Promise<bigint> {
  const utxo = await importUtxo();
  return utxo.getLikeCarryBox(author, new Set<string>())?.value ?? 0n;
}

describe('per-block like settlement (P2-D N2b)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------

  it('4 likes pay 0 and carry 4; the 5th in the next block pays 4 and zeroes the carry', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    await importRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'arithmetic target');
    posts.insertPost(postId, commit, content);

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    const likers = await seedLikers(5);
    const fourLikes = likers
      .slice(0, 4)
      .map((l) => makeLikeTx(l.id, l.box, postId, author.userId));
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: fourLikes }),
      ),
    ).toBe(true);

    // paid 0 — nothing minted to the author, so the post transaction's change
    // box stands untouched; carry 4 written unconditionally.
    expect(utxo.getKarmaValue(author.userId)).toBe(POST_CHANGE);
    expect(await carryOf(author.userId)).toBe(4n);

    const fifth = makeLikeTx(likers[4]!.id, likers[4]!.box, postId, author.userId);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 3, utxoTxs: [fifth] }),
      ),
    ).toBe(true);

    // total 5 → paid (5/5)·4 = 4, carry 0.
    //
    // ⚠ **A BALANCE, not a box.** The settlement emits a fresh karma output
    // rather than consolidating the author's holdings, so the payout sits beside
    // the post's change box instead of merging into it — consolidating would
    // make the transaction's INPUT list depend on the recipient's unrelated
    // holdings rather than on the block's content.
    expect(utxo.getKarmaValue(author.userId)).toBe(4n + POST_CHANGE);
    // ⛔ **The carry box is CONSUMED at a clean payout, not left holding 0.**
    // `[]` and `[{value: 0}]` are two encodings of one state.
    expect(await carryOf(author.userId)).toBe(0n);
  });

  it('grouping independence (§1.3.1): the same 13 likes split any way pay the same total', async () => {
    const SPLITS: number[][] = [[13], [4, 9], [5, 5, 3]];
    const outcomes: Array<{ paid: bigint; carry: bigint }> = [];

    for (const split of SPLITS) {
      vi.resetModules();
      const db = await importDb();
      db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
      const utxo = await importUtxo();
      const posts = await importPosts();
      await importRecords();
      const blockApply = await importBlockApply();

      const author = makeTestIdentity();
      const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'grouping target');
      posts.insertPost(postId, commit, content);
      expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

      let nonce = 0;
      let height = 1;
      for (const n of split) {
        const likers = await seedLikers(n, nonce);
        nonce += n;
        height += 1;
        const likeTxs = likers.map((l) => makeLikeTx(l.id, l.box, postId, author.userId));
        expect(
          blockApply.applyOrderingBlock(
            await makeApplicableBlock({ height, utxoTxs: likeTxs }),
          ),
        ).toBe(true);
      }

      outcomes.push({
        paid: utxo.getKarmaValue(author.userId),
        carry: await carryOf(author.userId),
      });
    }

    // 13 = 2·5 + 3 → paid 2·(5−1) = 8, carry 3 — whatever the grouping. The
    // author's karma is that payout merged into the post transaction's change.
    for (const o of outcomes) {
      expect(o.paid).toBe(
        (13n / X) * (X - 1n) + POST_CHANGE,
      );
      expect(o.carry).toBe(13n % X);
    }
  });

  // -------------------------------------------------------------------------
  // Mint identity
  // -------------------------------------------------------------------------

  it('two authors in one block receive two settlement outputs sharing one txId', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const authorA = makeTestIdentity();
    const authorB = makeTestIdentity();
    const a = await seedPostTx(authorA, 'author A target');
    const b = await seedPostTx(authorB, 'author B target');
    const postAId = a.postId;
    const postBId = b.postId;
    posts.insertPost(a.postId, a.commit, a.content);
    posts.insertPost(b.postId, b.commit, b.content);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ utxoTxs: [a.tx, b.tx] }),
      ),
    ).toBe(true);

    const likersA = await seedLikers(LIKES_PER_KARMA_PAYOUT, 0);
    const likersB = await seedLikers(LIKES_PER_KARMA_PAYOUT, 100);
    const likeTxs = [
      ...likersA.map((l) => makeLikeTx(l.id, l.box, postAId, authorA.userId)),
      ...likersB.map((l) => makeLikeTx(l.id, l.box, postBId, authorB.userId)),
    ];
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: likeTxs }),
      ),
    ).toBe(true);

    // Each author is paid `x − 1`, once, in the one settlement.
    expect(utxo.getKarmaValue(authorA.userId)).toBe(X - 1n + POST_CHANGE);
    expect(utxo.getKarmaValue(authorB.userId)).toBe(X - 1n + POST_CHANGE);

    const payouts = utxo
      .getUnspentBoxes()
      .filter((b) => b.boxType === 'karma' && b.value === X - 1n);
    expect(payouts).toHaveLength(2);
    // Both are outputs of the SAME transaction — the block's one settlement.
    expect(new Set(payouts.map((b) => b.txId)).size).toBe(1);
  });

  it('likes on two posts of one author in one block produce one settlement output', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const p1 = await seedPostTx(author, 'consolidation target 1');
    const p2 = await seedPostTx(author, 'consolidation target 2');
    const post1Id = p1.postId;
    const post2Id = p2.postId;
    posts.insertPost(p1.postId, p1.commit, p1.content);
    posts.insertPost(p2.postId, p2.commit, p2.content);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ utxoTxs: [p1.tx, p2.tx] }),
      ),
    ).toBe(true);

    const likers = await seedLikers(LIKES_PER_KARMA_PAYOUT);
    const likeTxs = [
      ...likers.slice(0, 3).map((l) => makeLikeTx(l.id, l.box, post1Id, author.userId)),
      ...likers.slice(3).map((l) => makeLikeTx(l.id, l.box, post2Id, author.userId)),
    ];
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: likeTxs }),
      ),
    ).toBe(true);

    // 3 + 2 likes accrue per AUTHOR (NODE_INTERFACE → "Per-block like
    // settlement") → one payout of `x − 1`, not two.
    //
    // ⚠ **The old case rested on a collision that is gone.** A per-post
    // settlement would have derived the same `(height, reason, subject)` twice
    // and tripped `UNIQUE(tx_id, output_index)`, so applying at all was part of
    // the property. Two outputs of one transaction cannot collide, so the
    // per-author grouping has to be asserted directly: exactly one payout box.
    const payouts = utxo
      .getUnspentBoxes()
      .filter(
        (b) =>
          b.boxType === 'karma' &&
          Buffer.from((b as KarmaBox).owner).equals(Buffer.from(author.userId)) &&
          b.value === X - 1n,
      );
    expect(payouts).toHaveLength(1);
    // Two posts, so two lots of change alongside the one payout.
    expect(utxo.getKarmaValue(author.userId)).toBe(X - 1n + 2n * POST_CHANGE);
  });

  // -------------------------------------------------------------------------
  // Dedup at apply
  // -------------------------------------------------------------------------

  it('two like txs for one (liker, target) in one block reject the whole block', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'same-block dedup target');
    posts.insertPost(postId, commit, content);
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    const liker = makeTestIdentity();
    const box1 = makeKarmaBox(2n, liker.userId, 0, 0);
    const box2 = makeKarmaBox(2n, liker.userId, 0, 1);
    utxo.insertBox(box1);
    utxo.insertBox(box2);

    const tx1 = makeLikeTx(liker, box1, postId, author.userId);
    const tx2 = makeLikeTx(liker, box2, postId, author.userId);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [tx1, tx2] }),
      ),
    ).toBe(false);

    // All-or-nothing: the first like's effects rolled back with the block.
    expect(ordering.getCurrentHeight()).toBe(1);
    expect(utxo.getBox(box1.id!)).not.toBeNull();
    expect(utxo.getBox(box2.id!)).not.toBeNull();
    expect(likeRecords.hasLikeRecord(postId, liker.userId)).toBe(false);
  });

  it('a like confirmed in block N rejects the same (liker, target) in block N+1 — the N1→N2 window is closed', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    await importRecords();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'cross-block dedup target');
    posts.insertPost(postId, commit, content);
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    const liker = makeTestIdentity();
    const box1 = makeKarmaBox(2n, liker.userId, 0, 0);
    const box2 = makeKarmaBox(2n, liker.userId, 0, 1);
    utxo.insertBox(box1);
    utxo.insertBox(box2);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [makeLikeTx(liker, box1, postId, author.userId)] }),
      ),
    ).toBe(true);
    expect(likeRecords.hasLikeRecord(postId, liker.userId)).toBe(true);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 3, utxoTxs: [makeLikeTx(liker, box2, postId, author.userId)] }),
      ),
    ).toBe(false);

    expect(ordering.getCurrentHeight()).toBe(2);
    expect(utxo.getBox(box2.id!)).not.toBeNull();
    expect(await carryOf(author.userId)).toBe(1n);
  });

  // -------------------------------------------------------------------------
  // Target liveness and author resolution
  // -------------------------------------------------------------------------


  it('a spare-signature like tx embedded directly in a block applies, with the liker = the karma input owner', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'spare signature target');
    posts.insertPost(postId, commit, content);
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    const liker = makeTestIdentity();
    const spare = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);

    // The gateway's one-signature rule is gateway policy: a validator can
    // embed a like tx carrying a spare signature directly. The spare entry is
    // FIRST in the map, so a settlement that read the signature map instead
    // of the input boxes would resolve the wrong liker.
    const tx: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 1n,
          createdAtBlock: 0,
          owner: liker.userId,
        },
        // The marker, so the transaction conserves — the shape is the engine's
        // and this case's subject is the SIGNATURE map, not the shape.
        {
          boxType: 'like_accrual',
          value: 1n,
          createdAtBlock: 0,
          author: author.userId,
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(tx, spare.privateKey, hex(spare.userId)); // spare, first
    signTransaction(tx, liker.privateKey, hex(liker.userId)); // owner
    expect(Object.keys(tx.signatures)[0]).toBe(hex(spare.userId));

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [tx] }),
      ),
    ).toBe(true);

    expect(likeRecords.hasLikeRecord(postId, liker.userId)).toBe(true);
    expect(likeRecords.hasLikeRecord(postId, spare.userId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Same-block exclusion
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------
  // Apply-then-revert, per new mutation class (active prover: DB identity,
  // digest identity, re-apply identity)
  // -------------------------------------------------------------------------

  it('round-trip: record inserts and the carry write (paid 0) revert exactly', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    await importRecords();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'round-trip carry target');
    posts.insertPost(postId, commit, content);
    // Everything seeded before bootstrap so tree and DB agree from height 0.
    const likers = await seedLikers(4);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);
    const pre = takeSnapshot(db, handle, 1);
    // Non-vacuity: the record exists (the post transaction bumped the author's
    // activity) and its carry is still zero, so the 4n below is this block's
    // write and not a value the fixture arrived with.
    expect(await carryOf(author.userId)).toBe(0n);

    const classBlock = await makeApplicableBlock({
      height: 2,
      utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId, author.userId)),
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
    expect(await carryOf(author.userId)).toBe(4n);
    expect(
      (dumpState(db.getDb()).likeRecords as Array<unknown>).length,
    ).toBe(4);

    await assertRoundTrip(db, handle, pre, classBlock);
    // Re-applied state holds the records and carry again, with the likers'
    // seed boxes spent by the burns once more.
    expect(await carryOf(author.userId)).toBe(4n);
    for (const l of likers) {
      expect(utxo.getBox(l.box.id!)).toBeNull();
    }
  });

  it('round-trip: the payout mint restores merge-consumed pre-existing karma and the prior carry', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    await importRecords();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'round-trip payout target');
    posts.insertPost(postId, commit, content);
    const authorKarma = makeKarmaBox(100n, author.userId, 0, 999);
    utxo.insertBox(authorKarma);
    const likers = await seedLikers(5);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);
    // Block 2: 4 likes → carry 4, no mint.
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: likers.slice(0, 4).map((l) => makeLikeTx(l.id, l.box, postId, author.userId)),
        }),
      ),
    ).toBe(true);
    const pre = takeSnapshot(db, handle, 2);
    expect(await carryOf(author.userId)).toBe(4n);

    // Block 3: the 5th like → paid 4, merging the author's 100n box.
    const classBlock = await makeApplicableBlock({
      height: 3,
      utxoTxs: [makeLikeTx(likers[4]!.id, likers[4]!.box, postId, author.userId)],
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);
    // ⚠ **No merge, so nothing pre-existing is consumed.** The settlement emits
    // a fresh karma output rather than consolidating the author's holdings, so
    // the seeded box stands and the BALANCE carries the claim. The round trip
    // below is therefore over a plain insert rather than over a
    // consume-and-replace pair — a strictly simpler inverse, and the one the
    // journal's box primitives already own.
    expect(utxo.getBox(authorKarma.id!)).not.toBeNull();
    expect(utxo.getKarmaValue(author.userId)).toBe(100n + POST_CHANGE + 4n);
    expect(await carryOf(author.userId)).toBe(0n);

    await assertRoundTrip(db, handle, pre, classBlock);
    expect(utxo.getKarmaValue(author.userId)).toBe(100n + POST_CHANGE + 4n); // re-applied
  });

  it('revertBlock restores prune-deleted like-records (all three columns) and removes inserted ones', async () => {
    // The likeRecordDeletions inverse, seeded via direct store calls: the
    // prune-time producer (settle-post-lock-utxo) is N3 — this pins the revert
    // machinery it will rely on. One journal carries BOTH inverse classes for
    // DIFFERENT records (the same-block exclusion only forbids them for the
    // same record).
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const likes = await import('../../src/store/likes.js');
    const journalStore = await importJournalStore();
    const forkResolution = await importForkResolution();

    const likerA = makeTestIdentity();
    const likerB = makeTestIdentity();
    const prunedPost = 'aa'.repeat(32);
    const likedPost = 'bb'.repeat(32);

    // Post-block state: the block at height 7 pruned P (deleting A's and B's
    // records on P, captured in the journal) and inserted B's record on Q.
    likes.insertLikeRecord(likedPost, likerB.userId, 7); // no journal open — not recorded
    journalStore.insertBlockJournal({
      blockHeight: 7,
      mutations: [],
      confirmedPostIds: [],
      appliedUtxoTxs: [],
      likeRecordInsertions: [{ targetPostId: likedPost, likerId: likerB.userId }],
      likeRecordDeletions: [
        { targetPostId: prunedPost, likerId: likerA.userId, appliedAtBlock: 3 },
        { targetPostId: prunedPost, likerId: likerB.userId, appliedAtBlock: 5 },
      ],
      deletedPosts: [],
      insertedStumps: [],
      withdrawnPosts: [],
      prunedTopologyRows: [],
    });

    forkResolution.revertBlock(7);

    // Deleted records restored exactly — original applied heights included.
    const rows = db
      .getDb()
      .prepare(
        'SELECT target_post_id, liker_id, applied_at_block FROM like_records ORDER BY target_post_id, liker_id',
      )
      .all() as Array<{ target_post_id: string; liker_id: Buffer; applied_at_block: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.target_post_id === prunedPost)).toBe(true);
    const byLiker = new Map(rows.map((r) => [r.liker_id.toString('hex'), r.applied_at_block]));
    expect(byLiker.get(hex(likerA.userId))).toBe(3);
    expect(byLiker.get(hex(likerB.userId))).toBe(5);
    // The inserted record is gone.
    expect(likes.hasLikeRecord(likedPost, likerB.userId)).toBe(false);
  });

  it('a like on a pruned target rejects the block — the stump is created by the real prune path', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const posts = await importPosts();
    await importRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'pruned-like-target');
    posts.insertPost(postId, commit, content);

    // Block 1: confirms the post.
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    // Block 2: prune the post through the real path.
    const pruneKarma = makeKarmaBox(1n, author.userId, 0, 8001);
    utxo.insertBox(pruneKarma);
    const pruneTx: UtxoTransaction = {
      inputs: [pruneKarma.id!],
      outputs: [
        { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: author.userId } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      prune: { rootPostHash: postId },
    };
    signTransaction(pruneTx, author.privateKey, hex(author.userId));
    expect(blockApply.applyOrderingBlock(
      await makeApplicableBlock({ height: 2, utxoTxs: [pruneTx] }),
    )).toBe(true);

    // The stump exists.
    const stumps = db.getDb()
      .prepare('SELECT * FROM dag_stumps WHERE root_post_hash = ?')
      .all(postId);
    expect(stumps).toHaveLength(1);

    // Block 3: a like on the pruned post rejects the block.
    const [liker] = await seedLikers(1, 9001);
    const likeTx = makeLikeTx(
      liker!.id, liker!.box, postId,
      author.userId,
    );
    const block3 = await makeApplicableBlock({ height: 3, utxoTxs: [likeTx] });
    expect(blockApply.applyOrderingBlock(block3)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A reply moves REPLY_AUTHOR_SHARE into the parent author's accrual and
  // neither lifetimeLikesReceived nor the like counter (§8.4 of the spec)
  // -------------------------------------------------------------------------

  it('a reply moves 1 karma into the parent author accrual and no counter; a like moves the counter', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'parent post');
    posts.insertPost(postId, commit, content);

    const replier = makeTestIdentity();
    const { tx: replyTx } = await seedPostTx(replier, 'reply post', { parentRefs: [postId] }, author.userId);

    const liker = (await seedLikers(1, 5000))[0]!;
    const likeTx = makeLikeTx(liker.id, liker.box, postId, author.userId);

    await activateProver();
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    const beforeRecord = records.getIdentityRecord(author.userId);
    const likesBefore = beforeRecord?.lifetimeLikesReceived ?? 0n;

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 2, utxoTxs: [replyTx, likeTx] }),
      ),
    ).toBe(true);

    const afterRecord = records.getIdentityRecord(author.userId);
    expect(afterRecord).not.toBeNull();
    expect(afterRecord!.lifetimeLikesReceived).toBe(likesBefore + 1n);

    const carry = await carryOf(author.userId);
    expect(carry >= REPLY_AUTHOR_SHARE).toBe(true);
  });

});
