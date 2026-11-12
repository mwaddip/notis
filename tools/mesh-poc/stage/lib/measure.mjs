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
 * Signal `pid` with `sig`. The stage's spawns go through `sudo ip netns
 * exec ... sudo -u <user>`, so every outer wrapper on `log.pids` is
 * root-owned by sudo's exec; a scenario that runs as the invoking user
 * cannot signal it directly and `process.kill` answers EPERM. This
 * helper falls back to `sudo kill -<sig> <pid>` on EPERM so a teardown
 * reaches the whole tree without caring whether the kernel accepts the
 * direct signal. A missing process reads `{ sent: false, reason:
 * 'ESRCH' }`; a sudo-kill error is surfaced in `reason` so a caller may
 * log it. Same shape as `stage/down.mjs`'s own `signalPid`.
 */
export function signalPid(pid, sig) {
  try {
    process.kill(pid, sig);
    return { sent: true, reason: null };
  } catch (err) {
    const code = err?.code ?? 'unknown';
    if (code === 'ESRCH') return { sent: false, reason: 'ESRCH' };
    if (code === 'EPERM') {
      try {
        execFileSync('sudo', ['kill', `-${sig.replace(/^SIG/, '')}`, String(pid)], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5_000,
        });
        return { sent: true, reason: 'sudo' };
      } catch (sudoErr) {
        const stderr = sudoErr?.stderr;
        const stderrText = stderr ? (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr)) : '';
        if (/No such process/i.test(stderrText)) return { sent: false, reason: 'ESRCH' };
        return { sent: false, reason: `sudo kill ${sig} ${pid}: ${stderrText.trim() || sudoErr?.message || sudoErr}` };
      }
    }
    throw err;
  }
}

/**
 * Read whether `pid` holds kernel resources — its sockets open, its ports
 * bound. A pid with no `/proc/<pid>` entry reads false; a pid in state Z
 * (zombie: exited, parent has not reaped) or X (dead) reads false too —
 * the kernel closed its sockets and freed its ports at exit, before the
 * parent reaped. Any other state (R, S, D, T) reads true. An unreadable
 * `/proc/<pid>/status` (a root-owned stat on some kernel configurations)
 * reads true conservatively: the pid exists, its state cannot be told,
 * treat it as alive.
 */
export function isPidAlive(pid) {
  if (!existsSync(`/proc/${pid}`)) return false;
  let raw;
  try { raw = readFileSync(`/proc/${pid}/status`, 'utf8'); }
  catch { return true; }
  const m = /^State:\s*([A-Z])/m.exec(raw);
  if (!m) return true;
  return m[1] !== 'Z' && m[1] !== 'X';
}

/**
 * SIGTERM `rootPid` and every descendant it had at the signal, poll
 * `/proc` until each is gone (per `isPidAlive`), past `timeoutMs`
 * SIGKILL the survivors deepest-first and poll again for up to
 * `killGraceMs`. Each signal rides `signalPid`, so a root-owned
 * wrapper in the stage's `sudo ip netns exec ... sudo -u <user>`
 * tree is reached over `sudo kill` when the direct call answers
 * EPERM. Returns `{ initialTree, termSent, killSent, survivors }`;
 * throws naming the survivors if any pid in the initial tree still
 * stands past the kill grace.
 *
 * MESH_INTERFACE → Acceptance 5 — a scenario that stops a node before
 * starting another on the same ports calls this first, so the kernel
 * has released the ports (the state `net.start()` reads to bind) by
 * the time the restart runs.
 */
export async function stopTree(rootPid, { timeoutMs = 10_000, pollMs = 100, killGraceMs = 5_000 } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new Error(`stopTree: rootPid must be a positive integer, got ${rootPid}`);
  }
  const descendants = descendantPids(rootPid);
  const initialTree = [rootPid, ...descendants];
  const termSent = [];
  for (const pid of initialTree) {
    const r = signalPid(pid, 'SIGTERM');
    if (r.sent) termSent.push(pid);
  }
  const allGone = () => initialTree.every((p) => !isPidAlive(p));
  const termDeadline = Date.now() + timeoutMs;
  while (Date.now() < termDeadline) {
    if (allGone()) {
      return { initialTree, termSent, killSent: [], survivors: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Still alive past the TERM bound; SIGKILL deepest-first — descendants
  // ahead of ancestors, so no descendant survives its wrapper's reap.
  const stillAlive = initialTree.filter((p) => isPidAlive(p));
  const killSent = [];
  for (const pid of [...stillAlive].reverse()) {
    const r = signalPid(pid, 'SIGKILL');
    if (r.sent) killSent.push(pid);
  }
  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    if (allGone()) {
      return { initialTree, termSent, killSent, survivors: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const survivors = initialTree.filter((p) => isPidAlive(p));
  if (survivors.length > 0) {
    throw new Error(`stopTree(${rootPid}): survivors past SIGKILL + ${killGraceMs}ms grace: ${survivors.join(', ')}`);
  }
  return { initialTree, termSent, killSent, survivors };
}

/**
 * Poll `http://127.0.0.1:<adminPort>/health` inside namespace `ns`
 * until the answer carries `peers_connected >= 1`, within `timeoutMs`
 * (polling every `pollMs`). Throws naming the ns, admin port and the
 * last read on timeout.
 *
 * MESH_INTERFACE → Acceptance 5 — a scenario that restarts a mesh
 * node reads this check before its step returns: `peers_connected >= 1`
 * is positive evidence that `net.start()` bound the node's listen
 * addresses and the node reached at least one peer, as against a
 * half-started node that answers HTTP with its mesh listener dead.
 */
export async function waitNetworkingUp(ns, adminPort, { timeoutMs = 60_000, pollMs = 500, user = null } = {}) {
  if (typeof ns !== 'string' || !ns.startsWith('notismesh-')) {
    throw new Error(`waitNetworkingUp: ns must start with 'notismesh-', got ${JSON.stringify(ns)}`);
  }
  if (!Number.isInteger(adminPort) || adminPort <= 0) {
    throw new Error(`waitNetworkingUp: adminPort must be a positive integer, got ${adminPort}`);
  }
  const deadline = Date.now() + timeoutMs;
  let lastRead = null;
  while (Date.now() < deadline) {
    try {
      const opts = user !== null ? { user, timeoutMs: 8_000 } : { timeoutMs: 8_000 };
      const buf = execIn(ns, [
        'curl', '-sf', '--max-time', '5',
        `http://127.0.0.1:${adminPort}/health`,
      ], opts);
      const data = JSON.parse(buf.toString('utf8'));
      lastRead = data;
      if (typeof data.peers_connected === 'number' && data.peers_connected >= 1) {
        return data;
      }
    } catch (err) {
      lastRead = { error: err?.message ?? String(err) };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`waitNetworkingUp(${ns}, :${adminPort}) timed out after ${timeoutMs}ms; last read: ${JSON.stringify(lastRead)}`);
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
 * MESH_INTERFACE → Acceptance — a restart records its PID in pids.json
 * in place of the old one. When `pidsPath` is given, the matching
 * entry on disk is rewritten so a later `stage:down` reads the LIVE
 * pid, not a stale one. `envOverride` layers over the entry's own
 * recorded env, so a scenario respawning a node on a different
 * `BOOTSTRAP_PEERS` (or any other env the first spawn set) names
 * exactly what the restart runs on and nothing wider.
 *
 * Notis spawns go through `sudo -u <user> -- env KEY=VALUE ...
 * <binary>`, and `sudo -u` strips the process env by default — the
 * only env the child reads is the inline `env KEY=VALUE` tokens in
 * argv. `envOverride` therefore also rewrites every inline
 * `KEY=VALUE` token in argv whose key matches an override key; keys
 * the override names that argv does not already carry are appended
 * right after the `env` token in argv. The Node `spawn` env still
 * gets the override too, so a non-sudo-wrapped restart (an
 * `['sh', '-c', …]` spawn, say) reads it straight through.
 */
export function restartFromEntry(entry, { pidsPath = null, envOverride = {} } = {}) {
  if (!entry || !Array.isArray(entry.argv) || entry.argv.length === 0) {
    throw new Error(`restartFromEntry: entry has no argv: ${JSON.stringify(entry)}`);
  }
  // Rewrite inline `env KEY=VALUE …` tokens in argv to match the
  // override, for the sudo-wrapped case. An `env` token marks the
  // start of a run of `KEY=VALUE` injections the child reads past
  // sudo's env-strip; the run ends at the first non-`KEY=VALUE`
  // token (the binary). Missing keys are appended at the run's end
  // so a restart that adds a new env name reaches the child too.
  // The rewrite walks the FULL entry.argv (not the destructured
  // tail), so an entry whose first token is `env` — a direct
  // `env KEY=VALUE … sh …` spawn, as the unit case uses — also
  // honours the override.
  const fullArgv = [...entry.argv];
  const envIdx = fullArgv.indexOf('env');
  if (envIdx !== -1) {
    const seen = new Set();
    let endIdx = envIdx + 1;
    while (endIdx < fullArgv.length) {
      const tok = fullArgv[endIdx];
      if (typeof tok !== 'string') break;
      const eq = tok.indexOf('=');
      if (eq <= 0) break;
      const key = tok.slice(0, eq);
      if (Object.prototype.hasOwnProperty.call(envOverride, key)) {
        fullArgv[endIdx] = `${key}=${envOverride[key]}`;
      }
      seen.add(key);
      endIdx += 1;
    }
    const toAppend = [];
    for (const k of Object.keys(envOverride)) {
      if (!seen.has(k)) toAppend.push(`${k}=${envOverride[k]}`);
    }
    if (toAppend.length > 0) fullArgv.splice(endIdx, 0, ...toAppend);
  }
  const [name, ...argv] = fullArgv;
  const env = { ...process.env, ...(entry.env ?? {}), ...envOverride };
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
