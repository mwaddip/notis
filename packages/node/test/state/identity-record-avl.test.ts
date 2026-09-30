import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  serializeBox,
  deserializeBox,
  deserializeAvlValue,
  serializeNetworkRecord,
  NETWORK_RECORD_TAG,
} from '../../src/state/serialize-box.js';
import {
  createAvlProver,
  performTreeWrites,
} from '../../src/state/avl-prover.js';
import type { PersistentBatchAVLProver } from '@ergots/avltree';
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
const perform = (prover: PersistentBatchAVLProver, writes: TreeWrite[]): string =>
  hexOf(performTreeWrites(prover, 1, writes, 'test'));

describe('identity records in the AVL tree (Spec G phase B3)', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => { db = openAvlDb(); db2 = openAvlDb(); });
  afterEach(() => { db.close(); db2.close(); });

  // Round-trip and codec-refusal cases live in `@dagsocial/types`'
  // `identity-record.test.ts`. The cases below prove that a record REACHES the
  // AVL tree and dispatches correctly against every box type — the
  // integration surface node owns.

  it('a box still round-trips unchanged', () => {
    const box = makeKarmaBox('aa'.repeat(32));
    const restored = deserializeBox(serializeBox(box));
    expect(restored.boxType).toBe('karma');
    expect((restored as KarmaBox).value).toBe(10n);
  });

  it('NO box type is shadowed by the record tag', () => {
    // Every box type, not just karma: a record tag chosen inside the assigned
    // range of `BOX_TYPE_TAGS` would make one real box type decode as a record
    // (deserializeAvlValue tests the record tag first) and make deserializeBox
    // reject it outright. Asserting only the tag literal would leave that
    // consequence untested.
    const owner = new Uint8Array(randomBytes(32));
    // `withProvenance` mirrors `makeKarmaBox` above: a caller-chosen id (the AVL
    // key, controlled so the tag-collision assertions below are readable) plus
    // real `txId`/`index`, which ride the AVL *value* and so must be present for
    // the serialized leaf to be a shape production could produce.
    const withProvenance = <B extends AnyBox>(id: string, c: object): B =>
      ({ id, ...c, ...fixtureProvenance(c, 1, hashSeed(id)) }) as B;

    const boxes: AnyBox[] = [
      makeKarmaBox('01'.repeat(32)),
      withProvenance('02'.repeat(32), { boxType: 'credit', value: 5n, createdAtBlock: 0,
        owner }),
      // ⚠ These fills are AVL **keys**, chosen so the assertions below read
      // in order — they are not box tags and do not track the tag table.
      // `genesis_proof` is the type with no row: it carries an `lp` payload no
      // fixture here needs, and its tag is covered by the two ownerless rows
      // at the end.
      withProvenance('05'.repeat(32), { boxType: 'bond', value: 10n, createdAtBlock: 0,
        inviterId: owner, inviteePublicKey: new Uint8Array(randomBytes(32)) }),
      withProvenance('06'.repeat(32), { boxType: 'karma_price', value: 5n, createdAtBlock: 0 }),
      withProvenance('07'.repeat(32), { boxType: 'vouch', value: 1n, createdAtBlock: 0,
        voucherId: owner, targetId: owner }),
      // The two ownerless block-application boxes. Their serialized leaf is the
      // shared prefix alone — `enum8(boxType) ‖ vlqU64(value)` and nothing else
      // (TYPES_INTERFACE → EmissionBox / TreasuryBox) — which makes them the
      // shortest values the tree ever holds and so the sharpest case for a tag
      // that must not be mistaken for a record.
      withProvenance('08'.repeat(32), { boxType: 'emission', value: 4226400000000n,  createdAtBlock: 0,}),
      withProvenance('09'.repeat(32), { boxType: 'treasury', value: 500n, createdAtBlock: 0 }),
      // The pool joins them: karma-bearing, ownerless, and the widest value the
      // tree holds (TYPES_INTERFACE → KarmaPoolBox).
      withProvenance('0a'.repeat(32), { boxType: 'karma_pool', value: 500n,  createdAtBlock: 0,}),
    ];

    for (const box of boxes) {
      const bytes = serializeBox(box);
      // Must not be mistaken for a record...
      const val = deserializeAvlValue(bytes);
      expect(val.kind).toBe('box');
      if (val.kind === 'box') expect(val.box.boxType).toBe(box.boxType);
      // ...and must still decode as a box.
      expect(deserializeBox(bytes).boxType).toBe(box.boxType);
    }
  });

  it('a record is not mistaken for any box type', () => {
    const bytes = identityRecordBytes(REC);
    const val = deserializeAvlValue(bytes);
    expect(val.kind).toBe('record');
  });

  it('deserializeBox REJECTS a record rather than mis-decoding it', () => {
    const bytes = identityRecordBytes(REC);
    expect(() => deserializeBox(bytes)).toThrow(/identity record, not a box/i);
  });

  it('the kind-dispatching decoder handles either value', () => {
    const boxVal = deserializeAvlValue(serializeBox(makeKarmaBox('cc'.repeat(32))));
    expect(boxVal.kind).toBe('box');

    const recVal = deserializeAvlValue(identityRecordBytes(REC));
    expect(recVal.kind).toBe('record');
    if (recVal.kind === 'record') expect(recVal.record).toEqual(REC);
  });

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

describe('network record — the third entity kind (§9)', () => {
  it('deserializeBox refuses 0x81 (the network record tag)', () => {
    const bytes = serializeNetworkRecord({ memberCount: 42 });
    expect(bytes[0]).toBe(NETWORK_RECORD_TAG);
    expect(() => deserializeBox(bytes)).toThrow('network record');
  });

  it('deserializeAvlValue on 0x81 returns kind: network', () => {
    const bytes = serializeNetworkRecord({ memberCount: 7 });
    const val = deserializeAvlValue(bytes);
    expect(val.kind).toBe('network');
    if (val.kind === 'network') {
      expect(val.network.memberCount).toBe(7);
    }
  });
});

/** Stable small integer from a fixture id, so distinct boxes get distinct provenance. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1_000_000;
}
