import type { PostId, UserId } from '@dagsocial/types';
import { getPostLockBox } from '../store/index.js';

/**
 * What a pruned subtree owes, as a plan rather than as a mutation.
 *
 * ⛔ **Prune settlement moves no karma any more.** The pruner's own locks leave
 * circulation, and value leaving circulation goes to the karma supply pool,
 * which the block's settlement transaction is the only spender of
 * (NODE_INTERFACE → The settlement transaction). Consuming the locks here and
 * crediting the pool at §11a would leave that karma nowhere for the length of a
 * block application — `ARCHITECTURE → The conservation axiom`'s *"not even as an
 * intermediary step"* forbids exactly that. So the boxes stay live until the
 * settlement consumes them and names both ends in one operation.
 */
export interface PruneSettlement {
  /**
   * Every `PostLockBox` in the subtree, in `postIds` order — the settlement's
   * inputs for this entry. Block content fixes the order, so the list is not a
   * fourth ordering source.
   */
  lockBoxIds: string[];
  /** Refunds to lock owners other than the pruner, ascending owner-hex. */
  refunds: Array<{ owner: Uint8Array; amount: bigint }>;
  /** The pruner's own locks. The sink is the pool. */
  toPool: bigint;
}

/**
 * Deterministic settlement for a pruned subtree.
 *
 * ⛔ **A PURE READ.** It names boxes and amounts and mutates nothing — the
 * subtree's like-record deletions are block application's, at §5, because this
 * function also runs inside the block creator's template fill, which is not a
 * rolled-back transaction. A planner that deleted records would drop them every
 * time a miner rebuilt a template.
 *
 * Names every PostLockBox in the subtree and the refund each owner is owed
 * **except `authorId`**. Destroying
 * your own post costs you its bond; destroying someone else's reply returns
 * theirs (`ARCHITECTURE.md` → "Prune lifecycle"). ⛔ **The pruning author's own
 * locks — the root's and their own replies' downstream — are the burn, and the
 * burn is a TRANSFER TO THE POOL** (`ARCHITECTURE` → The conservation axiom
 * names it as one of the four). Under the retired shape the burn was the
 * *absence* of a mint, which is why no `mintKarma(` call site marked it and a
 * name-keyed search could not see it at all.
 *
 * `PostLockBox.owner` against the entry's `authorId` decides which, from
 * committed state alone — no `block_topology` read, so a node holding no DAG
 * content reaches the same verdict.
 *
 * There is no liker leg: a like moves its karma into a marker at cast and the
 * settlement pays it to the author, so a prune has nothing to refund a liker.
 *
 * Key properties:
 * - Deterministic: given the same postIds, UTXO state, and like-records, it
 *   names the same boxes, the same refunds and the same pool figure every time.
 * - No DAG walk: uses only the postId list (already verified against
 *   block_topology by the caller).
 * - The refund set may be empty — a subtree carrying no lock owned by anyone
 *   but the pruner names no refund at all.
 *
 * ⛔ **THE REFUND NEEDS NO MINT PROVENANCE ANY MORE, AND THAT RETIRES A WHOLE
 * COLLISION HAZARD.** A refund is an output of the block's settlement
 * transaction, so it takes that transaction's real `(txId, index)` like every
 * other output. The synthetic `prune-refund-author` id it used to carry had to
 * separate two subtrees pruned at one height — one user whose replies sit in
 * both would otherwise derive the same `mintTxId` twice at `index` 0 and trip
 * `UNIQUE(tx_id, output_index)`. Two outputs of one transaction cannot collide,
 * so the argument has no subject left. **The reason tag stays reserved and
 * unused** (NODE_INTERFACE → Reason and subject table).
 */
export function planPruneSettlement(
  _rootPostHash: PostId,
  authorId: UserId,
  postIds: PostId[],
): PruneSettlement {
  const pruner = Buffer.from(authorId).toString('hex');
  const refunds = new Map<string, bigint>();
  const lockBoxIds: string[] = [];
  let toPool = 0n;

  for (const postId of postIds) {
    // Every lock is named; only the destination reads the owner. The pruner's
    // own lock takes the input and no refund entry — its value goes to the pool.
    const lockBox = getPostLockBox(postId);
    if (lockBox && lockBox.value > 0n) {
      const owner = Buffer.from(lockBox.owner).toString('hex');
      if (owner === pruner) toPool += lockBox.value;
      else refunds.set(owner, (refunds.get(owner) ?? 0n) + lockBox.value);
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
