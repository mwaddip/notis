// TEST_MATRIX_INTERFACE → The rows: the contract's table, as data. Each
// entry names the reader, what it reads (a member's name, or a repo-root
// path, or a directory path ending in '/'), the how, and the kind.
import type { Row } from './types.ts';

export const ROWS: readonly Row[] = [
  {
    reader: 'e2e',
    reads: 'node',
    how: 'spawns packages/node/dist/index.js for each node of its mesh',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'node',
    how: 'spawns packages/node/dist/index.js for a stack',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'faucet',
    how: 'spawns tools/faucet/dist/index.js for a stack',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'packages/web/scripts/promote.mjs',
    how: 'runs it in a generation',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'packages/web/scripts/extension-check/claim-name.mjs',
    how: 'runs it in a generation',
    kind: 'run time',
  },
  {
    reader: 'net',
    reads: 'packages/web/scripts/refuse-node-builtins.mjs',
    how: 'test/browser-entry.test.ts imports it',
    kind: 'in a suite',
  },
  {
    reader: 'node',
    reads: 'contracts/CONSTANTS.md',
    how: 'test/constants-register.test.ts makes a case of each row',
    kind: 'in a suite',
  },
  {
    reader: 'check',
    reads: 'node',
    how: 'runs its built code',
    kind: 'run time',
  },
  {
    reader: 'check',
    reads: 'faucet',
    how: 'runs its built code',
    kind: 'run time',
  },
  {
    reader: 'check',
    reads: 'test-state',
    how: 'runs its built code',
    kind: 'run time',
  },
  {
    reader: 'check',
    reads: 'packages/node/scripts/miner.mjs',
    how: 'runs the miner',
    kind: 'run time',
  },
  {
    reader: 'check',
    reads: 'web',
    how: 'builds its hosted page and its extension',
    kind: 'run time',
  },
  {
    reader: 'check',
    reads: 'packages/web/scripts/extension-check/',
    how: 'its harness',
    kind: 'run time',
  },
];
