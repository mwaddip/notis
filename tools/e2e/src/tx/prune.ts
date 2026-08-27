import { PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildPruneTx(
  author: Identity,
  boxes: BoxRef[],
  rootPostHash: string,
  height: number,
): BuiltTx {
  const totalValue = boxes.reduce((sum, b) => sum + b.value, 0n);
  const owner = Buffer.from(author.publicKeyHex, 'hex');

  const tx: UtxoTransaction = {
    inputs: boxes.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: totalValue, createdAtBlock: height, owner },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    prune: {
      rootPostHash,
    },
  };

  return signAndRender(author, tx);
}
