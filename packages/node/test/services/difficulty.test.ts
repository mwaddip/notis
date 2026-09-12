import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RETARGET_HALFLIFE_BLOCKS,
  PROTOCOL_VERSION,
  EMPTY_STATE_ROOT,
  interlinkRoot,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { asertTargetBits, blockHash } from '@dagsocial/validation';
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
    getOrderingBlockHash: (height: number) => string | null;
  };
}

async function importDifficulty() {
  return (await import('../../src/services/difficulty.js')) as unknown as {
    retargetParams: () => RetargetParams;
    anchorCreatedAt: () => number;
    scheduledTargetBits: (parent: BlockHeader) => number;
    scheduledPowTargetBits: (header: BlockHeader) => number | null;
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

  describe('scheduledPowTargetBits', () => {
    it('returns scheduledTargetBits(parent.header) when node holds the parent with matching hash', async () => {
      const { config } = await import('../../src/config.js');
      const anchorBits = config.orderingBlockPowTargetBits;
      const t1 = 1_000_000;
      seedBlock(ordering, 1, t1, anchorBits);

      const t2 = t1 + 120_000;
      const block2Header = seedBlock(ordering, 2, t2, anchorBits);
      const block2Hash = blockHash(block2Header);

      const headerAt3: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 3,
        prevBlockHash: block2Hash!,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: anchorBits,
        createdAt: t2 + 120_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
      };

      const result = difficulty.scheduledPowTargetBits(headerAt3);
      const expected = difficulty.scheduledTargetBits(block2Header);
      expect(result).toBe(expected);
    });

    it('returns config.orderingBlockPowTargetBits at height 1', async () => {
      const { config } = await import('../../src/config.js');
      const headerAt1: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 1,
        prevBlockHash: ZERO_HASH,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: config.orderingBlockPowTargetBits,
        createdAt: 1_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
      };
      expect(difficulty.scheduledPowTargetBits(headerAt1)).toBe(config.orderingBlockPowTargetBits);
    });

    it('returns null when no row exists at height − 1', () => {
      const headerAt5: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 5,
        prevBlockHash: ZERO_HASH,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 20,
        createdAt: 1_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
      };
      expect(difficulty.scheduledPowTargetBits(headerAt5)).toBeNull();
    });

    it('returns null when stored hash differs from prevBlockHash', async () => {
      const { config } = await import('../../src/config.js');
      seedBlock(ordering, 1, 1_000_000, config.orderingBlockPowTargetBits);

      const headerAt2: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: 'ff'.repeat(32),
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: config.orderingBlockPowTargetBits,
        createdAt: 2_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
      };
      expect(difficulty.scheduledPowTargetBits(headerAt2)).toBeNull();
    });
  });

  describe('guardStoreRead wrapping scheduledPowTargetBits', () => {
    it('promotes a corrupt stored block into a fail-stop', async () => {
      const { guardStoreRead } = await import('../../src/services/corrupt-state.js');
      const { getDb } = await import('../../src/store/db.js');

      const corruptHash = 'ab'.repeat(32);
      getDb().prepare(
        `INSERT INTO ordering_blocks
           (height, header_bytes, utxotx_tree_bytes,
            validator_signature, created_at, block_hash, interlinks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(1, Buffer.from([0xff]), Buffer.from([]), Buffer.from([]), 0, corruptHash, Buffer.from([]));

      const headerAt2: BlockHeader = {
        protocolVersion: PROTOCOL_VERSION,
        height: 2,
        prevBlockHash: corruptHash,
        utxoTxRoot: ZERO_HASH,
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: new Uint8Array(32),
        powNonce: 0,
        powTargetBits: 20,
        createdAt: 1_000_000,
        interlinkRoot: interlinkRoot([ZERO_HASH]),
      };

      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const guarded = guardStoreRead(difficulty.scheduledPowTargetBits);
      expect(() => guarded(headerAt2)).toThrow('process.exit');
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
