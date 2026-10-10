import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { makeTestConfig, mineNextBlock } from '../test/helpers.js';
import {
  importBlockCreator,
  importDb,
  importForkResolution,
  importOrdering,
  stubNet,
} from '../test/services/fork-resolution-fixtures.js';

describe('resolveFork — paged scoring walk', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => {
    try { (await importBlockCreator()).stopBlockCreator(); } catch {}
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a test config with horizon 450 walks two pages to a fork at depth 400', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const { setClock } = await import('../src/services/difficulty.js');

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

    // Peer shares our block at height 50 (depth 400 from tip).
    // Build headers that don't match at heights 51-450, then match at 50.
    const sharedBlock = ordering.getOrderingBlock(50)!.header;
    const fakeHeaders: BlockHeader[] = [];
    for (let h = 450; h >= 1; h--) {
      if (h === 50) {
        fakeHeaders.push(sharedBlock);
      } else if (h < 50) {
        fakeHeaders.push(ordering.getOrderingBlock(h)!.header);
      } else {
        fakeHeaders.push({
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
    }

    setClock(() => t1 + 451 * 60_000);
    const net = stubNet(fakeHeaders, []);
    await forkResolution.resolveFork(
      { header: fakeHeaders[0]!, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) } as OrderingBlock,
      net,
      'peer-withholding',
    );

    // The fork walk starts at 450, pages down in 400-header pages:
    // Request 1: startHeight=450, maxCount=400 → headers 450..51
    // Request 2: startHeight=50, maxCount=400 → headers 50..1, match at 50
    // Two fork-walk requests.
    const forkWalkRequests = net.headerRequests.filter(
      r => r.startHeight <= 450,
    );
    expect(forkWalkRequests.length).toBe(2);
    expect(forkWalkRequests[0]!.startHeight).toBe(450);
    expect(forkWalkRequests[1]!.startHeight).toBeLessThanOrEqual(51);

    // Chain untouched (the peer's headers above the fork fail verification).
    expect(ordering.getCurrentHeight()).toBe(450);
  }, 120_000);
});
