import { describe, it, expect, vi } from 'vitest';
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
import { NetNode } from '../src/node.js';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import { PeerState, PenaltyKind } from '../src/types.js';
import type { NetValidators } from '../src/types.js';
import { makeConfig } from './helpers.js';
import type { PeerManager } from '../src/peer-mgr.js';
import { PeerDb } from '../src/peerdb.js';
import type { PeerStorage } from '../src/peerdb.js';

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

const stubStore: SyncStore = {
  getOrderingBlockId: () => null,
  heightByBlockId: () => null,
  chainHeight: () => 0,
};

interface Internals {
  libp2p: unknown;
  peerMgr: PeerManager;
  syncMachine: SyncMachine | null;
}

// NET_INTERFACE → "A ban ends the connection"
describe('a ban hangs up the peer and tells the sync machine', () => {
  function makeHarness() {
    const config = makeConfig();
    const net = new NetNode(config, validators);
    const internals = net as unknown as Internals;
    const hangUp = vi.fn(() => Promise.resolve());
    const conns = [{ remotePeer: { toString: () => 'peer1' } }];
    internals.libp2p = {
      getConnections: () => [...conns],
      hangUp,
      getPeers: () => conns.map((c) => c.remotePeer),
    };
    // Inject a sync machine so the retained-height drop is observable
    const sm = new SyncMachine(config, stubStore, () => {});
    internals.syncMachine = sm;

    const pm = internals.peerMgr;
    pm.addPeer({ id: 'peer1', multiaddrs: [], protocols: [], connectedAt: 0 });
    pm.setPeerState('peer1', PeerState.Active);
    pm.setPeerAddress('peer1', '/ip4/51.15.0.1/tcp/4001');

    sm.onPeerActive('peer1', 100, 'outbound');
    sm.flush();
    return { net, pm, hangUp, sm, conns };
  }

  it('a permanent ban hangs up the connection and drops the retained claim', () => {
    const { pm, hangUp, sm, conns } = makeHarness();
    pm.recordPenalty('permanent', 'peer1', 0, 'test');

    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(hangUp).toHaveBeenCalledWith(conns[0]!.remotePeer);
    expect(pm.getPeerMetadata('peer1')).toBeNull();
    sm?.flush();
    expect(sm?.getClaimsForTest().has('peer1')).toBe(false);
  });

  it('a temporal ban at the threshold hangs up the connection', () => {
    const { pm, hangUp, sm } = makeHarness();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    pm.recordPenalty('misbehavior', 'peer1', 500, 'test');

    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(pm.isBanned('peer1')).toBe(true);
    sm?.flush();
    expect(sm?.getClaimsForTest().has('peer1')).toBe(false);
  });

  it('a ban of a peer with no connection calls hangUp zero times', () => {
    const net = new NetNode(makeConfig(), validators);
    const internals = net as unknown as Internals;
    const hangUp = vi.fn(() => Promise.resolve());
    internals.libp2p = {
      getConnections: () => [],
      hangUp,
      getPeers: () => [],
    };
    const pm = internals.peerMgr;
    pm.addPeer({ id: 'ghost', multiaddrs: [], protocols: [], connectedAt: 0 });
    pm.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'ghost', 'test');

    expect(hangUp).not.toHaveBeenCalled();
    expect(pm.isBanned('ghost')).toBe(true);
  });

  // NET_INTERFACE → PeerDb → "Persistence" — a throw from PeerDb's storage
  // does not keep the ban's hang-up from firing.
  it('a storage.delete throw during the address propagation still hangs up the connection', () => {
    const config = makeConfig();
    const net = new NetNode(config, validators);
    const internals = net as unknown as Internals & { peerDb: PeerDb };
    const hangUp = vi.fn(() => Promise.resolve());
    const conns = [{ remotePeer: { toString: () => 'peer1' } }];
    internals.libp2p = {
      getConnections: () => [...conns],
      hangUp,
      getPeers: () => conns.map((c) => c.remotePeer),
    };

    const ADDR = '/ip4/51.15.0.1/tcp/4001';
    let deleteThrows = false;
    const storage: PeerStorage = {
      loadAll: () => [],
      put: () => {},
      delete: () => { if (deleteThrows) throw new Error('storage delete dead'); },
    };
    const peerDb = new PeerDb(storage, 100, []);
    peerDb.record({
      address: ADDR,
      lastSeenMs: 1,
      agentName: 'a',
      nodeName: 'b',
      protocolVersion: 1,
      capabilities: [],
    });
    internals.peerDb = peerDb;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pm = internals.peerMgr;
    pm.addPeer({ id: 'peer1', multiaddrs: [], protocols: [], connectedAt: 0 });
    pm.setPeerAddress('peer1', ADDR);

    deleteThrows = true;
    pm.recordPenalty('permanent', 'peer1', 0, 'test');

    expect(hangUp).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
