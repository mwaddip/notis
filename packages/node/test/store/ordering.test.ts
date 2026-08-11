import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { OrderingBlock } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importOrderingFresh() {
  const mod = await import('../../src/store/ordering.js');
  return mod as {
    createOrderingBlock: (block: OrderingBlock) => void;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getCurrentHeight: () => number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrderingBlock(
  overrides: Partial<OrderingBlock> = {},
): OrderingBlock {
  return {
    header: {
      protocolVersion: 1,
      height: 1,
      prevBlockHash: '00'.repeat(32),
      subBlockRoot: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: uid('validator-1'),
      powNonce: 0,
      powTargetBits: 12,
      createdAt: Date.now(),
    },
    subBlockTree: {
      subBlockEntries: [],
      pruneEntries: [],
    },
    utxoTxTree: {
      utxoTxIds: ['1a'.repeat(32)],
      utxoTxs: [],
      coinbaseOutputs: [],
    },
    validatorSignature: new Uint8Array(64).fill(0xab),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ordering store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('getCurrentHeight returns 0 on empty table', async () => {
    const { initDb } = await importDbFresh();
    const { getCurrentHeight } = await importOrderingFresh();

    initDb(':memory:');

    expect(getCurrentHeight()).toBe(0);
  });

  it('createOrderingBlock + getOrderingBlock round-trip (all fields)', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getOrderingBlock } =
      await importOrderingFresh();

    initDb(':memory:');

    const block = makeOrderingBlock({
      header: {
        protocolVersion: 1,
        height: 1,
        prevBlockHash: 'aa'.repeat(32),
        subBlockRoot: 'bb'.repeat(32),
        utxoTxRoot: 'cc'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: uid('validator-alice'),
        powNonce: 42,
        powTargetBits: 14,
        createdAt: 1234567890,
      },
      subBlockTree: {
        subBlockEntries: [],
        pruneEntries: [],
      },
      utxoTxTree: {
        utxoTxIds: ['2b'.repeat(32)],
        utxoTxs: [],
        coinbaseOutputs: [
          {
            owner: uid('coinbase-recipient'),
            value: 100n,
            lockedUntilBlock: 100,
            isTreasury: false,
          },
        ],
      },
      validatorSignature: new Uint8Array(64).fill(0xcd),
    });

    createOrderingBlock(block);

    const result = getOrderingBlock(1);
    expect(result).not.toBeNull();
    const h = result!.header;
    expect(h.height).toBe(1);
    expect(h.protocolVersion).toBe(1);
    expect(h.prevBlockHash).toBe('aa'.repeat(32));
    expect(h.subBlockRoot).toBe('bb'.repeat(32));
    expect(h.utxoTxRoot).toBe('cc'.repeat(32));
    expect(h.validatorId).toEqual(uid('validator-alice'));
    expect(h.powNonce).toBe(42);
    expect(h.powTargetBits).toBe(14);
    expect(h.createdAt).toBe(1234567890);

    expect(result!.validatorSignature).toEqual(
      new Uint8Array(64).fill(0xcd),
    );

    // subBlockTree
    //
    // `SubBlockTree` has exactly two fields — `subBlockEntries` and
    // `pruneEntries` (TYPES_INTERFACE → Ordering block) — and both are
    // asserted, so this covers the whole struct rather than a sample of it.
    //
    // Asserting a name the struct does not declare is the trap here: it reads
    // as coverage while pinning the storage codec's tolerance for an unknown
    // key, which is a property of cbor-x and not of the protocol.
    expect(result!.subBlockTree.subBlockEntries).toEqual([]);
    expect(result!.subBlockTree.pruneEntries).toEqual([]);

    // utxoTxTree
    //
    // ⚠ `CoinbaseOutput.value` is a **bigint**, and both the fixture at the top
    // of this test and the assertion below must spell it `100n`. A round-trip
    // test is the one shape where a fixture and an assertion can agree with each
    // other while both disagree with the type: write `100` in the fixture, assert
    // `toBe(100)`, and the test passes on data no real block produces — so it
    // detects nothing, which is the single thing it exists to do.
    expect(result!.utxoTxTree.utxoTxIds).toEqual(['2b'.repeat(32)]);
    expect(result!.utxoTxTree.coinbaseOutputs).toHaveLength(1);
    expect(result!.utxoTxTree.coinbaseOutputs[0]!.value).toBe(100n);

    // getCurrentHeight should reflect the inserted block
    const { getCurrentHeight } = await importOrderingFresh();
    expect(getCurrentHeight()).toBe(1);
  });

  it('getOrderingBlock returns null for unknown height', async () => {
    const { initDb } = await importDbFresh();
    const { getOrderingBlock } = await importOrderingFresh();

    initDb(':memory:');

    const result = getOrderingBlock(999);
    expect(result).toBeNull();
  });
});
