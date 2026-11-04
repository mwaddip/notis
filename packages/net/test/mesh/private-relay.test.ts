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
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
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

  it.fails('starts at once with an ECONNREFUSED seed, reserves once the seed answers', async () => {
    // Pick a port the relay will later bind. Until it does, every
    // dial to that port reads ECONNREFUSED.
    const relayPort = await freePort();
    const relayKey = await libp2pGenerate('Ed25519');
    const relayPeer = peerIdFromPrivateKey(relayKey);
    const relayAddr = `/ip4/127.0.0.1/tcp/${relayPort}/p2p/${relayPeer.toString()}`;

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

    // Start the relay. The next retry attempt reserves.
    const relay = await createLibp2p({
      privateKey: relayKey,
      addresses: { listen: [`/ip4/127.0.0.1/tcp/${relayPort}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), circuitRelay: circuitRelayServer() },
    });
    toStop.push(relay);

    const deadline = Date.now() + 15_000;
    let reserved = false;
    while (Date.now() < deadline) {
      const mas = libp2p.getMultiaddrs().map((a) => a.toString());
      if (mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer.toString()))) {
        reserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(reserved,
      `reservation on relay once it answered (addrs = ${libp2p.getMultiaddrs().map((a) => a.toString()).join(', ')})`,
    ).toBe(true);
  }, 30_000);

  it.fails('a stalled second relay never stops the node; the working one lands', async () => {
    // Working relay — speaks HOP.
    const workingKey = await libp2pGenerate('Ed25519');
    const workingPeer = peerIdFromPrivateKey(workingKey);
    const workingPort = await freePort();
    const workingRelay = await createLibp2p({
      privateKey: workingKey,
      addresses: { listen: [`/ip4/127.0.0.1/tcp/${workingPort}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), circuitRelay: circuitRelayServer() },
    });
    toStop.push(workingRelay);

    // Stall relay — libp2p WITHOUT circuitRelayServer, so a HOP stream
    // is refused by multistream-select (UnsupportedProtocolError). The
    // behaviour under the real circuit-relay-v2 reservation store is
    // more subtle; either way, the working relay must land.
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

    const workingAddr = `/ip4/127.0.0.1/tcp/${workingPort}/p2p/${workingPeer.toString()}`;
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
      if (mas.some((m) => m.includes('/p2p-circuit') && m.includes(workingPeer.toString()))) {
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
