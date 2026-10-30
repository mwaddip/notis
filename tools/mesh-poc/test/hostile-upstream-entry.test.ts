// MESH_INTERFACE → Acceptance — `stage/hostile-upstream.mjs` runs as a
// script. The file exports `startHostileUpstream` but needs an entry
// block that reads MODE / PORT / PUB1_BASE and starts the server; main's
// run saw both hostile processes exit 0 with empty logs because the
// file had no entry.

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'stage', 'hostile-upstream.mjs');

async function startStubUpstream(): Promise<{ base: string; close: () => Promise<void> }> {
  // A tiny upstream the hostile process forwards non-proof routes to;
  // the entry test only wants to see the hostile server listening.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('stage/hostile-upstream.mjs — entry point', () => {
  it.fails('started as a script, it prints a listening line and does not exit at once', async () => {
    const upstream = await startStubUpstream();
    try {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          MODE: 'malformed',
          PORT: '0',
          PUB1_BASE: upstream.base,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
      child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

      // Give the server up to 5 s to listen. If the file has no entry
      // block, the child exits 0 before any output lands.
      const listening = await Promise.race([
        new Promise<boolean>((resolve) => {
          const i = setInterval(() => {
            if (/listening/i.test(stdout)) { clearInterval(i); resolve(true); }
          }, 50);
          setTimeout(() => { clearInterval(i); resolve(false); }, 5_000);
        }),
        new Promise<boolean>((resolve) => {
          child.once('exit', () => resolve(false));
        }),
      ]);

      try { child.kill('SIGTERM'); } catch { /* already gone */ }

      expect(listening, `expected a "listening" line; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`).toBe(true);
    } finally {
      await upstream.close();
    }
  }, 15_000);
});
