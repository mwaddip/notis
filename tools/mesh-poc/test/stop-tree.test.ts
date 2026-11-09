// MESH_INTERFACE → Acceptance 5 — the helper the scenarios call before
// a stop-then-start on the same ports: send SIGTERM to a recorded PID
// and every descendant it had at the signal, poll /proc until each is
// gone, past the bound SIGKILL the survivors deepest-first and poll
// again. A stop is complete when the kernel has closed the tree's
// sockets — the state the restart's `net.start()` reads to bind.
//
// The cases here spawn a child tree this process owns, so every signal
// stays user-to-user; the stage's root-owned wrappers go through the
// sudo fallback and are covered by `signalPid` alone (below).

import { describe, expect, it } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stopTree, signalPid, isPidAlive, descendantPids } from '../stage/lib/measure.mjs';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read /proc/<pid>/status and return the one-letter State field, or null. */
function procState(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^State:\s*([A-Z])/m.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function waitForDescendants(pid: number, count: number, deadlineMs: number): Promise<number[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const d = descendantPids(pid);
    if (d.length >= count) return d;
    await sleep(25);
  }
  return descendantPids(pid);
}

describe('isPidAlive', () => {
  it('a /proc entry that does not exist reads false', () => {
    // 2^22 - 1 is above the kernel's pid_max default and will not resolve.
    expect(isPidAlive(4194303)).toBe(false);
  });
  it('the current process reads true', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('a zombie reads false (the kernel released its resources before reaping)', async () => {
    // Spawn a child that exits at once. Do not attach an `exit` listener
    // so Node does not reap it — the child sits as a zombie until the
    // test exits.
    const child = nodeSpawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    const pid = child.pid!;
    // Poll /proc until State goes to Z.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (procState(pid) === 'Z') break;
      await sleep(25);
    }
    expect(procState(pid)).toBe('Z');
    expect(isPidAlive(pid)).toBe(false);
    // Reap so vitest does not leave a lingering zombie across tests.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });
});

describe('signalPid', () => {
  it('a missing pid reads ESRCH', () => {
    const r = signalPid(4194303, 'SIGTERM');
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('ESRCH');
  });
  it('a user-owned pid reads sent with SIGCONT (a no-op signal on a running process)', async () => {
    const child = nodeSpawn('sh', ['-c', 'exec sleep 30'], { stdio: 'ignore', detached: true });
    const pid = child.pid!;
    child.unref();
    try {
      const r = signalPid(pid, 'SIGCONT');
      expect(r.sent).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('stopTree', () => {
  it('a sh with two sleep children exits on SIGTERM and the function reads no survivors', async () => {
    // One sh with two sleep grandchildren: the sh waits on both.
    const parent = nodeSpawn(
      'sh',
      ['-c', 'sleep 60 & sleep 60 & wait'],
      { stdio: 'ignore', detached: true },
    );
    const pid = parent.pid!;
    parent.unref();
    try {
      // Wait until both sleeps show up as descendants.
      const d = await waitForDescendants(pid, 2, 2_000);
      expect(d.length).toBeGreaterThanOrEqual(2);
      const result = await stopTree(pid, { timeoutMs: 5_000, pollMs: 50 });
      expect(result.survivors).toEqual([]);
      expect(result.initialTree).toContain(pid);
      expect(result.initialTree.length).toBeGreaterThanOrEqual(3);
      expect(result.termSent.length).toBeGreaterThan(0);
      expect(result.killSent).toEqual([]);
      // Every pid in the initial tree reads not-alive.
      for (const p of result.initialTree) {
        expect(isPidAlive(p), `pid ${p} should be gone`).toBe(false);
      }
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 10_000);

  it('a child that ignores SIGTERM reaches SIGKILL and the function reads killSent', async () => {
    // `trap "" TERM` ignores SIGTERM; SIGKILL is uncatchable.
    const child = nodeSpawn(
      'sh',
      ['-c', 'trap "" TERM; exec sleep 60'],
      { stdio: 'ignore', detached: true },
    );
    const pid = child.pid!;
    child.unref();
    try {
      // Give `sh` a moment to install the trap and exec into sleep.
      await sleep(100);
      const result = await stopTree(pid, { timeoutMs: 400, pollMs: 50, killGraceMs: 2_000 });
      expect(result.survivors).toEqual([]);
      expect(result.killSent.length).toBeGreaterThan(0);
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 10_000);

  it('a pid that is already gone reads an empty tree with no survivors', async () => {
    // Spawn a child that exits at once; wait for it to be reaped.
    const child = nodeSpawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    // Short delay so the /proc entry has time to clear.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && existsSync(`/proc/${pid}`)) {
      await sleep(25);
    }
    const result = await stopTree(pid, { timeoutMs: 400, pollMs: 50 });
    expect(result.survivors).toEqual([]);
  });

  it('rejects a non-positive rootPid', async () => {
    await expect(stopTree(0)).rejects.toThrow(/rootPid/);
    await expect(stopTree(-1)).rejects.toThrow(/rootPid/);
  });
});
