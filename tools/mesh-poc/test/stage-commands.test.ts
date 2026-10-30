// MESH_INTERFACE → Acceptance — a failed command's stderr must reach the
// log. Node's `execFileSync` with `stdio: 'inherit'` sends stderr to the
// parent's stream and the thrown error carries `stderr: null`; `up` would
// then exit with the status code and nothing to say. The CommandLog
// captures stderr through a pipe and the thrown Error names it.

import { describe, expect, it } from 'vitest';
import { CommandLog } from '../stage/lib/commands.mjs';

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
});
