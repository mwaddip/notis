/**
 * Over one tree and one list of operations, this package's prover and both
 * verifiers against the tarball's own: proofs, digests and neighbor reports
 * equal. This is the one suite that may call the tarball's features
 * (@ergots/avltree's own `performLookupWithNeighbors`,
 * `lookupWithNeighbors`, `StrictBatchAVLVerifier`); main deletes it at the
 * 0.7.0 bump.
 */
import { describe, expect, it } from 'vitest'
import {
  BatchAVLProver as ErgotsProver,
  BatchAVLVerifier as ErgotsBatchAVLVerifier,
  StrictBatchAVLVerifier as ErgotsStrict,
  type AvlTreeConfig,
  type Operation,
} from '@ergots/avltree'
import { BatchAVLVerifier } from '../src/verifier.js'
import { StrictBatchAVLVerifier } from '../src/strict-verifier.js'
import { randomTree, rng, successfulBatch, KEY_LENGTHS } from './helpers/tree-harness.js'

const SEEDS = 5

describe('@dagsocial/avltree and @ergots/avltree 0.6.0 answer the same bytes', () => {
  for (const kl of KEY_LENGTHS) {
    it(`prover: same proof, digest and neighbor reports — keyLength ${kl}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed * 7919 + kl)
        const { prover: ours, model } = randomTree(r, kl)
        const theirs = new ErgotsProver(kl, null)
        theirs.restoreRoot(ours.root, ours.height)
        const batch = successfulBatch(r, model, 25)
        for (let i = 0; i < batch.ops.length; i++) {
          const op = batch.ops[i]!
          const at = `seed ${seed} op ${i} ${op.tag}`
          if (op.tag === 'Lookup') {
            const a = ours.performLookupWithNeighbors(op.key)
            const b = theirs.performLookupWithNeighbors(op.key)
            expect(a, at).toEqual(b)
          } else {
            expect(ours.performOneOperation(op), at).toEqual(theirs.performOneOperation(op))
          }
        }
        expect(ours.generateProof(), `seed ${seed}`).toEqual(theirs.generateProof())
        expect(ours.digest(), `seed ${seed}`).toEqual(theirs.digest())
      }
    })

    it(`verifier: same digest, results and neighbor reports — keyLength ${kl}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed * 104729 + kl)
        const { prover, model } = randomTree(r, kl)
        const before = prover.digest()
        const { ops } = successfulBatch(r, model, 25)
        const made = prover.generateProofForOperations(ops)
        if (!made.success) throw new Error(`seed ${seed}: batch failed on prover`)
        const config: AvlTreeConfig = { keyLength: kl, valueLengthOpt: null }
        const ours = new BatchAVLVerifier(before, made.proof, config)
        const theirs = new ErgotsBatchAVLVerifier(before, made.proof, config)
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i]!
          const at = `seed ${seed} op ${i} ${op.tag}`
          if (op.tag === 'Lookup') {
            expect(ours.performLookupWithNeighbors(op.key), at).toEqual(theirs.performLookupWithNeighbors(op.key))
          } else {
            expect(ours.performOneOperation(op), at).toEqual(theirs.performOneOperation(op))
          }
          expect(ours.digest(), at).toEqual(theirs.digest())
        }
      }
    })

    it(`strict verifier: same digest, results and consumption — keyLength ${kl}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = rng(seed * 31337 + kl)
        const { prover, model } = randomTree(r, kl)
        const before = prover.digest()
        const { ops } = successfulBatch(r, model, 20)
        const made = prover.generateProofForOperations(ops)
        if (!made.success) throw new Error(`seed ${seed}: batch failed on prover`)
        const config: AvlTreeConfig = { keyLength: kl, valueLengthOpt: null }
        const ours = new StrictBatchAVLVerifier(before, made.proof, config)
        const theirs = new ErgotsStrict(before, made.proof, config)
        for (const op of ops as Operation[]) {
          const a = op.tag === 'Lookup' ? ours.performLookupWithNeighbors(op.key) : ours.performOneOperation(op)
          const b = op.tag === 'Lookup' ? theirs.performLookupWithNeighbors(op.key) : theirs.performOneOperation(op)
          expect(a).toEqual(b)
        }
        expect(ours.digest()).toEqual(theirs.digest())
        expect(ours.isFullyConsumed()).toBe(theirs.isFullyConsumed())
      }
    })
  }
})
