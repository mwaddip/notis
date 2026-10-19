import { describe, it, expect, afterEach } from 'vitest';
import type { ProtocolEra } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../src/frame.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
import type { PeerDb } from '../src/peerdb.js';
import type { PeerManager } from '../src/peer-mgr.js';
import type { OutboundManager } from '../src/outbound-mgr.js';
import { multiaddr } from '@multiformats/multiaddr';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A handshake that does not complete ends its
// connection"; → "A connection handshakes within its deadline, or is closed"
// ---------------------------------------------------------------------------

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

interface Internals {
  peerDb: PeerDb;
  peerMgr: PeerManager;
  outboundMgr: OutboundManager;
  outboundTick(): void;
  dialAndHandshake(addr: string, source: 'seed' | 'candidate'): Promise<boolean>;
}

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    bootstrapPeers: [],
    minPeers: 0,
    ...overrides,
  });
}

const TIMEOUT = 25_000;

describe('a refused inbound handshake closes its connection', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake → "A handshake that does not complete ends its
  // connection". A peer on another network sends a frame A's magic rejects —
  // frame-tier, no penalty — and A's handler closes the connection it ran on.
  it.fails('a frame-tier refusal ends A\'s connection to the peer', async () => {
    nodeA = new NetNode(makeConfig({ magic: MAGIC_TESTNET }), validators);
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    nodeB = new NetNode(makeConfig({ magic: MAGIC_MAINNET }), validators);
    await nodeB.start();
    const bId = nodeB.peerId();

    const internalsB = nodeB as unknown as Internals;
    const ok = await internalsB.dialAndHandshake(aAddr!, 'candidate');

    // control: B's handshake with A does not complete
    expect(ok).toBe(false);
    // control: A records no penalty on B — a frame tier reject is a wrong
    // network, indistinguishable from a corrupt link
    const internalsA = nodeA as unknown as Internals;
    expect(internalsA.peerMgr.getPeerMetadata(bId)?.penaltyCount ?? 0).toBe(0);
    expect(internalsA.peerMgr.isBanned(bId)).toBe(false);

    // the connection A held to B is closed; the hang-up is asynchronous, so
    // give libp2p a tick to finish the close
    await new Promise((r) => setTimeout(r, 1500));
    const aConnsToB = nodeA.libp2pNode!.getConnections()
      .filter((c) => c.remotePeer.toString() === bId);
    expect(aConnsToB).toHaveLength(0);
  }, TIMEOUT);
});

describe('a body-tier refusal closes its connection too', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake → "Ban policy": a body-tier version mismatch
  // earns a soft Transient refusal, and the connection it ran on closes with
  // the stream.
  it.fails('an unsupported-version handshake closes A\'s connection to the peer', async () => {
    const eraTwoOnly: readonly ProtocolEra[] = [{ version: 2, fromHeight: 0 }];
    nodeA = new NetNode(makeConfig({ protocolVersionSchedule: eraTwoOnly }), validators);
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    // B declares PROTOCOL_VERSION (1) through its own buildOurHandshake, which
    // is below A's era (2). A validates, refuses soft, closes.
    nodeB = new NetNode(makeConfig(), validators);
    await nodeB.start();
    const bId = nodeB.peerId();

    const internalsB = nodeB as unknown as Internals;
    const ok = await internalsB.dialAndHandshake(aAddr!, 'candidate');

    // control: B's handshake with A does not complete
    expect(ok).toBe(false);
    // control: A records a Transient on B — a version mismatch, no ban
    const internalsA = nodeA as unknown as Internals;
    expect(internalsA.peerMgr.getPeerMetadata(bId)?.penaltyCount ?? 0).toBe(1);
    expect(internalsA.peerMgr.isBanned(bId)).toBe(false);

    await new Promise((r) => setTimeout(r, 1500));
    const aConnsToB = nodeA.libp2pNode!.getConnections()
      .filter((c) => c.remotePeer.toString() === bId);
    expect(aConnsToB).toHaveLength(0);
  }, TIMEOUT);
});

describe('a dialler whose handshake does not complete closes the connection and cools the address down', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake → "A handshake that does not complete ends its
  // connection" (dialler's half); → Outbound Manager → fill phase's cooldown
  // item: an address a dialler's handshake did not complete enters the redial
  // cooldown, as a failed dial does. A dials B on another network; A's
  // outbound funnel sees the empty frame B's handler sent back.
  it.fails('A holds no connection to B and A\'s next outbound plan omits B\'s address', async () => {
    nodeB = new NetNode(makeConfig({ magic: MAGIC_MAINNET }), validators);
    await nodeB.start();
    const bMulti = nodeB.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(bMulti).toBeTruthy();
    const bareBAddr = bMulti!.split('/p2p/')[0]!;
    const bId = nodeB.peerId();

    nodeA = new NetNode(makeConfig({ magic: MAGIC_TESTNET, maxPeers: 10 }), validators);
    await nodeA.start();
    const internalsA = nodeA as unknown as Internals;

    // A holds B as a PeerDb candidate under its bare key, the shape the fill
    // phase would feed into the funnel.
    internalsA.peerDb.record({
      address: bareBAddr,
      lastSeenMs: Date.now(),
      agentName: 'test',
      nodeName: '',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
    });

    const ok = await internalsA.dialAndHandshake(bareBAddr, 'candidate');

    // control: the dial resolved false
    expect(ok).toBe(false);
    // control: A holds no connection to B
    await new Promise((r) => setTimeout(r, 1500));
    const aConnsToB = nodeA.libp2pNode!.getConnections()
      .filter((c) => c.remotePeer.toString() === bId);
    expect(aConnsToB).toHaveLength(0);

    // last: the outbound manager's plan omits B's address — the cooldown
    // excludes it from the fill phase's candidate set
    const plan = internalsA.outboundMgr.planTick([]);
    expect(plan.candidate).toBeNull();
  }, TIMEOUT);
});

describe('a connection with no handshake is closed at its deadline', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake → "A connection handshakes within its deadline,
  // or is closed". A keeps a short deadline (3 × syncRequestTimeoutMs = 3 s);
  // B keeps a long one (30 s). B dials A around the funnel, so no handshake
  // stream ever opens. A closes at its deadline, no penalty.
  it.fails('A closes the connection B opened without a handshake', async () => {
    nodeA = new NetNode(makeConfig({ syncRequestTimeoutMs: 1_000 }), validators);
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    nodeB = new NetNode(makeConfig({ syncRequestTimeoutMs: 10_000 }), validators);
    await nodeB.start();
    const bId = nodeB.peerId();

    // A plain dial, around B's funnel, opens the connection and nothing more.
    await nodeB.libp2pNode!.dial(multiaddr(aAddr!));

    // control: before A's deadline the connection stands
    await new Promise((r) => setTimeout(r, 1_500));
    expect(
      nodeA.libp2pNode!.getConnections().filter((c) => c.remotePeer.toString() === bId),
    ).toHaveLength(1);

    // last: 3 s after the open, A's deadline fires and the connection closes
    await new Promise((r) => setTimeout(r, 2_500));
    expect(
      nodeA.libp2pNode!.getConnections().filter((c) => c.remotePeer.toString() === bId),
    ).toHaveLength(0);

    // the deadline is unscored: no penalty on A, no ban
    const internalsA = nodeA as unknown as Internals;
    expect(internalsA.peerMgr.getPeerMetadata(bId)?.penaltyCount ?? 0).toBe(0);
    expect(internalsA.peerMgr.isBanned(bId)).toBe(false);
  }, 25_000);
});

describe('a handshaken connection outlives the deadline', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake → "A connection handshakes within its deadline,
  // or is closed" — a completed handshake stops the deadline, so an honest
  // pair with a short timeout survives past 3 × syncRequestTimeoutMs.
  it('an honest pair stays connected past its deadline', async () => {
    nodeA = new NetNode(makeConfig({ syncRequestTimeoutMs: 1_000 }), validators);
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    nodeB = new NetNode(makeConfig({
      syncRequestTimeoutMs: 1_000,
      bootstrapPeers: [aAddr!],
    }), validators);
    await nodeB.start();

    // Settle: both sides handshake.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
    expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());

    // Wait past 3 × syncRequestTimeoutMs; the deadline sees a completed
    // connection and does nothing.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
    expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
  }, 25_000);
});
