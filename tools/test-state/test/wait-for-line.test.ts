import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackSpawn } from '../src/generator.js';
import { waitForLineInFile } from '../src/loader.js';

const activeChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const cp of activeChildren) {
    if (cp.exitCode === null && cp.signalCode === null) {
      try {
        cp.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  activeChildren.clear();
});

describe('waitForLineInFile', () => {
  it('ends when the process exits before the line, naming the exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-wait-'));
    try {
      const log = join(dir, 'proc.log');
      // Child exits with code 2 before writing anything.
      const cp = spawn(process.execPath, ['-e', 'process.exit(2);'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      activeChildren.add(cp);
      const tracked = trackSpawn(cp);
      await expect(
        waitForLineInFile(log, () => false, 30_000, 'child', tracked.exited),
      ).rejects.toThrow(/process exited \(code=2, signal=null\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates a non-ENOENT fs error', async () => {
    // Pass a directory as the path — statSync on it succeeds, openSync
    // throws EISDIR. The function used to swallow every fs error.
    const dir = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-wait-err-'));
    try {
      // Write a line so statSync reports size > 0 and the function
      // tries to open the path.
      writeFileSync(join(dir, 'placeholder'), 'x');
      // Never-resolving exit so the function does not short-circuit.
      const neverExit = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>(() => {
        // nothing — a pending promise
      });
      await expect(
        waitForLineInFile(dir, () => false, 2_000, 'dir-as-log', neverExit),
      ).rejects.toThrow(/EISDIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
