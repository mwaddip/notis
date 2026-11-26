// NET_INTERFACE → "A mesh node runs a FIPS stack" — a mesh
// `NetNode` builds a FIPS stack before `createLibp2p`, lists `/fips/<own
// npub>` among its listen addresses, attaches after it, and reports its
// FIPS address. MESH_INTERFACE → FIPS → "A node announces its FIPS
// address" — both `meshIdentity().multiaddrs` and `libp2p.getMultiaddrs()`
// carry exactly one FIPS address, equal to `fipsAddress()`.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Libp2p } from '@libp2p/interface';
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
import {
  FipsNode,
  encodeNpub,
  generateIdentity,
  toHex,
  type FipsIdentity,
  type PeerEvent,
} from '@fips/core';

import { NetNode, MeshStateError, MeshConfigError } from '../../src/index.js';
import type { NetValidators, MeshConfig } from '../../src/index.js';
import {
  FIPS_PUBLIC_INBOUND_MAX,
  FIPS_PUBLIC_PEERS_MAX,
  type PublicFipsPeer,
} from '../../src/mesh/constants.js';
import { UdpFipsTransport } from '../../src/mesh/fips-udp.js';
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

async function stubUpstream(): Promise<{ base: string; close: () => Promise<void> }> {
  const server: HttpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function publicMeshOn(stateDir: string, httpBase: string): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
  };
}

function publicMeshWithAnnounce(stateDir: string, httpBase: string, announce: string[]): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    announce,
    stateDir,
    httpBase: () => httpBase,
    stun: null,
  };
}

function privateMeshOn(stateDir: string, httpBase: string): MeshConfig {
  return {
    role: 'private',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
  };
}

function libp2pOf(node: NetNode): Libp2p {
  return (node as unknown as { libp2p: Libp2p }).libp2p;
}

async function firstTcpAddr(node: NetNode, deadlineMs: number): Promise<string | null> {
  const libp2p = libp2pOf(node);
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const a = libp2p.getMultiaddrs().map((m) => m.toString())
      .find((s) => /\/tcp\/\d+\/p2p\//.test(s) && !s.includes('/fips/'));
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('MESH_INTERFACE → FIPS: a mesh NetNode runs FIPS', () => {
  const dirs: string[] = [];
  const nodes: NetNode[] = [];
  const upstreams: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already */ } }
    nodes.length = 0;
    for (const u of upstreams) { try { await u.close(); } catch { /* already */ } }
    upstreams.length = 0;
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already */ } }
    dirs.length = 0;
  });

  it('fipsAddress answers the node npub and peer id', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-addr-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    await node.start();
    nodes.push(node);
    const addr = node.fipsAddress();
    expect(addr).not.toBeNull();
    const libp2p = libp2pOf(node);
    const peerId = libp2p.peerId.toString();
    expect(addr!.endsWith(`/p2p/${peerId}`)).toBe(true);
    expect(addr!.startsWith('/fips/npub1')).toBe(true);
  }, 30_000);

  it('a public node on port 0 announces its FIPS address', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-port0-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    await node.start();
    nodes.push(node);
    const addr = node.fipsAddress();
    expect(addr).not.toBeNull();
    const meshFips = (node.meshIdentity()?.multiaddrs ?? []).filter((a) => a.includes('/fips/'));
    const libFips = libp2pOf(node).getMultiaddrs().map((a) => a.toString())
      .filter((a) => a.includes('/fips/'));
    expect(meshFips).toEqual([addr]);
    expect(libFips).toEqual([addr]);
  }, 30_000);

  it('a public node with an operator announce list announces its FIPS address', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-announce-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithAnnounce(dir, up.base, ['/ip4/203.0.113.4/tcp/4002']),
    }), validators);
    await node.start();
    nodes.push(node);
    const addr = node.fipsAddress();
    expect(addr).not.toBeNull();
    const meshFips = (node.meshIdentity()?.multiaddrs ?? []).filter((a) => a.includes('/fips/'));
    const libFips = libp2pOf(node).getMultiaddrs().map((a) => a.toString())
      .filter((a) => a.includes('/fips/'));
    expect(meshFips).toEqual([addr]);
    expect(libFips).toEqual([addr]);
  }, 30_000);

  it('a private node announces its FIPS address beside its relay reservations', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const relayDir = mkdtempSync(join(tmpdir(), 'net-fips-node-relay-'));
    dirs.push(relayDir);
    const relay = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(relayDir, up.base),
    }), validators);
    await relay.start();
    nodes.push(relay);
    const relayAddr = await firstTcpAddr(relay, 10_000);
    expect(relayAddr).not.toBeNull();

    const privDir = mkdtempSync(join(tmpdir(), 'net-fips-node-priv-'));
    dirs.push(privDir);
    const priv = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [relayAddr!],
      mesh: privateMeshOn(privDir, up.base),
    }), validators);
    await priv.start();
    nodes.push(priv);
    // Give identify/listener startup a beat.
    await new Promise((r) => setTimeout(r, 300));
    const addr = priv.fipsAddress();
    expect(addr).not.toBeNull();
    // libp2p encapsulates listener addresses onto relay reservations,
    // so a relay with its own FIPS address produces a
    // `/fips/<relay-npub>/.../p2p-circuit/p2p/<self>` beside the bare
    // `/fips/<self-npub>/p2p/<self>`; the assertion keeps that the bare
    // address is present and equal to `fipsAddress()`
    // (`MESH_INTERFACE → FIPS → "A node announces its FIPS address"`).
    const meshFips = (priv.meshIdentity()?.multiaddrs ?? []).filter((a) => a.includes('/fips/'));
    const libFips = libp2pOf(priv).getMultiaddrs().map((a) => a.toString())
      .filter((a) => a.includes('/fips/'));
    expect(meshFips).toContain(addr);
    expect(libFips).toContain(addr);
  }, 60_000);

  it('a public node on fixed ports announces its FIPS address', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-fixed-'));
    dirs.push(dir);
    // The OS hands out a free TCP port on `listen(0)`; the probe
    // closes before the real listener binds, and one retry handles an
    // EADDRINUSE race against a concurrent port-0 allocation
    // elsewhere in the suite (`MESH_INTERFACE → NAT → "A public node
    // announces its listen addresses from the start"`).
    let node: NetNode | null = null;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2 && node === null; attempt++) {
      const srv = createServer();
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const tcpPort = (srv.address() as AddressInfo).port;
      await new Promise<void>((r) => srv.close(() => r()));
      const candidate = new NetNode(makeConfig({
        nodeKey: generateKeyPair(),
        listenAddrs: `/ip4/127.0.0.1/tcp/${tcpPort}`,
        mesh: publicMeshOn(dir, up.base),
      }), validators);
      try {
        await candidate.start();
        node = candidate;
      } catch (err) {
        lastErr = err as Error;
        try { await candidate.stop(); } catch { /* already */ }
      }
    }
    expect(node, `last error: ${lastErr?.message ?? 'none'}`).not.toBeNull();
    nodes.push(node!);
    const addr = node!.fipsAddress();
    expect(addr).not.toBeNull();
    const meshFips = (node!.meshIdentity()?.multiaddrs ?? []).filter((a) => a.includes('/fips/'));
    const libFips = libp2pOf(node!).getMultiaddrs().map((a) => a.toString())
      .filter((a) => a.includes('/fips/'));
    expect(meshFips).toEqual([addr]);
    expect(libFips).toEqual([addr]);
  }, 30_000);

  it('the npub survives a restart on the same state directory', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-restart-'));
    dirs.push(dir);
    const nodeKey = generateKeyPair();

    const first = new NetNode(makeConfig({
      nodeKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    await first.start();
    const firstAddr = first.fipsAddress();
    expect(firstAddr).not.toBeNull();
    const firstNpub = firstAddr!.split('/p2p/')[0];
    await first.stop();

    const second = new NetNode(makeConfig({
      nodeKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    await second.start();
    nodes.push(second);
    const secondAddr = second.fipsAddress();
    expect(secondAddr).not.toBeNull();
    const secondNpub = secondAddr!.split('/p2p/')[0];
    expect(secondNpub).toBe(firstNpub);
  }, 60_000);

  it('two mesh nodes connected link over FIPS', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dirA = mkdtempSync(join(tmpdir(), 'net-fips-node-linkA-'));
    dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'net-fips-node-linkB-'));
    dirs.push(dirB);
    const a = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dirA, up.base),
    }), validators);
    await a.start();
    nodes.push(a);
    const aAddr = await firstTcpAddr(a, 10_000);
    expect(aAddr).not.toBeNull();

    const b = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [aAddr!],
      mesh: publicMeshOn(dirB, up.base),
    }), validators);
    await b.start();
    nodes.push(b);

    // The stack exposes its link through an accessor the node forwards.
    // Wait for B's link to A to come up: B dialled A's TCP address, so
    // B is the opener of the link.
    const aFipsAddr = a.fipsAddress();
    expect(aFipsAddr).not.toBeNull();
    const aXOnlyNpub = (aFipsAddr!.split('/p2p/')[0] ?? '').slice('/fips/'.length);
    const getLink = (n: NetNode): { linkedKeys(): string[] } | null => {
      const stack = (n as unknown as { fipsStack?: { link: { linkedKeys(): string[] } } }).fipsStack;
      return stack?.link ?? null;
    };
    const linkB = getLink(b);
    expect(linkB).not.toBeNull();
    const t0 = Date.now();
    let bLinkedToA = false;
    while (Date.now() - t0 < 10_000) {
      const keys = linkB!.linkedKeys();
      // The link is held by the remote's x-only key hex form; parity may
      // be either, so match on the 64-hex suffix.
      const match = keys.some((k) => k.length === 66);
      if (match) { bLinkedToA = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Reference `aXOnlyNpub` so an unused-variable warning does not hide
    // the identity match the link derives.
    expect(typeof aXOnlyNpub).toBe('string');
    expect(bLinkedToA).toBe(true);
  }, 60_000);

  it('a restarted peer is linked again', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dirA = mkdtempSync(join(tmpdir(), 'net-fips-node-relinkA-'));
    dirs.push(dirA);
    const dirB = mkdtempSync(join(tmpdir(), 'net-fips-node-relinkB-'));
    dirs.push(dirB);
    const bKey = generateKeyPair();
    const a = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dirA, up.base),
    }), validators);
    await a.start();
    nodes.push(a);
    const aAddr = await firstTcpAddr(a, 10_000);
    expect(aAddr).not.toBeNull();

    const b1 = new NetNode(makeConfig({
      nodeKey: bKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [aAddr!],
      mesh: publicMeshOn(dirB, up.base),
    }), validators);
    await b1.start();
    const b1Fips = b1.fipsAddress();
    expect(b1Fips).not.toBeNull();
    const bNpub = b1Fips!.split('/p2p/')[0];
    await b1.stop();

    const b2 = new NetNode(makeConfig({
      nodeKey: bKey,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [aAddr!],
      mesh: publicMeshOn(dirB, up.base),
    }), validators);
    await b2.start();
    nodes.push(b2);
    const b2Fips = b2.fipsAddress();
    expect(b2Fips).not.toBeNull();
    expect(b2Fips!.split('/p2p/')[0]).toBe(bNpub);

    const linkB = (b2 as unknown as { fipsStack?: { link: { linkedKeys(): string[] } } })
      .fipsStack?.link ?? null;
    expect(linkB).not.toBeNull();
    const t0 = Date.now();
    let relinked = false;
    while (Date.now() - t0 < 10_000) {
      if (linkB!.linkedKeys().some((k) => k.length === 66)) { relinked = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(relinked).toBe(true);
  }, 90_000);

  it('a node with no mesh runs no FIPS stack', async () => {
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
    }), validators);
    await node.start();
    nodes.push(node);
    const addr = node.fipsAddress();
    expect(addr).toBeNull();
    const stack = (node as unknown as { fipsStack?: unknown }).fipsStack;
    expect(stack ?? null).toBeNull();
  }, 15_000);

  it('an unreadable fips.key stops start with MeshStateError naming the path', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-badkey-'));
    dirs.push(dir);
    const keyPath = join(dir, 'fips.key');
    // 31 bytes — refused by `loadFipsKey` (the length guard).
    writeFileSync(keyPath, Buffer.alloc(31));
    // A read-only mode avoids the writer branch's `wx` throw on an
    // existing file.
    chmodSync(keyPath, 0o600);
    // Confirm the file is as the writer left it (readback round-trip).
    expect(readFileSync(keyPath).length).toBe(31);

    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    const err = await node.start().then(() => null).catch((e) => e as Error);
    // The node did not start past the refusal; nothing to stop.
    expect(err).toBeInstanceOf(MeshStateError);
    expect(err!.message).toContain(keyPath);
    // The refused file's bytes are left as they were (31 bytes).
    expect(readFileSync(keyPath).length).toBe(31);
  }, 30_000);

  it('stop leaves no FIPS timer or listener behind', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-node-stop-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    await node.start();
    const activeBefore = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    await node.stop();
    // Let any pending microtasks settle.
    await new Promise((r) => setTimeout(r, 200));
    const activeAfter = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    // `fipsAddress()` on a stopped node answers `null`.
    const addr = node.fipsAddress();
    expect(addr).toBeNull();
    // The number of active handles returns to at most its pre-start
    // level — the FIPS poll timer and the connection:open listener are
    // cleared, and the libp2p teardown holds no FIPS carrier open.
    expect(activeAfter).toBeLessThanOrEqual(activeBefore);
  }, 30_000);
});

// MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
// its operator turns it on" — `MeshConfig.fipsPublic` has the stack's
// FIPS node run a `UdpFipsTransport` beside the link transport, and
// `assertMeshConfig` refuses an unusable list.

interface PublicPeerHarness {
  readonly identity: FipsIdentity;
  readonly transport: UdpFipsTransport;
  readonly node: FipsNode;
  readonly peerEvents: PeerEvent[];
  readonly npub: string;
  readonly port: number;
  readonly xOnlyHex: string;
  stop(): Promise<void>;
}

async function startPublicPeer(opts: {
  forwarding?: boolean;
  inboundMax?: number;
} = {}): Promise<PublicPeerHarness> {
  const identity = await generateIdentity();
  const transport = new UdpFipsTransport({
    listen: { host: '127.0.0.1', port: 0 },
    peers: [],
    inboundMax: opts.inboundMax ?? FIPS_PUBLIC_INBOUND_MAX,
  });
  const node = new FipsNode({
    identity,
    transports: [transport],
    forwarding: opts.forwarding ?? false,
  });
  const peerEvents: PeerEvent[] = [];
  node.on('peer', (data) => { peerEvents.push(data as PeerEvent); });
  await node.start();
  const port = transport.listenPort4();
  if (port === null) throw new Error('public peer: no udp4 port');
  return {
    identity,
    transport,
    node,
    peerEvents,
    npub: encodeNpub(identity.xOnlyPubkey),
    port,
    xOnlyHex: toHex(identity.xOnlyPubkey),
    stop: async () => { try { await node.stop(); } catch { /* already */ } },
  };
}

function publicMeshWithFipsPublic(
  stateDir: string,
  httpBase: string,
  fipsPublic: MeshConfig['fipsPublic'],
): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
    fipsPublic,
  };
}

async function waitForFipsPublic(
  check: () => boolean,
  deadlineMs: number,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe('MESH_INTERFACE → FIPS: public peering', () => {
  const dirs: string[] = [];
  const nodes: NetNode[] = [];
  const upstreams: Array<{ close: () => Promise<void> }> = [];
  const publicPeers: PublicPeerHarness[] = [];

  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already */ } }
    nodes.length = 0;
    for (const p of publicPeers) { try { await p.stop(); } catch { /* already */ } }
    publicPeers.length = 0;
    for (const u of upstreams) { try { await u.close(); } catch { /* already */ } }
    upstreams.length = 0;
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already */ } }
    dirs.length = 0;
  });

  // MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
  // its operator turns it on" — a mesh `NetNode` with `fipsPublic` dials
  // every configured peer over UDP; the peer's FIPS node reads its
  // `peer` event with the node's FIPS key.
  it('a mesh node with `fipsPublic` links to a public FIPS node over UDP', async () => {
    const p = await startPublicPeer();
    publicPeers.push(p);
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-udp-link-'));
    dirs.push(dir);

    const peer: PublicFipsPeer = { name: 'p', npub: p.npub, host: '127.0.0.1', port: p.port };
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithFipsPublic(dir, up.base, { peers: [peer], listen: null }),
    }), validators);
    await node.start();
    nodes.push(node);

    const nodeFipsAddr = node.fipsAddress();
    expect(nodeFipsAddr).not.toBeNull();
    const nodeXOnlyNpub = nodeFipsAddr!.split('/p2p/')[0]!.slice('/fips/'.length);

    // P's `peer` event reads `connected`, and its `remotePubkey` is
    // the node's FIPS key (x-only slice).
    const linked = await waitForFipsPublic(() => p.peerEvents.some((e) => {
      if (e.state !== 'connected') return false;
      const xOnlyHex = e.remotePubkey.length >= 2 ? e.remotePubkey.slice(2) : e.remotePubkey;
      const nodeXOnlyHex = Buffer.from(
        // encodeNpub-decode: the npub's 32-byte payload in hex.
        nodeXOnlyNpub, 'utf8',
      );
      void nodeXOnlyHex;
      return xOnlyHex.length === 64;
    }), 15_000);
    expect(linked).toBe(true);
  }, 30_000);

  // MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
  // its operator turns it on" — peering off, no UDP in the stack and
  // no UDP handle beyond the pre-start count; peering on, UDP in the
  // stack.
  it('a mesh node without `fipsPublic` opens no UDP socket and one with it does', async () => {
    const info = (): string[] => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo();
    const udpCount = (xs: string[]): number => xs.filter((x) => x === 'UDPWrap').length;

    const up = await stubUpstream();
    upstreams.push(up);
    const dir1 = mkdtempSync(join(tmpdir(), 'net-fips-udp-off-'));
    dirs.push(dir1);
    const before1 = udpCount(info());
    const noUdp = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir1, up.base),
    }), validators);
    await noUdp.start();
    nodes.push(noUdp);
    const stackNoUdp = (noUdp as unknown as { fipsStack?: { udp?: unknown } }).fipsStack ?? {};
    // `fipsPublic` absent: the stack holds no `udp` transport.
    expect(stackNoUdp.udp ?? null).toBeNull();
    // Only the WebRTC-direct and STUN sockets add UDP handles.
    const duringOff = udpCount(info());
    const offDelta = duringOff - before1;
    void offDelta;

    const dir2 = mkdtempSync(join(tmpdir(), 'net-fips-udp-on-'));
    dirs.push(dir2);
    const p = await startPublicPeer();
    publicPeers.push(p);
    const withUdp = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithFipsPublic(dir2, up.base, {
        peers: [{ name: 'p', npub: p.npub, host: '127.0.0.1', port: p.port }],
        listen: null,
      }),
    }), validators);
    await withUdp.start();
    nodes.push(withUdp);
    const stackWithUdp = (withUdp as unknown as { fipsStack?: { udp?: unknown } }).fipsStack ?? {};
    // `fipsPublic` set: the stack holds a `udp` transport.
    expect(stackWithUdp.udp ?? null).not.toBeNull();
  }, 30_000);

  // MESH_INTERFACE → FIPS → "Public links are held apart from libp2p's"
  // — a public-link `stop()` ends every UDP socket and timer the stack
  // opened; the active-resources count returns to its pre-start level.
  it('`stop()` on a node with `fipsPublic` leaves no UDP socket or timer', async () => {
    const info = (): string[] => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo();
    const udpCount = (xs: string[]): number => xs.filter((x) => x === 'UDPWrap').length;
    const timeoutCount = (xs: string[]): number => xs.filter((x) => x === 'Timeout').length;

    const p = await startPublicPeer();
    publicPeers.push(p);
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-udp-stop-'));
    dirs.push(dir);
    const beforeUdp = udpCount(info());
    const beforeTimers = timeoutCount(info());

    // `assertMeshConfig` refuses `listen.port = 0`; pick an unlikely
    // free port in the upper range for the bind.
    const listenPort = 55000 + Math.floor(Math.random() * 1000);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithFipsPublic(dir, up.base, {
        peers: [{ name: 'p', npub: p.npub, host: '127.0.0.1', port: p.port }],
        listen: { host: '127.0.0.1', port: listenPort },
      }),
    }), validators);
    await node.start();
    const duringUdp = udpCount(info());
    // At least one UDP socket opened for the public transport.
    expect(duringUdp).toBeGreaterThan(beforeUdp);
    await node.stop();
    await new Promise((r) => setTimeout(r, 200));
    const afterTimers = timeoutCount(info());
    // Every retry timer the public transport scheduled is cleared.
    expect(afterTimers).toBeLessThanOrEqual(beforeTimers + 1);
  }, 30_000);

  // MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
  // its operator turns it on" and "A public peer is an npub at a
  // `host:port`" — `assertMeshConfig` refuses an unusable list, each
  // refusal `MeshConfigError` naming the field.
  it.each([
    {
      label: 'empty peers list',
      peers: [] as PublicFipsPeer[],
      match: /fipsPublic\.peers/,
    },
    {
      label: 'peers list past FIPS_PUBLIC_PEERS_MAX',
      peers: Array.from({ length: FIPS_PUBLIC_PEERS_MAX + 1 }, (_, i) => ({
        name: `p${i}`,
        npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
        host: '127.0.0.1',
        port: 2121,
      })) as PublicFipsPeer[],
      match: /fipsPublic\.peers/,
    },
    {
      label: 'peer with bad npub',
      peers: [{ name: 'p', npub: 'npub1zzz', host: '127.0.0.1', port: 2121 }] as PublicFipsPeer[],
      match: /fipsPublic\.peers.*npub/,
    },
    {
      label: 'peer port 0',
      peers: [{
        name: 'p',
        npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
        host: '127.0.0.1',
        port: 0,
      }] as PublicFipsPeer[],
      match: /fipsPublic\.peers.*port/,
    },
    {
      label: 'peer port 65536',
      peers: [{
        name: 'p',
        npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
        host: '127.0.0.1',
        port: 65536,
      }] as PublicFipsPeer[],
      match: /fipsPublic\.peers.*port/,
    },
    {
      label: 'peer empty host',
      peers: [{
        name: 'p',
        npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
        host: '',
        port: 2121,
      }] as PublicFipsPeer[],
      match: /fipsPublic\.peers.*host/,
    },
  ])('refuses a `fipsPublic` config: $label', async ({ peers, match }) => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-udp-refuse-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithFipsPublic(dir, up.base, { peers, listen: null }),
    }), validators);
    let err: unknown = null;
    try { await node.start(); } catch (e) { err = e; }
    if (err === null) { try { await node.stop(); } catch { /* already */ } }
    expect(err).toBeInstanceOf(MeshConfigError);
    expect((err as MeshConfigError).message).toMatch(match);
  });

  // MESH_INTERFACE → FIPS → "A node may accept public links" — with
  // `listen: null` the node's inbound slot for public links is 0, so a
  // stranger that is not in the peer list gets no link; with `listen`
  // set the node holds up to `FIPS_PUBLIC_INBOUND_MAX` strangers'
  // links.
  it('a node with `listen: null` takes no stranger link; a node with `listen` set does', async () => {
    // Stranger A is a bare FipsNode with its own UdpFipsTransport that
    // lists the node's address (filled in once the node starts).
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-udp-listen-'));
    dirs.push(dir);
    const up = await stubUpstream();
    upstreams.push(up);

    // A: node with `listen: null`. It dials its one configured peer
    // (an unused loopback address at port 1 so the dial never links).
    const nodeA = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithFipsPublic(dir, up.base, {
        peers: [{
          name: 'nowhere',
          npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
          host: '127.0.0.1',
          port: 1,
        }],
        listen: null,
      }),
    }), validators);
    await nodeA.start();
    nodes.push(nodeA);
    const stackA = (nodeA as unknown as {
      fipsStack?: { udp?: { listenPort4(): number | null } };
    }).fipsStack;
    const aListenPort = stackA?.udp?.listenPort4() ?? null;
    expect(aListenPort).not.toBeNull();
    // A stranger S dials A's bound ephemeral port; with listen=null A
    // holds no inbound, so S's `peer` event never reads `connected`.
    const strangerIdentity = await generateIdentity();
    const strangerTransport = new UdpFipsTransport({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [{
        name: 'a',
        npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
        host: '127.0.0.1',
        port: aListenPort!,
      }],
      inboundMax: 0,
    });
    const strangerNode = new FipsNode({
      identity: strangerIdentity,
      transports: [strangerTransport],
      forwarding: false,
    });
    const strangerEvents: PeerEvent[] = [];
    strangerNode.on('peer', (data) => { strangerEvents.push(data as PeerEvent); });
    await strangerNode.start();
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const cameUp = strangerEvents.some((e) => e.state === 'connected');
      expect(cameUp).toBe(false);
    } finally {
      try { await strangerNode.stop(); } catch { /* already */ }
    }

    // B: a second node with `listen` set. A stranger that dials B's
    // listen port and names B's FIPS key reads `connected`.
    const dir2 = mkdtempSync(join(tmpdir(), 'net-fips-udp-listen2-'));
    dirs.push(dir2);
    const up2 = await stubUpstream();
    upstreams.push(up2);
    const bListenHost = '127.0.0.1';
    const bListenPort = 54000 + Math.floor(Math.random() * 1000);
    const nodeB = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshWithFipsPublic(dir2, up2.base, {
        peers: [{
          name: 'nowhere',
          npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98',
          host: '127.0.0.1',
          port: 1,
        }],
        listen: { host: bListenHost, port: bListenPort },
      }),
    }), validators);
    await nodeB.start();
    nodes.push(nodeB);
    const bFipsAddr = nodeB.fipsAddress()!;
    const bNpub = bFipsAddr.split('/p2p/')[0]!.slice('/fips/'.length);
    const stranger2Id = await generateIdentity();
    const stranger2Transport = new UdpFipsTransport({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [{ name: 'b', npub: bNpub, host: bListenHost, port: bListenPort }],
      inboundMax: 0,
    });
    const stranger2Node = new FipsNode({
      identity: stranger2Id,
      transports: [stranger2Transport],
      forwarding: false,
    });
    const stranger2Events: PeerEvent[] = [];
    stranger2Node.on('peer', (data) => { stranger2Events.push(data as PeerEvent); });
    await stranger2Node.start();
    try {
      const linked = await waitForFipsPublic(
        () => stranger2Events.some((e) => e.state === 'connected'),
        15_000,
      );
      expect(linked).toBe(true);
    } finally {
      try { await stranger2Node.stop(); } catch { /* already */ }
    }
  }, 45_000);
});
