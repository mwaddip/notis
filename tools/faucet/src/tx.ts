import { createPrivateKey, sign } from 'crypto';
import { computeCandidateBoxId, computeTxId } from '@dagsocial/types';
import type { AnyBoxCandidate, UtxoTransaction } from '@dagsocial/types';
import type { FaucetConfig } from './config.js';

/** A box the faucet may spend: the id the node reported, and its value. */
export interface BoxRef {
  readonly boxId: string;
  readonly value: bigint;
}

export interface BuiltTx {
  /** The wire body, ready for `JSON.stringify`. */
  readonly tx: Record<string, unknown>;
  readonly txId: string;
  readonly changeValue: bigint;
  /**
   * The change output as the next transaction may spend it, or `null` when the
   * transaction emits none.
   *
   * ⛔ **Derived from the output that was SIGNED**, never rebuilt from the
   * amount and the owner. A second statement of the change box would carry its
   * own id, and a transaction chained onto it would name an input block
   * application never materializes.
   */
  readonly change: BoxRef | null;
}

export const HEX64 = /^[0-9a-f]{64}$/;

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
  changeIndex: number | null,
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
  const changeOut = changeIndex === null ? undefined : tx.outputs[changeIndex];
  const change: BoxRef | null = changeOut === undefined || changeIndex === null
    ? null
    : { boxId: computeCandidateBoxId(changeOut, txId, changeIndex), value: changeOut.value };

  return { txId, changeValue: change?.value ?? 0n, change, tx: txToJson(signed) };
}

/**
 * Render a transaction for the node's JSON edge — the inverse of its `jsonToTx`.
 *
 * ⚠ **`bigint` and `Uint8Array` both have to be converted**: the first throws in
 * `JSON.stringify` and the second serialises as an index-keyed object. Values
 * cross as decimal strings and binary fields as hex, which is what `convertBox`
 * reads back.
 *
 * ⛔ **Fields are converted by their VALUE's type, not by name.** A renderer
 * holding its own list of binary fields is a second copy of the node's, and the
 * two would have to be kept in agreement by hand.
 *
 * ⚠ **Throws on a `likeTarget` or a `post`.** The faucet builds neither, and a
 * field silently dropped here would leave the node recomputing a different id
 * from the one the signature covers.
 */
export function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  if (tx.likeTarget !== undefined || tx.post !== undefined) {
    throw new Error('the faucet builds no likes and no posts, and this renderer carries neither');
  }
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map(boxToJson),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
    ),
    protocolVersion: tx.protocolVersion,
  };
}

function boxToJson(box: AnyBoxCandidate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(box).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? Buffer.from(value).toString('hex')
        : typeof value === 'bigint'
          ? value.toString()
          : value,
    ]),
  );
}

/**
 * The boxes to select from, in the order `selectBoxes` requires.
 *
 * ⚠ **The sort discharges `selectBoxes`' stated precondition** — it documents
 * that its input is pre-sorted by value descending — rather than guarding
 * against a caller. A precondition met two modules away is met by accident.
 */
export function valueDescending(boxes: readonly BoxRef[]): BoxRef[] {
  return [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
}

/** The recipient of any faucet transaction: 32 bytes, and never the faucet's own key. */
export function checkRecipient(cfg: FaucetConfig, hex: string, what: string): void {
  if (!HEX64.test(hex)) {
    throw new Error(`${what} public key must be 64 lowercase hex characters`);
  }
  if (hex === cfg.publicKeyHex) {
    throw new Error(`the faucet cannot address itself: ${what} is the faucet's own key`);
  }
}
