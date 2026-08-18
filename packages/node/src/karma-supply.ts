import type { AnyBox } from '@dagsocial/types';

/**
 * The box types whose value counts as karma that exists — what `getTotalKarma`
 * sums. Karma is spendable in a `karma` box and escrowed in the other three, and
 * escrowed karma is held rather than destroyed. `credit`, `emission`, `treasury`
 * and `fee` are the other ledger, and `genesis_proof` holds 0.
 *
 * ⚠ **`like_accrual` and `vouch_escrow` are IN, and each was added on its own
 * evidence.** A marker holds the liker's karma between the like transaction and
 * the block's settlement, and a carry box holds an author's remainder across
 * blocks; an escrow holds a voucher's stake for the length of its cooldown.
 * ⛔ **All three are karma a holder is waiting on rather than karma that stopped
 * existing** (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox), which is the
 * same standing `bond`, `post_lock` and `vouch` already have here.
 *
 * ⚠ **`like_accrual` answers the three questions differently and is the second
 * type to do so.** Transition **yes** — the like transaction is a karma spend
 * that creates one. Supply **yes**. Conservation **yes**. `vouch_escrow` is
 * transition **no**: it is created by spending a `VouchBox`, never a karma box.
 *
 * ⛔ **`karma_pool` is karma-bearing and is still not summed**, and it is out
 * for neither of those reasons: the pool holds the karma that is NOT in
 * circulation (TYPES_INTERFACE → KarmaPoolBox), so `pool + circulating` is the
 * invariant — **a constant**. Summing the pool here would make `getTotalKarma`
 * return that constant at every height on every network, which is to say it
 * would stop reporting anything. It is out of the transition set too, which is
 * what makes the allow-list load-bearing rather than a spelling of "everything
 * but the other ledger".
 *
 * ⛔ **Not the set the engine's karma transition arm admits as outputs** — that
 * is `KARMA_TRANSITION_TYPES` in `services/utxo-engine.ts`, and no set is
 * defined as, spread from or derived from another (NODE_INTERFACE → "Three
 * karma sets, and none derives from another"). That one answers whether a karma
 * spend may create the type, this one whether the type's value is karma in
 * existence, the conservation set whether it belongs to the total that never
 * changes. A karma-bearing type is added to each separately.
 *
 * ⛔ **`karma_pool` is the type whose three answers DIFFER — transition no,
 * supply no, conservation yes — and it is why a third set exists.** So this list
 * is not the conservation set with the pool struck out; the conservation total
 * is `circulating + pool`, a different sum from `getTotalKarma`, and using this
 * one to check the axiom measures the wrong thing (ARCHITECTURE → The
 * conservation axiom).
 *
 * ⛔ **It lives here rather than beside either reader, because it has two and
 * they sit at opposite ends of the package.** `routes/blocks.ts` re-exports it
 * for `GET /status`; `store/utxo.ts` reads it at the box mutation choke point to
 * account the karma supply pool. A store that imported it from a route would
 * invert the layering, and a second copy at the store would be exactly the drift
 * the two-set rule exists to prevent — the store asks the **supply** question,
 * not the transition one.
 */
export const KARMA_SUPPLY_TYPES = [
  'karma',
  'bond',
  'post_lock',
  'vouch',
  'like_accrual',
  'vouch_escrow',
] as const;

/**
 * Does a box of this type hold karma that is in circulation?
 *
 * The predicate form of `KARMA_SUPPLY_TYPES`, for the callers that hold one box
 * rather than build a SQL `IN` list. Reads the same array, so the two cannot
 * disagree about a type.
 */
export function countsAsCirculatingKarma(boxType: AnyBox['boxType']): boolean {
  return (KARMA_SUPPLY_TYPES as readonly string[]).includes(boxType);
}
