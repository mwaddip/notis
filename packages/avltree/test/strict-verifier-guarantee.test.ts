import { describe, expect, it } from 'vitest'
import type { BatchAVLProver } from '../src/prover.js'
import { StrictBatchAVLVerifier } from '../src/strict-verifier.js'
import {
  label,
  type AvlNode,
  type AvlTreeConfig,
  type InternalNode,
  type Operation,
} from '@ergots/avltree'
import { randInt, randomKey, randomTree, randomValue, rng, successfulBatch, toHex } from './helpers/tree-harness.js'

/**
 * The guarantee under test (facts/avltree.md § StrictBatchAVLVerifier): from a
 * digest with honest provenance, after a replay in which every operation
 * succeeded, isFullyConsumed() is true if and only if the proof is byte for
 * byte the one BatchAVLProver writes for those operations.
 *
 * Every tree here is built by the prover from the empty tree, so every digest
 * has honest provenance.
 */

/** [keyLength, valueLengthOpt]. 65 is a key longer than a 32-byte label; 0 is a fixed empty value. */
const CONFIGS: [number, number | null][] = [
  [32, null],
  [65, null],
  [32, 8],
  [8, null],
  [8, 0],
  [1, null],
]
const SEEDS = 20

interface Case {
  readonly at: string
  readonly config: AvlTreeConfig
  readonly prover: BatchAVLProver
  /** The tree the proof cycle starts from. */
  readonly oldRoot: AvlNode
  readonly digest: Uint8Array
  readonly ops: Operation[]
  /** The prover's proof for `ops`, and the digest after them. */
  readonly canonical: Uint8Array
  readonly newDigest: Uint8Array
  readonly r: () => number
}

function makeCase(seed: number, keyLength: number, valueLengthOpt: number | null): Case {
  const r = rng(seed * 104729 + keyLength * 31 + (valueLengthOpt ?? 17))
  const { prover, model } = randomTree(r, keyLength, valueLengthOpt)
  const digest = prover.digest()
  const oldRoot = prover.oldTopNode
  const { ops } = successfulBatch(r, model, randInt(r, 25), valueLengthOpt)
  const made = prover.generateProofForOperations(ops)
  if (!made.success) throw new Error('the batch must succeed on the prover')
  return {
    at: `kl=${keyLength} vl=${valueLengthOpt} seed=${seed}`,
    config: { keyLength, valueLengthOpt },
    prover,
    oldRoot,
    digest,
    ops,
    canonical: made.proof,
    newDigest: made.digest,
    r,
  }
}

/** Replays `ops` over `proof`, Lookups as neighbor lookups. */
function replay(
  c: Case,
  proof: Uint8Array,
  ops: Operation[],
): { everyOperationSucceeded: boolean; digest: Uint8Array | null; fullyConsumed: boolean } {
  const v = new StrictBatchAVLVerifier(c.digest, proof, c.config)
  let ok = v.digest() !== null
  for (const op of ops) {
    if (!ok) break
    ok = (op.tag === 'Lookup' ? v.performLookupWithNeighbors(op.key) : v.performOneOperation(op)).success
  }
  return { everyOperationSucceeded: ok, digest: v.digest(), fullyConsumed: v.isFullyConsumed() }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => toHex(a) === toHex(b)

/**
 * The guarantee, for one candidate proof replayed with the case's operations:
 * if it replays to the right digest, the answer is whether its bytes are the
 * canonical proof's; if it does not, the answer is false. Returns whether it
 * replayed.
 */
function expectGuarantee(c: Case, candidate: Uint8Array, kind: string): boolean {
  const res = replay(c, candidate, c.ops)
  const replayed = res.everyOperationSucceeded && res.digest !== null && sameBytes(res.digest, c.newDigest)
  expect(res.fullyConsumed, `${c.at}: ${kind}`).toBe(replayed && sameBytes(candidate, c.canonical))
  return replayed
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/**
 * `proof` with the label token of internal node `n` replaced by `n` written in
 * full, its two children as labels: `03 label(left) 03 label(right) balance`.
 * The root label is unchanged, and so is key chaining: either way a label
 * resets it before the next leaf, and the balance byte leaves it as it is.
 * Null when `proof` has no such token.
 */
function writtenInFull(proof: Uint8Array, n: InternalNode): Uint8Array | null {
  const at = indexOfBytes(proof, new Uint8Array([0x03, ...label(n)]))
  if (at === -1) return null
  return new Uint8Array([
    ...proof.subarray(0, at),
    0x03,
    ...label(n.left),
    0x03,
    ...label(n.right),
    n.balance & 0xff,
    ...proof.subarray(at + 33),
  ])
}

function internalNodes(root: AvlNode): InternalNode[] {
  const out: InternalNode[] = []
  const stack: AvlNode[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.kind !== 'internal') continue
    out.push(n)
    stack.push(n.left, n.right)
  }
  return out
}

describe('StrictBatchAVLVerifier — the guarantee, both directions', () => {
  for (const [keyLength, valueLengthOpt] of CONFIGS) {
    it(`keyLength ${keyLength}, valueLengthOpt ${valueLengthOpt}`, () => {
      const replays = { appended: 0, extraOperation: 0, paddingBit: 0, writtenInFull: 0 }

      for (let seed = 1; seed <= SEEDS; seed++) {
        const c = makeCase(seed, keyLength, valueLengthOpt)

        // The honest proof answers true.
        const honest = replay(c, c.canonical, c.ops)
        expect(honest.everyOperationSucceeded, c.at).toBe(true)
        expect(toHex(honest.digest!), c.at).toBe(toHex(c.newDigest))
        expect(honest.fullyConsumed, c.at).toBe(true)

        // Bytes appended after the directions.
        for (const tail of [[0x00], [0xff], [0x00, 0x00, 0x00], [0xff, 0xff, 0xff]]) {
          if (expectGuarantee(c, new Uint8Array([...c.canonical, ...tail]), `appended ${tail}`)) replays.appended++
        }

        // The proof for these operations plus one more, which the caller never asks.
        const k = randomKey(c.r, keyLength)
        const extras: Operation[] = [
          { tag: 'Lookup', key: k },
          { tag: 'InsertOrUpdate', key: k, value: randomValue(c.r, valueLengthOpt) },
        ]
        for (const extra of extras) {
          const made = c.prover.generateProofForOperations([...c.ops, extra])
          if (!made.success) throw new Error(`${c.at}: the extended batch must succeed on the prover`)
          if (expectGuarantee(c, made.proof, `one more ${extra.tag}`)) replays.extraOperation++

          // The other way round: the caller asks one more operation than the proof carries.
          const asked = replay(c, c.canonical, [...c.ops, extra])
          expect(asked.fullyConsumed, `${c.at}: asking one more ${extra.tag}`).toBe(
            asked.everyOperationSucceeded && sameBytes(c.canonical, made.proof),
          )
        }

        // One more bit set in the last byte. A set bit that still replays is a padding bit.
        const last = c.canonical.length - 1
        for (let bit = 0; bit < 8; bit++) {
          if ((c.canonical[last]! & (1 << bit)) !== 0) continue
          const flipped = new Uint8Array(c.canonical)
          flipped[last] = flipped[last]! | (1 << bit)
          if (expectGuarantee(c, flipped, `last byte bit ${bit}`)) replays.paddingBit++
        }

        // An unvisited internal node written in full, one level and two levels.
        for (const n of internalNodes(c.oldRoot)) {
          const one = writtenInFull(c.canonical, n)
          if (one === null) continue
          if (expectGuarantee(c, one, 'node written in full')) replays.writtenInFull++
          const child = [n.left, n.right].find((x): x is InternalNode => x.kind === 'internal')
          const two = child === undefined ? null : writtenInFull(one, child)
          if (two !== null && expectGuarantee(c, two, 'two levels written in full')) replays.writtenInFull++
          break
        }

        // The step-by-step route writes the same proof. Last: it advances the prover.
        for (const op of c.ops) {
          const res = op.tag === 'Lookup' ? c.prover.performLookupWithNeighbors(op.key) : c.prover.performOneOperation(op)
          expect(res.success, c.at).toBe(true)
        }
        expect(toHex(c.prover.generateProof()), c.at).toBe(toHex(c.canonical))
      }

      // Each kind of tampered proof must actually have replayed somewhere:
      // those are the cases the check exists for.
      expect(replays.appended, 'appended bytes that replayed').toBeGreaterThan(0)
      expect(replays.extraOperation, 'extra operations that replayed').toBeGreaterThan(0)
      expect(replays.paddingBit, 'padding bits that replayed').toBeGreaterThan(0)
      expect(replays.writtenInFull, 'nodes written in full that replayed').toBeGreaterThan(0)
    })
  }
})
