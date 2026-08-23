/**
 * The coinbase's slices and the inclusion bonus (MINING_INTERFACE → Coinbase
 * Application).
 *
 * Pure arithmetic over bigints and a count — no store, no config, no profile.
 * Both the block creator and the applier call the same functions on the same
 * body, so producer and verifier cannot disagree about what a coinbase should
 * hold. Where the *result* is minted, and whether the treasury's share is
 * minted at all, is the caller's question and depends on the network profile.
 */

import {
  COINBASE_TREASURY_PCT,
  COINBASE_BONUS_PCT,
  INCLUSION_BONUS_K,
} from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';

/** One embedded transaction and the boxes its inputs resolved to. */
export interface EmbeddedTx {
  tx: UtxoTransaction;
  inputBoxes: AnyBox[];
}

/**
 * Whether a transaction sits on the credit ledger — so which pool class it
 * belongs to (MEMPOOL_INTERFACE → Eviction, inside the credit class only).
 *
 * Stateless, and sound without reading a single input: the transition table
 * admits only `credit → credit and/or fee`, so outputs drawn from that pair
 * imply credit inputs (NODE_INTERFACE → Legal box transitions). That is
 * what lets the pool classify an entry at insert without a UTXO lookup.
 *
 * ⛔ **The length test is not defensive.** `[].every(…)` is `true`, and a
 * zero-output transaction is a karma-side unvouch — in the pool it would land
 * in the wrong class and become evictable.
 */
export function isCreditSideTx(tx: UtxoTransaction): boolean {
  const outs = tx.outputs ?? [];
  return outs.length > 0 && outs.every((o) => o.boxType === 'credit' || o.boxType === 'fee');
}

/**
 * The actor of a karma-side transaction, read from the box it spends.
 *
 * ⛔ **Never from `tx.signatures`.** Producing a signature is free, so a
 * signature-keyed count is inflated to any size by appending keys that hold
 * nothing. Every karma-side operation spends a box that names its actor, and
 * what bounds the count is that spending one of those boxes cost karma —
 * an invite bonds at least `inviteBondMin` and a vouch stakes `VOUCH_KARMA_AMOUNT`
 * (NODE_INTERFACE → Bond transition rules, Vouch transition rules).
 *
 * Reading `inputBoxes[0]` alone is sound only after `validateTx`: step 3 pins
 * every input to one `boxType`, karma inputs additionally share one owner, and
 * the vouch arm bounds the transaction to a single input. On an unvalidated
 * body the first input is the producer's choice.
 *
 * ⛔ **The box is the whole input, and the transaction is not consulted.** Every
 * karma-side row of the transition table names its actor in the box it spends
 * (NODE_INTERFACE → Legal box transitions), so no arm needs the output list to
 * tell two shapes apart.
 */
export function actorOf(inputBoxes: AnyBox[]): Uint8Array | null {
  const first = inputBoxes[0];
  if (!first) return null;
  switch (first.boxType) {
    case 'karma':
      return (first as KarmaBox).owner;
    case 'vouch':
      return (first as VouchBox).voucherId;
    default:
      // Credit — the other ledger. It pays a fee instead, and counting it here
      // would pay for one transaction twice.
      return null;
  }
}

/**
 * How many distinct actors the block's karma-side transactions carry.
 *
 * The block's own validator does not count, which generalises the rule that an
 * author may not be the validator: a validator cannot raise their own bonus by
 * including their own work.
 */
export function countKarmaActors(
  embedded: EmbeddedTx[],
  validatorId: Uint8Array,
): number {
  const seen = new Set<string>();
  const self = Buffer.from(validatorId).toString('hex');
  for (const { inputBoxes } of embedded) {
    const actor = actorOf(inputBoxes);
    if (!actor) continue;
    const actorHex = Buffer.from(actor).toString('hex');
    if (actorHex !== self) seen.add(actorHex);
  }
  return seen.size;
}

/**
 * The coinbase's two amounts for a block of this income and this many actors.
 *
 * The treasury is taken **per income term** — of emission and of fees, and of
 * storage rent never — so a third term arriving changes nothing here. The bonus
 * pool is `COINBASE_BONUS_PCT` of the whole income, of which the miner earns
 * `actors / (actors + INCLUSION_BONUS_K)` and the treasury takes the rest.
 *
 * **The miner floor takes every remainder**, which is why it is a subtraction
 * rather than its own percentage: four truncated percentages of one income do
 * not add back to it, while `sum(coinbaseOutputs) === income` is exact at
 * apply. That also routes storage rent's treasury exemption to miners, which is
 * where ARCHITECTURE puts rent.
 *
 * ⚠ **`unearned` is a subtraction from the pool, never its own division.** Two
 * independent truncations of one pool leak a base unit between them; a
 * subtraction cannot.
 *
 * The backer pool has no consumer — nothing stakes and nothing links — so its
 * share falls to the miner floor along with every other remainder.
 */
export function splitCoinbase(
  emission: bigint,
  fees: bigint,
  actors: number,
): { treasury: bigint; miner: bigint } {
  const income = emission + fees;
  const treasuryPct = BigInt(COINBASE_TREASURY_PCT);
  const treasuryBase =
    (emission * treasuryPct) / 100n + (fees * treasuryPct) / 100n;

  const bonusPool = (income * BigInt(COINBASE_BONUS_PCT)) / 100n;
  const a = BigInt(actors);
  const earned = (bonusPool * a) / (a + INCLUSION_BONUS_K);
  const unearned = bonusPool - earned;

  const treasury = treasuryBase + unearned;
  return { treasury, miner: income - treasury };
}
