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
    reads: 'packages/web/scripts/promote.mjs',
    how: 'runs both in a generation',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'packages/web/scripts/extension-check/claim-name.mjs',
    how: 'runs both in a generation',
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
    how: 'its harness',
    kind: 'run time',
  },

  // Beyond the contract table: the scan's rows.

  // test-state's fingerprint walks each member's dist/*.{js,mjs} at run
  // time (src/fingerprint.ts over NODE_LOADS and FAUCET_LOADS, listed in
  // src/dist-freshness.ts). The names in dist-freshness.ts are these.
  // net, types and validation are declared and need no row; node and
  // faucet are covered by the contract table.
  {
    reader: 'test-state',
    reads: 'wire',
    how: 'src/dist-freshness.ts names it in NODE_LOADS and FAUCET_LOADS; src/fingerprint.ts walks the dist',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'node-reads',
    how: 'src/dist-freshness.ts names it in NODE_LOADS and FAUCET_LOADS; src/fingerprint.ts walks the dist',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'avltree',
    how: 'src/dist-freshness.ts names it in NODE_LOADS; src/fingerprint.ts walks the dist',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'nipopow',
    how: 'src/dist-freshness.ts names it in NODE_LOADS; src/fingerprint.ts walks the dist',
    kind: 'run time',
  },
  {
    reader: 'test-state',
    reads: 'consensus',
    how: 'src/dist-freshness.ts names it in NODE_LOADS; src/fingerprint.ts walks the dist',
    kind: 'run time',
  },

  // dist-freshness.ts also names tools/nipopow-client in
  // NIPOPOW_CLIENT_LOADS, a list e2e passes to assertDistFresh —
  // test-state's own runs never read it.
  {
    reader: 'tools/test-state/src/dist-freshness.ts',
    reads: 'nipopow-client',
    how: 'names tools/nipopow-client in NIPOPOW_CLIENT_LOADS',
    kind: 'by no run',
  },
  {
    reader: 'tools/test-state/test/dist-freshness.test.ts',
    reads: 'nipopow-client',
    how: 'names tools/nipopow-client as a workspace entry whose dist-freshness list is checked',
    kind: 'by no run',
  },

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
    reads: 'e2e',
    how: 'writes tools/e2e/src/foo.ts as a fixture, and labels tools/e2e/src',
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

  // web's two entry scripts re-export from tools/e2e/src/ for vite to
  // bundle into Node scripts. web's own suite does not read these at run
  // time; test-state spawns the built promote.mjs, so an e2e change
  // reaches the stack through the build, not through these files.
  {
    reader: 'packages/web/scripts/docs-screens/entry.ts',
    reads: 'e2e',
    how: 're-exports tools/e2e/src/{identities,tx/*}.ts for the screens bundle',
    kind: 'by no run',
  },
  {
    reader: 'packages/web/scripts/promote/entry.ts',
    reads: 'e2e',
    how: 're-exports tools/e2e/src/{identities,tx/*}.ts for the promote bundle',
    kind: 'by no run',
  },
];
