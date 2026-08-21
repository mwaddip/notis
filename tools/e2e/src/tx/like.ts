import { selectBoxes, PROTOCOL_VERSION, LIKE_KARMA_COST } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildLikeTx(
  liker: Identity,
  boxes: BoxRef[],
  postId: string,
  postAuthorHex: string,
  height: number,
): BuiltTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, LIKE_KARMA_COST);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - LIKE_KARMA_COST;

  const owner = Buffer.from(liker.publicKeyHex, 'hex');
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: changeValue, createdAtBlock: height, owner },
      {
        boxType: 'like_accrual',
        value: LIKE_KARMA_COST,
        createdAtBlock: height,
        author: Buffer.from(postAuthorHex, 'hex'),
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };

  return signAndRender(liker, tx);
}
