import { createHash } from 'node:crypto';
import { IDENTITY_KEY_DOMAIN } from '@dagsocial/types';
import { getDb } from './db.js';
import { isBlockJournalOpen, recordIdentityRecordPut } from './journal.js';
import type { UserId } from '@dagsocial/types';

/**
 * The per-identity decay clock — the second committed entity alongside boxes
 * (Spec G D4). Once boxes carry no height, `decay.ts` has nothing to read from
 * them, and consensus may not read an uncommitted store column, so the clock
 * lives in committed state:
 *
 *   stale       = (height − lastActivityBlock) >= staleThresholdBlocks
 *   owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
 *
 * `>=`, not `>`: an identity last active at `A` is stale iff
 * `A <= height − threshold`, i.e. `height − A >= threshold`. A `>` is off by
 * one; `decay.ts` carries the full argument.
 *
 * **Who populates this.** `insertBox` bumps `lastActivityBlock` from the
 * open journal's height for every karma box with `nonActivity !== true`;
 * `commitDecayClocks` bumps `lastDecayBlock` when decay fires; and
 * `ensureSystemKarmaBox` writes genesis's own record, since it runs outside
 * block application where the choke point has no height to read.
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
}

/**
 * The record's **AVL** key: `blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32]`,
 * hex — never the raw `identityId`.
 *
 * Records and boxes share one 32-byte AVL keyspace, and an `identityId` is 32
 * *attacker-chosen* bytes (a public key): used raw, someone could grind a
 * keypair whose pubkey equals a live box id and collide the two entity kinds in
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
              lifetime_likes_received
       FROM identity_records WHERE identity_id = ?`,
    )
    .safeIntegers()
    .get(Buffer.from(identityId)) as
      {
        last_activity_block: bigint; last_decay_block: bigint;
        invited_at_block: bigint;
        lifetime_likes_received: bigint;
      }
      | undefined;
  if (!row) return null;
  return {
    lastActivityBlock: Number(row.last_activity_block),
    lastDecayBlock: Number(row.last_decay_block),
    invitedAtBlock: Number(row.invited_at_block),
    lifetimeLikesReceived: row.lifetime_likes_received,
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
              invited_at_block, lifetime_likes_received
       FROM identity_records ORDER BY identity_id`,
    )
    .safeIntegers()
    .all() as Array<{
      identity_id: Buffer;
      last_activity_block: bigint;
      last_decay_block: bigint;
      invited_at_block: bigint;
      lifetime_likes_received: bigint;
    }>;
  return rows.map((row) => ({
    identityId: new Uint8Array(row.identity_id),
    record: {
      lastActivityBlock: Number(row.last_activity_block),
      lastDecayBlock: Number(row.last_decay_block),
      invitedAtBlock: Number(row.invited_at_block),
      lifetimeLikesReceived: row.lifetime_likes_received,
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
          invited_at_block, lifetime_likes_received)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      Buffer.from(identityId),
      record.lastActivityBlock,
      record.lastDecayBlock,
      record.invitedAtBlock,
      record.lifetimeLikesReceived,
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
