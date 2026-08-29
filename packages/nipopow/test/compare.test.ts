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

    // Work measured from the headers: blockWork(bits) = 2^256 / (target + 1)
    function sumWork(headers: BlockHeader[]): bigint {
      let w = 0n;
      for (const h of headers) w += blockWork(h.powTargetBits) ?? 0n;
      return w;
    }

    // The cheap chain's registered fraction should be roughly 1/8
    const cheapAll = cheap.headers.slice(1);
    const registeredCount = cheapAll.filter(h =>
      level(h, DEVNET_RETARGET.anchorBits) !== null,
    ).length;
    const registrationFraction = registeredCount / cheapAll.length;
    expect(registrationFraction).toBeLessThan(0.25);
    expect(registrationFraction).toBeGreaterThan(0.05);

    // 20 trials: for each honest length, find the longest cheap prefix whose
    // work ≤ the honest side's, then compare proofs
    let neverCheap = true;
    const trials = 20;
    for (let i = 0; i < trials; i++) {
      const hLen = 15 + i;
      if (hLen + k > honest.headers.length) continue;
      if (hLen < m + k) continue;

      const honestAbove = honest.headers.slice(1, hLen);
      const honestWork = sumWork(honestAbove);

      // Find the longest cheap prefix whose work ≤ honest work
      let cLen = 1;
      let cheapWork = 0n;
      for (let j = 1; j < cheap.headers.length; j++) {
        const w = blockWork(cheap.headers[j]!.powTargetBits) ?? 0n;
        if (cheapWork + w > honestWork) break;
        cheapWork += w;
        cLen = j + 1;
      }
      if (cLen < m + k) continue;

      // The premise: cheap work ≤ honest work
      expect(cheapWork).toBeLessThanOrEqual(honestWork);

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

    // The mechanism: a control bestArg using the OLD definition (own-target
    // levels) picks the cheap chain — the attack the yardstick defeats
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
    const honestAbove = honest.headers.slice(1, 25);
    const cheapAboveSlice = cheapAll.slice(0, 200);
    const controlH = controlBestArg(honestAbove, m);
    const controlC = controlBestArg(cheapAboveSlice, m);
    expect(controlC).toBeGreaterThan(controlH);
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
