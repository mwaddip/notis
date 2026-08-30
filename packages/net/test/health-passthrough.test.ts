import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, encodeStruct } from '@dagsocial/types';
import { syncInfoCodec } from '../src/sync-codec.js';
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
import { buildHandshakeFrame } from '../src/handshake.js';
import { MSG_SYNC_INFO, PenaltyKind } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import type { PeerManager } from '../src/peer-mgr.js';

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

function makeConfig(): NetConfig {
  return {
    magic: MAGIC,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 120_000,
    syncRequestTimeoutMs: 10_000,
  };
}

function stubStore(overrides: Partial<SyncStore> = {}): SyncStore {
  return {
    getOrderingBlock: () => null,
    serializeOrderingBlock: () => null,
    getOrderingBlockId: () => null,
    heightByBlockId: () => null,
    chainHeight: () => 0,
    appendBlocks: () => {},
    ...overrides,
  };
}

type StreamHandler = (arg: {
  stream: unknown;
  connection: {
    remotePeer: { toString(): string };
    remoteAddr?: { toString(): string };
    direction?: string;
  };
}) => Promise<void>;

function makeHandshakeHarness() {
  const net = new NetNode(makeConfig(), validators);
  const peerId = 'peer-under-test';

  let handshakeHandler: StreamHandler | null = null;
  const internals = net as unknown as {
    libp2p: unknown;
    peerMgr: PeerManager;
    syncMachine: SyncMachine | null;
    registerHandshakeHandler(libp2p: unknown): void;
  };

  internals.libp2p = {
    handle: (_protocol: string, cb: StreamHandler) => {
      handshakeHandler = cb;
    },
    getMultiaddrs: () => [],
    peerId: { toString: () => 'self-peer-id' },
  };

  internals.peerMgr.addPeer({
    id: peerId,
    multiaddrs: [],
    protocols: [],
    connectedAt: Date.now(),
  });

  internals.registerHandshakeHandler(internals.libp2p);
  if (!handshakeHandler) throw new Error('handler not registered');

  const sendHandshake = async (
    frame: Uint8Array,
    direction: 'inbound' | 'outbound' = 'inbound',
  ): Promise<Uint8Array[]> => {
    const written: Uint8Array[] = [];
    const stream = {
      source: (async function* () { yield frame; })(),
      sink: async (chunks: Iterable<Uint8Array>) => {
        for await (const c of chunks) written.push(c);
      },
      close: async () => {},
    };
    await handshakeHandler!({
      stream,
      connection: {
        remotePeer: { toString: () => peerId },
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' },
        direction,
      },
    });
    return written;
  };

  return { net, peerId, peerMgr: internals.peerMgr, sendHandshake };
}

function validHandshakeFrame(): Uint8Array {
  return buildHandshakeFrame(MAGIC, {
    agentName: 'dagsocial/1.0.0',
    protocolVersion: PROTOCOL_VERSION,
    nodeName: 'peer',
    chainHeight: 7,
    capabilities: [],
    sessionMagic: 1234,
  });
}

// ---------------------------------------------------------------------------
// syncPhase (NET_INTERFACE → API → Node Lifecycle)
// ---------------------------------------------------------------------------

describe('syncPhase', () => {
  it('returns idle before start', () => {
    const net = new NetNode(makeConfig(), validators);
    expect(net.syncPhase()).toBe('idle');
  });

  it('follows the sync machine through idle → syncing', () => {
    const machine = new SyncMachine(makeConfig(), stubStore(), () => {});
    machine.start();

    const net = new NetNode(makeConfig(), validators);
    (net as unknown as { syncMachine: SyncMachine | null }).syncMachine = machine;

    expect(net.syncPhase()).toBe('idle');

    machine.onPeerActive('peer1', 100);
    machine.flush();
    expect(net.syncPhase()).toBe('syncing');

    machine.stop();
  });

  it('returns idle when the machine is null (after stop)', () => {
    const net = new NetNode(makeConfig(), validators);
    (net as unknown as { syncMachine: SyncMachine | null }).syncMachine = null;
    expect(net.syncPhase()).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// onPeerActive with direction (NET_INTERFACE → Sync Handler Registration)
// ---------------------------------------------------------------------------

describe('onPeerActive', () => {
  it('fires with peerId and inbound direction', async () => {
    const { net, peerId, sendHandshake } = makeHandshakeHarness();
    const events: Array<{ id: string; dir: string }> = [];
    net.onPeerActive((id, dir) => events.push({ id, dir }));

    await sendHandshake(validHandshakeFrame(), 'inbound');

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(peerId);
    expect(events[0]!.dir).toBe('inbound');
  });

  it('fires with outbound direction', async () => {
    const { net, sendHandshake } = makeHandshakeHarness();
    const events: Array<{ id: string; dir: string }> = [];
    net.onPeerActive((id, dir) => events.push({ id, dir }));

    await sendHandshake(validHandshakeFrame(), 'outbound');

    expect(events).toHaveLength(1);
    expect(events[0]!.dir).toBe('outbound');
  });

  it('a one-arg callback still works (additive)', async () => {
    const { net, peerId, sendHandshake } = makeHandshakeHarness();
    const ids: string[] = [];
    (net.onPeerActive as (cb: (id: string) => void) => void)((id) => ids.push(id));

    await sendHandshake(validHandshakeFrame());

    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(peerId);
  });
});

// ---------------------------------------------------------------------------
// onPeerDisconnected (NET_INTERFACE → Sync Handler Registration)
// ---------------------------------------------------------------------------

describe('onPeerDisconnected', () => {
  it('fires with peerId and empty reason', () => {
    const net = new NetNode(makeConfig(), validators);
    const peerId = 'disconnect-peer';
    const internals = net as unknown as {
      peerMgr: PeerManager;
      peerDisconnectedHandlers: Array<(peerId: string, reason: string) => void>;
    };

    internals.peerMgr.addPeer({
      id: peerId,
      multiaddrs: [],
      protocols: [],
      connectedAt: Date.now(),
    });

    const events: Array<{ id: string; reason: string }> = [];
    net.onPeerDisconnected((id, r) => events.push({ id, reason: r }));

    for (const cb of internals.peerDisconnectedHandlers) {
      cb(peerId, '');
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(peerId);
    expect(events[0]!.reason).toBe('');
  });
});

// ---------------------------------------------------------------------------
// onPeerPenalised (NET_INTERFACE → Sync Handler Registration)
// ---------------------------------------------------------------------------

describe('onPeerPenalised', () => {
  it('fires on penalizePeer with misbehavior', () => {
    const { net, peerId } = makeHandshakeHarness();
    const events: Array<{ id: string; kind: string; detail: string | null }> = [];
    net.onPeerPenalised((id, k, d) => events.push({ id, kind: k, detail: d }));

    net.penalizePeer(peerId, 'misbehavior', 'bad block');

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(peerId);
    expect(events[0]!.kind).toBe('misbehavior');
    expect(events[0]!.detail).toBe('bad block');
  });

  it('fires on penalizePeer with transient', () => {
    const { net, peerId } = makeHandshakeHarness();
    const events: Array<{ id: string; kind: string; detail: string | null }> = [];
    net.onPeerPenalised((id, k, d) => events.push({ id, kind: k, detail: d }));

    net.penalizePeer(peerId, 'transient', 'slow response');

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('transient');
    expect(events[0]!.detail).toBe('slow response');
  });

  it('fires on a direct peerMgr.recordPenaltyKind call (funnel coverage)', () => {
    const net = new NetNode(makeConfig(), validators);
    const peerId = 'funnel-peer';
    const internals = net as unknown as { peerMgr: PeerManager };

    internals.peerMgr.addPeer({
      id: peerId,
      multiaddrs: [],
      protocols: [],
      connectedAt: Date.now(),
    });

    const events: Array<{ id: string; kind: string; detail: string | null }> = [];
    net.onPeerPenalised((id, k, d) => events.push({ id, kind: k, detail: d }));

    internals.peerMgr.recordPenaltyKind(
      PenaltyKind.Transient, peerId, 'direct call',
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(peerId);
    expect(events[0]!.kind).toBe('transient');
    expect(events[0]!.detail).toBe('direct call');
  });

  it('fires on a direct peerMgr.recordPenalty call (funnel coverage)', () => {
    const net = new NetNode(makeConfig(), validators);
    const peerId = 'funnel-peer-2';
    const internals = net as unknown as { peerMgr: PeerManager };

    internals.peerMgr.addPeer({
      id: peerId,
      multiaddrs: [],
      protocols: [],
      connectedAt: Date.now(),
    });

    const events: Array<{ id: string; kind: string; detail: string | null }> = [];
    net.onPeerPenalised((id, k, d) => events.push({ id, kind: k, detail: d }));

    internals.peerMgr.recordPenalty('misbehavior', peerId, 100, 'direct misbehavior');

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(peerId);
    expect(events[0]!.kind).toBe('misbehavior');
    expect(events[0]!.detail).toBe('direct misbehavior');
  });

  it('fires on handshake rejection penalty', async () => {
    const { net, peerId, sendHandshake } = makeHandshakeHarness();
    const events: Array<{ id: string; kind: string; detail: string | null }> = [];
    net.onPeerPenalised((id, k, d) => events.push({ id, kind: k, detail: d }));

    // A well-framed body that fails the codec (empty agentName) is a body-tier
    // malformed handshake — rejected and penalised, firing the event. A high
    // declared version is no longer a rejection: peering is by era coverage, so
    // a newer build is accepted (NET_INTERFACE → Handshake).
    const badFrame = buildHandshakeFrame(MAGIC, {
      agentName: '',
      protocolVersion: 1,
      nodeName: 'peer',
      chainHeight: 7,
      capabilities: [],
      sessionMagic: 1234,
    });

    await sendHandshake(badFrame);

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(peerId);
    expect(events[0]!.detail).toContain('handshake');
  });
});

// ---------------------------------------------------------------------------
// H6 — onSyncComplete fires on every entry into synced, not only the first
// ---------------------------------------------------------------------------

describe('onSyncComplete fires on every entry into synced', () => {
  it('fires twice when synced is entered twice', () => {
    let height = 0;
    const machine = new SyncMachine(
      makeConfig(),
      stubStore({ chainHeight: () => height }),
      () => {},
    );
    machine.start();

    let count = 0;
    machine.onSynced(() => { count++; });

    machine.onPeerActive('peer1', 100);
    machine.flush();
    expect(machine.getState().phase).toBe('syncing');

    height = 100;
    machine.handleMessage('peer1', MSG_SYNC_INFO, encodeStruct(syncInfoCodec,
      { tipHeight: 100 },
    ));
    machine.flush();
    expect(machine.getState().phase).toBe('synced');
    expect(count).toBe(1);

    machine.onPeerActive('peer2', 200);
    machine.flush();
    expect(machine.getState().phase).toBe('syncing');

    height = 200;
    machine.handleMessage('peer2', MSG_SYNC_INFO, encodeStruct(syncInfoCodec,
      { tipHeight: 200 },
    ));
    machine.flush();
    expect(machine.getState().phase).toBe('synced');
    expect(count).toBe(2);

    machine.stop();
  });
});
