// MESH_INTERFACE → NAT → "A relay carries data" — a public mesh node
// relays with no circuit limit, so a private node reached through it
// serves bodies larger than libp2p's default 128 KiB circuit cap.
//
// The three cases hold the relayed data path through a public mesh
// `NetNode` to a private mesh `NetNode`:
//   1. the private lists a plain circuit address beside its WebRTC one,
//   2. a relayed connection carries no limit (`conn.limits` undefined),
//   3. a 200 000-byte body arrives whole and byte-equal through the
//      private's mesh endpoint over the relayed connection.

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
import { ping } from '@libp2p/ping';
import { http as httpService, type HTTP } from '@libp2p/http';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
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
import { makeConfig } from '../helpers.js';

const BODY_LEN = 200_000;
function makeBody(): Uint8Array {
  const buf = new Uint8Array(BODY_LEN);
  for (let i = 0; i < BODY_LEN; i++) buf[i] = i & 0xff;
  return buf;
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

function publicMeshOn(stateDir: string, httpBase: string): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase,
    stun: null,
  };
}

function privateMeshOn(stateDir: string, httpBase: string): MeshConfig {
  return {
    role: 'private',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase,
    stun: null,
    // Faster retry so the reservation lands inside the suite timeout.
    relayRetryBaseMs: 50,
    relayRetryCapMs: 500,
  } as MeshConfig;
}

async function firstTcpAddr(node: NetNode): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  return waitFor(
    () => libp2p.getMultiaddrs().map((a) => a.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s)),
    5_000,
    'public node TCP multiaddr',
  );
}

describe('a public NetNode relays data from a private NetNode with no circuit limit', () => {
  let upstream: HttpServer | null = null;
  let upstreamBase = '';
  let fixedBody: Uint8Array = new Uint8Array(0);
  let relay: NetNode | null = null;
  let priv: NetNode | null = null;
  let dialer: Libp2p | null = null;
  const stateDirs: string[] = [];

  beforeEach(async () => {
    // The private node's upstream — `/blocks/current` answers
    // 200 000 bytes of a fixed pattern as application/octet-stream.
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

    // Relay — a public mesh NetNode on loopback TCP + WebRTC-direct.
    const relayDir = mkdtempSync(join(tmpdir(), 'net-relay-carries-relay-'));
    stateDirs.push(relayDir);
    relay = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      mesh: publicMeshOn(relayDir, 'http://127.0.0.1:1'),
    }), validators);
    await relay.start();
    const relayAddr = await firstTcpAddr(relay);

    // Private — reserves on the relay through its TCP bootstrap peer.
    const privDir = mkdtempSync(join(tmpdir(), 'net-relay-carries-priv-'));
    stateDirs.push(privDir);
    priv = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [relayAddr],
      mesh: privateMeshOn(privDir, upstreamBase),
    }), validators);
    await priv.start();

    const relayLibp2p = (relay as unknown as { libp2p: Libp2p }).libp2p;
    const privLibp2p = (priv as unknown as { libp2p: Libp2p }).libp2p;
    const relayPeer = relayLibp2p.peerId.toString();
    await waitFor(
      () => {
        const mas = privLibp2p.getMultiaddrs().map((a) => a.toString());
        return mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer)) ? true : null;
      },
      20_000,
      'private reserves on the relay',
    );

    // Dialer — plain libp2p host, TCP + circuit-relay transport.
    dialer = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify(), ping: ping(), http: httpService() },
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
    for (const d of stateDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    stateDirs.length = 0;
  });

  it.fails('a private node lists a plain circuit address beside its WebRTC one', () => {
    const libp2p = (priv as unknown as { libp2p: Libp2p }).libp2p;
    const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
    const privPeer = libp2p.peerId.toString();
    const plain = addrs.filter((a) =>
      a.includes('/p2p-circuit/') &&
      !a.includes('/webrtc/') &&
      a.endsWith(`/p2p/${privPeer}`),
    );
    const webrtcCircuit = addrs.filter((a) =>
      a.includes('/p2p-circuit/webrtc/') &&
      a.endsWith(`/p2p/${privPeer}`),
    );
    expect(plain.length, `addrs = ${addrs.join(', ')}`).toBeGreaterThan(0);
    expect(webrtcCircuit.length, `addrs = ${addrs.join(', ')}`).toBeGreaterThan(0);
  });

  it.fails('a relayed connection carries no limit', async () => {
    const relayLibp2p = (relay as unknown as { libp2p: Libp2p }).libp2p;
    const privLibp2p = (priv as unknown as { libp2p: Libp2p }).libp2p;
    const privPeer = privLibp2p.peerId.toString();
    const relayTcp = relayLibp2p.getMultiaddrs().map((a) => a.toString())
      .find((s) => /\/tcp\/\d+\/p2p\//.test(s))!;
    const plainCircuit = `${relayTcp}/p2p-circuit/p2p/${privPeer}`;
    await dialer!.dial(multiaddr(relayTcp));
    const conn = await dialer!.dial(multiaddr(plainCircuit));
    expect(conn.remotePeer.toString()).toBe(privPeer);
    expect(conn.limits, `limits = ${JSON.stringify(conn.limits)}`).toBeUndefined();
  }, 30_000);

  it.fails('a body larger than 128 KiB arrives whole over the relayed mesh endpoint', async () => {
    const relayLibp2p = (relay as unknown as { libp2p: Libp2p }).libp2p;
    const privLibp2p = (priv as unknown as { libp2p: Libp2p }).libp2p;
    const privPeer = privLibp2p.peerId.toString();
    const relayTcp = relayLibp2p.getMultiaddrs().map((a) => a.toString())
      .find((s) => /\/tcp\/\d+\/p2p\//.test(s))!;
    const plainCircuit = `${relayTcp}/p2p-circuit/p2p/${privPeer}`;
    await dialer!.dial(multiaddr(relayTcp));
    const conn = await dialer!.dial(multiaddr(plainCircuit));
    // Reach the private node's mesh endpoint through `services.http.fetch`.
    const resource = `/p2p/${privPeer}/http-path/${encodeURIComponent('blocks/current')}`;
    const res = await (dialer as unknown as Libp2p<{ http: HTTP }>).services.http.fetch(resource);
    expect(res.status).toBe(200);
    const bodyBuf = new Uint8Array(await res.arrayBuffer());
    expect(bodyBuf.byteLength).toBe(BODY_LEN);
    expect(Buffer.from(bodyBuf).equals(Buffer.from(fixedBody))).toBe(true);
    // Keep `conn` referenced — a dead variable warning would hide the
    // shared connection the fetch rides.
    expect(conn.status).toBe('open');
  }, 60_000);
});
