// MESH_INTERFACE → NAT — "A private node ... takes relay reservations
// on public nodes and is reached through them". libp2p 3.5's
// circuit-relay listener keys off the listen multiaddr's shape
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

  // Dry-run runs stage up without the stage. Each private node's
  // MESH_LISTEN names the private's own IP + concrete ports PLUS one
  // `/ip4/<pub-addr>/tcp/<pub-tcpPort>/p2p/<pub-peerid>/p2p-circuit`
  // per public relay. Dry-run peer ids are deterministic ephemerals
  // the stage prints inline (`notisIds` map); the case asserts the
  // CIRCUIT SHAPE and the per-public coverage, not the particular id.
  for (const priv of privateHosts) {
    it.fails(`${priv.name}'s MESH_LISTEN names a /p2p-circuit through each public relay by id`, () => {
      const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
        encoding: 'utf8', timeout: 30_000,
      });
      expect(res.status, `exit (stderr: ${res.stderr})`).toBe(0);
      const line = res.stdout.split('\n').find((l) => l.startsWith(`[spawn:mesh:${priv.name}]`));
      expect(line, `[spawn:mesh:${priv.name}] in dry-run`).toBeDefined();
      const m = /MESH_LISTEN=([^\s]+)/.exec(line!);
      expect(m, `MESH_LISTEN set on ${priv.name}`).not.toBeNull();
      const value = m![1]!;
      const parts = value.split(',');
      // Private's own IP + concrete ports stay (previous finding).
      const addr = priv.host['addr'] as string;
      expect(parts.some((p) => p === `/ip4/${addr}/udp/4001/webrtc-direct`),
        `${priv.name}: webrtc-direct listen on own IP`).toBe(true);
      expect(parts.some((p) => p === `/ip4/${addr}/tcp/4002`),
        `${priv.name}: tcp listen on own IP`).toBe(true);
      // One circuit listen per public relay — specific form, not bare.
      for (const { name: pubName, host: pubHost } of publics) {
        const pubAddr = (pubHost as { addr: string }).addr;
        const pubTcp = ((pubHost as { mesh: { tcpPort: number } }).mesh.tcpPort);
        const circuitPrefix = `/ip4/${pubAddr}/tcp/${pubTcp}/p2p/`;
        const circuit = parts.find((p) => p.startsWith(circuitPrefix) && p.endsWith('/p2p-circuit'));
        expect(circuit, `${priv.name}: a /p2p-circuit through ${pubName} by id`).toBeDefined();
        // The /p2p/<id> after the prefix is a non-empty peer id string
        // (12D3Koo… or an ephemeral in dry-run). Not an empty slot.
        const idSection = circuit!.slice(circuitPrefix.length, -'/p2p-circuit'.length);
        expect(idSection.length, `${priv.name}: ${pubName}'s peer id present in the circuit`).toBeGreaterThan(0);
      }
      // No bare `/p2p-circuit` entry — the explicit form covers every
      // known relay and the bare form triggers libp2p's non-deterministic
      // discovery (`CircuitSearch` → RelayDiscovery).
      expect(parts.some((p) => p === '/p2p-circuit'),
        `${priv.name}: no bare /p2p-circuit (would trigger DHT discovery)`).toBe(false);
    }, 30_000);
  }
});

describe('mesh-node.ts does not auto-append a bare /p2p-circuit for private role', () => {
  // The caller (`up.mjs`) supplies specific `/ip4/<relay>/tcp/.../p2p-circuit`
  // listen addresses per public relay. The auto-append in
  // `startMeshNode` (previously `if (role === 'private') listen.push('/p2p-circuit')`)
  // would re-introduce the non-deterministic discovery path, so it must
  // be gone.
  it.fails('src/node/mesh-node.ts has no listen.push(\'/p2p-circuit\')', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(src, 'mesh-node.ts does not auto-push /p2p-circuit').not.toMatch(/listen\.push\(\s*['"]\/p2p-circuit['"]/);
  });
});
