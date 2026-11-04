// MESH_INTERFACE → The node endpoint — the client's half of
// `meshFetch`: its signal and timeout composition, its handling of
// unreachable peers, bad URLs, stalled answers, and that it leaves
// no `/http/1.1` stream behind in every ending the client sees.
// Ported from the PoC's `http-over-libp2p.test.ts`; the endpoint is
// a real `NetNode`'s public mesh.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { fetchJson } from '@dagsocial/node-reads';
import { generateKeyPair, bytesToHex } from '@dagsocial/types';
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
import type { NetValidators, MeshConfig } from '../../src/index.js';
import { nodeKeyFromKeyPair } from '../../src/mesh/identity.js';
import { meshFetch, MeshFetchError } from '../../src/mesh/mesh-fetch.js';
import { meshBaseUrl } from '../../src/mesh/mesh-url.js';
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

const HTTP_STREAM_PROTOCOL = '/http/1.1';

function httpStreamCount(node: Libp2p): number {
  let n = 0;
  for (const c of node.getConnections()) {
    for (const s of c.streams) {
      if (s.protocol === HTTP_STREAM_PROTOCOL) n += 1;
    }
  }
  return n;
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
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}`, bigJson };
}

function meshOn(stateDir: string, httpBase: string): MeshConfig {
  // STUN is not under test here — the server is off, the default
  // `STUN_PORT` 3478 stays unbound (forks-pool safe).
  return {
    role: 'public',
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase,
    stun: null,
  };
}

async function makeClient(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

async function nodeTcpAddress(node: NetNode): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  for (let i = 0; i < 400; i++) {
    const match = libp2p
      .getMultiaddrs()
      .map((m) => m.toString())
      .find((s) => s.includes('/tcp/') && !s.includes('/webrtc'));
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('node has no TCP listen address');
}

describe('MESH_INTERFACE → The node endpoint — meshFetch client half', () => {
  let node: NetNode | null = null;
  let client: Libp2p | null = null;
  let stub: Stub | null = null;
  let dir: string | null = null;
  let notisId = '';

  beforeEach(async () => {
    stub = await makeStub();
    dir = mkdtempSync(join(tmpdir(), 'net-reader-http-'));
    const nodeKey = generateKeyPair();
    node = new NetNode(makeConfig({
      nodeKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir, stub.base),
    }), validators);
    await node.start();
    client = await makeClient();
    const addr = await nodeTcpAddress(node);
    await client.dial(multiaddr(addr));
    notisId = nodeKeyFromKeyPair(nodeKey).notisId;
  });

  afterEach(async () => {
    try { await client?.stop(); } catch { /* already stopped */ }
    try { await node?.stop(); } catch { /* already stopped */ }
    stub?.srv.close();
    if (dir !== null) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
    client = null; node = null; stub = null; dir = null;
  });

  it('a GET answers the upstream bytes', async () => {
    const base = meshBaseUrl(notisId);
    const fetch = meshFetch(client!);

    const resA = await fetch(`${base}/blocks/current`);
    expect(resA.status).toBe(200);
    expect(resA.headers.get('content-type')).toBe('application/json');
    const textA = await resA.text();
    const directA = await (await globalThis.fetch(`${stub!.base}/blocks/current`)).text();
    expect(textA).toBe(directA);

    const resB = await fetch(`${base}/nipopow/proof/24/20`);
    expect(resB.status).toBe(200);
    const bufB = new Uint8Array(await resB.arrayBuffer());
    expect(bufB.byteLength).toBe(Buffer.byteLength(stub!.bigJson, 'utf8'));
    expect(Buffer.from(bufB).toString('utf8')).toBe(stub!.bigJson);
  }, 30_000);

  it('a stalled answer ends at the timeout', async () => {
    const base = meshBaseUrl(notisId);
    const fastFetch = meshFetch(client!, { timeoutMs: 1_000 });
    const t0 = Date.now();
    let caught: unknown;
    try { await fastFetch(`${base}/stall`); } catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_500);
    expect(caught instanceof Error && caught.name === 'TimeoutError').toBe(true);

    const r = await fetchJson(fastFetch, `${base}/stall`, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(0);
      expect(r.timedOut).toBe(true);
    }
  }, 30_000);

  it('the cap holds over the mesh', async () => {
    const base = meshBaseUrl(notisId);
    const fetch = meshFetch(client!);
    const overMesh = await fetchJson(fetch, `${base}/nipopow/proof/24/20`, 1024);
    expect(overMesh.ok).toBe(false);
    if (!overMesh.ok) expect(overMesh.body).toBe('body over 1024 bytes');
  }, 30_000);

  it('a peer that is not reachable rejects as transport', async () => {
    const strangerId = bytesToHex(generateKeyPair().publicKey);
    const base = meshBaseUrl(strangerId);
    const fetch = meshFetch(client!, { timeoutMs: 2_000 });
    let caught: unknown;
    try { await fetch(`${base}/blocks/current`); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MeshFetchError);
    if (caught instanceof MeshFetchError) expect(caught.kind).toBe('transport');
  }, 15_000);

  it('a mesh URL that does not parse rejects as url', async () => {
    const fetch = meshFetch(client!);
    const uppercase = 'notis-mesh://' + 'AB'.repeat(32) + '/x';
    for (const bad of ['http://x/y', 'notis-mesh://ab/x', uppercase]) {
      let caught: unknown;
      try { await fetch(bad); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(MeshFetchError);
      if (caught instanceof MeshFetchError) expect(caught.kind).toBe('url');
    }
  }, 15_000);

  // A client that gave up before the answer owns no `/http/1.1`
  // stream once the upstream has eventually answered.
  it('an abort before the answer leaks no stream once the upstream answers', async () => {
    const base = meshBaseUrl(notisId);
    const fastFetch = meshFetch(client!, { timeoutMs: 100 });
    expect(httpStreamCount(client!)).toBe(0);

    let caught: unknown;
    try { await fastFetch(`${base}/slow-headers`); } catch (e) { caught = e; }
    expect(caught instanceof Error && caught.name === 'TimeoutError').toBe(true);

    await new Promise((r) => setTimeout(r, 1_200));
    expect(httpStreamCount(client!)).toBe(0);
  }, 15_000);

  // A completed GET read to the end by the caller leaves no stream.
  it('a completed GET leaves no stream', async () => {
    const base = meshBaseUrl(notisId);
    const fetch = meshFetch(client!);
    expect(httpStreamCount(client!)).toBe(0);
    const small = await fetchJson(fetch, `${base}/blocks/current`, 10_000);
    expect(small.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(httpStreamCount(client!)).toBe(0);
  }, 15_000);
});
