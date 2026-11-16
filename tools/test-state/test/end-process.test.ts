import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { endProcess, trackSpawn } from '../src/generator.js';

describe('endProcess', () => {
  it('resolves on a child already killed by SIGKILL, and a second call returns at once', async () => {
    // A sleeping child whose only job is to stay alive. SIGKILL from
    // outside leaves `cp.exitCode` as null and `cp.signalCode` as
    // 'SIGKILL'. An endProcess that attached `once('exit')` after the
    // event waits forever; `trackSpawn` at the moment of spawn captures
    // the exit event up front, so the first call resolves and the
    // second returns at once.
    const cp = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000);'],
      { stdio: 'ignore' },
    );
    const tracked = trackSpawn(cp);
    // Let the child's event loop register its interval.
    await sleep(100);
    process.kill(cp.pid!, 'SIGKILL');
    await endProcess(tracked);
    expect(cp.exitCode).toBeNull();
    expect(cp.signalCode).toBe('SIGKILL');
    // The second call is a no-op: SIGTERM on a dead pid throws (ignored)
    // and `await tracked.exited` resolves without waiting.
    const start = Date.now();
    await endProcess(tracked);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
