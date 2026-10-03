import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// The proof-route bench (NODE_INTERFACE → AVL+ State Root), run on its own:
// `pnpm --filter @dagsocial/node exec vitest run -c vitest.bench.config.ts`.
// A million-leaf tree lives in one worker's heap and the memory numbers come
// from that worker's own `process.memoryUsage()`, so the suite's parallelism
// is off, the heap limit is raised and `--expose-gc` is exposed. The reporter
// does not intercept console output, so the tables print as the test writes
// them. The suite neither runs nor counts this: `vitest.config.ts` adds
// `bench/**` to its `exclude`.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['bench/**/*.test.ts'],
      testTimeout: 0,
      hookTimeout: 0,
      disableConsoleIntercept: true,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
          execArgv: ['--expose-gc', '--max-old-space-size=24576'],
        },
      },
      env: {
        NETWORK_TYPE: 'devnet',
        // The bench reads these to size its run. The defaults are the real
        // run's numbers; a sanity-sized sub-run sets `BENCH_*` on the env
        // before `vitest`.
        BENCH_SEED_LEAVES: process.env['BENCH_SEED_LEAVES'] ?? '',
        BENCH_LARGE_OWNER_BOXES: process.env['BENCH_LARGE_OWNER_BOXES'] ?? '',
        BENCH_BLOCK_COUNT: process.env['BENCH_BLOCK_COUNT'] ?? '',
        BENCH_BLOCK_SENDS: process.env['BENCH_BLOCK_SENDS'] ?? '',
        BENCH_SMALL_SENDS: process.env['BENCH_SMALL_SENDS'] ?? '',
      },
    },
  }),
);
