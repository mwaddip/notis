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
  RETARGET_HALFLIFE_BLOCKS,
  MAX_FUTURE_DRIFT_MS,
  GENESIS_PREV_BLOCK_HASH,
  NETWORK_PROFILES,
  COINBASE_TREASURY_PCT,
  COINBASE_MINER_FLOOR_PCT,
  COINBASE_BACKER_PCT,
  COINBASE_BONUS_PCT,
  INCLUSION_BONUS_K,
  MEMPOOL_CREDIT_SHARE_PCT,
  MIN_FEE_RATE_PER_BYTE,
  BOX_VALUE_BOUND,
  INVITE_BOND_MIN,
  INVITE_BOND_MAX,
  INVITE_BOND_VEST_PER_LIKES,
  LIKES_PER_KARMA_PAYOUT,
  LIKE_KARMA_COST,
  MIN_BOX_VALUE_PER_BYTE,
  STORAGE_RENT_PER_BYTE,
  MAX_BLOCK_BODY_BYTES,
  MAX_SETTLEMENT_BYTES,
  VOUCH_CAST_HEIGHT_WINDOW,
  SYSTEM_KARMA_INITIAL,
  FAUCET_CREDITS_INITIAL,
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

  // NOT the x256 rescale of 4. VALIDATION_INTERFACE → blockWork / cumulativeWork:
  // work resolves on [2305, 63357] and at neither end, so a chain admitted below
  // 2180 retargets without moving the quantity fork choice selects on. The floor
  // puts every reachable difficulty inside that band; it cannot put every
  // admitted one there, since the top edge is bounded by the target.
  it('puts the floor above the work-resolution floor', () => {
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBe(9 * 256);
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBeGreaterThan(2180);
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

  // MINING_INTERFACE → Difficulty Schedule: the halflife in ideal intervals,
  // universal across networks. 288 × 60_000 ms = 17_280_000 ms (4.8 h).
  it('RETARGET_HALFLIFE_BLOCKS is the ASERT halflife in ideal intervals', () => {
    expect(RETARGET_HALFLIFE_BLOCKS).toBe(288);
    expect(typeof RETARGET_HALFLIFE_BLOCKS).toBe('number');
    expect(RETARGET_HALFLIFE_BLOCKS * 60_000).toBe(17_280_000);
  });

  // MINING_INTERFACE → Header timestamp rules: the future bound on createdAt.
  // 600_000 / 60_000 = 10 — a lying clock buys at most 10 blocks, ever.
  it('MAX_FUTURE_DRIFT_MS is the future bound on createdAt', () => {
    expect(MAX_FUTURE_DRIFT_MS).toBe(600_000);
    expect(typeof MAX_FUTURE_DRIFT_MS).toBe('number');
    expect(MAX_FUTURE_DRIFT_MS / 60_000).toBe(10);
  });
});

/**
 * The genesis anchor — the `prevBlockHash` a height-1 block carries.
 *
 * TYPES_INTERFACE → Genesis parent hash. Heights start at 1, so no header
 * hashes to this value; it is a sentinel by construction.
 */
describe('GENESIS_PREV_BLOCK_HASH', () => {
  it('is 64 hex zero characters', () => {
    expect(GENESIS_PREV_BLOCK_HASH).toBe('0'.repeat(64));
    expect(GENESIS_PREV_BLOCK_HASH).toHaveLength(64);
  });

  it('is a string, not bytes', () => {
    expect(typeof GENESIS_PREV_BLOCK_HASH).toBe('string');
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

/**
 * Credit floor and storage rent — TYPES_INTERFACE → Box value domain.
 *
 * Both are consensus constants in base units per byte of a box's record.
 * Derived from Ergo's, scaled by the supply ratio; the ratio between the
 * two is preserved rather than chosen twice.
 */
describe('credit floor and storage rent', () => {
  it('pins both values as consensus constants', () => {
    expect(MIN_BOX_VALUE_PER_BYTE).toBe(156n);
    expect(STORAGE_RENT_PER_BYTE).toBe(605_378n);
  });

  it('denominates both as bigint per byte', () => {
    expect(typeof MIN_BOX_VALUE_PER_BYTE).toBe('bigint');
    expect(typeof STORAGE_RENT_PER_BYTE).toBe('bigint');
    expect(MIN_BOX_VALUE_PER_BYTE).toBeGreaterThan(0n);
    expect(STORAGE_RENT_PER_BYTE).toBeGreaterThan(0n);
  });

  // TYPES_INTERFACE → Box value domain: a box sitting at the minimum is
  // consumed at its first collection. The floor prevents spam creation;
  // surviving rent needs a deliberate buffer.
  it('rent per byte exceeds the floor per byte', () => {
    expect(STORAGE_RENT_PER_BYTE).toBeGreaterThan(MIN_BOX_VALUE_PER_BYTE);
  });

  it('a 100-byte box at the floor cannot cover one period of rent', () => {
    const bytes = 100n;
    const floorValue = MIN_BOX_VALUE_PER_BYTE * bytes;   // 15,600
    const rentCharge = STORAGE_RENT_PER_BYTE * bytes;     // 60,537,800
    expect(floorValue).toBe(15_600n);
    expect(rentCharge).toBe(60_537_800n);
    expect(floorValue).toBeLessThan(rentCharge);
  });
});

/**
 * Invite economics — the bond range and the supply dial.
 *
 * TYPES_INTERFACE → Protocol Constants. The grant equals the bond, so the pair
 * of numbers that could drift apart is one number; what remains to pin is the
 * range an inviter picks inside, and the ratio deciding whether a completed
 * invite adds to circulating supply or takes from it.
 */
describe('invite economics', () => {
  it('the bond range is ordered and its floor is positive', () => {
    expect(INVITE_BOND_MIN).toBeGreaterThan(0n);
    expect(INVITE_BOND_MAX).toBeGreaterThanOrEqual(INVITE_BOND_MIN);
  });

  // Denomination (TYPES_INTERFACE → Denomination): both bounds are compared
  // against a box value, which is a bigint. A `number` bound is a TypeError at
  // the first invite rather than a looser range.
  it('denominates both bounds as karma', () => {
    expect(typeof INVITE_BOND_MIN).toBe('bigint');
    expect(typeof INVITE_BOND_MAX).toBe('bigint');
  });

  // The supply dial. Vesting a bond `B` takes `INVITE_BOND_VEST_PER_LIKES · B`
  // likes, and the like settlement sends `1 / LIKES_PER_KARMA_PAYOUT` of every
  // karma spent on likes to the pool, so one completed invite moves
  // `B · (1 − V/L)` into circulation. `V < L` is what lets the network inflate
  // at all: at `V == L` a completed invite is exactly delta-neutral.
  it('vests cheaper than the like leak, so invites inflate supply', () => {
    expect(INVITE_BOND_VEST_PER_LIKES).toBeLessThan(LIKES_PER_KARMA_PAYOUT);
  });

  it('sends 40% of each bond to circulation at the current dials', () => {
    const V = INVITE_BOND_VEST_PER_LIKES;
    const L = LIKES_PER_KARMA_PAYOUT;
    // ⛔ The `1 − V/L` form is a karma count only while a like costs ONE karma.
    // The settlement derives its payout from marker VALUE, so at a higher cost
    // the leak is `V · LIKE_KARMA_COST / L` and this figure is not 40%. Pinned
    // here so the arithmetic does not depend on a constant it never names.
    expect(LIKE_KARMA_COST).toBe(1n);
    expect(1 - V / L).toBeCloseTo(0.4, 10);
  });

  // ⛔ The grant IS the bond, so no second constant is free to fall below the
  // first (ARCHITECTURE → Invite System).
});

/**
 * Size caps and settlement caps — TYPES_INTERFACE → Size caps, → Settlement caps.
 *
 * The availability relation: a legal settlement fits a legal body.
 */
describe('settlement size caps', () => {
  it('a legal settlement fits inside a legal body', () => {
    expect(MAX_SETTLEMENT_BYTES).toBeLessThan(MAX_BLOCK_BODY_BYTES);
  });
});

/**
 * TYPES_INTERFACE → Vouch. The vouch cast height window bounds how far a vouch
 * output's `createdAtBlock` may lag the block carrying it
 * (NODE_INTERFACE → Vouch transition rules).
 */
describe('VOUCH_CAST_HEIGHT_WINDOW', () => {
  it('is a positive integer', () => {
    expect(Number.isSafeInteger(VOUCH_CAST_HEIGHT_WINDOW)).toBe(true);
    expect(VOUCH_CAST_HEIGHT_WINDOW).toBeGreaterThan(0);
  });

  it('is universal, not a per-network profile field', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.hasOwn(profile, 'vouchCastHeightWindow')).toBe(false);
    }
  });
});

/**
 * TYPES_INTERFACE → Genesis. The faucet identity's two seeds — karma and
 * credits at genesis, on every network whose profile names a `faucetPublicKey`
 * (NODE_INTERFACE → Faucet).
 */
describe('SYSTEM_KARMA_INITIAL', () => {
  it('is a positive bigint', () => {
    expect(typeof SYSTEM_KARMA_INITIAL).toBe('bigint');
    expect(SYSTEM_KARMA_INITIAL).toBeGreaterThan(0n);
  });

  it('is universal, not a per-network profile field', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.hasOwn(profile, 'systemKarmaInitial')).toBe(false);
    }
  });
});

describe('FAUCET_CREDITS_INITIAL', () => {
  it('is a positive bigint denominated in base units', () => {
    expect(typeof FAUCET_CREDITS_INITIAL).toBe('bigint');
    expect(FAUCET_CREDITS_INITIAL).toBeGreaterThan(0n);
    expect(FAUCET_CREDITS_INITIAL).toBe(100_000n * 10n ** 8n);
  });

  it('is universal, not a per-network profile field', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.hasOwn(profile, 'faucetCreditsInitial')).toBe(false);
    }
  });
});
