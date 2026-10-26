import { sign, createPrivateKey } from 'crypto';
import { computeTxId, computeCandidateBoxId, txToJson } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';

// NODE_INTERFACE → UTXO queries — `income: true` marks the owner's income box
// (TYPES_INTERFACE → KarmaBox); absent on their own box and on every non-karma box.
export interface BoxRef {
  readonly boxId: string;
  readonly value: bigint;
  readonly income?: true;
}

export interface BuiltTx {
  readonly json: Record<string, unknown>;
  readonly txId: string;
  readonly outputs: BoxRef[];
}

export function signAndRender(identity: Identity, tx: UtxoTransaction): BuiltTx {
  const txId = computeTxId(tx);
  const privKey = createPrivateKey({ key: identity.secretKey, format: 'der', type: 'pkcs8' });
  const sig = sign(null, Buffer.from(txId, 'hex'), privKey);
  const signed: UtxoTransaction = { ...tx, signatures: { [identity.publicKeyHex]: sig } };

  const outputs: BoxRef[] = tx.outputs.map((out, i) => ({
    boxId: computeCandidateBoxId(out, txId, i),
    value: out.value,
  }));

  return { txId, json: txToJson(signed), outputs };
}
