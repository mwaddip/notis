import { createHash } from 'node:crypto';
import { IDENTITY_KEY_DOMAIN, NETWORK_KEY_DOMAIN } from '@dagsocial/types';
import { getDb } from './db.js';
import { isBlockJournalOpen, recordIdentityRecordPut, recordNetworkRecordPut } from './journal.js';
import type { UserId } from '@dagsocial/types';

/**
 * The per-identity decay clock — the second committed entity alongside boxes
 * (Spec G D4). Neither height that meets `insertBox` may feed it: a box's
 * `createdAtBlock` is creator-declared, so a backdated box would backdate its
 * owner's clock, and the `created_at_block` column is uncommitted
 * (NODE_INTERFACE → Populating the record). So the clock lives in committed
 * state:
 *
 *   stale       = (height − lastActivityBlock) >= staleThresholdBlocks
 *   owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
 *
 * `>=`, not `>`: an identity last active at `A` is stale iff
 * `A <= height − threshold`, i.e. `height − A >= threshold`. A `>` is off by
 * one; `decay.ts` carries the full argument.
 *
 * **Who populates this.** `recordKarmaActivity` bumps `lastActivityBlock`
 * from the open journal's height when block application applies a user
 * transaction whose inputs are karma boxes; `commitDecayClocks` bumps
 * `lastDecayBlock` when decay fires; and `ensureSystemKarmaBox` writes
 * genesis's own record, since it runs outside block application where the
 * choke point has no height to read.
 *
 * **Key type is `UserId`** — the raw 32 Ed25519 public-key bytes, and there is
 * deliberately no separate identity type. Box `owner`/`likerId`/`inviterId`/
 * `voucherId` are the same pubkey and all `UserId`, so key rotation would have
 * to move box ownership too: the two move together or not at all, and branding
 * two semantically identical things buys no safety while costing a cast at
 * every boundary.
 *
 * The SQL table keys on those raw bytes; the **AVL** key is derived from them
 * (see `identityRecordKey`). Both are total functions of the identity, so the
 * two representations cannot drift.
 */
export interface IdentityRecord {
  /** u32 — bumped when a non-decay karma box is created for the owner. */
  lastActivityBlock: number;
  /** u32 — bumped when decay fires. */
  lastDecayBlock: number;
  /**
   * u32 — the height an invite claim applied for this identity. `0` = never
   * invited.
   *
   * **The probation clock, and only that.** The paired bond settles at
   * `invitedAtBlock + INVITE_PROBATION_BLOCKS`, which is the whole of what this
   * field decides — a bond therefore carries no probation fields of its own
   * (NODE_INTERFACE → Identity Records). It is **not** the invite bar: an invite
   * may only name a key that is not already an account, and *that* test is the
   * existence of this record, not the value of this field.
   *
   * `0` stays reachable and stays meaningful — every identity that received
   * karma without being invited carries it, the genesis committee and the
   * faucet identity included — so the settlement sweep must exclude it rather than
   * treat it as an ordinary height.
   *
   * Written ONLY by block application when a claim applies. Every other writer
   * of this record carries the stored value through unchanged.
   */
  invitedAtBlock: number;
  /**
   * Likes this identity has received over its whole life — the bond settlement's
   * only input, `min(floor(n / INVITE_BOND_VEST_PER_LIKES), bond.value)`.
   *
   * **Monotonic: incremented by per-block like settlement and decremented by
   * nothing, prune included.** That is the whole reason it is a committed
   * counter rather than a count over `like_records`. Those records die with the
   * post, so a join through them would let a *third party* destroy value: Bob
   * replies in Carol's thread and earns likes, Carol prunes her own thread, and
   * Alice — who bonded for Bob and did nothing at all — loses karma at
   * settlement. Design track §1.4.1 forbids exactly that ("you may destroy your
   * own stake, never someone else's"), which is also why prune returns other
   * authors' post bonds.
   *
   * `bigint` for the same two reasons the counter is: the value is consensus
   * input to bigint arithmetic, and the row boundary (`safeIntegers`) hands back
   * bigint — so no `Number()` coercion can appear in a settlement path. It takes
   * `vlqU64`, which throws outside `[0, 2⁶⁴)` rather than colliding on a
   * sentinel.
   */
  lifetimeLikesReceived: bigint;
  /** u32 — 0 = never a member; else the height the bar was first met — the AGE, never reset. */
  memberSinceBlock: number;
  /** u32 — D(N) at first set, never reset; 0 on a root. */
  memberBar: number;
  /** u32 — live counted vouches naming this identity. */
  memberVouches: number;
  /** Likes received from members; never decremented. */
  memberLikes: bigint;
  /** u32 — bonds this identity has created; never decremented. */
  invitesUsed: number;
}

/**
 * The record's **AVL** key: `blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32]`,
 * hex — never the raw `identityId`.
 *
 * Records and boxes share one 32-byte AVL keyspace, and an `identityId` is 32
 * *attacker-chosen* bytes (a public key): used raw, someone could grind a
 * keypair whose pubkey equals a live box id and collide the three entity kinds in
 * the tree. Hashing under a domain tag makes that infeasible, and is what makes
 * the two kinds provably disjoint — by domain separation, not by luck.
 */
export function identityRecordKey(identityId: UserId): string {
  return createHash('blake2b512')
    .update(IDENTITY_KEY_DOMAIN)
    .update(identityId)
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

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
 * writing and records the mutation — the record-once choke point that keeps
 * the AVL feed and the rollback inverse derived from one log.
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

export interface NetworkRecord {
  memberCount: number;
}

/**
 * The network record's AVL key: `blake2b512(NETWORK_KEY_DOMAIN)[0:32]`, hex.
 * The tag alone is the preimage — the identity key's hashing rule with nothing
 * after the tag. Three entity kinds, three disjoint domain tags.
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
