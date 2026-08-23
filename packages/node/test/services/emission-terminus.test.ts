import { coinbaseOf, makeApplicableBlock, makeTestIdentity, ZERO_HASH } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
  EMPTY_STATE_ROOT,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// The emission terminus
//
// `computeBlockReward` decays to nothing (MINING_INTERFACE → Emission Schedule),
// so there is a first height that pays zero. These heights are devnet's:
// `creditFixedRateBlocks` 1000 and `creditEpochBlocks` 100 (TYPES_INTERFACE →
// Network profiles), which the whole node suite runs on because
// `vitest.config.ts` sets `NETWORK_TYPE`. `computeBlockReward` reads the process
// config singleton, so an injected `Config` cannot move these — the profile can,
// which is why the two fields are asserted below rather than assumed.
//
// ⛔ **5,900 is the trap, not the terminus.** `epochs = floor((h − 1001)/100) + 1`
// puts 5,900 in epoch 49, which pays `100 − 98 = 2` credits — the same 2e8 a
// tail-rate constant would hold the curve at. A terminus pinned there asserts
// the same value whether the curve ends or not and can never fail, so it stands
// here as the **control** and 5,901 is the terminus.
// ---------------------------------------------------------------------------

/** Epoch 49's last height — the last that pays. */
const LAST_PAYING_HEIGHT = 5900;
/** Epoch 50's first height — the first that pays nothing. */
const TERMINUS_HEIGHT = 5901;

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as unknown as {
    createOrderingBlock: (block: OrderingBlock) => void;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getCurrentHeight: () => number;
  };
}

async function importBlockCreator() {
  return (await import('../../src/services/block-creator.js')) as unknown as {
    computeBlockReward: (height: number) => bigint;
    stopBlockCreator: () => void;
  };
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
  };
}

/**
 * Put the chain at `height` without mining to it.
 *
 * The store's `createOrderingBlock` takes a block and validates nothing
 * (`store/ordering.ts` — the one writer, and tests call it directly), so the row
 * only has to be encodable: what the next block reads off it is
 * `blockHash(header)` for its `prevBlockHash`, and `MAX(height)` for the tip.
 */
async function seedChainAt(height: number): Promise<void> {
  const ordering = await importOrdering();
  const { expectedTarget } = await import('../../src/services/difficulty.js');
  const seedMiner = makeTestIdentity();

  ordering.createOrderingBlock({
    header: {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: ZERO_HASH,
      utxoTxRoot: ZERO_HASH,
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: seedMiner.userId,
      powNonce: 0,
      powTargetBits: expectedTarget(height),
      createdAt: Date.now(),
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      pruneEntries: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64),
  } as unknown as OrderingBlock);

  expect(ordering.getCurrentHeight()).toBe(height);
}

describe('credit emission terminates', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    try {
      const db = await importDb();
      db.closeDb();
    } catch {
      // No database was opened
    }
    vi.resetModules();
  });

  // -----------------------------------------------------------------------
  // The arithmetic
  // -----------------------------------------------------------------------

  it('the heights below rest on devnet\'s emission profile', async () => {
    const { config } = await import('../../src/config.js');

    // Both terms of `epochs = floor((h − F − 1)/E) + 1`. A profile change moves
    // the terminus, and every height in this file with it.
    expect(config.creditFixedRateBlocks).toBe(1000);
    expect(config.creditEpochBlocks).toBe(100);
  });

  it('pays through the end of epoch 49 (control)', async () => {
    const { computeBlockReward } = await importBlockCreator();

    // 100 − 49 × 2 = 2 credits. Stated both ways: as the curve's own arithmetic,
    // and as the literal, because the literal is the number a floor would have
    // held here and the point is that the curve arrives at it on its own.
    expect(computeBlockReward(LAST_PAYING_HEIGHT)).toBe(
      CREDIT_INITIAL_REWARD - 49n * CREDIT_REWARD_REDUCTION,
    );
    expect(computeBlockReward(LAST_PAYING_HEIGHT)).toBe(2n * 10n ** 8n);

    // Epoch 49 opens at 5,801, so the whole epoch pays the same 2 credits and
    // the step down is at its edge rather than somewhere inside it.
    expect(computeBlockReward(5801)).toBe(2n * 10n ** 8n);
    expect(computeBlockReward(5800)).toBe(4n * 10n ** 8n);
  });

  it('pays nothing from the terminus on', async () => {
    const { computeBlockReward } = await importBlockCreator();

    expect(computeBlockReward(TERMINUS_HEIGHT)).toBe(0n);

    // And stays there. The subtraction goes negative above epoch 50, so what is
    // being pinned is that the result is clamped rather than signed.
    for (const height of [5902, 6000, 10_000, 1_000_000, 2_147_483_647]) {
      expect(computeBlockReward(height)).toBe(0n);
    }
  });

  // -----------------------------------------------------------------------
  // The mechanism, through a block
  // -----------------------------------------------------------------------

  it('a block at the terminus carries no coinbase outputs at all', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    await seedChainAt(LAST_PAYING_HEIGHT);

    // No transactions, so no fees: the block's income is `0 + 0`, `splitCoinbase`
    // leaves nothing for either slice, and the settlement emits no credit output
    // at all. That is the only encoding a block can carry here — no coinbase
    // output may hold a zero value (MINING_INTERFACE → Coinbase Application,
    // invariant 1), so there is nothing to write instead of writing nothing.
    //
    // ⛔ **The coinbase is inside the settlement now**, which is the body's last
    // entry, so the assertion reads its outputs rather than a body field
    // (TYPES_INTERFACE → Ordering block).
    const block = await makeApplicableBlock({ height: TERMINUS_HEIGHT });
    expect(coinbaseOf(block)).toEqual([]);

    // And the apply path takes it. This is the rule exercised through a block
    // rather than through `splitCoinbase` alone: the zero-value scan walks an
    // empty list, and the income check compares 0 against 0.
    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    const ordering = await importOrdering();
    expect(ordering.getCurrentHeight()).toBe(TERMINUS_HEIGHT);
    expect(coinbaseOf(ordering.getOrderingBlock(TERMINUS_HEIGHT)!)).toEqual([]);
  });

  it('the same empty block one height lower still pays (control)', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    await seedChainAt(LAST_PAYING_HEIGHT - 1);

    // Identical body, identical absence of fees. What differs is the height, so
    // the empty list above is the terminus's doing and not the empty body's.
    const block = await makeApplicableBlock({ height: LAST_PAYING_HEIGHT });
    expect(coinbaseOf(block).length).toBeGreaterThan(0);

    const paid = coinbaseOf(block).reduce((sum, o) => sum + o.value, 0n);
    expect(paid).toBeGreaterThan(0n);

    const blockApply = await importBlockApply();
    expect(blockApply.applyOrderingBlock(block)).toBe(true);
  });
});
