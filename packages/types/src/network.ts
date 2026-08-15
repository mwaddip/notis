// Network profiles — TYPES_INTERFACE §Network profiles, ARCHITECTURE §Network Identity.
//
// A network is the pairing of a parameter profile with a genesis state, selected by the
// single `NETWORK_TYPE` setting (class `network-identity`). Two operators who differ on it
// are on different networks; two who agree cannot differ on anything below it.
//
// Genesis is state and not a block: there is no height-0 block anywhere in this protocol.
// Cold start seeds a box set into the AVL+ tree and height 1 is the first mined block, so
// what a network commits to is the height-0 root below — `genesisStateRoot`.
//
// The per-network set covers timescale, difficulty and genesis ONLY. Every other constant
// — format limits and every karma/credit cost — is universal: compress time, never
// economics. Adding a field here weakens every test that runs on devnet; the burden is on
// the addition.

import {
  ORDERING_BLOCK_POW_TARGET_BITS,
  POST_POW_TARGET_BITS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_STALE_THRESHOLD_BLOCKS,
  VOUCH_COOLDOWN_BLOCKS,
  INVITE_PROBATION_BLOCKS,
  CREDIT_MINER_REWARD_DELAY,
  BOOTSTRAP_PERIOD_BLOCKS,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_EPOCH_BLOCKS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
} from './constants.js';

export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkProfile {
  readonly networkType: NetworkType;
  readonly magic: number;              // wire frame magic — one per network

  // Difficulty
  readonly orderingBlockPowTargetBits: number;
  readonly postPowTargetBits: number;

  // Block-denominated durations
  readonly karmaDecayIntervalBlocks: number;
  readonly karmaStaleThresholdBlocks: number;
  readonly vouchCooldownBlocks: number;
  readonly inviteProbationBlocks: number;
  readonly creditMinerRewardDelay: number;
  readonly bootstrapPeriodBlocks: number;

  // Emission schedule
  readonly creditFixedRateBlocks: number;
  readonly creditEpochBlocks: number;

  // Genesis
  readonly genesisCommitteeKeys: readonly string[];
  readonly genesisKarmaPerMember: bigint;
  readonly genesisCreditsPerMember: bigint;
  /**
   * The `genesis_proof` box's payload, hex of raw bytes. **Differs on all three
   * networks, and nothing else in the genesis box set does** — the system karma
   * and faucet credit boxes are byte-identical everywhere, so this field is the
   * whole of network identity at height 0.
   *
   * Hex `string`, not `Uint8Array`, and the reason is immutability rather than
   * style: every profile is an `Object.freeze`d literal, and freezing a typed
   * array does not prevent writes to its contents. `treasuryPubKey` and
   * `genesisCommitteeKeys` are hex for the same reason.
   */
  readonly genesisProofPayload: string;
  /**
   * The height-0 AVL+ root over this network's genesis box set — Ergo's
   * `genesisStateDigestHex`. Hex, **66 characters**: the digest is a 32-byte
   * root label followed by a one-byte tree height, the same 33-byte shape
   * `EMPTY_STATE_ROOT` and the block header's `stateRoot` carry.
   *
   * Derived rather than chosen — it is the digest a node computes after seeding,
   * and `genesisProofPayload` is the only input to it that differs per network.
   * A node whose seeded state does not reproduce this value is on a chain that
   * forks from every honest peer at height 1, so node compares the two inside
   * the seeding transaction and throws, rolling the whole genesis back.
   *
   * ⚠ **A seeding postcondition, not a boot invariant** (`NODE_INTERFACE` → The
   * genesis state root is checked fail-stop, once, where it is built). Seeding
   * returns early on the `genesis_committed` flag, so a node that has ever
   * applied a block never reaches the comparison — repointing an existing store
   * at another network boots clean on the old network's height-0 state. The two
   * are not interchangeable and this pin only covers the first.
   *
   * ⚠ **Re-pin when anything a genesis box's id derives from moves.** These are
   * digests over box ids, so a change to the box encoding moves them without
   * anything here changing.
   */
  readonly genesisStateRoot: string;
  readonly treasuryPubKey: string;
}

// The network magics live here, not in @dagsocial/wire: wire has zero runtime dependencies
// and keeps them, so it must not import from types. The frame codec takes `magic` as a
// parameter and is magic-agnostic by construction. **This is the sole definition** — `net`
// re-exports these from `frame.ts` rather than declaring its own.
export const MAGIC_MAINNET = 0x4d444147; // "MDAG"
export const MAGIC_TESTNET = 0x54444147; // "TDAG"
export const MAGIC_DEVNET = 0x44444147; // "DDAG"

/** The canonical set. `net` must derive its frame-magic check from this, never a local literal. */
export const KNOWN_FRAME_MAGICS: readonly number[] = Object.freeze([
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
]);

// ⚠ PROVISIONAL VALUES — every number below is a placeholder pending the constants-pinning
// session (TYPES_INTERFACE §Network profiles: "Do not read any number in this contract as
// decided"). Genesis committee keys and treasury keys are empty placeholders on all three
// networks until real chains launch.

// mainnet: today's constants (constants.ts is the single source while both surfaces exist).
const MAINNET_PROFILE: NetworkProfile = Object.freeze({
  networkType: 'mainnet',
  magic: MAGIC_MAINNET,

  orderingBlockPowTargetBits: ORDERING_BLOCK_POW_TARGET_BITS,
  postPowTargetBits: POST_POW_TARGET_BITS,

  karmaDecayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  karmaStaleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  vouchCooldownBlocks: VOUCH_COOLDOWN_BLOCKS,
  inviteProbationBlocks: INVITE_PROBATION_BLOCKS,
  creditMinerRewardDelay: CREDIT_MINER_REWARD_DELAY,
  bootstrapPeriodBlocks: BOOTSTRAP_PERIOD_BLOCKS,

  creditFixedRateBlocks: CREDIT_FIXED_RATE_BLOCKS,
  creditEpochBlocks: CREDIT_EPOCH_BLOCKS,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  genesisKarmaPerMember: GENESIS_KARMA_PER_MEMBER,
  genesisCreditsPerMember: GENESIS_CREDITS_PER_MEMBER,
  // ⚠ MOCK CONTENT (user, 2026-08-13). What has to hold is that the three
  // payloads DIFFER; what is inside them does not. Substituting real
  // no-premine evidence later is a value change on a network that has not
  // launched, not a format change. hex("dagsocial/mainnet/genesis-proof/mock")
  genesisProofPayload: '646167736f6369616c2f6d61696e6e65742f67656e657369732d70726f6f662f6d6f636b',
  // Over ONE leaf. Mainnet's genesis state is the proof box alone: the system
  // karma and faucet credit boxes sit behind `isFaucetNetwork`, and a faucet on
  // mainnet would be a defect rather than a shortfall. The other two networks
  // seed four leaves — those two boxes, this one, and the system identity
  // record — which is why this root's trailing height byte differs from theirs.
  genesisStateRoot: 'df46d498fbf94b68dd05a57ddee4486a72211ffa5b1ca961272b2ef4f09b8c6c01',
  treasuryPubKey: '',
} satisfies NetworkProfile);

// testnet: identical to mainnet except network identity, genesis and treasury — deliberate
// (a testnet that differs from mainnet cannot catch a mainnet bug; the burden is on the
// difference). The spread makes identity structural: a mainnet parameter change cannot
// silently leave testnet behind.
const TESTNET_PROFILE: NetworkProfile = Object.freeze({
  ...MAINNET_PROFILE,
  networkType: 'testnet',
  magic: MAGIC_TESTNET,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  // Overridden explicitly, and it must be: the spread above would otherwise
  // hand testnet mainnet's payload, making the two genesis states byte-identical
  // — the one field whose whole job is to keep them apart.
  // hex("dagsocial/testnet/genesis-proof/mock")
  genesisProofPayload: '646167736f6369616c2f746573746e65742f67656e657369732d70726f6f662f6d6f636b',
  // Overridden for the same reason as the payload above, and it is the same
  // single failure: the spread would hand testnet mainnet's root, and a root is
  // exactly what a node checks its own seeded state against.
  genesisStateRoot: 'ec50b959ea5284dbf993f7c289a7c26c8b38979c0530fe0bf7c1f13dd428892b03',
  treasuryPubKey: '',
} satisfies NetworkProfile);

// devnet: compressed timescale, same economics. The two values marked (harness) are the
// ones the parked e2e harness ran on (packages/node/test/harness/node-manager.ts).
// postPowTargetBits is the value that harness wanted but could not override without
// desynchronising the challenge endpoint from the verifier — the exact defect the profile
// removes. The remaining durations are compressed roughly two orders of magnitude,
// preserving mainnet's orderings (bootstrap < stale threshold < probation,
// epoch < fixed-rate period). Ordering difficulty is compressed too, and for a reason
// that is not timescale; see orderingBlockPowTargetBits below.
//
// ⚠ **A ratio is not a derivation once the neighbour a value must clear is itself
// unprincipled.** `karmaStaleThresholdBlocks` is harness-pinned rather than derived, so a
// probation length picked by dividing mainnet's lands wherever the arithmetic falls —
// which is why `inviteProbationBlocks` below states the PROPERTY it has to hold and not
// the ratio that happens to produce it.
const DEVNET_PROFILE: NetworkProfile = Object.freeze({
  networkType: 'devnet',
  magic: MAGIC_DEVNET,

  // Devnet is where the retarget is exercised, so its seed may not sit below 2180, where
  // a 1/256-bit step can buy zero work and difficulty moves while cumulativeWork does not.
  // VALIDATION_INTERFACE → blockWork / cumulativeWork.
  //
  // Below testnet's, and that divergence is load-bearing rather than incidental. The node
  // test suite mines real PoW, and `expectedTarget()` reads the process config singleton,
  // which an injected `Config` cannot reach. Devnet is the profile that suite resolves
  // (pinned in its `vitest.config.ts`), so this value is what every mining test solves
  // against: at testnet's 5984 it costs the suite ~141 minutes of pure PoW per run, and at
  // 3072 a solve is ~4K hashes. Devnet's block cadence comes from throttling a miner's
  // hashrate, never from this number. TYPES_INTERFACE → Ordering block PoW.
  orderingBlockPowTargetBits: 3072,
  postPowTargetBits: 4, // (harness intent — see above)

  karmaDecayIntervalBlocks: 3, // (harness)
  karmaStaleThresholdBlocks: 500, // (harness)
  vouchCooldownBlocks: 3, // shortest wait that still spans block boundaries
  // **Above `karmaStaleThresholdBlocks`, so decay fires during probation as it does on
  // mainnet** (43200 > 40320). Not a ratio: what has to hold is that a devnet run can
  // reach a block where the decay writer and the probation reader touch the same identity
  // record. Under that height they never coincide, and every `putIdentityRecord` writer
  // that carried `invitedAtBlock` or `lifetimeLikesReceived` through would be untested on
  // the one network the suite actually runs — the fields are REQUIRED on the type, so a
  // writer passing `0` instead of the stored value compiles and silently destroys the
  // clock, the once-ever bar and the vesting count.
  inviteProbationBlocks: 540,
  creditMinerRewardDelay: 10, // 720 ÷ 72 — small enough to spend, large enough to observe immaturity
  bootstrapPeriodBlocks: 100, // 10000 ÷ 100

  creditFixedRateBlocks: 1000, // ~÷1000 so the fixed-rate → decay transition is reachable
  creditEpochBlocks: 100, // keeps fixed-rate ≈ 10 × epoch (mainnet: ≈ 8×)

  genesisCommitteeKeys: Object.freeze([] as string[]),
  genesisKarmaPerMember: GENESIS_KARMA_PER_MEMBER,
  genesisCreditsPerMember: GENESIS_CREDITS_PER_MEMBER,
  // hex("dagsocial/devnet/genesis-proof/mock") — mock, see mainnet above
  genesisProofPayload: '646167736f6369616c2f6465766e65742f67656e657369732d70726f6f662f6d6f636b',
  // Testnet and devnet seed byte-identical karma and credit boxes — same system
  // keypair, same values — so the proof box is the whole difference between
  // these two roots.
  genesisStateRoot: '0efe4301ae44bf9ed30b92ceab2db77bf0cd38d1a8d725f1972da18d2ab347a703',
  treasuryPubKey: '',
} satisfies NetworkProfile);

export const NETWORK_PROFILES: Readonly<Record<NetworkType, NetworkProfile>> = Object.freeze({
  mainnet: MAINNET_PROFILE,
  testnet: TESTNET_PROFILE,
  devnet: DEVNET_PROFILE,
});

/**
 * Resolve a network profile. Throws on an unknown network — an unrecognised value is a
 * misconfigured node, not a mainnet one. **Never falls back**: a `?? MAGIC_MAINNET` default
 * would silently put a misconfigured node on mainnet (NET_INTERFACE → Magic Bytes).
 */
export function profileFor(network: NetworkType): NetworkProfile {
  if (!Object.hasOwn(NETWORK_PROFILES, network)) {
    throw new Error(
      `Unknown network type ${JSON.stringify(network)} — expected 'mainnet' | 'testnet' | 'devnet'`,
    );
  }
  return NETWORK_PROFILES[network];
}
