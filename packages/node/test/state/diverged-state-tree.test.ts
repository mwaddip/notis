import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  boxKey,
  boxRecordBytes,
  bytesToHex,
  hexToBytes,
  identityKey,
  identityRecordBytes,
  networkKey,
  networkRecordBytes,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord, KarmaBox } from '@dagsocial/types';
import type { TreeWrite } from '@dagsocial/consensus';
import {
  createAvlProver,
  bootstrapAvlProver,
  performTreeWrites,
} from '../../src/state/avl-prover.js';
import { DivergedStateTreeError } from '../../src/services/corrupt-state.js';
import { openAvlDb, seedProvenance, uid } from '../helpers.js';

/**
 * The tree is asked, and a refusal is raised (NODE_INTERFACE → AVL+ State Root).
 *
 * ⛔ **The assertion is the THROW, never a root.** A single-node root comparison
 * cannot reach any of this: the producer and the verifier are one process, so a
 * seeded divergence makes both compute the same wrong digest and the comparison
 * matches. A test that seeded a divergence and compared roots would pass for the
 * wrong reason, which is why every case here asserts the class and the key it
 * names instead.
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

const owner = uid('diverged-state-tree/owner');

function karma(nonce: number, value = 100n): KarmaBox & { id: string } {
  return seedProvenance<KarmaBox>({ boxType: 'karma', value, createdAtBlock: 1, owner }, 1, nonce);
}

const keyOf = (box: AnyBox): Uint8Array => boxKey(hexToBytes(box.id!));
const insertOf = (box: AnyBox): TreeWrite =>
  ({ tag: 'Insert', key: keyOf(box), value: boxRecordBytes(box, box.txId, box.index) });

function refusal(run: () => unknown): DivergedStateTreeError {
  let caught: unknown;
  try { run(); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(DivergedStateTreeError);
  return caught as DivergedStateTreeError;
}

describe('a refused AVL+ operation raises DivergedStateTreeError', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openAvlDb();
  });

  afterEach(() => { db.close(); });

  // -------------------------------------------------------------------------
  // performTreeWrites — the three refusals
  // -------------------------------------------------------------------------

  it('throws when a Remove names a key the tree never held — the whole unit', () => {
    const { prover } = createAvlProver(db);
    const absent = karma(9);

    // The tree holds one box, and the block spends a different one.
    performTreeWrites(prover, 1, [insertOf(karma(1))], 'test');

    const err = refusal(() => performTreeWrites(prover, 2, [{ tag: 'Remove', key: keyOf(absent) }], 'applyOrderingBlock'));
    // The key is the only thing that says *which* entry the tree lacks, so it
    // has to survive into the message an operator reads — and its kind with it.
    const hex = bytesToHex(keyOf(absent));
    expect(err.message).toContain(hex);
    expect(err.message).toContain('the box key');
    expect(err.op).toBe('Remove');
    expect(err.key).toBe(hex);
    expect(err.height).toBe(2);
    expect(err.site).toBe('applyOrderingBlock');
  });

  it('throws when an Insert carries a key the tree already holds', () => {
    const { prover } = createAvlProver(db);
    const box = karma(1);
    performTreeWrites(prover, 1, [insertOf(box)], 'test');

    const err = refusal(() => performTreeWrites(prover, 2, [insertOf(box)], 'test'));
    expect(err.op).toBe('Insert');
    expect(err.message).toContain(bytesToHex(keyOf(box)));
  });

  it('throws when an Update names a key the tree lacks, naming the kind by its tag and never a box', () => {
    const { prover } = createAvlProver(db);

    const err = refusal(() =>
      performTreeWrites(prover, 3, [{ tag: 'Update', key: networkKey(), value: networkRecordBytes({ memberCount: 1 }) }], 'test'));
    expect(err.op).toBe('Update');
    expect(err.key).toBe(bytesToHex(networkKey()));
    expect(err.message).toContain('the network key');
    expect(err.message).not.toMatch(/\bbox\b/);
  });

  // -------------------------------------------------------------------------
  // The short-circuit
  // -------------------------------------------------------------------------

  it('stops at the FIRST refusal — the tree is never asked for the second', () => {
    const { prover } = createAvlProver(db);
    performTreeWrites(prover, 1, [insertOf(karma(1))], 'test');
    const before = bytesToHex(prover.digest());

    // Two removes, both absent: the first refusal ends the writes.
    expect(() =>
      performTreeWrites(prover, 2, [{ tag: 'Remove', key: keyOf(karma(8)) }, { tag: 'Remove', key: keyOf(karma(9)) }], 'test'),
    ).toThrow(DivergedStateTreeError);

    // The digest is asserted rather than the call count: what matters is that
    // the tree did not move, not how the loop was written.
    expect(bytesToHex(prover.digest())).toBe(before);
  });

  it('names the first write refused, in the order the writes are handed', () => {
    const { prover } = createAvlProver(db);
    const [second, first] = [karma(8), karma(9)];
    const err = refusal(() =>
      performTreeWrites(prover, 1, [{ tag: 'Remove', key: keyOf(first) }, { tag: 'Remove', key: keyOf(second) }], 'test'));
    expect(err.key).toBe(bytesToHex(keyOf(first)));
  });

  // -------------------------------------------------------------------------
  // bootstrapAvlProver
  // -------------------------------------------------------------------------

  it('bootstrapAvlProver throws on a key the tree already holds', () => {
    const handle = createAvlProver(db);
    const box = karma(1);
    bootstrapAvlProver(handle, [box], 0, [], { memberCount: 0 });

    const err = refusal(() => bootstrapAvlProver(handle, [box], 0, [], { memberCount: 0 }));
    expect(err.site).toBe('bootstrapAvlProver');
    expect(err.op).toBe('Insert');
    expect(err.key).toBe(bytesToHex(keyOf(box)));
  });

  it('bootstrapAvlProver refuses a seed that writes one key twice, before the tree moves', () => {
    const handle = createAvlProver(db);
    const before = bytesToHex(handle.prover.digest());
    const identityId = uid('diverged-state-tree/record');

    expect(() => bootstrapAvlProver(handle, [], 0, [
      { identityId, record: REC },
      { identityId: Uint8Array.from(identityId), record: REC },
    ], { memberCount: 1 })).toThrow(/two writes/);
    expect(bytesToHex(handle.prover.digest())).toBe(before);
  });

  // -------------------------------------------------------------------------
  // The one write with no refusal
  // -------------------------------------------------------------------------

  it('a repeated record put does NOT throw — InsertOrUpdate is total', () => {
    const { prover } = createAvlProver(db);
    const key = identityKey(uid('diverged-state-tree/record'));

    // The same repetition that is a refusal on `Insert` is a legal overwrite
    // here, which is why an `InsertOrUpdate` is never refused.
    performTreeWrites(prover, 1, [{ tag: 'InsertOrUpdate', key, value: identityRecordBytes(REC) }], 'test');
    expect(() =>
      performTreeWrites(prover, 2, [
        { tag: 'InsertOrUpdate', key, value: identityRecordBytes({ ...REC, lastActivityBlock: 99 }) },
      ], 'test'),
    ).not.toThrow();
  });
});
