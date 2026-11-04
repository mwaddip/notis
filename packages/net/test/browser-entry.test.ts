import { describe, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { refuseNodeBuiltins } from '../../../packages/web/scripts/refuse-node-builtins.mjs';

// NET_INTERFACE → The browser entry — the half a browser runs imports no
// Node built-in. The vite build of `src/browser.ts` through
// refuseNodeBuiltins fails on any Node built-in a module in its bundle
// imports, `node:`-prefixed or bare (WEB_INTERFACE → "A Node built-in
// fails every build"). The alias is not set: a stray `~/node_modules`
// sits above the repo and resolves undeclared imports, so the plugin's
// refusal — not the lockfile — is the proof here.
describe("@dagsocial/net/browser builds without reaching a Node built-in", () => {
  // Red until `patches/@libp2p__http-utils@2.0.6.patch` lands:
  // `src/browser.ts` now exports `meshFetch` through
  // `@libp2p/http-fetch`, whose barrel re-exports
  // `stream-to-socket.js` from `@libp2p/http-utils@2.0.6`, and that
  // file imports `node:stream` and `node:net`. The patch maps the
  // file to a browser twin through `package.json`'s `browser` field.
  it.fails('vite build succeeds', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'net-browser-entry-'));
    try {
      await build({
        root: fileURLToPath(new URL('../', import.meta.url)),
        logLevel: 'error',
        build: {
          outDir,
          emptyOutDir: true,
          target: 'es2022',
          lib: {
            entry: fileURLToPath(new URL('../src/browser.ts', import.meta.url)),
            formats: ['es'],
            fileName: 'browser',
          },
        },
        plugins: [refuseNodeBuiltins()],
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
