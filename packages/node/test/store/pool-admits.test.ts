// MEMPOOL_INTERFACE → assertPoolAdmits: the pool's own refusals, asked
// without writing anything. The function throws what `insertUtxoTx`'s
// conflict and capacity gates would throw at that moment, and leaves the
// pool's rows untouched: a displacement it finds open is the insert's to
// make.
import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {computeBoxId,
  computeTxId,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importMempoolFresh() {
  const mod = await import('../../src/store/mempool.js');
  return mod as {
    insertUtxoTx: (tx: any, txId: string, expiresAtHeight: number) => number;
    assertPoolAdmits: (tx: any) => void;
    getPendingEntries: (limit: number) => any[];
    setMempoolCap: (n: number) => void;
    MempoolFullError: new (cap: number, poolClass?: 'credit' | 'karma') => Error;
    PendingSpendConflictError: new (boxId: string) => Error;
  };
}

/** A credit-side entry whose fee output is `inputValue - outputValue`. */
function seededCreditTx(
  label: string,
  inputValue: bigint,
  outputValue: bigint,
): { tx: unknown; box: Record<string, unknown> } {
  const owner = createHash('blake2b512').update(`${label}_owner`).digest().subarray(0, 32);
  const box = {
    boxType: 'credit' as const,
    value: inputValue,
    createdAtBlock: 0,
    owner: new Uint8Array(owner),
    txId: createHash('blake2b512').update(`${label}_tx`).digest().subarray(0, 32).toString('hex'),
    index: 0,
  };
  const id = computeBoxId(box as never);
  const outputs: unknown[] = [
    { boxType: 'credit' as const, value: outputValue, createdAtBlock: 0, owner: new Uint8Array(owner) },
  ];
  const fee = inputValue - outputValue;
  if (fee > 0n) outputs.push({ boxType: 'fee' as const, value: fee, createdAtBlock: 0 });
  return {
    tx: { inputs: [id], outputs, signatures: {}, protocolVersion: 1 },
    box: { ...box, id },
  };
}

/** Snapshot of the pool: every row's rowid and raw `tx_id` string. */
async function snapshotPool(): Promise<{ count: number; rows: Array<{ rowid: number; tx_id: string }> }> {
  const { getDb } = await importDbFresh();
  const rows = getDb()
    .prepare('SELECT rowid, tx_id FROM mempool ORDER BY rowid')
    .all() as Array<{ rowid: number; tx_id: string }>;
  return { count: rows.length, rows };
}

describe('assertPoolAdmits', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDbFresh();
    db.initDb(':memory:');
  });

  afterEach(async () => {
    const db = await importDbFresh();
    db.closeDb();
  });

  it('with room: throws nothing, and the pool\'s rows are byte-for-byte unchanged', async () => {
    const mem = await importMempoolFresh();
    mem.setMempoolCap(4);

    const resident = seededCreditTx('with_room_resident', 10_000n, 100n); // fee 9_900
    mem.insertUtxoTx(resident.tx as any, computeTxId(resident.tx as any), 1000);

    const before = await snapshotPool();
    expect(before.count).toBe(1);

    const arrival = seededCreditTx('with_room_arrival', 10_000n, 100n); // fee 9_900, distinct input
    expect(() => mem.assertPoolAdmits(arrival.tx as any)).not.toThrow();

    const after = await snapshotPool();
    expect(after).toEqual(before);
  });

  it('a full credit class with a higher-bidding arrival: throws nothing, the resident is still pooled', async () => {
    const mem = await importMempoolFresh();
    mem.setMempoolCap(2); // credit cap = 1

    const resident = seededCreditTx('fullcred_resident', 1_000n, 900n); // fee 100
    mem.insertUtxoTx(resident.tx as any, computeTxId(resident.tx as any), 1000);

    const before = await snapshotPool();
    expect(before.count).toBe(1);
    const residentTxId = before.rows[0]!.tx_id;

    const arrival = seededCreditTx('fullcred_arrival_higher', 10_000n, 1n); // fee 9_999
    expect(() => mem.assertPoolAdmits(arrival.tx as any)).not.toThrow();

    // Writes nothing: the resident has not been displaced.
    const after = await snapshotPool();
    expect(after.rows.map((r) => r.tx_id)).toEqual([residentTxId]);
  });

  it('a full credit class with a lower bid: throws MempoolFullError', async () => {
    const mem = await importMempoolFresh();
    mem.setMempoolCap(2); // credit cap = 1

    const resident = seededCreditTx('fullcred_resident2', 1_000n, 100n); // fee 900
    mem.insertUtxoTx(resident.tx as any, computeTxId(resident.tx as any), 1000);

    const arrival = seededCreditTx('fullcred_arrival_lower', 1_000n, 999n); // fee 1
    let refusal: unknown;
    try {
      mem.assertPoolAdmits(arrival.tx as any);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(mem.MempoolFullError);
    expect((refusal as { poolClass: string }).poolClass).toBe('credit');
  });

  it('a pooled spend of an input: throws PendingSpendConflictError, and a full class and a conflict together: the conflict answers', async () => {
    const mem = await importMempoolFresh();
    mem.setMempoolCap(2); // credit cap = 1

    const resident = seededCreditTx('conflict_resident', 1_000n, 100n); // fee 900
    mem.insertUtxoTx(resident.tx as any, computeTxId(resident.tx as any), 1000);

    // A second transaction spending the SAME input box as the resident.
    const share = (resident.box.value as bigint) - 500n;
    const colliding = {
      inputs: [resident.box.id],
      outputs: [
        { boxType: 'credit' as const, value: share, createdAtBlock: 0, owner: resident.box.owner },
        { boxType: 'fee' as const, value: 500n, createdAtBlock: 0 },
      ],
      signatures: {},
      protocolVersion: 1,
    };

    let refusal: unknown;
    try {
      mem.assertPoolAdmits(colliding as any);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(mem.PendingSpendConflictError);
    expect((refusal as Error).message).toContain(resident.box.id as string);
  });
});
