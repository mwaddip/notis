import type { PostId, SubBlockTree } from '@dagsocial/types';

/**
 * The ids of the sub-blocks a block's tree carries, read from the **committed**
 * list.
 *
 * `subBlockEntries` is under `subBlockRoot` and therefore under `blockHash`;
 * `subBlockRefs` is not. `computeSubBlockRoot` builds its leaves from
 * `subBlockEntries` and `pruneEntries` and never reads the refs, and the
 * verifier checks only that the refs are an array of the same *length*. A block
 * whose refs name entirely different post ids therefore has an unchanged root
 * and an unchanged hash, so every value read from that field is attacker-chosen
 * — and these ids drive **three** state effects, not two:
 *
 *  1. `removeSubBlockEntries` → `DELETE FROM mempool`, committed with the
 *     accepted block. An **eviction** primitive: unconfirmed sub-blocks dropped
 *     network-wide without ever being confirmed.
 *  2. The journal's `confirmedSubBlockIds` → `unconfirmPost` on rollback
 *     (`revertBlock`). An inverse keyed off refs un-confirms ids the forward
 *     pass never confirmed and leaves the ones it did.
 *  3. The same journal field → `insertMempoolSubBlock` on reorg. An
 *     **injection** primitive, and the sharper one: eviction needs the victim's
 *     entry already pooled, while this *writes* attacker-chosen ids into the
 *     mempool as sub-block entries — for content the node need not hold — out
 *     the far side of a reorg. Easy to miss: (2) and (3) iterate the same field
 *     two functions apart, and reading them as one operation hides the second.
 *
 * The rule in one sentence: **the forward pass and every inverse read the same
 * committed list.** Every consumer reads through here.
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
