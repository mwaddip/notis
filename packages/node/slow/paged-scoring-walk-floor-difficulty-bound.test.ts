import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { updateInterlinks } from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { blockHash, cumulativeWork, level as headerLevel } from '@dagsocial/validation';
import { MAX_CHAIN_RESPONSE_ITEMS } from '@dagsocial/net';
import { buildMinedHeaderChain, mineNextBlock } from '../test/helpers.js';
import {
  importBlockCreator,
  importDb,
  importForkResolution,
  importOrdering,
  stubNet,
  testConfig,
} from '../test/services/fork-resolution-fixtures.js';

describe('resolveFork — paged scoring walk', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('floor-difficulty stub ends the walk within ceil(ourWork/floorWork)+400 headers', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../src/services/difficulty.js');
    const { retargetParams: rp } = await import('../src/services/difficulty.js');
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const ordering = await importOrdering();
    const forkResolution = await importForkResolution();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mine 5 blocks at the ideal rate.
    const t1 = 1_000_000;
    setClock(() => t1);
    await mineNextBlock(bc);
    for (let i = 1; i < 5; i++) {
      setClock(() => t1 + i * 60_000);
      await mineNextBlock(bc);
    }
    expect(ordering.getCurrentHeight()).toBe(5);

    const forkH = ordering.getOrderingBlock(1)!.header;
    const forkHash = blockHash(forkH)!;
    const forkLevel = headerLevel(forkH, testConfig.orderingBlockPowTargetBits);
    const il1 = ordering.getInterlinks(1)!;
    const anchorIl = updateInterlinks(il1, forkHash, forkLevel);
    const params = rp();

    // Our work above the fork (4 blocks).
    const ourHdrs: BlockHeader[] = [];
    for (let h = 2; h <= 5; h++) {
      ourHdrs.push(ordering.getOrderingBlock(h)!.header);
    }
    const ourWork = cumulativeWork(ourHdrs);

    // Build a peer chain with floor-difficulty headers (very long spacing
    // → ASERT drops the target to the floor → minimum work per header).
    const floorSpacingMs = 3_600_000; // 1 hour → target drops to floor
    const peerCount = 2000; // More than enough to exceed ourWork at the floor
    const { headers: floorChain } = buildMinedHeaderChain({
      anchorPrevBlockHash: forkHash,
      anchorInterlinks: anchorIl,
      startHeight: 2,
      count: peerCount,
      params,
      anchorCreatedAt: forkH.createdAt,
      anchorStamp: forkH.createdAt,
      startStamp: forkH.createdAt + floorSpacingMs,
      spacingMs: floorSpacingMs,
    });

    // Work per floor-difficulty header.
    const floorWork = cumulativeWork([floorChain[floorChain.length - 1]!]);
    const boundHeaders = Number((ourWork + floorWork - 1n) / floorWork);
    const requestBound = Math.ceil(boundHeaders / MAX_CHAIN_RESPONSE_ITEMS) + 1;

    const theirHeaders = [...floorChain].reverse().concat(forkH);
    setClock(() => forkH.createdAt + floorSpacingMs * peerCount + 60_000);
    const net = stubNet(theirHeaders, []);
    await forkResolution.resolveFork(
      { header: floorChain[floorChain.length - 1]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-withholding',
    );

    // The scoring walk's header requests should be bounded by
    // ceil(ourWork / floorWork) + 400 headers worth of pages.
    const scoringRequests = net.headerRequests.filter(
      r => r.startHeight > ordering.getCurrentHeight(),
    );
    expect(scoringRequests.length).toBeLessThanOrEqual(requestBound);
  });
});
