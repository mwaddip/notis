#!/usr/bin/env node
// The screens for the first-timers docs page — a seeded devnet notice board
// plus a walkthrough that drives the extension's own page in headless Chromium
// and saves one PNG per step. ⛔ DEVNET ONLY: it refuses any node whose
// /status.networkType is not `devnet`, and refuses any node or faucet whose
// host is not 127.0.0.1 or localhost — notis.fun and node02 are never written
// to by this script.
//
// What this script does, end to end:
//   1. Seeds three sample identities with the faucet's rep grant, each
//      claiming its name, then posting the fixed content below.
//      (NODE_INTERFACE → Faucet; WEB_INTERFACE → The username row.)
//   2. Launches headless Chromium with the unpacked extension loaded, drives
//      a fresh identity through the first run in its own page, and captures
//      a PNG per step at 1440×900 (390×844 for the phone screen).
//
// Preconditions:
//   - Node A reachable over HTTP on 127.0.0.1 or localhost, devnet, mining.
//   - Node B reachable, devnet, synced from A.
//   - The faucet reachable on the same host.
//   - An unpacked devnet extension at --extension-dir with notis-nodes naming
//     A and B and notis-faucet naming the faucet.
//   - Chrome for Testing at $CHROME (or Playwright's cached Chromium).
//
// Flags:
//   --extension-dir <path>              the unpacked extension
//   --nodes <A>,<B>                     or --node <A> and --node-b <B>
//   --faucet <origin>/faucet            the faucet with its /faucet prefix
//   --out <dir>                         where PNGs and shots.json land
//   --scratch <dir>                     for keys (mode 0600), the chromium
//                                       user data dir, and the ext copy
//   --walk-name <name>                  the walker's claimed name (river)
//   --sample-suffix <s>                 appended to every sample name so a
//                                       dev run on an already-seeded chain
//                                       does not collide (empty by default)
//   --reuse-seed <shots.json>           skip seeding; take the sample names
//                                       and seeded post ids from a previous
//                                       run's shots.json. The walker is
//                                       always fresh — the walkthrough builds
//                                       its own identity each run.
//
// Writes four reference PNGs, each serving several docs steps:
//   <out>/profile.png   — the profile window at the moment the claim form
//                         carries the walker's name, after the faucet grant
//                         has landed
//   <out>/workspace.png — the 1440×900 viewport with the feed on the left
//                         and one thread window — the repair café notice
//                         with the walker's own reply beneath it as the
//                         read card
//   <out>/composer.png  — the feed's new-post composer with the walker's
//                         first post typed, not posted
//   <out>/phone.png     — the 390×844 one-column layout
//   <out>/shots.json    — per-file what was captured and the captured area's
//                         innerText, so the docs page's prose can be
//                         written against what is on screen.
//
// Each run uses fresh keys written mode 0600 under --scratch. ⛔ Keys never
// enter the repo, a log or the report. Public keys may; nothing else may.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  args.set(a.slice(2), process.argv[++i]);
}
function flag(name, fallback) {
  const v = args.get(name);
  return v === undefined ? fallback : v;
}
function requiredFlag(name) {
  const v = args.get(name);
  if (!v) die(`missing --${name}`);
  return v;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..', '..');

const EXT_DIR_IN = requiredFlag('extension-dir');
const NODES_FLAG = flag('nodes', null);
let NODE_A;
let NODE_B;
if (NODES_FLAG) {
  const [a, b] = NODES_FLAG.split(',');
  NODE_A = a?.trim();
  NODE_B = b?.trim();
} else {
  NODE_A = requiredFlag('node');
  NODE_B = requiredFlag('node-b');
}
const FAUCET = requiredFlag('faucet');
const OUT_DIR = requiredFlag('out');
const SCRATCH_IN = requiredFlag('scratch');
const WALK_NAME = flag('walk-name', 'river');
const SAMPLE_SUFFIX = flag('sample-suffix', '');
const REUSE_SEED = flag('reuse-seed', null);

// ---------------------------------------------------------------------------
// The hard guard — every origin the script writes to must be loopback.
// Impossible to point this at notis.fun or node02 by argument.
// ---------------------------------------------------------------------------
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/;
for (const [k, v] of [['--node', NODE_A], ['--node-b', NODE_B], ['--faucet', FAUCET]]) {
  if (!LOOPBACK.test(v)) die(`refusing ${k}=${v}: host must be 127.0.0.1 or localhost`);
}

mkdirSync(SCRATCH_IN, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Chromium — Chrome for Testing by $CHROME, else the cached Playwright one.
// The script launches one Chromium of its own, captures its PID, and signals
// only that PID at the end — never a name, never any other process.
// ---------------------------------------------------------------------------
function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const pw = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw)) if (d.startsWith('chromium-')) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(pw, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
const CHROME = findChrome();
if (!CHROME) die('no Chromium found at $CHROME or in ~/.cache/ms-playwright/chromium-*');

const PASSPHRASE = 'docs-shots-pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error('docs-screens: ' + msg);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Thin HTTP helpers for the node and the faucet.
// ---------------------------------------------------------------------------
async function nodeGet(base, path) {
  const res = await fetch(base + path);
  const text = await res.text();
  const body = text === '' ? null : JSON.parse(text);
  if (!res.ok) throw new Error(`GET ${base}${path} → ${res.status} ${text}`);
  return body;
}
async function nodePost(base, path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${base}${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function askKarma(faucetBase, pubkey) {
  const res = await fetch(faucetBase + '/karma', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey }) });
  const data = await res.json();
  if (!res.ok) throw new Error(`faucet /karma → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const karmaBoxes = (k) => k.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
// A seeding wait: 6 minutes covers two or three slow pacer cycles plus a
// pending-queue drain. The browser waits have their own, tighter, bounds.
async function waitFor(what, pred, timeoutMs = 360_000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`);
    await sleep(1500);
  }
}

// ---------------------------------------------------------------------------
// Bundle the e2e builders for Node — same technique as promote.mjs and
// claim-name.mjs, so the one implementation of each tx is used.
// ---------------------------------------------------------------------------
async function loadBuilders() {
  const outDir = mkdtempSync(join(tmpdir(), 'notis-docs-screens-'));
  await build({
    root: WEB,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    ssr: { noExternal: true },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: true,
      lib: { entry: join(HERE, 'entry.ts'), formats: ['es'] },
      rollupOptions: { external: [/^node:/], output: { entryFileNames: 'builders.mjs' } },
    },
  });
  return import(pathToFileURL(join(outDir, 'builders.mjs')).href);
}

// ---------------------------------------------------------------------------
// The seeding — three sample identities, their names and their posts.
// Every text is a fixed string; the strings are the ones the docs page reads.
// ---------------------------------------------------------------------------
// With --reuse-seed, the suffix and sample names come from the previous
// run's shots.json; without it, they come from --sample-suffix.
let SUF = SAMPLE_SUFFIX;
let SAMPLE = {
  marit: 'marit' + SUF,
  jonas: 'jonas' + SUF,
  kofi: 'kofi' + SUF,
};
const POST_1 = '# Repair café on Saturday\nBring a lamp that flickers, a jacket with a torn seam or a bike that clicks. Tools, thread and coffee from 10 to 2 at the library annex.';
const POST_2 = 'Found: keys on a green carabiner, on the bench by the tram stop. Tell me what else is on the ring and they\'re yours.';
const POST_3 = 'Anyone else running a node from home? Curious how you keep it up when the laptop sleeps.';
const REPLY_MARIT = 'Mine lives on an old desktop in the hallway that never sleeps. Happy to compare notes.';
const REPLY_JONAS = 'I set mine to start with the machine. One less thing to remember.';
const POST_6 = 'Minutes from Tuesday\'s residents\' meeting: https://example.org/minutes';
const POST_7 = '![the community garden after the first frost](https://example.org/garden.jpg)';

// The walker's content — fixed strings, so the composer's byte count and the
// thread's reading are the same ones the docs page captures.
const WALKER_POST = 'Hello, board. Trying this out for the first time.';
const WALKER_REPLY = "I'll bring the lamp. Is 11 too late?";

async function seedChain(builders) {
  const { fresh, buildThreadTx, buildReplyTx, buildLikeTx, buildClaimTx } = builders;

  async function grant(label) {
    const key = fresh();
    const file = join(SCRATCH_IN, `${label}.key.json`);
    // mode 0o600 at creation: the file never exists at the default mode
    // for a window between open and chmod.
    writeFileSync(
      file,
      JSON.stringify({ pubKeyHex: key.publicKeyHex, privKeyBase64: key.secretKey.toString('base64') }),
      { mode: 0o600 },
    );
    console.log(`[seed] ${label}: ${key.publicKeyHex.slice(0, 12)}… — asking the faucet`);
    await askKarma(FAUCET, key.publicKeyHex);
    await waitFor(`${label}'s rep to land`, async () => (await nodeGet(NODE_A, `/karma/${key.publicKeyHex}`)).boxCount > 0);
    return key;
  }

  const status = await nodeGet(NODE_A, '/status');
  if (status.networkType !== 'devnet') die(`refusing a ${status.networkType} node — devnet only`);
  const version = status.protocolVersion;
  console.log(`[seed] A ${NODE_A} is devnet, era ${version}`);

  const [marit, jonas, kofi] = await Promise.all([grant(SAMPLE.marit), grant(SAMPLE.jonas), grant(SAMPLE.kofi)]);

  // Claim names, serially, so each claim's pending view reads clean.
  for (const [id, key] of [[SAMPLE.marit, marit], [SAMPLE.jonas, jonas], [SAMPLE.kofi, kofi]]) {
    const k = await nodeGet(NODE_A, `/karma/${key.publicKeyHex}?pending=1`);
    const tx = buildClaimTx(key, karmaBoxes(k), id, k.height, version);
    await nodePost(NODE_A, '/usernames', { tx: tx.json });
    await waitFor(`@${id} to land`, async () => {
      const res = await fetch(NODE_A + `/usernames?owner=${key.publicKeyHex}`);
      return res.ok;
    });
    console.log(`[seed] @${id} held by ${key.publicKeyHex.slice(0, 12)}…`);
  }

  // Posts in the order below so the feed (newest first) reads: 7, 6, 3, 2, 1
  // as roots once the walker's own root is added on top (step 10).
  async function post(key, content) {
    const k = await nodeGet(NODE_A, `/karma/${key.publicKeyHex}?pending=1`);
    const tx = buildThreadTx(key, karmaBoxes(k), content, k.height, version);
    const res = await nodePost(NODE_A, '/posts', { tx: tx.json, content: tx.content });
    await waitFor(`post ${content.slice(0, 24).replace(/\n/g, ' ')}…`, async () => {
      const p = await nodeGet(NODE_A, `/posts/${res.postId}`).catch(() => null);
      return p && p.status === 'confirmed';
    });
    return res.postId;
  }
  async function reply(key, content, parentId, parentAuthorHex) {
    const k = await nodeGet(NODE_A, `/karma/${key.publicKeyHex}?pending=1`);
    const tx = buildReplyTx(key, karmaBoxes(k), content, parentId, parentAuthorHex, k.height, version);
    const res = await nodePost(NODE_A, '/posts', { tx: tx.json, content: tx.content });
    await waitFor(`reply to ${parentId.slice(0, 10)}…`, async () => {
      const p = await nodeGet(NODE_A, `/posts/${res.postId}`).catch(() => null);
      return p && p.status === 'confirmed';
    });
    return res.postId;
  }
  async function like(key, postId, authorHex) {
    // Read the current count first so the wait resolves on THIS like's
    // landing — a second like whose count was already > 0 would otherwise
    // return before the second block takes it.
    const before = (await nodeGet(NODE_A, `/posts/${postId}`).catch(() => null))?.likeCount ?? 0;
    const k = await nodeGet(NODE_A, `/karma/${key.publicKeyHex}?pending=1`);
    const tx = buildLikeTx(key, karmaBoxes(k), postId, authorHex, k.height, version);
    await nodePost(NODE_A, '/likes', { tx: tx.json });
    await waitFor(`like on ${postId.slice(0, 10)}…`, async () => {
      const p = await nodeGet(NODE_A, `/posts/${postId}`).catch(() => null);
      return p && typeof p.likeCount === 'number' && p.likeCount > before;
    });
  }

  const post1 = await post(marit, POST_1);
  console.log(`[seed] post 1 (marit repair café): ${post1}`);
  const post2 = await post(jonas, POST_2);
  console.log(`[seed] post 2 (jonas keys): ${post2}`);
  const post3 = await post(kofi, POST_3);
  console.log(`[seed] post 3 (kofi node): ${post3}`);
  const reply4 = await reply(marit, REPLY_MARIT, post3, kofi.publicKeyHex);
  console.log(`[seed] reply 4 (marit): ${reply4}`);
  const reply5 = await reply(jonas, REPLY_JONAS, post3, kofi.publicKeyHex);
  console.log(`[seed] reply 5 (jonas): ${reply5}`);
  const post6 = await post(marit, POST_6);
  console.log(`[seed] post 6 (marit minutes): ${post6}`);
  const post7 = await post(jonas, POST_7);
  console.log(`[seed] post 7 (jonas image): ${post7}`);

  // Likes: kofi and jonas like 1 (marit's repair café).
  await like(kofi, post1, marit.publicKeyHex);
  await like(jonas, post1, marit.publicKeyHex);

  return {
    marit: marit.publicKeyHex,
    jonas: jonas.publicKeyHex,
    kofi: kofi.publicKeyHex,
    post1, post2, post3, reply4, reply5, post6, post7,
    jonasHex: jonas.publicKeyHex,
    kofiHex: kofi.publicKeyHex,
    maritHex: marit.publicKeyHex,
  };
}

// ---------------------------------------------------------------------------
// The extension copy — patched so `fetch` to the loopback faucet succeeds
// without a native permission dialog (CDP cannot drive one). The tracked
// manifest on disk is untouched, as extension-check does.
// ---------------------------------------------------------------------------
function prepareExtensionCopy() {
  const dest = join(SCRATCH_IN, 'ext-copy');
  rmSync(dest, { recursive: true, force: true });
  cpSync(EXT_DIR_IN, dest, { recursive: true });
  const mPath = join(dest, 'manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  const loopbacks = ['http://127.0.0.1/*', 'http://localhost/*'];
  m.host_permissions = [...new Set([...(m.host_permissions ?? []), ...loopbacks])];
  writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
  return { dir: dest, extId: 'kafmnekclgkjnkhnbafdoefnlllboddm' };
}

// ---------------------------------------------------------------------------
// Launch Chromium — one PID we own, cleaned up at the end even on failure.
// ⛔ The PID captured here is the only process this script ever signals; no
// pkill, no killall, no name-keyed match. Any miner, node or faucet of the
// operator's that happens to share a binary name is untouched.
// ---------------------------------------------------------------------------
async function launchChromium(extensionDir) {
  const chromePort = 19200 + Math.floor(Math.random() * 500);
  const profileDir = mkdtempSync(join(SCRATCH_IN, 'chromium-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`,
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
      if (r.ok) return { proc, port: chromePort, profileDir, version: await r.json() };
    } catch {}
    await sleep(100);
  }
  throw new Error(`Chromium DevTools never answered on ${chromePort}`);
}

async function jsonList(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
}
async function browserVersion(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());
}

// ---------------------------------------------------------------------------
// CDP session — the shape extension-check uses (its own copy, tiny), without
// any of the harness logic beside it. The `events` buffer records every CDP
// method event the page emits (Network.requestWillBeSent and
// Network.responseReceived among them), so a shot can report which
// requests ran during the moments before it.
// ---------------------------------------------------------------------------
async function openSession(wsUrl) {
  const s = new WebSocket(wsUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  let n = 0;
  const pending = new Map();
  const events = [];
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method) events.push({ method: m.method, params: m.params, at: Date.now() });
  };
  const CALL_MS = 60000;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout ${CALL_MS}ms on ${method}`)); }, CALL_MS);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    s.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  const eval_ = async (expression, userGesture = false) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  const waitForEval = async (expression, what, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await eval_(expression)) return;
      await sleep(150);
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  return { call, eval: eval_, waitFor: waitForEval, events, close: () => s.close() };
}

// Return every request whose url matches `urlFilter` and whose response
// landed since `sinceAt`, as `{ url, status, at, ms }`: a response matched
// to its request by `requestId`, timed to its response's event (`at`) and
// to its request's send (`ms`).
function requestsSince(events, sinceAt, urlFilter) {
  const requests = new Map(); // requestId → { url, at }
  const rows = [];
  for (const ev of events) {
    if (ev.at < sinceAt) continue;
    if (ev.method === 'Network.requestWillBeSent') {
      const url = ev.params?.request?.url;
      if (typeof url !== 'string') continue;
      if (!urlFilter(url)) continue;
      requests.set(ev.params.requestId, { url, at: ev.at });
    } else if (ev.method === 'Network.responseReceived') {
      const req = requests.get(ev.params?.requestId);
      if (!req) continue;
      const status = ev.params?.response?.status ?? null;
      rows.push({ url: req.url, status, at: req.at, respAt: ev.at, ms: ev.at - req.at });
    }
  }
  return rows;
}

async function openBrowserSession(port) {
  const bv = await browserVersion(port);
  const s = new WebSocket(bv.webSocketDebuggerUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  let n = 0;
  const pending = new Map();
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n;
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout on ${method}`)); }, 60000);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    s.send(JSON.stringify({ id, method, params }));
  });
  await call('Target.setDiscoverTargets', { discover: true });
  return { call, close: () => s.close() };
}

async function findExtensionPage(port, extId, pathSuffix) {
  for (let i = 0; i < 100; i++) {
    const list = await jsonList(port);
    const p = list.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}/`) && (pathSuffix ? t.url.includes(pathSuffix) : true));
    if (p?.webSocketDebuggerUrl) return p;
    await sleep(200);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Screenshots — one PNG per step, viewport or an element clipped with ~16 px
// padding. HOUSE_STYLE motion: `prefers-reduced-motion` is honoured by the
// emulated media, so no animation runs. (WEB_INTERFACE → The workspace;
// HOUSE_STYLE → Motion.)
// ---------------------------------------------------------------------------
async function setViewport(cx, { width, height, dpr }) {
  await cx.call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: width < 500,
  });
  await cx.call('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'light' },
    ],
  });
}

async function uiSettled(cx) {
  // Fonts loaded, no pending microtasks that would otherwise race the shot.
  await cx.eval(`document.fonts && document.fonts.ready`);
  // Two rAFs guarantees the browser has committed one paint since the last
  // DOM mutation (HOUSE_STYLE → Motion).
  await cx.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
}

const shots = [];

// A box the client measured. x / y / w / h are the element's own
// `getBoundingClientRect`, innerText the element's own text — read by the
// page, so a layout race here fails at the assertion below, not silently in
// the clip.
async function measureSelector(cx, selector) {
  return cx.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x, y: r.y, w: r.width, h: r.height,
      innerText: (el.innerText ?? '').trim(),
    };
  })()`);
}

// Measure the same box twice ~250 ms apart until both readings agree, so a
// clip of a row the profile has just reordered reads the final geometry, not
// the shape it had while the pending ledger's own redraw was still in
// flight. Up to ten tries; throws on the eleventh.
async function stableBox(cx, measure, name) {
  let a = await measure();
  if (!a) throw new Error(`shot ${name}: no element on first measure`);
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    const b = await measure();
    if (!b) throw new Error(`shot ${name}: the element went away during stability check`);
    if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h) return b;
    a = b;
  }
  throw new Error(`shot ${name}: the element's box never settled across 10 reads`);
}

// A shot: either a viewport, an element box clipped with padding, or a
// custom box the caller computed in-page. Every element shot waits for a
// stable box across two reads. The caller asserts the shot shows what its
// name says in one of two ways:
//   `expectText`      — a string the clip's innerText contains. The default
//                       padding is 16 px; row shots pass a smaller padding
//                       (`.winbody .row` has a 14 px gap, so a 16 px pad
//                       would leak the row above into the clip).
//   `expectValue`     — { selector, text }: the DOM element's `.value` must
//                       contain `text`. innerText never includes the value
//                       of a textarea or input; this reads the field.
// A `notes` object merges into the shot's record in shots.json.
async function shot(cx, name, selector = null, opts = {}) {
  const padding = opts.padding ?? 16;
  const expectText = opts.expectText ?? null;
  const expectValue = opts.expectValue ?? null;
  const customBoxExpr = opts.customBoxExpr ?? null;
  const notes = opts.notes ?? null;
  await uiSettled(cx);
  let clip = null;
  let innerText = null;
  let what = 'viewport';
  if (customBoxExpr) {
    const measure = () => cx.eval(customBoxExpr);
    const stable = await stableBox(cx, measure, name);
    clip = {
      x: Math.max(0, stable.x - padding),
      y: Math.max(0, stable.y - padding),
      width: stable.w + padding * 2,
      height: stable.h + padding * 2,
      scale: 1,
    };
    innerText = stable.innerText;
    what = `custom ${name}`;
  } else if (selector) {
    const stable = await stableBox(cx, () => measureSelector(cx, selector), name);
    clip = {
      x: Math.max(0, stable.x - padding),
      y: Math.max(0, stable.y - padding),
      width: stable.w + padding * 2,
      height: stable.h + padding * 2,
      scale: 1,
    };
    innerText = stable.innerText;
    what = `element ${selector}`;
  } else {
    innerText = await cx.eval(`document.body.innerText.trim()`);
  }
  if (expectText !== null && (innerText === null || !innerText.includes(expectText))) {
    throw new Error(`shot ${name}: expected "${expectText}" in innerText, got "${(innerText ?? '').slice(0, 300)}"`);
  }
  if (expectValue !== null) {
    const value = await cx.eval(`document.querySelector(${JSON.stringify(expectValue.selector)})?.value ?? null`);
    if (value === null || !value.includes(expectValue.text)) {
      throw new Error(`shot ${name}: expected "${expectValue.text}" in ${expectValue.selector}.value, got "${(value ?? '').slice(0, 200)}"`);
    }
  }
  // `captureBeyondViewport` forces a layout pass against a different viewport
  // size; for a clip fully inside the live viewport it is layout churn with
  // no payoff, so leave it off there and set it only when a clip spills past.
  const viewportW = await cx.eval(`window.innerWidth`);
  const viewportH = await cx.eval(`window.innerHeight`);
  const beyond = clip ? (clip.x + clip.width > viewportW || clip.y + clip.height > viewportH) : false;
  const params = clip
    ? { format: 'png', clip, captureBeyondViewport: beyond }
    : { format: 'png' };
  const png = await cx.call('Page.captureScreenshot', params);
  const file = join(OUT_DIR, `${name}.png`);
  const buf = Buffer.from(png.data, 'base64');
  writeFileSync(file, buf);
  const bytes = buf.length;
  const record = { file: `${name}.png`, what, bytes, innerText };
  if (notes !== null) record.notes = notes;
  shots.push(record);
  console.log(`[shot] ${name}.png — ${bytes} bytes, ${what}`);
  return { bytes, innerText };
}

// A JS expression the page evaluates to a box: `.region` from its bar's top
// to the bottom of the deepest child the region's body holds. The expression
// returns a shape `measureSelector` returns, so `shot()` treats it the same
// way. The input is a CSS selector that picks the thread's region.
function regionBoxExpr(regionSelector) {
  return `(() => {
    const r = document.querySelector(${JSON.stringify(regionSelector)});
    if (!r) return null;
    const bars = r.querySelector(':scope > .bars');
    const body = r.querySelector(':scope > .region-body');
    if (!bars || !body) return null;
    const children = [...body.children];
    const bottoms = children.map(c => c.getBoundingClientRect().bottom).filter(n => n > 0);
    if (bottoms.length === 0) return null;
    const b = bars.getBoundingClientRect();
    const bottom = Math.max(...bottoms);
    return {
      x: b.x,
      y: b.y,
      w: b.width,
      h: bottom - b.y,
      innerText: (r.innerText ?? '').trim(),
    };
  })()`;
}

// ---------------------------------------------------------------------------
// Walkthrough helpers — DOM selectors read from `packages/web/src/view/`;
// every selector is grounded in a view file, never in memory.
// ---------------------------------------------------------------------------

// The corner shows the chain's state (WEB_INTERFACE → The status corner).
// Under the extension's tip verifier the LED's class carries the state
// (`src/view/corner.ts:127` — `led ' + state`) and the title reads
// `verified across N nodes · tip T` where the verdict is `verified` and the
// state is `fresh` (`src/view/corner.ts:73`). Wait for that pair before any
// shot of the corner or of a viewport that frames it.
async function waitForVerifiedCorner(cx) {
  await cx.waitFor(`(() => {
    const led = document.querySelector('.corner .led.fresh');
    if (!led) return false;
    const title = document.querySelector('.corner')?.getAttribute('title') ?? '';
    return /^verified across \\d+ nodes · tip \\d+$/.test(title);
  })()`, 'verified corner', 120_000);
}

async function openWindow(cx, label) {
  await cx.eval(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`, true);
  // The window body stands while the window is open
  // (WEB_INTERFACE → The workspace → "A window's body stands while the window is open"),
  // so wait on the body to attach, not on an animation.
  await cx.waitFor(`!!document.querySelector('#panes .region-body')`, `window ${label}`);
}

async function typeInto(cx, selector, text) {
  // Set the value, then dispatch 'input' and 'change' so the composer's
  // byte counter updates (WEB_INTERFACE → Content).
  await cx.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const t = ${JSON.stringify(text)};
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, t);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`, true);
}

async function clickSelector(cx, selector) {
  await cx.eval(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Read the sample names and the seeded post ids from a previous run's
// shots.json so a dev iteration skips seeding. The walker is always fresh
// — the walkthrough builds a new identity each run — so no walker state is
// read from the file.
function loadReusedSeed(path) {
  const text = readFileSync(path, 'utf8');
  const j = JSON.parse(text);
  if (!j.sampleNames || !j.seededIds) {
    throw new Error(`--reuse-seed: ${path} has no sampleNames or seededIds`);
  }
  const needed = ['post1', 'post2', 'post3', 'reply4', 'reply5', 'post6', 'post7'];
  for (const k of needed) if (typeof j.seededIds[k] !== 'string') {
    throw new Error(`--reuse-seed: ${path} is missing seededIds.${k}`);
  }
  return {
    suffix: typeof j.sampleSuffix === 'string' ? j.sampleSuffix : '',
    sample: j.sampleNames,
    seeded: j.seededIds,
  };
}

async function main() {
  let seeded;
  let builders = null;
  if (REUSE_SEED !== null) {
    const reused = loadReusedSeed(REUSE_SEED);
    SUF = reused.suffix;
    SAMPLE = reused.sample;
    seeded = reused.seeded;
    console.log(`[seed] reusing seed from ${REUSE_SEED}: suffix="${SUF}", names=${JSON.stringify(SAMPLE)}`);
  } else {
    // Build the Node-side bundle first so a vite error does not reach the
    // chain or the browser.
    builders = await loadBuilders();
    seeded = await seedChain(builders);
  }

  // 2. Prepare the extension copy and launch Chromium.
  const { dir: extDir, extId } = prepareExtensionCopy();
  const chromium = await launchChromium(extDir);
  const chromiumPid = chromium.proc.pid;
  console.log(`[browser] Chromium pid ${chromiumPid}, DevTools :${chromium.port}`);

  // Only this PID is ever killed. Never signal any other process.
  const stopChromium = () => {
    try { process.kill(chromiumPid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(chromiumPid, 'SIGKILL'); } catch {} }, 3000);
  };
  process.on('SIGINT', () => { stopChromium(); process.exit(130); });
  process.on('SIGTERM', () => { stopChromium(); process.exit(143); });

  try {
    await runWalkthrough(chromium.port, extId, seeded);
    writeFileSync(join(OUT_DIR, 'shots.json'), JSON.stringify({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      phone: { width: 390, height: 844, deviceScaleFactor: 2 },
      walker: WALK_NAME,
      sampleSuffix: SAMPLE_SUFFIX,
      sampleNames: SAMPLE,
      seededIds: {
        post1: seeded.post1, post2: seeded.post2, post3: seeded.post3,
        reply4: seeded.reply4, reply5: seeded.reply5,
        post6: seeded.post6, post7: seeded.post7,
      },
      shots,
    }, null, 2));
    console.log(`[done] ${shots.length} PNGs under ${OUT_DIR}, shots.json beside them`);
  } finally {
    stopChromium();
  }
}

async function runWalkthrough(port, extId, seeded) {
  // Open a fresh page on the extension's own origin.
  const bcx = await openBrowserSession(port);
  await bcx.call('Target.createTarget', { url: `chrome-extension://${extId}/index.html` });
  const page = await findExtensionPage(port, extId, 'index.html');
  if (!page) throw new Error('the extension page never appeared');
  const cx = await openSession(page.webSocketDebuggerUrl);
  await setViewport(cx, { width: 1440, height: 900, dpr: 2 });

  // Wait for the feed's resolved cards. In the extension's light read every
  // list arrives as ids and resolves through POST /posts/batch
  // (WEB_INTERFACE → The extension → "The light read", "The resolve"), so
  // the slots are placeholder cards until the resolve lands.
  await cx.waitFor(`document.querySelectorAll('#feed .card:not(.slot)').length >= 3`, 'feed resolved', 60000);

  // The extension's tip verifier reads the chain the client is talking to —
  // every shot that frames the status corner or any proven handle on screen
  // waits for `verified` first (WEB_INTERFACE → The extension).
  await waitForVerifiedCorner(cx);

  // ---------------------------------------------------------------------
  // profile.png — the profile window after the faucet grant lands, with
  //   the username claim form carrying the walker's name typed, not yet
  //   pressed (WEB_INTERFACE → The profile window, → The username row).
  // ---------------------------------------------------------------------
  await openWindow(cx, 'open profile');
  await cx.waitFor(`[...document.querySelectorAll('button.word')].some(b => b.textContent.trim() === 'create')`, 'create word');
  // Create flow: press `create`, type the passphrase in both fields, submit.
  await cx.eval(`[...document.querySelectorAll('button.word')].find(b => b.textContent.trim() === 'create').click()`, true);
  await cx.waitFor(`!!document.querySelector('.pf input[type="password"]')`, 'passphrase form');
  const pwFields = `document.querySelectorAll('.pf input[type="password"]')`;
  await cx.eval(`(() => {
    const fs = ${pwFields};
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    for (const f of fs) {
      setter.call(f, ${JSON.stringify(PASSPHRASE)});
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`, true);
  await cx.eval(`document.querySelector('.pf').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))`, true);
  // The seal is scrypt(N=2¹⁶) — the key's rows render after it
  // (WEB_INTERFACE → The identity module).
  await cx.waitFor(`!!document.querySelector('.karma-field')`, 'profile with identity', 20_000);

  // Ask the faucet for rep — one press through the profile's `ask the faucet
  // for rep` word; wait for the mono rep number to replace the `working…` line
  // (WEB_INTERFACE → The faucet step).
  await cx.eval(`[...document.querySelectorAll('button.word')].find(b => b.textContent.trim() === 'ask the faucet for rep').click()`, true);
  await cx.waitFor(`(() => {
    const n = document.querySelector('.karma-field .mono');
    return !!n && /^[0-9]+/.test(n.textContent?.trim() ?? '');
  })()`, 'rep landed', 180_000);
  // The grant lands a karma box, which draws the `username` row in place
  // (WEB_INTERFACE → The username row). Type the walker's name into the row's
  // form — the composer-style field holds its text in `.value`, which
  // innerText does not read, so the shot asserts the field directly.
  await cx.waitFor(`!!document.querySelector('.username-field input')`, 'claim field', 60_000);
  await typeInto(cx, '.username-field input', WALK_NAME);
  await shot(cx, 'profile', '#panes .region-body .winbody', {
    expectText: 'this key lives in this browser only',
    expectValue: { selector: '.username-field input', text: WALK_NAME },
  });

  // Press `claim` and wait for the row to re-render with `burn` offered — the
  // name is held (WEB_INTERFACE → The username row). The extension's names
  // verifier may read the handle clay for one tip-run cycle after the claim
  // if the current anchor predates it; press the corner if so and wait for
  // the handle to turn ink (WEB_INTERFACE → The extension → "The verified
  // names").
  const claimPressedAt = Date.now();
  await cx.eval(`document.querySelector('.username-field .btn-primary').click()`, true);
  await cx.waitFor(`(() => {
    const r = document.querySelector('.username-field');
    if (!r) return false;
    return [...r.querySelectorAll('button.word')].some(b => b.textContent.trim() === 'burn');
  })()`, 'name held and burn offered', 240_000);
  await settleHandleToInk(cx, '.username-field .handle', claimPressedAt);

  // Close the profile window — press ✕ on its bar — so the workspace shot
  // below opens into a clean arrangement with the thread as the only window
  // (WEB_INTERFACE → The workspace).
  await closeEveryPane(cx);

  // ---------------------------------------------------------------------
  // workspace.png — the 1440×900 viewport: the feed on the left, one thread
  //   window to its right — the repair café notice with the walker's own
  //   reply beneath it as the read card. Never press `withdraw`.
  // ---------------------------------------------------------------------
  await cx.eval(`document.querySelector('#feed .card[data-post-id="${seeded.post1}"] button.strip').click()`, true);
  await cx.waitFor(`!!document.querySelector('#panes .region .card[data-post-id="${seeded.post1}"] button.reply-ctl')`, 'reply button on repair café');
  await cx.eval(`document.querySelector('#panes .region .card[data-post-id="${seeded.post1}"] button.reply-ctl').click()`, true);
  await cx.waitFor(`!!document.querySelector('.composer textarea')`, 'reply composer');
  await typeInto(cx, '.composer textarea', WALKER_REPLY);
  // Submit the reply. The flight begins when the submission card renders
  // beneath post1 (`.card.pending` and a `.stage` child), and ends when both
  // leave (WEB_INTERFACE → The write surface — identity, post and like, the
  // membership actions, and withdraw).
  // The composer reads affordability on open (WEB_INTERFACE →
  // Client-side operations → "Affordability is known before the attempt"):
  // post is disabled until the read lands. Wait for it to enable before
  // submitting.
  await cx.waitFor(`(() => {
    const b = document.querySelector('.composer .btn-primary');
    return !!b && !b.disabled;
  })()`, 'post button enabled', 30_000);
  await cx.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  await cx.waitFor(`(() => {
    const pane = document.querySelector('#panes .region:has(.card[data-post-id="${seeded.post1}"])');
    if (!pane) return false;
    return !!pane.querySelector('.card.pending, .card .stage');
  })()`, 'reply flight begun', 30_000);
  await cx.waitFor(`(() => {
    const pane = document.querySelector('#panes .region:has(.card[data-post-id="${seeded.post1}"])');
    if (!pane) return false;
    const subs = pane.querySelectorAll('.card.pending, .card .stage');
    return subs.length === 0;
  })()`, 'reply flight landed', 240_000);
  // Press the focused window's `↻` so the server's read-row for the walker's
  // reply replaces the landed submission card (WEB_INTERFACE → "A landed
  // submission is replied to where it stands"). A column stacks every opened
  // thread as its own bar, each with the same aria-label; the focused bar
  // carries `.bar.focused` and is the one post1's thread stands under.
  await cx.eval(`(() => {
    const pane = document.querySelector('#panes .region:has(.card[data-post-id="${seeded.post1}"])');
    pane.querySelector('.bar.focused button[aria-label="refresh replies to this thread"]').click();
  })()`, true);
  await cx.waitFor(`(() => {
    const pane = document.querySelector('#panes .region:has(.card[data-post-id="${seeded.post1}"])');
    if (!pane) return false;
    return !!pane.querySelector('button.withdraw-ctl');
  })()`, 'reader\'s own confirmed reply with withdraw control', 180_000);
  const walkerReplyId = await cx.eval(`(() => {
    const pane = document.querySelector('#panes .region:has(.card[data-post-id="${seeded.post1}"])');
    const own = [...pane.querySelectorAll('.region-body .card')].find(c => c.querySelector('.who .you') && c.querySelector('button.withdraw-ctl'));
    return own?.getAttribute('data-post-id') ?? null;
  })()`);
  if (walkerReplyId === null) {
    throw new Error('workspace: no own card with withdraw-ctl in the repair café pane');
  }
  // Wait for the corner to read `verified` again and for every handle on
  // screen to be ink — the names verifier re-checks after each tip run
  // (WEB_INTERFACE → The extension → "The verified names").
  await waitForVerifiedCorner(cx);
  await settleAllHandlesToInk(cx);
  await shot(cx, 'workspace');

  // ---------------------------------------------------------------------
  // composer.png — the feed's `new post` composer with the walker's first
  //   post typed, not posted. Open from the feed head, type, capture, cancel.
  // ---------------------------------------------------------------------
  await cx.waitFor(`!!document.querySelector('[data-composer-open="@feed"]')`, 'new post button', 30_000);
  await clickSelector(cx, '[data-composer-open="@feed"]');
  await cx.waitFor(`!!document.querySelector('.composer textarea')`, 'composer open');
  await typeInto(cx, '.composer textarea', WALKER_POST);
  await shot(cx, 'composer', '.composer', {
    expectValue: { selector: '.composer textarea', text: WALKER_POST },
  });
  // Cancel the composer so no post lands. A composer whose draft holds text
  // opens a confirm row at the first cancel press — *discard this post?* with
  // `discard` and `keep writing` — and `discard` closes it
  // (WEB_INTERFACE → Client-side operations).
  await cx.eval(`(() => {
    const btn = [...document.querySelectorAll('.composer button')].find(b => b.textContent.trim() === 'cancel');
    if (btn) btn.click();
  })()`, true);
  await cx.waitFor(`[...document.querySelectorAll('.composer button')].some(b => b.textContent.trim() === 'discard')`, 'discard confirm');
  await cx.eval(`(() => {
    const btn = [...document.querySelectorAll('.composer button')].find(b => b.textContent.trim() === 'discard');
    if (btn) btn.click();
  })()`, true);
  await cx.waitFor(`!document.querySelector('.composer textarea')`, 'composer closed');

  // ---------------------------------------------------------------------
  // phone.png — the 390×844 one-column layout (WEB_INTERFACE → The workspace
  //   → "At one column the screens are history").
  // ---------------------------------------------------------------------
  await setViewport(cx, { width: 390, height: 844, dpr: 2 });
  await uiSettled(cx);
  await cx.waitFor(`matchMedia('(max-width: 955px)').matches`, 'one-column layout');
  await shot(cx, 'phone');

  cx.close();
  bcx.close();
}

/** Close every open pane by pressing its bar's ✕ button, until none remain.
 *  Used to clear the arrangement so a shot captures only the pane the step
 *  opens. */
async function closeEveryPane(cx) {
  await cx.eval(`(() => {
    const closers = [...document.querySelectorAll('#panes .bar-ctl button[aria-label^="close"]')];
    for (const b of closers) b.click();
  })()`, true);
  await cx.waitFor(`!document.querySelector('#panes .region')`, 'every pane closed');
}

/** The extension draws a handle clay while its name has not verified yet
 *  against the chain the tip run anchored (WEB_INTERFACE → The extension →
 *  "The verified names"), and a clay pair is re-checked at the next verified
 *  tip run. A corner press runs the verifier anew. */
async function settleHandleToInk(cx, selector, pressedAt) {
  const clayExpr = `(() => {
    const h = document.querySelector(${JSON.stringify(selector)});
    return !!h && h.classList.contains('clay');
  })()`;
  const clayNow = await cx.eval(clayExpr);
  if (!clayNow) return;
  await cx.eval(`document.querySelector('.corner')?.click()`, true);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!await cx.eval(clayExpr)) return;
    await sleep(1000);
  }
  const elapsed = Math.round((Date.now() - pressedAt) / 1000);
  throw new Error(`handle at ${selector} stayed clay ${elapsed}s after a corner press`);
}

/** The names verifier re-checks every pair on screen after each verified tip
 *  run (WEB_INTERFACE → The extension → "The verified names"). Wait until no
 *  `.handle.clay` remains anywhere on the page; press the corner once if
 *  needed to run a fresh check. */
async function settleAllHandlesToInk(cx) {
  const anyClay = `!!document.querySelector('.handle.clay')`;
  if (!await cx.eval(anyClay)) return;
  await cx.eval(`document.querySelector('.corner')?.click()`, true);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!await cx.eval(anyClay)) return;
    await sleep(1000);
  }
  throw new Error('one or more handles stayed clay 3 min after a corner press');
}

main().catch((e) => {
  console.error('docs-screens:', e?.stack ?? e);
  process.exit(1);
});
