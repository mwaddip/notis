// MESH_INTERFACE → Acceptance — the measurement helpers the scenarios
// share: direct HTTP reads from inside a node's namespace, DNS log line
// counts, nft counter reads, pid lookup, process signalling and restart
// from recorded argv/env, scenario-local nft rules through `execFileSync`.
//
// Every call that reaches outside the Node process goes through
// `execFileSync` with its stdio captured (never `inherit`), so a
// non-zero exit lands as a thrown Error with its stderr attached.
// Scenarios run on the host (not in a namespace), so `sudo ip netns
// exec <ns> ...` is the one path into a stage namespace.

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Run a command inside a stage namespace as the invoking user, with
 * stdout + stderr captured. Returns stdout as a `Buffer`. A non-zero
 * exit raises with `status`, `stderr` and `stdout` attached — the same
 * shape as `CommandLog.shell`.
 */
export function execIn(ns, argv, { user, timeoutMs = 10_000, inputBuffer = null } = {}) {
  if (typeof ns !== 'string' || !ns.startsWith('notismesh-')) {
    throw new Error(`execIn: ns must start with 'notismesh-', got ${JSON.stringify(ns)}`);
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(`execIn: argv must be a non-empty array, got ${JSON.stringify(argv)}`);
  }
  const outerArgv = typeof user === 'string' && user !== ''
    ? ['ip', 'netns', 'exec', ns, 'sudo', '-u', user, '--', ...argv]
    : ['ip', 'netns', 'exec', ns, ...argv];
  try {
    const opts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      ...(inputBuffer !== null ? { input: inputBuffer } : {}),
    };
    return execFileSync('sudo', outerArgv, opts);
  } catch (err) {
    const status = typeof err.status === 'number' ? err.status : null;
    const stderr = decodeOutput(err.stderr);
    const stdout = decodeOutput(err.stdout);
    const wrapped = new Error(`execIn(${ns}, ${JSON.stringify(argv.slice(0, 3))}) failed (status ${status ?? 'n/a'}): ${stderr || stdout || err.message}`);
    wrapped.cause = err;
    wrapped.status = status;
    wrapped.capturedStderr = stderr;
    wrapped.capturedStdout = stdout;
    throw wrapped;
  }
}

function decodeOutput(buf) {
  if (buf === null || buf === undefined) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return s.replace(/\s+$/, '');
}

/**
 * `curl -sf <url>` from inside `ns`'s namespace. Returns `{ status,
 * bytes, sha256 }` as the probe does — same shape, so a scenario
 * compares the two by equality. `curl -o -` writes the body to stdout;
 * the sha256 is computed by this process over the captured buffer so
 * the comparison is byte for byte.
 *
 * Short-cut: when `curl` answers a non-2xx HTTP the exit is non-zero;
 * this wrapper re-reads the headers over a second curl to recover the
 * status and bytes-length without `-sf`.
 */
export function readDirect(ns, httpUrl, { user, timeoutMs = 10_000 } = {}) {
  // One pass that captures headers AND body: `curl -sS -o /dev/stdout
  // -w '\n---mesh-poc-headers---\n%{http_code}'` — but mixing bodies
  // with status is fragile; two calls keep each small and clear.
  const body = execIn(ns, ['curl', '-sf', '--max-time', '5', httpUrl], { user, timeoutMs });
  const status = parseInt(
    execIn(ns, ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', httpUrl], { user, timeoutMs })
      .toString('utf8').trim(),
    10,
  );
  const sha = createHash('sha256').update(body).digest('hex');
  return { status, bytes: body.length, sha256: sha };
}

/**
 * Return the number of newline-terminated lines in a text file. A file
 * that does not exist returns `0`. A trailing partial line (no \n) is
 * counted; a file that is exactly `k` lines reads `k`.
 */
export function readLineCount(path) {
  if (!existsSync(path)) return 0;
  const bytes = readFileSync(path);
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n += 1;
  // A trailing line with no \n is a line too.
  if (bytes[bytes.length - 1] !== 0x0a) n += 1;
  return n;
}

/**
 * Read a file's mtime in milliseconds since epoch. A missing file
 * returns `null`. Used to bound the DNS log window: a scenario captures
 * the mtime and the line count at start, and reads them again at end.
 */
export function readMtimeMs(path) {
  if (!existsSync(path)) return null;
  return statSync(path).mtimeMs;
}

/**
 * Sum the `packets` fields across every counter in an nft ruleset JSON
 * (as `nft -j list table ip <name>` returns it). The nft JSON holds a
 * `nftables` array whose entries are objects like
 * `{ rule: { expr: [{ counter: { packets: N, bytes: M } }, ...] } }`.
 * Only counters inside `rule.expr` are summed — a bare rule with no
 * counter contributes 0.
 */
export function sumNftCounters(json) {
  let total = 0;
  if (!json || !Array.isArray(json.nftables)) return 0;
  for (const row of json.nftables) {
    const rule = row?.rule;
    if (!rule || !Array.isArray(rule.expr)) continue;
    for (const e of rule.expr) {
      const c = e?.counter;
      if (c && typeof c.packets === 'number') total += c.packets;
    }
  }
  return total;
}

/**
 * Read every counter in `table` inside `ns`, return the sum of packet
 * counts. Uses `nft -j list table ip <table>` and feeds the JSON to
 * `sumNftCounters`. A missing table reads as `0` — before the stage's
 * dns_witness table is created, every scenario reads `0`.
 */
export function readNftCounterSum(ns, table, { timeoutMs = 10_000 } = {}) {
  try {
    const out = execIn(ns, ['nft', '-j', 'list', 'table', 'ip', table], { timeoutMs });
    const json = JSON.parse(out.toString('utf8'));
    return sumNftCounters(json);
  } catch (err) {
    // `nft list table` on a missing table exits non-zero. Treat as 0.
    if (err?.capturedStderr && /No such file|does not exist|not exist/i.test(err.capturedStderr)) {
      return 0;
    }
    throw err;
  }
}

/**
 * Find the first pid entry whose `description` matches `description`.
 * Returns the entry (with `pid`, `argv`, `env`, `logPath`, …) or `null`.
 */
export function findPid(pids, description) {
  if (!Array.isArray(pids)) return null;
  for (const e of pids) {
    if (e?.description === description) return e;
  }
  return null;
}

/**
 * Send SIGTERM to `pid`. A missing process reads `{ sent: false, reason:
 * 'ESRCH' }`; a permission error is re-raised with the code.
 */
export function sigterm(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return { sent: true, reason: null };
  } catch (err) {
    const code = err?.code ?? 'unknown';
    if (code === 'ESRCH') return { sent: false, reason: 'ESRCH' };
    throw err;
  }
}

/**
 * Direct children of `pid` from `/proc/<pid>/task/{tid}/children`. A
 * dead process or missing /proc entry is silently skipped. Pure
 * read of `/proc`; no privilege.
 */
function directChildren(pid) {
  const out = [];
  let tasks;
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const tid of tasks) {
    let line;
    try { line = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim(); }
    catch { continue; }
    if (line === '') continue;
    for (const cs of line.split(/\s+/)) {
      const c = Number(cs);
      if (!Number.isInteger(c) || c <= 0) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * Walk `/proc/<pid>/task/{tid}/children` recursively and return every
 * descendant pid of `pid` (not including `pid` itself). A dead
 * process or missing /proc entry is silently skipped. Pure read of
 * `/proc`; no privilege.
 */
export function descendantPids(pid) {
  const seen = new Set();
  const stack = [pid];
  while (stack.length > 0) {
    const p = stack.pop();
    for (const c of directChildren(p)) {
      if (seen.has(c)) continue;
      seen.add(c);
      stack.push(c);
    }
  }
  return [...seen];
}

/**
 * Return the leaves of `pid`'s descendant tree — processes that have
 * no further children. Scenarios signal these when SIGSTOP must
 * reach the innermost process (sudo does not relay SIGSTOP to its
 * children, so signalling the recorded outer pid does nothing).
 */
export function leafPids(pid) {
  const all = descendantPids(pid);
  return all.filter((p) => directChildren(p).length === 0);
}

/**
 * Send an arbitrary signal to `pid` — e.g. `'SIGSTOP'` to pause and
 * `'SIGCONT'` to resume. A missing process reads
 * `{ sent: false, reason: 'ESRCH' }`; every other error is re-raised.
 * Scenarios pair SIGSTOP + SIGCONT inside a try / finally so the paused
 * process still resumes if the probe raises
 * (MESH_INTERFACE → Acceptance 1).
 */
export function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return { sent: true, reason: null };
  } catch (err) {
    const code = err?.code ?? 'unknown';
    if (code === 'ESRCH') return { sent: false, reason: 'ESRCH' };
    throw err;
  }
}

/**
 * Spawn an argv recorded in `pids.json` (its `argv` and `env` fields)
 * as a detached process with its stdout and stderr re-routed to its
 * recorded `logPath`. Returns the new `pid`. Mirrors `CommandLog.spawn`'s
 * exec path, so a scenario's restart matches `up`'s own first spawn.
 *
 * MESH_INTERFACE → Acceptance — "Record every restart's PID in pids.json
 * in place of the old one". When `pidsPath` is given, the matching
 * entry on disk is rewritten so a later `stage:down` reads the LIVE
 * pid, not a stale one.
 */
export function restartFromEntry(entry, { pidsPath = null } = {}) {
  if (!entry || !Array.isArray(entry.argv) || entry.argv.length === 0) {
    throw new Error(`restartFromEntry: entry has no argv: ${JSON.stringify(entry)}`);
  }
  const [name, ...argv] = entry.argv;
  const env = { ...process.env, ...(entry.env ?? {}) };
  const logPath = entry.logPath;
  if (typeof logPath !== 'string' || logPath === '') {
    throw new Error(`restartFromEntry: entry has no logPath: ${JSON.stringify(entry)}`);
  }
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  const child = nodeSpawn(name, argv, {
    env,
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  child.unref();
  closeSync(fd);
  const oldPid = entry.pid;
  entry.pid = child.pid;
  if (typeof pidsPath === 'string' && pidsPath !== '') {
    try {
      const raw = readFileSync(pidsPath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.pids)) {
        for (const row of data.pids) {
          if (row.pid === oldPid && row.description === entry.description) {
            row.pid = child.pid;
          }
        }
        writeFileSync(pidsPath, JSON.stringify(data, null, 2));
      }
    } catch (err) {
      process.stderr.write(`restartFromEntry: pids.json rewrite failed: ${err?.message ?? err}\n`);
    }
  }
  return child.pid;
}

/**
 * Wait up to `timeoutMs` for a predicate on a value `read()` returns,
 * polling every `pollMs`. The passing value is returned; a timeout
 * raises with the last value in the message.
 */
export async function pollUntil(read, predicate, { timeoutMs = 60_000, pollMs = 500, name = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`pollUntil(${name}) timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}

/**
 * Apply one `nft` rule inside `ns` through sudo + ip netns exec. The
 * matching removal must come from `nftDelete`. Scenarios pair every
 * `nftApply` with a removal, so a `try/finally` leaves the stage as it
 * was.
 */
export function nftApply(ns, nftArgs, { timeoutMs = 10_000 } = {}) {
  if (!Array.isArray(nftArgs) || nftArgs.length === 0) {
    throw new Error('nftApply: nftArgs must be a non-empty array');
  }
  execFileSync('sudo', ['ip', 'netns', 'exec', ns, 'nft', ...nftArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}
