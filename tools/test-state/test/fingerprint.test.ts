import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { computeFingerprint } from '../src/fingerprint.js';
import { NODE_LOADS, FAUCET_LOADS } from '../src/dist-freshness.js';

const T0 = 1_700_000_000;
const SRC_MTIME = T0;
const DIST_MTIME = T0 + 10;

type Overrides = Record<string, string>;

function write(root: string, path: string, content: string, mtime: number): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  utimesSync(full, mtime, mtime);
}

// A minimal repo with every input the fingerprint reads, plus noise outside
// the input list. Overrides replace contents at a given repo-relative path.
function populate(root: string, overrides: Overrides = {}): void {
  const files: Array<[string, string, number]> = [];
  const members = [...new Set([...NODE_LOADS, ...FAUCET_LOADS])];

  for (const m of members) {
    files.push([`${m}/src/index.ts`, `// ${m} src`, SRC_MTIME]);
    files.push([`${m}/dist/index.js`, `// ${m} dist`, DIST_MTIME]);
  }
  // A second runtime file under one member's dist/, to cover multi-file dist.
  files.push(['packages/types/dist/helper.mjs', '// types helper', DIST_MTIME]);

  // The test-state member's own source.
  files.push(['tools/test-state/src/index.ts', '// barrel', SRC_MTIME]);
  files.push(['tools/test-state/src/dist-freshness.ts', '// freshness', SRC_MTIME]);
  files.push(['tools/test-state/src/clock-offset-preload.mjs', '// preload', SRC_MTIME]);

  // The generator scripts.
  files.push(['packages/web/scripts/promote.mjs', '// promote', SRC_MTIME]);
  files.push([
    'packages/web/scripts/extension-check/claim-name.mjs',
    '// claim-name',
    SRC_MTIME,
  ]);
  files.push(['packages/node/scripts/gen-miner-key.mjs', '// gen-miner-key', SRC_MTIME]);

  // The lockfile.
  files.push(['pnpm-lock.yaml', '# lockfile', SRC_MTIME]);

  // Noise outside the input list.
  files.push(['packages/web/src/foo.ts', '// web src', SRC_MTIME]);
  files.push(['contracts/FOO.md', '# contracts', SRC_MTIME]);
  files.push(['tools/e2e/src/foo.ts', '// e2e src', SRC_MTIME]);

  for (const [path, content, mtime] of files) {
    const override = overrides[path];
    write(root, path, override ?? content, mtime);
  }
  for (const [path, content] of Object.entries(overrides)) {
    if (files.some(([p]) => p === path)) continue;
    // A path not in the default set — write it as noise under its own mtime.
    write(root, path, content, SRC_MTIME);
  }
}

describe('fingerprint', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-fp-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-fp-b-'));
  });

  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('is equal across two copies of one tree at two paths', () => {
    populate(rootA);
    populate(rootB);
    expect(computeFingerprint(rootA)).toBe(computeFingerprint(rootB));
  });

  for (const [label, path] of [
    ['a dist/*.js byte', 'packages/wire/dist/index.js'],
    ['a src/ byte of this member', 'tools/test-state/src/index.ts'],
    ['a generator script byte', 'packages/web/scripts/promote.mjs'],
    ['a pnpm-lock.yaml byte', 'pnpm-lock.yaml'],
  ] as const) {
    it(`moves the digest on ${label} changing`, () => {
      populate(rootA);
      populate(rootB, { [path]: '// changed' });
      expect(computeFingerprint(rootA)).not.toBe(computeFingerprint(rootB));
    });
  }

  for (const [label, path] of [
    ['a packages/web/src byte', 'packages/web/src/foo.ts'],
    ['a contracts/ byte', 'contracts/FOO.md'],
    ['a tools/e2e/src byte', 'tools/e2e/src/foo.ts'],
  ] as const) {
    it(`holds the digest when ${label} changes`, () => {
      populate(rootA);
      populate(rootB, { [path]: '// changed' });
      expect(computeFingerprint(rootA)).toBe(computeFingerprint(rootB));
    });
  }

  it('refuses a stale dist of a member on the lists', () => {
    populate(rootA);
    // Make one member's src/ newer than its dist/index.js.
    write(rootA, 'packages/wire/src/index.ts', '// newer', DIST_MTIME + 100);
    expect(() => computeFingerprint(rootA)).toThrow(/Stale dist/);
  });
});
