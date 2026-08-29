import { describe, it, expect } from 'vitest';
import {
  asertTargetBits,
  verifyCreatedAtOrder,
  verifyCreatedAtBound,
  orderingPowTarget,
} from '../src/index.js';
import type { RetargetParams } from '../src/index.js';
import type { BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION } from '@dagsocial/types';

const P: RetargetParams = {
  anchorBits: 5984,
  idealMs: 60_000,
  halflifeMs: 17_280_000,
  floorBits: 5120,
  ceilingBits: 65536,
};

const t_a = 1_700_000_000_000;

function makeHeader(over: Partial<BlockHeader>): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height: 2,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 3072,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// asertTargetBits — VALIDATION_INTERFACE → asertTargetBits
// ---------------------------------------------------------------------------

describe('asertTargetBits', () => {
  it('Δ = 0 at height 1 → anchorBits', () => {
    expect(asertTargetBits(P, t_a, { height: 1, createdAt: t_a })).toBe(5984);
  });

  it('Δ = 0 at one day on schedule → anchorBits', () => {
    expect(asertTargetBits(P, t_a, { height: 1441, createdAt: t_a + 86_400_000 })).toBe(5984);
  });

  it('1 ms fast (Δ = −1) → 5985 — floor rounds harder', () => {
    expect(asertTargetBits(P, t_a, { height: 2, createdAt: t_a + 60_000 - 1 })).toBe(5985);
  });

  it('1 ms slow (Δ = +1) → 5984 — no easing yet', () => {
    expect(asertTargetBits(P, t_a, { height: 2, createdAt: t_a + 60_000 + 1 })).toBe(5984);
  });

  it('a truncating division answers 5984 for both — the first pin tells them apart', () => {
    const fast = asertTargetBits(P, t_a, { height: 2, createdAt: t_a + 60_000 - 1 });
    const slow = asertTargetBits(P, t_a, { height: 2, createdAt: t_a + 60_000 + 1 });
    expect(fast).toBe(5985);
    expect(slow).toBe(5984);
    expect(fast).not.toBe(slow);
  });

  it('one day, one hour slow (Δ = 3 600 000) → 5931', () => {
    expect(asertTargetBits(P, t_a, { height: 1441, createdAt: t_a + 90_000_000 })).toBe(5931);
  });

  it('one day, one hour fast (Δ = −3 600 000) → 6038', () => {
    expect(asertTargetBits(P, t_a, { height: 1441, createdAt: t_a + 82_800_000 })).toBe(6038);
  });

  it('exact halflife Δ = −17 280 000 → 6240', () => {
    expect(asertTargetBits(P, t_a, { height: 289, createdAt: t_a })).toBe(6240);
  });

  it('exact halflife Δ = +17 280 000 → 5728', () => {
    expect(asertTargetBits(P, t_a, { height: 289, createdAt: t_a + 34_560_000 })).toBe(5728);
  });

  it('exact half-halflife Δ = +8 640 000 → 5856', () => {
    expect(asertTargetBits(P, t_a, { height: 289, createdAt: t_a + 25_920_000 })).toBe(5856);
  });

  it('Δ = +10 days clamps to the floor (5120)', () => {
    expect(asertTargetBits(P, t_a, { height: 289, createdAt: t_a + 881_280_000 })).toBe(5120);
  });

  it('Δ = −10 days is within the default ceiling', () => {
    const result = asertTargetBits(P, t_a, { height: 289, createdAt: t_a - 846_720_000 });
    expect(result).toBeLessThanOrEqual(65536);
    expect(result).toBeGreaterThan(P.anchorBits);
  });

  it('Δ = −10 days with ceilingBits 6000 clamps to 6000', () => {
    const P2 = { ...P, ceilingBits: 6000 };
    expect(asertTargetBits(P2, t_a, { height: 289, createdAt: t_a - 846_720_000 })).toBe(6000);
  });

  it('monotone in Δ over 200 evenly spaced values from −2 halflives to +2 halflives', () => {
    const results: number[] = [];
    const rangeMs = 4 * P.halflifeMs;
    for (let i = 0; i < 200; i++) {
      const deltaMs = Math.round(-2 * P.halflifeMs + (i / 199) * rangeMs);
      const createdAt = t_a + deltaMs + P.idealMs * 288;
      results.push(asertTargetBits(P, t_a, { height: 289, createdAt }));
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!).toBeLessThanOrEqual(results[i - 1]!);
    }
  });

  // ---- Reference cross-check: aserti3-2d ported in target space ----
  //
  // The BCH reference (`next_target_aserti3_2d`, spec 2020-11-15) works in
  // target space with a cubic approximation of 2^x; we work in bits space
  // with no approximation. The mapping (spec §2.1): our block 1 is the
  // reference's anchor-parent, our block 2 its anchor. For each unclamped
  // vector the reference target must lie within one 1/256-bit unit of ours:
  // `orderingPowTarget(B − 1) ≥ T_ref ≥ orderingPowTarget(B + 1)`.

  describe('reference cross-check', () => {
    function targetToBigInt(t: Uint8Array): bigint {
      let v = 0n;
      for (const b of t) v = (v << 8n) | BigInt(b);
      return v;
    }

    function nextTargetAserti3_2d(
      anchorTarget: bigint,
      timeDelta: bigint,
      heightDelta: bigint,
      halflife: bigint,
      idealBlockTime: bigint,
    ): bigint {
      const RADIX = 65536n;
      let exponent = (timeDelta - idealBlockTime * (heightDelta + 1n)) * RADIX / halflife;
      const numShifts = exponent >> 16n;
      exponent = exponent - numShifts * RADIX;
      const factor = ((195766423245049n * exponent
        + 971821376n * exponent * exponent
        + 5127n * exponent * exponent * exponent
        + (1n << 47n)) >> 48n) + RADIX;
      let nextTarget = anchorTarget * factor;
      if (numShifts < 0n) {
        nextTarget >>= -numShifts;
      } else {
        nextTarget <<= numShifts;
      }
      nextTarget >>= 16n;
      if (nextTarget <= 0n) return 1n;
      return nextTarget;
    }

    const anchorTarget = targetToBigInt(orderingPowTarget(P.anchorBits)!);
    const halflife = BigInt(P.halflifeMs);
    const ideal = BigInt(P.idealMs);

    const vectors = [
      { height: 1, createdAt: t_a },
      { height: 1441, createdAt: t_a + 86_400_000 },
      { height: 2, createdAt: t_a + 60_000 - 1 },
      { height: 2, createdAt: t_a + 60_000 + 1 },
      { height: 1441, createdAt: t_a + 90_000_000 },
      { height: 1441, createdAt: t_a + 82_800_000 },
      { height: 289, createdAt: t_a },
      { height: 289, createdAt: t_a + 34_560_000 },
      { height: 289, createdAt: t_a + 25_920_000 },
    ];

    for (const parent of vectors) {
      it(`height=${parent.height} offset=${parent.createdAt - t_a}`, () => {
        const B = asertTargetBits(P, t_a, parent);
        const timeDelta = BigInt(parent.createdAt) - BigInt(t_a);
        const heightDelta = BigInt(parent.height) - 2n;
        const T_ref = nextTargetAserti3_2d(anchorTarget, timeDelta, heightDelta, halflife, ideal);
        const T_hi = targetToBigInt(orderingPowTarget(B - 1)!);
        const T_lo = targetToBigInt(orderingPowTarget(B + 1)!);
        expect(T_ref).toBeLessThanOrEqual(T_hi);
        expect(T_ref).toBeGreaterThanOrEqual(T_lo);
      });
    }
  });

  // ---- Totality ----

  describe('totality', () => {
    it('NaN createdAt → does not throw', () => {
      expect(() => asertTargetBits(P, t_a, { height: 2, createdAt: NaN })).not.toThrow();
      expect(asertTargetBits(P, t_a, { height: 2, createdAt: NaN })).toBe(0);
    });

    it('negative stamp → does not throw', () => {
      expect(() => asertTargetBits(P, t_a, { height: 2, createdAt: -1 })).not.toThrow();
      expect(asertTargetBits(P, t_a, { height: 2, createdAt: -1 })).toBe(0);
    });

    it('non-integer height → does not throw', () => {
      expect(() => asertTargetBits(P, t_a, { height: 1.5, createdAt: t_a })).not.toThrow();
      expect(asertTargetBits(P, t_a, { height: 1.5, createdAt: t_a })).toBe(0);
    });

    it('parent.height = 0 → does not throw, returns a clamped value', () => {
      expect(() => asertTargetBits(P, t_a, { height: 0, createdAt: t_a })).not.toThrow();
      const result = asertTargetBits(P, t_a, { height: 0, createdAt: t_a });
      expect(result).toBeGreaterThanOrEqual(P.floorBits);
      expect(result).toBeLessThanOrEqual(P.ceilingBits);
    });

    it('NaN anchorCreatedAt → does not throw', () => {
      expect(() => asertTargetBits(P, NaN, { height: 2, createdAt: t_a })).not.toThrow();
    });

    it('non-object parent → does not throw', () => {
      expect(() => asertTargetBits(P, t_a, null as any)).not.toThrow();
      expect(() => asertTargetBits(P, t_a, 42 as any)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// verifyCreatedAtOrder — VALIDATION_INTERFACE → verifyCreatedAtOrder
// ---------------------------------------------------------------------------

describe('verifyCreatedAtOrder', () => {
  it('greater → true', () => {
    expect(verifyCreatedAtOrder(
      makeHeader({ createdAt: 1001 }),
      makeHeader({ createdAt: 1000 }),
    )).toBe(true);
  });

  it('equal → false (strict)', () => {
    expect(verifyCreatedAtOrder(
      makeHeader({ createdAt: 1000 }),
      makeHeader({ createdAt: 1000 }),
    )).toBe(false);
  });

  it('less → false', () => {
    expect(verifyCreatedAtOrder(
      makeHeader({ createdAt: 999 }),
      makeHeader({ createdAt: 1000 }),
    )).toBe(false);
  });

  it('NaN → false', () => {
    expect(verifyCreatedAtOrder(
      makeHeader({ createdAt: NaN as any }),
      makeHeader({ createdAt: 1000 }),
    )).toBe(false);
  });

  it('non-integer → false', () => {
    expect(verifyCreatedAtOrder(
      makeHeader({ createdAt: 1.5 as any }),
      makeHeader({ createdAt: 1 }),
    )).toBe(false);
  });

  it('negative → false', () => {
    expect(verifyCreatedAtOrder(
      makeHeader({ createdAt: -1 as any }),
      makeHeader({ createdAt: 0 }),
    )).toBe(false);
  });

  it('non-object → false', () => {
    expect(verifyCreatedAtOrder(null as any, makeHeader({ createdAt: 0 }))).toBe(false);
    expect(verifyCreatedAtOrder(makeHeader({ createdAt: 1 }), null as any)).toBe(false);
  });

  it('never throws', () => {
    for (const bad of [null, undefined, 42, 'str', NaN]) {
      expect(() => verifyCreatedAtOrder(bad as any, bad as any)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// verifyCreatedAtBound — VALIDATION_INTERFACE → verifyCreatedAtBound
// ---------------------------------------------------------------------------

describe('verifyCreatedAtBound', () => {
  it('at the bound (inclusive) → true', () => {
    expect(verifyCreatedAtBound(
      makeHeader({ createdAt: 2000 }),
      1000,
      1000,
    )).toBe(true);
  });

  it('below the bound → true', () => {
    expect(verifyCreatedAtBound(
      makeHeader({ createdAt: 1999 }),
      1000,
      1000,
    )).toBe(true);
  });

  it('above the bound → false', () => {
    expect(verifyCreatedAtBound(
      makeHeader({ createdAt: 2001 }),
      1000,
      1000,
    )).toBe(false);
  });

  it('NaN createdAt → false', () => {
    expect(verifyCreatedAtBound(makeHeader({ createdAt: NaN as any }), 1000, 1000)).toBe(false);
  });

  it('non-integer createdAt → false', () => {
    expect(verifyCreatedAtBound(makeHeader({ createdAt: 1.5 as any }), 1000, 1000)).toBe(false);
  });

  it('negative createdAt → false', () => {
    expect(verifyCreatedAtBound(makeHeader({ createdAt: -1 as any }), 1000, 1000)).toBe(false);
  });

  it('non-object header → false', () => {
    expect(verifyCreatedAtBound(null as any, 1000, 1000)).toBe(false);
  });

  it('NaN nowMs → false', () => {
    expect(verifyCreatedAtBound(makeHeader({ createdAt: 1000 }), NaN, 1000)).toBe(false);
  });

  it('NaN maxDriftMs → false', () => {
    expect(verifyCreatedAtBound(makeHeader({ createdAt: 1000 }), 1000, NaN)).toBe(false);
  });

  it('never throws', () => {
    for (const bad of [null, undefined, 42, 'str', NaN]) {
      expect(() => verifyCreatedAtBound(bad as any, bad as any, bad as any)).not.toThrow();
    }
  });
});
