import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// The shadow replay of a stored chain (NODE_INTERFACE → AVL+ State Root), run on
// its own: `SHADOW_STORE=<store> pnpm --filter @dagsocial/node exec vitest run
// -c vitest.shadow.config.ts`. Testnet's profile, since the store is testnet's
// chain; no timeout, since a replay to the tip takes minutes; the run's lines
// printed as they are, without the reporter's per-line headers.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['shadow/**/*.test.ts'],
      testTimeout: 0,
      hookTimeout: 0,
      disableConsoleIntercept: true,
      env: {
        NETWORK_TYPE: 'testnet',
      },
    },
  }),
);
