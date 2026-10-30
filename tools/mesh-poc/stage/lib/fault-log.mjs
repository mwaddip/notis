// MESH_INTERFACE → Acceptance — "Faults are privileged and confined to the
// stage's namespaces: nft rules added and removed in a named namespace, a
// recorded process stopped by its PID and started again with its recorded
// command. Every fault a scenario applies, it removes before it ends, pass
// or fail."
//
// `FaultLog` records every fault the scenario applies and marks it with a
// `[fault:<scenario>:<name>]` prefix on dry-run output; the matching
// removal is marked `[fault:remove:<scenario>:<name>]`. In exec mode the
// `execFileSync` call runs; in dry-run only the record is written.
//
// The log also carries a cleanup list: `removeAll()` runs every recorded
// removal (in reverse order), so a scenario's `finally` block hands the
// stage back exactly as it was before its first `apply(...)`.

import { execFileSync } from 'node:child_process';

const NS_PREFIX = 'notismesh-';

export class FaultLog {
  constructor({ dryRun, scenario }) {
    this.dryRun = dryRun;
    this.scenario = scenario;
    this.records = [];
    this.removals = [];
  }

  /**
   * Record one fault. `argv` is the privileged command (an `nft add rule
   * ...` inside a stage namespace, say); every argv has to pass through
   * `assertStagePrivileged`, which refuses anything but a `sudo ip netns
   * exec notismesh-* ...` prefix. `removalArgv` is the command that
   * undoes it (`nft delete table ip ...`), kept beside the apply.
   */
  apply(name, argv, removalArgv) {
    assertStagePrivileged(argv);
    if (removalArgv !== null && removalArgv !== undefined) {
      assertStagePrivileged(removalArgv);
    }
    const marker = `[fault:${this.scenario}:${name}]`;
    const line = `${marker} ${quoteCommand(argv)}`;
    this.records.push(line);
    if (this.dryRun) process.stdout.write(line + '\n');
    else execFileSync(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    if (removalArgv !== null && removalArgv !== undefined) {
      this.removals.push({ name, argv: removalArgv });
    }
  }

  /**
   * Stop a running process by its recorded PID. The scenario's own
   * step records what it stopped; `start` restarts it from the entry
   * `up` wrote into `pids.json`. The removal is a restart with the
   * entry's argv.
   */
  signal(name, pid, { restartArgv = null } = {}) {
    const marker = `[fault:${this.scenario}:${name}]`;
    const line = `${marker} kill -TERM ${pid}`;
    this.records.push(line);
    if (this.dryRun) process.stdout.write(line + '\n');
    else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    if (restartArgv !== null) {
      assertStagePrivileged(restartArgv);
      this.removals.push({ name, argv: restartArgv, restart: true });
    }
  }

  /**
   * Record a "would spawn" line, in dry-run only, so a reader of the
   * dry-run sees what an impostor-style scenario would start without
   * requiring an actual spawn. Exec mode is the scenario's own job
   * (the stage already has `log.spawn` in `up.mjs`).
   */
  spawn(name, argv) {
    assertStagePrivileged(argv);
    const marker = `[fault:${this.scenario}:${name}:spawn]`;
    const line = `${marker} ${quoteCommand(argv)}`;
    this.records.push(line);
    if (this.dryRun) process.stdout.write(line + '\n');
  }

  /**
   * Run every recorded removal in reverse order. A scenario's `finally`
   * block calls this; the stage is handed back to the next scenario in
   * the same state it was before `apply(...)` ran.
   */
  removeAll() {
    while (this.removals.length > 0) {
      const r = this.removals.pop();
      const marker = `[fault:remove:${this.scenario}:${r.name}]`;
      const line = `${marker} ${quoteCommand(r.argv)}`;
      this.records.push(line);
      if (this.dryRun) process.stdout.write(line + '\n');
      else {
        try {
          execFileSync(r.argv[0], r.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          // Removal has to be best-effort: the first failure in an
          // nft `delete table` sequence must not stop the rest. The
          // scenario reports it in its own output; the stage's
          // ensuing cases (and a fresh `stage:up`) are the enforcement
          // of a clean handoff.
          process.stderr.write(`[fault:remove failed] ${r.name}: ${err?.message ?? err}\n`);
        }
      }
    }
  }
}

/**
 * Every fault command runs through `sudo ip netns exec notismesh-<host>
 * ...`. The outer `sudo` is required (ip netns exec is privileged); the
 * namespace is one of the stage's. Any argv that does not match raises,
 * so a bug in a scenario cannot leak nft rules to the host.
 */
export function assertStagePrivileged(argv) {
  if (!Array.isArray(argv) || argv.length < 5) {
    throw new Error(`fault argv must be [sudo, ip, netns, exec, notismesh-*, ...]; got ${JSON.stringify(argv)}`);
  }
  if (argv[0] !== 'sudo') throw new Error(`fault argv[0] must be 'sudo'; got ${JSON.stringify(argv[0])}`);
  if (argv[1] !== 'ip') throw new Error(`fault argv[1] must be 'ip'; got ${JSON.stringify(argv[1])}`);
  if (argv[2] !== 'netns') throw new Error(`fault argv[2] must be 'netns'; got ${JSON.stringify(argv[2])}`);
  if (argv[3] !== 'exec') throw new Error(`fault argv[3] must be 'exec'; got ${JSON.stringify(argv[3])}`);
  const ns = argv[4];
  if (typeof ns !== 'string' || !ns.startsWith(NS_PREFIX)) {
    throw new Error(`fault must run inside a notismesh-* namespace; got ${JSON.stringify(ns)}`);
  }
}

function quoteCommand(argv) {
  return argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}
