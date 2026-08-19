import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      // Block-application suites mine real PoW solutions (the powTargetBits
      // schedule is enforced at apply, so fixtures cannot fake it) and are
      // compute-bound by design. Under a full-repo parallel run the 5s
      // default flakes on whichever heavy test lands on a contended core —
      // observed on journal-roundtrip and like-settlement — so the ceiling
      // reflects the workload instead of per-test annotations chasing it.
      testTimeout: 60_000,
      env: {
        POW_SLOT_TARGET_BITS: '4',
        // The suite mines real PoW at `expectedTarget()`, which reads the
        // process config singleton — a `Config` a test injects cannot reach
        // it. Devnet is the profile whose ordering-block target stays
        // trivially solvable, so the suite runs there and the testnet target
        // is free to carry a real difficulty.
        // TYPES_INTERFACE → Network profiles.
        NETWORK_TYPE: 'devnet',
      },
    },
  }),
);
