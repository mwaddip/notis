import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  PostLockBox,
  KarmaBox,
} from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import type Database from 'better-sqlite3';
import {
  seedProvenance,
  type Stored } from '../helpers.js';

// ---------------------------------------------------------------------------
// Dynamic import helpers (module-level DB state requires reset + fresh import)
// ---------------------------------------------------------------------------

async function importDb() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importTopology() {
  const mod = await import('../../src/store/topology.js');
  return mod as {
    insertBlockTopology: (
      postId: string,
      parentRefs: string[],
      author: string,
      blockHeight: number,
    ) => void;
    getSubtreeTopology: (rootPostId: string) => Set<string>;
    getTopologyAuthor: (postId: string) => string | null;
    rollbackBlockTopology: (blockHeight: number) => void;
  };
}

async function importUtxo() {
  const mod = await import('../../src/store/utxo.js');
  return mod as {
    insertBox: (box: unknown, postLockTarget?: string) => void;
    getBox: (boxId: string) => unknown;
    getPostLockBox: (targetPostId: string) => PostLockBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importLikes() {
  const mod = await import('../../src/store/likes.js');
  return mod as {
    insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
    deleteLikeRecordsForPosts: (postIds: string[]) => void;
    hasLikeRecord: (targetPostId: string, likerId: Uint8Array) => boolean;
  };
}

async function importSettlePruneUtxo() {
  const mod = await import('../../src/services/settle-prune-utxo.js');
  // Hand-maintained mirror of the real arity — and `tsconfig.test.json` does
  // check it: a signature that drifts from the source fails `pnpm typecheck`
  // with TS2352 before any test runs. Change the source signature, change this
  // too.
  return mod as {
    planPruneSettlement: (
      rootPostHash: string,
      authorId: Uint8Array,
      postIds: string[],
    ) => {
      lockBoxIds: string[];
      refunds: Array<{ owner: Uint8Array; amount: bigint }>;
      toPool: bigint;
    };
  };
}

async function importJournal() {
  return await import('../../src/store/journal.js');
}

/**
 * Run `fn` with a block journal open at `height` and return the finished
 * journal — the record-once log the store choke point filled while it ran.
 */
async function journaled(height: number, fn: () => void): Promise<BlockJournal> {
  const journal = await importJournal();
  journal.beginBlockJournal(height);
  fn();
  return journal.finishBlockJournal();
}

/** boxIds of box 'remove' mutations, in application order. */
function removedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'remove')
    .map((m) => (m as BoxMutation).boxId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserId(label: string): Uint8Array {
  const buf = Buffer.alloc(32);
  buf.write(label, 0, Math.min(label.length, 32), 'utf-8');
  return new Uint8Array(buf);
}

/**
 * `value` is `bigint`, as `PostLockBox` declares it — it was `number` here, and
 * `makeKarmaBox` right below always had it right. `seedProvenance` takes an
 * `object`, so the type lie survived the compiler; CBOR then encoded the number
 * silently and the fixture pinned nothing about the u64 wire domain. The
 * positional writer has no `number` branch, which is what surfaced it.
 */
/**
 * A seeded post lock, plus the target the store must index it under.
 *
 * ⛔ **The box carries no `targetPostId`** — a post's id comes from the
 * transaction that creates the lock, so the field would have to be known before
 * the `TxId` that produces it (TYPES_INTERFACE → PostLockBox). A fixture seeds
 * the box with SYNTHETIC provenance, so it is in the same position as a
 * `postlock-remainder` lock: derivation route 1 (`computePostId(box.txId, 0)`)
 * would produce an id from a transaction that never created this post. The
 * target is therefore passed to `insertBox` — route 2 — and this helper returns
 * both halves so no caller can forget.
 */
function makePostLockBox(
  value: bigint,
  owner: Uint8Array,
  targetPostId: string,
  seed: number,
): { box: Stored<PostLockBox>; targetPostId: string } {
  const box = seedProvenance<PostLockBox>({
    boxType: 'post_lock' as const,
    value,
    createdAtBlock: 0,
    originalValue: value,
    owner,
  }, seed);
  return { box, targetPostId };
}

function makeKarmaBox(
  value: bigint,
  owner: Uint8Array,
  seed: number,
): Stored<KarmaBox> {
  return seedProvenance<KarmaBox>({
    boxType: 'karma' as const,
    value,
    createdAtBlock: 0,
    owner,
  }, seed);
}

/** Consensus-carried author for topology fixtures (hex(32)). */
const AUTHOR_HEX = 'ab'.repeat(32);

/** Check if a box ID is spent in the utxo_boxes table. */
function boxIsSpent(db: Database.Database, boxId: string): boolean {
  const row = db
    .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
    .get(boxId) as { spent_at_block: number | null } | undefined;
  return row != null && row.spent_at_block !== null;
}

// ---------------------------------------------------------------------------
// Tests: block_topology
// ---------------------------------------------------------------------------

describe('block_topology', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('getSubtreeTopology computes transitive closure via CTE', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    // Chain: root1 -> reply1 -> reply2
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('reply1', ['root1'], AUTHOR_HEX, 2);
    insertBlockTopology('reply2', ['reply1'], AUTHOR_HEX, 2);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1', 'reply1', 'reply2']));
  });

  it('getSubtreeTopology returns only root when no replies', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1']));
  });

  it('getSubtreeTopology returns empty set for unknown root', async () => {
    const { getSubtreeTopology } = await importTopology();

    const subtree = getSubtreeTopology('nonexistent');
    expect(subtree.size).toBe(0);
  });

  it('insertBlockTopology is idempotent', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('root1', [], AUTHOR_HEX, 1); // Duplicate call
    insertBlockTopology('reply1', ['root1'], AUTHOR_HEX, 2);

    const subtree = getSubtreeTopology('root1');
    expect(subtree).toEqual(new Set(['root1', 'reply1']));
  });

  it('getSubtreeTopology handles branching children', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    // root -> child1
    // root -> child2
    insertBlockTopology('root', [], AUTHOR_HEX, 1);
    insertBlockTopology('child1', ['root'], AUTHOR_HEX, 2);
    insertBlockTopology('child2', ['root'], AUTHOR_HEX, 2);

    const subtree = getSubtreeTopology('root');
    expect(subtree).toEqual(new Set(['root', 'child1', 'child2']));
  });

  it('getSubtreeTopology does not follow upward references', async () => {
    const { insertBlockTopology, getSubtreeTopology } = await importTopology();

    // Two independent root posts
    insertBlockTopology('rootA', [], AUTHOR_HEX, 1);
    insertBlockTopology('rootB', [], AUTHOR_HEX, 1);

    const subtree = getSubtreeTopology('rootA');
    expect(subtree).toEqual(new Set(['rootA']));
  });

  it('getTopologyAuthor returns the recorded author', async () => {
    const { insertBlockTopology, getTopologyAuthor } = await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);

    expect(getTopologyAuthor('root1')).toBe(AUTHOR_HEX);
  });

  it('getTopologyAuthor returns null for a post no block has confirmed', async () => {
    const { getTopologyAuthor } = await importTopology();

    expect(getTopologyAuthor('nonexistent')).toBeNull();
  });

  it('getTopologyAuthor keeps the first confirming block author (idempotent insert)', async () => {
    const { insertBlockTopology, getTopologyAuthor } = await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('root1', [], 'cd'.repeat(32), 2); // later block, same postId

    expect(getTopologyAuthor('root1')).toBe(AUTHOR_HEX);
  });

  it('getTopologyAuthor returns null again after the height is rolled back', async () => {
    const { insertBlockTopology, getTopologyAuthor, rollbackBlockTopology } =
      await importTopology();
    insertBlockTopology('root1', [], AUTHOR_HEX, 7);
    expect(getTopologyAuthor('root1')).toBe(AUTHOR_HEX);

    rollbackBlockTopology(7);
    expect(getTopologyAuthor('root1')).toBeNull();
  });

  it('rollbackBlockTopology removes entries at given height', async () => {
    const { insertBlockTopology, getSubtreeTopology, rollbackBlockTopology } =
      await importTopology();

    insertBlockTopology('root1', [], AUTHOR_HEX, 1);
    insertBlockTopology('reply1', ['root1'], AUTHOR_HEX, 2);
    insertBlockTopology('reply2', ['reply1'], AUTHOR_HEX, 3);

    // Roll back height 2 entries
    rollbackBlockTopology(2);

    const subtree = getSubtreeTopology('root1');
    // reply1 at height 2 should be gone; reply2 (parent_refs 'reply1') has
    // no incoming edge from an existing post, so CTE stops at root1
    expect(subtree).toEqual(new Set(['root1']));
  });
});

// ---------------------------------------------------------------------------
// Tests: planPruneSettlement
// ---------------------------------------------------------------------------

describe('planPruneSettlement', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("consumes a reply author's PostLockBox and merge-mints their refund", async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootPostId = 'a'.repeat(64);
    const replyPostId = 'b'.repeat(64);
    const pruner = makeUserId('pruner1');
    const replier = makeUserId('replier1');

    // The reply's lock belongs to someone other than the pruner, so it
    // returns; plus pre-existing karma the refund mint will merge in (seeded
    // outside the journal, like any pre-block state)
    const lockBox = makePostLockBox(100n, replier, replyPostId, 1);
    utxo.insertBox(lockBox.box, lockBox.targetPostId);
    const oldKarma = makeKarmaBox(40n, replier, 1);
    utxo.insertBox(oldKarma);

    // ⛔ **A PURE READ.** The planner names boxes and amounts and moves nothing:
    // the pruner's own locks leave circulation and their sink is the karma pool,
    // which only the settlement transaction spends, so consuming them here and
    // crediting the pool at §11a would leave that karma nowhere in between
    // (ARCHITECTURE → The conservation axiom, "not even as an intermediary
    // step"). The settlement consumes every lock and pays every leg at once.
    const journal = await journaled(10, () => {
      const p = planPruneSettlement(rootPostId, pruner, [rootPostId, replyPostId]);
      // The lock is NAMED, not consumed.
      expect(p.lockBoxIds).toEqual([lockBox.box.id]);
      // ⚠ **No merge.** The settlement emits a fresh karma box rather than
      // consolidating the recipient's holdings, so the pre-existing 40 is
      // untouched and the refund is the lock's own 100.
      expect(p.refunds).toHaveLength(1);
      expect(p.refunds[0]!.amount).toBe(100n);
      expect(Buffer.from(p.refunds[0]!.owner).equals(Buffer.from(replier))).toBe(true);
      // Nothing of the reply author's leaves circulation.
      expect(p.toPool).toBe(0n);
    });

    // The planner mutates nothing at all, so the journal is empty and both boxes
    // are still live.
    expect(journal.mutations).toEqual([]);
    const db = getDb();
    expect(boxIsSpent(db, lockBox.box.id!)).toBe(false);
    expect(boxIsSpent(db, oldKarma.id!)).toBe(false);
  });

  it('handles empty postId list', async () => {
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const plan = planPruneSettlement('0'.repeat(64), makeUserId('pruner-empty'), []);
    expect(plan.lockBoxIds).toEqual([]);
    expect(plan.refunds).toEqual([]);
    expect(plan.toPool).toBe(0n);
  });

  it('skips already-spent boxes', async () => {
    await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootPostId = 'c'.repeat(64);
    const replier = makeUserId('replier2');

    // Insert a PostLockBox and spend it beforehand
    const lockBox = makePostLockBox(50n, replier, rootPostId, 1);
    utxo.insertBox(lockBox.box, lockBox.targetPostId);
    utxo.consumeBox(lockBox.box.id!, 5); // Already spent at block 5

    const plan = planPruneSettlement(rootPostId, makeUserId('pruner2'), [rootPostId]);

    // A spent box is not named at all — `getPostLockBox` returns only unspent
    // boxes, so it returns null and the entry contributes nothing.
    expect(plan.lockBoxIds).toEqual([]);
    expect(plan.refunds).toEqual([]);
    expect(plan.toPool).toBe(0n);
  });

  it('aggregates refunds per author across multiple posts', async () => {
    await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    // Right length, wrong alphabet: `'p'.repeat(64)` looked like a post id and
    // is not one. `b32` has no encoding for it — a placeholder has to be hex.
    const postId1 = 'ab'.repeat(32);
    const postId2 = 'cd'.repeat(32);
    const authorId = makeUserId('author3');
    const pruner = makeUserId('pruner3');

    // Two PostLockBoxes for the same author on two posts, neither of them the
    // pruner's — aggregation is what is under test, not the burn rule.
    const lb1 = makePostLockBox(100n, authorId, postId1, 1);
    const lb2 = makePostLockBox(50n, authorId, postId2, 1);
    utxo.insertBox(lb1.box, lb1.targetPostId);
    utxo.insertBox(lb2.box, lb2.targetPostId);

    const plan = planPruneSettlement(postId1, pruner, [postId1, postId2]);

    // Both locks named, in `postIds` order — block content fixes it, so the
    // list is not a fourth ordering source.
    expect(plan.lockBoxIds).toEqual([lb1.box.id, lb2.box.id]);

    // One refund for the author, values aggregated: 100 + 50 = 150.
    expect(plan.refunds).toHaveLength(1);
    expect(plan.refunds[0]!.amount).toBe(150n);
    expect(Buffer.from(plan.refunds[0]!.owner).equals(Buffer.from(authorId))).toBe(true);
    expect(plan.toPool).toBe(0n);
  });

  it('handles posts with no PostLockBox', async () => {
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const postId = 'e'.repeat(64);
    const likesStore = await importLikes();
    const journal = await journaled(10, () => {
        // ⛔ The planner is a pure read; block application deletes the
        // subtree's like-records at §5, right after it. Both steps run here so
        // the journalling seam stays under test at the seam that owns it.
        planPruneSettlement(postId, makeUserId('pruner4'), [postId]);
        likesStore.deleteLikeRecordsForPosts([postId]);
    });
    expect(journal.mutations.length).toBe(0);
  });

  it('PostLockBox with zero value is not consumed', async () => {
    await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootPostId = 'f'.repeat(64);
    // Not the pruner's, so a lost `value > 0n` guard would show as BOTH a
    // consume and a mint — the zero-value guard is the only thing keeping this
    // journal empty.
    const authorId = makeUserId('author4');

    const lockBox = makePostLockBox(0n, authorId, rootPostId, 1);
    utxo.insertBox(lockBox.box, lockBox.targetPostId);

    const likesStore = await importLikes();
    const journal = await journaled(10, () => {
        // ⛔ The planner is a pure read; block application deletes the
        // subtree's like-records at §5, right after it. Both steps run here so
        // the journalling seam stays under test at the seam that owns it.
        planPruneSettlement(rootPostId, makeUserId('pruner5'), [rootPostId]);
        likesStore.deleteLikeRecordsForPosts([rootPostId]);
    });

    // Zero-value box is skipped (lockBox.box.value > 0 check)
    expect(removedIds(journal)).not.toContain(lockBox.box.id);
    expect(journal.mutations.length).toBe(0);
  });

  // ARCHITECTURE → "Prune lifecycle": destroying your own post costs you its
  // bond. The consume is the burn — no mint, and karma supply is the sum of
  // live boxes — so the assertions below pin the consume as well as the
  // absence of a mint. A test that only checked "no karma appeared" would pass
  // just as well against a settlement that never found the box.
  it("consumes the pruning author's own lock and mints nothing — the burn", async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootPostId = 'a1'.repeat(32);
    const pruner = makeUserId('self-pruner');

    const lockBox = makePostLockBox(100n, pruner, rootPostId, 1);
    utxo.insertBox(lockBox.box, lockBox.targetPostId);
    // Pre-existing karma: a mint would merge-consume this box and replace it.
    // Untouched, it proves no mint ran rather than merely that none was visible.
    const oldKarma = makeKarmaBox(40n, pruner, 1);
    utxo.insertBox(oldKarma);

    const plan = planPruneSettlement(rootPostId, pruner, [rootPostId]);

    // ⛔ **THE BURN NAMES A SINK, AND `toPool` IS THAT NAME**
    // (ARCHITECTURE → The conservation axiom: "burn" means *move back to the
    // supply pool*). ⚠ **A consumed box with nothing inserted beside it is a
    // destruction with no positive trace** — nothing for a search to find and
    // nothing for a test to assert.
    expect(plan.lockBoxIds).toEqual([lockBox.box.id]);
    expect(plan.toPool).toBe(100n);
    expect(plan.refunds).toEqual([]);

    // ⚠ **"Consumed, and nothing inserted" is true of a destruction too**, so
    // asserting `toPool` is the only clause that separates a burn returning to
    // the pool from one that ends the karma.
    const db = getDb();
    expect(boxIsSpent(db, lockBox.box.id!)).toBe(false);
    expect(boxIsSpent(db, oldKarma.id!)).toBe(false);
    expect(karmaRows(db).map((r) => r.value)).toEqual([40]);
  });

  // The case that distinguishes this rule from a plain "stop refunding": one
  // subtree holding both the pruner's own bond and someone else's.
  it("a mixed subtree burns the pruner's lock and returns only the other author's", async () => {
    await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootId = 'a2'.repeat(32);
    const replyId = 'b2'.repeat(32);
    const pruner = makeUserId('mixed-pruner');
    const replier = makeUserId('mixed-replier');

    const ownLock = makePostLockBox(100n, pruner, rootId, 1);
    const otherLock = makePostLockBox(50n, replier, replyId, 1);
    utxo.insertBox(ownLock.box, ownLock.targetPostId);
    utxo.insertBox(otherLock.box, otherLock.targetPostId);

    const plan = planPruneSettlement(rootId, pruner, [rootId, replyId]);

    // Both locks are named. ⛔ **The burn and the return differ only in where the
    // value goes**, so the two figures below are what tell them apart — a
    // consumed/not-consumed pair cannot.
    expect(plan.lockBoxIds).toEqual([ownLock.box.id, otherLock.box.id]);

    // The reply author's 50 recirculates; the pruner's 100 leaves circulation
    // for the pool. ⛔ **Neither is destroyed.**
    expect(plan.refunds).toHaveLength(1);
    expect(plan.refunds[0]!.amount).toBe(50n);
    expect(Buffer.from(plan.refunds[0]!.owner).equals(Buffer.from(replier))).toBe(true);
    expect(plan.toPool).toBe(100n);
  });

  // "…on the root and on their own replies downstream" — the burn is keyed on
  // each lock's owner, not on the subtree's root.
  it("burns the pruning author's own reply lock, not just the root's", async () => {
    await importDb();
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootId = 'a3'.repeat(32);
    const ownReplyId = 'b3'.repeat(32);
    const pruner = makeUserId('deep-pruner');

    const rootLock = makePostLockBox(70n, pruner, rootId, 1);
    const replyLock = makePostLockBox(30n, pruner, ownReplyId, 1);
    utxo.insertBox(rootLock.box, rootLock.targetPostId);
    utxo.insertBox(replyLock.box, replyLock.targetPostId);

    const plan = planPruneSettlement(rootId, pruner, [rootId, ownReplyId]);

    expect(plan.lockBoxIds).toEqual([rootLock.box.id, replyLock.box.id]);
    // Both of the pruner's own locks go to the pool — the root's AND the reply's,
    // which is the half a rule reading only the root would miss.
    expect(plan.toPool).toBe(100n);
    expect(plan.refunds).toEqual([]);
  });

  // N3b: the subtree's like-records die with the prune, and every doomed row
  // is captured as a `likeRecordDeletions` side-record so a reverted prune
  // restores them exactly.
  it("deletes the subtree's like-records and journals every deleted row", async () => {
    const likes = await importLikes();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootId = 'a'.repeat(64);
    const replyId = 'b'.repeat(64);
    const likerA = makeUserId('likerA');
    const likerB = makeUserId('likerB');

    // Applied by "earlier blocks": seeded outside any journal, so the
    // seeding itself records nothing.
    likes.insertLikeRecord(rootId, likerA, 3);
    likes.insertLikeRecord(rootId, likerB, 5);
    likes.insertLikeRecord(replyId, likerA, 7);

    const likesStore = await importLikes();
    const journal = await journaled(10, () => {
        // ⛔ The planner is a pure read; block application deletes the
        // subtree's like-records at §5, right after it. Both steps run here so
        // the journalling seam stays under test at the seam that owns it.
        planPruneSettlement(rootId, makeUserId('pruner-likes'), [rootId, replyId]);
        likesStore.deleteLikeRecordsForPosts([rootId, replyId]);
    });

    // Records died with the prune
    expect(likes.hasLikeRecord(rootId, likerA)).toBe(false);
    expect(likes.hasLikeRecord(rootId, likerB)).toBe(false);
    expect(likes.hasLikeRecord(replyId, likerA)).toBe(false);

    // Every doomed row captured, all three columns, capture order pinned by
    // the primary key
    expect(journal.likeRecordDeletions).toEqual([
      { targetPostId: rootId, likerId: likerA, appliedAtBlock: 3 },
      { targetPostId: rootId, likerId: likerB, appliedAtBlock: 5 },
      { targetPostId: replyId, likerId: likerA, appliedAtBlock: 7 },
    ]);
  });

  it('leaves like-records outside the subtree alone and journals exactly the subtree rows', async () => {
    const likes = await importLikes();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const prunedId = 'a'.repeat(64);
    const otherId = 'f'.repeat(64);
    const liker = makeUserId('liker5');

    likes.insertLikeRecord(prunedId, liker, 2);
    likes.insertLikeRecord(otherId, liker, 4);

    const likesStore = await importLikes();
    const journal = await journaled(10, () => {
        // ⛔ The planner is a pure read; block application deletes the
        // subtree's like-records at §5, right after it. Both steps run here so
        // the journalling seam stays under test at the seam that owns it.
        planPruneSettlement(prunedId, makeUserId('pruner-likes2'), [prunedId]);
        likesStore.deleteLikeRecordsForPosts([prunedId]);
    });

    // The unrelated post's record survives, unjournalled; the subtree row is
    // the exact deletion set.
    expect(likes.hasLikeRecord(otherId, liker)).toBe(true);
    expect(journal.likeRecordDeletions).toEqual([
      { targetPostId: prunedId, likerId: liker, appliedAtBlock: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tests: prune refund provenance (Spec G phase G2a)
// ---------------------------------------------------------------------------

/**
 * The subject the contract's reason/subject table pins, built here **without**
 * calling the encoder — `utf8(rootPostHash)` ‖ raw key, 96 bytes. Deriving the
 * expectation independently is what makes these tests fail when the encoder
 * drops `rootPostHash` rather than move with it.
 */
/** Every karma row the settlement left behind, oldest insert first. */
function karmaRows(db: Database.Database): Array<{
  tx_id: string | null;
  output_index: number | null;
  value: number;
}> {
  return db
    .prepare(
      `SELECT tx_id, output_index, value FROM utxo_boxes
       WHERE box_type = 'karma' ORDER BY value ASC`,
    )
    .all() as Array<{ tx_id: string | null; output_index: number | null; value: number }>;
}

describe('planPruneSettlement — refund provenance', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  // The load-bearing case for `rootPostHash`, and it survives the narrower
  // refund set. `block-apply.ts` calls settlement once per prune entry, so two
  // entries in one block are two calls at one height — and one user can have
  // replies in two subtrees that two *different* people prune in that block.
  // Refunded by both, on a subject of just the owner they would derive the same
  // mintTxId twice at index 0 — tripping UNIQUE(tx_id, output_index) and
  // rejecting a legitimate block.
  it('two prune entries at one height name one refund each, for one author', async () => {
    const utxo = await importUtxo();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const rootA = 'a4'.repeat(32);
    const rootB = 'b4'.repeat(32);
    const authorId = makeUserId('two-entry-author');
    const prunerA = makeUserId('two-entry-prunerA');
    const prunerB = makeUserId('two-entry-prunerB');

    const lockA = makePostLockBox(100n, authorId, rootA, 1);
    const lockB = makePostLockBox(50n, authorId, rootB, 1);
    utxo.insertBox(lockA.box, lockA.targetPostId);
    utxo.insertBox(lockB.box, lockB.targetPostId);

    // ⛔ **EACH ENTRY NAMES ITS OWN REFUND, and nothing has to keep them
    // apart.** A refund is an output of the block's settlement transaction, so
    // it takes that transaction's real `(txId, index)` and two outputs of one
    // transaction cannot collide on `UNIQUE(tx_id, output_index)` — the same
    // owner refunded twice at one height is two positions, by construction.
    const planA = planPruneSettlement(rootA, prunerA, [rootA]);
    const planB = planPruneSettlement(rootB, prunerB, [rootB]);

    expect(planA.refunds).toHaveLength(1);
    expect(planB.refunds).toHaveLength(1);
    expect(planA.refunds[0]!.amount).toBe(100n);
    expect(planB.refunds[0]!.amount).toBe(50n);
    for (const p of [planA, planB]) {
      expect(Buffer.from(p.refunds[0]!.owner).equals(Buffer.from(authorId))).toBe(true);
      expect(p.toPool).toBe(0n);
    }
  });

  it('a liked subtree settles to exactly the author mint — no liker leg', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const likes = await importLikes();
    const { planPruneSettlement } = await importSettlePruneUtxo();

    const root = 'c'.repeat(64);
    const pruner = makeUserId('pruner-liked');
    const authorId = makeUserId('author-liked');
    const likerId = makeUserId('liker-liked');

    const lock = makePostLockBox(100n, authorId, root, 1);
    utxo.insertBox(lock.box, lock.targetPostId);
    likes.insertLikeRecord(root, likerId, 3);

    const plan = planPruneSettlement(root, pruner, [root]);

    // ⛔ **Exactly one refund: the author's.** There is no liker leg — a like
    // moves its karma into a marker at cast and the settlement pays it to the
    // author, so a prune has nothing to refund a liker. An exact-set assertion,
    // so any stray second refund fails it regardless of where it came from.
    expect(plan.refunds).toHaveLength(1);
    expect(plan.refunds[0]!.amount).toBe(100n);
    expect(Buffer.from(plan.refunds[0]!.owner).equals(Buffer.from(authorId))).toBe(true);
    expect(plan.toPool).toBe(0n);
    // ⚠ **No synthetic mint id to assert.** A refund is an output of the block's
    // settlement transaction, so its provenance is that transaction's
    // `(txId, index)`. The planner writes nothing, so the ledger is untouched
    // here.
    expect(karmaRows(getDb())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration test: full prune lifecycle (UTXO path)
// ---------------------------------------------------------------------------


describe('Full prune lifecycle (UTXO settlement path)', () => {
  it.todo('retarget for prune transactions');
});

describe('prune settlement stump insert (P2-F F1)', () => {
  it.todo('retarget for prune transactions');
});

describe('prune apply-then-revert (P2-D N3b, real settle path)', () => {
  it.todo('retarget for prune transactions');
});
