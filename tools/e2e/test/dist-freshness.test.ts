import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { assertDistFresh, NODE_LOADS, NIPOPOW_CLIENT_LOADS } from '../src/dist-freshness.js';

const REPO_ROOT = realpathSync(resolve(import.meta.dirname, '..', '..', '..'));
const T0 = 1_700_000_000;

function touch(root: string, path: string, mtime: number): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, '');
  utimesSync(full, mtime, mtime);
}

function refusal(members: readonly string[], root: string): string {
  try {
    assertDistFresh(members, root);
  } catch (err) {
    if (err instanceof Error) return err.message;
    throw err;
  }
  return '';
}

// A workspace dependency resolves through the depending package's node_modules link,
// as Node resolves the spawned bundle's import.
function workspaceDeps(member: string): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, member, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, spec]) => spec.startsWith('workspace:'))
    .map(([name]) => relative(REPO_ROOT, realpathSync(join(REPO_ROOT, member, 'node_modules', name))));
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (member: string): void => {
    if (seen.has(member)) return;
    seen.add(member);
    for (const dep of workspaceDeps(member)) visit(dep);
  };
  visit(entry);
  return seen;
}

describe('dist freshness', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-freshness-'));
    // Every file under src/, the nested one too, predates dist/index.js; the directories
    // holding them keep today's mtime.
    for (const m of ['packages/fresh', 'tools/fresh-tool']) {
      touch(root, `${m}/src/index.ts`, T0);
      touch(root, `${m}/src/deep/nested.ts`, T0);
      touch(root, `${m}/dist/index.js`, T0 + 10);
    }
    // Only the nested file postdates dist/index.js.
    for (const m of ['packages/stale', 'tools/stale-tool']) {
      touch(root, `${m}/src/index.ts`, T0);
      touch(root, `${m}/src/deep/nested.ts`, T0 + 20);
      touch(root, `${m}/dist/index.js`, T0 + 10);
    }
    for (const m of ['packages/unbuilt', 'tools/unbuilt-tool']) {
      touch(root, `${m}/src/index.ts`, T0);
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes members whose dist/index.js postdates every file under src/', () => {
    expect(refusal(['packages/fresh', 'tools/fresh-tool'], root)).toBe('');
  });

  it('refuses a stale and a missing dist under packages/ and tools/, naming each with its path', () => {
    const members = [
      'packages/fresh',
      'packages/stale',
      'packages/unbuilt',
      'tools/fresh-tool',
      'tools/stale-tool',
      'tools/unbuilt-tool',
    ];
    expect(refusal(members, root).split('\n')).toEqual([
      'Stale dist — rebuild before running the mesh suite:',
      '  - @dagsocial/stale (packages/stale): src/ newer than dist/index.js',
      '  - @dagsocial/unbuilt (packages/unbuilt): dist/index.js missing',
      '  - @dagsocial/stale-tool (tools/stale-tool): src/ newer than dist/index.js',
      '  - @dagsocial/unbuilt-tool (tools/unbuilt-tool): dist/index.js missing',
      'Run: for p in fresh stale unbuilt fresh-tool stale-tool unbuilt-tool; do pnpm --filter @dagsocial/$p build; done',
    ]);
  });

  for (const [entry, loads] of [
    ['packages/node', NODE_LOADS],
    ['tools/nipopow-client', NIPOPOW_CLIENT_LOADS],
  ] as const) {
    it(`${entry}: the checked list is its workspace dependency closure, in build order`, () => {
      expect(new Set(loads)).toEqual(closure(entry));
      const outOfOrder = loads.flatMap((member, i) =>
        workspaceDeps(member)
          .filter((dep) => loads.indexOf(dep) > i)
          .map((dep) => `${dep} after ${member}`),
      );
      expect(outOfOrder).toEqual([]);
    });
  }
});
