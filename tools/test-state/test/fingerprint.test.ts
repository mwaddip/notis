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
import { computeFingerprint, fingerprintInputs } from '../src/fingerprint.js';
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

function writeBytes(root: string, path: string, content: Buffer, mtime: number): void {
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
    ['a promote.mjs byte', 'packages/web/scripts/promote.mjs'],
    ['a claim-name.mjs byte', 'packages/web/scripts/extension-check/claim-name.mjs'],
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

  it('leaves the digest unmoved when a .d.ts lands under dist/', () => {
    populate(rootA);
    populate(rootB, { 'packages/wire/dist/index.d.ts': '// declaration' });
    expect(computeFingerprint(rootA)).toBe(computeFingerprint(rootB));
  });

  it('leaves the digest unmoved when a .js.map lands under dist/', () => {
    populate(rootA);
    populate(rootB, { 'packages/wire/dist/index.js.map': '{"version":3}' });
    expect(computeFingerprint(rootA)).toBe(computeFingerprint(rootB));
  });

  it('lists per-member dist entries in code-unit order', () => {
    populate(rootA);
    const member = 'packages/wire';
    for (const n of ['zzz.js', 'aaa.js', 'mmm.js', 'ccc.js']) {
      write(rootA, `${member}/dist/${n}`, 'x', DIST_MTIME);
    }
    const paths = fingerprintInputs(rootA).map((i) => i.path);
    const memberDist = paths.filter((p) => p.startsWith(`${member}/dist/`));
    expect(memberDist).toEqual([...memberDist].sort());
  });

  it("lists this member's src entries in code-unit order", () => {
    populate(rootA);
    const base = 'tools/test-state/src';
    for (const n of ['zzz.ts', 'aaa.ts', 'mmm.ts', 'ccc.ts']) {
      write(rootA, `${base}/${n}`, 'x', SRC_MTIME);
    }
    const paths = fingerprintInputs(rootA).map((i) => i.path);
    const selfSrc = paths.filter((p) => p.startsWith(`${base}/`));
    expect(selfSrc).toEqual([...selfSrc].sort());
  });

  it('the content-length prefix prevents a boundary collision between neighbouring files', () => {
    // Tree A holds two extra dist files beside the default index.js; tree
    // B holds one whose bytes, without a content-length prefix, would
    // stream the same as A's two. The current digest reads a 4-byte path
    // length and an 8-byte content length, so the two trees differ.
    populate(rootA);
    populate(rootB);

    const dir = 'packages/wire/dist';
    const pathA = `${dir}/a.js`;
    const pathB = `${dir}/b.js`;
    const contentA = Buffer.from('r');
    const contentB = Buffer.from('s');

    writeBytes(rootA, pathA, contentA, DIST_MTIME);
    writeBytes(rootA, pathB, contentB, DIST_MTIME);

    // B's one file at a.js carries A's first content followed by the
    // bytes the digest would read for the second file under a shape with
    // a path length but no content length: pathLenB, pathB, contentB.
    const pathBufB = Buffer.from(pathB, 'utf8');
    const pathLenBBuf = Buffer.alloc(4);
    pathLenBBuf.writeUInt32BE(pathBufB.length, 0);
    const bContent = Buffer.concat([contentA, pathLenBBuf, pathBufB, contentB]);
    writeBytes(rootB, pathA, bContent, DIST_MTIME);

    expect(computeFingerprint(rootA)).not.toBe(computeFingerprint(rootB));
  });

  it('refuses a stale dist of a member on the lists', () => {
    populate(rootA);
    // Make one member's src/ newer than its dist/index.js.
    write(rootA, 'packages/wire/src/index.ts', '// newer', DIST_MTIME + 100);
    expect(() => computeFingerprint(rootA)).toThrow(/Stale dist/);
  });
});
