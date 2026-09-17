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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
const PASSPHRASE = 'proof-pass';

if (!EXT_DIR || !existsSync(EXT_DIR)) { console.error('missing --extension-dir'); process.exit(2); }
if (!R_KEY || !existsSync(R_KEY)) { console.error('missing --r-key'); process.exit(2); }

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
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n; p.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
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
    // The new markup — no `.ask` heading. Every line is a `.line` div with a
    // second class (`.what`, `.amount`, `.target`, `.fee`, `.content`), a
    // `.target` line carrying its `.target-label` and `.target-value` spans
    // (WEB_INTERFACE → The extension → "The prompt reads as three lines").
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
  const cx10 = await openSession(p10.webSocketDebuggerUrl);
  await cx10.waitFor(`document.querySelector('#feed')`, 'feed after reload');
  await sleep(1500);
  const state10 = await cx10.eval(`chrome.runtime.sendMessage({ kind: 'state' })`);
  record(10, state10 && state10.locked === false, `state.locked=${state10?.locked}, pubKeyHex=${state10?.pubKeyHex?.slice(0, 8)}…`);

  // --- Step 11 — Set the faucet preference. The real permissions dialog is
  // not drivable from headless Chrome (Phase 0 hypothesis (d)); assert the
  // page's own handler by stubbing `chrome.permissions.request` for both
  // branches. The manual pass exercises the real dialog.
  await cx10.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx10.waitFor(`document.querySelector('input[aria-label="the faucet this client asks for rep"]')`, 'faucet row');
  // Branch A — refused. Stub resolves false; hint must read the refusal;
  // storage must not carry the origin.
  const refused = await cx10.eval(`(async () => {
    localStorage.removeItem('notis.faucet');
    chrome.permissions.request = () => Promise.resolve(false);
    const input = document.querySelector('input[aria-label="the faucet this client asks for rep"]');
    input.value = ${JSON.stringify(FAUCET)};
    input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1500));
    const hint = input.parentElement.querySelector('.hint')?.textContent ?? null;
    const storedFaucet = localStorage.getItem('notis.faucet');
    return { hint, storedFaucet };
  })()`, true);
  // Branch B — granted. Stub resolves true; storage must carry the origin.
  const granted = await cx10.eval(`(async () => {
    chrome.permissions.request = () => Promise.resolve(true);
    const input = document.querySelector('input[aria-label="the faucet this client asks for rep"]');
    // Dispatch change again — same value, but the handler runs on 'change'.
    input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1500));
    const storedFaucet = localStorage.getItem('notis.faucet');
    return { storedFaucet };
  })()`, true);
  const refusedOk = refused.hint === 'the browser refused access to that origin.' && refused.storedFaucet === null;
  const grantedOk = granted.storedFaucet === FAUCET;
  record(11, refusedOk && grantedOk,
    `refused: hint="${refused.hint}" (${refusedOk ? 'ok' : 'FAIL'}), storedFaucet=${refused.storedFaucet}; granted: storedFaucet=${granted.storedFaucet} (${grantedOk ? 'ok' : 'FAIL'})`);

  // --- Step 12 — Credits: 12a ask → 12b send + approve → 12c decline →
  // 12d locked send. WEB_INTERFACE → The profile window, → The wallet,
  // → The extension. The identity is unlocked (step 9), the policy is
  // silent (step 9), the faucet base is set from step 11.
  const DEVNET_FAUCET_KEY = '5468d985c3924a95f3d3dc98b67a41ac2c7cc4cfca4fcbf7c5627452f1617f36';
  const R_HEX = R_JSON.pubKeyHex;

  // --- 12a — no credits → "ask the faucet for $NOTIS" → ledger creditGrant → landing → 100.
  // Open the profile if not already.
  await cx10.eval(`document.querySelector('.credits-field') || document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx10.waitFor(`!!document.querySelector('.credits-field .credits-line')`, 'credits line');
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
  await cx10.waitFor(`document.querySelector('.credits-line .mono.gold')?.textContent === '100'`, 'row reads 100 after grant', 120000);
  const after12a = await cx10.eval(`(() => ({
    gold: document.querySelector('.credits-line .mono.gold')?.textContent ?? null,
    text: document.querySelector('.credits-line')?.textContent?.trim() ?? null,
  }))()`);
  const grantOk12a = grantEntry12a?.kind === 'creditGrant' && typeof grantEntry12a.postId === 'string' && /^[0-9a-f]{64}$/.test(grantEntry12a.postId);
  const askOk12a = before12a.hasAsk;
  const rowOk12a = after12a.gold === '100' && (after12a.text || '').includes('$NOTIS');
  record('12a', askOk12a && grantOk12a && rowOk12a,
    `ask=${askOk12a}, grant.postId=${grantEntry12a?.postId?.slice(0, 8) ?? 'null'}…, landed row='${after12a.text}'`);

  // --- 12b — send 12.5 to the devnet faucet key. In the extension arm the
  // resolved-key hint appears beneath the recipient and the prompt opens at
  // once, no confirm row (WEB_INTERFACE → The profile window → "The `$NOTIS`
  // row"; → The extension → "The prompt window"). Approve → /credits/transfer
  // 200 → landing → row reads 87.5 → faucet /credits has the payment.
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
  // flight "send not sent.", no /credits/transfer (WEB_INTERFACE → The profile
  // window → "The `$NOTIS` row" — the fourth ending).
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

  // --- 12d — lock, then send: the extension arm mounts the unlock form UNDER
  // the credits form (`.credits-field .card-unlock`, the invites row's pattern
  // — WEB_INTERFACE → The profile window → "The `$NOTIS` row"), never in a
  // `.pf-confirm`. No prompt, no /credits/transfer under lock. Unlock →
  // the flight proceeds → the first-send prompt after unlock. Decline it. A
  // second send goes straight to the prompt — cur.identity was mutated, no
  // second unlock (WEB_INTERFACE → The wallet).
  await cx10.waitFor(`!!window.__btn('lock')`, 'lock button in profile 12d');
  await cx10.eval(`window.__btn('lock').click()`, true);
  await sleep(1000);
  const lockedSession12d = await cx10.eval(`(async () => (await chrome.storage.session.get('notis.seed'))['notis.seed'] ?? null)()`);
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
process.exit(exitCode);
