import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computePostId,
  computeTxId,
  computeMintTxId,
  computeBoxId,
  canonicalBoxBytes,
  encodePost,
  PROTOCOL_VERSION,
  LIKES_PER_KARMA_PAYOUT,
  POST_LOCK_REPLY_COST,
  POST_LOCK_THREAD_COST,
  POST_LOCK_UNLOCK_PER_LIKES,
} from '@dagsocial/types';
import type {
  KarmaBox,
  PostLockBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import {
  changeBoxOf,
  fixturePostId,
  fixtureProvenance,
  hex,
  lockBoxOf,
  makeApplicableBlock,
  makeKarmaBox,
  makeLikeTx,
  makePost,
  makePruneEntry,
  makeTestIdentity,
  seedPostTx,
  seedProvenance,
  signTransaction,
  type TestIdentity,
  activateProverOverStore,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// P2-D N2b: per-block like settlement (NODE_INTERFACE "Per-block like
// settlement"; ARCHITECTURE §Likes). The settlement is entirely derived —
// nothing rides in the block — so what these tests pin is the one shared
// implementation both producer and verifier run:
//
//   - apply-time like rules (confirmed + live target, author from topology,
//     structural dedup, liker = karma input owner) — any failure rejects the
//     whole block;
//   - author settlement arithmetic (carry, integer payout, the
//     grouping-independence property) and mint identity;
//   - post-lock vesting per block;
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
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getBox: (boxId: string) => { id?: string; value: bigint } | null;
    getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
    getKarmaValue: (owner: Uint8Array) => bigint;
    getPostLockBox: (targetPostId: string) => PostLockBox | null;
    getLikeCarryBox: (
      author: Uint8Array,
      exclude: Set<string>,
    ) => { value: bigint; author: Uint8Array; id?: string } | null;
    getUnspentBoxes: () => import('@dagsocial/types').AnyBox[];
  };
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as {
    insertPost: (postId: string, post: import('@dagsocial/types').Post, rawCbor: Uint8Array) => void;
    getPost: (id: string) => unknown;
  };
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
    ) => { lastActivityBlock: number; lastDecayBlock: number } | null;
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

// ⛔ Reserved, never to be reused: `seedPostLock`. A `PostLockBox` is minted by
// the transaction that carries the post (NODE_INTERFACE → Post transactions) and
// is indexed under the id that transaction gives the post, so a seeded lock
// beside a real post tx is a second lock for one post — a state no chain can
// reach, and one `getPostLockBox` resolves arbitrarily. `lockBoxOf(postTx)` is
// the lock a test means; its value is the cost for the post's shape
// (`POST_LOCK_THREAD_COST` for a thread, `POST_LOCK_REPLY_COST` for a reply),
// which is what a fixture picks between when it needs a particular one.


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
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'arithmetic target');
    posts.insertPost(postId, post, encodePost(post));

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
      const utxo = await importUtxo();
      const posts = await importPosts();
      const records = await importRecords();
      const blockApply = await importBlockApply();

      const author = makeTestIdentity();
      const { post, tx: postTx, postId } = await seedPostTx(author, 'grouping target');
      posts.insertPost(postId, post, encodePost(post));
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
    // author's karma is that payout merged into the post transaction's change,
    // plus the karma 13 likes vest out of the post's own lock (13/10 = 1):
    // vesting is per-post and grouping-independent for the same reason the
    // payout is, so it belongs in the total this compares across splits.
    for (const o of outcomes) {
      expect(o.paid).toBe(
        (13n / X) * (X - 1n) + POST_CHANGE + 13n / BigInt(POST_LOCK_UNLOCK_PER_LIKES),
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
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const authorA = makeTestIdentity();
    const authorB = makeTestIdentity();
    const a = await seedPostTx(authorA, 'author A target');
    const b = await seedPostTx(authorB, 'author B target');
    const postAId = a.postId;
    const postBId = b.postId;
    posts.insertPost(a.postId, a.post, encodePost(a.post));
    posts.insertPost(b.postId, b.post, encodePost(b.post));

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
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const p1 = await seedPostTx(author, 'consolidation target 1');
    const p2 = await seedPostTx(author, 'consolidation target 2');
    const post1Id = p1.postId;
    const post2Id = p2.postId;
    posts.insertPost(p1.postId, p1.post, encodePost(p1.post));
    posts.insertPost(p2.postId, p2.post, encodePost(p2.post));

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
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'same-block dedup target');
    posts.insertPost(postId, post, encodePost(post));
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
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const records = await importRecords();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'cross-block dedup target');
    posts.insertPost(postId, post, encodePost(post));
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

  it('a like on a pruned target rejects the block — the stump discriminator against a real stump row', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'pruned target');
    posts.insertPost(postId, post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          pruneEntries: [makePruneEntry(postId, [postId], author)],
        }),
      ),
    ).toBe(true);

    // A real stump row: getPost resolves the pruned root to a Stump —
    // detected as the absence of `content` / the presence of `rootPostHash`.
    // ('subtreeMerkleRoot' does NOT exist on Stump — the N1 report's dead
    // discriminator; this assertion is against the live field set.)
    const resolved = posts.getPost(postId) as Record<string, unknown>;
    expect(resolved).not.toBeNull();
    expect('content' in resolved).toBe(false);
    expect('rootPostHash' in resolved).toBe(true);

    const liker = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({ height: 3, utxoTxs: [makeLikeTx(liker, box, postId, author.userId)] }),
      ),
    ).toBe(false);
    expect(ordering.getCurrentHeight()).toBe(2);
    expect(utxo.getBox(box.id!)).not.toBeNull();
  });

  // ⛔ Reserved, never to be reused: the content-less-post like case.
  //
  // It credited the topology author rather than a placeholder row's ZEROED
  // author — a distinction that existed because a block could confirm a post
  // whose content had not arrived. **A block carries its posts**, so apply
  // always has the content, `insertPostPlaceholder` has no producer, and there
  // is no zeroed author for a settlement to prefer the topology one over.
  // `block_topology` is still the authority for prune, and it is now derived
  // from `tx.post` rather than recorded from a claim.

  it('a spare-signature like tx embedded directly in a block applies, with the liker = the karma input owner', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'spare signature target');
    posts.insertPost(postId, post, encodePost(post));
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

  it('a block carrying prune(P) + like(P) is rejected deterministically', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const ordering = await importOrdering();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'same-block exclusion target');
    posts.insertPost(postId, post, encodePost(post));
    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    const liker = makeTestIdentity();
    const box = makeKarmaBox(2n, liker.userId, 0);
    utxo.insertBox(box);

    // Prune settlement (§8c) runs before embedded txs (§11), so the like
    // finds a stump: invalid tx, whole block rejected.
    const block = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(postId, [postId], author)],
      utxoTxs: [makeLikeTx(liker, box, postId, author.userId)],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(false);
    // Deterministic: the same block rejects again, not just once.
    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // All-or-nothing: the prune's own effects rolled back too.
    expect(ordering.getCurrentHeight()).toBe(1);
    const live = posts.getPost(postId) as Record<string, unknown>;
    expect('content' in live).toBe(true);
    expect(utxo.getBox(box.id!)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Post-lock vesting
  // -------------------------------------------------------------------------

  it('vesting crosses POST_LOCK_UNLOCK_PER_LIKES in the block it crosses, not before', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const likeRecords = await importLikeRecords();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'vesting crossing target');
    posts.insertPost(postId, post, encodePost(post));

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);
    // The lock the post transaction minted — a thread, so POST_LOCK_THREAD_COST.
    const lockBox = lockBoxOf(postTx);
    expect(utxo.getPostLockBox(postId)!.id).toBe(lockBox.id);

    // 9 likes: 9 / 10 = 0 → no vest, lock untouched.
    const nine = await seedLikers(POST_LOCK_UNLOCK_PER_LIKES - 1);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: nine.map((l) => makeLikeTx(l.id, l.box, postId, author.userId)),
        }),
      ),
    ).toBe(true);
    expect(utxo.getBox(lockBox.id!)).not.toBeNull();

    // The 10th like crosses the threshold → unlock 1 in THIS block.
    const [tenth] = await seedLikers(1, 50);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 3,
          utxoTxs: [makeLikeTx(tenth!.id, tenth!.box, postId, author.userId)],
        }),
      ),
    ).toBe(true);

    expect(likeRecords.getLikeRecordCount(postId)).toBe(POST_LOCK_UNLOCK_PER_LIKES);
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    const remainder = utxo.getPostLockBox(postId);
    expect(remainder).not.toBeNull();
    expect(remainder!.value).toBe(POST_LOCK_THREAD_COST - 1n);
    expect(remainder!.originalValue).toBe(POST_LOCK_THREAD_COST);
    expect(remainder!.txId).toBe(computeMintTxId(3, 'postlock-remainder', Buffer.from(postId)));

    // Author karma: the post's 1 karma of change; block 2 paid 4 (9 likes →
    // carry 4); block 3 total 4+1=5 → payout 4 (merging what is there) then
    // unlock 1 → 10n, provenance = the LAST merge, the postlock-unlock mint
    // (settlement order: payout before vesting).
    const authorBox = utxo.getKarmaBox(author.userId);
    expect(authorBox!.value).toBe(POST_CHANGE + 4n + 4n + 1n);
    expect(authorBox!.txId).toBe(computeMintTxId(3, 'postlock-unlock', Buffer.from(postId)));
  });

  it('a fully-unlocked lock is consumed without a remainder box', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    // A REPLY, because the lock's value is the cost for the post's shape and
    // this case needs one the likes can unlock ENTIRELY:
    // POST_LOCK_REPLY_COST unlocks in POST_LOCK_REPLY_COST × 10 likes.
    const { post, tx: postTx, postId } = await seedPostTx(
      author, 'full unlock target', { parentRefs: ['ab'.repeat(32)] },
    );
    posts.insertPost(postId, post, encodePost(post));

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);
    const lockBox = lockBoxOf(postTx);
    expect((utxo.getBox(lockBox.id!) as PostLockBox).value).toBe(POST_LOCK_REPLY_COST);

    const LIKES = POST_LOCK_UNLOCK_PER_LIKES * Number(POST_LOCK_REPLY_COST);
    const likers = await seedLikers(LIKES);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId, author.userId)),
        }),
      ),
    ).toBe(true);

    // toUnlock = min(3, 30/10 − 0) = 3 = value → consumed, nothing re-minted.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getPostLockBox(postId)).toBeNull();
    // 30 likes → payout (30/5)·4 = 24, then the unlock 3 merges in.
    const payout = (BigInt(LIKES) / X) * (X - 1n);
    expect(utxo.getKarmaValue(author.userId)).toBe(
      POST_CHANGE + payout + POST_LOCK_REPLY_COST,
    );
  });

  it('T2a: the vesting remainder is content-true, and no guard string is in the id', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const blockApply = await importBlockApply();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'remainder pin target');
    posts.insertPost(postId, post, encodePost(post));

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);

    // 10 likes → unlock 1 of POST_LOCK_THREAD_COST → application re-mints the
    // remainder.
    const likers = await seedLikers(POST_LOCK_UNLOCK_PER_LIKES);
    expect(
      blockApply.applyOrderingBlock(
        await makeApplicableBlock({
          height: 2,
          utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId, author.userId)),
        }),
      ),
    ).toBe(true);

    const remainder = utxo.getPostLockBox(postId);
    expect(remainder).not.toBeNull();

    // The stored id was hashed over the producer's bytes, and it must equal the
    // hash of the content the store reconstructs.
    expect(computeBoxId(remainder!)).toBe(remainder!.id);

    // Both halves are pinned here (TYPES_INTERFACE → Layout — Boxes), because
    // "no such field is hashed" is only half a claim: a stray key on the object
    // does not move the id —
    // `canonicalBoxBytes` writes the fields its layout declares and no other…
    const withStrayKey = { ...remainder!, guard: 'epoch_tally' } as unknown as PostLockBox;
    expect(computeBoxId(withStrayKey)).toBe(computeBoxId(remainder!));
    // …and no guard string is in the bytes rather than merely inert.
    expect(Buffer.from(canonicalBoxBytes(remainder!)).toString('hex'))
      .not.toContain(Buffer.from('block_apply').toString('hex'));
  });

  // -------------------------------------------------------------------------
  // Apply-then-revert, per new mutation class (active prover: DB identity,
  // digest identity, re-apply identity)
  // -------------------------------------------------------------------------

  it('round-trip: record inserts and the carry write (paid 0) revert exactly', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'round-trip carry target');
    posts.insertPost(postId, post, encodePost(post));
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
    const utxo = await importUtxo();
    const posts = await importPosts();
    const records = await importRecords();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'round-trip payout target');
    posts.insertPost(postId, post, encodePost(post));
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

  it('round-trip: the vesting swap (consume + unlock mint + remainder re-mint) reverts exactly', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const posts = await importPosts();

    const author = makeTestIdentity();
    const { post, tx: postTx, postId } = await seedPostTx(author, 'round-trip vesting target');
    posts.insertPost(postId, post, encodePost(post));
    const likers = await seedLikers(POST_LOCK_UNLOCK_PER_LIKES);

    const handle = await activateProver();
    const blockApply = await importBlockApply();

    expect(blockApply.applyOrderingBlock(await confirmPostBlock(postTx))).toBe(true);
    // The lock the post transaction minted, live before the swap under test.
    const lockBox = lockBoxOf(postTx);
    expect(utxo.getBox(lockBox.id!)).not.toBeNull();
    const pre = takeSnapshot(db, handle, 1);

    const classBlock = await makeApplicableBlock({
      height: 2,
      utxoTxs: likers.map((l) => makeLikeTx(l.id, l.box, postId, author.userId)),
    });
    expect(blockApply.applyOrderingBlock(classBlock)).toBe(true);

    // The swap happened: lock consumed, a remainder one karma short of the
    // cost, author at change + payout 8 + unlock 1.
    expect(utxo.getBox(lockBox.id!)).toBeNull();
    expect(utxo.getPostLockBox(postId)!.value).toBe(POST_LOCK_THREAD_COST - 1n);
    expect(utxo.getKarmaValue(author.userId)).toBe(POST_CHANGE + 8n + 1n);

    await assertRoundTrip(db, handle, pre, classBlock);
    // Reverted-then-reapplied state again shows the swap.
    expect(utxo.getPostLockBox(postId)!.value).toBe(POST_LOCK_THREAD_COST - 1n);
  });

  it('revertBlock restores prune-deleted like-records (all three columns) and removes inserted ones', async () => {
    // The likeRecordDeletions inverse, seeded via direct store calls: the
    // prune-time producer (settle-prune-utxo) is N3 — this pins the revert
    // machinery it will rely on. One journal carries BOTH inverse classes for
    // DIFFERENT records (the same-block exclusion only forbids them for the
    // same record).
    const db = await importDb();
    db.initDb(':memory:');
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
      confirmedSubBlockIds: [],
      appliedUtxoTxs: [],
      likeRecordInsertions: [{ targetPostId: likedPost, likerId: likerB.userId }],
      likeRecordDeletions: [
        { targetPostId: prunedPost, likerId: likerA.userId, appliedAtBlock: 3 },
        { targetPostId: prunedPost, likerId: likerB.userId, appliedAtBlock: 5 },
      ],
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
});
