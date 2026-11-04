// MESH_INTERFACE → NAT — a private node takes a relay reservation on
// each public node it is told of and is reached through them. libp2p
// 3.5's circuit-relay listener keys off the listen multiaddr's shape
// (`@libp2p/circuit-relay-v2/src/transport/listener.ts` listen):
// `CircuitSearch` (a bare `/p2p-circuit`) triggers RelayDiscovery (DHT
// walk / discovery topology / peer-store scan) with variable timing;
// `CircuitListen` (`/ip4/<relay>/tcp/<port>/p2p/<relay-peer>/p2p-circuit`)
// opens a direct connection to the named relay and reserves on it.
// Private mesh nodes listen with the specific form, one per public
// relay they bootstrap from, so the reservation is deterministic.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readTopology, publicMeshHosts } from '../stage/lib/topology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const TOPOLOGY_PATH = join(PACKAGE_ROOT, 'stage', 'topology.json');
const UP_SCRIPT = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SRC_MESH_NODE = join(PACKAGE_ROOT, 'src', 'node', 'mesh-node.ts');

describe('a private mesh node listens on a /p2p-circuit per public relay it bootstraps from', () => {
  const topology = readTopology(TOPOLOGY_PATH);
  const publics = publicMeshHosts(topology);
  // Private hosts are those with mesh.role === 'private'.
  const privateHosts: Array<{ name: string; host: Record<string, unknown> }> = [];
  for (const [name, host] of Object.entries(topology.hosts) as Array<[string, Record<string, unknown>]>) {
    const mesh = host['mesh'] as Record<string, unknown> | undefined;
    if (mesh?.['role'] === 'private') privateHosts.push({ name, host });
  }

  it('the topology has at least one private mesh host (sanity)', () => {
    expect(privateHosts.length, 'at least one private host').toBeGreaterThan(0);
    expect(publics.length, 'at least one public host').toBeGreaterThan(0);
  });

  // MESH_INTERFACE → NAT — with one node per host, a private node's
  // MESH_LISTEN names its own IP + concrete ports; its circuit listens
  // are derived by `net` from the connection it holds to each seed, so
  // `BOOTSTRAP_PEERS` carries each public with its `/p2p/<peerId>`
  // trailer. The case reads the private host's notis spawn: its
  // MESH_LISTEN names the private's own IP + concrete ports, and its
  // BOOTSTRAP_PEERS names each public with a `/p2p/<peerId>` tail.
  for (const priv of privateHosts) {
    it(`${priv.name}'s notis spawn names its own listens and seeds each public by peer id`, () => {
      const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
        encoding: 'utf8', timeout: 30_000,
      });
      expect(res.status, `exit (stderr: ${res.stderr})`).toBe(0);
      const line = res.stdout.split('\n').find((l) => l.startsWith(`[spawn:notis:${priv.name}]`));
      expect(line, `[spawn:notis:${priv.name}] in dry-run`).toBeDefined();
      const listenM = /MESH_LISTEN=([^\s]+)/.exec(line!);
      expect(listenM, `MESH_LISTEN set on ${priv.name}`).not.toBeNull();
      const listenParts = listenM![1]!.split(',');
      const addr = priv.host['addr'] as string;
      expect(listenParts.some((p) => p === `/ip4/${addr}/udp/4001/webrtc-direct`),
        `${priv.name}: webrtc-direct listen on own IP`).toBe(true);
      expect(listenParts.some((p) => p === `/ip4/${addr}/tcp/4002`),
        `${priv.name}: tcp listen on own IP`).toBe(true);
      // No circuit listens in MESH_LISTEN — they are derived from seeds.
      expect(listenParts.some((p) => p.includes('/p2p-circuit')),
        `${priv.name}: MESH_LISTEN carries no /p2p-circuit (derived from seeds)`).toBe(false);
      const bootM = /BOOTSTRAP_PEERS=([^\s]+)/.exec(line!);
      expect(bootM, `BOOTSTRAP_PEERS set on ${priv.name}`).not.toBeNull();
      const seeds = bootM![1]!.split(',');
      for (const { name: pubName, host: pubHost } of publics) {
        const pubAddr = (pubHost as { addr: string }).addr;
        const pubP2p = ((pubHost as { node: { p2pPort: number } }).node.p2pPort);
        const prefix = `/ip4/${pubAddr}/tcp/${pubP2p}/p2p/`;
        const seed = seeds.find((s) => s.startsWith(prefix));
        expect(seed, `${priv.name}: a seed naming ${pubName} by peer id`).toBeDefined();
        const idSection = seed!.slice(prefix.length);
        expect(idSection.length, `${priv.name}: ${pubName}'s peer id present in the seed`).toBeGreaterThan(0);
      }
    }, 30_000);
  }
});

describe('mesh-node.ts does not auto-append a bare /p2p-circuit for private role', () => {
  // The caller (`up.mjs`) supplies specific `/ip4/<relay>/tcp/.../p2p-circuit`
  // listen addresses per public relay. The auto-append in
  // `startMeshNode` (previously `if (role === 'private') listen.push('/p2p-circuit')`)
  // would re-introduce the non-deterministic discovery path, so it must
  // be gone.
  it('src/node/mesh-node.ts has no listen.push(\'/p2p-circuit\')', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(src, 'mesh-node.ts does not auto-push /p2p-circuit').not.toMatch(/listen\.push\(\s*['"]\/p2p-circuit['"]/);
  });
});
