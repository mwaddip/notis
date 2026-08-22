import { computePostId, decodeTx } from '@dagsocial/types';
import type { OrderingBlock, PostCommit, PostId, TxId } from '@dagsocial/types';

/** One post a block creates, with the transaction identity that names it. */
export interface BlockPost {
  postId: PostId;
  txId: TxId;
  post: PostCommit;
}

/**
 * The posts a block creates, read from the **committed** transaction list.
 *
 * ⛔ **One derivation, used by the forward pass and by every inverse.** The
 * journal's rollback un-confirms exactly what apply confirmed, so both must read
 * the same list; a second derivation is free to disagree (audit H-3).
 *
 * ⛔ **The id comes from the transaction, never from the post.**
 * `computePostId(txId, index)` takes no `Post`, so a block cannot carry a post id
 * that disagrees with the transaction carrying it — there is no claim to check,
 * because there is no claim. A node holding the block body holds the post itself
 * plus the author's signature over the `TxId`, so it can verify authorship rather
 * than record it on trust.
 *
 * ⚠ **`txId` is the block's DECLARED id and callers must have checked it against
 * `computeTxId` first.** On the apply path that check is the embedded-tx loop's
 * byte-for-byte compare. This function is total on a well-formed block and is
 * called where that has already run, or where only the id set matters.
 *
 * `index` is `0` — exactly one post rides one transaction (TYPES_INTERFACE →
 * UtxoTransaction).
 */
export function postsOf(block: OrderingBlock): BlockPost[] {
  const posts: BlockPost[] = [];
  const { utxoTxIds, utxoTxs } = block.utxoTxTree;
  for (let i = 0; i < utxoTxIds.length; i++) {
    const cbor = utxoTxs[i];
    if (!cbor) continue;
    let tx;
    try {
      tx = decodeTx(cbor);
    } catch {
      // A body that does not decode is rejected by the embedded-tx loop with a
      // stated reason. Skipping here keeps this function total so the *journal*
      // paths — which run on blocks already applied — cannot throw.
      continue;
    }
    if (!tx.post) continue;
    const txId = utxoTxIds[i]!;
    posts.push({ postId: computePostId(txId, 0), txId, post: tx.post });
  }
  return posts;
}

/** Just the ids — the shape the journal and mempool cleanup want. */
export function postIdsOf(block: OrderingBlock): PostId[] {
  return postsOf(block).map((p) => p.postId);
}
