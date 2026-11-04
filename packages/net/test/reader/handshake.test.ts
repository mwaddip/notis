// NET_INTERFACE → The browser entry — a reader built from
// `readerLibp2pOptions` runs `readerHandshake` as the dialler over
// an open WebRTC-direct connection. On success the node lists the
// reader in `getConnectedReaders()` with the empty capability set
// (NET_INTERFACE → Readers — "A reader declares no capability"); the
// reader reads the node's answer as
// `{ ok: true, capabilities, height }`.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair, PROTOCOL_VERSION } from '@dagsocial/types';
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
import { readerHandshake } from '../../src/mesh/reader-handshake.js';
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
  // `MESH_INTERFACE → NAT → "Every STUN server is a mesh node named by
  // IP"` — this case tests the handshake over WebRTC-direct, not
  // STUN, so the STUN server is off (the default `STUN_PORT` 3478
  // stays unbound, keeping this file out of the forks pool's STUN
  // race).
  return {
    role: 'public',
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
  };
}

async function webrtcDirectAddrOf(node: NetNode): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  for (let i = 0; i < 400; i++) {
    const match = libp2p
      .getMultiaddrs()
      .map((m) => m.toString())
      .find((s) => /\/webrtc-direct\/certhash\//.test(s));
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('node has no WebRTC-direct listen address');
}

describe('NET_INTERFACE → The browser entry — reader handshake', () => {
  const nodes: NetNode[] = [];
  const hosts: Libp2p[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.stop(); } catch { /* already stopped */ } }
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ } }
    hosts.length = 0; nodes.length = 0; dirs.length = 0;
  });

  it('a reader built from readerLibp2pOptions handshakes with a NetNode that has a public mesh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-reader-hs-'));
    dirs.push(dir);
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshOn(dir),
    }), validators);
    nodes.push(node);
    await node.start();

    const reader = await createLibp2p(readerLibp2pOptions({
      privateKey: nodeKeyFromKeyPair(generateKeyPair()).privateKey,
      magic: MAGIC_TESTNET,
      network: 'testnet',
      iceServers: () => [],
      denyDialMultiaddr: () => false,
    }));
    hosts.push(reader);

    const addr = await webrtcDirectAddrOf(node);
    const conn = await reader.dial(multiaddr(addr));
    const result = await readerHandshake(conn, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'reader-handshake-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // NET_INTERFACE → Readers — "A full node declares
      // `NODE_CAPABILITIES`": the five request codes it answers.
      expect(result.capabilities).toContain(2); // SyncInfo
      expect(result.capabilities).toContain(14); // GetHeaders
      expect(result.capabilities).toContain(16); // GetBlocks
      expect(result.height).toBe(0);
    }

    // Give the node a moment to classify the connection, then check
    // the reader is listed on the reader side, not the peer side.
    for (let i = 0; i < 50; i++) {
      if (node.getConnectedReaders().length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const readerId = reader.peerId.toString();
    expect(node.getConnectedReaders()).toContain(readerId);
    expect(node.getConnectedPeers()).not.toContain(readerId);
  }, 60_000);
});
