import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.ts';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      fileParallelism: false,
      passWithNoTests: true,
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);
