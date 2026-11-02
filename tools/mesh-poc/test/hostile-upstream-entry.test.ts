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
// MESH_INTERFACE → Acceptance 6 — "A node naming a tip of its own
// that answers malformed proofs, and one that answers failing proofs,
// are blacklisted with their evidence". The hostile upstream's
// `/blocks/current` substitutes a 64-hex lie for the hash so the two
// liars name a tip no chain holds. The body builder is pure.
// eslint-disable-next-line import/extensions
import { blocksCurrentBody, LIE_HASH } from '../stage/hostile-upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'stage', 'hostile-upstream.mjs');

async function startStubUpstream(): Promise<{ base: string; close: () => Promise<void> }> {
  // A tiny upstream the hostile process forwards non-proof routes to;
  // the entry test only wants to see the hostile server listening.
  const server = createServer((_req, res) => {
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
  it('started as a script, it prints a listening line and does not exit at once', async () => {
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

describe('blocksCurrentBody — the hostile tip body', () => {
  it('substitutes a 64-hex lie for the hash and keeps every other field', () => {
    const upstream = { height: 123, hash: 'a'.repeat(64), timestampMs: 1_700_000_000_000 };
    const body = blocksCurrentBody(upstream);
    expect(body.height).toBe(123);
    expect(body.timestampMs).toBe(1_700_000_000_000);
    expect(body.hash).toBe(LIE_HASH);
    expect(LIE_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(body.hash).not.toBe(upstream.hash);
  });
  it('a null hash on the upstream is replaced too (the stage has no genesis-marker branch)', () => {
    const upstream = { height: 7, hash: null };
    const body = blocksCurrentBody(upstream);
    expect(body.hash).toBe(LIE_HASH);
    expect(body.height).toBe(7);
  });
});
