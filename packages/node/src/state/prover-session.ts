import type { NeighborLookup, PersistentBatchAVLProver } from '@ergots/avltree';
import { TREE_KEY_LENGTH, bytesToHex } from '@dagsocial/types';
import { TreeInconsistencyError } from '@dagsocial/consensus';
import type { TreeLookup, TreeSession } from '@dagsocial/consensus';

/**
 * The unrecorded tree session over this node's prover (NODE_INTERFACE → AVL+
 * State Root → "The session reads with the prover's unrecorded neighbour
 * lookup"): a lookup records nothing toward a proof, and a `null` neighbour is
 * the sentinel — all `0x00` below the first key, all `0xff` past the last
 * (CONSENSUS_INTERFACE → The tree session). A key at either bound, or of any
 * width but `TREE_KEY_LENGTH`, is the library's throw.
 *
 * Every answer is the caller's to keep (CONSENSUS_INTERFACE → The tree session →
 * "A session's answers are the view's to keep"): the library answers fresh
 * copies, and each sentinel is a fresh array.
 */
export function proverSession(prover: PersistentBatchAVLProver): TreeSession {
  return {
    lookup(key: Uint8Array): TreeLookup {
      return lookupOf(prover.unauthenticatedLookupWithNeighbors(key));
    },
  };
}

/**
 * The recording session over this node's prover (NODE_INTERFACE → The block
 * proof): each lookup is the prover's `performLookupWithNeighbors`, so it joins
 * the proof the prover makes at its next checkpoint or `generateProof()`. Only
 * block application and the speculative run read through it; every other reader
 * takes `proverSession`, because a recorded lookup outside a block's cycle would
 * enter a block's proof.
 *
 * Its answers are `proverSession`'s — the sentinels, fresh arrays, the library's
 * throw for a key at either bound. A `{ success: false }` is a tree that
 * contradicts itself: `TreeInconsistencyError`, which both callers make
 * `InconsistentStateTreeError` (CONSENSUS_INTERFACE → The tree session).
 */
export function recordingSession(prover: PersistentBatchAVLProver): TreeSession {
  return {
    lookup(key: Uint8Array): TreeLookup {
      const answer = prover.performLookupWithNeighbors(key);
      if (!answer.success) {
        throw new TreeInconsistencyError(`the prover refuses the recorded lookup of ${bytesToHex(key)}`);
      }
      return lookupOf(answer);
    },
  };
}

/** The library's answer with each `null` neighbour mapped to its sentinel. */
function lookupOf(answer: NeighborLookup): TreeLookup {
  const nextKey = answer.nextKey ?? pastLast();
  return answer.found
    ? { found: true, value: answer.value, nextKey }
    : { found: false, prevKey: answer.prevKey ?? belowFirst(), nextKey };
}

function belowFirst(): Uint8Array {
  return new Uint8Array(TREE_KEY_LENGTH);
}

function pastLast(): Uint8Array {
  return new Uint8Array(TREE_KEY_LENGTH).fill(0xff);
}
