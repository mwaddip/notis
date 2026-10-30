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
  if (cmd === 'targets') {
    const list = await listTargets();
    process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    return;
  }
  process.stderr.write(`cdp.mjs: unknown command ${JSON.stringify(cmd)}\n`);
  process.stderr.write('usage: cdp.mjs eval <url> <expression>\n');
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`cdp.mjs: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
