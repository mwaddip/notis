/**
 * Protocol constants whose value is a relationship rather than a number: the PoW
 * difficulties and the units they are denominated in, and the reorg bound.
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
  MAX_REORG_DEPTH,
  NETWORK_PROFILES,
  COINBASE_TREASURY_PCT,
  COINBASE_MINER_FLOOR_PCT,
  COINBASE_BACKER_PCT,
  COINBASE_BONUS_PCT,
  INCLUSION_BONUS_K,
  MEMPOOL_CREDIT_SHARE_PCT,
  MIN_FEE_RATE_PER_BYTE,
  BOX_VALUE_BOUND,
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

  // ⛔ There is exactly ONE PoW constant, and consensus is single-phase.
  // `POST_POW_TARGET_BITS` is deleted with post PoW — a post is admitted by the
  // stateful karma lock, not by a proof of burned milliseconds.
  it('has no post-PoW difficulty', async () => {
    const constants = await import('../src/constants.js') as Record<string, unknown>;
    expect(constants.POST_POW_TARGET_BITS).toBeUndefined();
    expect(constants.CHALLENGE_WINDOW_BLOCKS).toBeUndefined();
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

/**
 * The reorg bound.
 *
 * It lives in this package so that `@dagsocial/node`'s `config.ts` can reach it:
 * the constant's node-side home imports `config` itself, so the edge back would
 * close a cycle. Nothing here reads it — every consumer is in node — which is
 * exactly why its domain and its universality are pinned at the source.
 */
describe('MAX_REORG_DEPTH', () => {
  it('is a positive count of blocks', () => {
    expect(MAX_REORG_DEPTH).toBe(20);
    // It is subtracted from a height and compared against a walk depth, so a
    // non-integer or a zero is not a smaller window — it is a retention cutoff
    // above the tip and a fork walk that never runs.
    expect(Number.isSafeInteger(MAX_REORG_DEPTH)).toBe(true);
    expect(MAX_REORG_DEPTH).toBeGreaterThan(0);
  });

  // TYPES_INTERFACE → Network profiles: every constant outside `NetworkProfile`
  // is universal, and a constant moved into it is a place devnet may behave
  // unlike mainnet. Making this one per-network is a live proposal, so the
  // absence is asserted rather than assumed.
  it('is universal, not a per-network profile field', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.hasOwn(profile, 'maxReorgDepth')).toBe(false);
    }
  });
});

/**
 * The coinbase slices and the dials the fee market turns.
 *
 * MINING_INTERFACE → Coinbase Application states the slice table and the bonus
 * curve; MEMPOOL_INTERFACE → Eviction, inside the credit class only and → Fee
 * floor state the pool's two classes and the relay floor. Each is a bare
 * `export const` with no arithmetic relationship the compiler can see, so the
 * relationships between them are asserted here or nowhere.
 */
describe('coinbase slices', () => {
  // The load-bearing one. The sum of the settlement transaction's coinbase
  // outputs must equal income exactly at apply,
  // and four independent percentages of one income are not required by any type
  // to add up to it — a retune that moves one and forgets another produces a
  // coinbase no height can satisfy.
  it('sums to exactly 100', () => {
    expect(
      COINBASE_TREASURY_PCT +
        COINBASE_MINER_FLOOR_PCT +
        COINBASE_BACKER_PCT +
        COINBASE_BONUS_PCT,
    ).toBe(100);
  });

  // Every slice is a percentage of income taken by integer division, so a
  // negative one is a mint and a >100 one is a slice larger than the income it
  // is cut from. Neither is expressible in `number`.
  it('holds four percentages inside [0, 100]', () => {
    for (const pct of [
      COINBASE_TREASURY_PCT,
      COINBASE_MINER_FLOOR_PCT,
      COINBASE_BACKER_PCT,
      COINBASE_BONUS_PCT,
    ]) {
      expect(Number.isSafeInteger(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });

  // The floor is what the miner is guaranteed regardless of what they include,
  // and the bonus is what they forfeit by including nothing. A zero floor makes
  // an empty block worth only its treasury slice; a zero bonus prices inclusion
  // at nothing and the whole curve stops paying for anything.
  it('guarantees the miner a floor and leaves a bonus to earn', () => {
    expect(COINBASE_MINER_FLOOR_PCT).toBeGreaterThan(0);
    expect(COINBASE_BONUS_PCT).toBeGreaterThan(0);
  });
});

describe('the inclusion bonus curve', () => {
  // `pool × actors / (actors + K)`. At K = 0 the quotient is 0/0 at zero actors
  // and 1 everywhere else — a step, not a curve, and the marginal actor is worth
  // nothing past the first.
  it('has a positive knee', () => {
    expect(INCLUSION_BONUS_K).toBeGreaterThan(0n);
  });

  // It is added to a `BigInt(actors)` and divides a bigint pool. A `number` here
  // is a TypeError at the first block that carries an actor, not a rounding
  // difference.
  it('is a bigint, because it denominates the divisor of a bigint pool', () => {
    expect(typeof INCLUSION_BONUS_K).toBe('bigint');
  });
});

describe('mempool policy dials', () => {
  // The credit class exists to bound credit entries, and the karma-side class is
  // whatever is left. At 100 the pool goes all-credit under a flood, which is
  // the state the two classes exist to prevent; at 0 no credit transaction is
  // ever poolable and the fee market has no venue.
  it('leaves both classes a share of the pool', () => {
    expect(Number.isSafeInteger(MEMPOOL_CREDIT_SHARE_PCT)).toBe(true);
    expect(MEMPOOL_CREDIT_SHARE_PCT).toBeGreaterThan(0);
    expect(MEMPOOL_CREDIT_SHARE_PCT).toBeLessThan(100);
  });

  // Base units per IN-BLOCK byte — `entryByteCost`, not the bare encoding —
  // compared against a bigint rate. Zero is the
  // shipped default and a legitimate value — the seam exists so an operator can
  // raise it — but a negative floor would admit a transaction paying nothing and
  // report it as having cleared a bar.
  it('carries a non-negative bigint fee floor', () => {
    expect(typeof MIN_FEE_RATE_PER_BYTE).toBe('bigint');
    expect(MIN_FEE_RATE_PER_BYTE).toBeGreaterThanOrEqual(0n);
  });
});

describe('box value domain', () => {
  // TYPES_INTERFACE → Box value domain. The number is a relationship rather
  // than a magnitude: it is where SQLite's signed `INTEGER` stops, which is what
  // puts the accepted domain under the encodable one.
  it('sits exactly where a signed 64-bit integer stops', () => {
    // Demonstrated, not restated. The largest accepted value survives a signed
    // 64-bit reading; the bound itself comes back negative, which is the bind
    // the ledger refuses.
    expect(BigInt.asIntN(64, BOX_VALUE_BOUND - 1n)).toBe(BOX_VALUE_BOUND - 1n);
    expect(BigInt.asIntN(64, BOX_VALUE_BOUND)).toBeLessThan(0n);
  });

  // ⛔ Conflating the encodable domain with the accepted one is the defect this
  // constant exists to prevent, so what gets pinned is the GAP between them.
  it('is one bit below the encodable ceiling', () => {
    expect(BOX_VALUE_BOUND).toBe(1n << 63n);
    expect(BOX_VALUE_BOUND * 2n).toBe(1n << 64n);
  });

  // Denomination (TYPES_INTERFACE → Denomination): a box value is a bigint, so
  // the bound naming its domain is one too — a `number` here would lose the
  // last eleven bits of the domain it bounds.
  it('is a bigint', () => {
    expect(typeof BOX_VALUE_BOUND).toBe('bigint');
  });
});
