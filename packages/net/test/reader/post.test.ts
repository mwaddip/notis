// MESH_INTERFACE → The node endpoint — the client's side admits `GET`
// and `POST`; any other method is refused before any dial. These
// cases drive `meshFetchOverConnection` against a `NetNode` with a
// public mesh, over the node's TCP listener for speed; the endpoint
// is transport-blind (`mesh/endpoint.test.ts`), and the POST path is
// what this unit's patch unblocks.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import type { Connection } from '@libp2p/interface';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
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
import type { NetValidators, MeshConfig } from '../../src/index.js';
import { nodeKeyFromKeyPair } from '../../src/mesh/identity.js';
import {
  meshFetchOverConnection,
  MeshFetchError,
} from '../../src/mesh/mesh-fetch.js';
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

type Rec = { method: string; path: string; contentType: string | null; body: Buffer };

interface Stub {
  server: Server;
  base: string;
  received: Rec[];
}

async function makeStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Stub> {
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

function meshOn(stateDir: string, httpBase: string): MeshConfig {
  // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
  // IP"` — this case tests the HTTP forward, not STUN; the STUN
  // server is off (`stun: null`), the default `STUN_PORT` 3478 stays
  // unbound (forks-pool safe).
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

describe('MESH_INTERFACE → The node endpoint — meshFetchOverConnection POST / PUT', () => {
  let node: NetNode | null = null;
  let client: Libp2p | null = null;
  let stub: Stub | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    try { await client?.stop(); } catch { /* already stopped */ }
    try { await node?.stop(); } catch { /* already stopped */ }
    stub?.server.close();
    if (dir !== null) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
    client = null; node = null; stub = null; dir = null;
  });

  async function bringUp(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ notisId: string; pick: (notisId: string) => Connection | null }> {
    stub = await makeStub(handler);
    dir = mkdtempSync(join(tmpdir(), 'net-reader-post-'));
    const nodeKey = generateKeyPair();
    node = new NetNode(makeConfig({
      nodeKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir, stub.base),
    }), validators);
    await node.start();
    client = await makeClient();
    const addr = await nodeTcpAddress(node);
    const conn = await client.dial(multiaddr(addr));
    const notisId = nodeKeyFromKeyPair(nodeKey).notisId;
    return {
      notisId,
      pick: (id) => (id === notisId ? conn : null),
    };
  }

  it('a POST through meshFetchOverConnection reaches the node endpoint upstream and its answer returns byte for byte', async () => {
    const { notisId, pick } = await bringUp((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":1}');
    });
    const fetch = meshFetchOverConnection(pick);
    const bodyBytes = new TextEncoder().encode('{"hello":"world"}');
    const r = await fetch(`${meshBaseUrl(notisId)}/tx`, {
      method: 'POST',
      // A Blob wraps the bytes with a known content-type;
      // `@libp2p/http-fetch`'s `normalizeContent` preserves the
      // Blob's type (`blobBody`), whereas a plain string body would
      // be rewritten to `text/plain` by `stringBody`.
      body: new Blob([bodyBytes], { type: 'application/json' }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(await r.text()).toBe('{"accepted":1}');
    expect(stub!.received).toHaveLength(1);
    expect(stub!.received[0]!.method).toBe('POST');
    expect(stub!.received[0]!.path).toBe('/tx');
    expect(stub!.received[0]!.contentType).toBe('application/json');
    expect(Buffer.compare(stub!.received[0]!.body, Buffer.from(bodyBytes))).toBe(0);
  }, 30_000);

  it('a PUT is refused before any stream opens', async () => {
    const { notisId, pick } = await bringUp(() => {
      /* unreachable — the client refuses the method before any
       * stream opens, so the upstream is never contacted. */
    });
    const fetch = meshFetchOverConnection(pick);
    let caught: unknown;
    try {
      await fetch(`${meshBaseUrl(notisId)}/tx`, { method: 'PUT' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MeshFetchError);
    if (caught instanceof MeshFetchError) expect(caught.kind).toBe('method');
    // Count the `/http/1.1` streams the node holds — the method
    // refusal opens none.
    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    let httpStreams = 0;
    for (const conn of libp2p.getConnections()) {
      for (const s of conn.streams) {
        if (s.protocol === '/http/1.1') httpStreams += 1;
      }
    }
    expect(httpStreams).toBe(0);
    expect(stub!.received).toHaveLength(0);
  }, 30_000);
});
