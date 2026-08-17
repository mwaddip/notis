import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { ReaderError } from '@dagsocial/wire';
import {
  CodecError,
  computeBoxId,
  computeCandidateBoxId,
  computeMintTxId,
  computeTxId,
  boxRecordBytes,
  boxRecordFromBytes,
  canonicalBoxBytes,
  u32BE,
  BOX_ID_DOMAIN,
  TX_ID_DOMAIN,
  MINT_ID_DOMAIN,
  IDENTITY_KEY_DOMAIN,
  BOX_TYPE_TAGS,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  LIKE_KARMA_COST,
  LIKES_PER_KARMA_PAYOUT,
  MAX_GENESIS_PROOF_PAYLOAD_BYTES,
  BOX_VALUE_BOUND,
  encodeTx,
  decodeTx,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
} from '../src/index.js';
import type { AnyBoxCandidate, BoxCandidate, CandidateOf, KarmaBox, CreditBox, InviteBox, BondBox, GenesisProofBox, EmissionBox, TreasuryBox, FeeBox, KarmaPoolBox, UtxoTransaction, MintReason } from '../src/index.js';

const owner = new Uint8Array(32).fill(0xaa);
// A UserId is 32 raw bytes; `inviterId` is one, so a display string like
// 'user456' is not a valid fixture value.
const inviter = new Uint8Array(32).fill(0x56);
// Provenance is REQUIRED on every box (TYPES_INTERFACE → BoxId) — `computeBoxId`
// takes `Omit<BoxBase, 'id'>` and derives the id from `txId ‖ index`, so a
// fixture without it is not a box at all.
const FIXTURE_TX_ID = 'e'.repeat(64);

// Box ids and public keys are `b32` in every preimage, so a fixture id has to
// be 64 lowercase hex characters to have an encoding at all. A `'in1'` or
// `'box_a'` placeholder is legal only where ids enter a preimage as their own
// text, which they do not here.
const IN_1 = '1a'.repeat(32);
const IN_2 = '2b'.repeat(32);
const PUBKEY_HEX = '3c'.repeat(32);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100n,
    owner,
    txId: FIXTURE_TX_ID,
    index: 0,
    ...overrides,
  };
}

function makeCreditBox(): CreditBox {
  return {
    boxType: 'credit',
    value: 500n,
    owner,
    txId: FIXTURE_TX_ID,
    index: 1,
  };
}

function makeInviteBox(): InviteBox {
  return {
    boxType: 'invite',
    // An invite is a claim ticket and always holds 0 — the karma it names does
    // not exist until the claim mints it (TYPES_INTERFACE → InviteBox).
    value: 0n,
    inviterId: inviter,
    inviteePublicKey: new Uint8Array(32).fill(0xcc),
    txId: FIXTURE_TX_ID,
    index: 2,
  };
}

function makeBondBox(): BondBox {
  return {
    boxType: 'bond',
    value: 20n,
    inviterId: inviter,
    // The paired invite names the same key, and that is the whole pairing: an
    // address can be invited once, so this field identifies exactly one live
    // pair (TYPES_INTERFACE → BondBox).
    inviteePublicKey: new Uint8Array(32).fill(0xcc),
    txId: FIXTURE_TX_ID,
    index: 3,
  };
}

describe('boxes', () => {
  describe('computeBoxId', () => {
    it('returns a 64-char hex string', () => {
      const id = computeBoxId(makeKarmaBox());
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it('is deterministic', () => {
      const box = makeKarmaBox();
      expect(computeBoxId(box)).toBe(computeBoxId(box));
    });

    it('changes with different value', () => {
      const a = makeKarmaBox({ value: 100n });
      const b = makeKarmaBox({ value: 200n });
      expect(computeBoxId(a)).not.toBe(computeBoxId(b));
    });

    it('changes with different boxType', () => {
      const karma = makeKarmaBox();
      const credit = makeCreditBox();
      expect(computeBoxId(karma)).not.toBe(computeBoxId(credit));
    });

    it('changes with different owner', () => {
      const a = makeKarmaBox();
      const b = makeKarmaBox({ owner: new Uint8Array(32).fill(0xff) });
      expect(computeBoxId(a)).not.toBe(computeBoxId(b));
    });

    it('ignores id field if present', () => {
      const box = makeKarmaBox();
      const withId = { ...box, id: 'some-random-id' };
      expect(computeBoxId(withId)).toBe(computeBoxId(box));
    });

    it('works for all box types', () => {
      expect(() => computeBoxId(makeCreditBox())).not.toThrow();
      expect(() => computeBoxId(makeInviteBox())).not.toThrow();
      expect(() => computeBoxId(makeBondBox())).not.toThrow();
    });

    it('computeBoxId differs when decayBurn differs', () => {
      const box1 = makeKarmaBox({ value: 100n });
      const box2 = makeKarmaBox({ value: 100n, decayBurn: true });
      const id1 = computeBoxId(box1);
      const id2 = computeBoxId(box2);
      expect(id1).not.toBe(id2);
    });

    it('is DETERMINED by the provenance on the box', () => {
      // An id that ignored its own provenance would be the M-11 id: a box that
      // hashes the same bare or materialized, so "predictable at signing time"
      // and "honest about the stored box" stop being the same value.
      //
      // So: moving the same `(txId, index)` pair must move the id, and two
      // indices under one txId must not collide.
      for (const bare of [makeKarmaBox(), makeCreditBox(), makeInviteBox(), makeBondBox()]) {
        const at3 = { ...bare, txId: GOLDEN_TX_ID, index: 3 };
        const at4 = { ...bare, txId: GOLDEN_TX_ID, index: 4 };
        const otherTx = { ...bare, txId: 'a'.repeat(64), index: 3 };
        expect(computeBoxId(at3)).not.toBe(computeBoxId(at4));
        expect(computeBoxId(at3)).not.toBe(computeBoxId(otherTx));
        // The stored `id` field is not part of its own preimage. Bound to a
        // variable first: `computeBoxId` takes `Omit<BoxBase, 'id'>`, and
        // excess-property checking rejects an `id` written into a fresh
        // literal at the call site while accepting the identical value
        // through a variable — which is the real call shape, since every
        // STORED box carries an id and `stored.id === computeBoxId(stored)`
        // is the invariant. Same value, same claim, no cast.
        const withStoredId = { ...at3, id: 'f'.repeat(64) };
        expect(computeBoxId(withStoredId)).toBe(computeBoxId(at3));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Frozen golden vectors — bigint box values, positional layout
// ---------------------------------------------------------------------------

/**
 * Frozen golden vectors — the cross-implementation anchor for the box identity
 * encoding.
 *
 * `value` is `vlqU`, and field order comes from the layout table rather than
 * from a key sort (TYPES_INTERFACE → Layout — Boxes). Do not "fix" a failure by
 * editing the hashes: the encoding is protocol-breaking and unversioned.
 *
 * **`CreditBox.value` carries the wide-int pin.** `value` is the widest number
 * either of these two arms encodes, so the credit candidate's is deliberately
 * 12_345_678_900_000_000 — above 2^53, the range that makes box values `bigint`
 * and their writer the one that throws rather than sentinels.
 *
 * Candidates and boxes are separate because the derivation is layered: the
 * candidates define the transaction, the transaction defines its id, and that id
 * plus an index defines each box. Writing it in that order is also what shows
 * this path has no circularity.
 */
const GOLDEN_OWNER = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_OWNER[i] = i;

const GOLDEN_KARMA_CANDIDATE: CandidateOf<KarmaBox> = {
  boxType: 'karma',
  value: 100n,
  owner: GOLDEN_OWNER,
};

const GOLDEN_CREDIT_CANDIDATE: CandidateOf<CreditBox> = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  owner: GOLDEN_OWNER,
};

const GOLDEN_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_CREDIT_CANDIDATE],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '7c78d4e40b2134e51485a992e270385644932b77d2a360d63ea2f4402b1553dd';
const GOLDEN_CREDIT_BOX_ID =
  '1da30d341964fb09146f4cf1c371a4d56c01021e44aee8e95deb0df9cc3f57dd';
const GOLDEN_TX_ID =
  '0d72f28245bf0c9dcb1b458641dae9b08e711da5fc45a8dd78e8562de9ae0291';

/** The two candidates as block application materializes them out of GOLDEN_TX. */
const GOLDEN_KARMA_BOX: KarmaBox = { ...GOLDEN_KARMA_CANDIDATE, txId: GOLDEN_TX_ID, index: 0 };
const GOLDEN_CREDIT_BOX: CreditBox = { ...GOLDEN_CREDIT_CANDIDATE, txId: GOLDEN_TX_ID, index: 1 };

/**
 * Full canonical identity bytes, frozen — the whole encoding, not a sample of
 * it. A mirror implementation that gets any byte wrong computes different ids
 * for every box, so this is what the demo UI's hand-written mirror is checked
 * against.
 *
 *   karma  = 00 | 64 | b32(owner)             | 00
 *            ^tag ^vlqU(100)                    ^opt decayBurn absent
 *   credit = 01 | vlqU(12345678900000000) | b32(owner) | 00
 *                                                        ^opt lockedUntilBlock absent
 */
const GOLDEN_KARMA_BOX_BYTES =
  '00' +                                                               // enum8 karma
  '64' +                                                               // vlqU(100)
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  '00';                                                                // opt decayBurn absent
const GOLDEN_CREDIT_BOX_BYTES =
  '01' +                                                               // enum8 credit
  '80eae1eac58af715' +                                                 // vlqU(12345678900000000)
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  '00';                                                                // opt lockedUntilBlock absent

describe('golden vectors (positional box encoding)', () => {
  it('golden vector: karma boxId is frozen', () => {
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('golden vector: credit boxId (value > 2^53) is frozen', () => {
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('golden vector: txId is frozen', () => {
    expect(computeTxId(GOLDEN_TX)).toBe(GOLDEN_TX_ID);
  });

  it('value is vlqU over the full u64', () => {
    const karmaHex = Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex');
    const creditHex = Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex');
    // 100n → one byte, where the CBOR form spent nine (`1b` + u64BE).
    expect(karmaHex).toContain('64');
    // 12345678900000000n > 2^53 — the range a `number` cannot hold, which is
    // why `value` is a bigint and its writer is the one that throws rather than
    // sentinels (the u64 wire domain has no unreachable value).
    expect(creditHex).toContain('80eae1eac58af715');
  });

  it('golden vector: full canonical identity bytes are frozen', () => {
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex')).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex')).toBe(GOLDEN_CREDIT_BOX_BYTES);
    // 35 bytes: no map header, no key names, a one-byte `value`, and a one-byte
    // absent option.
    expect(canonicalBoxBytes(GOLDEN_KARMA_BOX).length).toBe(35);
  });

  it('an unknown boxType takes the reserved 0xff tag rather than throwing', () => {
    // `enum8` stays total: its tag set is narrower than a byte, so `0xff` is
    // unreachable from any real box type and a malformed box can never encode
    // as a well-formed one. `'like'` is the fixture because it is a retired box
    // type — the string is reserved and holds no tag, so it is exactly the
    // "outside the table" case this arm exists for.
    const bogus = { ...GOLDEN_KARMA_CANDIDATE, boxType: 'like' as never };
    const bytes = canonicalBoxBytes(bogus);
    expect(bytes[0]).toBe(0xff);
    // No per-type fields follow an unknown tag, so the encoding is just
    // `ff ‖ vlqU(value)` — total, and distinct from every valid box.
    expect(bytes.length).toBe(2);
  });

  it('a fixed-width box field outside its domain has no encoding', () => {
    // The `b32`/bigint writers throw where `enum8` sentinels, and the reason is
    // structural: a fixed-width field's wire domain IS its encodable domain, so
    // padding a 31-byte owner to 32 would map it onto a well-formed box's id.
    const shortOwner: CandidateOf<KarmaBox> = { ...GOLDEN_KARMA_CANDIDATE, owner: new Uint8Array(31) };
    expect(() => canonicalBoxBytes(shortOwner)).toThrow(/expected 32 bytes/);
    expect(() => canonicalBoxBytes({ ...GOLDEN_KARMA_CANDIDATE, value: -1n }))
      .toThrow();
    expect(() => canonicalBoxBytes({ ...GOLDEN_KARMA_CANDIDATE, value: 2n ** 64n }))
      .toThrow();
  });

  it('encodes a value above BOX_VALUE_BOUND — this package publishes the bound and enforces nothing', () => {
    // ⛔ The encodable domain is `[0, 2^64)` and the accepted one is
    // `[0, BOX_VALUE_BOUND)`; this package owns only the wider of the two
    // (→ `BOX_VALUE_BOUND`). Narrowing an encoder to the accepted bound is the
    // silent way to collapse that split, and this is what it fails on.
    expect(() => canonicalBoxBytes({ ...GOLDEN_KARMA_CANDIDATE, value: BOX_VALUE_BOUND }))
      .not.toThrow();
    // The corpus keeps `box/karma-value-u64-max` for the same reason: a vector
    // proving a value encodes is not a claim that consensus accepts it.
    expect(() => canonicalBoxBytes({ ...GOLDEN_KARMA_CANDIDATE, value: 2n ** 64n - 1n }))
      .not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Provenance-derived identity — TYPES_INTERFACE → BoxId
// ---------------------------------------------------------------------------

/**
 * Independent mirror of the src writer — the encoding under test, not a reuse of
 * it. Stays hand-written even though `u32BE` is exported: the golden vectors below
 * are only an anchor if the bytes they feed come from somewhere other than the
 * function under test, and it is the *in-domain* half this pins, so the mirror
 * deliberately omits the sentinel branch.
 */
function u32BEMirror(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/**
 * One frozen mint id per `MintReason`, at height 1 with subject `4x 0x5a` — the
 * conformance artifact an independent implementation needs, and the only thing
 * that catches a **renumber**. A renumber moves every mint txId carrying the tag
 * and, through `computeCandidateBoxId`, every box id minted under it, while
 * "every reason derives a distinct id" stays green: a permutation keeps them all
 * distinct. Do not "fix" a failure here by editing a hash — the derivation is
 * protocol-breaking and unversioned.
 *
 * `Readonly<Record<MintReason, string>>` is what makes the coverage structural: a
 * member added to the union without a row here is a **compile error**, so no tag
 * can ship unpinned. A list typed `MintReason[]` cannot carry that property —
 * an array of the union is satisfied by any subset of it, so it tracks the set
 * only by hand.
 */
const MINT_REASON_GOLDENS: Readonly<Record<MintReason, string>> = {
  coinbase:               '32fe945568d48465eb9a2b74d506b0ec16395136fbb4357c8de21cef5a105c0a',
  'vouch-settle':         '09a5a40e4424fd0f4897aff225d32500975941acb7ef4972bf30a71f2c6a62aa',
  'like-payout':          '53a7f0ab4f60e54e0b7bbc694c0082e777c6e4ebf910db321dcfb4c1d222f59a',
  'postlock-unlock':      '420485f93ec603eb241379a85728bd80070b3f5f0a8389cb052941604ddbf32f',
  'postlock-remainder':   '635cc8bfe23cd52f6bc5f045845defaef5f796a61be57f08f7932f60a0967f4d',
  decay:                  'a483b6263e7a5ed49246aca51adae2c12e0cd24958412657ced84f64dca0e77a',
  genesis:                '9010dd1d6fe6029eb8e856fe38467836781ce43ddad1ce01c0af7afc0bc7b7b2',
  'prune-refund-author':  'aa42ffca37cb6d20d30cc5afe2c691567fd31106a3a79a21e715cf616b863a32',
  'invite-claim':         'f59f898a63637ffd1c7ebc705ca88321bfc9035f23caa047366d56d49b1e8173',
  'bond-settle':          'b036b7e30827db46de4d98f80c982b978aa011e7a1a5a3f11389788e335eafde',
  'bond-return':          '7b6ffca09e60c23b597e01b4e217846117744e64b444ca41523e05912f5705c1',
  'emission-release':     '4cb4b95c47aa83dc1330235f096c09348ba7735ad7871eb18f21160ff2f5f0a1',
  'treasury-accrue':      '83b6e7983c2c14be4bdc71da51278d43372a9123ef071a5cf06aefd80fedca65',
  'genesis-committee':    '0cf15bc43dcc566062faad29d7e9569aa12f43e034ecd8babd19bffd85715d12',
};

const MINT_GOLDEN_HEIGHT = 1;
const MINT_GOLDEN_SUBJECT = new Uint8Array(4).fill(0x5a);

/** Every member of the union, inherited from the goldens' exhaustiveness. */
const ALL_MINT_REASONS = Object.keys(MINT_REASON_GOLDENS) as MintReason[];

/**
 * Frozen golden vectors for the provenance derivation — the cross-implementation
 * anchor for node and the demo UI. `GOLDEN_TX` creates these two boxes, so the
 * karma box sits at index 0 and the credit box at index 1 of that transaction.
 * Do not "fix" a failure by editing the hashes: the derivation is
 * protocol-breaking and unversioned.
 */
const GOLDEN_CANDIDATE_KARMA_ID =
  '7c78d4e40b2134e51485a992e270385644932b77d2a360d63ea2f4402b1553dd';
const GOLDEN_CANDIDATE_CREDIT_ID =
  '1da30d341964fb09146f4cf1c371a4d56c01021e44aee8e95deb0df9cc3f57dd';
const GOLDEN_MINT_COINBASE_ID =
  'da905d0f72efd81bc5c1ed3074e28fae890d7d1140fcb7f17d155da4bc12ce18';
const GOLDEN_MINT_DECAY_ID =
  '126ae615fa41a7707f9261852e4f5335640d0c18016be2b696811737778fe42f';

describe('canonicalBoxBytes', () => {
  it('is deterministic', () => {
    const a = canonicalBoxBytes(GOLDEN_KARMA_BOX);
    const b = canonicalBoxBytes(GOLDEN_KARMA_BOX);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('excludes id — and now there is no writer that could include it', () => {
    // The old encoder destructured `id`/`txId`/`index` out of the object and
    // CBOR-encoded whatever remained, so "provenance is not in the candidate
    // bytes" was a strip somebody had to remember and a stray key on a box
    // object would have ridden into the id. Positionally there is no branch
    // that could write them: the encoder writes the fields its layout declares
    // and nothing else.
    const withId = { ...makeKarmaBox(), id: 'should-be-excluded', stray: 'junk' };
    const bytes = canonicalBoxBytes(withId);
    expect(bytes[0]).toBe(0);  // enum8 karma — the first byte is the type tag
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(canonicalBoxBytes(makeKarmaBox())))).toBe(0);
  });

  it('excludes provenance, so a stored box yields its candidate bytes', () => {
    const candidate = makeKarmaBox();
    const stored = { ...candidate, id: 'x'.repeat(64), txId: GOLDEN_TX_ID, index: 3 };
    expect(Buffer.compare(
      Buffer.from(canonicalBoxBytes(stored)),
      Buffer.from(canonicalBoxBytes(candidate)),
    )).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// invite and bond — two tags over one trailing layout
// ---------------------------------------------------------------------------

/**
 * `invite` and `bond` carry **identical trailing fields** — `b32(inviterId) ‖
 * b32(inviteePublicKey)` — so `enum8(boxType)` is the whole of what separates
 * their leaves (TYPES_INTERFACE → Layout — Boxes). `value` happens to differ too,
 * since an invite is always `0`, but nothing may rely on that: the tests below
 * pin the pair at one shared value as well, which is the case a tag-blind encoder
 * would collide.
 *
 * Both key fields are fixed 32 bytes. A width outside that has **no** encoding
 * rather than sharing one — `writeBytesNOrThrow` throws, and its domain is
 * established upstream by node's output-shape schema (`TYPES_INTERFACE` →
 * Totality).
 *
 * Hand-assembled from the layout table, not copied from the encoder's output —
 * the file's idiom for a frozen byte string, and the only form that makes a
 * vector an independent check rather than a screenshot.
 *
 *   02 | 00 | b32(inviterId) | b32(inviteePublicKey)     — invite, value 0
 *   04 | 14 | b32(inviterId) | b32(inviteePublicKey)     — bond, value 20
 *   ^tag ^vlqU64(value)
 */
const INVITEE_KEY = new Uint8Array(32).fill(0xcc);
const PAIR_TAIL = '56'.repeat(32) + 'cc'.repeat(32);
const INVITE_BYTES = '02' + '00' + PAIR_TAIL;
const BOND_BYTES = '04' + '14' + PAIR_TAIL;

describe('invite and bond share a trailing layout, separated by the tag', () => {
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('an invite encodes to tag, value 0, and the two keys — 66 bytes', () => {
    expect(hexOf(canonicalBoxBytes(makeInviteBox()))).toBe(INVITE_BYTES);
    expect(canonicalBoxBytes(makeInviteBox()).length).toBe(66);
  });

  it('a bond encodes to the same tail under its own tag — 66 bytes', () => {
    expect(hexOf(canonicalBoxBytes(makeBondBox()))).toBe(BOND_BYTES);
    expect(canonicalBoxBytes(makeBondBox()).length).toBe(66);
  });

  it('the tag alone separates them when value agrees', () => {
    // The case a tag-blind encoder collides: same inviter, same invitee, same
    // value, different type. `enum8(boxType)` is field 1, so the leaves differ
    // in byte 0 and nowhere else — and the ids follow the bytes.
    const invite = { ...makeInviteBox(), value: 20n };
    const bond = makeBondBox();
    const a = hexOf(canonicalBoxBytes(invite));
    const b = hexOf(canonicalBoxBytes(bond));
    expect(a.slice(2)).toBe(b.slice(2));
    expect(a.slice(0, 2)).toBe('02');
    expect(b.slice(0, 2)).toBe('04');
    expect(computeCandidateBoxId(invite, FIXTURE_TX_ID, 0))
      .not.toBe(computeCandidateBoxId(bond, FIXTURE_TX_ID, 0));
  });

  it('both round-trip through the reader', () => {
    for (const box of [makeInviteBox(), makeBondBox()]) {
      const { candidate } = boxRecordFromBytes(boxRecordBytes(box, box.txId, box.index));
      expect(hexOf(canonicalBoxBytes(candidate as never))).toBe(hexOf(canonicalBoxBytes(box)));
    }
  });

  it('each key field is b32: an off-domain width has no encoding at all', () => {
    // Not merely rejected late — there is no byte string for it, so a malformed
    // box can never be handed a well-formed box's id.
    for (const width of [0, 1, 31, 33, 64]) {
      const shortInvitee = new Uint8Array(width);
      const invite = { ...makeInviteBox(), inviteePublicKey: shortInvitee };
      expect(() => canonicalBoxBytes(invite)).toThrow(/expected 32 bytes/);
      const bond = { ...makeBondBox(), inviteePublicKey: shortInvitee };
      expect(() => canonicalBoxBytes(bond)).toThrow(/expected 32 bytes/);
    }
  });

  it('a MISSING key throws rather than encoding as anything', () => {
    for (const absent of [undefined, null, []]) {
      const invite = { ...makeInviteBox(), inviteePublicKey: absent as unknown as Uint8Array };
      expect(() => canonicalBoxBytes(invite)).toThrow(/expected 32 bytes/);
      const bond = { ...makeBondBox(), inviteePublicKey: absent as unknown as Uint8Array };
      expect(() => canonicalBoxBytes(bond)).toThrow(/expected 32 bytes/);
    }
  });

  it('the invite-creation transaction hashes both outputs', () => {
    // One transaction emits the InviteBox and its paired BondBox, both naming
    // the same invitee. The key is inside the signed preimage, so a relay
    // cannot re-point either box at an invitee of its own.
    const inviteCreate: UtxoTransaction = {
      inputs: [IN_1],
      outputs: [
        { boxType: 'invite', value: 0n, inviterId: inviter, inviteePublicKey: INVITEE_KEY },
        { boxType: 'bond', value: 25n, inviterId: inviter, inviteePublicKey: INVITEE_KEY },
      ],
      signatures: {},
      protocolVersion: 1,
    };
    expect(computeTxId(inviteCreate)).toHaveLength(64);
    const other: UtxoTransaction = {
      ...inviteCreate,
      outputs: inviteCreate.outputs.map((o) => ({
        ...(o as CandidateOf<BondBox>),
        inviteePublicKey: new Uint8Array(32).fill(0xdd),
      })) as UtxoTransaction['outputs'],
    };
    expect(computeTxId(other)).not.toBe(computeTxId(inviteCreate));
  });

  it('nothing outside the invite and bond arms moved', () => {
    // The claim that keeps this a two-arm edit rather than a movement of
    // everything: the other box types and the transaction that carries none are
    // pinned here, so a change reaching another arm fails at this test rather
    // than at a moved `stateRoot` much later.
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex')).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex')).toBe(GOLDEN_CREDIT_BOX_BYTES);
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
    expect(computeTxId(GOLDEN_TX)).toBe(GOLDEN_TX_ID);
    // post_lock / vouch / genesis_proof have no inline golden here; theirs are
    // the untouched vectors in `test/golden/boxes.json`, asserted by the corpus
    // suite in both directions.
  });
});

// ---------------------------------------------------------------------------
// genesis_proof — the box whose payload is a network's identity
// ---------------------------------------------------------------------------

/**
 * Tag 3, `value` fixed at `0n`, and one variable-width field.
 *
 * **The payload is `lp`, not `lpUtf8`** (TYPES_INTERFACE → Layout — Boxes). It
 * is opaque to consensus; whether it decodes as text is a client's question,
 * and a UTF-8 writer would put a validity rule inside an encoder that has no
 * business holding one. That makes the length prefix the whole of the field's
 * injectivity, which is what the empty-payload test below pins.
 *
 * **A different payload is a different box id, and that is the mechanism the
 * unit rests on** — it is the only divergence between the three networks'
 * genesis box sets, so it is what makes their state roots differ.
 *
 * `value` is `0n`: the box carries neither karma nor credits and never enters
 * supply accounting. It still takes the shared prefix's `vlqU64` like every
 * other box type, which is the `00` in these vectors.
 */
const PROOF_PAYLOAD = new TextEncoder().encode('mock-headline');

/**
 * Hand-assembled from the layout table, not copied from the encoder's output —
 * the same idiom as `BOND_PREFIX` above, and the only form that makes a vector
 * an independent check rather than a screenshot.
 *
 *   03 | 00 | 0d | 6d6f636b2d686561646c696e65
 *   ^tag ^vlqU64(0)  ^vlqU(13)   ^payload
 */
const PROOF_BYTES = '03' + '00' + '0d' + '6d6f636b2d686561646c696e65';

function makeProofCandidate(payload: Uint8Array): CandidateOf<GenesisProofBox> {
  return { boxType: 'genesis_proof', value: 0n, payload };
}

describe('genesis_proof', () => {
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('takes tag 3, and encodes as enum8 ‖ vlqU64(value) ‖ lp(payload)', () => {
    const bytes = canonicalBoxBytes(makeProofCandidate(PROOF_PAYLOAD));
    expect(bytes[0]).toBe(3);
    expect(hexOf(bytes)).toBe(PROOF_BYTES);
    expect(bytes.length).toBe(16);
  });

  it('an empty payload has an encoding, and the length prefix keeps it distinct', () => {
    // `lp` and not raw bytes appended: without the count an empty payload is
    // indistinguishable from the end of the box, and a one-byte payload of
    // `00` would share its encoding with an empty one. Three bytes is the
    // smallest box that carries a tail; `emission` and `treasury` reach two by
    // carrying none.
    expect(hexOf(canonicalBoxBytes(makeProofCandidate(new Uint8Array(0))))).toBe('030000');
    expect(hexOf(canonicalBoxBytes(makeProofCandidate(new Uint8Array([0]))))).toBe('03000100');
  });

  it('round-trips through the box record', () => {
    const record = boxRecordFromBytes(
      boxRecordBytes(makeProofCandidate(PROOF_PAYLOAD), FIXTURE_TX_ID, 0),
    );
    expect(record).toEqual({
      candidate: { boxType: 'genesis_proof', value: 0n, payload: PROOF_PAYLOAD },
      txId: FIXTURE_TX_ID,
      index: 0,
    });
  });

  it('a different payload is a different box id — the whole per-network mechanism', () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const ids = ['mainnet-proof', 'testnet-proof', 'devnet-proof'].map((s) =>
      computeCandidateBoxId(makeProofCandidate(encode(s)), FIXTURE_TX_ID, 0),
    );
    expect(new Set(ids).size).toBe(3);
  });

  /**
   * `MAX_GENESIS_PROOF_PAYLOAD_BYTES` is a **decode** rule on this arm, so the
   * pair that pins it is the boundary — at the bound decodes, one byte past it
   * does not.
   *
   * ⚠ **The boundary pair is the assertion, and a single over-bound case would
   * not be one.** A payload of either length is well-formed `lp` and re-encodes
   * identically, so nothing else in the pipeline has a threshold anywhere near
   * 512: only this rule can separate the two. A test that asserted rejection
   * alone would be green whether the bound existed or the reader had merely run
   * out of some other rope.
   */
  const atBound = new Uint8Array(MAX_GENESIS_PROOF_PAYLOAD_BYTES).fill(0x5a);
  const overBound = new Uint8Array(MAX_GENESIS_PROOF_PAYLOAD_BYTES + 1).fill(0x5a);

  it('decodes a payload at the bound and refuses the next byte', () => {
    const decoded = boxRecordFromBytes(boxRecordBytes(makeProofCandidate(atBound), FIXTURE_TX_ID, 0));
    expect((decoded.candidate as CandidateOf<GenesisProofBox>).payload).toEqual(atBound);

    // ⚠ **The CLASS is the assertion, not the code.** `CodecError` extends
    // `ReaderError` and hands its constructor `'invalid-tag'` whatever its
    // `failure` is (`codec.ts`), so the code cannot separate a domain refusal
    // this arm makes from a boundary-check failure on the same bytes — only
    // `not.toBeInstanceOf(CodecError)` does. The unassigned-tag loop in
    // `boxRecordFromBytes` and `golden.test.ts`' reject runner split them the
    // same way.
    //
    // `readLpUtf8` is the precedent for the code itself: a domain refusal on
    // the contents of a length-prefixed field, where `ReaderErrorCode` offers
    // nothing narrower than "present and wrong, which is not truncation".
    let thrown: unknown;
    try {
      boxRecordFromBytes(boxRecordBytes(makeProofCandidate(overBound), FIXTURE_TX_ID, 0));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ReaderError);
    expect(thrown).not.toBeInstanceOf(CodecError);
    expect((thrown as ReaderError).code).toBe('invalid-tag');
  });

  it('still ENCODES an over-bound payload — the refusal is one-way', () => {
    // The writers stay total (TYPES_INTERFACE → Totality). The bound gives an
    // over-bound payload **no decoding**, which is the standing an unassigned
    // tag has, and does not make it unencodable — so `computeBoxId` still
    // answers for one and the encode/decode asymmetry stays the one this file
    // already relies on rather than a new class.
    const bytes = canonicalBoxBytes(makeProofCandidate(overBound));
    expect(bytes[0]).toBe(3);
    // tag ‖ vlqU64(0) ‖ vlqU(513) ‖ 513 bytes — the count needs two bytes past 127.
    expect(bytes.length).toBe(1 + 1 + 2 + overBound.length);
  });

  it('binds this arm alone — another lp field reads a payload it would refuse', () => {
    // Deliberately NOT in `readLp` (`src/codec.ts`), which every `lp` field
    // shares. `utxoTxTree.utxoTxs` is `arr(lp)` and goes through the same
    // primitive on the same positional reader, so it is what a bound placed in
    // the primitive would have caught along with this box — and it must not be.
    const tree = { utxoTxIds: [], utxoTxs: [overBound], pruneEntries: [], coinbaseOutputs: [] };
    expect(decodeUtxoTxTree(encodeUtxoTxTree(tree)).utxoTxs[0]).toEqual(overBound);
  });
});

// ---------------------------------------------------------------------------
// emission, treasury, fee and karma_pool — the types whose encoding stops at
// the prefix
// ---------------------------------------------------------------------------

/**
 * Tags 7, 8, 9 and 10, and **no trailing fields on any of them**
 * (TYPES_INTERFACE → Layout — Boxes). None of the four names an owner — block
 * application is the only spender — so the content encoding is the shared
 * `enum8(boxType) ‖ vlqU64(value)` and nothing else.
 *
 * **The empty tail is the shape the rest of the corpus does not hold.** Every
 * other arm writes at least one field, so a reader that assumed something
 * follows the prefix would be correct on every one of them and wrong only here.
 * The round-trips below are what makes "an empty tail is representable" a
 * checked property rather than an argument from the encoder's shape.
 *
 * Hand-assembled from the layout table, not copied from the encoder's output —
 * the file's idiom for a frozen byte string, and the only form that makes a
 * vector an independent check rather than a screenshot.
 *
 *   07 | 64     — emission, value 100
 *   08 | 64     — treasury, value 100
 *   09 | 64     — fee, value 100
 *   0a | 64     — karma_pool, value 100
 *   ^tag ^vlqU64(value)
 */
const EMISSION_CANDIDATE: CandidateOf<EmissionBox> = {
  boxType: 'emission', value: 100n,
};
const TREASURY_CANDIDATE: CandidateOf<TreasuryBox> = {
  boxType: 'treasury', value: 100n,
};
const FEE_CANDIDATE: CandidateOf<FeeBox> = {
  boxType: 'fee', value: 100n,
};
const KARMA_POOL_CANDIDATE: CandidateOf<KarmaPoolBox> = {
  boxType: 'karma_pool', value: 100n,
};

/** The tailed arms, at their own floor — one candidate per type that has a tail. */
const TAILED_CANDIDATES: AnyBoxCandidate[] = [
  { boxType: 'karma', value: 0n, owner },
  { boxType: 'credit', value: 0n, owner },
  { boxType: 'invite', value: 0n, inviterId: inviter, inviteePublicKey: INVITEE_KEY },
  { boxType: 'genesis_proof', value: 0n, payload: new Uint8Array(0) },
  { boxType: 'bond', value: 0n, inviterId: inviter, inviteePublicKey: INVITEE_KEY },
  { boxType: 'post_lock', value: 0n, originalValue: 0n, owner },
  { boxType: 'vouch', value: 1n, voucherId: owner, targetId: inviter },
];

describe('emission, treasury, fee and karma_pool', () => {
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('each encodes to its tag and value, and nothing else', () => {
    expect(hexOf(canonicalBoxBytes(EMISSION_CANDIDATE))).toBe('0764');
    expect(hexOf(canonicalBoxBytes(TREASURY_CANDIDATE))).toBe('0864');
    expect(hexOf(canonicalBoxBytes(FEE_CANDIDATE))).toBe('0964');
    expect(hexOf(canonicalBoxBytes(KARMA_POOL_CANDIDATE))).toBe('0a64');
    expect(canonicalBoxBytes(EMISSION_CANDIDATE)[0]).toBe(BOX_TYPE_TAGS.emission);
    expect(canonicalBoxBytes(TREASURY_CANDIDATE)[0]).toBe(BOX_TYPE_TAGS.treasury);
    expect(canonicalBoxBytes(FEE_CANDIDATE)[0]).toBe(BOX_TYPE_TAGS.fee);
    expect(canonicalBoxBytes(KARMA_POOL_CANDIDATE)[0]).toBe(BOX_TYPE_TAGS.karma_pool);
  });

  it('two bytes is the smallest legal box of any type', () => {
    // The prefix with nothing after it. The nearest type is `genesis_proof` at
    // `03 00 00`, three bytes, because its empty payload still spends a length
    // prefix. Pinned so the claim in TYPES_INTERFACE → Layout — Boxes has a
    // test under it.
    const emptyEmission: CandidateOf<EmissionBox> = { ...EMISSION_CANDIDATE, value: 0n };
    const emptyTreasury: CandidateOf<TreasuryBox> = { ...TREASURY_CANDIDATE, value: 0n };
    const emptyFee: CandidateOf<FeeBox> = { ...FEE_CANDIDATE, value: 0n };
    const emptyPool: CandidateOf<KarmaPoolBox> = { ...KARMA_POOL_CANDIDATE, value: 0n };
    const smallest = canonicalBoxBytes(emptyEmission);
    expect(hexOf(smallest)).toBe('0700');
    expect(smallest.length).toBe(2);
    expect(canonicalBoxBytes(emptyTreasury).length).toBe(2);
    // A zero-value fee box is not a box consensus creates (TYPES_INTERFACE →
    // FeeBox), and it still ENCODES: the no-zero rule is node's, and this
    // encoder's domain is the u64.
    expect(hexOf(canonicalBoxBytes(emptyFee))).toBe('0900');
    // The pool's zero is the one the ledger holds. Emission terminates and
    // creates no zero successor; the pool never terminates, because a burn must
    // always have somewhere to return (TYPES_INTERFACE → KarmaPoolBox).
    expect(hexOf(canonicalBoxBytes(emptyPool))).toBe('0a00');
    // Nothing else reaches two. Every other arm carries a tail, so this is the
    // floor for the whole format rather than for the empty-tail types.
    for (const candidate of TAILED_CANDIDATES) {
      expect(canonicalBoxBytes(candidate).length, candidate.boxType).toBeGreaterThan(2);
    }
  });

  it('the tag alone separates them at equal value', () => {
    // The `invite`/`bond` case with the trailing fields removed: same value,
    // different type, and byte 0 is the whole of the difference. The ids part
    // on the provenance `computeBoxId` appends, not on the content bytes.
    const encoded = [EMISSION_CANDIDATE, TREASURY_CANDIDATE, FEE_CANDIDATE, KARMA_POOL_CANDIDATE]
      .map((c) => hexOf(canonicalBoxBytes(c)));
    expect(encoded.map((h) => h.slice(0, 2))).toEqual(['07', '08', '09', '0a']);
    expect(new Set(encoded.map((h) => h.slice(2))).size).toBe(1);
    const ids = [EMISSION_CANDIDATE, TREASURY_CANDIDATE, FEE_CANDIDATE, KARMA_POOL_CANDIDATE]
      .map((c) => computeCandidateBoxId(c, FIXTURE_TX_ID, 0));
    expect(new Set(ids).size).toBe(4);
  });

  it('identical content bytes still get distinct ids, from provenance alone', () => {
    // With no trailing fields, two boxes of one type at one value have exactly
    // the same content bytes — there is no field left to differ in. Identity
    // therefore rests entirely on the provenance `computeBoxId` appends, which
    // is the case the empty tail makes reachable rather than hypothetical.
    const ids = [0, 1, 2].map((index) =>
      computeCandidateBoxId(EMISSION_CANDIDATE, FIXTURE_TX_ID, index),
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('round-trips through the box record', () => {
    for (const candidate of [
      EMISSION_CANDIDATE, TREASURY_CANDIDATE, FEE_CANDIDATE, KARMA_POOL_CANDIDATE,
    ]) {
      const record = boxRecordFromBytes(boxRecordBytes(candidate, FIXTURE_TX_ID, 0));
      expect(record).toEqual({
        candidate: { boxType: candidate.boxType, value: 100n },
        txId: FIXTURE_TX_ID,
        index: 0,
      });
    }
  });

  it('the record is the content bytes plus provenance, with no tail between', () => {
    // The one place an empty tail could go wrong silently: `boxRecordBytes`
    // concatenates the content half with `b32(txId) ‖ vlqU(index)`, so if the
    // reader walked a phantom field the txId would decode from the wrong
    // offset and still be 32 well-formed bytes.
    const bytes = boxRecordBytes(EMISSION_CANDIDATE, FIXTURE_TX_ID, 0);
    expect(hexOf(bytes)).toBe('0764' + FIXTURE_TX_ID + '00');
    expect(bytes.length).toBe(2 + 32 + 1);
  });

  it('a transaction carrying one hashes it like any other output', () => {
    // Neither type is a legal transaction output under node's shape rules, but
    // `computeTxId` is a total function of the candidates it is handed and must
    // not depend on that: an encoder that skipped an empty tail differently
    // from the reader would move a txId rather than reject it.
    const tx: UtxoTransaction = {
      inputs: [IN_1],
      outputs: [EMISSION_CANDIDATE, TREASURY_CANDIDATE],
      signatures: {},
      protocolVersion: 1,
    };
    expect(computeTxId(tx)).toHaveLength(64);
    const swapped: UtxoTransaction = { ...tx, outputs: [TREASURY_CANDIDATE, EMISSION_CANDIDATE] };
    expect(computeTxId(swapped)).not.toBe(computeTxId(tx));
  });

  it('value still throws outside the u64, like every other box type', () => {
    // The empty tail removes fields, not the prefix's domain. `value` is
    // `vlqU64` on every arm (TYPES_INTERFACE → Totality), so the exception is
    // the same one and not a new class.
    for (const value of [-1n, 2n ** 64n]) {
      expect(() => canonicalBoxBytes({ ...EMISSION_CANDIDATE, value }), `${value}`).toThrow();
      expect(() => canonicalBoxBytes({ ...TREASURY_CANDIDATE, value }), `${value}`).toThrow();
      expect(() => canonicalBoxBytes({ ...FEE_CANDIDATE, value }), `${value}`).toThrow();
      expect(() => canonicalBoxBytes({ ...KARMA_POOL_CANDIDATE, value }), `${value}`).toThrow();
    }
  });

  it('the pool encodes at its genesis value, the top of what the STORE can hold', () => {
    // `BOX_VALUE_BOUND - 1` is the whole of a network's karma supply and the
    // value genesis puts in the box (TYPES_INTERFACE → KarmaPoolBox). It is the
    // maximum STORABLE karma, one bit below the maximum encodable one: the
    // ledger is SQLite and its `INTEGER` is signed, so the pool is the one box
    // type whose ordinary state sits on the store's ceiling while the writer's
    // stays a bit above it (→ `BOX_VALUE_BOUND`).
    // `pool.value + circulating karma == BOX_VALUE_BOUND - 1` is what keeps it
    // there: a burn can only return what a mint drew, so nothing can hand this
    // writer a pool it would refuse.
    const genesis: CandidateOf<KarmaPoolBox> = { boxType: 'karma_pool', value: BOX_VALUE_BOUND - 1n };
    expect(hexOf(canonicalBoxBytes(genesis))).toBe('0affffffffffffffff7f');
    const record = boxRecordFromBytes(boxRecordBytes(genesis, FIXTURE_TX_ID, 0));
    expect(record.candidate).toEqual(genesis);
  });
});

/**
 * `u32BE` is the mint `subject` encoder and `computePostId`'s index writer;
 * `computeCandidateBoxId`'s `index` and `computeMintTxId`'s `height` are `vlqU`.
 *
 * It is exported because `NODE_INTERFACE.md`'s reason/subject table gives the
 * `coinbase` and `genesis` mints a `u32BE` selector as their `subject`, and
 * subject bytes are the caller's; one implementation is what stops node
 * reimplementing it and drifting. So these tests pin a live, protocol-visible
 * encoding — just one owned by a different contract.
 */
describe('u32BE', () => {
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('writes 4 bytes big-endian', () => {
    // Byte order is protocol-visible: a little-endian mirror builds different
    // coinbase/genesis subjects and therefore different mint txIds and box ids.
    expect(hexOf(u32BE(0))).toBe('00000000');
    expect(hexOf(u32BE(1))).toBe('00000001');          // '01000000' if little-endian
    expect(hexOf(u32BE(258))).toBe('00000102');
    expect(hexOf(u32BE(0x12345678))).toBe('12345678'); // '78563412' if little-endian
    expect(hexOf(u32BE(0xfffffffe))).toBe('fffffffe'); // top of the encodable domain
  });

  it('agrees with the independent in-domain mirror', () => {
    for (const n of [0, 1, 2, 255, 256, 258, 65535, 70000, 0x12345678, 0xfffffffe]) {
      expect(hexOf(u32BE(n)), `n=${n}`).toBe(hexOf(u32BEMirror(n)));
    }
  });

  it('is total: out-of-domain input takes the sentinel rather than throwing', () => {
    // M-5 no-panic contract. Light clients derive ids from attacker-supplied
    // fields, so a throw here is a denial-of-service, not a validation error.
    const bad: number[] = [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (const n of bad) {
      expect(() => u32BE(n), `n=${n}`).not.toThrow();
      expect(hexOf(u32BE(n)), `n=${n}`).toBe('ffffffff');
    }
    // The typeof guard, reachable only from untyped callers (JS, JSON).
    for (const n of [undefined, null, '7', {}]) {
      expect(hexOf(u32BE(n as unknown as number)), `n=${String(n)}`).toBe('ffffffff');
    }
  });

  it('excludes the sentinel from the encodable domain', () => {
    // Why a well-formed selector can never collide with a malformed one:
    // 0xffffffff is not itself encodable, so nothing valid produces those bytes.
    expect(hexOf(u32BE(0xffffffff))).toBe('ffffffff');
    expect(hexOf(u32BE(0xffffffff))).toBe(hexOf(u32BE(-1)));
  });

  it('always returns exactly 4 bytes', () => {
    for (const n of [0, 1, 0xfffffffe, -1, NaN, 2 ** 32]) {
      expect(u32BE(n).length, `n=${n}`).toBe(4);
    }
  });

  it('is the writer the coinbase and genesis SUBJECTS actually use', () => {
    // Pins the export against a frozen vector rather than against itself. It is
    // also the only remaining path by which a `u32BE` reaches an id at all: the
    // bytes go in as `subject`, opaque to `computeMintTxId`.
    expect(computeMintTxId(70000, 'coinbase', u32BE(0))).toBe(GOLDEN_MINT_COINBASE_ID);
  });

  it('nothing in this package hashes a u32BE any more', () => {
    // The 2a-ii pin, stated as a property rather than left to inspection: if
    // someone reintroduces `u32BE` into a preimage written here, the value it
    // encodes will move an id and this stays green — so what is asserted is the
    // positive replacement instead. `index` is `vlqU`, one byte for 0, where a
    // `u32BE` would have contributed four.
    const a = computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0);
    const h = createHash('blake2b512');
    h.update(BOX_ID_DOMAIN);
    h.update(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE));
    h.update(Buffer.from(GOLDEN_TX_ID, 'hex'));
    h.update(Buffer.from([0]));                    // vlqU(0) — one byte
    expect(h.digest().subarray(0, 32).toString('hex')).toBe(a);
    // …and the four-byte form is NOT what it computes.
    const withU32 = createHash('blake2b512');
    withU32.update(BOX_ID_DOMAIN);
    withU32.update(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE));
    withU32.update(Buffer.from(GOLDEN_TX_ID, 'hex'));
    withU32.update(u32BE(0));
    expect(withU32.digest().subarray(0, 32).toString('hex')).not.toBe(a);
  });
});

describe('computeCandidateBoxId', () => {
  it('golden vector: karma box at (GOLDEN_TX_ID, 0) is frozen', () => {
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_TX_ID, 0)).toBe(GOLDEN_CANDIDATE_KARMA_ID);
  });

  it('golden vector: credit box at (GOLDEN_TX_ID, 1) is frozen', () => {
    expect(computeCandidateBoxId(GOLDEN_CREDIT_BOX, GOLDEN_TX_ID, 1)).toBe(GOLDEN_CANDIDATE_CREDIT_ID);
  });

  it('returns 64-char lowercase hex', () => {
    const id = computeCandidateBoxId(makeKarmaBox(), GOLDEN_TX_ID, 0);
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('is deterministic', () => {
    const c = makeKarmaBox();
    expect(computeCandidateBoxId(c, GOLDEN_TX_ID, 0)).toBe(computeCandidateBoxId(c, GOLDEN_TX_ID, 0));
  });

  // --- provenance sensitivity: the whole point of the scheme ---

  it('same candidate, different txId → different id', () => {
    const c = makeKarmaBox();
    const a = computeCandidateBoxId(c, GOLDEN_TX_ID, 0);
    const b = computeCandidateBoxId(c, '2'.repeat(64), 0);
    expect(a).not.toBe(b);
  });

  it('same candidate and txId, different index → different id', () => {
    // Kills the mutation that drops `index` from the preimage — which is what
    // makes two byte-identical outputs of one transaction collide.
    const c = makeKarmaBox();
    const a = computeCandidateBoxId(c, GOLDEN_TX_ID, 0);
    const b = computeCandidateBoxId(c, GOLDEN_TX_ID, 1);
    expect(a).not.toBe(b);
  });

  it('two byte-identical candidates in one tx get different ids', () => {
    const identical = makeKarmaBox();
    const ids = [0, 1, 2].map((i) => computeCandidateBoxId(identical, GOLDEN_TX_ID, i));
    expect(new Set(ids).size).toBe(3);
  });

  it('IS computeBoxId — one derivation, not two', () => {
    // `computeBoxId(box)` is defined as
    // `computeCandidateBoxId(box, box.txId, box.index)` — one derivation, so
    // the two can never be confusable rather than merely happening to agree.
    //
    // This is the property the whole design turns on — a creator predicting an id
    // before the box exists and a verifier re-deriving it from the stored box
    // must run the *same* function, or "predictable" and "honest" are two
    // different ids again.
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(
      computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0),
    );
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(
      computeCandidateBoxId(GOLDEN_CREDIT_CANDIDATE, GOLDEN_TX_ID, 1),
    );
  });

  it('a stored box re-derives its own id — honesty is structural', () => {
    // M-11 stated as an invariant: `stored.id === computeBoxId(stored)`. Under
    // the content hash this could not hold once apply mutated `createdAtBlock`.
    for (const [candidate, index] of [
      [GOLDEN_KARMA_CANDIDATE, 0],
      [GOLDEN_CREDIT_CANDIDATE, 1],
    ] as const) {
      const id = computeCandidateBoxId(candidate, GOLDEN_TX_ID, index);
      const stored = { ...candidate, txId: GOLDEN_TX_ID, index, id };
      expect(computeBoxId(stored)).toBe(stored.id);
    }
  });

  it('hashes txId as 32 RAW bytes, and an uppercase spelling has no encoding', () => {
    // The inversion of the pre-2a-ii test, which compared `ab…` against `AB…`
    // and asserted they stayed DISTINCT — the point being that hashing the hex
    // text avoided a decode collapsing them onto one id.
    //
    // `b32(txId)` answers the same question one layer better: it accepts
    // lowercase only, so an uppercase txId has no encoding at all rather than
    // an encoding shared with its lowercase twin. The collision is removed, not
    // tolerated, and the id shrinks from 64 bytes of text to 32 raw.
    const c = makeKarmaBox();
    const lower = 'ab'.repeat(32);
    const upper = 'AB'.repeat(32);
    expect(computeCandidateBoxId(c, lower, 0)).toHaveLength(64);
    expect(() => computeCandidateBoxId(c, upper, 0)).toThrow(/64 lowercase hex chars/);
    // The domain that makes that throw unreachable in production: every txId
    // reaching here is a `.toString('hex')` output of `computeTxId` or
    // `computeMintTxId`, so it is 64 lowercase hex by construction.
    expect(computeCandidateBoxId(c, computeTxId(GOLDEN_TX), 0)).toHaveLength(64);
  });

  it('does not throw on an unencodable index (M-5 no-panic)', () => {
    // Total, in post.ts's shape: out-of-domain numbers take the sentinel rather
    // than turning id derivation into a panic on untrusted input.
    const c = makeKarmaBox();
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => computeCandidateBoxId(c, GOLDEN_TX_ID, bad)).not.toThrow();
      expect(computeCandidateBoxId(c, GOLDEN_TX_ID, bad)).toHaveLength(64);
    }
  });
});

/**
 * `boxRecordBytes` — the box-with-provenance encoding (TYPES_INTERFACE →
 * Layout — Boxes).
 *
 * These are exactly the bytes node's AVL value holds, and `computeCandidateBoxId`
 * hashes the same function's output, so the two cannot drift. A second copy of
 * this layout in `node` would be a second implementation of a consensus
 * preimage; these tests are what keeps that from being a promise in a comment.
 *
 * The first two are the ones with teeth: they fail if either function's bytes
 * move, and they keep failing if anyone edits one of the two without the other.
 */
describe('boxRecordBytes', () => {
  it('IS the preimage computeCandidateBoxId hashes — one encoding, not two', () => {
    // The anti-drift pin. Not a restatement of the implementation: it hashes
    // through `createHash` here, so a change to either function alone breaks it.
    for (const [candidate, index] of [
      [GOLDEN_KARMA_CANDIDATE, 0],
      [GOLDEN_CREDIT_CANDIDATE, 1],
      [makeInviteBox(), 7],
      [makeBondBox(), 2],
    ] as const) {
      const expected = createHash('blake2b512')
        .update(BOX_ID_DOMAIN)
        .update(boxRecordBytes(candidate, GOLDEN_TX_ID, index))
        .digest()
        .subarray(0, 32)
        .toString('hex');
      expect(computeCandidateBoxId(candidate, GOLDEN_TX_ID, index)).toBe(expected);
    }
  });

  it('is canonicalBoxBytes ‖ b32(txId) ‖ vlqU(index), assembled independently', () => {
    // The layout, built from its three named parts rather than read off the
    // function. `index` is `vlqU`, so 0 is one byte and 128 is two — the second
    // case is what would survive a mutation to a fixed-width writer.
    for (const index of [0, 1, 127, 128]) {
      const parts = Buffer.concat([
        Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE)),
        Buffer.from(GOLDEN_TX_ID, 'hex'),
        index < 128 ? Buffer.from([index]) : Buffer.from([(index & 0x7f) | 0x80, index >> 7]),
      ]);
      expect(Buffer.from(boxRecordBytes(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, index)).toString('hex'))
        .toBe(parts.toString('hex'));
    }
  });

  it('golden vector: the karma record at (GOLDEN_TX_ID, 0) is frozen', () => {
    // These bytes are committed into `stateRoot` as the AVL value, so freeze
    // them here — where the encoder lives — rather than only at the consumer.
    const frozen =
      GOLDEN_KARMA_BOX_BYTES +                                             // boxContentBytes
      '0d72f28245bf0c9dcb1b458641dae9b08e711da5fc45a8dd78e8562de9ae0291' + // b32 txId
      '00';                                                                // vlqU(0)
    expect(Buffer.from(boxRecordBytes(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0)).toString('hex'))
      .toBe(frozen);
  });

  it('provenance is appended, never folded into the content bytes', () => {
    // The split the two-encoding naming exists to make structural: the record
    // starts with the content bytes verbatim, so `computeBoxId` and the AVL
    // value cannot disagree about where content ends and provenance begins.
    const content = canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE);
    const record = boxRecordBytes(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0);
    expect(Buffer.from(record.subarray(0, content.length))).toEqual(Buffer.from(content));
    expect(record.length).toBe(content.length + 32 + 1);
  });

  it('carries the id derivation’s totality split unchanged', () => {
    // `b32(txId)` throws, `vlqU(index)` sentinels. Pinned on the extracted
    // function directly: the id derivation's own version of this test would
    // stay green if the throw moved to the hashing wrapper.
    expect(() => boxRecordBytes(GOLDEN_KARMA_CANDIDATE, 'AB'.repeat(32), 0))
      .toThrow(/64 lowercase hex chars/);
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => boxRecordBytes(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, bad)).not.toThrow();
    }
  });
});

/**
 * `boxRecordFromBytes` — the reader half, and why the pair matters.
 *
 * A writer with no reader is what lets a format acquire a second definition:
 * node's AVL store has to parse these bytes back, and a reader written there
 * would be a second statement of the box layout in a second package. The
 * round-trip below is strictly stronger than the frozen vector above — a frozen
 * vector can stay green while the two sides disagree about a field they both
 * skip, and this cannot.
 */
describe('boxRecordFromBytes', () => {
  /**
   * One candidate per box type, each exercising a field the others do not.
   *
   * Named for what the list IS rather than for how long it is — a count in the
   * name is false the first time a box type is added, and the name is not what
   * the compiler checks.
   */
  const ALL_BOX_TYPES: [string, AnyBoxCandidate][] = [
    ['karma (opt absent)', GOLDEN_KARMA_CANDIDATE],
    ['karma (opt present)', { ...GOLDEN_KARMA_CANDIDATE, decayBurn: true }],
    ['credit (opt absent)', GOLDEN_CREDIT_CANDIDATE],
    ['credit (opt present)', { ...GOLDEN_CREDIT_CANDIDATE, lockedUntilBlock: 4096 }],
    ['invite', {
      boxType: 'invite', value: 0n, inviterId: inviter,
      inviteePublicKey: new Uint8Array(32).fill(0xcc),
    }],
    // The same trailing fields under the other tag, at a value an invite never
    // carries. Both rows are here because the pair is one layout with two tags:
    // a reader that walked the bond arm as an invite would round-trip fine on
    // the fields and fail only on the discriminant.
    ['bond', {
      boxType: 'bond', value: 20n, inviterId: inviter,
      inviteePublicKey: new Uint8Array(32).fill(0xcc),
    }],
    ['post_lock', {
      boxType: 'post_lock', value: 5n, originalValue: 10n, owner,
    }],
    ['vouch', { boxType: 'vouch', value: 1n, voucherId: owner, targetId: inviter }],
    ['genesis_proof', makeProofCandidate(PROOF_PAYLOAD)],
    ['genesis_proof (empty payload)', makeProofCandidate(new Uint8Array(0))],
    // The empty-tail rows. A reader that assumed at least one field followed
    // the shared prefix would fail here and nowhere else — every other row
    // above walks a tail, so nothing in this list exercises a box that ends at
    // the prefix except these four.
    ['emission', EMISSION_CANDIDATE],
    ['treasury', TREASURY_CANDIDATE],
    ['fee', FEE_CANDIDATE],
    // At its genesis value rather than at the shared 100: the pool's ordinary
    // state is `BOX_VALUE_BOUND - 1` (TYPES_INTERFACE → KarmaPoolBox), so the
    // row that round-trips is the one carrying the nine-byte value.
    ['karma_pool', { boxType: 'karma_pool', value: BOX_VALUE_BOUND - 1n }],
  ];

  for (const [label, candidate] of ALL_BOX_TYPES) {
    it(`round-trips ${label}`, () => {
      // The candidate goes in whole and comes back whole — every field is
      // compared, with nothing dropped from either side of the expectation.
      const decoded = boxRecordFromBytes(boxRecordBytes(candidate, GOLDEN_TX_ID, 3));
      expect(decoded).toEqual({ candidate, txId: GOLDEN_TX_ID, index: 3 });
    });
  }

  it('re-encoding a decoded record reproduces the bytes exactly', () => {
    // The other direction of the same claim, at byte level. `toEqual` on the
    // value could pass while a field the reader ignores rides along in the
    // bytes; this cannot.
    for (const [, candidate] of ALL_BOX_TYPES) {
      const bytes = boxRecordBytes(candidate, GOLDEN_TX_ID, 3);
      const back = boxRecordFromBytes(bytes);
      expect(Buffer.from(boxRecordBytes(back.candidate as BoxCandidate, back.txId, back.index)))
        .toEqual(Buffer.from(bytes));
    }
  });

  it('carries the four-part boundary check, not just a parse', () => {
    const bytes = boxRecordBytes(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0);

    // 2 — trailing bytes are a rejection, not slack.
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => boxRecordFromBytes(trailing)).toThrow(CodecError);
    try { boxRecordFromBytes(trailing); } catch (e) {
      expect((e as CodecError).failure).toBe('trailing-bytes');
    }

    // 3 — a non-minimal VLQ decodes to the same value and re-encodes shorter.
    // `index` is the last field, so padding it is the cleanest instance: `81 00`
    // and `00` are both zero, and only the compare tells them apart.
    const nonMinimal = new Uint8Array(bytes.length + 1);
    nonMinimal.set(bytes.subarray(0, bytes.length - 1));
    nonMinimal.set([0x80, 0x00], bytes.length - 1);
    try { boxRecordFromBytes(nonMinimal); } catch (e) {
      expect((e as CodecError).failure).toBe('non-canonical');
    }

    // 1 — truncation is wire's own rejection, not a boundary-check one.
    expect(() => boxRecordFromBytes(bytes.subarray(0, bytes.length - 5))).toThrow(ReaderError);

    // 1 — the reserved sentinel tag and every unassigned boxType have no
    // decoding at all: the tag reader refuses them, so nothing after the tag is
    // read.
    //
    // The unassigned tag is **derived** from `BOX_TYPE_TAGS` rather than
    // written down, so it follows every future box type with no edit here. The
    // reject vector in `test/golden/boxes.json` names its number literally, and
    // must: a golden corpus deriving its input from the code under test checks
    // nothing.
    //
    // ⚠ **`not.toBeInstanceOf(CodecError)` is half the assertion.** An
    // *assigned* tag swapped in here throws too — on the fields it then
    // misreads — and `CodecError` extends `ReaderError` carrying
    // `code: 'invalid-tag'` whatever its `failure` is, so the code alone cannot
    // tell "this tag has no decoding" from "this tag decodes, into something
    // else, and the boundary check caught the remainder". Only the class
    // separates them. `golden.test.ts`' reject runner splits the two the same
    // way.
    const FIRST_UNASSIGNED_BOX_TAG = Math.max(...Object.values(BOX_TYPE_TAGS)) + 1;
    for (const tag of [FIRST_UNASSIGNED_BOX_TAG, 0xff]) {
      const badTag = bytes.slice();
      badTag[0] = tag;
      let thrown: unknown;
      try {
        boxRecordFromBytes(badTag);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `tag ${tag}`).toBeInstanceOf(ReaderError);
      expect(thrown, `tag ${tag}`).not.toBeInstanceOf(CodecError);
      expect((thrown as ReaderError).code, `tag ${tag}`).toBe('invalid-tag');
    }
  });
});

describe('computeMintTxId', () => {
  it('golden vector: coinbase mint is frozen', () => {
    expect(computeMintTxId(70000, 'coinbase', u32BEMirror(0))).toBe(GOLDEN_MINT_COINBASE_ID);
  });

  it('golden vector: decay mint (subject = owner key) is frozen', () => {
    expect(computeMintTxId(70000, 'decay', GOLDEN_OWNER)).toBe(GOLDEN_MINT_DECAY_ID);
  });

  it('varies with height, reason and subject independently', () => {
    const base = computeMintTxId(70000, 'decay', GOLDEN_OWNER);
    expect(computeMintTxId(70001, 'decay', GOLDEN_OWNER)).not.toBe(base);
    expect(computeMintTxId(70000, 'genesis', GOLDEN_OWNER)).not.toBe(base);
    expect(computeMintTxId(70000, 'decay', new Uint8Array(32).fill(0xff))).not.toBe(base);
  });

  it('separates like-payout from postlock-unlock for the same subject bytes', () => {
    // The reason tag is the only separator when two same-height mints share
    // subject bytes — the accrual payout and a lock vesting unlock both land on
    // an author in one block's settlement.
    const subject = new Uint8Array(32).fill(0x11);
    expect(computeMintTxId(70000, 'like-payout', subject))
      .not.toBe(computeMintTxId(70000, 'postlock-unlock', subject));
  });

  it('every reason derives a distinct mint id for the same subject', () => {
    // Widening the set must not let a new tag land on an existing mint id.
    const subject = new Uint8Array(96).fill(0x33);
    const ids = ALL_MINT_REASONS.map((r) => computeMintTxId(70000, r, subject));
    expect(new Set(ids).size).toBe(ALL_MINT_REASONS.length);
  });

  it('golden vector: the WHOLE reason tag table is frozen', () => {
    // The reason is an `enum8` tag, so the thing to catch is a RENUMBER — and
    // "every reason derives a distinct mint id" is renumber-BLIND, since a
    // permutation keeps them all distinct. One frozen id per member is what
    // makes swapping two tags fail instead of silently changing consensus.
    //
    // Coverage of the union is a compile-time property of the goldens' type,
    // not an assertion here (→ `MINT_REASON_GOLDENS`).
    for (const [reason, id] of Object.entries(MINT_REASON_GOLDENS)) {
      expect(computeMintTxId(MINT_GOLDEN_HEIGHT, reason as MintReason, MINT_GOLDEN_SUBJECT), reason)
        .toBe(id);
    }
  });

  it('cross-reason injectivity is STRUCTURAL — the names are not prefix-free, and it does not matter', () => {
    // `enum8(reason)` is one byte from a closed table, so injectivity across
    // reasons is a property of the ENCODING and never of the names. This is
    // where a return to a text reason encoding would be noticed, and the set
    // carries a witness that such an encoding would be ambiguous.
    const subject = new Uint8Array(8).fill(0x77);
    // The reason contributes exactly one byte, between the height and the
    // subject's length prefix: vlqU(1) ‖ enum8(reason) ‖ lp(subject).
    const ids = ALL_MINT_REASONS.map((r) => computeMintTxId(1, r, subject));
    expect(new Set(ids).size).toBe(ALL_MINT_REASONS.length);

    // The names are not prefix-free, and the witness is pinned by name:
    // `genesis` ⊏ `genesis-committee`. Both are the contract's
    // (NODE_INTERFACE → Reason and subject table), so the pair is not something
    // this set may rename its way out of.
    const prefixPairs = ALL_MINT_REASONS.flatMap((a) =>
      ALL_MINT_REASONS.filter((b) => b !== a && b.startsWith(a)).map((b) => `${a} ⊏ ${b}`),
    );
    expect(prefixPairs).toContain('genesis ⊏ genesis-committee');

    // What a text encoding does with that pair, demonstrated rather than
    // argued: `reason ‖ subject` as bare ASCII gives `genesis` over
    // `-committee ‖ X` and `genesis-committee` over `X` THE SAME BYTES. Two
    // reasons, one preimage.
    const utf8 = (s: string) => Buffer.from(s, 'utf8');
    const x = Buffer.alloc(4, 0x5a);
    const suffixed = Buffer.concat([utf8('-committee'), x]);
    expect(Buffer.concat([utf8('genesis'), suffixed]).toString('hex'))
      .toBe(Buffer.concat([utf8('genesis-committee'), x]).toString('hex'));

    // Under the encoding the format actually uses, that same pair separates on
    // the tag byte alone — the collision above has no counterpart here. This is
    // the whole of "a one-byte tag makes it structural" (→ `MINT_REASON`).
    expect(computeMintTxId(1, 'genesis', suffixed))
      .not.toBe(computeMintTxId(1, 'genesis-committee', x));
  });

  it('the reason contributes exactly one byte, from a closed table', () => {
    // The tag table's numbering is consensus-visible: a renumber moves every
    // mint txId carrying the tag and, through computeCandidateBoxId, every box
    // id minted under it. Pinned as a length delta rather than against the tag
    // values, which the goldens above already freeze.
    const shortSubject = new Uint8Array(1);
    const a = computeMintTxId(1, 'coinbase', shortSubject);
    const b = computeMintTxId(1, 'prune-refund-author', shortSubject);
    expect(a).not.toBe(b);
    // An unknown reason takes enum8's reserved 0xff rather than throwing — the
    // no-panic property, preserved through the encoding change.
    const bogus = 'not-a-reason' as MintReason;
    expect(() => computeMintTxId(1, bogus, shortSubject)).not.toThrow();
    expect(computeMintTxId(1, bogus, shortSubject)).not.toBe(a);
  });

  it('the subject is length-prefixed, so its encoding no longer has to be self-delimiting', () => {
    // The old preimage appended `subject` raw, which is why NODE_INTERFACE's
    // reason/subject table carried a standing obligation: every per-reason
    // encoding had to be fixed-length or self-delimiting, or two subjects under
    // one reason could concatenate identically. `lp(subject)` discharges it.
    const one = computeMintTxId(1, 'decay', new Uint8Array([1]));
    const two = computeMintTxId(1, 'decay', new Uint8Array([1, 0]));
    expect(one).not.toBe(two);
    // Still total on a non-byte-view subject: the length prefix takes the
    // sentinel rather than throwing.
    expect(() => computeMintTxId(1, 'decay', undefined as unknown as Uint8Array)).not.toThrow();
  });

  it('the two empty-subject reasons separate from each other and from an empty-subject peer', () => {
    // `emission-release` and `treasury-accrue` carry no subject, so the tag byte
    // is the whole separator between them at one height — including against a
    // reason whose subject merely happens to be empty in this call.
    const empty = new Uint8Array(0);
    const ids = (['emission-release', 'treasury-accrue', 'coinbase'] as const)
      .map((r) => computeMintTxId(70000, r, empty));
    expect(new Set(ids).size).toBe(3);
  });

  it('an empty-subject reason still separates heights', () => {
    // The property the empty subject rests on. With nothing to discriminate
    // inside a reason, the height is the only thing left, and exactly one
    // emission successor and one treasury successor exist per height
    // (NODE_INTERFACE → Reason and subject table).
    const empty = new Uint8Array(0);
    for (const reason of ['emission-release', 'treasury-accrue'] as const) {
      const heights = [0, 1, 2, 70000];
      const ids = heights.map((h) => computeMintTxId(h, reason, empty));
      expect(new Set(ids).size, reason).toBe(heights.length);
    }
  });

  it('an empty subject encodes as a zero LENGTH, not as an absence', () => {
    // Recomputed from the layout rather than from the function under test:
    // MINT_ID_DOMAIN ‖ vlqU(height) ‖ enum8(reason) ‖ lp(subject). At height 1
    // with an empty subject that is three bytes — 0x01, the tag, and a zero
    // length — so the tag numbers are pinned here independently of the goldens.
    const mirror = (tail: number[]) =>
      createHash('blake2b512')
        .update(Buffer.from(MINT_ID_DOMAIN))
        .update(Buffer.from(tail))
        .digest()
        .subarray(0, 32)
        .toString('hex');

    const empty = new Uint8Array(0);
    expect(computeMintTxId(1, 'emission-release', empty)).toBe(mirror([0x01, 0x0b, 0x00]));
    expect(computeMintTxId(1, 'treasury-accrue', empty)).toBe(mirror([0x01, 0x0c, 0x00]));

    // Drop the length byte and the id moves: present-and-empty is not absent,
    // which is what keeps the subject self-delimiting at width zero.
    expect(computeMintTxId(1, 'emission-release', empty)).not.toBe(mirror([0x01, 0x0b]));
  });

  it('does not throw on an unencodable height (M-5 no-panic)', () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => computeMintTxId(bad, 'decay', GOLDEN_OWNER)).not.toThrow();
    }
  });
});

describe('domain separation', () => {
  it('the four domain tags are pairwise distinct', () => {
    const tags = [BOX_ID_DOMAIN, TX_ID_DOMAIN, MINT_ID_DOMAIN, IDENTITY_KEY_DOMAIN]
      .map((t) => Buffer.from(t).toString('hex'));
    expect(new Set(tags).size).toBe(4);
  });

  it('a mint id never equals a box id built from the same material', () => {
    // Deliberate collision attempt, not a random-input assertion: every byte the
    // box derivation consumes after its domain tag — the candidate encoding, the
    // 32 raw txId bytes and the index — is fed to the mint derivation as well.
    //
    // The two preimage tails cannot be made byte-identical anyway, and the
    // reason is now structural rather than an accident of CBOR framing: the box
    // tail opens with `enum8(boxType)`, a tag in 0..6, while the mint tail opens
    // with `vlqU(height)` and then a `MintReason` tag — and `lp(subject)`
    // length-prefixes everything after it, so a candidate encoding cannot be
    // made to line up with the mint layout at any offset. Domain tags remove
    // the question entirely, which is why they exist.
    const material = Buffer.concat([
      Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)),
      Buffer.from(GOLDEN_TX_ID, 'hex'),
    ]);
    const boxId = computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_TX_ID, 7);
    const mintId = computeMintTxId(7, 'genesis', new Uint8Array(material));
    expect(mintId).not.toBe(boxId);
  });
});

describe('transactions', () => {
  describe('domain separation (found by G3b mutation testing)', () => {
    // Dropping `TX_ID_DOMAIN` from `computeTxId` was killed ONLY by frozen
    // goldens and the UI mirror — three assertions, all of the form "this id
    // equals this constant". Nothing pinned what the tag is *for*: that box ids,
    // transaction ids, mint txIds and identity-record keys share one 32-byte
    // keyspace and must be provably disjoint (TYPES_INTERFACE → Domain tags).
    //
    // A golden catches removal only because the golden was regenerated after the
    // tag was added. These pin the property, so a future id that forgets its tag
    // fails on meaning rather than on a number someone might "fix".

    it('every domain tag is distinct', () => {
      const tags = [BOX_ID_DOMAIN, TX_ID_DOMAIN, MINT_ID_DOMAIN, IDENTITY_KEY_DOMAIN]
        .map((t) => Buffer.from(t).toString('hex'));
      expect(new Set(tags).size).toBe(tags.length);
    });

    it('no domain tag is a prefix of another', () => {
      // Same argument the MintReason set rests on: the tag is followed directly
      // by caller bytes with no length prefix, so a prefix relation would let
      // one preimage be read as another domain's.
      const tags = [BOX_ID_DOMAIN, TX_ID_DOMAIN, MINT_ID_DOMAIN, IDENTITY_KEY_DOMAIN]
        .map((t) => Buffer.from(t).toString('hex'));
      for (const a of tags) {
        for (const b of tags) {
          if (a !== b) expect(a.startsWith(b)).toBe(false);
        }
      }
    });

    it('the txId preimage is domain-tagged — independently recomputed', () => {
      // Independent mirror of `computeTxId`, in the shape `u32BEMirror` uses:
      // written from the contract's layout table (TYPES_INTERFACE → Layout —
      // UtxoTransaction) rather than by calling the function under test, so
      // removing the tag from the implementation fails HERE and not only
      // against a frozen hash.
      //
      //   TX_ID_DOMAIN ‖ arr(inputs, b32) ‖ arr(outputs, boxContentBytes)
      //                ‖ opt(preimages) ‖ vlqU(protocolVersion) ‖ opt(likeTarget)
      //                ‖ opt(post)
      const h = createHash('blake2b512');
      h.update(Buffer.from('dagsocial/tx-id/1'));
      h.update(Buffer.from([GOLDEN_TX.inputs.length]));           // arr count
      for (const input of GOLDEN_TX.inputs) h.update(Buffer.from(input, 'hex'));
      h.update(Buffer.from([GOLDEN_TX.outputs.length]));          // arr count
      for (const out of GOLDEN_TX.outputs) h.update(canonicalBoxBytes(out));
      h.update(Buffer.from([0]));                                 // opt preimages: absent
      h.update(Buffer.from([GOLDEN_TX.protocolVersion]));         // vlqU(1)
      h.update(Buffer.from([0]));                                 // opt likeTarget: absent
      h.update(Buffer.from([0]));                                 // opt post: absent
      expect(h.digest().subarray(0, 32).toString('hex')).toBe(computeTxId(GOLDEN_TX));
    });

    it('the box-id preimage is domain-tagged — independently recomputed', () => {
      // BOX_ID_DOMAIN ‖ boxRecordBytes, where
      // boxRecordBytes = canonicalBoxBytes ‖ b32(txId) ‖ vlqU(index)
      // (TYPES_INTERFACE → Layout — Boxes, D4). Written from the contract, not
      // by calling the function under test.
      const h = createHash('blake2b512');
      h.update(Buffer.from('dagsocial/box-id/1'));
      h.update(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE));
      h.update(Buffer.from(GOLDEN_TX_ID, 'hex'));   // b32 — 32 raw bytes, not 64 of text
      h.update(Buffer.from([0]));                    // vlqU(0)
      expect(h.digest().subarray(0, 32).toString('hex'))
        .toBe(computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, GOLDEN_TX_ID, 0));
    });

    it('a tx id and a box id over the same bytes cannot collide', () => {
      // The concrete reason the tags exist: without them these two derivations
      // could be fed preimages that coincide, and both keys live in one AVL
      // keyspace. With the tags they are unconditionally distinct.
      const oneOutput: UtxoTransaction = {
        inputs: [], outputs: [GOLDEN_KARMA_CANDIDATE], signatures: {}, protocolVersion: 1,
      };
      // An all-zero txId rather than the empty string this used before phase
      // 2a-ii: `b32(txId)` has no encoding for `''`. The point is unchanged —
      // two derivations fed the closest thing to identical material that each
      // one's domain permits.
      expect(computeTxId(oneOutput))
        .not.toBe(computeCandidateBoxId(GOLDEN_KARMA_CANDIDATE, '00'.repeat(32), 0));
    });
  });

  describe('computeTxId', () => {
    it('returns a 64-char hex string', () => {
      const tx: UtxoTransaction = {
        inputs: [],
        outputs: [makeKarmaBox()],
        signatures: {},
        protocolVersion: 2,
      };
      const id = computeTxId(tx);
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(64);
    });

    it('is deterministic', () => {
      const tx: UtxoTransaction = {
        inputs: [IN_1],
        outputs: [makeKarmaBox()],
        signatures: { [PUBKEY_HEX]: new Uint8Array(64) },
        protocolVersion: 2,
      };
      expect(computeTxId(tx)).toBe(computeTxId(tx));
    });

    it('changes with different inputs', () => {
      const tx1: UtxoTransaction = { inputs: [IN_1], outputs: [makeKarmaBox()], signatures: {}, protocolVersion: 2 };
      const tx2: UtxoTransaction = { inputs: [IN_2], outputs: [makeKarmaBox()], signatures: {}, protocolVersion: 2 };
      expect(computeTxId(tx1)).not.toBe(computeTxId(tx2));
    });

    it('an input id outside the b32 domain has no encoding', () => {
      // The old preimage `h.update`'d each input id as text, so `'in1'` was a
      // perfectly good box id as far as identity was concerned. Inputs are
      // `arr(ids, b32)` now; `checkTxEnvelope` pins them at 64 lowercase hex
      // before this is ever reached in production.
      const tx: UtxoTransaction = { inputs: ['in1'], outputs: [], signatures: {}, protocolVersion: 2 };
      expect(() => computeTxId(tx)).toThrow(/64 lowercase hex chars/);
    });

    it('the input list is counted, not just concatenated (P2-C row C1)', () => {
      // Concatenated back to back with no count and no length prefix, a
      // one-input and a two-input transaction could produce the same bytes.
      // `arr()`'s count byte is what makes them structurally distinct rather
      // than accidentally so.
      const one: UtxoTransaction = { inputs: [IN_1], outputs: [], signatures: {}, protocolVersion: 2 };
      const two: UtxoTransaction = { inputs: [IN_1, IN_2], outputs: [], signatures: {}, protocolVersion: 2 };
      expect(computeTxId(one)).not.toBe(computeTxId(two));
    });

    it('changes with different outputs', () => {
      const tx1: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox({ value: 100n })], signatures: {}, protocolVersion: 2 };
      const tx2: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox({ value: 200n })], signatures: {}, protocolVersion: 2 };
      expect(computeTxId(tx1)).not.toBe(computeTxId(tx2));
    });

    it('excludes output id from hash (idempotent with assigned ids)', () => {
      const tx1: UtxoTransaction = { inputs: [], outputs: [makeKarmaBox()], signatures: {}, protocolVersion: 2 };
      const id1 = computeTxId(tx1);
      // Assign an id to the output — shouldn't change tx id. Bound to a
      // variable for the same reason as above: `AnyBoxCandidate` forbids an
      // `id` key, and proving `computeTxId` STRIPS one means constructing a
      // value the candidate type does not describe.
      const outputWithId = { ...makeKarmaBox(), id: computeBoxId(makeKarmaBox()) };
      const tx2: UtxoTransaction = {
        inputs: [],
        outputs: [outputWithId],
        signatures: {},
        protocolVersion: 2,
      };
      const id2 = computeTxId(tx2);
      expect(id1).toBe(id2);
    });

    it('is unaffected by provenance set on an output', () => {
      // Outputs are hashed as *candidates*. Producers materialize outputs with
      // txId/index set (node's `materializeOutput`); if computeTxId hashed those,
      // the txId would depend on ids derived from the txId itself — circular.
      // One box encoding (canonicalBoxBytes) is what makes this hold, and
      // positionally there is no writer for provenance at all.
      const tx: UtxoTransaction = {
        inputs: [IN_1],
        outputs: [makeKarmaBox(), makeCreditBox()],
        signatures: {},
        protocolVersion: 2,
      };
      const before = computeTxId(tx);

      const materialized: UtxoTransaction = {
        ...tx,
        outputs: tx.outputs.map((o, i) => ({ ...o, id: 'f'.repeat(64), txId: before, index: i })),
      };
      expect(computeTxId(materialized)).toBe(before);
    });
  });

  describe('computeTxId with preimages', () => {
    it('includes preimages in tx hash', () => {
      const tx: UtxoTransaction = {
        inputs: [IN_1],
        outputs: [],
        signatures: {},
        preimages: { [IN_1]: new Uint8Array([1, 2, 3]) },
        protocolVersion: 1,
      };
      const id1 = computeTxId(tx);

      const tx2: UtxoTransaction = {
        ...tx,
        preimages: { [IN_1]: new Uint8Array([4, 5, 6]) },
      };
      const id2 = computeTxId(tx2);

      expect(id1).not.toBe(id2);
    });

    it('sorts preimage keys for determinism, whatever order they were built in', () => {
      // The normative sort **ratifies** what this function already did
      // (`Object.keys().sort()`) rather than changing it — keys are lowercase
      // hex, so sorting the strings and sorting the decoded bytes agree. It is
      // load-bearing all the same: without it one transaction has two
      // encodings, which is the malleability the whole format exists to close.
      const forward: UtxoTransaction = {
        inputs: [IN_1, IN_2],
        outputs: [],
        signatures: {},
        preimages: { [IN_1]: new Uint8Array([1]), [IN_2]: new Uint8Array([2]) },
        protocolVersion: 1,
      };
      const reversed: UtxoTransaction = {
        ...forward,
        preimages: { [IN_2]: new Uint8Array([2]), [IN_1]: new Uint8Array([1]) },
      };
      expect(computeTxId(forward)).toBe(computeTxId(reversed));
    });

    it('a preimage is length-prefixed, so two entries cannot be re-split', () => {
      // `lp(preimage)` rather than a bare concatenation: without the prefix a
      // one-byte and a two-byte preimage under adjacent keys could be traded
      // for a two-byte and a one-byte one.
      const a: UtxoTransaction = {
        inputs: [], outputs: [], signatures: {}, protocolVersion: 1,
        preimages: { [IN_1]: new Uint8Array([1]), [IN_2]: new Uint8Array([2, 3]) },
      };
      const b: UtxoTransaction = {
        ...a,
        preimages: { [IN_1]: new Uint8Array([1, 2]), [IN_2]: new Uint8Array([3]) },
      };
      expect(computeTxId(a)).not.toBe(computeTxId(b));
    });

    it('omits preimages from hash when undefined — and an EMPTY map is now distinct', () => {
      const absent: UtxoTransaction = {
        inputs: [IN_1],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
      };
      const id = computeTxId(absent);
      expect(typeof id).toBe('string');
      expect(id.length).toBe(64);

      // An encoding that treated `preimages: {}` as truthy, iterated zero keys
      // and contributed nothing would give present-but-empty and absent the
      // identical txId. `checkTxEnvelope` rejects `{}` for exactly that reason;
      // `opt()` makes the two distinct at the encoding layer as well, so the
      // gate is not the only thing standing between them.
      const empty: UtxoTransaction = { ...absent, preimages: {} };
      expect(computeTxId(empty)).not.toBe(id);
    });
  });

  describe('computeTxId with likeTarget (P2-D)', () => {
    const TARGET_A = 'a'.repeat(64);
    const TARGET_B = 'b'.repeat(64);

    it('presence changes the txId', () => {
      const liked: UtxoTransaction = { ...GOLDEN_TX, likeTarget: TARGET_A };
      expect(computeTxId(liked)).not.toBe(computeTxId(GOLDEN_TX));
    });

    it('a relay cannot re-point a like: two targets, two txIds', () => {
      // The signature is over the TxId, so this inequality is what binds a
      // like to its post.
      const likeA: UtxoTransaction = { ...GOLDEN_TX, likeTarget: TARGET_A };
      const likeB: UtxoTransaction = { ...GOLDEN_TX, likeTarget: TARGET_B };
      expect(computeTxId(likeA)).not.toBe(computeTxId(likeB));
    });

    it('absence appends nothing: a tx without likeTarget hashes to the golden txId', () => {
      // `opt()` writes a single absent tag, so an unset `likeTarget` costs the
      // preimage one byte in a fixed position and the golden pin covers it.
      expect(computeTxId(GOLDEN_TX)).toBe(GOLDEN_TX_ID);
    });

    it('the tail contribution is opt(b32) after protocolVersion — independently recomputed', () => {
      // Mirror written from the contract text (TYPES_INTERFACE → Layout —
      // UtxoTransaction), not by calling the function under test: a golden
      // regenerated from the implementation pins nothing.
      //
      // Presence is `opt()`'s 0/1 tag — a byte, not an in-band string like an
      // ASCII `like:` marker that would have to be unforgeable against whatever
      // its neighbouring field can encode.
      const tx: UtxoTransaction = { ...GOLDEN_TX, likeTarget: TARGET_A };
      const h = createHash('blake2b512');
      h.update(Buffer.from('dagsocial/tx-id/1'));
      h.update(Buffer.from([tx.inputs.length]));
      for (const input of tx.inputs) h.update(Buffer.from(input, 'hex'));
      h.update(Buffer.from([tx.outputs.length]));
      for (const out of tx.outputs) h.update(canonicalBoxBytes(out));
      h.update(Buffer.from([0]));                       // opt preimages: absent
      h.update(Buffer.from([tx.protocolVersion]));      // vlqU(1)
      h.update(Buffer.from([1]));                       // opt likeTarget: present
      h.update(Buffer.from(TARGET_A, 'hex'));           // b32 — raw, not hex text
      h.update(Buffer.from([0]));                       // opt post: absent
      expect(computeTxId(tx)).toBe(h.digest().subarray(0, 32).toString('hex'));
    });

    it('an empty-string likeTarget is out of domain, not a silent absence', () => {
      // The old code took care to distinguish `''` from absence with a
      // `!== undefined` check, because `h.update('')` appends nothing. `opt()`
      // preserves the distinction structurally and `b32` removes the input:
      // an empty target has no encoding at all.
      expect(() => computeTxId({ ...GOLDEN_TX, likeTarget: '' }))
        .toThrow(/64 lowercase hex chars/);
    });

    it('likeTarget rides encodeTx/decodeTx and the id survives the round-trip', () => {
      // Like txs ride `utxoTxs` as CBOR like any other transaction; a wire
      // codec that dropped the field would re-derive a different id after
      // decode, and the signature over the original id would stop verifying.
      const tx: UtxoTransaction = { ...GOLDEN_TX, likeTarget: TARGET_A };
      const decoded = decodeTx(encodeTx(tx));
      expect(decoded.likeTarget).toBe(TARGET_A);
      expect(computeTxId(decoded)).toBe(computeTxId(tx));
    });
  });

  describe('like constants (P2-D)', () => {
    it('LIKE_KARMA_COST is 1n — a karma amount, so bigint', () => {
      expect(typeof LIKE_KARMA_COST).toBe('bigint');
      expect(LIKE_KARMA_COST).toBe(1n);
    });

    it('LIKES_PER_KARMA_PAYOUT is 5 — a count, so number', () => {
      expect(typeof LIKES_PER_KARMA_PAYOUT).toBe('number');
      expect(LIKES_PER_KARMA_PAYOUT).toBe(5);
    });
  });

  describe('INVITE constants', () => {
    it('INVITE_KARMA_AMOUNT is 25n', () => {
      expect(INVITE_KARMA_AMOUNT).toBe(25n);
    });

    it('INVITE_BOND_KARMA is 25n', () => {
      expect(INVITE_BOND_KARMA).toBe(25n);
    });
  });
});

// ---------------------------------------------------------------------------
// selectBoxes
// ---------------------------------------------------------------------------

describe('selectBoxes', () => {
  it('returns single box when value equals required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 5n, id: 'a' }];
    const result = selectBoxes(boxes, 5n);
    expect(result).toEqual([{ value: 5n, id: 'a' }]);
  });

  it('returns single box when value exceeds required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10n, id: 'a' }];
    const result = selectBoxes(boxes, 5n);
    expect(result).toEqual([{ value: 10n, id: 'a' }]);
  });

  it('selects largest-first to cover required amount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
      { value: 10n, id: 'small' },
    ];
    // 100 covers 80 alone — largest-first picks just the big one
    const result = selectBoxes(boxes, 80n);
    expect(result).toEqual([{ value: 100n, id: 'big' }]);
  });

  it('selects multiple boxes when one is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
      { value: 10n, id: 'small' },
    ];
    // 150 needs big (100) + med (50)
    const result = selectBoxes(boxes, 150n);
    expect(result).toEqual([
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
    ]);
  });

  it('selects all boxes when needed', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 100n, id: 'big' },
      { value: 50n, id: 'med' },
      { value: 10n, id: 'small' },
    ];
    const result = selectBoxes(boxes, 160n);
    expect(result).toEqual(boxes);
  });

  it('throws when total is insufficient', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [
      { value: 10n, id: 'a' },
      { value: 5n, id: 'b' },
    ];
    expect(() => selectBoxes(boxes, 20n)).toThrow('Insufficient total value');
  });

  it('throws on empty boxes with positive requiredAmount', async () => {
    const { selectBoxes } = await import('../src/index.js');
    expect(() => selectBoxes([], 1n)).toThrow('Insufficient total value');
  });

  it('returns empty array for requiredAmount of 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const boxes = [{ value: 10n, id: 'a' }];
    const result = selectBoxes(boxes, 0n);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty boxes and requiredAmount 0', async () => {
    const { selectBoxes } = await import('../src/index.js');
    const result = selectBoxes([], 0n);
    expect(result).toEqual([]);
  });
});

/**
 * The box-type mapping this package is the single source of.
 *
 * `BOX_TYPE_TAGS` is the numbering inside every box's id preimage, and it is
 * exported because other packages hold the same mapping. A wrong tag moves every
 * box id and every `stateRoot` covering it, loudly and everywhere.
 */
describe('the box-type tables', () => {
  const CANDIDATE_BY_TYPE: Record<BoxCandidate['boxType'], AnyBoxCandidate> = {
    karma: { boxType: 'karma', value: 100n, owner },
    credit: { boxType: 'credit', value: 500n, owner },
    invite: {
      boxType: 'invite', value: 0n, inviterId: inviter,
      inviteePublicKey: new Uint8Array(32).fill(0xcc),
    },
    genesis_proof: {
      boxType: 'genesis_proof', value: 0n, payload: new Uint8Array([1, 2, 3]),
    },
    bond: {
      boxType: 'bond', value: 20n, inviterId: inviter,
      inviteePublicKey: new Uint8Array(32).fill(0xcc),
    },
    post_lock: {
      boxType: 'post_lock', value: 5n, originalValue: 10n, owner,
    },
    vouch: { boxType: 'vouch', value: 1n, voucherId: owner, targetId: inviter },
    // The arms with no trailing fields at all — the rows that make this map
    // exercise a box whose bytes stop after the shared prefix.
    emission: { boxType: 'emission', value: 100n },
    treasury: { boxType: 'treasury', value: 100n },
    fee: { boxType: 'fee', value: 100n },
    karma_pool: { boxType: 'karma_pool', value: 100n },
  };

  // The table IS the numbering the encoder writes rather than a restatement of
  // it — the first byte of a box's identity preimage is its tag. A table
  // agreeing with the contract but not with `canonicalBoxBytes` would be exactly
  // the second copy this export exists to remove.
  it('is the numbering canonicalBoxBytes actually writes', () => {
    for (const [boxType, tag] of Object.entries(BOX_TYPE_TAGS)) {
      const candidate = CANDIDATE_BY_TYPE[boxType as BoxCandidate['boxType']];
      expect(canonicalBoxBytes(candidate)[0]).toBe(tag);
    }
  });

  // `enum8`'s domain: `0xff` is the reserved out-of-domain sentinel, so a table
  // claiming it would let a malformed box encode as a well-formed one. A
  // duplicate tag is an `enum8` construction throw and not a type error, which
  // is why injectivity is checked here rather than left to the compiler.
  it('assigns each type a distinct tag inside enum8s domain', () => {
    const tags = Object.values(BOX_TYPE_TAGS);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) {
      expect(Number.isInteger(tag)).toBe(true);
      expect(tag).toBeGreaterThanOrEqual(0);
      expect(tag).toBeLessThanOrEqual(0xfe);
    }
  });

  // The table pinned whole. A renumber moves every id covering the tag, so it
  // may not happen quietly.
  it('pins the table', () => {
    expect({ ...BOX_TYPE_TAGS }).toEqual({
      karma: 0, credit: 1, invite: 2, genesis_proof: 3, bond: 4, post_lock: 5, vouch: 6,
      emission: 7, treasury: 8, fee: 9, karma_pool: 10,
    });
  });

  // A single source a consumer can write to is not one. `Object.freeze` is the
  // runtime half of what `as const` states in the type.
  it('exports it frozen', () => {
    expect(Object.isFrozen(BOX_TYPE_TAGS)).toBe(true);
  });
});
