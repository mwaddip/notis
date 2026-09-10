import { selectBoxes } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildClaimTx(
  claimant: Identity,
  boxes: BoxRef[],
  name: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, 1n);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);

  const owner = Buffer.from(claimant.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [
    { boxType: 'karma', value: selectedTotal, createdAtBlock: height, owner },
    { boxType: 'username', value: 0n, createdAtBlock: height, owner, name: Buffer.from(name) },
  ];

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion,
  };

  return signAndRender(claimant, tx);
}
