import type { AnyBox } from '@dagsocial/types';

/**
 * The karma supply verdict table — one row per box type, answering whether that
 * type's value counts as karma in circulation. `getTotalKarma` sums the true
 * rows: `GET /status` builds an `IN` list from them.
 *
 * Karma is spendable in a `karma` box and escrowed in the others marked true —
 * escrowed karma is held rather than destroyed. `credit`, `emission`, `treasury`
 * and `fee` are the other ledger, and `genesis_proof` holds 0.
 *
 * `like_accrual` and `vouch_escrow` are true: a marker holds the liker's karma
 * between the like transaction and the block's settlement, a carry box holds an
 * author's remainder across blocks, and an escrow holds a voucher's stake for
 * the length of its cooldown (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox).
 *
 * `karma_pool` is karma-bearing and is false: the pool holds the karma NOT in
 * circulation (TYPES_INTERFACE → KarmaPoolBox), so `pool + circulating` is the
 * invariant — summing it here would make `getTotalKarma` return a constant at
 * every height on every network.
 *
 * Not the set the engine's karma transition arm admits as outputs — that is
 * `KARMA_TRANSITION_TYPES` in `@dagsocial/consensus`'s `utxo-engine`, and no set is defined
 * as, spread from or derived from another (NODE_INTERFACE → Three karma sets,
 * and none derives from another).
 *
 * `routes/blocks.ts` re-exports `KARMA_SUPPLY_TYPES`, derived below, for `GET /status`.
 */
const KARMA_SUPPLY_VERDICT: Record<AnyBox['boxType'], boolean> = {
  karma: true,
  bond: true,
  vouch: true,
  like_accrual: true,
  vouch_escrow: true,
  credit: false,
  emission: false,
  treasury: false,
  fee: false,
  genesis_proof: false,
  karma_pool: false,
  karma_price: false,
  username: false,
  backer_stake: false,
  backer_unstake: false,
  backer_pool: false,
};

/**
 * The box types whose value counts as karma in circulation — derived from
 * `KARMA_SUPPLY_VERDICT`'s true rows, in declaration order.
 */
export const KARMA_SUPPLY_TYPES: ReadonlyArray<AnyBox['boxType']> = Object.freeze(
  (Object.keys(KARMA_SUPPLY_VERDICT) as AnyBox['boxType'][])
    .filter((k) => KARMA_SUPPLY_VERDICT[k]),
);
