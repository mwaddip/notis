import { describe, it, expect } from 'vitest';
import { blockWork, cumulativeWork } from '../src/index.js';
import type { BlockHeader } from '@dagsocial/types';

function header(powTargetBits: number): BlockHeader {
  return {
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits,
    createdAt: 0,
  };
}

describe('blockWork', () => {
  it('equals 2^n at every whole bit, exactly', () => {
    for (let n = 0; n <= 256; n++) {
      expect(blockWork(256 * n)).toBe(1n << BigInt(n));
    }
  });

  it('is 1 at scaledBits 0 — every digest meets an all-ones target', () => {
    expect(blockWork(0)).toBe(1n);
  });

  // The bottom of the band the contract names: below 2180 a 1/256-bit step can
  // buy no work at all, so difficulty moves and the quantity fork choice
  // selects on does not (VALIDATION_INTERFACE → blockWork / cumulativeWork).
  it('does not resolve a single step at the bottom of the domain', () => {
    expect(blockWork(1)).toBe(blockWork(0));
    expect(blockWork(255)).toBe(1n);
    expect(blockWork(256)).toBe(2n);
  });

  it('is 2^256 at scaledBits 65536 — only the all-zero digest meets it', () => {
    expect(blockWork(65536)).toBe(1n << 256n);
  });

  it('refuses exactly what orderingPowTarget refuses', () => {
    expect(blockWork(65537)).toBeNull();
    expect(blockWork(-1)).toBeNull();
    expect(blockWork(1.5)).toBeNull();
    expect(blockWork(NaN)).toBeNull();
    expect(blockWork(Infinity)).toBeNull();
  });
});

describe('cumulativeWork', () => {
  it('sums the work of every in-domain header', () => {
    expect(cumulativeWork([header(2560), header(2560)])).toBe(2n * (1n << 10n));
  });

  it('skips an out-of-domain header rather than throwing', () => {
    expect(cumulativeWork([header(2560), header(65537)])).toBe(1n << 10n);
    expect(cumulativeWork([header(1.5)])).toBe(0n);
    expect(cumulativeWork([header(NaN)])).toBe(0n);
  });

  it('is 0 for no headers', () => {
    expect(cumulativeWork([])).toBe(0n);
  });

  // One header per edge of the domain. Every whole-bit expectation is the
  // closed form `2^n`, which the sum reaches by dividing `2^256` by
  // `orderingPowTarget`'s expansion — so it shares no arithmetic with the code
  // it checks. Between whole bits there is no closed form, which is why the
  // rows sit on multiples of 256 and on the two ends.
  //
  // `2 ** 31` carries past its own edge: a sum that shifted by a header's own
  // `powTargetBits` instead of consulting the domain would allocate or throw
  // on that row rather than skip it (VALIDATION_INTERFACE → blockWork /
  // cumulativeWork).
  it('totals a single header to 2^n inside the domain and 0 outside, at every edge', () => {
    const cases: [number, bigint][] = [
      [0, 1n],
      // One 1/256-bit step above the floor buys nothing — the blind end of the
      // band, not a rounding artefact.
      [1, 1n],
      [256, 2n],
      [2560, 1024n],
      [65280, 1n << 255n],
      [65536, 1n << 256n],
      [65537, 0n],
      [-1, 0n],
      [1.5, 0n],
      [NaN, 0n],
      [Infinity, 0n],
      [2 ** 31, 0n],
    ];
    for (const [bits, expected] of cases) {
      expect(cumulativeWork([header(bits)]), `targetBits ${bits}`).toBe(expected);
    }
  });
});
