import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  generateKeyPair,
  computeUtxoTxRoot,
  encodeOrderingBlock,
  hexToBytes,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  MAGIC_DEVNET,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  OrderingBlock,
  BlockHeader,
  UtxoTxTree,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyHeaderFieldDomains,
  verifyOrderingBlockStructure,
  verifyValidatorSignature,
  verifyUtxoTxRoot,
  verifyPostBody,
  blockHash,
} from '@dagsocial/validation';
import { NetNode, HANDSHAKE_DEADLINE_FACTOR } from '@dagsocial/net';
import type { NetConfig, NetValidators } from '@dagsocial/net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@libp2p/gossipsub';
import { blockTopic, gossipsubOptions } from '../src/gossip-rules.js';
import { startNodePeer, type NodePeer } from '../src/node/node-peer.js';

// MESH_INTERFACE → Block gossip — the mesh service dials its node's libp2p
// TCP address (no `/p2p/`), runs net's handshake as the dialler, subscribes
// to the ordering-block topic alone and publishes nothing. The three cases
// below measure, against a real NetNode, that the node keeps the host as
// a peer unpenalised, that a broadcast ordering block arrives on the
// topic, and that a restarted node is dialled again.

const SYNC_REQUEST_TIMEOUT_MS = 2_000;
// NET_INTERFACE → Handshake → "A connection handshakes within its deadline,
// or is closed": the deadline for one connection is this factor × the
// request timeout.
const HANDSHAKE_DEADLINE_MS =
  HANDSHAKE_DEADLINE_FACTOR * SYNC_REQUEST_TIMEOUT_MS;
// NET_INTERFACE → Sync State Machine — this node sends its own `SyncInfo` to
// every Active peer at peer-active and every SYNCED_POLL_INTERVAL_MS (30 s).
const SYNCED_POLL_INTERVAL_MS = 30_000;
// Past peer-active + 2 × SYNCED_POLL_INTERVAL_MS is where "two rounds past"
// is measured.
const TWO_ROUNDS_WAIT_MS = 2 * SYNCED_POLL_INTERVAL_MS + 2_000;

const CASE_TIMEOUT_MS = TWO_ROUNDS_WAIT_MS + 30_000;

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

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  // Devnet magic matches the mesh client's own default (`MESH_INTERFACE → The
  // mesh URL`), and the floor is types' `ORDERING_BLOCK_POW_TARGET_FLOOR`.
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

// Pick a free TCP port by opening a loopback listener on 0 and reading its
// port before closing. A tiny race window the caller tolerates.
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// VALIDATION_INTERFACE → verifyOrderingBlockStructure requires at least one
// settlement tx id and payload. A fresh validator key per fixture so the
// signature matches the header the fixture mines.
function makeBlockAt(height: number, protocolVersion: number): OrderingBlock {
  const kp = generateKeyPair();
  const seed = kp.secretKey.subarray(16);
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
  };
  const base: BlockHeader = {
    protocolVersion,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: '00'.repeat(33),
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  let header: BlockHeader | null = null;
  for (let n = 0; n < 1_000_000; n++) {
    const h = { ...base, powNonce: n };
    if (verifyOrderingBlockPoW(h)) {
      header = h;
      break;
    }
  }
  if (!header) throw new Error('could not mine header at the network floor');
  const hash = blockHash(header);
  if (hash === null) throw new Error('header outside encodable domain');
  const validatorSignature = ed25519.sign(hexToBytes(hash), seed);
  return { header, utxoTxTree, validatorSignature };
}

interface Host {
  libp2p: Libp2p;
  received: Uint8Array[];
}

async function startHost(magic: number): Promise<Host> {
  const received: Uint8Array[] = [];
  const libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionMonitor: { enabled: false },
    services: {
      identify: identify(),
      pubsub: gossipsub(gossipsubOptions(magic)),
    },
  });
  // Subscribe to the ordering-block topic — the only topic the mesh
  // service and the client hear (MESH_INTERFACE → Block gossip → "One
  // router, net's rules").
  const topic = blockTopic(magic);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (libp2p.services as any).pubsub.subscribe(topic);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (libp2p.services as any).pubsub.addEventListener(
    'gossipsub:message',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ev: any) => {
      const msg = ev.detail?.msg;
      if (msg && msg.topic === topic) received.push(msg.data);
    },
  );
  return { libp2p, received };
}

function nodeTcpAddrNoP2p(node: NetNode): string {
  const addrs = node.libp2pNode?.getMultiaddrs() ?? [];
  const first = addrs[0]?.toString();
  if (!first) throw new Error('node has no listen address');
  // Strip the /p2p/<peer> tail — MESH_INTERFACE → Block gossip:
  // "the node's peer id is learnt at the link".
  const p = first.indexOf('/p2p/');
  return p >= 0 ? first.slice(0, p) : first;
}

interface MeshPeer {
  getMeshPeers(topic: string): string[];
}

async function waitForMeshWith(
  host: Host,
  node: NetNode,
  magic: number,
  timeoutMs: number,
): Promise<void> {
  const topic = blockTopic(magic);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hostPubsub = (host.libp2p.services as any).pubsub as MeshPeer;
  const nodePubsub = (node.libp2pNode as unknown as {
    services: { pubsub: MeshPeer };
  }).services.pubsub;
  const nodePeerId = node.peerId();
  const hostPeerId = host.libp2p.peerId.toString();
  await vi.waitFor(
    () => {
      expect(hostPubsub.getMeshPeers(topic)).toContain(nodePeerId);
      expect(nodePubsub.getMeshPeers(topic)).toContain(hostPeerId);
    },
    { timeout: timeoutMs, interval: 100 },
  );
}

describe('startNodePeer against a real NetNode', () => {
  const openNodes: NetNode[] = [];
  const openHosts: Host[] = [];
  const openPeers: NodePeer[] = [];

  afterEach(async () => {
    while (openPeers.length > 0) {
      const p = openPeers.pop();
      await p?.stop();
    }
    while (openNodes.length > 0) {
      const n = openNodes.pop();
      await n?.stop();
    }
    while (openHosts.length > 0) {
      const h = openHosts.pop();
      await h?.libp2p.stop();
    }
  });

  it.fails(
    'the node holds the peer Active past the handshake deadline and two SyncInfo rounds',
    async () => {
      const magic = MAGIC_DEVNET;
      const node = new NetNode(makeConfig(), validators);
      await node.start();
      openNodes.push(node);

      const penalised: Array<{ peerId: string; kind: string; detail: string | null }> = [];
      node.onPeerPenalised((peerId, kind, detail) => {
        penalised.push({ peerId, kind, detail });
      });

      const host = await startHost(magic);
      openHosts.push(host);

      const peer = startNodePeer(host.libp2p, {
        nodeP2p: nodeTcpAddrNoP2p(node),
        magic,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-1',
      });
      openPeers.push(peer);

      // Reach Active first.
      await vi.waitFor(
        () => {
          expect(node.getConnectedPeers()).toContain(host.libp2p.peerId.toString());
        },
        { timeout: 15_000, interval: 100 },
      );

      // Past the handshake deadline, the Active peer stays Active.
      await new Promise((r) => setTimeout(r, HANDSHAKE_DEADLINE_MS + 2_000));
      expect(node.getConnectedPeers()).toContain(host.libp2p.peerId.toString());

      // Past two SyncInfo rounds the peer still stands and has not been
      // penalised. The sync machine dials SYNC_PROTOCOL on the host; the
      // host registers no sync handler, so the dial fails with CODE_UNSUPPORTED
      // and net's sendToPeer swallows the catch — no penalty is accrued.
      await new Promise((r) => setTimeout(r, TWO_ROUNDS_WAIT_MS));
      expect(node.getConnectedPeers()).toContain(host.libp2p.peerId.toString());
      const hostPenalties = penalised.filter(
        (p) => p.peerId === host.libp2p.peerId.toString(),
      );
      expect(hostPenalties).toEqual([]);
      expect(peer.connected()).toBe(true);
    },
    CASE_TIMEOUT_MS + 20_000,
  );

  it.fails(
    'a block the node broadcasts reaches the host on the topic',
    async () => {
      const magic = MAGIC_DEVNET;
      const node = new NetNode(makeConfig(), validators);
      await node.start();
      openNodes.push(node);

      const host = await startHost(magic);
      openHosts.push(host);

      const peer = startNodePeer(host.libp2p, {
        nodeP2p: nodeTcpAddrNoP2p(node),
        magic,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-2',
      });
      openPeers.push(peer);

      // Wait for the gossipsub mesh to form on both sides before the
      // broadcast — a message published to zero mesh peers is heard by
      // no one.
      await waitForMeshWith(host, node, magic, 30_000);

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      await node.broadcastOrderingBlock(block);

      await vi.waitFor(
        () => {
          expect(host.received.length).toBeGreaterThan(0);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(host.received[0]).toEqual(encodeOrderingBlock(block));
    },
    60_000,
  );

  it.fails(
    'a restarted node is dialled again',
    async () => {
      const magic = MAGIC_DEVNET;
      // Pick a free port and bind both NetNode instances to it, so the
      // bare TCP address survives the restart. The host dials the same
      // address and learns the new peer id at Noise.
      const port = await pickFreePort();
      const listenAddrs = `/ip4/127.0.0.1/tcp/${port}`;
      const node1 = new NetNode(makeConfig({ listenAddrs }), validators);
      await node1.start();
      openNodes.push(node1);

      const host = await startHost(magic);
      openHosts.push(host);

      const nodeAddr = nodeTcpAddrNoP2p(node1);
      const peer = startNodePeer(host.libp2p, {
        nodeP2p: nodeAddr,
        magic,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-3',
        retryMs: 500,
      });
      openPeers.push(peer);

      await vi.waitFor(
        () => {
          expect(peer.connected()).toBe(true);
          expect(node1.getConnectedPeers()).toContain(host.libp2p.peerId.toString());
        },
        { timeout: 15_000, interval: 100 },
      );

      // Stop node1; the connection drops.
      openNodes.pop();
      await node1.stop();

      await vi.waitFor(
        () => {
          expect(peer.connected()).toBe(false);
        },
        { timeout: 10_000, interval: 100 },
      );

      // Start a new NetNode on the same port, new key.
      const node2 = new NetNode(makeConfig({ listenAddrs }), validators);
      await node2.start();
      openNodes.push(node2);

      // The host redials the bare address and the handshake completes
      // against the new peer id.
      await vi.waitFor(
        () => {
          expect(peer.connected()).toBe(true);
          expect(node2.getConnectedPeers()).toContain(host.libp2p.peerId.toString());
        },
        { timeout: 20_000, interval: 100 },
      );
      // The two nodes carry different peer ids — the host learned each
      // at Noise.
      expect(node2.peerId()).not.toBe(node1.peerId());
    },
    60_000,
  );
});
