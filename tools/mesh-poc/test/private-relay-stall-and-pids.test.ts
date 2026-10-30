// MESH_INTERFACE → NAT / Acceptance — three more guards. A second
// configured relay stalls `createLibp2p`'s start under
// `@libp2p/circuit-relay-v2@4.2.17` (`transport/reservation-store.ts`
// serializes reservations through a `PeerQueue` of concurrency 1 — see
// `DEFAULT_RESERVATION_CONCURRENCY = 1` at `constants.ts:19` and
// `src/transport/reservation-store.ts:100-105` "ensure we don't listen
// on multiple relays simultaneously"; a stalled reservation holds the
// queue, and `NO_FATAL` tolerates a failed listen but not one that
// never returns — libp2p awaits every listener at start). The fix:
// start the node on its own addresses alone and add each circuit
// listen after start through the existing retry path, under its own
// deadline.
//
// Also: pids.json is written after every spawn so a `--keep-on-failure`
// run (or any crash mid-up) still names the processes `down` must end;
// and `down` falls back to `ip netns pids <ns>` per `notismesh-*`
// namespace when pids.json is missing.

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const SRC_MESH_NODE = join(PACKAGE_ROOT, 'src', 'node', 'mesh-node.ts');
const SRC_UP = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SRC_DOWN = join(PACKAGE_ROOT, 'stage', 'down.mjs');

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

describe('mesh-node.ts configures the circuit-relay reservation store for one reservation per named relay', () => {
  // `@libp2p/circuit-relay-v2@4.2.17/src/index.ts` lines 96-98
  // `maxReservations` defaults to 15, 199-207 `reservationConcurrency`
  // defaults to 1. The private role is told of each public relay by
  // id and holds a reservation on each; the transport's options have
  // to allow at least that many and allow concurrent reservation
  // attempts so a stalled attempt on one relay does not hold up the
  // others' queue slots.
  it.fails('circuitRelayTransport is called with explicit maxReservations and reservationConcurrency', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    // The call shape: `circuitRelayTransport({ ... })` with these two
    // options named.
    expect(src, 'maxReservations option is set').toMatch(/circuitRelayTransport\s*\(\s*\{[^}]*maxReservations/);
    expect(src, 'reservationConcurrency option is set').toMatch(/circuitRelayTransport\s*\(\s*\{[^}]*reservationConcurrency/);
  });
});

describe('a private mesh node starts on its own addresses alone; circuit listens are added after start', () => {
  // Separating the circuit listens from the initial `addresses.listen`
  // sidesteps the reservation-queue stall at startup: the libp2p
  // instance is up as soon as its own TCP/WebRTC-direct listens
  // succeed, and `startRelayRetry` adds each circuit listen through
  // `transportManager.listen([addr])` under its own deadline.
  it.fails('mesh-node.ts does not pass /p2p-circuit addresses to createLibp2p addresses.listen', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    // Grep the block that composes the `listen` array for
    // createLibp2p: it must FILTER OUT circuit entries from
    // `opts.listen` for the initial listen. The retry path still
    // reads them.
    expect(src, 'circuit addresses are filtered out of the initial listen').toMatch(
      /(circuitListens|filter[^)]*p2p-circuit|\.filter\s*\(\s*\([^)]+\)\s*=>\s*![^)]*p2p-circuit)/,
    );
  });
});

describe('a private node reserves on a working relay even when another relay never answers the reservation', () => {
  let stateDirs: string[] = [];
  let privateNode: MeshNode | null = null;
  const toStop: Libp2p[] = [];

  afterEach(async () => {
    if (privateNode) { await privateNode.stop(); privateNode = null; }
    for (const n of toStop) {
      try { await n.stop(); } catch { /* already stopped */ }
    }
    toStop.length = 0;
    for (const d of stateDirs) rmSync(d, { recursive: true, force: true });
    stateDirs = [];
  });

  function mkStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-stall-'));
    stateDirs.push(dir);
    return dir;
  }

  it.fails('starts at once, prints its identity (returns from startMeshNode), and reserves on the working relay', async () => {
    // Working relay: libp2p + circuitRelayServer, speaks HOP.
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

    // Stall relay: libp2p WITHOUT circuitRelayServer, so a HOP stream
    // request is refused by multistream-select — the reservation
    // attempt returns UnsupportedProtocolError. The behaviour
    // libp2p 3.5 shows on the real stage (two configured relays, a
    // stuck second reservation) is more subtle, but either way the
    // guarantee is: the WORKING relay's reservation lands and the
    // node is up without waiting on the stall.
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

    const circuitWorking = `/ip4/127.0.0.1/tcp/${workingPort}/p2p/${workingPeer.toString()}/p2p-circuit`;
    const circuitStall = `/ip4/127.0.0.1/tcp/${stallPort}/p2p/${stallPeer.toString()}/p2p-circuit`;

    const privateStateDir = mkStateDir();
    // `startMeshNode` must return at once — if the stall relay held
    // up start, this await would never resolve.
    const started = Date.now();
    privateNode = await startMeshNode({
      key: nodeKeyFromKeyPair(generateKeyPair()),
      network: 'devnet',
      role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0', circuitWorking, circuitStall],
      bootstrap: [],
      stateDir: privateStateDir,
      upstream: 'http://127.0.0.1:1',
      relayRetryBaseMs: 50,
      relayRetryCapMs: 200,
    });
    const startMs = Date.now() - started;
    expect(startMs, `startMeshNode returned within 10 s (was ${startMs} ms)`).toBeLessThan(10_000);

    // Poll the private node's multiaddrs for the working relay's
    // reservation. The stall relay's never lands.
    const deadline = Date.now() + 10_000;
    let workingReserved = false;
    while (Date.now() < deadline) {
      const mas = privateNode.multiaddrs();
      if (mas.some((m) => m.includes('/p2p-circuit') && m.includes(workingPeer.toString()))) {
        workingReserved = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(workingReserved, `working relay's /p2p-circuit present (multiaddrs = ${privateNode.multiaddrs().join(', ')})`).toBe(true);
  }, 20_000);
});

describe('pids.json is written after every spawn (not just at the end of up)', () => {
  // A `--keep-on-failure` run or a mid-`up` crash leaves pids.json
  // empty unless `up` writes it incrementally. `down` without a
  // pids.json has to find processes a different way — the ns-pids
  // fallback below — but incrementally writing cuts that fallback's
  // reach to the stray-process case alone.
  it.fails('up.mjs wires a pids.json writer that runs after each spawn', () => {
    const src = readFileSync(SRC_UP, 'utf8');
    // The hook on `log.spawn` writes pids.json beside appending the
    // pid entry; the writer is called inside the overridden spawn
    // (grep by the pids file name near the override region).
    const spawnOverrideIdx = src.indexOf('log.spawn = ');
    expect(spawnOverrideIdx, 'log.spawn override present').toBeGreaterThan(0);
    const after = src.slice(spawnOverrideIdx, spawnOverrideIdx + 2000);
    expect(after, 'the override writes pids.json').toMatch(/writePidsJson\(|writeFileSync\([^)]*pids\.json/);
  });
});

describe('down falls back to ip netns pids per namespace when pids.json is missing', () => {
  // Fallback flow: for each `notismesh-*` namespace, run
  // `sudo ip netns pids <ns>` to list the processes inside it,
  // SIGTERM each, wait, SIGKILL remnants, then delete the namespace.
  it.fails('down.mjs calls sudo ip netns pids <ns> in the fallback path', () => {
    const src = readFileSync(SRC_DOWN, 'utf8');
    expect(src, 'the fallback runs `ip netns pids`').toMatch(/ip['"],\s*['"]netns['"],\s*['"]pids/);
  });
});
