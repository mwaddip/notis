// NET_INTERFACE → The mesh — a private `NetNode`'s relay reservations
// follow the retry cadence `MESH_INTERFACE → NAT` names:
// `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n−1))`. A relay that answers
// with ECONNREFUSED at first is reserved on once it comes up; a second
// configured relay that refuses HOP never stops the node — the working
// one's reservation still lands and `start` returns at once.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { generateKeyPair as libp2pGenerate } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
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
import { retryIntervalMs } from '../../src/mesh/relay-retry.js';
import { RETRY_BASE_MS, RETRY_CAP_MS } from '../../src/browser.js';
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

async function waitFor<T>(fn: () => T | null | undefined, ms: number, label: string): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${ms} ms: ${label}`);
}

function privateMeshOn(stateDir: string): MeshConfig {
  return {
    role: 'private',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
    // Faster retries so tests run in reasonable time.
    relayRetryBaseMs: 50,
    relayRetryCapMs: 500,
  } as MeshConfig;
}

function publicMeshOn(stateDir: string): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:1',
    stun: null,
  };
}

describe('retryIntervalMs — the private node\'s relay retry cadence (pure)', () => {
  // The schedule mirrors the client's node-list retry
  // (`MESH_INTERFACE → The client's node list → "Retry"`):
  // `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n−1))`.
  it('the first retry waits RETRY_BASE_MS', () => {
    expect(retryIntervalMs(1)).toBe(RETRY_BASE_MS);
  });
  it('the second retry waits 2 × RETRY_BASE_MS', () => {
    expect(retryIntervalMs(2)).toBe(RETRY_BASE_MS * 2);
  });
  it('the third retry waits 4 × RETRY_BASE_MS', () => {
    expect(retryIntervalMs(3)).toBe(RETRY_BASE_MS * 4);
  });
  it('the retry caps at RETRY_CAP_MS', () => {
    // RETRY_BASE_MS = 5_000, RETRY_CAP_MS = 600_000 → cap at the 8th
    // failure (5_000 * 128 = 640_000 > 600_000).
    expect(retryIntervalMs(8)).toBe(RETRY_CAP_MS);
    expect(retryIntervalMs(20)).toBe(RETRY_CAP_MS);
  });
  it('a non-positive failure count reads 0', () => {
    expect(retryIntervalMs(0)).toBe(0);
    expect(retryIntervalMs(-1)).toBe(0);
  });
});

describe('a private NetNode with an unreachable seed starts, then reserves once the seed comes up', () => {
  let nodes: NetNode[] = [];
  let toStop: Libp2p[] = [];
  let dirs: string[] = [];

  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const r of toStop) { try { await r.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; toStop = []; dirs = [];
  });

  it('starts at once with an ECONNREFUSED seed, reserves once the seed answers', async () => {
    // Pick a port the relay will later bind. Until it does, every
    // dial to that port reads ECONNREFUSED.
    const relayPort = await freePort();
    const relayKey = generateKeyPair();
    // The relay's peer id is derived from `relayKey`; the private node
    // only needs the bootstrap address (bare host:port works, net
    // resolves the peer id on dial).
    const relayAddr = `/ip4/127.0.0.1/tcp/${relayPort}`;

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-econn-'));
    dirs.push(dir);
    const started = Date.now();
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [relayAddr],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    const startMs = Date.now() - started;
    nodes.push(node);
    expect(startMs, `start returned within 15 s (was ${startMs} ms)`).toBeLessThan(15_000);

    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    // No reservation yet — the relay is not up.
    const initial = libp2p.getMultiaddrs().map((a) => a.toString());
    expect(initial.some((m) => m.includes('/p2p-circuit')),
      `no circuit yet, addrs = ${initial.join(', ')}`).toBe(false);

    // Start the relay as a public mesh NetNode on the pre-picked port.
    // NET_INTERFACE → Handshake →
    // "Every connection this node dialled carries its handshake, whoever within the node dialled it":
    // the relay is a chain-serving NetNode so the funnel's handshake
    // completes and the reservation rides the floor TCP connection.
    const relayDir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-econn-relay-'));
    dirs.push(relayDir);
    const relay = new NetNode(makeConfig({
      nodeKey: relayKey,
      listenAddrs: `/ip4/127.0.0.1/tcp/${relayPort}`,
      bootstrapPeers: [],
      mesh: publicMeshOn(relayDir),
    }), validators);
    await relay.start();
    nodes.push(relay);
    const relayPeer = (relay as unknown as { libp2p: Libp2p }).libp2p.peerId.toString();

    const deadline = Date.now() + 15_000;
    let reserved = false;
    while (Date.now() < deadline) {
      const mas = libp2p.getMultiaddrs().map((a) => a.toString());
      if (mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer))) {
        reserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(reserved,
      `reservation on relay once it answered (addrs = ${libp2p.getMultiaddrs().map((a) => a.toString()).join(', ')})`,
    ).toBe(true);
  }, 30_000);

  it('a stalled second relay never stops the node; the working one lands', async () => {
    // Working relay — a public mesh NetNode, speaks the handshake and HOP.
    const workingDir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-stall-working-'));
    dirs.push(workingDir);
    const workingRelay = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      mesh: publicMeshOn(workingDir),
    }), validators);
    await workingRelay.start();
    nodes.push(workingRelay);
    const workingLibp2p = (workingRelay as unknown as { libp2p: Libp2p }).libp2p;
    const workingPeer = workingLibp2p.peerId.toString();
    const workingAddr = await waitFor(
      () => workingLibp2p.getMultiaddrs().map((a) => a.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s)),
      5_000,
      "working relay's TCP multiaddr",
    );

    // Stall relay — a plain libp2p host without `/dagsocial/handshake/1`
    // and without `circuitRelayServer`. The TCP + Noise upgrade completes;
    // the private node's funnel handshake stream fails multistream (the
    // protocol is not supported), and the admission closes the connection
    // (NET_INTERFACE → Handshake → "A handshake that does not complete
    // ends its connection"). start() returns at once, and the working
    // relay's reservation still lands.
    const stallKey = await libp2pGenerate('Ed25519');
    const stallPeer = peerIdFromPrivateKey(stallKey);
    const stallPort = await freePort();
    const stallRelay = await createLibp2p({
      privateKey: stallKey,
      addresses: { listen: [`/ip4/127.0.0.1/tcp/${stallPort}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    toStop.push(stallRelay);
    const stallAddr = `/ip4/127.0.0.1/tcp/${stallPort}/p2p/${stallPeer.toString()}`;

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-stall-'));
    dirs.push(dir);
    const started = Date.now();
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [workingAddr, stallAddr],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    const startMs = Date.now() - started;
    nodes.push(node);
    expect(startMs, `start returned within 15 s (was ${startMs} ms)`).toBeLessThan(15_000);

    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    const deadline = Date.now() + 15_000;
    let workingReserved = false;
    while (Date.now() < deadline) {
      const mas = libp2p.getMultiaddrs().map((a) => a.toString());
      if (mas.some((m) => m.includes('/p2p-circuit') && m.includes(workingPeer))) {
        workingReserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(workingReserved,
      `working relay's circuit present (addrs = ${libp2p.getMultiaddrs().map((a) => a.toString()).join(', ')})`,
    ).toBe(true);
  }, 30_000);
});

// NET_INTERFACE → Handshake →
// "Every connection this node dialled carries its handshake, whoever within the node dialled it":
// the stage's churn before the fix — a second TCP connection to the relay,
// opened by libp2p outside the funnel (a relay reservation retry, a DHT
// query, an AutoNAT dial-back), carried no handshake and died at the
// deadline, taking the reservation riding it with it. The fix runs the
// outbound handshake on every such connection; its reservation then holds
// past two deadlines.

describe('a private NetNode\'s service-opened connection to the relay stands past two deadlines', () => {
  let nodes: NetNode[] = [];
  let dirs: string[] = [];

  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; dirs = [];
  });

  it('a second TCP connection libp2p opens to the relay handshakes and outlives two deadlines', async () => {
    // A short `syncRequestTimeoutMs` makes two deadlines fit in the test
    // (`HANDSHAKE_DEADLINE_FACTOR` × 1 000 ms = 3 s per deadline, so two
    // deadlines in 6 s and the suite still inside its 30 s timeout).
    const relayDir = mkdtempSync(join(tmpdir(), 'net-mesh-service-dial-relay-'));
    dirs.push(relayDir);
    const relay = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      syncRequestTimeoutMs: 1_000,
      mesh: publicMeshOn(relayDir),
    }), validators);
    await relay.start();
    nodes.push(relay);
    const relayLibp2p = (relay as unknown as { libp2p: Libp2p }).libp2p;
    const relayPeerId = relayLibp2p.peerId.toString();
    const relayAddr = await waitFor(
      () => relayLibp2p.getMultiaddrs().map((a) => a.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s)),
      5_000,
      "relay's TCP multiaddr with /p2p/",
    );

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-service-dial-priv-'));
    dirs.push(dir);
    // The private node starts with no bootstrap peers, so the funnel
    // never dials the relay. The only path from the private node to the
    // relay is the direct libp2p dial below — a service dial, the shape
    // of a relay reservation retry's own `transportManager.listen`.
    const priv = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      syncRequestTimeoutMs: 1_000,
      mesh: privateMeshOn(dir),
    }), validators);
    await priv.start();
    nodes.push(priv);
    const privLibp2p = (priv as unknown as { libp2p: Libp2p }).libp2p;

    // Service dial — directly through libp2p, bypassing the funnel. Open
    // hook runs the outbound handshake on the resulting connection.
    const { multiaddr: toMultiaddr } = await import('@multiformats/multiaddr');
    await privLibp2p.dial(toMultiaddr(relayAddr));

    // The handshake completes under the deadline: the relay lists the
    // private node Active.
    await waitFor(
      () => (relay.getConnectedPeers().includes(privLibp2p.peerId.toString()) ? true : null),
      5_000,
      'handshake completes — relay lists private Active',
    );

    // Wait past two handshake deadlines (2 × 3 × syncRequestTimeoutMs =
    // 6 s). The deadline closes only a connection whose handshake truly
    // failed, so the TCP connection the service dial opened stands.
    await new Promise((r) => setTimeout(r, 7_000));
    const stillConnected = privLibp2p.getConnections()
      .filter((c) => c.remotePeer.toString() === relayPeerId);
    expect(stillConnected.length,
      `connection to relay after two deadlines`).toBeGreaterThan(0);
    expect(relay.getConnectedPeers()).toContain(privLibp2p.peerId.toString());
  }, 30_000);
});
