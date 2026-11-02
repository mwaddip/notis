// MESH_INTERFACE → Block gossip → "A mesh service is a gossip peer of its own
// node" / "One router, net's rules" / "A block is checked before it is
// forwarded, and never applied" — the mesh service runs gossipsub on the
// ordering-block topic alone, dials its own node (when `nodeP2p` is set) as a
// gossip peer, and relays a block its validator Accepts without applying it.
// A block that fails Stage 1 is never forwarded and no penalty against the mesh
// node's peer id is recorded by the node beside it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  computeUtxoTxRoot,
  encodeOrderingBlock,
  generateKeyPair,
  hexToBytes,
  MAGIC_DEVNET,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, UtxoTxTree } from '@dagsocial/types';
import {
  blockHash,
  verifyHeaderFieldDomains,
  verifyOrderingBlockPoW,
  verifyOrderingBlockStructure,
  verifyPostBody,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxSignatures,
  verifyTxStructure,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import { NetNode } from '@dagsocial/net';
import type { NetConfig, NetValidators } from '@dagsocial/net';
import { blockTopic } from '../src/gossip-rules.js';
import { nodeKeyFromKeyPair } from '../src/identity.js';
import type { NodeKey } from '../src/identity.js';
import { startMeshNode, type MeshNode } from '../src/node/mesh-node.js';
import { MeshConfigError } from '../src/config.js';
import { makeBlockAt } from './helpers/devnet-block.js';
import {
  startPlainGossipsubHost,
  type PlainGossipsubHost,
} from './helpers/plain-gossipsub-host.js';

// NET_INTERFACE → Handshake / Sync State Machine — a short request timeout
// keeps the handshake deadline tight; the mesh is reached in well under this.
const SYNC_REQUEST_TIMEOUT_MS = 2_000;
const MESH_WAIT_MS = 30_000;

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

function makeNetConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    magic: MAGIC_DEVNET,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    orderingBlockPowTargetFloorBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 10,
    minPeers: 0,
    peerDbCap: 1_000,
    outboundRedialCooldownMs: 60_000,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltyDecayIntervalMs: 120_000,
    syncRequestTimeoutMs: SYNC_REQUEST_TIMEOUT_MS,
    ...overrides,
  };
}

interface Stub { srv: Server; base: string }
async function makeStub(): Promise<Stub> {
  const srv = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', url: req.url }));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

function freshKey(): NodeKey {
  return nodeKeyFromKeyPair(generateKeyPair());
}

function netNodeTcpAddrNoP2p(node: NetNode): string {
  const addrs = node.libp2pNode?.getMultiaddrs() ?? [];
  const first = addrs[0]?.toString();
  if (!first) throw new Error('NetNode has no listen address');
  const p = first.indexOf('/p2p/');
  return p >= 0 ? first.slice(0, p) : first;
}

function meshTcpAddr(node: MeshNode): string {
  const addrs = node.libp2p.getMultiaddrs().map((a) => a.toString());
  const tcp = addrs.find((a) => /^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/p2p\//.test(a));
  if (!tcp) throw new Error(`mesh node has no loopback TCP addr: ${addrs.join(', ')}`);
  return tcp;
}

interface MeshPeerQuery {
  getMeshPeers(topic: string): string[];
}

function pubsubOf(libp2p: {
  services: unknown;
}): MeshPeerQuery {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (libp2p.services as any).pubsub as MeshPeerQuery;
}

/**
 * A valid devnet ordering block mined under the floor, with the validator
 * signature overwritten by 64 random bytes so `verifyValidatorSignature`
 * fails. The PoW stands; the signature does not. The mesh service's topic
 * validator Rejects it (NET_INTERFACE → Stage 1 → "A worked header is
 * forwarded with the body its root commits" — the signature check runs
 * before the body root check).
 */
function badSignatureBlock(): OrderingBlock {
  const good = makeBlockAt(1, PROTOCOL_VERSION);
  // Random 64 bytes — vanishingly unlikely to be a valid signature over the
  // header hash. ed25519 verify rejects it.
  const bad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bad[i] = (i * 37 + 11) & 0xff;
  return { ...good, validatorSignature: bad };
}

/** A valid devnet ordering block signed by a fresh key, no node needed. */
function freshValidBlock(): OrderingBlock {
  const kp = generateKeyPair();
  const seed = kp.secretKey.subarray(16);
  const tree: UtxoTxTree = {
    utxoTxIds: ['11'.repeat(32)],
    utxoTxs: [new Uint8Array(96).fill(0x11)],
  };
  const base: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: computeUtxoTxRoot(tree),
    stateRoot: '00'.repeat(33),
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 2_000_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  let header = base;
  for (let n = 0; n < 1_000_000; n++) {
    const h = { ...base, powNonce: n };
    if (verifyOrderingBlockPoW(h)) { header = h; break; }
  }
  const hash = blockHash(header);
  if (hash === null) throw new Error('freshValidBlock: header outside the encodable domain');
  const sig = ed25519.sign(hexToBytes(hash), seed);
  return { header, utxoTxTree: tree, validatorSignature: sig };
}

async function waitFor(cond: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  await vi.waitFor(cond, { timeout: timeoutMs, interval: 100 });
}

describe('mesh node — the block router', () => {
  const openMeshNodes: MeshNode[] = [];
  const openNetNodes: NetNode[] = [];
  const openHosts: PlainGossipsubHost[] = [];
  const stubs: Stub[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (openHosts.length > 0) {
      const h = openHosts.pop();
      if (h) await h.stop();
    }
    while (openMeshNodes.length > 0) {
      const n = openMeshNodes.pop();
      if (n) { try { await n.stop(); } catch { /* already stopped */ } }
    }
    while (openNetNodes.length > 0) {
      const n = openNetNodes.pop();
      if (n) { try { await n.stop(); } catch { /* already stopped */ } }
    }
    for (const s of stubs) { s.srv.close(); }
    stubs.length = 0;
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); }
    dirs.length = 0;
  });

  async function startBasicMesh(opts: { nodeP2p?: string }): Promise<MeshNode> {
    const stub = await makeStub(); stubs.push(stub);
    const dir = mkdtempSync(join(tmpdir(), 'mesh-gossip-')); dirs.push(dir);
    const options = {
      key: freshKey(),
      network: 'devnet' as const,
      role: 'public' as const,
      listen: ['/ip4/127.0.0.1/tcp/0'],
      bootstrap: [] as string[],
      stateDir: dir,
      upstream: stub.base,
      ...(opts.nodeP2p !== undefined ? { nodeP2p: opts.nodeP2p } : {}),
    };
    const node = await startMeshNode(options);
    openMeshNodes.push(node);
    return node;
  }

  it(
    'a mesh node with nodeP2p peers with a NetNode and relays its block to a host',
    async () => {
      const magic = MAGIC_DEVNET;
      const netNode = new NetNode(makeNetConfig(), validators);
      await netNode.start();
      openNetNodes.push(netNode);

      const nodeAddr = netNodeTcpAddrNoP2p(netNode);
      const mesh = await startBasicMesh({ nodeP2p: nodeAddr });

      const host = await startPlainGossipsubHost(magic);
      openHosts.push(host);

      // The host dials the mesh node's loopback TCP address; the mesh node
      // learns the host's peer id at Noise.
      const meshAddr = meshTcpAddr(mesh);
      const { multiaddr } = await import('@multiformats/multiaddr');
      await host.libp2p.dial(multiaddr(meshAddr));

      const topic = blockTopic(magic);
      const meshPubsub = pubsubOf(mesh.libp2p);
      const hostPubsub = pubsubOf(host.libp2p);
      const netNodePubsub = pubsubOf(netNode.libp2pNode as unknown as { services: unknown });

      await waitFor(
        () => {
          expect(meshPubsub.getMeshPeers(topic)).toContain(host.libp2p.peerId.toString());
          expect(hostPubsub.getMeshPeers(topic)).toContain(mesh.libp2p.peerId.toString());
          expect(meshPubsub.getMeshPeers(topic)).toContain(netNode.peerId());
          expect(netNodePubsub.getMeshPeers(topic)).toContain(mesh.libp2p.peerId.toString());
        },
        MESH_WAIT_MS,
      );

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      await netNode.broadcastOrderingBlock(block);

      await waitFor(
        () => { expect(host.received.length).toBeGreaterThan(0); },
        15_000,
      );
      const received = host.received[0]!;
      const bytes = new Uint8Array(received.buffer, received.byteOffset, received.byteLength);
      expect(bytes).toEqual(encodeOrderingBlock(block));
    },
    90_000,
  );

  it(
    'a mesh node with no nodeP2p relays a valid block between two hosts',
    async () => {
      const magic = MAGIC_DEVNET;
      const mesh = await startBasicMesh({});

      const hostA = await startPlainGossipsubHost(magic);
      openHosts.push(hostA);
      const hostB = await startPlainGossipsubHost(magic);
      openHosts.push(hostB);

      const meshAddr = meshTcpAddr(mesh);
      const { multiaddr } = await import('@multiformats/multiaddr');
      await hostA.libp2p.dial(multiaddr(meshAddr));
      await hostB.libp2p.dial(multiaddr(meshAddr));

      const topic = blockTopic(magic);
      const meshPubsub = pubsubOf(mesh.libp2p);
      await waitFor(
        () => {
          expect(meshPubsub.getMeshPeers(topic)).toContain(hostA.libp2p.peerId.toString());
          expect(meshPubsub.getMeshPeers(topic)).toContain(hostB.libp2p.peerId.toString());
        },
        MESH_WAIT_MS,
      );

      const block = freshValidBlock();
      await hostA.publish(encodeOrderingBlock(block));

      await waitFor(
        () => { expect(hostB.received.length).toBeGreaterThan(0); },
        15_000,
      );
      const received = hostB.received[0]!;
      const bytes = new Uint8Array(received.buffer, received.byteOffset, received.byteLength);
      expect(bytes).toEqual(encodeOrderingBlock(block));
    },
    90_000,
  );

  it(
    'a block failing its checks is not forwarded',
    async () => {
      const magic = MAGIC_DEVNET;
      const netNode = new NetNode(makeNetConfig(), validators);
      await netNode.start();
      openNetNodes.push(netNode);

      const penalised: Array<{ peerId: string; kind: string; detail: string | null }> = [];
      netNode.onPeerPenalised((peerId, kind, detail) => {
        penalised.push({ peerId, kind, detail });
      });

      const nodeAddr = netNodeTcpAddrNoP2p(netNode);
      const mesh = await startBasicMesh({ nodeP2p: nodeAddr });

      const hostA = await startPlainGossipsubHost(magic);
      openHosts.push(hostA);
      const hostB = await startPlainGossipsubHost(magic);
      openHosts.push(hostB);

      const { multiaddr } = await import('@multiformats/multiaddr');
      const meshAddr = meshTcpAddr(mesh);
      await hostA.libp2p.dial(multiaddr(meshAddr));
      await hostB.libp2p.dial(multiaddr(meshAddr));

      const topic = blockTopic(magic);
      const meshPubsub = pubsubOf(mesh.libp2p);
      const netNodePubsub = pubsubOf(netNode.libp2pNode as unknown as { services: unknown });
      await waitFor(
        () => {
          expect(meshPubsub.getMeshPeers(topic)).toContain(hostA.libp2p.peerId.toString());
          expect(meshPubsub.getMeshPeers(topic)).toContain(hostB.libp2p.peerId.toString());
          expect(meshPubsub.getMeshPeers(topic)).toContain(netNode.peerId());
          expect(netNodePubsub.getMeshPeers(topic)).toContain(mesh.libp2p.peerId.toString());
        },
        MESH_WAIT_MS,
      );

      const bad = badSignatureBlock();
      await hostA.publish(encodeOrderingBlock(bad));

      // Give the mesh node ample time to forward (it never will); 5 s is
      // several heartbeats and more than one round trip. The forwarded
      // message, if it happened, would be delivered to host B in that window.
      await new Promise((r) => setTimeout(r, 5_000));

      expect(hostB.received).toHaveLength(0);

      const meshPeerIdStr = mesh.libp2p.peerId.toString();
      const meshPenalties = penalised.filter((p) => p.peerId === meshPeerIdStr);
      expect(meshPenalties).toEqual([]);
    },
    90_000,
  );

  it(
    'a nodeP2p with a /p2p/ component is refused before libp2p starts',
    async () => {
      const stub = await makeStub(); stubs.push(stub);
      const dir = mkdtempSync(join(tmpdir(), 'mesh-gossip-refuse-')); dirs.push(dir);
      const bogus =
        '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWJqB2fQ8qQmQL8aQW5EcW9f3S3B8gKjcGtg5WwTR6a4Yx';
      let started: MeshNode | null = null;
      let thrown: unknown = null;
      const options = {
        key: freshKey(),
        network: 'devnet' as const,
        role: 'public' as const,
        listen: ['/ip4/127.0.0.1/tcp/0'],
        bootstrap: [] as string[],
        stateDir: dir,
        upstream: stub.base,
        nodeP2p: bogus,
      };
      try {
        started = await startMeshNode(options);
      } catch (e) {
        thrown = e;
      } finally {
        if (started) { try { await started.stop(); } catch { /* already stopped */ } }
      }
      expect(thrown).toBeInstanceOf(MeshConfigError);
      expect((thrown as Error).message).toContain('/p2p/');
    },
    30_000,
  );
});
