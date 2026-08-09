import { describe, it, expect } from 'vitest';
import {
  cumulativeWork,
  MAX_SATISFIABLE_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_BITS,
  EMPTY_STATE_ROOT,
} from '../src/index.js';
import type { BlockHeader } from '../src/index.js';

/**
 * `cumulativeWork` reads exactly one field. Building a full `BlockHeader` per
 * case would bury that, and every other field is irrelevant to the sum — so the
 * fixture varies the one thing under test and fills the rest with values that
 * are inside the header domain, not with junk that could be mistaken for the
 * input being probed.
 */
function header(powTargetBits: number): BlockHeader {
  return {
    protocolVersion: 1,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    subBlockRoot: '11'.repeat(32),
    utxoTxRoot: '22'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits,
    createdAt: 1_754_700_000_000,
  };
}

describe('cumulativeWork — the honest path is unchanged', () => {
  it('sums 2^targetBits over the segment', () => {
    expect(cumulativeWork([])).toBe(0n);
    expect(cumulativeWork([header(10)])).toBe(1024n);
    expect(cumulativeWork([header(10), header(10)])).toBe(2048n);
    expect(cumulativeWork([header(5), header(6)])).toBe(96n);
  });

  it('counts the live network difficulty', () => {
    // The only value `expectedTarget` ever returns on any profile.
    expect(cumulativeWork([header(ORDERING_BLOCK_POW_TARGET_BITS)])).toBe(
      1n << BigInt(ORDERING_BLOCK_POW_TARGET_BITS),
    );
  });

  it('a heavier segment still compares greater', () => {
    const lighter = [header(10), header(10)];        // 2 * 2^10
    const heavier = [header(12)];                    // 1 * 2^12
    expect(cumulativeWork(heavier) > cumulativeWork(lighter)).toBe(true);
  });

  it('targetBits 0 contributes one expected hash, not zero', () => {
    // 0 is inside the arithmetic domain even though apply rejects it as below
    // ORDERING_BLOCK_POW_TARGET_FLOOR. This function bounds arithmetic, not
    // admission — a floor check here would be a consensus rule in the wrong
    // package.
    expect(cumulativeWork([header(0)])).toBe(1n);
    expect(cumulativeWork([header(1), header(2), header(3)])).toBe(14n);
  });
});

describe('cumulativeWork — the satisfiability ceiling', () => {
  it('is the PoW digest width, 256 bits', () => {
    // blake2b512(...).subarray(0, 32) — validation's hasLeadingZeroBits answers
    // false for any target past this, so a wider target is unmineable.
    expect(MAX_SATISFIABLE_TARGET_BITS).toBe(256);
  });

  it('counts the ceiling itself and drops the value one past it', () => {
    expect(cumulativeWork([header(MAX_SATISFIABLE_TARGET_BITS)])).toBe(
      1n << 256n,
    );
    expect(cumulativeWork([header(MAX_SATISFIABLE_TARGET_BITS + 1)])).toBe(0n);
  });
});

describe('cumulativeWork — the peer-controlled defect, both directions', () => {
  // Every value below is one `verifyHeaderFieldDomains` ADMITS: isU64Safe is
  // `Number.isSafeInteger(v) && v >= 0`, so a peer batch carrying any of them
  // passes findForkPoint's blockHash gate whole and arrives here.

  it('the allocating shift the fix removes really does allocate', () => {
    // Guard on the platform behaviour the fix exists for: 2^30-1 is the widest
    // shift V8 accepts, and it materialises a 128 MiB BigInt. If this ever stops
    // being true the ceiling's justification has changed, and this test says so.
    const widest = 1n << BigInt(2 ** 30 - 1);
    expect(widest > 0n).toBe(true);
  });

  it('the unguarded shift the fix replaced really does throw', () => {
    expect(() => 1n << BigInt(2 ** 30)).toThrow(RangeError);
    expect(() => 1n << BigInt(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it('2^30-1 contributes zero instead of allocating 128 MiB', () => {
    expect(cumulativeWork([header(2 ** 30 - 1)])).toBe(0n);
  });

  it('2^30 contributes zero instead of throwing RangeError', () => {
    expect(cumulativeWork([header(2 ** 30)])).toBe(0n);
  });

  it('the top of isU64Safe contributes zero instead of throwing', () => {
    expect(cumulativeWork([header(Number.MAX_SAFE_INTEGER)])).toBe(0n);
  });

  it('the accumulator cannot overflow either', () => {
    // Two headers at 2^30-2: each term is individually shiftable, and the SUM
    // is what exceeds V8's max BigInt. A per-term guard that let these through
    // would still throw here — measured 2026-08-09.
    expect(() => 1n << BigInt(2 ** 30 - 2)).not.toThrow();
    expect(cumulativeWork([header(2 ** 30 - 2), header(2 ** 30 - 2)])).toBe(0n);
  });

  it('one poisoned entry does not erase the rest of the segment', () => {
    // The stated convention is per-header, not batch-refusal: the honest
    // headers keep their work. A batch refusal would answer 0n here.
    const mixed = [header(10), header(2 ** 40), header(10)];
    expect(cumulativeWork(mixed)).toBe(2048n);
  });

  it('a segment of nothing but poison weighs nothing', () => {
    const allPoison = Array.from({ length: 40 }, () => header(2 ** 40));
    expect(cumulativeWork(allPoison)).toBe(0n);
  });
});

describe('cumulativeWork — total for every number its signature admits', () => {
  // `powTargetBits: number` admits all of these at the type level. None survives
  // findForkPoint today, but the signature is the totality claim, so each must
  // produce a bigint rather than a throw.
  const nonIntegers: ReadonlyArray<readonly [string, number]> = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['a float', 1.5],
    ['a negative', -1],
    ['negative zero', -0],
    ['past MAX_SAFE_INTEGER', 2 ** 53],
  ];

  for (const [label, bits] of nonIntegers) {
    it(`${label} contributes zero and does not throw`, () => {
      expect(() => cumulativeWork([header(bits)])).not.toThrow();
      // -0 is a safe integer and `-0 < 0` is false, so it counts as 2^0 = 1.
      expect(cumulativeWork([header(bits)])).toBe(Object.is(bits, -0) ? 1n : 0n);
    });
  }

  it('a segment mixing every non-integer with honest headers still sums', () => {
    const mixed = [
      header(10),
      ...nonIntegers.filter(([, b]) => !Object.is(b, -0)).map(([, b]) => header(b)),
      header(10),
    ];
    expect(cumulativeWork(mixed)).toBe(2048n);
  });
});
