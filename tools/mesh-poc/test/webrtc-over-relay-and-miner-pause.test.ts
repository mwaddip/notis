// MESH_INTERFACE → NAT / Acceptance 1 — two more guards. A private
// node has a WebRTC transport and announces `/webrtc` on top of each
// `/p2p-circuit` reservation, so a browser reaches it directly after
// signalling through the relay — a circuit-relay v2 connection is
// limited (`@libp2p/circuit-relay-v2`'s `LimitTracker` in
// `src/utils.ts`, defaults ~128 KiB / 2 min) and refuses application
// streams, so the relayed connection carries SDP alone and the data
// goes over the direct WebRTC. s1's miner pause walks the recorded
// PID's descendants and signals the leaves, because the recorded PID
// is the outer `sudo` wrapper and SIGSTOP is not relayed to children.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type Server } from 'node:http';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { webRTC } from '@libp2p/webrtc';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair as libp2pGenerate } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { http as httpService } from '@libp2p/http';
import { fetch as libp2pFetch } from '@libp2p/http-fetch';
import { generateKeyPair } from '@dagsocial/types';
import { nodeKeyFromKeyPair } from '../src/identity.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { descendantPids, leafPids } from '../stage/lib/measure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const SRC_MESH_NODE = join(PACKAGE_ROOT, 'src', 'node', 'mesh-node.ts');
const SRC_UP = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SRC_S1 = join(PACKAGE_ROOT, 'stage', 'scenarios', 's1-no-name.mjs');

describe('mesh-node.ts gives a private role a webRTC transport and /webrtc listen', () => {
  // `@libp2p/webrtc@7.0.2/src/private-to-private/listener.ts` lines
  // 41-52: `WebRTCPeerListener` encapsulates `/webrtc` onto every
  // `/p2p-circuit` listener's addresses, so a private node with a
  // `/webrtc` listen entry announces `<relay>/p2p-circuit/webrtc/p2p/<self>`
  // the moment each circuit reservation lands.
  it.fails('src/node/mesh-node.ts imports webRTC from @libp2p/webrtc and uses it in the private transports', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(src, 'imports webRTC').toMatch(/import\s*\{[^}]*\bwebRTC\b[^}]*\}\s*from\s*['"]@libp2p\/webrtc['"]/);
    // The private transports include a webRTC() call.
    expect(src, 'webRTC() among the private transports').toMatch(/role === 'private'[\s\S]*?webRTC\s*\(/);
  });
  it.fails('src/node/mesh-node.ts adds /webrtc to the listen list for a private role', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(src, 'a /webrtc listen is added when role is private').toMatch(/role === 'private'[\s\S]*?['"]\/webrtc['"]/);
  });
  it('MeshNodeOptions carries a stunServers field (IP-only, matches the client\'s refusal rule)', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(src, 'stunServers option on MeshNodeOptions').toMatch(/stunServers\?\s*:\s*(?:readonly\s+)?string\[\]/);
  });
});

describe('config-variants picks the /webrtc form of a private node\'s announced circuit address', () => {
  // s2 builds a config variant whose only anchor is a private node
  // reached through a relay by WebRTC. A `/p2p-circuit` endpoint is
  // limited (relay cap), so a probe over the raw circuit form fails.
  // The private node announces `<relay>/p2p-circuit/webrtc/p2p/<priv>`
  // once both the circuit reservation and the WebRTC listener land —
  // the variant builder reads THAT form, not the raw circuit.
  it.fails('buildPrivateViaAnnouncedRelayVariant reads a /webrtc/p2p/<priv> address when the private announced one', async () => {
    const { buildPrivateViaAnnouncedRelayVariant } = await import('../stage/lib/config-variants.mjs');
    const base = {
      network: 'devnet',
      anchors: [{ notisId: 'aa'.repeat(32), addrs: ['/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/CH1/p2p/PUB1'] }],
      stunServers: ['stun:11.100.0.11:3478'],
      seeds: [],
    };
    const identities = {
      pub1: {
        notisId: 'aa'.repeat(32),
        meshRole: 'public',
        multiaddrs: [
          '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/CH1/p2p/PUB1',
          '/ip4/11.100.0.11/tcp/4002/p2p/PUB1',
        ],
      },
      priv1: {
        notisId: 'cc'.repeat(32),
        meshRole: 'private',
        multiaddrs: [
          '/ip4/10.101.0.11/udp/4001/webrtc-direct/certhash/CH-PRIV/p2p/PRIV1',
          '/ip4/11.100.0.11/tcp/4002/p2p/PUB1/p2p-circuit/webrtc/p2p/PRIV1',
          '/ip4/11.100.0.11/tcp/4002/p2p/PUB1/p2p-circuit/p2p/PRIV1',
        ],
      },
    };
    const r = buildPrivateViaAnnouncedRelayVariant(base, {
      privRow: identities.priv1,
      identities,
    });
    expect(r.anchors.length).toBe(1);
    // The composed anchor address encapsulates /p2p-circuit/webrtc/p2p/<priv>
    // on the relay's /webrtc-direct address.
    const addr = r.anchors[0]!.addrs[0]!;
    expect(addr, 'anchor address includes /p2p-circuit/webrtc/p2p/').toMatch(/\/p2p-circuit\/webrtc\/p2p\/PRIV1$/);
    expect(addr, 'anchor address rides the relay\'s webrtc-direct').toMatch(/^\/ip4\/11\.100\.0\.11\/udp\/4001\/webrtc-direct\/certhash\/CH1\/p2p\/PUB1/);
  });
});

describe('up.mjs passes MESH_STUN_SERVERS to each private mesh node', () => {
  // The private mesh node's WebRTC transport needs ICE servers (STUN)
  // to gather its own candidates — the ICE servers are the public
  // mesh nodes' STUN by IP (`MESH_INTERFACE → NAT` — "every STUN
  // server is a mesh node named by IP").
  it.fails('every private mesh spawn carries MESH_STUN_SERVERS naming the public STUNs by IP', () => {
    const src = readFileSync(SRC_UP, 'utf8');
    expect(src, 'MESH_STUN_SERVERS env is set on the private branch').toMatch(/MESH_STUN_SERVERS/);
  });
});

describe('s1 pauses the miner\'s innermost process, not the sudo wrapper', () => {
  // The recorded PID is the outer `sudo ip netns exec ...` wrapper.
  // sudo does not relay SIGSTOP to its child, so the inner Node
  // process keeps running and `/blocks/current` still moves. The
  // fault signals the leaves of the recorded PID's descendants.
  it('stage/lib/measure.mjs exports descendantPids and leafPids', () => {
    expect(typeof descendantPids).toBe('function');
    expect(typeof leafPids).toBe('function');
  });

  it.fails('leafPids(self) finds a short-lived child this test spawns and returns to the leaf', async () => {
    // Spawn `sh -c "sleep 0.5"` from vitest's own pid. The sh is a
    // direct child, and it has no further children — it IS the leaf.
    const child: ChildProcess = nodeSpawn('sh', ['-c', 'sleep 0.5']);
    try {
      // Give /proc time to register the child.
      await sleep(60);
      const leaves = leafPids(process.pid);
      expect(leaves.includes(child.pid!), `child ${child.pid} is in the leaf set of our own pid`).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
  }, 10_000);

  it.fails('stage/scenarios/s1-no-name.mjs signals the leaves, not the recorded PID directly', () => {
    const src = readFileSync(SRC_S1, 'utf8');
    expect(src, 's1 calls leafPids on the recorded miner-steady entry').toMatch(/leafPids\(/);
    // The old direct call to signal(minerEntry.pid, 'SIGSTOP') is gone.
    expect(src, 's1 does not SIGSTOP the recorded entry pid directly').not.toMatch(/signal\(\s*minerEntry\.pid\s*,\s*['"]SIGSTOP/);
  });
});

describe('a private mesh node is reached over /webrtc via a circuit relay (in-process)', () => {
  let stateDirs: string[] = [];
  let privateNode: MeshNode | null = null;
  const toStopLibp2p: Libp2p[] = [];
  const toStopServers: Server[] = [];

  afterEach(async () => {
    if (privateNode) { await privateNode.stop(); privateNode = null; }
    for (const n of toStopLibp2p) {
      try { await n.stop(); } catch { /* ignore */ }
    }
    toStopLibp2p.length = 0;
    for (const s of toStopServers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    toStopServers.length = 0;
    for (const d of stateDirs) rmSync(d, { recursive: true, force: true });
    stateDirs = [];
  });

  function mkStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-webrtc-'));
    stateDirs.push(dir);
    return dir;
  }

  it.fails('a browser-shaped client fetches 165 KB over /webrtc through the relay', async () => {
    // Upstream HTTP server with a 165 KB /nipopow/proof/24/20.
    const BODY = Buffer.alloc(165 * 1024);
    for (let i = 0; i < BODY.length; i += 1) BODY[i] = (i * 7) & 0xff;
    const upstream = createServer((req, res) => {
      if (req.url === '/nipopow/proof/24/20') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BODY.length) });
        res.end(BODY);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    toStopServers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    // Relay: TCP + circuitRelayServer. Keeps the circuit limit at
    // default (data goes over the direct WebRTC, not the relay).
    const relayKey = await libp2pGenerate('Ed25519');
    const relayPeer = peerIdFromPrivateKey(relayKey);
    const relay = await createLibp2p({
      privateKey: relayKey,
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), circuitRelay: circuitRelayServer() },
    });
    toStopLibp2p.push(relay);
    const relayAddrs = relay.getMultiaddrs().map((m) => m.toString());
    const relayTcp = relayAddrs.find((m) => m.includes('/tcp/') && !m.includes('/webrtc'))!;
    expect(relayTcp, 'relay has a tcp listen address').toBeDefined();

    // Private mesh node with webRTC transport, /webrtc listen,
    // circuit listen through the relay.
    const privateStateDir = mkStateDir();
    const circuitListen = `${relayTcp.replace(/\/p2p\/[^/]+$/, '')}/p2p/${relayPeer.toString()}/p2p-circuit`;
    privateNode = await startMeshNode({
      key: nodeKeyFromKeyPair(generateKeyPair()),
      network: 'devnet',
      role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0', circuitListen],
      bootstrap: [],
      stateDir: privateStateDir,
      upstream: upstreamUrl,
      stunServers: [],
      relayRetryBaseMs: 50,
      relayRetryCapMs: 200,
    });

    // Wait for the private node to announce a /webrtc/p2p/<priv>
    // address — the WebRTC listener encapsulates /webrtc on top of
    // each circuit reservation.
    const deadline = Date.now() + 15_000;
    let webrtcAddr: string | null = null;
    while (Date.now() < deadline) {
      const mas = privateNode.multiaddrs();
      const found = mas.find((m) => /\/p2p-circuit\/webrtc\/p2p\//.test(m));
      if (found) { webrtcAddr = found; break; }
      await sleep(100);
    }
    expect(webrtcAddr, `private announced a /p2p-circuit/webrtc address (mas = ${privateNode.multiaddrs().join(', ')})`).not.toBeNull();

    // Browser-shaped client: webRTC + circuitRelayTransport + tcp
    // (for the production browser this would be webRTC-direct to
    // reach the relay; the test uses TCP so the relay is reachable
    // from an in-process Node client).
    const clientKey = await libp2pGenerate('Ed25519');
    const client = await createLibp2p({
      privateKey: clientKey,
      transports: [tcp(), webRTC(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), http: httpService() },
    });
    toStopLibp2p.push(client);

    // Dial the private's /webrtc form directly.
    const conn = await client.dial(multiaddr(webrtcAddr!), { signal: AbortSignal.timeout(20_000) });
    // Open an HTTP stream on that connection and fetch the 165 KB body.
    const stream = await client.dialProtocol(conn.remotePeer, '/http/1.1', { signal: AbortSignal.timeout(20_000) });
    const res = await libp2pFetch(stream, 'http://peer/nipopow/proof/24/20');
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status, 'fetch status').toBe(200);
    expect(body.length, '165 KB body whole').toBe(BODY.length);
    expect(body.equals(BODY), 'body bytes match').toBe(true);
  }, 60_000);
});
