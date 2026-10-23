// Every acceptance the rule has answered, kept so the next arrival of its
// triple answers again without the arithmetic. The module holds the one
// memo the process shares across admission, net's Stage 1 and every block
// context, and exposes the factory a case builds its own under
// (NODE_INTERFACE → The signature memo).

import * as validation from '@dagsocial/validation';
import type { UtxoTransaction } from '@dagsocial/types';
import type { NetValidators } from '@dagsocial/net';
import type { SignatureChecks } from '@dagsocial/consensus';
import { countedVerifyOrderingBlockPoW } from '../metrics.js';

/**
 * The number of accepted signature triples the memo holds — ten full blocks'
 * signatures rounded up to 2^16, 171 B an entry (CONSTANTS → node;
 * NODE_INTERFACE → "Bounded, and a miss is a check, never another verdict").
 */
export const SIGNATURE_MEMO_ENTRIES = 65_536;

/**
 * The pair of signature checks the node hands admission, net's Stage 1 and
 * every block context — each answering what `validation`'s rule does
 * (NODE_INTERFACE → The signature memo). The capacity is a required argument.
 */
export function createSignatureMemo(
  capacity: number,
): SignatureChecks & { readonly capacity: number } {
  const verify: SignatureChecks['verify'] = (signature, message, publicKey) =>
    validation.verifyEd25519(signature, message, publicKey);
  const verifyBatch: SignatureChecks['verifyBatch'] = (entries) =>
    validation.verifyEd25519Batch(entries);
  return { capacity, verify, verifyBatch };
}

/** The process's one signature memo (NODE_INTERFACE → The signature memo). */
export const signatureMemo = createSignatureMemo(SIGNATURE_MEMO_ENTRIES);

/**
 * The validators `index.ts` hands `NetNode` — net's Stage 1 reads
 * `verifyTxSignatures` through the memo's batch
 * (NET_INTERFACE → Stage 1 → "A transaction's signatures are checked at
 * Stage 1").
 */
export function netValidators(): NetValidators {
  return {
    ...validation,
    verifyOrderingBlockPoW: countedVerifyOrderingBlockPoW,
    verifyTxSignatures: (tx: UtxoTransaction) =>
      validation.verifyTxSignatures(tx, signatureMemo.verifyBatch),
  };
}
