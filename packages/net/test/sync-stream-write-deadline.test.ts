import { describe, it, expect, afterEach } from 'vitest';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyPostBody,
} from '@dagsocial/validation';
import {
  PROTOCOL_VERSION,
  computeUtxoTxRoot,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { SYNC_PROTOCOL } from '../src/sync.js';
import { encodeGetBlocks } from '../src/sync-codec.js';
import { MAGIC_TESTNET } from '../src/frame.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Validation (and untrusted-input safety) →
// "A stream write is bounded in time as well"
//
// A peer that opens a `GetBlocks` stream and reads nothing of A's answer
// parks A's sink on yamux's send window. Without a deadline on the write A
// holds the serving stream for the life of the connection; with the deadline
// — syncRequestTimeoutMs for most arms, ×5 for a `Blocks` answer — A aborts
// the stream when the deadline runs out and the inbound slot clears.
// ---------------------------------------------------------------------------

const MAGIC = MAGIC_TESTNET;

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyPostBody,
};

// Short timeout so the ×5 Blocks deadline (`syncRequestTimeoutMs * 5` = 1 s)
// completes in a one-digit second count.
function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    syncRequestTimeoutMs: 200,
    ...overrides,
  });
}

// Generous bound for two TCP nodes and a deadline round trip.
const TIMEOUT = 30_000;

function makeBigBlock(height: number): OrderingBlock {
  const filler = new Uint8Array(160 * 1024).fill(height & 0xff);
  const utxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [filler],
  };
  const header: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  return { header, utxoTxTree, validatorSignature: new Uint8Array(64) };
}

async function waitConnected(nodeA: NetNode, nodeB: NetNode, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodeB.getConnectedPeers().includes(nodeA.peerId())
        && nodeA.getConnectedPeers().includes(nodeB.peerId())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('peers did not connect in time');
}

function inboundSyncStreams(libp2p: NonNullable<NetNode['libp2pNode']>, fromPeerId: string): number {
  const conn = libp2p.getConnections().find((c) => c.remotePeer.toString() === fromPeerId);
  if (!conn) return 0;
  return conn.streams.filter((s) =>
    (s as unknown as { protocol?: string }).protocol === SYNC_PROTOCOL
    && (s as unknown as { direction?: string }).direction === 'inbound',
  ).length;
}

describe("A's write to an unreading peer times out, the stream aborts", () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;
  const held: Array<() => void> = [];

  afterEach(async () => {
    for (const release of held) release();
    held.length = 0;
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it.fails('three GetBlocks streams unread; after the three write deadlines, A holds no inbound stream from B', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    nodeA.setHeadersHandler((h) => (h >= 1 && h <= 100 ? makeBigBlock(h) : null));
    nodeA.setChainHeightProvider(() => 100);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    // Same height on both sides keeps the sync machine out of the exchange —
    // A does not serve B an Inv, B does not pick A as a sync peer, so the
    // only inbound sync streams on A are the three this case opens.
    nodeB.setChainHeightProvider(() => 100);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    const req = encodeGetBlocks(MAGIC, { startHeight: 1, endHeight: 100 });
    let opened = 0;
    for (let i = 0; i < 3; i++) {
      const libp2p = nodeB.libp2pNode!;
      const peer = libp2p.getPeers().find((p) => p.toString() === nodeA!.peerId())!;
      try {
        const stream = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
          signal: AbortSignal.timeout(2_000),
        });
        // Hold the write-half open: the sink awaits a generator that never
        // completes. One-shot `release` lets the generator return at teardown.
        let release!: () => void;
        const hangForever = new Promise<void>((resolve) => { release = resolve; });
        held.push(release);
        void stream.sink((async function* () {
          yield req;
          await hangForever;
        })()).catch(() => { /* teardown — expected */ });
        opened++;
      } catch { /* ignore — pre-flip assertion catches this */ }
    }
    expect(opened).toBe(3);

    // Give A's handler time to begin writing — the ~16 MB response parks on
    // yamux's send window because the dial on B's side never reads.
    await new Promise((r) => setTimeout(r, 500));

    // Pre-flip: A has 3 inbound streams right now, parked on the write.
    expect(inboundSyncStreams(nodeA.libp2pNode!, nodeB.peerId())).toBe(3);

    // Wait past the ×5 Blocks deadline (200 ms × 5 = 1 s), with headroom.
    await new Promise((r) => setTimeout(r, 2_000));

    // A node with the write deadline aborts the three streams; a node
    // without it holds them for the life of the connection.
    expect(inboundSyncStreams(nodeA.libp2pNode!, nodeB.peerId())).toBe(0);
  }, TIMEOUT);
});
