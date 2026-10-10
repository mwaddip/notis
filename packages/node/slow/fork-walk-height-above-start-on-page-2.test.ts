import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import type { ForkResolutionNet } from '../src/services/fork-resolution.js';
import { makeTestConfig, mineNextBlock } from '../test/helpers.js';
import {
  importBlockCreator,
  importDb,
  importForkResolution,
  importOrdering,
} from '../test/services/fork-resolution-fixtures.js';

function dummyBlock(header: BlockHeader): OrderingBlock {
  return {
    header,
    utxoTxTree: { utxoTxIds: [], utxoTxs: [] },
    validatorSignature: new Uint8Array(64),
  } as OrderingBlock;
}

describe('the fork walk', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a height above the start on page 2', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../src/services/difficulty.js');

    const bigConfig = makeTestConfig({ maxReorgDepth: 450 });
    vi.doMock('../src/config.js', () => ({ config: bigConfig, loadConfig: () => bigConfig }));

    const bc = await importBlockCreator();
    bc.startBlockCreator(bigConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const t1 = 1_000_000;
    for (let i = 0; i < 450; i++) {
      setClock(() => t1 + i * 60_000);
      await mineNextBlock(bc);
    }
    expect(ordering.getCurrentHeight()).toBe(450);

    // Page 1: honest headers 450..51 (full). Page 2: the peer serves heights
    // starting above the requested start (450 again instead of ≤ 50).
    const honestHeaders: BlockHeader[] = [];
    for (let h = 450; h >= 1; h--) {
      honestHeaders.push({
        height: h,
        prevBlockHash: 'ff'.repeat(32),
        stateRoot: EMPTY_STATE_ROOT,
        utxoTxRoot: '00'.repeat(32),
        powTargetBits: bigConfig.orderingBlockPowTargetBits,
        powNonce: 0,
        protocolVersion: PROTOCOL_VERSION,
        createdAt: t1 + h * 60_000,
        validatorId: new Uint8Array(32),
        interlinkRoot: '00'.repeat(32),
        adProofsRoot: '00'.repeat(32),
      });
    }

    let requestCount = 0;
    const headerRequests: Array<{ startHeight: number; maxCount: number }> = [];
    const penalties: Array<{ peerId: string; kind: string; reason: string }> = [];
    const net: ForkResolutionNet = {
      getConnectedPeers: () => ['peer-above'],
      requestHeaders: async (startHeight: number, maxCount: number) => {
        headerRequests.push({ startHeight, maxCount });
        requestCount++;
        if (requestCount === 1) {
          return honestHeaders
            .filter(h => h.height <= startHeight)
            .sort((a, b) => b.height - a.height)
            .slice(0, maxCount);
        }
        // Page 2: maliciously top the page at 450 again.
        return honestHeaders
          .filter(h => h.height <= 450)
          .sort((a, b) => b.height - a.height)
          .slice(0, maxCount);
      },
      requestBlocks: async () => [],
      penalizePeer: (peerId: string, kind: string, reason: string) => {
        penalties.push({ peerId, kind, reason });
      },
      peerTipHeight: () => 450,
    };

    setClock(() => t1 + 451 * 60_000);
    await forkResolution.resolveFork(
      dummyBlock(honestHeaders[0]!),
      net,
      'peer-above',
    );

    expect(penalties).toEqual([
      expect.objectContaining({
        kind: 'misbehavior',
        reason: expect.stringMatching(/above the requested start/),
      }),
    ]);
    expect(headerRequests).toHaveLength(2);
    expect(ordering.getCurrentHeight()).toBe(450);
  }, 120_000);
});
