// MEMPOOL_INTERFACE → getBoxesPageWithPending; → getBoxTotalWithPending;
// → getOwnKarmaBoxIdsWithPending → "It is the unmarked rows of the set
// `getBoxesPageWithPending` reads for karma";
// NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending view, as
// admission spends from it".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import {
  LIKE_KARMA_COST,
  computeBoxId,
  computeCandidateBoxId,
  computeTxId,
} from '@dagsocial/types';
import type {
  AnyBox,
  CreditBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';

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
    getCreditBoxesPage: (
      owner: Uint8Array,
      page: { limit: number; after?: { value: bigint; id: string } },
    ) => { rows: CreditBox[]; next: { value: bigint; id: string } | null; count: number };
  };
}

// A typed dynamic import that typechecks against the shape the reads will
// take once the store exports them. The cast through `unknown` keeps the
// file compiling before the two new exports exist; a call to a missing
// export fails the case's last assertion rather than the file's compile.
async function importMempool() {
  return (await import('../../src/store/mempool.js')) as unknown as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getBoxesPageWithPending: (
      owner: Uint8Array,
      boxType: 'karma' | 'credit',
      page: { limit: number; after?: { value: bigint; id: string } },
    ) => {
      rows: (KarmaBox | CreditBox)[];
      next: { value: bigint; id: string } | null;
      count: number;
    };
    getBoxTotalWithPending: (owner: Uint8Array, boxType: 'karma' | 'credit') => bigint;
    getOwnKarmaBoxIdsWithPending: (ownerId: string) => string[];
  };
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function creditBox(value: bigint, owner: Uint8Array, nonce: number): CreditBox {
  const candidate = {
    boxType: 'credit' as const,
    value,
    createdAtBlock: 0,
    owner,
  };
  const prov = fixtureProvenance(candidate, 1, nonce);
  const withProv = { ...candidate, ...prov };
  const id = computeBoxId(withProv as AnyBox);
  return { ...withProv, id } as CreditBox;
}

function karmaBoxFx(value: bigint, owner: Uint8Array, nonce: number, income?: true): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value,
    createdAtBlock: 0,
    owner,
    ...(income === true ? { income } : {}),
  };
  const prov = fixtureProvenance(candidate, 1, nonce);
  const withProv = { ...candidate, ...prov };
  const id = computeBoxId(withProv as AnyBox);
  return { ...withProv, id } as KarmaBox;
}

// A credit-side transfer: a credit output for the change (when non-zero) and
// one for the payment. Outputs restricted to `credit`/`fee` so
// `isCreditSideTx` admits it.
function creditTransferTx(
  sender: Uint8Array,
  inputBoxId: string,
  changeValue: bigint,
  recipient: Uint8Array,
  paymentValue: bigint,
): UtxoTransaction {
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({
      boxType: 'credit',
      value: changeValue,
      createdAtBlock: 0,
      owner: sender,
    });
  }
  outputs.push({
    boxType: 'credit',
    value: paymentValue,
    createdAtBlock: 0,
    owner: recipient,
  });
  return {
    inputs: [inputBoxId],
    outputs,
    signatures: {},
    protocolVersion: 1,
  };
}

function karmaLikeTx(owner: Uint8Array, inputBoxId: string, changeValue: bigint): UtxoTransaction {
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

describe("an owner's boxes under the pool, read by owner", () => {
  let utxo: Awaited<ReturnType<typeof importUtxo>>;
  let mempool: Awaited<ReturnType<typeof importMempool>>;
  let OWNER_A: Uint8Array;
  let OWNER_B: Uint8Array;

  beforeEach(async () => {
    vi.resetModules();
    const { initDb } = await importDb();
    initDb(':memory:');
    utxo = await importUtxo();
    mempool = await importMempool();
    OWNER_A = new Uint8Array(randomBytes(32));
    OWNER_B = new Uint8Array(randomBytes(32));
  });

  afterEach(() => {
    vi.resetModules();
  });

  // The view of a key with a pooled spend (credit): the confirmed box is
  // out, the owner holds the change, the recipient the payment.
  it("a pooled credit transfer answers change to the sender and payment to the recipient", () => {
    const X = creditBox(100n, OWNER_A, 1);
    utxo.insertBox(X);
    // The confirmed read still holds X — the pool's rows are not yet joined
    // by the owner (the view is `getBoxesPageWithPending`'s).
    const confirmedA = utxo.getCreditBoxesPage(OWNER_A, { limit: 10 });
    expect(confirmedA.rows.map((r) => r.id)).toEqual([X.id]);

    const tx = creditTransferTx(OWNER_A, X.id!, 30n, OWNER_B, 70n);
    mempool.insertUtxoTx(tx, 999);
    const txId = computeTxId(tx);
    const changeId = computeCandidateBoxId(tx.outputs[0]!, txId, 0);
    const paymentId = computeCandidateBoxId(tx.outputs[1]!, txId, 1);

    const viewA = mempool.getBoxesPageWithPending(OWNER_A, 'credit', { limit: 10 });
    expect(viewA.count).toBe(1);
    expect(viewA.rows.map((r) => r.id)).toEqual([changeId]);
    expect(mempool.getBoxTotalWithPending(OWNER_A, 'credit')).toBe(30n);

    const viewB = mempool.getBoxesPageWithPending(OWNER_B, 'credit', { limit: 10 });
    expect(viewB.count).toBe(1);
    expect(viewB.rows.map((r) => r.id)).toEqual([paymentId]);
    expect(mempool.getBoxTotalWithPending(OWNER_B, 'credit')).toBe(70n);
  });

  // A chain of two credit transfers from A — only the tail stands.
  it("a chain of two credit transfers leaves only the second's change", () => {
    const X = creditBox(100n, OWNER_A, 1);
    utxo.insertBox(X);

    const tx1 = creditTransferTx(OWNER_A, X.id!, 60n, OWNER_B, 40n);
    mempool.insertUtxoTx(tx1, 999);
    const tx1Id = computeTxId(tx1);
    const change1 = computeCandidateBoxId(tx1.outputs[0]!, tx1Id, 0);
    // Control: the first chain link alone leaves A holding change1.
    const after1 = mempool.getBoxesPageWithPending(OWNER_A, 'credit', { limit: 10 });
    expect(after1.rows.map((r) => r.id)).toEqual([change1]);

    const tx2 = creditTransferTx(OWNER_A, change1, 20n, OWNER_B, 40n);
    mempool.insertUtxoTx(tx2, 999);
    const tx2Id = computeTxId(tx2);
    const change2 = computeCandidateBoxId(tx2.outputs[0]!, tx2Id, 0);

    const viewA = mempool.getBoxesPageWithPending(OWNER_A, 'credit', { limit: 10 });
    expect(viewA.count).toBe(1);
    expect(viewA.rows.map((r) => r.id)).toEqual([change2]);
  });

  // Karma: an owner holds a confirmed own box and a confirmed income box; a
  // pooled karma spend moves the own box with change.
  it('a pooled karma spend answers the change and the marked income box', () => {
    const own = karmaBoxFx(100n, OWNER_A, 1);
    const income = karmaBoxFx(50n, OWNER_A, 2, true);
    utxo.insertBox(own);
    utxo.insertBox(income);

    const tx = karmaLikeTx(OWNER_A, own.id!, 100n - LIKE_KARMA_COST);
    mempool.insertUtxoTx(tx, 999);
    const txId = computeTxId(tx);
    const changeId = computeCandidateBoxId(tx.outputs[0]!, txId, 0);

    const viewA = mempool.getBoxesPageWithPending(OWNER_A, 'karma', { limit: 10 });
    expect(viewA.count).toBe(2);
    const ids = viewA.rows.map((r) => r.id!);
    expect(new Set(ids)).toEqual(new Set([changeId, income.id!]));
    const incomeRow = viewA.rows.find((r) => r.id === income.id) as KarmaBox;
    expect(incomeRow.income).toBe(true);
    const changeRow = viewA.rows.find((r) => r.id === changeId) as KarmaBox;
    expect(changeRow.income).toBeUndefined();
    expect(mempool.getBoxTotalWithPending(OWNER_A, 'karma')).toBe((100n - LIKE_KARMA_COST) + 50n);
  });

  // Paging across the halves: confirmed and pooled rows whose values
  // interleave, one value shared across a confirmed and a pooled row.
  it('a page walks confirmed and pooled rows merged in value DESC, id', () => {
    const C300 = creditBox(300n, OWNER_A, 1);
    const C200 = creditBox(200n, OWNER_A, 2);
    const C100 = creditBox(100n, OWNER_A, 3);
    utxo.insertBox(C300);
    utxo.insertBox(C200);
    utxo.insertBox(C100);

    // Each pool entry has its own confirmed input, so no conflict arises
    // across them.
    const feederP300 = creditBox(300n, OWNER_B, 10);
    utxo.insertBox(feederP300);
    const txP300 = creditTransferTx(OWNER_B, feederP300.id!, 0n, OWNER_A, 300n);
    mempool.insertUtxoTx(txP300, 999);
    const txP300Id = computeTxId(txP300);
    const P300 = computeCandidateBoxId(txP300.outputs[0]!, txP300Id, 0);

    const feederP150 = creditBox(150n, OWNER_B, 11);
    utxo.insertBox(feederP150);
    const txP150 = creditTransferTx(OWNER_B, feederP150.id!, 0n, OWNER_A, 150n);
    mempool.insertUtxoTx(txP150, 999);
    const txP150Id = computeTxId(txP150);
    const P150 = computeCandidateBoxId(txP150.outputs[0]!, txP150Id, 0);

    // The two value=300 rows are the sole tie; `value DESC, id` resolves it
    // by id ascending.
    const topTwo = [C300.id!, P300].sort();
    const expected = [...topTwo, C200.id!, P150, C100.id!];

    const seen1: string[] = [];
    let next: { value: bigint; id: string } | null = null;
    let countOnLastPage = 0;
    for (let i = 0; i <= expected.length; i++) {
      const page: ReturnType<typeof mempool.getBoxesPageWithPending> =
        mempool.getBoxesPageWithPending(OWNER_A, 'credit', { limit: 1, after: next ?? undefined });
      expect(page.count).toBe(expected.length);
      countOnLastPage = page.count;
      if (page.rows.length === 0) break;
      for (const r of page.rows) seen1.push(r.id!);
      if (page.next === null) break;
      next = page.next;
    }
    expect(countOnLastPage).toBe(expected.length);
    expect(seen1).toEqual(expected);

    const seen2: string[] = [];
    next = null;
    for (;;) {
      const page: ReturnType<typeof mempool.getBoxesPageWithPending> =
        mempool.getBoxesPageWithPending(OWNER_A, 'credit', { limit: 2, after: next ?? undefined });
      expect(page.count).toBe(expected.length);
      for (const r of page.rows) seen2.push(r.id!);
      if (page.next === null) break;
      next = page.next;
    }
    expect(seen2).toEqual(expected);
  });
});
