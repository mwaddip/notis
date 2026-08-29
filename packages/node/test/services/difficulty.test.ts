import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RETARGET_HALFLIFE_BLOCKS,
  PROTOCOL_VERSION,
  EMPTY_STATE_ROOT,
  interlinkRoot,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { asertTargetBits } from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import { makeTestIdentity, solveHeaderPow, ZERO_HASH } from '../helpers.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as unknown as {
    createOrderingBlock: (block: OrderingBlock, interlinks: string[]) => void;
    getCurrentHeight: () => number;
  };
}

async function importDifficulty() {
  return (await import('../../src/services/difficulty.js')) as unknown as {
    retargetParams: () => RetargetParams;
    anchorCreatedAt: () => number;
    scheduledTargetBits: (parent: BlockHeader) => number;
    nowMs: () => number;
    setClock: (fn: (() => number) | null) => void;
  };
}

function seedBlock(
  ordering: Awaited<ReturnType<typeof importOrdering>>,
  height: number,
  createdAt: number,
  powTargetBits: number,
): BlockHeader {
  const miner = makeTestIdentity();
  const header: BlockHeader = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash: ZERO_HASH,
    utxoTxRoot: ZERO_HASH,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: miner.userId,
    powNonce: 0,
    powTargetBits,
    createdAt,
    interlinkRoot: interlinkRoot([ZERO_HASH]),
  };
  header.powNonce = solveHeaderPow(header);
  ordering.createOrderingBlock(
    { header, utxoTxTree: { utxoTxIds: [], utxoTxs: [] }, validatorSignature: new Uint8Array(64) },
    [ZERO_HASH],
  );
  return header;
}

describe('difficulty schedule', () => {
  let db: Awaited<ReturnType<typeof importDb>>;
  let ordering: Awaited<ReturnType<typeof importOrdering>>;
  let difficulty: Awaited<ReturnType<typeof importDifficulty>>;

  beforeEach(async () => {
    vi.resetModules();
    db = await importDb();
    db.initDb(':memory:');
    ordering = await importOrdering();
    difficulty = await importDifficulty();
  });

  afterEach(() => {
    difficulty.setClock(null);
    db.closeDb();
  });

  describe('retargetParams', () => {
    it('derives params from the process config', async () => {
      const { config } = await import('../../src/config.js');
      const p = difficulty.retargetParams();
      expect(p.anchorBits).toBe(config.orderingBlockPowTargetBits);
      expect(p.idealMs).toBe(config.orderingBlockIdealMs);
      expect(p.halflifeMs).toBe(RETARGET_HALFLIFE_BLOCKS * config.orderingBlockIdealMs);
      expect(p.floorBits).toBe(config.orderingBlockPowTargetFloorBits);
      expect(p.ceilingBits).toBe(config.orderingBlockPowTargetCeilingBits);
    });
  });

  describe('scheduledTargetBits', () => {
    it('equals asertTargetBits over the stored block 1 stamp', async () => {
      const { config } = await import('../../src/config.js');
      const anchorBits = config.orderingBlockPowTargetBits;
      const t1 = 1_000_000;
      seedBlock(ordering, 1, t1, anchorBits);

      const t2 = t1 + 120_000;
      const parent: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: ZERO_HASH,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: anchorBits,
        createdAt: t2,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
      };

      const scheduled = difficulty.scheduledTargetBits(parent);
      const expected = asertTargetBits(difficulty.retargetParams(), t1, parent);
      expect(scheduled).toBe(expected);
    });
  });

  describe('anchorCreatedAt', () => {
    it('returns block 1 stamp on a seeded chain', async () => {
      const { config } = await import('../../src/config.js');
      const t1 = 42_000;
      seedBlock(ordering, 1, t1, config.orderingBlockPowTargetBits);
      expect(difficulty.anchorCreatedAt()).toBe(t1);
    });

    it('throws MissingStoredBlockError on a tipped chain with no row at 1', async () => {
      const { config } = await import('../../src/config.js');
      seedBlock(ordering, 5, 100_000, config.orderingBlockPowTargetBits);
      expect(() => difficulty.anchorCreatedAt()).toThrow(/no block at height 1/);
    });

    it('throws a plain Error on an empty chain — a caller bug, not corruption', () => {
      expect(() => difficulty.anchorCreatedAt()).toThrow(/empty chain/);
    });
  });

  describe('clock seam', () => {
    it('defaults to Date.now', () => {
      const before = Date.now();
      const t = difficulty.nowMs();
      const after = Date.now();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    });

    it('takes an override and restores on null', () => {
      difficulty.setClock(() => 99999);
      expect(difficulty.nowMs()).toBe(99999);
      difficulty.setClock(null);
      expect(Math.abs(difficulty.nowMs() - Date.now())).toBeLessThan(100);
    });
  });
});
