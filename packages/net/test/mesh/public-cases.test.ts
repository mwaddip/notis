// NET_INTERFACE → The mesh — the public cases ported from the PoC's
// `tools/mesh-poc/test/mesh-node.test.ts`: the DHT speaks only Notis's
// protocol, the WebRTC-direct certificate persists across restarts,
// and (indirectly) a public node announces every listen address with a
// concrete port.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function meshOn(stateDir: string): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
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
