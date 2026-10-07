/**
 * BatchAVLProver — @ergots/avltree's prover extended with the neighbor-
 * reporting lookups: a Lookup that also reports its neighbors on the recorded
 * path, and an unauthenticated walk that does the same from the prover's tree
 * without recording.
 *
 * See AVLTREE_INTERFACE → Neighbor lookups.
 */

import {
  BatchAVLProver as EngineProver,
  compareBytes,
  negInfKey,
  posInfKey,
  type AvlNode,
  type LeafNode,
  type ProverOperationResult,
} from '@ergots/avltree'
import { neighborLookupOf, type NeighborLookup, type NeighborLookupResult } from './neighbors.js'

/**
 * The prover with the recorded neighbor lookup and its unrecorded twin. Every
 * other method inherits from the engine's prover unchanged.
 */
export class BatchAVLProver extends EngineProver {
  /** All-zero key, the exclusive lower bound. Depends only on keyLength. */
  private readonly negInfKeyBuf: Uint8Array
  /** All-0xff key, the exclusive upper bound. Depends only on keyLength. */
  private readonly posInfKeyBuf: Uint8Array

  constructor(keyLength: number, valueLengthOpt: number | null) {
    super(keyLength, valueLengthOpt)
    this.negInfKeyBuf = negInfKey(keyLength)
    this.posInfKeyBuf = posInfKey(keyLength)
  }

  /**
   * A Lookup that also reports its neighbors: a present key → its value and
   * the next leaf's key; an absent key → the keys of the leaves either side;
   * `null` for a sentinel. Runs `{ tag: 'Lookup', key }` through exactly
   * performOneOperation's path — same key gates and throws, same direction
   * bits and visits, same `{ success: false }`, same proof-cycle fail-stop —
   * and reads the report off the leaf the engine's single keyMatchesLeaf call
   * resolves at. A successful run that observed other than one leaf is an
   * engine inconsistency: it throws a plain `Error` and sets the fail-stop
   * mark.
   */
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult {
    const seen: { leaf: LeafNode | null; matches: boolean; calls: number } = {
      leaf: null,
      matches: false,
      calls: 0,
    }
    const result = this.perform(
      { tag: 'Lookup', key },
      (leaf, matches) => {
        seen.leaf = leaf
        seen.matches = matches
        seen.calls++
      },
      'performLookupWithNeighbors',
    )
    if (!result.success) return { success: false }
    if (seen.calls !== 1 || seen.leaf === null) {
      // An engine inconsistency: fail stop, as for any engine throw.
      this.cycleIndeterminate = true
      throw new Error(
        `BatchAVLProver.performLookupWithNeighbors: a successful Lookup observed ${seen.calls} leaves, not 1 — the shared engine is in an inconsistent state`,
      )
    }
    return { success: true, ...neighborLookupOf(seen.leaf, seen.matches, this.negInfKeyBuf, this.posInfKeyBuf) }
  }

  /**
   * performLookupWithNeighbors without recording: no directions, no visits,
   * no proof-cycle effect; reads only the root. Validates the key with
   * performOneOperation's three gates — unlike `unauthenticatedLookup`, which
   * validates nothing and returns null — so a sentinel key throws here as on
   * the recorded path. Walks the recorded path's descent: compare with the
   * internal node's key; on equal, right once, then left to the leaf. A label
   * stub or key-less internal node on the walk is an invariant violation
   * (reachable only via restoreRoot) and throws rather than guess.
   */
  unauthenticatedLookupWithNeighbors(key: Uint8Array): NeighborLookup {
    this.validateKey(key)
    let node: AvlNode = this.root
    let found = false
    while (node.kind === 'internal') {
      if (node.key === undefined) {
        throw new Error(
          'BatchAVLProver.unauthenticatedLookupWithNeighbors: internal node without key on the lookup path — tree invariant violated (restoreRoot)',
        )
      }
      if (found) {
        node = node.left
        continue
      }
      const cmp = compareBytes(key, node.key)
      if (cmp === 0) {
        found = true
        node = node.right
      } else {
        node = cmp < 0 ? node.left : node.right
      }
    }
    if (node.kind === 'label') {
      throw new Error(
        'BatchAVLProver.unauthenticatedLookupWithNeighbors: label stub on the lookup path — tree invariant violated (restoreRoot)',
      )
    }
    return neighborLookupOf(node, found, this.negInfKeyBuf, this.posInfKeyBuf)
  }
}

// Re-export ProverOperationResult so callers that import both from here keep
// one typed surface. AVLTREE_INTERFACE → Place in the workspace: this package
// is the one that imports @ergots/avltree.
export type { ProverOperationResult }
