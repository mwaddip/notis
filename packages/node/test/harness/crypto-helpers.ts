// packages/node/test/harness/crypto-helpers.ts
import { createHash, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  computeTxId,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
} from '@dagsocial/types';
import type { Post, UtxoTransaction } from '@dagsocial/types';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'));

export function blake32(d: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('blake2b512').update(d).digest().subarray(0, 32));
}

/**
 * The Post shape the canonical encoders read. `powNonce` and `signature` are
 * excluded from both the PoW preimage and the signing hash, so the placeholders
 * here never reach the bytes.
 */
function preimagePost(
  content: string, author: Uint8Array, parents: string[],
  chal: Uint8Array, ts: number,
): Post {
  return {
    content,
    author,
    parentRefs: parents,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: ts,
  };
}

// Reserved, never to be reused: `powInput`, `solve`, `signPost`. There is no
// post PoW and no post signature — a post is the payload of the transaction that
// locks its karma, and `signTx` below is the only signing the harness does.

export function signTx(tx: UtxoTransaction, userKey: KeyObject, pubHex: string): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), userKey);
  tx.signatures[pubHex] = new Uint8Array(sig);
}

export function txToApi(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map(o => {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        obj[k] = v instanceof Uint8Array ? hex(v)
          : typeof v === 'bigint' ? v.toString()
          : v;
      }
      return obj;
    }),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, hex(v as Uint8Array)]),
    ),
    preimages: tx.preimages
      ? Object.fromEntries(
          Object.entries(tx.preimages).map(([k, v]) => [k, hex(v as Uint8Array)]),
        )
      : undefined,
    protocolVersion: tx.protocolVersion,
    // Present ⟺ the tx is a like — the JSON edge must not drop it, since it
    // sits inside the signed bytes.
    ...(tx.likeTarget !== undefined ? { likeTarget: tx.likeTarget } : {}),
  };
}

/**
 * Post-lock tx — karma(total) → karma(total − lock) + PostLockBox(lock).
 *
 * There is deliberately no generic "spend N karma" builder: a user tx that
 * shrinks a karma box without producing a box for the difference destroys
 * value and the node rejects it. Karma is only burned by block-application
 * paths (decay, bond burn), never inside a user tx.
 */
/**
 * The post transaction: karma in, karma change + `PostLockBox` out, and the post
 * payload riding inside. The lock names no post — a post's id comes from this
 * very transaction (TYPES_INTERFACE → PostLockBox).
 */
export function postLockTx(
  boxes: { boxId: string; value: string }[],
  lockAmount: bigint,
  post: Post,
  author: Uint8Array,
): UtxoTransaction {
  // API box values arrive as decimal strings (bigint on the wire).
  const t = boxes.reduce((s, b) => s + BigInt(b.value), 0n);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [
      {
        boxType: 'karma', value: t - lockAmount, 
        owner: author, guard: 'owner_signature',
      },
      {
        boxType: 'post_lock', value: lockAmount, originalValue: lockAmount,
        owner: author, guard: 'block_apply',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
}

/**
 * Like tx, the burn shape — karma(total) → karma(total − LIKE_KARMA_COST),
 * `likeTarget` naming the post inside the signed bytes. The deficit IS the
 * like; a like is a transaction, never a box, and unlike is not a feature.
 */
export function likeTx(
  boxes: { boxId: string; value: string }[],
  targetPostId: string,
  liker: Uint8Array,
): UtxoTransaction {
  const t = boxes.reduce((s, b) => s + BigInt(b.value), 0n);
  return {
    inputs: boxes.map(b => b.boxId),
    outputs: [
      {
        boxType: 'karma', value: t - LIKE_KARMA_COST,
        owner: liker, guard: 'owner_signature',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: targetPostId,
  };
}
