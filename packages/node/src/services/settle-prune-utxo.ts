import type { PostId, UserId } from '@dagsocial/types';
import {
  getPostLockBox,
  consumeBox,
  deleteLikeRecordsForPosts,
} from '../store/index.js';
import { mintKarma } from './karma.js';
import { pruneRefundAuthorContext } from '../mint-provenance.js';

/**
 * Deterministic settlement for a pruned subtree.
 *
 * Consumes every PostLockBox in the subtree and mints refund karma to their
 * owners **except `authorId`**, then deletes the subtree's like-records.
 * Destroying your own post costs you its bond; destroying someone else's reply
 * returns theirs (`ARCHITECTURE.md` → "Prune lifecycle"). The pruning author's
 * own locks — the root's and their own replies' downstream — are consumed with
 * no mint, and that consumption **is** the burn: karma supply is the sum of
 * live boxes, so a box that leaves the set without a replacement leaves supply.
 *
 * `PostLockBox.owner` against the entry's `authorId` decides which, from
 * committed state alone — no `block_topology` read, so a node holding no DAG
 * content reaches the same verdict.
 *
 * There is no liker leg: a like burns its karma at cast and the burn is
 * deliberately unrecoverable, so a prune has nothing to refund a liker.
 *
 * Key properties:
 * - Deterministic: given the same postIds, UTXO state, and like-records,
 *   produces the same set of consumed/created boxes and deleted records
 *   every time.
 * - No DAG walk: uses only the postId list (already verified against
 *   block_topology by the caller).
 * - Every mutation — the settlement consumes, the merge-consumes and inserts
 *   inside mintKarma, and the like-record deletions — is recorded by the
 *   store choke point while the caller's block journal is open. A reverted
 *   prune replays `likeRecordDeletions` through `restoreLikeRecord`, so the
 *   subtree's records come back exactly.
 * - The refund set may be empty — a subtree carrying no lock owned by anyone
 *   but the pruner mints nothing at all, and the mint loop runs zero times.
 *
 * The refund mint carries provenance under `prune-refund-author`
 * (`NODE_INTERFACE.md` → "Reason and subject table"). Settlement has **one
 * reason**: every mint here goes to a lock owner, so the author/liker mint-id
 * collision a second reason would have to prevent is not reachable.
 *
 * **The subject still names the prune entry, not the post.** Refunds are
 * aggregated per owner across the whole subtree, so no single postId is
 * available — and the bare owner is not enough either. This function runs
 * **once per prune entry** (`block-apply.ts`, inside the loop over
 * `pruneEntries`), so a block carrying two entries calls it twice at one
 * height; one user whose replies sit in two subtrees pruned at that height
 * would derive the same `mintTxId` twice at `index` 0, trip
 * `UNIQUE(tx_id, output_index)`, and a legitimate block would be rejected.
 * `rootPostHash` is what separates the two calls.
 */
export function settlePruneUtxo(
  rootPostHash: PostId,
  authorId: UserId,
  postIds: PostId[],
  blockHeight: number,
): void {
  const pruner = Buffer.from(authorId).toString('hex');
  const refunds = new Map<string, bigint>();

  for (const postId of postIds) {
    // The consume is unconditional; only the refund reads the owner. The
    // pruner's own lock takes the consume and no map entry — that is the burn.
    const lockBox = getPostLockBox(postId);
    if (lockBox && lockBox.value > 0n) {
      const owner = Buffer.from(lockBox.owner).toString('hex');
      if (owner !== pruner) {
        refunds.set(owner, (refunds.get(owner) ?? 0n) + lockBox.value);
      }
      consumeBox(lockBox.id!, blockHeight);
    }
  }

  // The subtree's like-records die with the prune. The store choke point
  // captures every doomed row as a `likeRecordDeletions` side-record before
  // deleting, so a reverted prune restores them exactly. Runs after the
  // consume loop so the deletion never races a box read within this call.
  deleteLikeRecordsForPosts(postIds);

  // Mint refund karma to the other owners
  for (const [hexOwner, amount] of refunds) {
    const owner = new Uint8Array(Buffer.from(hexOwner, 'hex'));
    mintKarma(owner, amount, blockHeight, pruneRefundAuthorContext(rootPostHash, owner));
  }
}
