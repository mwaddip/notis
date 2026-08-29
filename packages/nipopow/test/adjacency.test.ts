import { describe, it, expect } from 'vitest';
import { proveWithReader } from '../src/prover.js';
import { verifyProof } from '../src/verify.js';
import { level } from '@dagsocial/validation';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  DEVNET_POW_TARGET_BITS,
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
});
