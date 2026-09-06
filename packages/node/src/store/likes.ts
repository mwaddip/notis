import type { UserId } from '@dagsocial/types';
import { getDb } from './db.js';
import { recordLikeRecordInsertion } from './journal.js';

// ---------------------------------------------------------------------------
// Like-records (NODE_INTERFACE → Like-records)
//
// `(liker, targetPostId)` pairs written ONLY at block application, never by
// an HTTP route. Content-layer consensus state, the `block_topology` tier:
// deterministic by replay, journalled with exact inverses, not in the
// `stateRoot`. Records survive a withdrawal of their target; nothing deletes
// them.
// ---------------------------------------------------------------------------

/**
 * Write the like-record for an applied like transaction.
 *
 * **Block application only** — by convention, not enforcement: N2b's
 * embedded-tx application is the intended sole caller. Throws on the primary
 * key: `(target, liker)` already present IS the structural
 * one-like-per-account dedup, and at apply time the engine treats the
 * collision as an invalid transaction.
 *
 * While a block journal is open, records a `likeRecordInsertions`
 * side-record (inverse: `deleteLikeRecord`). Recording happens after the
 * INSERT so a duplicate throws before anything reaches the journal.
 */
export function insertLikeRecord(
  targetPostId: string,
  likerId: UserId,
  blockHeight: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO like_records (target_post_id, liker_id, applied_at_block)
       VALUES (?, ?, ?)`,
    )
    .run(targetPostId, Buffer.from(likerId), blockHeight);
  recordLikeRecordInsertion(targetPostId, likerId);
}

/** Has this liker already liked this post? The apply-time dedup read. */
export function hasLikeRecord(targetPostId: string, likerId: UserId): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM like_records WHERE target_post_id = ? AND liker_id = ?')
    .get(targetPostId, Buffer.from(likerId));
  return row !== undefined;
}

/**
 * Lifetime like count for a live post — feeds the API `likeCount`. Nothing
 * decrements it.
 */
export function getLikeRecordCount(postId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM like_records WHERE target_post_id = ?')
    .get(postId) as { cnt: number };
  return row.cnt;
}

/**
 * Remove one like-record — fork-rollback inverse of `insertLikeRecord`.
 * Never records to the block journal.
 */
export function deleteLikeRecord(targetPostId: string, likerId: UserId): void {
  getDb()
    .prepare('DELETE FROM like_records WHERE target_post_id = ? AND liker_id = ?')
    .run(targetPostId, Buffer.from(likerId));
}
