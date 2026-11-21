// NET_INTERFACE → The mesh — a private `NetNode` runs the circuit-relay
// transport, the WebRTC transport, DCUtR, the DHT in client mode, and
// publishes its reservations alone (`MESH_INTERFACE → NAT → "A node's
// role is its operator's setting"`; `→ Discovery → "The DHT is Notis's
// own"`; `→ NAT → "A public node announces its listen addresses from
// the start"` — the same paragraph's close holds the private role to
// its reservations alone). The reservations ride the TCP connection
// `net` opened to each seed in `bootstrapPeers`, never a second one.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@dagsocial/types';
import { generateIdentity } from '@fips/core';
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
import { npubOf } from '../../src/mesh/fips-identity.js';
import { registerFipsProtocol } from '../../src/mesh/fips-addr.js';
import { privateAnnounceFilter } from '../../src/mesh/libp2p-options.js';
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
    httpBase: () => 'http://127.0.0.1:0',
    stun: null,
  };
}

function publicMeshOn(stateDir: string): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => 'http://127.0.0.1:1',
    stun: null,
  };
}

describe('mesh — a private NetNode', () => {
  let nodes: NetNode[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; dirs = [];
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

  // `MESH_INTERFACE → NAT → "A relay that does not answer never stops a private node"`
  // — with no bootstrap peer the private node holds no reservation
  // and lists no circuit address, yet `start` returns and the node
  // is up.
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

  // `MESH_INTERFACE → NAT → "A node's role is its operator's setting"`
  // — a private node takes a relay reservation on each of its
  // bootstrap peers over the connection `net` holds to that peer,
  // never by searching. The bootstrap address is a plain TCP
  // multiaddr with `/p2p/<peer>`; the private node reserves on each
  // through the TCP connection the outbound floor opened. The relay is
  // a public mesh `NetNode`, so the funnel's outbound handshake
  // completes (NET_INTERFACE → Handshake → "Every connection this node
  // dialled carries its handshake, whoever within the node dialled it"),
  // and a relay the node dialled serves the chain.
  it('reserves on its TCP seed and the reservation rides the floor-opened TCP connection', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-boot-relay-'));
    dirs.push(relayDir);
    const relay = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
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
        return mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeerId)) ? true : null;
      },
      20_000,
      'reservation on the TCP seed',
    );

    // Exactly ONE TCP connection stands to the relay peer — the floor's
    // dial, reused by the circuit transport's `openConnection`.
    const conns = libp2p.getConnections()
      .filter((c) => c.remotePeer.toString() === relayPeerId);
    expect(conns.length,
      `connections to relay = ${conns.map((c) => c.remoteAddr.toString()).join(', ')}`,
    ).toBe(1);
  }, 30_000);

  // `MESH_INTERFACE → NAT → "A public node announces its listen addresses from the start"`
  // — the same paragraph's close holds a private node to its
  // reservation addresses alone. Even with a `/webrtc-direct` listen
  // of its own (for the local-address path, `→ Discovery → "A node added by hand"`),
  // MESH_INTERFACE → FIPS → "A node announces its FIPS address" — a
  // private node's `getMultiaddrs()` carries its relay reservations and
  // FIPS addresses; every entry names either `/p2p-circuit` or `/fips/`.
  it('a private node announces its relay reservations and FIPS addresses (announceFilter)', async () => {
    const relayDir = mkdtempSync(join(tmpdir(), 'net-mesh-priv-announce-relay-'));
    dirs.push(relayDir);
    const relay = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      bootstrapPeers: [],
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
        return mas.some((m) => m.includes('/p2p-circuit') && m.includes(relayPeerId)) ? true : null;
      },
      20_000,
      'reservation lands',
    );
    const addrs = libp2p.getMultiaddrs().map((a) => a.toString());
    expect(addrs.length, `addrs = ${addrs.join(', ')}`).toBeGreaterThan(0);
    for (const a of addrs) {
      expect(
        a.includes('/p2p-circuit') || a.includes('/fips/'),
        `addrs = ${addrs.join(', ')}`,
      ).toBe(true);
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

  // MESH_INTERFACE → FIPS → "A private node's relay addresses ride IP"
  // — libp2p builds a relay address over a relay's FIPS address as
  // `/fips/<relay npub>/p2p/<relay>/p2p-circuit/p2p/<self>`; a private
  // node's announce filter drops it. The filter decides by components,
  // not substrings: a plain IP relay address is kept, the node's own
  // FIPS address is kept.
  it('a relay address over the relay\'s FIPS address is not announced', async () => {
    registerFipsProtocol();
    const RELAY_PEER = '12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';
    const SELF_PEER = '12D3KooWRK3WSeTr9LZQtEVz1FsdmfMMbZk59qJwpv5dW4ECrKvq';
    const relayId = await generateIdentity();
    const selfId = await generateIdentity();
    const npubRelay = npubOf(relayId);
    const npubSelf = npubOf(selfId);
    const over = multiaddr(`/fips/${npubRelay}/p2p/${RELAY_PEER}/p2p-circuit/p2p/${SELF_PEER}`);
    const plain = multiaddr(`/ip4/1.2.3.4/tcp/9733/p2p/${RELAY_PEER}/p2p-circuit/p2p/${SELF_PEER}`);
    const own = multiaddr(`/fips/${npubSelf}/p2p/${SELF_PEER}`);
    const bare = multiaddr('/ip4/10.0.0.2/tcp/9733');
    const kept = privateAnnounceFilter([over, plain, own, bare]).map((m) => m.toString());
    expect(kept).toEqual([plain.toString(), own.toString()]);
  });
});
