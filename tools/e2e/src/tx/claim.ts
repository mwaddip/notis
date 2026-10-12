import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';
import { selectKarmaInputs } from './karma.js';

export function buildClaimTx(
  claimant: Identity,
  boxes: BoxRef[],
  name: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  // A claim is `karma → karma + username(0)`: no karma leaves the owner, so the
  // helper takes the own box alone when one stands and the income box only when
  // the owner holds no own box (NODE_INTERFACE → Karma transition rules).
  const selected = selectKarmaInputs(boxes, 1n);
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
