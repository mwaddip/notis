import { describe, it, expect, afterEach } from 'vitest';
import {
  generateKeyPair,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { Post, UtxoTransaction, OrderingBlock, BlockHeader } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import { createPrivateKey, sign } from 'crypto';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';

function makeConfig(bootstrapPeers: string[] = []): NetConfig {
  return {
    // Testnet magic — both nodes must agree; also proves the wire path does
    // not silently frame as mainnet (ARCHITECTURE → What varies per network,
    // and what must not).
    magic: 0x54444147,
    // Matches the 20-bit target the fixtures below are mined at.
    bootstrapPeers,
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    syncRequestTimeoutMs: 10000,
  };
}

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
};

// Generous timeout — libp2p needs time for peer discovery and connection negotiation
const TIMEOUT = 25000;

// Block fixtures for the headers exchange. Copies of `sync-store.test.ts`'s
// file-local pair: the headers path needs whole blocks, and a shared fixture
// module is a wider change than the one test that wants them.
function makeHeader(overrides: Partial<BlockHeader> = {}): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 100,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000,
    ...overrides,
  };
}

// Every block carries at least one transaction, because the settlement is one
// (VALIDATION_INTERFACE → verifyOrderingBlockStructure;
// NODE_INTERFACE → It is the LAST entry in `utxoTxIds`). These blocks cross a
// real gossip topic validator and a real sync boundary, so an empty body is
// refused before either peer sees it.
function settlementBody(height: number): OrderingBlock['utxoTxTree'] {
  return {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
    pruneEntries: [],
  };
}

function makeBlock(header: BlockHeader): OrderingBlock {
  return {
    header,
    utxoTxTree: settlementBody(header.height),
    validatorSignature: new Uint8Array(64),
  };
}

describe('Two-node integration', () => {
  let nodeA: NetNode;
  let nodeB: NetNode;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('node A starts and gets a peer ID', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const id = nodeA.peerId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  }, TIMEOUT);

  it('two nodes connect to each other', async () => {
    // Start node A first
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();

    // Get node A's listen addresses for bootstrapping
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    expect(multiaddrs.length).toBeGreaterThan(0);

    // Start node B with A as bootstrap
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    // Give them a moment to establish the connection
    await new Promise((r) => setTimeout(r, 3000));

    // Both should see at least 1 peer (each other)
    expect(nodeA.peers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.peers().length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('transaction propagates from A to B via gossip', async () => {
    // Start node A
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];

    // Start node B with A as bootstrap
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 3000));

    // Register handler on B
    let receivedTx: UtxoTransaction | null = null;
    nodeB.onTx((tx) => {
      receivedTx = tx;
    });

    // A post is a transaction, so it propagates on the tx topic. B's relay gate
    // is membership, so B must know the author holds karma — mined PoW is gone.
    const kp = generateKeyPair();
    const post: Post = {
      content: 'hello from integration test',
      author: kp.publicKey,
      parentRefs: [],
      protocolVersion: 1,
      type: 'regular' as const,
    };
    const tx: UtxoTransaction = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: kp.publicKey } as never],
      signatures: {},
      protocolVersion: 1,
      post,
    };
    nodeB.addKarmaMember(Buffer.from(kp.publicKey).toString('hex'));

    await nodeA.broadcastTx(tx);

    // Wait for gossip propagation
    await new Promise((r) => setTimeout(r, 4000));

    expect(receivedTx).not.toBeNull();
    expect(receivedTx!.post!.content).toBe('hello from integration test');
  }, TIMEOUT);

  it('ordering block propagates from A to B', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    await new Promise((r) => setTimeout(r, 3000));

    let receivedBlock: OrderingBlock | null = null;
    nodeB.onOrderingBlock((block) => {
      receivedBlock = block;
    });

    const validatorId = new Uint8Array(32);
    // Stage 1 now PoW-gates ordering-block relay (audit M-9) — an unmined
    // header dies at B's topic validator, so mine the real 12-bit nonce
    // (~4K tries) with the same function the relay gate calls.
    const headerBase: BlockHeader = {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId,
      powNonce: 0,
      powTargetBits: 12 * 256,
      createdAt: Date.now(),
    };
    let blockNonce = -1;
    for (let n = 0; n < 10_000_000; n++) {
      if (verifyOrderingBlockPoW({ ...headerBase, powNonce: n })) { blockNonce = n; break; }
    }
    expect(blockNonce).toBeGreaterThanOrEqual(0);
    const block: OrderingBlock = {
      header: { ...headerBase, powNonce: blockNonce },
      utxoTxTree: settlementBody(headerBase.height),
      validatorSignature: new Uint8Array(64),
    };

    await nodeA.broadcastOrderingBlock(block);
    await new Promise((r) => setTimeout(r, 4000));

    expect(receivedBlock).not.toBeNull();
    expect(receivedBlock!.header.height).toBe(1);
    expect(receivedBlock!.header.protocolVersion).toBe(1);
  }, TIMEOUT);

  it('invalid transaction does NOT trigger handler on B', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    await new Promise((r) => setTimeout(r, 3000));

    let received = false;
    nodeB.onTx(() => {
      received = true;
    });

    // Broadcast an invalid post transaction (empty content — fails
    // ContentLimits). The fixture passes the structure gate's earlier clauses
    // and dies at content, so the rejection fires for its intended reason.
    //
    // ⚠ **The author IS admitted to B's karma set, and that is load-bearing.**
    // Without it this test would pass because membership dropped the message,
    // not because content did — the vacuous version of itself.
    const author = new Uint8Array(32).fill(0xa1);
    nodeB.addKarmaMember(Buffer.from(author).toString('hex'));

    const invalidTx = {
      inputs: ['ba'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: author }],
      signatures: {},
      protocolVersion: 1,
      post: {
        content: '',
        author,
        parentRefs: [],
        protocolVersion: 1,
        type: 'regular' as const,
      },
    } as unknown as UtxoTransaction;

    await nodeA.broadcastTx(invalidTx);
    await new Promise((r) => setTimeout(r, 4000));

    expect(received).toBe(false);
  }, TIMEOUT);

  it('node B fetches headers from node A over the framed sync stream', async () => {
    // The live measurement of the Active gate: the serve arm drops anything
    // from a peer that is not Active, so this only passes if node A's inbound
    // handshake with node B has completed by the time B asks.
    //
    // The protocol is registered by start() and both arms resolve the provider
    // per request, so this passes with the provider set either side of start().
    // Set before, deliberately: it is the order node/src/index.ts uses.
    nodeA = new NetNode(makeConfig(), validators);
    const chain = new Map<number, OrderingBlock>();
    for (let h = 1; h <= 3; h++) {
      chain.set(h, makeBlock(makeHeader({ height: h, createdAt: 1_000_000 + h })));
    }
    for (const [, block] of chain) {
      const r = verifyOrderingBlockStructure(block);
      expect(r.valid, `fixture block h=${block.header.height}: ${r.error}`).toBe(true);
    }
    nodeA.setHeadersHandler((h) => chain.get(h) ?? null);
    await nodeA.start();

    const multiaddrs = nodeA.libp2pNode?.getMultiaddrs() ?? [];
    expect(multiaddrs.length).toBeGreaterThan(0);

    const configB = makeConfig([multiaddrs[0]!.toString()]);
    nodeB = new NetNode(configB, validators);
    await nodeB.start();

    await new Promise((r) => setTimeout(r, 3000));

    // Headers mode walks downward from startHeight, so this is newest-first —
    // the order findForkPoint expects.
    const headers = await nodeB.requestHeaders(3, 3, nodeA.peerId());

    expect(headers.map((h) => h.height)).toEqual([3, 2, 1]);

    // Late binding, over the wire and on a node that is already serving: the
    // handler reads the provider per request, so replacing it takes effect
    // without re-registering anything (NET_INTERFACE → Sync Handler
    // Registration: "a later call replaces the delegate").
    //
    // The replacement still answers a contiguous chain from height 1. Serving
    // only height 2 would report a chain height of 0 — chainHeight() walks up
    // from 1 through this same provider and stops at the first gap — and the
    // empty result would be measuring that clamp instead of the swap.
    nodeA.setHeadersHandler((h) => (h <= 2 ? chain.get(h) ?? null : null));
    const afterSwap = await nodeB.requestHeaders(3, 3, nodeA.peerId());

    expect(afterSwap.map((h) => h.height)).toEqual([2, 1]);
  }, TIMEOUT);
});
