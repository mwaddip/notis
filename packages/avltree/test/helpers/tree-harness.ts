/**
 * Shared machinery for the 0.5.0 suites: a seeded PRNG, byte helpers, random
 * trees (Inserts, then Removes — sometimes all of them), a generator of
 * operation batches that all succeed, and a sorted-list oracle for neighbor
 * reports. No Buffer / node:* — these run under jsdom too.
 */
import { BatchAVLProver } from '../../src/prover.js'
import type { NeighborLookup, NeighborLookupResult } from '../../src/neighbors.js'
import { compareBytes, type Operation } from '@ergots/avltree'

export const KEY_LENGTHS = [32, 65] as const

/** Deterministic PRNG (mulberry32), as in prover-property.test.ts. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randInt(r: () => number, n: number): number {
  return Math.floor(r() * n)
}

export function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** A key strictly inside the sentinels; leading byte 1..6 so keys cluster. */
export function randomKey(r: () => number, keyLength: number): Uint8Array {
  const k = new Uint8Array(keyLength)
  for (let i = 0; i < keyLength; i++) k[i] = randInt(r, 256)
  k[0] = 1 + randInt(r, 6)
  return k
}

/** A value of the fixed length, or 0..8 bytes when variable. */
export function randomValue(r: () => number, valueLengthOpt: number | null): Uint8Array {
  const v = new Uint8Array(valueLengthOpt ?? randInt(r, 9))
  for (let i = 0; i < v.length; i++) v[i] = randInt(r, 256)
  return v
}

/** 0x00…01 — the key just above the −inf sentinel. Never a real key here. */
export function lowKey(keyLength: number): Uint8Array {
  const k = new Uint8Array(keyLength)
  k[keyLength - 1] = 1
  return k
}

/** 0xFF…FE — the key just below the +inf sentinel. Never a real key here. */
export function highKey(keyLength: number): Uint8Array {
  const k = new Uint8Array(keyLength).fill(0xff)
  k[keyLength - 1] = 0xfe
  return k
}

function i64Bytes(x: bigint): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigInt64(0, x, false)
  return b
}

function readI64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, false)
}

/** The tree's contents, hex key → value. Equal-length hex sorts in byte order. */
export class TreeModel {
  readonly values = new Map<string, Uint8Array>()
  constructor(readonly keyLength: number) {}

  has(key: Uint8Array): boolean {
    return this.values.has(toHex(key))
  }
  get(key: Uint8Array): Uint8Array | null {
    return this.values.get(toHex(key)) ?? null
  }
  set(key: Uint8Array, value: Uint8Array): void {
    this.values.set(toHex(key), value)
  }
  delete(key: Uint8Array): void {
    this.values.delete(toHex(key))
  }
  sortedKeys(): Uint8Array[] {
    return [...this.values.keys()].sort().map(fromHex)
  }

  /** The report a neighbor lookup of `key` must produce against these contents. */
  neighbors(key: Uint8Array): NeighborLookup {
    const keys = this.sortedKeys()
    const found = keys.findIndex((k) => compareBytes(k, key) >= 0)
    const at = found === -1 ? keys.length : found
    const here = keys[at]
    if (here !== undefined && compareBytes(here, key) === 0) {
      return { found: true, value: this.get(key)!, nextKey: keys[at + 1] ?? null }
    }
    return { found: false, prevKey: keys[at - 1] ?? null, nextKey: here ?? null }
  }
}

/**
 * A prover over random keys: Inserts, then Removes of a random subset — all
 * of them one time in ten, an emptied tree — rebased with generateProof() so
 * its proof cycle is clean. `model` mirrors the contents.
 */
export function randomTree(
  r: () => number,
  keyLength: number,
  valueLengthOpt: number | null = null,
): { prover: BatchAVLProver; model: TreeModel } {
  const prover = new BatchAVLProver(keyLength, valueLengthOpt)
  const model = new TreeModel(keyLength)
  const n = randInt(r, 120)
  for (let i = 0; i < n; i++) {
    const k = randomKey(r, keyLength)
    const v = randomValue(r, valueLengthOpt)
    if (prover.performOneOperation({ tag: 'Insert', key: k, value: v }).success) model.set(k, v)
  }
  const removeAll = randInt(r, 10) === 0
  for (const k of model.sortedKeys()) {
    if (removeAll || randInt(r, 3) === 0) {
      if (!prover.performOneOperation({ tag: 'Remove', key: k }).success) {
        throw new Error('randomTree: Remove of a present key failed')
      }
      model.delete(k)
    }
  }
  prover.generateProof()
  return { prover, model }
}

export interface PlannedBatch {
  readonly ops: Operation[]
  /** For each Lookup, the report it must produce; undefined for other operations. */
  readonly neighbors: (NeighborLookup | undefined)[]
}

/**
 * `count` operations that all succeed, in order, on a tree whose contents
 * `model` describes — all eight variants, plus lookups at the first and last
 * real keys and next to both sentinels. Mutates `model` to the post-batch
 * contents. UpdateLongBy only when values may be 8 bytes.
 */
export function successfulBatch(
  r: () => number,
  model: TreeModel,
  count: number,
  valueLengthOpt: number | null = null,
): PlannedBatch {
  const kl = model.keyLength
  const ops: Operation[] = []
  const neighbors: (NeighborLookup | undefined)[] = []
  const present = (): Uint8Array | null => {
    const ks = model.sortedKeys()
    return ks.length === 0 ? null : ks[randInt(r, ks.length)]!
  }
  const anyKey = (): Uint8Array => {
    const p = present()
    return p !== null && randInt(r, 2) === 0 ? p : randomKey(r, kl)
  }
  const lookup = (key: Uint8Array): void => {
    ops.push({ tag: 'Lookup', key })
    neighbors.push(model.neighbors(key))
  }
  const push = (op: Operation): void => {
    ops.push(op)
    neighbors.push(undefined)
  }

  for (let i = 0; i < count; i++) {
    const roll = randInt(r, 12)
    const p = present()
    if (roll < 3) {
      lookup(anyKey())
    } else if (roll === 3) {
      const ks = model.sortedKeys()
      const special = [lowKey(kl), highKey(kl), ks[0], ks[ks.length - 1]].filter(
        (k): k is Uint8Array => k !== undefined,
      )
      lookup(special[randInt(r, special.length)]!)
    } else if (roll === 4) {
      const k = randomKey(r, kl)
      if (model.has(k)) {
        lookup(k)
      } else {
        const v = randomValue(r, valueLengthOpt)
        push({ tag: 'Insert', key: k, value: v })
        model.set(k, v)
      }
    } else if (roll === 5 && p !== null) {
      // Rolls 5 and 6 need a present key; on an empty model they fall through to the arms below.
      const v = randomValue(r, valueLengthOpt)
      push({ tag: 'Update', key: p, value: v })
      model.set(p, v)
    } else if (roll === 6 && p !== null) {
      push({ tag: 'Remove', key: p })
      model.delete(p)
    } else if (roll === 7) {
      const k = anyKey()
      const v = randomValue(r, valueLengthOpt)
      push({ tag: 'InsertOrUpdate', key: k, value: v })
      model.set(k, v)
    } else if (roll === 8) {
      const k = anyKey()
      push({ tag: 'RemoveIfExists', key: k })
      model.delete(k)
    } else if (roll === 9) {
      push({ tag: 'UnknownModification', key: anyKey() })
    } else if (valueLengthOpt === null || valueLengthOpt === 8) {
      const k = anyKey()
      const old = model.get(k)
      if (old === null) {
        const delta = BigInt(1 + randInt(r, 1000))
        push({ tag: 'UpdateLongBy', key: k, delta })
        model.set(k, i64Bytes(delta))
      } else if (old.length === 8 && readI64(old) > 0n && readI64(old) < 2n ** 62n) {
        const x = readI64(old)
        const choice = randInt(r, 3)
        const delta = choice === 0 ? -x : choice === 1 ? 0n : BigInt(1 + randInt(r, 1000))
        push({ tag: 'UpdateLongBy', key: k, delta })
        if (x + delta === 0n) model.delete(k)
        else model.set(k, i64Bytes(x + delta))
      } else {
        lookup(k)
      }
    } else {
      lookup(anyKey())
    }
  }
  return { ops, neighbors }
}

/** The report inside a successful neighbor result. */
export function reportOf(r: NeighborLookupResult): NeighborLookup {
  if (!r.success) throw new Error('neighbor lookup failed')
  return r.found
    ? { found: true, value: r.value, nextKey: r.nextKey }
    : { found: false, prevKey: r.prevKey, nextKey: r.nextKey }
}
