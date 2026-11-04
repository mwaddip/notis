// MESH_INTERFACE → Acceptance — every stage script links under plain Node.
// Vitest resolves `@dagsocial/*` to source through vite, which tolerates a
// named import the built package does not export; native Node ESM refuses
// it at link time. This suite loads each `stage/**/*.mjs` module in a child
// Node process against the built packages, so an import that does not link
// fails here and not on the stage.
//
// The built packages are required: with `packages/*/dist` missing the stage
// cannot run, so the suite fails (`pnpm -r build` first) rather than skips.
//
// Loading runs a script's top level. `up.mjs` and `down.mjs` do work there,
// so the modules load from a throwaway copy of `stage/` (their `out/` is the
// copy's) with `--dry-run` in argv; `dns-log.mjs` and `page-server.mjs` listen
// on import, so they get port 0 on loopback from their own env; the other
// scripts guard their entry on `process.argv[1]` being the file, which
// `node -e` leaves unset. The child exits 0 once the import has resolved.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const STAGE = join(PKG, 'stage');
const DIST_ENTRIES = ['net', 'types', 'validation', 'wire', 'node-reads', 'nipopow']
  .map((p) => join(PKG, '..', '..', 'packages', p, 'dist', 'index.js'));

function modulesIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
}

const ENTRIES = [
  ...modulesIn(STAGE).map((f) => f),
  ...modulesIn(join(STAGE, 'scenarios')).map((f) => `scenarios/${f}`),
  ...modulesIn(join(STAGE, 'lib')).map((f) => `lib/${f}`),
];

let copy = '';

beforeAll(() => {
  const missing = DIST_ENTRIES.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(`built packages missing (run \`pnpm -r build\`): ${missing.join(', ')}`);
  }
  copy = mkdtempSync(join(PKG, '.stage-links-'));
  cpSync(STAGE, join(copy, 'stage'), {
    recursive: true,
    filter: (src) => !/[\\/]stage[\\/](out|out\.prev|cache)([\\/]|$)/.test(src),
  });
});

afterAll(() => {
  if (copy !== '') rmSync(copy, { recursive: true, force: true });
});

describe('stage scripts link under plain Node', () => {
  it('finds the scripts it is meant to load', () => {
    for (const name of ['up.mjs', 'run.mjs', 'down.mjs', 'report.mjs', 'hostile-gossip.mjs',
      'hostile-upstream.mjs', 'cdp.mjs', 'page-server.mjs', 'dns-log.mjs']) {
      expect(ENTRIES).toContain(name);
    }
    expect(ENTRIES.filter((e) => e.startsWith('scenarios/')).length).toBeGreaterThanOrEqual(8);
    expect(ENTRIES.filter((e) => e.startsWith('lib/')).length).toBeGreaterThanOrEqual(15);
  });

  it.each(ENTRIES)('%s', (entry) => {
    const url = pathToFileURL(join(copy, 'stage', entry)).href;
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); process.exit(0);`, 'argv0', '--dry-run'],
      { encoding: 'utf8', timeout: 60_000, env: {
          ...process.env,
          MESH_STAGE_OUT_DIR: join(copy, 'stage', 'out'),
          DNS_LOG_PORT: '0',
          DNS_LOG_BIND: '127.0.0.1',
          DNS_LOG_PATH: join(copy, 'dns.log'),
          PAGE_PORT: '0',
          SERVE_DIR: copy,
        },
      },
    );
    const text = `${r.stdout}${r.stderr}`;
    expect(r.stderr, text).not.toMatch(/SyntaxError|does not provide an export named|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/);
    expect(r.status, text).toBe(0);
  }, 70_000);
});
