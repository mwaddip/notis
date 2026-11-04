// NODE_INTERFACE → Configuration → "A mesh node prints its identity
// line" — a started node with a public mesh writes one JSON line on
// stdout, the `MeshIdentity` fields in order (`notisId`, `peerId`,
// `multiaddrs`, `localAddrs`), nothing else on the line. The spawned
// node is the built `dist/index.js`: vitest's alias runs only inside
// its own process, so a child process is the one shape that exercises
// the start line the operator reads.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const NODE_ENTRY = resolve(__dirname, '..', 'dist', 'index.js');

describe('NODE_INTERFACE → Configuration → "A mesh node prints its identity line"', () => {
  let distExists = true;
  beforeAll(() => {
    try {
      statSync(NODE_ENTRY);
    } catch {
      distExists = false;
    }
  });

  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterAll(() => {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  });

  it('a public mesh node prints one JSON line with the MeshIdentity fields in order before any change', async () => {
    if (!distExists) {
      throw new Error(`built node missing at ${NODE_ENTRY} — pnpm -r build first`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'node-mesh-identity-'));
    dirs.push(dir);
    const child = spawn(
      process.execPath,
      [NODE_ENTRY],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NETWORK_TYPE: 'devnet',
          NODE_ROLE: 'server',
          PORT: '0',
          ADMIN_PORT: '0',
          DB_PATH: join(dir, 'node.db'),
          LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0',
          BOOTSTRAP_PEERS: '',
          MESH_ROLE: 'public',
          // MESH_INTERFACE → NAT — "A public node announces its listen
          // addresses from the start": a WebRTC-direct address on a
          // random UDP port is enough for `meshIdentity()` to become
          // non-null at the first announce.
          MESH_LISTEN: '/ip4/127.0.0.1/udp/0/webrtc-direct',
          // MESH_INTERFACE → NAT — "Only the relayed WebRTC path uses
          // STUN": the STUN server is off to keep the test off the
          // default `STUN_PORT` 3478.
          MESH_STUN: 'off',
        },
      },
    );
    children.push(child);

    const identityLines: string[] = [];
    let partial = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop()!;
      for (const line of lines) {
        if (line.length === 0) continue;
        // The journal writes lines carrying `timestamp` and `event`
        // keys (no `notisId`); the identity line is the one JSON
        // object with `notisId`.
        let obj: Record<string, unknown> | null = null;
        try {
          const v: unknown = JSON.parse(line);
          if (typeof v === 'object' && v !== null && 'notisId' in v) {
            obj = v as Record<string, unknown>;
          }
        } catch { /* not JSON — a start line, not an identity line */ }
        if (obj !== null) identityLines.push(line);
      }
    });

    // Wait up to 30 s for the first identity line.
    const deadline = Date.now() + 30_000;
    while (identityLines.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) {
        throw new Error(`node exited early with code ${child.exitCode}`);
      }
    }
    expect(identityLines.length).toBeGreaterThanOrEqual(1);

    // The first line's keys and their order are the MeshIdentity
    // fields: `notisId`, `peerId`, `multiaddrs`, `localAddrs`.
    const first = JSON.parse(identityLines[0]!) as Record<string, unknown>;
    expect(Object.keys(first)).toEqual(['notisId', 'peerId', 'multiaddrs', 'localAddrs']);
    expect(typeof first['notisId']).toBe('string');
    expect(typeof first['peerId']).toBe('string');
    expect(Array.isArray(first['multiaddrs'])).toBe(true);
    expect(Array.isArray(first['localAddrs'])).toBe(true);
    // The identity's `notisId` is 64 lowercase hex.
    expect(/^[0-9a-f]{64}$/.test(first['notisId'] as string)).toBe(true);
    // A public node's `localAddrs` is empty (announces its listen
    // addresses already) — MESH_INTERFACE → Discovery → "A node added
    // by hand".
    expect(first['localAddrs']).toEqual([]);
  }, 60_000);
});
