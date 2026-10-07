/**
 * The step-by-step verifier with the neighbor-reporting lookup, over
 * @ergots/avltree's VerifierCore extended with lookupWithNeighbors through
 * the engine's `protected perform`.
 *
 * See AVLTREE_INTERFACE → Neighbor lookups.
 */

import {
  VerifierCore,
  negInfKey,
  posInfKey,
  validateConfig,
  validateOperationShape,
  validateStartingDigest,
  type AvlTreeConfig,
  type AvlVerifyFailReason,
  type LeafNode,
  type Operation,
  type ProverOperationResult,
} from '@ergots/avltree'
import { neighborLookupOf, type NeighborLookup, type NeighborLookupResult } from './neighbors.js'

/**
 * VerifierCore with a neighbor-reporting lookup bolted on through the engine's
 * protected `perform`. Shares the parent's traversal state, callbacks and
 * digest; adds only the leaf observer the report is read off.
 *
 * The subclass's fields are initialized only after `super()` returns, which
 * VerifierCore's constructor guarantees by calling no overridable method.
 */
export class CoreWithNeighbors extends VerifierCore {
  private readonly negInfKeyBuf: Uint8Array
  private readonly posInfKeyBuf: Uint8Array

  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    super(startingDigest, proof, config)
    this.negInfKeyBuf = negInfKey(config.keyLength)
    this.posInfKeyBuf = posInfKey(config.keyLength)
  }

  /**
   * A Lookup that reports its neighbors: exactly
   * `performOneOperation({ tag: 'Lookup', key })` — same gates, same proof
   * bits consumed, same poisoning — with the report read off the leaf the
   * lookup resolved at. Buffers in the report are fresh copies.
   */
  lookupWithNeighbors(key: Uint8Array): NeighborLookup | { failed: true } {
    const seen: { leaf: LeafNode | null; matches: boolean; calls: number } = {
      leaf: null,
      matches: false,
      calls: 0,
    }
    const r = this.perform({ tag: 'Lookup', key }, (leaf, matches) => {
      seen.leaf = leaf
      seen.matches = matches
      seen.calls++
    })
    if (r !== null && typeof r === 'object' && 'failed' in r) return r
    if (seen.calls !== 1 || seen.leaf === null) {
      throw new Error(
        `CoreWithNeighbors.lookupWithNeighbors: a successful Lookup observed ${seen.calls} leaves, not 1 — the shared engine is in an inconsistent state`,
      )
    }
    return neighborLookupOf(seen.leaf, seen.matches, this.negInfKeyBuf, this.posInfKeyBuf)
  }
}

/**
 * The step-by-step AVL+ verifier: construct over a starting digest, a proof
 * and a config, then perform operations one at a time. Wraps CoreWithNeighbors.
 *
 * - Construction copies `config` (its four fields) and validates the copy,
 *   validates `startingDigest`, and copies `proof` with `new Uint8Array` —
 *   the core reads direction bits from it lazily, op by op, and a Buffer's
 *   `.slice()` is a view. A proof that fails to decode or anchor does not
 *   throw: the verifier is poisoned from birth — `digest()` null,
 *   `getLastFailReason()` says why, every operation fails.
 * - A failed operation poisons: every later one fails; the first failure's
 *   reason is kept.
 * - Returned values are fresh copies.
 * - An engine throw leaves the instance indeterminate; every later call
 *   throws.
 */
export class BatchAVLVerifier {
  private readonly config: AvlTreeConfig
  protected readonly core: CoreWithNeighbors
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
    this.core = new CoreWithNeighbors(startingDigest, new Uint8Array(proof), own)
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
   * A Lookup that also reports its neighbors. Consumes the proof exactly as
   * `performOneOperation({ tag: 'Lookup', key })` does — same key validation,
   * same bits, same poisoning — and reports, for a present key, its value
   * and the next leaf's key, or for an absent key the keys of the leaves
   * either side; `null` for a sentinel. The leaf is authenticated: it is in
   * the tree this verifier's digest commits to.
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

  protected assertUsable(method: string): void {
    if (this.indeterminate) {
      throw new Error(
        `BatchAVLVerifier.${method}: an earlier call threw mid-operation, so this verifier is indeterminate — discard it (an engine throw is never a verification verdict)`,
      )
    }
  }
}

