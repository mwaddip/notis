import { parse as parsePath, join as joinPath } from 'node:path';
import {
  MIN_FEE_RATE_PER_BYTE,
  TREE_KEY_LENGTH,
  MAX_BLOCK_BODY_BYTES,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  POW_TARGET_BITS_MAX,
  decayCfgFor,
  isHex64,
  profileFor,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType, ProtocolEra } from '@dagsocial/types';
import type { MeshConfig, PublicFipsPeer } from '@dagsocial/net';
import {
  PUBLIC_FIPS_PEERS,
  FIPS_UDP_DEFAULT_PORT,
  FIPS_PUBLIC_PEERS_MAX,
} from '@dagsocial/net';
import { DEFAULT_MAX_MEMPOOL_ENTRIES } from './store/mempool.js';
import { DECIMAL_INT } from './decimal-int.js';

export interface Config {
  port: number;
  adminPort: number;
  adminBindAddress: string;
  dbPath: string;
  /**
   * The node key's file, read or written by `loadNodeKey`
   * (NET_INTERFACE → The node key; NODE_INTERFACE → Configuration →
   * "The key file is named for the store"). An unset `NODE_KEY_PATH`
   * derives the path from `dbPath` by replacing its extension with `.key`;
   * a set empty value is refused at load.
   */
  nodeKeyPath: string;
  /**
   * The network this node is on. Class `network-identity` — the only environment
   * variable that may change a consensus parameter, and it changes every one of
   * them together by selecting `profile` (ARCHITECTURE → Network Identity).
   */
  networkType: NetworkType;
  /**
   * The parameter table `networkType` selects, resolved once at load and frozen.
   * The consensus fields below are copied from it so consumers keep one flat
   * config surface; the node reads `magic` off it for the wire layer.
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
  // Net settings — the whole-number knobs reach `NetNode` from the one
  // loaded `config`; semantics `NET_INTERFACE → Config` and
  // `NET_INTERFACE → Outbound Manager`.
  bootstrapPeers: string[];
  listenAddrs: string;
  maxPeers: number;
  maxReaders: number;
  minPeers: number;
  peerDbCap: number;
  outboundRedialCooldownMs: number;
  penaltyScoreThreshold: number;
  temporalBanDurationMs: number;
  penaltyDecayIntervalMs: number;
  syncRequestTimeoutMs: number;
  /**
   * The mesh a `public` or `private` node runs — `null` with no
   * `MESH_ROLE` (NODE_INTERFACE → Configuration; NET_INTERFACE → The
   * mesh). `index.ts` completes it with the `httpBase` function
   * (NODE_INTERFACE → Configuration → "The node's mesh endpoint
   * forwards to its own public listener") and passes it as the
   * `NetConfig.mesh` of this node's `NetNode`, substituting
   * `undefined` for `null`.
   */
  mesh: Omit<MeshConfig, 'httpBase'> | null;
}

export function loadConfig(): Readonly<Config> {
  // Resolve the network profile first. `profileFor` throws on an unknown value:
  // a misconfigured node must fail at startup, loudly — it must never default
  // onto a network it was not pointed at.
  const profile = profileFor((process.env['NETWORK_TYPE'] ?? 'testnet') as NetworkType);

  // The karma decay cfg — the one derivation from the profile and the two
  // universal constants (TYPES_INTERFACE → Identity record and karma valuation).
  const decay = decayCfgFor(profile);

  const dbPath = process.env['DB_PATH'] ?? 'dagsocial.db';
  const port = readWholeNumber('PORT', 3000, { floor: 0, port: true });

  const cfg: Config = {
    port,
    adminPort: readWholeNumber('ADMIN_PORT', 3001, { floor: 0, port: true }),
    adminBindAddress: process.env['ADMIN_BIND_ADDRESS'] ?? '127.0.0.1',
    dbPath,
    nodeKeyPath: parseNodeKeyPath(process.env['NODE_KEY_PATH'], dbPath),
    networkType: profile.networkType,
    profile,
    nodeRole: parseNodeRole(process.env['NODE_ROLE'] ?? 'server'),
    webShellPath: process.env['WEB_SHELL_PATH'] ?? '',
    // BLOCK_BODY_BUDGET_BYTES is local over a consensus ceiling: the reader
    // admits any value at or above its floor of 1, and the clamp here reads
    // a value above `MAX_BLOCK_BODY_BYTES` as "as much as the rules allow"
    // — a node cannot raise its own consensus bound by asking. A fixture-
    // assembled `Config` does not pass through here, so the producer clamps
    // again where it spends the budget (MINING_INTERFACE → Template and
    // submit → "Packing to the budget").
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
    maxReaders: readWholeNumber('MAX_READERS', 64, { floor: 0 }),
    minPeers: readWholeNumber('MIN_PEERS', 3, { floor: 0 }),
    peerDbCap: readWholeNumber('PEER_DB_CAP', 1000, { floor: 0 }),
    outboundRedialCooldownMs: readWholeNumber('OUTBOUND_REDIAL_COOLDOWN_MS', 60_000, { floor: 0 }),
    penaltyScoreThreshold: readWholeNumber('PENALTY_SCORE_THRESHOLD', 500, { floor: 0 }),
    temporalBanDurationMs: readWholeNumber('TEMPORAL_BAN_DURATION_MS', 3_600_000, { floor: 0 }),
    penaltyDecayIntervalMs: readWholeNumber('PENALTY_DECAY_INTERVAL_MS', 120_000, { floor: 1 }),
    syncRequestTimeoutMs: readWholeNumber('SYNC_REQUEST_TIMEOUT_MS', 10_000, { floor: 1 }),
    mesh: parseMeshConfig({
      role: process.env['MESH_ROLE'],
      listen: process.env['MESH_LISTEN'],
      announce: process.env['MESH_ANNOUNCE'],
      stun: process.env['MESH_STUN'],
      stunServers: process.env['MESH_STUN_SERVERS'],
      wss: process.env['MESH_WSS'],
      acmeDirectory: process.env['MESH_ACME_DIRECTORY'],
      acmeChallengePort: process.env['MESH_ACME_CHALLENGE_PORT'],
      fipsPublic: process.env['FIPS_PUBLIC'],
      fipsPublicPeers: process.env['FIPS_PUBLIC_PEERS'],
      fipsUdpListen: process.env['FIPS_UDP_LISTEN'],
      network: profile.networkType,
      dbPath,
    }),
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
  if (!DECIMAL_INT.test(raw)) {
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
 * `floorBits <= anchorBits <= ceilingBits`, `ceilingBits <= POW_TARGET_BITS_MAX`,
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
  if (!(cfg.orderingBlockPowTargetCeilingBits <= POW_TARGET_BITS_MAX)) {
    throw new Error(
      `orderingBlockPowTargetCeilingBits ${cfg.orderingBlockPowTargetCeilingBits} for network ` +
        `"${net}" exceeds ${POW_TARGET_BITS_MAX}`,
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
 * the things that keeps two genesis roots apart. The suite requires every
 * profile pair to disagree on this string too; the two guards state one rule
 * between them, so the fail-stop must not be the permissive one.
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
 * (MINING_INTERFACE → Invariants, item 8).
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
 * `NODE_KEY_PATH`, the file `loadNodeKey` reads or writes
 * (NODE_INTERFACE → Configuration → "The key file is named for the store").
 * Unset derives the path from `dbPath` by replacing its extension with
 * `.key`: `node:path`'s `parse` picks the directory and the base name,
 * `join` recombines them with `.key`, so `dagsocial.db` lands at
 * `dagsocial.key` beside the store, a name with no extension takes `.key`
 * appended, and the leading `./` on a relative path is normalized away.
 * A set empty value is refused at load naming the setting, the shape every
 * refusal of a set-but-refused setting takes
 * (NODE_INTERFACE → Configuration →
 * "Every whole-number setting is read by one reader, and a set value it refuses stops the node at load").
 */
function parseNodeKeyPath(raw: string | undefined, dbPath: string): string {
  if (raw === undefined) {
    const parsed = parsePath(dbPath);
    return joinPath(parsed.dir, parsed.name + '.key');
  }
  if (raw === '') {
    throw new Error(
      'Invalid NODE_KEY_PATH "" — the empty string names no file; unset ' +
        'NODE_KEY_PATH to default to the store path with its extension replaced by .key',
    );
  }
  return raw;
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

// MESH_INTERFACE → Discovery → "An address is a hint" — a mesh listen
// or announce multiaddr is an IP literal address, never a hostname.
const MESH_DNS_RE = /\/dns4\/|\/dns6\/|\/dnsaddr\//;
// MESH_INTERFACE → NAT — a public node's listen set must hold a
// `/webrtc-direct` address so a browser can reach it at a fixed port.
const MESH_WEBRTC_DIRECT_RE = /\/webrtc-direct(?:\/|$)/;

/**
 * NODE_INTERFACE → Configuration → "The mesh state directory is named
 * for the store". `DB_PATH` with its extension replaced by `.mesh` —
 * `dagsocial.db` → `dagsocial.mesh`, a name with no extension takes
 * `.mesh` appended — as `parseNodeKeyPath` does for `.key`.
 */
function meshStateDirFor(dbPath: string): string {
  const parsed = parsePath(dbPath);
  return joinPath(parsed.dir, parsed.name + '.mesh');
}

/**
 * NODE_INTERFACE → Configuration — a comma-separated list, trimmed
 * and emptied of blanks. Unset or empty yields `[]`.
 */
function parseMeshAddrList(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * NODE_INTERFACE → Configuration — `MESH_STUN` is `<ip>:<port>` or
 * `[<ipv6>]:<port>`, `off` turning the server off, unset leaving it
 * absent so `net` derives the default from the first WebRTC-direct
 * listen address (MESH_INTERFACE → NAT → "A node's role is its
 * operator's setting"). The strict `isIpLiteral` check lives in
 * `MeshConfig`'s own `assertMeshConfig` at `net.start()`; this reader
 * returns `{ host, port }` for whatever the operator spelled, and
 * `net` refuses a hostname with `MeshConfigError`.
 */
function parseMeshStun(raw: string | undefined): { host: string; port: number } | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'off') return null;
  let host: string;
  let portStr: string;
  if (raw.startsWith('[')) {
    const idx = raw.indexOf(']:');
    if (idx < 0) {
      throw new Error(`Invalid MESH_STUN "${raw}" — a bracketed host must end with ]:<port>`);
    }
    host = raw.substring(1, idx);
    portStr = raw.substring(idx + 2);
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx < 0) {
      throw new Error(`Invalid MESH_STUN "${raw}" — must be <ip>:<port> or off`);
    }
    host = raw.substring(0, idx);
    portStr = raw.substring(idx + 1);
  }
  if (!DECIMAL_INT.test(portStr)) {
    throw new Error(`Invalid MESH_STUN "${raw}" — port must be decimal digits only`);
  }
  const port = Number(portStr);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid MESH_STUN "${raw}" — port must be 0..65535`);
  }
  return { host, port };
}

/**
 * NODE_INTERFACE → Configuration — `MESH_WSS` is `<ip>:<port>` or
 * `[<ipv6>]:<port>`, requires `MESH_ACME_DIRECTORY`. The challenge
 * port reads through the one whole-number reader as a port, defaulting
 * to 80. The strict IP check is `MeshConfig`'s at `net.start()`.
 */
function parseMeshWss(
  raw: string | undefined,
  acmeDirectory: string | undefined,
  acmeChallengePortRaw: string | undefined,
): { ip: string; port: number; acmeDirectory: string; challengePort: number } | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (acmeDirectory === undefined || acmeDirectory === '') {
    throw new Error('Invalid MESH_WSS — MESH_ACME_DIRECTORY must be set');
  }
  let ip: string;
  let portStr: string;
  if (raw.startsWith('[')) {
    const idx = raw.indexOf(']:');
    if (idx < 0) {
      throw new Error(`Invalid MESH_WSS "${raw}" — a bracketed host must end with ]:<port>`);
    }
    ip = raw.substring(1, idx);
    portStr = raw.substring(idx + 2);
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx < 0) {
      throw new Error(`Invalid MESH_WSS "${raw}" — must be <ip>:<port>`);
    }
    ip = raw.substring(0, idx);
    portStr = raw.substring(idx + 1);
  }
  if (!DECIMAL_INT.test(portStr)) {
    throw new Error(`Invalid MESH_WSS "${raw}" — port must be decimal digits only`);
  }
  const port = Number(portStr);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid MESH_WSS "${raw}" — port must be 0..65535`);
  }
  // NODE_INTERFACE → Configuration → "Every whole-number setting is read by one reader, and a set value it refuses stops the node at load."
  // `MESH_ACME_CHALLENGE_PORT` passes through the same path,
  // defaulting to 80.
  let challengePort: number;
  if (acmeChallengePortRaw === undefined) {
    challengePort = 80;
  } else {
    if (!DECIMAL_INT.test(acmeChallengePortRaw)) {
      throw new Error(
        `Invalid MESH_ACME_CHALLENGE_PORT "${acmeChallengePortRaw}" — must be decimal digits only`,
      );
    }
    challengePort = Number(acmeChallengePortRaw);
    if (!Number.isSafeInteger(challengePort) || challengePort < 0 || challengePort > 65_535) {
      throw new Error(
        `Invalid MESH_ACME_CHALLENGE_PORT "${acmeChallengePortRaw}" — a TCP port is at most 65 535`,
      );
    }
  }
  return { ip, port, acmeDirectory, challengePort };
}

/**
 * NODE_INTERFACE → Configuration — `FIPS_PUBLIC` is "on" or "off", unset
 * reading "off" (MESH_INTERFACE → FIPS → "A node peers with the public FIPS
 * mesh when its operator turns it on").
 */
function parseFipsPublic(raw: string | undefined): boolean {
  if (raw === undefined || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`Invalid FIPS_PUBLIC "${raw}" — must be "on" or "off"`);
}

/**
 * NODE_INTERFACE → Configuration — `FIPS_PUBLIC_PEERS` is comma-separated
 * `<npub>@<host>[:<port>]`, the port `FIPS_UDP_DEFAULT_PORT` where none is
 * named and a bracketed IPv6 host as `MESH_STUN` reads one; each entry's
 * `name` is its host. The npub's bech32 payload is decoded at start by
 * `net`'s `assertMeshConfig`; this reader checks only the shape.
 */
function parseFipsPublicPeers(raw: string | undefined): PublicFipsPeer[] {
  if (raw === undefined || raw === '') return [];
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (entries.length > FIPS_PUBLIC_PEERS_MAX) {
    throw new Error(
      `Invalid FIPS_PUBLIC_PEERS — ${entries.length} entries, over FIPS_PUBLIC_PEERS_MAX (${FIPS_PUBLIC_PEERS_MAX})`,
    );
  }
  const out: PublicFipsPeer[] = [];
  for (const entry of entries) {
    out.push(parseFipsPublicPeer(entry));
  }
  return out;
}

function parseFipsPublicPeer(entry: string): PublicFipsPeer {
  const atIdx = entry.indexOf('@');
  if (atIdx < 0) {
    throw new Error(
      `Invalid FIPS_PUBLIC_PEERS entry "${entry}" — must be <npub>@<host>[:<port>]`,
    );
  }
  const npub = entry.substring(0, atIdx);
  if (!npub.startsWith('npub1')) {
    throw new Error(
      `Invalid FIPS_PUBLIC_PEERS entry "${entry}" — npub does not begin with "npub1"`,
    );
  }
  const hostPort = entry.substring(atIdx + 1);
  let host: string;
  let portStr: string | undefined;
  if (hostPort.startsWith('[')) {
    const idx = hostPort.indexOf(']');
    if (idx < 0) {
      throw new Error(
        `Invalid FIPS_PUBLIC_PEERS entry "${entry}" — a bracketed host must end with ]`,
      );
    }
    host = hostPort.substring(1, idx);
    const tail = hostPort.substring(idx + 1);
    if (tail === '') {
      portStr = undefined;
    } else if (tail.startsWith(':')) {
      portStr = tail.substring(1);
    } else {
      throw new Error(
        `Invalid FIPS_PUBLIC_PEERS entry "${entry}" — a bracketed host must be followed by :<port>`,
      );
    }
  } else {
    const idx = hostPort.lastIndexOf(':');
    if (idx < 0) {
      host = hostPort;
      portStr = undefined;
    } else {
      host = hostPort.substring(0, idx);
      portStr = hostPort.substring(idx + 1);
    }
  }
  if (host.length === 0) {
    throw new Error(`Invalid FIPS_PUBLIC_PEERS entry "${entry}" — host is empty`);
  }
  let port: number;
  if (portStr === undefined) {
    port = FIPS_UDP_DEFAULT_PORT;
  } else {
    if (!DECIMAL_INT.test(portStr)) {
      throw new Error(
        `Invalid FIPS_PUBLIC_PEERS entry "${entry}" — port must be decimal digits only`,
      );
    }
    port = Number(portStr);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        `Invalid FIPS_PUBLIC_PEERS entry "${entry}" — port must be 1..65535`,
      );
    }
  }
  return { name: host, npub, host, port };
}

/**
 * NODE_INTERFACE → Configuration — `FIPS_UDP_LISTEN` is `<ip>:<port>` or
 * `[<ip6>]:<port>`; unset or empty, no inbound bind (MESH_INTERFACE → FIPS
 * → "A node may accept public links"). A hostname is refused, as `MESH_STUN`
 * refuses one.
 */
function parseFipsUdpListen(
  raw: string | undefined,
): { host: string; port: number } | null {
  if (raw === undefined || raw === '') return null;
  let host: string;
  let portStr: string;
  if (raw.startsWith('[')) {
    const idx = raw.indexOf(']:');
    if (idx < 0) {
      throw new Error(
        `Invalid FIPS_UDP_LISTEN "${raw}" — a bracketed host must end with ]:<port>`,
      );
    }
    host = raw.substring(1, idx);
    portStr = raw.substring(idx + 2);
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx < 0) {
      throw new Error(
        `Invalid FIPS_UDP_LISTEN "${raw}" — must be <ip>:<port> or [<ipv6>]:<port>`,
      );
    }
    host = raw.substring(0, idx);
    portStr = raw.substring(idx + 1);
  }
  if (host.length === 0) {
    throw new Error(`Invalid FIPS_UDP_LISTEN "${raw}" — host is empty`);
  }
  if (!isIpLiteral(host)) {
    throw new Error(
      `Invalid FIPS_UDP_LISTEN "${raw}" — ${JSON.stringify(host)} is not an IP literal`,
    );
  }
  if (!DECIMAL_INT.test(portStr)) {
    throw new Error(
      `Invalid FIPS_UDP_LISTEN "${raw}" — port must be decimal digits only`,
    );
  }
  const port = Number(portStr);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid FIPS_UDP_LISTEN "${raw}" — port must be 1..65535`);
  }
  return { host, port };
}

/**
 * The same permissive IP-literal shape `net`'s `assertMeshConfig` reads;
 * the strict parse runs where a socket is opened.
 */
function isIpLiteral(s: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    for (const p of s.split('.')) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    }
    return true;
  }
  return s.includes(':') && !s.includes('/');
}

/**
 * NODE_INTERFACE → Configuration — the mesh a node runs, or `null`
 * with no `MESH_ROLE`. Every refusal names the setting at fault; the
 * strict refusals `MESH_INTERFACE` names (the IP literal on
 * `MESH_STUN` and `MESH_WSS`, the `stun:<ip>:<port>` shape on
 * `MESH_STUN_SERVERS`, the `/webrtc-direct` requirement on a public
 * node's listen set) land in `net`'s own `assertMeshConfig` at
 * `net.start()`; those the node can see at load without reading a
 * socket land here.
 *
 * `FIPS_PUBLIC=on` without `MESH_ROLE` is refused naming both settings
 * (NODE_INTERFACE → Configuration — the `FIPS_PUBLIC` row). The reader
 * answers `null` early when `MESH_ROLE` is unset, so the FIPS checks run
 * where they still see the setting.
 */
function parseMeshConfig(opts: {
  role: string | undefined;
  listen: string | undefined;
  announce: string | undefined;
  stun: string | undefined;
  stunServers: string | undefined;
  wss: string | undefined;
  acmeDirectory: string | undefined;
  acmeChallengePort: string | undefined;
  fipsPublic: string | undefined;
  fipsPublicPeers: string | undefined;
  fipsUdpListen: string | undefined;
  network: 'devnet' | 'testnet' | 'mainnet';
  dbPath: string;
}): Omit<MeshConfig, 'httpBase'> | null {
  const fipsPublicOn = parseFipsPublic(opts.fipsPublic);
  const fipsPublicPeersParsed = parseFipsPublicPeers(opts.fipsPublicPeers);
  const fipsUdpListenParsed = parseFipsUdpListen(opts.fipsUdpListen);
  if (!fipsPublicOn) {
    if (fipsPublicPeersParsed.length > 0) {
      throw new Error(
        'Invalid FIPS_PUBLIC_PEERS — set without FIPS_PUBLIC=on',
      );
    }
    if (fipsUdpListenParsed !== null) {
      throw new Error(
        'Invalid FIPS_UDP_LISTEN — set without FIPS_PUBLIC=on',
      );
    }
  }
  if (opts.role === undefined) {
    if (fipsPublicOn) {
      throw new Error(
        'Invalid FIPS_PUBLIC "on" — MESH_ROLE must be set to "public" or "private"',
      );
    }
    return null;
  }
  if (opts.role !== 'public' && opts.role !== 'private') {
    throw new Error(
      `Invalid MESH_ROLE "${opts.role}" — must be "public" or "private"`,
    );
  }
  const role: 'public' | 'private' = opts.role;
  const listen = parseMeshAddrList(opts.listen);
  for (const a of listen) {
    if (MESH_DNS_RE.test(a)) {
      throw new Error(`Invalid MESH_LISTEN "${a}" — carries a DNS component`);
    }
  }
  if (role === 'public') {
    let hasWebrtcDirect = false;
    for (const a of listen) {
      if (MESH_WEBRTC_DIRECT_RE.test(a)) { hasWebrtcDirect = true; break; }
    }
    if (!hasWebrtcDirect) {
      throw new Error(
        'Invalid MESH_LISTEN — a public node has no /webrtc-direct listen address',
      );
    }
  }
  const announce = parseMeshAddrList(opts.announce);
  for (const a of announce) {
    if (MESH_DNS_RE.test(a)) {
      throw new Error(`Invalid MESH_ANNOUNCE "${a}" — carries a DNS component`);
    }
  }
  const stun = parseMeshStun(opts.stun);
  if (role === 'private' && stun !== undefined) {
    throw new Error('Invalid MESH_STUN — a private node does not serve STUN');
  }
  const stunServers = parseMeshAddrList(opts.stunServers);
  const wss = parseMeshWss(opts.wss, opts.acmeDirectory, opts.acmeChallengePort);
  if (role === 'private' && wss !== undefined) {
    throw new Error('Invalid MESH_WSS — a private node does not serve WSS');
  }
  const fipsPublic = fipsPublicOn
    ? {
        peers:
          fipsPublicPeersParsed.length > 0
            ? fipsPublicPeersParsed
            : [...PUBLIC_FIPS_PEERS],
        listen: fipsUdpListenParsed,
      }
    : undefined;
  const mesh: Omit<MeshConfig, 'httpBase'> = {
    role,
    network: opts.network,
    listen,
    stateDir: meshStateDirFor(opts.dbPath),
    ...(announce.length > 0 ? { announce } : {}),
    ...(stun !== undefined ? { stun } : {}),
    ...(stunServers.length > 0 ? { stunServers } : {}),
    ...(wss !== undefined ? { wss } : {}),
    ...(fipsPublic !== undefined ? { fipsPublic } : {}),
  };
  return mesh;
}

export const config = loadConfig();
