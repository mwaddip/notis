import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { streamChildToLog, trackSpawn } from '../src/generator.js';

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

describe('streamChildToLog', () => {
  it('writes each chunk to the log file as the child emits it', async () => {
    // A child that prints one line, pauses, then prints another and
    // exits. Under the pre-fix shape the generator buffered chunks in
    // an array and wrote them once at readiness, so a failure between
    // the two prints would leave the second line in memory, not on
    // disk. The streaming shape writes every chunk as it arrives, so
    // a work directory kept on a failure reads everything up to the
    // moment of the throw.
    const dir = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-stream-'));
    try {
      const log = join(dir, 'child.log');
      const cp = spawn(
        process.execPath,
        [
          '-e',
          "process.stdout.write('first line\\n'); setTimeout(() => { process.stdout.write('second line\\n'); process.exit(0); }, 200);",
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      activeChildren.add(cp);
      const tracked = trackSpawn(cp);
      streamChildToLog(cp, log);
      // Shortly after the first print (which lands synchronously at
      // process start), the log already carries that line. The second
      // line has not been written yet.
      await sleep(80);
      const partial = readFileSync(log, 'utf8');
      expect(partial).toContain('first line');
      expect(partial).not.toContain('second line');
      // After the child exits, both lines are on disk.
      await tracked.exited;
      const full = readFileSync(log, 'utf8');
      expect(full).toContain('first line');
      expect(full).toContain('second line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes stderr with the [stderr] prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-stream-err-'));
    try {
      const log = join(dir, 'child.log');
      const cp = spawn(
        process.execPath,
        ['-e', "process.stderr.write('boom\\n'); process.exit(0);"],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      activeChildren.add(cp);
      const tracked = trackSpawn(cp);
      streamChildToLog(cp, log);
      await tracked.exited;
      const contents = readFileSync(log, 'utf8');
      expect(contents).toContain('[stderr] boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
