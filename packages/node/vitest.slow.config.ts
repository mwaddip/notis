import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// The deepest cases of fork resolution — paged scoring walks against
// hundreds of built headers — run on their own: `pnpm --filter
// @dagsocial/node test:slow`. One file per case so vitest runs them in
// parallel; the env and timeout match the default node suite's. The
// default suite neither runs nor counts this: `vitest.config.ts` adds
// `slow/**` to its `exclude`.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      include: ['slow/**/*.test.ts'],
      testTimeout: 60_000,
      env: {
        // Mines real PoW at `scheduledTargetBits` (MINING_INTERFACE →
        // Difficulty Schedule). Devnet is the profile whose ordering-block
        // target stays trivially solvable (TYPES_INTERFACE → Network profiles).
        NETWORK_TYPE: 'devnet',
      },
    },
  }),
);
