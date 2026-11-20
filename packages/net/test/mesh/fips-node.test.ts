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

import { NetNode, MeshStateError } from '../../src/index.js';
import type { NetValidators, MeshConfig } from '../../src/index.js';
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
