import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  cacheRootDir,
  copyOutState,
  readState,
  writeState,
  type Manifest,
} from '../src/cache.js';

const FINGERPRINT = '0'.repeat(64);
const NAME = 'base';

function makeSourceState(root: string, manifest: Manifest, extraFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'state-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe('cacheRootDir', () => {
  it('honours XDG_CACHE_HOME', () => {
    expect(cacheRootDir({ XDG_CACHE_HOME: '/opt/xdg' })).toBe(
      join('/opt/xdg', 'dagsocial', 'test-state'),
    );
  });

  it('falls back to ~/.cache without the variable', () => {
    expect(cacheRootDir({})).toBe(join(homedir(), '.cache', 'dagsocial', 'test-state'));
  });
});

describe('cache', () => {
  let tmp: string;
  let cacheRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-cache-'));
    // Every case points the cache at a temporary directory.
    cacheRoot = join(tmp, 'cache');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a state whole and reads it back', () => {
    const manifest: Manifest = { name: NAME, fingerprint: FINGERPRINT, tip: 60 };
    const source = makeSourceState(tmp, manifest, { 'store.db': 'the store' });
    writeState(cacheRoot, FINGERPRINT, NAME, source);

    const read = readState(cacheRoot, FINGERPRINT, NAME);
    expect(read).not.toBeNull();
    expect(read!.manifest).toEqual(manifest);
    expect(readFileSync(join(read!.dir, 'store.db'), 'utf8')).toBe('the store');
  });

  it('leaves one state and no temporary directory when two writers race', () => {
    const mA: Manifest = { name: NAME, fingerprint: FINGERPRINT, by: 'A' };
    const mB: Manifest = { name: NAME, fingerprint: FINGERPRINT, by: 'B' };
    const srcA = makeSourceState(tmp, mA, { 'who.txt': 'A' });
    const srcB = makeSourceState(tmp, mB, { 'who.txt': 'B' });

    writeState(cacheRoot, FINGERPRINT, NAME, srcA);
    // The second writer finds the final directory already present; its tmp
    // dir is removed and the winner's state is read.
    writeState(cacheRoot, FINGERPRINT, NAME, srcB);

    const fingerprintDir = join(cacheRoot, FINGERPRINT);
    expect(readdirSync(fingerprintDir)).toEqual([NAME]);
    const read = readState(cacheRoot, FINGERPRINT, NAME);
    expect(read).not.toBeNull();
    // The winner is A — its content is what lives in the cache.
    expect(readFileSync(join(read!.dir, 'who.txt'), 'utf8')).toBe('A');
  });

  it('reports no state when the manifest is missing', () => {
    const dir = join(cacheRoot, FINGERPRINT, NAME);
    mkdirSync(dir, { recursive: true });
    expect(readState(cacheRoot, FINGERPRINT, NAME)).toBeNull();
  });

  it('reports no state when the manifest is unparsable', () => {
    const dir = join(cacheRoot, FINGERPRINT, NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{not-json');
    expect(readState(cacheRoot, FINGERPRINT, NAME)).toBeNull();
  });

  it('a rename error that is not ENOTEMPTY or EEXIST propagates', () => {
    // The target path is a regular file, so rename(dir, file) throws
    // ENOTDIR — writeState must not swallow it.
    mkdirSync(join(cacheRoot, FINGERPRINT), { recursive: true });
    writeFileSync(join(cacheRoot, FINGERPRINT, NAME), 'not a directory');
    const source = makeSourceState(tmp, { name: NAME, fingerprint: FINGERPRINT }, {});
    expect(() => writeState(cacheRoot, FINGERPRINT, NAME, source)).toThrow(/ENOTDIR/);
  });

  it('throws naming the final directory when it holds no readable manifest', () => {
    // A directory already exists at the final path, non-empty but with no
    // manifest.json. writeState loses the rename and reads no state back;
    // the error names the directory.
    const final = join(cacheRoot, FINGERPRINT, NAME);
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, 'noise.txt'), 'x');
    const source = makeSourceState(tmp, { name: NAME, fingerprint: FINGERPRINT }, {});
    expect(() => writeState(cacheRoot, FINGERPRINT, NAME, source)).toThrow(
      new RegExp(final.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('copies a state out into a run directory', () => {
    const manifest: Manifest = { name: NAME, fingerprint: FINGERPRINT };
    const source = makeSourceState(tmp, manifest, { 'store.db': 'the store' });
    writeState(cacheRoot, FINGERPRINT, NAME, source);

    const runDir = join(tmp, 'run');
    copyOutState(cacheRoot, FINGERPRINT, NAME, runDir);
    expect(readFileSync(join(runDir, 'manifest.json'), 'utf8')).toBe(JSON.stringify(manifest));
    expect(readFileSync(join(runDir, 'store.db'), 'utf8')).toBe('the store');
  });
});
