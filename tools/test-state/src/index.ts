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

// TEST_STATE_INTERFACE → The clock offset. The barrel lives in src/ at test
// time (vitest's alias) and in dist/ at runtime (the package's main); the
// build copies the preload next to dist/index.js, so this resolve finds the
// file in both.
export const CLOCK_OFFSET_PRELOAD: string = resolve(
  import.meta.dirname,
  'clock-offset-preload.mjs',
);

export function clockOffsetNodeOptions(): string {
  return `--import=${pathToFileURL(CLOCK_OFFSET_PRELOAD).href}`;
}
