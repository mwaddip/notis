// MEMPOOL_INTERFACE → Schema → "An entry's inputs and outputs are rows keyed
// by box id"; MEMPOOL_INTERFACE → getBoxWithPending → "Three point reads".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('each pending read\'s prepared statement runs through indexes', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await importDbFresh();
    db.initDb(':memory:');
  });

  afterEach(async () => {
    const db = await importDbFresh();
    db.closeDb();
  });

  it.fails('runs through indexes, not through a mempool scan or json_each', async () => {
    const mem = await import('../../src/store/mempool.js');
    const { computeTxId } = await import('@dagsocial/types');
    const { materializeOutput } = await import('@dagsocial/consensus');
    const { getDb } = await importDbFresh();
    const db = getDb();

    const OWNER_HEX = 'cc'.repeat(32);
    const POOLED_INPUT = 'dd'.repeat(32);
    const UNPOOLED_INPUT = 'ee'.repeat(32);
    const ABSENT_ID = 'ff'.repeat(32);

    // A karma transaction the pool holds, so `karma_owner` carries the owner
    // and `getOwnKarmaBoxIdsWithPending` has a row to find
    // (MEMPOOL_INTERFACE → Gate metadata columns). One signature, one karma
    // output of its own owner.
    const karmaTx = {
      inputs: [POOLED_INPUT],
      outputs: [
        { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: bytes(OWNER_HEX) },
      ],
      signatures: { [OWNER_HEX]: new Uint8Array(64) },
      protocolVersion: 1,
    };
    mem.insertUtxoTx(karmaTx as never, 100);

    // The pooled output's id, as `materializeOutput` writes it at insert.
    const pooledTxId = computeTxId(karmaTx as never);
    const pooledOutput = materializeOutput(karmaTx.outputs[0] as never, pooledTxId, 0);

    // Record every statement each of the four reads prepares on the live
    // handle (MEMPOOL_INTERFACE → getBoxWithPending → "Three point reads";
    // → getOwnKarmaBoxIdsWithPending).
    const { sqls: s1 } = recordPrepared(db, () =>
      mem.hasPendingSpend([POOLED_INPUT, UNPOOLED_INPUT]),
    );
    const { sqls: s2 } = recordPrepared(db, () =>
      mem.getBoxWithPending(pooledOutput.id!),
    );
    const { sqls: s3 } = recordPrepared(db, () =>
      mem.getBoxWithPending(ABSENT_ID),
    );
    const { sqls: s4 } = recordPrepared(db, () =>
      mem.getOwnKarmaBoxIdsWithPending(OWNER_HEX),
    );
    const allSqls = [...s1, ...s2, ...s3, ...s4];

    // Each recorded text's EXPLAIN QUERY PLAN. SQLite does not execute the
    // statement, but each `?` still has to bind — empty strings suffice.
    const plans = allSqls.map((sql) => {
      const placeholders = (sql.match(/\?/g) ?? []).length;
      const binds = Array.from({ length: placeholders }, () => '');
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>;
      return rows.map((r) => r.detail).join(' | ');
    });

    const scansMempool = plans.some((p) => /\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p));
    const anyJsonEach = plans.some((p) => /json_each/i.test(p));
    const spendSearchesInputs = plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b/i.test(p));

    // One compound assertion so the failure names which property stood.
    expect({ scansMempool, anyJsonEach, spendSearchesInputs }).toEqual({
      scansMempool: false,
      anyJsonEach: false,
      spendSearchesInputs: true,
    });
  });
});
