// MEMPOOL_INTERFACE → Schema → "An entry's inputs and outputs are rows keyed
// by box id"; MEMPOOL_INTERFACE → getBoxWithPending → "Three point reads".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/** Record every SQL text `fn()` prepares on `db`. */
function recordPrepared<T>(
  db: Database.Database,
  fn: () => T,
): { result: T; sqls: string[] } {
  const sqls: string[] = [];
  // better-sqlite3's `prepare` is a prototype method; the instance has no
  // own binding, so a direct assignment shadows it for the span of the call.
  const original = db.prepare.bind(db) as (sql: string) => ReturnType<Database.Database['prepare']>;
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    writable: true,
    value: function (sql: string) {
      sqls.push(sql);
      return original(sql);
    },
  });
  try {
    return { result: fn(), sqls };
  } finally {
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

/** EXPLAIN QUERY PLAN each recorded text, bind every `?` with an empty string. */
function planOf(db: Database.Database, sql: string): string {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  const binds = Array.from({ length: placeholders }, () => '');
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

const OWNER_HEX = 'cc'.repeat(32);
const POOLED_INPUT = 'dd'.repeat(32);
const ABSENT_ID = 'ff'.repeat(32);

/** A karma transaction the pool holds: one signature, one karma output of its owner. */
function karmaTx() {
  return {
    inputs: [POOLED_INPUT],
    outputs: [
      { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: bytes(OWNER_HEX) },
    ],
    signatures: { [OWNER_HEX]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

/**
 * Set the pool up in `dbFile`, pool one karma transaction, and return the
 * id of the one output it would create — `materializeOutput`'s id, the
 * derivation the insert uses.
 */
async function setUpPool(dbFile: string): Promise<string> {
  vi.resetModules();
  const dbMod = await importDbFresh();
  dbMod.initDb(dbFile);
  const mem = await import('../../src/store/mempool.js');
  const { computeTxId } = await import('@dagsocial/types');
  const { materializeOutput } = await import('@dagsocial/consensus');
  const tx = karmaTx();
  mem.insertUtxoTx(tx as never, 100);
  const txId = computeTxId(tx as never);
  const output = materializeOutput(tx.outputs[0] as never, txId, 0);
  dbMod.closeDb();
  return output.id!;
}

/**
 * Record `fn`'s prepared statements on a handle freshly opened against
 * `dbFile`. Each read is recorded on a handle opened for it, so a
 * statement compiled earlier on another handle cannot hide that read's
 * statement from the recorder.
 */
async function recordReadOn<T>(
  dbFile: string,
  fn: (mem: typeof import('../../src/store/mempool.js')) => T,
): Promise<{ result: T; sqls: string[]; db: Database.Database }> {
  vi.resetModules();
  const dbMod = await importDbFresh();
  dbMod.initDb(dbFile);
  const mem = await import('../../src/store/mempool.js');
  const db = dbMod.getDb();
  const run = recordPrepared(db, () => fn(mem));
  return { result: run.result, sqls: run.sqls, db };
}

describe('each pending read\'s prepared statement runs through indexes', () => {
  let tmpDir: string;
  let dbFile: string;
  let pooledOutput: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-read-plans-'));
    dbFile = path.join(tmpDir, 'pool.db');
    pooledOutput = await setUpPool(dbFile);
  });

  afterEach(async () => {
    const dbMod = await importDbFresh();
    dbMod.closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hasPendingSpend reads a SEARCH on mempool_inputs by box_id', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.hasPendingSpend([POOLED_INPUT, ABSENT_ID]),
    );

    expect(result).toBe(POOLED_INPUT);
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b[^|]*\bbox_id\b/i.test(p))).toBe(true);
  });

  it('getBoxWithPending on a pooled output reads a SEARCH on mempool_outputs', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.getBoxWithPending(pooledOutput),
    );

    expect(result).not.toBeNull();
    expect((result as { id?: string }).id).toBe(pooledOutput);
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_outputs\b/i.test(p))).toBe(true);
  });

  it('getBoxWithPending on an absent id searches inputs and outputs, scans neither mempool nor json_each', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.getBoxWithPending(ABSENT_ID),
    );

    expect(result).toBeNull();
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_outputs\b/i.test(p))).toBe(true);
  });

  it('getOwnKarmaBoxIdsWithPending\'s spends read a SEARCH on mempool_inputs', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.getOwnKarmaBoxIdsWithPending(OWNER_HEX),
    );

    // The owner's pooled karma output is `pooledOutput`; nothing spends it,
    // so it stays in the kept set.
    expect(result).toContain(pooledOutput);
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b/i.test(p))).toBe(true);
  });
});
