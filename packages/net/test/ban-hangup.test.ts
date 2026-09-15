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
import { NetNode } from '../src/node.js';
import { SyncMachine } from '../src/sync-machine.js';
import type { SyncStore } from '../src/sync-machine.js';
import { PeerState, PenaltyKind } from '../src/types.js';
import type { NetValidators } from '../src/types.js';
import { makeConfig } from './helpers.js';
import type { PeerManager } from '../src/peer-mgr.js';

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

const stubStore: SyncStore = {
  getOrderingBlock: () => null,
  serializeOrderingBlock: () => null,
  getOrderingBlockId: () => null,
  heightByBlockId: () => null,
  chainHeight: () => 0,
  appendBlocks: () => {},
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

  it('a permanent ban hangs up the connection and drops the retained height', () => {
    const { pm, hangUp, sm, conns } = makeHarness();
    pm.recordPenalty('permanent', 'peer1', 0, 'test');

    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(hangUp).toHaveBeenCalledWith(conns[0]!.remotePeer);
    expect(pm.getPeerMetadata('peer1')).toBeNull();
    sm?.flush();
    expect(sm?.peerHeight('peer1')).toBeNull();
  });

  it('a temporal ban at the threshold hangs up the connection', () => {
    const { pm, hangUp, sm } = makeHarness();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    pm.recordPenalty('misbehavior', 'peer1', 500, 'test');

    expect(hangUp).toHaveBeenCalledTimes(1);
    expect(pm.isBanned('peer1')).toBe(true);
    sm?.flush();
    expect(sm?.peerHeight('peer1')).toBeNull();
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
});
