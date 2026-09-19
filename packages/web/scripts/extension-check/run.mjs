#!/usr/bin/env node
// The extension proof — the twelve steps of WEB_INTERFACE → The extension,
// verbatim, over raw CDP against a live devnet stack. Drives the App's real
// UI on the extension's own page: the composer, the like word, the profile
// window's rows, and the prompt window found by its `prompt.html?id=` URL.
//
// Preconditions:
//  1. `node packages/node/dist/index.js` running as `NETWORK_TYPE=devnet`
//     with a miner, or `packages/node/scripts/dev.mjs`.
//  2. The faucet running against that node with the devnet key.
//  3. `promote.mjs` has printed R's public and pkcs8-hex; R's clear file
//     (`{ pubKeyHex, privKeyBase64 }`) lives in a scratch path outside the
//     repo and never enters a commit, a log or the REPORT.
//  4. The extension was built via build-extension.sh with devnet values
//     (VITE_NODES points at this run's node).
//
// Usage:
//   node scripts/extension-check/run.mjs \
//     --extension-dir <path> --r-key <path> --node <origin> --faucet <origin>

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { matchPatternFor } from '../../extension/match-pattern.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[++i]);
}
const EXT_DIR = args.get('extension-dir');
const R_KEY = args.get('r-key');
const NODE = args.get('node') ?? 'http://localhost:3300';
const FAUCET = args.get('faucet') ?? 'http://localhost:3103';
const EXT_ID = args.get('extension-id') ?? 'kafmnekclgkjnkhnbafdoefnlllboddm';
const PUBLIC = args.get('public') ?? null;
const WEB_DIST = args.get('web-dist') ?? null;
const PASSPHRASE = 'proof-pass';

if (!EXT_DIR || !existsSync(EXT_DIR)) { console.error('missing --extension-dir'); process.exit(2); }
if (!R_KEY || !existsSync(R_KEY)) { console.error('missing --r-key'); process.exit(2); }

// --public and --web-dist come together — pass both or neither. Without them
// the twelve run as today and steps 13–16 are reported NOT RUN by name
// (WEB_INTERFACE → The extension → "Links into the extension").
if ((PUBLIC === null) !== (WEB_DIST === null)) {
  console.error('--public and --web-dist come together — pass both or neither');
  process.exit(2);
}
let publicOrigin = null;
let publicBase = null;
let publicPort = null;
let webDistAbs = null;
if (PUBLIC !== null) {
  let u;
  try { u = new URL(PUBLIC); } catch { console.error(`--public must be a URL, got: ${PUBLIC}`); process.exit(2); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { console.error('--public must be http:/https:'); process.exit(2); }
  if (!u.pathname.endsWith('/')) { console.error('--public must end with \'/\''); process.exit(2); }
  if (u.search !== '' || u.hash !== '') { console.error('--public must carry no query or fragment'); process.exit(2); }
  if (u.port === '') { console.error('--public must name a port'); process.exit(2); }
  publicOrigin = u.origin;
  publicBase = u.pathname;
  publicPort = Number(u.port);
  if (!existsSync(WEB_DIST)) { console.error(`--web-dist not found: ${WEB_DIST}`); process.exit(2); }
  webDistAbs = resolve(WEB_DIST);
  if (!existsSync(join(webDistAbs, 'index.html'))) { console.error(`--web-dist has no index.html: ${webDistAbs}`); process.exit(2); }
}

// Grant two loopback origins on the *unpacked* manifest — CDP cannot drive the
// browser's permission dialog, so the App's fetch to the faucet is refused at
// the network layer even after step 11 stubs `chrome.permissions.request` true.
// The tracked template (`extension/manifest.template.json`) and the packed
// release manifest are untouched.
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const LOOPBACKS = ['http://127.0.0.1/*', 'http://localhost/*'];
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...LOOPBACKS])];
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest patched: host_permissions += ${JSON.stringify(LOOPBACKS)}`);

// The build's faucet base is the shell's `notis-faucet` — WEB_INTERFACE →
// "The faucet step". prefs.faucet reads it once at load, and the press's
// permission ask uses that value. A build whose meta does not match --faucet
// would die at step 11 with no word why, so fail fast here and name it.
const SHELL_PATH = join(EXT_DIR, 'index.html');
const shellHtml = readFileSync(SHELL_PATH, 'utf8');
const faucetMetaMatch = shellHtml.match(/<meta[^>]+name="notis-faucet"[^>]+content="([^"]*)"[^>]*>/);
const shellFaucet = faucetMetaMatch ? faucetMetaMatch[1] : null;
if (shellFaucet !== FAUCET) {
  console.error(`FAIL: shell notis-faucet="${shellFaucet}" != --faucet="${FAUCET}"`);
  console.error(`      rebuild with VITE_FAUCET_BASE=${FAUCET} bash packages/web/scripts/build-extension.sh`);
  process.exit(2);
}
console.log(`shell notis-faucet=${shellFaucet} matches --faucet`);

// The build's public base is the shell's `notis-public` — WEB_INTERFACE →
// The extension → "Links into the extension". When --public is passed, the
// shell must carry it exactly, and the manifest's one content_scripts entry
// must be the port-less pattern derived from --public (via the module the
// emitter uses; never a second implementation here — the faucet check's
// shape, for the same reason).
if (PUBLIC !== null) {
  const publicMetaMatch = shellHtml.match(/<meta[^>]+name="notis-public"[^>]+content="([^"]*)"[^>]*>/);
  const shellPublic = publicMetaMatch ? publicMetaMatch[1] : null;
  if (shellPublic !== PUBLIC) {
    console.error(`FAIL: shell notis-public="${shellPublic}" != --public="${PUBLIC}"`);
    console.error(`      rebuild with VITE_PUBLIC=${PUBLIC} bash packages/web/scripts/build-extension.sh`);
    process.exit(2);
  }
  console.log(`shell notis-public=${shellPublic} matches --public`);
  const expectedPattern = matchPatternFor(PUBLIC);
  const cs = manifest.content_scripts;
  if (!Array.isArray(cs) || cs.length !== 1) {
    console.error(`FAIL: manifest content_scripts must have one entry, got: ${JSON.stringify(cs)}`);
    process.exit(2);
  }
  const csMatches = cs[0].matches;
  if (!Array.isArray(csMatches) || csMatches.length !== 1 || csMatches[0] !== expectedPattern) {
    console.error(`FAIL: manifest content_scripts[0].matches != [${JSON.stringify(expectedPattern)}] — got: ${JSON.stringify(csMatches)}`);
    process.exit(2);
  }
  console.log(`manifest content_scripts[0].matches=${csMatches[0]} matches expected pattern (port-less)`);
}

// The web server for --web-dist — WEB_INTERFACE → The extension → "Links into
// the extension". The files under the base's path; <base>p/<64 hex> answers
// the shell (index.html), as the node's GET /shell/:id does behind nginx.
// The plain page (/link.html?id=<hex>, outside the base — the bridge is
// declared only for <base>p/*, so this page runs with no bridge) links to a
// thread twice, once same-tab and once target="_blank", the two arms step 16
// measures. Content types cover only what a Vite web build serves.
function contentTypeFor(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.woff2')) return 'font/woff2';
  if (p.endsWith('.woff')) return 'font/woff';
  if (p.endsWith('.ico')) return 'image/x-icon';
  if (p.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

const HEX64 = /^[0-9a-f]{64}$/i;
let webServer = null;
// Every request the web server answers, in the order it arrives — path and
// arrival time. Step 14 reads the slice around a run to show how far the
// hosted page got, measured from outside the browser
// (WEB_INTERFACE → The extension → "Links into the extension").
const webRequests = [];
async function startWebServer() {
  if (PUBLIC === null) return;
  webServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', publicOrigin);
      const p = url.pathname;
      webRequests.push({ path: (req.url ?? '/'), at: Date.now() });
      if (p === '/link.html') {
        const idQ = url.searchParams.get('id') ?? '';
        const safe = HEX64.test(idQ) ? idQ : '';
        const href = publicOrigin + publicBase + 'p/' + safe;
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>plain</title>` +
          `</head><body><a id="same" href="${href}">follow same-tab</a> ` +
          `<a id="blank" href="${href}" target="_blank" rel="noopener">follow new-tab</a></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      if (!p.startsWith(publicBase)) { res.writeHead(404); res.end('outside base'); return; }
      const rel = p.substring(publicBase.length);
      if (/^p\/[0-9a-f]{64}$/i.test(rel)) {
        const shell = await readFile(join(webDistAbs, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(shell);
        return;
      }
      const relClean = rel === '' ? 'index.html' : rel;
      const abs = resolve(webDistAbs, relClean);
      if (abs !== webDistAbs && !abs.startsWith(webDistAbs + sep)) { res.writeHead(403); res.end('escape'); return; }
      let buf;
      try { buf = await readFile(abs); } catch { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': contentTypeFor(relClean), 'cache-control': 'no-store' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((res, rej) => {
    webServer.on('error', rej);
    webServer.listen(publicPort, '127.0.0.1', () => res());
  });
  console.log(`web server: ${webDistAbs} served on ${publicOrigin}${publicBase} (port ${publicPort})`);
}
await startWebServer();

const R_TEXT = readFileSync(R_KEY, 'utf8');
const R_JSON = JSON.parse(R_TEXT);

const findChrome = () => {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const pw = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw)) if (d.startsWith('chromium-')) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(pw, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
};
const CHROME = findChrome();
if (!CHROME) { console.error('no Chromium found'); process.exit(2); }

const port = 19200 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'notis-ext-proof-'));
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--load-extension=${EXT_DIR}`, `--disable-extensions-except=${EXT_DIR}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', () => {}); // absorb chrome's noise
proc.stdout.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserVersion() {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return r.json(); } catch {}
    await sleep(100);
  }
  throw new Error('chrome DevTools never appeared');
}
await browserVersion();

async function jsonList() { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()); }

// A CDP session over one target — Page, Runtime, Network enabled; window.__btn
// is the byName helper the precedent used.
async function openSession(wsUrl) {
  const s = new WebSocket(wsUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  let n = 0;
  const p = new Map();
  const events = [];
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
    if (m.method) events.push(m);
  };
  const CALL_TIMEOUT_MS = 60000;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n;
    const timer = setTimeout(() => { p.delete(id); rej(new Error(`CDP timeout ${CALL_TIMEOUT_MS}ms on ${method}`)); }, CALL_TIMEOUT_MS);
    p.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    s.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  const eval_ = async (expression, userGesture = false) => {
    // `call` resolves with `m.result` (the CDP method result). Runtime.evaluate's
    // result is `{ result: { type, value, ... }, exceptionDetails? }`, so the
    // value sits at `r.result.value`.
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  const waitFor = async (expression, what, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await eval_(expression)) return; await sleep(200); }
    throw new Error(`timeout waiting for ${what}`);
  };
  await eval_(`window.__btn = (t, r) => [...(r||document).querySelectorAll('button')].find(b=>b.textContent.trim()===t)||null; window.__req = []; true`);
  return { s, call, eval: eval_, waitFor, events };
}

const findings = [];
const record = (step, status, detail) => {
  const s = status === true ? 'PASS' : status === false ? 'FAIL' : status === 'skipped' ? 'SKIPPED' : String(status);
  findings.push({ step, status: s, detail });
  console.log(`step ${step}: ${s} — ${detail}`);
};

async function findExt(pathSuffix) {
  for (let i = 0; i < 100; i++) {
    const list = await jsonList();
    const p = list.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`) && (pathSuffix ? t.url.includes(pathSuffix) : true));
    if (p?.webSocketDebuggerUrl) return p;
    await sleep(200);
  }
  return null;
}

async function findWorker() {
  const list = await jsonList();
  return list.find((t) => (t.type === 'service_worker' || t.type === 'worker') && t.url.endsWith('/background.js'));
}

// The browser-level CDP session — the only one that can `Target.createTarget`,
// `Target.closeTarget`, `Target.createBrowserContext`, and see `targetCreated`
// / `targetDestroyed` events at the browser scope. Distinct from a per-target
// session opened via `openSession(wsUrl)` (WEB_INTERFACE → The extension →
// "Links into the extension" — the browser-scope moves the tabs).
async function openBrowserSession() {
  const bv = await browserVersion();
  const s = new WebSocket(bv.webSocketDebuggerUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  let n = 0;
  const p = new Map();
  const events = [];
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
    // A method event carries its own arrival stamp — the run's clock in ms
    // (WEB_INTERFACE → The extension → "Links into the extension"), so a
    // wait taking an index AFTER the event still reports when the event
    // arrived. Read as `ev.__at` alongside `ev.method`/`ev.params`.
    if (m.method) { m.__at = Date.now(); events.push(m); }
  };
  const CALL_TIMEOUT_MS = 60000;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n;
    const timer = setTimeout(() => { p.delete(id); rej(new Error(`CDP timeout ${CALL_TIMEOUT_MS}ms on ${method}`)); }, CALL_TIMEOUT_MS);
    p.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    s.send(JSON.stringify({ id, method, params }));
  });
  await call('Target.setDiscoverTargets', { discover: true });
  return { s, call, events };
}

// A trusted click — CDP `Input.dispatchMouseEvent` on the control's measured
// centre, so the page reads the browser's transient user activation (which a
// page cannot forge). The offer listener inside the bridge takes the event
// only under this activation (WEB_INTERFACE → The extension → "The website's
// control offers the thread to the extension"); `element.click()` through
// `Runtime.evaluate` reads as synthetic there. Returns the coordinates.
async function trustedClickAt(cx, selector) {
  const box = await cx.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`trustedClickAt: no element for ${selector}`);
  await cx.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await cx.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}

// Wait for a target from `/json/list` matching a predicate (typically by id).
async function findTargetById(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await jsonList();
    const t = list.find((x) => x.id === id);
    if (t && t.webSocketDebuggerUrl) return t;
    await sleep(150);
  }
  return null;
}

// Wait for a target to disappear from `/json/list` (destroyed).
async function waitForTargetGone(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await jsonList();
    if (!list.find((x) => x.id === id)) return true;
    await sleep(100);
  }
  return false;
}

// Set the extension's links preference through the settings window's real
// row (WEB_INTERFACE → The settings window → "The links row"). Never writes
// storage directly, per the proof's rules.
async function setLinksPrefViaUi(cx, value) {
  const label = value === 'site' ? 'on the site' : 'here';
  await cx.eval(`document.querySelector('[aria-label="open settings"]').click()`, true);
  await cx.waitFor(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    return rows.some(r => r.querySelector('label')?.textContent === 'a Notis link opens');
  })()`, 'settings links row', 10000);
  await cx.eval(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    const row = rows.find(r => r.querySelector('label')?.textContent === 'a Notis link opens');
    const btn = [...row.querySelectorAll('button.word')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
    btn.click();
  })()`, true);
  // The click stashes through `chrome.storage.local.set` — wait on the read
  // to observe the stored value, capped at 5 s. Any wait for the write is
  // the value's arrival, not a sleep.
  const t0 = Date.now();
  let applied = null;
  while (Date.now() - t0 < 5000) {
    applied = await cx.eval(`(async () => (await chrome.storage.local.get('notis.links'))['notis.links'] ?? 'here')()`);
    if (applied === value) return applied;
    await sleep(50);
  }
  return applied;
}

// Read a root post id authored by R from the node — a post the run itself
// made (step 3, or promote.mjs's earlier ones — the run itself made all of
// them under R). WEB_INTERFACE → Reading the feed and threads — the answer's
// rows sit under `posts` on this endpoint.
async function pickOwnRootPostId() {
  // `GET /posts` answers `{ posts, next, pending, pendingCount }`
  // (NODE_INTERFACE → Posts).
  const r = await fetch(`${NODE}/posts?roots=1&author=${R_JSON.pubKeyHex}&limit=1`);
  const j = await r.json();
  const rows = Array.isArray(j?.posts) ? j.posts : [];
  const first = rows[0];
  if (!first || typeof first.id !== 'string') return null;
  return first.id;
}

async function pollKarma(target = 20, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`);
      const j = await r.json();
      const total = Number(j.effective ?? j.total ?? 0);
      if (total >= target) return { ok: true, total };
    } catch {}
    await sleep(1000);
  }
  return { ok: false };
}

async function feedContains(id) {
  try { const j = await (await fetch(`${NODE}/posts/${id}`)).json(); return j && !j.kind; } catch { return false; }
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function main() {
  // Open the extension's page.
  const p1 = await findExt('index.html');
  if (p1) {} else {
    // Open one via Target.createTarget through the browser websocket.
    const bv = await browserVersion();
    const br = new WebSocket(bv.webSocketDebuggerUrl);
    await new Promise((res, rej) => { br.onopen = res; br.onerror = rej; });
    br.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: `chrome-extension://${EXT_ID}/index.html` } }));
    await sleep(2000);
    br.close();
  }
  const page = await findExt('index.html');
  if (!page) throw new Error('no extension page');
  // Give the page a moment to finish parsing before we attach — main.ts's
  // top-level `await bootstrapProxy(chrome)` runs before `#feed` gets its
  // children, but the section element itself is in the initial HTML.
  await sleep(4000);
  const cx = await openSession(page.webSocketDebuggerUrl);
  // Wait longer for the page to be usable; the extension's SW must be ready
  // for main.ts's bootstrapProxy to return.
  await cx.waitFor(`!!document.querySelector('#feed')`, 'feed root', 30000);
  await sleep(2000);

  // --- Step 1 — read surface: seed list drives the feed; no `new post` button.
  const s1 = await cx.eval(`(() => ({
    nodes: document.querySelector('meta[name="notis-nodes"]').content,
    newPost: !!document.querySelector('[data-composer-open="@feed"]'),
    feedLoaded: document.querySelectorAll('#feed .card').length,
    feedReport: document.querySelector('#feed .report')?.textContent ?? null,
  }))()`);
  record(1, s1.nodes.includes(NODE.replace(/\/$/, '')) && s1.newPost === false, `notis-nodes=${s1.nodes}, new-post=${s1.newPost}, feedCards=${s1.feedLoaded}, feedReport=${s1.feedReport}`);

  // --- Step 2 — import R through the profile window's Import row.
  await cx.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx.waitFor(`!!window.__btn('import')`, 'import button');
  // The App's inspectFile branch takes the file's text via chrome.runtime.sendMessage
  // through the proxy; the profile then reveals a set-passphrase form. Drive that
  // by calling importFile through the proxy directly — the seam the reader's file
  // picker feeds into after inspectFile.
  const r2 = await cx.eval(`chrome.runtime.sendMessage({ kind: 'importFile', text: ${JSON.stringify(R_TEXT)}, passphrase: ${JSON.stringify(PASSPHRASE)} })`);
  await sleep(1500);
  const s2 = await cx.eval(`(async () => {
    const local = await chrome.storage.local.get(['notis.identity','notis.identity.backedup']);
    const session = await chrome.storage.session.get(['notis.seed']);
    const state = await chrome.runtime.sendMessage({ kind: 'state' });
    const localEnv = local['notis.identity'];
    const seedHex = session['notis.seed'] ?? '';
    return {
      importOk: ${JSON.stringify(r2 ?? null)},
      state,
      envelopeSet: typeof localEnv === 'string' && localEnv.length > 0,
      seedInSession: typeof seedHex === 'string' && seedHex.length === 64,
      seedFreeLocal: typeof localEnv === 'string' && seedHex.length === 64 && !localEnv.includes(seedHex),
    };
  })()`);
  const pubKeyHex = s2.state?.pubKeyHex;
  record(2, pubKeyHex === R_JSON.pubKeyHex && s2.envelopeSet && s2.seedInSession && s2.seedFreeLocal,
    `state.pubKeyHex=${pubKeyHex?.slice(0, 8)}…, envelope in local, seed in session, seed-free local: ${s2.seedFreeLocal}`);

  // Reload so the identity is loaded from storage — proves the proxy's snapshot boot.
  await cx.call('Page.reload');
  await sleep(2500);
  const p2 = await findExt('index.html');
  const cx2 = await openSession(p2.webSocketDebuggerUrl);
  await cx2.waitFor(`document.querySelector('#feed .feed-head .btn-primary')`, 'new post button after identity load');

  // --- Step 3 — Post a thread under silent policy; the composer collapses only after
  // the sign round-trip; the post lands.
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer opened');
  const CONTENT = 'proof-thread-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  // Wait for affordability read to complete so post enables.
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'composer post enabled');
  // No prompt target should appear under silent policy.
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  // Wait: no prompt page opens.
  await sleep(2000);
  const promptOpen = await findExt('prompt.html');
  const composerAfter = await cx2.eval(`!!document.querySelector('.composer')`);
  const cardVisible = await cx2.eval(`!!document.querySelector('.card.pending')`);
  const landed3 = await pollKarma(15, 45000);
  await sleep(3000);
  const feedShowsIt = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT)}))`);
  record(3, !promptOpen && !composerAfter && (cardVisible || feedShowsIt),
    `no prompt (${promptOpen ? 'FAIL' : 'ok'}), composer collapsed (${!composerAfter}), pendingCard=${cardVisible}, feedShows=${feedShowsIt}, karma@R=${landed3.total ?? '?'}`);

  // --- Step 4 — the faucet key posts a thread, R likes it silently, lands.
  // Faucet posting via /faucet is not this test — the promote already posted two
  // threads under R and the faucet already liked them. Step 4's shape here: R likes
  // an EXISTING confirmed post that is not R's own. Look for one in the feed.
  await cx2.eval(`document.querySelector('.feed-head .ctl').click()`, true); // refresh
  await sleep(2500);
  const otherPost = await cx2.eval(`(() => {
    const my = ${JSON.stringify(R_JSON.pubKeyHex)};
    const cards = [...document.querySelectorAll('#feed .card[data-post-id]')];
    const other = cards.find(c => c.getAttribute('data-author') !== my && [...c.querySelectorAll('.word')].some(w => w.textContent.trim() === 'like'));
    if (!other) return null;
    return { id: other.getAttribute('data-post-id'), author: other.getAttribute('data-author') };
  })()`);
  if (otherPost) {
    await cx2.eval(`(() => {
      const card = document.querySelector('[data-post-id="' + ${JSON.stringify(otherPost.id)} + '"]');
      const like = [...card.querySelectorAll('.word')].find(w => w.textContent.trim() === 'like');
      like.click();
    })()`, true);
    await sleep(2000);
    // Check the like is optimistic (green) and no prompt appears.
    const promptOpen4 = await findExt('prompt.html');
    const cardLiked = await cx2.eval(`(() => {
      const card = document.querySelector('[data-post-id="' + ${JSON.stringify(otherPost.id)} + '"]');
      return card ? card.textContent.includes('liked') : false;
    })()`);
    record(4, !promptOpen4 && cardLiked, `no prompt on like (${promptOpen4 ? 'FAIL' : 'ok'}), card shows liked=${cardLiked}, target=${otherPost.id.slice(0, 8)}…`);
  } else {
    record(4, false, 'no non-own likeable post visible in feed');
  }

  // --- Step 5 — Set policy to `ask`; post a thread → prompt appears with the
  // derived summary → approve → window closed, post lands.
  await cx2.eval(`chrome.runtime.sendMessage({ kind: 'policy', karma: 'ask' })`);
  await sleep(500);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer opened for step 5');
  const CONTENT5 = 'proof-ask-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT5)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 5');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  // The prompt window appears.
  const prompt5 = await findExt('prompt.html');
  if (prompt5) {
    const cxp = await openSession(prompt5.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt .line.what')`, 'prompt first line');
    // The markup: every line is a `.line` div with a second class (`.what`,
    // `.amount`, `.target`, `.fee`, `.content`), a `.target` line carrying
    // its `.target-label` and `.target-value` spans (WEB_INTERFACE → The
    // extension → "The prompt reads as three lines: what, how much, to whom").
    const promptShape = await cxp.eval(`(() => {
      return [...document.querySelectorAll('.prompt .line')].map((l) => ({
        cls: [...l.classList].filter((c) => c !== 'line').join(' '),
        text: (l.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        label: l.querySelector('.target-label')?.textContent ?? null,
        value: l.querySelector('.target-value')?.textContent ?? null,
      }));
    })()`);
    // Approve.
    await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    await sleep(2000);
    const promptGone = !(await findExt('prompt.html'));
    const landed5 = await pollKarma(0, 45000).catch(() => ({ ok: true }));
    await sleep(2000);
    const feedShows5 = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT5)}))`);
    const whatOk = promptShape[0]?.cls === 'what' && promptShape[0]?.text === 'Notis post';
    const amountOk = promptShape[1]?.cls === 'amount' && promptShape[1]?.text === '5 rep';
    const contentOk = promptShape.some((l) => l.cls === 'content' && (l.text ?? '').includes(CONTENT5));
    record(5, promptGone && feedShows5 && whatOk && amountOk && contentOk,
      `lines=${JSON.stringify(promptShape.map((l) => `${l.cls}:${l.text}`))} (what=${whatOk}, amount=${amountOk}, content=${contentOk}), promptClosed=${promptGone}, feedShows=${feedShows5}`);
    cxp.s.close();
  } else {
    record(5, false, 'no prompt target appeared under ask policy');
  }

  // --- Step 6 — Post under ask → decline → composer still open with its text,
  // foot line "post not sent.", karma unchanged, no submission.
  const karmaBefore6 = Number((await (await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`)).json()).effective ?? 0);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for decline');
  const CONTENT6 = 'proof-declined-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT6)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 6');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  const prompt6 = await findExt('prompt.html');
  if (prompt6) {
    const cxp = await openSession(prompt6.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'cancel button');
    // Decline.
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    const composerStill = await cx2.eval(`!!document.querySelector('.composer textarea')`);
    const draftIntact = await cx2.eval(`document.querySelector('.composer textarea')?.value ?? null`);
    const foot = await cx2.eval(`document.querySelector('.composer .karma')?.textContent ?? null`);
    const karmaAfter6 = Number((await (await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`)).json()).effective ?? 0);
    record(6, composerStill && draftIntact === CONTENT6 && foot === 'post not sent.' && karmaAfter6 === karmaBefore6,
      `composer still open (${composerStill}), draft="${draftIntact}", foot="${foot}", karma ${karmaBefore6}→${karmaAfter6}`);
    cxp.s.close();
  } else {
    record(6, false, 'no prompt target for decline');
  }

  // --- Step 7 — Close the prompt from outside (Target.closeTarget) → same ending.
  // Cancel the current composer first to reset, then post again.
  await cx2.eval(`(() => {
    const cancel = document.querySelector('.composer button.btn-ghost'); if (cancel) cancel.click();
    // Confirm discard if asked.
    const discard = [...document.querySelectorAll('.composer button')].find(b => b.textContent.trim() === 'discard'); if (discard) discard.click();
  })()`, true);
  await sleep(500);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for close-outside');
  const CONTENT7 = 'proof-closed-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT7)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 7');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  const prompt7 = await findExt('prompt.html');
  if (prompt7) {
    // Close via Target.closeTarget.
    const bv = await browserVersion();
    const br = new WebSocket(bv.webSocketDebuggerUrl);
    await new Promise((res, rej) => { br.onopen = res; br.onerror = rej; });
    br.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: prompt7.id } }));
    await sleep(2500);
    br.close();
    const composerStill7 = await cx2.eval(`!!document.querySelector('.composer textarea')`);
    const foot7 = await cx2.eval(`document.querySelector('.composer .karma')?.textContent ?? null`);
    record(7, composerStill7 && foot7 === 'post not sent.',
      `composer still open (${composerStill7}), foot="${foot7}" after Target.closeTarget`);
  } else {
    record(7, false, 'no prompt target for close-outside');
  }

  // --- Step 8 — Stop the worker mid-prompt. Detach + idle-wait ≥30s per Phase 0.
  // Cancel the current composer, open a fresh one, submit.
  await cx2.eval(`(() => {
    const cancel = document.querySelector('.composer button.btn-ghost'); if (cancel) cancel.click();
    const discard = [...document.querySelectorAll('.composer button')].find(b => b.textContent.trim() === 'discard'); if (discard) discard.click();
  })()`, true);
  await sleep(500);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for step 8');
  const CONTENT8 = 'proof-restart-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT8)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 8');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  const prompt8 = await findExt('prompt.html');
  const workerBefore = await findWorker();
  if (prompt8 && workerBefore) {
    const idBefore = workerBefore.id;
    // Idle-wait ≥30s to let the SW terminate on its own; detaching the CDP
    // session is achieved by not attaching to it. Wait 35s.
    console.log(`step 8: worker id=${idBefore}; idle-waiting 35s for MV3 SW termination…`);
    await sleep(35000);
    // The worker should be absent from /json/list now — that IS termination.
    const workerAtWait = await findWorker();
    // Approve — the fresh worker instance wakes to receive the sign message.
    const cxp = await openSession(prompt8.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-primary')`, 'prompt sign btn after restart');
    await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    // Poll until a worker target reappears (the wake), then read its id.
    let workerAfter = null;
    for (let i = 0; i < 60; i++) {
      workerAfter = await findWorker();
      if (workerAfter && workerAfter.id !== idBefore) break;
      await sleep(500);
    }
    const idAfter = workerAfter?.id ?? null;
    await sleep(4000);
    const feedShows8 = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT8)}))`);
    const idsDiffer = !!idAfter && idAfter !== idBefore;
    record(8, feedShows8 && idsDiffer,
      `worker id before=${idBefore}, mid-wait=${workerAtWait ? workerAtWait.id : 'absent'}, after=${idAfter ?? 'null'} (differ=${idsDiffer}); post landed=${feedShows8}`);
    cxp.s.close();
  } else {
    record(8, false, `prompt=${!!prompt8}, worker=${!!workerBefore}`);
  }

  // --- Step 9 — lock in the profile → session store empties → post mounts unlock →
  // unlock → lands. Set policy back to silent for a clean landing.
  await cx2.eval(`chrome.runtime.sendMessage({ kind: 'policy', karma: 'silent' })`);
  await sleep(500);
  await cx2.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx2.waitFor(`!!window.__btn('lock')`, 'lock button');
  await cx2.eval(`window.__btn('lock').click()`, true);
  await sleep(1000);
  const lockedState = await cx2.eval(`(async () => (await chrome.storage.session.get('notis.seed'))['notis.seed'] ?? null)()`);
  // Post — the composer's foot should mount the unlock form.
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for step 9');
  const CONTENT9 = 'proof-unlock-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT9)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 9');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  await sleep(1500);
  const unlockMounted = await cx2.eval(`!!document.querySelector('.composer form.pf')`);
  if (unlockMounted) {
    // Fill the unlock form and submit.
    await cx2.eval(`(() => {
      const form = document.querySelector('.composer form.pf');
      const pw = form.querySelector('input[type="password"]');
      pw.value = ${JSON.stringify(PASSPHRASE)};
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    })()`, true);
    await sleep(6000);
    const feedShows9 = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT9)}))`);
    record(9, lockedState === null && unlockMounted && feedShows9,
      `lockedSession=${lockedState === null ? 'empty' : 'present'}, unlockMounted=${unlockMounted}, landed=${feedShows9}`);
  } else {
    record(9, false, `lockedSession=${lockedState === null ? 'empty' : 'present'}, unlockMounted=${unlockMounted}`);
  }

  // --- Step 10 — Reload the page → still unlocked (session store per browser).
  await cx2.call('Page.reload');
  await sleep(3000);
  const p10 = await findExt('index.html');
  let cx10 = await openSession(p10.webSocketDebuggerUrl);
  await cx10.waitFor(`document.querySelector('#feed')`, 'feed after reload');
  await sleep(1500);
  const state10 = await cx10.eval(`chrome.runtime.sendMessage({ kind: 'state' })`);
  record(10, state10 && state10.locked === false, `state.locked=${state10?.locked}, pubKeyHex=${state10?.pubKeyHex?.slice(0, 8)}…`);

  // --- Step 11 — the faucet press asks the browser for the origin
  // (WEB_INTERFACE → The faucet step → "In the extension the press asks the
  // browser for the faucet's origin first"). Open the wallet, stub
  // `chrome.permissions.request` to record its argument, press "ask the
  // faucet for $NOTIS", assert the refused branch: the region's report line
  // reads the refusal, no request reaches the faucet, and the ledger holds
  // no `creditGrant`. Restore the stub to resolve true — the granted branch
  // is step 12a, and 12a asserts the stub was asked again before the request
  // left. The real permissions dialog is not drivable from headless Chrome;
  // the manual pass exercises it.
  await cx10.eval(`document.querySelector('[aria-label="open wallet"]').click()`, true);
  await cx10.waitFor(`!!document.querySelector('.credits-field .credits-line button.word')`, 'wallet ask word');
  const events11Start = cx10.events.length;
  await cx10.eval(`(() => {
    window.__permCalls = [];
    chrome.permissions.request = (args) => {
      window.__permCalls.push({ origins: args?.origins ?? null, at: performance.now() });
      return Promise.resolve(false);
    };
  })()`, true);
  await cx10.eval(`(() => {
    const line = document.querySelector('.credits-field .credits-line');
    [...line.querySelectorAll('button.word')].find(b => b.textContent.trim() === 'ask the faucet for $NOTIS').click();
  })()`, true);
  await cx10.waitFor(`(() => {
    const region = document.querySelector('.credits-field')?.closest('.region');
    return region?.querySelector('.report')?.textContent === 'the browser refused access to that origin.';
  })()`, 'wallet region report reads refusal', 5000);
  const refused11 = await cx10.eval(`(() => {
    const region = document.querySelector('.credits-field')?.closest('.region');
    const report = region?.querySelector('.report')?.textContent ?? null;
    const calls = window.__permCalls;
    const raw = localStorage.getItem('notis.pending.' + ${JSON.stringify(R_JSON.pubKeyHex)}) || '[]';
    const hasGrant = JSON.parse(raw).some(e => e.kind === 'creditGrant');
    return { report, callCount: calls.length, firstOrigins: calls[0]?.origins ?? null, hasGrant };
  })()`);
  const faucetRequestSeen11 = cx10.events.slice(events11Start).some((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').startsWith(FAUCET));
  // Restore the stub to true for step 12a — same recorder, so 12a can see
  // that the stub was asked again before the request left.
  await cx10.eval(`(() => {
    chrome.permissions.request = (args) => {
      window.__permCalls.push({ origins: args?.origins ?? null, at: performance.now() });
      return Promise.resolve(true);
    };
  })()`, true);
  const originsExpected = FAUCET + '/*';
  const originsOk11 = refused11.callCount === 1 && Array.isArray(refused11.firstOrigins) && refused11.firstOrigins[0] === originsExpected;
  const reportOk11 = refused11.report === 'the browser refused access to that origin.';
  const noRequest11 = !faucetRequestSeen11;
  const noGrant11 = !refused11.hasGrant;
  record(11, originsOk11 && reportOk11 && noRequest11 && noGrant11,
    `stub calls=${refused11.callCount}, origins[0]=${JSON.stringify(refused11.firstOrigins?.[0] ?? null)} (want=${JSON.stringify(originsExpected)}), report=${JSON.stringify(refused11.report)}, no faucet request=${noRequest11} (CDP Network), no creditGrant=${noGrant11}`);

  // --- Step 12 — Credits: 12a ask → 12b send + approve → 12c decline →
  // 12d locked send. WEB_INTERFACE → The wallet window, → The faucet step,
  // → The extension. The identity is unlocked (step 9), the policy is
  // silent (step 9), and the wallet is already open from step 11 with the
  // permissions stub resolving true.
  const DEVNET_FAUCET_KEY = '5468d985c3924a95f3d3dc98b67a41ac2c7cc4cfca4fcbf7c5627452f1617f36';
  const R_HEX = R_JSON.pubKeyHex;

  // --- 12a — press ask under the granted stub → the stub is asked again
  // BEFORE /credits POST leaves → ledger creditGrant → landing → 100.
  await cx10.waitFor(`!!document.querySelector('.credits-field .credits-line')`, 'credits line');
  const events12aStart = cx10.events.length;
  const permCallsBefore12a = await cx10.eval(`window.__permCalls.length`);
  const before12a = await cx10.eval(`(() => {
    const line = document.querySelector('.credits-field .credits-line');
    const btns = [...(line?.querySelectorAll('button.word') ?? [])];
    const ask = btns.find(b => b.textContent.trim() === 'ask the faucet for $NOTIS');
    return { hasAsk: !!ask, gold: line?.querySelector('.mono.gold')?.textContent ?? null };
  })()`);
  await cx10.eval(`(() => {
    const line = document.querySelector('.credits-field .credits-line');
    [...line.querySelectorAll('button.word')].find(b => b.textContent.trim() === 'ask the faucet for $NOTIS').click();
  })()`, true);
  await cx10.waitFor(`(() => {
    const raw = localStorage.getItem('notis.pending.' + ${JSON.stringify(R_HEX)}) || '[]';
    return JSON.parse(raw).some(e => e.kind === 'creditGrant');
  })()`, 'creditGrant ledger entry', 15000);
  const grantEntry12a = await cx10.eval(`(() => {
    const raw = localStorage.getItem('notis.pending.' + ${JSON.stringify(R_HEX)}) || '[]';
    return JSON.parse(raw).find(e => e.kind === 'creditGrant');
  })()`);
  // The stub was asked again — the second call sits at index `permCallsBefore12a`.
  const permCall12a = await cx10.eval(`(() => {
    const call = window.__permCalls[${permCallsBefore12a}] ?? null;
    return call ? { origins: call.origins, at: call.at } : null;
  })()`);
  const faucetRequestEvent12a = cx10.events.slice(events12aStart).find((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').startsWith(FAUCET));
  const askedAgain12a = permCall12a !== null && Array.isArray(permCall12a.origins) && permCall12a.origins[0] === originsExpected;
  const askedBeforeRequest12a = permCall12a !== null && !!faucetRequestEvent12a
    && permCall12a.at <= faucetRequestEvent12a.params.wallTime * 1000;
  await cx10.waitFor(`document.querySelector('.credits-line .mono.gold')?.textContent === '100'`, 'row reads 100 after grant', 120000);
  const after12a = await cx10.eval(`(() => ({
    gold: document.querySelector('.credits-line .mono.gold')?.textContent ?? null,
    text: document.querySelector('.credits-line')?.textContent?.trim() ?? null,
  }))()`);
  const grantOk12a = grantEntry12a?.kind === 'creditGrant' && typeof grantEntry12a.postId === 'string' && /^[0-9a-f]{64}$/.test(grantEntry12a.postId);
  const askOk12a = before12a.hasAsk;
  const rowOk12a = after12a.gold === '100' && (after12a.text || '').includes('$NOTIS');
  record('12a', askOk12a && grantOk12a && rowOk12a && askedAgain12a && askedBeforeRequest12a,
    `ask=${askOk12a}, stub-asked-again=${askedAgain12a} (origins[0]=${JSON.stringify(permCall12a?.origins?.[0] ?? null)}), asked-before-request=${askedBeforeRequest12a}, grant.postId=${grantEntry12a?.postId?.slice(0, 8) ?? 'null'}…, landed row='${after12a.text}'`);

  // --- 12b — send 12.5 to the devnet faucet key. In the extension arm the
  // resolved-key hint appears beneath the recipient and the prompt opens at
  // once, no confirm row (WEB_INTERFACE → The wallet window → "The `send` row";
  // → The extension). Approve → /credits/transfer 200 → landing → row reads
  // 87.5 → faucet /credits has the payment.
  const events12bStart = cx10.events.length;
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'send form present');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '12.5';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // Wait for the resolved-key hint to reveal — the extension arm shows the whole
  // key beneath the recipient field, no confirm row.
  await cx10.waitFor(
    `(() => { const r = document.querySelector('.credits-field form.credits-form .resolved-key'); return !!r && !r.hidden; })()`,
    'resolved-key visible 12b',
  );
  const resolvedKey12b = await cx10.eval(`document.querySelector('.credits-field form.credits-form .resolved-key')?.textContent ?? null`);
  const noConfirm12b = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const prompt12b = await findExt('prompt.html');
  let promptShape12b = null;
  let shotSaved12b = false;
  if (prompt12b) {
    const cxp = await openSession(prompt12b.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt .line.what')`, 'prompt first line 12b');
    promptShape12b = await cxp.eval(`(() => {
      return [...document.querySelectorAll('.prompt .line')].map((l) => ({
        cls: [...l.classList].filter((c) => c !== 'line').join(' '),
        text: (l.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        label: l.querySelector('.target-label')?.textContent ?? null,
        value: l.querySelector('.target-value')?.textContent ?? null,
      }));
    })()`);
    // The screenshot — the popup's own window is 360 × 420 (background.ts
    // opens it that way); Page.captureScreenshot on that target renders the
    // page at that size. The one thing headless cannot measure is the
    // window's placement on a real screen — the report says so.
    const shot = await cxp.call('Page.captureScreenshot', { format: 'png' });
    if (shot && typeof shot.data === 'string') {
      const shotPath = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', 'prompts', 'web-prompt-window-12b.png');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      shotSaved12b = true;
    }
    await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  await sleep(3000);
  const transfer12b = cx10.events.slice(events12bStart).find((e) =>
    e.method === 'Network.responseReceived' && (e.params.response.url || '').includes('/credits/transfer'));
  await cx10.waitFor(`document.querySelector('.credits-line .mono.gold')?.textContent === '87.5'`, 'row reads 87.5 after send', 180000);
  const faucetCredits12b = await (await fetch(`${NODE}/credits/${DEVNET_FAUCET_KEY}`)).json();
  const paymentBox = (faucetCredits12b.boxes || []).find((b) => BigInt(b.value) === 1_250_000_000n);
  const resolvedOk12b = resolvedKey12b === DEVNET_FAUCET_KEY;
  const whatOk12b = promptShape12b?.[0]?.cls === 'what' && promptShape12b?.[0]?.text === 'Notis transfer';
  const amountOk12b = promptShape12b?.[1]?.cls === 'amount' && promptShape12b?.[1]?.text === '12.5 $NOTIS';
  const targetOk12b = promptShape12b?.[2]?.cls === 'target' && promptShape12b?.[2]?.label === 'to:' && promptShape12b?.[2]?.value === DEVNET_FAUCET_KEY;
  const noFeeLine12b = !(promptShape12b || []).some((l) => l.cls === 'fee');
  const transferOk12b = transfer12b?.params.response.status === 200;
  const rowOk12b = await cx10.eval(`document.querySelector('.credits-line .mono.gold')?.textContent === '87.5'`);
  record('12b',
    noConfirm12b && resolvedOk12b && whatOk12b && amountOk12b && targetOk12b && noFeeLine12b && transferOk12b && rowOk12b && !!paymentBox && shotSaved12b,
    `no .pf-confirm=${noConfirm12b}, resolved-key='${(resolvedKey12b ?? '').slice(0, 8)}…${(resolvedKey12b ?? '').slice(-4)}'=whole=${resolvedOk12b}, lines=${JSON.stringify((promptShape12b || []).map((l) => `${l.cls}:${l.text}`))}, transfer=${transfer12b?.params.response.status ?? 'null'}, row='87.5'=${rowOk12b}, faucet has 12.5=${!!paymentBox}, screenshot saved=${shotSaved12b}`);

  // --- 12c — same extension arm, decline at the prompt. Both form inputs kept,
  // flight "send not sent.", no /credits/transfer (WEB_INTERFACE → The wallet
  // window → "The `send` row" — the fourth ending).
  const events12cStart = cx10.events.length;
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'credits form present 12c');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '7.25';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // The extension arm — the resolved-key hint reveals, no confirm row.
  await cx10.waitFor(
    `(() => { const r = document.querySelector('.credits-field form.credits-form .resolved-key'); return !!r && !r.hidden; })()`,
    'resolved-key visible 12c',
  );
  const noConfirm12c = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const prompt12c = await findExt('prompt.html');
  if (prompt12c) {
    const cxp = await openSession(prompt12c.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'prompt cancel 12c');
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  await sleep(2000);
  const state12c = await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form ? form.querySelectorAll('input') : [];
    const flight = document.querySelector('.credits-flight .stage')?.textContent?.trim() ?? null;
    const gold = document.querySelector('.credits-line .mono.gold')?.textContent ?? null;
    return { to: inputs[0]?.value ?? null, amount: inputs[1]?.value ?? null, flight, gold };
  })()`);
  const transferSeen12c = cx10.events.slice(events12cStart).some((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').includes('/credits/transfer'));
  const formKept12c = state12c.to === DEVNET_FAUCET_KEY && state12c.amount === '7.25';
  const flightOk12c = state12c.flight === 'send not sent.';
  const rowUnchanged12c = state12c.gold === '87.5';
  record('12c', noConfirm12c && formKept12c && flightOk12c && !transferSeen12c && rowUnchanged12c,
    `no .pf-confirm=${noConfirm12c}, form to='${state12c.to?.slice(0, 8) ?? 'null'}…' amount='${state12c.amount}', flight='${state12c.flight}', no /credits/transfer=${!transferSeen12c}, row='${state12c.gold}'`);

  // --- 12d — lock in the profile, return to the wallet, then send: the
  // extension arm mounts the unlock form UNDER the credits form
  // (`.credits-field .card-unlock`, the invites row's pattern — WEB_INTERFACE
  // → The wallet window → "The `send` row"), never in a `.pf-confirm`. No
  // prompt, no /credits/transfer under lock. Unlock → the flight proceeds →
  // the first-send prompt after unlock. Decline it. A second send goes
  // straight to the prompt — cur.identity was mutated, no second unlock
  // (WEB_INTERFACE → The wallet window → "The `send` row").
  await cx10.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx10.waitFor(`!!window.__btn('lock')`, 'lock button in profile 12d');
  await cx10.eval(`window.__btn('lock').click()`, true);
  await sleep(1000);
  const lockedSession12d = await cx10.eval(`(async () => (await chrome.storage.session.get('notis.seed'))['notis.seed'] ?? null)()`);
  await cx10.eval(`document.querySelector('[aria-label="open wallet"]').click()`, true);
  const events12dStart = cx10.events.length;
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'credits form under lock');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '5';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // The unlock form mounts under the credits form as `.credits-field
  // .card-unlock`, never in a confirm.
  await cx10.waitFor(`!!document.querySelector('.credits-field .card-unlock form.pf input[type="password"]')`, 'card-unlock 12d');
  const unlockMounted12d = await cx10.eval(`!!document.querySelector('.credits-field .card-unlock form.pf input[type="password"]')`);
  const noConfirmLocked12d = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const promptSeen12d = await findExt('prompt.html');
  const transferSeen12dLocked = cx10.events.slice(events12dStart).some((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').includes('/credits/transfer'));
  await cx10.eval(`(() => {
    const form = document.querySelector('.credits-field .card-unlock form.pf');
    const pw = form.querySelector('input[type="password"]');
    pw.value = ${JSON.stringify(PASSPHRASE)};
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  await sleep(3000);
  const prompt12dFirst = await findExt('prompt.html');
  if (prompt12dFirst) {
    const cxp = await openSession(prompt12dFirst.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'prompt 12d first (decline)');
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  await sleep(2000);
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'credits form for 12d second send');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '2';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // The resolved-key hint reveals; there must be no second `.card-unlock`
  // — the closure's `cur.identity.locked` is false after the first unlock.
  await cx10.waitFor(
    `(() => { const r = document.querySelector('.credits-field form.credits-form .resolved-key'); return !!r && !r.hidden; })()`,
    'resolved-key visible 12d second',
  );
  await sleep(1000);
  const unlockMounted12dSecond = await cx10.eval(`!!document.querySelector('.credits-field .card-unlock')`);
  const noConfirmSecond12d = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const prompt12dSecond = await findExt('prompt.html');
  if (prompt12dSecond) {
    const cxp = await openSession(prompt12dSecond.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'prompt 12d second (decline)');
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  record('12d',
    lockedSession12d === null && unlockMounted12d && noConfirmLocked12d && !promptSeen12d && !transferSeen12dLocked && !!prompt12dFirst && !unlockMounted12dSecond && noConfirmSecond12d && !!prompt12dSecond,
    `session empty=${lockedSession12d === null}, unlock under form=${unlockMounted12d}, no .pf-confirm under lock=${noConfirmLocked12d}, no prompt under lock=${!promptSeen12d}, no /credits/transfer under lock=${!transferSeen12dLocked}, first-send prompt after unlock=${!!prompt12dFirst}, second-send .card-unlock absent=${!unlockMounted12dSecond}, second-send .pf-confirm absent=${noConfirmSecond12d}, second-send prompt seen=${!!prompt12dSecond}`);

  // -------------------------------------------------------------------------
  // Steps 13–16 — WEB_INTERFACE → The extension → "Links into the extension".
  // Without --public and --web-dist the four are reported NOT RUN by name,
  // never PASS, never silently absent.
  // -------------------------------------------------------------------------
  if (PUBLIC === null) {
    record(13, 'NOT RUN', 'no --public / --web-dist — the harness serves no hosted origin');
    record(14, 'NOT RUN', 'no --public / --web-dist');
    record(15, 'NOT RUN', 'no --public / --web-dist');
    record(16, 'NOT RUN', 'no --public / --web-dist');
    return;
  }

  const postId = await pickOwnRootPostId();
  if (postId === null) {
    record(13, false, 'no confirmed root post authored by R — nothing to link to');
    record(14, false, 'no confirmed root post authored by R');
    record(15, false, 'no confirmed root post authored by R');
    record(16, false, 'no confirmed root post authored by R');
    return;
  }
  console.log(`steps 13-16 link target = <public>p/${postId.slice(0, 8)}…`);

  const bcx = await openBrowserSession();
  const publicLink = publicOrigin + publicBase + 'p/' + postId;
  const plainLink = publicOrigin + '/link.html?id=' + postId;
  const baseUrl = publicOrigin + publicBase;

  // The bridge's user-activation check reads navigator.userActivation.isActive.
  // Headless Chromium's window is 0×0 unless a viewport is set — a click at
  // (0,0) hits the browser chrome, not the page. Set a viewport now so
  // Input.dispatchMouseEvent lands inside the page for every hosted target.
  await bcx.call('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false }).catch(() => {});

  async function readNotisOpenKeys(cxToUse) {
    return await cxToUse.eval(`(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.keys(all).filter(k => k.startsWith('notis.open.'));
    })()`);
  }

  // Wait for `Target.targetDestroyed` for a given target from a caller-passed
  // start index. The index must be taken BEFORE the target is created — a
  // destruction fired inside the microseconds between `Target.createTarget`
  // and the caller's own wait would otherwise sit at an index BEFORE `bcx.events.length`
  // at wait time, and a wait taking its own index in-body would step past it
  // (WEB_INTERFACE → The extension → "Links into the extension"). Returns the
  // event's arrival stamp (from `ev.__at`), so wall time is a difference in
  // that clock.
  async function waitForDestroyEvent(targetId, startIdx, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      for (let i = startIdx; i < bcx.events.length; i++) {
        const ev = bcx.events[i];
        if (ev.method === 'Target.targetDestroyed' && ev.params?.targetId === targetId) {
          return ev.__at ?? Date.now();
        }
      }
      await sleep(50);
    }
    return null;
  }

  // The raw event sequence for one target from the browser-session, between
  // two indices — `Target.targetCreated`, `Target.targetInfoChanged*`,
  // `Target.targetDestroyed`, each with its arrival stamp and the URL it
  // carried at the time.
  function collectTargetEvents(targetId, startIdx, endIdx) {
    const end = endIdx ?? bcx.events.length;
    const out = [];
    for (let i = startIdx; i < end; i++) {
      const ev = bcx.events[i];
      const info = ev.params?.targetInfo;
      const idHere = ev.method === 'Target.targetDestroyed' ? ev.params?.targetId : info?.targetId;
      if (idHere !== targetId) continue;
      if (ev.method !== 'Target.targetCreated'
          && ev.method !== 'Target.targetInfoChanged'
          && ev.method !== 'Target.targetDestroyed') continue;
      out.push({
        method: ev.method,
        at: ev.__at ?? null,
        url: info?.url ?? null,
        openerId: info?.openerId ?? null,
      });
    }
    return out;
  }

  // ------- Step 13 — pref `on the site`, the button arm. The browser-context
  // arm ("13-uncancelled") is run AFTER step 16: `Target.createBrowserContext`
  // + `Target.disposeBrowserContext` has been observed to freeze the next CDP
  // call in a same-browser session, so it runs last where a freeze cannot
  // shadow the other steps.
  const step13Prefs = await setLinksPrefViaUi(cx10, 'site');
  if (step13Prefs !== 'site') {
    record(13, false, `pref did not take: notis.links=${step13Prefs}`);
  } else {
    // Fresh target on the post's public link — the destruction event may
    // arrive before this line returns, so the browser event index is taken
    // BEFORE the call.
    const startIdx13 = bcx.events.length;
    const created13 = await bcx.call('Target.createTarget', { url: publicLink });
    const hostedId13 = created13.targetId;
    const hostedInfo13 = await findTargetById(hostedId13, 15000);
    let stepStatus13 = false;
    let boot13ok = false;
    let takeoverDidNotFire13 = false;
    let destroyed13ok = false;
    let firstColumnHasThread13 = false;
    let extActive13 = false;
    let noOpen13 = false;
    if (!hostedInfo13) {
      record(13, false, `hosted target ${hostedId13.slice(0, 8)}… never appeared in /json/list`);
    } else {
      const cxH13 = await openSession(hostedInfo13.webSocketDebuggerUrl);
      // Wait for the App to boot to the standalone thread.
      try {
        await cxH13.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, 'hosted root card 13', 30000);
        boot13ok = true;
      } catch {}
      const url13boot = await cxH13.eval(`location.href`);
      // The takeover did not fire — the tab was not redirected under `site`.
      takeoverDidNotFire13 = url13boot === publicLink;
      const openKeysBefore13 = await readNotisOpenKeys(cx10);
      // Trusted press on `add to workspace`.
      let clickErr13 = null;
      try { await trustedClickAt(cxH13, '[aria-label="add this thread to your workspace"]'); }
      catch (e) { clickErr13 = String(e); }
      // The hosted target destroyed; the extension page's first column holds the thread.
      const destAt13 = await waitForDestroyEvent(hostedId13, startIdx13, 15000);
      destroyed13ok = destAt13 !== null;
      try {
        await cx10.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first column holds thread 13', 15000);
        firstColumnHasThread13 = true;
      } catch {}
      extActive13 = await cx10.eval(`(async () => {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const me = tabs.find(t => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
        return !!me;
      })()`);
      const openKeysAfter13 = await readNotisOpenKeys(cx10);
      // The offer left no pending record — takeOpen consumed it, so the
      // count returns to what it was before (WEB_INTERFACE → The extension →
      // "Both messages end in one act, landing the thread in the workspace").
      noOpen13 = openKeysAfter13.length === openKeysBefore13.length && openKeysAfter13.length === 0;
      try { cxH13.s.close(); } catch {}
      console.log(`step 13 button: url@boot=${url13boot}, click=${clickErr13 ?? 'ok'}, dest@ms=${destAt13 ?? 'null'}, firstCol=${firstColumnHasThread13}, extActive=${extActive13}, openKeys before=${JSON.stringify(openKeysBefore13)} after=${JSON.stringify(openKeysAfter13)}`);

      stepStatus13 = boot13ok && takeoverDidNotFire13 && destroyed13ok && firstColumnHasThread13 && extActive13 && noOpen13;
      record(13, stepStatus13,
        `boot=${boot13ok} (url ${url13boot}), takeover-did-not-fire=${takeoverDidNotFire13}, hosted destroyed=${destroyed13ok} (@${destAt13 ?? 'null'}ms), first column has thread=${firstColumnHasThread13}, ext tab active=${extActive13}, no notis.open. key=${noOpen13}`);
    }
  }

  // ------- Step 14 — pref `here`, a workspace tab open, three runs incl. cold.
  // The step probes cx10 at start — a short evaluate against a 5 s race,
  // /json/list for the extension page, `document.visibilityState`,
  // `document.hasFocus()` — and calls `Target.activateTarget` on the page if
  // its visibility is hidden. The bridge-less arm's browser-context work is
  // deferred to run AFTER step 16, so cx10 is expected to be responsive here.
  const probeAt14 = {
    listHasExt: null,
    probeMs: null,
    probeValue: null,
    visibility: null,
    hasFocus: null,
    activateTried: false,
    activateAfterProbe: null,
  };
  {
    const t0p = Date.now();
    const listNow = await jsonList();
    const extPageNow = listNow.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
    probeAt14.listHasExt = !!extPageNow;
    const probeP = (async () => {
      try { return await cx10.eval(`1+1`); } catch (e) { return { error: String(e) }; }
    })();
    const raceP = new Promise((res) => setTimeout(() => res({ timeout: true }), 5000));
    const probeR = await Promise.race([probeP, raceP]);
    probeAt14.probeMs = Date.now() - t0p;
    probeAt14.probeValue = probeR;
    try {
      probeAt14.visibility = await Promise.race([
        cx10.eval(`document.visibilityState`),
        new Promise((res) => setTimeout(() => res(null), 3000)),
      ]);
      probeAt14.hasFocus = await Promise.race([
        cx10.eval(`document.hasFocus()`),
        new Promise((res) => setTimeout(() => res(null), 3000)),
      ]);
    } catch {}
    if (extPageNow && (probeR?.timeout === true || probeAt14.visibility === 'hidden')) {
      probeAt14.activateTried = true;
      try { await bcx.call('Target.activateTarget', { targetId: extPageNow.targetId }); } catch {}
      const probeAgain = await Promise.race([
        (async () => { try { return await cx10.eval(`1+1`); } catch (e) { return { error: String(e) }; } })(),
        new Promise((res) => setTimeout(() => res({ timeout: true }), 5000)),
      ]);
      probeAt14.activateAfterProbe = probeAgain;
    }
    console.log(`step 14 probe: listHasExt=${probeAt14.listHasExt}, probeMs=${probeAt14.probeMs}, probe=${JSON.stringify(probeAt14.probeValue)}, visibility=${probeAt14.visibility}, hasFocus=${probeAt14.hasFocus}, activateTried=${probeAt14.activateTried}, afterActivate=${JSON.stringify(probeAt14.activateAfterProbe)}`);
  }

  const step14Prefs = await setLinksPrefViaUi(cx10, 'here');
  if (step14Prefs !== 'here') {
    record(14, false, `pref did not take: notis.links=${step14Prefs}; probe=${JSON.stringify(probeAt14)}`);
  } else {
    const runs14 = [];
    for (let r = 0; r < 3; r++) {
      const cold = r === 2;
      if (cold) {
        // Let any live worker die by a ≥ 32 s idle wait — step 8's rule.
        console.log(`step 14 run 3: idle-waiting 32s for MV3 SW termination…`);
        await sleep(32000);
      }
      const openKeysBefore14 = await readNotisOpenKeys(cx10);
      // Index into the browser session's events and the static server's
      // request log, taken BEFORE the createTarget so a destruction that
      // fires inside the first microseconds is still visible to the wait.
      const evStart14 = bcx.events.length;
      const reqStart14 = webRequests.length;
      const t0 = Date.now();
      const created14 = await bcx.call('Target.createTarget', { url: publicLink });
      const tid14 = created14.targetId;
      const info14 = await findTargetById(tid14, 15000);
      let mounted14 = null;
      let cxT14 = null;
      if (info14) {
        try {
          cxT14 = await openSession(info14.webSocketDebuggerUrl);
          // Poll `#appbar` children — record whether the hosted App mounted
          // before the destruction. Bail out on any eval error (a destroying
          // target rejects Runtime.evaluate). Recorded, never asserted — a
          // CDP session attached to a tab that lives tens of milliseconds is
          // a race the harness loses; the static server's request log is the
          // measurement from outside.
          const t1 = Date.now();
          while (Date.now() - t1 < 15000) {
            const has = await cxT14.eval(`(document.querySelector('#appbar')?.children.length ?? 0) > 0`).catch(() => 'gone');
            if (has === true) { mounted14 = true; break; }
            if (has === 'gone') { break; }
            await sleep(50);
          }
        } catch {}
      }
      const destAt14 = await waitForDestroyEvent(tid14, evStart14, 20000);
      const elapsed14 = destAt14 === null ? null : destAt14 - t0;
      try { if (cxT14) cxT14.s.close(); } catch {}
      // Read /json/list AFTER the wait — the arriving target absent AND
      // exactly one extension page target — that count tells the close arm
      // from the re-point arm.
      const listAfter14 = await jsonList();
      const arrivedGone14 = !listAfter14.find((t) => t.id === tid14);
      const extPagesAfter14 = listAfter14.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
      const extPageCount14 = extPagesAfter14.length;
      // First column has the thread; extension tab is active. The record was
      // consumed by takeOpen — no `notis.open.` key remains.
      let firstColOk = false;
      try {
        await cx10.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first col 14', 15000);
        firstColOk = true;
      } catch {}
      const extActive14 = await cx10.eval(`(async () => {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const me = tabs.find(t => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
        return !!me;
      })()`);
      const openKeysAfter14 = await readNotisOpenKeys(cx10);
      const noOpen14 = openKeysAfter14.length === openKeysBefore14.length;
      // The arriving target's own event sequence — targetCreated →
      // targetInfoChanged* → targetDestroyed — each with its ms since t0.
      const targetEvents14 = collectTargetEvents(tid14, evStart14, bcx.events.length).map((e) => ({
        method: e.method,
        ms: e.at === null ? null : e.at - t0,
        url: e.url,
      }));
      // The static server's request log for this run — from t0 to 500 ms
      // after the destroyed event (or 15 s after t0 if no destruction). The
      // shell alone, or the bundle, the stylesheet, the fonts — how far the
      // hosted page got, measured from outside.
      const reqWindowEnd14 = destAt14 !== null ? destAt14 + 500 : t0 + 15000;
      const reqLog14 = webRequests.slice(reqStart14).filter((q) => q.at <= reqWindowEnd14).map((q) => ({ path: q.path, ms: q.at - t0 }));
      const run = {
        cold, tid: tid14.slice(0, 8), mounted: mounted14, elapsedMs: elapsed14,
        firstCol: firstColOk, extActive: extActive14, noOpen: noOpen14,
        arrivedGone: arrivedGone14, extPageCount: extPageCount14,
        targetEvents: targetEvents14, reqLog: reqLog14,
      };
      runs14.push(run);
      console.log(`step 14 run ${r + 1}${cold ? ' (cold)' : ''}: dest@${elapsed14 ?? 'null'}ms, arrivedGone=${arrivedGone14}, extPages=${extPageCount14}, appbarMountedBeforeDestroy=${mounted14 ?? 'unobserved'}, firstCol=${firstColOk}, extActive=${extActive14}, noOpen=${noOpen14}`);
      console.log(`step 14 run ${r + 1} events for tid=${tid14.slice(0, 8)}: ${JSON.stringify(targetEvents14)}`);
      console.log(`step 14 run ${r + 1} static server: ${JSON.stringify(reqLog14)}`);
    }
    const allDestroyed14 = runs14.every((r) => r.elapsedMs !== null);
    const allArrivedGone14 = runs14.every((r) => r.arrivedGone === true);
    const allOneExtPage14 = runs14.every((r) => r.extPageCount === 1);
    const allFirstCol14 = runs14.every((r) => r.firstCol);
    const allExtActive14 = runs14.every((r) => r.extActive);
    const allNoOpen14 = runs14.every((r) => r.noOpen);
    record(14, allDestroyed14 && allArrivedGone14 && allOneExtPage14 && allFirstCol14 && allExtActive14 && allNoOpen14,
      `three runs: destroyed=${allDestroyed14}, arrivedGone=${allArrivedGone14}, extPageCount==1=${allOneExtPage14}, first col holds thread=${allFirstCol14}, ext tab active=${allExtActive14}, no notis.open. key remained=${allNoOpen14}; timings ms=${JSON.stringify(runs14.map((r) => ({ cold: r.cold, ms: r.elapsedMs, extPages: r.extPageCount, mounted: r.mounted })))}`);
  }

  // ------- Step 15 — pref `here`, no workspace tab. Close the extension's tab
  //         first; a fresh target on the link should have its URL become the
  //         extension page (WEB_INTERFACE → The extension → "Both messages
  //         end in one act, landing the thread in the workspace").
  {
    // Find and close cx10's target.
    const extPage = await findExt('index.html');
    const extPageId = extPage?.id ?? null;
    try { cx10.s.close(); } catch {}
    let closed15 = false;
    if (extPageId) {
      await bcx.call('Target.closeTarget', { targetId: extPageId }).catch(() => {});
      closed15 = await waitForTargetGone(extPageId, 15000);
    }
    await sleep(1500);
    const openKeysBefore15 = null; // no ext page to read from yet
    const created15 = await bcx.call('Target.createTarget', { url: publicLink });
    const tid15 = created15.targetId;
    // The extension redirects the tab in place. Wait for the target's URL to
    // become the extension page.
    let becameExtension15 = false;
    let cx15 = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const list = await jsonList();
      const t = list.find((x) => x.id === tid15);
      if (t && typeof t.url === 'string' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)) {
        becameExtension15 = true;
        cx15 = await openSession(t.webSocketDebuggerUrl);
        break;
      }
      await sleep(150);
    }
    let firstColOk15 = false;
    let noOpen15 = false;
    let backUrl15 = null;
    let backCount15 = 0;
    let backReached15 = false;
    let backStays15 = false;
    let backHostedCard15 = false;
    let backHistoryLen15Ok = false;
    let backHistoryLen15Value = null;
    let backHistoryLen15SingleEntry = false;
    let initialHist15 = null;
    let initialWidth15 = null;
    const backSteps15 = [];
    if (cx15) {
      try {
        await cx15.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first col 15', 30000);
        firstColOk15 = true;
      } catch {}
      const openKeysAfter15 = await readNotisOpenKeys(cx15);
      noOpen15 = openKeysAfter15.length === 0;
      console.log(`step 15: closed=${closed15}, becameExtension=${becameExtension15}, firstCol=${firstColOk15}, notis.open. keys=${JSON.stringify(openKeysAfter15)}`);

      // Step 16(c) — history.back on the re-pointed tab. The workspace
      // pushes a screen entry when a thread opens under one column, so
      // reaching the hosted URL may take more than one back. Log innerWidth,
      // history.length and history.state BEFORE every back; iterate at most
      // three; wait after each on a settle condition — the URL or the state
      // changing, never a bare sleep — and stop when the URL is the hosted
      // link. If `history.length` reads 1 in the re-pointed tab right after
      // its boot, `tabs.update({ url })` replaced the hosted entry and back
      // cannot reach the website at all — record that and do not iterate.
      initialHist15 = await cx15.eval(`history.length`);
      const initialUrl15 = await cx15.eval(`location.href`);
      initialWidth15 = await cx15.eval(`innerWidth`);
      const initialState15 = await cx15.eval(`JSON.stringify(history.state)`);
      backSteps15.push({ before: 'initial', width: initialWidth15, historyLength: initialHist15, historyState: initialState15, url: initialUrl15 });
      if (initialHist15 === 1) {
        backHistoryLen15SingleEntry = true;
        console.log(`step 16(c) history.length=1 on the re-pointed tab: tabs.update({ url }) replaced the hosted entry — no back can reach the website.`);
      } else {
        for (let attempt = 0; attempt < 3 && !backReached15; attempt++) {
          const before = {
            attempt,
            width: await cx15.eval(`innerWidth`),
            historyLength: await cx15.eval(`history.length`),
            historyState: await cx15.eval(`JSON.stringify(history.state)`),
            url: await cx15.eval(`location.href`),
          };
          backSteps15.push({ before: 'before back ' + attempt, ...before });
          const priorUrl = before.url;
          const priorState = before.historyState;
          await cx15.eval(`history.back()`);
          backCount15 += 1;
          const t0b = Date.now();
          while (Date.now() - t0b < 5000) {
            const urlNow = await cx15.eval(`location.href`).catch(() => priorUrl);
            const stateNow = await cx15.eval(`JSON.stringify(history.state)`).catch(() => priorState);
            if (urlNow !== priorUrl || stateNow !== priorState) break;
            await sleep(50);
          }
          const urlAfter = await cx15.eval(`location.href`).catch(() => priorUrl);
          const stateAfter = await cx15.eval(`JSON.stringify(history.state)`).catch(() => priorState);
          backSteps15.push({ before: 'after back ' + attempt, url: urlAfter, historyState: stateAfter });
          if (urlAfter === publicLink) { backReached15 = true; break; }
        }
        if (backReached15) {
          try { await cx15.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, '16c hosted card', 15000); } catch {}
          backHostedCard15 = await cx15.eval(`!!document.querySelector('.card[data-post-id="${postId}"]')`);
          await sleep(2000);
          backUrl15 = await cx15.eval(`location.href`);
          backStays15 = backUrl15 === publicLink;
          backHistoryLen15Value = await cx15.eval(`history.length`);
          backHistoryLen15Ok = typeof backHistoryLen15Value === 'number' && backHistoryLen15Value >= 2;
        }
      }
      console.log(`step 16(c) history.back: initial history.length=${initialHist15}, attempts=${backCount15}, reached=${backReached15}, urlAfter=${backUrl15}, stays=${backStays15}, hosted card=${backHostedCard15}, history.length on hosted=${backHistoryLen15Value}, singleEntry=${backHistoryLen15SingleEntry}, steps=${JSON.stringify(backSteps15)}`);
    }
    record(15, closed15 && becameExtension15 && firstColOk15 && noOpen15,
      `ext tab closed=${closed15}, fresh target URL becomes extension=${becameExtension15}, first col holds thread=${firstColOk15}, no notis.open. key=${noOpen15}`);

    // ------- Step 16 — pref `here`, left alone. (a) same-tab click on the
    // plain page's link → hosted page boots and stays; (b) reload of a hosted
    // thread page → stays; (c) history.back() in step 15's tab → hosted page,
    // stays (measured above); (d) target="_blank" from the plain page → taken
    // over — the control for (a).
    let same16a_url = null, same16a_hist = null, same16a_stays = false;
    let reload16b_url = null, reload16b_stays = false;
    let blank16d_destroyed = false, blank16d_firstCol = false;
    // (a): open a fresh target on the plain page, click #same, then wait.
    const createdA = await bcx.call('Target.createTarget', { url: plainLink });
    const tidA = createdA.targetId;
    const infoA = await findTargetById(tidA, 15000);
    if (infoA) {
      const cxA = await openSession(infoA.webSocketDebuggerUrl);
      try { await cxA.waitFor(`!!document.querySelector('#same')`, 'plain page a-same', 10000); } catch {}
      // Trusted click on the same-tab link.
      try { await trustedClickAt(cxA, '#same'); } catch {}
      // Wait for the navigation to land on the hosted post URL.
      const t0a = Date.now();
      while (Date.now() - t0a < 15000) {
        const u = await cxA.eval(`location.href`).catch(() => null);
        if (u === publicLink) break;
        await sleep(150);
      }
      same16a_url = await cxA.eval(`location.href`);
      try { await cxA.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, '16a hosted card', 20000); } catch {}
      // Sleep 2s and assert it stays.
      await sleep(2000);
      const url16aAfter = await cxA.eval(`location.href`);
      same16a_hist = await cxA.eval(`history.length`);
      same16a_stays = url16aAfter === publicLink && same16a_hist === 2;
      // (b): reload this hosted page.
      await cxA.call('Page.reload');
      await sleep(3000);
      try { await cxA.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, '16b hosted card', 20000); } catch {}
      reload16b_url = await cxA.eval(`location.href`);
      reload16b_stays = reload16b_url === publicLink && (await cxA.eval(`!!document.querySelector('.card[data-post-id="${postId}"]')`)) === true;
      try { cxA.s.close(); } catch {}
      await bcx.call('Target.closeTarget', { targetId: tidA }).catch(() => {});
    }
    console.log(`step 16(a) same-tab: url=${same16a_url}, history.length=${same16a_hist}, stays=${same16a_stays}`);
    console.log(`step 16(b) reload:   url=${reload16b_url}, stays=${reload16b_stays}`);

    // (d): open a fresh plain page, trusted click on #blank. The tab opens
    // by `_blank`; its precondition is that zero extension page targets are
    // open, so the takeover arm is the redirect (no destruction), and the
    // measured expectation is the new tab's URL becomes the extension page,
    // the thread in the first column, no `notis.open.` key left, and exactly
    // one extension page target — never asserted as a union.

    // Close step 15's tab so no live extension page target stands.
    let cx15Closed16d = false;
    if (cx15) {
      try { cx15.s.close(); } catch {}
      cx15 = null;
      try { await bcx.call('Target.closeTarget', { targetId: tid15 }); } catch {}
      cx15Closed16d = await waitForTargetGone(tid15, 15000);
    }
    const listPre16d = await jsonList();
    const extPagesPre16d = listPre16d.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));

    let blank16d_newTargetId = null;
    let blank16d_openerIdPresent = null;
    let blank16d_urlSeen = null;
    let blank16d_becameExtension = false;
    let blank16d_takenOver = false;
    let blank16d_noOpenKey = false;
    let blank16d_extPageCount = null;
    if (extPagesPre16d.length !== 0) {
      // Precondition failed — the takeover arm this step controls for is not
      // the arm that would run; report and skip.
      record(16, false,
        `precondition failed for (d): after cx15 tab close, /json/list still has ${extPagesPre16d.length} extension page target(s); (a) stays=${same16a_stays}, (b) stays=${reload16b_stays}, (c) reached=${backReached15}, stays=${backStays15}, url ${backUrl15}, history.length ${backHistoryLen15Value}, singleEntry=${backHistoryLen15SingleEntry}, steps=${JSON.stringify(backSteps15)}`);
    } else {
      const createdD = await bcx.call('Target.createTarget', { url: plainLink });
      const tidD = createdD.targetId;
      const infoD = await findTargetById(tidD, 15000);
      if (infoD) {
        const cxD = await openSession(infoD.webSocketDebuggerUrl);
        try { await cxD.waitFor(`!!document.querySelector('#blank')`, 'plain page d-blank', 10000); } catch {}
        // Known page target ids taken BEFORE the click — anything opening
        // after with a fresh id and (when the runtime carries it) an
        // `openerId` of `tidD` is the popup this click created; else fall
        // back to the first fresh page id.
        const listBeforeClick = await jsonList();
        const knownIds = new Set(listBeforeClick.filter((t) => t.type === 'page').map((t) => t.id));
        const startIdx = bcx.events.length;
        try { await trustedClickAt(cxD, '#blank'); } catch {}
        // Discover the new target by openerId first, else by any fresh page
        // id — never by URL, because `Target.targetCreated` for a link-opened
        // tab announces with an empty URL, and the real URL arrives in a
        // later `Target.targetInfoChanged`.
        const t0d = Date.now();
        while (Date.now() - t0d < 15000 && !blank16d_newTargetId) {
          for (let i = startIdx; i < bcx.events.length; i++) {
            const ev = bcx.events[i];
            if (ev.method !== 'Target.targetCreated') continue;
            const info = ev.params?.targetInfo;
            if (!info || info.type !== 'page') continue;
            if (info.openerId === tidD) {
              blank16d_newTargetId = info.targetId;
              blank16d_openerIdPresent = true;
              break;
            }
          }
          if (blank16d_newTargetId) break;
          for (let i = startIdx; i < bcx.events.length; i++) {
            const ev = bcx.events[i];
            if (ev.method !== 'Target.targetCreated') continue;
            const info = ev.params?.targetInfo;
            if (!info || info.type !== 'page') continue;
            if (info.targetId === tidD) continue;
            if (knownIds.has(info.targetId)) continue;
            blank16d_newTargetId = info.targetId;
            blank16d_openerIdPresent = false;
            break;
          }
          if (!blank16d_newTargetId) await sleep(100);
        }
        if (blank16d_newTargetId) {
          // Follow `Target.targetInfoChanged` for the URL; the takeover ends
          // with the extension page URL (no live workspace tab existed at
          // the click). `/json/list` is polled as a second reader in case a
          // changed event is missed.
          const t1 = Date.now();
          let extInfo = null;
          while (Date.now() - t1 < 20000) {
            for (let i = startIdx; i < bcx.events.length; i++) {
              const ev = bcx.events[i];
              if (ev.method !== 'Target.targetInfoChanged') continue;
              const info = ev.params?.targetInfo;
              if (info?.targetId !== blank16d_newTargetId) continue;
              if (typeof info.url === 'string' && info.url.startsWith(`chrome-extension://${EXT_ID}/`)) {
                blank16d_urlSeen = info.url;
                break;
              }
            }
            if (blank16d_urlSeen) break;
            const list = await jsonList();
            const t = list.find((x) => x.id === blank16d_newTargetId);
            if (t && typeof t.url === 'string' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)) {
              blank16d_urlSeen = t.url;
              extInfo = t;
              break;
            }
            await sleep(150);
          }
          blank16d_becameExtension = blank16d_urlSeen !== null;
          blank16d_takenOver = blank16d_becameExtension;
          // First col holds the thread — in the redirected new tab, and the
          // ledger's `notis.open.` key was consumed.
          if (blank16d_becameExtension) {
            if (!extInfo) {
              const list = await jsonList();
              extInfo = list.find((x) => x.id === blank16d_newTargetId);
            }
            if (extInfo?.webSocketDebuggerUrl) {
              const cxNew = await openSession(extInfo.webSocketDebuggerUrl);
              try {
                await cxNew.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first col 16d new tab', 15000);
                blank16d_firstCol = true;
              } catch {}
              try {
                const remaining = await readNotisOpenKeys(cxNew);
                blank16d_noOpenKey = remaining.length === 0;
              } catch {}
              try { cxNew.s.close(); } catch {}
            }
            const listEnd = await jsonList();
            blank16d_extPageCount = listEnd.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)).length;
          }
        }
        try { cxD.s.close(); } catch {}
        await bcx.call('Target.closeTarget', { targetId: tidD }).catch(() => {});
      }
      console.log(`step 16(d) target=_blank: cx15Closed=${cx15Closed16d}, extPagesPre=${extPagesPre16d.length}, newTarget=${blank16d_newTargetId ? blank16d_newTargetId.slice(0, 8) + '…' : 'null'}, openerIdPresent=${blank16d_openerIdPresent}, urlSeen=${blank16d_urlSeen}, becameExtension=${blank16d_becameExtension}, firstCol=${blank16d_firstCol}, noOpenKey=${blank16d_noOpenKey}, extPageCount=${blank16d_extPageCount}`);

      const step16Pass = same16a_stays && reload16b_stays
        && backReached15 && backStays15 && backHostedCard15 && backHistoryLen15Ok
        && blank16d_takenOver && blank16d_firstCol && blank16d_noOpenKey && blank16d_extPageCount === 1;
      record(16, step16Pass,
        `(a) same-tab stays=${same16a_stays} (url ${same16a_url}, history.length ${same16a_hist}); (b) reload stays=${reload16b_stays} (url ${reload16b_url}); (c) history.back reached=${backReached15} in ${backCount15} back(s) (initialWidth=${initialWidth15}, initialHistoryLen=${initialHist15}, singleEntry=${backHistoryLen15SingleEntry}), stays=${backStays15} (url ${backUrl15}, hostedCard=${backHostedCard15}, history.length=${backHistoryLen15Value}, ≥2=${backHistoryLen15Ok}), steps=${JSON.stringify(backSteps15)}; (d) precondition extPagesPre=${extPagesPre16d.length}, cx15Closed=${cx15Closed16d}, openerIdPresent=${blank16d_openerIdPresent}, becameExtension=${blank16d_becameExtension}, first col=${blank16d_firstCol}, noOpenKey=${blank16d_noOpenKey}, extPageCount=${blank16d_extPageCount}`);
    }

    try { if (cx15) cx15.s.close(); } catch {}
  }

  // ------- Step 13-uncancelled — the browser-context arm, run after step 16.
  // The extension does not load in a `Target.createBrowserContext` context
  // (per `--load-extension`'s default profile scope), so the bridge cannot
  // send `arrived` and no `notis.open.` key appears. `Target.disposeBrowserContext`
  // has been observed to freeze the next CDP call in a same-browser session,
  // and running the arm here keeps that risk out of steps 14–16.
  {
    let extPageAfter16 = await findExt('index.html');
    let cxObserver = null;
    let openBeforeArm = null;
    try {
      if (extPageAfter16?.webSocketDebuggerUrl) {
        cxObserver = await openSession(extPageAfter16.webSocketDebuggerUrl);
        openBeforeArm = await readNotisOpenKeys(cxObserver);
      }
      let bctxId = null;
      try {
        const ctxRes = await bcx.call('Target.createBrowserContext', {});
        bctxId = ctxRes.browserContextId;
        const arm = await bcx.call('Target.createTarget', { url: publicLink, browserContextId: bctxId });
        const armId = arm.targetId;
        const armInfo = await findTargetById(armId, 15000);
        if (!armInfo) {
          record('13-uncancelled', false, `fresh target in browser context never appeared`);
        } else {
          const cxArm = await openSession(armInfo.webSocketDebuggerUrl);
          try {
            await cxArm.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, 'arm root card', 30000);
          } catch {}
          const openMid = cxObserver ? await readNotisOpenKeys(cxObserver) : null;
          const bridgeAbsentPreClick = openMid !== null && openBeforeArm !== null && openMid.length === openBeforeArm.length;
          let armClickErr = null;
          try { await trustedClickAt(cxArm, '[aria-label="add this thread to your workspace"]'); }
          catch (e) { armClickErr = String(e); }
          await sleep(2000);
          const armUrl = await cxArm.eval(`location.href`).catch(() => null);
          const armInPlace = armUrl === baseUrl;
          const openAfterArm = cxObserver ? await readNotisOpenKeys(cxObserver) : null;
          const armBridgeAbsent = bridgeAbsentPreClick && openAfterArm !== null && openBeforeArm !== null && openAfterArm.length === openBeforeArm.length;
          console.log(`step 13-uncancelled: click=${armClickErr ?? 'ok'}, url@after=${armUrl}, in-place=${armInPlace}, bridge absent (no new notis.open.)=${armBridgeAbsent}, extPageAfter16=${!!extPageAfter16}`);
          record('13-uncancelled', armInPlace && armBridgeAbsent,
            `url=${armUrl} in-place=${armInPlace}, bridge absent=${armBridgeAbsent} (openBefore=${JSON.stringify(openBeforeArm)}, openAfter=${JSON.stringify(openAfterArm)}); observer extPage=${!!extPageAfter16}`);
          try { cxArm.s.close(); } catch {}
          await bcx.call('Target.closeTarget', { targetId: armId }).catch(() => {});
        }
      } finally {
        if (bctxId) await bcx.call('Target.disposeBrowserContext', { browserContextId: bctxId }).catch(() => {});
      }
    } catch (e) {
      record('13-uncancelled', false, `error: ${String(e)}`);
    } finally {
      try { if (cxObserver) cxObserver.s.close(); } catch {}
    }
  }

  try { bcx.s.close(); } catch {}
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error('proof failed:', e);
  exitCode = 1;
}

console.log('\n=== SUMMARY ===');
for (const r of findings) console.log(`  step ${r.step}: ${r.status} — ${r.detail}`);
const pass = findings.filter((f) => f.status === 'PASS').length;
const fail = findings.filter((f) => f.status === 'FAIL').length;
const skipped = findings.filter((f) => f.status === 'SKIPPED').length;
// One measurement per top-level step. Step 12's sub-parts (12a…12d) collapse
// into step 12; the summary line reads what WEB_INTERFACE → The extension asks.
const measured = new Set(findings.map((f) => String(f.step).replace(/[a-d]$/, ''))).size;
console.log(`\n${measured} measured (${pass} PASS, ${fail} FAIL, ${skipped} SKIPPED)`);
console.log(JSON.stringify({ measured, pass, fail, skipped, findings }, null, 2));
if (fail > 0) exitCode = 1;

proc.kill();
if (webServer) await new Promise((r) => webServer.close(() => r()));
process.exit(exitCode);
