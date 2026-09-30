import type { PersistentBatchAVLProver } from '@ergots/avltree';
import { TREE_KEY_LENGTH } from '@dagsocial/types';
import type { TreeLookup, TreeSession } from '@dagsocial/consensus';

/**
 * The tree session over this node's prover (NODE_INTERFACE → AVL+ State Root →
 * "The session reads with the prover's unrecorded neighbour lookup"): a lookup
 * records nothing toward a proof, and a `null` neighbour is the sentinel — all
 * `0x00` below the first key, all `0xff` past the last (CONSENSUS_INTERFACE →
 * The tree session). A key at either bound, or of any width but
 * `TREE_KEY_LENGTH`, is the library's throw.
 *
 * Every answer is the caller's to keep (CONSENSUS_INTERFACE → The tree session →
 * "A session's answers are the view's to keep"): the library answers fresh
 * copies, and each sentinel is a fresh array.
 */
export function proverSession(prover: PersistentBatchAVLProver): TreeSession {
  return {
    lookup(key: Uint8Array): TreeLookup {
      const answer = prover.unauthenticatedLookupWithNeighbors(key);
      const nextKey = answer.nextKey ?? pastLast();
      return answer.found
        ? { found: true, value: answer.value, nextKey }
        : { found: false, prevKey: answer.prevKey ?? belowFirst(), nextKey };
    },
  };
}

function belowFirst(): Uint8Array {
  return new Uint8Array(TREE_KEY_LENGTH);
}

function pastLast(): Uint8Array {
  return new Uint8Array(TREE_KEY_LENGTH).fill(0xff);
}
