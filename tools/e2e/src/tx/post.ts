import {
  selectBoxes,
  computeContentHash,
  PROTOCOL_VERSION,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export interface PostTx extends BuiltTx {
  readonly content: string;
}

export function buildThreadTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  height: number,
): PostTx {
  return buildPostTx(author, boxes, content, [], POST_LOCK_THREAD_COST, height);
}

export function buildReplyTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  parentPostId: string,
  height: number,
): PostTx {
  return buildPostTx(author, boxes, content, [parentPostId], POST_LOCK_REPLY_COST, height);
}

function buildPostTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  parentRefs: string[],
  lockCost: bigint,
  height: number,
): PostTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, lockCost);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - lockCost;

  const owner = Buffer.from(author.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'karma', value: changeValue, createdAtBlock: height, owner });
  }
  outputs.push({
    boxType: 'post_lock',
    value: lockCost,
    originalValue: lockCost,
    createdAtBlock: height,
    owner,
  });

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: {
      contentHash: computeContentHash(content),
      author: owner,
      parentRefs,
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    },
  };

  return { ...signAndRender(author, tx), content };
}
