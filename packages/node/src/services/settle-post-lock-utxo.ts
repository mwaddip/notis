import type { PostId, UserId, PostLockBox } from '@dagsocial/types';
import { POST_LOCK_UNLOCK_PER_LIKES } from '@dagsocial/types';
import { getPostLockBox } from '../store/index.js';

/**
 * What a pruned subtree owes, as a plan rather than as a mutation.
 *
 * ⛔ **Post-lock settlement moves no karma any more.** The actor's own locks
 * leave circulation, and value leaving circulation goes to the karma supply
 * pool, which the block's settlement transaction is the only spender of
 * (NODE_INTERFACE → The settlement transaction). Consuming the locks here and
 * crediting the pool at §11a would leave that karma nowhere for the length of a
 * block application — `ARCHITECTURE → The conservation axiom`'s *"not even as an
 * intermediary step"* forbids exactly that. So the boxes stay live until the
 * settlement consumes them and names both ends in one operation.
 */
export interface PostLockSettlement {
  /**
   * Every `PostLockBox` in the subtree, in `postIds` order — the settlement's
   * inputs for this entry. Block content fixes the order, so the list is not a
   * fourth ordering source.
   */
  lockBoxIds: string[];
  /** Refunds to lock owners, ascending owner-hex. Includes vest refunds. */
  refunds: Array<{ owner: Uint8Array; amount: bigint }>;
  /** The actor's own locks minus any vest. The sink is the pool. */
  toPool: bigint;
}

/**
 * The vest a `PostLockBox` releases for a given lifetime like count.
 *
 * ⛔ **ONE FUNCTION, TWO CALLERS.** `planPostLockSettlement` calls it for posts
 * being pruned (vest folded into the settlement), and §11b calls
 * it for posts liked this block that are not being settled. Both must use this
 * function — two derivations of one rule is the hazard D11 §4 names.
 */
export function computeVestAmount(
  lockBox: Pick<PostLockBox, 'value' | 'originalValue'>,
  totalLikesAfterBlock: number,
): bigint {
  const alreadyUnlocked = lockBox.originalValue - lockBox.value;
  const shouldUnlock = BigInt(totalLikesAfterBlock) / BigInt(POST_LOCK_UNLOCK_PER_LIKES);
  const unlockable = shouldUnlock - alreadyUnlocked;
  const toUnlock = lockBox.value < unlockable ? lockBox.value : unlockable;
  return toUnlock > 0n ? toUnlock : 0n;
}

/**
 * Deterministic settlement for a pruned subtree.
 *
 * ⛔ **A PURE READ.** It names boxes and amounts and mutates nothing — the
 * subtree's like-record deletions are block application's, at §8c, because this
 * function also runs inside the block creator's template fill, which is not a
 * rolled-back transaction. A planner that deleted records would drop them every
 * time a miner rebuilt a template.
 *
 * Names every PostLockBox in the subtree and the refund each owner is owed.
 * The actor's own locks go to the pool minus any vest; a non-actor owner's
 * locks are refunded in full (vest + remaining are both theirs).
 *
 * `PostLockBox.owner` against the entry's `authorId` decides which, from
 * committed state alone — no `block_topology` read, so a node holding no DAG
 * content reaches the same verdict.
 *
 * There is no liker leg: a like moves its karma into a marker at cast and the
 * settlement pays it to the author, so a prune has nothing to refund a liker.
 *
 * Key properties:
 * - Deterministic: given the same postIds, UTXO state, and like counts, it
 *   names the same boxes, the same refunds and the same pool figure every time.
 * - No DAG walk: uses only the postId list (already verified against
 *   block_topology by the caller).
 * - The refund set may be empty — a subtree carrying no lock owned by anyone
 *   but the actor names no refund at all (and the vest may be zero).
 *
 * ⛔ **`likeCounts` is the lifetime count AS OF AFTER this block's likes
 * apply.** The caller computes it — the creator adds the body's likes to the
 * stored count, the applier's stored count already holds them — and this
 * function never reads `getLikeRecordCount` itself. A plan that did would
 * silently disagree between the two callers.
 *
 * ⛔ **A REFUND CARRIES NO MINT PROVENANCE.** It is an output of the block's
 * settlement transaction, so it takes that transaction's real `(txId, index)`
 * like every other output, and two outputs of one transaction cannot collide on
 * `UNIQUE(tx_id, output_index)`.
 */
export function planPostLockSettlement(
  _rootPostHash: PostId,
  authorId: UserId,
  postIds: PostId[],
  likeCounts: Map<string, number>,
): PostLockSettlement {
  const actor = Buffer.from(authorId).toString('hex');
  const refunds = new Map<string, bigint>();
  const lockBoxIds: string[] = [];
  let toPool = 0n;

  for (const postId of postIds) {
    const lockBox = getPostLockBox(postId);
    if (lockBox && lockBox.value > 0n) {
      const owner = Buffer.from(lockBox.owner).toString('hex');
      const totalLikes = likeCounts.get(postId) ?? 0;
      const vestAmount = computeVestAmount(lockBox, totalLikes);

      if (owner === actor) {
        // The actor's lock: vest goes back to the actor as a refund,
        // remaining lock value goes to the pool. ⚠ **A burn is a
        // destination, so it is named at the site**: `toPool` carries it,
        // where a difference between two figures would carry nothing a
        // search could find (ARCHITECTURE → The conservation axiom).
        if (vestAmount > 0n) {
          refunds.set(owner, (refunds.get(owner) ?? 0n) + vestAmount);
        }
        toPool += lockBox.value - vestAmount;
      } else {
        // A non-actor's lock: the full value is refunded regardless of vest
        // (vest + remaining are both theirs).
        refunds.set(owner, (refunds.get(owner) ?? 0n) + lockBox.value);
      }
      lockBoxIds.push(lockBox.id!);
    }
  }

  return {
    lockBoxIds,
    // Ascending owner-hex, so two nodes emit one entry's refunds in one order.
    // A `Map`'s insertion order is the subtree walk's, which is already fixed by
    // `postIds` — sorted anyway, because relying on that is relying on a
    // property of the caller rather than on one this function states.
    refunds: [...refunds.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([hexOwner, amount]) => ({
        owner: new Uint8Array(Buffer.from(hexOwner, 'hex')),
        amount,
      })),
    toPool,
  };
}
