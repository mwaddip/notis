import { getDb } from './db.js';

/**
 * Idempotent insert — a second refusal of the same block is a no-op.
 */
export function insertRefusedHeader(hash: string, height: number, refusedAt: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO refused_headers (hash, height, refused_at) VALUES (?, ?, ?)')
    .run(hash, height, refusedAt);
}

/**
 * True iff any of the given hashes is present in the refused set.
 */
export function anyRefusedHeader(hashes: string[]): boolean {
  if (hashes.length === 0) return false;
  const db = getDb();
  const placeholders = hashes.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT 1 FROM refused_headers WHERE hash IN (${placeholders}) LIMIT 1`)
    .get(...hashes) as { '1': number } | undefined;
  return row !== undefined;
}

/**
 * Remove all marks below `belowHeight`. Called beside `purgeOldJournals` with
 * the same bound: `height − maxReorgDepth` (NODE_INTERFACE → Refused headers).
 */
export function purgeRefusedHeaders(belowHeight: number): void {
  getDb()
    .prepare('DELETE FROM refused_headers WHERE height < ?')
    .run(belowHeight);
}
