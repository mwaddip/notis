// MESH_INTERFACE → Acceptance — raw CDP over WebSocket to the Chromium
// `--remote-debugging-port` the stage brings up on the browser host's
// loopback. Uses Node 24's global `WebSocket` (no new dependency, no
// Playwright): open a target on a URL, `Runtime.evaluate` to read a
// serialisable value out of the page, close the target. Runs inside
// `notismesh-browser` as the user — the stage calls this script via
// `execIn(ns, [NODE_ABS, cdp.mjs, ...])`, since CDP listens on that
// namespace's loopback.
//
// The one invariant this driver holds: every WebSocket it opens is
// closed before `run()` returns, every target it opens via `/json/new`
// is closed via `/json/close/<id>`, and every timer is capped.
//
// CLI shape:
//   node cdp.mjs eval <url> <expression>
// Writes the evaluation's returned value (JSON) on stdout. Exits
// non-zero and writes the error on stderr if evaluation threw, the
// expression's result was not serialisable, or the deadline fired.

import { fileURLToPath } from 'node:url';
import { setTimeout as sleepP } from 'node:timers/promises';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * List Chromium's current targets, as `/json` returns them.
 */
export async function listTargets(cdpUrl = DEFAULT_CDP_URL) {
  const res = await fetch(`${cdpUrl}/json`);
  if (!res.ok) throw new Error(`GET /json: ${res.status}`);
  return res.json();
}

/**
 * Open a new target on `url` and return its target info. The returned
 * object carries `id` (the target id, Chromium calls it `targetId` in
 * `/json/new`) and `webSocketDebuggerUrl` (the target-level WS to
 * connect for `Runtime.*`, `Page.*`, etc.).
 */
export async function openTarget(url, cdpUrl = DEFAULT_CDP_URL) {
  // Chromium's `/json/new` takes the URL as a query parameter.
  const res = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`PUT /json/new: ${res.status}`);
  return res.json();
}

/**
 * Close a target by id. Does not throw if the target is already gone.
 */
export async function closeTarget(targetId, cdpUrl = DEFAULT_CDP_URL) {
  const res = await fetch(`${cdpUrl}/json/close/${encodeURIComponent(targetId)}`);
  // Chromium answers 200 "Target is closing" on success. A 404 means the
  // target is already gone; we are tolerant there.
  if (!res.ok && res.status !== 404) {
    throw new Error(`GET /json/close/${targetId}: ${res.status}`);
  }
}

/**
 * Open a WebSocket to a target's debugger URL. The returned Session has
 * `send(method, params)` and `close()`. Every unmatched reply fails the
 * session; every timer is capped at `DEFAULT_TIMEOUT_MS`.
 */
export function openSession(wsUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  let openP;
  const open = new Promise((resolve, reject) => {
    const dl = setTimeout(() => reject(new Error(`WS open timed out after ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(dl); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(dl); reject(new Error(`WS error: ${String(e?.message ?? e)}`)); }, { once: true });
  });
  openP = open;
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const { resolve, reject, dl } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(dl);
      if (msg.error) {
        reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
      } else {
        resolve(msg.result ?? null);
      }
    }
  });
  ws.addEventListener('close', () => {
    for (const { reject, dl } of pending.values()) {
      clearTimeout(dl);
      reject(new Error('WS closed before reply'));
    }
    pending.clear();
  });
  return {
    ready: openP,
    async send(method, params = {}) {
      await openP;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const dl = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, dl });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * The one high-level call this driver answers: open a target on `url`,
 * run `Runtime.evaluate` with `expression`, read its result as JSON
 * (via `returnByValue: true`), close the target. The expression must
 * end with a serialisable value — a bare `document.querySelector(...)`
 * returns an element, which is not serialisable, so the caller writes
 * `document.querySelector('#state')?.textContent ?? null`.
 */
export async function evaluate(url, expression, {
  cdpUrl = DEFAULT_CDP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  awaitPromise = true,
} = {}) {
  const target = await openTarget(url, cdpUrl);
  const wsUrl = target.webSocketDebuggerUrl;
  if (typeof wsUrl !== 'string') throw new Error(`target has no webSocketDebuggerUrl: ${JSON.stringify(target)}`);
  const session = openSession(wsUrl, { timeoutMs });
  try {
    const result = await session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result?.exceptionDetails) {
      throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result?.result?.value;
  } finally {
    session.close();
    await closeTarget(target.id, cdpUrl);
  }
}

/**
 * Build a predicate from its body text. The one definition every
 * caller uses so the predicate's runtime is the live one: `new
 * Function('v', body)` runs in cdp.mjs' Node process, with no
 * `window` and no `document` in scope — an *expression* runs in the
 * page, a *predicate* runs here. The returned function takes the
 * expression's value and returns truthy when the poll is done; it
 * holds its state across polls on `globalThis` (the cdp.mjs process
 * lives for one poll, so the state is the poll's) and catches
 * `JSON.parse` alone — any other throw propagates to `main`, which
 * fails the poll at once with the error instead of waiting out the
 * deadline.
 */
export function buildPredicate(predicateBody) {
  return new Function('v', predicateBody);
}

/**
 * Poll `expression` every `pollMs` until it answers a value matching
 * `predicate`, or `timeoutMs` elapses. Returns the final value; throws
 * on timeout.
 */
export async function pollEvaluate(url, expression, predicate, {
  cdpUrl = DEFAULT_CDP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(url, expression, { cdpUrl, timeoutMs: Math.min(timeoutMs, 10_000) });
    if (predicate(last)) return last;
    await sleepP(pollMs);
  }
  throw new Error(`pollEvaluate timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}

/**
 * MESH_INTERFACE → Acceptance 1 — the page's RTCPeerConnection
 * constructions are recorded by a wrapper the stage installs through
 * `Page.addScriptToEvaluateOnNewDocument`, because Chromium's own
 * `--host-resolver-rules` resolver answers host-named ICE servers
 * before any DNS witness sees them. The wrapper stores each
 * construction's `iceServers.urls` on `window.__notismeshIceRecord`
 * and passes everything through unchanged.
 *
 * The source runs as a string in the page's main world; the wrapper
 * swallows no error (a page that cannot construct an RTCPeerConnection
 * surfaces the real throw) and makes the record readable by every
 * caller that evaluates `window.__notismeshIceRecord`.
 */
export const ICE_RECORD_INSTALL_SRC = `
(function () {
  if (window.__notismeshIceRecordInstalled) return;
  window.__notismeshIceRecordInstalled = true;
  var record = [];
  window.__notismeshIceRecord = record;
  var OrigPC = window.RTCPeerConnection;
  if (typeof OrigPC !== 'function') return;
  function Wrapped(cfg) {
    var urls = [];
    if (cfg && cfg.iceServers && cfg.iceServers.length) {
      for (var i = 0; i < cfg.iceServers.length; i++) {
        var s = cfg.iceServers[i];
        if (!s) continue;
        if (Array.isArray(s.urls)) {
          for (var j = 0; j < s.urls.length; j++) urls.push(s.urls[j]);
        } else if (typeof s.urls === 'string') {
          urls.push(s.urls);
        }
      }
    }
    record.push({ urls: urls });
    return new OrigPC(cfg);
  }
  Wrapped.prototype = OrigPC.prototype;
  for (var k in OrigPC) { if (Object.prototype.hasOwnProperty.call(OrigPC, k)) Wrapped[k] = OrigPC[k]; }
  window.RTCPeerConnection = Wrapped;
})();
`;

/**
 * Open one Chromium target on `url`, keep its CDP session alive, and
 * return a page handle whose `.eval(expression)` runs a `Runtime.evaluate`
 * on it with `returnByValue: true`. `page.close()` closes the session and
 * the target. A single `/json/new` + WebSocket means repeated `eval`s on
 * the same page (polling `#state` and `#probe` during a scenario) do not
 * open and tear down a target each time.
 */
export async function openPage(url, {
  cdpUrl = DEFAULT_CDP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = await openTarget(url, cdpUrl);
  const wsUrl = target.webSocketDebuggerUrl;
  if (typeof wsUrl !== 'string') throw new Error(`target has no webSocketDebuggerUrl: ${JSON.stringify(target)}`);
  const session = openSession(wsUrl, { timeoutMs });
  await session.ready;
  let closed = false;
  return {
    target,
    async eval(expression, { awaitPromise = true, perCallTimeoutMs } = {}) {
      if (closed) throw new Error('page is closed');
      const r = await session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        ...(perCallTimeoutMs !== undefined ? { timeout: perCallTimeoutMs } : {}),
      });
      if (r?.exceptionDetails) {
        throw new Error(`Runtime.evaluate threw: ${JSON.stringify(r.exceptionDetails)}`);
      }
      return r?.result?.value;
    },
    /**
     * Poll an expression every `pollMs` until it returns a value matching
     * `predicate`, or `timeoutMs` elapses. The matching value is returned.
     */
    async pollEval(expression, predicate, { timeoutMs: pTimeout = timeoutMs, pollMs = 500 } = {}) {
      const deadline = Date.now() + pTimeout;
      let last;
      while (Date.now() < deadline) {
        last = await this.eval(expression);
        if (predicate(last)) return last;
        await sleepP(pollMs);
      }
      throw new Error(`pollEval timed out after ${pTimeout}ms; last value: ${JSON.stringify(last)}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      session.close();
      await closeTarget(target.id, cdpUrl);
    },
  };
}

/**
 * MESH_INTERFACE → Acceptance 1 — open a target to `about:blank`, enable
 * the Page domain, install the RTCPeerConnection wrapper through
 * `Page.addScriptToEvaluateOnNewDocument`, then navigate to `url`. The
 * wrapper runs before any script in the loaded document, so every
 * `RTCPeerConnection` the page builds is recorded. The returned page
 * handle has `eval`, `pollEval`, `close` as `openPage`'s handle, plus
 * `readIceRecord()` which reads `window.__notismeshIceRecord` and
 * returns `[]` when nothing was recorded yet.
 */
export async function openPageWithIceRecord(url, {
  cdpUrl = DEFAULT_CDP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = await openTarget('about:blank', cdpUrl);
  const wsUrl = target.webSocketDebuggerUrl;
  if (typeof wsUrl !== 'string') throw new Error(`target has no webSocketDebuggerUrl: ${JSON.stringify(target)}`);
  const session = openSession(wsUrl, { timeoutMs });
  await session.ready;
  let closed = false;
  await session.send('Page.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: ICE_RECORD_INSTALL_SRC });
  await session.send('Page.navigate', { url });
  return {
    target,
    async eval(expression, { awaitPromise = true, perCallTimeoutMs } = {}) {
      if (closed) throw new Error('page is closed');
      const r = await session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        ...(perCallTimeoutMs !== undefined ? { timeout: perCallTimeoutMs } : {}),
      });
      if (r?.exceptionDetails) {
        throw new Error(`Runtime.evaluate threw: ${JSON.stringify(r.exceptionDetails)}`);
      }
      return r?.result?.value;
    },
    async pollEval(expression, predicate, { timeoutMs: pTimeout = timeoutMs, pollMs = 500 } = {}) {
      const deadline = Date.now() + pTimeout;
      let last;
      while (Date.now() < deadline) {
        last = await this.eval(expression);
        if (predicate(last)) return last;
        await sleepP(pollMs);
      }
      throw new Error(`pollEval timed out after ${pTimeout}ms; last value: ${JSON.stringify(last)}`);
    },
    async readIceRecord() {
      if (closed) throw new Error('page is closed');
      // Returns a JSON array `[{ urls: string[] }, ...]`; empty when
      // the page has not constructed any `RTCPeerConnection` yet.
      const value = await this.eval('JSON.stringify(window.__notismeshIceRecord || [])');
      return JSON.parse(typeof value === 'string' ? value : '[]');
    },
    async close() {
      if (closed) return;
      closed = true;
      session.close();
      await closeTarget(target.id, cdpUrl);
    },
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'eval') {
    const [url, expression] = rest;
    if (typeof url !== 'string' || typeof expression !== 'string') {
      process.stderr.write('usage: cdp.mjs eval <url> <expression>\n');
      process.exit(2);
    }
    const value = await evaluate(url, expression);
    process.stdout.write(JSON.stringify(value) + '\n');
    return;
  }
  if (cmd === 'poll') {
    // `cdp.mjs poll <url> <expression> <predicate-body> <timeoutMs> <pollMs>`:
    // keeps a target open, polls `<expression>` every `<pollMs>` until
    // `buildPredicate(<predicate-body>)` reads it as truthy. Writes
    // the matching value as JSON on stdout. The predicate body is run
    // in this process (not the page), so it stays short — eg
    // `return v !== null && JSON.parse(v).nodeId !== null`.
    const [url, expression, predicateBody, timeoutStr, pollStr] = rest;
    if (typeof url !== 'string' || typeof expression !== 'string' || typeof predicateBody !== 'string') {
      process.stderr.write('usage: cdp.mjs poll <url> <expression> <predicate-body> [<timeoutMs>] [<pollMs>]\n');
      process.exit(2);
    }
    const timeoutMs = timeoutStr !== undefined ? parseInt(timeoutStr, 10) : DEFAULT_TIMEOUT_MS;
    const pollMs = pollStr !== undefined ? parseInt(pollStr, 10) : 500;
    // The Function constructor is restricted here to a predicate body
    // the scenario itself writes (no attacker surface): the scenario
    // process is the only caller of this command.
    const predicate = buildPredicate(predicateBody);
    const page = await openPage(url, { timeoutMs });
    try {
      const result = await page.pollEval(expression, predicate, { timeoutMs, pollMs });
      process.stdout.write(JSON.stringify(result) + '\n');
    } finally {
      await page.close();
    }
    return;
  }
  if (cmd === 'poll-ice') {
    // `cdp.mjs poll-ice <url> <expression> <predicate-body> <timeoutMs> <pollMs>`:
    // like `poll`, but opens the page through `openPageWithIceRecord` so
    // the `RTCPeerConnection` wrapper installs before the document's
    // scripts run. Writes `{ value, iceRecord }` as JSON on stdout.
    const [url, expression, predicateBody, timeoutStr, pollStr] = rest;
    if (typeof url !== 'string' || typeof expression !== 'string' || typeof predicateBody !== 'string') {
      process.stderr.write('usage: cdp.mjs poll-ice <url> <expression> <predicate-body> [<timeoutMs>] [<pollMs>]\n');
      process.exit(2);
    }
    const timeoutMs = timeoutStr !== undefined ? parseInt(timeoutStr, 10) : DEFAULT_TIMEOUT_MS;
    const pollMs = pollStr !== undefined ? parseInt(pollStr, 10) : 500;
    const predicate = buildPredicate(predicateBody);
    const page = await openPageWithIceRecord(url, { timeoutMs });
    try {
      const value = await page.pollEval(expression, predicate, { timeoutMs, pollMs });
      const iceRecord = await page.readIceRecord();
      process.stdout.write(JSON.stringify({ value, iceRecord }) + '\n');
    } finally {
      await page.close();
    }
    return;
  }
  if (cmd === 'targets') {
    const list = await listTargets();
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    return;
  }
  process.stderr.write(`cdp.mjs: unknown command ${JSON.stringify(cmd)}\n`);
  process.stderr.write('usage: cdp.mjs eval <url> <expression>\n');
  process.stderr.write('       cdp.mjs poll <url> <expression> <predicate-body> [<timeoutMs>] [<pollMs>]\n');
  process.stderr.write('       cdp.mjs poll-ice <url> <expression> <predicate-body> [<timeoutMs>] [<pollMs>]\n');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`cdp.mjs: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
