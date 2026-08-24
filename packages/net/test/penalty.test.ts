import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PeerManager } from '../src/peer-mgr.js';
import { NetNode } from '../src/node.js';
import { PenaltyKind } from '../src/types.js';
import type { NetConfig, NetValidators, Peer } from '../src/types.js';

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    magic: 0x54444147,
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 50,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3600000,
    penaltySafeIntervalMs: 120000,
    syncRequestTimeoutMs: 10000,
    ...overrides,
  };
}

function makePeer(id: string): Peer {
  return {
    id,
    multiaddrs: [`/ip4/127.0.0.1/tcp/${9000 + parseInt(id)}`],
    protocols: [],
    connectedAt: Date.now(),
  };
}

describe('penalty attribution (using PeerManager)', () => {
  let mgr: PeerManager;
  let config: NetConfig;

  beforeEach(() => {
    config = makeConfig();
    mgr = new PeerManager(config);
  });

  it('ProtocolViolation permanently bans and removes the peer', () => {
    mgr.addPeer(makePeer('peer1'));
    expect(mgr.getPeerCount()).toBe(1);

    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'malformed message');

    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
    expect(mgr.getPeerMetadata('peer1')).toBeNull();
  });

  it('Transient adds 50 points and does NOT ban (below threshold)', () => {
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);

    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'timeout');

    const meta = mgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
    expect(mgr.getPeerCount()).toBe(1);
    expect(mgr.isBanned('peer1')).toBe(false);
  });

  it('accumulating Transient penalties above break-even triggers temporal ban', () => {
    mgr.addPeer(makePeer('peer1'));
    // A Transient (50) decays away within half a safe interval, so only
    // faster misbehavior accrues pressure. One penalty per interval/10 nets
    // +40 per step — 50, 90, 130, … crossing 500 on the 13th penalty.
    for (let i = 0; i < 13; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(i * (config.penaltySafeIntervalMs / 10));
      mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', `timeout ${i}`);
    }

    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);
  });

  it('rapid non-fatal penalties all accrue — none are discarded (fails pre-fix)', () => {
    // Every penalty counts: a safe-interval cooldown that swallowed the second
    // one would leave penaltyCount at 1. The nonzero timestamp is what makes
    // that check meaningful — such a cooldown skips itself while
    // lastPenaltyTime is 0, so a t=0 flood would accrue either way.
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'first');
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer1', 'second — counts too');

    const meta = mgr.getPeerMetadata('peer1');
    expect(meta?.penaltyCount).toBe(2);
    expect((mgr as any).peers.get('peer1').penaltyScore).toBe(100);
  });

  it('ProtocolViolation bans instantly at zero score and regardless of decay', () => {
    // Permanent bans bypass scoring entirely — no accumulated score needed.
    mgr.addPeer(makePeer('peer1'));
    vi.spyOn(Date, 'now').mockReturnValue(0);
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer1', 'malformed');
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.getPeerMetadata('peer1')).toBeNull();

    // A peer whose score has long since decayed to nothing is still
    // permanently banned on the spot — decay never applies to permanents.
    mgr.addPeer(makePeer('peer2'));
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'peer2', 'noise');
    vi.spyOn(Date, 'now').mockReturnValue(1000 * config.penaltySafeIntervalMs);
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'peer2', 'malformed later');
    expect(mgr.isBanned('peer2')).toBe(true);
    expect(mgr.getPeerCount()).toBe(0);

    // Permanent = survives any clock advance.
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect(mgr.isBanned('peer1')).toBe(true);
    expect(mgr.isBanned('peer2')).toBe(true);
  });

  it('penalty for unknown peer is a no-op', () => {
    mgr.recordPenaltyKind(PenaltyKind.Transient, 'ghost', 'who?');
    mgr.recordPenaltyKind(PenaltyKind.ProtocolViolation, 'ghost2', '??');
    // Should not throw, no peers tracked
    expect(mgr.getPeerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NetNode.penalizePeer — node's one call into the penalty system
// ---------------------------------------------------------------------------

const stubValidators: NetValidators = {
  verifyOrderingBlockPoW: () => true,
  verifyProtocolVersion: () => true,
  verifyContentLimits: () => ({ valid: true }),
  verifyParentRefsCount: () => ({ valid: true }),
  verifyTxStructure: () => ({ valid: true }),
  verifyOrderingBlockStructure: () => ({ valid: true }),
  verifyPostBody: () => ({ valid: true }),
};

describe('NetNode.penalizePeer', () => {
  function setup() {
    const config = makeConfig();
    const net = new NetNode(config, stubValidators);
    const peerMgr: PeerManager = (net as any).peerMgr;
    peerMgr.addPeer(makePeer('peer1'));
    return { net, peerMgr, config };
  }

  it('misbehavior records 100 against the peer', () => {
    const { net, peerMgr } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(0);

    net.penalizePeer('peer1', 'misbehavior', 'bad headers');

    const meta = peerMgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
    expect((peerMgr as any).peers.get('peer1').penaltyScore).toBe(100);
  });

  it('transient records 50 against the peer', () => {
    const { net, peerMgr } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(0);

    net.penalizePeer('peer1', 'transient', 'short answer');

    const meta = peerMgr.getPeerMetadata('peer1');
    expect(meta).not.toBeNull();
    expect(meta!.penaltyCount).toBe(1);
    expect((peerMgr as any).peers.get('peer1').penaltyScore).toBe(50);
  });

  it('misbehavior reaches the manager with the stated reason', () => {
    const { net, peerMgr } = setup();
    const spy = vi.spyOn(peerMgr, 'recordPenalty');

    net.penalizePeer('peer1', 'misbehavior', 'identity mismatch');

    expect(spy).toHaveBeenCalledWith('misbehavior', 'peer1', 100, 'identity mismatch');
  });

  it('transient reaches the manager with the stated reason', () => {
    const { net, peerMgr } = setup();
    const spy = vi.spyOn(peerMgr, 'recordPenaltyKind');

    net.penalizePeer('peer1', 'transient', 'non-delivery');

    expect(spy).toHaveBeenCalledWith(PenaltyKind.Transient, 'peer1', 'non-delivery');
  });

  it('no-ops for an unknown peer', () => {
    const { net, peerMgr } = setup();

    net.penalizePeer('ghost', 'misbehavior', 'no such peer');
    net.penalizePeer('ghost', 'transient', 'no such peer');

    expect(peerMgr.getPeerCount()).toBe(1);
    expect(peerMgr.isBanned('ghost')).toBe(false);
  });
});
