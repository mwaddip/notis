import { getDb, prepared } from './db.js';
import { getOrderingBlockHash } from './ordering.js';

/**
 * Idempotent insert — a second refusal of the same block is a no-op.
 */
export function insertRefusedHeader(hash: string, height: number, refusedAt: number): void {
  prepared(getDb(), 'INSERT OR IGNORE INTO refused_headers (hash, height, refused_at) VALUES (?, ?, ?)')
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
 * The header-standing provider (NODE_INTERFACE → Sync handlers): `'held'`
 * when the `block_hash` column at `height` equals `hash`, `'refused'` when
 * `refused_headers` holds `hash`, `null` otherwise. Net reads this through
 * the stage-1 ordering-block validator to Ignore a header this node knows
 * (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"). Two
 * point reads — one decodes no row — so there is nothing for
 * `failStopIfCorruptChain` to promote, and the provider is handed over
 * unwrapped.
 */
export function headerStanding(hash: string, height: number): 'held' | 'refused' | null {
  if (getOrderingBlockHash(height) === hash) return 'held';
  if (anyRefusedHeader([hash])) return 'refused';
  return null;
}

/**
 * Remove all marks below `belowHeight`. Called beside `purgeOldJournals` with
 * the same bound: `height − maxReorgDepth` (NODE_INTERFACE → Refused headers).
 */
export function purgeRefusedHeaders(belowHeight: number): void {
  prepared(getDb(), 'DELETE FROM refused_headers WHERE height < ?')
    .run(belowHeight);
}
