import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateKeyPair,
  computeContentHash,
  encodeOrderingBlock,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  MAGIC_DEVNET,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  PostCommit,
  UtxoTransaction,
  OrderingBlock,
  BlockHeader,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
} from '@dagsocial/validation';
import { TopicValidatorResult } from '@libp2p/interface';
import type { PubSub } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import type { GossipsubEvents } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import {
  GOSSIP_SEEN_WINDOW_MS,
  gossipMessageId,
} from '../src/gossip.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// NET_INTERFACE → Gossip Topics
// NET_INTERFACE → Gossip Topics → "A topic is named for its network"
// NET_INTERFACE → Gossip Topics → "A message is its topic and its data"
// NET_INTERFACE → Gossip Topics → "A message is named by its bytes"
// NET_INTERFACE → Gossip Topics → "A message is heard once in a seen window"
// NET_INTERFACE → Gossip → "A broadcast that sends nothing still resolves"
// NET_INTERFACE → Inbound Processing →
//   "A gossip message that passes Stage 1 is delivered, whichever peer carried it"
// NET_INTERFACE → Peer State Machine

// Timeout per case. Libp2p needs seconds for TCP, Noise, identify, our
// handshake and the gossipsub mesh heartbeat (NET_INTERFACE → libp2p Stack).
const TIMEOUT = 25_000;

// A fixed quiet after the last expected event. One gossipsub heartbeat is a
// second; two heartbeats hold a "nothing more arrives" count — a second copy
// of the same bytes, a subscription record a peer would announce, a validator
// the router would reach.
const SETTLE_HEARTBEATS = 2;
const SETTLE_MS = SETTLE_HEARTBEATS * 1_000;

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
};

// Every node binds loopback-only, so each handshake's `declaredAddress` is
// absent (NET_INTERFACE → Handshake Body). No peer learns a dialable address
// for any other, so PeerDb cannot seed the Fill phase that would close a line
// into a triangle (NET_INTERFACE → Outbound Manager → "Fill phase").
function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    minPeers: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Router seams — read the topic strings and wrap a validator in place.
// NET_INTERFACE → libp2p Stack.
// ---------------------------------------------------------------------------

interface GossipsubMessage {
  propagationSource: unknown;
  msgId: string;
  msg: {
    topic: string;
    data: Uint8Array;
    type?: 'signed' | 'unsigned';
    from?: unknown;
    sequenceNumber?: bigint;
    signature?: Uint8Array;
    key?: unknown;
  };
}

interface PubSubShape {
  getTopics(): string[];
  getSubscribers(topic: string): Array<{ toString(): string }>;
  getMeshPeers(topic: string): string[];
  subscribe(topic: string): void;
  topicValidators: Map<
    string,
    (peer: unknown, msg: { data: Uint8Array }) =>
      TopicValidatorResult | Promise<TopicValidatorResult>
  >;
  addEventListener(
    type: 'gossipsub:message',
    handler: (ev: CustomEvent<GossipsubMessage>) => void,
  ): void;
}

function pubsubOf(node: NetNode): PubSubShape {
  const lp = node.libp2pNode;
  if (!lp) throw new Error('node is not started');
  return (lp as unknown as { services: { pubsub: PubSubShape } }).services.pubsub;
}

// The two topic strings a node's router is subscribed to, read off the live
// pubsub by their endings — not built here by the function under test.
function topicsOf(node: NetNode): { orderingBlock: string; tx: string } {
  const ts = pubsubOf(node).getTopics();
  const orderingBlock = ts.find((t) => t.endsWith('/ordering-block/1'));
  const tx = ts.find((t) => t.endsWith('/tx/1'));
  if (!orderingBlock || !tx) {
    throw new Error(`router is not subscribed to both topics: ${JSON.stringify(ts)}`);
  }
  return { orderingBlock, tx };
}

interface Counter {
  count: number;
  lastResult: TopicValidatorResult | null;
}

function newCounter(): Counter {
  return { count: 0, lastResult: null };
}

// Wrap the function the router holds around itself — the wrapper counts and
// calls through, it decides nothing.
function wrapValidator(node: NetNode, topic: string, counter: Counter): void {
  const ps = pubsubOf(node);
  const original = ps.topicValidators.get(topic);
  if (!original) throw new Error(`no topic validator registered for ${topic}`);
  ps.topicValidators.set(topic, async (peer, msg) => {
    counter.count += 1;
    const r = await original(peer, msg);
    counter.lastResult = r;
    return r;
  });
}

// Each neighbour appears in the other's mesh for both topics — the condition
// a gossip publish counts under.
async function waitForMesh(x: NetNode, y: NetNode): Promise<void> {
  await vi.waitFor(
    () => {
      const topicsX = topicsOf(x);
      const topicsY = topicsOf(y);
      expect(pubsubOf(x).getMeshPeers(topicsX.orderingBlock)).toContain(y.peerId());
      expect(pubsubOf(x).getMeshPeers(topicsX.tx)).toContain(y.peerId());
      expect(pubsubOf(y).getMeshPeers(topicsY.orderingBlock)).toContain(x.peerId());
      expect(pubsubOf(y).getMeshPeers(topicsY.tx)).toContain(x.peerId());
    },
    { timeout: 15_000, interval: 100 },
  );
}

// ---------------------------------------------------------------------------
// Block and transaction fixtures
// ---------------------------------------------------------------------------

function mineHeader(base: BlockHeader): BlockHeader {
  for (let n = 0; n < 1_000_000; n++) {
    const h = { ...base, powNonce: n };
    if (verifyOrderingBlockPoW(h)) return h;
  }
  throw new Error('could not mine header at the network floor within 1M nonces');
}

function makeBlockAt(height: number, protocolVersion: number): OrderingBlock {
  const base: BlockHeader = {
    protocolVersion,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  const header = mineHeader(base);
  // VALIDATION_INTERFACE → verifyOrderingBlockStructure requires at least one
  // settlement tx id and payload.
  return {
    header,
    utxoTxTree: {
      utxoTxIds: [height.toString(16).padStart(64, '0')],
      utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
    },
    validatorSignature: new Uint8Array(64),
  };
}

function makePostTxPacket(
  author: Uint8Array,
  content: string,
): { tx: UtxoTransaction; content: string } {
  const commit: PostCommit = {
    contentHash: computeContentHash(content),
    author,
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular' as const,
  };
  const tx: UtxoTransaction = {
    inputs: ['aa'.repeat(32)],
    outputs: [
      { boxType: 'karma', value: 10n, createdAtBlock: 0, owner: author } as never,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: commit,
  };
  return { tx, content };
}

// ---------------------------------------------------------------------------
// A — B pair
// ---------------------------------------------------------------------------

async function startAB(): Promise<{ nodeA: NetNode; nodeB: NetNode }> {
  const nodeA = new NetNode(makeConfig(), validators);
  await nodeA.start();
  const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
  if (!aAddr) throw new Error('A has no listen address');

  const nodeB = new NetNode(makeConfig({ bootstrapPeers: [aAddr] }), validators);
  await nodeB.start();

  await vi.waitFor(
    () => {
      expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
      expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
    },
    { timeout: 15_000, interval: 250 },
  );

  await waitForMesh(nodeA, nodeB);
  return { nodeA, nodeB };
}

// ---------------------------------------------------------------------------
// The line A — B — C: B dials A, C dials B. A and C never dial each other,
// and no path (outbound tick, peer exchange, learned declaredAddress) closes
// the line into a triangle inside the per-case timeout.
// ---------------------------------------------------------------------------

async function startLine(): Promise<{
  nodeA: NetNode;
  nodeB: NetNode;
  nodeC: NetNode;
}> {
  const nodeA = new NetNode(makeConfig(), validators);
  await nodeA.start();
  const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
  if (!aAddr) throw new Error('A has no listen address');

  const nodeB = new NetNode(makeConfig({ bootstrapPeers: [aAddr] }), validators);
  await nodeB.start();
  const bAddr = nodeB.libp2pNode?.getMultiaddrs()[0]?.toString();
  if (!bAddr) throw new Error('B has no listen address');

  const nodeC = new NetNode(makeConfig({ bootstrapPeers: [bAddr] }), validators);
  await nodeC.start();

  await vi.waitFor(
    () => {
      expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
      expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
      expect(nodeB.getConnectedPeers()).toContain(nodeC.peerId());
      expect(nodeC.getConnectedPeers()).toContain(nodeB.peerId());
    },
    { timeout: 15_000, interval: 250 },
  );

  await waitForMesh(nodeA, nodeB);
  await waitForMesh(nodeB, nodeC);

  return { nodeA, nodeB, nodeC };
}

function assertLineIntact(nodeA: NetNode, nodeC: NetNode): void {
  const aConns =
    nodeA.libp2pNode?.getConnections().map((c) => c.remotePeer.toString()) ?? [];
  const cConns =
    nodeC.libp2pNode?.getConnections().map((c) => c.remotePeer.toString()) ?? [];
  expect(aConns).not.toContain(nodeC.peerId());
  expect(cConns).not.toContain(nodeA.peerId());
}

// ---------------------------------------------------------------------------
// Delivery on a line
// ---------------------------------------------------------------------------

describe('Gossip on a line A — B — C', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop();
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  it(
    'one publish by A delivers once at B and runs C\'s validator once (ordering block)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const bDeliveries: OrderingBlock[] = [];
      nodeB.onOrderingBlock((b) => {
        bDeliveries.push(b);
      });
      const cValidator = newCounter();
      const topicsC = topicsOf(nodeC);
      wrapValidator(nodeC, topicsC.orderingBlock, cValidator);

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeA.broadcastOrderingBlock(block);

      await vi.waitFor(() => expect(bDeliveries.length).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect(bDeliveries.length).toBe(1);
      expect(cValidator.count).toBe(1);
      expect(cValidator.lastResult).toBe(TopicValidatorResult.Accept);
    },
    TIMEOUT,
  );

  it(
    'one publish by A delivers once at B and runs C\'s validator once (tx packet)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const kp = generateKeyPair();
      const hex = Buffer.from(kp.publicKey).toString('hex');
      // NODE_INTERFACE → Post transactions: the relay-path gate is a cached
      // membership check. The author must hold karma at every hop that will
      // relay or deliver — set it on all three.
      nodeA.addKarmaMember(hex);
      nodeB.addKarmaMember(hex);
      nodeC.addKarmaMember(hex);

      const bDeliveries: UtxoTransaction[] = [];
      nodeB.onTx((t) => {
        bDeliveries.push(t);
      });
      const cValidator = newCounter();
      const topicsC = topicsOf(nodeC);
      wrapValidator(nodeC, topicsC.tx, cValidator);

      const { tx, content } = makePostTxPacket(kp.publicKey, 'line-control-tx');
      await nodeA.broadcastTx(tx, content);

      await vi.waitFor(() => expect(bDeliveries.length).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect(bDeliveries.length).toBe(1);
      expect(cValidator.count).toBe(1);
      expect(cValidator.lastResult).toBe(TopicValidatorResult.Accept);
    },
    TIMEOUT,
  );

  it(
    'five publishes of the same bytes deliver once at B and run C\'s validator once (ordering block)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const bDeliveries: OrderingBlock[] = [];
      nodeB.onOrderingBlock((b) => {
        bDeliveries.push(b);
      });
      const cValidator = newCounter();
      const topicsC = topicsOf(nodeC);
      wrapValidator(nodeC, topicsC.orderingBlock, cValidator);

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      // NET_INTERFACE → Gossip → "A broadcast that sends nothing still resolves"
      for (let i = 0; i < 5; i++) {
        await expect(nodeA.broadcastOrderingBlock(block)).resolves.toBeUndefined();
      }

      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect({
        bHandler: bDeliveries.length,
        cValidator: cValidator.count,
      }).toEqual({ bHandler: 1, cValidator: 1 });
    },
    TIMEOUT,
  );

  it(
    'five publishes of the same bytes deliver once at B and run C\'s validator once (tx packet)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const kp = generateKeyPair();
      const hex = Buffer.from(kp.publicKey).toString('hex');
      nodeA.addKarmaMember(hex);
      nodeB.addKarmaMember(hex);
      nodeC.addKarmaMember(hex);

      const bDeliveries: UtxoTransaction[] = [];
      nodeB.onTx((t) => {
        bDeliveries.push(t);
      });
      const cValidator = newCounter();
      const topicsC = topicsOf(nodeC);
      wrapValidator(nodeC, topicsC.tx, cValidator);

      const { tx, content } = makePostTxPacket(kp.publicKey, 'duplicate-publish-tx');
      // NET_INTERFACE → Gossip → "A broadcast that sends nothing still resolves"
      for (let i = 0; i < 5; i++) {
        await expect(nodeA.broadcastTx(tx, content)).resolves.toBeUndefined();
      }

      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect({
        bHandler: bDeliveries.length,
        cValidator: cValidator.count,
      }).toEqual({ bHandler: 1, cValidator: 1 });
    },
    TIMEOUT,
  );

  it(
    'one publish by A is delivered once at C over two hops (ordering block)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const cDeliveries: OrderingBlock[] = [];
      nodeC.onOrderingBlock((b) => {
        cDeliveries.push(b);
      });
      const bDeliveries: OrderingBlock[] = [];
      nodeB.onOrderingBlock((b) => {
        bDeliveries.push(b);
      });

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeA.broadcastOrderingBlock(block);

      await vi.waitFor(() => expect(bDeliveries.length).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(cDeliveries.length).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'one publish by A is delivered once at C over two hops (tx packet)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const kp = generateKeyPair();
      const hex = Buffer.from(kp.publicKey).toString('hex');
      nodeA.addKarmaMember(hex);
      nodeB.addKarmaMember(hex);
      nodeC.addKarmaMember(hex);

      const cDeliveries: UtxoTransaction[] = [];
      nodeC.onTx((t) => {
        cDeliveries.push(t);
      });
      const bDeliveries: UtxoTransaction[] = [];
      nodeB.onTx((t) => {
        bDeliveries.push(t);
      });

      const { tx, content } = makePostTxPacket(kp.publicKey, 'two-hop-tx');
      await nodeA.broadcastTx(tx, content);

      await vi.waitFor(() => expect(bDeliveries.length).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(cDeliveries.length).toBe(1);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// A node of another network is no peer of ours
// NET_INTERFACE → Gossip Topics → "A topic is named for its network"
// NET_INTERFACE → Handshake → "Ban policy" — frame tier closes the stream
// without a penalty, so the connection stands though neither becomes Active.
// ---------------------------------------------------------------------------

async function startBAndStranger(): Promise<{
  nodeB: NetNode;
  nodeX: NetNode;
}> {
  const nodeB = new NetNode(makeConfig(), validators);
  await nodeB.start();
  const bAddr = nodeB.libp2pNode?.getMultiaddrs()[0]?.toString();
  if (!bAddr) throw new Error('B has no listen address');

  // X runs on a different frame magic; its handshake frame to B is refused at
  // the frame tier (unknown magic), B closes the stream without a penalty, and
  // the connection stands. X's outbound side reads B's empty frame and treats
  // the handshake as failed. Neither side's handshake completes.
  const nodeX = new NetNode(
    makeConfig({ magic: MAGIC_DEVNET, bootstrapPeers: [bAddr] }),
    validators,
  );
  await nodeX.start();

  await vi.waitFor(
    () => {
      expect(nodeB.libp2pNode?.getConnections().length ?? 0).toBeGreaterThan(0);
      expect(nodeX.libp2pNode?.getConnections().length ?? 0).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 250 },
  );
  // The pair shares no topic (NET_INTERFACE → Gossip Topics →
  // "A topic is named for its network"), so there is nothing to poll on. The
  // fixed quiet waits out two gossipsub heartbeats — any subscription record
  // or mesh graft that would arrive, does.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return { nodeB, nodeX };
}

describe('A node of another network is no peer of ours', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop();
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  it(
    'a node of another magic holds a connection to B and neither is Active to the other',
    async () => {
      const { nodeB, nodeX } = await startBAndStranger();
      track([nodeB, nodeX]);
      const bConns = nodeB.libp2pNode?.getConnections() ?? [];
      const xConns = nodeX.libp2pNode?.getConnections() ?? [];
      expect(bConns.length).toBeGreaterThan(0);
      expect(xConns.length).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeX.peerId());
      expect(nodeX.getConnectedPeers()).not.toContain(nodeB.peerId());
    },
    TIMEOUT,
  );

  it(
    'B\'s router lists no peer of another magic among the subscribers of either of B\'s own topics',
    async () => {
      const { nodeB, nodeX } = await startBAndStranger();
      track([nodeB, nodeX]);
      expect((nodeB.libp2pNode?.getConnections().length ?? 0)).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeX.peerId());

      const topicsB = topicsOf(nodeB);
      const ps = pubsubOf(nodeB);
      const subsOrderingBlock = ps
        .getSubscribers(topicsB.orderingBlock)
        .map((p) => p.toString());
      const subsTx = ps.getSubscribers(topicsB.tx).map((p) => p.toString());

      expect({
        orderingBlock: subsOrderingBlock.includes(nodeX.peerId()),
        tx: subsTx.includes(nodeX.peerId()),
      }).toEqual({ orderingBlock: false, tx: false });
    },
    TIMEOUT,
  );

  it(
    'a block X publishes runs no validator at B',
    async () => {
      const { nodeB, nodeX } = await startBAndStranger();
      track([nodeB, nodeX]);
      expect((nodeB.libp2pNode?.getConnections().length ?? 0)).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeX.peerId());

      const bValidator = newCounter();
      const topicsB = topicsOf(nodeB);
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      // NET_INTERFACE → Gossip → "A broadcast that sends nothing still resolves"
      await expect(nodeX.broadcastOrderingBlock(block)).resolves.toBeUndefined();

      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(bValidator.count).toBe(0);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// A carrier that is not Active
// NET_INTERFACE → Inbound Processing →
//   "A gossip message that passes Stage 1 is delivered, whichever peer carried it"
// NET_INTERFACE → Handshake → "Ban policy" — a soft refusal
// (`unsupported-version`) closes the stream and leaves the connection standing.
// NET_INTERFACE → Peer State Machine — a peer whose handshake does not
// complete stays Connecting; `getConnectedPeers()` lists Active peers only.
// ---------------------------------------------------------------------------

// B's era at the next height is PROTOCOL_VERSION + 1. Y's build declares
// PROTOCOL_VERSION (the handshake reads it directly), so B's inbound handshake
// handler rejects Y as `unsupported-version` — Transient, 50 points, below the
// 500-point threshold a plain `makeConfig()` carries, so no ban hangs up the
// connection. The block Y publishes is at height 1 with its header's own
// `protocolVersion = PROTOCOL_VERSION + 1`, which matches B's era at height 1.
async function startBAndSoftRefused(): Promise<{
  nodeB: NetNode;
  nodeY: NetNode;
}> {
  const nodeB = new NetNode(
    makeConfig({
      protocolVersionSchedule: [
        { version: PROTOCOL_VERSION, fromHeight: 0 },
        { version: PROTOCOL_VERSION + 1, fromHeight: 1 },
      ],
    }),
    validators,
  );
  await nodeB.start();
  const bAddr = nodeB.libp2pNode?.getMultiaddrs()[0]?.toString();
  if (!bAddr) throw new Error('B has no listen address');

  const nodeY = new NetNode(makeConfig({ bootstrapPeers: [bAddr] }), validators);
  await nodeY.start();

  await vi.waitFor(
    () => {
      expect(nodeB.libp2pNode?.getConnections().length ?? 0).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 250 },
  );
  await waitForMesh(nodeB, nodeY);
  return { nodeB, nodeY };
}

describe('A carrier that is not Active', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop();
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  it(
    'B\'s validator accepts a block Y publishes while Y is not Active at B',
    async () => {
      const { nodeB, nodeY } = await startBAndSoftRefused();
      track([nodeB, nodeY]);

      // Y holds a connection to B and is not Active at B.
      expect((nodeB.libp2pNode?.getConnections().length ?? 0)).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeY.peerId());

      const bValidator = newCounter();
      const topicsB = topicsOf(nodeB);
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      const block = makeBlockAt(1, PROTOCOL_VERSION + 1);
      await expect(nodeY.broadcastOrderingBlock(block)).resolves.toBeUndefined();

      await vi.waitFor(
        () => expect(bValidator.count).toBeGreaterThanOrEqual(1),
        { timeout: 10_000, interval: 100 },
      );
      expect(bValidator.count).toBe(1);
      expect(bValidator.lastResult).toBe(TopicValidatorResult.Accept);
    },
    TIMEOUT,
  );

  it(
    'a block Y publishes is delivered once at B although Y is not Active there',
    async () => {
      const { nodeB, nodeY } = await startBAndSoftRefused();
      track([nodeB, nodeY]);

      expect((nodeB.libp2pNode?.getConnections().length ?? 0)).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeY.peerId());

      const bValidator = newCounter();
      const topicsB = topicsOf(nodeB);
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      const bDeliveries: OrderingBlock[] = [];
      nodeB.onOrderingBlock((b) => {
        bDeliveries.push(b);
      });

      const block = makeBlockAt(1, PROTOCOL_VERSION + 1);
      await nodeY.broadcastOrderingBlock(block);

      await vi.waitFor(
        () => expect(bValidator.count).toBeGreaterThanOrEqual(1),
        { timeout: 10_000, interval: 100 },
      );
      expect(bValidator.lastResult).toBe(TopicValidatorResult.Accept);
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect(bDeliveries.length).toBe(1);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// A topic the node does not hear, a message's envelope, a message's name
// NET_INTERFACE → Gossip Topics → "A topic is named for its network"
// NET_INTERFACE → Gossip Topics → "A message is its topic and its data"
// NET_INTERFACE → Gossip Topics → "A message is named by its bytes"
// ---------------------------------------------------------------------------

describe('A topic the node does not hear, a message\'s envelope, a message\'s name', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop();
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  it(
    'a topic B does not hear leaves no record of A at B, though A subscribes to it',
    async () => {
      const { nodeA, nodeB } = await startAB();
      track([nodeA, nodeB]);

      const extraTopic = '/dagsocial/outsider/1';
      expect(pubsubOf(nodeA).getTopics()).not.toContain(extraTopic);
      expect(pubsubOf(nodeB).getTopics()).not.toContain(extraTopic);

      pubsubOf(nodeA).subscribe(extraTopic);

      // Two heartbeats for A's SUBSCRIBE RPC to reach B.
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      // The subscription exchange has run — B lists A among the subscribers
      // of B's own topics.
      const topicsB = topicsOf(nodeB);
      const subsOrderingBlock = pubsubOf(nodeB)
        .getSubscribers(topicsB.orderingBlock)
        .map((p) => p.toString());
      expect(subsOrderingBlock).toContain(nodeA.peerId());

      // NET_INTERFACE → Gossip Topics → "A topic is named for its network"
      const subsExtra = pubsubOf(nodeB)
        .getSubscribers(extraTopic)
        .map((p) => p.toString());
      expect(subsExtra).not.toContain(nodeA.peerId());
    },
    TIMEOUT,
  );

  it(
    'a message delivered at B names no publisher, sequence number, signature or key',
    async () => {
      const { nodeA, nodeB } = await startAB();
      track([nodeA, nodeB]);

      const topicsB = topicsOf(nodeB);
      const block = makeBlockAt(1, PROTOCOL_VERSION);
      const expectedData = encodeOrderingBlock(block);

      let captured: GossipsubMessage['msg'] | null = null;
      pubsubOf(nodeB).addEventListener('gossipsub:message', (ev) => {
        if (ev.detail.msg.topic === topicsB.orderingBlock && captured === null) {
          captured = ev.detail.msg;
        }
      });

      await nodeA.broadcastOrderingBlock(block);

      await vi.waitFor(() => expect(captured).not.toBeNull(), {
        timeout: 10_000,
        interval: 100,
      });

      const m = captured as unknown as GossipsubMessage['msg'];
      // The event arrived with the block's bytes.
      expect(Array.from(m.data)).toEqual(Array.from(expectedData));

      // NET_INTERFACE → Gossip Topics → "A message is its topic and its data"
      expect({
        from: m.from ?? null,
        sequenceNumber: m.sequenceNumber ?? null,
        signature: m.signature ?? null,
        key: m.key ?? null,
      }).toEqual({ from: null, sequenceNumber: null, signature: null, key: null });
    },
    TIMEOUT,
  );

  it(
    'the id B\'s router names a block by equals hash32(lpUtf8(topic) ‖ data)',
    async () => {
      const { nodeA, nodeB } = await startAB();
      track([nodeA, nodeB]);

      const topicsB = topicsOf(nodeB);
      const block = makeBlockAt(1, PROTOCOL_VERSION);
      const data = encodeOrderingBlock(block);

      let capturedMsgId: string | null = null;
      let capturedData: Uint8Array | null = null;
      pubsubOf(nodeB).addEventListener('gossipsub:message', (ev) => {
        if (ev.detail.msg.topic === topicsB.orderingBlock && capturedMsgId === null) {
          capturedMsgId = ev.detail.msgId;
          capturedData = ev.detail.msg.data;
        }
      });

      await nodeA.broadcastOrderingBlock(block);

      await vi.waitFor(() => expect(capturedMsgId).not.toBeNull(), {
        timeout: 10_000,
        interval: 100,
      });

      // The event's data is the block's bytes.
      expect(Array.from(capturedData as unknown as Uint8Array)).toEqual(
        Array.from(data),
      );

      // Build the preimage by hand: lpUtf8(topic) ‖ data. The topic is well
      // under 128 bytes, so WIRE_INTERFACE's VLQ writer encodes its length as
      // one continuation-free byte.
      const topicBytes = Buffer.from(topicsB.orderingBlock, 'utf-8');
      if (topicBytes.length >= 128) throw new Error('topic exceeds a single VLQ byte');
      const preimage = Buffer.concat([
        Uint8Array.of(topicBytes.length),
        topicBytes,
        data,
      ]);
      // TYPES_INTERFACE → The protocol hash — BLAKE2b-512 truncated to 32 bytes.
      const expectedBytes = createHash('blake2b512').update(preimage).digest().subarray(0, 32);
      // Gossipsub renders a msgId through `messageIdToString`: multiformats
      // base64 with the multibase prefix stripped — unpadded standard base64.
      const expectedStr = expectedBytes.toString('base64').replace(/=+$/, '');

      // NET_INTERFACE → Gossip Topics → "A message is named by its bytes"
      expect(capturedMsgId).toBe(expectedStr);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// A bare publisher dials B — what only the unsigned envelope expresses
//
// Each case builds a libp2p node of this package's own dependencies, with a
// gossipsub router of the case's own options, dials B, and publishes without
// running the dagsocial handshake. The bare node subscribes to the pair B's
// router is subscribed to, so the mesh grafts.
//
// NET_INTERFACE → Gossip Topics → "A message is its topic and its data"
// NET_INTERFACE → Gossip Topics → "A message is named by its bytes"
// NET_INTERFACE → Gossip Topics → "A message is heard once in a seen window"
// NET_INTERFACE → libp2p Stack
// ---------------------------------------------------------------------------

interface BareOptions {
  globalSignaturePolicy?: 'StrictSign' | 'StrictNoSign';
  msgIdFn?: (msg: { topic: string; data: Uint8Array }) => Uint8Array | Promise<Uint8Array>;
}

async function startBarePublisher(
  bAddr: string,
  bareTopics: { orderingBlock: string; tx: string },
  options: BareOptions = {},
): Promise<Libp2p> {
  const bare = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncryption: [noise()],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamMuxers: [yamux() as any],
    services: {
      pubsub: gossipsub({
        globalSignaturePolicy: options.globalSignaturePolicy ?? 'StrictNoSign',
        msgIdFn: options.msgIdFn ?? ((msg) => gossipMessageId(msg.topic, msg.data)),
        seenTTL: GOSSIP_SEEN_WINDOW_MS,
        ignoreDuplicatePublishError: true,
        allowedTopics: [bareTopics.orderingBlock, bareTopics.tx],
        allowPublishToZeroTopicPeers: true,
      }),
      identify: identify(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });
  const ps = (bare as unknown as { services: { pubsub: PubSub<GossipsubEvents> } })
    .services.pubsub;
  ps.subscribe(bareTopics.orderingBlock);
  ps.subscribe(bareTopics.tx);
  await bare.dial(multiaddr(bAddr));
  return bare;
}

async function waitForBareMeshPeer(
  bare: Libp2p,
  nodeB: NetNode,
  topic: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      const barePubsub = (bare as unknown as {
        services: { pubsub: { getMeshPeers(t: string): string[] } };
      }).services.pubsub;
      const bPubsub = (nodeB.libp2pNode as unknown as {
        services: { pubsub: { getMeshPeers(t: string): string[] } };
      } | null)?.services.pubsub;
      if (!bPubsub) throw new Error('B is not started');
      expect(barePubsub.getMeshPeers(topic)).toContain(nodeB.peerId());
      expect(bPubsub.getMeshPeers(topic)).toContain(bare.peerId.toString());
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function stopBare(bare: Libp2p | undefined): Promise<void> {
  if (!bare) return;
  await bare.stop();
}

describe('A bare publisher dials B', () => {
  const openNodes: NetNode[] = [];
  const openBare: Libp2p[] = [];
  afterEach(async () => {
    while (openBare.length > 0) await stopBare(openBare.pop());
    while (openNodes.length > 0) {
      const n = openNodes.pop();
      await n?.stop();
    }
  });

  async function startB(
    overrides: Partial<NetConfig> = {},
  ): Promise<{ nodeB: NetNode; bAddr: string }> {
    const nodeB = new NetNode(makeConfig(overrides), validators);
    await nodeB.start();
    openNodes.push(nodeB);
    const bAddr = nodeB.libp2pNode?.getMultiaddrs()[0]?.toString();
    if (!bAddr) throw new Error('B has no listen address');
    return { nodeB, bAddr };
  }

  it(
    'the receiver names the message: five publishes with changing own ids deliver once',
    async () => {
      // The publisher's own id function returns a new value on every
      // call, so its seen cache never dedupes; B names the message by our rule
      // and dedupes.
      const { nodeB, bAddr } = await startB();
      const topicsB = topicsOf(nodeB);

      let counter = 0;
      const bare = await startBarePublisher(bAddr, topicsB, {
        msgIdFn: () => {
          counter += 1;
          const buf = new Uint8Array(32);
          buf[0] = counter & 0xff;
          buf[1] = (counter >> 8) & 0xff;
          return buf;
        },
      });
      openBare.push(bare);
      await waitForBareMeshPeer(bare, nodeB, topicsB.orderingBlock);

      const bValidator = newCounter();
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      const bDeliveries: OrderingBlock[] = [];
      nodeB.onOrderingBlock((b) => {
        bDeliveries.push(b);
      });

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      const data = encodeOrderingBlock(block);
      const ps = (bare as unknown as { services: { pubsub: PubSub<GossipsubEvents> } })
        .services.pubsub;
      for (let i = 0; i < 5; i++) {
        await ps.publish(topicsB.orderingBlock, data);
      }

      await vi.waitFor(() => expect(bDeliveries.length).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect({ bValidator: bValidator.count, bDeliveries: bDeliveries.length })
        .toEqual({ bValidator: 1, bDeliveries: 1 });
    },
    TIMEOUT,
  );

  it(
    'the same bytes on the two topics are two messages',
    async () => {
      // A bare publisher sends a block's bytes on B's tx topic: B's tx
      // validator runs and refuses them. Then A, a NetNode Active at B,
      // broadcasts that block on the ordering-block topic: B's block validator
      // runs and the handler is called once.
      const { nodeB, bAddr } = await startB();
      const topicsB = topicsOf(nodeB);

      const bare = await startBarePublisher(bAddr, topicsB);
      openBare.push(bare);
      await waitForBareMeshPeer(bare, nodeB, topicsB.tx);
      await waitForBareMeshPeer(bare, nodeB, topicsB.orderingBlock);

      const bTxValidator = newCounter();
      const bBlockValidator = newCounter();
      wrapValidator(nodeB, topicsB.tx, bTxValidator);
      wrapValidator(nodeB, topicsB.orderingBlock, bBlockValidator);

      const bDeliveries: OrderingBlock[] = [];
      nodeB.onOrderingBlock((b) => {
        bDeliveries.push(b);
      });

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      const data = encodeOrderingBlock(block);
      const ps = (bare as unknown as { services: { pubsub: PubSub<GossipsubEvents> } })
        .services.pubsub;
      // Block bytes on the tx topic — the tx validator will see them.
      await ps.publish(topicsB.tx, data);

      await vi.waitFor(() => expect(bTxValidator.count).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      expect(bTxValidator.lastResult).toBe(TopicValidatorResult.Reject);
      expect(bBlockValidator.count).toBe(0);

      // Now A broadcasts the same block on the ordering-block topic. B's
      // block validator runs and the handler fires.
      const nodeA = new NetNode(makeConfig({ bootstrapPeers: [bAddr] }), validators);
      await nodeA.start();
      openNodes.push(nodeA);
      await vi.waitFor(
        () => {
          expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
          expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
        },
        { timeout: 15_000, interval: 250 },
      );
      await waitForMesh(nodeA, nodeB);

      await nodeA.broadcastOrderingBlock(block);

      await vi.waitFor(() => expect(bDeliveries.length).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect({
        bTxValidator: bTxValidator.count,
        bBlockValidator: bBlockValidator.count,
        bDeliveries: bDeliveries.length,
      }).toEqual({ bTxValidator: 1, bBlockValidator: 1, bDeliveries: 1 });
    },
    TIMEOUT,
  );

  it(
    'a signed message reaches no validator',
    async () => {
      // A bare publisher on the library's default signing options
      // publishes a block on B's block topic. B's StrictNoSign refuses the
      // signed envelope at the policy gate, so B's validator does not run.
      // The control: an unsigned publisher on the same mesh is heard.
      const { nodeB, bAddr } = await startB();
      const topicsB = topicsOf(nodeB);

      const signedBare = await startBarePublisher(bAddr, topicsB, {
        globalSignaturePolicy: 'StrictSign',
      });
      openBare.push(signedBare);
      await waitForBareMeshPeer(signedBare, nodeB, topicsB.orderingBlock);

      const bValidator = newCounter();
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      const data = encodeOrderingBlock(block);
      const signedPs = (signedBare as unknown as {
        services: { pubsub: PubSub<GossipsubEvents> };
      }).services.pubsub;
      await signedPs.publish(topicsB.orderingBlock, data);

      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(bValidator.count).toBe(0);

      // Control: an unsigned bare publisher IS heard.
      const unsignedBare = await startBarePublisher(bAddr, topicsB);
      openBare.push(unsignedBare);
      await waitForBareMeshPeer(unsignedBare, nodeB, topicsB.orderingBlock);

      const unsignedPs = (unsignedBare as unknown as {
        services: { pubsub: PubSub<GossipsubEvents> };
      }).services.pubsub;
      await unsignedPs.publish(topicsB.orderingBlock, data);

      await vi.waitFor(() => expect(bValidator.count).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      expect(bValidator.lastResult).toBe(TopicValidatorResult.Accept);
    },
    TIMEOUT,
  );

  it(
    'a refusal stands for the window: two bare publishers send the same bytes, B\'s validator runs once',
    async () => {
      // The refusal taken here is a protocol-version mismatch
      // (NET_INTERFACE → Stage 1): the block declares version PROTOCOL_VERSION
      // but B's schedule at the header's height is PROTOCOL_VERSION + 1, so
      // the Reject is Transient (50 points, below B's 500-point threshold —
      // no ban, no stream close).
      const { nodeB, bAddr } = await startB({
        protocolVersionSchedule: [
          { version: PROTOCOL_VERSION, fromHeight: 0 },
          { version: PROTOCOL_VERSION + 1, fromHeight: 1 },
        ],
      });
      const topicsB = topicsOf(nodeB);

      const bareOne = await startBarePublisher(bAddr, topicsB);
      openBare.push(bareOne);
      await waitForBareMeshPeer(bareOne, nodeB, topicsB.orderingBlock);

      const bValidator = newCounter();
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      // Height 1 declares PROTOCOL_VERSION; B's era at height 1 is
      // PROTOCOL_VERSION + 1 — a mismatch, so Transient Reject.
      const block = makeBlockAt(1, PROTOCOL_VERSION);
      const data = encodeOrderingBlock(block);
      const psOne = (bareOne as unknown as {
        services: { pubsub: PubSub<GossipsubEvents> };
      }).services.pubsub;
      await psOne.publish(topicsB.orderingBlock, data);

      await vi.waitFor(() => expect(bValidator.count).toBe(1), {
        timeout: 10_000,
        interval: 100,
      });
      expect(bValidator.lastResult).toBe(TopicValidatorResult.Reject);
      expect(nodeB.libp2pNode?.getConnections().length ?? 0).toBeGreaterThan(0);

      // A second bare publisher sends the SAME bytes. B's seen cache was
      // recorded before the validator ran, so the second copy is not
      // validated, not delivered and not forwarded.
      const bareTwo = await startBarePublisher(bAddr, topicsB);
      openBare.push(bareTwo);
      await waitForBareMeshPeer(bareTwo, nodeB, topicsB.orderingBlock);

      const psTwo = (bareTwo as unknown as {
        services: { pubsub: PubSub<GossipsubEvents> };
      }).services.pubsub;
      await psTwo.publish(topicsB.orderingBlock, data);

      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(bValidator.count).toBe(1);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// The seen window carries the constant — NET_INTERFACE → Gossip Topics →
// "A message is heard once in a seen window"
//
// A case that waits two minutes is not a case: the pin reads the router's own
// record of its options. It does not show that the router keeps an id for that
// long, and the library's default is the same number, so it does not show the
// option is set either.
// ---------------------------------------------------------------------------

describe('The seen window carries the constant', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop();
    }
  });

  it('a running node\'s gossipsub carries seenTTL = GOSSIP_SEEN_WINDOW_MS', async () => {
    const nodeB = new NetNode(makeConfig(), validators);
    await nodeB.start();
    open.push(nodeB);

    const router = (nodeB.libp2pNode as unknown as {
      services: { pubsub: { opts?: { seenTTL?: number } } };
    } | null)?.services.pubsub;
    expect(router).toBeDefined();
    expect(router?.opts?.seenTTL).toBe(GOSSIP_SEEN_WINDOW_MS);
  });
});
