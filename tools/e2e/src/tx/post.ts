import {
  selectBoxes,
  computeContentHash,
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
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
  protocolVersion: number,
  postProtocolVersion: number = protocolVersion,
): PostTx {
  return buildPostTx(author, boxes, content, [], POST_PRICE_THREAD, height, protocolVersion, postProtocolVersion);
}

export function buildReplyTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  parentPostId: string,
  parentAuthorHex: string,
  height: number,
  protocolVersion: number,
  postProtocolVersion: number = protocolVersion,
): PostTx {
  return buildPostTx(author, boxes, content, [parentPostId], POST_PRICE_REPLY, height, protocolVersion, postProtocolVersion, parentAuthorHex);
}

function buildPostTx(
  author: Identity,
  boxes: BoxRef[],
  content: string,
  parentRefs: string[],
  price: bigint,
  height: number,
  protocolVersion: number,
  commitVersion: number,
  parentAuthorHex?: string,
): PostTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, price);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - price;

  const owner = Buffer.from(author.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'karma', value: changeValue, createdAtBlock: height, owner });
  }

  if (parentAuthorHex) {
    // ARCHITECTURE → The post price
    outputs.push({
      boxType: 'karma_price',
      value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE,
      createdAtBlock: height,
    });
    outputs.push({
      boxType: 'like_accrual',
      value: REPLY_AUTHOR_SHARE,
      createdAtBlock: height,
      author: Buffer.from(parentAuthorHex, 'hex'),
    });
  } else {
    outputs.push({
      boxType: 'karma_price',
      value: POST_PRICE_THREAD,
      createdAtBlock: height,
    });
  }

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion,
    post: {
      contentHash: computeContentHash(content),
      author: owner,
      parentRefs,
      protocolVersion: commitVersion,
      type: 'regular',
    },
  };

  return { ...signAndRender(author, tx), content };
}
