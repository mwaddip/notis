import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BatchAVLProver } from '../src/prover.js'
import { StrictBatchAVLVerifier } from '../src/strict-verifier.js'
import { BatchAVLVerifier } from '../src/verifier.js'
import {
  AvlVerifyError,
  verifyAvlBatch,
  type AvlTreeConfig,
  type Operation,
} from '@ergots/avltree'
import { ViewSlicingBytes } from './helpers/buffer-like.js'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'
import { KEY_LENGTHS, TreeModel, fromHex, randInt, randomKey, randomTree, rng, successfulBatch } from './helpers/tree-harness.js'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function jsonToOp(o: { tag: string; keyHex: string; valueHex?: string; delta?: string | number }): Operation {
  const k = fromHex(o.keyHex)
  switch (o.tag) {
    case 'Lookup':
    case 'UnknownModification':
    case 'Remove':
    case 'RemoveIfExists':
      return { tag: o.tag, key: k }
    case 'Insert':
    case 'Update':
    case 'InsertOrUpdate':
      return { tag: o.tag, key: k, value: fromHex(o.valueHex ?? '') }
    case 'UpdateLongBy':
      return { tag: 'UpdateLongBy', key: k, delta: BigInt(o.delta ?? 0) }
    default:
      throw new Error(`unknown op tag ${o.tag}`)
  }
}

/** One call on a verifier: an operation, or a neighbor-reporting lookup. */
type Call = { kind: 'op'; op: Operation } | { kind: 'neighbors'; key: Uint8Array }

const asOps = (ops: Operation[]): Call[] => ops.map((op) => ({ kind: 'op', op }))
/** The same batch with every Lookup issued as a neighbor-reporting lookup. */
const withNeighborLookups = (ops: Operation[]): Call[] =>
  ops.map((op) => (op.tag === 'Lookup' ? { kind: 'neighbors', key: op.key } : { kind: 'op', op }))

/**
 * What a call did: its return value, or what it threw. Two throws are the same
 * outcome when they have the same class and, for AvlVerifyError, the same
 * code. The fail-stop error names its own class, so its text is compared only
 * as "says indeterminate".
 */
type Outcome =
  | { returned: unknown }
  | { threw: string; code: string | null; indeterminate: boolean }

function outcomeOf(f: () => unknown): Outcome {
  try {
    return { returned: f() }
  } catch (e) {
    if (!(e instanceof Error)) throw e
    return {
      threw: e.constructor.name,
      code: e instanceof AvlVerifyError ? e.code : null,
      indeterminate: /indeterminate/.test(e.message),
    }
  }
}

type Verifier = BatchAVLVerifier | StrictBatchAVLVerifier
const perform = (v: Verifier, c: Call): unknown =>
  c.kind === 'op' ? v.performOneOperation(c.op) : v.performLookupWithNeighbors(c.key)

/**
 * Builds both classes over the same inputs and makes the same calls on each.
 * After construction and after every call: the outcomes are equal, and so are
 * `digest()` and `getLastFailReason()`.
 */
function driveBoth(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  calls: Call[],
  at: string,
): void {
  const reference = outcomeOf(() => new BatchAVLVerifier(startingDigest, proof, config))
  const strict = outcomeOf(() => new StrictBatchAVLVerifier(startingDigest, proof, config))
  if (!('returned' in reference) || !('returned' in strict)) {
    expect(strict, `${at}: construction`).toEqual(reference)
    return
  }
  const r = reference.returned as BatchAVLVerifier
  const s = strict.returned as StrictBatchAVLVerifier
  const sameState = (where: string): void => {
    expect(outcomeOf(() => s.digest()), `${where}: digest()`).toEqual(outcomeOf(() => r.digest()))
    expect(s.getLastFailReason(), `${where}: getLastFailReason()`).toBe(r.getLastFailReason())
  }
  sameState(`${at}: after construction`)
  calls.forEach((c, i) => {
    const where = `${at}: call ${i}`
    expect(outcomeOf(() => perform(s, c)), where).toEqual(outcomeOf(() => perform(r, c)))
    sameState(where)
  })
}

describe('StrictBatchAVLVerifier — the same answers as BatchAVLVerifier', () => {
  it('over every corpus fixture and the partial fixture', () => {
    const dir = resolve(FIXTURES, 'avltree')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(50)
    for (const f of files) {
      const j = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'))
      const ops: Operation[] = j.operations.map(jsonToOp)
      const digest = fromHex(j.startingDigestHex)
      const proof = fromHex(j.proofHex)
      driveBoth(digest, proof, j.config, asOps(ops), f)
      driveBoth(digest, proof, j.config, withNeighborLookups(ops), `${f} (neighbor lookups)`)
    }
    const p = JSON.parse(readFileSync(resolve(FIXTURES, 'partial/insert-fail-at-3-of-5.json'), 'utf-8'))
    driveBoth(fromHex(p.starting_digest_hex), fromHex(p.proof_hex), p.config, asOps(p.operations.map(jsonToOp)), 'partial')
  })

  it('over random batches that succeed, and with a failing operation before or after them', () => {
    for (const keyLength of KEY_LENGTHS) {
      for (const valueLengthOpt of [null, 8] as const) {
        for (let seed = 1; seed <= 25; seed++) {
          const at = `kl=${keyLength} vl=${valueLengthOpt} seed=${seed}`
          const r = rng(seed * 7919 + keyLength)
          const { prover, model } = randomTree(r, keyLength, valueLengthOpt)
          const before = new TreeModel(keyLength)
          for (const k of model.sortedKeys()) before.set(k, model.get(k)!)
          const digest = prover.digest()
          const { ops } = successfulBatch(r, model, randInt(r, 30), valueLengthOpt)
          const made = prover.generateProofForOperations(ops)
          if (!made.success) throw new Error(`${at}: the batch must succeed on the prover`)
          const config: AvlTreeConfig = { keyLength, valueLengthOpt }
          const calls = withNeighborLookups(ops)
          driveBoth(digest, made.proof, config, calls, at)

          // An operation that fails, issued first (against the starting tree)
          // and last (against the final one). Both classes poison on it.
          const failing = (contents: TreeModel): Call[] => {
            const out: Call[] = [
              { kind: 'op', op: { tag: 'Lookup', key: new Uint8Array(keyLength) } }, // −inf sentinel
              { kind: 'neighbors', key: new Uint8Array(keyLength).fill(0xff) }, // +inf sentinel
            ]
            let absent = randomKey(r, keyLength)
            while (contents.has(absent)) absent = randomKey(r, keyLength)
            out.push({ kind: 'op', op: { tag: 'Update', key: absent, value: new Uint8Array(valueLengthOpt ?? 3) } })
            const present = contents.sortedKeys()[0]
            if (present !== undefined) {
              out.push({ kind: 'op', op: { tag: 'Insert', key: present, value: new Uint8Array(valueLengthOpt ?? 3) } })
            }
            return out
          }
          for (const bad of failing(before)) driveBoth(digest, made.proof, config, [bad, ...calls], `${at}: failing first`)
          for (const bad of failing(model)) driveBoth(digest, made.proof, config, [...calls, bad, ...calls], `${at}: failing last`)
        }
      }
    }
  })

  it('on shape errors, at construction and per operation', () => {
    const r = rng(42)
    const { prover, model } = randomTree(r, 32, 8)
    const digest = prover.digest()
    const { ops } = successfulBatch(r, model, 12, 8)
    const made = prover.generateProofForOperations(ops)
    if (!made.success) throw new Error('the batch must succeed on the prover')
    const good: AvlTreeConfig = { keyLength: 32, valueLengthOpt: 8 }
    const k = randomKey(r, 32)

    const badConfigs: AvlTreeConfig[] = [
      { keyLength: 0, valueLengthOpt: 8 },
      { keyLength: 32, valueLengthOpt: -1 },
      { keyLength: 32, valueLengthOpt: undefined as unknown as null },
      { keyLength: 32, valueLengthOpt: 8, maxNumOperations: 1, maxDeletes: 2 },
      { keyLength: 32, valueLengthOpt: 8, maxNumOperations: 1.5 },
    ]
    for (const config of badConfigs) driveBoth(digest, made.proof, config, [], `config ${JSON.stringify(config)}`)
    driveBoth(digest.subarray(0, 32), made.proof, good, [], 'short digest')
    // Two faults at once: the config's code comes first.
    driveBoth(digest.subarray(0, 32), made.proof, { keyLength: 0, valueLengthOpt: 8 }, [], 'two faults')

    const badCalls: Call[] = [
      { kind: 'op', op: { tag: 'Lookup', key: k.subarray(0, 31) } },
      { kind: 'neighbors', key: k.subarray(0, 31) },
      { kind: 'op', op: { tag: 'Insert', key: k, value: new Uint8Array(7) } },
      { kind: 'op', op: { tag: 'UpdateLongBy', key: k, delta: 2n ** 63n } },
      { kind: 'op', op: { tag: 'UpdateLongBy', key: k, delta: -(2n ** 63n) - 1n } },
    ]
    // Each shape error throws on both and poisons neither: the batch after it still replays.
    for (const bad of badCalls) driveBoth(digest, made.proof, good, [bad, ...withNeighborLookups(ops)], `bad call ${bad.kind}`)
  })

  it('after an engine throw: both are indeterminate, and neither reports a rejection', () => {
    const depth = 100_000
    const lookup: Operation = { tag: 'Lookup', key: new Uint8Array([0x10]) }
    const digest = buildSpineDigest(depth, 0xff)
    const proof = buildSpineProof(depth, Math.ceil(depth / 8))
    const asOp: Call = { kind: 'op', op: lookup }
    const asNeighbors: Call = { kind: 'neighbors', key: lookup.key }
    // The throwing call comes first as an operation, then first as a neighbor lookup.
    driveBoth(digest, proof, SPINE_CONFIG, [asOp, asOp, asNeighbors], 'deep spine, operation first')
    driveBoth(digest, proof, SPINE_CONFIG, [asNeighbors, asNeighbors, asOp], 'deep spine, neighbor lookup first')
  })
})

describe('StrictBatchAVLVerifier — the buffers it returns and receives', () => {
  const KL = 32
  const CONFIG: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }
  const key = (b: number): Uint8Array => {
    const k = new Uint8Array(KL)
    k[0] = b
    k[KL - 1] = b
    return k
  }

  /** Starting digest and proof for `ops` over a tree holding keys 10..50 (value = [b]). */
  function scenario(ops: Operation[]): { digest: Uint8Array; proof: Uint8Array } {
    const p = new BatchAVLProver(KL, null)
    for (const b of [10, 20, 30, 40, 50]) {
      p.performOneOperation({ tag: 'Insert', key: key(b), value: new Uint8Array([b]) })
    }
    p.generateProof()
    const digest = p.digest()
    const made = p.generateProofForOperations(ops)
    if (!made.success) throw new Error('scenario operations must succeed on the prover')
    return { digest, proof: made.proof }
  }

  it('returned values, neighbor keys and digests are copies', () => {
    // Lookup(20), then Insert(25): addNode rebuilds leaf 20 from its live value.
    const ops: Operation[] = [
      { tag: 'Lookup', key: key(20) },
      { tag: 'Insert', key: key(25), value: new Uint8Array([25]) },
    ]
    const { digest, proof } = scenario(ops)
    const expected = verifyAvlBatch(digest, proof, CONFIG, ops)?.newDigest

    const byOperation = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    const r = byOperation.performOneOperation(ops[0]!)
    if (!r.success || r.value === null) throw new Error('expected a value')
    r.value.fill(0xee)
    expect(byOperation.performOneOperation(ops[1]!).success).toBe(true)
    expect(byOperation.digest()).toEqual(expected)
    byOperation.digest()!.fill(0)
    expect(byOperation.digest()).toEqual(expected)
    expect(byOperation.isFullyConsumed()).toBe(true)

    const byNeighbors = new StrictBatchAVLVerifier(digest, proof, CONFIG)
    const n = byNeighbors.performLookupWithNeighbors(key(20))
    if (!n.success || !n.found || n.nextKey === null) throw new Error('expected a present key with a successor')
    n.value.fill(0xee)
    n.nextKey.fill(0xee)
    expect(byNeighbors.performOneOperation(ops[1]!).success).toBe(true)
    expect(byNeighbors.digest()).toEqual(expected)
    expect(byNeighbors.isFullyConsumed()).toBe(true)
  })

  it('owns its proof and config: caller mutation after construction changes nothing', () => {
    const ops: Operation[] = [
      { tag: 'Lookup', key: key(20) },
      { tag: 'Lookup', key: key(40) },
    ]
    const { digest, proof } = scenario(ops)
    const config: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }
    const bufferLike = new ViewSlicingBytes(proof) // slice() would be a view, as on a Buffer
    const v = new StrictBatchAVLVerifier(digest, bufferLike, config)
    bufferLike.fill(0) // the caller reuses its proof buffer
    config.keyLength = 99
    expect(v.performOneOperation(ops[0]!)).toEqual({ success: true, value: new Uint8Array([20]) })
    expect(v.performOneOperation(ops[1]!)).toEqual({ success: true, value: new Uint8Array([40]) })
    // The comparison reads the verifier's own copy of the proof, not the caller's zeroed one.
    expect(v.isFullyConsumed()).toBe(true)

    // A getter-backed config is read exactly once per field: no check-then-copy gap.
    const reads = { keyLength: 0, valueLengthOpt: 0, maxNumOperations: 0, maxDeletes: 0 }
    const getterConfig: AvlTreeConfig = {
      get keyLength() {
        reads.keyLength++
        return reads.keyLength === 1 ? KL : 0 // a second read would see an invalid length
      },
      get valueLengthOpt() {
        reads.valueLengthOpt++
        return null
      },
      get maxNumOperations() {
        reads.maxNumOperations++
        return undefined
      },
      get maxDeletes() {
        reads.maxDeletes++
        return undefined
      },
    }
    const g = new StrictBatchAVLVerifier(digest, proof, getterConfig)
    expect(reads).toEqual({ keyLength: 1, valueLengthOpt: 1, maxNumOperations: 1, maxDeletes: 1 })
    expect(g.performOneOperation(ops[0]!)).toEqual({ success: true, value: new Uint8Array([20]) })
  })
})
