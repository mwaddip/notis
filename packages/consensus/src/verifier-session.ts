import type { BatchAVLVerifier } from '@ergots/avltree';
import { TREE_KEY_LENGTH, bytesToHex } from '@dagsocial/types';
import type { TreeLookup, TreeSession } from './tree-session.js';

/**
 * The session over `@ergots/avltree`'s step-by-step verifier
 * (CONSENSUS_INTERFACE → The tree session): each lookup is the verifier's
 * `performLookupWithNeighbors`, so the tree view answers a block's reads from
 * the block's proof alone, anchored at the digest the verifier was built on.
 *
 * The parameter names the two members the session calls, so it takes either of
 * the library's two step-by-step classes — `BatchAVLVerifier` and
 * `StrictBatchAVLVerifier` — neither of which is assignable to the other
 * (CONSENSUS_INTERFACE → The tree session → "`verifierSession(verifier)` is
 * the session over `@ergots/avltree`'s step-by-step verifier").
 *
 * A `null` neighbour is the sentinel — all `0x00` below the first key, all
 * `0xff` past the last — a fresh array each, so every answer is the view's to
 * keep. A `{ success: false }` is fatal to the proof: it throws, naming the
 * verifier's `getLastFailReason()`, and the verifier stays poisoned. A key the
 * library refuses by its shape is the library's throw.
 */
export function verifierSession(
  verifier: Pick<BatchAVLVerifier, 'performLookupWithNeighbors' | 'getLastFailReason'>,
): TreeSession {
  return {
    lookup(key: Uint8Array): TreeLookup {
      const answer = verifier.performLookupWithNeighbors(key);
      if (!answer.success) {
        throw new Error(`the proof refuses the lookup of ${bytesToHex(key)}: ${verifier.getLastFailReason()}`);
      }
      const nextKey = answer.nextKey ?? new Uint8Array(TREE_KEY_LENGTH).fill(0xff);
      return answer.found
        ? { found: true, value: answer.value, nextKey }
        : { found: false, prevKey: answer.prevKey ?? new Uint8Array(TREE_KEY_LENGTH), nextKey };
    },
  };
}
