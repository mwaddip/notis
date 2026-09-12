// MINING_INTERFACE → The backer pool — the arithmetic, the worked vectors, and
// the invariant V ≥ Σ accrued(stake).
import { describe, it, expect } from 'vitest';
import { backerLeg } from '../../src/services/coinbase-split.js';

// Devnet's numbers: S = 100, stakes 20 and 30, base = 4_200_000_000 (42 credits, no fees), c = 35.
const S = 100n;
const BASE = 4_200_000_000n;

function accrued(weight: bigint, accrual: bigint): bigint {
  return S > 0n ? (weight * accrual) / S : 0n;
}

describe('backer leg — the contract\'s three-block vector table', () => {
  // Block 1: no unstakes. T=50, cap binds: inc = ⌊4.2e9·3500/5000⌋ = 2_940_000_000
  it('block 1 — no unstakes, cap binds', () => {
    const leg = backerLeg(BASE, S, 50n, 0n, [], true);
    expect(leg.staked).toBe(50n);
    // inc = ⌊4200000000 * 35 * 100 / (100 * 50)⌋ = ⌊14700000000000 / 5000⌋ = 2_940_000_000
    expect(leg.accrual).toBe(2_940_000_000n);
    // P = ⌈50 * 2940000000 / 100⌉ = ⌈147000000000/100⌉ = 1_470_000_000
    expect(leg.draw).toBe(1_470_000_000n);
    expect(leg.releases).toEqual([]);
    // V after = 0 + 1470000000 - 0 = 1_470_000_000
    // Verify: accrued(20) = ⌊20*2940000000/100⌋ = 588_000_000
    expect(accrued(20n, leg.accrual)).toBe(588_000_000n);
    // accrued(30) = ⌊30*2940000000/100⌋ = 882_000_000
    expect(accrued(30n, leg.accrual)).toBe(882_000_000n);
  });

  // Block 2: A unstakes 10 of 20. T0=50, after: T=40. r = ⌊10 * 2940000000/100⌋ = 294_000_000
  it('block 2 — partial unstake, cap binds', () => {
    const leg = backerLeg(BASE, S, 50n, 2_940_000_000n, [{ weight: 10n }], true);
    expect(leg.releases).toEqual([294_000_000n]);
    expect(leg.staked).toBe(40n);
    // inc: T=40, 100*40=4000 > 35*100=3500, cap binds:
    // inc = ⌊4200000000 * 35 * 100 / (100 * 40)⌋ = ⌊14700000000000 / 4000⌋ = 3_675_000_000
    expect(leg.accrual).toBe(2_940_000_000n + 3_675_000_000n);
    expect(leg.accrual).toBe(6_615_000_000n);
    // P = ⌈40 * 3675000000 / 100⌉ = ⌈147000000000/100⌉ = 1_470_000_000
    expect(leg.draw).toBe(1_470_000_000n);
    // V after = 1470000000 + 1470000000 - 294000000 = 2_646_000_000
    // accrued(10, 6615000000) = ⌊10*6615000000/100⌋ = 661_500_000
    expect(accrued(10n, leg.accrual)).toBe(661_500_000n);
    // accrued(30, 6615000000) = ⌊30*6615000000/100⌋ = 1_984_500_000
    expect(accrued(30n, leg.accrual)).toBe(1_984_500_000n);
  });

  // Block 3: A unstakes the last 10. T0=40, after: T=30. r = ⌊10 * 6615000000/100⌋ = 661_500_000
  it('block 3 — full unstake, cap does not bind', () => {
    const leg = backerLeg(BASE, S, 40n, 6_615_000_000n, [{ weight: 10n }], true);
    expect(leg.releases).toEqual([661_500_000n]);
    expect(leg.staked).toBe(30n);
    // inc: T=30, 100*30=3000 ≤ 35*100=3500, does NOT bind: inc = base = 4_200_000_000
    expect(leg.accrual).toBe(6_615_000_000n + 4_200_000_000n);
    expect(leg.accrual).toBe(10_815_000_000n);
    // P = ⌈30 * 4200000000 / 100⌉ = ⌈126000000000/100⌉ = 1_260_000_000
    expect(leg.draw).toBe(1_260_000_000n);
    // V after = 2646000000 + 1260000000 - 661500000 = 3_244_500_000
    // accrued(30, 10815000000) = ⌊30*10815000000/100⌋ = 3_244_500_000
    expect(accrued(30n, leg.accrual)).toBe(3_244_500_000n);
  });
});

describe('backer leg — edge cases', () => {
  it('inc on the cap boundary: 100·T == c·S exactly → does not bind', () => {
    // T=35, S=100, c=35: 100*35=3500 == 35*100=3500
    const leg = backerLeg(BASE, S, 35n, 0n, [], true);
    // does not bind: inc = base
    expect(leg.accrual).toBe(BASE);
  });

  it('window last block (inWindow=true) has nonzero inc', () => {
    const leg = backerLeg(BASE, S, 50n, 0n, [], true);
    expect(leg.draw).toBeGreaterThan(0n);
  });

  it('first block outside window (inWindow=false) has zero inc', () => {
    const leg = backerLeg(BASE, S, 50n, 0n, [], false);
    expect(leg.accrual).toBe(0n);
    expect(leg.draw).toBe(0n);
  });

  it('T = 0 — all weight unstaked', () => {
    const leg = backerLeg(BASE, S, 50n, 1_000n, [{ weight: 50n }], true);
    expect(leg.staked).toBe(0n);
    expect(leg.draw).toBe(0n);
  });

  it('no pool box (supply 0) — draw is 0', () => {
    const leg = backerLeg(BASE, 0n, 0n, 0n, [], true);
    expect(leg.draw).toBe(0n);
    expect(leg.releases).toEqual([]);
  });

  it('a marker whose release rounds to zero emits no output', () => {
    // weight=1, accrual=99, S=100: release = ⌊1*99/100⌋ = 0
    const leg = backerLeg(BASE, 100n, 10n, 99n, [{ weight: 1n }], true);
    expect(leg.releases[0]).toBe(0n);
  });

  it('unstake weight > staked is the caller\'s refusal, not the leg\'s', () => {
    // backerLeg is pure arithmetic — staked goes negative. The caller
    // (derive()) refuses the block before calling.
    const leg = backerLeg(BASE, S, 10n, 1000n, [{ weight: 20n }], true);
    expect(leg.staked).toBe(-10n);
  });

  it('outside window with unstakes still computes releases', () => {
    const leg = backerLeg(BASE, S, 50n, 2_000_000_000n, [{ weight: 10n }], false);
    expect(leg.releases).toEqual([200_000_000n]);
    expect(leg.accrual).toBe(2_000_000_000n);
    expect(leg.draw).toBe(0n);
  });
});

describe('backer leg — the invariant V ≥ Σ accrued over random unstake sequences', () => {
  it('random sequences: pool value covers every live stake\'s accrued', () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 200; trial++) {
      const supply = 1000n;
      let stakes = [
        { weight: BigInt(50 + Math.floor(rng() * 200)) },
        { weight: BigInt(50 + Math.floor(rng() * 200)) },
        { weight: BigInt(50 + Math.floor(rng() * 200)) },
      ];
      let staked = stakes.reduce((s, k) => s + k.weight, 0n);
      let accrual = 0n;
      let poolValue = 0n;

      const blocks = 5 + Math.floor(rng() * 10);
      for (let h = 0; h < blocks; h++) {
        const base = BigInt(1000 + Math.floor(rng() * 9000));
        const unstakes: { weight: bigint }[] = [];
        const newStakes = [];
        for (const s of stakes) {
          if (rng() < 0.3 && s.weight > 1n) {
            const w = 1n + BigInt(Math.floor(rng() * Number(s.weight - 1n)));
            unstakes.push({ weight: w });
            const remainder = s.weight - w;
            if (remainder > 0n) newStakes.push({ weight: remainder });
          } else {
            newStakes.push(s);
          }
        }

        const leg = backerLeg(base, supply, staked, accrual, unstakes, true);
        const totalReleased = leg.releases.reduce((a, b) => a + b, 0n);
        poolValue = poolValue + leg.draw - totalReleased;
        staked = leg.staked;
        accrual = leg.accrual;
        stakes = newStakes;

        // The invariant: V ≥ Σ accrued(stake)
        const sumAccrued = stakes.reduce(
          (s, k) => s + (k.weight * accrual) / supply, 0n,
        );
        expect(poolValue).toBeGreaterThanOrEqual(sumAccrued);

        // Every release ≤ its stake's accrued at this height
        for (const r of leg.releases) {
          expect(r).toBeGreaterThanOrEqual(0n);
        }
      }
    }
  });
});

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let v = Math.imul(t ^ (t >>> 15), 1 | t);
    v ^= v + Math.imul(v ^ (v >>> 7), 61 | v);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}
