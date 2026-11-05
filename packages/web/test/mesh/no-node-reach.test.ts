// MESH_INTERFACE → Place in the workspace — the mesh client runs in the
// browser as written: `dist-mesh/` (the bundle `./mesh` exports and any
// file it imports from within `dist-mesh/`) carries no `node:` import,
// no bare Node built-in import, and none of the Node globals that
// `refuseNodeBuiltins` and `tsconfig.browser.json` keep out of the
// source.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const DIST_MESH = process.env['NO_NODE_REACH_DIST']
  ?? fileURLToPath(new URL('../../dist-mesh', import.meta.url));

/**
 * Every `.js` file under `dist-mesh/`, recursively. tsup emits one
 * bundle at `dist-mesh/index.js` today; a build that splits chunks
 * lands them here too.
 */
function distFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...distFiles(p));
    } else if (s.isFile() && name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

// tsup externalises Node built-ins, but it rewrites `node:fs` to `fs`
// in its output: the refuse-node-builtins plugin checks both forms, so
// the scan does the same (`packages/web/scripts/refuse-node-builtins.mjs`).
// Four forms of an import: `from 'spec'`, `require('spec')`, dynamic
// `import('spec')`, and a side-effect `import 'spec'`.
const IMPORT_RE = /(?:from\s*['"]|require\s*\(\s*['"]|import\s*\(\s*['"]|import\s+['"])([^'"\s)]+)['"]/g;

// The four Node globals the source is held to keep out. `Buffer`,
// `process` and `__dirname` are matched with word boundaries so
// substrings — `ProcessFoo`, `__dirname_like` — do not match;
// `require(` is literal, so a `requireAuth` identifier does not match.
const GLOBAL_RES: { name: string; re: RegExp }[] = [
  { name: 'Buffer', re: /\bBuffer\b/ },
  { name: 'process', re: /\bprocess\b/ },
  { name: 'require(', re: /\brequire\(/ },
  { name: '__dirname', re: /\b__dirname\b/ },
];

describe('@dagsocial/web/mesh — the bundle reaches no Node built-in', () => {
  it('dist-mesh/ carries no node: import, no bare Node built-in import, and no Node global', async () => {
    expect(
      existsSync(DIST_MESH),
      `dist-mesh/ must exist — run \`pnpm --filter @dagsocial/web build\` first (${DIST_MESH})`,
    ).toBe(true);
    const files = distFiles(DIST_MESH);
    expect(files.length, `dist-mesh/ holds no .js file (${DIST_MESH})`).toBeGreaterThan(0);
    const { builtinModules } = await import('node:module');
    const importHits: string[] = [];
    const globalHits: string[] = [];
    for (const f of files) {
      const rel = f.slice(dirname(DIST_MESH).length + 1);
      const code = readFileSync(f, 'utf8');
      for (const m of code.matchAll(IMPORT_RE)) {
        const spec = m[1]!;
        if (spec.startsWith('node:') || builtinModules.includes(spec)) {
          importHits.push(`${rel}: ${spec}`);
        }
      }
      for (const g of GLOBAL_RES) {
        if (g.re.test(code)) globalHits.push(`${rel}: ${g.name}`);
      }
    }
    expect(importHits, `banned Node imports: ${importHits.join(', ')}`).toEqual([]);
    expect(globalHits, `banned Node globals: ${globalHits.join(', ')}`).toEqual([]);
  }, 30_000);
});
