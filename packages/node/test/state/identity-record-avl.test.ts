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
import { BOX_TYPE_TAGS } from '@dagsocial/types';
import type { KarmaBox, AnyBox } from '@dagsocial/types';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import { fixtureProvenance } from '../helpers.js';

/**
 * Identity records as the AVL tree's second entity kind — NODE_INTERFACE →
 * "Two entity kinds" and Layout — IdentityRecord.
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
    createdAtBlock: 0,
    owner: new Uint8Array(randomBytes(32)),
  };
  return { id, ...candidate, ...fixtureProvenance(candidate, 1, hashSeed(id)) };
}

const REC: IdentityRecord = { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 };

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
    const bytes = serializeIdentityRecord(REC);
    const val = deserializeAvlValue(bytes);
    expect(val.kind).toBe('record');
    // And the record's tag byte is not one any box can emit. ⛔ **The set is
    // read from `BOX_TYPE_TAGS` rather than written down**: a hand-kept set
    // that understates the range still passes, because 0x80 is in neither, so
    // nothing here would fail when a tag is added.
    const boxTags = new Set<number>(Object.values(BOX_TYPE_TAGS));
    expect(boxTags.has(bytes[0]!)).toBe(false);
  });

  it('the record tag is outside the box-type range, with the high bit set', () => {
    expect(IDENTITY_RECORD_TAG).toBe(0x80);
    // "box" vs "not a box" is a single bit test, and the whole assigned range
    // below the high bit stays open to `BOX_TYPE_TAGS`.
    expect(IDENTITY_RECORD_TAG & 0x80).toBe(0x80);
    expect(IDENTITY_RECORD_TAG).toBeGreaterThan(Math.max(...Object.values(BOX_TYPE_TAGS)));
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
    const zero: IdentityRecord = { lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 };
    expect(deserializeIdentityRecord(serializeIdentityRecord(zero))).toEqual(zero);
  });

  it('record value bytes are a pure function of the record', () => {
    const a = serializeIdentityRecord({ lastActivityBlock: 3, lastDecayBlock: 4, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    const b = serializeIdentityRecord({ lastActivityBlock: 3, lastDecayBlock: 4, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));

    const c = serializeIdentityRecord({ lastActivityBlock: 4, lastDecayBlock: 3, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    expect(Buffer.from(c).toString('hex')).not.toBe(Buffer.from(a).toString('hex'));
  });

  // --- the record must actually reach the digest --------------------------

  it('a record reaching the tree changes the digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const boxes = [makeKarmaBox('11'.repeat(32))];
    const puts: RecordPut[] = [{ key: 'ab'.repeat(32), record: REC }];

    const without = applyBlockMutations(p1, 1, [], boxes);
    const with_ = applyBlockMutations(p2, 1, [], boxes, puts);

    expect(Buffer.from(with_).toString('hex')).not.toBe(
      Buffer.from(without).toString('hex'),
    );
  });

  it('a different record value gives a different digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const d1 = applyBlockMutations(p1, 1, [], [], [{ key: 'cd'.repeat(32), record: REC }]);
    const d2 = applyBlockMutations(p2, 1, [], [], [
      { key: 'cd'.repeat(32), record: { lastActivityBlock: 43, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
    ]);

    expect(Buffer.from(d1).toString('hex')).not.toBe(Buffer.from(d2).toString('hex'));
  });

  it('a record put is InsertOrUpdate: writing the same key twice succeeds', () => {
    const { prover } = createAvlProver(db);
    const key = 'ef'.repeat(32);

    // First block creates it, second updates it — no existence lookup needed.
    applyBlockMutations(prover, 1, [], [], [{ key, record: REC }]);
    expect(() =>
      applyBlockMutations(prover, 1, [], [], [
        { key, record: { lastActivityBlock: 99, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
      ]),
    ).not.toThrow();
  });

  it('updating a record moves the digest; rewriting the same value does not', () => {
    const { prover: p1 } = createAvlProver(db);
    const key = '55'.repeat(32);

    const afterCreate = Buffer.from(
      applyBlockMutations(p1, 1, [], [], [{ key, record: REC }]),
    ).toString('hex');
    const afterSame = Buffer.from(
      applyBlockMutations(p1, 1, [], [], [{ key, record: REC }]),
    ).toString('hex');
    expect(afterSame).toBe(afterCreate);

    const afterChange = Buffer.from(
      applyBlockMutations(p1, 1, [], [], [
        { key, record: { lastActivityBlock: 100, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
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
      record: { lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 },
    }));

    const d1 = applyBlockMutations(p1, 1, [], boxes, puts);
    const d2 = applyBlockMutations(p2, 1, [], [...boxes].reverse(), [...puts].reverse());

    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('record ordering is independent of the box ordering it arrives with', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);

    const boxes: AnyBox[] = ['77', '10'].map((b) => makeKarmaBox(b.repeat(32), 5n));
    const puts: RecordPut[] = ['fe', '01', '8a'].map((k) => ({
      key: k.repeat(32),
      record: { lastActivityBlock: 9, lastDecayBlock: 2, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 },
    }));

    const d1 = applyBlockMutations(p1, 1, [], boxes, puts);
    const d2 = applyBlockMutations(p2, 1, [], [...boxes].reverse(), [
      puts[2]!, puts[0]!, puts[1]!,
    ]);

    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('removes, inserts and record puts coexist in one block', () => {
    const { prover } = createAvlProver(db);
    const pre = makeKarmaBox('12'.repeat(32), 100n);
    applyBlockMutations(prover, 1, [], [pre]);

    const digest = applyBlockMutations(
      prover,
      1,
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

    // `recordPuts` is inert when empty: a caller that passes no records reaches
    // the same digest as one that omits the argument. Without this, adding a
    // record kind to the feed would silently move every box-only caller's root.
    const d1 = applyBlockMutations(p1, 1, [], boxes);
    const d2 = applyBlockMutations(p2, 1, [], boxes, []);
    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// The always-present fields in the record's AVL value encoding
// (NODE_INTERFACE → Layout — IdentityRecord).
//
// The record holds nine fields — four original (two heights, the claim height,
// the lifetime like counter) and five membership fields (memberSinceBlock,
// memberBar, memberVouches, memberLikes, invitesUsed). The AVL value encodes
// all nine after a `0x80` tag byte. The vectors below pin the positional
// layout byte by byte.
// ---------------------------------------------------------------------------

describe('the always-present fields in the record encoding', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => { db = makeAvlDb(); db2 = makeAvlDb(); });
  afterEach(() => { db.close(); db2.close(); });

  it('a non-zero like counter round-trips as bigint', () => {
    const rec: IdentityRecord = { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 3n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 };
    const back = deserializeIdentityRecord(serializeIdentityRecord(rec));
    expect(back).toEqual(rec);
    expect(typeof back.lifetimeLikesReceived).toBe('bigint');
  });

  it('a zero counter round-trips as 0n, not dropped and not a number', () => {
    const back = deserializeIdentityRecord(serializeIdentityRecord(REC));
    expect(back.lifetimeLikesReceived).toBe(0n);
    expect(typeof back.lifetimeLikesReceived).toBe('bigint');
  });

  // Golden bytes for NODE_INTERFACE → Layout — IdentityRecord, byte by byte:
  //
  //   80   u8 tag
  //   2a   vlqU(lastActivityBlock = 42)
  //   07   vlqU(lastDecayBlock = 7)
  //   00   vlqU(invitedAtBlock = 0)
  //   00   vlqU64(lifetimeLikesReceived = 0n)
  //   00   vlqU(memberSinceBlock = 0)
  //   00   vlqU(memberBar = 0)
  //   00   vlqU(memberVouches = 0)
  //   00   vlqU64(memberLikes = 0n)
  //   00   vlqU(invitesUsed = 0)
  const GOLDEN_ZERO = '802a0700000000000000';
  const GOLDEN_INVITED = '802a070b000000000000';
  const GOLDEN_LIKED = '802a070b070000000000';
  /** The same layout with a trailing field absent — a shape a reader must reject. */
  const GOLDEN_SHORT = '802a070b0000000000';

  it('golden bytes: every counter present at zero, none omitted', () => {
    expect(Buffer.from(serializeIdentityRecord(REC)).toString('hex')).toBe(GOLDEN_ZERO);
  });

  it('golden bytes: an invited identity differs in the fourth byte alone', () => {
    const bytes = serializeIdentityRecord({ lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 11, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 });
    expect(Buffer.from(bytes).toString('hex')).toBe(GOLDEN_INVITED);
    expect(GOLDEN_INVITED.slice(0, 6)).toBe(GOLDEN_ZERO.slice(0, 6));
    expect(GOLDEN_INVITED.slice(8)).toBe(GOLDEN_ZERO.slice(8));
    expect(GOLDEN_INVITED.slice(6, 8)).not.toBe(GOLDEN_ZERO.slice(6, 8));
  });

  // ⚠ `lifetimeLikesReceived` is `vlqU64`, so its width tracks its MAGNITUDE.
  // Two records whose counters encode to the same length say nothing about the
  // field — below 128 every value is one byte, and an assertion resting on that
  // reads as a structural rule while pinning a coincidence. The rows below make
  // the width change explicit instead of leaving it to be discovered by a fork.
  it('the like counter is variable-width under vlqU64 — equal length below 128 is not a rule', () => {
    const len = (likes: bigint): number =>
      serializeIdentityRecord({ lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: likes, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 }).length;

    expect(len(0n)).toBe(len(3n));      // both single-byte VLQ — a coincidence, not structure
    expect(len(127n)).toBe(len(0n));    // last single-byte value
    expect(len(128n)).toBe(len(0n) + 1); // first two-byte value: the width moves
  });

  it('golden bytes: the like counter differs in its byte alone', () => {
    const bytes = serializeIdentityRecord({
      lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 11, lifetimeLikesReceived: 7n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    expect(Buffer.from(bytes).toString('hex')).toBe(GOLDEN_LIKED);
    // The prefix through invitedAtBlock (4 bytes = 8 hex chars) is identical.
    expect(GOLDEN_LIKED.slice(0, 8)).toBe(GOLDEN_INVITED.slice(0, 8));
    // The suffix from memberSinceBlock onward (5 bytes = 10 hex chars) is identical.
    expect(GOLDEN_LIKED.slice(10)).toBe(GOLDEN_INVITED.slice(10));
    // The lifetime field itself (byte 4) differs.
    expect(GOLDEN_LIKED.slice(8, 10)).not.toBe(GOLDEN_INVITED.slice(8, 10));
  });

  it('the encoding is exactly the ten declared fields, no more', () => {
    // Tag + 9 fields, one byte each at these values.
    expect(serializeIdentityRecord(REC).length).toBe(10);
  });

  it('bytes missing a trailing field are REJECTED, not defaulted', () => {
    // A record value without a field must fail loudly: a silent 0 default would
    // mask exactly the fork the always-present rule exists to prevent. Under the
    // positional layout the reader simply runs out of input — the fields are not
    // optional, so there is nothing to be absent.
    for (const truncated of [GOLDEN_SHORT, '802a07', '802a']) {
      expect(() => deserializeIdentityRecord(Buffer.from(truncated, 'hex')), truncated)
        .toThrow();
    }
  });

  it('trailing bytes and non-minimal VLQ are both rejected (boundary check 2 and 3)', () => {
    // `decodeStruct` gives the record the same four-step boundary check the box
    // arm gets. Without the minimality step two distinct byte strings decode to
    // one record — two AVL values for one state, which is a fork with no
    // producer disagreement behind it.
    expect(() => deserializeIdentityRecord(Buffer.from(GOLDEN_ZERO + 'ff', 'hex'))).toThrow();
    // invitedAtBlock 0 in non-minimal two-byte VLQ (0x80 0x00) instead of one byte (0x00),
    // with the remaining fields at zero to reach the full 11-byte length.
    expect(() => deserializeIdentityRecord(Buffer.from('802a078000000000000000', 'hex'))).toThrow();
  });

  it('two provers fed the same record put agree on the digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);
    const put: RecordPut = {
      key: 'a1'.repeat(32),
      record: { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 2n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 },
    };

    const d1 = applyBlockMutations(p1, 1, [], [], [put]);
    const d2 = applyBlockMutations(p2, 1, [], [], [put]);
    expect(Buffer.from(d1).toString('hex')).toBe(Buffer.from(d2).toString('hex'));
  });

  it('a record updated lifetimeLikesReceived 0n → 3n changes the digest', () => {
    const { prover } = createAvlProver(db);
    const key = 'b2'.repeat(32);

    const at0 = Buffer.from(
      applyBlockMutations(prover, 1, [], [], [
        { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
      ]),
    ).toString('hex');
    const at3 = Buffer.from(
      applyBlockMutations(prover, 1, [], [], [
        { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 3n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
      ]),
    ).toString('hex');

    expect(at3).not.toBe(at0);
  });

  it('records differing ONLY in the like counter give different digests across provers', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db2);
    const key = 'c3'.repeat(32);

    const d1 = applyBlockMutations(p1, 1, [], [], [
      { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
    ]);
    const d2 = applyBlockMutations(p2, 1, [], [], [
      { key, record: { lastActivityBlock: 42, lastDecayBlock: 7, invitedAtBlock: 0, lifetimeLikesReceived: 3n, memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0 } },
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
