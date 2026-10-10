import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { updateInterlinks } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { blockHash, cumulativeWork, level as headerLevel } from '@dagsocial/validation';
import type { ForkResolutionNet } from '../src/services/fork-resolution.js';
import { buildMinedHeaderChain, makeTestConfig, mineNextBlock } from '../test/helpers.js';
import {
  importBlockCreator,
  importDb,
  importForkResolution,
  importOrdering,
} from '../test/services/fork-resolution-fixtures.js';

describe('resolveFork — paged scoring walk', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('first page-aligned heavier prefix — the reorg target is the first stop-rule hit', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../src/services/difficulty.js');
    const { retargetParams: rp } = await import('../src/services/difficulty.js');

    // Inject a config with maxReorgDepth 450.
    const bigConfig = makeTestConfig({ maxReorgDepth: 450 });
    vi.doMock('../src/config.js', () => ({ config: bigConfig, loadConfig: () => bigConfig }));

    const bc = await importBlockCreator();
    bc.startBlockCreator(bigConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mine 450 blocks.
    const t1 = 1_000_000;
    for (let i = 0; i < 450; i++) {
      setClock(() => t1 + i * 60_000);
      await mineNextBlock(bc);
    }
    expect(ordering.getCurrentHeight()).toBe(450);

    // Fork at height 1 (depth 449). Our work above 1 is 449 blocks.
    const forkBlock = ordering.getOrderingBlock(1)!.header;
    const forkHash = blockHash(forkBlock)!;
    const forkLevel = headerLevel(forkBlock, bigConfig.orderingBlockPowTargetBits);
    const anchorIl = updateInterlinks([], forkHash, forkLevel);

    // Their branch: slightly faster spacing so each header is harder → more
    // work per header. The crossing boundary is derived from cumulativeWork.
    const params = rp();
    const { headers: peerChain } = buildMinedHeaderChain({
      anchorPrevBlockHash: forkHash,
      anchorInterlinks: anchorIl,
      startHeight: 2,
      count: 450,
      params,
      anchorCreatedAt: forkBlock.createdAt,
      anchorStamp: forkBlock.createdAt,
      startStamp: forkBlock.createdAt + 57_000,
      spacingMs: 57_000,
    });

    // Include the shared block 1 so the fork walk finds the match.
    const theirHeaders = [...peerChain].reverse().concat(forkBlock);

    const blockRequests: Array<{ startHeight: number; endHeight: number }> = [];
    const penalties: Array<{ peerId: string; kind: string; reason: string }> = [];
    const peerTip = 1 + 450;

    const net: ForkResolutionNet & {
      blockRequests: typeof blockRequests;
      headerRequests: Array<{ startHeight: number; maxCount: number }>;
      penalties: typeof penalties;
    } = {
      getConnectedPeers: () => ['peer-prefix'],
      requestHeaders: async (startHeight: number, maxCount: number) => {
        net.headerRequests.push({ startHeight, maxCount });
        const clamped = Math.min(startHeight, peerTip);
        return theirHeaders
          .filter(h => h.height <= clamped)
          .sort((a, b) => b.height - a.height)
          .slice(0, maxCount);
      },
      requestBlocks: async (s: number, e: number) => {
        blockRequests.push({ startHeight: s, endHeight: e });
        return [];
      },
      penalizePeer: (peerId: string, kind: string, reason: string) => {
        penalties.push({ peerId, kind, reason });
      },
      peerTipHeight: () => peerTip,
      blockRequests,
      headerRequests: [],
      penalties,
    };

    setClock(() => t1 + 451 * 60_000);
    // Spy getHeadersAbove to pin that ourWork reads the header-only store path.
    const orderingMod = await import('../src/store/ordering.js');
    const headersAboveSpy = vi.spyOn(orderingMod, 'getHeadersAbove');

    await forkResolution.resolveFork(
      { header: peerChain[peerChain.length - 1]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-prefix',
    );

    // The ourWork read went through getHeadersAbove, not the decode loop.
    expect(headersAboveSpy).toHaveBeenCalledWith(1, 449);

    // Derive the first page boundary at which their work exceeds ours.
    // The residual (heights 2..450) is chunked at MAX_CHAIN_RESPONSE_ITEMS
    // (400): pages of 2..401, 402..450. Fresh requests above that.
    const ourWork = cumulativeWork(
      Array.from({ length: 449 }, (_, i) => ordering.getOrderingBlock(2 + i)!.header),
    );
    const pageBoundaries = [400, 449];
    let expectedK: number | null = null;
    for (const k of pageBoundaries) {
      const sliceWork = cumulativeWork(peerChain.slice(0, k));
      if (sliceWork > ourWork) { expectedK = k; break; }
    }
    expect(expectedK, 'peer branch must exceed our work at some page boundary').not.toBeNull();

    expect(blockRequests.length).toBeGreaterThan(0);
    expect(blockRequests[0]!.startHeight).toBe(2);
    expect(blockRequests[blockRequests.length - 1]!.endHeight).toBe(1 + expectedK!);
    expect(penalties.some(p => p.kind === 'transient')).toBe(true);
  }, 120_000);
});
