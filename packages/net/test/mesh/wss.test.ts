// `MESH_INTERFACE → Transports / The IP certificate` — a public
// node's secure WebSocket fallback: a TLS WebSocket listener for an
// IP certificate, swapped in place at renewal (open connections stay
// up), stopped at `notAfter` with every other transport carrying on.
// A `NetNode` with `mesh.wss` set runs the WSS listener beside its
// WebRTC-direct and TCP listeners when the state directory holds a
// valid certificate or `obtain()` succeeds at start; with `obtain()`
// failing at start, the node starts without the WSS listener and the
// renewal driver wires it in on the first successful retry.

// Trust the test's self-signed certificate — the test owns both
// ends. Set before any libp2p/websockets import so the native
// WebSocket's undici agent picks it up at module load.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// `@peculiar/x509@2.x` pulls in tsyringe, which needs the Reflect
// polyfill loaded before any of its modules.
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { webcrypto } from 'node:crypto';
// `@libp2p/webrtc` sets @peculiar/x509's crypto provider to its own
// `@peculiar/webcrypto` instance at module load. Setting it again
// here (as a global override to Node's webcrypto) breaks WebRTC
// transport cert generation: a keyPair made by @peculiar/webcrypto
// is then handed to `exportKey` on Node's webcrypto, which refuses
// it as "not a CryptoKey". The helpers below pass `webcrypto` to
// @peculiar/x509 explicitly instead; the global provider stays
// @libp2p/webrtc's.
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
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';

import { NetNode } from '../../src/index.js';
import type { NetValidators } from '../../src/index.js';
import type { CertificateSource, IpCertificate } from '../../src/mesh/acme.js';
import { makeConfig } from '../helpers.js';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

// Node's webcrypto, cast to the `Crypto` shape `@peculiar/x509` takes
// as its optional second argument. `@libp2p/webrtc` has already set
// the global provider; we pass this one explicitly so neither path
// steps on the other.
const TEST_X509_CRYPTO = webcrypto as unknown as Crypto;

interface Stub {
  server: Server;
  base: string;
}

async function makeStub(): Promise<Stub> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: 1, hash: 'ab'.repeat(32) }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * A self-signed certificate for `127.0.0.1`, valid between
 * `notBefore` and `notAfter`. Used by the fake `CertificateSource`
 * to drive the WSS listener without an ACME server.
 */
async function makeSelfSigned(
  notBefore: number,
  notAfter: number,
): Promise<IpCertificate> {
  const keys = await TEST_X509_CRYPTO.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
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
 * Reach the server's TLS fingerprint by opening a plain TLS socket
 * to the WSS port; the WebSocket handshake is not needed to read
 * the certificate.
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

function nodeMultiaddrs(node: NetNode): string[] {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  return libp2p.getMultiaddrs().map((a) => a.toString());
}

function wssPortOf(node: NetNode): number {
  for (const a of nodeMultiaddrs(node)) {
    const m = a.match(/\/tcp\/(\d+)\/tls\/ws/);
    if (m) return Number(m[1]);
  }
  throw new Error('no /tls/ws multiaddr');
}

/**
 * A `NetNode` with mesh set, started under a certificate source the
 * test owns. `stun: null` keeps the default STUN port unbound so this
 * file never races another mesh case under vitest's forks pool.
 */
async function startWssNode(
  stateDir: string,
  httpBase: string,
  source: CertificateSource,
): Promise<NetNode> {
  // The constructor's fourth parameter — the certificate-source
  // factory — is the WSS test seam, with the same standing as
  // `peerStorage`'s third-parameter seam. Production calls remain
  // the three-argument form (`acmeSource(...)` builds the source
  // from `mesh.wss`); the test hands in a source of its own, and
  // the `acmeDirectory` string on `mesh.wss` is unused.
  const node = new NetNode(
    makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir,
        httpBase,
        stun: null,
        wss: { ip: '127.0.0.1', port: 0, acmeDirectory: 'about:blank', challengePort: 0 },
      },
    }),
    validators,
    undefined,
    () => source,
  );
  await node.start();
  return node;
}

/**
 * The HTTP client side: a libp2p host with `@libp2p/websockets`,
 * `@libp2p/http` and `@libp2p/tcp`. The client dials the server by
 * its secure-WebSocket multiaddr (or TCP, for the notAfter case).
 */
async function makeClient(): Promise<Libp2p<{ http: HTTP }>> {
  return await createLibp2p({
    transports: [webSockets(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping(), http: httpService() },
  });
}

async function firstWssAddr(node: NetNode): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const a = nodeMultiaddrs(node).find((s) => s.includes('/tls/ws'));
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function firstTcpAddr(node: NetNode): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const a = nodeMultiaddrs(node).find(
      (s) => s.includes('/tcp/') && !s.includes('/webrtc') && !s.includes('/tls/ws'),
    );
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no TCP listen address');
}

/**
 * `services.http.fetch` wraps `@libp2p/http-fetch`'s `fetch` — the
 * same path a browser uses. The `/http-path/…` multiaddr tuple's
 * value carries the path with its leading slash stripped.
 */
function meshFetchFor(
  client: Libp2p<{ http: HTTP }>,
  serverPeerId: string,
): (path: string) => Promise<Response> {
  return async (path: string) => {
    const resource = `/p2p/${serverPeerId}/http-path/${encodeURIComponent(path.slice(1))}`;
    return await client.services.http.fetch(resource);
  };
}

describe('wss — the IP certificate and the secure WebSocket fallback', () => {
  const nodes: NetNode[] = [];
  const clients: Libp2p<{ http: HTTP }>[] = [];
  const stubs: Stub[] = [];
  const dirs: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any = null;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* capture, do not print */
    });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try { await c.stop(); } catch { /* already stopped */ }
    }
    for (const n of nodes.splice(0)) {
      try { await n.stop(); } catch { /* already stopped */ }
    }
    for (const s of stubs.splice(0)) s.server.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    errSpy?.mockRestore();
    errSpy = null;
  });

  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'net-wss-'));
    dirs.push(d);
    return d;
  }

  it('a client reaches the node by key over WSS', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = freshDir();
    const cert = await makeSelfSigned(Date.now(), Date.now() + 60_000);
    const source: CertificateSource = {
      async current() { return cert; },
      async obtain() { return cert; },
    };
    const server = await startWssNode(dir, stub.base, source);
    nodes.push(server);

    const wsAddr = await firstWssAddr(server);
    expect(wsAddr, 'a /tls/ws multiaddr is announced').toBeTruthy();

    const client = await makeClient();
    clients.push(client);
    const libp2p = (server as unknown as { libp2p: Libp2p }).libp2p;
    await client.dial(multiaddr(wsAddr!));
    const serverPeerId = libp2p.peerId.toString();
    const mFetch = meshFetchFor(client, serverPeerId);

    const res = await mFetch('/blocks/current');
    expect(res.status).toBe(200);
    const body = await res.text();
    const direct = await (
      await globalThis.fetch(`${stub.base}/blocks/current`)
    ).text();
    expect(body).toBe(direct);
  }, 60_000);

  it('the certificate is reloaded without a restart', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = freshDir();
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
        // renewer's post-obtain `renewalStep` reads `serve` (the
        // half-spent throttle fires on a half-spent reply, not on a
        // fresh one).
        return makeSelfSigned(Date.now(), Date.now() + 10_000);
      },
    };
    const server = await startWssNode(dir, stub.base, source);
    nodes.push(server);
    const port = wssPortOf(server);
    const fp1 = await tlsFingerprint(port);

    // Open a WebSocket connection before the renewal fires so we can
    // check it is still answering `meshFetch` after the swap.
    const client = await makeClient();
    clients.push(client);
    const wsAddr = (await firstWssAddr(server))!;
    await client.dial(multiaddr(wsAddr));
    const libp2p = (server as unknown as { libp2p: Libp2p }).libp2p;
    const serverPeerId = libp2p.peerId.toString();
    const mFetch = meshFetchFor(client, serverPeerId);

    // Wait for the half-life renewal (`renewAtMs ≈ now + 2 s`).
    await new Promise((r) => setTimeout(r, 2_500));
    expect(obtains).toBeGreaterThanOrEqual(1);

    const fp2 = await tlsFingerprint(port);
    expect(fp2).not.toBe(fp1);

    // The pre-renewal connection still answers.
    const res = await mFetch('/blocks/current');
    expect(res.status).toBe(200);
  }, 30_000);

  it('a failed renewal keeps serving and is logged', async () => {
    const stub = await makeStub();
    stubs.push(stub);
    const dir = freshDir();
    // The source builds its certificate the first time the node
    // asks for it, with `notBefore` 10 s in the past and `notAfter`
    // 10 s ahead — so the half-life
    // (`(notBefore + notAfter) / 2`) is at the moment of the
    // `current()` call, and the renewer's first tick reads clock
    // past the half-life and fires `obtain()` at once, with no
    // real-time half-life wait and no dependency on how long
    // `startWssNode` took (`NetNode.start()` under vitest's forks
    // pool takes up to a few seconds beside sibling mesh tests;
    // `notAfter` is 10 s ahead so the `stop-wss` path has a
    // comfortable budget).
    let cert1: IpCertificate | null = null;
    let obtains = 0;
    const source: CertificateSource = {
      async current() {
        if (cert1 === null) {
          const t = Date.now();
          cert1 = await makeSelfSigned(t - 10_000, t + 10_000);
        }
        return cert1;
      },
      async obtain() {
        obtains++;
        throw new Error('ACME down');
      },
    };
    const server = await startWssNode(dir, stub.base, source);
    nodes.push(server);
    const port = wssPortOf(server);
    const fp1 = await tlsFingerprint(port);

    // Wait until the renewer's first tick has fired `obtain()` —
    // a condition, not a fixed wall-clock wait. The tick is a
    // `setTimeout(0)` scheduled by `planNext()` inside
    // `startWssRenewal`, so one macrotask after `node.start()`
    // returns; the loop below gives the event loop that macrotask
    // (and any follow-on microtasks for the catch + log) without
    // racing wall time.
    const until = Date.now() + 1_000;
    while (obtains === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
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
    const dir = freshDir();
    // `now` is sampled AFTER the ACME source is captured so the
    // 3 s lifetime starts counting from the moment the node begins
    // to start — `NetNode.start()` is heavier than the PoC's
    // `startMeshNode`, and a short-enough lifetime would be past
    // `notAfter` before `wssPortOf` could read the listener.
    const source: CertificateSource = {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      async current() { return cert1; },
      async obtain() {
        throw new Error('ACME down');
      },
    };
    const now = Date.now();
    const cert1 = await makeSelfSigned(now, now + 3_000);
    const server = await startWssNode(dir, stub.base, source);
    nodes.push(server);
    const port = wssPortOf(server);
    const tcpAddr = await firstTcpAddr(server);

    // Past `notAfter`: WSS listener is closed, TCP still answers.
    await new Promise((r) => setTimeout(r, 3_500));

    await expect(tlsFingerprint(port)).rejects.toBeTruthy();

    const client = await makeClient();
    clients.push(client);
    await client.dial(multiaddr(tcpAddr));
    const libp2p = (server as unknown as { libp2p: Libp2p }).libp2p;
    const serverPeerId = libp2p.peerId.toString();
    const mFetch = meshFetchFor(client, serverPeerId);
    const res = await mFetch('/blocks/current');
    expect(res.status).toBe(200);
  }, 30_000);

  it('the node starts without a WSS listener when the initial obtain fails', async () => {
    // `MESH_INTERFACE → The IP certificate` — "A failed renewal is
    // retried every `CERT_RETRY_MS` while the current certificate
    // serves"; the WSS fallback never takes the node down. With no
    // stored certificate and an ACME server that is down, the node
    // starts with every other transport up and no `/tls/ws`
    // multiaddr — and the source was reached (`current()` then
    // `obtain()` tried), so the renewal driver is running.
    const stub = await makeStub();
    stubs.push(stub);
    const dir = freshDir();
    let currentCalls = 0;
    let obtainCalls = 0;
    const source: CertificateSource = {
      async current() { currentCalls++; return null; },
      async obtain() {
        obtainCalls++;
        throw new Error('ACME down');
      },
    };
    const server = await startWssNode(dir, stub.base, source);
    nodes.push(server);

    const addrs = nodeMultiaddrs(server);
    expect(addrs.some((a) => a.includes('/tls/ws'))).toBe(false);
    const tcpAddr = await firstTcpAddr(server);
    expect(tcpAddr).toBeTruthy();

    const client = await makeClient();
    clients.push(client);
    await client.dial(multiaddr(tcpAddr));
    const libp2p = (server as unknown as { libp2p: Libp2p }).libp2p;
    const serverPeerId = libp2p.peerId.toString();
    const mFetch = meshFetchFor(client, serverPeerId);
    const res = await mFetch('/blocks/current');
    expect(res.status).toBe(200);
    // The renewal driver reached the source at start: `current()`
    // (nothing), `obtain()` (ACME down). Without the wiring, no
    // call lands.
    expect(currentCalls, 'source.current() is read at start').toBeGreaterThanOrEqual(1);
    expect(obtainCalls, 'source.obtain() is tried when current() answers null').toBeGreaterThanOrEqual(1);
  }, 30_000);
});
