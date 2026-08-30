// Network profiles — TYPES_INTERFACE → Network profiles, ARCHITECTURE → Network Identity.
//
// A network is the pairing of a parameter profile with a genesis state, selected by the
// single `NETWORK_TYPE` setting (class `network-identity`). Two operators who differ on it
// are on different networks; two who agree cannot differ on anything below it.
//
// Genesis is state and not a block: there is no height-0 block anywhere in this protocol.
// Cold start seeds a box set into the AVL+ tree and height 1 is the first mined block, so
// what a network commits to is the height-0 root below — `genesisStateRoot`.
//
// The per-network set covers timescale, difficulty, genesis and CAPS. Adding a MECHANIC
// here weakens every test that runs on devnet; the burden is on the addition. A CAP is
// different in kind — a defect lives in a formula or a ratio, never in the size of a limit
// — so a relaxed bound diverges without hiding anything. Every field added here says which
// of the two it is (ARCHITECTURE → "What varies per network, and what must not").

import {
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_STALE_THRESHOLD_BLOCKS,
  VOUCH_COOLDOWN_BLOCKS,
  INVITE_PROBATION_BLOCKS,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_EMISSION_TOTAL,
  GENESIS_KARMA_PER_MEMBER,
  INVITE_BOND_MIN,
  INVITE_BOND_MAX,
} from './constants.js';

export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkProfile {
  readonly networkType: NetworkType;
  readonly magic: number;              // wire frame magic — one per network

  // Difficulty — the ASERT schedule's per-network numbers (MINING_INTERFACE → Difficulty Schedule).
  // `orderingBlockPowTargetBits` is the ANCHOR's bits — block 1's target, and the yardstick every
  // superblock level is measured against; the schedule moves inside [floor, ceiling];
  // `orderingBlockIdealMs` is the interval the schedule aims at and the halflife's unit
  // (halflife = RETARGET_HALFLIFE_BLOCKS · ideal). The mechanic is universal; only the numbers vary.
  readonly orderingBlockPowTargetBits: number;
  readonly orderingBlockIdealMs: number;
  readonly orderingBlockPowTargetFloorBits: number;
  readonly orderingBlockPowTargetCeilingBits: number;

  // Block-denominated durations
  readonly karmaDecayIntervalBlocks: number;
  readonly karmaStaleThresholdBlocks: number;
  readonly vouchCooldownBlocks: number;
  readonly inviteProbationBlocks: number;
  readonly creditMinerRewardDelay: number;

  // Chain reorganisation — the reorg horizon: how far below the tip a fork may be followed
  // (→ Chain reorganisation). A duration in blocks; the mechanic is universal, the number per network.
  readonly maxReorgDepth: number;

  // Emission schedule. `creditEmissionTotal` is the EmissionBox's genesis value,
  // CARRIED rather than derived (TYPES_INTERFACE → EmissionBox). It must be
  // STRICTLY below the curve's own sum for this profile's F and E at the
  // universal R and d.
  readonly creditFixedRateBlocks: number;
  readonly creditEpochBlocks: number;
  readonly creditEmissionTotal: bigint;

  // Storage rent — the period between collections, in blocks
  readonly storageRentPeriodBlocks: number;

  // Membership — k in D(N) = max(1, icbrt(k · N)); a cap, field-only
  // (ARCHITECTURE → What varies per network)
  readonly membershipBarMultiplier: number;

  // Genesis
  readonly genesisCommitteeKeys: readonly string[];
  readonly genesisKarmaPerMember: bigint;
  /**
   * The faucet identity's Ed25519 public key, 64 hex chars, or **absent**.
   *
   * ⛔ **Absence is the mainnet gate, and it is the whole of it.** Genesis seeds
   * the faucet's karma and credit boxes only when this is present, and those
   * boxes reach `genesisStateRoot` — so a node that invents a faucet identity
   * computes a different root and cannot join. The gate is chain-committed
   * rather than read from a config file.
   *
   * ⚠ **Testnet and devnet name DIFFERENT keys.** Devnet's secret lives in
   * tracked source and reaches CI; testnet's guards a balance testers depend on.
   * One key for both is the fixture key and the live key being one key.
   */
  readonly faucetPublicKey?: string;

  // Invite caps — the inviter picks a bond in this range, and the grant equals
  // it. ⚠ **Caps, not mechanics**: the vesting formula and the `V/L` supply dial
  // are universal, and only the bounds vary (ARCHITECTURE → "What varies per
  // network, and what must not").
  readonly inviteBondMin: bigint;
  readonly inviteBondMax: bigint;

  /**
   * The `genesis_proof` box's payload, hex of raw bytes. **Differs on all three
   * networks**, and it is the one genesis input every network seeds, so it is
   * what separates mainnet's height-0 state from the two that also seed a faucet
   * identity.
   *
   * Hex `string`, not `Uint8Array`, and the reason is immutability rather than
   * style: every profile is an `Object.freeze`d literal, and freezing a typed
   * array does not prevent writes to its contents. `genesisStateRoot` and
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
   *
   * ⛔ **Nothing here can derive one, so a re-pin is taken on measurement.** This
   * package holds neither the box serializer nor the AVL prover, and a digest over
   * a genesis box set is not hand-assembled. **Mainnet is what makes a measured
   * value checkable:** it seeds no identity record and no faucet box, so a change
   * confined to either leaves its root byte-identical while the other two move. A
   * re-pin that moves mainnet's as well is not confined — a box encoding, a codec
   * or the feed order moved with it, and the delta is wider than the change
   * claims (`TYPES_INTERFACE` → A regenerated pin's INPUT is unchecked, so state
   * it).
   */
  readonly genesisStateRoot: string;
  readonly genesisId: string;             // hex(32) or '' — the pinned height-1 block hash; '' = unpinned
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

// ⚠ PROVISIONAL VALUES — each cell's standing is CONSTANTS → Per-network values
// (TYPES_INTERFACE → Network profiles → "Do not read any number in this contract as
// decided"). Genesis committee keys are empty placeholders on all three networks until real
// chains launch. **No field names the treasury**: it is a `TreasuryBox` that block application
// alone moves, and no key can reach it (ARCHITECTURE → Treasury).

// mainnet: today's constants (constants.ts is the single source while both surfaces exist).
const MAINNET_PROFILE: NetworkProfile = Object.freeze({
  networkType: 'mainnet',
  magic: MAGIC_MAINNET,

  orderingBlockPowTargetBits: ORDERING_BLOCK_POW_TARGET_BITS,
  orderingBlockIdealMs: 60_000,
  orderingBlockPowTargetFloorBits: 5120,
  orderingBlockPowTargetCeilingBits: 65536,

  karmaDecayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
  karmaStaleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
  vouchCooldownBlocks: VOUCH_COOLDOWN_BLOCKS,
  inviteProbationBlocks: INVITE_PROBATION_BLOCKS,
  creditMinerRewardDelay: CREDIT_MINER_REWARD_DELAY,

  // TYPES_INTERFACE → Chain reorganisation
  maxReorgDepth: 60,

  creditFixedRateBlocks: CREDIT_FIXED_RATE_BLOCKS,
  creditEpochBlocks: CREDIT_EPOCH_BLOCKS,
  creditEmissionTotal: CREDIT_EMISSION_TOTAL,

  // 4 years at 60s blocks, and exactly 2 × creditFixedRateBlocks. The rate is
  // universal (MIN_BOX_VALUE_PER_BYTE, STORAGE_RENT_PER_BYTE in constants.ts);
  // the period is timescale and per-network.
  storageRentPeriodBlocks: 2_102_400,

  membershipBarMultiplier: 10,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  genesisKarmaPerMember: GENESIS_KARMA_PER_MEMBER,

  // ⚠ PLACEHOLDER WEIGHTS. Mainnet's numbers are testnet's output; these hold
  // the shape until there is evidence to set them from. **No `faucetPublicKey`**
  // — its absence is what makes a mainnet faucet unrepresentable.
  inviteBondMin: INVITE_BOND_MIN,
  inviteBondMax: INVITE_BOND_MAX,

  // ⚠ MOCK CONTENT (user, 2026-08-13). What has to hold is that the three
  // payloads DIFFER; what is inside them does not. Substituting real
  // no-premine evidence later is a value change on a network that has not
  // launched, not a format change. hex("dagsocial/mainnet/genesis-proof/mock")
  genesisProofPayload: '646167736f6369616c2f6d61696e6e65742f67656e657369732d70726f6f662f6d6f636b',
  // Over FOUR leaves — the proof box, the emission box, the karma pool box and
  // the network record. The faucet's karma and credit boxes are the ones this
  // profile does not seed, because it names no `faucetPublicKey`; the emission
  // and pool boxes are seeded everywhere on purpose, because every block's
  // coinbase is released from the one and every karma mint draws from the other
  // (TYPES_INTERFACE → EmissionBox, KarmaPoolBox). The other two networks seed
  // SEVEN leaves — those three boxes, these four, and the faucet identity's
  // record — which is why this root's trailing height byte (`03`) differs from
  // theirs (`04`).
  genesisStateRoot: 'e2a156c44ddb8cc40587b28fc3ce7a8c01c2657f94e5752a063d9b13912b322703',
  genesisId: '',
} satisfies NetworkProfile);

// testnet: mainnet's MECHANICS with relaxed CAPS — the public playground. A testnet that
// ran a different formula could not catch a mainnet bug; one that runs a larger bound
// catches every one of them. Its identity and genesis differ as before. The spread makes
// the rest structural: a mainnet parameter change cannot silently leave testnet behind.
const TESTNET_PROFILE: NetworkProfile = Object.freeze({
  ...MAINNET_PROFILE,
  networkType: 'testnet',
  magic: MAGIC_TESTNET,

  // Generated 2026-08-18. The secret is NOT in this repo; it is deployed to the
  // faucet service as a config value.
  faucetPublicKey: '7d501686ebf18b2618c5a9394445bd14922a72478d2a4c36a82a8cfc2a66cce7',
  // TYPES_INTERFACE → Chain reorganisation
  maxReorgDepth: 240,

  // Relaxed so a tester arrives with enough karma to post and like freely. A cap,
  // not a mechanic — the vesting formula is unchanged.
  inviteBondMax: 1000n,

  membershipBarMultiplier: 1,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  // Overridden explicitly, and it must be: the spread above would otherwise
  // hand testnet mainnet's payload, making the two genesis states byte-identical
  // — the one field whose whole job is to keep them apart.
  // hex("dagsocial/testnet/genesis-proof/mock")
  genesisProofPayload: '646167736f6369616c2f746573746e65742f67656e657369732d70726f6f662f6d6f636b',
  // Overridden for the same reason as the payload above, and it is the same
  // single failure: the spread would hand testnet mainnet's root, and a root is
  // exactly what a node checks its own seeded state against.
  genesisStateRoot: 'd5be2f66c8d10f0408f726b982a1c1282b9577587aefc1cab6808f0a218bf45403',
  genesisId: '',
} satisfies NetworkProfile);

// devnet: compressed timescale, same economics. `karmaDecayIntervalBlocks` (3) and
// `karmaStaleThresholdBlocks` (500) are short-run values that make decay observable
// inside a short devnet run — an interval of 3 blocks fires decay quickly; stale after
// 500 keeps staleness reachable within a test suite.
// The remaining durations are compressed roughly two orders of magnitude,
// preserving mainnet's orderings (epoch < fixed-rate period). Ordering difficulty is compressed too, and for a reason
// that is not timescale; see orderingBlockPowTargetBits below.
//
// ⚠ **A ratio is not a derivation once the neighbour a value must clear is itself
// unprincipled.** `karmaStaleThresholdBlocks` is chosen directly rather than derived, so a
// probation length picked by dividing mainnet's lands wherever the arithmetic falls —
// which is why `inviteProbationBlocks` below states the PROPERTY it has to hold and not
// the ratio that happens to produce it.
const DEVNET_PROFILE: NetworkProfile = Object.freeze({
  networkType: 'devnet',
  magic: MAGIC_DEVNET,

  // The schedule reads the process config singleton, so the mechanic is the same on every
  // network; the band is the cap. The ceiling of 4096 keeps a burst of test blocks inside
  // sixteen whole bits. TYPES_INTERFACE → Ordering block PoW.
  orderingBlockPowTargetBits: 3072,
  orderingBlockIdealMs: 60_000,
  orderingBlockPowTargetFloorBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
  orderingBlockPowTargetCeilingBits: 4096,

  karmaDecayIntervalBlocks: 3,
  karmaStaleThresholdBlocks: 500,
  vouchCooldownBlocks: 3, // shortest wait that still spans block boundaries
  // **Above `karmaStaleThresholdBlocks`, so decay fires during probation as it does on
  // mainnet** (43200 > 40320). Not a ratio: what has to hold is that a devnet run can
  // reach a block where the decay writer and the probation reader touch the same identity
  // record. Under that height they never coincide, and every `putIdentityRecord` writer
  // that carried `invitedAtBlock` or `lifetimeLikesReceived` through would be untested on
  // the one network the suite actually runs — the fields are REQUIRED on the type, so a
  // writer passing `0` instead of the stored value compiles and silently moves a
  // probation deadline or forfeits a bond that had vested.
  inviteProbationBlocks: 540,
  creditMinerRewardDelay: 10, // small enough to spend, large enough to observe immaturity

  // TYPES_INTERFACE → Chain reorganisation
  maxReorgDepth: 40,

  creditFixedRateBlocks: 1000, // ~÷1000 so the fixed-rate → decay transition is reachable
  creditEpochBlocks: 400, // fixed-rate ≈ 2.5× epoch (mainnet: ≈ 2.24×)
  creditEmissionTotal: 362_000n * 10n ** 8n, // below devnet's curve (386,400)

  // Above the deepest height any e2e scenario reaches — 51, the fork chapter's
  // strand case, measured (CONSTANTS → Per-network values) — with headroom.
  // ARCHITECTURE → What varies per network.
  storageRentPeriodBlocks: 100,

  // ⚠ **A PUBLICLY KNOWN TEST KEY.** Its secret is in tracked source and reaches
  // CI, which is correct for an ephemeral network and is why it is not testnet's.
  faucetPublicKey: '5468d985c3924a95f3d3dc98b67a41ac2c7cc4cfca4fcbf7c5627452f1617f36',
  // A bond of `B` takes `INVITE_BOND_VEST_PER_LIKES · B` likes to vest in full, so
  // the floor is what decides whether a fixture can drive one all the way: 5 costs
  // it 15 likes, 25 costs it 75. The ceiling stays at mainnet's so the range check
  // has both boundaries to fail against.
  inviteBondMin: 5n,
  inviteBondMax: INVITE_BOND_MAX,

  membershipBarMultiplier: 1,

  genesisCommitteeKeys: Object.freeze([] as string[]),
  genesisKarmaPerMember: GENESIS_KARMA_PER_MEMBER,
  // hex("dagsocial/devnet/genesis-proof/mock") — mock, see mainnet above
  genesisProofPayload: '646167736f6369616c2f6465766e65742f67656e657369732d70726f6f662f6d6f636b',
  // Three things separate this root from testnet's, not one: the proof box's
  // payload, the emission box's value — carried as `creditEmissionTotal`, so
  // smaller here than on the two networks that share mainnet's total — and
  // the faucet identity, since the two profiles name DIFFERENT
  // `faucetPublicKey`s and therefore seed differently-owned karma and credit
  // boxes.
  genesisStateRoot: '438480fde1b5ca026f9d2498fe0a0049c9b5e89e003e6ebcb7807da12d2c1dc304',
  genesisId: '',
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
