import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  createOrderingBlock,
  getPopowHeaderByHash,
  getPopowHeaderAtHeight,
  getLastHeaders,
  getHeadersAfter,
} from '../../src/store/ordering.js';
import { buildMinedHeaderChain } from '../helpers.js';
import { blockHash } from '@dagsocial/validation';
import {
  GENESIS_PREV_BLOCK_HASH,
  encodeInterlinks,
} from '@dagsocial/types';
import { retargetParams } from '../../src/services/difficulty.js';
import { UnreadableStoredBlockError } from '../../src/services/corrupt-state.js';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-nipopow-reader.sqlite';

// NODE_INTERFACE → Nipopow reader: four reads over a stored chain with real
// PoW-solved headers carrying correct interlink vectors.

describe('nipopow reader store reads', () => {
  const CHAIN_LEN = 10;
  let chainHashes: string[];

  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    const { headers, interlinksPerHeader } = buildMinedHeaderChain({
      anchorPrevBlockHash: GENESIS_PREV_BLOCK_HASH,
      anchorInterlinks: [],
      startHeight: 1,
      count: CHAIN_LEN,
      params: retargetParams(),
      anchorCreatedAt: null,
      anchorStamp: 0,
      startStamp: 1_000_000,
    });

    chainHashes = headers.map((h) => {
      const hash = blockHash(h);
      if (hash === null) throw new Error('unhashable test header');
      return hash;
    });

    for (let i = 0; i < headers.length; i++) {
      createOrderingBlock(
        {
          header: headers[i]!,
          utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
          validatorSignature: new Uint8Array(64),
        },
        interlinksPerHeader[i]!,
      );
    }
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  // ---- getPopowHeaderByHash ----

  it('returns a PoPowHeader for a stored hash', () => {
    const ph = getPopowHeaderByHash(chainHashes[0]!);
    expect(ph).not.toBeNull();
    expect(ph!.header.height).toBe(1);
    expect(Array.isArray(ph!.interlinks)).toBe(true);
  });

  it('returns null for a missing hash', () => {
    expect(getPopowHeaderByHash('ff'.repeat(32))).toBeNull();
  });

  // ---- getPopowHeaderAtHeight ----

  it('returns a PoPowHeader for a stored height', () => {
    const ph = getPopowHeaderAtHeight(5);
    expect(ph).not.toBeNull();
    expect(ph!.header.height).toBe(5);
  });

  it('returns null for a missing height', () => {
    expect(getPopowHeaderAtHeight(9999)).toBeNull();
  });

  // ---- getLastHeaders ----

  it('returns ascending headers for the last n', () => {
    const hdrs = getLastHeaders(3);
    expect(hdrs).toHaveLength(3);
    expect(hdrs[0]!.height).toBe(CHAIN_LEN - 2);
    expect(hdrs[1]!.height).toBe(CHAIN_LEN - 1);
    expect(hdrs[2]!.height).toBe(CHAIN_LEN);
  });

  it('clamps n to MAX_NIPOPOW_PARAM', () => {
    const hdrs = getLastHeaders(999);
    expect(hdrs.length).toBeLessThanOrEqual(128);
    expect(hdrs.length).toBe(CHAIN_LEN);
  });

  // ---- getHeadersAfter ----

  it('returns ascending headers after a height', () => {
    const hdrs = getHeadersAfter(3, 4);
    expect(hdrs).toHaveLength(4);
    expect(hdrs[0]!.height).toBe(4);
    expect(hdrs[3]!.height).toBe(7);
  });

  it('returns fewer than n when the chain is shorter', () => {
    const hdrs = getHeadersAfter(CHAIN_LEN - 1, 5);
    expect(hdrs).toHaveLength(1);
    expect(hdrs[0]!.height).toBe(CHAIN_LEN);
  });

  // ---- Corrupt data ----

  it('getPopowHeaderAtHeight throws CorruptChainStateError for corrupted interlinks', () => {
    const db = getDb();
    db.prepare(
      'UPDATE ordering_blocks SET interlinks = ? WHERE height = 1',
    ).run(Buffer.from([0xff, 0xff, 0xff, 0xff]));

    expect(() => getPopowHeaderAtHeight(1)).toThrow(UnreadableStoredBlockError);

    // Restore for remaining tests
    db.prepare(
      'UPDATE ordering_blocks SET interlinks = ? WHERE height = 1',
    ).run(Buffer.from(encodeInterlinks([])));
  });

  it('getPopowHeaderByHash throws CorruptChainStateError for corrupted header_bytes', () => {
    const db = getDb();
    const originalBytes = (db.prepare(
      'SELECT header_bytes FROM ordering_blocks WHERE height = 2',
    ).get() as { header_bytes: Buffer }).header_bytes;

    db.prepare(
      'UPDATE ordering_blocks SET header_bytes = ? WHERE height = 2',
    ).run(Buffer.from([0x00, 0x01]));

    expect(() => getPopowHeaderByHash(chainHashes[1]!)).toThrow(UnreadableStoredBlockError);

    db.prepare(
      'UPDATE ordering_blocks SET header_bytes = ? WHERE height = 2',
    ).run(originalBytes);
  });

  it('getLastHeaders throws CorruptChainStateError for corrupted header_bytes', () => {
    const db = getDb();
    const originalBytes = (db.prepare(
      'SELECT header_bytes FROM ordering_blocks WHERE height = ?',
    ).get(CHAIN_LEN) as { header_bytes: Buffer }).header_bytes;

    db.prepare(
      'UPDATE ordering_blocks SET header_bytes = ? WHERE height = ?',
    ).run(Buffer.from([0x00, 0x01]), CHAIN_LEN);

    expect(() => getLastHeaders(1)).toThrow(UnreadableStoredBlockError);

    db.prepare(
      'UPDATE ordering_blocks SET header_bytes = ? WHERE height = ?',
    ).run(originalBytes, CHAIN_LEN);
  });
});
