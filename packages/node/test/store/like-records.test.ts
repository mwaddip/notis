import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BlockEffects } from '@dagsocial/consensus';
import { uid } from '../helpers.js';

/**
 * The like-record store (NODE_INTERFACE → Like-records).
 *
 * `(liker, targetPostId)` pairs, written only at block application. These tests
 * drive the primitives directly, with no producer in the way, so what they pin
 * is the row boundary and the composite key; the journal cases build their
 * journal with the effects writer and undo it with `revertBlock`. The callers —
 * block application's dedup gate, the mempool gate — are covered in their own
 * suites.
 */

// ---------------------------------------------------------------------------
// Dynamic import helpers — a fresh module graph, and so a fresh database
// handle, per test
// ---------------------------------------------------------------------------

async function importAll() {
  const db = await import('../../src/store/db.js');
  const journal = await import('../../src/store/journal.js');
  const likes = await import('../../src/store/likes.js');
  const { writeBlockEffects } = await import('../../src/services/block-apply.js');
  const { revertBlock } = await import('../../src/services/fork-resolution.js');
  return { ...db, ...journal, ...likes, writeBlockEffects, revertBlock };
}

function likesOnly(likeRecords: BlockEffects['likeRecords']): BlockEffects {
  return { mutations: [], posts: [], likeRecords, withdrawals: [], appliedTxs: [] };
}

const LIKER_A = uid('lr-liker-a');
const LIKER_B = uid('lr-liker-b');
const LIKER_C = uid('lr-liker-c');

describe('like-records store (P2-D N2a)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // --- CRUD ------------------------------------------------------------------

  it('insert → has and count observe the record', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(false);
    expect(s.getLikeRecordCount('post-1')).toBe(0);

    s.insertLikeRecord('post-1', LIKER_A, 7);

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(true);
    expect(s.hasLikeRecord('post-1', LIKER_B)).toBe(false);
    expect(s.hasLikeRecord('post-2', LIKER_A)).toBe(false);
    expect(s.getLikeRecordCount('post-1')).toBe(1);

    s.insertLikeRecord('post-1', LIKER_B, 7);
    expect(s.getLikeRecordCount('post-1')).toBe(2);
    expect(s.getLikeRecordCount('post-2')).toBe(0);
  });

  it('a duplicate insert THROWS on the primary key — the structural dedup', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 3);
    expect(() => s.insertLikeRecord('post-1', LIKER_A, 4)).toThrow();

    // The original row is untouched — same applied height, count still 1.
    const row = s.getDb()
      .prepare('SELECT applied_at_block FROM like_records WHERE target_post_id = ? AND liker_id = ?')
      .get('post-1', Buffer.from(LIKER_A)) as { applied_at_block: number };
    expect(row.applied_at_block).toBe(3);
    expect(s.getLikeRecordCount('post-1')).toBe(1);
  });

  it('the same liker may like different posts, different likers the same post', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 1);
    expect(() => s.insertLikeRecord('post-2', LIKER_A, 1)).not.toThrow();
    expect(() => s.insertLikeRecord('post-1', LIKER_B, 1)).not.toThrow();
  });

  // --- Inverses --------------------------------------------------------------

  it('deleteLikeRecord is the exact inverse of one insert', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertLikeRecord('post-1', LIKER_A, 5);
    s.insertLikeRecord('post-1', LIKER_B, 5);

    s.deleteLikeRecord('post-1', LIKER_A);

    expect(s.hasLikeRecord('post-1', LIKER_A)).toBe(false);
    expect(s.hasLikeRecord('post-1', LIKER_B)).toBe(true);
  });

  it('revertBlock undoes a block\'s like records and restores the exact pre-block rows', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    // Pre-state: two records on post-1, one on post-2.
    s.insertLikeRecord('post-1', LIKER_A, 1);
    s.insertLikeRecord('post-1', LIKER_B, 2);
    s.insertLikeRecord('post-2', LIKER_C, 3);
    const preRows = s.getDb()
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all();

    // A block inserts one more record.
    s.insertBlockJournal(s.writeBlockEffects(likesOnly([{ targetPostId: 'post-2', likerId: LIKER_A }]), 9));
    expect(s.hasLikeRecord('post-2', LIKER_A)).toBe(true);

    s.revertBlock(9);

    const postRows = s.getDb()
      .prepare('SELECT * FROM like_records ORDER BY target_post_id, liker_id')
      .all();
    expect(postRows).toEqual(preRows);
  });

  // --- Journal row round-trip ------------------------------------------------

  it('the persisted journal row round-trips likeRecordInsertions', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBlockJournal(s.writeBlockEffects(likesOnly([{ targetPostId: 'post-1', likerId: LIKER_A }]), 11));
    const back = s.getBlockJournal(11);
    expect(back).not.toBeNull();

    // CBOR hands byte fields back as plain Uint8Array — compare content-wise.
    expect(back!.likeRecordInsertions).toHaveLength(1);
    expect(back!.likeRecordInsertions[0]!.targetPostId).toBe('post-1');
    expect(new Uint8Array(back!.likeRecordInsertions[0]!.likerId)).toEqual(LIKER_A);
  });

  it('an empty journal round-trips likeRecordInsertions as empty, not absent', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBlockJournal(s.writeBlockEffects(likesOnly([]), 12));

    const back = s.getBlockJournal(12)!;
    expect(back.likeRecordInsertions).toEqual([]);
  });
});
