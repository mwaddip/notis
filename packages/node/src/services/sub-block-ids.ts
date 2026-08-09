import type { PostId, SubBlockTree } from '@dagsocial/types';

/**
 * The ids of the sub-blocks a block's tree carries, read from the **committed**
 * list.
 *
 * `subBlockEntries` is under `subBlockRoot` and therefore under `blockHash`;
 * `subBlockRefs` is not. `computeSubBlockRoot` builds its leaves from
 * `subBlockEntries` and `pruneEntries` and never reads the refs, and the
 * verifier checks only that the refs are an array of the same *length*. A block
 * whose refs named entirely different post ids was accepted with an unchanged
 * root and an unchanged hash — so every value taken from that field was
 * attacker-chosen, and it drove **three** state effects, not two:
 *
 *  1. `removeSubBlockEntries` → `DELETE FROM mempool`, committed with the
 *     accepted block. An **eviction** primitive: unconfirmed sub-blocks dropped
 *     network-wide without ever being confirmed.
 *  2. The journal's `confirmedSubBlockIds` → `unconfirmPost` on rollback
 *     (`fork-resolution.ts:214`, inside `revertBlock`). The inverse un-confirmed
 *     ids the forward pass never confirmed, and left the ones it did.
 *  3. The same journal field → `insertMempoolSubBlock` on reorg
 *     (`fork-resolution.ts:335`, `reorg` phase 2). An **injection** primitive,
 *     and the sharper one: eviction needed the victim's entry already pooled,
 *     while this *writes* attacker-chosen ids into the mempool as sub-block
 *     entries — for content the node need not hold — out the far side of a
 *     reorg. Easy to miss because `:214` and `:335` iterate the same field two
 *     functions apart, and reading them as one operation is how the second one
 *     stayed unnamed.
 *
 * That was the defect in one sentence: **apply confirmed from the committed
 * list while every inverse keyed off the uncommitted one** — the reverse
 * operations reading a different list from the forward one. Every consumer now
 * reads through here.
 *
 * This changes nothing for an honest block. Sub-block identity *is* post
 * identity, and `block-creator.ts` builds refs and entries from the same
 * `resolvedSubBlocks`, so `subBlockRefs[i] === subBlockEntries[i].postId`
 * holds for anything this node — or any honest node — produces.
 *
 * One function rather than five inline maps, so the derivation has a single
 * definition and the field's removal has a single place to check.
 */
export function subBlockIdsOf(tree: SubBlockTree): PostId[] {
  return tree.subBlockEntries.map((entry) => entry.postId);
}
