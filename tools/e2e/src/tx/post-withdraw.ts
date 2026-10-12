import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';
import { selectKarmaInputs } from './karma.js';

export function buildPostWithdrawTx(
  author: Identity,
  boxes: BoxRef[],
  postId: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  // A post-withdrawal is a karma self-transfer carrying `postWithdraw`
  // (NODE_INTERFACE → Withdrawal) — no karma leaves the owner, so the helper
  // takes the own box alone when one stands and the income box only when the
  // owner holds no own box (NODE_INTERFACE → Karma transition rules).
  const selected = selectKarmaInputs(boxes, 0n);
  const totalValue = selected.reduce((sum, b) => sum + b.value, 0n);
  const owner = Buffer.from(author.publicKeyHex, 'hex');

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
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
