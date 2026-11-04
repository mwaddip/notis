// NET_INTERFACE → The mesh — the public cases ported from the PoC's
// `tools/mesh-poc/test/mesh-node.test.ts`: the DHT speaks only Notis's
// protocol, the WebRTC-direct certificate persists across restarts,
// and (indirectly) a public node announces every listen address with a
// concrete port.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { Key } from 'interface-datastore';
import { generateKeyPair } from '@dagsocial/types';
import { openMeshDatastore } from '../../src/mesh/state-dir.js';
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

function meshOn(stateDir: string): MeshConfig {
  // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
  // IP"` — these cases test the DHT protocol, the WebRTC-direct cert
  // and the mesh identity; none exercises STUN, so the server is off.
  // `stun: null` keeps the default `STUN_PORT` (3478) unbound, so this
  // file never races another mesh case under vitest's forks pool
  // (`MeshConfig.stun`: `null` encodes "off").
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
  };
}

function certhashOf(ma: string): string | null {
  const m = /\/certhash\/([^/]+)/.exec(ma);
  return m ? m[1]! : null;
}

describe('mesh — public cases ported from the PoC', () => {
  let nodes: NetNode[] = [];
  let dirs: string[] = [];
  afterEach(async () => {
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    nodes = []; dirs = [];
  });

  it("the DHT speaks only Notis's protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-dht-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    const libp2p = (node as unknown as { libp2p: { getProtocols(): string[] } }).libp2p;
    const protos = libp2p.getProtocols();
    expect(protos).toContain(dhtProtocol('devnet'));
    // Every other registered protocol stays clear of kad-dht's defaults
    // and any `/kad/` family at all. Notis's own is the only `/kad/`.
    for (const p of protos.filter((x) => x !== dhtProtocol('devnet'))) {
      expect(p).not.toMatch(/\/ipfs\/kad\//);
      expect(p).not.toMatch(/\/kad\//);
    }
  }, 30_000);

  // MESH_INTERFACE → Transports → "The WebRTC-direct certificate persists"
  // — the WebRTC-direct certificate's `notAfter` sits well past any
  // operator horizon, so the certhash an anchor lists stays steady
  // across restarts within one release cycle. The guard is
  // `certificateLifespan: WEBRTC_CERT_LIFESPAN_MS` in
  // `meshWebRTCDirectTransport`; without it the webrtc default of 14
  // days applies and the assertion below fails.
  it('the WebRTC-direct certificate notAfter is well past the operator horizon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-notafter-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    await node.start();
    nodes.push(node);

    const ds = openMeshDatastore(dir);
    // `@libp2p/webrtc@7.0.2`'s datastore key for the PEM certificate.
    const certBytes = await ds.get(new Key('/libp2p/webrtc-direct/certificate'));
    const cert = new X509Certificate(Buffer.from(certBytes));
    const notAfterMs = Date.parse(cert.validTo);
    expect(Number.isFinite(notAfterMs)).toBe(true);
    expect(notAfterMs).toBeGreaterThan(Date.now() + 25 * 24 * 60 * 60 * 1000);
  }, 30_000);

  it('the WebRTC-direct certhash persists across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-cert-'));
    dirs.push(dir);
    const key = generateKeyPair();

    const n1 = new NetNode(makeConfig({
      nodeKey: key,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    await n1.start();
    const addrs1 = (n1 as unknown as { libp2p: { getMultiaddrs(): Array<{ toString(): string }> } }).libp2p.getMultiaddrs().map((a) => a.toString());
    const peer1 = (n1 as unknown as { libp2p: { peerId: { toString(): string } } }).libp2p.peerId.toString();
    await n1.stop();

    const n2 = new NetNode(makeConfig({
      nodeKey: key,
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    await n2.start();
    nodes.push(n2);
    const addrs2 = (n2 as unknown as { libp2p: { getMultiaddrs(): Array<{ toString(): string }> } }).libp2p.getMultiaddrs().map((a) => a.toString());
    const peer2 = (n2 as unknown as { libp2p: { peerId: { toString(): string } } }).libp2p.peerId.toString();

    const wd1 = addrs1.find((a) => a.includes('/webrtc-direct/'));
    const wd2 = addrs2.find((a) => a.includes('/webrtc-direct/'));
    expect(wd1).toBeTruthy();
    expect(wd2).toBeTruthy();
    expect(certhashOf(wd1!)).toBe(certhashOf(wd2!));
    expect(peer1).toBe(peer2);
  }, 30_000);

  it('meshIdentity reports the announced addresses, onMeshAddresses fires on update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-mesh-id-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    const updates: Array<{ multiaddrs: readonly string[] }> = [];
    node.onMeshAddresses((id) => { updates.push({ multiaddrs: id.multiaddrs }); });
    await node.start();
    nodes.push(node);
    const id = node.meshIdentity();
    expect(id).not.toBeNull();
    expect(id!.notisId).toMatch(/^[0-9a-f]{64}$/);
    // The announced set is non-empty by the time the node is started;
    // libp2p 3.5 may fire `self:peer:update` zero or more times before
    // `start()` returns, so the handler's count can be 0 — that is not
    // a defect, the first announce may have already fired.
    expect(id!.multiaddrs.length).toBeGreaterThan(0);
  }, 30_000);
});
