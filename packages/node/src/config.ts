import {
  MIN_FEE_RATE_PER_BYTE,
  TREE_KEY_LENGTH,
  MAX_BLOCK_BODY_BYTES,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  decayCfgFor,
  isHex64,
  profileFor,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType, ProtocolEra } from '@dagsocial/types';
import { DEFAULT_MAX_MEMPOOL_ENTRIES } from './store/mempool.js';

export interface Config {
  port: number;
  adminPort: number;
  adminBindAddress: string;
  dbPath: string;
  /**
   * The network this node is on. Class `network-identity` — the only environment
   * variable that may change a consensus parameter, and it changes every one of
   * them together by selecting `profile` (ARCHITECTURE → Network Identity).
   */
  networkType: NetworkType;
  /**
   * The parameter table `networkType` selects, resolved once at load and frozen.
   * The consensus fields below are copied from it so consumers keep one flat
   * config surface; `index.ts` reads `magic` off it for the wire layer.
   */
  profile: NetworkProfile;
  nodeRole: 'server' | 'miner';
  /**
   * Path of the web client's `index.html`; empty means `GET /shell/:id`
   * answers 404 (NODE_INTERFACE → Configuration, → Link previews).
   */
  webShellPath: string;
  /**
   * Body bytes this node fills the blocks it **produces** to
   * (NODE_INTERFACE → Configuration). Local, because a
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
   * Relay floor in base units per **in-block** byte — the rate beneath which
   * this node refuses a credit transaction (MEMPOOL_INTERFACE → Fee floor).
   * The denominator is `entryByteCost`, what the transaction occupies inside a
   * block body, which is ~34 bytes more than its bare encoding.
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
  orderingBlockIdealMs: number;
  orderingBlockPowTargetFloorBits: number;
  orderingBlockPowTargetCeilingBits: number;
  /** Blocks before a coinbase output is spendable. Apply-time consensus check (MINING invariant 3). */
  creditMinerRewardDelay: number;
  // Emission schedule shape. `computeBlockReward` is a consensus function on
  // both the creator and the applier, so both read these from here.
  creditFixedRateBlocks: number;
  creditEpochBlocks: number;
  // The EmissionBox's genesis value, CARRIED rather than derived
  // (TYPES_INTERFACE → EmissionBox). Strictly below the curve's own sum.
  creditEmissionTotal: bigint;
  // Vouch and invite timing
  vouchCooldownBlocks: number;
  inviteProbationBlocks: number;
  /** k — the multiplier in D(N) = max(1, icbrt(k · N)). Per-network cap. */
  membershipBarMultiplier: number;
  /**
   * The faucet identity this network's genesis seeds, or absent where it seeds
   * none. **The absence IS the gate** — mainnet omits it, so no faucet identity
   * exists in mainnet state and there is nothing for a service to hold a key
   * to. The node holds the public key and never a secret
   * (ARCHITECTURE → "What varies per network, and what must not").
   */
  faucetPublicKey?: string;
  /**
   * The inclusive range an invite's bond may take, and therefore the range the
   * grant may take — the two are one value. A cap rather than a mechanism, so
   * it varies per network.
   */
  inviteBondMin: bigint;
  inviteBondMax: bigint;
  // Karma decay
  karmaStaleThresholdBlocks: number;
  karmaDecayIntervalBlocks: number;
  karmaDecayAmount: bigint;
  karmaMinimum: bigint;
  // Storage rent
  storageRentPeriodBlocks: number;
  // Chain reorganisation — the profile's reorg horizon
  // (TYPES_INTERFACE → Chain reorganisation).
  maxReorgDepth: number;
  // The protocol-version schedule — the era in force at each height
  // (ARCHITECTURE → Protocol Versioning).
  protocolVersionSchedule: readonly ProtocolEra[];
  // AVL state root
  maxProofHistory: number;
  avlKeyLength: number;
  /**
   * The last blocks whose roots this node keeps in memory, the heights its
   * proof routes answer `atHeight` at (NODE_INTERFACE → "A proof at an older
   * height restores a kept root"). Local — a node that keeps fewer serves
   * `atHeight` on fewer heights; below a light client's `k` (20) the node
   * proves it no settled height (NODE_INTERFACE → Configuration, the
   * `PROOF_WINDOW_BLOCKS` row).
   */
  proofWindowBlocks: number;
  /**
   * The most tree nodes the kept roots hold beyond the live tree — the sum
   * of the counts of the blocks the ring reaches above its lowest kept
   * height (NODE_INTERFACE → "The count is the store's"). The lowest kept
   * root is dropped first while that sum is above this; the tip's root is
   * kept whatever it says. Local, like `proofWindowBlocks`.
   */
  proofWindowNodes: number;
  /**
   * Blocks whose proofs this node keeps for `GET /blocks/:height/proof`: apply
   * prunes below `tip − proofRetentionBlocks` (NODE_INTERFACE → The block proof).
   * Local — what a node serves, not what it accepts.
   */
  proofRetentionBlocks: number;
  /**
   * Bytes of proofs this node keeps, on top of `proofRetentionBlocks`: apply
   * prunes the oldest proofs while those kept exceed this cap, after the
   * height-based prune — the tighter of the two wins, and the tip's proof is
   * kept whatever either says (NODE_INTERFACE → The block proof). Local, like
   * `proofRetentionBlocks`.
   */
  proofRetentionBytes: number;
  // Net settings — the seven whole-number knobs reach `NetNode` from the one
  // loaded `config`; semantics `NET_INTERFACE → Config` and
  // `NET_INTERFACE → Outbound Manager`.
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
  minPeers: number;
  peerDbCap: number;
  outboundRedialCooldownMs: number;
  penaltyScoreThreshold: number;
  temporalBanDurationMs: number;
  penaltySafeIntervalMs: number;
  syncRequestTimeoutMs: number;
}

export function loadConfig(): Readonly<Config> {
  // Resolve the network profile first. `profileFor` throws on an unknown value:
  // a misconfigured node must fail at startup, loudly — it must never default
  // onto a network it was not pointed at.
  const profile = profileFor((process.env['NETWORK_TYPE'] ?? 'testnet') as NetworkType);

  // The karma decay cfg — the one derivation from the profile and the two
  // universal constants (TYPES_INTERFACE → Identity record and karma valuation).
  const decay = decayCfgFor(profile);

  const cfg: Config = {
    port: readWholeNumber('PORT', 3000, { floor: 0, port: true }),
    adminPort: readWholeNumber('ADMIN_PORT', 3001, { floor: 0, port: true }),
    adminBindAddress: process.env['ADMIN_BIND_ADDRESS'] ?? '127.0.0.1',
    dbPath: process.env['DB_PATH'] ?? 'dagsocial.db',
    networkType: profile.networkType,
    profile,
    nodeRole: parseNodeRole(process.env['NODE_ROLE'] ?? 'server'),
    webShellPath: process.env['WEB_SHELL_PATH'] ?? '',
    // BLOCK_BODY_BUDGET_BYTES is local over a consensus ceiling: the reader
    // admits any value at or above its floor of 1, and the clamp here reads
    // a value above `MAX_BLOCK_BODY_BYTES` as "as much as the rules allow"
    // — a node cannot raise its own consensus bound by asking. A fixture-
    // assembled `Config` does not pass through here, so the producer clamps
    // again where it spends the budget (`block-creator.ts`).
    blockBodyBudgetBytes: Math.min(
      readWholeNumber('BLOCK_BODY_BUDGET_BYTES', MAX_BLOCK_BODY_BYTES, { floor: 1 }),
      MAX_BLOCK_BODY_BYTES,
    ),
    maxMempoolEntries: readWholeNumber(
      'MAX_MEMPOOL_ENTRIES',
      DEFAULT_MAX_MEMPOOL_ENTRIES,
      { floor: 0 },
    ),
    minFeeRatePerByte: parseFeeFloor(process.env['MIN_FEE_RATE_PER_BYTE']),
    // Mining
    miningSecret: process.env['MINING_SECRET'] ?? '',
    orderingBlockPowTargetBits: profile.orderingBlockPowTargetBits,
    orderingBlockIdealMs: profile.orderingBlockIdealMs,
    orderingBlockPowTargetFloorBits: profile.orderingBlockPowTargetFloorBits,
    orderingBlockPowTargetCeilingBits: profile.orderingBlockPowTargetCeilingBits,
    creditMinerRewardDelay: profile.creditMinerRewardDelay,
    creditFixedRateBlocks: profile.creditFixedRateBlocks,
    creditEpochBlocks: profile.creditEpochBlocks,
    creditEmissionTotal: profile.creditEmissionTotal,
    // Vouch and invite timing — per-network timescale, same rule as the karma
    // decay pair below.
    vouchCooldownBlocks: profile.vouchCooldownBlocks,
    inviteProbationBlocks: profile.inviteProbationBlocks,
    membershipBarMultiplier: profile.membershipBarMultiplier,
    faucetPublicKey: profile.faucetPublicKey,
    inviteBondMin: profile.inviteBondMin,
    inviteBondMax: profile.inviteBondMax,
    // Karma decay — the numbers `decay` above holds; none is readable from the
    // environment.
    karmaStaleThresholdBlocks: decay.staleThresholdBlocks,
    karmaDecayIntervalBlocks: decay.decayIntervalBlocks,
    karmaDecayAmount: decay.decayAmount,
    karmaMinimum: decay.karmaMinimum,
    storageRentPeriodBlocks: profile.storageRentPeriodBlocks,
    maxReorgDepth: profile.maxReorgDepth,
    protocolVersionSchedule: profile.protocolVersionSchedule,
    // AVL state root (NODE_INTERFACE → AVL+ State Root).
    maxProofHistory: readWholeNumber('MAX_PROOF_HISTORY', 1440, { floor: 0 }),
    avlKeyLength: TREE_KEY_LENGTH,
    proofRetentionBlocks: readWholeNumber('PROOF_RETENTION_BLOCKS', 10_080, { floor: 0 }),
    proofRetentionBytes: readWholeNumber('PROOF_RETENTION_BYTES', 2_147_483_648, { floor: 0 }),
    proofWindowBlocks: readWholeNumber('PROOF_WINDOW_BLOCKS', 64, { floor: 0 }),
    proofWindowNodes: readWholeNumber('PROOF_WINDOW_NODES', 250_000, { floor: 0 }),
    // Net settings
    bootstrapPeers: parseBootstrapPeers(process.env['BOOTSTRAP_PEERS'], profile.bootstrapPeers),
    listenAddrs: process.env['LISTEN_ADDRS'] ?? '/ip4/0.0.0.0/tcp/0',
    maxPeers: readWholeNumber('MAX_PEERS', 50, { floor: 1 }),
    minPeers: readWholeNumber('MIN_PEERS', 3, { floor: 0 }),
    peerDbCap: readWholeNumber('PEER_DB_CAP', 1000, { floor: 0 }),
    outboundRedialCooldownMs: readWholeNumber('OUTBOUND_REDIAL_COOLDOWN_MS', 60_000, { floor: 0 }),
    penaltyScoreThreshold: readWholeNumber('PENALTY_SCORE_THRESHOLD', 500, { floor: 0 }),
    temporalBanDurationMs: readWholeNumber('TEMPORAL_BAN_DURATION_MS', 3_600_000, { floor: 0 }),
    penaltySafeIntervalMs: readWholeNumber('PENALTY_SAFE_INTERVAL_MS', 120_000, { floor: 1 }),
    syncRequestTimeoutMs: readWholeNumber('SYNC_REQUEST_TIMEOUT_MS', 10_000, { floor: 1 }),
  };

  assertMiningAuthConfigured(cfg);
  assertGenesisProofPayloadEncodable(cfg);
  assertInviteBondRangeInhabited(cfg);
  assertFaucetPublicKeyWellFormed(cfg);
  assertOrderingTargetAboveFloor(cfg);
  assertReorgDepthValid(cfg);
  assertProofHistoryCoversReorgDepth(cfg);
  assertProofWindowWithinProofHistory(cfg);

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
 * The one reader every whole-number setting answers to
 * (NODE_INTERFACE → Configuration → "Every whole-number setting is read by
 * one reader, and a set value it refuses stops the node at load").
 *
 * Decimal digits and nothing else, so `parseInt` reading `2.5` as 2 and
 * `1e3` as 1 cannot happen here; a safe integer, so a value above 2^53
 * cannot silently round; at or above the setting's floor — 1 for durations
 * and the body budget, 0 for every other — and a port at most 65 535. The
 * setting's name rides every refusal: a value a node cannot read says which
 * one is at fault, and a silent `NaN` or `undefined` never reaches a field
 * whose consumer compares it against a number.
 *
 * ⚠ **This is the environment's entry point, not the field's.** A `Config`
 * assembled directly — every test fixture — never passes through here, so
 * the comparisons downstream remain total over `NaN` and over a value no
 * reader could have returned.
 */
function readWholeNumber(
  name: string,
  defaultValue: number,
  opts: { floor: 0 | 1; port?: boolean },
): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${name} "${raw}" — must be decimal digits only`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name} "${raw}" — must be a safe integer`);
  }
  if (parsed < opts.floor) {
    throw new Error(`Invalid ${name} "${raw}" — must be at least ${opts.floor}`);
  }
  if (opts.port === true && parsed > 65_535) {
    throw new Error(`Invalid ${name} "${raw}" — a TCP port is at most 65 535`);
  }
  return parsed;
}

/**
 * The profile's `maxReorgDepth` is a positive safe integer — refused at load,
 * never clamped (NODE_INTERFACE → Configuration).
 *
 * Written as a negated chain so `NaN` and non-integers refuse: `Number.isSafeInteger`
 * is false for `NaN`, and the positive check excludes zero.
 */
function assertReorgDepthValid(cfg: Config): void {
  if (!(Number.isSafeInteger(cfg.maxReorgDepth) && cfg.maxReorgDepth > 0)) {
    throw new Error(
      `maxReorgDepth ${cfg.maxReorgDepth} for network "${cfg.networkType}" ` +
        'is not a positive safe integer',
    );
  }
}

/**
 * `MAX_PROOF_HISTORY` must cover every height a reorg can walk back to.
 *
 * `checkpointProver` prunes AVL versions below `height - maxProofHistory`,
 * while a switch reverts up to `maxReorgDepth` blocks and its fork point can sit at height 0.
 * A `maxProofHistory` under that depth prunes inside the window the walk
 * still answers within: `reorg` then finds no version at or before its fork
 * height and throws, and the node keeps a chain it should have switched away
 * from. The two numbers must be ordered, and nothing but this check orders
 * them.
 *
 * Written as a negated `>=` rather than a `<` so the check is total on the
 * parse: `parseInt` yields `NaN` for a non-numeric `MAX_PROOF_HISTORY`, and
 * `NaN < maxReorgDepth` is false — a `<` would pass the one value that makes
 * every pruning height `NaN`.
 */
function assertProofHistoryCoversReorgDepth(cfg: Config): void {
  if (!(cfg.maxProofHistory >= cfg.maxReorgDepth)) {
    throw new Error(
      `MAX_PROOF_HISTORY ${cfg.maxProofHistory} is below maxReorgDepth ` +
        `${cfg.maxReorgDepth} — AVL versions inside the reorg window would be ` +
        'pruned, and a reorg reaching one of them would abort with the node ' +
        'still on its own chain',
    );
  }
}

/**
 * `PROOF_WINDOW_BLOCKS` names heights the proof routes answer; the store
 * prunes versions below `tip − MAX_PROOF_HISTORY`, so a window reaching past
 * that names heights the node cannot answer (NODE_INTERFACE → Configuration,
 * → AVL+ State Root → "A height of the proof window with no kept root is
 * served from the store"). Refused at load rather than clamped.
 *
 * Written as a negated `<=` so the check is total on the parse: `NaN` for
 * either side refuses.
 */
function assertProofWindowWithinProofHistory(cfg: Config): void {
  if (!(cfg.proofWindowBlocks <= cfg.maxProofHistory)) {
    throw new Error(
      `PROOF_WINDOW_BLOCKS ${cfg.proofWindowBlocks} is above MAX_PROOF_HISTORY ` +
        `${cfg.maxProofHistory} — the store prunes versions below ` +
        'tip − MAX_PROOF_HISTORY, and a window reaching past that names ' +
        'heights the node cannot answer',
    );
  }
}

/**
 * The difficulty band is refused at load, never clamped.
 * NODE_INTERFACE → Configuration: `floorBits >= ORDERING_BLOCK_POW_TARGET_FLOOR`,
 * `floorBits <= anchorBits <= ceilingBits`, `ceilingBits <= 65536`,
 * `idealMs > 0`. Each comparison is negated so `NaN` refuses.
 */
function assertOrderingTargetAboveFloor(cfg: Config): void {
  const net = cfg.networkType;
  if (!(cfg.orderingBlockPowTargetFloorBits >= ORDERING_BLOCK_POW_TARGET_FLOOR)) {
    throw new Error(
      `orderingBlockPowTargetFloorBits ${cfg.orderingBlockPowTargetFloorBits} for network ` +
        `"${net}" is below the ordering-block floor ${ORDERING_BLOCK_POW_TARGET_FLOOR}`,
    );
  }
  if (!(cfg.orderingBlockPowTargetBits >= cfg.orderingBlockPowTargetFloorBits)) {
    throw new Error(
      `orderingBlockPowTargetBits ${cfg.orderingBlockPowTargetBits} for network ` +
        `"${net}" is below floorBits ${cfg.orderingBlockPowTargetFloorBits}`,
    );
  }
  if (!(cfg.orderingBlockPowTargetCeilingBits >= cfg.orderingBlockPowTargetBits)) {
    throw new Error(
      `orderingBlockPowTargetCeilingBits ${cfg.orderingBlockPowTargetCeilingBits} for network ` +
        `"${net}" is below anchorBits ${cfg.orderingBlockPowTargetBits}`,
    );
  }
  if (!(cfg.orderingBlockPowTargetCeilingBits <= 65536)) {
    throw new Error(
      `orderingBlockPowTargetCeilingBits ${cfg.orderingBlockPowTargetCeilingBits} for network ` +
        `"${net}" exceeds 65536`,
    );
  }
  if (!(cfg.orderingBlockIdealMs > 0)) {
    throw new Error(
      `orderingBlockIdealMs ${cfg.orderingBlockIdealMs} for network ` +
        `"${net}" is not positive`,
    );
  }
}

/**
 * The genesis proof payload's domain, established where it enters this node's
 * config surface rather than where it is encoded (TYPES_INTERFACE →
 * "Totality": a throwing writer's domain belongs upstream of the encoder).
 *
 * `Buffer.from(s, 'hex')` stops at the first character pair outside the
 * alphabet instead of failing, and `writeLp` is total by sentinel rather than
 * throwing, so a malformed payload produces a **shorter payload and a different
 * genesis state root** with nothing raised anywhere. The node then runs, mines,
 * and forks from every honest peer at height 1. Refuse at load rather than
 * clamp or default: put the verdict where a human is reading it.
 *
 * **Non-empty, and that half is not pedantry.** An empty payload still encodes
 * cleanly, to the same `030000` on every network, so a profile that supplied one
 * would seed a proof box byte-identical to another network's — removing one of
 * the things that keeps two genesis roots apart. `network.test.ts` requires one or more pairs of the same profile
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
 * A ceiling under its floor admits no bond at all. Refused at load rather than
 * left to surface as every invite being rejected, which reads as a broken
 * invite rule rather than as the configuration at fault.
 */
function assertInviteBondRangeInhabited(cfg: Config): void {
  if (cfg.profile.inviteBondMax < cfg.profile.inviteBondMin) {
    throw new Error(
      `Network "${cfg.networkType}" caps the invite bond at ${cfg.profile.inviteBondMax} ` +
        `but floors it at ${cfg.profile.inviteBondMin}. Refusing to start — no bond ` +
        'value satisfies both.',
    );
  }
}

/**
 * The faucet identity's public key, where the profile names one.
 *
 * ⛔ **A key that decodes to the wrong bytes forks rather than fails.** Genesis
 * seeds this identity's boxes and those boxes reach `genesisStateRoot`, so a
 * malformed key produces a state root no peer shares — a node that cannot join
 * the network it was pointed at. Refused at load, where the verdict names the
 * configuration.
 *
 * Absence is not malformation: mainnet omits the field, and that omission is
 * the whole of its faucet gate.
 */
function assertFaucetPublicKeyWellFormed(cfg: Config): void {
  const faucetKey = cfg.profile.faucetPublicKey;
  if (faucetKey === undefined) return;
  if (!isHex64(faucetKey)) {
    throw new Error(
      `Invalid faucetPublicKey for network "${cfg.networkType}" — must be 64 ` +
        'lowercase hex characters, an Ed25519 public key',
    );
  }
}

/**
 * A miner node serves the coinbase payout override (`?miner=`) over HTTP, so the
 * bearer secret is load-bearing — there is no unauthenticated mode. A miner
 * without a secret fails at startup rather than opening the endpoints
 * (MINING_INTERFACE → Invariants, item 8; audit M-7).
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

/**
 * `BOOTSTRAP_PEERS`, comma-separated libp2p multiaddrs. Unset defaults to the
 * profile's known nodes; a set variable **replaces** that list rather than
 * adding to it, so an explicitly empty `BOOTSTRAP_PEERS=` names no seeds
 * (NODE_INTERFACE → Configuration).
 */
function parseBootstrapPeers(raw: string | undefined, profilePeers: readonly string[]): string[] {
  if (raw === undefined) return [...profilePeers];
  if (!raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseNodeRole(raw: string): 'server' | 'miner' {
  if (raw === 'server' || raw === 'miner') return raw;
  throw new Error(`Invalid NODE_ROLE "${raw}" — must be "server" or "miner"`);
}

export const config = loadConfig();
