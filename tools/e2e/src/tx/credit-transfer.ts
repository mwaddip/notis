import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

// NODE_INTERFACE → Credits
export function buildCreditTransferTx(
  owner: Identity,
  creditBoxes: BoxRef[],
  to: Identity,
  amount: bigint,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const total = creditBoxes.reduce((sum, b) => sum + b.value, 0n);
  const change = total - amount;
  const ownerBuf = Buffer.from(owner.publicKeyHex, 'hex');
  const toBuf = Buffer.from(to.publicKeyHex, 'hex');

  const outputs: UtxoTransaction['outputs'] = [
    { boxType: 'credit', value: amount, owner: toBuf, createdAtBlock: height },
  ];
  if (change > 0n) {
    outputs.push({ boxType: 'credit', value: change, owner: ownerBuf, createdAtBlock: height });
  }

  const tx: UtxoTransaction = {
    inputs: creditBoxes.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion,
  };

  return signAndRender(owner, tx);
}
