// MESH_INTERFACE → The node endpoint — the mesh service answers HTTP
// over libp2p (`@libp2p/http`) by forwarding each GET and POST to its
// own public HTTP API on loopback. Any other method answers 405. The
// endpoint is transport-blind: the libp2p stream carries any payload
// shape its underlying transport can carry. These cases use TCP for
// simplicity (the mesh node also runs TCP beside WebRTC-direct) and
// drive requests through `services.http.fetch` — the same
// `@libp2p/http-fetch` path a browser uses, headers and body sent
// back-to-back from the client's `Promise.all`.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { http as httpService, type HTTP } from '@libp2p/http';
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

type Rec = { method: string; path: string; contentType: string | null; body: Buffer };

interface Stub {
  server: Server;
  base: string;
  received: Rec[];
}

async function makeStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Stub> {
  const received: Rec[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); });
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        path: req.url ?? '',
        contentType: req.headers['content-type'] ?? null,
        body: Buffer.concat(chunks),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, received };
}

async function makeClient(): Promise<Libp2p<{ http: HTTP }>> {
  return await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { http: httpService() },
  });
}

async function firstTcpAddr(node: NetNode): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  for (let i = 0; i < 100; i++) {
    const a = libp2p.getMultiaddrs().map((m) => m.toString()).find((s) => s.includes('/tcp/') && !s.includes('/webrtc'));
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no TCP listen address');
}

describe('mesh — the node endpoint', () => {
  let node: NetNode | null = null;
  let client: Libp2p<{ http: HTTP }> | null = null;
  let stub: Stub | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    try { await client?.stop(); } catch { /* already stopped */ }
    try { await node?.stop(); } catch { /* already stopped */ }
    stub?.server.close();
    if (dir !== null) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
    client = null; node = null; stub = null; dir = null;
  });

  // The `FetchInit` type `@libp2p/http` takes is `RequestInit` with a
  // non-null `signal` — narrow to that shape here.
  type MeshFetchInit = Omit<RequestInit, 'signal'> & { signal?: AbortSignal };

  async function bringUp(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ meshFetch: (path: string, init?: MeshFetchInit) => Promise<Response> }> {
    stub = await makeStub(handler);
    dir = mkdtempSync(join(tmpdir(), 'net-endpoint-'));
    node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named
      // by IP"` — these endpoint cases forward HTTP; STUN is not under
      // test, so the server is off. `stun: null` keeps the default
      // `STUN_PORT` (3478) unbound, so this file never races another
      // mesh case under vitest's forks pool.
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir: dir,
        httpBase: stub.base,
        stun: null,
      },
    }), validators);
    await node.start();
    client = await makeClient();
    const addr = await firstTcpAddr(node);
    await client.dial(multiaddr(addr));
    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    const serverPeerId = libp2p.peerId.toString();
    const c = client!;
    return {
      async meshFetch(path: string, init?: MeshFetchInit): Promise<Response> {
        // `services.http.fetch` wraps `@libp2p/http-fetch`'s `fetch`,
        // which runs `Promise.all([readResponse, sendRequest])` —
        // the browser's write path. The `/http-path/…` multiaddr
        // tuple's value carries the path with its leading slash
        // stripped (`@libp2p/http-utils`' `toResource` writes it that
        // way), and `@libp2p/http`'s `sendRequest` prepends it with
        // one slash as it builds the HTTP request line.
        const resource = `/p2p/${serverPeerId}/http-path/${encodeURIComponent(path.slice(1))}`;
        return await c.services.http.fetch(resource, init);
      },
    };
  }

  it('a GET answers the upstream bytes', async () => {
    const { meshFetch } = await bringUp((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const r = await meshFetch('/blocks/current');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(await r.text()).toBe('{"ok":true}');
    expect(stub!.received).toHaveLength(1);
    expect(stub!.received[0]!.method).toBe('GET');
    expect(stub!.received[0]!.path).toBe('/blocks/current');
  }, 30_000);

  it('a POST with a JSON body is forwarded, body bytes byte for byte', async () => {
    const { meshFetch } = await bringUp((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":1}');
    });
    const bodyBytes = new TextEncoder().encode('{"hello":"world"}');
    const r = await meshFetch('/tx', {
      method: 'POST',
      // A Blob carries its type through `@libp2p/http-fetch`'s
      // `normalizeContent` — a string body would be rewritten to
      // `text/plain; charset="UTF-8"` by `stringBody`
      // (`@libp2p/http-fetch@4.0.4/dist/src/body/string.js`).
      body: new Blob([bodyBytes], { type: 'application/json' }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"accepted":1}');
    expect(stub!.received).toHaveLength(1);
    expect(stub!.received[0]!.method).toBe('POST');
    expect(stub!.received[0]!.path).toBe('/tx');
    expect(stub!.received[0]!.contentType).toBe('application/json');
    expect(Buffer.compare(stub!.received[0]!.body, Buffer.from(bodyBytes))).toBe(0);
  }, 30_000);

  it('a POST without a content-type is forwarded as application/octet-stream', async () => {
    const { meshFetch } = await bringUp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    // A Blob with no type lands on the wire as the default
    // `application/octet-stream` that `blobBody` sets when the blob
    // carries no type (`@libp2p/http-fetch@4.0.4/dist/src/body/blob.js`);
    // the endpoint forwards whatever the client sent.
    const bytes = new TextEncoder().encode('opaque');
    const r = await meshFetch('/raw', { method: 'POST', body: new Blob([bytes]) });
    expect(r.status).toBe(200);
    expect(stub!.received).toHaveLength(1);
    expect(Buffer.compare(stub!.received[0]!.body, Buffer.from(bytes))).toBe(0);
    expect(stub!.received[0]!.contentType).toBe('application/octet-stream');
  }, 30_000);

  it('a PUT answers 405 and never calls the upstream', async () => {
    const { meshFetch } = await bringUp(() => { /* unreachable */ });
    const r = await meshFetch('/x', { method: 'PUT' });
    expect(r.status).toBe(405);
    expect(stub!.received).toHaveLength(0);
  }, 30_000);

  it('an upstream answering 413 forwards the status and body', async () => {
    const { meshFetch } = await bringUp((_req, res) => {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('too big');
    });
    const r = await meshFetch('/x', {
      method: 'POST',
      body: new Blob([new TextEncoder().encode('x')], { type: 'application/json' }),
    });
    expect(r.status).toBe(413);
    expect(await r.text()).toBe('too big');
  }, 30_000);

  // MESH_INTERFACE → The node endpoint — the endpoint's upstream
  // `fetch` runs under a deadline the operator names (`MeshConfig.upstreamTimeoutMs`);
  // on expiry the endpoint aborts the libp2p stream. The server's
  // `/http/1.1` stream count drops to 0 within the budget; without
  // the guard it would stay open for the hung upstream's lifetime.
  it('a hung upstream aborts the mesh stream within upstreamTimeoutMs', async () => {
    const UPSTREAM_TIMEOUT_MS = 500;
    const WAIT_BUFFER_MS = 2_000;
    // A stub that accepts and never answers — the connection stays
    // open on the loopback TCP, the response is never written.
    const received: Array<{ method: string; path: string }> = [];
    const server = createServer((req) => {
      received.push({ method: req.method ?? '', path: req.url ?? '' });
      // Intentionally do not write a response.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    stub = { server, base: `http://127.0.0.1:${port}`, received: received as unknown as Rec[] };
    dir = mkdtempSync(join(tmpdir(), 'net-endpoint-'));
    node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: {
        role: 'public',
        network: 'devnet',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        stateDir: dir,
        httpBase: stub.base,
        upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
        stun: null,
      },
    }), validators);
    await node.start();
    client = await makeClient();
    const addr = await firstTcpAddr(node);
    await client.dial(multiaddr(addr));
    const srvLibp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    const serverPeerId = srvLibp2p.peerId.toString();

    function openHttpStreams(): number {
      let n = 0;
      for (const conn of srvLibp2p.getConnections()) {
        for (const s of conn.streams as Array<{ protocol?: string; timeline?: { close?: number } }>) {
          if (s.protocol === '/http/1.1' && s.timeline?.close == null) n++;
        }
      }
      return n;
    }

    // Fire the mesh fetch and let it hang — `@libp2p/http-fetch`'s
    // `readResponse` waits on `message` / `remoteCloseWrite` events
    // that a reset does not raise, so the client-side promise is
    // unreachable here. The server's observable effect is what we
    // test.
    const resource = `/p2p/${serverPeerId}/http-path/${encodeURIComponent('tx')}`;
    void client!.services.http.fetch(resource, { method: 'GET' }).catch(() => undefined);

    // Wait for the server to see one `/http/1.1` stream open.
    const sawOpenDeadline = Date.now() + WAIT_BUFFER_MS;
    while (openHttpStreams() === 0 && Date.now() < sawOpenDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(openHttpStreams()).toBe(1);

    // Within `upstreamTimeoutMs + a buffer` the endpoint has aborted
    // and the server's stream count drops to 0.
    const abortDeadline = Date.now() + UPSTREAM_TIMEOUT_MS + WAIT_BUFFER_MS;
    while (openHttpStreams() > 0 && Date.now() < abortDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(openHttpStreams()).toBe(0);
  }, 15_000);

  it('a POST body at HTTP_BODY_MAX_BYTES is forwarded byte for byte', async () => {
    const { meshFetch } = await bringUp((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":1}');
    });
    // 64 KiB — the node's `HTTP_BODY_MAX_BYTES`, the largest body a
    // public write carries.
    const bodyBytes = new Uint8Array(65_536);
    for (let i = 0; i < bodyBytes.byteLength; i++) bodyBytes[i] = i & 0xff;
    const r = await meshFetch('/tx', {
      method: 'POST',
      body: new Blob([bodyBytes], { type: 'application/octet-stream' }),
    });
    expect(r.status).toBe(200);
    expect(stub!.received).toHaveLength(1);
    expect(stub!.received[0]!.body.byteLength).toBe(bodyBytes.byteLength);
    expect(Buffer.compare(stub!.received[0]!.body, Buffer.from(bodyBytes))).toBe(0);
  }, 30_000);
});
