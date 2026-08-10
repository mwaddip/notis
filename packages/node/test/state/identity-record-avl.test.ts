import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  serializeBox,
  deserializeBox,
  serializeIdentityRecord,
  deserializeIdentityRecord,
  deserializeAvlValue,
  IDENTITY_RECORD_TAG,
} from '../../src/state/serialize-box.js';
import {
  createAvlProver,
  applyBlockMutations,
  type RecordPut,
} from '../../src/state/avl-prover.js';
import type { KarmaBox, AnyBox } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import { fixtureProvenance } from '../helpers.js';

/**
 * Spec G phase B3 — identity records as the AVL tree's second entity kind.
 */

function makeAvlDb(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
  return database;
}

function makeKarmaBox(id: string, value = 10n): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value,
    owner: new Uint8Array(randomBytes(32)),
    guard: 'owner_signature' as const,
    proofSource: 'tx-1',
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, 1, hashSeed(id)) };
}

const REC: IdentityRecord = { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 0n };

describe('identity records in the AVL tree (Spec G phase B3)', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => { db = makeAvlDb(); db2 = makeAvlDb(); });
  afterEach(() => { db.close(); db2.close(); });

  // --- serialization: both kinds round-trip, neither decodes as the other ---

  it('an identity record round-trips', () => {
    const bytes = serializeIdentityRecord(REC);
    expect(deserializeIdentityRecord(bytes)).toEqual(REC);
  });

  it('a box still round-trips unchanged', () => {
    const box = makeKarmaBox('aa'.repeat(32));
    const restored = deserializeBox(serializeBox(box));
    expect(restored.boxType).toBe('karma');
    expect((restored as KarmaBox).value).toBe(10n);
  });

  it('NO box type is shadowed by the record tag', () => {
    // Every box type, not just karma: a record tag chosen inside the 0x01-0x07
    // range would make one real box type decode as a record (deserializeAvlValue
    // tests the record tag first) and make deserializeBox reject it outright.
    // Asserting only the tag literal would leave that consequence untested.
    const owner = new Uint8Array(randomBytes(32));
    // `withProvenance` mirrors `makeKarmaBox` above: a caller-chosen id (the AVL
    // key, controlled so the tag-collision assertions below are readable) plus
    // real `txId`/`index`, which ride the AVL *value* and so must be present for
    // the serialized leaf to be a shape production could produce.
    const withProvenance = <B extends AnyBox>(id: string, c: object): B =>
      ({ id, ...c, ...fixtureProvenance(c, 1, hashSeed(id)) }) as B;

    const boxes: AnyBox[] = [
      makeKarmaBox('01'.repeat(32)),
      withProvenance('02'.repeat(32), { boxType: 'credit', value: 5n,
        owner, guard: 'owner_signature', proofSource: 1 }),
      // 0x03 was 'like' — retired (P2-D), tag byte reserved.
      withProvenance('04'.repeat(32), { boxType: 'invite', value: 50n,
        secretHash: new Uint8Array(randomBytes(32)), inviterId: owner,
        guard: 'hash_preimage_with_bond' }),
      withProvenance('05'.repeat(32), { boxType: 'bond', value: 10n,
        inviterId: owner, inviteOutputIndex: 0, inviteePublicKey: new Uint8Array(0),
        probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual' }),
      withProvenance('06'.repeat(32), { boxType: 'post_lock', value: 5n,
        // `b32` in the id preimage — `'p1'` has no encoding.
        originalValue: 5n, owner, targetPostId: '66'.repeat(32), guard: 'block_apply' }),
      withProvenance('07'.repeat(32), { boxType: 'vouch', value: 1n,
        voucherId: owner, targetId: owner, guard: 'owner_signature' }),
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
    const bytes = serializeIdentityRecord(REC);
    const val = deserializeAvlValue(bytes);
    expect(val.kind).toBe('record');
    // And the record's tag byte is not one any box can emit.
    const boxTags = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    expect(boxTags.has(bytes[0]!)).toBe(false);
  });

  it('the record tag is outside the box-type range, with the high bit set', () => {
    expect(IDENTITY_RECORD_TAG).toBe(0x80);
    // "box" vs "not a box" is a single bit test, and 0x01-0x07 stays open.
    expect(IDENTITY_RECORD_TAG & 0x80).toBe(0x80);
    expect(IDENTITY_RECORD_TAG).toBeGreaterThan(0x07);
    expect(serializeIdentityRecord(REC)[0]).toBe(IDENTITY_RECORD_TAG);
  });

  it('deserializeBox REJECTS a record rather than mis-decoding it', () => {
    const bytes = serializeIdentityRecord(REC);
    expect(() => deserializeBox(bytes)).toThrow(/identity record, not a box/i);
  });

  it('deserializeIdentityRecord rejects a box', () => {
    const bytes = serializeBox(makeKarmaBox('bb'.repeat(32)));
    expect(() => deserializeIdentityRecord(bytes)).toThrow(/not an identity record/i);
  });

  it('the kind-dispatching decoder handles either value', () => {
    const boxVal = deserializeAvlValue(serializeBox(makeKarmaBox('cc'.repeat(32))));
    expect(boxVal.kind).toBe('box');

    const recVal = deserializeAvlValue(serializeIdentityRecord(REC));
    expect(recVal.kind).toBe('record');
    if (recVal.kind === 'record') expect(recVal.record).toEqual(REC);
  });

  it('a record with a zero clock round-trips as zero', () => {
    const zero: IdentityRecord = { lastActivityBlock: 0, lastDecayBlock: 0, likeCarry: 0n };
    expect(deserializeIdentityRecord(serializeIdentityRecord(zero))).toEqual(zero);
  });

  it('record value bytes are a pure function of the record', () => {
    const a = serializeIdentityRecord({ lastActivityBlock: 3, lastDecayBlock: 4, likeCarry: 0n });
    const b = serializeIdentityRecord({ lastActivityBlock: 3, lastDecayBlock: 4, likeCarry: 0n });
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));

    const c = serializeIdentityRecord({ lastActivityBlock: 4, lastDecayBlock: 3, likeCarry: 0n });
    expect(Buffer.from(c).toString('hex')).not.toBe(Buffer.from(a).toString('hex'));
  });

  // --- the record must actually reach the digest --------------------------

  it('a record reaching the tree changes the digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const boxes = [makeKarmaBox('11'.repeat(32))];
    const puts: RecordPut[] = [{ key: 'ab'.repeat(32), record: REC }];

    const without = applyBlockMutations(p1, [], boxes);
    const with_ = applyBlockMutations(p2, [], boxes, puts);

    expect(Buffer.from(with_).toString('hex')).not.toBe(
      Buffer.from(without).toString('hex'),
    );
  });

  it('a different record value gives a different digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const d1 = applyBlockMutations(p1, [], [], [{ key: 'cd'.repeat(32), record: REC }]);
    const d2 = applyBlockMutations(p2, [], [], [
      { key: 'cd'.repeat(32), record: { lastActivityBlock: 43, lastDecayBlock: 7, likeCarry: 0n } },
    ]);

    expect(Buffer.from(d1).toString('hex')).not.toBe(Buffer.from(d2).toString('hex'));
  });

  it('a record put is InsertOrUpdate: writing the same key twice succeeds', () => {
    const { prover } = createAvlProver(db);
    const key = 'ef'.repeat(32);

    // First block creates it, second updates it — no existence lookup needed.
    applyBlockMutations(prover, [], [], [{ key, record: REC }]);
    expect(() =>
      applyBlockMutations(prover, [], [], [
        { key, record: { lastActivityBlock: 99, lastDecayBlock: 7, likeCarry: 0n } },
      ]),
    ).not.toThrow();
  });

  it('updating a record moves the digest; rewriting the same value does not', () => {
    const { prover: p1 } = createAvlProver(db);
    const key = '55'.repeat(32);

    const afterCreate = Buffer.from(
      applyBlockMutations(p1, [], [], [{ key, record: REC }]),
    ).toString('hex');
    const afterSame = Buffer.from(
      applyBlockMutations(p1, [], [], [{ key, record: REC }]),
    ).toString('hex');
    expect(afterSame).toBe(afterCreate);

    const afterChange = Buffer.from(
      applyBlockMutations(p1, [], [], [
        { key, record: { lastActivityBlock: 100, lastDecayBlock: 7, likeCarry: 0n } },
      ]),
    ).toString('hex');
    expect(afterChange).not.toBe(afterCreate);
  });

  // --- canonical ordering extends to records ------------------------------

  it('feed ordering is input-order-independent for a mixed box+record set', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const boxes: AnyBox[] = ['cc', '22', '99', '44'].map((b) =>
      makeKarmaBox(b.repeat(32), 5n),
    );
    const puts: RecordPut[] = ['bb', '33', 'dd'].map((k) => ({
      key: k.repeat(32),
      record: { lastActivityBlock: 1, lastDecayBlock: 0, likeCarry: 0n },
    }));

    const d1 = applyBlockMutations(p1, [], boxes, puts);
    const d2 = applyBlockMutations(p2, [], [...boxes].reverse(), [...puts].reverse());

    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('record ordering is independent of the box ordering it arrives with', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const boxes: AnyBox[] = ['77', '10'].map((b) => makeKarmaBox(b.repeat(32), 5n));
    const puts: RecordPut[] = ['fe', '01', '8a'].map((k) => ({
      key: k.repeat(32),
      record: { lastActivityBlock: 9, lastDecayBlock: 2, likeCarry: 0n },
    }));

    const d1 = applyBlockMutations(p1, [], boxes, puts);
    const d2 = applyBlockMutations(p2, [], [...boxes].reverse(), [
      puts[2]!, puts[0]!, puts[1]!,
    ]);

    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('removes, inserts and record puts coexist in one block', () => {
    const { prover } = createAvlProver(db);
    const pre = makeKarmaBox('12'.repeat(32), 100n);
    applyBlockMutations(prover, [], [pre]);

    const digest = applyBlockMutations(
      prover,
      ['12'.repeat(32)],
      [makeKarmaBox('34'.repeat(32), 90n)],
      [{ key: '9a'.repeat(32), record: REC }],
    );
    expect(digest.length).toBe(33);
  });

  it('an empty recordPuts array leaves the digest exactly as before', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);
    const boxes = [makeKarmaBox('ee'.repeat(32))];

    // Pins that the new parameter is inert when unused — every pre-B3 caller
    // keeps its digest.
    const d1 = applyBlockMutations(p1, [], boxes);
    const d2 = applyBlockMutations(p2, [], boxes, []);
    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// P2-D N2a — `likeCarry` in the record's AVL value encoding.
// ---------------------------------------------------------------------------

describe('likeCarry in the record encoding (P2-D N2a)', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => { db = makeAvlDb(); db2 = makeAvlDb(); });
  afterEach(() => { db.close(); db2.close(); });

  it('a non-zero likeCarry round-trips as bigint', () => {
    const rec: IdentityRecord = { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 3n };
    const back = deserializeIdentityRecord(serializeIdentityRecord(rec));
    expect(back).toEqual(rec);
    expect(typeof back.likeCarry).toBe('bigint');
  });

  it('a zero likeCarry round-trips as 0n, not dropped and not a number', () => {
    const back = deserializeIdentityRecord(serializeIdentityRecord(REC));
    expect(back.likeCarry).toBe(0n);
    expect(typeof back.likeCarry).toBe('bigint');
  });

  // Golden bytes for NODE_INTERFACE → Layout — IdentityRecord, byte by byte:
  //
  //   80   u8 tag — field 1 of the layout, not a wrapper around it
  //   2a   vlqU(lastActivityBlock = 42)
  //   07   vlqU(lastDecayBlock = 7)
  //   00   vlqU64(likeCarry = 0n)      ← present at zero, never omitted
  //
  // Derived from the layout table by hand BEFORE running the encoder, then
  // found to match it. That ordering is the point: a golden captured from the
  // implementation only proves the implementation equals itself, whereas these
  // two derivations agreeing is evidence about the format. The heights differ
  // (42 vs 7) so a transposition of the two adjacent `vlqU` fields is visible;
  // equal values would have hidden it.
  const GOLDEN_ZERO = '802a0700';
  const GOLDEN_THREE = '802a0703';
  /** The pre-P2-D shape — same layout, `likeCarry` absent. */
  const GOLDEN_PRE_P2D = '802a07';

  it('golden bytes: {42, 7, likeCarry: 0n} — the field is present at zero', () => {
    expect(Buffer.from(serializeIdentityRecord(REC)).toString('hex')).toBe(GOLDEN_ZERO);
  });

  it('golden bytes: {42, 7, likeCarry: 3n} — one value byte apart from the zero case', () => {
    const bytes = serializeIdentityRecord({ lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 3n });
    expect(Buffer.from(bytes).toString('hex')).toBe(GOLDEN_THREE);
  });

  // ⚠ The cbor-era version of this test asserted that zero and non-zero carry
  // encode to the SAME LENGTH, on the reasoning that "the map header counts 3
  // keys either way". Under `vlqU64` that reasoning is dead and the equal
  // length is a COINCIDENCE of two small values — cbor-x wrote a fixed-width
  // 8-byte integer, VLQ writes as many bytes as the magnitude needs. Re-pinning
  // it verbatim would have preserved an assertion whose stated justification is
  // false, so it is replaced by the property that is actually true, and the
  // variable width is made explicit rather than left to be discovered.
  it('likeCarry is variable-width under vlqU64 — equal length below 128 is not a rule', () => {
    const len = (carry: bigint): number =>
      serializeIdentityRecord({ lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: carry }).length;

    expect(len(0n)).toBe(len(3n));      // both single-byte VLQ — a coincidence, not structure
    expect(len(127n)).toBe(len(0n));    // last single-byte value
    expect(len(128n)).toBe(len(0n) + 1); // first two-byte value: the width moves
  });

  it('the encoding grew by exactly the always-present field vs the pre-P2-D shape', () => {
    // The layout is otherwise identical, so the difference is `vlqU64(0n)`:
    // one byte, on every record, zero included.
    expect(serializeIdentityRecord(REC).length).toBe(GOLDEN_PRE_P2D.length / 2 + 1);
  });

  it('bytes missing likeCarry are REJECTED, not defaulted to 0n', () => {
    // A pre-P2-D record value must fail loudly: a silent 0n default would mask
    // exactly the fork the always-present rule exists to prevent. Under the
    // positional layout the reader simply runs out of input — the field is not
    // optional, so there is nothing to be absent.
    const preP2D = Buffer.from(GOLDEN_PRE_P2D, 'hex');
    expect(() => deserializeIdentityRecord(preP2D)).toThrow();
  });

  it('trailing bytes and non-minimal VLQ are both rejected (boundary check 2 and 3)', () => {
    // `decodeStruct` gives the record the same four-part check the box arm
    // gets, and these two arms had NO cbor-era equivalent. Without step 3 two
    // distinct byte strings decode to one record — two AVL values for one
    // state, which is a fork with no producer disagreement behind it.
    expect(() => deserializeIdentityRecord(Buffer.from(GOLDEN_ZERO + 'ff', 'hex'))).toThrow();
    // `80 2a 07 8000` — likeCarry 0 written in two bytes instead of one.
    expect(() => deserializeIdentityRecord(Buffer.from('802a078000', 'hex'))).toThrow();
  });

  it('two provers fed the same record put agree on the digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);
    const put: RecordPut = {
      key: 'a1'.repeat(32),
      record: { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 2n },
    };

    const d1 = applyBlockMutations(p1, [], [], [put]);
    const d2 = applyBlockMutations(p2, [], [], [put]);
    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('a record updated likeCarry 0n → 3n changes the digest', () => {
    const { prover } = createAvlProver(db);
    const key = 'b2'.repeat(32);

    const at0 = Buffer.from(
      applyBlockMutations(prover, [], [], [
        { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 0n } },
      ]),
    ).toString('hex');
    const at3 = Buffer.from(
      applyBlockMutations(prover, [], [], [
        { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 3n } },
      ]),
    ).toString('hex');

    expect(at3).not.toBe(at0);
  });

  it('records differing ONLY in likeCarry give different digests across provers', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);
    const key = 'c3'.repeat(32);

    const d1 = applyBlockMutations(p1, [], [], [
      { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 0n } },
    ]);
    const d2 = applyBlockMutations(p2, [], [], [
      { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, likeCarry: 3n } },
    ]);
    expect(Buffer.from(d1).toString('hex')).not.toBe(Buffer.from(d2).toString('hex'));
  });
});

/** Stable small integer from a fixture id, so distinct boxes get distinct provenance. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 1_000_000;
}
