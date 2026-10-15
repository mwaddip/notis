import { describe, it, expect, afterEach } from 'vitest';
import type { Stream } from '@libp2p/interface';
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
import { encodeSyncInfo, encodeGetBlocks } from '../src/sync-codec.js';
import { MAGIC_TESTNET } from '../src/frame.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Stream Protocols → "Every inbound stream ends" and
// "A peer's sync streams are served one at a time"
//
// Two real nodes over TCP: anything a stream carries goes through
// libp2p.dialProtocol + sink + close, the way requestHeaders and sendToPeer
// do. libp2p 1.9.4's inbound limit per protocol per connection is 32 by
// default (`DEFAULT_MAX_INBOUND_STREAMS`), and the muxer aborts the next
// stream with `ERR_TOO_MANY_INBOUND_PROTOCOL_STREAMS`.
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

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    syncRequestTimeoutMs: 2_000,
    ...overrides,
  });
}

// Generous bound for two TCP nodes shaking hands.
const TIMEOUT = 30_000;

// A deliberately large chain response: 100 blocks of ~160 KB each is 16 MB,
// comfortably above the serve byte cap (4 MiB), so one 100-block GetBlocks
// answer saturates the write cap, which fills the muxer's send window and
// parks the writer on an unread reader.
function makeBigBlock(height: number): OrderingBlock {
  // 160 KB of filler per transaction, times a few, so the block body is heavy.
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

/** Wait until B lists A in its connected peers (handshake complete). */
async function waitConnected(nodeA: NetNode, nodeB: NetNode, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodeB.getConnectedPeers().includes(nodeA.peerId())
        && nodeA.getConnectedPeers().includes(nodeB.peerId())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('peers did not connect in time');
}

/** Count open inbound sync streams `conn` currently holds. */
function inboundSyncStreams(libp2p: NonNullable<NetNode['libp2pNode']>, fromPeerId: string): number {
  const conn = libp2p.getConnections().find((c) => c.remotePeer.toString() === fromPeerId);
  if (!conn) return 0;
  return conn.streams.filter((s) =>
    (s as unknown as { protocol?: string }).protocol === SYNC_PROTOCOL
    && (s as unknown as { direction?: string }).direction === 'inbound',
  ).length;
}

/**
 * Dial the sync protocol, send one framed message, close the stream. Returns
 * true on success, false if the dial itself failed — libp2p aborts a stream
 * when the receiver's inbound limit is reached, which fails the dial.
 */
async function pushOne(from: NetNode, toPeerId: string, body: Uint8Array): Promise<boolean> {
  const libp2p = from.libp2pNode!;
  const peer = libp2p.getPeers().find((p) => p.toString() === toPeerId);
  if (!peer) throw new Error('peer not connected at libp2p layer');
  try {
    const s = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(2_000),
    });
    await s.sink([body]);
    await s.close().catch(() => { /* already gone */ });
    return true;
  } catch {
    return false;
  }
}

describe('every inbound sync stream ends — 40 SyncInfos leave none open', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it.fails('after 40 SyncInfos from A, B holds no open inbound sync stream from A', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    let sent = 0;
    for (let i = 0; i < 40; i++) {
      const body = encodeSyncInfo(MAGIC, { tipHeight: i });
      if (await pushOne(nodeA, nodeB.peerId(), body)) sent++;
    }
    // Pre-flip control: a non-trivial number got through on A's side.
    expect(sent).toBeGreaterThan(0);

    // Give B's registrar time to settle its stream list after each push.
    await new Promise((r) => setTimeout(r, 500));

    const open = inboundSyncStreams(nodeB.libp2pNode!, nodeA.peerId());
    expect(open).toBe(0);
  }, TIMEOUT);

  it('after 10 SyncInfos from A, A.requestHeaders(B) answers', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    for (let i = 0; i < 10; i++) {
      const body = encodeSyncInfo(MAGIC, { tipHeight: i });
      expect(await pushOne(nodeA, nodeB.peerId(), body)).toBe(true);
    }

    // No chain on either side — a GetHeaders without a provider answers zero
    // bytes, and requestHeaders returns []. That is an answer, not a throw.
    const result = await nodeA.requestHeaders(0, 1, nodeB.peerId())
      .catch((err: unknown) => err);
    expect(result instanceof Error).toBe(false);
  }, TIMEOUT);

  it.fails('after 40 SyncInfos from A, A.requestHeaders(B) answers rather than throwing', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    for (let i = 0; i < 40; i++) {
      const body = encodeSyncInfo(MAGIC, { tipHeight: i });
      await pushOne(nodeA, nodeB.peerId(), body);
    }

    // Give B's registrar time to settle.
    await new Promise((r) => setTimeout(r, 500));

    const result = await nodeA.requestHeaders(0, 1, nodeB.peerId())
      .catch((err: unknown) => err);
    expect(result instanceof Error).toBe(false);
  }, TIMEOUT);
});

describe('a peer refused above the stream cap — 16 unread streams, no 17th', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;
  const held: Array<{ release?: () => void }> = [];

  afterEach(async () => {
    // Release the hung sinks so the stop can tear their streams down.
    for (const h of held) h.release?.();
    held.length = 0;
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  /**
   * Open a sync stream, send one chunk, and hold the write-half open — the
   * sink awaits a generator that never completes. Returns the stream so the
   * caller can tear it down, and a `release` that lets the generator return
   * (so stop() can close).
   */
  async function dialAndHold(from: NetNode, toPeerId: string, body: Uint8Array): Promise<{ stream: Stream; release: () => void } | null> {
    const libp2p = from.libp2pNode!;
    const peer = libp2p.getPeers().find((p) => p.toString() === toPeerId);
    if (!peer) return null;
    try {
      const stream = await libp2p.dialProtocol(peer, SYNC_PROTOCOL, {
        signal: AbortSignal.timeout(2_000),
      });
      let release!: () => void;
      const hangForever = new Promise<void>((resolve) => { release = resolve; });
      const gen = (async function* () {
        yield body;
        await hangForever;
      })();
      void stream.sink(gen).catch(() => { /* teardown — expected */ });
      return { stream, release };
    } catch {
      return null;
    }
  }

  it.fails('16 unread GetBlocks streams held open on A, B.dialProtocol for the 17th is refused', async () => {
    nodeA = new NetNode(makeConfig(), validators);
    nodeA.setHeadersHandler((h) => (h >= 1 && h <= 100 ? makeBigBlock(h) : null));
    nodeA.setChainHeightProvider(() => 100);
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr] }), validators);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    const req = encodeGetBlocks(MAGIC, { startHeight: 1, endHeight: 100 });
    let opened = 0;
    for (let i = 0; i < 16; i++) {
      const h = await dialAndHold(nodeB, nodeA.peerId(), req);
      if (h) {
        held.push(h);
        opened++;
      }
    }
    // Pre-flip control: the 16 streams did go on the wire. 16 is the number
    // the register states — kept as a literal here so a future bump of the
    // export does not quietly change what this case asks.
    expect(opened).toBe(16);

    // Give A's handler time to begin writing — the ~16 MB response parks on
    // yamux's send window because B's dial never reads the stream.
    await new Promise((r) => setTimeout(r, 1_000));

    // The 17th stream. libp2p aborts the muxer stream when the receiver's
    // registered limit is reached — `.catch` reads that back as a thrown dial.
    let result17: Stream | Error;
    try {
      const peer = nodeB.libp2pNode!.getPeers().find((p) => p.toString() === nodeA!.peerId())!;
      result17 = await nodeB.libp2pNode!.dialProtocol(peer, SYNC_PROTOCOL, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (err) {
      result17 = err as Error;
    }
    expect(result17 instanceof Error).toBe(true);
  }, TIMEOUT);
});
