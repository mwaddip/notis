import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

async function importFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

// The six columns migrateMempoolTxColumns adds to an existing mempool table
// (MEMPOOL_INTERFACE → Schema).
const ALTER_COLUMNS = [
  'tx_inputs',
  'tx_output_ids',
  'tx_id',
  'tx_fee',
  'tx_bytes',
  'prune_entry_id',
];

// Every index createMempoolGateIndexes declares, derived from db.ts.
const GATE_INDEX_NAMES = [
  'idx_mempool_like',
  'idx_mempool_invite',
  'idx_mempool_vouch',
  'idx_mempool_expires',
  'idx_mempool_tx_inputs',
  'idx_mempool_tx_output_ids',
  'idx_mempool_tx_id',
  'idx_mempool_prune_entry_id',
  'idx_mempool_fee_rate',
];

// Pre-column mempool schema: literal SQL without the six ALTER columns and
// without gate indexes. The test pins that the ALTER pass repairs a table
// missing these columns; it does not pin any historical schema.
const PRE_COLUMN_MEMPOOL = `CREATE TABLE mempool (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('utxo_tx', 'prune')),
  utxo_tx_cbor BLOB,
  prune_entry_cbor BLOB,
  expires_at_height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  like_target TEXT,
  like_liker TEXT,
  invite_inviter TEXT,
  vouch_voucher TEXT
)`;

// Same table with only prune_entry_id missing — pins the per-column guard.
const MISSING_ONE_MEMPOOL = `CREATE TABLE mempool (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('utxo_tx', 'prune')),
  utxo_tx_cbor BLOB,
  prune_entry_cbor BLOB,
  expires_at_height INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  like_target TEXT,
  like_liker TEXT,
  invite_inviter TEXT,
  vouch_voucher TEXT,
  tx_inputs TEXT,
  tx_output_ids TEXT,
  tx_id TEXT,
  tx_fee INTEGER,
  tx_bytes INTEGER
)`;

describe('migrateMempoolTxColumns', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-migration-'));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The repair AND the order pin. A pre-column table has none of
  // the six ALTER columns. If createMempoolGateIndexes ran before
  // migrateMempoolTxColumns, CREATE INDEX on columns the table lacks throws —
  // so this passing IS the order pin.
  it('repairs a pre-column mempool table and creates all gate indexes', async () => {
    const dbPath = path.join(tmpDir, 'repair.db');

    const raw = new Database(dbPath);
    raw.exec(PRE_COLUMN_MEMPOOL);
    raw.close();

    const { initDb, getDb, closeDb } = await importFresh();
    initDb(dbPath);
    const db = getDb();

    const cols = (db.pragma('table_info(mempool)') as Array<{ name: string }>)
      .map(c => c.name);
    for (const col of ALTER_COLUMNS) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }

    const idxs = (db.pragma('index_list(mempool)') as Array<{ name: string }>)
      .map(i => i.name)
      .sort();
    expect(idxs).toEqual([...GATE_INDEX_NAMES].sort());

    closeDb();
  });

  it('adds a single missing column without disturbing existing ones', async () => {
    const dbPath = path.join(tmpDir, 'one-col.db');

    const raw = new Database(dbPath);
    raw.exec(MISSING_ONE_MEMPOOL);
    raw.close();

    const { initDb, getDb, closeDb } = await importFresh();
    initDb(dbPath);
    const db = getDb();

    const cols = (db.pragma('table_info(mempool)') as Array<{ name: string }>)
      .map(c => c.name);
    expect(cols).toContain('prune_entry_id');
    for (const col of ['tx_inputs', 'tx_output_ids', 'tx_id', 'tx_fee', 'tx_bytes']) {
      expect(cols).toContain(col);
    }

    closeDb();
  });

  it('second initDb on the same file does not throw or alter columns', async () => {
    const dbPath = path.join(tmpDir, 'idempotent.db');

    const raw = new Database(dbPath);
    raw.exec(PRE_COLUMN_MEMPOOL);
    raw.close();

    const s1 = await importFresh();
    s1.initDb(dbPath);
    const colsFirst = (s1.getDb().pragma('table_info(mempool)') as Array<{ name: string }>)
      .map(c => c.name);
    s1.closeDb();

    vi.resetModules();
    const s2 = await importFresh();
    expect(() => s2.initDb(dbPath)).not.toThrow();
    const colsSecond = (s2.getDb().pragma('table_info(mempool)') as Array<{ name: string }>)
      .map(c => c.name);
    expect(colsSecond).toEqual(colsFirst);
    s2.closeDb();
  });

  it('pre-column row survives with NULLs in the new columns', async () => {
    const dbPath = path.join(tmpDir, 'legacy.db');

    const raw = new Database(dbPath);
    raw.exec(PRE_COLUMN_MEMPOOL);
    raw.exec(
      `INSERT INTO mempool (entry_type, expires_at_height) VALUES ('utxo_tx', 100)`,
    );
    const inserted = raw.prepare('SELECT rowid FROM mempool').get() as { rowid: number };
    raw.close();

    const { initDb, getDb, closeDb } = await importFresh();
    initDb(dbPath);
    const db = getDb();

    const row = db.prepare(
      `SELECT tx_inputs, tx_output_ids, tx_id, tx_fee, tx_bytes, prune_entry_id
       FROM mempool WHERE rowid = ?`,
    ).get(inserted.rowid) as Record<string, unknown>;
    expect(row).toBeDefined();
    for (const col of ALTER_COLUMNS) {
      expect(row[col]).toBeNull();
    }

    closeDb();
  });
});
