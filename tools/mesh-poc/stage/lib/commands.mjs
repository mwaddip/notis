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
// `spawn([name, ...argv], { description, env, cwd })` records a long-lived
// process. In dry-run it prints the line marked with its description; in
// exec it spawns the process and records its PID so `down` can end exactly
// those.

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';

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
      // `stdio: ['ignore', 'pipe', 'pipe']` captures stdout and stderr
      // into the thrown Error on failure (`err.stdout`, `err.stderr`),
      // so the message can carry what the process said; `'inherit'`
      // sends them to the parent and leaves `err.stderr === null`.
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
  // the rest are its arguments. `spawn` keeps the full line in the record
  // so a reader of the dry-run sees exactly what will run.
  spawn(argvFull, { description, env = {}, cwd }) {
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
    const child = nodeSpawn(name, argv, {
      env: { ...process.env, ...env },
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pids.push({ pid: child.pid, description });
    return child;
  }
}

function decodeOutput(buf) {
  if (buf === null || buf === undefined) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  // Trim trailing newlines; a short stderr like `grep: X: No such file`
  // is already tidy and a trailing newline just adds noise to the error
  // message.
  return s.replace(/\s+$/, '');
}

function quoteCommand(argv) {
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}
