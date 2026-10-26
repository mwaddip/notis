import { createPrivateKey, sign } from 'crypto';
import { computeCandidateBoxId, computeTxId, isHex64, txToJson } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { FaucetConfig } from './config.js';

/**
 * A box the faucet may spend: the id the node reported, its value, and — on a
 * karma read — the mark that tells the owner's income box from their own box
 * (TYPES_INTERFACE → KarmaBox).
 */
export interface BoxRef {
  readonly boxId: string;
  readonly value: bigint;
  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes"
  readonly income?: true;
}

export interface BuiltTx {
  /** The wire body, ready for `JSON.stringify`. */
  readonly tx: Record<string, unknown>;
  readonly txId: string;
  /**
   * The payment output — the box the transaction grants to the recipient — as
   * the next transaction may spend it, or `null` when the transaction emits
   * none of its own (an invite grants no output; the block's settlement does).
   *
   * ⛔ **Derived from the output that was SIGNED**, never rebuilt from the
   * amount and the owner: rebuilding it would state the transaction twice.
   */
  readonly payment: BoxRef | null;
}

/**
 * Compute the id, sign it, and render the wire body.
 *
 * ⛔ **The id is computed over the TYPED transaction and the body is rendered
 * from the same object**, so the bytes the signature covers and the bytes the
 * node recomputes come from one statement of the transaction. Building the two
 * separately is the drift the positional format exists to close.
 *
 * The signature is raw Ed25519 over the 32 id bytes, keyed by the signer's
 * public-key hex.
 */
export function signAndRender(
  cfg: FaucetConfig,
  tx: UtxoTransaction,
  paymentIndex: number | null = null,
): BuiltTx {
  const txId = computeTxId(tx);
  const privKey = createPrivateKey({ key: cfg.secretKey, format: 'der', type: 'pkcs8' });
  // Signed after the id and outside its preimage: the signature is Ed25519
  // *over* the id, so it cannot be one of the fields the id hashes.
  const sig = sign(null, Buffer.from(txId, 'hex'), privKey);
  const signed: UtxoTransaction = { ...tx, signatures: { [cfg.publicKeyHex]: sig } };

  // `computeCandidateBoxId`, not `computeBoxId`: an output is a candidate and
  // carries no provenance, and this is the derivation block application applies
  // to it (TYPES_INTERFACE → BoxId).
  const payment = refFromIndex(tx, txId, paymentIndex);

  return { txId, payment, tx: txToJson(signed) };
}

function refFromIndex(tx: UtxoTransaction, txId: string, index: number | null): BoxRef | null {
  if (index === null) return null;
  const out = tx.outputs[index];
  if (out === undefined) return null;
  return { boxId: computeCandidateBoxId(out, txId, index), value: out.value };
}

/**
 * The faucet cannot cover a grant out of what it holds.
 *
 * ⚠ **Its own state, not the caller's mistake.** The faucet draws down as it
 * invites and does not replenish, so running dry is where it ends up rather
 * than an edge case — and a request refused for it must not read as a bad
 * request.
 */
export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

/**
 * A refusal of the request itself — a malformed key or the faucet's own key as
 * the recipient — raised at build time and answered 400 (NODE_INTERFACE →
 * Faucet → "Every other answer is the service's own or the node's, never one
 * dressed as the other").
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** The recipient of any faucet transaction: 32 bytes, and never the faucet's own key. */
export function checkRecipient(cfg: FaucetConfig, hex: string, what: string): void {
  if (!isHex64(hex)) {
    throw new BadRequestError(`${what} public key must be 64 lowercase hex characters`);
  }
  if (hex === cfg.publicKeyHex) {
    throw new BadRequestError(`the faucet cannot address itself: ${what} is the faucet's own key`);
  }
}
