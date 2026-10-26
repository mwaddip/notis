/**
 * The JSON form of a transaction — the `tx` of the `{ tx }` body every write
 * route of the node reads (TYPES_INTERFACE → The JSON form of a transaction).
 * Pure, and free of any Node built-in: the browser runs it as written.
 */

import { bytesToHex } from './codec.js';
import type { PostCommit } from './post.js';
import type { AnyBoxCandidate, UtxoTransaction } from './utxo.js';

/**
 * A box candidate as its own fields, converted by the value's type rather than
 * by a field list: a byte field as lowercase hex, a `bigint` as its decimal
 * string, every other value as it is.
 */
function boxToJson(box: AnyBoxCandidate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(box).map(([k, v]) => [
      k,
      v instanceof Uint8Array ? bytesToHex(v) : typeof v === 'bigint' ? v.toString() : v,
    ]),
  );
}

function postToJson(commit: PostCommit): Record<string, unknown> {
  return {
    contentHash: bytesToHex(commit.contentHash),
    author: bytesToHex(commit.author),
    parentRefs: commit.parentRefs,
    protocolVersion: commit.protocolVersion,
    type: commit.type,
  };
}

/**
 * Render a transaction for the node's HTTP edge. `likeTarget`, `post` and
 * `postWithdraw` are carried when the transaction holds them and no key when
 * it does not — each sits inside the signed bytes.
 */
export function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  const body: Record<string, unknown> = {
    inputs: tx.inputs,
    outputs: tx.outputs.map(boxToJson),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, bytesToHex(v)]),
    ),
    protocolVersion: tx.protocolVersion,
  };
  if (tx.likeTarget !== undefined) body.likeTarget = tx.likeTarget;
  if (tx.post !== undefined) body.post = postToJson(tx.post);
  if (tx.postWithdraw !== undefined) body.postWithdraw = { postId: tx.postWithdraw.postId };
  return body;
}
