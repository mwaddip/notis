import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/prover.js'
import { BatchAVLVerifier, CoreWithNeighbors } from '../src/verifier.js'
import {
  AvlVerifyError,
  label,
  newLeaf,
  verifyAvlBatch,
  type LeafNode,
  type Operation,
} from '@ergots/avltree'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'
import { KEY_LENGTHS, lowKey, randomTree, reportOf, rng, successfulBatch } from './helpers/tree-harness.js'
import { keyOf } from './helpers/tree-surgery.js'

const SEEDS = 12
const KL = 32
const CONFIG = { keyLength: KL, valueLengthOpt: null }

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** A prover over keys 10..50 (value = [b]), rebased to a clean proof cycle. */
function fiveKeyProver(kl = KL): BatchAVLProver {
  const p = new BatchAVLProver(kl, null)
  for (const b of [10, 20, 30, 40, 50]) {
    p.performOneOperation({ tag: 'Insert', key: keyOf(b, kl), value: new Uint8Array([b]) })
  }
  p.generateProof()
  return p
}

describe('a verifier neighbor lookup consumes the proof exactly as a Lookup', () => {
  for (const kl of KEY_LENGTHS) {
    it(`same results and digests as plain Lookups; neighbors match the sorted-list oracle — keyLength ${kl}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed * 104729 + kl)
        const { prover, model } = randomTree(r, kl)
        const before = prover.digest()
        const batch = successfulBatch(r, model, 40)
        const oneGo = prover.generateProofForOperations(batch.ops)
        if (!oneGo.success) throw new Error(`seed ${seed}: the harness batch failed on the prover`)
        const config = { keyLength: kl, valueLengthOpt: null }
        const a = new BatchAVLVerifier(before, oneGo.proof, config)
        const b = new BatchAVLVerifier(before, oneGo.proof, config)
        batch.ops.forEach((op, i) => {
          const where = `seed ${seed} op ${i} ${op.tag}`
          const plain = b.performOneOperation(op)
          expect(plain.success, where).toBe(true)
          if (op.tag === 'Lookup') {
            const report = reportOf(a.performLookupWithNeighbors(op.key))
            expect(report, where).toEqual(batch.neighbors[i])
            expect(plain.success && plain.value, where).toEqual(report.found ? report.value : null)
          } else {
            expect(a.performOneOperation(op).success, where).toBe(true)
          }
          expect(a.digest(), where).toEqual(b.digest())
        })
        expect(a.digest(), `seed ${seed}`).toEqual(oneGo.digest)
        expect(verifyAvlBatch(before, oneGo.proof, config, batch.ops)?.newDigest, `seed ${seed}`).toEqual(oneGo.digest)
      }
    })
  }

  it('the empty tree reports both neighbors null', () => {
    for (const kl of KEY_LENGTHS) {
      const p = new BatchAVLProver(kl, null)
      const before = p.digest()
      const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: lowKey(kl) }])
      if (!oneGo.success) throw new Error('prover lookup failed')
      const v = new BatchAVLVerifier(before, oneGo.proof, { keyLength: kl, valueLengthOpt: null })
      expect(v.performLookupWithNeighbors(lowKey(kl))).toEqual({ success: true, found: false, prevKey: null, nextKey: null })
    }
  })

  it('validates and poisons like a Lookup', () => {
    const p = fiveKeyProver()
    const before = p.digest()
    const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(20) }])
    if (!oneGo.success) throw new Error('prover lookup failed')
    const v = new BatchAVLVerifier(before, oneGo.proof, CONFIG)
    // Same shape gate, and same code, as performOneOperation.
    let shapeError: unknown
    try {
      v.performLookupWithNeighbors(new Uint8Array(KL - 1).fill(1))
    } catch (e) {
      shapeError = e
    }
    expect(shapeError).toBeInstanceOf(AvlVerifyError)
    expect((shapeError as AvlVerifyError).code).toBe('operation-key-length-mismatch')
    expect(v.getLastFailReason()).toBeNull()
    expect(v.performLookupWithNeighbors(new Uint8Array(KL))).toEqual({ success: false })
    expect(v.getLastFailReason()).toBe('key-out-of-bounds')
    expect(v.performLookupWithNeighbors(keyOf(20))).toEqual({ success: false })
  })

  it('an engine throw inside a neighbor lookup leaves the verifier unusable', () => {
    const depth = 100_000
    const v = new BatchAVLVerifier(buildSpineDigest(depth, 0xff), buildSpineProof(depth, Math.ceil(depth / 8)), SPINE_CONFIG)
    expect(() => v.performLookupWithNeighbors(new Uint8Array([0x10]))).toThrow(RangeError)
    expect(() => v.performLookupWithNeighbors(new Uint8Array([0x10]))).toThrow(/indeterminate/)
    expect(() => v.performOneOperation({ tag: 'Lookup', key: new Uint8Array([0x10]) })).toThrow(/indeterminate/)
  })

  it('a successful Lookup that observed other than one leaf throws and leaves the verifier unusable', () => {
    // Unreachable with the real engine, which calls keyMatchesLeaf exactly once
    // for a successful Lookup; a stubbed core perform drives the guard both ways.
    const p = fiveKeyProver()
    const before = p.digest()
    const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(20) }])
    if (!oneGo.success) throw new Error('prover lookup failed')
    const leaf = newLeaf(keyOf(20), new Uint8Array([20]), keyOf(30))
    for (const calls of [0, 2]) {
      const v = new BatchAVLVerifier(before, oneGo.proof, CONFIG)
      const perform = (_op: Operation, onLeaf?: (leaf: LeafNode, matches: boolean) => void): Uint8Array | null => {
        for (let i = 0; i < calls; i++) onLeaf?.(leaf, true)
        return null
      }
      Object.assign((v as unknown as { core: object }).core, { perform }) // shadows VerifierCore's private perform
      expect(() => v.performLookupWithNeighbors(keyOf(20))).toThrow(`observed ${calls} leaves, not 1`)
      expect(() => v.digest()).toThrow(/indeterminate/)
    }
  })
})

describe('the neighbors are authenticated', () => {
  for (const kl of KEY_LENGTHS) {
    const config = { keyLength: kl, valueLengthOpt: null }

    it(`a proof whose leaf carries an altered nextLeafKey never anchors — keyLength ${kl}`, () => {
      const p = fiveKeyProver(kl)
      const before = p.digest()
      const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(20, kl) }])
      if (!oneGo.success) throw new Error('prover lookup failed')
      const pattern = new Uint8Array(2 * kl)
      pattern.set(keyOf(20, kl), 0) // the leaf's key, then its nextLeafKey
      pattern.set(keyOf(30, kl), kl)
      const at = indexOf(oneGo.proof, pattern)
      expect(at).toBeGreaterThanOrEqual(0)
      const tampered = new Uint8Array(oneGo.proof)
      tampered[at + kl] = tampered[at + kl]! ^ 1
      const v = new BatchAVLVerifier(before, tampered, config)
      expect(v.digest()).toBeNull()
      expect(v.getLastFailReason()).toBe('digest-mismatch')
      expect(v.performLookupWithNeighbors(keyOf(20, kl))).toEqual({ success: false })
    })

    it(`a proof for one lookup cannot vouch for a key in another gap — keyLength ${kl}`, () => {
      const p = fiveKeyProver(kl)
      const before = p.digest()
      const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(25, kl) }]) // the gap after 20
      if (!oneGo.success) throw new Error('prover lookup failed')
      const v = new BatchAVLVerifier(before, oneGo.proof, config)
      expect(v.performLookupWithNeighbors(keyOf(45, kl))).toEqual({ success: false }) // the gap after 40
      expect(v.getLastFailReason()).toBe('leaf-key-out-of-order')
    })

    it(`a neighbor lookup whose direction bits are cut off fails and poisons — keyLength ${kl}`, () => {
      const p = fiveKeyProver(kl)
      const before = p.digest()
      const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(30, kl) }])
      if (!oneGo.success) throw new Error('prover lookup failed')
      const v = new BatchAVLVerifier(before, oneGo.proof.subarray(0, oneGo.proof.length - 1), config)
      expect(v.digest()).not.toBeNull()
      expect(v.performLookupWithNeighbors(keyOf(30, kl))).toEqual({ success: false })
      expect(v.getLastFailReason()).toBe('directions-exhausted')
      expect(v.digest()).toBeNull()
    })
  }

  it('the verifier observer sees a leaf only after the range check approved it', () => {
    // Not observable through the public API: a failed check fails the lookup
    // before the report is read. Pinned here so a report is read only from a
    // leaf that keyMatchesLeaf's leaf-position check approved (for a present
    // key, only key == leaf.key). The rest of the report rests on the digest's
    // provenance.
    const p = fiveKeyProver()
    const before = p.digest()
    const oneGo = p.generateProofForOperations([{ tag: 'Lookup', key: keyOf(20) }])
    if (!oneGo.success) throw new Error('prover lookup failed')
    const core = new CoreWithNeighbors(before, oneGo.proof, CONFIG)
    type Hooks = { keyMatchesLeaf(key: Uint8Array, leaf: LeafNode): { ok: boolean } }
    const seen: boolean[] = []
    const hooks = (
      core as unknown as { buildCallbacks(onLeaf: (leaf: LeafNode, matches: boolean) => void): Hooks }
    ).buildCallbacks((_leaf, matches) => seen.push(matches))
    const leaf = newLeaf(keyOf(20), new Uint8Array([20]), keyOf(30))
    expect(hooks.keyMatchesLeaf(keyOf(45), leaf).ok).toBe(false) // 45 lies outside [20, 30)
    expect(seen).toEqual([])
    expect(hooks.keyMatchesLeaf(keyOf(25), leaf).ok).toBe(true) // 25 lies inside, and is absent
    expect(seen).toEqual([false])
  })

  it("a present key's nextKey is not checked (as in both references): it rests on the digest's provenance", () => {
    // Pins reference-faithful behavior. On a match, keyMatchesLeaf returns ok
    // without comparing leaf.nextLeafKey, exactly as Rust's key_matches_leaf
    // (batch_avl_verifier.rs:258-259 @568e7c3) and scrypto 3.0.0's
    // keyMatchesLeaf do. So a one-leaf digest whose leaf has nextLeafKey <= key
    // anchors, and a found neighbor lookup reports a nextKey that is not above
    // the key. Only a digest without honest provenance commits to such a leaf.
    // Adding a local nextLeafKey check here would make this verifier reject
    // lookups that both references accept: a verdict divergence from both.
    const k = keyOf(0x70)
    const value = new Uint8Array([0xab])
    const cases = [
      ['equal to the key', new Uint8Array(k)],
      ['below the key', keyOf(0x60)],
    ] as const
    for (const [name, nextLeafKey] of cases) {
      const where = `nextLeafKey ${name}`
      const digest = new Uint8Array(33) // a one-leaf tree: height byte 0
      digest.set(label(newLeaf(k, value, nextLeafKey)), 0)
      // Packed proof: LEAF token, key, nextLeafKey, u32 BE value length, value,
      // END_OF_TREE. A lone leaf has no internal node, so no direction bits.
      const proof = new Uint8Array([0x02, ...k, ...nextLeafKey, 0, 0, 0, value.length, ...value, 0x04])
      const v = new BatchAVLVerifier(digest, proof, CONFIG)
      expect(v.digest(), where).not.toBeNull()
      expect(v.performLookupWithNeighbors(k), where).toEqual({ success: true, found: true, value, nextKey: nextLeafKey })
      // The same verdict as a plain Lookup on a fresh verifier over the same proof.
      const plain = new BatchAVLVerifier(digest, proof, CONFIG)
      expect(plain.performOneOperation({ tag: 'Lookup', key: k }), where).toEqual({ success: true, value })
      expect(v.digest(), where).toEqual(plain.digest())
    }
  })
})

describe('verifier neighbor reports are copies', () => {
  it('mutating a returned value and nextKey leaves later digests intact', () => {
    // Lookup(20) with neighbors, then Insert(25): addNode rebuilds leaf 20 from its live fields.
    const p = fiveKeyProver()
    const before = p.digest()
    const ops: Operation[] = [
      { tag: 'Lookup', key: keyOf(20) },
      { tag: 'Insert', key: keyOf(25), value: new Uint8Array([25]) },
    ]
    const oneGo = p.generateProofForOperations(ops)
    if (!oneGo.success) throw new Error('prover batch failed')
    const v = new BatchAVLVerifier(before, oneGo.proof, CONFIG)
    const r = v.performLookupWithNeighbors(keyOf(20))
    if (!r.success || !r.found || r.nextKey === null) throw new Error('expected a present key with a successor')
    r.value.fill(0xee)
    r.nextKey.fill(0xee)
    expect(v.performOneOperation(ops[1]!).success).toBe(true)
    expect(v.digest()).toEqual(verifyAvlBatch(before, oneGo.proof, CONFIG, ops)?.newDigest)
  })
})

describe('a failed operation mid-batch (documented asymmetry)', () => {
  it('the prover omits it and carries on; the verifier replaying it poisons', () => {
    const p = fiveKeyProver()
    const before = p.digest()
    const ops: Operation[] = [
      { tag: 'Insert', key: keyOf(20), value: new Uint8Array([9]) }, // fails: 20 exists
      { tag: 'Lookup', key: keyOf(40) },
    ]
    expect(p.performOneOperation(ops[0]!)).toEqual({ success: false })
    expect(p.performOneOperation(ops[1]!).success).toBe(true)
    const v = new BatchAVLVerifier(before, p.generateProof(), CONFIG)
    expect(v.performOneOperation(ops[0]!)).toEqual({ success: false })
    expect(v.performOneOperation(ops[1]!)).toEqual({ success: false })
  })
})
