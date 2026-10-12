import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  generateKeyPair,
  computeContentHash,
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
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// NET_INTERFACE → Gossip Topics
// NET_INTERFACE → Gossip Topics → "A topic is named for its network"
// NET_INTERFACE → Gossip Topics → "A message is named by its bytes"
// NET_INTERFACE → Gossip Topics → "A message is heard once in a seen window"
// NET_INTERFACE → Gossip → "A broadcast that sends nothing still resolves"
// NET_INTERFACE → Inbound Processing →
//   "A gossip message that passes Stage 1 is delivered, whichever peer carried it"
// NET_INTERFACE → Peer State Machine

// Timeout per case. Libp2p needs seconds for TCP, Noise, identify, our
// handshake and the gossipsub mesh heartbeat (NET_INTERFACE → libp2p Stack).
const TIMEOUT = 25_000;

// A fixed settle after the last expected event. One gossipsub heartbeat is
// ~1 s; this waits that out so "nothing more arrives" has had a chance to
// arrive on both hops and the local handler has drained.
const SETTLE_MS = 3_000;

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
// absent (NET_INTERFACE → Handshake Body: "a loopback address advertised to
// a peer is one no peer can dial"). No peer learns a dialable address for any
// other, so PeerDb cannot seed the fill phase that would close a line into a
// triangle (NET_INTERFACE → Outbound Manager → Fill phase).
function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    minPeers: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Router seams — read the two topic strings and wrap a validator in place.
// NET_INTERFACE → libp2p Stack: "the node's two topics alone".
// ---------------------------------------------------------------------------

interface PubSubShape {
  getTopics(): string[];
  getSubscribers(topic: string): Array<{ toString(): string }>;
  topicValidators: Map<
    string,
    (peer: unknown, msg: { data: Uint8Array }) =>
      TopicValidatorResult | Promise<TopicValidatorResult>
  >;
}

function pubsubOf(node: NetNode): PubSubShape {
  const lp = node.libp2pNode;
  if (!lp) throw new Error('node is not started');
  return (lp as unknown as { services: { pubsub: PubSubShape } }).services.pubsub;
}

// The two topic strings a node's router is subscribed to, picked by their
// ending — not a literal, not the `TOPICS` export.
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

  // Mesh formation runs on gossipsub's heartbeat (default ~1 s). This waits
  // for both hops' mesh to form before any publish; it is not covering a
  // race in production code.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

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
// Cases 1–3: delivery on a line
// ---------------------------------------------------------------------------

describe('Gossip on a line A — B — C', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop().catch(() => {});
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  // case 1 — control, ordering block
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
      // The two topic strings from C's router — printed for the report, not
      // asserted (the names change in the next step).
      console.log(
        `[gossip-mesh] C topics: ${JSON.stringify(pubsubOf(nodeC).getTopics())}`,
      );
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

  // case 1 — control, tx packet
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

  // case 2 — "A message is named by its bytes" / "heard once in a seen window"
  it.fails(
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
      // NET_INTERFACE → Gossip → "A broadcast that sends nothing still
      // resolves" — every one of five resolves.
      for (let i = 0; i < 5; i++) {
        await expect(nodeA.broadcastOrderingBlock(block)).resolves.toBeUndefined();
      }

      await new Promise((r) => setTimeout(r, SETTLE_MS * 2));

      expect({
        bHandler: bDeliveries.length,
        cValidator: cValidator.count,
      }).toEqual({ bHandler: 1, cValidator: 1 });
    },
    TIMEOUT,
  );

  it.fails(
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
      for (let i = 0; i < 5; i++) {
        await expect(nodeA.broadcastTx(tx, content)).resolves.toBeUndefined();
      }

      await new Promise((r) => setTimeout(r, SETTLE_MS * 2));

      expect({
        bHandler: bDeliveries.length,
        cValidator: cValidator.count,
      }).toEqual({ bHandler: 1, cValidator: 1 });
    },
    TIMEOUT,
  );

  // case 3 — "A gossip message that passes Stage 1 is delivered, whichever
  // peer carried it".
  it.fails(
    'one publish by A is delivered once at C over two hops (ordering block)',
    async () => {
      const { nodeA, nodeB, nodeC } = await startLine();
      track([nodeA, nodeB, nodeC]);
      assertLineIntact(nodeA, nodeC);

      const cDeliveries: OrderingBlock[] = [];
      nodeC.onOrderingBlock((b) => {
        cDeliveries.push(b);
      });
      // A control that B relays reliably: B's handler fires on receipt. If
      // this `expect` ever failed on this tree, the case's assertion below
      // would still be at the right place, but the harness would be the
      // reason — this expects the setup, not the subject.
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
      await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
      expect(cDeliveries.length).toBe(1);
    },
    TIMEOUT,
  );

  it.fails(
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
      await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
      expect(cDeliveries.length).toBe(1);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Cases 4–6: a node of another network is no peer of ours
// NET_INTERFACE → Gossip Topics → "A topic is named for its network"
// NET_INTERFACE → Handshake → "Ban policy" (frame tier closes the stream, no
// penalty, so the connection stands though neither becomes Active).
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
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return { nodeB, nodeX };
}

describe('A node of another network is no peer of ours', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop().catch(() => {});
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  // case 4 — control
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

  // case 5 — subscriber list
  it.fails(
    'B\'s router lists no peer of another magic among the subscribers of either of B\'s own topics',
    async () => {
      const { nodeB, nodeX } = await startBAndStranger();
      track([nodeB, nodeX]);
      // Carries case 4 inline — the setup `expect`s hold today.
      expect((nodeB.libp2pNode?.getConnections().length ?? 0)).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeX.peerId());

      const topicsB = topicsOf(nodeB);
      const ps = pubsubOf(nodeB);
      const subsOrderingBlock = ps
        .getSubscribers(topicsB.orderingBlock)
        .map((p) => p.toString());
      const subsTx = ps.getSubscribers(topicsB.tx).map((p) => p.toString());
      // The subscriber lists, read from B's router — printed for the report.
      console.log(
        `[gossip-mesh] B topics: ${JSON.stringify([
          topicsB.orderingBlock,
          topicsB.tx,
        ])}`,
      );
      console.log(
        `[gossip-mesh] B subscribers(ordering-block): ${JSON.stringify(subsOrderingBlock)}`,
      );
      console.log(
        `[gossip-mesh] B subscribers(tx): ${JSON.stringify(subsTx)}`,
      );

      expect({
        orderingBlock: subsOrderingBlock.includes(nodeX.peerId()),
        tx: subsTx.includes(nodeX.peerId()),
      }).toEqual({ orderingBlock: false, tx: false });
    },
    TIMEOUT,
  );

  // case 6 — another network reaches no validator
  it.fails(
    'a block X publishes runs no validator at B',
    async () => {
      const { nodeB, nodeX } = await startBAndStranger();
      track([nodeB, nodeX]);
      // The control for "X really published and B really is connected" — the
      // first two expects hold today (case 4 proves them standalone).
      expect((nodeB.libp2pNode?.getConnections().length ?? 0)).toBeGreaterThan(0);
      expect(nodeB.getConnectedPeers()).not.toContain(nodeX.peerId());

      const bValidator = newCounter();
      const topicsB = topicsOf(nodeB);
      wrapValidator(nodeB, topicsB.orderingBlock, bValidator);

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      // X's broadcast resolves (NET_INTERFACE → Gossip → "A broadcast that
      // sends nothing still resolves") — the carrier claim for this case.
      await expect(nodeX.broadcastOrderingBlock(block)).resolves.toBeUndefined();

      await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
      expect(bValidator.count).toBe(0);
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Cases 7–8: a carrier that is not Active
// NET_INTERFACE → Inbound Processing →
//   "A gossip message that passes Stage 1 is delivered, whichever peer carried it"
// NET_INTERFACE → Handshake → "Ban policy": a soft refusal
// (`unsupported-version`) closes the stream and leaves the connection standing.
// NET_INTERFACE → Peer State Machine: a peer whose handshake does not complete
// stays Connecting; `getConnectedPeers()` lists Active peers only.
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
  // The handshake runs on the stream Y opened; give it a chance to be
  // soft-refused by B before the mesh forms.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return { nodeB, nodeY };
}

describe('A carrier that is not Active', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop().catch(() => {});
    }
  });
  const track = (nodes: NetNode[]): void => {
    for (const n of nodes) open.push(n);
  };

  // case 7 — control
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

  // case 8 — delivery although carrier is not Active
  it.fails(
    'a block Y publishes is delivered once at B although Y is not Active there',
    async () => {
      const { nodeB, nodeY } = await startBAndSoftRefused();
      track([nodeB, nodeY]);

      // Case 7's control, run inline — the setup `expect`s hold today.
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
