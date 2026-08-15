import {
  MIN_FEE_RATE_PER_BYTE,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  AVL_KEY_LENGTH,
  MAX_BLOCK_BODY_BYTES,
  MAX_REORG_DEPTH,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  profileFor,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';

export interface Config {
  port: number;
  adminPort: number;
  adminBindAddress: string;
  dbPath: string;
  /**
   * The network this node is on. Class `network-identity` — the only environment
   * variable that may change a consensus parameter, and it changes every one of
   * them together by selecting `profile` (ARCHITECTURE §Network Identity).
   */
  networkType: NetworkType;
  /**
   * The parameter table `networkType` selects, resolved once at load and frozen.
   * The consensus fields below are copied from it so consumers keep one flat
   * config surface; `index.ts` reads `magic` off it for the wire layer.
   */
  profile: NetworkProfile;
  nodeRole: 'server' | 'miner';
  /** Base path where the demo UI is served (e.g., "/testnet/" or "/"). */
  publicUrl: string;
  // Reserved, never to be reused: `postPowTargetBits`, `challengeWindowBlocks`,
  // `maxSubBlocksPerBlock`. Post PoW and its challenge handshake are gone;
  // consensus PoW is the ordering block's alone.
  /**
   * Body bytes this node fills the blocks it **produces** to
   * (NODE_INTERFACE → the `BLOCK_BODY_BUDGET_BYTES` row). Local, because a
   * miner may legitimately publish smaller blocks — but never above
   * `MAX_BLOCK_BODY_BYTES`, which is consensus and is checked in
   * `@dagsocial/validation`.
   */
  blockBodyBudgetBytes: number;
  /**
   * Pool bound, applied **per class**: credit entries hold
   * `MEMPOOL_CREDIT_SHARE_PCT` of it and karma-side entries the rest
   * (MEMPOOL_INTERFACE → Eviction, inside the credit class only).
   */
  maxMempoolEntries: number;
  /**
   * Relay floor in base units per encoded byte — the rate beneath which this
   * node refuses a credit transaction (MEMPOOL_INTERFACE → Fee floor).
   *
   * ⚠ **Policy, and the only reason it may be read from the environment.**
   * Every consensus value in this file comes from the network profile, because
   * two nodes disagreeing about one is a fork. This is the opposite: two nodes
   * may hold different floors and both are correct, and an operator raising
   * theirs under load is the case the seam exists for. Ships at zero, because
   * eviction already displaces a non-paying entry the moment a paying one
   * arrives.
   */
  minFeeRatePerByte: bigint;
  // Mining
  miningSecret: string;          // bearer token for mining API, required non-empty on a miner
  orderingBlockPowTargetBits: number;
  treasuryPubKey: string;  // hex-encoded 32-byte key, empty = no treasury
  /** Blocks before a coinbase output is spendable. Apply-time consensus check (MINING invariant 3). */
  creditMinerRewardDelay: number;
  // Emission schedule shape. `computeBlockReward` is a consensus function on
  // both the creator and the applier, so both read these from here.
  creditFixedRateBlocks: number;
  creditEpochBlocks: number;
  // Vouch and invite timing
  vouchCooldownBlocks: number;
  inviteProbationBlocks: number;
  // Karma decay
  karmaStaleThresholdBlocks: number;
  karmaDecayIntervalBlocks: number;
  karmaDecayAmount: bigint;
  karmaMinimum: bigint;
  // AVL state root
  verifyStateRoot: boolean;
  maxProofHistory: number;
  avlKeyLength: number;
  // Net settings
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
}

export function loadConfig(): Readonly<Config> {
  // Resolve the network profile first. `profileFor` throws on an unknown value:
  // a misconfigured node must fail at startup, loudly — it must never default
  // onto a network it was not pointed at.
  const profile = profileFor((process.env['NETWORK_TYPE'] ?? 'testnet') as NetworkType);

  const cfg: Config = {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    adminPort: parseInt(process.env['ADMIN_PORT'] ?? '3001', 10),
    adminBindAddress: process.env['ADMIN_BIND_ADDRESS'] ?? '127.0.0.1',
    dbPath: process.env['DB_PATH'] ?? 'dagsocial.db',
    networkType: profile.networkType,
    profile,
    nodeRole: parseNodeRole(process.env['NODE_ROLE'] ?? 'server'),
    publicUrl: process.env['PUBLIC_URL'] ?? '/',
    blockBodyBudgetBytes: parseBlockBodyBudget(
      process.env['BLOCK_BODY_BUDGET_BYTES'],
    ),
    maxMempoolEntries: parseInt(
      process.env['MAX_MEMPOOL_ENTRIES'] ?? '10000',
      10,
    ),
    minFeeRatePerByte: parseFeeFloor(process.env['MIN_FEE_RATE_PER_BYTE']),
    // Mining
    miningSecret: process.env['MINING_SECRET'] ?? '',
    orderingBlockPowTargetBits: profile.orderingBlockPowTargetBits,
    treasuryPubKey: profile.treasuryPubKey,
    creditMinerRewardDelay: profile.creditMinerRewardDelay,
    creditFixedRateBlocks: profile.creditFixedRateBlocks,
    creditEpochBlocks: profile.creditEpochBlocks,
    // Vouch and invite timing — per-network timescale, same rule as the karma
    // decay pair below.
    vouchCooldownBlocks: profile.vouchCooldownBlocks,
    inviteProbationBlocks: profile.inviteProbationBlocks,
    // Karma decay — per-network timescale from the profile, universal economics
    // from the constants (ARCHITECTURE §Network Identity: "compress time, never
    // economics"). None of these is readable from the environment.
    karmaStaleThresholdBlocks: profile.karmaStaleThresholdBlocks,
    karmaDecayIntervalBlocks: profile.karmaDecayIntervalBlocks,
    karmaDecayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
    // AVL state root. On by default since Spec B P3: producer and verifier now
    // agree by construction — the header carries the POST-block digest (H-6),
    // both feeds are canonically ordered (M-12), and the mutation set is
    // journal-derived (P1) — so a mismatch is genuine state divergence and
    // must reject the block. `VERIFY_STATE_ROOT=false` disables it.
    verifyStateRoot: process.env['VERIFY_STATE_ROOT'] !== 'false',
    maxProofHistory: parseInt(
      process.env['MAX_PROOF_HISTORY'] ?? '1440',
      10,
    ),
    avlKeyLength: AVL_KEY_LENGTH,
    // Net settings
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'] ?? ''),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: parseInt(process.env['MAX_PEERS'] ?? '50', 10),
  };

  assertMiningAuthConfigured(cfg);
  assertTreasuryKeyEncodable(cfg);
  assertGenesisProofPayloadEncodable(cfg);
  assertOrderingTargetAboveFloor(cfg);
  assertProofHistoryCoversReorgDepth(cfg);

  return Object.freeze(cfg);
}

/**
 * `MIN_FEE_RATE_PER_BYTE`, defaulting to the shipped floor of zero.
 *
 * Refused rather than clamped when it names no non-negative integer: a floor
 * this node cannot read is a relay policy nobody chose, and silently running
 * at zero would look identical to an operator who meant to raise it. Negative
 * is refused for the same reason it is not expressible — a floor beneath zero
 * admits a transaction paying nothing while reporting that it cleared a bar.
 */
function parseFeeFloor(raw: string | undefined): bigint {
  if (raw === undefined) return MIN_FEE_RATE_PER_BYTE;
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new Error(
      `Invalid MIN_FEE_RATE_PER_BYTE "${raw}" — must be a non-negative integer ` +
        'in base units per byte',
    );
  }
  if (parsed < 0n) {
    throw new Error(
      `Invalid MIN_FEE_RATE_PER_BYTE "${raw}" — a floor beneath zero would ` +
        'admit a transaction paying nothing and report that it cleared a bar',
    );
  }
  return parsed;
}

/**
 * `BLOCK_BODY_BUDGET_BYTES`, never above `MAX_BLOCK_BODY_BYTES`.
 *
 * **Clamping, and it is the only value in this file that clamps.** The budget
 * is a local preference over a consensus ceiling, so a value above the ceiling
 * has one legal reading — as much as the rules allow — and a node cannot raise
 * its own bound by asking. The two asserts below refuse instead, because a
 * below-floor PoW target and a too-short proof history name no legal value they
 * were reaching for.
 *
 * ⚠ **This is the environment's entry point, not the field's.** A `Config`
 * assembled directly — every test fixture — never passes through here, so the
 * producer clamps again where it spends the budget (`block-creator.ts`). That
 * one is total over both routes.
 *
 * A string denoting no positive number is refused rather than clamped or
 * defaulted: `parseInt` yields `NaN`, every comparison against `NaN` is false,
 * and a budget nothing fits inside produces empty blocks for as long as the
 * node runs — a node that stays up and carries no user work, which is the
 * silence `assertOrderingTargetAboveFloor` exists to prevent one field over.
 * Written as a negated `>` so the check is total on the parse.
 */
function parseBlockBodyBudget(raw: string | undefined): number {
  if (raw === undefined) return MAX_BLOCK_BODY_BYTES;
  const parsed = parseInt(raw, 10);
  if (!(parsed > 0)) {
    throw new Error(
      `Invalid BLOCK_BODY_BUDGET_BYTES "${raw}" — must be a positive byte ` +
        'count; a budget no transaction fits inside produces empty blocks ' +
        'silently, for as long as the node runs',
    );
  }
  return Math.min(parsed, MAX_BLOCK_BODY_BYTES);
}

/**
 * `MAX_PROOF_HISTORY` must cover every height a reorg can walk back to.
 *
 * `checkpointProver` prunes AVL versions below `height - maxProofHistory`, while
 * `findForkPoint` walks back a fixed `MAX_REORG_DEPTH` and can answer height 0.
 * A `maxProofHistory` under that depth prunes inside the window the walk still
 * answers within: `reorg` then finds no version at or before its fork height and
 * throws, and the node keeps a chain it should have switched away from. The two
 * numbers must be ordered, and nothing but this check orders them.
 *
 * Refusal, never clamping — the same rule `assertOrderingTargetAboveFloor`
 * follows: raising a too-small value to `MAX_REORG_DEPTH` would retain history
 * against a bound nobody configured, and failing at load puts the verdict where
 * a human is reading it.
 *
 * Written as a negated `>=` rather than a `<` so the check is total on the
 * parse: `parseInt` yields `NaN` for a non-numeric `MAX_PROOF_HISTORY`, and
 * `NaN < MAX_REORG_DEPTH` is false — a `<` would pass the one value that makes
 * every pruning height `NaN`.
 */
function assertProofHistoryCoversReorgDepth(cfg: Config): void {
  if (!(cfg.maxProofHistory >= MAX_REORG_DEPTH)) {
    throw new Error(
      `MAX_PROOF_HISTORY ${cfg.maxProofHistory} is below MAX_REORG_DEPTH ` +
        `${MAX_REORG_DEPTH} — AVL versions inside the reorg window would be ` +
        'pruned, and a reorg reaching one of them would abort with the node ' +
        'still on its own chain',
    );
  }
}

/**
 * The producer half of the ordering-block floor.
 * `verifyOrderingBlockStructure` refuses an arriving header below
 * `ORDERING_BLOCK_POW_TARGET_FLOOR` (VALIDATION_INTERFACE → orderingPowTarget),
 * and `expectedTarget()` returns this field unchecked — so a profile below the
 * floor builds templates this node's own verifier, and every peer's, refuses. A
 * node that stays up, mines, and never produces: silence in the direction that
 * costs the chain.
 *
 * Refusal, never clamping. Raising a below-floor value to the floor would mine
 * the chain against a target nobody configured; failing at load puts the verdict
 * where a human is reading it.
 */
function assertOrderingTargetAboveFloor(cfg: Config): void {
  if (cfg.orderingBlockPowTargetBits < ORDERING_BLOCK_POW_TARGET_FLOOR) {
    throw new Error(
      `orderingBlockPowTargetBits ${cfg.orderingBlockPowTargetBits} for network ` +
        `"${cfg.networkType}" is below the ordering-block floor ` +
        `${ORDERING_BLOCK_POW_TARGET_FLOOR} — every header this node built ` +
        'would be refused by its own verifier',
    );
  }
}

/**
 * The treasury key's domain, established where it enters this node's config
 * surface rather than where it is encoded (TYPES_INTERFACE → "Totality": a
 * throwing writer's domain belongs upstream of the encoder).
 *
 * `buildCoinbaseOutputs` turns this string into a `CoinbaseOutput.owner`, whose
 * writer is `writeBytesNOrThrow(…, 32)` — and `Buffer.from(s, 'hex')` stops at
 * the first character pair outside the alphabet instead of failing, so a
 * character count says nothing about the byte count it produces: 64 non-hex
 * characters yield 0 bytes, `62 hex + 'zz'` yields 31. Both encode to a
 * coinbase leaf the writer refuses, inside the miner's own interval callback,
 * where nothing converts a throw into a rejection.
 */
function assertTreasuryKeyEncodable(cfg: Config): void {
  const key = cfg.treasuryPubKey;
  if (key.length === 0) return;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      `Invalid treasuryPubKey for network "${cfg.networkType}" — must be 64 ` +
        'hex characters (32 bytes) or empty for no treasury',
    );
  }
}

/**
 * The genesis proof payload's domain, established where it enters this node's
 * config surface — the same job `assertTreasuryKeyEncodable` does one function
 * up, and for the sharper half of the same hazard.
 *
 * `Buffer.from(s, 'hex')` stops at the first character pair outside the
 * alphabet instead of failing, and `writeLp` is total by sentinel rather than
 * throwing, so a malformed payload produces a **shorter payload and a different
 * genesis state root** with nothing raised anywhere. The node then runs, mines,
 * and forks from every honest peer at height 1. Refuse at load rather than
 * clamp or default: put the verdict where a human is reading it.
 *
 * **Non-empty, and that half is not pedantry.** The proof box is the whole of
 * the difference between testnet's and devnet's genesis states — they share the
 * system keypair and both box values, so their karma and credit boxes are
 * byte-identical and carry the same ids. An empty payload still encodes cleanly,
 * to the same `030000` on both, and collapses two networks onto one genesis
 * root. `network.test.ts` requires one or more pairs of the same profile
 * strings; the two guards state one rule between them, so the fail-stop must not
 * be the permissive one.
 *
 * ⚠ **This is not the payload BOUND.** How long a payload may be is a decode
 * rule and belongs beside the encoder in `@dagsocial/types`; this asserts only
 * that the configured string denotes bytes, and denotes the ones it appears to.
 */
function assertGenesisProofPayloadEncodable(cfg: Config): void {
  const hex = cfg.profile.genesisProofPayload;
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error(
      `Invalid genesisProofPayload for network "${cfg.networkType}" — must be a ` +
        'non-empty, even number of hex characters; a truncated decode silently ' +
        'moves the genesis state root, and an empty payload collapses two ' +
        "networks' genesis states onto one",
    );
  }
}

/**
 * Allow-list of faucet-bearing networks (NODE_INTERFACE §Faucet). Fail-closed:
 * a network added later mints nothing until someone names it here. All three
 * faucet gates — the system-box provisioning (index.ts), the /faucet mount
 * (server.ts) and the /credits/faucet handler guard (routes/utxo.ts) — call
 * this one predicate so they cannot drift.
 */
export function isFaucetNetwork(networkType: NetworkType): boolean {
  return networkType === 'testnet' || networkType === 'devnet';
}

/**
 * A miner node serves the coinbase payout override (`?miner=`) over HTTP, so the
 * bearer secret is load-bearing — there is no unauthenticated mode. A miner
 * without a secret fails at startup rather than opening the endpoints
 * (MINING_INTERFACE invariant 8, audit M-7).
 */
function assertMiningAuthConfigured(cfg: Config): void {
  if (cfg.nodeRole !== 'miner') return;
  if (cfg.miningSecret.trim().length === 0) {
    throw new Error(
      'MINING_SECRET must be set and non-empty when NODE_ROLE=miner — ' +
        'the mining API has no unauthenticated mode',
    );
  }
}

function parseBootstrapPeers(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseNodeRole(raw: string): 'server' | 'miner' {
  if (raw === 'server' || raw === 'miner') return raw;
  throw new Error(`Invalid NODE_ROLE "${raw}" — must be "server" or "miner"`);
}

export const config = loadConfig();
