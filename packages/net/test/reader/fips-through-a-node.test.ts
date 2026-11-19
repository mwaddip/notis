// MESH_INTERFACE → FIPS — a reader linked to one Notis mesh node reaches
// another by its FIPS address: the reader dials B over TCP, links to B
// over FIPS, dials C's FIPS address through the link B carries, and
// reads C's HTTP API on the connection the FIPS dial answers. B
// forwards; the reader forwards nothing.

import { afterEach, describe, expect, it } from 'vitest';
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
import type { Connection } from '@libp2p/interface';
import { generateKeyPair, PROTOCOL_VERSION } from '@dagsocial/types';
import { generateIdentity, toHex } from '@fips/core';
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
import type { NetValidators, MeshConfig, FipsStack } from '../../src/index.js';
import { createReaderFips, fipsMultiaddr } from '../../src/index.js';
import { meshFetchOverConnection } from '../../src/mesh/mesh-fetch.js';
import { meshBaseUrl } from '../../src/mesh/mesh-url.js';
import { readerHandshake } from '../../src/mesh/reader-handshake.js';
import { notisIdFromPeerId } from '../../src/mesh/identity.js';
import { fipsLinkProtocol } from '../../src/mesh/fips-link.js';
import { MAGIC_TESTNET } from '../../src/frame.js';
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

interface Stub {
  srv: Server;
  base: string;
  bigJson: string;
  currentJson: string;
}

async function makeStub(label: string): Promise<Stub> {
  const bigJson = JSON.stringify({ proof: label, bytes: 'ab'.repeat(75 * 1024) });
  const currentJson = JSON.stringify({ height: 1, id: label.repeat(64).slice(0, 64) });
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(currentJson);
    } else if (req.url === '/nipopow/proof/24/20') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bigJson);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    srv,
    base: `http://127.0.0.1:${port}`,
    bigJson,
    currentJson,
  };
}

function publicMesh(stateDir: string, httpBase: string): MeshConfig {
  // MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
  // IP" — STUN is off, the default `STUN_PORT` 3478 stays unbound.
  return {
    role: 'public',
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
  };
}

async function nodeTcpAddress(node: NetNode, deadlineMs = 10_000): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const match = libp2p.getMultiaddrs().map((m) => m.toString())
      .find((s) => /\/tcp\/\d+\/p2p\//.test(s) && !s.includes('/fips/') && !s.includes('/webrtc'));
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('node has no TCP listen address');
}

async function waitFor(check: () => boolean, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

async function buildReader(stack: FipsStack): Promise<Libp2p> {
  const reader = await createLibp2p({
    addresses: { listen: [] },
    transports: [tcp(), stack.transport],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  await stack.attach(reader);
  return reader;
}

// MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two
// ends already hold" — the reader opens the link over its one
// connection to B; the dial to C's FIPS address rides B's forwarding.
async function openReaderLink(
  stack: FipsStack,
  connB: Connection,
  bXOnlyHex: string,
  deadlineMs: number,
): Promise<void> {
  await stack.link.openLink(connB);
  const up = await waitFor(() => stack.link.linkedKeys().includes(bXOnlyHex), deadlineMs);
  if (!up) throw new Error('reader-to-B link did not come up');
}

interface Mesh {
  stubB: Stub;
  stubC: Stub;
  dirB: string;
  dirC: string;
  b: NetNode;
  c: NetNode;
  bPeerId: string;
  cPeerId: string;
  cFipsAddr: string;
  bFipsXOnlyHex: string;
}

async function buildMesh(): Promise<Mesh> {
  const stubB = await makeStub('b');
  const stubC = await makeStub('c');
  const dirB = mkdtempSync(join(tmpdir(), 'net-fips-reader-b-'));
  const dirC = mkdtempSync(join(tmpdir(), 'net-fips-reader-c-'));

  const c = new NetNode(makeConfig({
    nodeKey: generateKeyPair(),
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    mesh: publicMesh(dirC, stubC.base),
  }), validators);
  await c.start();
  const cTcp = await nodeTcpAddress(c);

  const b = new NetNode(makeConfig({
    nodeKey: generateKeyPair(),
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    bootstrapPeers: [cTcp],
    mesh: publicMesh(dirB, stubB.base),
  }), validators);
  await b.start();

  const bFipsAddr = b.fipsAddress();
  const cFipsAddr = c.fipsAddress();
  if (bFipsAddr === null || cFipsAddr === null) throw new Error('fips address missing');
  const bLibp2p = (b as unknown as { libp2p: Libp2p }).libp2p;
  const cLibp2p = (c as unknown as { libp2p: Libp2p }).libp2p;

  // MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake
  // over it completes" — B dialled C, so B is the link opener. The
  // test waits for B to see C on its linked set before the reader
  // dials the mesh.
  const bStack = (b as unknown as { fipsStack: FipsStack }).fipsStack;
  const linkedToC = await waitFor(
    () => bStack.link.linkedKeys().length >= 1,
    15_000,
  );
  if (!linkedToC) throw new Error('B did not link to C');

  return {
    stubB,
    stubC,
    dirB,
    dirC,
    b,
    c,
    bPeerId: bLibp2p.peerId.toString(),
    cPeerId: cLibp2p.peerId.toString(),
    cFipsAddr,
    bFipsXOnlyHex: toHex(bStack.identity.publicKey),
  };
}

describe('MESH_INTERFACE → FIPS: a reader reaches a node through another', () => {
  const nodes: NetNode[] = [];
  const stacks: FipsStack[] = [];
  const hosts: Libp2p[] = [];
  const stubs: Server[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.stop(); } catch { /* already */ } }
    for (const s of stacks) { try { await s.stop(); } catch { /* already */ } }
    for (const n of nodes) { try { await n.stop(); } catch { /* already */ } }
    for (const srv of stubs) { try { srv.close(); } catch { /* already */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already */ } }
    hosts.length = 0; stacks.length = 0; nodes.length = 0; stubs.length = 0; dirs.length = 0;
  });

  async function setup(): Promise<{
    mesh: Mesh;
    stack: FipsStack;
    reader: Libp2p;
    connB: Connection;
    connC: Connection;
  }> {
    const mesh = await buildMesh();
    nodes.push(mesh.b, mesh.c);
    stubs.push(mesh.stubB.srv, mesh.stubC.srv);
    dirs.push(mesh.dirB, mesh.dirC);

    const stack = await createReaderFips({ network: 'testnet' });
    stacks.push(stack);
    const reader = await buildReader(stack);
    hosts.push(reader);

    const bTcp = await nodeTcpAddress(mesh.b);
    const connB = await reader.dial(multiaddr(bTcp));
    const hsB = await readerHandshake(connB, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'fips-through-a-node-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });
    if (!hsB.ok) throw new Error(`handshake with B failed: ${hsB.reason}`);

    await openReaderLink(stack, connB, mesh.bFipsXOnlyHex, 15_000);

    const cFipsMa = multiaddr(mesh.cFipsAddr);
    const connC = await reader.dial(cFipsMa);
    const hsC = await readerHandshake(connC, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'fips-through-a-node-test',
      chainHeight: 0,
      timeoutMs: 15_000,
    });
    if (!hsC.ok) throw new Error(`handshake with C failed: ${hsC.reason}`);

    return { mesh, stack, reader, connB, connC };
  }

  it('the reader links to B and reads /blocks/current on C over FIPS', async () => {
    const { mesh, connC } = await setup();
    const cNotisId = notisIdFromPeerId(connC.remotePeer);
    const fetch = meshFetchOverConnection((wantNotisId) => {
      if (wantNotisId !== cNotisId) return null;
      return connC;
    }, { timeoutMs: 15_000 });
    const res = await fetch(`${meshBaseUrl(cNotisId)}/blocks/current`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const text = await res.text();
    expect(text).toBe(mesh.stubC.currentJson);
  }, 90_000);

  it('the reader connection to C is a FIPS connection and C holds no other to the reader', async () => {
    const { mesh, reader, connC } = await setup();
    expect(connC.remoteAddr.toString()).toContain('/fips/');
    const cLibp2p = (mesh.c as unknown as { libp2p: Libp2p }).libp2p;
    const readerIdStr = reader.peerId.toString();
    const cToReader = cLibp2p.getConnections().filter((x) => x.remotePeer.toString() === readerIdStr);
    expect(cToReader.length).toBe(1);
    expect(cToReader[0]!.remoteAddr.toString()).toContain('/fips/');
  }, 90_000);

  it('a 150 KiB proof body arrives whole', async () => {
    const { mesh, connC } = await setup();
    const cNotisId = notisIdFromPeerId(connC.remotePeer);
    const fetch = meshFetchOverConnection((wantNotisId) => {
      if (wantNotisId !== cNotisId) return null;
      return connC;
    }, { timeoutMs: 20_000 });
    const res = await fetch(`${meshBaseUrl(cNotisId)}/nipopow/proof/24/20`);
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(Buffer.byteLength(mesh.stubC.bigJson, 'utf8'));
    expect(Buffer.from(buf).toString('utf8')).toBe(mesh.stubC.bigJson);
  }, 90_000);

  it('a FIPS address with a wrong npub fails', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.b, mesh.c);
    stubs.push(mesh.stubB.srv, mesh.stubC.srv);
    dirs.push(mesh.dirB, mesh.dirC);

    const stack = await createReaderFips({ network: 'testnet' });
    stacks.push(stack);
    const reader = await buildReader(stack);
    hosts.push(reader);

    const bTcp = await nodeTcpAddress(mesh.b);
    const connB = await reader.dial(multiaddr(bTcp));
    const hsB = await readerHandshake(connB, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'fips-through-a-node-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });
    if (!hsB.ok) throw new Error(`handshake with B failed: ${hsB.reason}`);
    await openReaderLink(stack, connB, mesh.bFipsXOnlyHex, 15_000);

    const wrongIdentity = await generateIdentity();
    const wrongMa = fipsMultiaddr(wrongIdentity.xOnlyPubkey, mesh.cPeerId);

    let dialErr: unknown = null;
    let dialed: Connection | null = null;
    try {
      dialed = await reader.dial(wrongMa, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      dialErr = e;
    }
    const cLibp2p = (mesh.c as unknown as { libp2p: Libp2p }).libp2p;
    const readerIdStr = reader.peerId.toString();
    const cConnsToReader = cLibp2p.getConnections().filter((x) => x.remotePeer.toString() === readerIdStr);
    try { await dialed?.close(); } catch { /* already */ }
    expect(dialErr).not.toBeNull();
    expect(cConnsToReader.length).toBe(0);
  }, 90_000);

  it('a reader that never calls openLink opens no link stream', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.b, mesh.c);
    stubs.push(mesh.stubB.srv, mesh.stubC.srv);
    dirs.push(mesh.dirB, mesh.dirC);

    const stack = await createReaderFips({ network: 'testnet' });
    stacks.push(stack);
    const reader = await buildReader(stack);
    hosts.push(reader);

    const bTcp = await nodeTcpAddress(mesh.b);
    const connB = await reader.dial(multiaddr(bTcp));
    const hsB = await readerHandshake(connB, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'fips-through-a-node-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });
    if (!hsB.ok) throw new Error(`handshake with B failed: ${hsB.reason}`);
    // The reader does not call `openLink`. Give B a beat to settle;
    // if B initiated a link stream on its inbound connection it would
    // show up here.
    await new Promise((r) => setTimeout(r, 500));
    const bLibp2p = (mesh.b as unknown as { libp2p: Libp2p }).libp2p;
    const readerIdStr = reader.peerId.toString();
    const protocol = fipsLinkProtocol('testnet');
    const linkStreams = bLibp2p.getConnections()
      .filter((x) => x.remotePeer.toString() === readerIdStr)
      .flatMap((x) => x.streams)
      .filter((s) => s.protocol === protocol);
    expect(linkStreams.length).toBe(0);
  }, 90_000);
});
