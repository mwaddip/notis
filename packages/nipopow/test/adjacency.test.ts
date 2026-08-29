import { describe, it, expect } from 'vitest';
import { proveWithReader } from '../src/prover.js';
import { verifyProof } from '../src/verify.js';
import { level } from '@dagsocial/validation';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  DEVNET_POW_TARGET_BITS,
  DEVNET_RETARGET,
} from './helpers.js';

// NIPOPOW_INTERFACE → verifyProof. The prove-then-verify round trip over deterministic
// chains at five lengths and five (m, k) pairs, rule 6's strict adjacency included.
describe('strict-adjacency property test', () => {
  const profile = devnetProfile();
  const mkParams = [
    { m: 1, k: 1 },
    { m: 2, k: 3 },
    { m: 3, k: 5 },
    { m: 6, k: 10 },
    { m: 10, k: 10 },
  ];

  const chainLengths = [20, 50, 100, 150, 200];

  let totalIterations = 0;

  for (const len of chainLengths) {
    for (const params of mkParams) {
      if (len < params.m + params.k) continue;

      it(`chain=${len}, m=${params.m}, k=${params.k}: prove → verify passes`, () => {
        const chain = buildMinedChain({ count: len });
        const reader = makeReader(chain);
        const proof = proveWithReader(reader, params);
        const result = verifyProof(proof, profile);
        if (!result.ok) {
          const levels = chain.headers.map(h => level(h, DEVNET_POW_TARGET_BITS));
          console.error('ADJACENCY FAILURE', {
            chainLen: len,
            m: params.m,
            k: params.k,
            reason: result.reason,
            index: (result as any).index,
            levels,
          });
        }
        expect(result.ok).toBe(true);
        totalIterations++;
      });
    }
  }

  // Include forced high-level headers
  it('chain with forced high-level headers passes', () => {
    const forceLevels = new Map<number, number>();
    forceLevels.set(10, 3);
    forceLevels.set(20, 4);
    forceLevels.set(30, 3);
    forceLevels.set(50, 5);
    const chain = buildMinedChain({ count: 80, forceLevels });
    const reader = makeReader(chain);
    for (const params of mkParams) {
      if (80 < params.m + params.k) continue;
      const proof = proveWithReader(reader, params);
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(true);
      totalIterations++;
    }
  });

  // Long level-0 runs (no forced levels, just a long chain where most blocks are level 0)
  it('chain with long level-0 runs passes', () => {
    const chain = buildMinedChain({ count: 200 });
    const reader = makeReader(chain);
    const proof = proveWithReader(reader, { m: 6, k: 10 });
    const result = verifyProof(proof, profile);
    expect(result.ok).toBe(true);
    totalIterations++;
  });

  // A chain with no-level headers: stretched stamps walk the target below the
  // anchor, so some PoW-valid hits exceed the yardstick → null level → vector
  // unchanged across that header. TYPES_INTERFACE → Interlink vector.
  it('chain with no-level headers proves and verifies, vector unchanged', () => {
    // 200× idealMs stamps: target walks to floor (2304) by block 7.
    // At 2304, ~7/8 of PoW-valid hits exceed the anchor yardstick (3072) → null level
    const chain = buildMinedChain({ count: 50, stampIntervalMs: 200 * 60_000 });

    // Confirm the chain has at least one no-level header
    const levels = chain.headers.map(h => level(h, DEVNET_RETARGET.anchorBits));
    const nullCount = levels.filter(lvl => lvl === null).length;
    expect(nullCount).toBeGreaterThan(0);

    // The interlink vector is unchanged across a no-level header
    for (let i = 1; i < chain.headers.length; i++) {
      if (levels[i] === null) {
        continue;
      }
    }
    // Verify that no-level headers have the same interlinks as the previous header
    for (let i = 1; i < chain.popowHeaders.length; i++) {
      const prev = chain.popowHeaders[i - 1]!;
      const cur = chain.popowHeaders[i]!;
      if (levels[i - 1] === null) {
        // The vector was NOT updated by the no-level parent
        // Actually, updateInterlinks uses the PARENT's level, so if parent has null level,
        // the CURRENT block's vector is unchanged from the parent's
        expect(cur.interlinks).toEqual(prev.interlinks);
      }
    }

    // Prove and verify
    const stretchProfile = {
      ...profile,
      nowMs: 1_000_000_000,
    };
    const reader = makeReader(chain);
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const result = verifyProof(proof, stretchProfile);
    expect(result.ok).toBe(true);
  });
});
