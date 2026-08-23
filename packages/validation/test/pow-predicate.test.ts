import { describe, it, expect } from 'vitest';
import { meetsPowTarget, orderingPowTarget } from '../src/index.js';
import { wholeBitTarget } from './helpers.js';

/**
 * The bit-walk form of the admission rule, copied verbatim from `verify.ts`
 * at 695eb5d and kept as a differential oracle for `meetsPowTarget`
 * (VALIDATION_INTERFACE → meetsPowTarget).
 *
 * ⚠ **An oracle, not a second implementation to be maintained.** It is true only
 * while targets are whole bits. Anything that makes a target finer than one bit
 * makes this function false by construction, and the answer is then to delete it
 * and the three tests below that use it — never to patch it into agreement.
 */
function legacyHasLeadingZeroBits(hash: Uint8Array, targetBits: number): boolean {
  if (targetBits > hash.length * 8) return false;
  for (let i = 0; i < targetBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    const byte = hash[byteIdx];
    if (byte === undefined) return false;
    if ((byte & (1 << bitIdx)) !== 0) return false;
  }
  return true;
}

/** Deterministic LCG so a failure reproduces exactly. Not cryptographic. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

function nextDigest(rand: () => number): Uint8Array {
  const d = new Uint8Array(32);
  for (let i = 0; i < 32; i++) d[i] = rand();
  return d;
}

/** Force a digest with exactly `n` leading zero bits, to hit the boundary. */
function digestWithLeadingZeros(n: number, rand: () => number): Uint8Array {
  const d = nextDigest(rand);
  for (let i = 0; i < n; i++) {
    d[i >> 3] = d[i >> 3]! & ~(1 << (7 - (i % 8)));
  }
  if (n < 256) d[n >> 3] = d[n >> 3]! | (1 << (7 - (n % 8)));
  return d;
}

function newMeets(hash: Uint8Array, targetBits: number): boolean {
  const target = wholeBitTarget(targetBits);
  if (target === null) return false;
  return meetsPowTarget(hash, target);
}

// VALIDATION_INTERFACE → meetsPowTarget: the comparator against the 695eb5d
// bit walk at whole bits and at exact boundaries.
describe('meetsPowTarget — equivalence with the bit walk', () => {
  it('agrees on the three edges', () => {
    const zero = new Uint8Array(32);
    const ones = new Uint8Array(32).fill(0xff);

    // targetBits 0 accepts everything, both ways.
    expect(newMeets(ones, 0)).toBe(true);
    expect(legacyHasLeadingZeroBits(ones, 0)).toBe(true);

    // targetBits 256 accepts only the all-zero digest, both ways.
    expect(newMeets(zero, 256)).toBe(true);
    expect(legacyHasLeadingZeroBits(zero, 256)).toBe(true);
    expect(newMeets(ones, 256)).toBe(false);
    expect(legacyHasLeadingZeroBits(ones, 256)).toBe(false);

    // Past the digest width, unsatisfiable both ways — even for an all-zero digest.
    expect(newMeets(zero, 257)).toBe(false);
    expect(legacyHasLeadingZeroBits(zero, 257)).toBe(false);
  });

  it('agrees on random digests across every target in [0, 256]', () => {
    const rand = lcg(0xc0ffee);
    for (let targetBits = 0; targetBits <= 256; targetBits++) {
      for (let trial = 0; trial < 8; trial++) {
        const d = nextDigest(rand);
        expect(newMeets(d, targetBits)).toBe(legacyHasLeadingZeroBits(d, targetBits));
      }
    }
  });

  it('agrees at the exact boundary — a digest with exactly n leading zeros', () => {
    const rand = lcg(0xbeef);
    for (let n = 0; n <= 256; n++) {
      const d = digestWithLeadingZeros(n, rand);
      // Accepted at n, refused at n+1 — and the two implementations must agree on both.
      expect(newMeets(d, n)).toBe(legacyHasLeadingZeroBits(d, n));
      expect(newMeets(d, n + 1)).toBe(legacyHasLeadingZeroBits(d, n + 1));
      expect(newMeets(d, n)).toBe(true);
      expect(newMeets(d, n + 1)).toBe(false);
    }
  });

  // VALIDATION_INTERFACE → meetsPowTarget: a short hash is compared normally
  // while it has bytes and refused the moment it runs out still equal.
  it('refuses a short hash that equals the target prefix, accepts one strictly below', () => {
    const target = orderingPowTarget(3072)!; // 00 0f ff…
    const equalPrefix = target.slice(0, 31);
    const fullEqual = new Uint8Array(32);
    fullEqual.set(target);
    expect(meetsPowTarget(fullEqual, target)).toBe(true);
    expect(meetsPowTarget(equalPrefix, target)).toBe(false);

    const below = new Uint8Array(31); // 31 zero bytes — strictly below at byte 0
    expect(meetsPowTarget(below, target)).toBe(true);
  });

});
