import { createHash } from 'node:crypto';
import { NETWORK_KEY_DOMAIN, identityRecordKey } from '@dagsocial/types';
import { getDb } from './db.js';
import { isBlockJournalOpen, recordIdentityRecordPut, recordNetworkRecordPut } from './journal.js';
import type { UserId, IdentityRecord } from '@dagsocial/types';
import type { NetworkRecord } from '@dagsocial/consensus';

export type { NetworkRecord };

/**
 * SQL and journal for the identity record (TYPES_INTERFACE → Identity record
 * and karma valuation for the type, the AVL key and the codec).
 *
 * **Who populates this.** Block application writes each record its effects
 * carry — the activity bump when a post transaction applies, the decay clock
 * when decay fires, the grant, the like counters, the membership pass
 * (NODE_INTERFACE → Populating the record); `ensureSystemKarmaBox` writes
 * genesis's own record, since it runs outside block application.
 *
 * The SQL table keys on the raw identity bytes (`UserId`); the AVL key is
 * derived from them by `identityRecordKey` in `@dagsocial/types`. Both are
 * total functions of the identity, so the two representations cannot drift.
 */

/** The record for an identity, or null if it has none yet. */
export function getIdentityRecord(identityId: UserId): IdentityRecord | null {
  const row = getDb()
    .prepare(
      `SELECT last_activity_block, last_decay_block, invited_at_block,
              lifetime_likes_received, member_since_block, member_bar,
              member_vouches, member_likes, invites_used
       FROM identity_records WHERE identity_id = ?`,
    )
    .safeIntegers()
    .get(Buffer.from(identityId)) as
      {
        last_activity_block: bigint; last_decay_block: bigint;
        invited_at_block: bigint;
        lifetime_likes_received: bigint;
        member_since_block: bigint; member_bar: bigint;
        member_vouches: bigint; member_likes: bigint;
        invites_used: bigint;
      }
      | undefined;
  if (!row) return null;
  return {
    lastActivityBlock: Number(row.last_activity_block),
    lastDecayBlock: Number(row.last_decay_block),
    invitedAtBlock: Number(row.invited_at_block),
    lifetimeLikesReceived: row.lifetime_likes_received,
    memberSinceBlock: Number(row.member_since_block),
    memberBar: Number(row.member_bar),
    memberVouches: Number(row.member_vouches),
    memberLikes: row.member_likes,
    invitesUsed: Number(row.invites_used),
  };
}

/**
 * Every identity record in the store, ordered by raw identity bytes.
 *
 * Production caller: `seedGenesisState`, which feeds the full set into
 * `bootstrapAvlProver` over the empty genesis tree — the one case where a
 * full-set feed is sound (NODE_INTERFACE → AVL+ State Root → "AVL+ tree
 * shape is history-dependent"). Store unit tests also use it.
 *
 * The SQL `ORDER BY` is not the canonical order — the AVL key is a *hash* of
 * these bytes, so a prover feed sorts by that instead. This ordering only
 * makes the read deterministic.
 */
export function getAllIdentityRecords(): Array<{ identityId: UserId; record: IdentityRecord }> {
  const rows = getDb()
    .prepare(
      `SELECT identity_id, last_activity_block, last_decay_block,
              invited_at_block, lifetime_likes_received,
              member_since_block, member_bar, member_vouches,
              member_likes, invites_used
       FROM identity_records ORDER BY identity_id`,
    )
    .safeIntegers()
    .all() as Array<{
      identity_id: Buffer;
      last_activity_block: bigint;
      last_decay_block: bigint;
      invited_at_block: bigint;
      lifetime_likes_received: bigint;
      member_since_block: bigint;
      member_bar: bigint;
      member_vouches: bigint;
      member_likes: bigint;
      invites_used: bigint;
    }>;
  return rows.map((row) => ({
    identityId: new Uint8Array(row.identity_id),
    record: {
      lastActivityBlock: Number(row.last_activity_block),
      lastDecayBlock: Number(row.last_decay_block),
      invitedAtBlock: Number(row.invited_at_block),
      lifetimeLikesReceived: row.lifetime_likes_received,
      memberSinceBlock: Number(row.member_since_block),
      memberBar: Number(row.member_bar),
      memberVouches: Number(row.member_vouches),
      memberLikes: row.member_likes,
      invitesUsed: Number(row.invites_used),
    },
  }));
}

/**
 * Upsert an identity record.
 *
 * Created on first karma receipt, **never deleted** in normal operation — only
 * by rollback. Deleting at zero balance would keep the tree smaller but would
 * require revert to resurrect records with their exact prior values;
 * unbounded-but-simple is the deliberate choice at this stage.
 *
 * While a block journal is open this captures the row it replaces **before**
 * writing and records the mutation.
 */
export function putIdentityRecord(identityId: UserId, record: IdentityRecord): void {
  const replaced = isBlockJournalOpen()
    ? (getIdentityRecord(identityId) ?? undefined)
    : undefined;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO identity_records
         (identity_id, last_activity_block, last_decay_block,
          invited_at_block, lifetime_likes_received,
          member_since_block, member_bar, member_vouches,
          member_likes, invites_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Buffer.from(identityId),
      record.lastActivityBlock,
      record.lastDecayBlock,
      record.invitedAtBlock,
      record.lifetimeLikesReceived,
      record.memberSinceBlock,
      record.memberBar,
      record.memberVouches,
      record.memberLikes,
      record.invitesUsed,
    );
  recordIdentityRecordPut(identityRecordKey(identityId), identityId, record, replaced);
}

/**
 * Remove an identity record.
 *
 * Fork-rollback inverse only — the inverse of a *first* `putIdentityRecord` for
 * a key. Never records to the block journal.
 */
export function deleteIdentityRecord(identityId: UserId): void {
  getDb()
    .prepare('DELETE FROM identity_records WHERE identity_id = ?')
    .run(Buffer.from(identityId));
}

// ---------------------------------------------------------------------------
// Network record — NODE_INTERFACE → Network record
// ---------------------------------------------------------------------------

/**
 * The network record's AVL key: `blake2b512(NETWORK_KEY_DOMAIN)[0:32]`, hex.
 * The tag alone is the preimage — the identity key's hashing rule with nothing
 * after the tag. Five entity kinds, five disjoint domain tags.
 */
export function networkRecordKey(): string {
  return createHash('blake2b512')
    .update(NETWORK_KEY_DOMAIN)
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/** The one row; throws where none exists (a store never seeded). */
export function getNetworkRecord(): NetworkRecord {
  const row = getDb()
    .prepare('SELECT member_count FROM network_record WHERE id = 1')
    .get() as { member_count: number } | undefined;
  if (!row) {
    throw new Error('getNetworkRecord: no network record — store was never seeded');
  }
  return { memberCount: row.member_count };
}

/**
 * Upsert the network record. While a block journal is open, captures the row
 * it replaces and records a NetworkMutation — the same pattern as
 * putIdentityRecord.
 */
export function putNetworkRecord(record: NetworkRecord): void {
  const replaced = isBlockJournalOpen()
    ? getNetworkRecord()
    : undefined;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, ?)`,
    )
    .run(record.memberCount);
  recordNetworkRecordPut(record, replaced);
}
