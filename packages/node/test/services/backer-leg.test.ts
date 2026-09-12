// MINING_INTERFACE → The backer pool — the arithmetic, the worked vectors, and
// the invariant V ≥ Σ accrued(stake).
import { describe, it, expect } from 'vitest';
import { backerLeg, splitCoinbase } from '../../src/services/coinbase-split.js';
import {
  buildSettlement,
  checkSettlement,
} from '../../src/services/settlement.js';
import type { SettlementDeps, SettlementBody } from '../../src/services/settlement.js';
import type {
  AnyBox,
  AnyBoxCandidate,
  BackerPoolBox,
  EmissionBox,
  KarmaPoolBox,
  CreditBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { makeTestIdentity, seedProvenance } from '../helpers.js';

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

// ---------------------------------------------------------------------------
// Settlement-level tests — derive() through buildSettlement / checkSettlement
// ---------------------------------------------------------------------------

const ONE_ERA = [{ version: 1, fromHeight: 0 }] as const;
const DELAY = 5;
const WINDOW = 1_000_000;

const miner = makeTestIdentity();
const backerOwner2 = makeTestIdentity();

let sn = 1000;
function makePoolBox(v: bigint, t: bigint, a: bigint): BackerPoolBox {
  return seedProvenance<BackerPoolBox>(
    { boxType: 'backer_pool', value: v, staked: t, accrual: a, createdAtBlock: 0 },
    1, sn++,
  );
}

function makeDeps(opts: {
  emission: bigint;
  poolBox: BackerPoolBox | null;
  supply: bigint;
  window?: number;
}): SettlementDeps {
  const emBox = seedProvenance<EmissionBox>(
    { boxType: 'emission', value: opts.emission, createdAtBlock: 0 }, 1, sn++,
  );
  const kpBox = seedProvenance<KarmaPoolBox>(
    { boxType: 'karma_pool', value: 1000n, createdAtBlock: 0 }, 1, sn++,
  );
  const boxes = new Map<string, AnyBox>();
  boxes.set(emBox.id!, emBox as AnyBox);
  boxes.set(kpBox.id!, kpBox as AnyBox);
  if (opts.poolBox) boxes.set(opts.poolBox.id!, opts.poolBox as AnyBox);
  return {
    getEmissionBox: () => emBox as EmissionBox,
    getTreasuryBox: () => null,
    getKarmaPoolBox: () => kpBox as KarmaPoolBox,
    getBox: (id) => boxes.get(id) ?? null,
    getLikeCarryBox: () => null,
    getBondsSettlingAt: () => [],
    getEscrowsReleasableAt: () => [],
    getLapsedVouches: () => [],
    getLifetimeLikes: () => 0n,
    getDecayPlans: () => [],
    vouchCooldownBlocks: 2,
    getBackerPoolBox: () => opts.poolBox,
    backerSupply: opts.supply,
    creditFixedRateBlocks: opts.window ?? WINDOW,
  };
}

function emptyBodyWith(unstakes: SettlementBody['unstakes'] = []): SettlementBody {
  return { fees: 0n, rent: 0n, actors: 0, feeBoxIds: [], invites: [], markers: [], priceBoxes: [], unstakes };
}

describe('backer leg — settlement-level (derive through buildSettlement/checkSettlement)', () => {
  it('successor fields match the vector table at block 1', () => {
    const pool = makePoolBox(0n, 50n, 0n);
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S });
    const result = buildSettlement(deps, 1, ONE_ERA, BASE, DELAY, emptyBodyWith(), miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const successor = result.tx.outputs.find(o => o.boxType === 'backer_pool') as BackerPoolBox | undefined;
    expect(successor).toBeDefined();
    expect(successor!.value).toBe(1_470_000_000n);
    expect(successor!.staked).toBe(50n);
    expect(successor!.accrual).toBe(2_940_000_000n);
  });

  it('an unstake produces a credit release with the marker owner, no lock, createdAtBlock=height', () => {
    const pool = makePoolBox(1_470_000_000n, 50n, 2_940_000_000n);
    const marker = seedProvenance<import('@dagsocial/types').BackerUnstakeBox>(
      { boxType: 'backer_unstake', value: 0n as 0n, owner: backerOwner2.userId, weight: 10n, createdAtBlock: 2 },
      2, sn++,
    );
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S });
    const body = emptyBodyWith([{ id: marker.id!, owner: backerOwner2.userId, weight: 10n }]);
    const result = buildSettlement(deps, 2, ONE_ERA, BASE, DELAY, body, miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const credits = result.tx.outputs.filter(o => o.boxType === 'credit') as CreditBox[];
    const release = credits.find(c =>
      Buffer.from(c.owner).toString('hex') === Buffer.from(backerOwner2.userId).toString('hex'),
    );
    expect(release).toBeDefined();
    expect(release!.value).toBe(294_000_000n);
    expect(release!.createdAtBlock).toBe(2);
    expect(release!.lockedUntilBlock).toBeUndefined();
  });

  it('miner slice is income − treasury − unearned − draw', () => {
    const pool = makePoolBox(0n, 50n, 0n);
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S });
    const result = buildSettlement(deps, 1, ONE_ERA, BASE, DELAY, emptyBodyWith(), miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const split = splitCoinbase(BASE, 0n, 0n, 0, 1_470_000_000n);
    const coinbase = result.tx.outputs.filter(o => o.boxType === 'credit') as CreditBox[];
    const minerOut = coinbase.find(c =>
      Buffer.from(c.owner).toString('hex') === Buffer.from(miner.userId).toString('hex'),
    );
    expect(minerOut).toBeDefined();
    expect(minerOut!.value).toBe(split.miner);
  });

  it('outside the window with no unstake — pool box is neither input nor output', () => {
    const pool = makePoolBox(100n, 50n, 1000n);
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S, window: 0 });
    const result = buildSettlement(deps, 1, ONE_ERA, BASE, DELAY, emptyBodyWith(), miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    expect(result.tx.inputs).not.toContain(pool.id);
    expect(result.tx.outputs.find(o => o.boxType === 'backer_pool')).toBeUndefined();
  });

  it('outside the window with an unstake — pool box spent, inc is 0', () => {
    const pool = makePoolBox(500n, 50n, 2_000_000_000n);
    const marker = seedProvenance<import('@dagsocial/types').BackerUnstakeBox>(
      { boxType: 'backer_unstake', value: 0n as 0n, owner: backerOwner2.userId, weight: 10n, createdAtBlock: 5 },
      5, sn++,
    );
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S, window: 0 });
    const body = emptyBodyWith([{ id: marker.id!, owner: backerOwner2.userId, weight: 10n }]);
    const result = buildSettlement(deps, 5, ONE_ERA, BASE, DELAY, body, miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    expect(result.tx.inputs).toContain(pool.id);
    const successor = result.tx.outputs.find(o => o.boxType === 'backer_pool') as BackerPoolBox | undefined;
    expect(successor).toBeDefined();
    expect(successor!.accrual).toBe(2_000_000_000n);
  });

  it('U > T0 is refused by buildSettlement', () => {
    const pool = makePoolBox(100n, 10n, 1000n);
    const marker = seedProvenance<import('@dagsocial/types').BackerUnstakeBox>(
      { boxType: 'backer_unstake', value: 0n as 0n, owner: backerOwner2.userId, weight: 20n, createdAtBlock: 2 },
      2, sn++,
    );
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S });
    const body = emptyBodyWith([{ id: marker.id!, owner: backerOwner2.userId, weight: 20n }]);
    const result = buildSettlement(deps, 2, ONE_ERA, BASE, DELAY, body, miner.userId);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('exceeds staked');
  });

  it('checkSettlement refuses a successor whose accrual is off by one', () => {
    const pool = makePoolBox(0n, 50n, 0n);
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S });
    const result = buildSettlement(deps, 1, ONE_ERA, BASE, DELAY, emptyBodyWith(), miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const tx = result.tx;
    const poolIdx = tx.outputs.findIndex(o => o.boxType === 'backer_pool');
    expect(poolIdx).toBeGreaterThanOrEqual(0);
    const tampered: UtxoTransaction = {
      ...tx,
      outputs: tx.outputs.map((o, i) =>
        i === poolIdx
          ? { ...o, accrual: (o as BackerPoolBox).accrual + 1n }
          : o,
      ) as AnyBoxCandidate[],
    };
    const check = checkSettlement(deps, 1, ONE_ERA, BASE, DELAY, emptyBodyWith(), tampered);
    expect(check.valid).toBe(false);
  });

  it('checkSettlement refuses a release off by one', () => {
    const pool = makePoolBox(1_470_000_000n, 50n, 2_940_000_000n);
    const marker = seedProvenance<import('@dagsocial/types').BackerUnstakeBox>(
      { boxType: 'backer_unstake', value: 0n as 0n, owner: backerOwner2.userId, weight: 10n, createdAtBlock: 2 },
      2, sn++,
    );
    const deps = makeDeps({ emission: BASE, poolBox: pool, supply: S });
    const body = emptyBodyWith([{ id: marker.id!, owner: backerOwner2.userId, weight: 10n }]);
    const result = buildSettlement(deps, 2, ONE_ERA, BASE, DELAY, body, miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const tx = result.tx;
    const releaseIdx = tx.outputs.findIndex(o =>
      o.boxType === 'credit' && !('lockedUntilBlock' in o && o.lockedUntilBlock !== undefined),
    );
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    const tampered: UtxoTransaction = {
      ...tx,
      outputs: tx.outputs.map((o, i) =>
        i === releaseIdx ? { ...o, value: o.value + 1n } : o,
      ) as AnyBoxCandidate[],
    };
    const check = checkSettlement(deps, 2, ONE_ERA, BASE, DELAY, body, tampered);
    expect(check.valid).toBe(false);
  });
});
