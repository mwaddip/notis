// MESH_INTERFACE → Place in the workspace / Transports / NAT / Discovery /
// The node endpoint — a mesh node is a libp2p host that forwards HTTP over
// libp2p to its own Notis node, speaks Kademlia on `/notis/<network>/kad/
// 1.0.0` and nothing else, persists its WebRTC-direct certificate in its
// state directory, and refuses a `/dns4/`, `/dns6/` or `/dnsaddr/`
// multiaddr at start.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webRTCDirect } from '@libp2p/webrtc';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { http as httpService, type HTTP } from '@libp2p/http';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
import { meshBaseUrl } from '../src/mesh-url.js';
import { meshFetch } from '../src/http-fetch.js';
import { nodeKeyFromKeyPair, notisIdFromPeerId } from '../src/identity.js';
import { dhtProtocol } from '../src/protocols.js';
import type { NodeKey } from '../src/identity.js';
import { startMeshNode, MeshConfigError, type MeshNode } from '../src/node/mesh-node.js';

// MESH_INTERFACE → The node endpoint — a tiny upstream the mesh node
// forwards to; the dial-by-key case reads /blocks/current back.
interface Stub { srv: Server; base: string }
async function makeStub(): Promise<Stub> {
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: 1, id: 'ab'.repeat(32) }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

function freshKey(): NodeKey {
  return nodeKeyFromKeyPair(generateKeyPair());
}

function writeKeyFile(path: string, kp: { secretKey: Uint8Array }): void {
  writeFileSync(path, kp.secretKey, { mode: 0o600 });
}

function certhashOf(ma: string): string | null {
  const m = ma.match(/\/certhash\/([^/]+)/);
  return m ? m[1]! : null;
}

describe('mesh node — libp2p, the persisted certificate, the DHT', () => {
  let nodes: MeshNode[] = [];
  let stubs: Stub[] = [];
  let dirs: string[] = [];

  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const s of stubs) { s.srv.close(); }
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); }
    nodes = []; stubs = []; dirs = [];
  });

  it('the DHT speaks only Notis\'s protocol', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    const n = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
    });
    nodes.push(n);
    const protos = n.libp2p.getProtocols();
    expect(protos).toContain(dhtProtocol('devnet'));
    // Every other registered protocol stays clear of kad-dht's defaults —
    // the IPFS WAN/LAN pair — and of any /kad/ family at all. Notis's own
    // `/notis/devnet/kad/1.0.0` is the only `/kad/` here.
    const others = protos.filter((p) => p !== dhtProtocol('devnet'));
    for (const p of others) {
      expect(p).not.toMatch(/\/ipfs\/kad\//);
      expect(p).not.toMatch(/\/kad\//);
    }
  }, 30_000);

  it('a private node runs the DHT as a client', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    const n = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
    });
    nodes.push(n);
    expect(n.libp2p.getProtocols()).not.toContain(dhtProtocol('devnet'));
  }, 30_000);

  it('the WebRTC-direct certificate persists', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    const key = freshKey();

    const n1 = await startMeshNode({
      key, network: 'devnet', role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
      bootstrap: [], stateDir: dir, upstream: stub.base,
    });
    const addrs1 = n1.multiaddrs();
    const peerId1 = n1.libp2p.peerId.toString();
    await n1.stop();

    const n2 = await startMeshNode({
      key, network: 'devnet', role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
      bootstrap: [], stateDir: dir, upstream: stub.base,
    });
    nodes.push(n2);
    const addrs2 = n2.multiaddrs();
    const peerId2 = n2.libp2p.peerId.toString();

    const wd1 = addrs1.find((a) => a.includes('/webrtc-direct/'));
    const wd2 = addrs2.find((a) => a.includes('/webrtc-direct/'));
    expect(wd1).toBeTruthy();
    expect(wd2).toBeTruthy();
    expect(certhashOf(wd1!)).toBe(certhashOf(wd2!));
    expect(peerId1).toBe(peerId2);
  }, 30_000);

  // One case per guard, so a missing refusal fails its own case and nothing
  // else: `startMeshNode` with a deleted guard may return a running node
  // instead of throwing, which the file's shared `afterEach` would catch too
  // late to keep the suite's other cases on their feet. Each case here
  // tracks what it started in a local holder and stops it in a `finally`
  // (`MESH_INTERFACE → Transports / Discovery`).
  async function expectConfigError(
    start: () => Promise<MeshNode>,
  ): Promise<void> {
    let started: MeshNode | null = null;
    let thrown: unknown;
    try {
      started = await start();
    } catch (e) {
      thrown = e;
    } finally {
      if (started) { try { await started.stop(); } catch { /* already stopped */ } }
    }
    expect(thrown).toBeInstanceOf(MeshConfigError);
  }

  it('a DNS bootstrap address is refused', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    const otherPeer = freshKey().peerId.toString();
    await expectConfigError(() => startMeshNode({
      key: freshKey(), network: 'devnet', role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [`/dns4/example.com/tcp/1/p2p/${otherPeer}`],
      stateDir: dir, upstream: stub.base,
    }));
  }, 30_000);

  it('a DNS listen address is refused', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    await expectConfigError(() => startMeshNode({
      key: freshKey(), network: 'devnet', role: 'private',
      listen: ['/dns6/example.com/tcp/0'],
      bootstrap: [],
      stateDir: dir, upstream: stub.base,
    }));
  }, 30_000);

  it('a DNS announce address is refused', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    await expectConfigError(() => startMeshNode({
      key: freshKey(), network: 'devnet', role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      announce: ['/dnsaddr/example.com/tcp/1'],
      bootstrap: [],
      stateDir: dir, upstream: stub.base,
    }));
  }, 30_000);

  it('a bootstrap address without a peer id is refused', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    await expectConfigError(() => startMeshNode({
      key: freshKey(), network: 'devnet', role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: ['/ip4/127.0.0.1/tcp/1'],
      stateDir: dir, upstream: stub.base,
    }));
  }, 30_000);

  it('the endpoint is reachable by key over WebRTC-direct', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-node-')); dirs.push(dir);
    const server = await startMeshNode({
      key: freshKey(), network: 'devnet', role: 'public',
      listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
      bootstrap: [], stateDir: dir, upstream: stub.base,
    });
    nodes.push(server);

    // The second node has WebRTC-direct and nothing else (no TCP), to
    // prove the mesh node's own address is reachable by the browser's
    // transport (`MESH_INTERFACE → Transports`).
    const client: Libp2p<{ http: HTTP }> = await createLibp2p({
      transports: [webRTCDirect()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping(), http: httpService() },
    });
    try {
      await client.start();
      const wd = server.multiaddrs().find((a) => a.includes('/webrtc-direct/'));
      expect(wd).toBeTruthy();
      await client.dial(multiaddr(wd!));

      const notisId = notisIdFromPeerId(server.libp2p.peerId);
      const base = meshBaseUrl(notisId);
      const fetch = meshFetch(client, { timeoutMs: 10_000 });
      const res = await fetch(`${base}/blocks/current`);
      expect(res.status).toBe(200);
      const body = await res.text();
      const direct = await (await globalThis.fetch(`${stub.base}/blocks/current`)).text();
      expect(body).toBe(direct);
    } finally {
      try { await client.stop(); } catch { /* already stopped */ }
    }
  }, 60_000);

  it('main prints its addresses', async () => {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-main-')); dirs.push(dir);
    const stateDir = join(dir, 'state');
    const keyPath = join(dir, 'node.key');
    // Pre-write a key so we can check `notisId` against the key file's
    // own identity. `KeyPair.secretKey` is the PKCS8 prefix ‖ 32-byte
    // seed (`TYPES_INTERFACE → Identity`).
    const kp = generateKeyPair();
    writeKeyFile(keyPath, kp);
    const expectedId = bytesToHex(kp.publicKey);

    const env = {
      ...process.env,
      MESH_KEY_PATH: keyPath,
      MESH_NETWORK: 'devnet',
      MESH_ROLE: 'public',
      MESH_LISTEN: '/ip4/127.0.0.1/udp/0/webrtc-direct',
      MESH_BOOTSTRAP: '',
      MESH_STATE_DIR: stateDir,
      MESH_UPSTREAM: stub.base,
    };
    const main = spawn(process.execPath, ['dist/node/main.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let proc: ChildProcess | null = main;
    try {
      const firstLine = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error('timeout waiting for first stdout line')), 20_000);
        main.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const i = buf.indexOf('\n');
          if (i !== -1) { clearTimeout(t); resolve(buf.slice(0, i)); }
        });
        main.on('exit', (code) => { clearTimeout(t); reject(new Error(`main exited early with code ${code}`)); });
      });
      const parsed = JSON.parse(firstLine) as { notisId: string; peerId: string; multiaddrs: string[] };
      expect(parsed.notisId).toBe(expectedId);
      expect(Array.isArray(parsed.multiaddrs)).toBe(true);
      expect(parsed.multiaddrs.length).toBeGreaterThan(0);
      for (const a of parsed.multiaddrs) {
        expect(a).not.toMatch(/\/dns4\//);
        expect(a).not.toMatch(/\/dns6\//);
        expect(a).not.toMatch(/\/dnsaddr\//);
        expect(a.startsWith('/ip4/') || a.startsWith('/ip6/')).toBe(true);
      }

      // SIGTERM; main exits 0.
      const exitCode = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for SIGTERM exit')), 10_000);
        main.on('exit', (code) => { clearTimeout(t); resolve(code ?? -1); });
        main.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
      proc = null;
    } finally {
      // Kill by the PID we captured at launch (never a broad kill).
      if (proc && proc.pid !== undefined && proc.exitCode === null) {
        try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 60_000);
});

