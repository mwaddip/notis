import {
  profileFor,
  NETWORK_PROFILES,
  RETARGET_HALFLIFE_BLOCKS,
  MAX_FUTURE_DRIFT_MS,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { MAX_NIPOPOW_PARAM } from '@dagsocial/nipopow';
import type { VerifyProfile } from '@dagsocial/nipopow';

export type { VerifyProfile };

// CONSTANTS → Client defaults
export const DEFAULT_M = 24;
export const DEFAULT_K = 20;

export interface Config {
  nodeUrls: string[];
  profile: NetworkProfile;
  m: number;
  k: number;
  user: string | null;
  // WEB_INTERFACE → The extension → "The post check" — a `post <id>` positional
  // puts the command line in post-check mode: a GET /posts/<id>?tx=1 against
  // the first configured node, run through checkPosts.
  post: string | null;
  allowSingle: boolean;
  json: boolean;
}

// NIPOPOW_INTERFACE → verifyProof — the retarget band and the version schedule are the profile's
export function verifierProfile(profile: NetworkProfile, nowMs: number): VerifyProfile {
  const idealMs = profile.orderingBlockIdealMs;
  return {
    retarget: {
      anchorBits: profile.orderingBlockPowTargetBits,
      idealMs,
      halflifeMs: RETARGET_HALFLIFE_BLOCKS * idealMs,
      floorBits: profile.orderingBlockPowTargetFloorBits,
      ceilingBits: profile.orderingBlockPowTargetCeilingBits,
    },
    maxFutureDriftMs: MAX_FUTURE_DRIFT_MS,
    nowMs,
    genesisId: profile.genesisId,
    // TYPES_INTERFACE → Version — verifyProof rule 3 checks each header at its own height
    protocolVersionSchedule: profile.protocolVersionSchedule,
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError' as const;
}

export function parseConfig(argv: string[], env: Record<string, string | undefined>): Config {
  const networkType = env['NETWORK_TYPE'];
  if (!networkType) throw new ConfigError('NETWORK_TYPE is required');
  if (!(networkType in NETWORK_PROFILES)) throw new ConfigError(`unknown NETWORK_TYPE: ${networkType}`);
  const profile = profileFor(networkType as NetworkType);

  const nodeUrlsRaw = env['NODE_URLS'];
  if (!nodeUrlsRaw) throw new ConfigError('NODE_URLS is required');
  const nodeUrls = nodeUrlsRaw.split(',').map(u => u.trim()).filter(Boolean);
  if (nodeUrls.length === 0) throw new ConfigError('NODE_URLS is empty');

  let m = DEFAULT_M;
  let k = DEFAULT_K;
  let user: string | null = null;
  let allowSingle = false;
  let json = false;
  let post: string | null = null;

  // The `post <id>` positional, when present, is the first argv. Every other
  // argv stays a flag.
  let flagsStart = 0;
  if (argv[0] === 'post') {
    const id = argv[1];
    if (id === undefined) throw new ConfigError('post requires an id');
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ConfigError('post id must be 64 lowercase hex chars');
    post = id;
    flagsStart = 2;
  }

  for (let i = flagsStart; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--m') {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError('--m requires a value');
      m = parsePositiveInt(v, '--m');
      if (m > MAX_NIPOPOW_PARAM) throw new ConfigError(`--m must be at most ${MAX_NIPOPOW_PARAM}`);
    } else if (arg === '--k') {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError('--k requires a value');
      k = parsePositiveInt(v, '--k');
      if (k > MAX_NIPOPOW_PARAM) throw new ConfigError(`--k must be at most ${MAX_NIPOPOW_PARAM}`);
    } else if (arg === '--user') {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError('--user requires a value');
      if (!/^[0-9a-f]{64}$/.test(v)) throw new ConfigError('--user must be 64 lowercase hex chars');
      user = v;
    } else if (arg === '--allow-single') {
      allowSingle = true;
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new ConfigError(`unknown argument: ${arg}`);
    }
  }

  // The post check is a function of the row the node serves; it reads no
  // chain state and asks the node nothing beyond /posts/<id>?tx=1
  // (WEB_INTERFACE → The extension → "The post check"), so the two-node
  // discipline that guards the tip is not its gate.
  if (post === null && nodeUrls.length < 2 && !allowSingle) {
    throw new ConfigError('at least 2 node URLs required (use --allow-single to override — a single node can eclipse the client)');
  }

  return { nodeUrls, profile, m, k, user, post, allowSingle, json };
}

function parsePositiveInt(s: string, flag: string): number {
  if (!/^\d+$/.test(s)) throw new ConfigError(`${flag} must be a positive integer, got: ${s}`);
  const n = Number(s);
  if (n < 1) throw new ConfigError(`${flag} must be a positive integer, got: ${s}`);
  return n;
}
