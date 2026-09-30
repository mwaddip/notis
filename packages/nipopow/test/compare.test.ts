import { describe, it, expect } from 'vitest';
import { compareProofs, bestArg } from '../src/compare.js';
import { proveWithReader } from '../src/prover.js';
import { blockHash, blockWork, level } from '@dagsocial/validation';
import type { BlockHeader } from '@dagsocial/types';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  DEVNET_POW_TARGET_BITS,
  DEVNET_RETARGET,
} from './helpers.js';

describe('compareProofs', () => {
  const profile = devnetProfile();
  const m = 3;
  const k = 5;

  it('the one with more work above the LCA wins (both argument orders)', () => {
    // Build a longer chain — heavier
    const chainA = buildMinedChain({ count: 60 });
    const readerA = makeReader(chainA);
    const proofA = proveWithReader(readerA, { m, k });

    // Build a shorter chain from the same genesis — lighter
    const chainB = buildMinedChain({ count: 30 });
    const readerB = makeReader(chainB);
    const proofB = proveWithReader(readerB, { m, k });

    const gA = blockHash(chainA.headers[0]!);
    const gB = blockHash(chainB.headers[0]!);

    if (gA === gB) {
      // Same genesis — comparable
      const resultAB = compareProofs(proofA, proofB, m, profile);
      expect(resultAB.verdict).toBe('a');
      const resultBA = compareProofs(proofB, proofA, m, profile);
      expect(resultBA.verdict).toBe('b');
    } else {
      // Different genesis — both proofs are valid but no common ancestor
      const result = compareProofs(proofA, proofB, m, profile);
      expect(result.verdict).toBe('incomparable');
    }
  });

  it('no common ancestor (two chains from different block 1s) is incomparable', () => {
    // Two independently mined chains always have different genesis
    const chainA = buildMinedChain({ count: 20 });
    const chainB = buildMinedChain({ count: 20 });
    const gA = blockHash(chainA.headers[0]!);
    const gB = blockHash(chainB.headers[0]!);

    // If by chance they share genesis, this test is vacuous
    if (gA !== gB) {
      const readerA = makeReader(chainA);
      const readerB = makeReader(chainB);
      const proofA = proveWithReader(readerA, { m, k });
      const proofB = proveWithReader(readerB, { m, k });
      const result = compareProofs(proofA, proofB, m, profile);
      expect(result.verdict).toBe('incomparable');
      if (result.verdict === 'incomparable') {
        expect(result.reason).toBe('no-common-ancestor');
      }
    }
  });

  it('m mismatch is incomparable', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = proveWithReader(reader, { m: 6, k: 5 });
    const result = compareProofs(proofA, proofB, 3, profile);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') {
      expect(result.reason).toBe('m-mismatch');
    }
  });

  it('an invalid proof is incomparable', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = { ...proveWithReader(reader, { m: 3, k: 5 }) };
    proofB.prefix = []; // make it invalid
    const result = compareProofs(proofA, proofB, 3, profile);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') {
      expect(result.reason).toBe('invalid');
    }
  });
});

describe('attack pins — NIPOPOW_INTERFACE → compareProofs', () => {
  // nowMs far above every stretched stamp so the clock check passes
  const profile = { ...devnetProfile(), nowMs: 10_000_000_000 };
  const m = 3;
  const k = 5;
  const { anchorBits, floorBits } = DEVNET_RETARGET;
  // stretched stamps: 200× idealMs → target walks to floor (2304) by block 7
  const cheapStampMs = 200 * 60_000;

  // 2^((3072 - 2304) / 256) = 2^3 = 8: a floor-difficulty block is 1/8 the work
  // of an anchor-difficulty block, and registers a level with probability 1/8.
  // An honest chain of H blocks above the LCA has H anchor-units of work.
  // A cheap chain of C floor blocks has C/8 anchor-units of work.
  // For equal work: C = 8H (plus a few transition blocks).

  // Work measured from the headers: blockWork(bits) = 2^256 / (target + 1)
  function sumWork(headers: BlockHeader[]): bigint {
    let w = 0n;
    for (const h of headers) w += blockWork(h.powTargetBits) ?? 0n;
    return w;
  }

  // The control: bestArg with every level measured against the header's own target, as Ergo
  // measures it (NIPOPOW_INTERFACE → compareProofs → "The score is work, whatever the headers declare")
  function controlBestArg(headers: BlockHeader[], m: number): bigint {
    const levels = headers.map(h => level(h, h.powTargetBits));
    const count0 = levels.filter(lvl => lvl !== null).length;
    const acc: Array<[number, number]> = [[0, count0]];
    let mu = 1;
    for (;;) {
      const count = levels.filter(lvl => lvl !== null && lvl >= mu).length;
      if (count >= m) { acc.push([mu, count]); mu++; } else break;
    }
    let best = 0n;
    for (const [lvl, cnt] of acc) {
      const score = (2n ** BigInt(lvl)) * BigInt(cnt);
      if (score > best) best = score;
    }
    return best;
  }

  // NIPOPOW_INTERFACE → compareProofs → "A cheap-target chain therefore buys no score beyond its
  // work", over the cheap chain's floor headers — heights 7..500; the difficulty walk's headers
  // 2..6 carry targets between the anchor's and the floor's.
  //
  // Identity: T_floor + 1 = 2^247 = 8 · (T_anchor + 1) (VALIDATION_INTERFACE → orderingPowTarget),
  // so a floor header whose hit meets the anchor has an own-target level of its anchor level plus
  // three (VALIDATION_INTERFACE → level), and one whose hit misses it an own-target level of 0, 1
  // or 2. The own-target count at μ + 3 is the anchor count at μ, so the own-target score is at
  // least eight times the anchor score. An honest header's own target is the anchor, so its two
  // scores are one.
  //
  // Binomial: a floor header's hit is uniform below its own target, so it meets the anchor with
  // probability 1/8, its work in anchor units. The registered count of the 494 floor headers is
  // Binomial(494, 1/8) — mean W = 61.75, sd 7.35 — and the band [W/2, 2W] lies 4.25 sd below the
  // mean and 8.4 sd above it: exact tails 1.8e-6 and 2.0e-14. bestArg's maximum includes level 0,
  // so the anchor score is at least W/2. Above that the maximum is decided at the top level holding
  // m headers, whose noise is m's (NIPOPOW_INTERFACE → compareProofs → "How often a proof of less
  // work wins at all is `m`'s to bound, not the yardstick's") and has no overwhelming bound at m = 3.
  it('(a) one cheap chain: bestArg against the anchor tracks its work, own-target levels inflate it eightfold', () => {
    const honest = buildMinedChain({ count: 30 });
    const cheap = buildMinedChain({ count: 500, stampIntervalMs: cheapStampMs });

    const floor = cheap.headers.slice(6);
    expect(floor[0]!.height).toBe(7);
    for (const h of floor) expect(h.powTargetBits).toBe(floorBits);

    for (const h of floor) {
      const againstAnchor = level(h, anchorBits);
      const againstOwn = level(h, h.powTargetBits);
      if (againstAnchor === null) expect([0, 1, 2]).toContain(againstOwn);
      else expect(againstOwn).toBe(againstAnchor + 3);
    }

    const work = sumWork(floor);
    const anchorWork = blockWork(anchorBits)!;
    const registered = BigInt(floor.filter(h => level(h, anchorBits) !== null).length);
    expect(2n * registered * anchorWork).toBeGreaterThanOrEqual(work);   // registered ≥ W/2
    expect(registered * anchorWork).toBeLessThanOrEqual(2n * work);      // registered ≤ 2W

    const anchorScore = bestArg(floor, m, anchorBits);
    const ownScore = controlBestArg(floor, m);
    expect(2n * anchorScore * anchorWork).toBeGreaterThanOrEqual(work);  // anchor score ≥ W/2
    expect(ownScore).toBeGreaterThanOrEqual(8n * anchorScore);
    // every header meets its own target: the own-target level-0 count is the header count, 8W
    expect(ownScore).toBeGreaterThanOrEqual(BigInt(floor.length));

    const honestAbove = honest.headers.slice(1);
    for (const h of honestAbove) expect(h.powTargetBits).toBe(anchorBits);
    expect(controlBestArg(honestAbove, m)).toBe(bestArg(honestAbove, m, anchorBits));
  });

  it('(b) cheap chain with strictly more work wins', () => {
    const honest = buildMinedChain({ count: 25 });
    const cheap = buildMinedChain({ count: 500, stampIntervalMs: 200 * 60_000 });

    const gH = blockHash(honest.headers[0]!);
    const gC = blockHash(cheap.headers[0]!);
    expect(gH).toBe(gC);

    // Measure both works so a reader sees the ratio
    let honestWork = 0n;
    for (const h of honest.headers.slice(1)) honestWork += blockWork(h.powTargetBits) ?? 0n;
    let cheapWork = 0n;
    for (const h of cheap.headers.slice(1)) cheapWork += blockWork(h.powTargetBits) ?? 0n;
    expect(cheapWork).toBeGreaterThan(honestWork);

    const hReader = makeReader(honest);
    const cReader = makeReader(cheap);
    const proofH = proveWithReader(hReader, { m, k });
    const proofC = proveWithReader(cReader, { m, k });

    const result = compareProofs(proofH, proofC, m, profile);
    expect(result.verdict).toBe('b');
  });

  // The control's verdict over the equal-work trials — honest prefixes of 15..25 headers, each
  // against the longest cheap prefix of no more work. The cheap side's own-target level-0 count is
  // its header count, about seven times the honest length; the honest side's own-target score is
  // its anchor score, which passes that only through a fluke at its top level. The verdict is
  // scored at the client's m (CONSTANTS → Client defaults): a top level of three headers lets such a
  // fluke through in about one mining of these fixtures in 200, a top level of six in about one in
  // 18 000.
  it('(c) the own-target control picks the cheap side in every equal-work trial', () => {
    const clientM = 6;
    const honest = buildMinedChain({ count: 30 });
    const cheap = buildMinedChain({ count: 250, stampIntervalMs: cheapStampMs });
    expect(blockHash(honest.headers[0]!)).toBe(blockHash(cheap.headers[0]!));

    for (let hLen = 15; hLen <= 25; hLen++) {
      const honestAbove = honest.headers.slice(1, hLen);
      const honestWork = sumWork(honestAbove);

      let cLen = 1;
      let cheapWork = 0n;
      for (let j = 1; j < cheap.headers.length; j++) {
        const w = blockWork(cheap.headers[j]!.powTargetBits) ?? 0n;
        if (cheapWork + w > honestWork) break;
        cheapWork += w;
        cLen = j + 1;
      }
      // the prefix ends on work, not on the fixture's last header
      expect(cLen).toBeLessThan(cheap.headers.length);
      expect(cheapWork).toBeLessThanOrEqual(honestWork);

      const cheapAbove = cheap.headers.slice(1, cLen);
      expect(controlBestArg(cheapAbove, clientM)).toBeGreaterThan(controlBestArg(honestAbove, clientM));
    }
  });
});

describe('bestArg', () => {
  it('returns 0n for an empty chain', () => {
    expect(bestArg([], 3, DEVNET_POW_TARGET_BITS)).toBe(0n);
  });

  it('level 0 counts all registered headers', () => {
    const chain = buildMinedChain({ count: 10 });
    const score = bestArg(chain.headers, 3, DEVNET_POW_TARGET_BITS);
    // On-schedule: every header has a level; 2^0 * 10 = 10
    expect(score).toBeGreaterThanOrEqual(10n);
  });

  it('hand-checked: forced levels produce expected scores', () => {
    const forceLevels = new Map<number, number>();
    forceLevels.set(3, 2);
    forceLevels.set(5, 2);
    forceLevels.set(7, 2);
    const chain = buildMinedChain({ count: 10, forceLevels });
    const headers = chain.headers;

    const score = bestArg(headers, 2, DEVNET_POW_TARGET_BITS);
    expect(score).toBeGreaterThanOrEqual(10n);
  });
});
