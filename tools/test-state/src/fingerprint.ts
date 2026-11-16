// TEST_STATE_INTERFACE → The fingerprint.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { assertDistFresh, FAUCET_LOADS, NODE_LOADS } from './dist-freshness.js';

// The generator's scripts, "without the client code those scripts bundle".
const GENERATOR_SCRIPTS: readonly string[] = [
  'packages/web/scripts/promote.mjs',
  'packages/web/scripts/extension-check/claim-name.mjs',
  'packages/node/scripts/gen-miner-key.mjs',
];

const TEST_STATE_SRC = 'tools/test-state/src';
const LOCKFILE = 'pnpm-lock.yaml';

export interface FingerprintInput {
  readonly path: string;
}

function toRepoRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

function walk(absDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(absDir);
  return out;
}

function distRuntimeFiles(root: string, member: string): string[] {
  const dist = join(root, member, 'dist');
  const st = statSync(dist, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return [];
  return walk(dist).filter((p) => p.endsWith('.js') || p.endsWith('.mjs'));
}

export function fingerprintInputs(root: string): readonly FingerprintInput[] {
  // The two lists, deduplicated, in code-unit order by path.
  const members = [...new Set([...NODE_LOADS, ...FAUCET_LOADS])].sort();
  const paths: string[] = [];

  // (1) runtime .js/.mjs under each member's dist/, in code-unit order by path.
  for (const m of members) {
    const files = distRuntimeFiles(root, m).map((abs) => toRepoRel(root, abs));
    files.sort();
    paths.push(...files);
  }

  // (2) this member's own source, in code-unit order by path.
  const selfSrc = walk(join(root, TEST_STATE_SRC))
    .map((abs) => toRepoRel(root, abs))
    .sort();
  paths.push(...selfSrc);

  // (3–5) the generator scripts, in the fixed order declared here.
  paths.push(...GENERATOR_SCRIPTS);

  // (6) the lockfile.
  paths.push(LOCKFILE);

  return paths.map((path) => ({ path }));
}

// 32-byte BLAKE2b digest (createHash('blake2b512'), first 32 bytes) over each
// input's repo-relative path and its bytes. Length prefixes separate the two
// fields, so moving bytes between a path and its contents cannot give an
// equal digest.
export function computeFingerprint(root: string): string {
  const members = [...new Set([...NODE_LOADS, ...FAUCET_LOADS])];
  assertDistFresh(members, root);

  const hash = createHash('blake2b512');
  const pathLen = Buffer.alloc(4);
  const contentLen = Buffer.alloc(8);
  for (const { path } of fingerprintInputs(root)) {
    const bytes = readFileSync(join(root, path));
    const pathBuf = Buffer.from(path, 'utf8');
    pathLen.writeUInt32BE(pathBuf.length, 0);
    contentLen.writeBigUInt64BE(BigInt(bytes.length), 0);
    hash.update(pathLen);
    hash.update(pathBuf);
    hash.update(contentLen);
    hash.update(bytes);
  }
  // First 32 bytes of the 64-byte BLAKE2b-512 output.
  return hash.digest().subarray(0, 32).toString('hex');
}
