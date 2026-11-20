// NET_INTERFACE → The browser entry — a reader built from
// `readerLibp2pOptions` registers the `fips` multiaddr code at start
// so libp2p's identify reads a mesh node's signed peer record whole,
// including its FIPS address (`MESH_INTERFACE → FIPS → "Every Notis
// libp2p client knows the \`fips\` code"`). The reader's peer store
// holds that address after identify completes.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
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
import { nodeKeyFromKeyPair } from '../../src/mesh/identity.js';
import { readerLibp2pOptions } from '../../src/mesh/reader-options.js';
import { MAGIC_TESTNET } from '../../src/frame.js';
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
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => 'http://127.0.0.1:0',
    stun: null,
  };
}

async function webrtcDirectAddr(libp2p: Libp2p, deadlineMs: number): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const a = libp2p.getMultiaddrs().map((m) => m.toString())
      .find((s) => /\/webrtc-direct\/certhash\//.test(s));
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('NET_INTERFACE → The browser entry — reader learns a node FIPS address through identify', () => {
  const nodes: NetNode[] = [];
  const hosts: Libp2p[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.stop(); } catch { /* already */ } }
    for (const n of nodes) { try { await n.stop(); } catch { /* already */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already */ } }
    hosts.length = 0; nodes.length = 0; dirs.length = 0;
  });

  it.fails('a reader built from readerLibp2pOptions learns a node FIPS address through identify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-fips-reader-id-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    nodes.push(node);
    await node.start();
    const nodeFips = node.fipsAddress();
    expect(nodeFips).not.toBeNull();

    const reader = await createLibp2p(readerLibp2pOptions({
      privateKey: nodeKeyFromKeyPair(generateKeyPair()).privateKey,
      magic: MAGIC_TESTNET,
      network: 'testnet',
      iceServers: () => [],
      denyDialMultiaddr: () => false,
    }));
    hosts.push(reader);

    const nodeAddr = await webrtcDirectAddr(
      (node as unknown as { libp2p: Libp2p }).libp2p,
      10_000,
    );
    expect(nodeAddr).not.toBeNull();
    await reader.dial(multiaddr(nodeAddr!));

    // identify runs on the new connection; its signed peer record
    // carries every address the node announces, the FIPS one included.
    const nodePeerId = (node as unknown as { libp2p: Libp2p }).libp2p.peerId;
    const t0 = Date.now();
    let found = false;
    while (Date.now() - t0 < 10_000) {
      const peer = await reader.peerStore.get(nodePeerId).catch(() => null);
      if (peer !== null) {
        const addrs = peer.addresses.map((a) => a.multiaddr.toString());
        if (addrs.some((a) => a.includes('/fips/'))) { found = true; break; }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBe(true);
  }, 30_000);
});
