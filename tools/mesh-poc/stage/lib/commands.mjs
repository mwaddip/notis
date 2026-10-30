// MESH_INTERFACE → Acceptance — the stage never touches the host outside
// `notismesh-*` namespaces, their nft rules and `/etc/netns/<ns>/resolv.conf`.
// Every command this file runs or logs says what it does, and `up --dry-run`
// prints the privileged ones for a reader to check before `up` runs for real.
//
// `logShell(line, { privileged })` records one command. In dry-run mode it
// prints it with its marking; in exec mode it runs it through `execFileSync`
// so a non-zero exit stops `up`.

import { execFileSync, spawn } from 'node:child_process';

export class CommandLog {
  constructor({ dryRun }) {
    this.dryRun = dryRun;
    this.records = [];
    this.privilegedCount = 0;
    this.pids = [];
  }

  // A command the stage would run on the host, through `sudo` or `ip netns
  // exec` (which itself needs root to enter a namespace). The log line names
  // the host's own binary and arguments; `privileged: true` marks it so a
  // reader can see what `sudo` the stage would run.
  shell(name, argv, { privileged = false } = {}) {
    const line = quoteCommand(name, argv);
    if (privileged) this.privilegedCount += 1;
    const marked = privileged ? `[privileged] ${line}` : line;
    this.records.push(marked);
    if (this.dryRun) {
      process.stdout.write(marked + '\n');
      return;
    }
    execFileSync(name, argv, { stdio: 'inherit' });
  }

  // Spawn a long-running process in a namespace. In dry-run, log and skip;
  // in exec, start it and record its PID so `down` can end exactly those.
  spawn(name, argv, { description, env = {}, cwd }) {
    const line = quoteCommand(name, argv);
    const marked = `[spawn:${description}] ${line}`;
    this.records.push(marked);
    if (this.dryRun) {
      process.stdout.write(marked + '\n');
      return null;
    }
    const child = spawn(name, argv, {
      env: { ...process.env, ...env },
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pids.push({ pid: child.pid, description });
    return child;
  }
}

function quoteCommand(name, argv) {
  const parts = [name, ...argv].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a));
  return parts.join(' ');
}
