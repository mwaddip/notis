/**
 * Nodes loaded on first access — AVLTREE_INTERFACE → Nodes loaded on first
 * access. The probe's five workloads as cases: a tree of a few thousand
 * leaves, the loads counted and asserted against a bound derived from the
 * tree's height. Plus: a `load` that throws reaches the caller; a label with
 * no row is not turned into a stub (it reaches the caller as the loader's
 * throw).
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  deserializeNode,
  label,
  newInternal,
  serializeNode,
  type AvlNode,
  type AvlTreeConfig,
} from '@ergots/avltree'
import { BatchAVLProver } from '../src/prover.js'
import { lazyRoot } from '../src/lazy-nodes.js'

const KL = 65
const CFG: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }
const N = 2000

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

function keyOf(i: number): Uint8Array {
  const h = createHash('blake2b512').update(`k${i}`).digest()
  const k = new Uint8Array(KL)
  k.set(h.subarray(0, 64), 1)
  k[0] = 1
  return k
}

interface Built {
  prover: BatchAVLProver
  keys: Uint8Array[]
  rows: Map<string, Uint8Array>
  rootLabel: Uint8Array
  height: number
}

function buildFullTree(): Built {
  const prover = new BatchAVLProver(KL, null)
  const keys: Uint8Array[] = []
  for (let i = 0; i < N; i++) {
    const k = keyOf(i)
    keys.push(k)
    const r = prover.performOneOperation({
      tag: 'Insert',
      key: k,
      value: new Uint8Array(40).fill(i & 0xff),
    })
    if (!r.success) throw new Error(`seed insert ${i} failed`)
  }
  prover.generateProof() // close the cycle; move oldTopNode forward
  const rootLabel = label(prover.root)
  const height = prover.height
  const rows = new Map<string, Uint8Array>()
  const walk = (n: AvlNode): void => {
    rows.set(hex(label(n)), serializeNode(n, CFG))
    if (n.kind === 'internal') {
      walk(n.left)
      walk(n.right)
    }
  }
  walk(prover.root)
  return { prover, keys, rows, rootLabel, height }
}

/** The reference eager loader: a plain, fully-materialized copy of the tree. */
function makeEagerCopy(rows: Map<string, Uint8Array>): (lab: Uint8Array) => AvlNode {
  const copy = (lab: Uint8Array): AvlNode => {
    const row = rows.get(hex(lab))
    if (!row) throw new Error(`row for ${hex(lab).slice(0, 16)}… not found`)
    const n = deserializeNode(row, CFG)
    if (n.kind !== 'internal') return n
    return newInternal(copy(label(n.left)), copy(label(n.right)), n.balance, n.key)
  }
  return copy
}

interface Case {
  name: string
  run: (prover: BatchAVLProver) => void
}

function makeCases(keys: Uint8Array[]): Case[] {
  const sorted = [...keys].sort((a, b) => Buffer.compare(a, b))
  const absent = keyOf(N + 7)
  return [
    {
      name: 'one present key — Lookup',
      run: (p) => {
        const r = p.performOneOperation({ tag: 'Lookup', key: keys[1234 % N]! })
        if (!r.success) throw new Error('present Lookup failed')
      },
    },
    {
      name: 'one absent key — Lookup',
      run: (p) => {
        const r = p.performOneOperation({ tag: 'Lookup', key: absent })
        if (!r.success) throw new Error('absent Lookup failed')
      },
    },
    {
      name: 'one key with neighbors',
      run: (p) => {
        const r = p.performLookupWithNeighbors(keys[321 % N]!)
        if (!r.success) throw new Error('neighbor Lookup failed')
      },
    },
    {
      name: '513 neighbor lookups in key order',
      run: (p) => {
        for (let i = 0; i < 513; i++) {
          const r = p.performLookupWithNeighbors(sorted[(100 + i) % N]!)
          if (!r.success) throw new Error('page Lookup failed')
        }
      },
    },
    {
      name: 'insert + remove',
      run: (p) => {
        const i = p.performOneOperation({
          tag: 'Insert',
          key: absent,
          value: new Uint8Array(40),
        })
        if (!i.success) throw new Error('insert failed')
        const r = p.performOneOperation({ tag: 'Remove', key: keys[77 % N]! })
        if (!r.success) throw new Error('remove failed')
      },
    },
  ]
}

describe('lazyRoot — proof and digest byte equality against a fully loaded tree', () => {
  const built = buildFullTree()
  const { keys, rows, rootLabel, height } = built
  const cases = makeCases(keys)
  const eagerCopy = makeEagerCopy(rows)

  for (const c of cases) {
    it(`${c.name}: lazy prover produces byte-identical proof and digest`, () => {
      let loads = 0
      const load = (lab: Uint8Array): Uint8Array => {
        loads++
        const row = rows.get(hex(lab))
        if (!row) throw new Error(`row for ${hex(lab).slice(0, 16)}… not found`)
        return row
      }
      const lazy = new BatchAVLProver(KL, null)
      lazy.restoreRoot(lazyRoot(rootLabel, load, CFG), height)
      c.run(lazy)
      const lazyProof = lazy.generateProof()
      const lazyDigest = lazy.digest()

      const eager = new BatchAVLProver(KL, null)
      eager.restoreRoot(eagerCopy(rootLabel), height)
      c.run(eager)
      const eagerProof = eager.generateProof()
      const eagerDigest = eager.digest()

      expect(lazyProof).toEqual(eagerProof)
      expect(lazyDigest).toEqual(eagerDigest)
      // Load count is bounded. If the invariant broke, it would explode
      // toward rows.size.
      expect(loads).toBeLessThan(rows.size)
    })
  }

  it('a single-key operation materializes at most O(height) rows', () => {
    // Bound: each level descended into loads its two children. The root is
    // one more load. Writes may rotate; keep the bound generous.
    const singleKeyBound = height * 2 + 10
    for (const name of [
      'one present key — Lookup',
      'one absent key — Lookup',
      'one key with neighbors',
    ]) {
      const c = cases.find((x) => x.name === name)!
      let loads = 0
      const load = (lab: Uint8Array): Uint8Array => {
        loads++
        const row = rows.get(hex(lab))
        if (!row) throw new Error('row not found')
        return row
      }
      const lazy = new BatchAVLProver(KL, null)
      lazy.restoreRoot(lazyRoot(rootLabel, load, CFG), height)
      c.run(lazy)
      lazy.generateProof()
      expect(loads, name).toBeLessThanOrEqual(singleKeyBound)
    }
  })
})

describe('lazyRoot — load errors reach the caller, label-less rows are not turned into stubs', () => {
  const built = buildFullTree()
  const { rows, rootLabel, keys, height } = built

  it('a load that throws reaches the operation caller', () => {
    const err = new Error('storage is down')
    const load = (lab: Uint8Array): Uint8Array => {
      // Serve only the root; the first descent raises.
      const row = rows.get(hex(lab))
      if (!row) throw err
      // The lazyRoot invocation itself only loads the root; descents happen
      // when the engine reads a child, so trigger from a descent.
      if (hex(lab) !== hex(rootLabel)) throw err
      return row
    }
    const prover = new BatchAVLProver(KL, null)
    prover.restoreRoot(lazyRoot(rootLabel, load, CFG), height)
    expect(() => prover.performOneOperation({ tag: 'Lookup', key: keys[0]! })).toThrow(/storage is down/)
  })

  it('a label with no row is the caller\'s corruption, surfaced as its throw', () => {
    // Build a loader that answers only the root. A descent for any lookup
    // reaches a child whose row the loader cannot answer.
    const load = (lab: Uint8Array): Uint8Array => {
      const row = rows.get(hex(lab))
      if (!row) throw new Error(`no row for ${hex(lab).slice(0, 8)}`)
      if (hex(lab) === hex(rootLabel)) return row
      throw new Error('child row missing')
    }
    const prover = new BatchAVLProver(KL, null)
    prover.restoreRoot(lazyRoot(rootLabel, load, CFG), height)
    expect(() => prover.performOneOperation({ tag: 'Lookup', key: keys[0]! })).toThrow(/child row missing/)
  })
})
