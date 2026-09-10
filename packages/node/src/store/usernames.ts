import { getDb } from './db.js';
import { recordUsernameMutation, recordHolderMutation } from './journal.js';
import type { UserId } from '@dagsocial/types';

// NODE_INTERFACE → Username records

export interface UsernameRow {
  nameLower: string;
  name: string;
  owner: string;
  boxId: string;
  claimedAtBlock: number;
}

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

export function putUsername(row: UsernameRow): void {
  const db = getDb();
  const existing = getUsername(row.nameLower);
  const existingByOwner = getUsernameByOwner(row.owner);

  db.prepare(
    `INSERT OR REPLACE INTO usernames (name_lower, name, owner, box_id, claimed_at_block)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.nameLower, row.name, row.owner, row.boxId, row.claimedAtBlock);

  recordUsernameMutation(row.nameLower, row, existing ?? undefined);
  recordHolderMutation(
    Buffer.from(row.owner, 'hex'),
    { claimAvailable: false, boxId: row.boxId },
    existingByOwner ? { claimAvailable: false, boxId: existingByOwner.boxId } : undefined,
  );
}

export function deleteUsername(nameLower: string): void {
  const db = getDb();
  const existing = getUsername(nameLower);
  if (!existing) return;

  db.prepare('DELETE FROM usernames WHERE name_lower = ?').run(nameLower);

  recordUsernameMutation(nameLower, null, existing);
  // NODE_INTERFACE → Username records: an absent holder record means
  // { claimAvailable: true, boxId: null } and is never written — a burn
  // removes the record.
  recordHolderMutation(
    Buffer.from(existing.owner, 'hex'),
    null,
    { claimAvailable: false, boxId: existing.boxId },
  );
}

export function countUsernames(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM usernames').get() as { n: number };
  return row.n;
}
