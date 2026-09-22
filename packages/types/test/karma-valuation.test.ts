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
  effectiveKarma,
  isIdentityStale,
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

describe('isIdentityStale — the `>=` and the `height <= threshold` guard', () => {
  const threshold = TEST_CFG.staleThresholdBlocks;

  it('`>=`: stale at exactly `height − lastActivityBlock === threshold`', () => {
    expect(isIdentityStale(clock(100), 100 + threshold, threshold)).toBe(true);
  });

  it('`>=`: not stale one block earlier', () => {
    expect(isIdentityStale(clock(100), 99 + threshold, threshold)).toBe(false);
  });

  it('the `height <= threshold` guard: a null record is not stale at threshold', () => {
    // With `A >= 1` the subtraction cannot reach the threshold below it, but
    // `lastActivityBlock` is 0 for a never-active identity and `0 − 0 >=
    // threshold` holds at exactly `height === threshold`. The guard is what
    // excludes it.
    expect(isIdentityStale(null, threshold, threshold)).toBe(false);
    expect(isIdentityStale(null, threshold + 1, threshold)).toBe(true);
  });

  it('the `height <= threshold` guard: a `lastActivityBlock 0` record is not stale at threshold', () => {
    expect(isIdentityStale(clock(0), threshold, threshold)).toBe(false);
    expect(isIdentityStale(clock(0), threshold + 1, threshold)).toBe(true);
  });
});

describe('owedPeriods — the `max` and the no-clamp rule', () => {
  const interval = TEST_CFG.decayIntervalBlocks;

  it('the `max`: a `lastDecayBlock` above `lastActivityBlock` measures from it', () => {
    // The `max(...)` fallback: after a decay the only karma box is the
    // decay-burn box, whose height is exactly `lastDecayBlock`. Charging from
    // `lastActivityBlock` alone would re-bill every interval since the
    // original activity.
    const activityAt = 1000;
    const decayAt = activityAt + 2 * interval;
    expect(owedPeriods(clock(activityAt, decayAt), decayAt + interval, interval)).toBe(1);
  });

  it('the `max`: a `lastActivityBlock` above `lastDecayBlock` measures from it', () => {
    const decayAt = 100;
    const activityAt = decayAt + interval;
    const height = activityAt + 3 * interval;
    expect(owedPeriods(clock(activityAt, decayAt), height, interval)).toBe(3);
  });

  it('no clamp: a clock ahead of the chain answers negative', () => {
    // The caller skips anything `<= 0`; swallowing a negative here would hide
    // a clock that had somehow run ahead of the chain.
    expect(owedPeriods(clock(1000), 999, interval)).toBeLessThan(0);
  });
});

describe('effectiveKarma — the four edges', () => {
  it('not stale returns the face total', () => {
    // 99000 activity out of a 100000 height — well inside the threshold.
    expect(effectiveKarma(100n, clock(99000), 100000, TEST_CFG)).toBe(100n);
  });

  it('stale with zero periods returns the face total', () => {
    // Stale by activity, but the interval has not passed since the last decay.
    // At exactly `lastDecayBlock + 0` the `owedPeriods` is 0, so no burn.
    const rec = clock(1, TEST_CFG.staleThresholdBlocks + 1);
    const height = TEST_CFG.staleThresholdBlocks + 1;
    expect(isIdentityStale(rec, height, TEST_CFG.staleThresholdBlocks)).toBe(true);
    expect(owedPeriods(rec, height, TEST_CFG.decayIntervalBlocks)).toBe(0);
    expect(effectiveKarma(100n, rec, height, TEST_CFG)).toBe(100n);
  });

  it('one period subtracts `decayAmount`', () => {
    // Exactly one whole interval past the activity, past the staleness
    // threshold, with a face total well above the floor.
    const rec = clock(1000);
    const height =
      1000 + TEST_CFG.staleThresholdBlocks + TEST_CFG.decayIntervalBlocks;
    // periods = floor((threshold + interval) / interval)
    const periods = BigInt(
      Math.floor(
        (TEST_CFG.staleThresholdBlocks + TEST_CFG.decayIntervalBlocks) /
          TEST_CFG.decayIntervalBlocks,
      ),
    );
    const face = 10_000n;
    expect(effectiveKarma(face, rec, height, TEST_CFG)).toBe(
      face - periods * TEST_CFG.decayAmount,
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

  it('a null record values as never active — decaying from height 0', () => {
    const height =
      TEST_CFG.staleThresholdBlocks + 1000 * TEST_CFG.decayIntervalBlocks;
    expect(effectiveKarma(100n, null, height, TEST_CFG)).toBe(TEST_CFG.karmaMinimum);
  });
});
