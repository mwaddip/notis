import { sign, createPrivateKey } from 'crypto';
import { computeTxId, computeCandidateBoxId } from '@dagsocial/types';
import type { UtxoTransaction, AnyBoxCandidate } from '@dagsocial/types';
import type { Identity } from '../identities.js';

export interface BoxRef {
  readonly boxId: string;
  readonly value: bigint;
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

function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  const result: Record<string, unknown> = {
    inputs: tx.inputs,
    outputs: tx.outputs.map(boxToJson),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
    ),
    protocolVersion: tx.protocolVersion,
  };
  if (tx.likeTarget !== undefined) {
    result['likeTarget'] = tx.likeTarget;
  }
  if (tx.post !== undefined) {
    result['post'] = {
      content: tx.post.content,
      author: Buffer.from(tx.post.author).toString('hex'),
      parentRefs: tx.post.parentRefs,
      protocolVersion: tx.post.protocolVersion,
      type: tx.post.type,
    };
  }
  return result;
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
