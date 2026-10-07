/**
 * Public surface of `@dagsocial/avltree`: @ergots/avltree's authenticated
 * tree, plus the three things Notis needs that it does not have — the
 * neighbor-reporting lookups, the strict verifier, and nodes loaded on first
 * access.
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

// Passed through from @ergots/avltree: types, constructors, codec, the batch
// functions, versioned-storage, the error class.
export {
  AvlVerifyError,
  PersistentBatchAVLProver,
  deserializeNode,
  label,
  newInternal,
  newLabel,
  newLeaf,
  serializeNode,
  verifyAvlBatch,
  verifyAvlBatchPartial,
  verifyAvlLookup,
  type AvlNode,
  type AvlTreeConfig,
  type AvlVerifyErrorCode,
  type AvlVerifyFailReason,
  type Balance,
  type InternalNode,
  type LabelNode,
  type LeafNode,
  type Operation,
  type OperationResult,
  type VerifyAvlBatchPartialResult,
  type VerifyAvlBatchResult,
  type VersionedAVLStorage,
} from '@ergots/avltree'
