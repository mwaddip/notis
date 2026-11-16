// @dagsocial/test-state's public surface. Its contract is
// contracts/TEST_STATE_INTERFACE.md.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export {
  assertDistFresh,
  NODE_LOADS,
  NIPOPOW_CLIENT_LOADS,
  FAUCET_LOADS,
} from './dist-freshness.js';

export {
  computeFingerprint,
  fingerprintInputs,
  type FingerprintInput,
} from './fingerprint.js';

export {
  cacheRootDir,
  copyOutState,
  readState,
  writeState,
  type CachedState,
  type Manifest,
} from './cache.js';

export {
  runMiner,
  type MinerConfig,
  type MinerHandle,
} from './miner.js';

export {
  allowlistedEnv,
  SPAWN_ENV_ALLOWLIST,
} from './env.js';

export {
  computeClockOffsetMs,
  nodeOptionsForPreload,
} from './clock-offset.js';

export {
  generate,
  pathsFor,
  RECIPES,
  BASE,
  MINIMAL,
  type GenerateOptions,
  type GenerateResult,
  type StateRecipe,
} from './generator.js';

export {
  up,
  down,
  probePort,
  type UpOptions,
  type UpPorts,
  type UpResult,
} from './loader.js';

// TEST_STATE_INTERFACE → The clock offset. The barrel lives in src/ at test
// time (vitest's alias) and in dist/ at runtime (the package's main); both
// are one directory below the package root, so `..` lands on the package
// and `src/clock-offset-preload.mjs` points at the one preload file.
export const CLOCK_OFFSET_PRELOAD: string = resolve(
  import.meta.dirname,
  '..',
  'src',
  'clock-offset-preload.mjs',
);

export function clockOffsetNodeOptions(): string {
  return `--import=${pathToFileURL(CLOCK_OFFSET_PRELOAD).href}`;
}
