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
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: uid('validator-1'),
      powNonce: 0,
      powTargetBits: 256 * 12,
      createdAt: Date.now(),
    },
    utxoTxTree: {
      utxoTxIds: ['1a'.repeat(32)],
      utxoTxs: [],
      pruneEntries: [],
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
        utxoTxRoot: 'cc'.repeat(32),
        stateRoot: '00'.repeat(33),
        validatorId: uid('validator-alice'),
        powNonce: 42,
        // 3584 is two VLQ bytes, so the round-trip covers this field's
        // multi-byte path rather than only its one-byte one.
        powTargetBits: 256 * 14,
        createdAt: 1234567890,
      },
      utxoTxTree: {
        // The settlement is the last entry, and here it is the only one — the
        // shape every body has (NODE_INTERFACE → It is the LAST entry in
        // `utxoTxIds`). The store round-trips bytes and reads none of them.
        utxoTxIds: ['2b'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x2b)],
        pruneEntries: [],
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
    expect(h.utxoTxRoot).toBe('cc'.repeat(32));
    expect(h.stateRoot).toBe('00'.repeat(33));
    expect(h.validatorId).toEqual(uid('validator-alice'));
    expect(h.powNonce).toBe(42);
    expect(h.powTargetBits).toBe(256 * 14);
    expect(h.createdAt).toBe(1234567890);

    expect(result!.validatorSignature).toEqual(
      new Uint8Array(64).fill(0xcd),
    );

    // utxoTxTree
    //
    // `UtxoTxTree` has exactly three fields (TYPES_INTERFACE → Layout —
    // Block) and all three are asserted, so this covers the whole struct
    // rather than a sample of it.
    //
    // Asserting a name the struct does not declare is the trap here: it reads
    // as coverage while pinning the storage codec's tolerance for an unknown
    // key, which is a property of the codec and not of the protocol.
    expect(result!.utxoTxTree.pruneEntries).toEqual([]);
    expect(result!.utxoTxTree.utxoTxIds).toEqual(['2b'.repeat(32)]);
    // The settlement's bytes come back byte-for-byte, and the payload is
    // height-bearing rather than a shared constant: a store returning some other
    // block's body would pass an assertion on a value every block shares.
    expect(result!.utxoTxTree.utxoTxs).toHaveLength(1);
    expect(Buffer.from(result!.utxoTxTree.utxoTxs[0]!)).toEqual(
      Buffer.from(new Uint8Array(96).fill(0x2b)),
    );

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
