import { LIKE_KARMA_COST } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';
import { selectKarmaInputs } from './karma.js';

export function buildLikeTx(
  liker: Identity,
  boxes: BoxRef[],
  postId: string,
  postAuthorHex: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const selected = selectKarmaInputs(boxes, LIKE_KARMA_COST);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - LIKE_KARMA_COST;

  const owner = Buffer.from(liker.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'karma', value: changeValue, createdAtBlock: height, owner });
  }
  outputs.push({
    boxType: 'like_accrual',
    value: LIKE_KARMA_COST,
    createdAtBlock: height,
    author: Buffer.from(postAuthorHex, 'hex'),
  });

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion,
    likeTarget: postId,
  };

  return signAndRender(liker, tx);
}
