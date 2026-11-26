// MESH_INTERFACE → FIPS → "A reader links when a node's every other address
// failed" — the mesh client's FIPS pass over real libp2p. Three NetNodes B
// peered with A and C over TCP so B links to both over FIPS; a browser-style
// mesh client reaches B directly over WebRTC-direct and reaches A and C over
// FIPS through the link B carries. Each case runs against a stub HTTP base
// on each node, answering `/blocks/current` with a shape the client's tip
// read admits.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Libp2p } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { profileFor, generateKeyPair } from '@dagsocial/types';
import type { KeyPair, NetworkProfile, NetworkType } from '@dagsocial/types';
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
  blockHash,
} from '@dagsocial/validation';
import { NetNode } from '@dagsocial/net';
import type { NetConfig, NetValidators, MeshConfig, FipsStack } from '@dagsocial/net';
import { notisIdFromPeerId } from '@dagsocial/net/browser';
import {
  startMeshClient,
  type MeshClient,
  type MeshEvent,
} from '@dagsocial/web/mesh';
import { chainResolve } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';

const NETWORK: NetworkType = 'devnet';
const PROFILE: NetworkProfile = profileFor(NETWORK);
const K = 5;
const CHAIN = makeLinkedChain(K, PROFILE);
const TIP_HEIGHT = CHAIN[CHAIN.length - 1]!.header.height;
const TIP_HASH = blockHash(CHAIN[CHAIN.length - 1]!.header)!;

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
  readonly srv: Server;
  readonly base: string;
  readonly currentJson: string;
}

async function makeStub(): Promise<Stub> {
  // The one JSON the mesh client's `/blocks/current` reader admits:
  // `{ height, hash }` — `isTipShape` holds height to a non-negative
  // safe integer and hash to 64 lowercase hex or null. The byte identity
  // lets the FIPS probe case assert a body-for-body answer.
  const currentJson = JSON.stringify({ height: TIP_HEIGHT, hash: TIP_HASH });
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(currentJson);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}`, currentJson };
}

interface StartedNode {
  readonly node: NetNode;
  readonly id: string;
  readonly libp2p: Libp2p;
  readonly tcpAddr: string;
  readonly webrtcAddr: string;
  readonly fipsAddr: string;
  readonly stub: Stub;
  readonly dir: string;
  readonly nodeKey: KeyPair;
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

function meshConfigPublic(stateDir: string, httpBase: string): MeshConfig {
  return {
    role: 'public',
    network: NETWORK,
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
  };
}

function netConfig(
  nodeKey: KeyPair,
  bootstrapPeers: readonly string[],
  mesh: MeshConfig,
): NetConfig {
  return {
    nodeKey,
    magic: PROFILE.magic,
    protocolVersionSchedule: PROFILE.protocolVersionSchedule,
    orderingBlockPowTargetFloorBits: PROFILE.orderingBlockPowTargetFloorBits,
    bootstrapPeers: [...bootstrapPeers],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 10,
    maxReaders: 100,
    minPeers: 3,
    peerDbCap: 1_000,
    outboundRedialCooldownMs: 60_000,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltyDecayIntervalMs: 120_000,
    syncRequestTimeoutMs: 10_000,
    mesh,
  };
}

async function startNode(
  label: string,
  bootstrapPeers: readonly string[],
  nodeKey?: KeyPair,
): Promise<StartedNode> {
  const stub = await makeStub();
  const dir = mkdtempSync(join(tmpdir(), `mc-fips-${label}-`));
  const key = nodeKey ?? generateKeyPair();
  const node = new NetNode(
    netConfig(key, bootstrapPeers, meshConfigPublic(dir, stub.base)),
    validators,
  );
  await node.start();
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
  const webrtcAddr = addrs.find((a) => a.includes('/webrtc-direct/'));
  if (webrtcAddr === undefined) {
    await node.stop();
    throw new Error(`${label}: no WebRTC-direct listen address`);
  }
  const fipsAddr = node.fipsAddress();
  if (fipsAddr === null) {
    await node.stop();
    throw new Error(`${label}: no FIPS address`);
  }
  const tcpAddr = await nodeTcpAddress(node);
  const id = notisIdFromPeerId(libp2p.peerId);
  return { node, id, libp2p, tcpAddr, webrtcAddr, fipsAddr, stub, dir, nodeKey: key };
}

/**
 * Three nodes — A, C public mesh, B peered with both over TCP — so B's
 * FIPS stack links to A and C. `buildMesh` waits for B's stack to list
 * both links up before returning, with a 60 s cap for slower runs.
 */
async function buildMesh(): Promise<{
  a: StartedNode;
  b: StartedNode;
  c: StartedNode;
}> {
  const a = await startNode('a', []);
  const c = await startNode('c', []);
  const b = await startNode('b', [a.tcpAddr, c.tcpAddr]);
  const bStack = (b.node as unknown as { fipsStack: FipsStack }).fipsStack;
  const bothUp = await waitFor(
    () => bStack.link.linkPeers().length >= 2,
    60_000,
  );
  if (!bothUp) {
    throw new Error(
      `B did not link to both A and C: have ${bStack.link.linkPeers().length}`,
    );
  }
  return { a, b, c };
}

async function stopNode(n: StartedNode): Promise<void> {
  try { await n.node.stop(); } catch { /* already */ }
  try { n.stub.srv.close(); } catch { /* already */ }
  try { rmSync(n.dir, { recursive: true, force: true }); } catch { /* already */ }
}

/**
 * Bind a TCP socket to port 0, read the OS-assigned port, close it. The
 * returned port is free when this resolves, so a later dial to it on
 * Linux gets an ICMP/TCP RST (`ECONNREFUSED`) at once rather than
 * waiting out the dial deadline.
 */
async function reserveClosedTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const info = srv.address() as AddressInfo;
      srv.close(() => resolve(info.port));
    });
    srv.on('error', reject);
  });
}

/**
 * Four nodes — A, C public mesh, B and D both peered with A and C over
 * TCP so each of B and D runs a FIPS stack linked to A and C. `buildFourMesh`
 * waits for both B and D to list their two links up before returning.
 */
async function buildFourMesh(): Promise<{
  a: StartedNode;
  b: StartedNode;
  c: StartedNode;
  d: StartedNode;
}> {
  const a = await startNode('a', []);
  const c = await startNode('c', []);
  const b = await startNode('b', [a.tcpAddr, c.tcpAddr]);
  const d = await startNode('d', [a.tcpAddr, c.tcpAddr]);
  const bStack = (b.node as unknown as { fipsStack: FipsStack }).fipsStack;
  const dStack = (d.node as unknown as { fipsStack: FipsStack }).fipsStack;
  const bothUp = await waitFor(
    () => bStack.link.linkPeers().length >= 2 && dStack.link.linkPeers().length >= 2,
    90_000,
  );
  if (!bothUp) {
    throw new Error(
      `B and D did not each link to both A and C: ${bStack.link.linkPeers().length} / ${dStack.link.linkPeers().length}`,
    );
  }
  return { a, b, c, d };
}

describe('MESH_INTERFACE → FIPS: the reader\'s FIPS pass', () => {
  const clients: MeshClient[] = [];
  const nodes: StartedNode[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already */ } }
    for (const n of nodes.splice(0)) { await stopNode(n); }
  });

  it('a node whose other addresses fail is read over FIPS through the node the reader holds', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    // A and C: FIPS address only (no non-FIPS → `dialByAddresses`
    // returns 'skipped', the FIPS pass candidate list includes them).
    // B: its real WebRTC-direct address, the one connection the FIPS
    // link rides.
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();

    const state = client.state();
    const entryA = state.nodes.find((n) => n.notisId === mesh.a.id);
    const entryC = state.nodes.find((n) => n.notisId === mesh.c.id);
    expect(entryA, 'A entry exists').toBeDefined();
    expect(entryC, 'C entry exists').toBeDefined();
    expect(entryA!.transport, 'A is read over FIPS').toBe('fips');
    expect(entryC!.transport, 'C is read over FIPS').toBe('fips');
    expect(entryA!.via, 'A\'s link rides through B').toBe(mesh.b.id);
    expect(entryC!.via, 'C\'s link rides through B').toBe(mesh.b.id);

    // A probe of A's /blocks/current over the mesh equals A's stub body.
    const { response } = await client.read('/blocks/current', 'tip');
    expect(response.status).toBe(200);
    const text = await response.text();
    // One of A, B or C answers; the body is equal across them since
    // they share a chain. The byte identity holds for whichever one
    // the fast set picked.
    expect(text).toBe(mesh.a.stub.currentJson);
    expect(text).toBe(mesh.b.stub.currentJson);
    expect(text).toBe(mesh.c.stub.currentJson);

    // One `fips-link` open and one `up` event, both naming B as `via`.
    const linkEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link',
    );
    expect(linkEvents.some((e) => e.event === 'open' && e.via === mesh.b.id)).toBe(true);
    expect(linkEvents.some((e) => e.event === 'up' && e.via === mesh.b.id)).toBe(true);
  }, 120_000);

  it('a reader whose direct addresses answer opens no link', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    // Every node reachable at its own WebRTC-direct address: phase 1's
    // dial connects each; the FIPS pass finds no candidate.
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.webrtcAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.webrtcAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();

    const linkEvents = captured.filter((e) => e.kind === 'fips-link');
    expect(linkEvents, 'no fips-link event').toEqual([]);
    const state = client.state();
    for (const entry of state.nodes) {
      expect(entry.transport, `${entry.notisId} not FIPS`).not.toBe('fips');
    }
  }, 120_000);

  it('the link\'s node going away leaves its FIPS nodes in retry and the next check links again', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();
    {
      const s = client.state();
      expect(s.nodes.find((n) => n.notisId === mesh.a.id)!.transport).toBe('fips');
      expect(s.nodes.find((n) => n.notisId === mesh.c.id)!.transport).toBe('fips');
    }

    // Close every link the client holds and close every FIPS
    // connection; the node-list rule binds A and C to `retry`, never
    // `blacklisted` (MESH_INTERFACE → The client's node list — the
    // table rows), and the FIPS-pass rule binds the next check to
    // open a link again (→ FIPS → "A reader links when a node's every
    // other address failed").
    const stack = (client as unknown as { fipsStack: FipsStack }).fipsStack;
    for (const peer of stack.link.linkPeers()) {
      await stack.link.close({ transport: stack.link.type, addr: peer.remoteKeyHex });
    }
    const libp2p = (client as unknown as { libp2p: Libp2p }).libp2p;
    for (const conn of libp2p.getConnections()) {
      if (conn.remoteAddr.toString().startsWith('/fips/')) {
        try { await conn.close(); } catch { /* already */ }
      }
    }

    // Each check runs under the invariant that A and C never blacklist;
    // the pass that opens a new link fires one `open`/`up` pair and
    // the check reads A and C over FIPS through the re-made link.
    captured.length = 0;
    const t0 = Date.now();
    let sawReOpen = false;
    while (Date.now() - t0 < 30_000) {
      await client.check();
      const s = client.state();
      const a = s.nodes.find((n) => n.notisId === mesh.a.id);
      const c = s.nodes.find((n) => n.notisId === mesh.c.id);
      expect(a!.status, 'A never blacklisted').not.toBe('blacklisted');
      expect(c!.status, 'C never blacklisted').not.toBe('blacklisted');
      const linkEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
        e.kind === 'fips-link',
      );
      if (linkEvents.some((e) => e.event === 'open' && e.via === mesh.b.id)
          && linkEvents.some((e) => e.event === 'up' && e.via === mesh.b.id)) {
        sawReOpen = true;
        // MESH_INTERFACE → FIPS → "A send to a key with no route waits
        // for one" — the check that opens the link again reads A and C
        // over FIPS through it. The patch at `@fips/core` holds a send
        // on the re-made link for fips-ts's route lookup; the entries'
        // `transport` names `fips` and their `status` is `ok`.
        expect(a!.transport, 'A read over FIPS through the re-made link').toBe('fips');
        expect(a!.status, 'A is ok after the re-made link').toBe('ok');
        expect(c!.transport, 'C read over FIPS through the re-made link').toBe('fips');
        expect(c!.status, 'C is ok after the re-made link').toBe('ok');
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(sawReOpen, 'a later check links again').toBe(true);
  }, 120_000);

  it('a reader holding no connection opens no link until the local node connects', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    // B absent from firstContact; A and C as FIPS-only (no non-FIPS,
    // so phase 1 does not dial them and the FIPS pass sees them as
    // candidates). With no connection to anywhere, the FIPS pass can
    // pick no link peer, and so emits no event.
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();
    {
      const linkEvents = captured.filter((e) => e.kind === 'fips-link');
      expect(linkEvents, 'no fips-link event before B is reachable').toEqual([]);
    }

    // Add B through the client's `addByHand` seam — the closest in-tree
    // analogue to `addLocal`: both add an entry whose addresses are
    // configured so the gater lets them through for that key alone,
    // and both trigger an immediate check. (The spec's `addLocal` path
    // is an internal seam for the extension's identity-URL lookup; the
    // rule under test is that a link opens only after a connection the
    // client holds has handshake-passed.)
    captured.length = 0;
    client.addByHand(mesh.b.id, [mesh.b.webrtcAddr], false);
    // Give the triggered immediate check time to open B and run the
    // pass; `addByHand` triggers an immediate check internally.
    await waitFor(() => {
      const s = client.state();
      return s.nodes.find((n) => n.notisId === mesh.a.id)?.transport === 'fips'
        && s.nodes.find((n) => n.notisId === mesh.c.id)?.transport === 'fips';
    }, 60_000);

    const linkEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link',
    );
    expect(linkEvents.some((e) => e.event === 'open' && e.via === mesh.b.id)).toBe(true);
    expect(linkEvents.some((e) => e.event === 'up' && e.via === mesh.b.id)).toBe(true);
  }, 180_000);

  it('a link that went down between checks is opened again by the next check that needs one', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();
    const stack = (client as unknown as { fipsStack: FipsStack }).fipsStack;
    expect(stack, 'the client exposes its FIPS stack').toBeDefined();
    const linkPeersAfterFirst = stack.link.linkPeers();
    expect(linkPeersAfterFirst.length, 'one link up after first check').toBe(1);

    // Close the link from the client side; the `closed` event fires
    // through `onLinkChange` (MESH_INTERFACE → FIPS → "A reader's link
    // closes at the end of a check").
    captured.length = 0;
    await stack.link.close({
      transport: stack.link.type,
      addr: linkPeersAfterFirst[0]!.remoteKeyHex,
    });
    await waitFor(
      () => captured.some((e) => e.kind === 'fips-link' && e.event === 'closed'),
      5_000,
    );

    // Close every open FIPS connection so the next check lists A and
    // C as FIPS pass candidates.
    captured.length = 0;
    const libp2p = (client as unknown as { libp2p: Libp2p }).libp2p;
    for (const conn of libp2p.getConnections()) {
      if (conn.remoteAddr.toString().startsWith('/fips/')) {
        try { await conn.close(); } catch { /* already */ }
      }
    }
    await client.check();
    const linkEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link',
    );
    expect(linkEvents.some((e) => e.event === 'open' && e.via === mesh.b.id)).toBe(true);
    expect(linkEvents.some((e) => e.event === 'up' && e.via === mesh.b.id)).toBe(true);

    // MESH_INTERFACE → FIPS → "A send to a key with no route waits for
    // one" — the check that opens the link again reads A and C over
    // FIPS through it. The patch at `@fips/core` holds a send on the
    // re-made link for fips-ts's route lookup.
    const sAfter = client.state();
    const aAfter = sAfter.nodes.find((n) => n.notisId === mesh.a.id);
    const cAfter = sAfter.nodes.find((n) => n.notisId === mesh.c.id);
    expect(aAfter!.transport, 'A read over FIPS through the re-made link').toBe('fips');
    expect(aAfter!.status, 'A is ok after the re-made link').toBe('ok');
    expect(cAfter!.transport, 'C read over FIPS through the re-made link').toBe('fips');
    expect(cAfter!.status, 'C is ok after the re-made link').toBe('ok');
  }, 180_000);

  it('the link closes at the end of a check that needs no FIPS connection', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();
    const stack = (client as unknown as { fipsStack: FipsStack }).fipsStack;
    expect(stack.link.linkPeers().length, 'one link up after first check').toBe(1);

    // "Give A and C working direct addresses" — the brief's "restart
    // the client's list so they connect directly" path. `addByHand`
    // adds A's and C's own WebRTC-direct addresses to the entries,
    // writing them into `configured` so the gater lets them through
    // for that key alone.
    client.addByHand(mesh.a.id, [mesh.a.webrtcAddr], false);
    client.addByHand(mesh.c.id, [mesh.c.webrtcAddr], false);
    // Close A's and C's FIPS connections so the next check dials them.
    const libp2p = (client as unknown as { libp2p: Libp2p }).libp2p;
    for (const conn of libp2p.getConnections()) {
      if (conn.remoteAddr.toString().startsWith('/fips/')) {
        try { await conn.close(); } catch { /* already */ }
      }
    }

    // Run a check: A and C dial over WebRTC-direct and connect
    // directly; the FIPS pass finds no candidate; at check end the
    // client holds no FIPS connection and dialled no FIPS address, so
    // every up link closes.
    captured.length = 0;
    await client.check();
    // Wait for the close to propagate through the subscription.
    await waitFor(
      () => captured.some((e) => e.kind === 'fips-link' && e.event === 'closed'),
      5_000,
    );
    const linkEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link',
    );
    expect(linkEvents.some((e) => e.event === 'closed' && e.via === mesh.b.id)).toBe(true);
    expect(stack.link.linkPeers().length, 'no link up after the close').toBe(0);
  }, 180_000);

  it('a node whose dialled addresses fail is read over FIPS', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    // A TCP port that nothing listens on: a dial to it on this host
    // gets `ECONNREFUSED` at once, so the phase-1 dial fails without
    // waiting out `PEER_DIAL_MIN_MS`. A's address list carries the
    // secure-WebSocket shape for that port plus its FIPS address; the
    // gater lets the private TCP address through because it is one of
    // A's first-contact addresses (→ Transports → "A client dials a
    // private address only when its own configuration names it").
    const closedPort = await reserveClosedTcpPort();
    const aPeerIdStr = mesh.a.libp2p.peerId.toString();
    const aFailAddr = `/ip4/127.0.0.1/tcp/${closedPort}/tls/ws/p2p/${aPeerIdStr}`;

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [aFailAddr, mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();

    // Phase 1 reports a failed dial for A at the tls/ws address; the
    // FIPS pass then reads A over FIPS via B.
    const aDials = captured.filter((e): e is Extract<MeshEvent, { kind: 'dial' }> =>
      e.kind === 'dial' && e.nodeId === mesh.a.id,
    );
    expect(aDials.length, 'a dial event for A').toBeGreaterThanOrEqual(1);
    expect(
      aDials.some((d) => d.outcome.result === 'failed'),
      "A's dial outcome is `failed`",
    ).toBe(true);

    const state = client.state();
    const entryA = state.nodes.find((n) => n.notisId === mesh.a.id);
    expect(entryA, 'A entry exists').toBeDefined();
    expect(entryA!.transport, 'A read over FIPS').toBe('fips');
    expect(entryA!.via, 'A\'s link rides through B').toBe(mesh.b.id);
  }, 180_000);

  it('the FIPS pass opens the link over a `local` node first', async () => {
    const mesh = await buildFourMesh();
    nodes.push(mesh.a, mesh.b, mesh.c, mesh.d);

    // B first in firstContact (so entries order lists B before D) and
    // D handed as a `local` seed through the `addLocal` path — the
    // same path a real `local` node takes. Both B and D get an open,
    // handshake-passed connection; the pick must land on D because it
    // is `local`, not on B even though B comes first in entries.
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      seeds: [
        { notisId: mesh.d.id, addrs: [mesh.d.webrtcAddr], local: true },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();

    const linkEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link',
    );
    const openEvents = linkEvents.filter((e) => e.event === 'open');
    expect(openEvents.length, 'one `open` event this check').toBeGreaterThanOrEqual(1);
    expect(
      openEvents.every((e) => e.via === mesh.d.id),
      'every `open` names D (local), never B',
    ).toBe(true);
  }, 240_000);

  it('a check with a link up dials a new candidate through it and opens no second link', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    // firstContact names A (FIPS only) and B (webrtc). C is not in the
    // list at start; a `peer:discovery` event names C's FIPS address
    // after the first check, so the second check finds it as a new
    // candidate the pass dials through the standing link.
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();
    const stack = (client as unknown as { fipsStack: FipsStack }).fipsStack;
    expect(stack.link.linkPeers().length, 'one link up after the first check').toBe(1);
    expect(
      client.state().nodes.find((n) => n.notisId === mesh.a.id)!.transport,
      'A read over FIPS on the first check',
    ).toBe('fips');

    const openCountBefore = captured.filter(
      (e) => e.kind === 'fips-link' && e.event === 'open',
    ).length;

    // Dispatch `peer:discovery` for C with its FIPS address — the mesh
    // client's `handleDiscovery` adds the entry through `NodeList.add`,
    // the path a DHT-discovered peer takes (MESH_INTERFACE → Discovery).
    const libp2p = (client as unknown as { libp2p: Libp2p }).libp2p;
    (libp2p as unknown as { safeDispatchEvent: (name: string, detail: unknown) => void })
      .safeDispatchEvent('peer:discovery', {
        detail: {
          id: mesh.c.libp2p.peerId,
          multiaddrs: [multiaddr(mesh.c.fipsAddr)],
        },
      });

    await client.check();

    const linkEventsAfter = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link',
    );
    const openCountAfter = linkEventsAfter.filter((e) => e.event === 'open').length;
    expect(openCountAfter, 'no new `open` event after the first check').toBe(openCountBefore);
    expect(stack.link.linkPeers().length, 'still one link up').toBe(1);

    const state = client.state();
    const entryC = state.nodes.find((n) => n.notisId === mesh.c.id);
    expect(entryC, 'C entry exists').toBeDefined();
    expect(entryC!.transport, 'C read over FIPS').toBe('fips');
    expect(entryC!.via, "C's link rides through B").toBe(mesh.b.id);
  }, 180_000);

  it("libp2p's own dial of a FIPS address is refused while no link is up", async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    // No FIPS address in firstContact: the first check has no FIPS
    // candidate, so the FIPS pass opens no link. The client holds a
    // connection to B afterwards, which the manual `openLink` below
    // rides.
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
    });
    clients.push(client);

    await client.check();
    const stack = (client as unknown as { fipsStack: FipsStack }).fipsStack;
    expect(stack.link.linkPeers().length, 'no link up after the first check').toBe(0);

    const libp2p = (client as unknown as { libp2p: Libp2p }).libp2p;
    const aFipsMa = multiaddr(mesh.a.fipsAddr);

    // MESH_INTERFACE → The client's node list → "A FIPS address is ranked
    // last" — "The gater admits a FIPS address only while the client
    // holds an up link, whoever asks for the dial, libp2p's own services
    // included". With no link up, libp2p's own dial of A's FIPS address
    // is refused by the gater as `DialDeniedError`.
    let firstErr: unknown = null;
    try {
      await libp2p.dial(aFipsMa, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      firstErr = e;
    }
    expect(firstErr, 'the first dial rejects').not.toBeNull();
    const firstErrName = (firstErr as { name?: string } | null)?.name ?? '';
    const firstErrMessage = (firstErr as { message?: string } | null)?.message ?? '';
    expect(
      firstErrName === 'DialDeniedError' || /denied/i.test(firstErrMessage),
      `the first dial's error is dial-denied; saw name=${firstErrName} message=${firstErrMessage}`,
    ).toBe(true);

    // Open a link to B manually, so `fipsLinkUp()` answers true and the
    // gater lets the next dial through.
    const bPeerIdStr = mesh.b.libp2p.peerId.toString();
    const bConn = libp2p.getConnections().find((c) => c.remotePeer.toString() === bPeerIdStr);
    expect(bConn, 'the client holds a connection to B').toBeDefined();
    const opened = await stack.link.openLink(bConn!);
    expect(opened, 'openLink answers B\'s FIPS key').not.toBe('');
    const up = await waitFor(() => stack.link.linkPeers().length > 0, 10_000);
    expect(up, 'link to B comes up').toBe(true);

    // Same address dials now. A throw here fails the case; a resolve is
    // the rule's answer.
    await libp2p.dial(aFipsMa, { signal: AbortSignal.timeout(20_000) });
  }, 180_000);

  it('a check whose FIPS pass needs a link opens it over a WebRTC connection, never over a standing FIPS connection', async () => {
    const mesh = await buildMesh();
    nodes.push(mesh.a, mesh.b, mesh.c);

    const captured: MeshEvent[] = [];
    // Entries order places A first (FIPS only), then B (WebRTC), then
    // C (FIPS only). After the first check the client holds a WebRTC
    // connection to B and two FIPS connections through B — the rule
    // this case drives is `pickLinkConnection` refusing the FIPS one.
    const client = await startMeshClient({
      firstContact: [
        { notisId: mesh.a.id, addrs: [mesh.a.fipsAddr] },
        { notisId: mesh.b.id, addrs: [mesh.b.webrtcAddr] },
        { notisId: mesh.c.id, addrs: [mesh.c.fipsAddr] },
      ],
      network: NETWORK,
      profile: PROFILE,
      agentName: 'notis-fips-pass-test',
      fips: true,
      resolve: chainResolve(() => CHAIN, K),
      events: (e) => captured.push(e),
    });
    clients.push(client);

    await client.check();
    const stack = (client as unknown as { fipsStack: FipsStack }).fipsStack;
    const libp2p = (client as unknown as { libp2p: Libp2p }).libp2p;
    // Controls: one link up and two FIPS connections after the first
    // check — one to A, one to C.
    expect(stack.link.linkPeers().length, 'one link up after the first check').toBe(1);
    const fipsConnsBefore = libp2p.getConnections().filter(
      (c) => c.remoteAddr.toString().startsWith('/fips/'),
    );
    expect(fipsConnsBefore.length, 'two FIPS connections after the first check').toBe(2);

    // Close C's FIPS connection first — C becomes a FIPS pass
    // candidate (no open connection, FIPS address); A's FIPS
    // connection stands untouched. Then close B's link peer. A wait
    // on `linkPeers` emptying stands under the close's own event. If
    // A's FIPS connection is torn down with the link by libp2p, the
    // test falls on its control below — the rule still binds the
    // `pickLinkConnection` filter and the sister cases cover the
    // every-FIPS-torn-down path.
    const cPeerStr = mesh.c.libp2p.peerId.toString();
    for (const conn of libp2p.getConnections()) {
      if (conn.remotePeer.toString() === cPeerStr
          && conn.remoteAddr.toString().startsWith('/fips/')) {
        try { await conn.close(); } catch { /* already */ }
      }
    }
    captured.length = 0;
    await stack.link.close({
      transport: stack.link.type,
      addr: stack.link.linkPeers()[0]!.remoteKeyHex,
    });
    await waitFor(
      () => captured.some((e) => e.kind === 'fips-link' && e.event === 'closed'),
      5_000,
    );
    expect(stack.link.linkPeers().length, 'no link up after the close').toBe(0);
    // Control: A's FIPS connection stands after the link close. The
    // rule holds when it does — the next check's `pickLinkConnection`
    // would mistakenly pick it without the filter.
    const fipsConnsAfter = libp2p.getConnections().filter(
      (c) => c.remoteAddr.toString().startsWith('/fips/'),
    );
    expect(fipsConnsAfter.length, "A's FIPS connection stands after the link close").toBe(1);
    expect(
      fipsConnsAfter[0]!.remotePeer.toString(),
      "the standing FIPS connection is A's",
    ).toBe(mesh.a.libp2p.peerId.toString());

    // Next check: C is a FIPS candidate (no connection, FIPS address
    // only), so the pass opens a new link. The rule: the pick is a
    // connection that is not itself a FIPS one, so `via` names B, the
    // WebRTC-direct node, never A.
    captured.length = 0;
    await client.check();

    const openEvents = captured.filter((e): e is Extract<MeshEvent, { kind: 'fips-link' }> =>
      e.kind === 'fips-link' && e.event === 'open',
    );
    expect(openEvents.length, 'one `open` event in the second check').toBeGreaterThanOrEqual(1);
    expect(
      openEvents.every((e) => e.via === mesh.b.id),
      'every `open` names B (WebRTC), never A (FIPS)',
    ).toBe(true);
  }, 180_000);
});
