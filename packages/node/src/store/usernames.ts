import { getDb } from './db.js';
import type { UserId } from '@dagsocial/types';
import type { UsernameRow } from '@dagsocial/consensus';

// NODE_INTERFACE → Username records

export type { UsernameRow };

export interface HolderRecord {
  claimAvailable: boolean;
  boxId: string | null;
}

export function getUsername(nameLower: string): UsernameRow | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT name_lower, name, owner, box_id, claimed_at_block FROM usernames WHERE name_lower = ?',
  ).get(nameLower) as { name_lower: string; name: string; owner: string; box_id: string; claimed_at_block: number } | undefined;
  if (!row) return null;
  return {
    nameLower: row.name_lower,
    name: row.name,
    owner: row.owner,
    boxId: row.box_id,
    claimedAtBlock: row.claimed_at_block,
  };
}

export function getUsernameByOwner(owner: UserId | string): UsernameRow | null {
  const db = getDb();
  const ownerHex = typeof owner === 'string' ? owner : Buffer.from(owner).toString('hex');
  const row = db.prepare(
    'SELECT name_lower, name, owner, box_id, claimed_at_block FROM usernames WHERE owner = ?',
  ).get(ownerHex) as { name_lower: string; name: string; owner: string; box_id: string; claimed_at_block: number } | undefined;
  if (!row) return null;
  return {
    nameLower: row.name_lower,
    name: row.name,
    owner: row.owner,
    boxId: row.box_id,
    claimedAtBlock: row.claimed_at_block,
  };
}

/**
 * The claim's write — one row, the name record and its holder's record both
 * (NODE_INTERFACE → Username records). A plain write: the journal entries and
 * the rows they replace are the effects writer's
 * (NODE_INTERFACE → Block Journal).
 */
export function putUsername(row: UsernameRow): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO usernames (name_lower, name, owner, box_id, claimed_at_block)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.nameLower, row.name, row.owner, row.boxId, row.claimedAtBlock);
}

/** The burn's write: the row goes, and with it both records. A plain write, as `putUsername` is. */
export function deleteUsername(nameLower: string): void {
  getDb().prepare('DELETE FROM usernames WHERE name_lower = ?').run(nameLower);
}

export function countUsernames(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM usernames').get() as { n: number };
  return row.n;
}
