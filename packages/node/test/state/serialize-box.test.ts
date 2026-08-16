import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { serializeBox, deserializeBox, deserializeBoxWithId } from '../../src/state/serialize-box.js';
import { seedProvenance } from '../helpers.js';
import { BOX_ID_DOMAIN, ReaderError, computeBoxId } from '@dagsocial/types';
import type { AnyBox, KarmaBox, CreditBox, InviteBox, GenesisProofBox, BondBox, PostLockBox, VouchBox } from '@dagsocial/types';

/**
 * Every fixture below is a GENUINE box: `seedProvenance` gives it real
 * `txId`/`index` and an `id` that derives from them, so `computeBoxId(box) ===
 * box.id` holds.
 *
 * That is a requirement rather than tidiness. `serializeBox` writes the
 * provenance tail, so a fixture carrying a hand-written `id` and no `txId`/
 * `index` round-trips fields the codec never encoded — a codec test whose
 * fixtures omit fields does not cover them.
 */

/**
 * A box reduced to what its AVL value carries, for comparison against a decode.
 *
 * `id` is the hash OF the value, handed to the reader rather than read out of
 * it, so it leaves the *expectation* rather than the assertion — which keeps
 * "absent by design" distinct from "not compared".
 */
function decodedFields(box: AnyBox) {
  const { id: _id, ...rest } = box;
  return rest;
}

describe('serializeBox', () => {
  it('roundtrips a KarmaBox', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 100n,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
    });
    const serialized = serializeBox(box);
    const deserialized = deserializeBoxWithId(box.id, serialized);
    expect(deserialized).toEqual({ ...decodedFields(box), id: box.id });
  });

  it('roundtrips a CreditBox', () => {
    const box = seedProvenance<CreditBox>({
      boxType: 'credit' as const,
      value: 50n,
      owner: new Uint8Array(32).fill(0xbb),
      guard: 'owner_signature' as const,
      lockedUntilBlock: 20,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box)))
      .toEqual({ ...decodedFields(box), id: box.id });
  });

  it('an unassigned box tag has no decoding — the AVL value reader refuses it', () => {
    // 9 is the first number `BOX_TYPE` does not assign (TYPES_INTERFACE →
    // Layout — Boxes). Bytes carrying it must fail at the tag rather than parse
    // as some other type, which is what makes the rejection a property of the
    // tag table instead of a special case somebody has to remember.
    //
    // ⛔ **The number is load-bearing and moves with the table.** It was `7`
    // until `emission` took that tag, at which point these two bytes became a
    // complete, valid emission box at value 0 — the format's floor — and the
    // call still threw, as a short read on `txId`. The next tag assignment
    // must move it again; `packages/types` pins the same number in
    // `utxo.test.ts` and in the golden corpus's reject vector.
    //
    // ⚠ **The `invalid-tag` code is the assertion, not `toThrow` alone.** An
    // *assigned* tag put here throws too — on the fields it then misreads — so a
    // bare `toThrow` cannot tell "this tag has no decoding" from "this tag
    // decodes, into something else". `packages/types` pins the same property the
    // same way, at `boxRecordFromBytes` and in the golden corpus; three sites
    // agreeing on one property is the point.
    const bytes = new Uint8Array([0x09, 0x00]); // unassigned tag + a value byte
    let thrown: unknown;
    try {
      deserializeBox(bytes);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ReaderError);
    expect((thrown as ReaderError).code).toBe('invalid-tag');
  });

  // The two b32 fields are filled differently on purpose: they are adjacent
  // same-width fields, so equal values would make a transposition invisible.
  it('roundtrips an InviteBox', () => {
    const box = seedProvenance<InviteBox>({
      boxType: 'invite' as const,
      value: 0n,
      inviterId: new Uint8Array(32).fill(0x33),
      inviteePublicKey: new Uint8Array(32).fill(0x22),
      guard: 'invite_dual' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  // Two arms, because `payload` is `lp` and the length prefix is the whole of
  // the field's injectivity: appended raw, an empty payload would be
  // indistinguishable from the end of the box. The empty case is also the
  // smallest legal box of any type, so it is the one that would decode as
  // something else if the prefix went missing.
  //
  // `guard` is reattached from `GUARD_FOR` on the way back, and `'unspendable'`
  // is the first guard naming no spender at all — so a wrong arm in that table
  // shows up here rather than at the first attempt to spend one.
  it('roundtrips a GenesisProofBox', () => {
    const box = seedProvenance<GenesisProofBox>({
      boxType: 'genesis_proof' as const,
      value: 0n,
      payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      guard: 'unspendable' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a GenesisProofBox — empty payload, the lp zero-length arm', () => {
    const box = seedProvenance<GenesisProofBox>({
      boxType: 'genesis_proof' as const,
      value: 0n,
      payload: new Uint8Array(0),
      guard: 'unspendable' as const,
    });
    const back = deserializeBoxWithId(box.id, serializeBox(box));
    expect(back).toEqual(box);
    expect((back as GenesisProofBox).payload.length).toBe(0);
    // The distinguishing assertion: a written zero length, not an absent field.
    // A one-byte payload must not serialize to the same value bytes, which is
    // what a dropped length prefix would produce.
    const oneByte = { ...box, payload: new Uint8Array([0x00]) };
    expect(Buffer.from(serializeBox(box)).equals(Buffer.from(serializeBox(oneByte)))).toBe(false);
  });

  // Byte-for-byte the invite arm's trailing fields, under the other tag — the
  // pair is one layout with two tags (TYPES_INTERFACE → Layout — Boxes), so a
  // reader that walked one arm as the other would round-trip the fields and
  // fail only on the discriminant. Both b32 fields differ for the same reason
  // as the invite above.
  it('roundtrips a BondBox', () => {
    const box = seedProvenance<BondBox>({
      boxType: 'bond' as const,
      value: 5n,
      inviterId: new Uint8Array(32).fill(0x33),
      inviteePublicKey: new Uint8Array(32).fill(0x99),
      guard: 'block_apply' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a PostLockBox', () => {
    const box = seedProvenance<PostLockBox>({
      boxType: 'post_lock' as const,
      // ⚠ `value` and `originalValue` MUST differ, and so must `owner` and
      // `targetPostId`. Each is an adjacent same-width pair in the layout
      // (TYPES_INTERFACE → Layout — Boxes), and the positional format carries no
      // key names, so field ORDER is the only thing distinguishing the halves of
      // a pair. Equal values make a transposition of that pair encode and decode
      // identically, and the round-trip below passes on a swapped writer.
      value: 5n,
      originalValue: 9n,
      owner: new Uint8Array(32).fill(0x44),
      // `b32` in the id preimage, so `'post-2'` has no encoding — the id this
      // fixture derives from itself could not be computed.
      guard: 'block_apply' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('is deterministic — same input produces identical bytes', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 42n,
      owner: new Uint8Array(32).fill(0x55),
      guard: 'owner_signature' as const,
    });
    const a = serializeBox(box);
    const b = serializeBox({ ...box });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('deserializeBox returns fields without id', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 1n,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
    });
    const fields = deserializeBox(serializeBox(box));
    expect(fields).not.toHaveProperty('id');
    expect(fields).toEqual(decodedFields(box));
  });

  it('deserializeBox throws on truncated bytes', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 1n,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
    });
    const bytes = serializeBox(box);
    expect(() => deserializeBox(bytes.slice(0, 3))).toThrow();
  });

  it('deserializeBox throws on unknown box type byte', () => {
    expect(() => deserializeBox(new Uint8Array([0xff, ...new Array(100).fill(0)]))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Golden bytes — the AVL box value IS `boxRecordBytes`
// ---------------------------------------------------------------------------
//
// ⚠ **These assertions are the only pin on the AVL box format in this
// package.** Every test above is a round-trip or a determinism check, and both
// pass for ANY self-consistent codec; every hex assertion elsewhere in the
// suite compares `serializeBox(a)` against `serializeBox(b)`, so both sides move
// together. No golden `stateRoot` literal exists either. Delete this block and
// the value format can be replaced wholesale with the suite green — which is a
// silent chain split, because the format is committed in `stateRoot`.
//
// Every expected string below was **hand-derived from `TYPES_INTERFACE` →
// Layout — Boxes before the encoder was run**, then checked against it. A
// golden captured from the implementation only proves the implementation
// equals itself; two independent derivations agreeing is evidence about the
// format. They are written as commented segments for the same reason — an
// opaque 200-char blob is re-captured when it breaks, whereas a segment list
// is read.
//
// Fixtures use fixed provenance rather than `seedProvenance` so every byte is
// hand-checkable, and **no two adjacent same-width fields share a value**, or
// a transposition of the pair would not show.

const TXID = 'ab'.repeat(32);
const INDEX = 1;
/** `b32(txId)` ‖ `vlqU(index)` — the provenance tail every box record ends with. */
const PROV = 'ab'.repeat(32) + '01';

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('serializeBox golden bytes (Layout — Boxes)', () => {
  it('karma', () => {
    const box: KarmaBox = {
      boxType: 'karma', value: 100n, owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature', txId: TXID, index: INDEX,
    };
    expect(hexOf(serializeBox(box))).toBe(
      '00' +            // enum8(karma) = 0
      '64' +            // vlqU64(100)
      'aa'.repeat(32) + // b32(owner)
      '00' +            // opt(decayBurn) absent
      PROV,
    );
  });

  it('credit — the lock is an option, and absence is not a value', () => {
    const box: CreditBox = {
      boxType: 'credit', value: 50n, owner: new Uint8Array(32).fill(0xbb),
      guard: 'owner_signature', lockedUntilBlock: 20,
      txId: TXID, index: INDEX,
    };
    expect(hexOf(serializeBox(box))).toBe(
      '01' +            // enum8(credit) = 1
      '32' +            // vlqU64(50)
      'bb'.repeat(32) + // b32(owner)
      '01' + '14' +     // opt(lockedUntilBlock) present ‖ vlqU(20)
      PROV,
    );
    // The distinguishing assertion: an unlocked box writes the bare `00` tag
    // and a box locked until block 0 writes `01 00`, so the two cannot collide.
    // A raw `vlqU` with 0 standing for "unlocked" would give them one id.
    const unlocked: CreditBox = { ...box, lockedUntilBlock: undefined };
    const lockedAtZero: CreditBox = { ...box, lockedUntilBlock: 0 };
    expect(hexOf(serializeBox(unlocked))).toBe(
      '01' + '32' + 'bb'.repeat(32) + '00' + PROV,
    );
    expect(hexOf(serializeBox(lockedAtZero))).toBe(
      '01' + '32' + 'bb'.repeat(32) + '01' + '00' + PROV,
    );
  });

  it('invite', () => {
    const box: InviteBox = {
      boxType: 'invite', value: 0n, inviterId: new Uint8Array(32).fill(0x33),
      inviteePublicKey: new Uint8Array(32).fill(0x22), guard: 'invite_dual',
      txId: TXID, index: INDEX,
    };
    expect(hexOf(serializeBox(box))).toBe(
      '02' +            // enum8(invite) = 2
      '00' +            // vlqU64(0) — an invite always holds 0
      '33'.repeat(32) + // b32(inviterId)
      '22'.repeat(32) + // b32(inviteePublicKey)  ← differs from inviterId on purpose
      PROV,
    );
  });

  // The bond's tail is byte-for-byte the invite's, so the two vectors sit
  // adjacent: the tag byte and the value are the whole of the difference, and a
  // reader that lost the tag would read one as the other.
  it('bond', () => {
    const box: BondBox = {
      boxType: 'bond', value: 5n, inviterId: new Uint8Array(32).fill(0x33),
      inviteePublicKey: new Uint8Array(32).fill(0x22), guard: 'block_apply',
      txId: TXID, index: INDEX,
    };
    expect(hexOf(serializeBox(box))).toBe(
      '04' +            // enum8(bond) = 4 — 3 is genesis_proof
      '05' +            // vlqU64(5)
      '33'.repeat(32) + // b32(inviterId)
      '22'.repeat(32) + // b32(inviteePublicKey)
      PROV,
    );
  });

  it('post_lock — value then originalValue, and they must differ', () => {
    const box: PostLockBox = {
      boxType: 'post_lock', value: 5n, originalValue: 9n,
      owner: new Uint8Array(32).fill(0x44),
      guard: 'block_apply', txId: TXID, index: INDEX,
    };
    expect(hexOf(serializeBox(box))).toBe(
      '05' +            // enum8(post_lock) = 5
      '05' +            // vlqU64(value = 5)        ← shared prefix, written first
      '09' +            // vlqU64(originalValue = 9) ← per-type tail starts here
      '44'.repeat(32) + // b32(owner)  ← differs from owner on purpose
      PROV,
    );
  });

  it('vouch', () => {
    const box: AnyBox = {
      boxType: 'vouch', value: 1n, voucherId: new Uint8Array(32).fill(0x55),
      targetId: new Uint8Array(32).fill(0x66), guard: 'owner_signature',
      txId: TXID, index: INDEX,
    };
    expect(hexOf(serializeBox(box))).toBe(
      '06' +            // enum8(vouch) = 6
      '01' +            // vlqU64(1)
      '55'.repeat(32) + // b32(voucherId)
      '66'.repeat(32) + // b32(targetId)  ← differs from voucherId on purpose
      PROV,
    );
  });
});

// ---------------------------------------------------------------------------
// The AVL key is recomputable from the AVL value
// ---------------------------------------------------------------------------

describe('boxId is a total function of the AVL value', () => {
  // NODE_INTERFACE → Invariants requires that a box id be a total function of
  // the stored box. The AVL value IS `boxRecordBytes`, so that stops being an
  // argument about which fields the value happens to carry and becomes an
  // identity a test can hold **from the proof alone**:
  //
  //     boxId = blake2b512(BOX_ID_DOMAIN ‖ avlValue)[0:32]
  //
  // It holds exactly because the two byte strings are the same string: a value
  // carrying a field the derivation ignores, or omitting one it consumes, would
  // break it. A light client recomputes the key of any box it is served.
  const boxIdFromAvlValue = (value: Uint8Array): string =>
    Buffer.from(
      createHash('blake2b512').update(Buffer.from(BOX_ID_DOMAIN)).update(Buffer.from(value)).digest(),
    ).subarray(0, 32).toString('hex');

  const cases: Array<[string, AnyBox]> = [
    ['karma', seedProvenance<KarmaBox>({
      boxType: 'karma', value: 100n, owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature',
    })],
    ['credit', seedProvenance<CreditBox>({
      boxType: 'credit', value: 50n, owner: new Uint8Array(32).fill(0xbb),
      guard: 'owner_signature', lockedUntilBlock: 20,
    })],
    ['invite', seedProvenance<InviteBox>({
      boxType: 'invite', value: 0n, inviterId: new Uint8Array(32).fill(0x33),
      inviteePublicKey: new Uint8Array(32).fill(0x22), guard: 'invite_dual',
    })],
    ['bond', seedProvenance<BondBox>({
      boxType: 'bond', value: 5n, inviterId: new Uint8Array(32).fill(0x33),
      inviteePublicKey: new Uint8Array(32).fill(0x99), guard: 'block_apply',
    })],
    ['post_lock', seedProvenance<PostLockBox>({
      boxType: 'post_lock', value: 5n, originalValue: 9n,
      owner: new Uint8Array(32).fill(0x44),
      guard: 'block_apply',
    })],
    ['vouch', seedProvenance<VouchBox>({
      boxType: 'vouch', value: 1n, voucherId: new Uint8Array(32).fill(0x55),
      targetId: new Uint8Array(32).fill(0x66), guard: 'owner_signature',
    })],
  ];

  for (const [name, box] of cases) {
    it(`${name}: the stored id equals the hash of the stored value`, () => {
      expect(boxIdFromAvlValue(serializeBox(box))).toBe(box.id);
      // and `computeBoxId` agrees, so the identity is not an artifact of the
      // fixture helper deriving the id the same way this test does
      expect(computeBoxId(box)).toBe(box.id);
    });
  }
});
