import { describe, it, expect, vi } from 'vitest';
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
import type { ProtocolEra } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import { buildHandshakeFrame } from '../src/handshake.js';
import { PeerDb } from '../src/peerdb.js';
import { PeerState } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import type { PeerManager } from '../src/peer-mgr.js';

// ---------------------------------------------------------------------------
// tipApplied — the boundary sweep (NET_INTERFACE → Post-Handshake Routing) and
// the record's declared version (NET_INTERFACE → PeerDb).
//
// These drive the real NetNode against a stub libp2p — start() is a TCP
// listener, so the connection primitives (getConnections/hangUp, dial) are the
// stub's, and every other seam is the instance's own.
// ---------------------------------------------------------------------------

const MAGIC = 0x54444147;

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

function makeConfig(
  schedule: readonly ProtocolEra[] = [{ version: 1, fromHeight: 0 }],
): NetConfig {
  return {
    magic: MAGIC,
    protocolVersionSchedule: schedule,
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 120_000,
    syncRequestTimeoutMs: 10_000,
  };
}

const H = 5;
const twoEra: readonly ProtocolEra[] = [
  { version: 1, fromHeight: 0 },
  { version: 2, fromHeight: H },
];

interface Internals {
  libp2p: unknown;
  peerMgr: PeerManager;
  peerDb: PeerDb;
  outboundMgr: unknown;
  dialBootstrapPeer(addr: string): Promise<boolean>;
}

describe('tipApplied — the boundary sweep', () => {
  function makeSweepHarness() {
    const net = new NetNode(makeConfig(twoEra), validators);
    const internals = net as unknown as Internals;
    // One live connection per peer id, so disconnectPeer's getConnections().find
    // resolves a PeerId to hang up.
    const conns = ['v1', 'v2', 'v3'].map((id) => ({ remotePeer: { toString: () => id } }));
    const hangUp = vi.fn(() => Promise.resolve());
    internals.libp2p = { getConnections: () => conns, hangUp };

    const pm = internals.peerMgr;
    for (const [id, v] of [['v1', 1], ['v2', 2], ['v3', 3]] as const) {
      pm.addPeer({ id, multiaddrs: [], protocols: [], connectedAt: 0 });
      pm.setPeerState(id, PeerState.Active);
      pm.setPeerVersion(id, v);
    }
    return { net, pm, hangUp, conns };
  }

  it('drops exactly the peer below the new era, keeps the rest', () => {
    const { net, pm, hangUp, conns } = makeSweepHarness();

    // era in force is 1; tipApplied(H-1) raises it to 2 (era at (H-1)+1 = H = 2).
    net.tipApplied(H - 1);

    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(hangUp).toHaveBeenCalledWith(conns[0]!.remotePeer); // v1's connection
    expect(pm.getPeerMetadata('v1')).toBeNull();               // dropped → not Active
    expect(pm.isPeerActive('v2')).toBe(true);
    expect(pm.isPeerActive('v3')).toBe(true);
  });

  it('drops no one and calls the primitive zero times inside an era', () => {
    const { net, pm, hangUp } = makeSweepHarness();

    net.tipApplied(H - 1); // crosses to era 2 — drops v1
    expect(hangUp).toHaveBeenCalledTimes(1);

    // A second apply at the same era, and one inside the era, drop no one.
    net.tipApplied(H);     // era at H+1 = 2, not above 2
    net.tipApplied(H - 2); // era at (H-2)+1 = H-1 = 1, not above 2
    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(pm.isPeerActive('v2')).toBe(true);
    expect(pm.isPeerActive('v3')).toBe(true);
  });

  it('a peer with no declared version (never handshaken) is not swept', () => {
    const { net, pm, hangUp } = makeSweepHarness();
    // A fourth peer, Active but with a null metadata version.
    pm.addPeer({ id: 'nover', multiaddrs: [], protocols: [], connectedAt: 0 });
    pm.setPeerState('nover', PeerState.Active);
    expect(pm.getPeerMetadata('nover')?.protocolVersion).toBeNull();

    net.tipApplied(H - 1); // era 2

    expect(hangUp).toHaveBeenCalledTimes(1);        // only v1
    expect(pm.isPeerActive('nover')).toBe(true);    // null version → never the sweep's
  });
});

describe('the outbound bootstrap record keeps the peer\'s declared version', () => {
  function replyFrame(version: number): Uint8Array {
    return buildHandshakeFrame(MAGIC, {
      agentName: 'dagsocial/1.0.0',
      protocolVersion: version,
      nodeName: 'peer',
      chainHeight: 7,
      capabilities: [],
      sessionMagic: 4321,
    });
  }

  it('records 2, not our PROTOCOL_VERSION, and stamps it on the metadata', async () => {
    const net = new NetNode(makeConfig(), validators);
    const internals = net as unknown as Internals;
    const peerId = 'boot-peer';
    const addr = '/ip4/9.9.9.9/tcp/9000';
    const peerDb = new PeerDb(null, 1000, []);
    internals.peerDb = peerDb;
    internals.outboundMgr = { recordDialResult: () => {}, recordSeedPeer: () => {} };
    internals.libp2p = {
      dial: async () => ({ remotePeer: { toString: () => peerId }, direction: 'outbound' }),
      dialProtocol: async () => ({
        sink: async () => {},
        source: (async function* () { yield replyFrame(2); })(),
        close: async () => {},
      }),
      getPeers: () => [{ toString: () => peerId }],
      getMultiaddrs: () => [],
      peerId: { toString: () => 'self-peer-id' },
    };
    internals.peerMgr.addPeer({ id: peerId, multiaddrs: [], protocols: [], connectedAt: 0 });
    net.setChainHeightProvider(() => 0); // era at 1 = 1; the peer declaring 2 covers it

    const ok = await internals.dialBootstrapPeer(addr);

    expect(ok).toBe(true);
    expect(peerDb.get(addr)?.protocolVersion).toBe(2);
    expect(internals.peerMgr.getPeerMetadata(peerId)?.protocolVersion).toBe(2);
  });

  it('hands the peer the dial resolved to back to the manager (floor skips a connected seed)', async () => {
    // NET_INTERFACE → Outbound Manager, Floor phase: the mapping a bootstrap
    // dial establishes is what lets the floor skip the seed while its peer is
    // connected. dialBootstrapPeer records it the moment the dial resolves.
    const net = new NetNode(makeConfig(), validators);
    const internals = net as unknown as Internals;
    const peerId = 'boot-peer';
    const addr = '/ip4/9.9.9.9/tcp/9000';
    internals.peerDb = new PeerDb(null, 1000, []);
    const learned: Array<[string, string]> = [];
    internals.outboundMgr = {
      recordDialResult: () => {},
      recordSeedPeer: (a: string, p: string) => { learned.push([a, p]); },
    };
    internals.libp2p = {
      dial: async () => ({ remotePeer: { toString: () => peerId }, direction: 'outbound' }),
      dialProtocol: async () => ({
        sink: async () => {},
        source: (async function* () { yield replyFrame(1); })(),
        close: async () => {},
      }),
      getPeers: () => [{ toString: () => peerId }],
      getMultiaddrs: () => [],
      peerId: { toString: () => 'self-peer-id' },
    };
    internals.peerMgr.addPeer({ id: peerId, multiaddrs: [], protocols: [], connectedAt: 0 });
    net.setChainHeightProvider(() => 0);

    await internals.dialBootstrapPeer(addr);

    expect(learned).toEqual([[addr, peerId]]);
  });
});
