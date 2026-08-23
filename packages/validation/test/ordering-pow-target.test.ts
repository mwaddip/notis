import { describe, it, expect } from 'vitest';
import {
  orderingPowTarget,
  meetsPowTarget,
  blockWork,
  cumulativeWork,
} from '../src/index.js';
import { wholeBitTarget } from './helpers.js';

/** The 32-byte big-endian target as an integer. */
function asInt(t: Uint8Array): bigint {
  let v = 0n;
  for (const b of t) v = (v << 8n) | BigInt(b);
  return v;
}
/** R, the inclusive maximum plus one — the quantity the rule is stated over. */
function rootOf(scaledBits: number): bigint {
  const t = orderingPowTarget(scaledBits);
  expect(t).not.toBeNull();
  return asInt(t!) + 1n;
}

describe('orderingPowTarget', () => {
  // VALIDATION_INTERFACE → orderingPowTarget. Two exponentiations and a
  // comparison, sharing no code with the fixed-point path they check.
  it('satisfies the defining predicate on all 256 base values', () => {
    for (let f = 0; f < 256; f++) {
      const R = rootOf(f);
      const N = 1n << BigInt(65536 - f);
      expect(R ** 256n <= N).toBe(true);
      expect(N < (R + 1n) ** 256n).toBe(true);
    }
  });

  // A PRECONDITION, not evidence. For this implementation shape both sides
  // reduce to the same floor expression, so it passes with corrupted constants
  // too — it pins the factoring that makes the check above exhaustive, and says
  // nothing about the constants. VALIDATION_INTERFACE → orderingPowTarget.
  it('factors as a base value and a shift at every input in the domain', () => {
    const base: bigint[] = [];
    for (let f = 0; f < 256; f++) base.push(rootOf(f));
    for (let B = 0; B <= 65536; B++) {
      expect(rootOf(B)).toBe(base[B & 255]! >> BigInt(B >> 8));
    }
  });

  // §1 clause 3 is consensus and meetsPowTarget cannot detect its violation: a
  // minimal-width render at B=63358 gives a 2-byte target that admits a 2^248
  // digest the 32-byte target refuses.
  it('renders exactly 32 bytes at every input in the domain', () => {
    for (let B = 0; B <= 65536; B++) {
      expect(orderingPowTarget(B)!.length).toBe(32);
    }
  });

  it('refuses a digest that a minimal-width target would admit', () => {
    const target = orderingPowTarget(63358)!;
    const digest = new Uint8Array(32);
    digest[1] = 0x01; // ~2^240, far above the true target of 363
    expect(meetsPowTarget(digest, target)).toBe(false);
    expect(meetsPowTarget(digest, target.slice(30))).toBe(true); // the defect, pinned
  });

  // VALIDATION_INTERFACE → orderingPowTarget: the whole-bit expansion
  // `2^(256 − n) − 1`, checked against a byte-fill rendering that shares no
  // arithmetic with the fixed-point path.
  it('is the whole-bit expansion at every whole bit', () => {
    for (let n = 0; n <= 256; n++) {
      expect(orderingPowTarget(256 * n)).toEqual(wholeBitTarget(n));
    }
  });

  it('never increases across the domain', () => {
    let prev = rootOf(0);
    for (let B = 1; B <= 65536; B++) {
      const cur = rootOf(B);
      expect(cur <= prev).toBe(true);
      prev = cur;
    }
  });

  // Hand-derived from the predicate, not regenerated from this function.
  // 3073, 5984 and 6000 are not multiples of 256 — the case integer bits
  // cannot express, and the only place the fractional path is exercised.
  // 5984 is ORDERING_BLOCK_POW_TARGET_BITS, mainnet's and testnet's live
  // ordering target, so this row moves whenever that constant does —
  // TYPES_INTERFACE → Ordering block PoW.
  it.each([
    [0, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
    [1024, '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
    [3072, '000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
    [3073, '000ff4ecb59511ec8a5301ba217ef18dd7c2f409857956d475fdb171474700cc'],
    [5984, '0000018ace5422aa0db5ba7c55a192c9bb3e6ed61f2733304a346d8ed0c00dc8'],
    [6000, '0000017a11473eb0186d7d51023f6cda1f5ef42b66977960531e821b3497c046'],
    [63358, '000000000000000000000000000000000000000000000000000000000000016b'],
    [65536, '0000000000000000000000000000000000000000000000000000000000000000'],
  ])('derives the pinned target for scaledBits %i', (B, hex) => {
    expect(Buffer.from(orderingPowTarget(B)!).toString('hex')).toBe(hex);
  });

  it('stops resolving adjacent inputs at the representation edge', () => {
    expect(orderingPowTarget(63357)).toEqual(orderingPowTarget(63358));
    expect(orderingPowTarget(63356)).not.toEqual(orderingPowTarget(63357));
  });

  it.each([-1, 65537, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'refuses %p',
    (bad) => {
      expect(orderingPowTarget(bad as number)).toBeNull();
    },
  );
});

describe('blockWork under scaled bits', () => {
  it('is exactly 2^n at every whole bit', () => {
    for (let n = 0; n <= 256; n++) {
      expect(blockWork(256 * n)).toBe(1n << BigInt(n));
    }
  });

  it('accepts the whole scaled domain and refuses outside it', () => {
    expect(blockWork(65536)).not.toBeNull();
    expect(blockWork(65537)).toBeNull();
    expect(blockWork(-1)).toBeNull();
  });

  it('rises with difficulty between whole bits', () => {
    expect(blockWork(3073)!).toBeGreaterThan(blockWork(3072)!);
    expect(blockWork(3073)!).toBeLessThan(blockWork(3328)!);
  });

  // A header outside the domain contributes nothing rather than throwing.
  it('skips an out-of-domain header in a sum', () => {
    const hdr = (bits: number) => ({ powTargetBits: bits }) as never;
    expect(cumulativeWork([hdr(3072), hdr(65537), hdr(3072)])).toBe(2n * (1n << 12n));
  });
});
