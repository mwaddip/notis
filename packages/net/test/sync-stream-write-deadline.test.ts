import { describe, it, expect, afterEach } from 'vitest';
import type { Stream } from '@libp2p/interface';
import {
  blockHash,
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
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

// Deadline the handshake does not race under a loaded run: `syncRequestTimeoutMs`
// is also the handshake's dial, read and write deadline, and 200 ms misses
// too often. 1 000 ms keeps the handshake clear and still makes the ×5
// Blocks deadline (`syncRequestTimeoutMs * 5` = 5 s) complete in a
// one-digit second count for two streams.
function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    syncRequestTimeoutMs: 1_000,
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
  return conn.streams.filter((s) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyS = s as any;
    if (anyS.protocol !== SYNC_PROTOCOL) return false;
    if (anyS.direction !== 'inbound') return false;
    // A stream whose overall status has moved off 'open' is not an unread
    // parked stream. 'closing' / 'closed' are the write helper's steps,
    // 'aborted' / 'reset' are the muxer's abort paths.
    if (anyS.status !== 'open') return false;
    // A `GetBlocks` answer parked on the receive window has its writable
    // end still 'writable' — A has not yet half-closed its write. Once
    // the write helper returns (or the deadline fires and the stream
    // aborts), `writeStatus` moves off 'writable'.
    if (anyS.writeStatus !== 'writable') return false;
    return true;
  }).length;
}

describe("A's write to an unreading peer times out, the stream aborts", () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it('two GetBlocks streams unread; after the two write deadlines, A holds no inbound stream from B', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    nodeA.setHeadersHandler((h) => (h >= 1 && h <= 100 ? makeBigBlock(h) : null));
    nodeA.setChainHeightProvider(() => 100);
    nodeA.setHeightByBlockIdProvider((id) => {
      for (let h = 1; h <= 100; h++) {
        if (blockHash(makeBigBlock(h).header) === id) return h;
      }
      return null;
    });
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    // Same height on both sides keeps the chain exchange trivial — A does
    // not serve B a header or block page beyond the scheduler's
    // `SyncInfo` at peer-active.
    nodeB.setChainHeightProvider(() => 100);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    // Wait until the scheduler's `SyncInfo` from B at peer-active has
    // been processed and closed before counting. The filter under
    // `inboundSyncStreams` drops streams in `closing` / `closed` /
    // `aborted` / `reset`; libp2p transitions a handler-closed stream
    // through those states. `waitConnected` returns once both peers
    // are Active, but B's scheduler queues the SyncInfo dial on its
    // event loop — the stream opens AFTER waitConnected returns.
    //
    // Poll until the count holds at 0 for 300 ms running, with a
    // deadline that fails loudly rather than wrongly below.
    const DEADLINE_MS = 10_000;
    const QUIET_MS = 300;
    const start = Date.now();
    let quietSince = -1;
    for (;;) {
      const n = inboundSyncStreams(nodeA.libp2pNode!, nodeB.peerId());
      if (n === 0) {
        if (quietSince < 0) quietSince = Date.now();
        if (Date.now() - quietSince >= QUIET_MS) break;
      } else {
        quietSince = -1;
      }
      if (Date.now() - start > DEADLINE_MS) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(inboundSyncStreams(nodeA.libp2pNode!, nodeB.peerId())).toBe(0);

    // Twenty block ids A's chain holds — ~3.2 MiB of body.
    const ids: string[] = [];
    for (let h = 1; h <= 20; h++) ids.push(blockHash(makeBigBlock(h).header)!);
    const req = encodeGetBlocks(MAGIC, { ids });
    const streams: Stream[] = [];
    for (let i = 0; i < 2; i++) {
      const libp2p = nodeB.libp2pNode!;
      const peer = libp2p.getPeers().find((p) => p.toString() === nodeA!.peerId())!;
      try {
        const stream = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
          signal: AbortSignal.timeout(2_000),
        });
        // Write the request and close B's write half. The pause keeps the
        // muxer from sending window updates back to A as data arrives, so
        // A's answer parks on the window the contract pins instead of
        // flowing through B's unread receive buffer.
        stream.send(req);
        stream.pause();
        void stream.close().catch(() => { /* already gone */ });
        streams.push(stream);
      } catch { /* a control: the number assertion below catches a short write */ }
    }
    expect(streams.length).toBe(2);

    // Give A's handler time to read the request (EOS reached since B closed
    // its write half) and begin writing the ~16 MB answer, which parks on the
    // receive window.
    await new Promise((r) => setTimeout(r, 500));

    // Two streams, parked mid-write on A.
    expect(inboundSyncStreams(nodeA.libp2pNode!, nodeB.peerId())).toBe(2);

    // Wait past two ×5 Blocks deadlines served one after another
    // (1 000 ms × 5 = 5 s each, 10 s in sequence) with headroom.
    await new Promise((r) => setTimeout(r, 12_000));

    // A node with the write deadline aborts the two streams; a node
    // without it holds them for the life of the connection.
    expect(inboundSyncStreams(nodeA.libp2pNode!, nodeB.peerId())).toBe(0);
  }, TIMEOUT);
});
