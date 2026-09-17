import type { UtxoTransaction, AnyBoxCandidate } from '@dagsocial/types';
import { toHex } from '../identity/envelope';
import type { SignSummary, CreditSend } from './protocol';

// The classification and summary the prompt uses. Pure functions, so they can
// be tested against the wallet's own builders (WEB_INTERFACE → "The summary the
// prompt shows is derived from the transaction"). The background derives the
// summary from the decoded transaction, not from any hint the page supplied — a
// name on the summary is never taken from what the page said about them.

/** The ledger the transaction moves — WEB_INTERFACE → "The policy". Any output
 *  with `boxType` `credit` or `fee` names the credits side; otherwise the
 *  transaction is karma-side. Inputs are ids only, so the classification is
 *  output-side by necessity, and it is sufficient (value conserves per ledger;
 *  the node refuses a `fee` on a karma-side transaction). */
export type Ledger = 'karma' | 'credits';

export function classifyLedger(tx: UtxoTransaction): Ledger {
  for (const out of tx.outputs) {
    if (out.boxType === 'credit' || out.boxType === 'fee') return 'credits';
  }
  return 'karma';
}

/** The summary the prompt shows, derived from the transaction alone. `signerHex`
 *  is the signer's public key — output boxes to that key are change and are
 *  never listed as spent (WEB_INTERFACE → "The summary the prompt shows is
 *  derived from the transaction"). An unrecognised karma-side shape — a bare
 *  consolidation of karma, legal on the ledger but not something the client
 *  builds — reads as `other`; a throw here would reject the background's
 *  message-handling promise and the page would never resolve. */
export function summarise(tx: UtxoTransaction, signerHex: string): SignSummary {
  const ledger = classifyLedger(tx);
  if (ledger === 'credits') return credits(tx, signerHex);

  // Karma-side kinds branch on the transaction's shape, in the order the
  // contract lists them (WEB_INTERFACE → "The summary the prompt shows is
  // derived from the transaction").
  if (tx.post) {
    const kind: 'thread' | 'reply' = tx.post.parentRefs.length > 0 ? 'reply' : 'thread';
    return { kind, spendRep: sumKarmaSideSpend(tx) };
  }
  if (tx.likeTarget) {
    return { kind: 'like', targetHex: tx.likeTarget, spendRep: sumKarmaSideSpend(tx) };
  }
  if (tx.postWithdraw) {
    return { kind: 'withdraw', postId: tx.postWithdraw.postId };
  }
  // Vouch, unvouch, invite, claim, burn — from the outputs' `boxType`s.
  const vouchOut = firstOut(tx, 'vouch');
  if (vouchOut) return { kind: 'vouch', targetHex: toHex(vouchOut.targetId), spendRep: valueOf(vouchOut) };
  const escrowOut = firstOut(tx, 'vouch_escrow');
  if (escrowOut && !firstOut(tx, 'vouch')) {
    // The `VouchEscrowBox` carries `owner` — the voucher, where the karma
    // returns — and no target; the input vouch is an id only, so the target
    // is not derivable from the transaction. The prompt says "sign this
    // unvouch?" and nothing more — the reader pressed the row.
    return { kind: 'unvouch' };
  }
  const bondOut = firstOut(tx, 'bond');
  if (bondOut) return { kind: 'invite', inviteeHex: toHex(bondOut.inviteePublicKey), spendRep: valueOf(bondOut) };
  const nameOut = firstOut(tx, 'username');
  if (nameOut) return { kind: 'claim', name: nameToText(nameOut.name) };
  // Burn: a `karma_price` output present with `post` and `likeTarget` absent —
  // the username box it spends is an input (an id only, so the name is not
  // in the transaction) and the burn's price rides the `karma_price` output.
  const priceOut = firstOut(tx, 'karma_price');
  if (priceOut) return { kind: 'burn', spendRep: valueOf(priceOut) };
  // A bare karma consolidation — karma in, karma change out, nothing else — is
  // legal on the ledger and the client never builds one; the prompt reads
  // "sign this rep transaction?".
  return { kind: 'other', spendRep: sumNonChangeKarma(tx, signerHex) };
}

// ---------------------------------------------------------------------------
// Helpers — output-side reads, per the spec's table.
// ---------------------------------------------------------------------------

/** Sum of the `karma_price` and `like_accrual` outputs' values — the karma the
 *  transaction spends on a post or a like (WEB_INTERFACE → "The summary the
 *  prompt shows is derived from the transaction"). A thread has one price
 *  + zero accrual; a reply one price + one accrual (the parent's author's
 *  share); a like one accrual alone. */
function sumKarmaSideSpend(tx: UtxoTransaction): string {
  let total = 0n;
  for (const out of tx.outputs) {
    if (out.boxType === 'karma_price' || out.boxType === 'like_accrual') total += out.value;
  }
  return total.toString();
}

/** Non-change karma outputs' total, for the `other` catch-all — a consolidation
 *  has only change and sums to zero (WEB_INTERFACE → "The summary the prompt
 *  shows is derived from the transaction"). */
function sumNonChangeKarma(tx: UtxoTransaction, signerHex: string): string {
  let total = 0n;
  for (const out of tx.outputs) {
    if (out.boxType !== 'karma') continue;
    if (toHex(out.owner) === signerHex) continue;
    total += out.value;
  }
  return total.toString();
}

function credits(tx: UtxoTransaction, signerHex: string): SignSummary {
  const sends: CreditSend[] = [];
  let feeValue = '0';
  for (const out of tx.outputs) {
    if (out.boxType === 'credit') {
      const ownerHex = toHex(out.owner);
      // Change is any output to the signer's own key — never listed as spent
      // (WEB_INTERFACE → "The summary the prompt shows is derived from the
      // transaction").
      if (ownerHex === signerHex) continue;
      sends.push({ ownerHex, value: out.value.toString() });
    } else if (out.boxType === 'fee') {
      feeValue = out.value.toString();
    }
  }
  return { kind: 'credits', sends, feeValue };
}

type ByType<T extends AnyBoxCandidate['boxType']> = Extract<AnyBoxCandidate, { boxType: T }>;

function firstOut<T extends AnyBoxCandidate['boxType']>(tx: UtxoTransaction, boxType: T): ByType<T> | null {
  for (const out of tx.outputs) if (out.boxType === boxType) return out as ByType<T>;
  return null;
}

function valueOf(box: { value: bigint }): string {
  return box.value.toString();
}

const NAME_DECODER = new TextDecoder('utf-8');

/** The username field is 1–24 UTF-8 bytes of [A-Za-z0-9_] — a strict subset of
 *  ASCII, so `TextDecoder` matches the node's own reading (TYPES_INTERFACE →
 *  UsernameBox). */
function nameToText(bytes: Uint8Array): string {
  return NAME_DECODER.decode(bytes);
}
