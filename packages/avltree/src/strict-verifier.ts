/**
 * StrictBatchAVLVerifier — a step-by-step verifier that can also say whether
 * the proof it replayed is exactly the proof a prover writes for the
 * operations performed.
 *
 * NOT Ergo consensus. Ergo's references accept proofs this check rejects (a
 * proof with trailing bytes, for one), so no Ergo path may use this class.
 * It exists for networks whose full nodes regenerate each proof and compare
 * it byte for byte.
 *
 * See AVLTREE_INTERFACE → The strict verifier.
 */

import {
  validateConfig,
  validateOperationShape,
  validateStartingDigest,
  type AvlNode,
  type AvlTreeConfig,
  type AvlTreeOpsCallbacks,
  type AvlVerifyFailReason,
  type LeafCallback,
  type Operation,
  type ProverOperationResult,
} from '@ergots/avltree'
import { CoreWithNeighbors } from './verifier.js'
import { matchesCanonicalProof } from './canonical-proof.js'
import type { NeighborLookupResult } from './neighbors.js'

/**
 * CoreWithNeighbors, plus a record of what the replay touched: the tree as
 * the proof decoded it, every node the engine visits, and where the
 * directions begin. Internal.
 *
 * It relies on one property of the parent's constructor: it calls no
 * overridable method. This class's fields are initialized only after
 * `super()` returns, so an override reached from that constructor would see
 * them unset.
 */
class RecordingVerifierCore extends CoreWithNeighbors {
  /** The root as decoded from the proof; null when decoding or anchoring failed. */
  private readonly decodedRoot: AvlNode | null
  /** The bit after END_OF_TREE, where this proof's directions begin. */
  private readonly directionsStartBit: number
  private readonly valueLengthOpt: number | null
  /**
   * Every node the engine visited, by identity — what the prover's
   * `modifiedNodes` holds, fed by the same `onNodeVisit` calls. Nodes the
   * replay created are recorded too; only decoded nodes are ever looked up.
   */
  private readonly visited = new Set<AvlNode>()

  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    super(startingDigest, proof, config)
    this.decodedRoot = this.root
    this.directionsStartBit = this.state.directionsIndex
    this.valueLengthOpt = config.valueLengthOpt
  }

  /** The parent's callbacks, with `onNodeVisit` recording instead of doing nothing. */
  protected override buildCallbacks(onLeaf?: LeafCallback): AvlTreeOpsCallbacks {
    const visited = this.visited
    return {
      ...super.buildCallbacks(onLeaf),
      onNodeVisit: (node: AvlNode) => {
        visited.add(node)
      },
    }
  }

  /**
   * Whether the proof is exactly what a prover writes for the operations
   * performed so far. False once poisoned.
   */
  isFullyConsumed(): boolean {
    if (this.root === null || this.decodedRoot === null) return false
    return matchesCanonicalProof(
      this.proof,
      this.decodedRoot,
      this.visited,
      this.valueLengthOpt,
      this.directionsStartBit,
      this.state.directionsIndex,
    )
  }
}

/**
 * The strict step-by-step verifier: BatchAVLVerifier's constructor and
 * methods, with the same behavior, plus `isFullyConsumed()`.
 *
 * - The constructor and the four shared methods validate, copy, poison and
 *   fail-stop exactly as BatchAVLVerifier's do; see that class.
 * - `isFullyConsumed()` says whether the proof is byte-for-byte the proof
 *   BatchAVLProver.generateProof() writes for the operations performed.
 * - NOT Ergo consensus: Ergo's references accept proofs it rejects.
 * - Not a subtype of BatchAVLVerifier: both classes have private members,
 *   which TypeScript compares nominally. Type a parameter that takes either
 *   class structurally.
 */
export class StrictBatchAVLVerifier {
  private readonly config: AvlTreeConfig
  private readonly core: RecordingVerifierCore
  /** Set while a call is inside the core; still set after one threw. */
  private indeterminate = false

  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    // Copy first, then validate the copy: no check-then-copy gap on a
    // getter-backed config object.
    const own: AvlTreeConfig = {
      keyLength: config.keyLength,
      valueLengthOpt: config.valueLengthOpt,
      maxNumOperations: config.maxNumOperations,
      maxDeletes: config.maxDeletes,
    }
    validateConfig(own)
    validateStartingDigest(startingDigest)
    this.config = own
    // `new Uint8Array`, never `.slice()`: a Buffer's slice is a view, and the
    // core reads direction bits from the proof lazily, op by op.
    this.core = new RecordingVerifierCore(startingDigest, new Uint8Array(proof), own)
  }

  /**
   * Applies one operation. Shape errors throw AvlVerifyError and change no
   * state. Success → `{ success: true, value }` (the old value, a fresh copy,
   * or null when absent); verification failure → `{ success: false }`, and
   * the verifier is poisoned.
   */
  performOneOperation(op: Operation): ProverOperationResult {
    this.assertUsable('performOneOperation')
    validateOperationShape(op, this.config)
    this.indeterminate = true
    const r = this.core.performOneOperation(op)
    this.indeterminate = false
    if (r !== null && typeof r === 'object' && 'failed' in r) return { success: false }
    return { success: true, value: r === null ? null : new Uint8Array(r) }
  }

  /**
   * A Lookup that also reports its neighbors, exactly as
   * BatchAVLVerifier.performLookupWithNeighbors does: the same key
   * validation, the same proof bits and visits as a plain Lookup, the same
   * poisoning.
   */
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult {
    this.assertUsable('performLookupWithNeighbors')
    validateOperationShape({ tag: 'Lookup', key }, this.config)
    this.indeterminate = true
    const r = this.core.lookupWithNeighbors(key)
    this.indeterminate = false
    if ('failed' in r) return { success: false }
    return { success: true, ...r }
  }

  /** The current 33-byte digest (a fresh buffer), or null once poisoned. */
  digest(): Uint8Array | null {
    this.assertUsable('digest')
    return this.core.digest()
  }

  /**
   * Why the verifier is poisoned — the first failure's reason — or null if no
   * verification failure has occurred. Neither an AvlVerifyError nor an
   * engine throw sets a reason, and this method answers even after an engine
   * throw left the instance indeterminate.
   */
  getLastFailReason(): AvlVerifyFailReason | null {
    return this.core.lastFailReason
  }

  /**
   * Whether the proof is byte-for-byte the proof BatchAVLProver.generateProof()
   * writes for the operations performed so far — so ask after the last one.
   *
   * - false once the verifier is poisoned: a proof that failed to decode or
   *   anchor, or an operation that failed.
   * - Throws a plain Error on an indeterminate instance, as `digest()` does.
   * - Changes no state.
   */
  isFullyConsumed(): boolean {
    this.assertUsable('isFullyConsumed')
    return this.core.isFullyConsumed()
  }

  private assertUsable(method: string): void {
    if (this.indeterminate) {
      throw new Error(
        `StrictBatchAVLVerifier.${method}: an earlier call threw mid-operation, so this verifier is indeterminate — discard it (an engine throw is never a verification verdict)`,
      )
    }
  }
}
