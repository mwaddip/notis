import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createAvlProver,
  applyBlockMutations,
  bootstrapAvlProver,
  type RecordPut,
} from '../../src/state/avl-prover.js';
import { DivergedStateTreeError } from '../../src/services/corrupt-state.js';
import { fixtureProvenance } from '../helpers.js';
import type { AnyBox } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';

/**
 * The tree is asked, and a refusal is raised (NODE_INTERFACE → AVL+ State Root).
 *
 * ⛔ **The assertion is the THROW, never a root.** A single-node root comparison
 * cannot reach any of this: the producer and the verifier are one process, so a
 * seeded divergence makes both compute the same wrong digest and the comparison
 * matches. A test that seeded a divergence and compared roots would pass for the
 * wrong reason, which is why every case here asserts the class and the key it
 * names instead.
 *
 * Every rule below had **no incidental coverage** before it was written — the
 * suite's existing removes all name keys inserted earlier into the same prover,
 * so no fixture ever handed the tree an operation it could refuse.
 */

const REC: IdentityRecord = {
  lastActivityBlock: 42,
  lastDecayBlock: 7,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

/** A karma box with a chosen id — provenance filled the way a real one carries it. */
function makeKarmaBox(id: string, value = 100n, height = 1): AnyBox & { id: string } {
  const candidate = {
    boxType: 'karma' as const,
    value,
    createdAtBlock: height,
    owner: new Uint8Array(32).fill(0x77),
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, height) };
}

describe('a refused AVL+ operation raises DivergedStateTreeError', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY,
        height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE avl_tree_nodes (
        label BLOB NOT NULL,
        node_data BLOB NOT NULL,
        first_seen_height INTEGER NOT NULL,
        orphaned_at_height INTEGER,
        PRIMARY KEY (label, first_seen_height)
      );
    `);
  });

  afterEach(() => { db.close(); });

  // -------------------------------------------------------------------------
  // applyBlockMutations — the two arms
  // -------------------------------------------------------------------------

  it('throws when `consumed` names a key the tree never held — the whole unit', () => {
    const { prover } = createAvlProver(db);
    const absent = 'ab'.repeat(32);

    // The tree holds one box, and the block spends a different one.
    applyBlockMutations(prover, 1, [], [makeKarmaBox('11'.repeat(32))]);

    let caught: unknown;
    try {
      applyBlockMutations(prover, 2, [absent], []);
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(DivergedStateTreeError);
    const err = caught as DivergedStateTreeError;
    // The key is the only thing that says *which* box the two stores disagree
    // about, so it has to survive into the message an operator reads.
    expect(err.message).toContain(absent);
    expect(err.op).toBe('Remove');
    expect(err.key).toBe(absent);
    expect(err.height).toBe(2);
    expect(err.site).toBe('applyBlockMutations');
  });

  it('throws when `created` carries a box id the tree already holds', () => {
    const { prover } = createAvlProver(db);
    const id = 'cd'.repeat(32);
    applyBlockMutations(prover, 1, [], [makeKarmaBox(id)]);

    let caught: unknown;
    try {
      applyBlockMutations(prover, 2, [], [makeKarmaBox(id, 50n, 2)]);
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(DivergedStateTreeError);
    expect((caught as DivergedStateTreeError).op).toBe('Insert');
    expect((caught as DivergedStateTreeError).message).toContain(id);
  });

  // -------------------------------------------------------------------------
  // The short-circuit
  // -------------------------------------------------------------------------

  it('stops at the FIRST refusal — the tree is never asked for the second', () => {
    const { prover } = createAvlProver(db);
    applyBlockMutations(prover, 1, [], [makeKarmaBox('11'.repeat(32))]);
    const before = Buffer.from(prover.digest()!).toString('hex');

    // Two removes, both absent. The feed is sorted, so `22…` is asked first and
    // `99…` is never reached.
    expect(() =>
      applyBlockMutations(prover, 2, ['99'.repeat(32), '22'.repeat(32)], []),
    ).toThrow(DivergedStateTreeError);

    // The digest is asserted rather than the call count: what matters is that
    // the tree did not move, not how the loop was written.
    expect(Buffer.from(prover.digest()!).toString('hex')).toBe(before);
  });

  it('names the first key in canonical order, not the caller order', () => {
    const { prover } = createAvlProver(db);
    let caught: unknown;
    try {
      applyBlockMutations(prover, 1, ['99'.repeat(32), '22'.repeat(32)], []);
    } catch (err) { caught = err; }
    expect((caught as DivergedStateTreeError).key).toBe('22'.repeat(32));
  });

  // -------------------------------------------------------------------------
  // bootstrapAvlProver — both feeds
  // -------------------------------------------------------------------------

  it('bootstrapAvlProver throws on a duplicate box id', () => {
    const handle = createAvlProver(db);
    const id = 'ef'.repeat(32);

    let caught: unknown;
    try {
      bootstrapAvlProver(handle, [makeKarmaBox(id), makeKarmaBox(id, 50n, 2)], 0, []);
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(DivergedStateTreeError);
    const err = caught as DivergedStateTreeError;
    expect(err.site).toBe('bootstrapAvlProver');
    expect(err.op).toBe('Insert');
    expect(err.key).toBe(id);
  });

  it('bootstrapAvlProver throws on a duplicate record key', () => {
    const handle = createAvlProver(db);
    const key = '5a'.repeat(32);
    const puts: RecordPut[] = [{ key, record: REC }, { key, record: REC }];

    let caught: unknown;
    try {
      bootstrapAvlProver(handle, [], 0, puts);
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(DivergedStateTreeError);
    expect((caught as DivergedStateTreeError).key).toBe(key);
    expect((caught as DivergedStateTreeError).site).toBe('bootstrapAvlProver');
  });

  // -------------------------------------------------------------------------
  // The one result that stays discarded
  // -------------------------------------------------------------------------

  it('a repeated record put does NOT throw — InsertOrUpdate is total', () => {
    const { prover } = createAvlProver(db);
    const key = '7b'.repeat(32);

    // The counterpart to the two bootstrap cases: the same repetition that is a
    // refusal on `Insert` is a legal overwrite here, which is why the record-put
    // loop's result carries no verdict to read.
    applyBlockMutations(prover, 1, [], [], [{ key, record: REC }]);
    expect(() =>
      applyBlockMutations(prover, 2, [], [], [
        { key, record: { ...REC, lastActivityBlock: 99 } },
      ]),
    ).not.toThrow();
  });
});
