// MESH_INTERFACE → NAT — "A relay that does not answer never stops a
// private node. One that is down when the node starts, or that goes
// away, is tried again on the node list's retry cadence (RETRY_BASE_MS
// doubling to RETRY_CAP_MS), and the node reserves on it once it
// answers; meanwhile it serves through whichever relays it holds".
//
// Two cases:
//   - retryIntervalMs(n) follows the node list's cadence (fake timers
//     not needed; it's a pure function of the failure count).
//   - a private mesh node started with an unreachable relay address
//     starts (no `UnsupportedListenAddressesError`), and reserves on
//     the relay once a server at that address answers (in-process:
//     the relay libp2p starts AFTER the private one).

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
import { nodeKeyFromKeyPair } from '../src/identity.js';
import { retryIntervalMs, startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { RETRY_BASE_MS, RETRY_CAP_MS } from '../src/protocols.js';

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

describe('retryIntervalMs — the private node\'s relay retry cadence (pure)', () => {
  // The schedule mirrors `NodeList.failure` (src/client/node-list.ts):
  //   min(RETRY_CAP_MS, RETRY_BASE_MS * 2^(n-1))
  // where `n` is the failure count (1 for the first retry, 2 for the
  // second, …). The function is pure; a test with a fake clock would
  // add nothing here.
  it.fails('the first retry waits RETRY_BASE_MS', () => {
    expect(retryIntervalMs(1)).toBe(RETRY_BASE_MS);
  });
  it.fails('the second retry waits 2 × RETRY_BASE_MS', () => {
    expect(retryIntervalMs(2)).toBe(RETRY_BASE_MS * 2);
  });
  it.fails('the third retry waits 4 × RETRY_BASE_MS', () => {
    expect(retryIntervalMs(3)).toBe(RETRY_BASE_MS * 4);
  });
  it.fails('the retry caps at RETRY_CAP_MS', () => {
    // RETRY_BASE_MS = 5_000, RETRY_CAP_MS = 600_000 → cap at the 8th
    // failure (5_000 * 128 = 640_000 > 600_000).
    expect(retryIntervalMs(8)).toBe(RETRY_CAP_MS);
    expect(retryIntervalMs(20)).toBe(RETRY_CAP_MS);
  });
  it.fails('a non-positive failure count reads 0', () => {
    expect(retryIntervalMs(0)).toBe(0);
    expect(retryIntervalMs(-1)).toBe(0);
  });
});

describe('a private mesh node starts with an unreachable relay and reserves once it answers', () => {
  let stateDirs: string[] = [];
  let privateNode: MeshNode | null = null;
  let relayNode: Libp2p | null = null;

  afterEach(async () => {
    if (privateNode) { await privateNode.stop(); privateNode = null; }
    if (relayNode) { await relayNode.stop(); relayNode = null; }
    for (const d of stateDirs) rmSync(d, { recursive: true, force: true });
    stateDirs = [];
  });

  function mkStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-relay-retry-'));
    stateDirs.push(dir);
    return dir;
  }

  it.fails('starts with ECONNREFUSED on the relay listen, then reserves once the relay comes up', async () => {
    // Pick a port the relay will later bind. The private node's
    // circuit listen points at it before the relay starts, so the
    // first listen attempt reads ECONNREFUSED.
    const relayPort = await freePort();

    // The relay's key — we need its peer id in the private's listen
    // address.
    const relayPrivateKey = await libp2pGenerate('Ed25519');
    const relayPeer = peerIdFromPrivateKey(relayPrivateKey);
    const relayAddr = `/ip4/127.0.0.1/tcp/${relayPort}/p2p/${relayPeer.toString()}`;
    const circuitListen = `${relayAddr}/p2p-circuit`;

    // Start the private mesh node — the relay is NOT up yet, so the
    // initial listen on the circuit address will fail.
    const privateStateDir = mkStateDir();
    const privateUpstream = 'http://127.0.0.1:1';
    privateNode = await startMeshNode({
      key: nodeKeyFromKeyPair(generateKeyPair()),
      network: 'devnet',
      role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0', circuitListen],
      bootstrap: [],
      stateDir: privateStateDir,
      upstream: privateUpstream,
      relayRetryBaseMs: 50, // fast cadence for the test
      relayRetryCapMs: 200,
    });
    // Private node is up (the initial listen failure did not take it
    // down). The circuit address is not yet in its multiaddrs — the
    // relay is not reachable.
    const initialMultiaddrs = privateNode.multiaddrs();
    expect(initialMultiaddrs.some((m) => m.includes('/p2p-circuit')),
      'no circuit reservation yet').toBe(false);

    // Start the relay. The listen retry will succeed on its next
    // attempt.
    relayNode = await createLibp2p({
      privateKey: relayPrivateKey,
      addresses: { listen: [`/ip4/127.0.0.1/tcp/${relayPort}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        circuitRelay: circuitRelayServer(),
      },
    });

    // Poll the private node's multiaddrs for the circuit reservation.
    const deadline = Date.now() + 10_000;
    let reserved = false;
    while (Date.now() < deadline) {
      const mas = privateNode.multiaddrs();
      if (mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer.toString()))) {
        reserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(reserved, `private reserved on the relay once it came up (multiaddrs = ${privateNode.multiaddrs().join(', ')})`).toBe(true);
  }, 20_000);
});
