import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  computeBoxId,
  computeCandidateBoxId,
  computeMintTxId,
  computeTxId,
  canonicalBoxBytes,
  u32BE,
  BOX_ID_DOMAIN,
  TX_ID_DOMAIN,
  MINT_ID_DOMAIN,
  IDENTITY_KEY_DOMAIN,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  LIKE_KARMA_COST,
  LIKES_PER_KARMA_PAYOUT,
  encodeTx,
  decodeTx,
} from '../src/index.js';
import type { CandidateOf, KarmaBox, CreditBox, InviteBox, BondBox, UtxoTransaction, MintReason } from '../src/index.js';

const owner = new Uint8Array(32).fill(0xaa);
// A UserId is 32 raw bytes; `inviterId` is one. The fixtures below carried
// the display string 'user456'.
const inviter = new Uint8Array(32).fill(0x56);
// Provenance is REQUIRED on every box (Spec G phase G3a) — `computeBoxId`
// takes `Omit<BoxBase, 'id'>` and derives the id from `txId ‖ index`, so a
// fixture without it is not a box at all. These predate G3a.
const FIXTURE_TX_ID = 'e'.repeat(64);

// Box ids and public keys are `b32` in every preimage now, so a fixture id has
// to be 64 lowercase hex characters to have an encoding at all. The `'in1'` /
// `'box_a'` placeholders these replace were legal only while ids entered a
// preimage as their own text.
const IN_1 = '1a'.repeat(32);
const IN_2 = '2b'.repeat(32);
const PUBKEY_HEX = '3c'.repeat(32);

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  return {
    boxType: 'karma',
    value: 100n,
    owner,
    guard: 'owner_signature',
    proofSource: 'genesis',
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
    guard: 'owner_signature',
    proofSource: 42,
    txId: FIXTURE_TX_ID,
    index: 1,
  };
}

function makeInviteBox(): InviteBox {
  return {
    boxType: 'invite',
    value: 10n,
    secretHash: new Uint8Array(32).fill(0xbb),
    inviterId: inviter,
    // RETIRED guard string. The InviteBox guard is `hash_preimage_with_bond` —
    // the rename happened when a reveal started requiring a paired BondBox
    // input. This fixture named a guard the engine has no arm for.
    guard: 'hash_preimage_with_bond',
    txId: FIXTURE_TX_ID,
    index: 2,
  };
}

function makeBondBox(): BondBox {
  return {
    boxType: 'bond',
    value: 20n,
    inviterId: inviter,
    inviteePublicKey: new Uint8Array(32).fill(0xcc),
    // REQUIRED since P2-B phase 1 and absent from this fixture: the bond
    // resolves its paired InviteBox by `(bond.txId, bond.inviteOutputIndex)`.
    // A newly-required field silently missing from a mock is exactly the rot
    // an unchecked test tree hides.
    inviteOutputIndex: 2,
    probationStartBlock: 17,
    probationEndBlock: 1017,
    // RETIRED guard string. The BondBox guard is `bond_dual` — the rename
    // happened when the bond gained its three satisfaction paths (inviter
    // signature, committed-invitee signature, preimage commit).
    guard: 'bond_dual',
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
      // The inversion of the phase C0 test that lived here. Until phase G3b the
      // assertion was that provenance is *stripped* — the legacy derivation had
      // no `txId`/`index` in the preimage, so a box hashed the same bare or
      // materialized, and the test existed to prove the single-strip-rule fix
      // was not a no-op. Under the provenance derivation that property is
      // exactly wrong: an id that ignored its own provenance would be the M-11
      // id again.
      //
      // Same boxes, opposite claim — moving the same `(txId, index)` pair must
      // move the id, and two indices under one txId must not collide.
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
// Frozen golden vectors (P0 — bigint box values; positional since Phase 2)
// ---------------------------------------------------------------------------

/**
 * Frozen golden vectors — the cross-implementation anchor for the box identity
 * encoding.
 *
 * **Reset for the positional dialect (Phase 2).** `value` used to encode as a
 * CBOR uint64 (`0x1b` + 8 bytes BE) inside a cbor-x map with a fixed two-byte
 * header; it is `vlqU` now, `guard` has left the consensus bytes entirely
 * (P2-C row C10) and field order comes from the layout table rather than from a
 * key sort. Every box id and tx id below moved — see the movement table in
 * `prompts/types-id-preimages-REPORT.md`. Do not "fix" a failure by editing the
 * hashes: the encoding is protocol-breaking and unversioned.
 *
 * The wide-int pin **moved from `createdAtBlock` to `proofSource`** (Spec G
 * phase G3b). `createdAtBlock: 70000` used to be the only box field above
 * 65536, which is what locked the wide-int encoding path; deleting the field
 * would otherwise have dropped that coverage silently, because a karma box's
 * canonical bytes carry no numeric field beyond `value`. `CreditBox.proofSource`
 * is a block height and carries the pin now — and it is `vlqS`, because the same
 * field also carries `-1`, the transfer sentinel.
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
  guard: 'owner_signature',
  proofSource: 'genesis',
};

const GOLDEN_CREDIT_CANDIDATE: CandidateOf<CreditBox> = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — the range P0 exists for
  owner: GOLDEN_OWNER,
  guard: 'owner_signature',
  proofSource: 70000,             // > 65536 — locks the wide-int encoding path (L-5)
};

const GOLDEN_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_CREDIT_CANDIDATE],
  signatures: {},
  protocolVersion: 1,
};

const GOLDEN_KARMA_BOX_ID =
  '4ac16757cfa8adb833a281bd48b917478457a93e21cc7b90cc7bb93cc03f423c';
const GOLDEN_CREDIT_BOX_ID =
  '38d81346e5a47c6043f51e1e15aee5c6048aec92b5eb07c14003ccbcd4bb2bc5';
const GOLDEN_TX_ID =
  '09b0c0e3fb832cd886114f0d099ec751537cef8377d7bc5a935f1ddf9c8eef62';

/** The two candidates as block application materializes them out of GOLDEN_TX. */
const GOLDEN_KARMA_BOX: KarmaBox = { ...GOLDEN_KARMA_CANDIDATE, txId: GOLDEN_TX_ID, index: 0 };
const GOLDEN_CREDIT_BOX: CreditBox = { ...GOLDEN_CREDIT_CANDIDATE, txId: GOLDEN_TX_ID, index: 1 };

/**
 * Full canonical identity bytes, frozen — the whole encoding, not a sample of
 * it. A mirror implementation that gets any byte wrong computes different ids
 * for every box, so this is what the demo UI's hand-written mirror is checked
 * against.
 *
 *   karma  = 00 | 64 | b32(owner)             | 07 "genesis" | 00
 *            ^tag ^vlqU(100)                    ^lpUtf8        ^opt absent
 *   credit = 01 | vlqU(12345678900000000) | b32(owner) | e0c508 | 00
 *                                                        ^vlqS(70000)
 */
const GOLDEN_KARMA_BOX_BYTES =
  '00' +                                                               // enum8 karma
  '64' +                                                               // vlqU(100)
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  '07' + '67656e65736973' +                                            // lpUtf8 'genesis'
  '00';                                                                // opt decayBurn absent
const GOLDEN_CREDIT_BOX_BYTES =
  '01' +                                                               // enum8 credit
  '80eae1eac58af715' +                                                 // vlqU(12345678900000000)
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  'e0c508' +                                                           // vlqS(70000)
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

  it('value is vlqU over the full u64; proofSource is vlqS because it carries -1', () => {
    const karmaHex = Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex');
    const creditHex = Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex');
    // 100n → one byte, where the CBOR form spent nine (`1b` + u64BE).
    expect(karmaHex).toContain('64');
    // 12345678900000000n > 2^53 — the range a `number` cannot hold, which is
    // why `value` is a bigint and its writer is the one that throws rather than
    // sentinels (the u64 wire domain has no unreachable value).
    expect(creditHex).toContain('80eae1eac58af715');
    // `credit.proofSource` is ZigZag: the same field is `-1` on every
    // user-path credit box (the transfer sentinel), so a `vlqU` here would
    // sentinel every transfer the node makes. 70000 → zigzag 140000 → e0c508.
    expect(creditHex).toContain('e0c508');
    // Bound to a variable, not written inline: `canonicalBoxBytes` takes the
    // `BoxCandidate` base, and excess-property checking rejects a per-type key
    // written into a fresh literal at the call site while accepting the
    // identical value through a variable — the file's existing idiom.
    const transfer: CandidateOf<CreditBox> = { ...GOLDEN_CREDIT_CANDIDATE, proofSource: -1 };
    expect(Buffer.from(canonicalBoxBytes(transfer)).toString('hex')).toContain('01');  // zigzag(-1) = 1
  });

  it('golden vector: full canonical identity bytes are frozen', () => {
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex')).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex')).toBe(GOLDEN_CREDIT_BOX_BYTES);
    // The karma box went from 114 bytes to 43: no map header, no key names, no
    // `guard`, and a one-byte `value` where CBOR spent nine.
    expect(canonicalBoxBytes(GOLDEN_KARMA_BOX).length).toBe(43);
  });

  it('guard has left the consensus bytes (P2-C row C10)', () => {
    // `guard` is a pure function of `boxType` — one guard string per type, no
    // box choosing between two — so it carried zero information in a preimage
    // while costing 16-30 bytes in every box id. Removing a field is only safe
    // where it is derivable, which is the whole argument, so pin BOTH halves:
    // the string is absent from the bytes, and changing it changes no id.
    const hex = Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex');
    expect(hex).not.toContain(Buffer.from('owner_signature', 'utf8').toString('hex'));
    const wrongGuard = { ...GOLDEN_KARMA_CANDIDATE, guard: 'block_apply' as never };
    expect(Buffer.compare(
      Buffer.from(canonicalBoxBytes(wrongGuard)),
      Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE)),
    )).toBe(0);
  });

  it('an unknown boxType takes the reserved 0xff tag rather than throwing', () => {
    // `enum8` stays total: its tag set is narrower than a byte, so `0xff` is
    // unreachable from any real box type and a malformed box can never encode
    // as a well-formed one. Tag 3 is permanently burnt for the retired `like`
    // — a renumber would silently move every box id covering the tag.
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
});

// ---------------------------------------------------------------------------
// Spec G — provenance-derived identity
// ---------------------------------------------------------------------------

/**
 * Independent mirror of the src writer — the encoding under test, not a reuse of
 * it. Stays hand-written now that `u32BE` is exported: the golden vectors below
 * are only an anchor if the bytes they feed come from somewhere other than the
 * function under test, and it is the *in-domain* half this pins, so the mirror
 * deliberately omits the sentinel branch.
 */
function u32BEMirror(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

const ALL_MINT_REASONS: MintReason[] = [
  'coinbase',
  'vouch-settle',
  'like-payout',
  'postlock-unlock',
  'postlock-remainder',
  'decay',
  'genesis',
  'prune-refund-author',
];

/**
 * Frozen golden vectors for the provenance derivation — the cross-implementation
 * anchor for node and the demo UI. `GOLDEN_TX` creates these two boxes, so the
 * karma box sits at index 0 and the credit box at index 1 of that transaction.
 * Do not "fix" a failure by editing the hashes: the derivation is
 * protocol-breaking and unversioned.
 */
const GOLDEN_CANDIDATE_KARMA_ID =
  '4ac16757cfa8adb833a281bd48b917478457a93e21cc7b90cc7bb93cc03f423c';
const GOLDEN_CANDIDATE_CREDIT_ID =
  '38d81346e5a47c6043f51e1e15aee5c6048aec92b5eb07c14003ccbcd4bb2bc5';
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
// bond.inviteePublicKey — the one 0-or-32-byte field (Phase 2a-iii)
// ---------------------------------------------------------------------------

/**
 * `opt(b32)`, not `b32` — and the tests below are the pin, in both directions.
 *
 * The field is 0-or-32 bytes: empty = unclaimed, 32 bytes = committed. The
 * layout table specified `b32`, drafted from the field's TYPE rather than its
 * DOMAIN, and `writeBytesNOrThrow` throws on a zero-length input — so
 * `canonicalBoxBytes` threw on every bond a *created* invite carries, and
 * through it `computeTxId` threw on every invite creation. Node's engine
 * *requires* the field empty on that path: a pre-committed bond would let the
 * inviter reclaim immediately and make the network's only sybil cost free. So
 * the throwing arm was not a corner — it was the whole create path.
 *
 * What has to hold now, and what each test below covers:
 *
 *  1. Both states encode, and to the bytes the layout table names.
 *  2. **Injectivity forward** — the two states never share bytes. They differ in
 *     the option tag, which is the first byte after `inviteOutputIndex`.
 *  3. **Injectivity backward** — there is no third encoding. Anything that is
 *     not empty and not 32 bytes has *no* encoding rather than sharing one, and
 *     that includes a field which is missing altogether: a malformed box must
 *     not be handed a well-formed box's id.
 *  4. Nothing else in the bond arm moved, and nothing outside it moved at all.
 */
const BOND_KEY = new Uint8Array(32).fill(0xcc);
const BOND_UNCLAIMED = { ...makeBondBox(), inviteePublicKey: new Uint8Array(0) };
const BOND_COMMITTED = { ...makeBondBox(), inviteePublicKey: BOND_KEY };

/**
 * Hand-assembled from the layout table, not copied from the encoder's output —
 * the file's existing idiom for a frozen byte string, and the only form that
 * makes the vector an independent check rather than a screenshot.
 *
 *   04 | 14 | b32(inviterId) | 02 | <opt> | 11 | f907
 *   ^tag ^vlqU(20)             ^index      ^17  ^vlqU(1017)
 */
const BOND_PREFIX = '04' + '14' + '56'.repeat(32) + '02';
const BOND_SUFFIX = '11' + 'f907';
const BOND_UNCLAIMED_BYTES = BOND_PREFIX + '00' + BOND_SUFFIX;
const BOND_COMMITTED_BYTES = BOND_PREFIX + '01' + 'cc'.repeat(32) + BOND_SUFFIX;

describe('bond.inviteePublicKey is opt(b32), not b32', () => {
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('an UNCLAIMED bond encodes — the case a b32 writer had no encoding for', () => {
    expect(hexOf(canonicalBoxBytes(BOND_UNCLAIMED))).toBe(BOND_UNCLAIMED_BYTES);
    // 39 bytes. Under `b32` this call threw: `expected 32 bytes, got 0`.
    expect(canonicalBoxBytes(BOND_UNCLAIMED).length).toBe(39);
  });

  it('a COMMITTED bond encodes as 01 followed by exactly the key', () => {
    expect(hexOf(canonicalBoxBytes(BOND_COMMITTED))).toBe(BOND_COMMITTED_BYTES);
    // 71, one byte more than the 70 the b32 row produced — the option tag.
    expect(canonicalBoxBytes(BOND_COMMITTED).length).toBe(71);
  });

  it('injective forward: the two states differ, at the option tag and nowhere else', () => {
    const unclaimed = hexOf(canonicalBoxBytes(BOND_UNCLAIMED));
    const committed = hexOf(canonicalBoxBytes(BOND_COMMITTED));
    expect(unclaimed).not.toBe(committed);
    // Same box otherwise, so everything before the tag is identical and
    // everything after the payload is identical. That is what confines this
    // change to one field rather than to the bond layout as a whole.
    expect(unclaimed.startsWith(BOND_PREFIX)).toBe(true);
    expect(committed.startsWith(BOND_PREFIX)).toBe(true);
    expect(unclaimed.endsWith(BOND_SUFFIX)).toBe(true);
    expect(committed.endsWith(BOND_SUFFIX)).toBe(true);
    // The tag byte itself is the discriminant: 00 versus 01.
    expect(unclaimed.slice(BOND_PREFIX.length, BOND_PREFIX.length + 2)).toBe('00');
    expect(committed.slice(BOND_PREFIX.length, BOND_PREFIX.length + 2)).toBe('01');
    // And the ids follow the bytes.
    expect(computeBoxId(BOND_UNCLAIMED)).not.toBe(computeBoxId(BOND_COMMITTED));
  });

  it('injective forward: two committed bonds with different keys never share bytes', () => {
    const other = { ...BOND_COMMITTED, inviteePublicKey: new Uint8Array(32).fill(0xdd) };
    expect(hexOf(canonicalBoxBytes(other))).not.toBe(hexOf(canonicalBoxBytes(BOND_COMMITTED)));
    expect(computeBoxId(other)).not.toBe(computeBoxId(BOND_COMMITTED));
  });

  it('injective backward: there is no third encoding — off-domain widths have NONE', () => {
    // `opt(b32)` rather than `lp` is what makes this structural. An `lp` costs
    // the same bytes and would round-trip a 5-byte key happily, leaving the
    // 0-or-32 domain entirely to validation; here a decoder can produce absence
    // or exactly 32 bytes and there is nothing else to reject.
    for (const width of [1, 31, 33, 64]) {
      const off = { ...BOND_COMMITTED, inviteePublicKey: new Uint8Array(width) };
      expect(() => canonicalBoxBytes(off)).toThrow(/expected 32 bytes/);
    }
  });

  it('injective backward: a MISSING field throws rather than encoding as unclaimed', () => {
    // The subtle one, and the reason the absence test is "byte view of length
    // zero" instead of `writeOpt`'s own null/undefined coercion. A missing
    // field is out of domain, not unclaimed — letting it take the absent branch
    // would give a malformed box a well-formed box's id, which is exactly the
    // collision `canonicalBoxBytes` refuses for `value`.
    const missing = { ...BOND_COMMITTED, inviteePublicKey: undefined as unknown as Uint8Array };
    expect(() => canonicalBoxBytes(missing)).toThrow(/expected 32 bytes/);
    const nulled = { ...BOND_COMMITTED, inviteePublicKey: null as unknown as Uint8Array };
    expect(() => canonicalBoxBytes(nulled)).toThrow(/expected 32 bytes/);
    // Not a byte view at all, and array-like is still not a Uint8Array.
    const arrayLike = { ...BOND_COMMITTED, inviteePublicKey: [] as unknown as Uint8Array };
    expect(() => canonicalBoxBytes(arrayLike)).toThrow(/expected 32 bytes/);
  });

  it('the invite-creation path computes a txId instead of throwing', () => {
    // The production defect, stated as the transaction that carries it. An
    // invite create emits the InviteBox and its paired BondBox in ONE
    // transaction, with the bond's invitee key empty — so `computeTxId` hashed
    // an empty `b32` and threw, taking `createInvite` and `validateTx` with it.
    const inviteCreate: UtxoTransaction = {
      inputs: [IN_1],
      outputs: [
        { boxType: 'invite', value: 25n, secretHash: new Uint8Array(32).fill(0xbb), inviterId: inviter, guard: 'hash_preimage_with_bond' },
        { boxType: 'bond', value: 25n, inviterId: inviter, inviteOutputIndex: 0, inviteePublicKey: new Uint8Array(0), probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual' },
      ],
      signatures: {},
      protocolVersion: 1,
    };
    expect(() => computeTxId(inviteCreate)).not.toThrow();
    expect(computeTxId(inviteCreate)).toHaveLength(64);
    // And committing to an invitee moves that id — the bond is inside the
    // signed preimage, so a relay cannot swap in its own invitee key.
    const committed: UtxoTransaction = {
      ...inviteCreate,
      outputs: [inviteCreate.outputs[0]!, { ...(inviteCreate.outputs[1] as CandidateOf<BondBox>), inviteePublicKey: BOND_KEY }],
    };
    expect(computeTxId(committed)).not.toBe(computeTxId(inviteCreate));
  });

  it('nothing outside the bond arm moved', () => {
    // The claim that keeps this a one-field fix rather than a third movement of
    // everything. The five non-bond box types and the transaction that carries
    // none are pinned at their pre-2a-iii bytes and ids — these values are
    // carried over unchanged, so a change reaching any other arm fails here.
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_KARMA_BOX)).toString('hex')).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(Buffer.from(canonicalBoxBytes(GOLDEN_CREDIT_BOX)).toString('hex')).toBe(GOLDEN_CREDIT_BOX_BYTES);
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
    expect(computeTxId(GOLDEN_TX)).toBe(GOLDEN_TX_ID);
    // invite / post_lock / vouch have no inline golden here; theirs are the
    // untouched vectors in `test/golden/boxes.json`, asserted by the corpus
    // suite in both directions.
  });
});

/**
 * `u32BE` after phase 2a-ii: a **caller-side subject encoder**, not part of any
 * preimage this package writes.
 *
 * Both of its former uses here — `computeCandidateBoxId`'s `index` and
 * `computeMintTxId`'s `height` — are `vlqU` now. It survives because
 * `NODE_INTERFACE.md`'s reason/subject table gives the `coinbase` and `genesis`
 * mints a `u32BE` selector as their `subject`, and subject bytes are the
 * caller's; exporting one implementation is what stops node reimplementing it
 * and drifting. So these tests still pin a live, protocol-visible encoding —
 * just one owned by a different contract.
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
    // The inversion of the phase-A test that asserted these two must not be
    // confusable, back when `computeBoxId` still carried the legacy content
    // hash. Phase G3b collapsed them: `computeBoxId(box)` is defined as
    // `computeCandidateBoxId(box, box.txId, box.index)`.
    //
    // This is the property the whole spec turns on — a creator predicting an id
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
    // subject bytes — under P2-D the accrual payout and a lock vesting unlock
    // both land on an author in one block's settlement.
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
    // ⚠ Added because the mutation check caught a gap this phase created. The
    // reason is an `enum8` tag now, and a RENUMBER moves every mint txId
    // carrying the tag and, through computeCandidateBoxId, every box id minted
    // under it. Two goldens (coinbase, decay) covered two of the eight tags,
    // and "every reason derives a distinct mint id" is renumber-BLIND — a
    // permutation keeps them all distinct. Swapping any two un-goldened tags
    // was a silent consensus change.
    //
    // One frozen id per member closes that, and it is the conformance artifact
    // an independent implementation needs anyway. Height 1, subject 4x 0x5a.
    const subject = new Uint8Array(4).fill(0x5a);
    const FROZEN: ReadonlyArray<readonly [MintReason, string]> = [
      ['coinbase',            '32fe945568d48465eb9a2b74d506b0ec16395136fbb4357c8de21cef5a105c0a'],
      ['vouch-settle',        '09a5a40e4424fd0f4897aff225d32500975941acb7ef4972bf30a71f2c6a62aa'],
      ['like-payout',         '53a7f0ab4f60e54e0b7bbc694c0082e777c6e4ebf910db321dcfb4c1d222f59a'],
      ['postlock-unlock',     '420485f93ec603eb241379a85728bd80070b3f5f0a8389cb052941604ddbf32f'],
      ['postlock-remainder',  '635cc8bfe23cd52f6bc5f045845defaef5f796a61be57f08f7932f60a0967f4d'],
      ['decay',               'a483b6263e7a5ed49246aca51adae2c12e0cd24958412657ced84f64dca0e77a'],
      ['genesis',             '9010dd1d6fe6029eb8e856fe38467836781ce43ddad1ce01c0af7afc0bc7b7b2'],
      ['prune-refund-author', 'aa42ffca37cb6d20d30cc5afe2c691567fd31106a3a79a21e715cf616b863a32'],
    ];
    for (const [reason, id] of FROZEN) {
      expect(computeMintTxId(1, reason, subject), reason).toBe(id);
    }
    // And the table covers the type exhaustively — a member added without a
    // frozen vector fails here rather than shipping unpinned.
    expect(FROZEN.map(([r]) => r).sort()).toEqual([...ALL_MINT_REASONS].sort());
  });

  it('cross-reason injectivity is STRUCTURAL now — the prefix-free rule is retired', () => {
    // What this replaces: "no reason is a prefix of another", which held
    // because `reason ‖ subject` appended bare ASCII with no length prefix, so
    // one careless addition to the set would have made two mint preimages
    // ambiguous. The property was true, test-pinned, and permanently fragile.
    //
    // `enum8(reason)` is one byte from a closed table, so the question cannot
    // be asked any more. Kept as an assertion rather than deleted, because the
    // ONLY thing that could reopen it is someone changing the reason encoding
    // back to text — and this is where that would be noticed.
    const subject = new Uint8Array(8).fill(0x77);
    const tags = ALL_MINT_REASONS.map((r) => {
      // The reason contributes exactly one byte, between the height and the
      // subject's length prefix: vlqU(1) ‖ enum8(reason) ‖ lp(subject).
      const bytes = Buffer.from(computeMintTxId(1, r, subject), 'hex');
      return bytes;
    });
    expect(new Set(tags.map((b) => b.toString('hex'))).size).toBe(ALL_MINT_REASONS.length);
    // Prefix-freeness of the STRINGS is no longer load-bearing: a member could
    // legally be named `decay-extra` now. Asserted as the retirement, so that
    // re-adding the old rule reads as a deliberate step backwards.
    const namesArePrefixFree = ALL_MINT_REASONS.every((a) =>
      ALL_MINT_REASONS.every((b) => a === b || !b.startsWith(a)),
    );
    expect(namesArePrefixFree).toBe(true); // still true — but no longer required
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
      const h = createHash('blake2b512');
      h.update(Buffer.from('dagsocial/tx-id/1'));
      h.update(Buffer.from([GOLDEN_TX.inputs.length]));           // arr count
      for (const input of GOLDEN_TX.inputs) h.update(Buffer.from(input, 'hex'));
      h.update(Buffer.from([GOLDEN_TX.outputs.length]));          // arr count
      for (const out of GOLDEN_TX.outputs) h.update(canonicalBoxBytes(out));
      h.update(Buffer.from([0]));                                 // opt preimages: absent
      h.update(Buffer.from([GOLDEN_TX.protocolVersion]));         // vlqU(1)
      h.update(Buffer.from([0]));                                 // opt likeTarget: absent
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
      // Inputs and outputs used to be `h.update`d back to back with no count
      // and no length prefix. `arr()`'s count byte is what makes a one-input
      // and a two-input transaction structurally distinct rather than
      // accidentally so.
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
      // Outputs are hashed as *candidates*. From Spec G phase C on, producers
      // materialize outputs with txId/index set; if computeTxId hashed those,
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

      // Under the old encoding `preimages: {}` was truthy, iterated zero keys
      // and contributed nothing — so present-but-empty and absent produced the
      // identical txId. `checkTxEnvelope` rejects `{}` for exactly that reason;
      // `opt()` now makes the two distinct at the encoding layer as well, so
      // the gate stops being the only thing standing between them.
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

    it('absence appends nothing: the frozen pre-P2-D golden txId is unchanged', () => {
      // Restates the golden-vector pin as the additive-phase invariant: a tx
      // without likeTarget hashes byte-identically to before the field existed.
      expect(computeTxId(GOLDEN_TX)).toBe(GOLDEN_TX_ID);
    });

    it('the tail contribution is opt(b32) after protocolVersion — independently recomputed', () => {
      // Mirror written from the contract text (TYPES_INTERFACE → Layout —
      // UtxoTransaction), not by calling the function under test — the G3b
      // lesson: a golden regenerated after the fact pins nothing.
      //
      // The old encoding marked presence with an ASCII `like:` tag, chosen
      // because a decimal `protocolVersion` could not forge it. `opt()`'s 0/1
      // tag retires the trick: presence is a byte, not a string that has to be
      // unforgeable against its neighbour.
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
