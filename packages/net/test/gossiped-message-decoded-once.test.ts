import { vi, describe, it, expect, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

// The counter object lives inside `vi.hoisted` so it is initialised before the
// `vi.mock` factory below reads it (`vi.mock` hoists above every import; a
// plain `let` would still be in the temporal dead zone when the factory
// registers). Each delivery resets both counts, so a leaked startup decode
// shows up as a non-zero initial read.
const decodeCounts = vi.hoisted(() => ({ block: 0, tx: 0 }));

// Partial module mock of `@dagsocial/types`: every other export is the real
// one, and the two decoders this case counts are wrapped so each call lifts
// the matching counter and then delegates to the original. The mock is
// scoped to this test file; vitest's module registry isolates it from every
// other suite (NET_INTERFACE → Inbound Processing → "A gossiped message is
// decoded once").
vi.mock('@dagsocial/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/types')>();
  return {
    ...actual,
    decodeOrderingBlock: (bytes: Uint8Array) => {
      decodeCounts.block++;
      return actual.decodeOrderingBlock(bytes);
    },
    decodeTxPacket: (bytes: Uint8Array) => {
      decodeCounts.tx++;
      return actual.decodeTxPacket(bytes);
    },
  };
});

import {
  generateKeyPair,
  computeContentHash,
  computeUtxoTxRoot,
  hexToBytes,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  PostCommit,
  UtxoTransaction,
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
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

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

// Loopback-only listen and no outbound-fill floor so each node's mesh is
// exactly the one peer the test wires up.
function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    minPeers: 0,
    ...overrides,
  });
}

// The real Stage 1 validator reads every block that passes through, so a
// fixture reaching Accept carries a header signed under the key its
// `validatorId` names.
const MESH_VALIDATOR_KP = generateKeyPair();
const MESH_VALIDATOR_SEED = MESH_VALIDATOR_KP.secretKey.subarray(16);

function signMeshHeader(header: BlockHeader): Uint8Array {
  const hash = blockHash(header);
  if (hash === null) throw new Error('signMeshHeader: header outside the encodable domain');
  return ed25519.sign(hexToBytes(hash), MESH_VALIDATOR_SEED);
}

function mineHeader(base: BlockHeader): BlockHeader {
  for (let n = 0; n < 1_000_000; n++) {
    const h = { ...base, powNonce: n };
    if (verifyOrderingBlockPoW(h)) return h;
  }
  throw new Error('could not mine header at the network floor within 1M nonces');
}

function makeBlockAt(height: number): OrderingBlock {
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
  };
  const base: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: '00'.repeat(33),
    validatorId: MESH_VALIDATOR_KP.publicKey,
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  const header = mineHeader(base);
  return {
    header,
    utxoTxTree,
    validatorSignature: signMeshHeader(header),
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

interface PubSubShape {
  getTopics(): string[];
  getMeshPeers(topic: string): string[];
}

function pubsubOf(node: NetNode): PubSubShape {
  const lp = node.libp2pNode;
  if (!lp) throw new Error('node is not started');
  return (lp as unknown as { services: { pubsub: PubSubShape } }).services.pubsub;
}

function topicsOf(node: NetNode): { orderingBlock: string; tx: string } {
  const ts = pubsubOf(node).getTopics();
  const orderingBlock = ts.find((t) => t.endsWith('/ordering-block/1'));
  const tx = ts.find((t) => t.endsWith('/tx/1'));
  if (!orderingBlock || !tx) {
    throw new Error(`router is not subscribed to both topics: ${JSON.stringify(ts)}`);
  }
  return { orderingBlock, tx };
}

async function startAB(
  karmaMembers?: Set<string>,
): Promise<{ nodeA: NetNode; nodeB: NetNode }> {
  const nodeA = new NetNode(makeConfig(), validators);
  await nodeA.start();
  if (karmaMembers) nodeA.setKarmaMembers(karmaMembers);
  const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
  if (!aAddr) throw new Error('A has no listen address');

  const nodeB = new NetNode(makeConfig({ bootstrapPeers: [aAddr] }), validators);
  await nodeB.start();
  if (karmaMembers) nodeB.setKarmaMembers(karmaMembers);

  await vi.waitFor(
    () => {
      expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
      expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
    },
    { timeout: 15_000, interval: 250 },
  );

  // Each neighbour appears in the other's mesh for both topics — the
  // condition a gossip publish counts under.
  await vi.waitFor(
    () => {
      const tA = topicsOf(nodeA);
      const tB = topicsOf(nodeB);
      expect(pubsubOf(nodeA).getMeshPeers(tA.orderingBlock)).toContain(nodeB.peerId());
      expect(pubsubOf(nodeA).getMeshPeers(tA.tx)).toContain(nodeB.peerId());
      expect(pubsubOf(nodeB).getMeshPeers(tB.orderingBlock)).toContain(nodeA.peerId());
      expect(pubsubOf(nodeB).getMeshPeers(tB.tx)).toContain(nodeA.peerId());
    },
    { timeout: 15_000, interval: 100 },
  );

  return { nodeA, nodeB };
}

// NET_INTERFACE → Inbound Processing → "A gossiped message is decoded once"
describe('a gossiped message reaches the handler decoded once', () => {
  const open: NetNode[] = [];
  afterEach(async () => {
    while (open.length > 0) {
      const n = open.pop();
      await n?.stop();
    }
  });

  it(
    'a gossiped ordering block reaches onOrderingBlock with no call to decodeOrderingBlock',
    async () => {
      const { nodeA, nodeB } = await startAB();
      open.push(nodeA, nodeB);

      const received: OrderingBlock[] = [];
      nodeB.onOrderingBlock((block) => {
        received.push(block);
      });

      // Reset AFTER startup and handshake — those paths decode nothing, but
      // the reset pins the window the counter measures to this one delivery.
      decodeCounts.block = 0;

      const block = makeBlockAt(1);
      await nodeA.broadcastOrderingBlock(block);

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
        },
        { timeout: 15_000, interval: 100 },
      );

      // Control: the block B's handler sees carries the bytes A broadcast.
      // Without this, a `received` populated by a path other than the listener
      // (or a broken decode that silently returned a blank block) would
      // satisfy the count below.
      expect(received[0]!.header.height).toBe(block.header.height);
      expect(received[0]!.header.utxoTxRoot).toBe(block.header.utxoTxRoot);
      expect(received[0]!.header.powNonce).toBe(block.header.powNonce);
      expect(Array.from(received[0]!.validatorSignature)).toEqual(
        Array.from(block.validatorSignature),
      );
      expect(received[0]!.utxoTxTree.utxoTxIds).toEqual(block.utxoTxTree.utxoTxIds);

      // The sender (A) does not decode its own publish — a publish writes
      // through `encodeOrderingBlock`, and gossipsub does not deliver a
      // self-published message back to its publisher
      // (`gossipsubOptions` sets no self-emit). The receiver (B)'s topic
      // validator reads the frame through `readOrderingBlockSections` and
      // `decodeUtxoTxTree` (NET_INTERFACE → Stage 1 → "A header is read
      // before its body"), neither of which is `decodeOrderingBlock`, so the
      // counter catches only post-validator decodes. No sync runs — neither
      // node has a pipeline or chain view registered, so the sync-codec's
      // `decodeBlocks` is never reached either.
      expect(decodeCounts.block).toBe(0);
    },
    60_000,
  );

  it(
    'a gossiped transaction packet reaches onTx with one decodeTxPacket call',
    async () => {
      const kp = generateKeyPair();
      const authorHex = Buffer.from(kp.publicKey).toString('hex');
      const members = new Set([authorHex]);
      const { nodeA, nodeB } = await startAB(members);
      open.push(nodeA, nodeB);

      const CONTENT = 'a gossiped transaction fixture';
      const { tx, content } = makePostTxPacket(kp.publicKey, CONTENT);

      type Seen = { tx: UtxoTransaction; content: string | undefined };
      const received: Seen[] = [];
      nodeB.onTx((t, c) => {
        received.push({ tx: t, content: c });
        return true;
      });

      decodeCounts.tx = 0;

      await nodeA.broadcastTx(tx, content);

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
        },
        { timeout: 15_000, interval: 100 },
      );

      // Control: B's handler receives the transaction and the content A
      // published.
      expect(received[0]!.content).toBe(CONTENT);
      expect(received[0]!.tx.protocolVersion).toBe(tx.protocolVersion);
      expect(received[0]!.tx.post?.contentHash).toEqual(tx.post!.contentHash);
      expect(Array.from(received[0]!.tx.post!.author)).toEqual(
        Array.from(tx.post!.author),
      );

      // The one `decodeTxPacket` call counted is the validator's on B
      // (NET_INTERFACE → Stage 1). The sender (A) writes through
      // `encodeTxPacket` and gossipsub does not deliver a self-published
      // message to its publisher. No sync path decodes a transaction packet
      // — transaction bytes are not a sync response type. So the count is
      // exactly the number of post-validator decodes plus the validator's
      // one read.
      expect(decodeCounts.tx).toBe(1);
    },
    60_000,
  );
});
