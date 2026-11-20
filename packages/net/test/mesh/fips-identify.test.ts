// MESH_INTERFACE → libp2p is pinned → "its address manager passes
// over an address that names no IP" — the libp2p patch keeps identify
// from throwing on an observed FIPS address: `addObservedAddr` returns
// before `getNetConfig` when the address names no IP, so identify
// completes on both ends of a FIPS connection. `DNSMappings.has` and
// `IPMappings.has` return `false` on the same, so a reservation
// teardown that unmaps a relayed FIPS address raises no uncaught
// exception.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p, Connection } from '@libp2p/interface';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
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

import { NetNode, createReaderFips } from '../../src/index.js';
import type { NetValidators, MeshConfig, FipsStack } from '../../src/index.js';
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
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
  };
}

function privateMeshOn(stateDir: string, httpBase: string): MeshConfig {
  return {
    role: 'private',
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
    relayRetryBaseMs: 50,
    relayRetryCapMs: 500,
  } as MeshConfig;
}

async function firstTcpAddr(libp2p: Libp2p, deadlineMs: number): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const a = libp2p.getMultiaddrs().map((m) => m.toString())
      .find((s) => /\/tcp\/\d+\/p2p\//.test(s) && !s.includes('/fips/') && !s.includes('/webrtc'));
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('MESH_INTERFACE → libp2p is pinned → "its address manager passes over an address that names no IP"', () => {
  const nodes: NetNode[] = [];
  const stacks: FipsStack[] = [];
  const hosts: Libp2p[] = [];
  const upstreams: Array<{ close: () => Promise<void> }> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.stop(); } catch { /* already */ } }
    for (const s of stacks) { try { await s.stop(); } catch { /* already */ } }
    for (const n of nodes) { try { await n.stop(); } catch { /* already */ } }
    for (const up of upstreams) { try { await up.close(); } catch { /* already */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already */ } }
    hosts.length = 0; stacks.length = 0; nodes.length = 0; upstreams.length = 0; dirs.length = 0;
  });

  it('identify completes on both ends of a FIPS connection', async () => {
    const up = await stubUpstream();
    upstreams.push(up);
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-identify-'));
    dirs.push(dir);

    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: publicMeshOn(dir, up.base),
    }), validators);
    await node.start();
    nodes.push(node);

    const nodeLibp2p = (node as unknown as { libp2p: Libp2p }).libp2p;

    // The reader runs its own FIPS stack and dials the node's FIPS
    // address: the connection is FIPS-first, so identify's observed
    // address exchange runs over a `/fips/<npub>/p2p/<peerId>` that
    // the patched address manager passes over.
    const stack = await createReaderFips({ network: 'testnet' });
    stacks.push(stack);
    const reader = await createLibp2p({
      addresses: { listen: [] },
      transports: [tcp(), stack.transport],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    hosts.push(reader);
    await stack.attach(reader);

    // Count `peer:identify` events per end, keyed by the connection
    // the event names: identify's per-connection event fires only
    // when `maybeAddObservedAddress` does not throw.
    const readerFipsIdentifies = new Set<string>();
    const nodeFipsIdentifies = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reader.addEventListener('peer:identify', (evt: any) => {
      const conn = evt?.detail?.connection as Connection | undefined;
      if (conn !== undefined && conn.remoteAddr.toString().includes('/fips/')) {
        readerFipsIdentifies.add(conn.id);
      }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeLibp2p.addEventListener('peer:identify', (evt: any) => {
      const conn = evt?.detail?.connection as Connection | undefined;
      if (conn !== undefined && conn.remoteAddr.toString().includes('/fips/')) {
        nodeFipsIdentifies.add(conn.id);
      }
    });

    const nodeFipsAddr = node.fipsAddress();
    expect(nodeFipsAddr).not.toBeNull();

    // First the reader connects to the node over TCP so FIPS can
    // link (the mesh node's FIPS transport dials no peer, so the
    // reader opens the link from its side).
    const nodeTcp = await firstTcpAddr(nodeLibp2p, 10_000);
    expect(nodeTcp).not.toBeNull();
    const connTcp = await reader.dial(multiaddr(nodeTcp!));
    await stack.link.openLink(connTcp);
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      if (stack.link.linkedKeys().length >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stack.link.linkedKeys().length).toBeGreaterThanOrEqual(1);

    // Dial the node's FIPS address with `force: true` so libp2p does
    // not answer the connection it already holds; the result is a
    // FIPS-first connection on which identify runs.
    const connFips = await reader.dial(
      multiaddr(nodeFipsAddr!),
      { force: true, signal: AbortSignal.timeout(15_000) } as unknown as never,
    ) as Connection;
    expect(connFips.remoteAddr.toString()).toContain('/fips/');

    // identify fires `peer:identify` once per connection after
    // `consumeIdentifyMessage` runs — which it reaches only when
    // `maybeAddObservedAddress` does not throw. Both ends dispatch
    // the event for their FIPS connection within the wait.
    const t1 = Date.now();
    while (Date.now() - t1 < 15_000) {
      if (readerFipsIdentifies.size >= 1 && nodeFipsIdentifies.size >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readerFipsIdentifies.size).toBeGreaterThanOrEqual(1);
    expect(nodeFipsIdentifies.size).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it.fails('a relay announcing a FIPS address leaves with no uncaught exception', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error): void => { uncaught.push(err); };
    const onUnhandled = (reason: unknown): void => {
      uncaught.push(reason instanceof Error ? reason : new Error(String(reason)));
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    try {
      const up = await stubUpstream();
      upstreams.push(up);
      const relayDir = mkdtempSync(join(tmpdir(), 'net-fips-relay-'));
      dirs.push(relayDir);
      const privDir = mkdtempSync(join(tmpdir(), 'net-fips-priv-'));
      dirs.push(privDir);

      const relay = new NetNode(makeConfig({
        nodeKey: generateKeyPair(),
        listenAddrs: '/ip4/127.0.0.1/tcp/0',
        mesh: publicMeshOn(relayDir, up.base),
      }), validators);
      await relay.start();
      const relayLibp2p = (relay as unknown as { libp2p: Libp2p }).libp2p;
      const relayAddr = await firstTcpAddr(relayLibp2p, 10_000);
      expect(relayAddr).not.toBeNull();

      const priv = new NetNode(makeConfig({
        nodeKey: generateKeyPair(),
        listenAddrs: '/ip4/127.0.0.1/tcp/0',
        bootstrapPeers: [relayAddr!],
        mesh: privateMeshOn(privDir, up.base),
      }), validators);
      await priv.start();
      nodes.push(priv);

      // Wait for the private node's reservation to form on the relay —
      // a `/p2p-circuit` entry in its announced set means the
      // `/fips/<relay-npub>/.../p2p-circuit/p2p/<self>` composite exists
      // as an observed address and will reach `removeObservedAddr` at
      // the relay's teardown.
      const privLibp2p = (priv as unknown as { libp2p: Libp2p }).libp2p;
      const t0 = Date.now();
      let reserved = false;
      while (Date.now() - t0 < 20_000) {
        const mas = privLibp2p.getMultiaddrs().map((a) => a.toString());
        if (mas.some((m) => m.includes('/p2p-circuit'))) { reserved = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(reserved).toBe(true);

      // Relay goes away: circuit-relay-v2's `_onRemoveRelayPeer` fires
      // `addressManager.removeObservedAddr` on each relayed listener
      // address, the FIPS-bearing one among them. Without the patch
      // the throw escapes as an uncaught exception.
      await relay.stop();
      // Let the teardown's event listeners run.
      await new Promise((r) => setTimeout(r, 500));

      // The private node is still running.
      const privStillUp = (priv as unknown as { started: boolean }).started;
      expect(privStillUp).toBe(true);
      expect(uncaught.map((e) => e.message)).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }
  }, 60_000);
});
