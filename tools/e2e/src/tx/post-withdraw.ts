import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildPostWithdrawTx(
  author: Identity,
  boxes: BoxRef[],
  postId: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const totalValue = boxes.reduce((sum, b) => sum + b.value, 0n);
  const owner = Buffer.from(author.publicKeyHex, 'hex');

  const tx: UtxoTransaction = {
    inputs: boxes.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: totalValue, createdAtBlock: height, owner },
    ],
    signatures: {},
    protocolVersion,
    postWithdraw: {
      postId,
    },
  };

  return signAndRender(author, tx);
}
