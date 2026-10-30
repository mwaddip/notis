// MESH_INTERFACE → Acceptance — a failed command's stderr must reach the
// log. Node's `execFileSync` with `stdio: 'inherit'` sends stderr to the
// parent's stream and the thrown error carries `stderr: null`; `up` would
// then exit with the status code and nothing to say. The CommandLog
// captures stderr through a pipe and the thrown Error names it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandLog, isProcessAlive } from '../stage/lib/commands.mjs';

describe('stage/lib/commands.mjs', () => {
  it('shell throws an Error that names the failed command and its stderr', () => {
    const log = new CommandLog({ dryRun: false });
    let caught: unknown;
    try {
      // `grep` on a missing file writes `grep: ...: No such file or
      // directory` to stderr and exits non-zero. The phrase "No such
      // file" is not part of the command's argv, so finding it in the
      // Error message proves the capture read it off stderr, not from
      // the command text.
      log.shell('grep', ['pattern', '/notis-mesh-stage-missing-xyz7']);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'shell must throw on exit != 0').toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg, `message names the command: ${msg}`).toContain('grep');
    expect(msg, `message carries stderr: ${msg}`).toContain('No such file');
    expect(msg, `message names the status: ${msg}`).toMatch(/status\s+2\b/);
  }, 10_000);

  it('shell does not log a successful command any differently in dry-run', () => {
    const log = new CommandLog({ dryRun: true });
    // Dry-run must not raise on any shell call — a dry-run exercises the
    // shape of what up would run, not its real exit code.
    expect(() => log.shell('whatever-does-not-exist', ['--flag'])).not.toThrow();
  });

  // MESH_INTERFACE → Acceptance — spawn's stdout and stderr go to a log
  // file through an fd `openSync` gives, not a pipe. A pipe fills at 64 KB
  // and blocks the child; a Notis node logging every block would hang
  // mid-run. A 1 MB write to stdout finishes and the file carries every
  // byte.
  describe('spawn with logPath', () => {
    let dir = '';
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mesh-spawn-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('sends stdout to the log file and does not block on 1 MB', async () => {
      const log = new CommandLog({ dryRun: false });
      const logPath = join(dir, 'child.log');
      // 1 MiB of 'x' bytes on stdout, then exit 0. This is well past the
      // 64 KB kernel pipe default; a child whose stdout is a pipe nothing
      // reads blocks forever at that boundary.
      const child = log.spawn(['sh', '-c', 'yes x | head -c 1048576'], {
        description: 'thousand-and-change',
        logPath,
      });
      expect(child, 'spawn returns a child in exec mode').not.toBeNull();
      const exitCode = await new Promise<number>((resolve) => {
        child!.once('exit', (code) => resolve(code ?? -1));
      });
      // A 10-second timeout is well above a well-behaved child's write;
      // vitest will fail the test if we exceed it.
      expect(exitCode, 'child exited cleanly').toBe(0);
      const size = statSync(logPath).size;
      expect(size, 'log file holds the 1 MiB write').toBe(1048576);
    }, 10_000);

    // MESH_INTERFACE → Acceptance — a spawned child does not keep `up`'s
    // event loop alive. `detached: true` starts a new process group;
    // `child.unref()` drops the child from the parent's reference count,
    // so `up` returns 0 right after its last line and `down` reads
    // `pids.json` to find the children. The process-group check — pgid
    // equals the child's pid — is the direct evidence `detached: true`
    // took effect.
    it('starts the child in its own process group (detached: true + unref)', async () => {
      const log = new CommandLog({ dryRun: false });
      const logPath = join(dir, 'detached.log');
      const child = log.spawn(['sh', '-c', 'sleep 10'], {
        description: 'detached-child',
        logPath,
      });
      expect(child, 'spawn returned a child').not.toBeNull();
      try {
        const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(child!.pid)], { encoding: 'utf8' });
        const pgid = Number(out.trim());
        expect(pgid, 'pgid is a positive integer').toBeGreaterThan(0);
        expect(pgid, 'pgid === pid: the child is its own process group leader').toBe(child!.pid);
      } finally {
        // SIGTERM the whole process group so the child sh and its sleep
        // both exit; a lingering sleep would print as a zombie in `ps`
        // after the test.
        try { process.kill(-child!.pid!, 'SIGTERM'); } catch { /* already gone */ }
      }
    });

    // MESH_INTERFACE → Acceptance — up's live-check reads the outer
    // `sudo` process by its pid; sudo runs as root, up runs as the
    // user, and `process.kill(pid, 0)` on a running process the user
    // does not own throws `EPERM`, not success. The live-check must
    // treat `EPERM` as alive (the process exists; signalling is just
    // forbidden) and only `ESRCH` as dead. PID 1 is init, root-owned,
    // always alive, and never ours.
    it('isProcessAlive reads PID 1 as alive (EPERM, not ESRCH)', () => {
      const r = isProcessAlive(1);
      expect(r.alive, 'PID 1 is alive: EPERM is alive, not dead').toBe(true);
      expect(r.reason, 'reason names EPERM so a reader sees why').toContain('EPERM');
    });

    it('isProcessAlive reads an unused pid as dead (ESRCH)', () => {
      // POSIX pid_max defaults to 32768 on this kernel; a very high
      // unused value is reliably absent. Pick one above 2^22 (far
      // above pid_max on any default-configured Linux) and expect
      // ESRCH.
      const r = isProcessAlive(0x7fff_ffff);
      expect(r.alive).toBe(false);
      expect(r.reason).toContain('ESRCH');
    });

    it('records the logPath on log.pids so down can find it', () => {
      const log = new CommandLog({ dryRun: false });
      const logPath = join(dir, 'test-pids.log');
      const child = log.spawn(['sh', '-c', 'exit 0'], {
        description: 'pid-recorder',
        logPath,
      });
      expect(child).not.toBeNull();
      const entry = log.pids.find((p) => p.description === 'pid-recorder');
      expect(entry, 'pid entry recorded').toBeDefined();
      expect(entry!.logPath, 'logPath carried on the entry').toBe(logPath);
      // Reap the child to avoid a zombie before the next case.
      return new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
      });
    });

    // MESH_INTERFACE → Acceptance — "up records each process's full
    // argv and environment in pids.json so a scenario can restart it
    // as it was". The entry's `argv` carries every element of the
    // spawn's argvFull; `env` carries only the explicit vars the
    // spawner passed, so a restart picks up the current process's
    // PATH and HOME as a fresh `up` would.
    it('records argv and env on each pid entry so a scenario can restart it', () => {
      const log = new CommandLog({ dryRun: false });
      const logPath = join(dir, 'test-argv.log');
      const argvFull = ['sh', '-c', 'exit 0'];
      const env = { NOTIS_TEST_VAR: 'yes' };
      const child = log.spawn(argvFull, {
        description: 'argv-recorder',
        env,
        logPath,
      });
      expect(child).not.toBeNull();
      const entry = log.pids.find((p) => p.description === 'argv-recorder');
      expect(entry, 'pid entry recorded').toBeDefined();
      expect((entry as unknown as { argv: unknown }).argv, 'argv carried on the entry').toEqual(argvFull);
      expect((entry as unknown as { env: unknown }).env, 'env carried on the entry').toEqual(env);
      // No cwd was passed, so no cwd field is on the entry.
      expect((entry as unknown as { cwd?: unknown }).cwd).toBeUndefined();
      return new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
      });
    });
  });
});
