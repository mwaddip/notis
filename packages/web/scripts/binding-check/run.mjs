#!/usr/bin/env node
// Binding check: build the read surface's crypto path and run it in a REAL
// browser over live node data, asserting each recomputed contentHash equals the
// one the node served. WEB_INTERFACE → The browser reaches @dagsocial/types
// through a build-time shim — only the built bundle in a browser exercises the
// shim; under Node the substitution never happens, so no committed unit test can.
//
// Usage:
//   node scripts/binding-check/run.mjs [apiBase]
//   node scripts/binding-check/run.mjs https://notis.fun/testnet/api
//
// apiBase defaults to a local dev node (http://localhost:3000 —
// `node packages/node/scripts/dev.mjs --nodes 1 --miners 1` serves one). Needs a
// Chromium binary: set CHROME, else Playwright's cached chromium is used.
//
// Exit 0 = all live posts matched; 1 = a mismatch; 2 = setup failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import inject from '@rollup/plugin-inject';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const require_ = createRequire(import.meta.url);
const API = process.argv[2] ?? 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const found = [];
  const pw = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw)) {
      if (!d.startsWith('chromium-')) continue;
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(pw, d, rel);
        if (existsSync(p)) found.push(p);
      }
    }
  }
  found.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  return found.find(existsSync) ?? null;
}

// 1. Build the harness through the same alias + ABSOLUTE-path Buffer inject the
//    app build uses — a bare `buffer` here would resolve from @dagsocial/types to
//    the Node builtin and externalize to nothing.
const outDir = mkdtempSync(join(tmpdir(), 'notis-binding-'));
await build({
  root: WEB,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: [{ find: /^crypto$/, replacement: join(WEB, 'src/shim/crypto.ts') }] },
  build: {
    outDir,
    emptyOutDir: true,
    minify: false,
    lib: { entry: join(HERE, 'entry.ts'), formats: ['iife'], name: 'BC', fileName: () => 'bc.js' },
    rollupOptions: {
      // The trailing slash forces package resolution — `resolve('buffer')` returns
      // the Node builtin's name, not the buffer package's absolute path.
      plugins: [inject({ modules: { Buffer: [require_.resolve('buffer/'), 'Buffer'] }, exclude: [/node_modules[/\\]buffer[/\\]/] })],
    },
  },
});
const BC_JS = readFileSync(join(outDir, 'bc.js'), 'utf8');

const chrome = findChrome();
if (!chrome) { console.error('no Chromium found — set CHROME to a browser binary'); process.exit(2); }

// 2. Live data the node independently produced.
const posts = [];
let after = null;
for (let page = 0; page < 6 && posts.length < 80; page++) {
  const url = `${API}/posts?limit=30${after ? `&after=${encodeURIComponent(after)}` : ''}`;
  let j;
  try { j = await (await fetch(url)).json(); }
  catch (e) { console.error(`cannot reach ${url}: ${e.message}`); process.exit(2); }
  posts.push(...j.posts.filter((p) => p && !p.kind && p.content != null));
  if (!j.next) break;
  after = j.next;
}
if (posts.length === 0) { console.error(`${API} returned no posts with content to check`); process.exit(2); }
console.log(`fetched ${posts.length} live posts with content from ${API}`);

// 3. Headless Chromium + CDP.
const port = 9000 + Math.floor(Math.random() * 1000);
const profile = mkdtempSync(join(tmpdir(), 'notis-bc-profile-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pg = list.find((t) => t.type === 'page');
      if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chromium DevTools endpoint never appeared');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

await send('Runtime.enable');
const env = await evaluate('JSON.stringify({ process: typeof process, Buffer: typeof Buffer, subtle: typeof crypto !== "undefined" && !!crypto.subtle })');
console.log('browser env before the bundle loads:', env);
const kind = await evaluate(BC_JS + '\n;typeof globalThis.__contentHashHex');
if (kind !== 'function') throw new Error(`harness did not expose __contentHashHex (got ${kind})`);

// 4. Recompute each post in the browser and compare to the served contentHash.
let checked = 0, mismatched = 0;
for (const p of posts) {
  const got = await evaluate(`globalThis.__contentHashHex(${JSON.stringify(p.content)})`);
  checked++;
  if (got !== p.contentHash) { mismatched++; console.log(`MISMATCH ${p.id}: served ${p.contentHash} got ${got}`); }
}
console.log(`checked ${checked}, mismatched ${mismatched} — ${mismatched === 0 ? 'ALL MATCH' : 'PROBLEM'}`);

ws.close();
proc.kill();
process.exit(mismatched === 0 ? 0 : 1);
