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
    // DELETED 2026-08-10 (Phase 3b): `expect(result!.subBlockTree.subBlockRefs)
    // .toEqual(['sb-ref-1', 'sb-ref-2'])`. The field is gone from the wire, and
    // the fixture values were not post ids in the first place — `'sb-ref-1'` is
    // seven characters where a `b32` row needs 32 bytes, so under the positional
    // codec this fixture has no encoding at all. It survived because cbor wrote
    // any string, which is the same reason the field itself survived unchecked.
    // Read-back of the committed lists is what the store owes, and that is
    // asserted here and below.
    expect(result!.subBlockTree.subBlockEntries).toEqual([]);
    // DELETED 2026-08-08: `expect(result!.subBlockTree.stumpIds).toEqual(['stump-aaa'])`.
    // `stumpIds` is not a field of `SubBlockTree` (it is `subBlockRefs`,
    // `subBlockEntries`, `pruneEntries`) and the string appears nowhere in any
    // package's `src`. The assertion could only ever have passed because the
    // storage codec preserved a key the fixture itself wrote — so it pinned the
    // encoder's tolerance for unknown keys, not a protocol field. Prune
    // commitments travel in `pruneEntries`, which the round-trip below covers.
    expect(result!.subBlockTree.pruneEntries).toEqual([]);

    // utxoTxTree
    //
    // CHANGED 2026-08-08: the fixture wrote `value: 100` and this asserted
    // `toBe(100)`. `CoinbaseOutput.value` is bigint, so a real block
    // round-tripping through this store returns `100n` and the assertion would
    // have FAILED on real data — it could only pass on a fixture lying in the
    // same direction. Fixture and assertion agreed with each other while both
    // diverged from the type, so the round-trip test could not detect the one
    // thing it exists to check. `net`'s `headers.test.ts` carried the identical
    // defect on the identical field (fixed in e9d4eda): Spec B P0's bigint
    // migration left systematic residue in storage round-trip tests.
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
