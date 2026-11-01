// MESH_INTERFACE → NAT → "A relay carries data" — a public mesh node
// relays with no circuit limit, so a private node reached through it
// serves bodies larger than libp2p's default 128 KiB circuit cap. The
// three cases hold the relayed data path in process over TCP:
//   1. a private node lists a plain circuit address beside its WebRTC one,
//   2. a relayed connection carries no limit (`conn.limits` undefined),
//   3. a 200 000-byte body arrives whole and byte-equal through
//      `meshFetchOverConnection` over the relayed connection.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@dagsocial/types';
import { nodeKeyFromKeyPair } from '../src/identity.js';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { meshBaseUrl } from '../src/mesh-url.js';
import { meshFetchOverConnection } from '../src/http-fetch.js';

const BODY_LEN = 200_000;
// A fixed pattern across the body — any shift or truncation makes a case
// fail at the first changed byte.
function makeBody(): Uint8Array {
  const buf = new Uint8Array(BODY_LEN);
  for (let i = 0; i < BODY_LEN; i++) buf[i] = i & 0xff;
  return buf;
}

async function waitFor<T>(fn: () => T | null, ms: number, label: string): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${ms} ms: ${label}`);
}

describe('a public mesh node relays data with no circuit limit', () => {
  let upstream: HttpServer | null = null;
  let upstreamBase = '';
  let fixedBody: Uint8Array = new Uint8Array(0);
  let relay: MeshNode | null = null;
  let priv: MeshNode | null = null;
  let dialer: Libp2p | null = null;
  const stateDirs: string[] = [];

  beforeEach(async () => {
    // The private node's upstream — the Notis HTTP base `nodeApiServer`
    // forwards GETs to. `/blocks/current` answers 200 000 bytes of a
    // fixed pattern as `application/octet-stream`; any other path 404s.
    fixedBody = makeBody();
    upstream = createServer((req, res) => {
      if (req.url === '/blocks/current') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(fixedBody.byteLength),
        });
        res.end(Buffer.from(fixedBody));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const upPort = (upstream.address() as AddressInfo).port;
    upstreamBase = `http://127.0.0.1:${upPort}`;

    // The relay — a public mesh node on a kernel-chosen TCP port, no
    // WebRTC-direct listener (TCP is enough for the in-process reach).
    const relayDir = mkdtempSync(join(tmpdir(), 'relay-carries-data-relay-'));
    stateDirs.push(relayDir);
    relay = await startMeshNode({
      key: nodeKeyFromKeyPair(generateKeyPair()),
      network: 'devnet',
      role: 'public',
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [],
      stateDir: relayDir,
      upstream: 'http://127.0.0.1:1',
    });

    // The relay's dialable TCP multiaddr with the peer id — the private
    // node's circuit listen names it in the specific form
    // `/ip4/127.0.0.1/tcp/<port>/p2p/<relay>/p2p-circuit`.
    const relayAddr = await waitFor(() => {
      const addrs = relay!.multiaddrs();
      return addrs.find((a) => /\/tcp\/\d+\/p2p\//.test(a)) ?? null;
    }, 5_000, "relay's TCP multiaddr with /p2p/");

    // The private — reserves on the relay through the specific
    // `/p2p-circuit` listen; its upstream is the 200 000-byte stub.
    const privDir = mkdtempSync(join(tmpdir(), 'relay-carries-data-priv-'));
    stateDirs.push(privDir);
    priv = await startMeshNode({
      key: nodeKeyFromKeyPair(generateKeyPair()),
      network: 'devnet',
      role: 'private',
      listen: ['/ip4/127.0.0.1/tcp/0', `${relayAddr}/p2p-circuit`],
      bootstrap: [],
      stateDir: privDir,
      upstream: upstreamBase,
      relayRetryBaseMs: 50,
      relayRetryCapMs: 500,
    });

    // Wait for the reservation to land — the circuit address appears
    // in the private's multiaddrs with the relay peer id.
    const relayPeer = relay.libp2p.peerId.toString();
    await waitFor(() => {
      const mas = priv!.multiaddrs();
      return mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer)) ? true : null;
    }, 15_000, 'private reserves on the relay');

    // The dialer — a plain libp2p host with TCP, Noise, Yamux, identify
    // and `circuitRelayTransport` (no mesh node services). It dials the
    // private node's plain circuit multiaddr.
    dialer = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
  });

  afterEach(async () => {
    try { await dialer?.stop(); } catch { /* already stopped */ }
    try { await priv?.stop(); } catch { /* already stopped */ }
    try { await relay?.stop(); } catch { /* already stopped */ }
    dialer = null; priv = null; relay = null;
    if (upstream) {
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = null;
    }
    for (const d of stateDirs) rmSync(d, { recursive: true, force: true });
    stateDirs.length = 0;
  });

  // A measurement, not a guard: a private node's `getMultiaddrs()`
  // publishes the plain `/p2p-circuit/p2p/<self>` once its reservation
  // lands, independently of the WebRTC listener's own
  // `/p2p-circuit/webrtc/p2p/<self>`. This may pass before the
  // relay-limit change — it rests on libp2p's listener behaviour, not
  // on the server's limit config. Later cases dial that plain address.
  it('a private node lists a plain circuit address beside its WebRTC one', () => {
    const addrs = priv!.libp2p.getMultiaddrs().map((a) => a.toString());
    const privPeer = priv!.libp2p.peerId.toString();
    const plain = addrs.filter((a) =>
      a.includes('/p2p-circuit/') &&
      !a.includes('/webrtc/') &&
      a.endsWith(`/p2p/${privPeer}`),
    );
    expect(plain.length, `addrs = ${addrs.join(', ')}`).toBeGreaterThan(0);
  });

  it.fails('a relayed connection carries no limit', async () => {
    const relayPeer = relay!.libp2p.peerId.toString();
    const privPeer = priv!.libp2p.peerId.toString();
    const addrs = relay!.multiaddrs();
    const relayTcp = addrs.find((a) => /\/tcp\/\d+\/p2p\//.test(a))!;
    const plainCircuit = `${relayTcp}/p2p-circuit/p2p/${privPeer}`;
    // Ensure the dialer first holds a direct connection to the relay —
    // libp2p needs it to route the circuit dial, and dialing by key
    // uses `circuitRelayTransport` without a relay connection would be
    // a different test (that still fails, but on reach, not on
    // limits).
    await dialer!.dial(multiaddr(relayTcp));
    const conn = await dialer!.dial(multiaddr(plainCircuit));
    try {
      expect(conn.remotePeer.toString()).toBe(privPeer);
      expect(conn.limits, `limits = ${JSON.stringify(conn.limits)}`).toBeUndefined();
    } finally {
      void relayPeer;
    }
  }, 20_000);

  it.fails('a body larger than 128 KiB arrives whole over the circuit', async () => {
    const relayPeer = relay!.libp2p.peerId.toString();
    const privPeer = priv!.libp2p.peerId.toString();
    const addrs = relay!.multiaddrs();
    const relayTcp = addrs.find((a) => /\/tcp\/\d+\/p2p\//.test(a))!;
    const plainCircuit = `${relayTcp}/p2p-circuit/p2p/${privPeer}`;
    await dialer!.dial(multiaddr(relayTcp));
    const conn = await dialer!.dial(multiaddr(plainCircuit));
    const privNotisId = (await import('../src/identity.js')).notisIdFromPeerId(priv!.libp2p.peerId);
    const base = meshBaseUrl(privNotisId);
    const fetch = meshFetchOverConnection(() => conn, { timeoutMs: 30_000 });
    const res = await fetch(`${base}/blocks/current`);
    expect(res.status).toBe(200);
    const bodyBuf = new Uint8Array(await res.arrayBuffer());
    expect(bodyBuf.byteLength).toBe(BODY_LEN);
    // Byte-equal: a shift or a truncation past the 128 KiB cap would
    // leave a diff at the first changed byte.
    expect(Buffer.from(bodyBuf).equals(Buffer.from(fixedBody))).toBe(true);
    void relayPeer;
  }, 60_000);
});
