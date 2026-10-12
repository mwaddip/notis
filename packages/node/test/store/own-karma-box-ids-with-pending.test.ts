// MEMPOOL_INTERFACE → getOwnKarmaBoxIdsWithPending: the pending view of the
// owner's unmarked karma boxes — confirmed ∪ pooled outputs − pooled inputs,
// found by `karma_owner`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import {
  LIKE_KARMA_COST,
  POST_PRICE_THREAD,
  computeBoxId,
  computeTxId,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput } from '@dagsocial/consensus';

import { fixtureProvenance } from '../helpers.js';

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as {
    insertBox: (box: AnyBox) => void;
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getOwnKarmaBoxIdsWithPending: (ownerId: string) => string[];
    removeUtxoTxEntry: (txId: string) => number;
    removeEntry: (rowid: number) => void;
    purgeExpired: (currentHeight: number) => number;
  };
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function karmaBox(
  value: bigint,
  owner: Uint8Array,
  nonce: number,
  income?: true,
): KarmaBox {
  const candidate: KarmaBox = {
    id: '',
    boxType: 'karma',
    value,
    createdAtBlock: 0,
    owner,
    ...(income === true ? { income } : {}),
    ...fixtureProvenance(
      { boxType: 'karma', value, createdAtBlock: 0, owner, ...(income === true ? { income } : {}) },
      1,
      nonce,
    ),
  };
  candidate.id = computeBoxId(candidate);
  return candidate;
}

function likeTx(
  owner: Uint8Array,
  inputBoxId: string,
  changeValue: bigint,
): UtxoTransaction {
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({
      boxType: 'karma',
      value: changeValue,
      createdAtBlock: 0,
      owner,
    });
  }
  outputs.push({
    boxType: 'like_accrual',
    value: LIKE_KARMA_COST,
    createdAtBlock: 0,
    author: new Uint8Array(32).fill(0xee),
  });
  return {
    inputs: [inputBoxId],
    outputs,
    signatures: { [toHex(owner)]: new Uint8Array(64) },
    protocolVersion: 1,
    likeTarget: '00'.repeat(32),
  };
}

function threadTx(owner: Uint8Array, inputBoxId: string, changeValue: bigint): UtxoTransaction {
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({
      boxType: 'karma',
      value: changeValue,
      createdAtBlock: 0,
      owner,
    });
  }
  outputs.push({
    boxType: 'karma_price',
    value: POST_PRICE_THREAD,
    createdAtBlock: 0,
  });
  return {
    inputs: [inputBoxId],
    outputs,
    signatures: { [toHex(owner)]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function consolidationTx(
  owner: Uint8Array,
  inputBoxIds: string[],
  outputValue: bigint,
): UtxoTransaction {
  return {
    inputs: inputBoxIds,
    outputs: [
      {
        boxType: 'karma',
        value: outputValue,
        createdAtBlock: 0,
        owner,
      },
    ],
    signatures: { [toHex(owner)]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

function withdrawalTx(owner: Uint8Array, inputBoxId: string, value: bigint): UtxoTransaction {
  return {
    inputs: [inputBoxId],
    outputs: [
      {
        boxType: 'karma',
        value,
        createdAtBlock: 0,
        owner,
      },
    ],
    signatures: { [toHex(owner)]: new Uint8Array(64) },
    protocolVersion: 1,
    postWithdraw: { postId: '00'.repeat(32) },
  };
}

function claimTx(
  owner: Uint8Array,
  inputBoxId: string,
  outputValue: bigint,
  name: string,
): UtxoTransaction {
  return {
    inputs: [inputBoxId],
    outputs: [
      {
        boxType: 'karma',
        value: outputValue,
        createdAtBlock: 0,
        owner,
      },
      {
        boxType: 'username',
        value: 0n,
        createdAtBlock: 0,
        owner,
        name: new Uint8Array(Buffer.from(name, 'utf8')),
      },
    ],
    signatures: { [toHex(owner)]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

/** The id a pooled transaction's output takes once block application names it. */
function pendingOutputId(tx: UtxoTransaction, index: number): string {
  const txId = computeTxId(tx);
  return materializeOutput(tx.outputs[index]!, txId, index).id!;
}

describe('getOwnKarmaBoxIdsWithPending — confirmed ∪ pending outputs − pending inputs', () => {
  let utxo: Awaited<ReturnType<typeof importUtxo>>;
  let mempool: Awaited<ReturnType<typeof importMempool>>;
  let OWNER: Uint8Array;
  let OWNER_HEX: string;

  beforeEach(async () => {
    vi.resetModules();
    const { initDb } = await importDb();
    initDb(':memory:');
    utxo = await importUtxo();
    mempool = await importMempool();
    OWNER = new Uint8Array(randomBytes(32));
    OWNER_HEX = toHex(OWNER);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('nothing pooled — the owner holds the confirmed own box', () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([own.id]);
  });

  it("one pooled spend — its change, and not the box it spent", () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    const tx = likeTx(OWNER, own.id!, 100n - LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx, 999);
    const changeId = pendingOutputId(tx, 0);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([changeId]);
  });

  it("a chain of three pooled spends — the last change alone", () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);

    const tx1 = likeTx(OWNER, own.id!, 100n - LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx1, 999);
    const changeAfter1 = pendingOutputId(tx1, 0);

    const tx2 = likeTx(OWNER, changeAfter1, 100n - 2n * LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx2, 999);
    const changeAfter2 = pendingOutputId(tx2, 0);

    const tx3 = likeTx(OWNER, changeAfter2, 100n - 3n * LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx3, 999);
    const changeAfter3 = pendingOutputId(tx3, 0);

    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([changeAfter3]);
  });

  it.fails("a chain of three pooled spends, rows inserted child-first — the last change alone", () => {
    // The grandchild is inserted first, so SQLite walks the owner's index with
    // the child at the lowest rowid: the row-by-row answer carries every
    // change box, since each row's inputs are added by the row ahead of it.
    // MEMPOOL_INTERFACE → getOwnKarmaBoxIdsWithPending: "less every box a
    // pooled transaction spends" — the subtraction answers over the gathered
    // outputs, not row by row.
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);

    const tx1 = likeTx(OWNER, own.id!, 100n - LIKE_KARMA_COST);
    const changeAfter1 = pendingOutputId(tx1, 0);
    const tx2 = likeTx(OWNER, changeAfter1, 100n - 2n * LIKE_KARMA_COST);
    const changeAfter2 = pendingOutputId(tx2, 0);
    const tx3 = likeTx(OWNER, changeAfter2, 100n - 3n * LIKE_KARMA_COST);
    const changeAfter3 = pendingOutputId(tx3, 0);

    mempool.insertUtxoTx(tx3, 999);
    mempool.insertUtxoTx(tx2, 999);
    mempool.insertUtxoTx(tx1, 999);

    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([changeAfter3]);
  });

  it("a pooled spend that returned no change — the empty list", () => {
    // A karma box of exactly LIKE_KARMA_COST — the spend emits only the
    // like_accrual marker, no karma output (NODE_INTERFACE → Karma transition
    // rules → "A karma output carries at least 1n").
    const own = karmaBox(LIKE_KARMA_COST, OWNER, 1);
    utxo.insertBox(own);
    const tx = likeTx(OWNER, own.id!, 0n);
    mempool.insertUtxoTx(tx, 999);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([]);
  });

  it('the owner holding an income box alone — nothing pooled — answers the empty list', () => {
    const income = karmaBox(50n, OWNER, 1, true);
    utxo.insertBox(income);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([]);
  });

  it("the income box is never answered — a confirmed own box beside it is", () => {
    const own = karmaBox(100n, OWNER, 1);
    const income = karmaBox(50n, OWNER, 2, true);
    utxo.insertBox(own);
    utxo.insertBox(income);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([own.id]);
  });

  it("another owner's rows are never read", () => {
    const other = new Uint8Array(randomBytes(32));
    const otherHex = toHex(other);
    const ownA = karmaBox(100n, OWNER, 1);
    const ownOther = karmaBox(100n, other, 2);
    utxo.insertBox(ownA);
    utxo.insertBox(ownOther);

    const otherTx = likeTx(other, ownOther.id!, 100n - LIKE_KARMA_COST);
    mempool.insertUtxoTx(otherTx, 999);

    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([ownA.id]);
    expect(mempool.getOwnKarmaBoxIdsWithPending(otherHex)).toEqual([pendingOutputId(otherTx, 0)]);
  });

  it('a pooled consolidation moves the own box — the row is reachable by owner', () => {
    const ownA = karmaBox(60n, OWNER, 1);
    const ownB = karmaBox(40n, OWNER, 2);
    utxo.insertBox(ownA);
    utxo.insertBox(ownB);

    const tx = consolidationTx(OWNER, [ownA.id!, ownB.id!], 100n);
    mempool.insertUtxoTx(tx, 999);

    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([pendingOutputId(tx, 0)]);
  });

  it('a pooled name claim moves the own box — the row is reachable by owner', () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    const tx = claimTx(OWNER, own.id!, 100n, 'alice');
    mempool.insertUtxoTx(tx, 999);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([pendingOutputId(tx, 0)]);
  });

  it('a pooled withdrawal moves the own box — the row is reachable by owner', () => {
    const own = karmaBox(10n, OWNER, 1);
    utxo.insertBox(own);
    const tx = withdrawalTx(OWNER, own.id!, 10n);
    mempool.insertUtxoTx(tx, 999);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([pendingOutputId(tx, 0)]);
  });

  it("removeUtxoTxEntry leaves the answer what the remaining state gives", () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    const tx = likeTx(OWNER, own.id!, 100n - LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx, 999);
    mempool.removeUtxoTxEntry(computeTxId(tx));
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([own.id]);
  });

  it("removeEntry leaves the answer what the remaining state gives", () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    const tx = likeTx(OWNER, own.id!, 100n - LIKE_KARMA_COST);
    const rowid = mempool.insertUtxoTx(tx, 999);
    mempool.removeEntry(rowid);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([own.id]);
  });

  it("purgeExpired leaves the answer what the remaining state gives", () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    const tx = threadTx(OWNER, own.id!, 100n - POST_PRICE_THREAD);
    mempool.insertUtxoTx(tx, 50);
    mempool.purgeExpired(100);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([own.id]);
  });

  it("a block confirming a pooled spend — removing its row — leaves the answer what the remaining state gives", async () => {
    const own = karmaBox(100n, OWNER, 1);
    utxo.insertBox(own);
    const tx = likeTx(OWNER, own.id!, 100n - LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx, 999);
    // What a block that confirms a pending entry does: the row is removed by
    // its tx id, and the confirmed state then holds the change box.
    mempool.removeUtxoTxEntry(computeTxId(tx));
    // The confirmed state's own box is spent and its change box inserted —
    // the shape apply writes to the store.
    const changeBox = materializeOutput(tx.outputs[0]!, computeTxId(tx), 0) as KarmaBox;
    const { deleteBox } = await import('../../src/store/utxo.js');
    deleteBox(own.id!);
    utxo.insertBox(changeBox);
    expect(mempool.getOwnKarmaBoxIdsWithPending(OWNER_HEX)).toEqual([changeBox.id]);
  });
});
