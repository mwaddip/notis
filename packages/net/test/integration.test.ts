import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  generateKeyPair,
  computeContentHash,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { PostCommit, UtxoTransaction, OrderingBlock, BlockHeader } from '@dagsocial/types';
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
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { PenaltyKind, PeerState } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
import type { PeerDb } from '../src/peerdb.js';
import type { PeerManager } from '../src/peer-mgr.js';

function makeConfig(bootstrapPeers: string[] = []): NetConfig {
  return makeBaseConfig({ bootstrapPeers });
}

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
    interlinkRoot: '00'.repeat(32),
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

    let receivedTx: UtxoTransaction | null = null;
    let receivedContent: string | undefined;
    nodeB.onTx((tx, content) => {
      receivedTx = tx;
      receivedContent = content;
    });

    const kp = generateKeyPair();
    const content = 'hello from integration test';
    const commit: PostCommit = {
      contentHash: computeContentHash(content),
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
      post: commit,
    };
    nodeB.addKarmaMember(Buffer.from(kp.publicKey).toString('hex'));

    await nodeA.broadcastTx(tx, content);

    await new Promise((r) => setTimeout(r, 4000));

    expect(receivedTx).not.toBeNull();
    expect(receivedContent).toBe('hello from integration test');
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
      interlinkRoot: '00'.repeat(32),
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

    // Empty content fails verifyPostBody (ContentLimits). The author IS in
    // B's karma set so the rejection is from body verification, not membership.
    const author = new Uint8Array(32).fill(0xa1);
    nodeB.addKarmaMember(Buffer.from(author).toString('hex'));

    const emptyContent = '';
    const invalidTx = {
      inputs: ['ba'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: author }],
      signatures: {},
      protocolVersion: 1,
      post: {
        contentHash: computeContentHash('placeholder'),
        author,
        parentRefs: [],
        protocolVersion: 1,
        type: 'regular' as const,
      },
    } as unknown as UtxoTransaction;

    await nodeA.broadcastTx(invalidTx, emptyContent);
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
    nodeA.setChainHeightProvider(() => 3);
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

    // Late binding: replacing the provider takes effect without re-registering
    // anything (NET_INTERFACE → Sync Handler Registration → "Handler setters
    // are order-independent"). The fixture keeps them consistent as a node's
    // store does by construction.
    nodeA.setHeadersHandler((h) => (h <= 2 ? chain.get(h) ?? null : null));
    nodeA.setChainHeightProvider(() => 2);
    const afterSwap = await nodeB.requestHeaders(3, 3, nodeA.peerId());

    expect(afterSwap.map((h) => h.height)).toEqual([2, 1]);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// A connection to our own peer id is never a peer (NET_INTERFACE →
// "A connection whose remote peer id is this node's own is never a peer") —
// driven through the real outbound funnel: the dial, the own-peer check, then
// the handshake for anyone else.
// ---------------------------------------------------------------------------

interface Internals {
  peerDb: PeerDb;
  peerMgr: PeerManager;
  outboundTick(): void;
}

describe('the outbound funnel and our own peer id', () => {
  let nodeA: NetNode;
  let nodeB: NetNode;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('a seed that resolves to ourselves is dialled once, closed, and never dialled again', async () => {
    const configA = makeConfig();
    nodeA = new NetNode(configA, validators);
    await nodeA.start();

    // Bare — no `/p2p/<peerId>` suffix, the shape the testnet profile's real
    // seed has (NET_INTERFACE → "A connection whose remote peer id is this
    // node's own is never a peer"). A multiaddr that names a peer id is
    // refused by libp2p's own dial-queue before it ever reaches this node's
    // own-peer check; only a bare address reaches TCP, upgrades, and resolves
    // to our own id afterward.
    const selfMultiaddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(selfMultiaddr).toBeTruthy();
    const bareSelfAddr = selfMultiaddr!.split('/p2p/')[0]!;
    // NetNode keeps the caller's config object by reference (this.config =
    // config), so pushing after start() still reaches the manager's seed list.
    configA.bootstrapPeers.push(bareSelfAddr);

    const internals = nodeA as unknown as Internals;
    internals.outboundTick();
    await new Promise((r) => setTimeout(r, 1000));

    expect(nodeA.peers()).toEqual([]);
    expect(nodeA.getConnectedPeers()).toEqual([]);
    expect(nodeA.libp2pNode?.getConnections()).toEqual([]);

    // Retired for the manager's lifetime: a second tick plans no seed dial.
    internals.outboundTick();
    await new Promise((r) => setTimeout(r, 300));
    expect(nodeA.libp2pNode?.getConnections()).toEqual([]);
  }, TIMEOUT);

  it('the fill phase runs the outbound handshake', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    nodeB = new NetNode(makeBaseConfig({ bootstrapPeers: [], minPeers: 0 }), validators);
    await nodeB.start();

    const internalsB = nodeB as unknown as Internals;
    internalsB.peerDb.record({
      address: aAddr!,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });

    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 3000));

    expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
  }, TIMEOUT);

  it('a PeerDb candidate that resolves to ourselves is closed and forgotten', async () => {
    nodeB = new NetNode(makeBaseConfig({ bootstrapPeers: [], minPeers: 0 }), validators);
    await nodeB.start();

    // A spelling PeerDb's self-address filter does not match — the listen
    // addresses recorded at start() are IP literals, not this DNS name — so
    // the record is admitted, and only the funnel's peer-id check catches it.
    const bAddrs = nodeB.libp2pNode?.getMultiaddrs() ?? [];
    const port = bAddrs[0]?.toString().match(/tcp\/(\d+)/)?.[1];
    expect(port).toBeTruthy();
    const selfCandidate = `/dns4/localhost/tcp/${port}`;

    const internalsB = nodeB as unknown as Internals;
    const record = {
      address: selfCandidate,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    };
    internalsB.peerDb.record(record);

    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 1500));

    expect(nodeB.libp2pNode?.getConnections()).toEqual([]);
    expect(internalsB.peerDb.get(selfCandidate)).toBeNull();

    // Forgotten AND filtered thereafter — a later record of the same address
    // is dropped (NET_INTERFACE → PeerDb).
    internalsB.peerDb.record(record);
    expect(internalsB.peerDb.get(selfCandidate)).toBeNull();
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Addresses compare without their `/p2p/` component (NET_INTERFACE →
// Outbound Manager → "Addresses compare without their `/p2p/` component") —
// a connected candidate recorded bare must not be re-dialled every tick.
// ---------------------------------------------------------------------------

describe('the fill phase does not re-dial a connected candidate recorded bare', () => {
  let nodeA: NetNode;
  let nodeB: NetNode;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('B holds exactly one connection to A across three ticks', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const aMultiaddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aMultiaddr).toBeTruthy();
    // Bare — the shape every seed carries and the shape this pin measured
    // the bug under (declaredAddress-learned keys already carry /p2p/ and
    // are unaffected).
    const bareAAddr = aMultiaddr!.split('/p2p/')[0]!;

    nodeB = new NetNode(makeBaseConfig({ bootstrapPeers: [], minPeers: 0 }), validators);
    await nodeB.start();

    const internalsB = nodeB as unknown as Internals;
    internalsB.peerDb.record({
      address: bareAAddr,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });

    for (let tick = 0; tick < 3; tick++) {
      internalsB.outboundTick();
      await new Promise((r) => setTimeout(r, 1500));
      expect(nodeB.libp2pNode?.getConnections()).toHaveLength(1);
      expect(nodeB.getConnectedPeers()).toEqual([nodeA.peerId()]);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// A banned peer is never handshaken (NET_INTERFACE → "A banned peer's
// handshake is refused unread"; NET_INTERFACE → "A ban carries every address
// its peer has been tied to") — driven through the real outbound funnel: the
// dial, the own-peer check, the ban check, then the handshake for anyone else.
// ---------------------------------------------------------------------------

describe('the outbound funnel refuses a banned peer before the handshake', () => {
  let nodeA: NetNode;
  let nodeB: NetNode;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
  });

  it('a permanently banned candidate is closed before the handshake', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const aId = nodeA.peerId();
    const aMultiaddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aMultiaddr).toBeTruthy();
    const bareAAddr = aMultiaddr!.split('/p2p/')[0]!;

    nodeB = new NetNode(makeBaseConfig({ bootstrapPeers: [], minPeers: 0 }), validators);
    await nodeB.start();
    const internalsB = nodeB as unknown as Internals;

    // Banned before any connection — the funnel is what has to catch this,
    // not the inbound handler (there is no inbound handshake here at all).
    internalsB.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, aId, 'test');
    internalsB.peerDb.record({
      address: bareAAddr,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });

    const logSpy = vi.spyOn(console, 'log');
    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 1500));
    const logs = logSpy.mock.calls.map((args) => String(args[0]));
    logSpy.mockRestore();

    expect(nodeB.libp2pNode?.getConnections()).toEqual([]);
    expect(nodeB.getConnectedPeers()).toEqual([]);
    expect(nodeA.getConnectedPeers()).toEqual([]);
    expect(internalsB.peerDb.isBanned(bareAAddr)).toBe(true);
    expect(internalsB.peerDb.get(bareAAddr)).toBeNull();

    // The mechanism, named: the funnel's own line fired, and no handshake
    // line did — a test going green on some other guard would prove nothing
    // about this one.
    expect(logs.some((l) => l.includes(`resolved to banned peer ${aId}`))).toBe(true);
    expect(logs.some((l) => l.includes('outbound handshake with'))).toBe(false);
  }, TIMEOUT);

  it('a temporally banned peer does not become Active through a second spelling', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const aId = nodeA.peerId();
    const aMultiaddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aMultiaddr).toBeTruthy();
    const port = aMultiaddr!.match(/tcp\/(\d+)/)?.[1];
    expect(port).toBeTruthy();
    const ipAddr = `/ip4/127.0.0.1/tcp/${port}`;
    const dnsAddr = `/dns4/localhost/tcp/${port}`;

    nodeB = new NetNode(makeBaseConfig({ bootstrapPeers: [], minPeers: 0 }), validators);
    await nodeB.start();
    const internalsB = nodeB as unknown as Internals;

    // Record bare, tick, settle — the fill phase dials A and both sides go Active.
    internalsB.peerDb.record({
      address: ipAddr,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });
    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 3000));
    expect(nodeB.getConnectedPeers()).toContain(aId);
    expect(nodeB.libp2pNode?.getConnections()).toHaveLength(1);

    // A second spelling of the same host, learned separately (a gossiped
    // entry or a second seed would arrive this way — DNS resolves to the
    // same loopback target the live connection already holds).
    internalsB.peerDb.record({
      address: dnsAddr,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });

    internalsB.peerMgr.recordPenalty('misbehavior', aId, 500, 'test');
    // Control: the ban takes A out of the peers map at once and leaves the
    // live connection open — a ban does not hang up a connection; it is the
    // SECOND tick this test measures.
    expect(nodeB.getConnectedPeers()).not.toContain(aId);
    expect(nodeB.libp2pNode?.getConnections()).toHaveLength(1);

    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 1500));

    expect(nodeB.getConnectedPeers()).not.toContain(aId);
    expect(internalsB.peerMgr.getPeerMetadata(aId)?.state).not.toBe(PeerState.Active);
    expect(internalsB.peerDb.isBanned(dnsAddr)).toBe(true);
    expect(nodeB.libp2pNode?.getConnections().length).toBeLessThanOrEqual(1);
  }, TIMEOUT);

  it('a seed that resolves to a banned peer is dialled again on the next tick', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const aId = nodeA.peerId();
    const aMultiaddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aMultiaddr).toBeTruthy();
    const bareAAddr = aMultiaddr!.split('/p2p/')[0]!;

    const configB = makeConfig();
    nodeB = new NetNode(configB, validators);
    await nodeB.start();
    const internalsB = nodeB as unknown as Internals;

    internalsB.peerMgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, aId, 'test');
    // NetNode keeps the caller's config object by reference (this.config =
    // config), so pushing after start() still reaches the manager's seed list.
    configB.bootstrapPeers.push(bareAAddr);

    const logSpy = vi.spyOn(console, 'log');

    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 1500));

    let logs = logSpy.mock.calls.map((args) => String(args[0]));
    expect(logs.filter((l) => l.includes(`resolved to banned peer ${aId}`))).toHaveLength(1);
    expect(logs.some((l) => l.includes('outbound handshake with'))).toBe(false);
    expect(nodeB.libp2pNode?.getConnections()).toEqual([]);
    expect(nodeB.getConnectedPeers()).toEqual([]);
    expect(nodeA.getConnectedPeers()).toEqual([]);

    // The floor keeps listing a banned seed while the ban stands
    // (NET_INTERFACE → Outbound Manager, Floor phase) — a second tick dials
    // it again, at the same cost as an unreachable seed.
    internalsB.outboundTick();
    await new Promise((r) => setTimeout(r, 1500));

    logs = logSpy.mock.calls.map((args) => String(args[0]));
    logSpy.mockRestore();
    expect(logs.filter((l) => l.includes(`resolved to banned peer ${aId}`))).toHaveLength(2);
    expect(nodeB.libp2pNode?.getConnections()).toEqual([]);
  }, TIMEOUT);
});
