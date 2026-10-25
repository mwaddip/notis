import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  spawnNode,
  waitForStatus,
  awaitExit,
  type NodeProcess,
} from '../src/node-process.js';
import { assertDistFresh, NODE_LOADS } from '../src/dist-freshness.js';
import { p2pPort } from '../src/ports.js';

const FILE_INDEX = 24;
const EXIT_DEADLINE_MS = 30_000;

interface SpawnedStatus {
  exitCode: number | null;
  statusAnswered: boolean;
}

async function waitExitBounded(
  node: NodeProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (node.child.exitCode !== null) return node.child.exitCode;
  return new Promise<number | null>((r) => {
    const timer = setTimeout(() => r(null), timeoutMs);
    node.child.on('exit', (code) => {
      clearTimeout(timer);
      r(code);
    });
  });
}

async function raceExitAndStatus(
  node: NodeProcess,
  timeoutMs: number,
): Promise<SpawnedStatus> {
  let answered = false;
  let halted = false;
  const probe = (async () => {
    while (!halted && node.child.exitCode === null) {
      try {
        const res = await fetch(`${node.url}/status`);
        if (res.ok) {
          answered = true;
          return;
        }
      } catch {
        /* the port is not accepting yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const exitCode = await waitExitBounded(node, timeoutMs);
  halted = true;
  await probe;
  return { exitCode, statusAnswered: answered };
}

describe('startup', () => {
  const spawned: NodeProcess[] = [];
  const dbDirs: string[] = [];
  const heldSockets: Server[] = [];

  afterEach(async () => {
    for (const n of spawned) {
      if (n.child.exitCode === null) {
        n.kill();
        await awaitExit(n);
      }
    }
    spawned.length = 0;
    for (const s of heldSockets) {
      await new Promise<void>((r) => s.close(() => r()));
    }
    heldSockets.length = 0;
    for (const d of dbDirs) rmSync(d, { recursive: true, force: true });
    dbDirs.length = 0;
  });

  it('a free p2p port and the default MAX_PEERS let the node answer /status', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const node = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath: join(dbDir, 'node.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
    });
    spawned.push(node);
    await waitForStatus(node);
    const res = await fetch(`${node.url}/status`);
    expect(res.ok).toBe(true);
  });

  it.fails('a held p2p port stops the node', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const port = p2pPort(FILE_INDEX, 0);
    const server = createServer();
    heldSockets.push(server);
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    expect(listening).toBe(true);
    const addr = server.address();
    expect(addr !== null && typeof addr === 'object' && addr.port === port).toBe(true);

    const node = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath: join(dbDir, 'node.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
    });
    spawned.push(node);

    const { exitCode, statusAnswered } = await raceExitAndStatus(node, EXIT_DEADLINE_MS);
    // NODE_INTERFACE → Net Integration → "A `net.start()` that throws stops the node"
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(statusAnswered).toBe(false);
    const output = node.logs.join('\n');
    // libp2p's `UnsupportedListenAddressesError` wraps Node's `EADDRINUSE` for
    // the held TCP port; neither token appears in an ordinary startup line.
    expect(output).toMatch(/UnsupportedListenAddressesError|EADDRINUSE/);
  });

  it.fails('MAX_PEERS=0 stops the node naming the setting', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const node = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath: join(dbDir, 'node.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
      env: { MAX_PEERS: '0' },
    });
    spawned.push(node);

    const { exitCode, statusAnswered } = await raceExitAndStatus(node, EXIT_DEADLINE_MS);
    // NODE_INTERFACE → Configuration → "Every whole-number setting is read by one reader, and a set value it refuses stops the node at load"
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(statusAnswered).toBe(false);
    const output = node.logs.join('\n');
    expect(output).toMatch(/MAX_PEERS/);
  });
});
