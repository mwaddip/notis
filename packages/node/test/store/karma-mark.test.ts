import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

import { canonicalBoxBytes, computeBoxId } from '@dagsocial/types';
import type { AnyBox, KarmaBox } from '@dagsocial/types';

import type { Page, BoxKey, PageResult } from '../../src/store/index.js';
import { fixtureProvenance } from '../helpers.js';

// NODE_INTERFACE → "The store does not version its schema". Each case opens a
// fresh in-memory database and imports the modules anew — the dynamic import
// is what makes a reset safe.
async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxoFresh() {
  const mod = await import('../../src/store/utxo.js');
  return mod as {
    insertBox: (box: AnyBox) => void;
    getBox: (boxId: string) => AnyBox | null;
    getKarmaBoxes: (owner: Uint8Array) => KarmaBox[];
    getKarmaBoxesPage: (
      owner: Uint8Array,
      page: Page<BoxKey>,
    ) => PageResult<KarmaBox, BoxKey>;
    getUnspentBoxes: () => AnyBox[];
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    unconsumeBox: (boxId: string) => void;
    deleteBox: (boxId: string) => void;
  };
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

function karmaCandidate(
  value: bigint,
  owner: Uint8Array,
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
    ),
  };
  candidate.id = computeBoxId(candidate);
  return candidate;
}

describe("the store carries the karma box's mark", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('a marked box inserted reads back marked, an unmarked one reads back with no income key', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);

    const own = karmaCandidate(100n, owner);
    const income = karmaCandidate(50n, owner, true);
    insertBox(own);
    insertBox(income);

    const readOwn = getBox(own.id!) as KarmaBox;
    const readIncome = getBox(income.id!) as KarmaBox;

    expect(readOwn.boxType).toBe('karma');
    expect(readOwn.income).toBeUndefined();
    expect(Object.hasOwn(readOwn, 'income')).toBe(false);
    expect(readIncome.income).toBe(true);
  });

  it('getKarmaBoxes returns the mark on the income box and omits the key on the own box', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxes } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);

    const own = karmaCandidate(100n, owner);
    const income = karmaCandidate(50n, owner, true);
    insertBox(own);
    insertBox(income);

    const rows = getKarmaBoxes(owner);
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id!, r] as const));
    expect(byId.get(own.id!)!.income).toBeUndefined();
    expect(Object.hasOwn(byId.get(own.id!)!, 'income')).toBe(false);
    expect(byId.get(income.id!)!.income).toBe(true);
  });

  it('getKarmaBoxesPage carries the mark on the page row', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaBoxesPage } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);
    const own = karmaCandidate(100n, owner);
    const income = karmaCandidate(50n, owner, true);
    insertBox(own);
    insertBox(income);

    const page = getKarmaBoxesPage(owner, { limit: 10 });
    const byId = new Map(page.rows.map((r) => [r.id!, r] as const));
    expect(byId.get(own.id!)!.income).toBeUndefined();
    expect(byId.get(income.id!)!.income).toBe(true);
    expect(page.count).toBe(2);
  });

  it('getUnspentBoxes carries the mark on the row that feeds the tree', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getUnspentBoxes } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);
    const own = karmaCandidate(100n, owner);
    const income = karmaCandidate(50n, owner, true);
    insertBox(own);
    insertBox(income);

    const unspent = getUnspentBoxes() as KarmaBox[];
    const byId = new Map(unspent.map((r) => [r.id!, r] as const));
    expect(byId.get(own.id!)!.income).toBeUndefined();
    expect(byId.get(income.id!)!.income).toBe(true);
  });

  it("canonicalBoxBytes of a box read back equals canonicalBoxBytes of the box inserted", async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);
    const own = karmaCandidate(100n, owner);
    const income = karmaCandidate(50n, owner, true);
    insertBox(own);
    insertBox(income);

    const readOwn = getBox(own.id!) as KarmaBox;
    const readIncome = getBox(income.id!) as KarmaBox;
    expect(Buffer.from(canonicalBoxBytes(readOwn)).toString('hex'))
      .toBe(Buffer.from(canonicalBoxBytes(own)).toString('hex'));
    expect(Buffer.from(canonicalBoxBytes(readIncome)).toString('hex'))
      .toBe(Buffer.from(canonicalBoxBytes(income)).toString('hex'));
  });

  it('a consume followed by unconsume leaves the mark intact and a delete-then-insert round trips it', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getBox, consumeBox, unconsumeBox, deleteBox } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);
    const income = karmaCandidate(50n, owner, true);
    insertBox(income);

    consumeBox(income.id!, 5);
    unconsumeBox(income.id!);
    const afterRoundTrip = getBox(income.id!) as KarmaBox;
    expect(afterRoundTrip.income).toBe(true);

    deleteBox(income.id!);
    expect(getBox(income.id!)).toBeNull();
    insertBox(income);
    const reinserted = getBox(income.id!) as KarmaBox;
    expect(reinserted.income).toBe(true);
  });

  it('a database written before the mark existed reads its karma boxes unmarked', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { getBox, getKarmaBoxes } = await importUtxoFresh();
    initDb(':memory:');
    const owner = bytes(32);
    // The pre-mark shape: extra_data holds `{}` on every karma row — what
    // every karma box carried before the mark existed.
    const candidate = {
      boxType: 'karma' as const,
      value: 100n,
      createdAtBlock: 0,
      owner,
    };
    const prov = fixtureProvenance(candidate, 1);
    const id = computeBoxId({ ...candidate, ...prov } as KarmaBox);
    getDb()
      .prepare(
        `INSERT INTO utxo_boxes
           (id, box_type, value, created_at_block, spent_at_block,
            owner, extra_data,
            tx_id, output_index)
         VALUES (?, 'karma', ?, 0, NULL, ?, '{}', ?, ?)`,
      )
      .run(id, candidate.value, Buffer.from(owner), prov.txId, prov.index);

    const direct = getBox(id) as KarmaBox;
    expect(direct.income).toBeUndefined();
    expect(Object.hasOwn(direct, 'income')).toBe(false);
    const [listed] = getKarmaBoxes(owner);
    expect(listed!.income).toBeUndefined();
    expect(Object.hasOwn(listed!, 'income')).toBe(false);
  });
});
