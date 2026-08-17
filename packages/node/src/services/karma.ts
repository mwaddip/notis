import { computeBoxId } from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import { getKarmaBoxes, insertBox, consumeBox } from '../store/index.js';
import { MINT_OUTPUT_INDEX, mintTxIdFor } from '../mint-provenance.js';
import type { MintContext } from '../mint-provenance.js';

/**
 * Mint (or increase) karma for a given user.
 *
 * Consumes ALL existing unspent karma boxes and creates a single new one
 * with the combined value + amount. This ensures each identity has at most
 * one unspent karma box after any mint operation.
 *
 * Exported so both the local block creator (miner) and the server's
 * block-application path can use it.
 *
 * `ctx` says *why* — the half of the box's synthetic transaction id this
 * function cannot know.
 *
 * Non-nullable is deliberate rather than tidy-up. `tsconfig` covers `src`, so a
 * required parameter is a **compile error at the call site** — exactly where
 * omitting provenance breaks consensus. A `| null` would leave the store as the
 * only line of defence, and since `utxo_boxes.tx_id`/`output_index` are NOT
 * NULL that means a constraint failure at block application: fail-closed, but
 * late, and it reads as a store bug rather than as a missing mint reason.
 * Nothing can legitimately pass `null` either:
 * the contract requires a new mint reason to arrive as a tag *plus* an encoding
 * *plus* an argument that `(height, reason, subject)` cannot repeat, so "no
 * reason" is not a state a correct producer can be in.
 */
export function mintKarma(
  userId: Uint8Array,
  amount: bigint,
  blockHeight: number,
  ctx: MintContext,
): string {
  if (amount <= 0n) return '';

  const existingBoxes = getKarmaBoxes(userId);
  const existingTotal = existingBoxes.reduce((sum, b) => sum + b.value, 0n);
  const newValue = existingTotal + amount;

  // Consume all existing boxes
  for (const box of existingBoxes) {
    if (box.id) consumeBox(box.id, blockHeight);
  }

  // Field order here is free: the committed encodings are positional, so a
  // producer cannot disagree with `rowToBox` about it.
  //
  // The consolidation reads nothing off `existingBoxes` but their values, so the
  // order `getKarmaBoxes` returns them in cannot reach the minted box's id.
  const newBox: KarmaBox = {
    boxType: 'karma',
    value: newValue,
    owner: userId,
    txId: mintTxIdFor(ctx, blockHeight),
    index: MINT_OUTPUT_INDEX,
  };
  // After provenance is set, never before: `computeBoxId` binds `txId`/`index`,
  // so deriving the id from a box that lacks them produces an id nothing can
  // reproduce.
  const boxId = computeBoxId(newBox);
  newBox.id = boxId;

  insertBox(newBox);
  return boxId;
}
