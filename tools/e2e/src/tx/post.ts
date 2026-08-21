import {
  selectBoxes,
  PROTOCOL_VERSION,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildThreadTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  height: number,
): BuiltTx {
  return buildPostTx(author, boxes, content, [], POST_LOCK_THREAD_COST, height);
}

export function buildReplyTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  parentPostId: string,
  height: number,
): BuiltTx {
  return buildPostTx(author, boxes, content, [parentPostId], POST_LOCK_REPLY_COST, height);
}

function buildPostTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  parentRefs: string[],
  lockCost: bigint,
  height: number,
): BuiltTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, lockCost);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - lockCost;

  const owner = Buffer.from(author.publicKeyHex, 'hex');
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: changeValue, createdAtBlock: height, owner },
      {
        boxType: 'post_lock',
        value: lockCost,
        originalValue: lockCost,
        createdAtBlock: height,
        owner,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: {
      content,
      author: owner,
      parentRefs,
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    },
  };

  return signAndRender(author, tx);
}
