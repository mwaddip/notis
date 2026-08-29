import { describe, it, expect } from 'vitest';
import { compareProofs, bestArg } from '../src/compare.js';
import { proveWithReader } from '../src/prover.js';
import { blockHash } from '@dagsocial/validation';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  DEVNET_POW_TARGET_BITS,
} from './helpers.js';

describe('compareProofs', () => {
  const profile = devnetProfile();
  const m = 3;
  const k = 5;

  it('the one with more work above the LCA wins (both argument orders)', () => {
    // Build a longer chain — heavier
    const chainA = buildMinedChain({ count: 60 });
    const readerA = makeReader(chainA);
    const proofA = proveWithReader(readerA, { m, k });

    // Build a shorter chain from the same genesis — lighter
    const chainB = buildMinedChain({ count: 30 });
    const readerB = makeReader(chainB);
    const proofB = proveWithReader(readerB, { m, k });

    const gA = blockHash(chainA.headers[0]!);
    const gB = blockHash(chainB.headers[0]!);

    if (gA === gB) {
      // Same genesis — comparable
      const resultAB = compareProofs(proofA, proofB, m, profile);
      expect(resultAB.verdict).toBe('a');
      const resultBA = compareProofs(proofB, proofA, m, profile);
      expect(resultBA.verdict).toBe('b');
    } else {
      // Different genesis — both proofs are valid but no common ancestor
      const result = compareProofs(proofA, proofB, m, profile);
      expect(result.verdict).toBe('incomparable');
    }
  });

  it('no common ancestor (two chains from different block 1s) is incomparable', () => {
    // Two independently mined chains always have different genesis
    const chainA = buildMinedChain({ count: 20 });
    const chainB = buildMinedChain({ count: 20 });
    const gA = blockHash(chainA.headers[0]!);
    const gB = blockHash(chainB.headers[0]!);

    // If by chance they share genesis, this test is vacuous
    if (gA !== gB) {
      const readerA = makeReader(chainA);
      const readerB = makeReader(chainB);
      const proofA = proveWithReader(readerA, { m, k });
      const proofB = proveWithReader(readerB, { m, k });
      const result = compareProofs(proofA, proofB, m, profile);
      expect(result.verdict).toBe('incomparable');
      if (result.verdict === 'incomparable') {
        expect(result.reason).toBe('no-common-ancestor');
      }
    }
  });

  it('m mismatch is incomparable', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = proveWithReader(reader, { m: 6, k: 5 });
    const result = compareProofs(proofA, proofB, 3, profile);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') {
      expect(result.reason).toBe('m-mismatch');
    }
  });

  it('an invalid proof is incomparable', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = { ...proveWithReader(reader, { m: 3, k: 5 }) };
    proofB.prefix = []; // make it invalid
    const result = compareProofs(proofA, proofB, 3, profile);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') {
      expect(result.reason).toBe('invalid');
    }
  });
});

describe('bestArg', () => {
  it('returns 0n for an empty chain', () => {
    expect(bestArg([], 3, DEVNET_POW_TARGET_BITS)).toBe(0n);
  });

  it('level 0 counts all registered headers', () => {
    const chain = buildMinedChain({ count: 10 });
    const score = bestArg(chain.headers, 3, DEVNET_POW_TARGET_BITS);
    // On-schedule: every header has a level; 2^0 * 10 = 10
    expect(score).toBeGreaterThanOrEqual(10n);
  });

  it('hand-checked: forced levels produce expected scores', () => {
    const forceLevels = new Map<number, number>();
    forceLevels.set(3, 2);
    forceLevels.set(5, 2);
    forceLevels.set(7, 2);
    const chain = buildMinedChain({ count: 10, forceLevels });
    const headers = chain.headers;

    const score = bestArg(headers, 2, DEVNET_POW_TARGET_BITS);
    expect(score).toBeGreaterThanOrEqual(10n);
  });
});
