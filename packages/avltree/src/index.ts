/**
 * Public surface of `@dagsocial/avltree`: @ergots/avltree's authenticated
 * tree, plus the four things Notis needs that it does not have — the
 * neighbor-reporting lookups, the strict verifier, the depth guard the
 * verifiers run at construction, and nodes loaded on first access.
 *
 * See AVLTREE_INTERFACE.
 */

// Neighbor lookups.
export { BatchAVLProver, type ProverOperationResult } from './prover.js'
export { BatchAVLVerifier } from './verifier.js'
export type { NeighborLookup, NeighborLookupResult } from './neighbors.js'

// The strict verifier.
export { StrictBatchAVLVerifier } from './strict-verifier.js'

// Nodes loaded on first access.
export { lazyRoot, type LoadNode } from './lazy-nodes.js'

// Passed through from @ergots/avltree (AVLTREE_INTERFACE → What it holds): the
// persistent prover, versioned storage, the node type and its constructors, the
// codec and the lookup verifier.
export {
  PersistentBatchAVLProver,
  deserializeNode,
  label,
  newInternal,
  newLabel,
  newLeaf,
  serializeNode,
  verifyAvlLookup,
  type AvlNode,
  type AvlTreeConfig,
  type VersionedAVLStorage,
} from '@ergots/avltree'
