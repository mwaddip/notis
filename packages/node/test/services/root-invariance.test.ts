import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UtxoTxTree } from '@dagsocial/types';
import {
  bytesToHex,
  buildMerkleRoot,
  leafHash,
  hexToBytes,
  computeUtxoTxRoot,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import {
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
} from '../helpers.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as unknown as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: unknown) => void;
  };
}

// A fixture aligned under TYPES_INTERFACE → Ordering block: two ids and two
// elements, each pair in body order.
const alignedFixture: UtxoTxTree = {
  utxoTxIds: ['ab'.repeat(32), 'cd'.repeat(32)],
  utxoTxs: [new Uint8Array([0x01]), new Uint8Array([0x02])],
};

describe('utxoTxRoot — the root over one body', () => {
  beforeEach(async () => { vi.resetModules(); });
  afterEach(async () => { vi.resetModules(); });

  it.fails('a mined block\'s utxoTxRoot is the root of its id leaves, then its bytes leaves, in body order', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    utxo.insertBox(box);

    const block = await makeApplicableBlock({
      utxoTxs: [makeCreditTx(sender, [box], 10_000n)],
    });

    // TYPES_INTERFACE → Ordering block: every utxoTxIds entry under 'utxotx',
    // then every utxoTxs element under 'utxotx-bytes'. Hand-built, so this
    // case names the leaf layout independently of the function it holds.
    const expected = bytesToHex(buildMerkleRoot([
      ...block.utxoTxTree.utxoTxIds.map((id) => leafHash('utxotx', hexToBytes(id))),
      ...block.utxoTxTree.utxoTxs.map((bytes) => leafHash('utxotx-bytes', bytes)),
    ]));
    expect(block.header.utxoTxRoot).toBe(expected);
  });

  it.fails('the settlement is the last leaf of each class', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();

    const sender = makeTestIdentity();
    const box = makeCreditBox(100_000n, sender.userId, 0, 1);
    utxo.insertBox(box);

    const block = await makeApplicableBlock({
      utxoTxs: [makeCreditTx(sender, [box], 10_000n)],
    });

    const ids = block.utxoTxTree.utxoTxIds;
    const txs = block.utxoTxTree.utxoTxs;
    const withSettlement = bytesToHex(buildMerkleRoot([
      ...ids.map((id) => leafHash('utxotx', hexToBytes(id))),
      ...txs.map((bytes) => leafHash('utxotx-bytes', bytes)),
    ]));
    const withoutSettlement = bytesToHex(buildMerkleRoot([
      ...ids.slice(0, -1).map((id) => leafHash('utxotx', hexToBytes(id))),
      ...txs.slice(0, -1).map((bytes) => leafHash('utxotx-bytes', bytes)),
    ]));
    expect(block.header.utxoTxRoot).not.toBe(withoutSettlement);
    expect(block.header.utxoTxRoot).toBe(withSettlement);
  });

  it('leaf order is normative — exchanging two ids moves the root, exchanging two elements moves it', () => {
    const swappedIds: UtxoTxTree = {
      ...alignedFixture,
      utxoTxIds: [alignedFixture.utxoTxIds[1]!, alignedFixture.utxoTxIds[0]!],
    };
    const swappedTxs: UtxoTxTree = {
      ...alignedFixture,
      utxoTxs: [alignedFixture.utxoTxs[1]!, alignedFixture.utxoTxs[0]!],
    };
    expect(computeUtxoTxRoot(swappedIds)).not.toBe(computeUtxoTxRoot(alignedFixture));
    expect(computeUtxoTxRoot(swappedTxs)).not.toBe(computeUtxoTxRoot(alignedFixture));
  });
});
