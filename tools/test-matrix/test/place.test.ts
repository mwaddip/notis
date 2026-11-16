// TEST_MATRIX_INTERFACE → How a path is placed, → Reach, → The rows, → The
// output: a case per rule and each kind of row. Each case asserts the rule
// that placed each of its paths and the sorted list of selected runs
// (TEST_MATRIX_INTERFACE → Tests → "Each rule is held by a case").
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { place } from '../src/place.ts';
import { ROWS } from '../src/rows.ts';
import type { TreeReader } from '../src/types.ts';
import { diskReader, readWorkspace } from '../src/workspace.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const workspace = readWorkspace(diskReader(ROOT));

const EVERY_RUN: readonly string[] = [
  'avltree',
  'check',
  'consensus',
  'e2e',
  'faucet',
  'mesh-poc',
  'net',
  'nipopow',
  'nipopow-client',
  'node',
  'node-reads',
  'node:slow',
  'test-matrix',
  'test-state',
  'types',
  'validation',
  'web',
  'wire',
];

const TYPES_REACH_WITHOUT_MATRIX: readonly string[] = [
  'check',
  'consensus',
  'e2e',
  'faucet',
  'mesh-poc',
  'net',
  'nipopow',
  'nipopow-client',
  'node',
  'node-reads',
  'node:slow',
  'test-state',
  'types',
  'validation',
  'web',
];

const TYPES_REACH: readonly string[] = [
  ...TYPES_REACH_WITHOUT_MATRIX,
  'test-matrix',
].sort();

const WIRE_REACH: readonly string[] = [...TYPES_REACH, 'wire'].sort();

describe('every run', () => {
  for (const p of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'tsconfig.base.json',
    'vitest.shared.ts',
    'patches/libp2p@3.5.1.patch',
    '.github/workflows/ci.yml',
  ]) {
    it(`${p} selects every run`, () => {
      const result = place([p], workspace, ROWS);
      const e = result.selected.find((s) => s.path === p);
      expect(e?.rule).toEqual('every run');
      expect(
        result.selected.map((s) => s.run).sort(),
      ).toEqual(EVERY_RUN);
    });
  }
});

describe('no run', () => {
  for (const p of [
    'contracts/NODE_INTERFACE.md',
    'docs/specs/some-doc.md',
    'packages/web/CLAUDE.md',
    'README.md',
    'scripts/build-deb.sh',
  ]) {
    it(`${p} selects no run`, () => {
      const result = place([p], workspace, ROWS);
      const u = result.unplaced.find((x) => x.path === p);
      expect(u?.rule).toEqual('no run');
      expect(
        result.selected.map((s) => s.run).sort(),
      ).toEqual([]);
    });
  }
});

describe('a row read in a suite adds the reader alone', () => {
  it('contracts/CONSTANTS.md selects node', () => {
    const p = 'contracts/CONSTANTS.md';
    const result = place([p], workspace, ROWS);
    const u = result.unplaced.find((x) => x.path === p);
    expect(u?.rule).toEqual('no run');
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('row in a suite');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node']);
  });

  it('refuse-node-builtins.mjs selects web, check, mesh-poc, net and test-matrix', () => {
    const p = 'packages/web/scripts/refuse-node-builtins.mjs';
    const result = place([p], workspace, ROWS);
    const web = result.selected.find((s) => s.run === 'web');
    expect(web?.rule).toEqual('reach');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'mesh-poc', 'net', 'test-matrix', 'web']);
  });
});

describe('rule order', () => {
  it('.github/x.md selects every run — the every-run rule before the .md rule', () => {
    const p = '.github/x.md';
    const result = place([p], workspace, ROWS);
    const e = result.selected.find((s) => s.path === p);
    expect(e?.rule).toEqual('every run');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(EVERY_RUN);
  });

  it('packages/node/test/notes.md selects no run — the .md rule before the test-tree rule', () => {
    const p = 'packages/node/test/notes.md';
    const result = place([p], workspace, ROWS);
    const u = result.unplaced.find((x) => x.path === p);
    expect(u?.rule).toEqual('no run');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual([]);
  });
});

describe("the check's harness", () => {
  it('extension-check/run.mjs selects check and test-matrix', () => {
    const p = 'packages/web/scripts/extension-check/run.mjs';
    const result = place([p], workspace, ROWS);
    const check = result.selected.find((s) => s.run === 'check');
    expect(check?.rule).toEqual('row at run time');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'test-matrix']);
  });

  it.fails('extension-check/claim-name.mjs selects check, test-matrix and test-state', () => {
    const p = 'packages/web/scripts/extension-check/claim-name.mjs';
    const result = place([p], workspace, ROWS);
    const check = result.selected.find((s) => s.run === 'check');
    expect(check?.rule).toEqual('row at run time');
    const ts = result.selected.find((s) => s.run === 'test-state');
    expect(ts?.rule).toEqual('row in a suite');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'test-matrix', 'test-state']);
  });
});

describe('a member test tree', () => {
  it('packages/node/test/x.ts selects node and test-matrix', () => {
    const p = 'packages/node/test/x.ts';
    const result = place([p], workspace, ROWS);
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('test/');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node', 'test-matrix']);
  });

  it('packages/node/slow/x.ts selects node, node:slow and test-matrix', () => {
    const p = 'packages/node/slow/x.ts';
    const result = place([p], workspace, ROWS);
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('slow/');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node', 'node:slow', 'test-matrix']);
  });

  it('packages/node/shadow/x.ts selects node and test-matrix', () => {
    const p = 'packages/node/shadow/x.ts';
    const result = place([p], workspace, ROWS);
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('shadow/');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node', 'test-matrix']);
  });

  it('packages/node/bench/x.ts selects node and test-matrix', () => {
    const p = 'packages/node/bench/x.ts';
    const result = place([p], workspace, ROWS);
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('bench/');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node', 'test-matrix']);
  });

  it('packages/web/test/x.ts selects web and test-matrix', () => {
    const p = 'packages/web/test/x.ts';
    const result = place([p], workspace, ROWS);
    const web = result.selected.find((s) => s.run === 'web');
    expect(web?.rule).toEqual('test/');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['test-matrix', 'web']);
  });

  it('tools/e2e/test/x.ts selects e2e and test-matrix', () => {
    const p = 'tools/e2e/test/x.ts';
    const result = place([p], workspace, ROWS);
    const e2e = result.selected.find((s) => s.run === 'e2e');
    expect(e2e?.rule).toEqual('test/');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['e2e', 'test-matrix']);
  });
});

describe('reach', () => {
  it('reach from packages/web/src/x.ts', () => {
    const p = 'packages/web/src/x.ts';
    const result = place([p], workspace, ROWS);
    const web = result.selected.find((s) => s.run === 'web');
    expect(web?.rule).toEqual('reach');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'mesh-poc', 'test-matrix', 'web']);
  });

  it('reach from packages/node/src/x.ts', () => {
    const p = 'packages/node/src/x.ts';
    const result = place([p], workspace, ROWS);
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'node', 'node:slow', 'test-matrix', 'test-state']);
  });

  it('reach from packages/node/scripts/miner.mjs', () => {
    const p = 'packages/node/scripts/miner.mjs';
    const result = place([p], workspace, ROWS);
    const node = result.selected.find((s) => s.run === 'node');
    expect(node?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'node', 'node:slow', 'test-matrix', 'test-state']);
  });

  it('reach from tools/faucet/src/x.ts', () => {
    const p = 'tools/faucet/src/x.ts';
    const result = place([p], workspace, ROWS);
    const faucet = result.selected.find((s) => s.run === 'faucet');
    expect(faucet?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'faucet', 'test-matrix', 'test-state']);
  });

  it.fails('reach from tools/e2e/src/x.ts', () => {
    const p = 'tools/e2e/src/x.ts';
    const result = place([p], workspace, ROWS);
    const e2e = result.selected.find((s) => s.run === 'e2e');
    expect(e2e?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'test-matrix', 'test-state']);
  });

  it.fails('reach from packages/web/scripts/promote/entry.ts, web by its path and test-state by its row', () => {
    const p = 'packages/web/scripts/promote/entry.ts';
    const result = place([p], workspace, ROWS);
    const web = result.selected.find((s) => s.run === 'web');
    expect(web?.rule).toEqual('reach');
    const ts = result.selected.find((s) => s.run === 'test-state');
    expect(ts?.rule).toEqual('row at run time');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'mesh-poc', 'test-matrix', 'test-state', 'web']);
  });

  it.fails('reach from tools/nipopow-client/package.json, test-state via the in-a-suite row', () => {
    const p = 'tools/nipopow-client/package.json';
    const result = place([p], workspace, ROWS);
    const nc = result.selected.find((s) => s.run === 'nipopow-client');
    expect(nc?.rule).toEqual('reach');
    const ts = result.selected.find((s) => s.run === 'test-state');
    expect(ts?.rule).toEqual('row in a suite');
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual([
      'check',
      'e2e',
      'mesh-poc',
      'nipopow-client',
      'test-matrix',
      'test-state',
      'web',
    ]);
  });

  it('reach from tools/test-matrix/src/x.ts', () => {
    const p = 'tools/test-matrix/src/x.ts';
    const result = place([p], workspace, ROWS);
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['test-matrix']);
  });

  it('reach from packages/types/src/x.ts', () => {
    const p = 'packages/types/src/x.ts';
    const result = place([p], workspace, ROWS);
    const types = result.selected.find((s) => s.run === 'types');
    expect(types?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(TYPES_REACH);
  });

  it('reach from packages/wire/src/x.ts', () => {
    const p = 'packages/wire/src/x.ts';
    const result = place([p], workspace, ROWS);
    const wire = result.selected.find((s) => s.run === 'wire');
    expect(wire?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(WIRE_REACH);
  });
});

describe('any other path', () => {
  it('LICENSE selects every run', () => {
    const p = 'LICENSE';
    const result = place([p], workspace, ROWS);
    const e = result.selected.find((s) => s.path === p);
    expect(e?.rule).toEqual('other');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(EVERY_RUN);
  });
});

describe("the first path to select a run names its rule", () => {
  it('web via a test tree, node among the members left out', () => {
    const result = place(
      ['packages/web/test/a.test.ts', 'packages/web/src/b.ts'],
      workspace,
      ROWS,
    );
    const web = result.selected.find((s) => s.run === 'web');
    expect(web).toEqual({
      run: 'web',
      path: 'packages/web/test/a.test.ts',
      rule: 'test/',
    });
    const matrix = result.selected.find((s) => s.run === 'test-matrix');
    expect(matrix?.rule).toEqual('matrix');
    expect(result.membersLeftOut).toContain('node');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'mesh-poc', 'test-matrix', 'web']);
  });
});

function twoMemberFixture(
  bField: 'dependencies' | 'devDependencies' | 'peerDependencies',
): TreeReader {
  return {
    file(path) {
      if (path === 'pnpm-workspace.yaml') {
        return "packages:\n  - 'pkg/*'\n";
      }
      if (path === 'pkg/a/package.json') {
        return JSON.stringify({ name: '@dagsocial/a' });
      }
      if (path === 'pkg/b/package.json') {
        return JSON.stringify({
          name: '@dagsocial/b',
          [bField]: { '@dagsocial/a': 'workspace:*' },
        });
      }
      return null;
    },
    dirs(path) {
      if (path === 'pkg') return ['a', 'b'];
      return [];
    },
  };
}

describe('a member reached by each dependency field', () => {
  it('b declares a in dependencies', () => {
    const ws = readWorkspace(twoMemberFixture('dependencies'));
    expect(ws.members.map((m) => m.name).sort()).toEqual(['a', 'b']);
    const result = place(['pkg/a/src/x.ts'], ws, []);
    const a = result.selected.find((s) => s.run === 'a');
    expect(a?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['a', 'b']);
  });

  it('b declares a in devDependencies', () => {
    const ws = readWorkspace(twoMemberFixture('devDependencies'));
    expect(ws.members.map((m) => m.name).sort()).toEqual(['a', 'b']);
    const result = place(['pkg/a/src/x.ts'], ws, []);
    const a = result.selected.find((s) => s.run === 'a');
    expect(a?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['a', 'b']);
  });

  it('b declares a in peerDependencies', () => {
    const ws = readWorkspace(twoMemberFixture('peerDependencies'));
    expect(ws.members.map((m) => m.name).sort()).toEqual(['a', 'b']);
    const result = place(['pkg/a/src/x.ts'], ws, []);
    const a = result.selected.find((s) => s.run === 'a');
    expect(a?.rule).toEqual('reach');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['a', 'b']);
  });
});
