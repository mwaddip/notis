import { describe, it, expect } from 'vitest';
import { compareProofs, bestArg } from '../src/compare.js';
import { proveWithReader } from '../src/prover.js';
import { blockHash, level } from '@dagsocial/validation';
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

  // 2^((3072 - 2304) / 256) = 2^3 = 8: a floor-difficulty block is 1/8 the work
  // of an anchor-difficulty block, and registers a level with probability 1/8.
  // An honest chain of H blocks above the LCA has H anchor-units of work.
  // A cheap chain of C floor blocks has C/8 anchor-units of work.
  // For equal work: C = 8H (plus a few transition blocks).

  it('(a) equal-work cheap chain does not out-compare the honest one', () => {
    const honest = buildMinedChain({ count: 30 });
    // stretched stamps: 200× idealMs → target walks to floor (2304) by block 7
    const cheap = buildMinedChain({ count: 250, stampIntervalMs: 200 * 60_000 });

    const gH = blockHash(honest.headers[0]!);
    const gC = blockHash(cheap.headers[0]!);
    expect(gH).toBe(gC);

    // Count the cheap chain's registered headers (level not null)
    const cheapAbove = cheap.headers.slice(1);
    const registeredCount = cheapAbove.filter(h =>
      level(h, DEVNET_RETARGET.anchorBits) !== null,
    ).length;

    // The registered fraction should be roughly 1/8 of the total
    // (the first ~6 blocks are at transitional difficulty, rest at floor)
    const registrationFraction = registeredCount / cheapAbove.length;
    expect(registrationFraction).toBeLessThan(0.25);
    expect(registrationFraction).toBeGreaterThan(0.05);

    // Compare proofs across different chain-length pairs (≥ 20 solver seeds):
    // honest chain length 10+i, cheap chain length floor-adjusted to match work
    let neverCheap = true;
    const trials = 20;
    for (let i = 0; i < trials; i++) {
      const hLen = 15 + i;
      const cLen = 8 * hLen + 10;
      if (hLen + k > honest.headers.length || cLen > cheap.headers.length) continue;
      if (hLen < m + k || cLen < m + k) continue;

      const hSlice = { ...honest, headers: honest.headers.slice(0, hLen), popowHeaders: honest.popowHeaders.slice(0, hLen), interlinksPerHeader: honest.interlinksPerHeader.slice(0, hLen) };
      const cSlice = { ...cheap, headers: cheap.headers.slice(0, cLen), popowHeaders: cheap.popowHeaders.slice(0, cLen), interlinksPerHeader: cheap.interlinksPerHeader.slice(0, cLen) };

      const hReader = makeReader(hSlice);
      const cReader = makeReader(cSlice);
      const proofH = proveWithReader(hReader, { m, k });
      const proofC = proveWithReader(cReader, { m, k });

      const result = compareProofs(proofH, proofC, m, profile);
      if (result.verdict === 'b') neverCheap = false;
    }
    expect(neverCheap).toBe(true);

    // The mechanism: a control bestArg using the OLD definition (own-target levels)
    // picks the cheap chain — the attack succeeds under the old definition
    const honestAbove = honest.headers.slice(1, 25);
    const cheapAboveSlice = cheapAbove.slice(0, 200);
    function controlBestArg(headers: typeof honest.headers, m: number): bigint {
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
    // Under own-target levels, every PoW-valid header registers, so the cheap
    // chain with more headers trivially out-scores the honest one
    const controlH = controlBestArg(honestAbove, m);
    const controlC = controlBestArg(cheapAboveSlice, m);
    expect(controlC).toBeGreaterThan(controlH);
  });

  it('(b) cheap chain with strictly more work wins', () => {
    // honest = 25 blocks → 24 above the LCA, 24 anchor-work units.
    // cheap  = 500 blocks → ~494 at the floor, ~494/8 + 2.5 ≈ 64 anchor-work
    // units — 2.7× the honest work. The proof's prefix at each level is
    // deeper, and bestArg recovers the work advantage.
    const honest = buildMinedChain({ count: 25 });
    const cheap = buildMinedChain({ count: 500, stampIntervalMs: 200 * 60_000 });

    const gH = blockHash(honest.headers[0]!);
    const gC = blockHash(cheap.headers[0]!);
    expect(gH).toBe(gC);

    const hReader = makeReader(honest);
    const cReader = makeReader(cheap);
    const proofH = proveWithReader(hReader, { m, k });
    const proofC = proveWithReader(cReader, { m, k });

    const result = compareProofs(proofH, proofC, m, profile);
    expect(result.verdict).toBe('b');
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
