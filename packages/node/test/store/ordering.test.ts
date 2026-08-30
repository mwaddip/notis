import { uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { blockHash } from '@dagsocial/validation';
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
    createOrderingBlock: (block: OrderingBlock, interlinks: string[]) => void;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getCurrentHeight: () => number;
    deleteOrderingBlock: (height: number) => void;
    getOrderingBlockHash: (height: number) => string | null;
    getHeightByBlockHash: (hash: string) => number | null;
    getInterlinks: (height: number) => string[] | null;
    getHeadersAbove: (height: number, n: number) => import('@dagsocial/types').BlockHeader[];
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
      interlinkRoot: '00'.repeat(32),
    },
    utxoTxTree: {
      utxoTxIds: ['1a'.repeat(32)],
      utxoTxs: [],
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
        interlinkRoot: 'ee'.repeat(32),
      },
      utxoTxTree: {
        // The settlement is the last entry, and here it is the only one — the
        // shape every body has (NODE_INTERFACE → It is the LAST entry in
        // `utxoTxIds`). The store round-trips bytes and reads none of them.
        utxoTxIds: ['2b'.repeat(32)],
        utxoTxs: [new Uint8Array(96).fill(0x2b)],
      },
      validatorSignature: new Uint8Array(64).fill(0xcd),
    });

    createOrderingBlock(block, ['ab'.repeat(32), 'cd'.repeat(32)]);

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
    expect(h.interlinkRoot).toBe(block.header.interlinkRoot);

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

  it('getOrderingBlockHash returns the stored block_hash for a present height', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getOrderingBlock, getOrderingBlockHash } =
      await importOrderingFresh();

    initDb(':memory:');

    const block = makeOrderingBlock();
    createOrderingBlock(block, []);

    const hash = getOrderingBlockHash(1);
    expect(hash).not.toBeNull();
    expect(hash).toBe(blockHash(getOrderingBlock(1)!.header));
  });

  it('getOrderingBlockHash returns null for absent height', async () => {
    const { initDb } = await importDbFresh();
    const { getOrderingBlockHash } = await importOrderingFresh();

    initDb(':memory:');

    expect(getOrderingBlockHash(999)).toBeNull();
  });

  it('getHeightByBlockHash returns height for known hash, null for unknown', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getOrderingBlockHash, getHeightByBlockHash } =
      await importOrderingFresh();

    initDb(':memory:');

    const block = makeOrderingBlock();
    createOrderingBlock(block, []);

    const hash = getOrderingBlockHash(1)!;
    expect(getHeightByBlockHash(hash)).toBe(1);
    expect(getHeightByBlockHash('ff'.repeat(32))).toBeNull();
  });

  it('deleteOrderingBlock removes the hash mapping', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, deleteOrderingBlock, getOrderingBlockHash, getHeightByBlockHash } =
      await importOrderingFresh();

    initDb(':memory:');

    const block = makeOrderingBlock();
    createOrderingBlock(block, []);

    const hash = getOrderingBlockHash(1)!;
    expect(getHeightByBlockHash(hash)).toBe(1);

    deleteOrderingBlock(1);
    expect(getOrderingBlockHash(1)).toBeNull();
    expect(getHeightByBlockHash(hash)).toBeNull();
  });

  it('UNIQUE index rejects a duplicate block_hash at a different height', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { createOrderingBlock, getOrderingBlockHash } =
      await importOrderingFresh();

    initDb(':memory:');

    const block1 = makeOrderingBlock();
    createOrderingBlock(block1, []);
    const hash = getOrderingBlockHash(1)!;

    // A second INSERT with the same block_hash at a different height throws.
    const db = getDb();
    expect(() => {
      db.prepare(
        `INSERT INTO ordering_blocks
           (height, header_bytes, utxotx_tree_bytes,
            validator_signature, created_at, block_hash, interlinks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(2, Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(64), 0, hash, Buffer.alloc(1));
    }).toThrow();
  });

  it('createOrderingBlock throws UnhashableStoredHeaderError when blockHash returns null', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock } = await importOrderingFresh();

    initDb(':memory:');

    const block = makeOrderingBlock({
      header: {
        ...makeOrderingBlock().header,
        createdAt: -1,
      },
    });
    let caught: unknown;
    try {
      createOrderingBlock(block, []);
    } catch (err) {
      caught = err;
    }
    // By name, not `instanceof` — `vi.resetModules()` gives the dynamically
    // imported graph its own copy of every class.
    expect((caught as Error).name).toBe('UnhashableStoredHeaderError');
    expect((caught as { site: string }).site).toBe('createOrderingBlock');
    expect((caught as { height: number }).height).toBe(1);
  });

  it('getInterlinks round-trips the stored vector', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getInterlinks } = await importOrderingFresh();

    initDb(':memory:');

    const ids = ['ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)];
    const block = makeOrderingBlock();
    createOrderingBlock(block, ids);

    expect(getInterlinks(1)).toEqual(ids);
  });

  it('getInterlinks returns null for missing height', async () => {
    const { initDb } = await importDbFresh();
    const { getInterlinks } = await importOrderingFresh();

    initDb(':memory:');

    expect(getInterlinks(999)).toBeNull();
  });

  it('deleteOrderingBlock drops the interlinks with the row', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, deleteOrderingBlock, getInterlinks } =
      await importOrderingFresh();

    initDb(':memory:');

    createOrderingBlock(makeOrderingBlock(), ['aa'.repeat(32)]);
    expect(getInterlinks(1)).toEqual(['aa'.repeat(32)]);

    deleteOrderingBlock(1);
    expect(getInterlinks(1)).toBeNull();
  });

  // NODE_INTERFACE → Store Interface → Ordering blocks: the fork walk's
  // header-only read, uncapped (not the prover's MAX_NIPOPOW_PARAM read).
  it('getHeadersAbove(f, 300) on a 301-block chain answers 300 headers', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getHeadersAbove } = await importOrderingFresh();

    initDb(':memory:');

    for (let h = 1; h <= 301; h++) {
      createOrderingBlock(
        makeOrderingBlock({
          header: { ...makeOrderingBlock().header, height: h, createdAt: 1000 + h },
        }),
        [],
      );
    }

    const headers = getHeadersAbove(1, 300);
    expect(headers).toHaveLength(300);
    expect(headers[0]!.height).toBe(2);
    expect(headers[299]!.height).toBe(301);
    for (let i = 1; i < headers.length; i++) {
      expect(headers[i]!.height).toBe(headers[i - 1]!.height + 1);
    }
  });

  it('getHeadersAbove: n past the tip answers what exists', async () => {
    const { initDb } = await importDbFresh();
    const { createOrderingBlock, getHeadersAbove } = await importOrderingFresh();

    initDb(':memory:');

    for (let h = 1; h <= 5; h++) {
      createOrderingBlock(
        makeOrderingBlock({
          header: { ...makeOrderingBlock().header, height: h, createdAt: 1000 + h },
        }),
        [],
      );
    }

    const headers = getHeadersAbove(3, 100);
    expect(headers).toHaveLength(2);
    expect(headers[0]!.height).toBe(4);
    expect(headers[1]!.height).toBe(5);
  });

  it('getHeadersAbove: an unreadable row throws at its height', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { createOrderingBlock, getHeadersAbove } = await importOrderingFresh();

    initDb(':memory:');

    createOrderingBlock(makeOrderingBlock(), []);

    // Corrupt the header_bytes in SQLite directly.
    getDb().prepare('UPDATE ordering_blocks SET header_bytes = ? WHERE height = 1').run(
      Buffer.from([0xff, 0xff]),
    );

    let caught: unknown;
    try {
      getHeadersAbove(0, 5);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe('UnreadableStoredBlockError');
    expect(String(caught)).toContain('getHeadersAbove');
  });
});
