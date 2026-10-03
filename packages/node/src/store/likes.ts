import type { UserId } from '@dagsocial/types';
import { getDb } from './db.js';

// ---------------------------------------------------------------------------
// Like-records (NODE_INTERFACE → Like-records)
//
// `(target_post_id, liker_id)` pairs written ONLY at block application,
// never by an HTTP route. **No rule reads this table**: the rule reads the
// tree's `like ‖ postId ‖ liker` marker under the state root
// (NODE_INTERFACE → Like-records; CONSENSUS_INTERFACE → StateView;
// TYPES_INTERFACE → Layout — tree records), and the table is a redundant
// view-side copy — journalled with exact inverses, written from the same
// effects in the same block — that answers the views and admission's
// duplicate gate. Records survive a withdrawal of their target; nothing
// deletes them.
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
 * A plain write: the journal's `likeRecordInsertions` entry is the effects
 * writer's (NODE_INTERFACE → Block Journal; inverse: `deleteLikeRecord`).
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

/** Remove one like-record — fork-rollback inverse of `insertLikeRecord`. */
export function deleteLikeRecord(targetPostId: string, likerId: UserId): void {
  getDb()
    .prepare('DELETE FROM like_records WHERE target_post_id = ? AND liker_id = ?')
    .run(targetPostId, Buffer.from(likerId));
}
