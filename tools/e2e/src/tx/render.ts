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
    result['post'] = convertValue(tx.post);
  }
  if (tx.prune !== undefined) {
    result['prune'] = convertValue(tx.prune);
  }
  return result;
}

function convertValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(convertValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, convertValue(v)]),
    );
  }
  return value;
}

function boxToJson(box: AnyBoxCandidate): Record<string, unknown> {
  return convertValue(box) as Record<string, unknown>;
}
