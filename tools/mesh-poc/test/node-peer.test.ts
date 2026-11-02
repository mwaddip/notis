import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import {
  encodeOrderingBlock,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  MAGIC_DEVNET,
  PROTOCOL_VERSION,
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
} from '@dagsocial/validation';
import { NetNode, HANDSHAKE_DEADLINE_FACTOR } from '@dagsocial/net';
import type { NetConfig, NetValidators } from '@dagsocial/net';
import type { Connection } from '@libp2p/interface';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@libp2p/gossipsub';
import { blockTopic, gossipsubOptions } from '../src/gossip-rules.js';
import { startNodePeer, type NodePeer } from '../src/node/node-peer.js';
import { HANDSHAKE_PROTOCOL } from '@dagsocial/net';
import { makeBlockAt } from './helpers/devnet-block.js';

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

  it(
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

  it(
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
      // Compare as plain Uint8Array — libp2p may hand the data as a
      // Node `Buffer`, which `toEqual` serialises differently.
      const received = host.received[0]!;
      const bytes = new Uint8Array(
        received.buffer,
        received.byteOffset,
        received.byteLength,
      );
      expect(bytes).toEqual(encodeOrderingBlock(block));
    },
    60_000,
  );

  it(
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
      const node1PeerId = node1.peerId();
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
      // at Noise. `node1`'s peer id was captured before it stopped.
      expect(node2.peerId()).not.toBe(node1PeerId);
    },
    60_000,
  );

  it(
    'an unrelated connection closing leaves the node connection as it is',
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

      const nodePeerIdObj = node.libp2pNode!.peerId;

      // Park the first dial to the node so the unrelated close lands
      // while the first `connectOnce` is still in flight.
      const nodeAddr = nodeTcpAddrNoP2p(node);
      const originalDial = host.libp2p.dial.bind(host.libp2p);
      let releasePark: () => void = () => {};
      const park = new Promise<void>((r) => { releasePark = r; });
      let firstDialSeenResolve: () => void = () => {};
      const firstDialSeen = new Promise<void>((r) => { firstDialSeenResolve = r; });
      let nodeDialSeen = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (host.libp2p as any).dial = async function (addr: any, options?: any) {
        if (typeof addr?.toString === 'function' && addr.toString().startsWith(nodeAddr)) {
          const n = ++nodeDialSeen;
          if (n === 1) { firstDialSeenResolve(); await park; }
        }
        return originalDial(addr, options);
      };

      const retryMs = 50;
      const peer = startNodePeer(host.libp2p, {
        nodeP2p: nodeAddr,
        magic,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-unrelated-close',
        retryMs,
      });
      openPeers.push(peer);

      // Wait until the first dial has entered the park.
      await firstDialSeen;

      // The host also holds a connection to a third libp2p host; close
      // that one.
      const third = await startHost(magic);
      openHosts.push(third);
      const thirdAddr = third.libp2p.getMultiaddrs()[0];
      if (!thirdAddr) throw new Error('third host has no listen address');
      await originalDial(thirdAddr);
      await host.libp2p.hangUp(third.libp2p.peerId);

      // Across two retryMs, let any wasted redial fire.
      await new Promise((r) => setTimeout(r, 2 * retryMs + 100));

      // Release the park; the first dial proceeds.
      releasePark();

      await vi.waitFor(
        () => { expect(peer.connected()).toBe(true); },
        { timeout: 15_000, interval: 50 },
      );

      // Capture the connection the host now holds to the node.
      const connsFirst = host.libp2p.getConnections(nodePeerIdObj);
      expect(connsFirst).toHaveLength(1);
      const connIdFirst = connsFirst[0]!.id;

      // Across two retryMs, the connection is unchanged.
      await new Promise((r) => setTimeout(r, 2 * retryMs + 200));

      const connsAfter = host.libp2p.getConnections(nodePeerIdObj);
      expect(connsAfter).toHaveLength(1);
      expect(connsAfter[0]!.id).toBe(connIdFirst);
      expect(node.getConnectedPeers()).toContain(host.libp2p.peerId.toString());

      const hostPenalties = penalised.filter(
        (p) => p.peerId === host.libp2p.peerId.toString(),
      );
      expect(hostPenalties).toEqual([]);
    },
    60_000,
  );

  it(
    'a redial that fires during a dial opens no second handshake',
    async () => {
      const magic = MAGIC_DEVNET;
      const node = new NetNode(makeConfig(), validators);
      await node.start();
      openNodes.push(node);

      const host = await startHost(magic);
      openHosts.push(host);

      const nodePeerIdStr = node.peerId();
      const nodePeerIdObj = node.libp2pNode!.peerId;

      // Count every connection the host opened to the node and every
      // close of one — a double-handshake race drops the shared
      // connection and shows as both a close and a second open.
      const openedToNode: string[] = [];
      const closedToNode: string[] = [];
      host.libp2p.addEventListener('connection:open', ((
        ev: CustomEvent<Connection>,
      ) => {
        const c = ev.detail;
        if (c && c.remotePeer.toString() === nodePeerIdStr) openedToNode.push(c.id);
      }) as EventListener);
      host.libp2p.addEventListener('connection:close', ((
        ev: CustomEvent<Connection>,
      ) => {
        const c = ev.detail;
        if (c && c.remotePeer.toString() === nodePeerIdStr) closedToNode.push(c.id);
      }) as EventListener);

      // Park the first dial so several unrelated closes land while
      // the first handshake is in flight.
      const nodeAddr = nodeTcpAddrNoP2p(node);
      const originalDial = host.libp2p.dial.bind(host.libp2p);
      let releasePark: () => void = () => {};
      const park = new Promise<void>((r) => { releasePark = r; });
      let firstDialSeenResolve: () => void = () => {};
      const firstDialSeen = new Promise<void>((r) => { firstDialSeenResolve = r; });
      let nodeDialSeen = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (host.libp2p as any).dial = async function (addr: any, options?: any) {
        if (typeof addr?.toString === 'function' && addr.toString().startsWith(nodeAddr)) {
          const n = ++nodeDialSeen;
          if (n === 1) { firstDialSeenResolve(); await park; }
        }
        return originalDial(addr, options);
      };

      const retryMs = 20;
      const peer = startNodePeer(host.libp2p, {
        nodeP2p: nodeAddr,
        magic,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-in-flight',
        retryMs,
      });
      openPeers.push(peer);

      // Wait until the first dial has entered the park.
      await firstDialSeen;

      // Drive several `connection:close` events from unrelated libp2p
      // hosts while the first handshake is in flight. Each close, on
      // today's code, schedules a redial; the timer fires inside the
      // handshake window and runs a second `connectOnce` in parallel.
      for (let i = 0; i < 3; i++) {
        const other = await startHost(magic);
        openHosts.push(other);
        const otherAddr = other.libp2p.getMultiaddrs()[0];
        if (!otherAddr) throw new Error('other host has no listen address');
        await originalDial(otherAddr);
        await host.libp2p.hangUp(other.libp2p.peerId);
        await new Promise((r) => setTimeout(r, 2 * retryMs + 20));
      }

      // Release the park; the first dial proceeds.
      releasePark();

      await vi.waitFor(
        () => { expect(peer.connected()).toBe(true); },
        { timeout: 15_000, interval: 50 },
      );

      // Give the induced race (if any) time to resolve.
      await new Promise((r) => setTimeout(r, 2 * retryMs + 500));

      // The handshake completes once: one connection ever opened to
      // the node.
      expect(openedToNode).toHaveLength(1);
      // The node connection is never closed by the peer.
      expect(closedToNode).toEqual([]);
      // The host still holds the connection, and `connected()` is true.
      expect(host.libp2p.getConnections(nodePeerIdObj)).toHaveLength(1);
      expect(peer.connected()).toBe(true);
    },
    60_000,
  );

  it(
    'an address with /p2p/ or a DNS name is refused at the call',
    async () => {
      const host = await startHost(MAGIC_DEVNET);
      openHosts.push(host);

      // Capture every call to libp2p.dial — a refused address never
      // reaches it.
      let dialsAttempted = 0;
      const originalDial = host.libp2p.dial.bind(host.libp2p);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (host.libp2p as any).dial = async function (addr: any, options?: any) {
        dialsAttempted++;
        return originalDial(addr, options);
      };

      const common = {
        magic: MAGIC_DEVNET,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-address',
      };

      // `/p2p/` component — the contract names the address with no `/p2p/`.
      expect(() =>
        startNodePeer(host.libp2p, {
          ...common,
          nodeP2p:
            '/ip4/127.0.0.1/tcp/0/p2p/12D3KooWJqB2fQ8qQmQL8aQW5EcW9f3S3B8gKjcGtg5WwTR6a4Yx',
        }),
      ).toThrow();

      // `/dns4/`.
      expect(() =>
        startNodePeer(host.libp2p, { ...common, nodeP2p: '/dns4/example.com/tcp/4001' }),
      ).toThrow();

      // `/dns6/`.
      expect(() =>
        startNodePeer(host.libp2p, { ...common, nodeP2p: '/dns6/example.com/tcp/4001' }),
      ).toThrow();

      // `/dnsaddr/`.
      expect(() =>
        startNodePeer(host.libp2p, { ...common, nodeP2p: '/dnsaddr/example.com' }),
      ).toThrow();

      expect(dialsAttempted).toBe(0);
    },
    30_000,
  );

  it(
    'a node that never answers the handshake is left at the deadline and dialled again',
    async () => {
      // NET_INTERFACE → Handshake → "A connection handshakes within its
      // deadline, or is closed". A stall host accepts the handshake stream,
      // reads the inbound frame, and never writes or closes — the dialler's
      // read is the one that must end.
      const stallLibp2p = await createLibp2p({
        addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        connectionMonitor: { enabled: false },
        services: { identify: identify() },
      });
      openHosts.push({ libp2p: stallLibp2p, received: [] });

      let handlerEntries = 0;
      const handlerDone = new Set<number>();
      let firstHandlerEnd: 'eof' | 'error' | null = null;
      await stallLibp2p.handle(HANDSHAKE_PROTOCOL, (stream): void => {
        const entry = ++handlerEntries;
        const iter = stream as unknown as AsyncIterable<unknown>;
        void (async () => {
          try {
            // Drain the inbound frame then stay here, reading nothing more.
            // The remote end is the one that ends this iteration — either
            // by aborting the stream (handler sees error) or closing the
            // connection (handler sees EOF).
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _chunk of iter) { /* drop */ }
            if (entry === 1) firstHandlerEnd = 'eof';
          } catch {
            if (entry === 1) firstHandlerEnd = 'error';
          } finally {
            handlerDone.add(entry);
          }
        })();
      });

      const host = await startHost(MAGIC_DEVNET);
      openHosts.push(host);

      const maddr = stallLibp2p.getMultiaddrs()[0]?.toString();
      if (!maddr) throw new Error('stall host has no listen address');
      const p = maddr.indexOf('/p2p/');
      const stallAddr = p >= 0 ? maddr.slice(0, p) : maddr;

      const opts = {
        nodeP2p: stallAddr,
        magic: MAGIC_DEVNET,
        protocolVersion: PROTOCOL_VERSION,
        nodeName: 'mesh-service-case-stall',
        retryMs: 200,
        handshakeTimeoutMs: 1_000,
      };
      const peer = startNodePeer(host.libp2p, opts);
      openPeers.push(peer);

      // Within ~3 s, the handler is entered at least twice — the first was
      // left at the deadline and the dialler redialled.
      await vi.waitFor(
        () => { expect(handlerEntries).toBeGreaterThanOrEqual(2); },
        { timeout: 3_000, interval: 50 },
      );

      // The dialler never records a connection as the peer's.
      expect(peer.connected()).toBe(false);

      // The first stream ended for the stall handler at EOF: we half-close
      // the writable side with `stream.close()` before the stall, so the
      // handler drains the frame and sees EOF when its for-await ends. The
      // read-deadline abort is observable on the dialler's side alone (its
      // pending read rejects), and is what frees `connectOnce` to redial.
      expect(handlerDone.has(1)).toBe(true);
      expect(firstHandlerEnd).toBe('eof');
    },
    30_000,
  );
});
