import { describe, it, expect } from 'vitest';
import { blockWork, cumulativeWork } from '../src/index.js';
import { cumulativeWork as typesCumulativeWork } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';

function header(powTargetBits: number): BlockHeader {
  return {
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    subBlockRoot: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits,
    createdAt: 0,
  };
}

describe('blockWork', () => {
  it('equals 2^targetBits at every integer target, exactly', () => {
    for (let bits = 0; bits <= 256; bits++) {
      expect(blockWork(bits)).toBe(1n << BigInt(bits));
    }
  });

  it('is 1 at targetBits 0 — every digest meets an all-ones target', () => {
    expect(blockWork(0)).toBe(1n);
  });

  it('is 2^256 at targetBits 256 — only the all-zero digest meets it', () => {
    expect(blockWork(256)).toBe(1n << 256n);
  });

  it('refuses exactly what powTarget refuses', () => {
    expect(blockWork(257)).toBeNull();
    expect(blockWork(-1)).toBeNull();
    expect(blockWork(1.5)).toBeNull();
    expect(blockWork(NaN)).toBeNull();
    expect(blockWork(Infinity)).toBeNull();
  });
});

describe('cumulativeWork', () => {
  it('sums the work of every in-domain header', () => {
    expect(cumulativeWork([header(10), header(10)])).toBe(2n * (1n << 10n));
  });

  it('skips an out-of-domain header rather than throwing', () => {
    expect(cumulativeWork([header(10), header(257)])).toBe(1n << 10n);
    expect(cumulativeWork([header(1.5)])).toBe(0n);
    expect(cumulativeWork([header(NaN)])).toBe(0n);
  });

  it('is 0 for no headers', () => {
    expect(cumulativeWork([])).toBe(0n);
  });

  // The move is faithful only if the two domains coincide. Asserted, not assumed.
  it('agrees with the types implementation it replaces, across the domain edges', () => {
    const cases = [0, 1, 10, 255, 256, 257, -1, 1.5, NaN, Infinity, 2 ** 31];
    for (const bits of cases) {
      expect(cumulativeWork([header(bits)])).toBe(typesCumulativeWork([header(bits)]));
    }
  });
});
