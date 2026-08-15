import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeBoxId, computeMintTxId, PROTOCOL_VERSION } from '@dagsocial/types';
import type {
  PostLockBox,
  KarmaBox,
  OrderingBlock,
  Post,
  Stump,
} from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import type Database from 'better-sqlite3';
import {
  fixtureProvenance,
  hex,
  makeApplicableBlock,
  makePruneEntry,
  makeTestIdentity,
  seedProvenance,
  type Stored,
} from '../helpers.js';

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
    insertBox: (box: unknown) => void;
    getBox: (boxId: string) => unknown;
    getPostLockBox: (targetPostId: string) => PostLockBox | null;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
  };
}

async function importLikes() {
  const mod = await import('../../src/store/likes.js');
  return mod as {
    insertLikeRecord: (targetPostId: string, likerId: Uint8Array, blockHeight: number) => void;
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
    settlePruneUtxo: (
      rootPostHash: string,
      authorId: Uint8Array,
      postIds: string[],
      blockHeight: number,
    ) => void;
  };
}

async function importJournal() {
  const mod = await import('../../src/store/journal.js');
  return mod as {
    beginBlockJournal: (height: number) => void;
    finishBlockJournal: () => BlockJournal;
  };
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

/** boxIds of box 'insert' mutations, in application order. */
function insertedIds(journal: BlockJournal): string[] {
  return journal.mutations
    .filter((m) => m.kind === 'box' && m.op === 'insert')
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
function makePostLockBox(
  value: bigint,
  owner: Uint8Array,
  targetPostId: string,
  seed: number,
): Stored<PostLockBox> {
  return seedProvenance<PostLockBox>({
    boxType: 'post_lock' as const,
    value,
    originalValue: value,
    owner,
    targetPostId,
    guard: 'block_apply' as const,
  }, seed);
}

function makeKarmaBox(
  value: bigint,
  owner: Uint8Array,
  seed: number,
): Stored<KarmaBox> {
  return seedProvenance<KarmaBox>({
    boxType: 'karma' as const,
    value,
    owner,
    guard: 'owner_signature' as const,
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
// Tests: settlePruneUtxo
// ---------------------------------------------------------------------------

describe('settlePruneUtxo', () => {
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
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'a'.repeat(64);
    const replyPostId = 'b'.repeat(64);
    const pruner = makeUserId('pruner1');
    const replier = makeUserId('replier1');

    // The reply's lock belongs to someone other than the pruner, so it
    // returns; plus pre-existing karma the refund mint will merge in (seeded
    // outside the journal, like any pre-block state)
    const lockBox = makePostLockBox(100n, replier, replyPostId, 1);
    utxo.insertBox(lockBox);
    const oldKarma = makeKarmaBox(40n, replier, 1);
    utxo.insertBox(oldKarma);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootPostId, pruner, [rootPostId, replyPostId], 10),
    );

    // PostLockBox consumed
    expect(removedIds(journal)).toContain(lockBox.id);

    // The pre-existing karma box the mint merged in is journaled too — the
    // merge-consume the old hand-maintained journal lost (value-loss on reorg)
    expect(removedIds(journal)).toContain(oldKarma.id);

    // PostLockBox marked spent in DB
    const db = getDb();
    expect(boxIsSpent(db, lockBox.id!)).toBe(true);

    // Merged karma refund box created with old + refund value, its bytes in
    // the journal payload
    const mintedKarma = journal.mutations.find(
      (m) => m.kind === 'box' && m.op === 'insert' && (m.box as KarmaBox).boxType === 'karma',
    ) as BoxMutation | undefined;
    expect(mintedKarma).toBeDefined();
    expect((mintedKarma!.box as KarmaBox).value).toBe(140n);
  });

  it('handles empty postId list', async () => {
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const journal = await journaled(5, () =>
      settlePruneUtxo('0'.repeat(64), makeUserId('pruner-empty'), [], 5),
    );
    expect(journal.mutations.length).toBe(0);
  });

  it('skips already-spent boxes', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'c'.repeat(64);
    const replier = makeUserId('replier2');

    // Insert a PostLockBox and spend it beforehand
    const lockBox = makePostLockBox(50n, replier, rootPostId, 1);
    utxo.insertBox(lockBox);
    utxo.consumeBox(lockBox.id!, 5); // Already spent at block 5

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootPostId, makeUserId('pruner2'), [rootPostId], 10),
    );

    // Already-spent box should not be re-consumed, and no refund karma minted
    // (getPostLockBox returns only unspent boxes, so it returns null)
    expect(journal.mutations.length).toBe(0);
  });

  it('aggregates refunds per author across multiple posts', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

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
    utxo.insertBox(lb1);
    utxo.insertBox(lb2);

    const journal = await journaled(10, () =>
      settlePruneUtxo(postId1, pruner, [postId1, postId2], 10),
    );

    // Both lock boxes consumed
    expect(removedIds(journal)).toContain(lb1.id);
    expect(removedIds(journal)).toContain(lb2.id);

    // One refund box for the author, values aggregated: 100 + 50 = 150
    expect(insertedIds(journal).length).toBe(1);
    const db = getDb();
    const row = db
      .prepare("SELECT value, owner FROM utxo_boxes WHERE id = ? AND box_type = 'karma'")
      .get(insertedIds(journal)[0]!) as { value: number; owner: Buffer };
    expect(row.value).toBe(150);
    expect(Buffer.from(row.owner).equals(Buffer.from(authorId))).toBe(true);
  });

  it('handles posts with no PostLockBox', async () => {
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const postId = 'e'.repeat(64);
    const journal = await journaled(10, () =>
      settlePruneUtxo(postId, makeUserId('pruner4'), [postId], 10),
    );
    expect(journal.mutations.length).toBe(0);
  });

  it('PostLockBox with zero value is not consumed', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'f'.repeat(64);
    // Not the pruner's, so a lost `value > 0n` guard would show as BOTH a
    // consume and a mint — the zero-value guard is the only thing keeping this
    // journal empty.
    const authorId = makeUserId('author4');

    const lockBox = makePostLockBox(0n, authorId, rootPostId, 1);
    utxo.insertBox(lockBox);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootPostId, makeUserId('pruner5'), [rootPostId], 10),
    );

    // Zero-value box is skipped (lockBox.value > 0 check)
    expect(removedIds(journal)).not.toContain(lockBox.id);
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
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootPostId = 'a1'.repeat(32);
    const pruner = makeUserId('self-pruner');

    const lockBox = makePostLockBox(100n, pruner, rootPostId, 1);
    utxo.insertBox(lockBox);
    // Pre-existing karma: a mint would merge-consume this box and replace it.
    // Untouched, it proves no mint ran rather than merely that none was visible.
    const oldKarma = makeKarmaBox(40n, pruner, 1);
    utxo.insertBox(oldKarma);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootPostId, pruner, [rootPostId], 10),
    );

    // The lock is gone — consumed, journalled, and spent in the table.
    expect(removedIds(journal)).toContain(lockBox.id);
    const db = getDb();
    expect(boxIsSpent(db, lockBox.id!)).toBe(true);

    // Nothing was created, and the standing karma box was never merged.
    expect(insertedIds(journal)).toEqual([]);
    expect(removedIds(journal)).not.toContain(oldKarma.id);
    expect(boxIsSpent(db, oldKarma.id!)).toBe(false);
    expect(karmaRows(db).map((r) => r.value)).toEqual([40]);
  });

  // The case that distinguishes this rule from a plain "stop refunding": one
  // subtree holding both the pruner's own bond and someone else's.
  it("a mixed subtree burns the pruner's lock and returns only the other author's", async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a2'.repeat(32);
    const replyId = 'b2'.repeat(32);
    const pruner = makeUserId('mixed-pruner');
    const replier = makeUserId('mixed-replier');

    const ownLock = makePostLockBox(100n, pruner, rootId, 1);
    const otherLock = makePostLockBox(50n, replier, replyId, 1);
    utxo.insertBox(ownLock);
    utxo.insertBox(otherLock);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootId, pruner, [rootId, replyId], 10),
    );

    // Both locks are consumed — the burn and the return differ only in the mint.
    expect(removedIds(journal)).toEqual(
      expect.arrayContaining([ownLock.id, otherLock.id]),
    );
    const db = getDb();
    expect(boxIsSpent(db, ownLock.id!)).toBe(true);
    expect(boxIsSpent(db, otherLock.id!)).toBe(true);

    // Exactly one karma box exists, holding the reply author's 50 and owned by
    // them. The pruner's 100 left supply.
    expect(insertedIds(journal).length).toBe(1);
    const row = db
      .prepare("SELECT value, owner FROM utxo_boxes WHERE id = ? AND box_type = 'karma'")
      .get(insertedIds(journal)[0]!) as { value: number; owner: Buffer };
    expect(row.value).toBe(50);
    expect(Buffer.from(row.owner).equals(Buffer.from(replier))).toBe(true);
    expect(karmaRows(db).map((r) => r.value)).toEqual([50]);
  });

  // "…on the root and on their own replies downstream" — the burn is keyed on
  // each lock's owner, not on the subtree's root.
  it("burns the pruning author's own reply lock, not just the root's", async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a3'.repeat(32);
    const ownReplyId = 'b3'.repeat(32);
    const pruner = makeUserId('deep-pruner');

    const rootLock = makePostLockBox(70n, pruner, rootId, 1);
    const replyLock = makePostLockBox(30n, pruner, ownReplyId, 1);
    utxo.insertBox(rootLock);
    utxo.insertBox(replyLock);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootId, pruner, [rootId, ownReplyId], 10),
    );

    expect(removedIds(journal)).toEqual(
      expect.arrayContaining([rootLock.id, replyLock.id]),
    );
    const db = getDb();
    expect(boxIsSpent(db, rootLock.id!)).toBe(true);
    expect(boxIsSpent(db, replyLock.id!)).toBe(true);
    expect(insertedIds(journal)).toEqual([]);
    expect(karmaRows(db)).toEqual([]);
  });

  // N3b: the subtree's like-records die with the prune, and every doomed row
  // is captured as a `likeRecordDeletions` side-record so a reverted prune
  // restores them exactly.
  it("deletes the subtree's like-records and journals every deleted row", async () => {
    const likes = await importLikes();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a'.repeat(64);
    const replyId = 'b'.repeat(64);
    const likerA = makeUserId('likerA');
    const likerB = makeUserId('likerB');

    // Applied by "earlier blocks": seeded outside any journal, so the
    // seeding itself records nothing.
    likes.insertLikeRecord(rootId, likerA, 3);
    likes.insertLikeRecord(rootId, likerB, 5);
    likes.insertLikeRecord(replyId, likerA, 7);

    const journal = await journaled(10, () =>
      settlePruneUtxo(rootId, makeUserId('pruner-likes'), [rootId, replyId], 10),
    );

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
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const prunedId = 'a'.repeat(64);
    const otherId = 'f'.repeat(64);
    const liker = makeUserId('liker5');

    likes.insertLikeRecord(prunedId, liker, 2);
    likes.insertLikeRecord(otherId, liker, 4);

    const journal = await journaled(10, () =>
      settlePruneUtxo(prunedId, makeUserId('pruner-likes2'), [prunedId], 10),
    );

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
function expectedSubject(rootPostHash: string, key: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(rootPostHash, 'utf-8'), Buffer.from(key)]));
}

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

describe('settlePruneUtxo — refund provenance', () => {
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
  it('two prune entries at one height refunding the same author both apply', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootA = 'a'.repeat(64);
    const rootB = 'b'.repeat(64);
    const prunerA = makeUserId('pruner-of-subtree-A');
    const prunerB = makeUserId('pruner-of-subtree-B');
    const authorId = makeUserId('author-in-both-subtrees');

    utxo.insertBox(makePostLockBox(100n, authorId, rootA, 1));
    utxo.insertBox(makePostLockBox(50n, authorId, rootB, 1));

    // One journal, one height, two entries — exactly the loop in block-apply.
    const journal = await journaled(10, () => {
      settlePruneUtxo(rootA, prunerA, [rootA], 10);
      settlePruneUtxo(rootB, prunerB, [rootB], 10);
    });

    // Second mint merges the first, so the survivor holds 100 + 50.
    const rows = karmaRows(getDb());
    expect(rows.map((r) => r.value)).toEqual([100, 150]);

    // Both rows persist — the merge marks the first spent, it does not delete
    // the row — so the two mints must occupy distinct provenance keys.
    expect(rows.map((r) => r.tx_id)).toEqual([
      computeMintTxId(10, 'prune-refund-author', expectedSubject(rootA, authorId)),
      computeMintTxId(10, 'prune-refund-author', expectedSubject(rootB, authorId)),
    ]);
    expect(rows.map((r) => r.output_index)).toEqual([0, 0]);
    expect(insertedIds(journal).length).toBe(2);
  });

  // N3b/T2b: the liker leg is gone — a like's karma was burned at cast and is
  // deliberately unrecoverable, so a prune refunds no liker. The subtree's
  // post WAS liked (like-record seeded), so a stray liker mint — whatever it
  // were derived from — would land in this table and fail the exact-set
  // assertion below. (The named-id tripwire that stood here until T2b died
  // with the retired reason: its mint id is no longer derivable. The
  // exact-set assertion subsumes it.)
  it('a liked subtree settles to exactly the author mint — no liker leg', async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const likes = await importLikes();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const root = 'c'.repeat(64);
    const pruner = makeUserId('pruner-liked');
    const authorId = makeUserId('author-liked');
    const likerId = makeUserId('liker-liked');

    utxo.insertBox(makePostLockBox(100n, authorId, root, 1));
    likes.insertLikeRecord(root, likerId, 3);

    await journaled(10, () => settlePruneUtxo(root, pruner, [root], 10));

    // Exactly one mint: the author's — an exact-set assertion, so any stray
    // second mint fails it regardless of what it would be derived from.
    const rows = karmaRows(getDb());
    expect(rows.map((r) => r.tx_id)).toEqual([
      computeMintTxId(10, 'prune-refund-author', expectedSubject(root, authorId)),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration test: full prune lifecycle (UTXO path)
// ---------------------------------------------------------------------------

describe('Full prune lifecycle (UTXO settlement path)', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("full lifecycle: create posts, prune, verify the reply author's refund", async () => {
    const { getDb } = await importDb();
    const utxo = await importUtxo();
    const topology = await importTopology();
    const { settlePruneUtxo } = await importSettlePruneUtxo();

    const rootId = 'a'.repeat(64);
    const replyId = 'b'.repeat(64);
    const authorId = makeUserId('author1');
    const replier = makeUserId('replier1');

    // 1. Seed block_topology: root has no parents, reply has root as parent —
    //    and the reply is somebody else's, the shape the prune rule turns on
    const authorHex = Buffer.from(authorId).toString('hex');
    topology.insertBlockTopology(rootId, [], authorHex, 1);
    topology.insertBlockTopology(replyId, [rootId], Buffer.from(replier).toString('hex'), 2);

    // 2. Verify subtree includes both posts
    const subtree = topology.getSubtreeTopology(rootId);
    expect(subtree).toEqual(new Set([rootId, replyId]));

    // 3. Seed UTXO: PostLockBox for each post
    const lb1 = makePostLockBox(50n, authorId, rootId, 1);
    const lb2 = makePostLockBox(50n, replier, replyId, 1);
    utxo.insertBox(lb1);
    utxo.insertBox(lb2);

    // 4. Apply settlement, pruned by the root's author
    const journal = await journaled(10, () =>
      settlePruneUtxo(rootId, authorId, [rootId, replyId], 10),
    );

    // 5. Verify PostLockBoxes consumed
    expect(removedIds(journal)).toContain(lb1.id);
    expect(removedIds(journal)).toContain(lb2.id);

    // 6. Verify karma: the reply author gets their 50 back, the pruning author
    //    gets nothing — their own 50 burned with the consume
    const db = getDb();
    const createdBoxes = insertedIds(journal).map(
      (boxId) =>
        db
          .prepare('SELECT * FROM utxo_boxes WHERE id = ?')
          .get(boxId) as {
          value: number;
          owner: Buffer;
          box_type: string;
        } | undefined,
    ).filter(Boolean);

    const replierBox = createdBoxes.find(
      (b) => b && Buffer.from(b.owner).equals(Buffer.from(replier)),
    );
    expect(replierBox).toBeDefined();
    expect(replierBox!.value).toBe(50);
    expect(
      createdBoxes.find((b) => b && Buffer.from(b.owner).equals(Buffer.from(authorId))),
    ).toBeUndefined();

    // 7. Verify all original boxes are marked spent
    expect(boxIsSpent(db, lb1.id!)).toBe(true);
    expect(boxIsSpent(db, lb2.id!)).toBe(true);

    // 8. Verify getPostLockBox returns null (box now spent)
    expect(utxo.getPostLockBox(rootId)).toBeNull();
    expect(utxo.getPostLockBox(replyId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: stump insert is structural at settlement (P2-F F1)
// ---------------------------------------------------------------------------

describe('prune settlement stump insert (P2-F F1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../src/store/posts.js');
    vi.resetModules();
  });

  async function importBlockApply() {
    return (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (block: OrderingBlock) => boolean;
    };
  }

  async function importStumps() {
    return (await import('../../src/store/stumps.js')) as {
      getStump: (id: string) => Stump | null;
    };
  }

  async function importPostsStore() {
    return (await import('../../src/store/posts.js')) as {
      getPost: (id: string) => Post | Stump | null;
    };
  }

  async function importOrderingStore() {
    return (await import('../../src/store/ordering.js')) as {
      getCurrentHeight: () => number;
    };
  }

  // Pins the contract obligation (NODE_INTERFACE → "Pruning" step 4;
  // ARCHITECTURE → "Prune lifecycle" step 7): a node holding no DAG content for
  // the subtree records the same stump at settlement, every field derived from
  // the verified entry or the carrying block's height. An unconditional insert
  // would satisfy this only incidentally — `pruneSubtree` returns silently on
  // zero rows — so the assertion is written against the obligation rather than
  // against any one implementation of it.
  it('records the stump at settlement on a node holding no DAG content', async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const rootId = 'a1'.repeat(32);
    const replyId = 'b2'.repeat(32);

    const blockApply = await importBlockApply();

    // Height 1 confirms root + reply as consensus entries. No post content is
    // ever inserted — confirmation creates placeholders, which is all a
    // content-less node holds.
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [
        { postId: rootId, parentRefs: [], author: hex(author.userId) },
        { postId: replyId, parentRefs: [rootId], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Placeholder, not content — the content-less premise, pinned.
    const posts = await importPostsStore();
    const beforePrune = posts.getPost(rootId);
    expect(beforePrune).not.toBeNull();
    expect((beforePrune as Post).content).toBe('');

    // Height 2 settles the prune.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(rootId, [rootId, replyId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const { getStump } = await importStumps();
    const stump = getStump(rootId);
    expect(stump).not.toBeNull();
    expect(stump!.rootPostHash).toBe(rootId);
    expect(hex(stump!.authorId)).toBe(hex(author.userId));
    expect(stump!.replyCount).toBe(1); // subtreePostIds.length - 1
    expect(stump!.trigger).toBe('author');
    expect(stump!.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(stump!.compactedAtBlockHeight).toBe(2); // the carrying block's height
  });

  // The discriminating case for P2-F F1: the stump insert is structural —
  // not behind the content prune. With pruneSubtree forced to throw, the
  // block still applies (content-prune failure stays non-fatal) AND the
  // stump row exists. Before the change (insertStump after pruneSubtree
  // inside one try/catch) the throw skipped the insert: the block applied
  // with the stump silently missing.
  it('records the stump even when pruneSubtree throws (structural independence)', async () => {
    vi.doMock('../../src/store/posts.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/store/posts.js')>();
      return {
        ...orig,
        pruneSubtree: (): void => {
          throw new Error('forced pruneSubtree failure (test seam)');
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const rootId = 'c3'.repeat(32);

    const blockApply = await importBlockApply();
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [
        { postId: rootId, parentRefs: [], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(rootId, [rootId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    const ordering = await importOrderingStore();
    expect(ordering.getCurrentHeight()).toBe(2);

    const { getStump } = await importStumps();
    const stump = getStump(rootId);
    expect(stump).not.toBeNull();
    expect(stump!.compactedAtBlockHeight).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: prune apply → revert restores like-records (P2-D N3b)
// ---------------------------------------------------------------------------

describe('prune apply-then-revert (P2-D N3b, real settle path)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function importBlockApply() {
    return (await import('../../src/services/block-apply.js')) as {
      applyOrderingBlock: (block: OrderingBlock) => boolean;
    };
  }

  async function importForkResolution() {
    return (await import('../../src/services/fork-resolution.js')) as {
      revertBlock: (height: number) => unknown;
    };
  }

  // N2b pinned the likeRecordDeletions inverse against a hand-built journal;
  // this closes the loop end-to-end: the journal is produced by the REAL
  // prune path (applyOrderingBlock → settlePruneUtxo →
  // deleteLikeRecordsForPosts), then revertBlock replays it and the exact
  // rows return.
  it("a reverted prune block restores the subtree's like-records exactly (all three columns)", async () => {
    const db = await importDb();
    db.initDb(':memory:');

    const author = makeTestIdentity();
    const likerA = makeTestIdentity();
    const likerB = makeTestIdentity();
    const rootId = 'd4'.repeat(32);
    const replyId = 'e5'.repeat(32);

    const blockApply = await importBlockApply();
    const likes = await importLikes();
    const forkResolution = await importForkResolution();

    // Height 1 confirms root + reply as consensus entries.
    const confirmBlock = await makeApplicableBlock({
      subBlockEntries: [
        { postId: rootId, parentRefs: [], author: hex(author.userId) },
        { postId: replyId, parentRefs: [rootId], author: hex(author.userId) },
      ],
    });
    expect(blockApply.applyOrderingBlock(confirmBlock)).toBe(true);

    // Like-records applied by earlier blocks — seeded via the store with no
    // journal open, exactly the state a node holds before the prune block.
    likes.insertLikeRecord(rootId, likerA.userId, 1);
    likes.insertLikeRecord(rootId, likerB.userId, 1);
    likes.insertLikeRecord(replyId, likerA.userId, 1);

    // Height 2 prunes the subtree through the real apply path.
    const pruneBlock = await makeApplicableBlock({
      height: 2,
      pruneEntries: [makePruneEntry(rootId, [rootId, replyId], author)],
    });
    expect(blockApply.applyOrderingBlock(pruneBlock)).toBe(true);

    // The subtree's records died with the prune.
    expect(likes.hasLikeRecord(rootId, likerA.userId)).toBe(false);
    expect(likes.hasLikeRecord(rootId, likerB.userId)).toBe(false);
    expect(likes.hasLikeRecord(replyId, likerA.userId)).toBe(false);

    // Revert the prune block: the journalled deletions replay through
    // restoreLikeRecord and the exact rows return.
    forkResolution.revertBlock(2);

    const rows = db
      .getDb()
      .prepare(
        'SELECT target_post_id, liker_id, applied_at_block FROM like_records ORDER BY target_post_id, liker_id',
      )
      .all() as Array<{ target_post_id: string; liker_id: Buffer; applied_at_block: number }>;
    const restored = rows.map((r) => ({
      targetPostId: r.target_post_id,
      likerId: r.liker_id.toString('hex'),
      appliedAtBlock: r.applied_at_block,
    }));
    // Liker keys are random, so sort the expectation the way the query sorts
    // rows (hex order = BLOB byte order).
    const expected = [
      { targetPostId: rootId, likerId: hex(likerA.userId), appliedAtBlock: 1 },
      { targetPostId: rootId, likerId: hex(likerB.userId), appliedAtBlock: 1 },
      { targetPostId: replyId, likerId: hex(likerA.userId), appliedAtBlock: 1 },
    ].sort((a, b) =>
      a.targetPostId !== b.targetPostId
        ? a.targetPostId < b.targetPostId
          ? -1
          : 1
        : a.likerId < b.likerId
          ? -1
          : 1,
    );
    expect(restored).toEqual(expected);
  });
});
