// NODE_INTERFACE → Configuration → "The node's mesh endpoint forwards
// to its own public listener" — exercised through the node's own start
// (`dist/index.js`, spawned as a child). The reader dials the node's
// announced WebRTC-direct address, runs `readerHandshake`, reads
// `/blocks/current` over the mesh and over direct HTTP at the port
// `api_listening` names, and asserts the mesh answer equals the direct
// answer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection } from '@libp2p/interface';
import {
  generateKeyPair,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import {
  nodeKeyFromKeyPair,
  readerHandshake,
  readerLibp2pOptions,
  meshFetchOverConnection,
  meshBaseUrl,
} from '../../net/src/browser.js';

const NODE_ENTRY = resolve(__dirname, '..', 'dist', 'index.js');
const DEVNET_MAGIC = profileFor('devnet').magic;

async function pickFreePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => { srv.listen(0, '127.0.0.1', r); });
  const addr = srv.address() as AddressInfo;
  const port = addr.port;
  await new Promise<void>((r) => { srv.close(() => r()); });
  return port;
}

interface SpawnedNode {
  child: ChildProcess;
  dir: string;
  apiPort: number;
  notisId: string;
  webrtcAddr: string;
}

/**
 * Spawn `dist/index.js` with a public mesh, read its stdout for the
 * `api_listening` event (the bound port) and the identity line (the
 * announced WebRTC-direct address and `notisId`), and resolve once both
 * have arrived.
 */
async function startNode(
  portEnv: string,
  dirPrefix: string,
): Promise<SpawnedNode> {
  try { statSync(NODE_ENTRY); }
  catch { throw new Error(`built node missing at ${NODE_ENTRY} — pnpm -r build first`); }
  const dir = mkdtempSync(join(tmpdir(), dirPrefix));
  const child = spawn(
    process.execPath,
    [NODE_ENTRY],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NETWORK_TYPE: 'devnet',
        NODE_ROLE: 'server',
        PORT: portEnv,
        ADMIN_PORT: '0',
        ADMIN_BIND_ADDRESS: '127.0.0.1',
        DB_PATH: join(dir, 'node.db'),
        LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0',
        BOOTSTRAP_PEERS: '',
        MESH_ROLE: 'public',
        MESH_LISTEN: '/ip4/127.0.0.1/udp/0/webrtc-direct',
        // STUN is off so the test does not bind the default STUN_PORT 3478.
        MESH_STUN: 'off',
      },
    },
  );

  let apiPort: number | null = null;
  let notisId: string | null = null;
  let webrtcAddr: string | null = null;

  let partial = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop()!;
    for (const line of lines) {
      if (line.length === 0) continue;
      let obj: Record<string, unknown> | null = null;
      try { obj = JSON.parse(line) as Record<string, unknown>; }
      catch { continue; }
      if (obj === null) continue;
      if (obj['event'] === 'api_listening' && typeof obj['port'] === 'number') {
        apiPort = obj['port'] as number;
      }
      if ('notisId' in obj && 'multiaddrs' in obj) {
        if (notisId === null) notisId = obj['notisId'] as string;
        const addrs = obj['multiaddrs'] as unknown;
        if (Array.isArray(addrs)) {
          const match = addrs
            .map((a) => String(a))
            .find((s) => /\/webrtc-direct\/certhash\//.test(s));
          if (match !== undefined && webrtcAddr === null) webrtcAddr = match;
        }
      }
    }
  });

  const deadline = Date.now() + 45_000;
  while ((apiPort === null || notisId === null || webrtcAddr === null) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) {
      throw new Error(`node exited early with code ${child.exitCode}`);
    }
  }
  if (apiPort === null) throw new Error('node did not print api_listening');
  if (notisId === null || webrtcAddr === null) throw new Error('node did not announce a WebRTC-direct address');

  return { child, dir, apiPort, notisId, webrtcAddr };
}

describe('NODE_INTERFACE → Configuration → "The node\'s mesh endpoint forwards to its own public listener"', () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  let reader: Libp2p | null = null;
  let conn: Connection | null = null;

  beforeEach(() => {
    reader = null;
    conn = null;
  });

  afterEach(async () => {
    try { await conn?.close(); } catch { /* already closed */ }
    try { await reader?.stop(); } catch { /* already stopped */ }
    reader = null; conn = null;
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
    children.length = 0;
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    dirs.length = 0;
  });

  async function dialAndHandshake(spawned: SpawnedNode): Promise<void> {
    reader = await createLibp2p(readerLibp2pOptions({
      privateKey: nodeKeyFromKeyPair(generateKeyPair()).privateKey,
      magic: DEVNET_MAGIC,
      network: 'devnet',
      iceServers: () => [],
      denyDialMultiaddr: () => false,
    }));
    conn = await reader.dial(multiaddr(spawned.webrtcAddr));
    const result = await readerHandshake(conn, {
      magic: DEVNET_MAGIC,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'mesh-endpoint-spawned-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
  }

  it('GET /blocks/current — the mesh answer equals the direct answer when PORT names a fixed port', async () => {
    const fixedPort = await pickFreePort();
    const spawned = await startNode(String(fixedPort), 'node-mesh-spawned-fixed-');
    children.push(spawned.child); dirs.push(spawned.dir);
    expect(spawned.apiPort).toBe(fixedPort);

    await dialAndHandshake(spawned);
    const pick = (id: string): Connection | null => id === spawned.notisId ? conn : null;
    const fetchMesh = meshFetchOverConnection(pick);
    const meshRes = await fetchMesh(`${meshBaseUrl(spawned.notisId)}/blocks/current`);
    const directRes = await fetch(`http://127.0.0.1:${spawned.apiPort}/blocks/current`);
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    const meshBuf = new Uint8Array(await meshRes.arrayBuffer());
    const directBuf = new Uint8Array(await directRes.arrayBuffer());
    expect(Buffer.compare(Buffer.from(meshBuf), Buffer.from(directBuf))).toBe(0);
  }, 90_000);

  it('GET /blocks/current — the mesh answer equals the direct answer when PORT is 0', async () => {
    const spawned = await startNode('0', 'node-mesh-spawned-port-zero-');
    children.push(spawned.child); dirs.push(spawned.dir);
    expect(spawned.apiPort).toBeGreaterThan(0);

    await dialAndHandshake(spawned);
    const pick = (id: string): Connection | null => id === spawned.notisId ? conn : null;
    const fetchMesh = meshFetchOverConnection(pick);
    const meshRes = await fetchMesh(`${meshBaseUrl(spawned.notisId)}/blocks/current`);
    const directRes = await fetch(`http://127.0.0.1:${spawned.apiPort}/blocks/current`);
    expect(meshRes.status).toBe(directRes.status);
    expect(meshRes.headers.get('content-type')).toBe(directRes.headers.get('content-type'));
    const meshBuf = new Uint8Array(await meshRes.arrayBuffer());
    const directBuf = new Uint8Array(await directRes.arrayBuffer());
    expect(Buffer.compare(Buffer.from(meshBuf), Buffer.from(directBuf))).toBe(0);
  }, 90_000);
});
