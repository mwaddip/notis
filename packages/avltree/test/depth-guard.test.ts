/**
 * AVLTREE_INTERFACE → The depth guard. A proof is never deeper than the tree
 * its digest declares: BatchAVLVerifier and StrictBatchAVLVerifier refuse at
 * construction any proof whose decoded tree is deeper than the digest's height
 * byte, poisoning the verifier so digest() is null, getLastFailReason() is
 * 'proof-malformed', and every operation fails without throwing. The engine's
 * node bound inside verifyAvlLookup already refuses the same deep proofs.
 */

import { describe, expect, it } from 'vitest'
import { BatchAVLVerifier } from '../src/verifier.js'
import { StrictBatchAVLVerifier } from '../src/strict-verifier.js'
import { verifyAvlLookup } from '@ergots/avltree'
import type { NeighborLookupResult } from '../src/neighbors.js'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'
import { keyOf, sevenKeyProver } from './helpers/tree-surgery.js'

const KL = 32
const CONFIG = { keyLength: KL, valueLengthOpt: null }
const DEEP_DEPTH = 60_000
const DEEP_HEIGHT_BYTE = 0xff
const DEEP_LOOKUP_KEY = new Uint8Array([0x10])

describe('the tree the digest declares bounds every path of the proof', () => {
  it.fails('a proof whose decoded tree is one level deeper than the digest declares is refused — BatchAVLVerifier', () => {
    const p = sevenKeyProver()
    const trueDigest = p.digest()
    const h = trueDigest[32]!
    expect(h).toBeGreaterThanOrEqual(1)
    const lookup = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(40) }])
    if (!lookup.success) throw new Error('prover lookup proof must succeed')
    // Control: the honest digest decodes and anchors; a lookup answers the value.
    const ok = new BatchAVLVerifier(trueDigest, lookup.proof, CONFIG)
    expect(ok.digest()).not.toBeNull()
    expect(ok.performOneOperation({ tag: 'Lookup', key: keyOf(40) })).toEqual({
      success: true,
      value: new Uint8Array([40]),
    })
    // The same proof under a digest whose height byte is one lower.
    const lowered = new Uint8Array(trueDigest)
    lowered[32] = h - 1
    const v = new BatchAVLVerifier(lowered, lookup.proof, CONFIG)
    expect(v.getLastFailReason()).toBe('proof-malformed')
    expect(v.digest()).toBeNull()
  })

  it.fails('a proof whose decoded tree is one level deeper than the digest declares is refused — StrictBatchAVLVerifier', () => {
    const p = sevenKeyProver()
    const trueDigest = p.digest()
    const h = trueDigest[32]!
    expect(h).toBeGreaterThanOrEqual(1)
    const lookup = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(40) }])
    if (!lookup.success) throw new Error('prover lookup proof must succeed')
    // Control: the honest digest decodes and anchors; a lookup answers the value.
    const ok = new StrictBatchAVLVerifier(trueDigest, lookup.proof, CONFIG)
    expect(ok.digest()).not.toBeNull()
    expect(ok.performOneOperation({ tag: 'Lookup', key: keyOf(40) })).toEqual({
      success: true,
      value: new Uint8Array([40]),
    })
    // The same proof under a digest whose height byte is one lower.
    const lowered = new Uint8Array(trueDigest)
    lowered[32] = h - 1
    const v = new StrictBatchAVLVerifier(lowered, lookup.proof, CONFIG)
    expect(v.getLastFailReason()).toBe('proof-malformed')
    expect(v.digest()).toBeNull()
  })

  it("a prover's own lookup proof verifies at its declared height — both verifiers", () => {
    const p = sevenKeyProver()
    const trueDigest = p.digest()
    const lookup = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(40) }])
    if (!lookup.success) throw new Error('prover lookup proof must succeed')
    const a = new BatchAVLVerifier(trueDigest, lookup.proof, CONFIG)
    expect(a.digest()).not.toBeNull()
    expect(a.performOneOperation({ tag: 'Lookup', key: keyOf(40) })).toEqual({
      success: true,
      value: new Uint8Array([40]),
    })
    const b = new StrictBatchAVLVerifier(trueDigest, lookup.proof, CONFIG)
    expect(b.digest()).not.toBeNull()
    expect(b.performOneOperation({ tag: 'Lookup', key: keyOf(40) })).toEqual({
      success: true,
      value: new Uint8Array([40]),
    })
  })

  it.fails('a thousands-deep spine under a digest declaring 255 is refused with no throw — BatchAVLVerifier', () => {
    const digest = buildSpineDigest(DEEP_DEPTH, DEEP_HEIGHT_BYTE)
    const proof = buildSpineProof(DEEP_DEPTH, Math.ceil(DEEP_DEPTH / 8))
    let v: BatchAVLVerifier | undefined
    // Control: construction never throws.
    expect(() => {
      v = new BatchAVLVerifier(digest, proof, SPINE_CONFIG)
    }).not.toThrow()
    // Operations fail cleanly, never raising a RangeError from a stack overflow.
    let lookupR: NeighborLookupResult | undefined
    expect(() => {
      lookupR = v!.performLookupWithNeighbors(DEEP_LOOKUP_KEY)
    }).not.toThrow()
    expect(lookupR).toEqual({ success: false })
    expect(v!.digest()).toBeNull()
  })

  it.fails('a thousands-deep spine under a digest declaring 255 is refused with no throw — StrictBatchAVLVerifier', () => {
    const digest = buildSpineDigest(DEEP_DEPTH, DEEP_HEIGHT_BYTE)
    const proof = buildSpineProof(DEEP_DEPTH, Math.ceil(DEEP_DEPTH / 8))
    let v: StrictBatchAVLVerifier | undefined
    // Control: construction never throws.
    expect(() => {
      v = new StrictBatchAVLVerifier(digest, proof, SPINE_CONFIG)
    }).not.toThrow()
    // Operations fail cleanly, never raising a RangeError from a stack overflow.
    let lookupR: NeighborLookupResult | undefined
    expect(() => {
      lookupR = v!.performLookupWithNeighbors(DEEP_LOOKUP_KEY)
    }).not.toThrow()
    expect(lookupR).toEqual({ success: false })
    expect(v!.digest()).toBeNull()
  })

  it("verifyAvlLookup with the engine's node bound refuses a thousands-deep spine with no throw", () => {
    const digest = buildSpineDigest(DEEP_DEPTH, DEEP_HEIGHT_BYTE)
    const proof = buildSpineProof(DEEP_DEPTH, Math.ceil(DEEP_DEPTH / 8))
    const config = { keyLength: 1, valueLengthOpt: 1, maxNumOperations: 1, maxDeletes: 0 }
    let r: ReturnType<typeof verifyAvlLookup> | undefined
    expect(() => {
      r = verifyAvlLookup(digest, proof, config, DEEP_LOOKUP_KEY)
    }).not.toThrow()
    expect(r).toBeNull()
  })
})
