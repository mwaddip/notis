import {
  profileFor,
  PROTOCOL_VERSION,
  NETWORK_PROFILES,
  RETARGET_HALFLIFE_BLOCKS,
  MAX_FUTURE_DRIFT_MS,
} from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { MAX_NIPOPOW_PARAM } from '@dagsocial/nipopow';
import type { VerifyProfile } from '@dagsocial/nipopow';

export type { VerifyProfile };

export interface Config {
  nodeUrls: string[];
  profile: NetworkProfile;
  m: number;
  k: number;
  user: string | null;
  allowSingle: boolean;
  json: boolean;
}

// NIPOPOW_INTERFACE → verifyProof — the schedule's parameters are the profile band
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
    protocolVersion: PROTOCOL_VERSION,
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

  let m = 6;
  let k = 20;
  let user: string | null = null;
  let allowSingle = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
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

  if (nodeUrls.length < 2 && !allowSingle) {
    throw new ConfigError('at least 2 node URLs required (use --allow-single to override — a single node can eclipse the client)');
  }

  return { nodeUrls, profile, m, k, user, allowSingle, json };
}

function parsePositiveInt(s: string, flag: string): number {
  if (!/^\d+$/.test(s)) throw new ConfigError(`${flag} must be a positive integer, got: ${s}`);
  const n = Number(s);
  if (n < 1) throw new ConfigError(`${flag} must be a positive integer, got: ${s}`);
  return n;
}
