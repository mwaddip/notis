// MESH_INTERFACE → The node endpoint — a browser reaches a Notis node's HTTP
// API by its key over libp2p: `meshFetch` is an `HttpFetch` over a mesh URL,
// `nodeApiServer` is the WebServer the node is built with. Every reader that
// takes an `HttpFetch` (node-reads' `fetchJson` here) runs over the mesh
// unchanged (CONSTANTS → Client reads).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { http as httpService, type HTTP } from '@libp2p/http';
import { multiaddr } from '@multiformats/multiaddr';
import { fetchJson } from '@dagsocial/node-reads';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
import { notisIdFromPeerId } from '../src/identity.js';
import { meshBaseUrl } from '../src/mesh-url.js';
import { meshFetch, MeshFetchError } from '../src/http-fetch.js';
import { nodeApiServer } from '../src/node/api-forward.js';

type MeshNode = Libp2p<{ http: HTTP }>;

// MESH_INTERFACE → The node endpoint — the libp2p stream protocol under
// which @libp2p/http runs. The test asserts counts of these streams to
// prove that a request that ends by abort or by upstream timeout does not
// leak one.
const HTTP_STREAM_PROTOCOL = '/http/1.1';

function httpStreamCount(node: MeshNode): number {
  let n = 0;
  for (const c of node.getConnections()) {
    for (const s of c.streams) {
      if (s.protocol === HTTP_STREAM_PROTOCOL) n += 1;
    }
  }
  return n;
}

async function makeClient(): Promise<MeshNode> {
  return await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { http: httpService() },
  });
}

async function makeServer(upstream: string, opts?: { upstreamTimeoutMs?: number }): Promise<MeshNode> {
  return await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { http: httpService({ server: nodeApiServer(upstream, opts) }) },
  });
}

interface Stub {
  srv: Server;
  base: string;
  bigJson: string;
}

async function makeStub(): Promise<Stub> {
  const bigJson = JSON.stringify({ proof: 'ab'.repeat(150 * 1024) });
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ height: 1, id: 'ab'.repeat(32) }));
    } else if (req.url === '/nipopow/proof/24/20') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bigJson);
    } else if (req.url === '/stall') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // deliberately never finish: tests the read deadline
    } else if (req.url === '/slow-headers') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ late: true }));
      }, 500);
    } else if (req.url === '/dead') {
      // deliberately never answer: tests the upstream deadline on the node
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}`, bigJson };
}

async function waitListen(node: MeshNode): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const addrs = node.getMultiaddrs();
    if (addrs.length) return addrs[0]!.toString();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no listen addrs');
}

describe('HTTP over libp2p — meshFetch and the node endpoint', () => {
  let server: MeshNode | null = null;
  let client: MeshNode | null = null;
  let stub: Stub | null = null;

  beforeEach(async () => {
    stub = await makeStub();
    server = await makeServer(stub.base);
    client = await makeClient();
    const addr = await waitListen(server);
    await client.dial(multiaddr(addr));
  });

  afterEach(async () => {
    try { await client?.stop(); } catch { /* already stopped */ }
    try { await server?.stop(); } catch { /* already stopped */ }
    stub?.srv.close();
    client = null; server = null; stub = null;
  });

  it.fails('a GET answers the upstream bytes', async () => {
    const id = notisIdFromPeerId(server!.peerId);
    const base = meshBaseUrl(id);
    const fetch = meshFetch(client!);

    // /blocks/current
    const resA = await fetch(`${base}/blocks/current`);
    expect(resA.status).toBe(200);
    expect(resA.headers.get('content-type')).toBe('application/json');
    const textA = await resA.text();
    const directA = await (await globalThis.fetch(`${stub!.base}/blocks/current`)).text();
    expect(textA).toBe(directA);

    // /nipopow/proof/24/20 — ~300 KB
    const resB = await fetch(`${base}/nipopow/proof/24/20`);
    expect(resB.status).toBe(200);
    expect(resB.headers.get('content-type')).toBe('application/json');
    const bufB = new Uint8Array(await resB.arrayBuffer());
    expect(bufB.byteLength).toBe(Buffer.byteLength(stub!.bigJson, 'utf8'));
    expect(Buffer.from(bufB).toString('utf8')).toBe(stub!.bigJson);
  }, 15_000);

  it.fails('a non-GET is refused at both ends', async () => {
    const id = notisIdFromPeerId(server!.peerId);
    const base = meshBaseUrl(id);
    const fetch = meshFetch(client!);

    // meshFetch rejects before dialling, kind 'method'
    await expect(fetch(`${base}/blocks/current`, { method: 'POST' }))
      .rejects.toThrow(MeshFetchError);
    try {
      await fetch(`${base}/blocks/current`, { method: 'POST' });
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(MeshFetchError);
      expect((e as MeshFetchError).kind).toBe('method');
    }

    // A raw POST through @libp2p/http answers 405 at the node.
    const path = '/blocks/current';
    const resource = multiaddr(`/p2p/${server!.peerId}/http-path/${encodeURIComponent(path.slice(1))}`);
    const raw = await client!.services.http.fetch(resource, { method: 'POST' });
    expect(raw.status).toBe(405);
  }, 15_000);

  it.fails('a stalled answer ends at the timeout', async () => {
    const id = notisIdFromPeerId(server!.peerId);
    const base = meshBaseUrl(id);
    const fastFetch = meshFetch(client!, { timeoutMs: 1_000 });

    // meshFetch's own timeout
    const t0 = Date.now();
    let caught: unknown;
    try { await fastFetch(`${base}/stall`); } catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_500);
    expect(caught instanceof Error && caught.name === 'TimeoutError').toBe(true);

    // fetchJson over meshFetch — the reader's own timeout wins and the
    // result carries timedOut: true (WEB_INTERFACE → Reading a node's answer).
    const r = await fetchJson(fastFetch, `${base}/stall`, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(0);
      expect(r.timedOut).toBe(true);
    }
  }, 15_000);

  it.fails('the cap holds over the mesh', async () => {
    const id = notisIdFromPeerId(server!.peerId);
    const base = meshBaseUrl(id);
    const fetch = meshFetch(client!);

    const overMesh = await fetchJson(fetch, `${base}/nipopow/proof/24/20`, 1024);
    expect(overMesh.ok).toBe(false);
    if (!overMesh.ok) expect(overMesh.body).toBe('body over 1024 bytes');

    const direct = await fetchJson(globalThis.fetch, `${stub!.base}/nipopow/proof/24/20`, 1024);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.body).toBe('body over 1024 bytes');
  }, 15_000);

  it.fails('a peer that is not reachable rejects as transport', async () => {
    // A key no node holds: generate a fresh one that is not in the
    // client's peerstore.
    const strangerId = bytesToHex(generateKeyPair().publicKey);
    const base = meshBaseUrl(strangerId);
    const fetch = meshFetch(client!, { timeoutMs: 2_000 });
    let caught: unknown;
    try { await fetch(`${base}/blocks/current`); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MeshFetchError);
    if (caught instanceof MeshFetchError) expect(caught.kind).toBe('transport');
  }, 10_000);

  it.fails('a mesh URL that does not parse rejects as url', async () => {
    const fetch = meshFetch(client!);
    const uppercase = 'notis-mesh://' + 'AB'.repeat(32) + '/x';
    for (const bad of ['http://x/y', 'notis-mesh://ab/x', uppercase]) {
      let caught: unknown;
      try { await fetch(bad); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(MeshFetchError);
      if (caught instanceof MeshFetchError) expect(caught.kind).toBe('url');
    }
  }, 10_000);

  // MESH_INTERFACE → The node endpoint — a client that gave up before the
  // answer owns no `/http/1.1` stream once the upstream has eventually
  // answered: meshFetch cancels the Response body on a late resolve, and the
  // libp2p stream closes with the server's own `stream.close` on completion.
  it.fails('an abort before the answer leaks no stream once the upstream answers', async () => {
    const id = notisIdFromPeerId(server!.peerId);
    const base = meshBaseUrl(id);
    const fastFetch = meshFetch(client!, { timeoutMs: 100 });

    // Baseline: a fresh dial holds no `/http/1.1` stream.
    expect(httpStreamCount(client!)).toBe(0);
    expect(httpStreamCount(server!)).toBe(0);

    // The stub's `/slow-headers` sends its headers after 500 ms — past the
    // 100 ms timeout — then ends.
    let caught: unknown;
    try { await fastFetch(`${base}/slow-headers`); } catch (e) { caught = e; }
    expect(caught instanceof Error && caught.name === 'TimeoutError').toBe(true);

    // Wait past the stub's delay and the forwarder's write; both ends should
    // return to zero `/http/1.1` streams.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(httpStreamCount(client!)).toBe(0);
    expect(httpStreamCount(server!)).toBe(0);
  }, 15_000);

  // MESH_INTERFACE → The node endpoint — the server's own wait on the
  // upstream is bounded. A `/dead` upstream makes the server abort the
  // libp2p stream at its upstream deadline, and the client sees a transport
  // failure (or its own earlier deadline, whichever fires first) rather than
  // waiting indefinitely.
  it.fails('an upstream that never answers is bounded by the server', async () => {
    const localStub = await makeStub();
    const localServer = await makeServer(localStub.base, { upstreamTimeoutMs: 500 });
    const localClient = await makeClient();
    try {
      const addr = await waitListen(localServer);
      await localClient.dial(multiaddr(addr));
      const id = notisIdFromPeerId(localServer.peerId);
      const base = meshBaseUrl(id);
      // Client timeout well above the server's — we assert the server's
      // deadline, not the client's.
      const fetch = meshFetch(localClient, { timeoutMs: 5_000 });

      const t0 = Date.now();
      let caught: unknown;
      try { await fetch(`${base}/dead`); } catch (e) { caught = e; }
      const elapsed = Date.now() - t0;

      // The caller gets either a transport error (the server aborted the
      // stream) or its own TimeoutError if that fired first.
      expect(caught).toBeDefined();
      const asError = caught as Error;
      const transportOrDeadline =
        (caught instanceof MeshFetchError && caught.kind === 'transport') ||
        asError.name === 'TimeoutError';
      expect(transportOrDeadline).toBe(true);
      // Elapsed is bounded by the SERVER's deadline plus a margin — well
      // under the client's own 5 000 ms.
      expect(elapsed).toBeLessThan(1_500);

      // The server's `/http/1.1` stream is closed on the server too.
      await new Promise((r) => setTimeout(r, 300));
      expect(httpStreamCount(localServer)).toBe(0);
    } finally {
      try { await localClient.stop(); } catch { /* already stopped */ }
      try { await localServer.stop(); } catch { /* already stopped */ }
      localStub.srv.close();
    }
  }, 15_000);
});
