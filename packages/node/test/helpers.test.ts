import { describe, it, expect } from 'vitest';
import { computeBoxId } from '@dagsocial/types';
import { seedBond, uid, openAvlDb } from './helpers.js';
import { initDb, getDb, closeDb } from '../src/store/db.js';

/** The AVL table/index rows a fresh database carries, keyed for comparison. */
function avlSchemaRows(db: { prepare: (sql: string) => { all: () => unknown[] } }): unknown[] {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'avl_tree%' OR name LIKE 'idx_avl_tree%' ORDER BY name",
    )
    .all();
}

/**
 * Pins the fixture helpers themselves.
 *
 * `seedBond` is the single source of bond fixtures across this suite, and
 * centralising is what makes its provenance rule load-bearing: a shared helper
 * that let two callers collide produces the collision at every site at once.
 * These are the properties that make it safe to share.
 */
describe('seedBond — distinct provenance per call', () => {
  const inviterId = uid('alice');

  it('two bonds built with different labels have distinct ids', () => {
    const a = seedBond({ label: 'first', inviterId });
    const b = seedBond({ label: 'second', inviterId });

    expect(new Set([a.bond.id, b.bond.id]).size).toBe(2);
  });

  it('they are distinct transactions, not just distinct boxes', () => {
    const a = seedBond({ label: 'first', inviterId });
    const b = seedBond({ label: 'second', inviterId });

    // The bond is the transaction's first (and only seeded) output.
    expect(a.bond.index).toBe(0);

    // Different txId across calls — the property `label` exists to guarantee.
    // Without it these two share a txId and both bonds land on
    // (txId, index) = (same, 0), which `UNIQUE(tx_id, output_index)` forbids.
    expect(a.bond.txId).not.toBe(b.bond.txId);
  });

  it('a difference confined to the bond VALUE still separates them', () => {
    // ⛔ **The sharp case, and it survives the collapse in a different shape.**
    // `seedAsOneTx` derives the shared txId from `candidates[0]`, which is now
    // the bond itself — so a value difference DOES reach the txId. `label` is
    // still what carries two structurally IDENTICAL bonds apart, which is the
    // common case at every call site below.
    const a = seedBond({ label: 'bond-a', inviterId, bondValue: 5n });
    const b = seedBond({ label: 'bond-b', inviterId, bondValue: 99n });

    expect(a.bond.txId).not.toBe(b.bond.txId);
    expect(a.bond.id).not.toBe(b.bond.id);
  });

  it('two IDENTICAL bonds are separated by the label alone', () => {
    // The property the previous case cannot show: same inviter, same invitee,
    // same value, same height — only the label differs, and it has to be enough.
    const a = seedBond({ label: 'same-a', inviterId });
    const b = seedBond({ label: 'same-b', inviterId });

    expect(a.bond.txId).not.toBe(b.bond.txId);
    expect(a.bond.id).not.toBe(b.bond.id);
  });

  it('every box it returns satisfies id integrity', () => {
    const { bond } = seedBond({ label: 'integrity', inviterId });
    expect(computeBoxId(bond)).toBe(bond.id);
  });

  it('is deterministic — the same label reproduces the same ids', () => {
    // Not a counter: ids must not depend on how many fixtures a test happened
    // to build first, or golden vectors move with file ordering.
    const a = seedBond({ label: 'stable', inviterId });
    const b = seedBond({ label: 'stable', inviterId });
    expect(a.bond.id).toBe(b.bond.id);
  });
});

/**
 * `openAvlDb` and the fresh-database branch of `initDb` both execute
 * `AVL_SCHEMA` (NODE_INTERFACE → AVL+ State Root → "AVL storage shares nodes
 * across versions; a row is a node's lifetime") — one exported text, not a
 * copy on each side. A future edit that hands the fresh-database path a
 * different string fails this pin.
 */
describe('openAvlDb — one schema source with the fresh-database path', () => {
  it('the tables and indexes it creates match initDb(\':memory:\')', () => {
    const fixtureDb = openAvlDb();
    const fixtureRows = avlSchemaRows(fixtureDb);
    fixtureDb.close();

    initDb(':memory:');
    const liveRows = avlSchemaRows(getDb());
    closeDb();

    expect(fixtureRows).toEqual(liveRows);
  });
});
