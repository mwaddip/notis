import { describe, expect, it } from 'vitest'
import { BatchAVLProver, type ProverOperationResult } from '../src/prover.js'
import { AvlVerifyError, newLeaf, type LeafNode, type Operation } from '@ergots/avltree'
import { KEY_LENGTHS, lowKey, randomKey, randomTree, reportOf, rng, successfulBatch } from './helpers/tree-harness.js'
import { SEVEN_KEYS, keyOf, keylessRight, pivot, sevenKeyProver, stubRight } from './helpers/tree-surgery.js'

const SEEDS = 12
const FIRST = SEVEN_KEYS[0]

describe('a recorded neighbor lookup is a Lookup (prover)', () => {
  for (const kl of KEY_LENGTHS) {
    it(`same proof bytes, digest and value as plain Lookups; neighbors match the sorted-list oracle — keyLength ${kl}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed * 7919 + kl)
        const { prover: a, model } = randomTree(r, kl)
        const b = new BatchAVLProver(kl, null)
        b.restoreRoot(a.root, a.height)
        const batch = successfulBatch(r, model, 40)
        batch.ops.forEach((op, i) => {
          const where = `seed ${seed} op ${i} ${op.tag}`
          // An unrecorded lookup of a key the next operation does not touch
          // must leave A's proof untouched too.
          a.unauthenticatedLookupWithNeighbors(randomKey(r, kl))
          if (op.tag === 'Lookup') {
            // Interleaved unrecorded lookups must leave A's proof untouched.
            const unrecorded = a.unauthenticatedLookupWithNeighbors(op.key)
            const recorded = a.performLookupWithNeighbors(op.key)
            const plain = b.performOneOperation(op)
            expect(recorded.success, where).toBe(true)
            expect(plain.success, where).toBe(true)
            const report = reportOf(recorded)
            expect(report, where).toEqual(batch.neighbors[i])
            expect(unrecorded, where).toEqual(report)
            expect(plain.success && plain.value, where).toEqual(report.found ? report.value : null)
          } else {
            expect(a.performOneOperation(op).success, where).toBe(true)
            expect(b.performOneOperation(op).success, where).toBe(true)
          }
        })
        expect(a.generateProof(), `seed ${seed}`).toEqual(b.generateProof())
        expect(a.digest(), `seed ${seed}`).toEqual(b.digest())
      }
    })
  }
})

describe('neighbor lookups throw exactly what performOneOperation throws (prover)', () => {
  const kl = 32
  const codeOf = (f: () => unknown): string => {
    try {
      f()
    } catch (e) {
      if (e instanceof AvlVerifyError) return e.code
      throw e
    }
    return 'no throw'
  }
  const cases: [string, Uint8Array][] = [
    ['all-zero key (−inf)', new Uint8Array(kl)],
    ['all-0xFF key (+inf)', new Uint8Array(kl).fill(0xff)],
    ['short all-zero key (fires the −inf gate first)', new Uint8Array(kl - 1)],
    ['short non-zero key', new Uint8Array(kl - 1).fill(0x11)],
    ['long non-zero key', new Uint8Array(kl + 1).fill(0x11)],
  ]
  for (const [name, badKey] of cases) {
    it(name, () => {
      const p = new BatchAVLProver(kl, null)
      const expected = codeOf(() => p.performOneOperation({ tag: 'Lookup', key: badKey }))
      expect(expected).not.toBe('no throw')
      expect(codeOf(() => p.performLookupWithNeighbors(badKey))).toBe(expected)
      expect(codeOf(() => p.unauthenticatedLookupWithNeighbors(badKey))).toBe(expected)
    })
  }
})

describe('neighbor lookups on the tree edges (prover)', () => {
  it('the empty tree reports both neighbors null, recorded and unrecorded', () => {
    for (const kl of KEY_LENGTHS) {
      const p = new BatchAVLProver(kl, null)
      expect(p.unauthenticatedLookupWithNeighbors(lowKey(kl))).toEqual({ found: false, prevKey: null, nextKey: null })
      expect(p.performLookupWithNeighbors(lowKey(kl))).toEqual({ success: true, found: false, prevKey: null, nextKey: null })
    }
  })

  for (const kl of KEY_LENGTHS) {
    it(`a range walk over the 0xFF tag ends in null, not the +inf sentinel — keyLength ${kl}`, () => {
      const p = new BatchAVLProver(kl, null)
      for (const n of [1, 2, 3]) {
        const k = new Uint8Array(kl)
        k[0] = 0xff
        k[1] = n
        p.performOneOperation({ tag: 'Insert', key: k, value: new Uint8Array([n]) })
      }
      p.generateProof()
      const lower = new Uint8Array(kl)
      lower[0] = 0xff // 0xFF 00…00: below every 0xFF-tagged key
      const first = p.performLookupWithNeighbors(lower)
      if (!first.success || first.found) throw new Error('the lower bound should be absent')
      const seen: number[] = []
      let next = first.nextKey
      while (next !== null && next[0] === 0xff) {
        const step = p.performLookupWithNeighbors(next)
        if (!step.success || !step.found) throw new Error('a walked key should be present')
        seen.push(step.value[0]!)
        next = step.nextKey
      }
      expect(seen).toEqual([1, 2, 3])
      expect(next).toBeNull()
    })
  }

  it('returned buffers are copies, on both paths and both report shapes', () => {
    const p = sevenKeyProver()
    const present = p.performLookupWithNeighbors(keyOf(20))
    if (!present.success || !present.found || present.nextKey === null) throw new Error('expected a present key with a successor')
    const absent = p.performLookupWithNeighbors(keyOf(25))
    if (!absent.success || absent.found || absent.prevKey === null || absent.nextKey === null) {
      throw new Error('expected an absent key between two real keys')
    }
    const unrecorded = [p.unauthenticatedLookupWithNeighbors(keyOf(20)), p.unauthenticatedLookupWithNeighbors(keyOf(25))]
    for (const r of [present, absent, ...unrecorded]) {
      if (r.found) r.value.fill(0)
      else r.prevKey?.fill(0)
      r.nextKey?.fill(0)
    }
    expect(p.unauthenticatedLookupWithNeighbors(keyOf(20))).toEqual({
      found: true,
      value: new Uint8Array([20]),
      nextKey: keyOf(30),
    })
    expect(p.unauthenticatedLookupWithNeighbors(keyOf(25))).toEqual({
      found: false,
      prevKey: keyOf(20),
      nextKey: keyOf(30),
    })
  })
})

describe('neighbor lookups on invariant-violating trees (prover)', () => {
  it('a label stub on the path: recorded gives { success: false }, unrecorded throws', () => {
    const base = sevenKeyProver()
    const p = pivot(base.root, keyOf(FIRST))
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(stubRight(base.root, p), base.height)
    expect(() => prover.unauthenticatedLookupWithNeighbors(p.key!)).toThrow(/label stub/)
    expect(prover.performLookupWithNeighbors(p.key!)).toEqual({ success: false })
    // The failed recorded lookup left the prover's `found` set (the reset
    // happens at the next operation's entry); the unrecorded walk must not
    // read it.
    expect(prover.unauthenticatedLookupWithNeighbors(keyOf(FIRST))).toEqual({
      found: true,
      value: new Uint8Array([FIRST]),
      nextKey: keyOf(20),
    })
  })

  it('a key-less internal node on the path throws, in either descent mode', () => {
    const base = sevenKeyProver()
    const p = pivot(base.root, keyOf(FIRST))
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(keylessRight(base.root, p), base.height)
    // Found mode: p.key equals the pivot's key, so the walk turns right into the key-less node.
    expect(() => prover.unauthenticatedLookupWithNeighbors(p.key!)).toThrow(/without key/)
    // Search mode: just above p.key, so the walk turns right at the pivot without a match.
    const above = new Uint8Array(p.key!)
    above[31] = above[31]! + 1
    expect(() => prover.unauthenticatedLookupWithNeighbors(above)).toThrow(/without key/)
  })

  it('the recorded lookup honors the proof-cycle fail-stop (P3)', () => {
    const base = sevenKeyProver()
    const p = pivot(base.root, keyOf(FIRST))
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(keylessRight(base.root, p), base.height)
    // Search mode (a key above the pivot's), where the reference fails too.
    expect(() => prover.performLookupWithNeighbors(keyOf(SEVEN_KEYS[4]))).toThrow(/InternalNode\.key is undefined/)
    expect(() => prover.performLookupWithNeighbors(keyOf(FIRST))).toThrow(/performLookupWithNeighbors.*indeterminate/)
    expect(prover.unauthenticatedLookupWithNeighbors(keyOf(FIRST)).found).toBe(true)
  })

  it('a successful Lookup that observed other than one leaf throws and fails stop', () => {
    // Unreachable with the real engine, which calls keyMatchesLeaf exactly once
    // for a successful Lookup; a stubbed perform drives the guard both ways.
    const leaf = newLeaf(keyOf(FIRST), new Uint8Array([FIRST]), keyOf(20))
    for (const calls of [0, 2]) {
      const prover = sevenKeyProver()
      const perform = (_op: Operation, onLeaf?: (leaf: LeafNode, matches: boolean) => void): ProverOperationResult => {
        for (let i = 0; i < calls; i++) onLeaf?.(leaf, true)
        return { success: true, value: null }
      }
      Object.assign(prover, { perform }) // shadows the private method on this instance
      expect(() => prover.performLookupWithNeighbors(keyOf(FIRST))).toThrow(`observed ${calls} leaves, not 1`)
      expect(() => prover.generateProof()).toThrow(/indeterminate/)
    }
  })
})
