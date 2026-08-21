// ARCHITECTURE → Build and test resolution, rule 4.
import { readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const PACKAGES_DIR = resolve(import.meta.dirname, '..', '..', '..', 'packages');
const PROTOCOL_PACKAGES = ['wire', 'types', 'validation', 'net', 'node'] as const;

function newestMtime(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  }
  return newest;
}

export function assertDistFresh(): void {
  const stale: string[] = [];
  for (const pkg of PROTOCOL_PACKAGES) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src');
    const distEntry = join(PACKAGES_DIR, pkg, 'dist', 'index.js');
    const distStat = statSync(distEntry, { throwIfNoEntry: false });
    if (!distStat) {
      stale.push(`${pkg}: dist/index.js missing`);
      continue;
    }
    const srcNewest = newestMtime(srcDir);
    if (srcNewest > distStat.mtimeMs) {
      stale.push(`${pkg}: src newer than dist`);
    }
  }
  if (stale.length > 0) {
    const list = stale.map((s) => `  - ${s}`).join('\n');
    throw new Error(
      `Stale dist — rebuild before running the mesh suite:\n${list}\n` +
        `Run: for p in wire types validation net node; do pnpm --filter @dagsocial/$p build; done`,
    );
  }
}
