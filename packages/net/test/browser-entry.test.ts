import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { refuseNodeBuiltins } from '../../../packages/web/scripts/refuse-node-builtins.mjs';
import * as browserEntry from '../src/browser.js';

// NET_INTERFACE → The browser entry — the half a browser runs imports no
// Node built-in. The vite build of `src/browser.ts` through
// refuseNodeBuiltins fails on any Node built-in a module in its bundle
// imports, `node:`-prefixed or bare (WEB_INTERFACE → "A Node built-in
// fails every build"). The alias is not set: a stray `~/node_modules`
// sits above the repo and resolves undeclared imports, so the plugin's
// refusal — not the lockfile — is the proof here.
describe("@dagsocial/net/browser builds without reaching a Node built-in", () => {
  it('vite build succeeds', async () => {
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

  // NET_INTERFACE → The browser entry — `SYNC_PROTOCOL`,
  // `PostTextProvider`, `answerPostTextsRequest`, `postTextsHandler` and
  // `SERVING_READER_CAPABILITIES` reach the browser through
  // `@dagsocial/net/browser`, beside `MAX_MODIFIER_REQUEST_FRAME_BYTES`.
  it('exports the serving reader names', () => {
    const ns = browserEntry as unknown as Record<string, unknown>;
    expect({
      SYNC_PROTOCOL: ns.SYNC_PROTOCOL,
      answerPostTextsRequest: typeof ns.answerPostTextsRequest,
      postTextsHandler: typeof ns.postTextsHandler,
      SERVING_READER_CAPABILITIES: Array.isArray(ns.SERVING_READER_CAPABILITIES),
      MAX_MODIFIER_REQUEST_FRAME_BYTES: typeof ns.MAX_MODIFIER_REQUEST_FRAME_BYTES,
    }).toEqual({
      SYNC_PROTOCOL: '/dagsocial/sync/1',
      answerPostTextsRequest: 'function',
      postTextsHandler: 'function',
      SERVING_READER_CAPABILITIES: true,
      MAX_MODIFIER_REQUEST_FRAME_BYTES: 'number',
    });
  });
});
