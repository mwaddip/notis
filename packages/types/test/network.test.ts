import { describe, it, expect } from 'vitest';
import {
  NETWORK_PROFILES,
  profileFor,
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
  MAX_REORG_DEPTH,
} from '../src/index.js';
import type { NetworkType, NetworkProfile } from '../src/index.js';

// The full contract field set — TYPES_INTERFACE → Network profiles. Guards both
// directions: a missing field and an added one (per-network creep is how a devnet
// test stops catching a mainnet bug).
const REQUIRED_PROFILE_FIELDS = [
  'networkType',
  'magic',
  'orderingBlockPowTargetBits',
  'karmaDecayIntervalBlocks',
  'karmaStaleThresholdBlocks',
  'vouchCooldownBlocks',
  'inviteProbationBlocks',
  'creditMinerRewardDelay',
  'creditFixedRateBlocks',
  'creditEpochBlocks',
  'genesisCommitteeKeys',
  'genesisKarmaPerMember',
  'inviteBondMin',
  'inviteBondMax',
  'genesisProofPayload',
  'genesisStateRoot',
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
    ]);
    // ⚠ **Caps, not mechanics** (ARCHITECTURE → "What varies per network, and
    // what must not"). Every name here is a BOUND; a formula or a ratio may not
    // join them, and the list is what makes each difference declared rather than
    // discovered. `inviteBondMin` is deliberately absent — testnet inherits
    // mainnet's floor.
    const relaxedCaps = new Set(['inviteBondMax']);
    const { mainnet, testnet } = NETWORK_PROFILES;
    // ⛔ Derived from the profiles, never from a literal list. A hardcoded set
    // goes on passing while a field added to either profile sits uncompared, so
    // the guarantee this test states would quietly stop covering the tree.
    const fields = new Set([...Object.keys(mainnet), ...Object.keys(testnet)]);
    for (const field of fields) {
      if (identityOrGenesis.has(field) || relaxedCaps.has(field)) continue;
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
    expect(devnet.creditEpochBlocks).toBe(100);

    // Every ordering asserted on BOTH profiles, so "devnet mirrors mainnet" is
    // checked rather than assumed: a compression that quietly reorders the
    // windows fails here and not on the network it would have broken.
    for (const p of [mainnet, devnet]) {
      expect(p.creditEpochBlocks).toBeLessThan(p.creditFixedRateBlocks);
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

  // The deepest e2e height is 27 (MAX_REORG_DEPTH + 7). A period below that
  // ceiling lets a producer collect the faucet's genesis credits underneath a
  // running scenario. ⚠ Raising MAX_REORG_DEPTH eats the headroom silently.
  it('devnet rent period clears the deepest e2e height with headroom', () => {
    const devnet = NETWORK_PROFILES.devnet;
    expect(devnet.storageRentPeriodBlocks).toBe(40);
    expect(devnet.storageRentPeriodBlocks).toBeGreaterThan(MAX_REORG_DEPTH + 7);
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
