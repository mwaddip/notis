// ARCHITECTURE → Build and test resolution, rule 4.
import { readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

// Each list names, by directory under the repo root, every workspace member whose
// `dist/index.js` one spawned entry loads: its own package and its workspace dependencies,
// transitively — a bundle externalises its workspace dependencies, so each loads from its
// own `dist`. Listed in build order, which the refusal's Run hint follows.

// `packages/node/dist/index.js`, spawned for every node of a mesh.
export const NODE_LOADS: readonly string[] = [
  'packages/wire',
  'packages/types',
  'packages/validation',
  'packages/net',
  'packages/nipopow',
  'packages/node',
];

// `tools/nipopow-client/dist/index.js`, spawned by the light-client test.
export const NIPOPOW_CLIENT_LOADS: readonly string[] = [
  'packages/wire',
  'packages/types',
  'packages/validation',
  'packages/nipopow',
  'tools/nipopow-client',
];

function newestMtime(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) {
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

// A member's package is `@dagsocial/` and its directory's name.
export function assertDistFresh(members: readonly string[], root: string = REPO_ROOT): void {
  const stale: string[] = [];
  for (const member of members) {
    const label = `@dagsocial/${basename(member)} (${member})`;
    const distStat = statSync(join(root, member, 'dist', 'index.js'), { throwIfNoEntry: false });
    if (!distStat) {
      stale.push(`${label}: dist/index.js missing`);
      continue;
    }
    if (newestMtime(join(root, member, 'src')) > distStat.mtimeMs) {
      stale.push(`${label}: src/ newer than dist/index.js`);
    }
  }
  if (stale.length > 0) {
    const list = stale.map((s) => `  - ${s}`).join('\n');
    const names = members.map((m) => basename(m)).join(' ');
    throw new Error(
      `Stale dist — rebuild before running the mesh suite:\n${list}\n` +
        `Run: for p in ${names}; do pnpm --filter @dagsocial/$p build; done`,
    );
  }
}
