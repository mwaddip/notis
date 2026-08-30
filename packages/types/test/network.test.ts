import { describe, it, expect } from 'vitest';
import {
  NETWORK_PROFILES,
  profileFor,
  protocolVersionAt,
  PROTOCOL_VERSION,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  MAX_GENESIS_PROOF_PAYLOAD_BYTES,
  BOX_VALUE_BOUND,
  INVITE_BOND_VEST_PER_LIKES,
  LIKES_PER_KARMA_PAYOUT,
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '../src/index.js';
import type { NetworkType, NetworkProfile, ProtocolEra } from '../src/index.js';

// The full contract field set — TYPES_INTERFACE → Network profiles. Guards both
// directions: a missing field and an added one (per-network creep is how a devnet
// test stops catching a mainnet bug).
const REQUIRED_PROFILE_FIELDS = [
  'networkType',
  'magic',
  'orderingBlockPowTargetBits',
  'orderingBlockIdealMs',
  'orderingBlockPowTargetFloorBits',
  'orderingBlockPowTargetCeilingBits',
  'karmaDecayIntervalBlocks',
  'karmaStaleThresholdBlocks',
  'vouchCooldownBlocks',
  'inviteProbationBlocks',
  'creditMinerRewardDelay',
  'maxReorgDepth',
  'protocolVersionSchedule',
  'creditFixedRateBlocks',
  'creditEpochBlocks',
  'creditEmissionTotal',
  'genesisCommitteeKeys',
  'genesisKarmaPerMember',
  'inviteBondMin',
  'inviteBondMax',
  'membershipBarMultiplier',
  'genesisProofPayload',
  'genesisStateRoot',
  'genesisId',
  'storageRentPeriodBlocks',
].sort();

// ⛔ Optional, and the ABSENCE is the fact rather than a gap. Mainnet names no
// faucet identity, so its key set is the required list alone while the other two
// carry this as well — which is why the pin below is presence-and-allowance
// rather than one list compared for equality against all three.
const OPTIONAL_PROFILE_FIELDS = ['faucetPublicKey'];

function asciiOfMagic(magic: number): string {
  return String.fromCharCode(
    (magic >>> 24) & 0xff,
    (magic >>> 16) & 0xff,
    (magic >>> 8) & 0xff,
    magic & 0xff,
  );
}

describe('network magics', () => {
  it('spell MDAG / TDAG / DDAG', () => {
    expect(asciiOfMagic(MAGIC_MAINNET)).toBe('MDAG');
    expect(asciiOfMagic(MAGIC_TESTNET)).toBe('TDAG');
    expect(asciiOfMagic(MAGIC_DEVNET)).toBe('DDAG');
  });

  it('are pairwise distinct', () => {
    expect(new Set([MAGIC_MAINNET, MAGIC_TESTNET, MAGIC_DEVNET]).size).toBe(3);
  });

  it('KNOWN_FRAME_MAGICS is exactly the three magics, frozen', () => {
    expect(KNOWN_FRAME_MAGICS).toEqual([MAGIC_MAINNET, MAGIC_TESTNET, MAGIC_DEVNET]);
    expect(Object.isFrozen(KNOWN_FRAME_MAGICS)).toBe(true);
  });

});

describe('NETWORK_PROFILES', () => {
  it('has exactly the three networks', () => {
    expect(Object.keys(NETWORK_PROFILES).sort()).toEqual(['devnet', 'mainnet', 'testnet']);
  });

  it('each profile carries its own key as networkType and its own magic', () => {
    expect(NETWORK_PROFILES.mainnet.networkType).toBe('mainnet');
    expect(NETWORK_PROFILES.mainnet.magic).toBe(MAGIC_MAINNET);
    expect(NETWORK_PROFILES.testnet.networkType).toBe('testnet');
    expect(NETWORK_PROFILES.testnet.magic).toBe(MAGIC_TESTNET);
    expect(NETWORK_PROFILES.devnet.networkType).toBe('devnet');
    expect(NETWORK_PROFILES.devnet.magic).toBe(MAGIC_DEVNET);
  });

  it('profiles carry exactly the contract field set — nothing added, nothing missing', () => {
    const allowed = new Set([...REQUIRED_PROFILE_FIELDS, ...OPTIONAL_PROFILE_FIELDS]);
    for (const profile of Object.values(NETWORK_PROFILES)) {
      for (const field of REQUIRED_PROFILE_FIELDS) {
        expect(Object.hasOwn(profile, field), `${profile.networkType}.${field}`).toBe(true);
      }
      for (const field of Object.keys(profile)) {
        expect(allowed.has(field), `${profile.networkType}.${field}`).toBe(true);
      }
    }
  });

  it('no field names the treasury, on any network', () => {
    // ARCHITECTURE → Treasury: unspendable **by absent rule**, not by a withheld
    // key. A profile field holding a treasury key would be the withheld-key
    // shape that rule rejects — spendable by whoever holds it, and uncheckable
    // from outside. The field-set assertion above would catch a reintroduction
    // under the old name; this catches one under any name.
    for (const profile of Object.values(NETWORK_PROFILES)) {
      for (const field of Object.keys(profile)) {
        expect(field.toLowerCase(), profile.networkType).not.toContain('treasury');
      }
    }
  });

  it('table and profiles are frozen', () => {
    expect(Object.isFrozen(NETWORK_PROFILES)).toBe(true);
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.genesisCommitteeKeys)).toBe(true);
      // The schedule is a nested array of nested objects, neither of which the
      // profile's own Object.freeze reaches, so both levels are frozen at the
      // literal — the array and every era. (TYPES_INTERFACE → Version)
      expect(Object.isFrozen(profile.protocolVersionSchedule), `${profile.networkType} schedule`).toBe(true);
      expect(
        profile.protocolVersionSchedule.every((era) => Object.isFrozen(era)),
        `${profile.networkType} eras`,
      ).toBe(true);
    }
  });

  it('mainnet carries the corrected karma constants (60s-block units)', () => {
    expect(KARMA_STALE_THRESHOLD_BLOCKS).toBe(40320); // 28 days at 60s blocks
    expect(KARMA_DECAY_INTERVAL_BLOCKS).toBe(1440); // 24 hours at 60s blocks
    expect(NETWORK_PROFILES.mainnet.karmaStaleThresholdBlocks).toBe(40320);
    expect(NETWORK_PROFILES.mainnet.karmaDecayIntervalBlocks).toBe(1440);
  });

  it('testnet runs mainnet MECHANICS, differing only on identity, genesis and declared caps', () => {
    const identityOrGenesis = new Set([
      'networkType',
      'magic',
      'genesisCommitteeKeys',
      'genesisProofPayload',
      // Exempt for the same reason as the payload, and inseparably: the root is
      // the digest over a box set whose only per-network member is that
      // payload, so the two differ across networks together or not at all.
      'genesisStateRoot',
      // An identity, and a genesis input: whether it is present decides whether
      // genesis seeds a faucet's boxes at all, so it separates the two networks
      // the same way the payload does.
      'faucetPublicKey',
      // The pinned height-1 block hash — empty until a network has one.
      'genesisId',
    ]);
    // ⚠ **Caps, not mechanics** (ARCHITECTURE → "What varies per network, and
    // what must not"). Every name here is a BOUND; a formula or a ratio may not
    // join them, and the list is what makes each difference declared rather than
    // discovered. `inviteBondMin` is deliberately absent — testnet inherits
    // mainnet's floor.
    const relaxedCaps = new Set(['inviteBondMax', 'maxReorgDepth', 'membershipBarMultiplier']);
    // The version schedule is per network and stated as its own literal on each (never inherited by
    // spread), so testnet's array is a distinct reference from mainnet's even where the two schedules
    // agree — a `.toBe` here would read that reference difference as a divergence. It is neither a
    // must-match mechanic nor a declared cap that must differ: the schedule MAY diverge (mainnet's may
    // end at an earlier version than testnet's under one build), and today it does not. Its content
    // `[1@0]` and its distinct reference are pinned in the schedule tests below; this case does not
    // opine on it. TYPES_INTERFACE → Version.
    const perNetworkSchedule = new Set(['protocolVersionSchedule']);
    const { mainnet, testnet } = NETWORK_PROFILES;
    // ⛔ Derived from the profiles, never from a literal list. A hardcoded set
    // goes on passing while a field added to either profile sits uncompared, so
    // the guarantee this test states would quietly stop covering the tree.
    const fields = new Set([...Object.keys(mainnet), ...Object.keys(testnet)]);
    for (const field of fields) {
      if (identityOrGenesis.has(field) || relaxedCaps.has(field) || perNetworkSchedule.has(field)) continue;
      expect(testnet[field as keyof NetworkProfile], field).toBe(
        mainnet[field as keyof NetworkProfile],
      );
    }
    // Each declared difference is a real one — an exemption covering a field
    // that already matches is an exemption nothing checks.
    for (const field of relaxedCaps) {
      expect(testnet[field as keyof NetworkProfile], field)
        .not.toBe(mainnet[field as keyof NetworkProfile]);
    }
  });

  it('devnet decay interval is 3 and stale threshold is 500', () => {
    const devnet = NETWORK_PROFILES.devnet;
    expect(devnet.karmaDecayIntervalBlocks).toBe(3);
    expect(devnet.karmaStaleThresholdBlocks).toBe(500);
  });

  // Devnet's seed sits below mainnet's and above 2180. The floor is what makes a
  // retarget observable — under 2180 a 1/256-bit step can buy zero work, so difficulty
  // moves while cumulativeWork does not (VALIDATION_INTERFACE → blockWork /
  // cumulativeWork). The gap below mainnet is what keeps the node suite's real-PoW
  // mining affordable; `network.ts` carries the mechanism.
  // TYPES_INTERFACE → Ordering block PoW.
  it('devnet seeds ordering difficulty where a retarget is observable, but cheap', () => {
    const { mainnet, devnet } = NETWORK_PROFILES;
    expect(devnet.orderingBlockPowTargetBits).toBeGreaterThan(2180);
    expect(devnet.orderingBlockPowTargetBits).toBeLessThan(mainnet.orderingBlockPowTargetBits);
  });

  it('devnet compresses the remaining durations, preserving mainnet orderings', () => {
    const { mainnet, devnet } = NETWORK_PROFILES;
    expect(devnet.vouchCooldownBlocks).toBe(3);
    expect(devnet.inviteProbationBlocks).toBe(540);
    expect(devnet.creditMinerRewardDelay).toBe(10);
    expect(devnet.creditFixedRateBlocks).toBe(1000);
    expect(devnet.creditEpochBlocks).toBe(400);

    // Every ordering asserted on BOTH profiles, so "devnet mirrors mainnet" is
    // checked rather than assumed: a compression that quietly reorders the
    // windows fails here and not on the network it would have broken.
    for (const p of [mainnet, devnet]) {
      expect(p.creditEpochBlocks).toBeLessThan(p.creditFixedRateBlocks);
    }
  });

  // MINING_INTERFACE → Emission Schedule: the carried total must be STRICTLY
  // below the curve's own sum, because equal is the stranding case — no unpaid
  // tail for a returned bonus to drain through. The curve sum is computed here
  // from each profile's own F and E at the universal R and d; there is no
  // curve-sum function in types, so this is a carried value vs. a computed one.
  it('creditEmissionTotal is strictly below the curve sum on every profile', () => {
    const R = CREDIT_INITIAL_REWARD / (10n ** 8n);
    const d = CREDIT_REWARD_REDUCTION / (10n ** 8n);
    const epochs = Number(R / d) - 1; // 41 at R=42, d=1

    for (const profile of Object.values(NETWORK_PROFILES)) {
      const F = BigInt(profile.creditFixedRateBlocks);
      const E = BigInt(profile.creditEpochBlocks);

      const fixedRate = F * R;
      let decaySum = 0n;
      for (let k = 1; k <= epochs; k++) {
        decaySum += R - BigInt(k) * d;
      }
      const curveSum = (fixedRate + E * decaySum) * 10n ** 8n;
      const total = profile.creditEmissionTotal;

      expect(total < curveSum, `${profile.networkType}: ${total} must be < ${curveSum}`).toBe(true);
    }
  });

  it('mainnet and testnet set the rent period to four years at 60s blocks', () => {
    expect(NETWORK_PROFILES.mainnet.storageRentPeriodBlocks).toBe(2_102_400);
    expect(NETWORK_PROFILES.testnet.storageRentPeriodBlocks).toBe(2_102_400);
    // Exactly 2 × creditFixedRateBlocks, which is the relationship the contract
    // states and the profile's own comment carries.
    expect(NETWORK_PROFILES.mainnet.storageRentPeriodBlocks)
      .toBe(2 * NETWORK_PROFILES.mainnet.creditFixedRateBlocks);
  });

  // Above the deepest height any e2e scenario reaches — 51, the fork chapter's
  // strand case, measured (CONSTANTS → Per-network values) — with headroom.
  // The drift test pins both values.
  it('devnet rent period clears the deepest e2e height with headroom', () => {
    const devnet = NETWORK_PROFILES.devnet;
    expect(devnet.storageRentPeriodBlocks).toBe(100);
    expect(devnet.storageRentPeriodBlocks).toBeGreaterThan(devnet.maxReorgDepth + 7);
  });

  // TYPES_INTERFACE → Chain reorganisation: the reorg horizon bounds the fork walk,
  // the journal retention window, the refused-header purge and the AVL history floor.
  // Each profile's own literal; testnet's four hours is the largest.
  it('maxReorgDepth is 60 on mainnet, 240 on testnet, 40 on devnet', () => {
    expect(NETWORK_PROFILES.mainnet.maxReorgDepth).toBe(60);
    expect(NETWORK_PROFILES.testnet.maxReorgDepth).toBe(240);
    expect(NETWORK_PROFILES.devnet.maxReorgDepth).toBe(40);
  });

  it('every maxReorgDepth is a positive safe integer, testnet the largest', () => {
    const profiles = Object.values(NETWORK_PROFILES);
    for (const p of profiles) {
      expect(Number.isSafeInteger(p.maxReorgDepth)).toBe(true);
      expect(p.maxReorgDepth).toBeGreaterThan(0);
    }
    const largest = Math.max(...profiles.map(p => p.maxReorgDepth));
    expect(NETWORK_PROFILES.testnet.maxReorgDepth).toBe(largest);
  });

  // ARCHITECTURE → What varies per network: the multiplier is a cap, field-only.
  // Each profile's own literal, since testnet differs from mainnet and inherits
  // by spread otherwise.
  it('membershipBarMultiplier is 10 on mainnet, 1 on testnet and devnet', () => {
    expect(NETWORK_PROFILES.mainnet.membershipBarMultiplier).toBe(10);
    expect(NETWORK_PROFILES.testnet.membershipBarMultiplier).toBe(1);
    expect(NETWORK_PROFILES.devnet.membershipBarMultiplier).toBe(1);
  });

  // MINING_INTERFACE → Difficulty Schedule: the ideal interval, floor and ceiling.
  // Each profile's own literal; the band invariant holds on every profile.
  it('orderingBlockIdealMs is 60_000 on all three networks', () => {
    expect(NETWORK_PROFILES.mainnet.orderingBlockIdealMs).toBe(60_000);
    expect(NETWORK_PROFILES.testnet.orderingBlockIdealMs).toBe(60_000);
    expect(NETWORK_PROFILES.devnet.orderingBlockIdealMs).toBe(60_000);
  });

  it('orderingBlockPowTargetFloorBits per profile', () => {
    expect(NETWORK_PROFILES.mainnet.orderingBlockPowTargetFloorBits).toBe(5120);
    expect(NETWORK_PROFILES.testnet.orderingBlockPowTargetFloorBits).toBe(5120);
    expect(NETWORK_PROFILES.devnet.orderingBlockPowTargetFloorBits).toBe(2304);
  });

  it('orderingBlockPowTargetCeilingBits per profile', () => {
    expect(NETWORK_PROFILES.mainnet.orderingBlockPowTargetCeilingBits).toBe(65536);
    expect(NETWORK_PROFILES.testnet.orderingBlockPowTargetCeilingBits).toBe(65536);
    expect(NETWORK_PROFILES.devnet.orderingBlockPowTargetCeilingBits).toBe(4096);
  });

  // TYPES_INTERFACE → Network profiles: the band invariant.
  // floor ≥ ORDERING_BLOCK_POW_TARGET_FLOOR, floor ≤ anchor ≤ ceiling ≤ 65536,
  // idealMs > 0.
  it('difficulty band invariant holds on every profile', () => {
    for (const p of Object.values(NETWORK_PROFILES)) {
      expect(p.orderingBlockPowTargetFloorBits, `${p.networkType} floor ≥ FLOOR`)
        .toBeGreaterThanOrEqual(ORDERING_BLOCK_POW_TARGET_FLOOR);
      expect(p.orderingBlockPowTargetFloorBits, `${p.networkType} floor ≤ anchor`)
        .toBeLessThanOrEqual(p.orderingBlockPowTargetBits);
      expect(p.orderingBlockPowTargetBits, `${p.networkType} anchor ≤ ceiling`)
        .toBeLessThanOrEqual(p.orderingBlockPowTargetCeilingBits);
      expect(p.orderingBlockPowTargetCeilingBits, `${p.networkType} ceiling ≤ 65536`)
        .toBeLessThanOrEqual(65536);
      expect(p.orderingBlockIdealMs, `${p.networkType} idealMs > 0`)
        .toBeGreaterThan(0);
    }
  });

  it('probation outlasts the stale threshold on every profile', () => {
    // The load-bearing one, and it is a property rather than an ordering
    // preference: decay must be able to fire *during* a probation window, or no
    // run on that network ever reaches a block where the decay writer and the
    // probation reader touch one identity record. `invitedAtBlock` and
    // `lifetimeLikesReceived` are required fields, so a writer that passes `0`
    // instead of the stored value compiles — devnet is where that regression
    // becomes observable, and only above this threshold.
    for (const p of Object.values(NETWORK_PROFILES)) {
      expect(p.inviteProbationBlocks, p.networkType)
        .toBeGreaterThan(p.karmaStaleThresholdBlocks);
      // And long enough to span whole decay intervals rather than one boundary.
      expect(p.inviteProbationBlocks, p.networkType)
        .toBeGreaterThan(p.karmaDecayIntervalBlocks);
    }
  });

  it('devnet does not compress the genesis karma allocation', () => {
    const { mainnet, devnet } = NETWORK_PROFILES;
    expect(devnet.genesisKarmaPerMember).toBe(mainnet.genesisKarmaPerMember);
  });

  // The `genesis_proof` box's payload — the only field that differs across the
  // three genesis box sets, and therefore the only reason their state roots
  // differ. `genesisKarmaPerMember` is shared by all three (the test above
  // pins that), so distinctness here is not one property among several: it is
  // the whole of network identity at genesis.
  it('every profile carries a genesis proof payload, and no two share one', () => {
    const payloads = Object.values(NETWORK_PROFILES).map((p) => p.genesisProofPayload);
    for (const payload of payloads) {
      // Hex of raw bytes: even length, lowercase, non-empty. The field is a
      // string rather than a `Uint8Array` because `Object.freeze` does not
      // reach a typed array's contents, so a profile holding one would be
      // mutable in exactly the field that defines the network.
      expect(payload).toMatch(/^([0-9a-f]{2})+$/);
    }
    expect(new Set(payloads).size).toBe(3);
  });

  // Where a misconfigured payload gets caught. The three are compile-time
  // constants, so this is the only place they can be checked at all — node's
  // seeder writes whichever one its profile carries and deliberately does not
  // measure it, because a writer that checks its own input is complete only
  // until there is a second writer.
  it('every profile payload is inside the decode bound', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      // Hex, so bytes are half the characters — the bound is on the bytes the
      // box carries, not on the string that spells them.
      expect(profile.genesisProofPayload.length / 2, profile.networkType)
        .toBeLessThanOrEqual(MAX_GENESIS_PROOF_PAYLOAD_BYTES);
    }
  });

  // The pinned height-0 AVL root — Ergo's `genesisStateDigestHex`. A network's
  // whole commitment: a node whose seeded state does not reproduce its
  // profile's value is on a chain that forks from every honest peer at height 1.
  //
  // ⚠ **These are TRUSTED, not proven.** They were derived by node booting a
  // fresh store under each profile; this package holds neither the serializer
  // nor the prover that produced them, so nothing here can re-derive one. The
  // assertions below are the shape and the distinctness — the literal bytes are
  // checked where they can be, by node comparing seeded against pinned.
  it('every profile pins a genesis state root, and no two share one', () => {
    const roots = Object.values(NETWORK_PROFILES).map((p) => p.genesisStateRoot);
    for (const root of roots) {
      // 66 hex characters, not 64: the AVL+ digest is a 32-byte root label
      // followed by a one-byte tree height, which is Ergo's 33-byte shape and
      // what `EMPTY_STATE_ROOT` and the block header's `b33` stateRoot already
      // carry. A 64-char pin would fail on all three, and truncating one to fit
      // would silently drop the height byte.
      expect(root).toMatch(/^[0-9a-f]{66}$/);
    }
    expect(new Set(roots).size).toBe(3);
  });

  // The spread trap, named rather than caught sideways. `TESTNET_PROFILE` is
  // `{ ...MAINNET_PROFILE, … }`, so a value written into mainnet alone hands
  // testnet mainnet's with no type error — and the "identical except identity,
  // genesis and treasury" test above exempts both fields precisely so it cannot
  // object. The two distinctness assertions do fail on it, as a set of size 2;
  // this one fails saying which pair collided and on which field.
  it('testnet overrides both genesis fields rather than inheriting mainnet\'s', () => {
    const { mainnet, testnet } = NETWORK_PROFILES;
    expect(testnet.genesisProofPayload).not.toBe(mainnet.genesisProofPayload);
    expect(testnet.genesisStateRoot).not.toBe(mainnet.genesisStateRoot);
  });

  // TYPES_INTERFACE → Network profiles: `genesisId` pins block 1, and is
  // empty until a network has one. Devnet is always '' — every run mines
  // its own block 1.
  it('every genesisId is empty or 64 lowercase hex, and devnet is empty', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      const id = profile.genesisId;
      expect(
        id === '' || /^[0-9a-f]{64}$/.test(id),
        `${profile.networkType}.genesisId: ${JSON.stringify(id)}`,
      ).toBe(true);
    }
    expect(NETWORK_PROFILES.devnet.genesisId).toBe('');
  });

  // TYPES_INTERFACE → "genesisId pins block 1, and is empty until a network
  // has one": testnet is pinned to its mined block 1, mainnet stays unpinned.
  it('testnet genesisId pins its block 1; mainnet is unpinned', () => {
    // The literal value — 64 lowercase hex, the height-1 block's blockHash.
    expect(NETWORK_PROFILES.testnet.genesisId)
      .toBe('30865e48f876921a6b58db6bbf9f3ef82cde99058a421f4f6e34c287d1322fdc');
    expect(NETWORK_PROFILES.testnet.genesisId).toMatch(/^[0-9a-f]{64}$/);
    expect(NETWORK_PROFILES.mainnet.genesisId).toBe('');
  });
});

describe('profileFor', () => {
  it('resolves each known network to its profile', () => {
    expect(profileFor('mainnet')).toBe(NETWORK_PROFILES.mainnet);
    expect(profileFor('testnet')).toBe(NETWORK_PROFILES.testnet);
    expect(profileFor('devnet')).toBe(NETWORK_PROFILES.devnet);
  });

  it('throws on an unknown network — never falls back to mainnet', () => {
    for (const bad of ['regtest', '', 'MAINNET', 'Mainnet', 'main', 'localnet']) {
      expect(() => profileFor(bad as NetworkType), bad).toThrow(/[Uu]nknown network/);
    }
  });

  it('throws on prototype-chain keys', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => profileFor(bad as NetworkType), bad).toThrow(/[Uu]nknown network/);
    }
  });
});

/**
 * The faucet identity.
 *
 * A network that names one seeds its karma and credit boxes at genesis, and
 * those boxes reach `genesisStateRoot`. Absence is therefore chain-committed
 * rather than read from a config file.
 */
describe('faucet identity per network', () => {
  // ⛔ **Absence IS the mainnet gate, and it is the whole of it.** No boolean
  // states the same fact a second time, so a mainnet faucet is unrepresentable
  // rather than merely disallowed.
  it('mainnet names no faucet identity', () => {
    expect(profileFor('mainnet').faucetPublicKey).toBeUndefined();
    expect(Object.hasOwn(profileFor('mainnet'), 'faucetPublicKey')).toBe(false);
  });

  it('mainnet is the only profile without one', () => {
    const absent = Object.values(NETWORK_PROFILES)
      .filter((p) => p.faucetPublicKey === undefined)
      .map((p) => p.networkType);
    expect(absent).toEqual(['mainnet']);
  });

  it('testnet and devnet name DIFFERENT faucet identities', () => {
    const t = profileFor('testnet').faucetPublicKey;
    const d = profileFor('devnet').faucetPublicKey;
    // A raw Ed25519 public key, 32 bytes as lowercase hex — the shape the
    // verifier rebuilds a KeyObject from.
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    // ⛔ Sharing one key would make the fixture key and the live key one key:
    // devnet's secret is in tracked source and reaches CI, testnet's guards a
    // balance testers depend on.
    expect(t).not.toBe(d);
  });
});

/**
 * The invite bond caps.
 *
 * ⚠ **Caps, not mechanics** (ARCHITECTURE → "What varies per network, and what
 * must not"). The vesting formula and the `V/L` supply dial are universal; only
 * the bounds an inviter picks between vary.
 */
describe('invite bond caps per network', () => {
  it('every profile orders its own range', () => {
    for (const n of ['mainnet', 'testnet', 'devnet'] as const) {
      const p = profileFor(n);
      expect(p.inviteBondMax, n).toBeGreaterThanOrEqual(p.inviteBondMin);
      expect(p.inviteBondMin, n).toBeGreaterThan(0n);
    }
  });

  // Denomination: both bounds are compared against a box value, so both are
  // bigint on every profile — including the ones written as literals here
  // rather than reached through a constant.
  it('denominates every bound as karma, inside the box value domain', () => {
    for (const p of Object.values(NETWORK_PROFILES)) {
      expect(typeof p.inviteBondMin, p.networkType).toBe('bigint');
      expect(typeof p.inviteBondMax, p.networkType).toBe('bigint');
      expect(p.inviteBondMax, p.networkType).toBeLessThan(BOX_VALUE_BOUND);
    }
  });

  it('testnet relaxes the ceiling above mainnet, and mechanics are untouched', () => {
    expect(profileFor('testnet').inviteBondMax)
      .toBeGreaterThan(profileFor('mainnet').inviteBondMax);
    // The dial that decides whether an invite inflates supply is universal, so
    // testnet's larger bound moves the size of a grant and nothing about how
    // one settles.
    expect(INVITE_BOND_VEST_PER_LIKES).toBeLessThan(LIKES_PER_KARMA_PAYOUT);
  });

  // Devnet's floor states a property, not a scaled-down number: a bond of `B`
  // takes `INVITE_BOND_VEST_PER_LIKES · B` likes to vest in full, so the floor
  // is what decides whether a fixture can drive one all the way rather than
  // watching it partially forfeit.
  it('floors the devnet bond low enough for a fixture to vest one in full', () => {
    const likesToVestSmallest =
      INVITE_BOND_VEST_PER_LIKES * Number(profileFor('devnet').inviteBondMin);
    expect(likesToVestSmallest).toBeLessThanOrEqual(15);
  });
});

describe('protocolVersionSchedule', () => {
  // TYPES_INTERFACE → Version — "A schedule is valid iff". The rule written as the function the
  // assertions apply; test-local, because no production code reads it — every shipped schedule is
  // valid by construction, not by any runtime check. `maxVersion` defaults to the contract's bound
  // (PROTOCOL_VERSION) and is a parameter only so each clause can be shown to fire in isolation: at
  // PROTOCOL_VERSION 1 any second era already exceeds the build, so the version-step and
  // ascending-fromHeight clauses can be violated ALONE only against a higher bound.
  function isValidSchedule(
    schedule: readonly ProtocolEra[],
    maxVersion: number = PROTOCOL_VERSION,
  ): boolean {
    const first = schedule[0];
    if (first === undefined || first.version !== 1 || first.fromHeight !== 0) return false;
    for (let i = 1; i < schedule.length; i++) {
      const prev = schedule[i - 1]!;
      const era = schedule[i]!;
      if (era.version !== prev.version + 1) return false; // each version is the previous plus one
      if (era.fromHeight <= prev.fromHeight) return false; // fromHeight strictly ascending
    }
    return schedule[schedule.length - 1]!.version <= maxVersion; // build implements every era it schedules
  }

  it('every shipped profile schedules a valid era table', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(isValidSchedule(profile.protocolVersionSchedule), profile.networkType).toBe(true);
    }
  });

  it('the validity rule rejects each of its four clauses violated in isolation', () => {
    // Clause 1 — the first era must be { version: 1, fromHeight: 0 }, both halves.
    expect(isValidSchedule([{ version: 2, fromHeight: 0 }], 5)).toBe(false);
    expect(isValidSchedule([{ version: 1, fromHeight: 5 }], 5)).toBe(false);
    // Clause 2 — each version is the previous plus one. Holding it at 1 keeps clause 4 clear.
    expect(isValidSchedule([{ version: 1, fromHeight: 0 }, { version: 1, fromHeight: 10 }], 5)).toBe(false);
    // Clause 3 — fromHeight strictly ascending. Bound 5, so version 2 does not co-trip clause 4.
    expect(isValidSchedule([{ version: 1, fromHeight: 0 }, { version: 2, fromHeight: 0 }], 5)).toBe(false);
    // Clause 4 — the last version is at most the build's. The same schedule is valid at bound 2 and
    // rejected at bound 1, so the ONLY thing wrong there is that version 2 is unimplemented.
    expect(isValidSchedule([{ version: 1, fromHeight: 0 }, { version: 2, fromHeight: 10 }], 2)).toBe(true);
    expect(isValidSchedule([{ version: 1, fromHeight: 0 }, { version: 2, fromHeight: 10 }], 1)).toBe(false);
  });

  it('every profile schedules exactly one era: version 1 from height 0', () => {
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(profile.protocolVersionSchedule, profile.networkType).toEqual([{ version: 1, fromHeight: 0 }]);
    }
  });

  // The spread hazard, named as a pin: TESTNET_PROFILE is `{ ...MAINNET_PROFILE, … }`, so an
  // un-overridden schedule would BE mainnet's array by reference — and a future bump to mainnet's
  // would silently ride into testnet. Each network states its own literal. (TYPES_INTERFACE → Version)
  it('testnet and devnet schedule arrays are not the mainnet array', () => {
    const { mainnet, testnet, devnet } = NETWORK_PROFILES;
    expect(testnet.protocolVersionSchedule).not.toBe(mainnet.protocolVersionSchedule);
    expect(devnet.protocolVersionSchedule).not.toBe(mainnet.protocolVersionSchedule);
  });
});

describe('protocolVersionAt', () => {
  // A single-era schedule and a two-era one. The two-era fixture schedules version 2, which this build
  // does not implement — allowed here, since the validity rule binds NETWORK_PROFILES only and the
  // lookup reads any ascending schedule in order. (TYPES_INTERFACE → Version)
  const ONE_ERA: readonly ProtocolEra[] = [{ version: 1, fromHeight: 0 }];
  const TWO_ERA: readonly ProtocolEra[] = [
    { version: 1, fromHeight: 0 },
    { version: 2, fromHeight: 10 },
  ];

  it('reads the single era at 0, at 1, and far above', () => {
    expect(protocolVersionAt(ONE_ERA, 0)).toBe(1);
    expect(protocolVersionAt(ONE_ERA, 1)).toBe(1);
    expect(protocolVersionAt(ONE_ERA, 1_000_000)).toBe(1);
  });

  it('reads the era boundary of a two-era schedule', () => {
    expect(protocolVersionAt(TWO_ERA, 9)).toBe(1); // last era at or below 9 is 1@0
    expect(protocolVersionAt(TWO_ERA, 10)).toBe(2); // 2@10 covers exactly 10
    expect(protocolVersionAt(TWO_ERA, 1_000_000)).toBe(2);
  });

  it('is null for any height outside the chain height domain', () => {
    // The height domain is a non-negative safe integer; a negative, a fraction, NaN, ±Infinity and a
    // value past 2⁵³ are all outside it and read null. (TYPES_INTERFACE → Version)
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 53]) {
      expect(protocolVersionAt(ONE_ERA, bad), String(bad)).toBeNull();
    }
  });

  it('is total on a non-number height — no throw, null on undefined, a string, an object', () => {
    const bads: unknown[] = [undefined, 'x', {}, null, [], true];
    for (const bad of bads) {
      expect(() => protocolVersionAt(ONE_ERA, bad as number)).not.toThrow();
      expect(protocolVersionAt(ONE_ERA, bad as number)).toBeNull();
    }
  });
});
