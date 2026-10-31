// MESH_INTERFACE → Transports / The IP certificate — a public node's secure
// WebSocket fallback: a TLS WebSocket listener for an IP certificate, swapped
// in place at renewal (open connections stay up), stopped at `notAfter` with
// every other transport carrying on. The node refuses `wss` on a private role
// and `wss.ip` that is not an IP literal (`MeshConfigError`).

// Trust the test's self-signed certificate — the test owns both ends. Set
// before any libp2p/websockets import so the native WebSocket's undici agent
// picks it up at module load.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// @peculiar/x509@2.x pulls in tsyringe, which needs the Reflect polyfill
// loaded before any of its modules.
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
// `@libp2p/webrtc` sets @peculiar/x509's crypto provider to its own
// `@peculiar/webcrypto` instance at module load. Setting it again here
// (as a global override to Node's webcrypto) breaks WebRTC transport
// cert generation: a keyPair made by @peculiar/webcrypto is then handed
// to `exportKey` on Node's webcrypto, which refuses it as "not a
// CryptoKey". The helpers below pass `webcrypto` to @peculiar/x509
// explicitly instead; the global provider stays @libp2p/webrtc's.
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { http as httpService, type HTTP } from '@libp2p/http';
import { tcp } from '@libp2p/tcp';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@dagsocial/types';
import { meshBaseUrl } from '../src/mesh-url.js';
import { meshFetch } from '../src/http-fetch.js';
import { nodeKeyFromKeyPair, notisIdFromPeerId } from '../src/identity.js';
import type { NodeKey } from '../src/identity.js';
import {
  startMeshNode,
  MeshConfigError,
  type MeshNode,
} from '../src/node/mesh-node.js';
import type { CertificateSource, IpCertificate } from '../src/node/acme.js';
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';

// Node 20+ exposes WebCrypto on `node:crypto.webcrypto` and
// @peculiar/x509 takes a `Crypto` as its optional second argument.
const TEST_X509_CRYPTO = webcrypto as unknown as Crypto;

interface Stub {
  srv: Server;
  base: string;
}

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
  return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

function freshKey(): NodeKey {
  return nodeKeyFromKeyPair(generateKeyPair());
}

/**
 * A self-signed certificate for `127.0.0.1`, valid between `notBefore` and
 * `notAfter`. Used by the fake `CertificateSource` to drive the WSS listener
 * without an ACME server.
 */
async function makeSelfSigned(
  notBefore: number,
  notAfter: number,
): Promise<IpCertificate> {
  const keys = await TEST_X509_CRYPTO.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: Math.floor(Math.random() * 1e12).toString(16),
      name: 'CN=127.0.0.1',
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      keys,
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'ip', value: '127.0.0.1' },
        ]),
      ],
    },
    TEST_X509_CRYPTO,
  );
  const pkcs8 = await TEST_X509_CRYPTO.subtle.exportKey(
    'pkcs8',
    keys.privateKey,
  );
  const keyPem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g)!.join('\n') +
    '\n-----END PRIVATE KEY-----\n';
  const certPem = cert.toString('pem');
  return { certPem, keyPem, notBefore, notAfter };
}

/**
 * Reach the server's TLS fingerprint by opening a plain TLS socket to the
 * WSS port; the WebSocket handshake is not needed to read the certificate.
 */
async function tlsFingerprint(port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = tlsConnect(
      { host: '127.0.0.1', port, rejectUnauthorized: false },
      () => {
        const peer = socket.getPeerCertificate();
        socket.end();
        resolve(peer.fingerprint256 ?? peer.fingerprint);
      },
    );
    socket.on('error', reject);
  });
}

function wssPortOf(node: MeshNode): number {
  for (const a of node.multiaddrs()) {
    const m = a.match(/\/tcp\/(\d+)\/tls\/ws/);
    if (m) return Number(m[1]);
  }
  throw new Error('no /tls/ws multiaddr');
}

describe('wss — the IP certificate and the secure WebSocket fallback', () => {
  let nodes: MeshNode[] = [];
  let clients: Libp2p<{ http: HTTP }>[] = [];
  let stubs: Stub[] = [];
  let dirs: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any = null;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* capture, do not print */
    });
  });

  afterEach(async () => {
    for (const c of clients) {
      try {
        await c.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of nodes) {
      try {
        await n.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const s of stubs) s.srv.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    nodes = [];
    clients = [];
    stubs = [];
    dirs = [];
    errSpy?.mockRestore();
    errSpy = null;
  });

  it('WSS on a private node is refused', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const cert = await makeSelfSigned(Date.now(), Date.now() + 60_000);
    const source: CertificateSource = {
      async current() {
        return cert;
      },
      async obtain() {
        return cert;
      },
    };
    let thrown: unknown;
    let started: MeshNode | null = null;
    try {
      started = await startMeshNode({
        key: freshKey(),
        network: 'devnet',
        role: 'private',
        listen: ['/ip4/127.0.0.1/tcp/0'],
        bootstrap: [],
        stateDir: dir,
        upstream: stub.base,
        wss: { ip: '127.0.0.1', port: 0, source },
      });
    } catch (e) {
      thrown = e;
    } finally {
      if (started) {
        try {
          await started.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    expect(thrown).toBeInstanceOf(MeshConfigError);
  });

  it('WSS with a hostname is refused', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const cert = await makeSelfSigned(Date.now(), Date.now() + 60_000);
    const source: CertificateSource = {
      async current() {
        return cert;
      },
      async obtain() {
        return cert;
      },
    };
    let thrown: unknown;
    let started: MeshNode | null = null;
    try {
      started = await startMeshNode({
        key: freshKey(),
        network: 'devnet',
        role: 'public',
        listen: ['/ip4/127.0.0.1/tcp/0'],
        bootstrap: [],
        stateDir: dir,
        upstream: stub.base,
        wss: { ip: 'example.com', port: 0, source },
      });
    } catch (e) {
      thrown = e;
    } finally {
      if (started) {
        try {
          await started.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    expect(thrown).toBeInstanceOf(MeshConfigError);
  });

  it('a client reaches the node by key over WSS', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const cert = await makeSelfSigned(Date.now(), Date.now() + 60_000);
    const source: CertificateSource = {
      async current() {
        return cert;
      },
      async obtain() {
        return cert;
      },
    };
    const server = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
      wss: { ip: '127.0.0.1', port: 0, source },
    });
    nodes.push(server);

    const wsAddr = server
      .multiaddrs()
      .find((a) => a.includes('/tls/ws'));
    expect(wsAddr).toBeTruthy();

    const client: Libp2p<{ http: HTTP }> = await createLibp2p({
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping(), http: httpService() },
    });
    clients.push(client);

    const notisId = notisIdFromPeerId(server.libp2p.peerId);
    await client.dial(multiaddr(wsAddr!));
    const res = await meshFetch(client, { timeoutMs: 10_000 })(
      `${meshBaseUrl(notisId)}/blocks/current`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    const direct = await (
      await globalThis.fetch(`${stub.base}/blocks/current`)
    ).text();
    expect(body).toBe(direct);

    // Dialled with another peer id, the Noise handshake refuses — the mesh
    // URL is bound to the node's key (`MESH_INTERFACE → Transports`).
    const other = freshKey().peerId.toString();
    const wrongPeer = wsAddr!.replace(/\/p2p\/[^/]+/, `/p2p/${other}`);
    await expect(client.dial(multiaddr(wrongPeer))).rejects.toThrow();
  }, 60_000);

  it('the certificate is reloaded without a restart', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const now = Date.now();
    const cert1 = await makeSelfSigned(now, now + 4_000);
    let obtains = 0;
    const source: CertificateSource = {
      async current() {
        return cert1;
      },
      async obtain() {
        obtains++;
        // Each obtain mints a fresh cert valid 10 s from now so the
        // renewer's post-obtain `renewalStep` reads `serve` (fix 5's
        // throttle only trips on a half-spent reply, not on a fresh one).
        return makeSelfSigned(Date.now(), Date.now() + 10_000);
      },
    };
    const server = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
      wss: { ip: '127.0.0.1', port: 0, source },
    });
    nodes.push(server);
    const port = wssPortOf(server);
    const fp1 = await tlsFingerprint(port);

    // Open a WebSocket connection before the renewal fires so we can check
    // it is still answering `meshFetch` after the swap.
    const client: Libp2p<{ http: HTTP }> = await createLibp2p({
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping(), http: httpService() },
    });
    clients.push(client);
    const wsAddr = server.multiaddrs().find((a) => a.includes('/tls/ws'))!;
    await client.dial(multiaddr(wsAddr));
    const notisId = notisIdFromPeerId(server.libp2p.peerId);
    const fetchFn = meshFetch(client, { timeoutMs: 10_000 });

    // Wait for the half-life renewal (`renewAtMs ≈ now + 2 s`).
    await new Promise((r) => setTimeout(r, 2_500));
    expect(obtains).toBeGreaterThanOrEqual(1);

    const fp2 = await tlsFingerprint(port);
    expect(fp2).not.toBe(fp1);

    // The pre-renewal connection still answers.
    const res = await fetchFn(`${meshBaseUrl(notisId)}/blocks/current`);
    expect(res.status).toBe(200);
  }, 30_000);

  it('a failed renewal keeps serving and is logged', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const now = Date.now();
    const cert1 = await makeSelfSigned(now, now + 4_000);
    let obtains = 0;
    const source: CertificateSource = {
      async current() {
        return cert1;
      },
      async obtain() {
        obtains++;
        throw new Error('ACME down');
      },
    };
    const server = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
      wss: { ip: '127.0.0.1', port: 0, source },
    });
    nodes.push(server);
    const port = wssPortOf(server);
    const fp1 = await tlsFingerprint(port);

    // After the half-life renewal fires, the obtain rejects: the old
    // certificate still serves and one `console.error` fires.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(obtains).toBe(1);
    const fp2 = await tlsFingerprint(port);
    expect(fp2).toBe(fp1);

    const calls = errSpy!.mock.calls as unknown[][];
    const renewalLogs = calls.filter((c) =>
      /renew/i.test(c.map((v) => String(v)).join(' ')),
    );
    expect(renewalLogs.length).toBe(1);
  }, 30_000);

  it('the WSS listener stops at notAfter and nothing else does', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const now = Date.now();
    const cert1 = await makeSelfSigned(now, now + 1_500);
    const source: CertificateSource = {
      async current() {
        return cert1;
      },
      async obtain() {
        throw new Error('ACME down');
      },
    };
    const server = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
      wss: { ip: '127.0.0.1', port: 0, source },
    });
    nodes.push(server);
    const port = wssPortOf(server);
    const tcpAddr = server
      .multiaddrs()
      .find((a) => /\/tcp\/\d+(\/|$)/.test(a) && !a.includes('/tls/ws'))!;

    // Past `notAfter`: WSS listener is closed, TCP still answers.
    await new Promise((r) => setTimeout(r, 2_000));

    await expect(tlsFingerprint(port)).rejects.toBeTruthy();

    const client: Libp2p<{ http: HTTP }> = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping(), http: httpService() },
    });
    clients.push(client);
    await client.dial(multiaddr(tcpAddr));
    const notisId = notisIdFromPeerId(server.libp2p.peerId);
    const res = await meshFetch(client, { timeoutMs: 10_000 })(
      `${meshBaseUrl(notisId)}/blocks/current`,
    );
    expect(res.status).toBe(200);
  }, 30_000);

  it('the node starts without a WSS listener when the initial obtain fails', async () => {
    // MESH_INTERFACE → The IP certificate — "A failed renewal is retried
    // every `CERT_RETRY_MS` while the current certificate serves"; the WSS
    // fallback never takes the node down. With no stored certificate and
    // an ACME server that is down, the node starts with every other
    // transport up and no `/tls/ws` multiaddr.
    const stub = await makeStub();
    stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-'));
    dirs.push(dir);
    const source: CertificateSource = {
      async current() {
        return null;
      },
      async obtain() {
        throw new Error('ACME down');
      },
    };
    const server = await startMeshNode({
      key: freshKey(),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: dir,
      upstream: stub.base,
      wss: { ip: '127.0.0.1', port: 0, source },
    });
    nodes.push(server);

    const addrs = server.multiaddrs();
    expect(addrs.some((a) => a.includes('/tls/ws'))).toBe(false);
    const tcpAddr = addrs.find((a) => /\/tcp\/\d+(\/|$)/.test(a))!;
    expect(tcpAddr).toBeTruthy();

    const client: Libp2p<{ http: HTTP }> = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping(), http: httpService() },
    });
    clients.push(client);
    await client.dial(multiaddr(tcpAddr));
    const notisId = notisIdFromPeerId(server.libp2p.peerId);
    const res = await meshFetch(client, { timeoutMs: 10_000 })(
      `${meshBaseUrl(notisId)}/blocks/current`,
    );
    expect(res.status).toBe(200);
  }, 30_000);

  it('a client reaches a dual-listen node (webrtc-direct + wss) over webrtc-direct', async () => {
    // MESH_INTERFACE → The client's node list → "The secure WebSocket is
    // the fallback" — the client gives libp2p its own address order:
    // WebRTC-direct, then WebRTC signalled over a relay, then the secure
    // WebSocket, then any other address. A node listing both a
    // WebRTC-direct and a secure WebSocket address is reached over
    // WebRTC-direct; libp2p's dial queue dials the sorted list one
    // address at a time, so the first that connects wins.
    const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
    const meshClients: MeshClient[] = [];
    try {
      const stub = await makeStub();
      stubs.push(stub);
      const dir = mkdtempSync(join(tmpdir(), 'mesh-wss-dual-'));
      dirs.push(dir);
      const cert = await makeSelfSigned(Date.now(), Date.now() + 60_000);
      const source: CertificateSource = {
        async current() { return cert; },
        async obtain() { return cert; },
      };
      const key = nodeKeyFromKeyPair(generateKeyPair());
      const server = await startMeshNode({
        key,
        network: 'devnet',
        role: 'public',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct', '/ip4/127.0.0.1/tcp/0'],
        bootstrap: [],
        stateDir: dir,
        upstream: stub.base,
        wss: { ip: '127.0.0.1', port: 0, source },
      });
      nodes.push(server);

      const addrs = server.multiaddrs();
      const webrtcAddr = addrs.find((a) => a.includes('/webrtc-direct/'));
      const wsAddr = addrs.find((a) => a.includes('/tls/ws'));
      expect(webrtcAddr, 'the node has a /webrtc-direct/ listen address').toBeTruthy();
      expect(wsAddr, 'the node has a /tls/ws listen address').toBeTruthy();

      const notisId = notisIdFromPeerId(server.libp2p.peerId);
      // Anchor lists wss first, webrtc-direct second — the client's own
      // sorter puts webrtc-direct first whatever the input order is.
      // libp2p's default sorter would have put wss ahead.
      const fakeResolve: typeof import('@dagsocial/nipopow-client').resolveTip
        = async (urls) => {
          const resultNodes: NodeTipResult[] = urls.map((url, i) => ({
            url,
            verified: true,
            proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
            verifyResult: null,
            refuseReason: null,
            refuseCode: null,
            behind: i === 0 ? 0 : 1,
            genesisHash: 'f'.repeat(64),
          }));
          const out: TipResult = {
            winner: resultNodes[0] ?? null,
            winnerIndex: resultNodes.length > 0 ? 0 : -1,
            nodes: resultNodes,
            tip: null,
            suffixHead: null,
            splits: [],
          };
          return out;
        };
      const client = await startMeshClient({
        anchors: [{ notisId, addrs: [wsAddr!, webrtcAddr!] }],
        network: 'devnet',
        profile: PROFILE,
        stunServers: [],
        resolve: fakeResolve,
      });
      meshClients.push(client);
      await client.check();
      const s = client.state();
      expect(s.nodeId).toBe(notisId);
      expect(s.transport, 'webrtc-direct was first in the one sort order').toBe('webrtc-direct');
      expect(s.path).toBe('direct');
    } finally {
      for (const c of meshClients) {
        try { await c.stop(); } catch { /* already stopped */ }
      }
    }
  }, 60_000);
});
