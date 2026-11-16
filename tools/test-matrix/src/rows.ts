// TEST_MATRIX_INTERFACE → The rows: the contract's table, as data. Each
// entry names the reader, what it reads (a member's name, or a repo-root
// path, or a directory path ending in '/'), the how, and the kind. A
// by-no-run row's reader is the file that holds the name, and it covers
// that file's names alone (TEST_MATRIX_INTERFACE → The rows → "by no
// run").
import type { Row } from './types.ts';

export const ROWS: readonly Row[] = [
  // TEST_MATRIX_INTERFACE → The rows table.
  {
    reader: 'e2e',
    reads: 'node',
    how: 'spawns packages/node/dist/index.js for each node of its mesh',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'node',
    how: 'spawns packages/node/dist/index.js and tools/faucet/dist/index.js for a stack',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'faucet',
    how: 'spawns packages/node/dist/index.js and tools/faucet/dist/index.js for a stack',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'wire',
    how: 'up fingerprints the dist of every member node and the faucet load',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'node-reads',
    how: 'up fingerprints the dist of every member node and the faucet load',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'avltree',
    how: 'up fingerprints the dist of every member node and the faucet load',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'nipopow',
    how: 'up fingerprints the dist of every member node and the faucet load',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'consensus',
    how: 'up fingerprints the dist of every member node and the faucet load',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'packages/web/scripts/promote.mjs',
    how: "runs promote.mjs in a generation — its suite's up of the minimal state among them — which bundles promote/entry.ts",
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'packages/web/scripts/promote/',
    how: "runs promote.mjs in a generation — its suite's up of the minimal state among them — which bundles promote/entry.ts",
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'e2e',
    how: "promote.mjs's bundle runs tools/e2e/src/'s identity and transaction builders",
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'packages/web/scripts/extension-check/claim-name.mjs',
    how: 'up fingerprints its bytes; the state its suite generates makes no claim, so the suite never runs it',
    kind: 'in a suite',
  },
  {
    reader: 'test-state',
    reads: 'nipopow-client',
    how: "test/dist-freshness.test.ts holds the list e2e's runs check to nipopow-client's dependency closure, read from the package.json files",
    kind: 'in a suite',
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
    how: "spawns packages/node/dist/index.js beside each block's stack, and runs packages/node/scripts/miner.mjs",
    kind: 'run time',
  },
  {
    reader: 'check',
    reads: 'test-state',
    how: "brings up each block's stack through its loader — node, faucet and miner",
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
    how: "its harness, and claim-name.mjs, which base's generation runs and which bundles web's src/ when it runs",
    kind: 'run time',
  },

  // Beyond the contract table: the scan's rows.

  // test-state's test/fingerprint.test.ts writes fixture names into a
  // directory of its own.
  {
    reader: 'tools/test-state/test/fingerprint.test.ts',
    reads: 'web',
    how: 'writes packages/web/src/foo.ts as a fixture, and labels packages/web/src',
    kind: 'by no run',
  },
  {
    reader: 'tools/test-state/test/fingerprint.test.ts',
    reads: 'contracts/',
    how: 'writes contracts/FOO.md as a fixture, and labels contracts/',
    kind: 'by no run',
  },

  // mesh-poc's stage files spawn node's dist and miner.mjs, and tests
  // assert the spawn line's text. The stage runs by hand as root, and
  // these test assertions compare strings; no matrix-answered run reads
  // node through these names.
  {
    reader: 'tools/mesh-poc/stage/run.mjs',
    reads: 'node',
    how: 'spawns node through its dist',
    kind: 'by no run',
  },
  {
    reader: 'tools/mesh-poc/stage/up.mjs',
    reads: 'node',
    how: 'spawns node through its dist',
    kind: 'by no run',
  },
  {
    reader: 'tools/mesh-poc/stage/scenarios/s5-impersonation.mjs',
    reads: 'node',
    how: 'names an absolute path to packages/node/dist/index.js',
    kind: 'by no run',
  },
  {
    reader: 'tools/mesh-poc/test/hostile-fork-single.test.ts',
    reads: 'node',
    how: 'passes /repo/packages/node/scripts/miner.mjs to a fake',
    kind: 'by no run',
  },
  {
    reader: 'tools/mesh-poc/test/scenarios.test.ts',
    reads: 'node',
    how: 'asserts a spawn line contains packages/node/dist/index.js',
    kind: 'by no run',
  },

  // web's docs-screens entry re-exports tools/e2e/src for vite to bundle;
  // the bundle is run by hand (a docs capture), not by any matrix-answered
  // run.
  {
    reader: 'packages/web/scripts/docs-screens/entry.ts',
    reads: 'e2e',
    how: 're-exports tools/e2e/src/{identities,tx/*}.ts for the screens bundle, run by hand',
    kind: 'by no run',
  },
];
