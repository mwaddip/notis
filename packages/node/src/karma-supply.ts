import type { AnyBox } from '@dagsocial/types';

/**
 * The karma supply verdict table — one row per box type, answering whether that
 * type's value counts as karma in circulation. `getTotalKarma` sums the true
 * rows, `GET /status` builds an `IN` list from them, and `countsAsCirculatingKarma`
 * reads the table directly.
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
 * `KARMA_TRANSITION_TYPES` in `services/utxo-engine.ts`, and no set is defined
 * as, spread from or derived from another (NODE_INTERFACE → Three karma sets,
 * and none derives from another).
 *
 * It lives here rather than beside either reader, because it has two and they
 * sit at opposite ends of the package. `routes/blocks.ts` re-exports it for
 * `GET /status`; `store/utxo.ts` reads it at the box mutation choke point.
 */
const KARMA_SUPPLY_VERDICT: Record<AnyBox['boxType'], boolean> = {
  karma: true,
  bond: true,
  post_lock: true,
  vouch: true,
  like_accrual: true,
  vouch_escrow: true,
  credit: false,
  emission: false,
  treasury: false,
  fee: false,
  genesis_proof: false,
  karma_pool: false,
};

/**
 * The box types whose value counts as karma in circulation — derived from
 * `KARMA_SUPPLY_VERDICT`'s true rows, in declaration order.
 */
export const KARMA_SUPPLY_TYPES: ReadonlyArray<AnyBox['boxType']> = Object.freeze(
  (Object.keys(KARMA_SUPPLY_VERDICT) as AnyBox['boxType'][])
    .filter((k) => KARMA_SUPPLY_VERDICT[k]),
);

/**
 * Does a box of this type hold karma that is in circulation?
 *
 * Reads the verdict table directly rather than the derived array, so the two
 * cannot disagree about a type.
 */
export function countsAsCirculatingKarma(boxType: AnyBox['boxType']): boolean {
  return KARMA_SUPPLY_VERDICT[boxType] === true;
}
