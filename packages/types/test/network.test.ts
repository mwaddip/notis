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
} from '../src/index.js';
import type { NetworkType, NetworkProfile } from '../src/index.js';

// The full contract field set — TYPES_INTERFACE §Network profiles. Guards both
// directions: a missing field and an added one (per-network creep is how a devnet
// test stops catching a mainnet bug).
const PROFILE_FIELDS = [
  'networkType',
  'magic',
  'orderingBlockPowTargetBits',
  'karmaDecayIntervalBlocks',
  'karmaStaleThresholdBlocks',
  'vouchCooldownBlocks',
  'inviteProbationBlocks',
  'creditMinerRewardDelay',
  'bootstrapPeriodBlocks',
  'creditFixedRateBlocks',
  'creditEpochBlocks',
  'genesisCommitteeKeys',
  'genesisKarmaPerMember',
  'genesisCreditsPerMember',
  'genesisProofPayload',
  'genesisStateRoot',
  'treasuryPubKey',
].sort();

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
    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(Object.keys(profile).sort()).toEqual(PROFILE_FIELDS);
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

  it('testnet is identical to mainnet except identity, genesis and treasury', () => {
    const identityOrGenesis = new Set([
      'networkType',
      'magic',
      'genesisCommitteeKeys',
      'genesisProofPayload',
      // Exempt for the same reason as the payload, and inseparably: the root is
      // the digest over a box set whose only per-network member is that
      // payload, so the two differ across networks together or not at all.
      'genesisStateRoot',
      'treasuryPubKey',
    ]);
    const { mainnet, testnet } = NETWORK_PROFILES;
    for (const field of PROFILE_FIELDS) {
      if (identityOrGenesis.has(field)) continue;
      expect(testnet[field as keyof NetworkProfile], field).toBe(
        mainnet[field as keyof NetworkProfile],
      );
    }
  });

  it('devnet runs the parked e2e harness values', () => {
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
    expect(devnet.bootstrapPeriodBlocks).toBe(100);
    expect(devnet.creditFixedRateBlocks).toBe(1000);
    expect(devnet.creditEpochBlocks).toBe(100);

    // Every ordering asserted on BOTH profiles, so "devnet mirrors mainnet" is
    // checked rather than assumed: a compression that quietly reorders the
    // windows fails here and not on the network it would have broken.
    for (const p of [mainnet, devnet]) {
      expect(p.bootstrapPeriodBlocks).toBeLessThan(p.karmaStaleThresholdBlocks);
      expect(p.creditEpochBlocks).toBeLessThan(p.creditFixedRateBlocks);
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

  it('devnet keeps mainnet economics — genesis allocations are not compressed', () => {
    const { mainnet, devnet } = NETWORK_PROFILES;
    expect(devnet.genesisKarmaPerMember).toBe(mainnet.genesisKarmaPerMember);
    expect(devnet.genesisCreditsPerMember).toBe(mainnet.genesisCreditsPerMember);
  });

  // The `genesis_proof` box's payload — the only field that differs across the
  // three genesis box sets, and therefore the only reason their state roots
  // differ. `genesisKarmaPerMember` and `genesisCreditsPerMember` are shared by
  // all three (the test above pins that), so distinctness here is not one
  // property among several: it is the whole of network identity at genesis.
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
