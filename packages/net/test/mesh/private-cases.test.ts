// NET_INTERFACE → The mesh — a private `NetNode` runs the circuit-relay
// transport, the WebRTC transport, DCUtR, the DHT in client mode, and
// publishes its reservations alone (`MESH_INTERFACE → NAT → "A private
// node … takes a relay reservation on each public node it is told of
// … is reached through them"`; `→ Discovery → "The DHT is Notis's
// own"`; `→ NAT → "A private node announces its relay reservations
// alone"`). The reservations ride the TCP connection `net` opened to
// each seed in `bootstrapPeers`, never a second one.

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
import { dhtProtocol } from '../../src/browser.js';
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
  };
}

describe('mesh — a private NetNode', () => {
  let nodes: NetNode[] = [];
  let relays: Libp2p[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const r of relays) { try { await r.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; relays = []; dirs = [];
  });

  // MESH_INTERFACE → Discovery → "The DHT is Notis's own" — a private
  // node runs the DHT in CLIENT mode, so it does not register the
  // server-side handlers for Notis's `/kad/` protocol; it still walks
  // the DHT as a client.
  it('a private node runs the DHT as a client', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-dht-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    const libp2p = (node as unknown as { libp2p: { getProtocols(): string[] } }).libp2p;
    const protos = libp2p.getProtocols();
    // A client-mode kad-dht does not register the server-side protocol
    // (`@libp2p/kad-dht` `src/index.ts`'s `clientMode` branch).
    expect(protos).not.toContain(dhtProtocol('devnet'));
  }, 30_000);

  // MESH_INTERFACE → NAT — "A relay that does not answer never stops a
  // private node. The node starts on its own addresses alone". With no
  // bootstrap peer the private node holds no reservation and lists no
  // circuit address, yet `start` returns and the node is up.
  it('with bootstrapPeers: [] starts and takes no reservation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-no-boot-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);
    const libp2p = (node as unknown as { libp2p: { getMultiaddrs(): Array<{ toString(): string }> } }).libp2p;
    const mas = libp2p.getMultiaddrs().map((a) => a.toString());
    // No circuit reservation stands in a private node with no bootstrap.
    expect(mas.some((m) => m.includes('/p2p-circuit')),
      `addrs = ${mas.join(', ')}`).toBe(false);
  }, 30_000);

  // MESH_INTERFACE → NAT — "takes a relay reservation on each public
  // node it is told of — its bootstrap peers, by address and id, over
  // the connection `net` holds to each, never by searching". The
  // bootstrap address is a plain TCP multiaddr with `/p2p/<peer>`; the
  // private node reserves on each through the TCP connection the
  // outbound floor opened.
  it('reserves on its TCP seed and the reservation rides the floor-opened TCP connection', async () => {
    // A plain libp2p circuit-relay server on loopback TCP — the
    // minimal shape of a public mesh node's relay surface.
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
    relays.push(relay);
    const relayAddr = await waitFor(
      () => relay.getMultiaddrs().map((a) => a.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s)),
      5_000,
      "relay's TCP multiaddr with /p2p/",
    );

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-boot-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [relayAddr],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    // The reservation lands within the retry cadence.
    await waitFor(
      () => {
        const mas = libp2p.getMultiaddrs().map((a) => a.toString());
        return mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer.toString())) ? true : null;
      },
      20_000,
      'reservation on the TCP seed',
    );

    // Exactly ONE TCP connection stands to the relay peer — the floor's
    // dial, reused by the circuit transport's `openConnection`.
    const conns = libp2p.getConnections()
      .filter((c) => c.remotePeer.toString() === relayPeer.toString());
    expect(conns.length,
      `connections to relay = ${conns.map((c) => c.remoteAddr.toString()).join(', ')}`,
    ).toBe(1);
  }, 30_000);

  // MESH_INTERFACE → NAT → "A `private` node announces its relay
  // reservations alone". Even with a `/webrtc-direct` listen of its
  // own (for the local-address path, `→ Discovery → "A node added by
  // hand"`), `getMultiaddrs()` carries circuit entries alone — every
  // address names `/p2p-circuit`.
  it('a private node announces its relay reservations alone (announceFilter)', async () => {
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
    relays.push(relay);
    const relayAddr = await waitFor(
      () => relay.getMultiaddrs().map((a) => a.toString()).find((s) => /\/tcp\/\d+\/p2p\//.test(s)),
      5_000,
      "relay's TCP multiaddr with /p2p/",
    );

    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-announce-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [relayAddr],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
    await waitFor(
      () => {
        const mas = libp2p.getMultiaddrs().map((a) => a.toString());
        return mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeer.toString())) ? true : null;
      },
      20_000,
      'reservation lands',
    );
    const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
    expect(addrs.length, `addrs = ${addrs.join(', ')}`).toBeGreaterThan(0);
    for (const a of addrs) {
      expect(a, `addrs = ${addrs.join(', ')}`).toContain('/p2p-circuit');
    }
  }, 30_000);

  // MESH_INTERFACE → Discovery → "A node added by hand" — "A private
  // node prints its local WebRTC-direct address with its key, for its
  // operator to hand over". `meshIdentity().localAddrs` carries each
  // WebRTC-direct listen address with `/certhash/` and `/p2p/<peer>`,
  // and nothing else.
  it("meshIdentity().localAddrs lists the private node's local WebRTC-direct address with certhash", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-ident-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
      mesh: privateMeshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    // Wait for the WebRTC-direct listener's certificate to arrive — the
    // listener's `getAddrs()` returns [] until the cert loads.
    const id = await waitFor(
      () => {
        const got = node.meshIdentity();
        if (got === null) return null;
        return got.localAddrs.some((a) => a.includes('/webrtc-direct/certhash/')) ? got : null;
      },
      15_000,
      'localAddrs with /webrtc-direct/certhash/',
    );
    expect(id.localAddrs.length).toBeGreaterThan(0);
    for (const a of id.localAddrs) {
      expect(a).toMatch(/\/webrtc-direct\/certhash\/[^/]+/);
      expect(a.endsWith(`/p2p/${id.peerId}`)).toBe(true);
    }
  }, 30_000);
});
