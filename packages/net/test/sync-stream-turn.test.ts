import { describe, it, expect, afterEach } from 'vitest';
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
import { encodeGetBlocks, encodeSyncInfo } from '../src/sync-codec.js';
import { MAGIC_TESTNET } from '../src/frame.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Stream Protocols → "A peer's sync streams are served one
// at a time". A peer's next stream waits for its earlier one, and a
// waiting stream's read deadline starts at its turn — not when libp2p
// accepted it.
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

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    ...overrides,
  });
}

// Generous bound for two TCP nodes and A's ×5 Blocks write deadline.
const TIMEOUT = 30_000;

function makeHeader(height: number): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: height,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function makeBigBlock(height: number): OrderingBlock {
  const filler = new Uint8Array(160 * 1024).fill(height & 0xff);
  const utxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [filler],
  };
  return {
    header: { ...makeHeader(height), utxoTxRoot: computeUtxoTxRoot(utxoTxTree) },
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  };
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

describe("a peer's sync streams are served one at a time", () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it("B's next stream waits for its earlier one to end", async () => {
    // A: short deadline so the parked write ends at ~5 s (×5 for Blocks).
    nodeA = new NetNode(makeConfig({ syncRequestTimeoutMs: 1_000 }), validators);
    nodeA.setHeadersHandler((h) => (h >= 1 && h <= 100 ? makeBigBlock(h) : null));
    nodeA.setHeaderProvider((h) => h === 1 ? makeHeader(1) : null);
    nodeA.setChainHeightProvider(() => 100);
    nodeA.setHeightByBlockIdProvider((id) => {
      for (let h = 1; h <= 100; h++) {
        if (blockHash(makeBigBlock(h).header) === id) return h;
      }
      return null;
    });
    await nodeA.start();
    const addr = nodeA.libp2pNode!.getMultiaddrs()[0]!.toString();

    // B: a longer deadline than A's 5 s write-deadline, so requestHeaders'
    // own read deadline does not expire while waiting for the turn.
    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr], syncRequestTimeoutMs: 10_000 }), validators);
    nodeB.setChainHeightProvider(() => 100);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    // The first stream: a GetBlocks request B closes its write half on and
    // never reads. A reads the request, serves ~4 MiB, parks on the
    // receive window — the write-deadline case's shape.
    const peer = nodeB.libp2pNode!.getPeers().find((p) => p.toString() === nodeA!.peerId())!;
    const held = await nodeB.libp2pNode!.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(2_000),
    });
    // Twenty block ids that A's chain holds — enough to park A's write
    // against the receive window.
    const heavyIds: string[] = [];
    for (let h = 1; h <= 20; h++) heavyIds.push(blockHash(makeBigBlock(h).header)!);
    await held.sink([encodeGetBlocks(MAGIC, { ids: heavyIds })]);

    // Let A begin writing before the second stream arrives.
    await new Promise((r) => setTimeout(r, 300));

    const t0 = Date.now();
    const result = await nodeB.requestHeaders(['ff'.repeat(32)], nodeA.peerId())
      .catch((err: unknown) => err);
    const elapsed = Date.now() - t0;

    // A control: the second request did answer rather than throw.
    expect(result instanceof Error).toBe(false);
    expect(Array.isArray(result)).toBe(true);
    // The rule: A read B's second stream only once the first had ended.
    // A's ×5 Blocks write deadline is 5 s, so the second answer could not
    // reach B before ~4.7 s; 4 s leaves headroom for scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
  }, TIMEOUT);

  it("a waiting stream's read deadline runs from its turn", async () => {
    nodeA = new NetNode(makeConfig({ syncRequestTimeoutMs: 1_000 }), validators);
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

    // B's advertised height is 100 at handshake and 777 at the push —
    // the second value is what B's sync-machine reply reads, so A's
    // retained height after the whole exchange settles on 777 only if
    // the push itself was read.
    let bHeight = 100;
    nodeB = new NetNode(makeConfig({ bootstrapPeers: [addr], syncRequestTimeoutMs: 10_000 }), validators);
    nodeB.setChainHeightProvider(() => bHeight);
    await nodeB.start();
    await waitConnected(nodeA, nodeB);

    const peer = nodeB.libp2pNode!.getPeers().find((p) => p.toString() === nodeA!.peerId())!;

    // The held first stream, as above.
    const held = await nodeB.libp2pNode!.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(2_000),
    });
    const heavyIds: string[] = [];
    for (let h = 1; h <= 20; h++) heavyIds.push(blockHash(makeBigBlock(h).header)!);
    await held.sink([encodeGetBlocks(MAGIC, { ids: heavyIds })]);
    await new Promise((r) => setTimeout(r, 300));

    // The second stream is a one-way `SyncInfo` push with a distinct
    // height. B dials, writes, closes — the push arrives on A quickly
    // and waits its turn.
    const pushedHeight = 777;
    bHeight = pushedHeight;
    const pushStream = await nodeB.libp2pNode!.dialProtocol(peer, SYNC_PROTOCOL, {
      signal: AbortSignal.timeout(2_000),
    });
    await pushStream.sink([encodeSyncInfo(MAGIC, { tipHeight: pushedHeight, tipHash: '00'.repeat(32) })]);
    await pushStream.close().catch(() => { /* already gone */ });

    // Wait past A's ×5 Blocks write deadline (5 s) with headroom, so A has
    // moved on from the first stream and read the push.
    await new Promise((r) => setTimeout(r, 7_000));

    // The rule: the push's read ran under a deadline that started at its
    // turn, not when libp2p accepted it; the ~5 s wait is longer than A's
    // 1 s read deadline, and the push was still read.
    const schA = (nodeA as unknown as {
      syncMachine: { getClaimsForTest(): Map<string, { tipHeight: number; tipHash: string }> };
    }).syncMachine;
    expect(schA.getClaimsForTest().get(nodeB.peerId())?.tipHeight).toBe(pushedHeight);
  }, TIMEOUT);
});
