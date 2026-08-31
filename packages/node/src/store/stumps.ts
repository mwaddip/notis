import { getDb } from './db.js';
import type { Stump } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface StumpRow {
  id: string;
  root_post_hash: string;
  author_id: Buffer; // 32-byte Ed25519 public key
  reply_count: number;
  upvote_count: number;
  protocol_version: number;
  compacted_at_block_height: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function rowToStump(row: StumpRow): Stump {
  return {
    rootPostHash: row.root_post_hash,
    authorId: new Uint8Array(row.author_id),
    replyCount: row.reply_count,
    upvoteCount: row.upvote_count,
    protocolVersion: row.protocol_version,
    compactedAtBlockHeight: row.compacted_at_block_height,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a stump into dag_stumps.
 * The stump ID is its rootPostHash — the canonical lookup key.
 */
export function insertStump(stump: Stump): void {
  const db = getDb();
  const stumpId = stump.rootPostHash;

  db.prepare(
    `INSERT OR REPLACE INTO dag_stumps
       (id, root_post_hash, author_id, reply_count, upvote_count,
        protocol_version, compacted_at_block_height)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stumpId,
    stump.rootPostHash,
    Buffer.from(stump.authorId),
    stump.replyCount,
    stump.upvoteCount,
    stump.protocolVersion,
    stump.compactedAtBlockHeight,
  );
}

/**
 * Retrieve a stump by its id (rootPostHash).
 * Returns null if no stump with that id exists.
 */
export function getStump(stumpId: string): Stump | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM dag_stumps WHERE id = ?')
    .get(stumpId) as StumpRow | undefined;
  return row ? rowToStump(row) : null;
}

export function deleteStump(stumpId: string): void {
  getDb().prepare('DELETE FROM dag_stumps WHERE id = ?').run(stumpId);
}
