import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/prover.js'
import { StrictBatchAVLVerifier } from '../src/strict-verifier.js'
import { AvlVerifyError, type AvlTreeConfig, type Operation } from '@ergots/avltree'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'

const KL = 32
const CONFIG: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }

function key(b: number): Uint8Array {
  const k = new Uint8Array(KL)
  k[0] = b
  k[KL - 1] = b
  return k
}

/** Starting digest and canonical proof for `ops` over a tree holding keys 10..50 (value = [b]). */
function scenario(ops: Operation[]): { digest: Uint8Array; proof: Uint8Array } {
  const p = new BatchAVLProver(KL, null)
  for (const b of [10, 20, 30, 40, 50]) {
    p.performOneOperation({ tag: 'Insert', key: key(b), value: new Uint8Array([b]) })
  }
  p.generateProof()
  const digest = p.digest()
  const r = p.generateProofForOperations(ops)
  if (!r.success) throw new Error('scenario operations must succeed on the prover')
  return { digest, proof: r.proof }
}

const TWO_LOOKUPS: Operation[] = [
  { tag: 'Lookup', key: key(20) },
  { tag: 'Lookup', key: key(40) },
]

describe('isFullyConsumed — a poisoned verifier answers false', () => {
  it('poisoned from birth: a proof that fails to decode or anchor', () => {
    const { digest, proof } = scenario(TWO_LOOKUPS)
    const wrong = new Uint8Array(digest)
    wrong[0] = wrong[0]! ^ 1
    const cases: [Uint8Array, Uint8Array, AvlTreeConfig, string][] = [
      [wrong, proof, CONFIG, 'digest-mismatch'],
      [digest, proof.subarray(0, 3), CONFIG, 'proof-truncated'],
      [digest, new Uint8Array(0), CONFIG, 'proof-truncated'],
      [digest, new Uint8Array([0x04]), CONFIG, 'proof-malformed'],
      [digest, proof, { keyLength: KL, valueLengthOpt: null, maxNumOperations: 0, maxDeletes: 0 }, 'max-nodes-exceeded'],
    ]
    for (const [d, p, config, reason] of cases) {
      const v = new StrictBatchAVLVerifier(d, p, config)
      expect(v.getLastFailReason(), reason).toBe(reason)
      expect(v.digest(), reason).toBeNull()
      expect(v.isFullyConsumed(), reason).toBe(false)
    }
  })

  it('poisoned from birth: a config that differs from the producer\'s', () => {
    // The producer wrote variable-length values; this verifier expects one fixed byte.
    const { digest, proof } = scenario(TWO_LOOKUPS)
    const v = new StrictBatchAVLVerifier(digest, proof, { keyLength: KL, valueLengthOpt: 1 })
    expect(v.getLastFailReason()).not.toBeNull()
    expect(v.digest()).toBeNull()
    expect(v.isFullyConsumed()).toBe(false)
  })

  it('after a failed operation', () => {
    const { digest, proof } = scenario(TWO_LOOKUPS)
    const precondition = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    expect(precondition.performOneOperation({ tag: 'Insert', key: key(20), value: new Uint8Array([9]) })).toEqual({
      success: false,
    })
    expect(precondition.getLastFailReason()).toBe('operation-precondition-failed')
    expect(precondition.isFullyConsumed()).toBe(false)

    const sentinel = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    expect(sentinel.performOneOperation({ tag: 'Lookup', key: new Uint8Array(KL) })).toEqual({ success: false })
    expect(sentinel.getLastFailReason()).toBe('key-out-of-bounds')
    expect(sentinel.isFullyConsumed()).toBe(false)
  })
})

describe('isFullyConsumed — the answer covers the operations performed so far', () => {
  it('is false until the last operation, then true, and asking changes nothing', () => {
    const { digest, proof } = scenario(TWO_LOOKUPS)
    const v = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    expect(v.isFullyConsumed()).toBe(false)
    expect(v.performOneOperation(TWO_LOOKUPS[0]!)).toEqual({ success: true, value: new Uint8Array([20]) })
    expect(v.isFullyConsumed()).toBe(false)
    expect(v.isFullyConsumed()).toBe(false)
    expect(v.performOneOperation(TWO_LOOKUPS[1]!)).toEqual({ success: true, value: new Uint8Array([40]) })
    expect(v.isFullyConsumed()).toBe(true)
    expect(v.isFullyConsumed()).toBe(true)

    // The same replay without the questions in between ends the same way.
    const quiet = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    for (const op of TWO_LOOKUPS) quiet.performOneOperation(op)
    expect(quiet.isFullyConsumed()).toBe(true)
    expect(quiet.digest()).toEqual(v.digest())
  })

  it('before any operation, only an empty cycle proof answers true', () => {
    const empty = scenario([])
    expect(empty.proof.length).toBe(34) // one label, then END_OF_TREE
    expect(new StrictBatchAVLVerifier(empty.digest, empty.proof, CONFIG).isFullyConsumed()).toBe(true)
    const padded = new Uint8Array([...empty.proof, 0])
    expect(new StrictBatchAVLVerifier(empty.digest, padded, CONFIG).isFullyConsumed()).toBe(false)
  })

  it('a proof with no direction bits still needs its operation', () => {
    // A fresh tree is one sentinel leaf: a lookup descends no internal node.
    const p = new BatchAVLProver(KL, null)
    const digest = p.digest()
    const lookup: Operation = { tag: 'Lookup', key: key(20) }
    const r = p.generateProofForOperations([lookup])
    if (!r.success) throw new Error('lookup must succeed on the prover')
    expect(r.proof[r.proof.length - 1]).toBe(0x04) // END_OF_TREE is the last byte: no directions
    const v = new StrictBatchAVLVerifier(digest, r.proof, CONFIG)
    expect(v.isFullyConsumed()).toBe(false) // the leaf is written in full but not yet visited
    expect(v.performOneOperation(lookup)).toEqual({ success: true, value: null })
    expect(v.isFullyConsumed()).toBe(true)
  })

  it('answers false after the caller performs an operation the proof does not carry', () => {
    const { digest, proof } = scenario([TWO_LOOKUPS[0]!])
    const v = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    expect(v.performOneOperation(TWO_LOOKUPS[0]!).success).toBe(true)
    expect(v.isFullyConsumed()).toBe(true)
    // The proof carries nothing for a second lookup: it fails, and poisons.
    expect(v.performOneOperation(TWO_LOOKUPS[1]!)).toEqual({ success: false })
    expect(v.isFullyConsumed()).toBe(false)
  })
})

describe('isFullyConsumed — a throw is not an answer', () => {
  it('a shape throw changes nothing', () => {
    const { digest, proof } = scenario(TWO_LOOKUPS)
    const v = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    expect(v.performOneOperation(TWO_LOOKUPS[0]!).success).toBe(true)
    expect(v.isFullyConsumed()).toBe(false)
    expect(() => v.performOneOperation({ tag: 'Lookup', key: new Uint8Array(KL - 1).fill(1) })).toThrow(AvlVerifyError)
    expect(() => v.performLookupWithNeighbors(new Uint8Array(KL + 1).fill(1))).toThrow(AvlVerifyError)
    expect(v.getLastFailReason()).toBeNull()
    expect(v.isFullyConsumed()).toBe(false)
    // The verifier is still healthy: the second lookup counts, as a neighbor lookup here.
    expect(v.performLookupWithNeighbors(key(40))).toMatchObject({ success: true, found: true })
    expect(v.isFullyConsumed()).toBe(true)
  })

  it('after an engine throw it throws, as digest() does', () => {
    const depth = 100_000
    const v = new StrictBatchAVLVerifier(
      buildSpineDigest(depth, 0xff),
      buildSpineProof(depth, Math.ceil(depth / 8)),
      SPINE_CONFIG,
    )
    expect(v.isFullyConsumed()).toBe(false) // healthy, and nothing visited yet
    expect(() => v.performOneOperation({ tag: 'Lookup', key: new Uint8Array([0x10]) })).toThrow(RangeError)
    expect(() => v.isFullyConsumed()).toThrow(/StrictBatchAVLVerifier\.isFullyConsumed.*indeterminate/)
    expect(() => v.digest()).toThrow(/indeterminate/)
    // The one method that still answers: no verification failure was recorded.
    expect(v.getLastFailReason()).toBeNull()
  })
})
