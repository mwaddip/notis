/**
 * The karma transfer primitive — the one operation that ends a karma-bearing
 * box's life and begins another's (ARCHITECTURE → The conservation axiom).
 *
 * ⛔ **IT NAMES A SOURCE AND A DESTINATION IN ONE CALL, AND THAT IS THE WHOLE
 * POINT.** The axiom's complaint is against the *function*, not the arithmetic:
 * a primitive that takes an amount and no source cannot fail, because there is
 * nothing for it to check against. This one takes the boxes the value comes out
 * of, so `Σspend` is a fact rather than a parameter and every call is a checked
 * transfer.
 *
 * ⛔ **THE REMAINDER'S VALUE IS COMPUTED HERE, NEVER PASSED IN.** A caller that
 * stated it would be restating `Σspend − Σcredit`, and an assertion against a
 * number the caller derived from the same two figures is a tautology that
 * catches nothing. The caller supplies the remainder's *shape*; this module
 * supplies its value.
 *
 * ⛔ **BOTH DIRECTIONS FAIL CLOSED.** Crediting more than the source holds is
 * creation; leaving a surplus with no remainder to hold it is destruction. The
 * axiom forbids both, so both throw rather than being clamped — inside block
 * application the apply funnel's totality catch turns the throw into a rejected
 * block (NODE_INTERFACE → "What the funnel's totality catch is FOR").
 *
 * ⚠ **A PATH THAT NEEDS THE POOL IS NOT A PATH THIS PRIMITIVE SERVES.** The
 * karma pool box is spent by the block's settlement transaction and by nothing
 * else (NODE_INTERFACE → The settlement transaction), so a transfer whose
 * surplus belongs to the pool — decay, a bond forfeit, a pruner's own lock, the
 * like remainder — is derived and emitted there. What is left here is the set of
 * paths that conserve inside themselves.
 */

import { computeBoxId } from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, PostId } from '@dagsocial/types';
import { getKarmaBoxes, insertBox, consumeBox } from '../store/index.js';
import { MINT_OUTPUT_INDEX, mintTxIdFor } from '../mint-provenance.js';
import type { MintContext } from '../mint-provenance.js';

/** Karma landing on one owner, consolidated with whatever they already hold. */
export interface KarmaCredit {
  owner: Uint8Array;
  amount: bigint;
  /** Why — the half of the box's synthetic transaction id this module cannot know. */
  ctx: MintContext;
}

/**
 * What holds the part of the source this transfer does not move.
 *
 * `shape` is called with the value this module computed, so the caller decides
 * the box's *type and fields* and never its amount.
 */
export interface KarmaRemainder {
  shape: (value: bigint) => AnyBoxCandidate;
  ctx: MintContext;
  /** `insertBox` derivation route 2, for a `post_lock` remainder. */
  postLockTarget?: PostId;
}

/**
 * A transfer that would create or destroy karma.
 *
 * ⚠ **Deliberately a plain `Error`, not a `CorruptChainStateError`.** A
 * mis-derived transfer costs the block, never the node — the same standing
 * `BoxNotLiveError` has.
 */
export class KarmaNotConservedError extends Error {
  constructor(readonly spent: bigint, readonly credited: bigint) {
    super(
      `transferKarma: source holds ${spent}, credits total ${credited} — ` +
      `a transfer neither creates nor destroys karma`,
    );
    this.name = 'KarmaNotConservedError';
  }
}

/**
 * Move the value of `spend` into `credit`, with any surplus held by `remainder`.
 *
 * Every box in `spend` is consumed. Each credit consumes the owner's existing
 * karma boxes and inserts one holding `existingTotal + amount`, so an identity
 * still holds at most one unspent karma box afterwards — the consolidation the
 * ledger has always had, now attached to a source.
 *
 * ⚠ **The consolidated boxes are NOT part of the conservation sum**, and must
 * not be: they are the destination's own karma, standing still. Only `spend`
 * moves.
 *
 * Returns the ids of the karma boxes it created, in `credit` order.
 */
export function transferKarma(
  spend: AnyBox[],
  credit: KarmaCredit[],
  remainder: KarmaRemainder | null,
  blockHeight: number,
): string[] {
  const spent = spend.reduce((sum, b) => sum + b.value, 0n);
  const credited = credit.reduce((sum, c) => sum + c.amount, 0n);
  // Creation, and destruction with nowhere named to hold the surplus. Checked
  // before anything mutates, so a refused transfer has moved nothing.
  if (credited > spent) throw new KarmaNotConservedError(spent, credited);
  const left = spent - credited;
  if (left > 0n && remainder === null) throw new KarmaNotConservedError(spent, credited);

  for (const box of spend) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  const created: string[] = [];
  for (const c of credit) {
    // A zero credit creates no box: `[]` and `[{value: 0}]` are two encodings
    // of one state, and an owner who receives nothing has received nothing.
    if (c.amount <= 0n) {
      created.push('');
      continue;
    }
    const existing = getKarmaBoxes(c.owner);
    const consolidated = existing.reduce((sum, b) => sum + b.value, 0n) + c.amount;
    for (const box of existing) {
      if (box.id) consumeBox(box.id, blockHeight);
    }
    // Field order is free — the committed encodings are positional, so a
    // producer cannot disagree with `rowToBox` about it. The consolidation reads
    // nothing off `existing` but their values, so the order `getKarmaBoxes`
    // returns them in cannot reach the new box's id.
    const box: KarmaBox = {
      boxType: 'karma',
      value: consolidated,
      owner: c.owner,
      txId: mintTxIdFor(c.ctx, blockHeight),
      index: MINT_OUTPUT_INDEX,
    };
    // After provenance is set, never before: `computeBoxId` binds `txId`/`index`,
    // so deriving the id from a box that lacks them produces an id nothing can
    // reproduce.
    box.id = computeBoxId(box);
    insertBox(box);
    created.push(box.id);
  }

  if (remainder !== null && left > 0n) {
    const box = { ...remainder.shape(left) } as AnyBox;
    box.txId = mintTxIdFor(remainder.ctx, blockHeight);
    box.index = MINT_OUTPUT_INDEX;
    box.id = computeBoxId(box);
    insertBox(box, remainder.postLockTarget);
  }

  return created;
}
