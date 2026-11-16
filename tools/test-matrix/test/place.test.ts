// TEST_MATRIX_INTERFACE → How a path is placed, → Reach, → The rows, → The
// output: a case per rule and each kind of row. The last assertion is the
// sorted list of selected runs; a stated earlier assertion is a control.
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

const TYPES_REACH: readonly string[] = [
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

const WIRE_REACH: readonly string[] = [...TYPES_REACH, 'wire'];

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
      expect(result.unplaced).toContainEqual({ path: p, rule: 'no run' });
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
    expect(result.unplaced).toContainEqual({ path: p, rule: 'no run' });
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node']);
  });

  it('refuse-node-builtins.mjs selects web, check, mesh-poc and net', () => {
    const result = place(
      ['packages/web/scripts/refuse-node-builtins.mjs'],
      workspace,
      ROWS,
    );
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'mesh-poc', 'net', 'web']);
  });
});

describe('rule order', () => {
  it('.github/x.md selects every run — the every-run rule before the .md rule', () => {
    const result = place(['.github/x.md'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(EVERY_RUN);
  });

  it('packages/node/test/notes.md selects no run — the .md rule before the test-tree rule', () => {
    const p = 'packages/node/test/notes.md';
    const result = place([p], workspace, ROWS);
    expect(result.unplaced).toContainEqual({ path: p, rule: 'no run' });
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual([]);
  });
});

describe("the check's harness", () => {
  it('extension-check/run.mjs selects check', () => {
    const result = place(
      ['packages/web/scripts/extension-check/run.mjs'],
      workspace,
      ROWS,
    );
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check']);
  });

  it('extension-check/claim-name.mjs selects check, e2e and test-state', () => {
    const result = place(
      ['packages/web/scripts/extension-check/claim-name.mjs'],
      workspace,
      ROWS,
    );
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'test-state']);
  });
});

describe('a member test tree', () => {
  it('packages/node/test/x.ts selects node', () => {
    const result = place(['packages/node/test/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node']);
  });

  it('packages/node/slow/x.ts selects node and node:slow', () => {
    const result = place(['packages/node/slow/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node', 'node:slow']);
  });

  it('packages/node/shadow/x.ts selects node', () => {
    const result = place(['packages/node/shadow/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node']);
  });

  it('packages/node/bench/x.ts selects node', () => {
    const result = place(['packages/node/bench/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['node']);
  });

  it('packages/web/test/x.ts selects web', () => {
    const result = place(['packages/web/test/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['web']);
  });

  it('tools/e2e/test/x.ts selects e2e', () => {
    const result = place(['tools/e2e/test/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['e2e']);
  });
});

describe('reach', () => {
  it('reach from packages/web/src/x.ts', () => {
    const result = place(['packages/web/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'mesh-poc', 'web']);
  });

  it('reach from packages/node/src/x.ts', () => {
    const result = place(['packages/node/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'node', 'node:slow', 'test-state']);
  });

  it('reach from packages/node/scripts/miner.mjs', () => {
    const result = place(['packages/node/scripts/miner.mjs'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'node', 'node:slow', 'test-state']);
  });

  it('reach from tools/faucet/src/x.ts', () => {
    const result = place(['tools/faucet/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'e2e', 'faucet', 'test-state']);
  });

  it('reach from tools/e2e/src/x.ts', () => {
    const result = place(['tools/e2e/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['e2e']);
  });

  it('reach from tools/test-matrix/src/x.ts', () => {
    const result = place(['tools/test-matrix/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['test-matrix']);
  });

  it('reach from packages/types/src/x.ts', () => {
    const result = place(['packages/types/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(TYPES_REACH);
  });

  it('reach from packages/wire/src/x.ts', () => {
    const result = place(['packages/wire/src/x.ts'], workspace, ROWS);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(WIRE_REACH);
  });
});

describe('any other path', () => {
  it('LICENSE selects every run', () => {
    const result = place(['LICENSE'], workspace, ROWS);
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
    expect(result.membersLeftOut).toContain('node');
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['check', 'mesh-poc', 'web']);
  });
});

describe('a member reached by the workspace alone', () => {
  it('a/src/x.ts selects a and b, with b declaring a', () => {
    const fixture: TreeReader = {
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
            dependencies: { '@dagsocial/a': 'workspace:*' },
          });
        }
        return null;
      },
      dirs(path) {
        if (path === 'pkg') return ['a', 'b'];
        return [];
      },
    };
    const ws = readWorkspace(fixture);
    expect(ws.members.map((m) => m.name).sort()).toEqual(['a', 'b']);
    const result = place(['pkg/a/src/x.ts'], ws, []);
    expect(
      result.selected.map((s) => s.run).sort(),
    ).toEqual(['a', 'b']);
  });
});
