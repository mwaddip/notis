import { describe, it, expect, afterEach } from 'vitest';
import type { ProtocolEra } from '@dagsocial/types';
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
import { PROTOCOL_VERSION } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../src/frame.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
import type { PeerDb } from '../src/peerdb.js';
import type { PeerManager } from '../src/peer-mgr.js';
import type { OutboundManager } from '../src/outbound-mgr.js';
import { multiaddr } from '@multiformats/multiaddr';
import { HANDSHAKE_PROTOCOL } from '../src/sync.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Handshake → "A handshake that does not complete ends its
// connection"; → "A connection handshakes within its deadline, or is closed"
// ---------------------------------------------------------------------------

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
  it('a frame-tier refusal ends A\'s connection to the peer', async () => {
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
  it('an unsupported-version handshake closes A\'s connection to the peer', async () => {
    const eraTwoOnly: readonly ProtocolEra[] = [{ version: 2, fromHeight: 0 }];
    nodeA = new NetNode(makeConfig({ protocolVersionSchedule: eraTwoOnly }), validators);
    const penalties: Array<{ peerId: string; kind: string }> = [];
    nodeA.onPeerPenalised((peerId, kind) => { penalties.push({ peerId, kind }); });
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
    const transients = penalties.filter((p) => p.peerId === bId && p.kind === 'transient');
    expect(transients.length).toBeGreaterThanOrEqual(1);
    const internalsA = nodeA as unknown as Internals;
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
  it('A holds no connection to B and A\'s next outbound plan omits B\'s address', async () => {
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

describe('an outbound connection libp2p opens outside the funnel handshakes', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake → "Every connection this node dialled carries its
  // handshake, whoever within the node dialled it". B dials A through libp2p
  // directly — bypassing the funnel the way a relay reservation retry, a DHT
  // query or an AutoNAT dial-back does. The node's outbound handshake runs on
  // the connection as it opens; A lists B Active, B lists A Active, and the
  // connection stands past 3 × syncRequestTimeoutMs.
  it('a direct libp2p dial handshakes and the connection outlives the deadline', async () => {
    nodeA = new NetNode(makeConfig({ syncRequestTimeoutMs: 1_000 }), validators);
    const aActive: Array<{ peerId: string; dir: string }> = [];
    nodeA.onPeerActive((peerId, dir) => { aActive.push({ peerId, dir }); });
    const aPenalties: Array<{ peerId: string; kind: string }> = [];
    nodeA.onPeerPenalised((peerId, kind) => { aPenalties.push({ peerId, kind }); });
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    nodeB = new NetNode(makeConfig({ syncRequestTimeoutMs: 1_000 }), validators);
    const bActive: Array<{ peerId: string; dir: string }> = [];
    nodeB.onPeerActive((peerId, dir) => { bActive.push({ peerId, dir }); });
    await nodeB.start();
    const aId = nodeA.peerId();
    const bId = nodeB.peerId();

    // The dial goes around B's funnel, the way libp2p opens a connection on
    // the node's own behalf — a relay reservation, a DHT query, AutoNAT.
    await nodeB.libp2pNode!.dial(multiaddr(aAddr!));

    // The handshake completes under the deadline on both sides.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(nodeA.getConnectedPeers()).toContain(bId);
    expect(nodeB.getConnectedPeers()).toContain(aId);

    // One peerActive fire per peer: the guard that the funnel's own and the
    // open hook's handshake are the same handshake, never two.
    expect(aActive.filter((e) => e.peerId === bId)).toHaveLength(1);
    expect(bActive.filter((e) => e.peerId === aId)).toHaveLength(1);

    // Past 3 × syncRequestTimeoutMs (3 s): the deadline leaves a handshaken
    // connection alone, so the connection stands.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(
      nodeA.libp2pNode!.getConnections().filter((c) => c.remotePeer.toString() === bId),
    ).toHaveLength(1);
    expect(nodeA.getConnectedPeers()).toContain(bId);
    expect(nodeB.getConnectedPeers()).toContain(aId);

    // No penalty — an honest connection past its deadline carries one.
    expect(aPenalties.filter((p) => p.peerId === bId)).toEqual([]);
    const internalsA = nodeA as unknown as Internals;
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

describe('a funnel dial runs exactly one handshake on its connection', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  // NET_INTERFACE → Handshake →
  // "Every connection this node dialled carries its handshake, whoever within the node dialled it":
  // the funnel's own and the open hook's are the same handshake — the
  // ownership mark keyed on the connection id makes whichever side
  // reaches the connection first run it, and the other waits on that
  // one. The remote's handler is invoked exactly once per outbound
  // connection the funnel dialled.
  it('the remote receives exactly one handshake stream per funnel-dialled connection', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const aAddr = nodeA.libp2pNode?.getMultiaddrs()[0]?.toString();
    expect(aAddr).toBeTruthy();

    nodeB = new NetNode(makeConfig(), validators);
    await nodeB.start();

    // Intercept A's inbound handshake handler through the registrar: the
    // wrapper counts each invocation and delegates to the original. One
    // handler invocation per inbound handshake stream, so the count
    // measures the streams the remote received.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aLibp2p = nodeA.libp2pNode as any;
    const registrar = aLibp2p.components.registrar;
    const original = registrar.getHandler(HANDSHAKE_PROTOCOL);
    let handshakeStreams = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = (stream: any, connection: any): any => {
      handshakeStreams += 1;
      return original.handler(stream, connection);
    };
    await aLibp2p.unhandle(HANDSHAKE_PROTOCOL);
    await aLibp2p.handle(HANDSHAKE_PROTOCOL, wrappedHandler, original.options);

    // B dials A through B's funnel.
    const internalsB = nodeB as unknown as Internals;
    const ok = await internalsB.dialAndHandshake(aAddr!, 'candidate');
    expect(ok).toBe(true);

    // Give any stray second stream a window to arrive and be counted.
    await new Promise((r) => setTimeout(r, 500));

    // The remote received exactly one handshake stream per connection.
    expect(handshakeStreams).toBe(1);
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
    expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
  }, 25_000);
});
