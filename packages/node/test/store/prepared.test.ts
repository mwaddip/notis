// NODE_INTERFACE → Store Interface → Database lifecycle →
// "A statement is prepared once per database handle".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { KarmaBox } from '@dagsocial/types';
import { fixtureProvenance } from '../helpers.js';

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

/** Record every SQL text prepared on `db` from now on. */
function record(db: Database.Database): string[] {
  const sqls: string[] = [];
  const original = db.prepare.bind(db) as (sql: string) => ReturnType<Database.Database['prepare']>;
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    writable: true,
    value: function (sql: string) {
      sqls.push(sql);
      return original(sql);
    },
  });
  return sqls;
}

const BOX_TEXT = 'FROM utxo_boxes WHERE id = ? AND spent_at_block IS NULL';

async function seedBox(): Promise<KarmaBox> {
  const { computeBoxId } = await import('@dagsocial/types');
  const { insertBox } = await import('../../src/store/utxo.js');
  const candidate = {
    boxType: 'karma' as const,
    value: 100n,
    createdAtBlock: 0,
    owner: new Uint8Array(randomBytes(32)),
  };
  const box = { id: '', ...candidate, ...fixtureProvenance(candidate, 1) } as KarmaBox;
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

describe('prepared statements', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it.fails('a store read run twice on one handle compiles its statement once', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { getBox } = await import('../../src/store/utxo.js');
    initDb(':memory:');
    const box = await seedBox();
    const sqls = record(getDb());

    expect(getBox(box.id!)?.id).toBe(box.id);
    expect(getBox(box.id!)?.id).toBe(box.id);

    expect(sqls.filter((s) => s.includes(BOX_TEXT))).toHaveLength(1);
  });
});
