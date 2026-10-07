import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  createAvlProver,
  performTreeWrites,
} from '../../src/state/avl-prover.js';
import type { AvlProver } from '../../src/state/avl-prover.js';
import { boxKey, boxRecordBytes, hexToBytes, identityKey, identityRecordBytes } from '@dagsocial/types';
import type { IdentityRecord, KarmaBox, AnyBox } from '@dagsocial/types';
import type { TreeWrite } from '@dagsocial/consensus';
import { fixtureProvenance, openAvlDb, uid } from '../helpers.js';

/**
 * Identity records as the AVL tree's second entity kind — NODE_INTERFACE →
 * Entity kinds and Layout — IdentityRecord.
 */

function makeKarmaBox(id: string, value = 10n): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value,
    createdAtBlock: 0,
    owner: new Uint8Array(randomBytes(32)),
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, 1, hashSeed(id)) };
}

const REC: IdentityRecord = { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 };

/** A record write as a block's writes carry it — an `InsertOrUpdate` under `identity ‖ id`. */
const put = (label: string, record: IdentityRecord): TreeWrite =>
  ({ tag: 'InsertOrUpdate', key: identityKey(uid(`identity-record-avl/${label}`)), value: identityRecordBytes(record) });
const insertOf = (box: AnyBox): TreeWrite =>
  ({ tag: 'Insert', key: boxKey(hexToBytes(box.id!)), value: boxRecordBytes(box, box.txId, box.index) });
const hexOf = (d: Uint8Array): string => Buffer.from(d).toString('hex');
const perform = (prover: AvlProver, writes: TreeWrite[]): string =>
  hexOf(performTreeWrites(prover, 1, writes, 'test'));

describe('identity records in the AVL tree (Spec G phase B3)', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => { db = openAvlDb(); db2 = openAvlDb(); });
  afterEach(() => { db.close(); db2.close(); });

  // The codecs are `@dagsocial/types`' (TYPES_INTERFACE → Layout — tree
  // records). The cases below prove that a record reaches the tree and moves
  // its digest — the integration surface node owns.

  // --- the record must actually reach the digest --------------------------

  it('a record reaching the tree changes the digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);
    const box = makeKarmaBox('11'.repeat(32));

    const without = perform(p1, [insertOf(box)]);
    const with_ = perform(p2, [insertOf(box), put('ab', REC)]);

    expect(with_).not.toBe(without);
  });

  it('a different record value gives a different digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const d1 = perform(p1, [put('cd', REC)]);
    const d2 = perform(p2, [put('cd', { ...REC, lastActivityBlock: 43 })]);

    expect(d1).not.toBe(d2);
  });

  it('a record put is InsertOrUpdate: writing the same key twice succeeds', () => {
    const { prover } = createAvlProver(db);

    // First block creates it, second updates it — no existence lookup needed.
    perform(prover, [put('ef', REC)]);
    expect(() => perform(prover, [put('ef', { ...REC, lastActivityBlock: 99 })])).not.toThrow();
  });

  it('updating a record moves the digest; rewriting the same value does not', () => {
    const { prover: p1 } = createAvlProver(db);

    const afterCreate = perform(p1, [put('55', REC)]);
    const afterSame = perform(p1, [put('55', REC)]);
    expect(afterSame).toBe(afterCreate);

    const afterChange = perform(p1, [put('55', { ...REC, lastActivityBlock: 100 })]);
    expect(afterChange).not.toBe(afterCreate);
  });

  it('removes, inserts and record puts coexist in one block', () => {
    const { prover } = createAvlProver(db);
    const pre = makeKarmaBox('12'.repeat(32), 100n);
    perform(prover, [insertOf(pre)]);

    const digest = performTreeWrites(prover, 2, [
      { tag: 'Remove', key: boxKey(hexToBytes(pre.id!)) },
      insertOf(makeKarmaBox('34'.repeat(32), 90n)),
      put('9a', REC),
    ], 'test');
    expect(digest.length).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// Record puts reaching the digest — the AVL-level side of TYPES_INTERFACE →
// Layout — IdentityRecord. The codec, its goldens and its refusals live in
// `@dagsocial/types`' `identity-record.test.ts`.
// ---------------------------------------------------------------------------

describe('record puts reaching the digest', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => { db = openAvlDb(); db2 = openAvlDb(); });
  afterEach(() => { db.close(); db2.close(); });

  const withLikes = (lifetimeLikesReceived: bigint): IdentityRecord => ({ ...REC, lifetimeLikesReceived });

  it('two provers fed the same record put agree on the digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    expect(perform(p1, [put('a1', withLikes(2n))])).toBe(perform(p2, [put('a1', withLikes(2n))]));
  });

  it('a record updated lifetimeLikesReceived 0n → 3n changes the digest', () => {
    const { prover } = createAvlProver(db);

    const at0 = perform(prover, [put('b2', withLikes(0n))]);
    const at3 = perform(prover, [put('b2', withLikes(3n))]);

    expect(at3).not.toBe(at0);
  });

  it('records differing ONLY in the like counter give different digests across provers', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    expect(perform(p1, [put('c3', withLikes(0n))])).not.toBe(perform(p2, [put('c3', withLikes(3n))]));
  });
});

/** Stable small integer from a fixture id, so distinct boxes get distinct provenance. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1_000_000;
}
