import { getDb, prepared } from './db.js';
import { KARMA_SUPPLY_TYPES } from '../karma-supply.js';

// ---------------------------------------------------------------------------
// The five aggregates — NODE_INTERFACE → Status
//
// Each karma or credit box carries an owner, so the three sums scan every
// unspent box's entry in `idx_utxo_boxes_owner_type_value` — the type covers
// the predicate and the value. The two post counts read `dag_posts`' own
// partial indexes: the confirmed count's plan on a fresh `initDb(':memory:')`
// is `SCAN dag_posts USING COVERING INDEX idx_dag_posts_confirmed` — the
// partial index on `(block_height, block_index) WHERE status = 'confirmed'`
// is walked whole — and the pending count's is `SEARCH dag_posts USING
// COVERING INDEX idx_dag_posts_pending (status=?)` — the partial index on
// `(status) WHERE status = 'pending'` is probed by its key. The router reads
// `postCount`, `usernameCount`, `totalKarma`, `liquidKarma` and `totalCredits`
// once per applied tip, and `pendingPosts` on each request (NODE_INTERFACE →
// Status → "Every figure but `pendingPosts` is read once per applied tip";
// NODE_INTERFACE → Store Interface → "A read the node runs per request or
// per block touches what it answers").
// ---------------------------------------------------------------------------

/** `postCount` — the count of confirmed posts. */
export function countConfirmedPosts(): number {
  return (
    prepared(getDb(), "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'confirmed'")
      .get() as { c: number }
  ).c;
}

/**
 * `totalKarma` — the sum over every unspent box of the karma supply set
 * (`KARMA_SUPPLY_TYPES`). Karma held in a bond, a vouch escrow or a like
 * accrual is held, not destroyed, so the four escrowed types are summed with
 * `karma` — and only those: the supply set is independent of the transition
 * set the engine's karma arm admits as outputs, and a karma-bearing type is
 * added to each separately (NODE_INTERFACE → "Three karma sets, and none
 * derives from another").
 */
export function getTotalKarma(): bigint {
  const row = prepared(getDb(), `SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes
        WHERE box_type IN (${KARMA_SUPPLY_TYPES.map(() => '?').join(', ')})
          AND spent_at_block IS NULL`, true)
    .get(...KARMA_SUPPLY_TYPES) as { s: bigint };
  return row.s;
}

/**
 * `liquidKarma` — karma its owner can spend now, the sum over every unspent
 * `karma` box. The escrowed four are excluded by construction.
 */
export function getLiquidKarma(): bigint {
  const row = prepared(getDb(), "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'karma' AND spent_at_block IS NULL", true)
    .get() as { s: bigint };
  return row.s;
}

/**
 * `totalCredits` — credits in circulation, the sum over every unspent `credit`
 * box.
 *
 * ⛔ **`emission` and `treasury` are deliberately not summed here.** The
 * emission box holds what has never been released and the treasury holds what
 * is out of circulation with no rule to release it (ARCHITECTURE → Treasury),
 * so counting either would report a supply larger than anyone can hold. Keyed
 * on `credit` by name rather than by excluding them, so a later credit-bearing
 * box type is a deliberate addition here.
 *
 * ⛔ **`fee` is credit-bearing and is still not summed**, because the sum could
 * only ever be zero: block application consumes a fee box in the block that
 * created it (MINING_INTERFACE → Coinbase Application), so no fee box is
 * unspent at any height a caller can observe. Its value reaches this total
 * through the coinbase, as a `credit` box.
 */
export function getTotalCredits(): bigint {
  const row = prepared(getDb(), "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'credit' AND spent_at_block IS NULL", true)
    .get() as { s: bigint };
  return row.s;
}

/** `pendingPosts` — the count of pending posts, read on every request. */
export function countPendingPosts(): number {
  return (
    prepared(getDb(), "SELECT COUNT(*) AS c FROM dag_posts WHERE status = 'pending'")
      .get() as { c: number }
  ).c;
}
