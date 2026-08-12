/**
 * The PoW difficulty constants and the units they are denominated in.
 *
 * TYPES_INTERFACE → Protocol Constants states what these are; the units and the
 * resolution band are VALIDATION_INTERFACE → orderingPowTarget and
 * VALIDATION_INTERFACE → blockWork / cumulativeWork. The two denominations are
 * not interchangeable, and nothing in the type system separates them, so the
 * relationships below are what hold them apart.
 */

import { describe, it, expect } from 'vitest';
import {
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  POST_POW_TARGET_BITS,
  NETWORK_PROFILES,
} from '../src/index.js';

describe('PoW difficulty constants', () => {
  // VALIDATION_INTERFACE → orderingPowTarget: ordering-block difficulty is an
  // integer in units of 1/256 of a bit, domain [0, 65536]. The seed is 23.375 bits
  // — 23 + 3/8, a difficulty no whole bit count can express and one these units
  // carry exactly, which is what they exist for.
  it('denominates ordering-block difficulty in 1/256 of a bit', () => {
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBe(5984);
    expect(ORDERING_BLOCK_POW_TARGET_BITS % 256).not.toBe(0);
    expect(ORDERING_BLOCK_POW_TARGET_BITS / 256).toBe(23.375);
  });

  // Post PoW is fixed difficulty and is never retargeted, so it is not scaled.
  // VALIDATION_INTERFACE → powTarget / meetsPowTarget keeps its [0, 256] domain.
  it('leaves post difficulty in whole bits', () => {
    expect(POST_POW_TARGET_BITS).toBe(20);
  });

  // NOT the x256 rescale of 4. VALIDATION_INTERFACE → blockWork / cumulativeWork:
  // work resolves on [2305, 63357] and at neither end, so a chain admitted below
  // 2180 retargets without moving the quantity fork choice selects on. The floor
  // puts every reachable difficulty inside that band; it cannot put every
  // admitted one there, since the top edge is bounded by the target.
  it('puts the floor above the work-resolution floor', () => {
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBe(9 * 256);
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBeGreaterThan(2180);
  });

  // Every value the floor admits is outside powTarget's [0, 256] domain, so an
  // unmigrated miner throws instead of mining at 1/256 the intended difficulty.
  it('puts the floor above the integer-bit domain', () => {
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBeGreaterThan(256);
  });

  // Both constants are difficulties in the same units, so the seed may not sit
  // under the floor that bounds it.
  it('seeds the chain at or above its own floor', () => {
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBeGreaterThanOrEqual(
      ORDERING_BLOCK_POW_TARGET_FLOOR,
    );
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBeLessThanOrEqual(65536);
  });

  // Devnet exists to exercise the retarget, so it may not be seeded blind.
  // DEVNET_PROFILE is module-private; NETWORK_PROFILES is the exported handle.
  it('seeds devnet above the work-resolution floor', () => {
    expect(NETWORK_PROFILES.devnet.orderingBlockPowTargetBits).toBeGreaterThan(2180);
    expect(NETWORK_PROFILES.devnet.postPowTargetBits).toBe(4);
  });

  // TYPES_INTERFACE → Ordering block PoW: the constant is mainnet's and testnet's,
  // and devnet sets its own, lower. Testnet reaches the value through a spread of
  // mainnet rather than a literal, so this is what catches the spread being
  // replaced by a copy that then fails to follow the constant.
  it('carries a real difficulty on testnet, and devnet does not follow it', () => {
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBe(5984);
    expect(NETWORK_PROFILES.testnet.orderingBlockPowTargetBits).toBe(5984);
    expect(NETWORK_PROFILES.devnet.orderingBlockPowTargetBits).toBe(3072);
    expect(NETWORK_PROFILES.devnet.orderingBlockPowTargetBits).toBeLessThan(
      NETWORK_PROFILES.testnet.orderingBlockPowTargetBits,
    );
  });
});
