/**
 * The karma valuation — the one implementation of the effective-balance
 * function the node and the light client both run (TYPES_INTERFACE →
 * Identity record and karma valuation).
 *
 * Each test's title names the formula it pins, so a failure names the rule
 * it broke; the numbers derive from the constants and the profile so the
 * tests survive the next constant change.
 */

import { describe, it, expect } from 'vitest';
import {
  DecayCfg,
  decayCfgFor,
  decaySettledThrough,
  effectiveKarma,
  owedPeriods,
} from '../src/karma-valuation.js';
import type { IdentityRecord } from '../src/identity-record.js';
import { KARMA_DECAY_AMOUNT, KARMA_MINIMUM } from '../src/constants.js';
import { profileFor, type NetworkType } from '../src/network.js';

function clock(lastActivityBlock: number, lastDecayBlock = 0): IdentityRecord {
  return {
    lastActivityBlock,
    lastDecayBlock,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 0,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
  };
}

// The mainnet cfg, used by the valuation-edge tests below. Sourced through
// `decayCfgFor` so a change in the profile flows through here without a
// second definition.
const MAINNET = profileFor('mainnet');
const TEST_CFG: DecayCfg = decayCfgFor(MAINNET);

describe('decayCfgFor', () => {
  const NETWORKS: NetworkType[] = ['devnet', 'testnet', 'mainnet'];

  for (const network of NETWORKS) {
    it(`derives the cfg from the ${network} profile and the two constants`, () => {
      const profile = profileFor(network);
      const cfg = decayCfgFor(profile);
      expect(cfg.staleThresholdBlocks).toBe(profile.karmaStaleThresholdBlocks);
      expect(cfg.decayIntervalBlocks).toBe(profile.karmaDecayIntervalBlocks);
      // ⛔ Assert against the constants, not against literals copied from the
      // profile — the point is that these two are universal economics and do
      // not vary per network.
      expect(cfg.decayAmount).toBe(KARMA_DECAY_AMOUNT);
      expect(cfg.karmaMinimum).toBe(KARMA_MINIMUM);
    });
  }
});

describe('the window boundary and the null / `clock(0)` start', () => {
  // The window ends at `A + T` and `owedPeriods` is 0 there (`TYPES_INTERFACE
  // → Identity record and karma valuation → "Decay starts at the grace
  // window's end, from nothing"`). A `null` record and a `clock(0)` record
  // both value from the window — their clock starts at `staleThresholdBlocks`.
  const T = TEST_CFG.staleThresholdBlocks;
  const face = 10_000n;

  it('the window ends at `A + T`: `owedPeriods` is 0 and the face stands', () => {
    expect(owedPeriods(clock(100), 100 + T, TEST_CFG)).toBe(0);
    expect(effectiveKarma(face, clock(100), 100 + T, TEST_CFG)).toBe(face);
  });

  it('one block before the window ends: `owedPeriods` is negative and the face stands', () => {
    expect(owedPeriods(clock(100), 99 + T, TEST_CFG)).toBeLessThan(0);
    expect(effectiveKarma(face, clock(100), 99 + T, TEST_CFG)).toBe(face);
  });

  it('a `null` record values from the window: at `T` the face stands, past `T + I` it decays', () => {
    expect(owedPeriods(null, T, TEST_CFG)).toBe(0);
    expect(effectiveKarma(face, null, T, TEST_CFG)).toBe(face);
    // One past the window's end still owes nothing — the first period lands at `T + I`.
    expect(owedPeriods(null, T + 1, TEST_CFG)).toBe(0);
    expect(effectiveKarma(face, null, T + 1, TEST_CFG)).toBe(face);
  });

  it('a `lastActivityBlock 0` record values from the window: at `T` the face stands, past `T + I` it decays', () => {
    expect(owedPeriods(clock(0), T, TEST_CFG)).toBe(0);
    expect(effectiveKarma(face, clock(0), T, TEST_CFG)).toBe(face);
    expect(owedPeriods(clock(0), T + 1, TEST_CFG)).toBe(0);
    expect(effectiveKarma(face, clock(0), T + 1, TEST_CFG)).toBe(face);
  });
});

describe('owedPeriods — the `max` and the no-clamp rule', () => {
  const T = TEST_CFG.staleThresholdBlocks;
  const I = TEST_CFG.decayIntervalBlocks;

  it('the `max`: a `lastDecayBlock` past the window measures from `lastDecayBlock`', () => {
    // After a squaring has settled past the window's end, `lastDecayBlock`
    // is the start — counting from the window's end alone would re-bill every
    // period a squaring already settled
    // (TYPES_INTERFACE → Identity record and karma valuation → "The `max` in
    // `clockStart` is not decoration").
    const activityAt = 1000;
    const decayAt = activityAt + T + 2 * I; // past the window's end
    expect(owedPeriods(clock(activityAt, decayAt), decayAt + I, TEST_CFG)).toBe(1);
  });

  it('the `max`: a record whose `lastDecayBlock` sits below the window measures from the window', () => {
    // With `lastDecayBlock < lastActivityBlock + staleThresholdBlocks`, the
    // start is the window's end — `clockStart` holds the `max` of the two
    // paths together.
    const decayAt = 100;
    const activityAt = 1000;
    const height = activityAt + T + 3 * I;
    expect(owedPeriods(clock(activityAt, decayAt), height, TEST_CFG)).toBe(3);
  });

  it('no clamp: a clock ahead of the chain answers negative', () => {
    // The caller skips anything `<= 0`; swallowing a negative here would hide
    // a clock that had somehow run ahead of the chain.
    expect(owedPeriods(clock(1000), 999, TEST_CFG)).toBeLessThan(0);
  });
});

describe('effectiveKarma — the grace window and the window-end clock', () => {
  // The valuation reads the record's clock through the grace window:
  // the window ends at `A + T`, and the first period lands at `A + T + I`
  // (`TYPES_INTERFACE → Identity record and karma valuation →
  // "Decay starts at the grace window's end, from nothing"`).
  const T = TEST_CFG.staleThresholdBlocks;
  const I = TEST_CFG.decayIntervalBlocks;
  const amount = TEST_CFG.decayAmount;
  const A = 1000;
  const face = 10_000n;

  it('a record last active at A: at A + T returns face', () => {
    expect(effectiveKarma(face, clock(A), A + T, TEST_CFG)).toBe(face);
  });

  it('a record last active at A: at A + T + I − 1 returns face', () => {
    expect(effectiveKarma(face, clock(A), A + T + I - 1, TEST_CFG)).toBe(face);
  });

  it('a record last active at A: at A + T + I returns face − decayAmount', () => {
    expect(effectiveKarma(face, clock(A), A + T + I, TEST_CFG)).toBe(face - amount);
  });

  it('a record last active at A: at A + T + 3I returns face − 3·decayAmount', () => {
    expect(effectiveKarma(face, clock(A), A + T + 3 * I, TEST_CFG)).toBe(face - 3n * amount);
  });

  it('a record with lastDecayBlock past the window: periods count from it, not from the window', () => {
    const D = A + T + 5 * I;
    // Each height carries its own `expect`: before `D`, nothing owed; at `D + I`
    // the first period lands; at `D + 2I` the second.
    expect(effectiveKarma(face, clock(A, D), D, TEST_CFG)).toBe(face);
    expect(effectiveKarma(face, clock(A, D), D + I - 1, TEST_CFG)).toBe(face);
    expect(effectiveKarma(face, clock(A, D), D + I, TEST_CFG)).toBe(face - amount);
    expect(effectiveKarma(face, clock(A, D), D + 2 * I, TEST_CFG)).toBe(face - 2n * amount);
  });

  it('a null record: at T returns face', () => {
    expect(effectiveKarma(face, null, T, TEST_CFG)).toBe(face);
  });

  it('a null record: at T + I − 1 returns face', () => {
    expect(effectiveKarma(face, null, T + I - 1, TEST_CFG)).toBe(face);
  });

  it('a null record: at T + I returns face − decayAmount', () => {
    expect(effectiveKarma(face, null, T + I, TEST_CFG)).toBe(face - amount);
  });

  it('a clock(0) record: at T returns face', () => {
    expect(effectiveKarma(face, clock(0), T, TEST_CFG)).toBe(face);
  });

  it('a clock(0) record: at T + I − 1 returns face', () => {
    expect(effectiveKarma(face, clock(0), T + I - 1, TEST_CFG)).toBe(face);
  });

  it('a clock(0) record: at T + I returns face − decayAmount', () => {
    expect(effectiveKarma(face, clock(0), T + I, TEST_CFG)).toBe(face - amount);
  });
});

describe('effectiveKarma — the four edges', () => {
  it('well within the grace window returns the face total', () => {
    // 99000 activity out of a 100000 height — the window ends at 99000 + T,
    // well above the read height, so `owedPeriods` is negative and the face
    // stands.
    expect(effectiveKarma(100n, clock(99000), 100000, TEST_CFG)).toBe(100n);
  });

  it('`owedPeriods` of 0 returns the face total', () => {
    // `clockStart = max(1 + T, T + 1) = T + 1`, so at height `T + 1`
    // `owedPeriods` is 0 and no burn lands.
    const rec = clock(1, TEST_CFG.staleThresholdBlocks + 1);
    const height = TEST_CFG.staleThresholdBlocks + 1;
    expect(owedPeriods(rec, height, TEST_CFG)).toBe(0);
    expect(effectiveKarma(100n, rec, height, TEST_CFG)).toBe(100n);
  });

  it('one period subtracts `decayAmount`', () => {
    // One whole interval past the window's end, with a face total above
    // the floor.
    const rec = clock(1000);
    const height =
      1000 + TEST_CFG.staleThresholdBlocks + TEST_CFG.decayIntervalBlocks;
    const face = 10_000n;
    expect(owedPeriods(rec, height, TEST_CFG)).toBe(1);
    expect(effectiveKarma(face, rec, height, TEST_CFG)).toBe(
      face - TEST_CFG.decayAmount,
    );
  });

  it('floor = min(faceTotal, karmaMinimum): a face total below the minimum never decays below itself', () => {
    const rec = clock(1000);
    const height =
      1000 + TEST_CFG.staleThresholdBlocks + 1000 * TEST_CFG.decayIntervalBlocks;
    const face = TEST_CFG.karmaMinimum - 1n;
    expect(effectiveKarma(face, rec, height, TEST_CFG)).toBe(face);
  });

  it('floor = min(faceTotal, karmaMinimum): a face total above the minimum never decays below it', () => {
    const rec = clock(1000);
    const height =
      1000 + TEST_CFG.staleThresholdBlocks + 1000 * TEST_CFG.decayIntervalBlocks;
    const face = TEST_CFG.karmaMinimum + 100n;
    expect(effectiveKarma(face, rec, height, TEST_CFG)).toBe(TEST_CFG.karmaMinimum);
  });

  it('a null record values as never active — decaying from the window', () => {
    // A null record values as `EMPTY_IDENTITY_RECORD` — its clock starts at
    // `staleThresholdBlocks`. 1000 whole intervals past the window burns the
    // face down to the floor.
    const height =
      TEST_CFG.staleThresholdBlocks + 1000 * TEST_CFG.decayIntervalBlocks;
    expect(owedPeriods(null, height, TEST_CFG)).toBe(1000);
    expect(effectiveKarma(100n, null, height, TEST_CFG)).toBe(TEST_CFG.karmaMinimum);
  });
});

describe('decaySettledThrough — the height a squaring writes as `lastDecayBlock`', () => {
  const T = TEST_CFG.staleThresholdBlocks;
  const I = TEST_CFG.decayIntervalBlocks;
  const A = 1000;

  it('a squaring at `A + T + 2I + 3` settles through `A + T + 2I`, keeping the 3 blocks', () => {
    // `owedPeriods` is 2 and the part of the third period that has run — 3
    // blocks — stays owed; the next squaring counts it
    // (NODE_INTERFACE → Karma decay → "A squaring writes the height it
    // settles through, never its own height").
    const height = A + T + 2 * I + 3;
    expect(owedPeriods(clock(A), height, TEST_CFG)).toBe(2);
    expect(decaySettledThrough(clock(A), height, TEST_CFG)).toBe(A + T + 2 * I);
  });

  it('one period past a `lastDecayBlock` start settles through `lastDecayBlock + I`', () => {
    // `lastDecayBlock` sits past the window's end, so `clockStart` is
    // `lastDecayBlock`; a squaring one period past it settles through
    // `lastDecayBlock + I`, with the 7 extra blocks still owed.
    const D = A + T + 5 * I;
    const height = D + I + 7;
    expect(owedPeriods(clock(A, D), height, TEST_CFG)).toBe(1);
    expect(decaySettledThrough(clock(A, D), height, TEST_CFG)).toBe(D + I);
  });
});
