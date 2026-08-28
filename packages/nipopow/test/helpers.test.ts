import { describe, it, expect } from 'vitest';
import { blockHash } from '@dagsocial/validation';
import { buildMinedChain, buildMinedChainFresh } from './helpers.js';

describe('buildMinedChain memo', () => {
  it('memoized result is byte-identical to a fresh build (count=20)', () => {
    const memoized = buildMinedChain({ count: 20 });
    const fresh = buildMinedChainFresh({ count: 20 });

    expect(memoized.headers.length).toBe(fresh.headers.length);
    for (let i = 0; i < fresh.headers.length; i++) {
      expect(blockHash(memoized.headers[i]!)).toBe(blockHash(fresh.headers[i]!));
      expect(memoized.interlinksPerHeader[i]).toEqual(fresh.interlinksPerHeader[i]);
    }
  });

  it('memoized result is byte-identical to a fresh build (count=50)', () => {
    const memoized = buildMinedChain({ count: 50 });
    const fresh = buildMinedChainFresh({ count: 50 });

    expect(memoized.headers.length).toBe(fresh.headers.length);
    for (let i = 0; i < fresh.headers.length; i++) {
      expect(blockHash(memoized.headers[i]!)).toBe(blockHash(fresh.headers[i]!));
      expect(memoized.interlinksPerHeader[i]).toEqual(fresh.interlinksPerHeader[i]);
    }
  });

  it('memoized result is byte-identical under a forced-level key', () => {
    const forceLevels = new Map<number, number>();
    forceLevels.set(3, 2);
    forceLevels.set(5, 3);

    const memoized = buildMinedChain({ count: 15, forceLevels });
    const fresh = buildMinedChainFresh({ count: 15, forceLevels });

    expect(memoized.headers.length).toBe(fresh.headers.length);
    for (let i = 0; i < fresh.headers.length; i++) {
      expect(blockHash(memoized.headers[i]!)).toBe(blockHash(fresh.headers[i]!));
      expect(memoized.interlinksPerHeader[i]).toEqual(fresh.interlinksPerHeader[i]);
    }
  });
});
