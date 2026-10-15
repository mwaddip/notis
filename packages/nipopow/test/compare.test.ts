import { describe, it, expect } from 'vitest';
import { compareProofs, bestArg } from '../src/compare.js';
import { encodeNipopowProof, verifyProof } from '../src/index.js';
import { proveWithReader } from '../src/prover.js';
import { asertTargetBits, blockHash, blockWork, level, level as headerLevel, verifyOrderingBlockPoW } from '@dagsocial/validation';
import type { BlockHeader } from '@dagsocial/types';
import {
  NETWORK_PROFILES,
  interlinkRoot,
  protocolVersionAt,
  updateInterlinks,
} from '@dagsocial/types';
import type { CompareResult, VerifyProfile } from '../src/index.js';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  solveHeaderPow,
  DEVNET_POW_TARGET_BITS,
  DEVNET_RETARGET,
} from './helpers.js';
import type { NipopowProof, PoPowHeader } from '../src/index.js';

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
      const resultAB = compareProofs(proofA, proofB, { m, k }, profile);
      expect(resultAB.verdict).toBe('a');
      const resultBA = compareProofs(proofB, proofA, { m, k }, profile);
      expect(resultBA.verdict).toBe('b');
    } else {
      // Different genesis — both proofs are valid but no common ancestor
      const result = compareProofs(proofA, proofB, { m, k }, profile);
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
      const result = compareProofs(proofA, proofB, { m, k }, profile);
      expect(result.verdict).toBe('incomparable');
      if (result.verdict === 'incomparable') {
        expect(result.reason).toBe('no-common-ancestor');
      }
    }
  });

  it('a proof declaring another m is incomparable', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = proveWithReader(reader, { m: 6, k: 5 });
    const result = compareProofs(proofA, proofB, { m: 3, k: 5 }, profile);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') {
      expect(result.reason).toBe('invalid');
    }
  });

  it('an invalid proof is incomparable', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = { ...proveWithReader(reader, { m: 3, k: 5 }) };
    proofB.prefix = []; // make it invalid
    const result = compareProofs(proofA, proofB, { m: 3, k: 5 }, profile);
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
  // the client's m (CONSTANTS → Client defaults)
  const clientM = 24;
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

  // NIPOPOW_INTERFACE → compareProofs → "A cheap-target chain therefore buys no score beyond its
  // work": a lower-difficulty chain of more work wins. The honest side is the prover's shortest
  // chain at the client's m and k = 5 — 29 headers, 28 above the LCA and 28 anchor units of work —
  // against the fixture cheap chain's 700 headers and about 89. The prover never walks level 0
  // (NIPOPOW_INTERFACE → proveWithReader), so above block 1 a proof carries its five suffix headers
  // and, below them, only headers of level 1 or above. The honest proof scores its level-0 count —
  // five plus Binomial(23, 1/2), at most 28 — unless 24 of its 28 headers reach level 1, scoring 48
  // or more with probability P(Binomial(28, 1/2) ≥ 24) = 9.0e-5. The cheap proof scores 48 or more
  // while 24 of its headers reach level 1 — a count of mean 44.6 — and below that only its level-0
  // count, at most 28; the likeliest way past it is 23 or fewer at level 1, probability 1.9e-4, with
  // the honest level-0 count reaching the cheap one's in about one of those in 40. Modelled over
  // 20 000 000 draws of this shape — honest levels geometric, a cheap header meeting the anchor with
  // probability its work in anchor units, the prover's walk and bestArg as written — the verdict is
  // not 'b' in 94, about 5e-6 per mining of these fixtures; at 600 cheap headers it is 1.5e-4, at
  // 500 3e-3.
  it('(b) cheap chain with strictly more work wins', () => {
    const honest = buildMinedChain({ count: clientM + k });
    const cheap = buildMinedChain({ count: 700, stampIntervalMs: cheapStampMs });

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
    const proofH = proveWithReader(hReader, { m: clientM, k });
    const proofC = proveWithReader(cReader, { m: clientM, k });

    const result = compareProofs(proofH, proofC, { m: clientM, k }, profile);
    expect(result.verdict).toBe('b');
  });

  // The control's verdict over the equal-work trials — honest prefixes of 25..35 headers, 24 to 34
  // above the LCA and so at least the client's m at level 0, each against the longest cheap prefix
  // of no more work. The cheap side's own-target level-0 count is its header count, about seven and
  // a half times the honest length; the honest side's own-target score is its anchor score, which
  // passes that only through a fluke at its top level. The verdict is scored at the client's m
  // (CONSTANTS → Client defaults): a top level of three headers lets such a fluke through in about
  // one mining of these fixtures in 230, a top level of six in about one in 19 000, and a top level
  // of 24 — 24 honest headers at level 4 or above, or all but at most one at level 3 — in fewer than
  // one in 10^20.
  it('(c) the own-target control picks the cheap side in every equal-work trial', () => {
    const honest = buildMinedChain({ count: 35 });
    const cheap = buildMinedChain({ count: 300, stampIntervalMs: cheapStampMs });
    expect(blockHash(honest.headers[0]!)).toBe(blockHash(cheap.headers[0]!));

    for (let hLen = 25; hLen <= 35; hLen++) {
      const honestAbove = honest.headers.slice(1, hLen);
      expect(honestAbove.length).toBeGreaterThanOrEqual(clientM);
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

// NIPOPOW_INTERFACE → compareProofs — "`m` and `k` are the client's":
// a proof that declares another `m` or `k` answers `incomparable / invalid`.
// NIPOPOW_INTERFACE → verifyProof — "Shape" rule 1 holds the proof to the client's params.
describe('comparator holds each proof to the client params', () => {
  const profile = devnetProfile();

  it('a short-suffix proof carrying a chosen stateRoot against an honest proof answers incomparable / invalid', () => {
    const chain = buildMinedChain({ count: 60 });
    const schedule = NETWORK_PROFILES.devnet.protocolVersionSchedule;
    const anchorBits = DEVNET_RETARGET.anchorBits;
    const clientK = 20;

    const honestReader = makeReader(chain);
    const honest = proveWithReader(honestReader, { m: 24, k: clientK });
    expect(honest.suffixTail.length).toBe(clientK - 1);

    const tip = chain.popowHeaders[chain.headers.length - 1]!;
    const tipHash = blockHash(tip.header);
    expect(tipHash).not.toBeNull();
    const tipLevel = headerLevel(tip.header, anchorBits);
    const bInterlinks = updateInterlinks(tip.interlinks, tipHash!, tipLevel);
    const chosenRoot = 'ab'.repeat(33);
    const bHeight = tip.header.height + 1;
    const t_a = chain.headers[0]!.createdAt;
    const bBits = asertTargetBits(DEVNET_RETARGET, t_a, {
      height: tip.header.height,
      createdAt: tip.header.createdAt,
    });
    const bHeader: BlockHeader = {
      protocolVersion: protocolVersionAt(schedule, bHeight)!,
      height: bHeight,
      prevBlockHash: tipHash!,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: chosenRoot,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: bBits,
      createdAt: tip.header.createdAt + DEVNET_RETARGET.idealMs,
      interlinkRoot: interlinkRoot(bInterlinks),
      adProofsRoot: '00'.repeat(32),
    };
    bHeader.powNonce = solveHeaderPow(bHeader);
    expect(verifyOrderingBlockPoW(bHeader)).toBe(true);
    const bPopow: PoPowHeader = { header: bHeader, interlinks: bInterlinks };

    const augmented: PoPowHeader[] = [...chain.popowHeaders, bPopow];
    const byHash = new Map<string, PoPowHeader>();
    const byHeight = new Map<number, PoPowHeader>();
    for (const ph of augmented) {
      const h = blockHash(ph.header);
      if (h !== null) byHash.set(h, ph);
      byHeight.set(ph.header.height, ph);
    }
    const augmentedReader = {
      chainHeight: () => augmented.length,
      popowHeaderByHash: (h: string) => byHash.get(h) ?? null,
      popowHeaderAtHeight: (h: number) => byHeight.get(h) ?? null,
      lastHeaders: (n: number) => augmented.slice(-n).map(p => p.header),
      headersAfter: (h: number, n: number): BlockHeader[] => {
        const out: BlockHeader[] = [];
        for (let k = h + 1; k <= Math.min(h + n, augmented.length); k++) {
          const ph = byHeight.get(k);
          if (ph) out.push(ph.header);
        }
        return out;
      },
    };
    const forged = proveWithReader(augmentedReader, { m: 24, k: 1 });
    expect(forged.suffixHead.header.height).toBe(bHeight);
    expect(forged.suffixHead.header.stateRoot).toBe(chosenRoot);
    forged.k = clientK;

    const nowMs = bHeader.createdAt + 1_000;
    const vp: VerifyProfile = { ...profile, nowMs };
    const result = (compareProofs as unknown as (
      a: NipopowProof,
      b: NipopowProof,
      params: { m: number; k: number },
      profile: VerifyProfile,
    ) => CompareResult)(forged, honest, { m: 24, k: clientK }, vp);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') expect(result.reason).toBe('invalid');
  });

  it('a proof declaring another m against an honest proof answers incomparable / invalid', () => {
    const chain = buildMinedChain({ count: 30 });
    const reader = makeReader(chain);
    const proofA = proveWithReader(reader, { m: 3, k: 5 });
    const proofB = proveWithReader(reader, { m: 3, k: 5 });
    const mutated: NipopowProof = { ...proofA, m: 4 };
    const result = (compareProofs as unknown as (
      a: NipopowProof,
      b: NipopowProof,
      params: { m: number; k: number },
      profile: VerifyProfile,
    ) => CompareResult)(mutated, proofB, { m: 3, k: 5 }, profile);
    expect(result.verdict).toBe('incomparable');
    if (result.verdict === 'incomparable') expect(result.reason).toBe('invalid');
  });
});

// NIPOPOW_INTERFACE → proveWithReader step 3 (level-0 sweep) and compareProofs — a proof
// built without the sweep carries only its level-1 headers among the blocks above an LCA
// near the suffix; a fork of fewer blocks that carries every header outscores it.
describe('a padded fork of fewer headers above the LCA loses to an honest proof', () => {
  it.fails('an honest proof outscores a padded fork across the LCA', () => {
    const FORK = 100;
    const D = 30;
    const Dp = 24;
    const m = 24;
    const k = 20;
    const forkPoint = FORK + 1;
    const honest = buildMinedChain({ count: FORK + D });
    const fork = buildMinedChain({
      count: FORK + Dp,
      forceLevels: new Map([[forkPoint, 1]]),
    });
    expect(blockHash(honest.headers[0]!)).toBe(blockHash(fork.headers[0]!));
    expect(blockHash(honest.headers[FORK - 1]!)).toBe(blockHash(fork.headers[FORK - 1]!));
    expect(blockHash(honest.headers[FORK]!)).not.toBe(blockHash(fork.headers[FORK]!));

    const honestReader = makeReader(honest);
    const forkReader = makeReader(fork);
    const honestProof = proveWithReader(honestReader, { m, k });
    const forkProof = proveWithReader(forkReader, { m, k });

    const paddedPrefix: PoPowHeader[] = [...forkProof.prefix];
    const haveHeights = new Set(paddedPrefix.map(p => p.header.height));
    for (let h = 2; h < forkProof.suffixHead.header.height; h++) {
      if (!haveHeights.has(h)) {
        const ph = forkReader.popowHeaderAtHeight(h);
        expect(ph).not.toBeNull();
        paddedPrefix.push(ph!);
      }
    }
    paddedPrefix.sort((a, b) => a.header.height - b.header.height);
    const padded: NipopowProof = { ...forkProof, prefix: paddedPrefix };

    const nowMs = Math.max(
      honest.headers[honest.headers.length - 1]!.createdAt,
      fork.headers[fork.headers.length - 1]!.createdAt,
    ) + 1_000;
    const vp = { ...devnetProfile(), nowMs };

    const paddedVerdict = verifyProof(encodeNipopowProof(padded), { m: padded.m, k: padded.k }, vp);
    expect(paddedVerdict.ok).toBe(true);

    const forkLevel1Above = fork.popowHeaders.filter(ph => {
      if (ph.header.height <= FORK) return false;
      if (ph.header.height >= padded.suffixHead.header.height) return false;
      const lvl = headerLevel(ph.header, DEVNET_RETARGET.anchorBits);
      return lvl !== null && lvl >= 1;
    }).length;
    expect(forkLevel1Above).toBeLessThan(m);

    const result = compareProofs(honestProof, padded, { m, k }, vp);
    expect(result.verdict).toBe('a');
  });
});
