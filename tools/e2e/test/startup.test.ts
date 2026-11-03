import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'net';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { existsSync } from 'node:fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPrivateKey, createPublicKey, randomBytes } from 'crypto';
import {
  spawnNode,
  waitForStatus,
  awaitExit,
  type NodeProcess,
} from '../src/node-process.js';
import { assertDistFresh, NODE_LOADS } from '../src/dist-freshness.js';
import { p2pPort } from '../src/ports.js';

// NET_INTERFACE → The node key → "The key file holds the key's
// `KeyPair.secretKey`". The 48-byte secretKey is RFC 8410 PKCS8 DER; Node's
// `createPrivateKey` reads it, `createPublicKey(...).export({ format: 'der',
// type: 'spki' })` writes 12 bytes of SPKI prefix then the 32-byte raw public
// key.
function nodeKeyPubHexFromFile(path: string): string {
  const key = createPrivateKey({ key: readFileSync(path), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki).subarray(12).toString('hex');
}

// NET_INTERFACE → The node key → "The node names its key at start": the start
// line prints `Net node started, peer ID: <peer id>, key: <64 hex>`.
function peerIdFromStartLine(logs: string[]): string {
  for (const line of logs) {
    const m = line.match(/Net node started, peer ID: (\S+?)(?:,|$)/);
    if (m !== null) return m[1]!;
  }
  throw new Error(`no "Net node started" line in logs:\n${logs.join('\n')}`);
}

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

  it('a held p2p port stops the node', async () => {
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
    // The node writes the thrown error's message (`net.start() threw: …`),
    // which carries Node's `EADDRINUSE` for the held TCP port; the token
    // appears in no ordinary startup line.
    expect(output).toMatch(/EADDRINUSE/);
  });

  it('MAX_PEERS=0 stops the node naming the setting', async () => {
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

  // NODE_INTERFACE → Configuration → "The key file is named for the store".
  // A fresh store on `<dir>/node.db` writes `<dir>/node.key` with mode 0600;
  // the start line names the key's 64-hex public spelling
  // (NODE_INTERFACE → Configuration → "The node names its key at start").
  it.fails('a fresh store writes its key file named for the store, and the start line names that key', async () => {
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
    const keyPath = join(dbDir, 'node.key');
    expect(existsSync(keyPath)).toBe(true);
    const st = statSync(keyPath);
    expect(st.size).toBe(48);
    expect(st.mode & 0o777).toBe(0o600);
    const expectedHex = nodeKeyPubHexFromFile(keyPath);
    const output = node.logs.join('\n');
    expect(output).toMatch(new RegExp(expectedHex));
  });

  // NODE_INTERFACE → Configuration → "A node runs under one key, and the key
  // persists": a restart on the same store keeps the key file, and the peer
  // id's identity multihash the start line prints does not change.
  it.fails('a node restarted on its store keeps its peer id', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const dbPath = join(dbDir, 'node.db');
    const miningSecret = randomBytes(32).toString('hex');
    const first = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath,
      miningSecret,
      bootstrapPeers: '',
    });
    spawned.push(first);
    await waitForStatus(first);
    const firstPeerId = peerIdFromStartLine(first.logs);
    first.kill();
    await awaitExit(first);

    const second = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath,
      miningSecret,
      bootstrapPeers: '',
    });
    spawned.push(second);
    await waitForStatus(second);
    const secondPeerId = peerIdFromStartLine(second.logs);
    expect(secondPeerId).toBe(firstPeerId);
  });

  // NODE_INTERFACE → Configuration → "The key file is named for the store":
  // two nodes whose stores sit beside each other each hold a key named for
  // its own store, so their start lines report different peer ids.
  it.fails('two nodes whose stores share a directory run under two keys', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const nodeA = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath: join(dbDir, 'a.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
    });
    spawned.push(nodeA);
    const nodeB = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 1,
      dbPath: join(dbDir, 'b.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
    });
    spawned.push(nodeB);
    await waitForStatus(nodeA);
    await waitForStatus(nodeB);
    const peerIdA = peerIdFromStartLine(nodeA.logs);
    const peerIdB = peerIdFromStartLine(nodeB.logs);
    expect(peerIdA).not.toBe(peerIdB);
  });

  // NET_INTERFACE → The node key → "The key file holds the key's
  // `KeyPair.secretKey`": a file of any other length than 48 is refused with
  // `NodeKeyError` naming the path. The node writes one line carrying the
  // error's message and exits non-zero (NODE_INTERFACE → Configuration →
  // the `NODE_KEY_PATH` row).
  it.fails('a refused key file stops the node, naming the path, and the file is left as it is', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const keyPath = join(dbDir, 'node.key');
    const planted = Buffer.alloc(47, 0xee);
    writeFileSync(keyPath, planted);
    const node = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath: join(dbDir, 'node.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
    });
    spawned.push(node);
    const { exitCode, statusAnswered } = await raceExitAndStatus(node, EXIT_DEADLINE_MS);
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(statusAnswered).toBe(false);
    const output = node.logs.join('\n');
    expect(output).toContain(keyPath);
    const bytesAfter = readFileSync(keyPath);
    expect(Buffer.compare(bytesAfter, planted)).toBe(0);
  });

  // NODE_INTERFACE → Configuration → the `NODE_KEY_PATH` row: a set
  // `NODE_KEY_PATH` names the file the node uses, and no file at the
  // store-named default is written.
  it.fails('a set NODE_KEY_PATH names the file the node uses', async () => {
    assertDistFresh(NODE_LOADS);
    const dbDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-startup-'));
    dbDirs.push(dbDir);
    const otherKey = join(dbDir, 'other.key');
    const storeNamed = join(dbDir, 'node.key');
    const node = spawnNode({
      fileIndex: FILE_INDEX,
      nodeIndex: 0,
      dbPath: join(dbDir, 'node.db'),
      miningSecret: randomBytes(32).toString('hex'),
      bootstrapPeers: '',
      env: { NODE_KEY_PATH: otherKey },
    });
    spawned.push(node);
    await waitForStatus(node);
    expect(existsSync(otherKey)).toBe(true);
    expect(existsSync(storeNamed)).toBe(false);
  });
});
