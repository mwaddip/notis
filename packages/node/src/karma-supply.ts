import type { AnyBox } from '@dagsocial/types';

/**
 * The box types whose value counts as karma that exists — what `getTotalKarma`
 * sums. Karma is spendable in a `karma` box and escrowed in the other four, and
 * escrowed karma is held rather than destroyed. `credit`, `emission`, `treasury`
 * and `fee` are the other ledger, and `genesis_proof` holds 0.
 *
 * ⛔ **`karma_pool` is karma-bearing and is still not summed**, and it is out
 * for neither of those reasons: the pool holds the karma that is NOT in
 * circulation (TYPES_INTERFACE → KarmaPoolBox), so `pool + circulating` is the
 * invariant — **a constant**. Summing the pool here would make `getTotalKarma`
 * return that constant at every height on every network, which is to say it
 * would stop reporting anything. It is the first type belonging to neither karma
 * set, which is what makes the allow-list load-bearing rather than a spelling of
 * "everything but the other ledger".
 *
 * ⛔ **Not the set the engine's karma transition arm admits as outputs** — that
 * is `KARMA_TRANSITION_TYPES` in `services/utxo-engine.ts`, and neither set is
 * defined as, spread from or derived from the other (NODE_INTERFACE → "Two
 * karma sets, and neither derives from the other"). They hold the same members
 * for two different reasons: that one answers whether a karma spend may create
 * the type, this one whether the type's value is karma in existence. A
 * karma-bearing type is added to each separately.
 *
 * ⛔ **It lives here rather than beside either reader, because it has two and
 * they sit at opposite ends of the package.** `routes/blocks.ts` re-exports it
 * for `GET /status`; `store/utxo.ts` reads it at the box mutation choke point to
 * account the karma supply pool. A store that imported it from a route would
 * invert the layering, and a second copy at the store would be exactly the drift
 * the two-set rule exists to prevent — the store asks the **supply** question,
 * not the transition one.
 */
export const KARMA_SUPPLY_TYPES = ['karma', 'invite', 'bond', 'post_lock', 'vouch'] as const;

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
