// TEST_STATE_INTERFACE → The cache.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The manifest read from disk. The fields a state records live in the file
// the generator writes; this read answers whatever the generator wrote
// alongside `name` and `fingerprint`.
export interface Manifest {
  readonly name: string;
  readonly fingerprint: string;
  readonly [k: string]: unknown;
}

export interface CachedState {
  readonly manifest: Manifest;
  readonly dir: string;
}

// `$XDG_CACHE_HOME/dagsocial/test-state/`, or `~/.cache/dagsocial/test-state/`
// when the variable is unset. A caller passes `process.env`.
export function cacheRootDir(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'dagsocial', 'test-state');
}

// A read finds a state by its fingerprint and name and parses its manifest.
// A missing directory or an unparsable manifest is no state.
export function readState(
  cacheRoot: string,
  fingerprint: string,
  name: string,
): CachedState | null {
  const dir = join(cacheRoot, fingerprint, name);
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return null;
  const manifestPath = join(dir, 'manifest.json');
  let bytes: string;
  try {
    bytes = readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(bytes) as Manifest;
  } catch {
    return null;
  }
  return { manifest, dir };
}

// Copies the source into a temporary directory beside the final location and
// renames it into place. A rename that lands on an existing non-empty
// directory refuses (rename(2) ENOTEMPTY, or EEXIST on some platforms) — a
// second writer that loses the race removes its own copy and reads the
// winner's. Any other rename error propagates.
export function writeState(
  cacheRoot: string,
  fingerprint: string,
  name: string,
  sourceDir: string,
): CachedState {
  const fingerprintDir = join(cacheRoot, fingerprint);
  mkdirSync(fingerprintDir, { recursive: true });
  const tmpDir = mkdtempSync(join(fingerprintDir, `.tmp-${name}-`));
  cpSync(sourceDir, tmpDir, { recursive: true });
  const final = join(fingerprintDir, name);
  try {
    renameSync(tmpDir, final);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
  const state = readState(cacheRoot, fingerprint, name);
  if (!state) {
    throw new Error(`${final} is not a readable state`);
  }
  return state;
}

// A copy-out writes the state into a run directory. The cache is read-only
// from a run's point of view.
export function copyOutState(
  cacheRoot: string,
  fingerprint: string,
  name: string,
  destDir: string,
): CachedState {
  const state = readState(cacheRoot, fingerprint, name);
  if (!state) {
    throw new Error(`no cached state: ${fingerprint}/${name}`);
  }
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(state.dir)) {
    cpSync(join(state.dir, entry), join(destDir, entry), { recursive: true });
  }
  return state;
}
