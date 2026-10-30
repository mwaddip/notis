// MESH_INTERFACE → Acceptance — the stage never touches the host outside
// `notismesh-*` namespaces, their nft rules and `/etc/netns/<ns>/resolv.conf`.
// Every command this file runs or logs says what it does, and `up --dry-run`
// prints the privileged ones for a reader to check before `up` runs for real.
//
// `shell(name, argv, { privileged })` records one short-lived command. In
// dry-run mode it prints the line with its marking; in exec mode it runs it
// through `execFileSync` so a non-zero exit stops `up`.
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
    execFileSync(name, argv, { stdio: 'inherit' });
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

function quoteCommand(argv) {
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}
