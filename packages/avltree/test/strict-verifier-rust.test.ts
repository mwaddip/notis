import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BatchAVLProver } from '../src/prover.js'
import { StrictBatchAVLVerifier } from '../src/strict-verifier.js'
import type { Operation } from '@ergots/avltree'
import { fromHex, toHex } from './helpers/tree-harness.js'

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

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
}

// Every proof in these fixtures was written by ergo_avltree_rust's prover. A
// replay that answers true has regenerated that proof byte for byte.
describe('StrictBatchAVLVerifier — regeneration reproduces the Rust prover', () => {
  it('answers true on every corpus fixture that replays fully, false on every other', () => {
    const dir = resolve(FIXTURES, 'avltree')
    const files = jsonFiles(dir)
    expect(files.length).toBe(50)
    let replayedFully = 0
    for (const f of files) {
      const j = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'))
      const ops: Operation[] = j.operations.map(jsonToOp)
      const v = new StrictBatchAVLVerifier(fromHex(j.startingDigestHex), fromHex(j.proofHex), j.config)
      let failed = v.digest() === null
      const results: (string | null)[] = []
      for (const op of ops) {
        if (failed) break
        const r = v.performOneOperation(op)
        if (!r.success) {
          failed = true
          break
        }
        results.push(r.value === null ? null : toHex(r.value))
      }
      if (j.expectedNewDigestHex === null) {
        expect(failed, f).toBe(true)
        expect(v.isFullyConsumed(), f).toBe(false)
      } else {
        expect(failed, f).toBe(false)
        expect(results, f).toEqual(j.expectedResultsHex)
        expect(toHex(v.digest()!), f).toBe(j.expectedNewDigestHex)
        expect(v.isFullyConsumed(), f).toBe(true)
        replayedFully++
      }
    }
    expect(replayedFully).toBe(42)
  })

  it('answers true on every proof cycle of the prover fixtures', () => {
    const dir = resolve(FIXTURES, 'prover')
    const files = jsonFiles(dir)
    expect(files.length).toBe(10)
    let cycles = 0
    for (const f of files) {
      const j = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'))
      const config = { keyLength: j.config.keyLength, valueLengthOpt: j.config.valueLengthOpt }
      // The first cycle starts from a fresh prover's tree: one sentinel leaf.
      let digest = new BatchAVLProver(config.keyLength, config.valueLengthOpt).digest()
      let from = 0
      j.genProofAfter.forEach((after: number, i: number) => {
        const at = `${f} cycle ${i}`
        const v = new StrictBatchAVLVerifier(digest, fromHex(j.expectedProofs[i]), config)
        const ops: Operation[] = j.operations.slice(from, after + 1).map(jsonToOp)
        for (const op of ops) expect(v.performOneOperation(op).success, at).toBe(true)
        expect(toHex(v.digest()!), at).toBe(j.expectedDigests[i])
        expect(v.isFullyConsumed(), at).toBe(true)
        digest = fromHex(j.expectedDigests[i])
        from = after + 1
        cycles++
      })
    }
    expect(cycles).toBe(18)
  })

  it('answers false on the partial fixture, which fails at its recorded operation', () => {
    const j = JSON.parse(readFileSync(resolve(FIXTURES, 'partial/insert-fail-at-3-of-5.json'), 'utf-8'))
    const v = new StrictBatchAVLVerifier(fromHex(j.starting_digest_hex), fromHex(j.proof_hex), j.config)
    let completed = 0
    for (const op of j.operations.map(jsonToOp) as Operation[]) {
      if (!v.performOneOperation(op).success) break
      completed++
    }
    expect(completed).toBe(j.expected_ops_completed)
    expect(v.isFullyConsumed()).toBe(false)
  })
})
