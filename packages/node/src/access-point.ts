// NODE_INTERFACE → The access-point tool — the CLI entry. `main(argv,
// runner)` takes the Runner seam (`src/access-point/run.ts`); this file
// alone constructs the real one.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { Runner, RunResult } from './access-point/run.js';

export async function main(_argv: readonly string[], _runner: Runner): Promise<number> {
  return 1;
}

function realRunner(): Runner {
  return {
    async run(cmd, args): Promise<RunResult> {
      return await new Promise((resolve, reject) => {
        const child = spawn(cmd, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (b: Buffer) => stdout.push(b));
        child.stderr.on('data', (b: Buffer) => stderr.push(b));
        child.once('error', reject);
        child.once('close', (code: number | null) => {
          resolve({
            code: code ?? 0,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        });
      });
    },
    async write(path, text): Promise<void> {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, text, 'utf8');
    },
    async read(path): Promise<string | null> {
      try {
        return await fs.readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(path): Promise<void> {
      try {
        await fs.unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
    isRoot(): boolean {
      return typeof process.getuid === 'function' && process.getuid() === 0;
    },
    log(msg): void {
      process.stdout.write(msg + '\n');
    },
  };
}

// The entry: run `main` when the file is invoked as a module, exit non-zero
// on an uncaught throw with the message on stderr.
const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  main(process.argv.slice(2), realRunner()).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`dagsocial-access-point: ${msg}\n`);
      process.exit(1);
    },
  );
}
