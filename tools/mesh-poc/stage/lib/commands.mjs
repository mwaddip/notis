// MESH_INTERFACE → Acceptance — the stage never touches the host outside
// `notismesh-*` namespaces, their nft rules and `/etc/netns/<ns>/resolv.conf`.
// Every command this file runs or logs says what it does, and `up --dry-run`
// prints the privileged ones for a reader to check before `up` runs for real.
//
// `shell(name, argv, { privileged })` records one short-lived command. In
// dry-run mode it prints the line with its marking; in exec mode it runs it
// through `execFileSync` with stdout/stderr captured by pipes and surfaces
// both on failure in the thrown Error's message — a lost stderr makes a
// non-zero exit silent, which is what the previous `stdio: 'inherit'` did.
//
// `spawn([name, ...argv], { description, env, cwd, logPath })` records a
// long-lived process. In dry-run it prints the line marked with its
// description; in exec it opens `logPath` and hands the kernel file
// descriptor to the child as its stdout and stderr — a pipe fills at the
// kernel's 64 KB default and blocks the child, so a Notis node logging
// every block would hang mid-run. `log.pids` carries the `logPath` so
// `down` and the wait helpers can tail it.

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export class CommandLog {
  constructor({ dryRun }) {
    this.dryRun = dryRun;
    this.records = [];
    this.privilegedCount = 0;
    this.pids = [];
  }

  shell(name, argv, { privileged = false } = {}) {
    const line = quoteCommand([name, ...argv]);
    if (privileged) this.privilegedCount += 1;
    const marked = privileged ? `[privileged] ${line}` : line;
    this.records.push(marked);
    if (this.dryRun) {
      process.stdout.write(marked + '\n');
      return;
    }
    try {
      execFileSync(name, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const status = typeof err.status === 'number' ? err.status : null;
      const signal = err.signal ?? null;
      const stderr = decodeOutput(err.stderr);
      const stdout = decodeOutput(err.stdout);
      const parts = [`Command failed (status ${status ?? 'n/a'}${signal ? ', signal ' + signal : ''}): ${line}`];
      if (stderr !== '') parts.push(`stderr: ${stderr}`);
      if (stdout !== '') parts.push(`stdout: ${stdout}`);
      const wrapped = new Error(parts.join('\n'));
      wrapped.cause = err;
      wrapped.status = status;
      wrapped.capturedStderr = stderr;
      wrapped.capturedStdout = stdout;
      throw wrapped;
    }
  }

  // `argvFull` is the complete command — `argvFull[0]` is the binary and
  // the rest are its arguments. In exec mode `logPath` is required so the
  // child's output lands in a file instead of a pipe nothing reads; the
  // entry on `log.pids` carries it. Dry-run skips the file open.
  spawn(argvFull, { description, env = {}, cwd, logPath }) {
    if (!Array.isArray(argvFull) || argvFull.length === 0) {
      throw new Error('spawn needs a non-empty argv array');
    }
    const [name, ...argv] = argvFull;
    const line = quoteCommand(argvFull);
    const marked = `[spawn:${description}] ${line}`;
    this.records.push(marked);
    if (this.dryRun) {
      process.stdout.write(marked + '\n');
      return null;
    }
    if (typeof logPath !== 'string' || logPath === '') {
      throw new Error(`spawn ${description} requires logPath in exec mode`);
    }
    mkdirSync(dirname(logPath), { recursive: true });
    // `openSync(path, 'w')` truncates on open; the child's stdout and
    // stderr both write into this one fd (interleaved — ok for a log).
    // The parent's copy is closed after spawn so a reader that opens
    // the file for reading sees the child's writes. `detached: true`
    // starts the child in its own process group; `child.unref()` drops
    // it from the parent's reference count, so `up` returns right after
    // its last line and `down` reads `pids.json` to find the children.
    const fd = openSync(logPath, 'w');
    const child = nodeSpawn(name, argv, {
      env: { ...process.env, ...env },
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    child.unref();
    closeSync(fd);
    this.pids.push({ pid: child.pid, description, logPath });
    return child;
  }
}

function decodeOutput(buf) {
  if (buf === null || buf === undefined) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return s.replace(/\s+$/, '');
}

function quoteCommand(argv) {
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}
