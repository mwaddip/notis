/**
 * The identity record: the AVL value bytes, the key derivation, and the
 * boundary check the codec inherits from `encodeStruct`/`decodeStruct`
 * (TYPES_INTERFACE → Layout — IdentityRecord; → Identity record and karma
 * valuation).
 *
 * The goldens pin main's measurements against the node's implementation. If
 * this file disagrees, the code is the hypothesis and the vector is main's.
 */

import { describe, it, expect } from 'vitest';
import { ReaderError } from '@dagsocial/wire';
import { CodecError } from '../src/codec.js';
import {
  identityRecordBytes,
  identityRecordFromBytes,
  identityRecordKey,
  IDENTITY_RECORD_TAG,
  type IdentityRecord,
} from '../src/identity-record.js';
import { BOX_TYPE_TAGS, boxRecordBytes } from '../src/utxo.js';
import type { CandidateOf, KarmaBox } from '../src/utxo.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** The `CodecError.failure` a decode produced, or the thrown value itself. */
function failureOf(fn: () => unknown): string | unknown {
  try {
    fn();
  } catch (err) {
    return err instanceof CodecError ? err.failure : err;
  }
  return 'DID NOT THROW';
}

const FULL: IdentityRecord = {
  lastActivityBlock: 8123,
  lastDecayBlock: 300,
  invitedAtBlock: 17,
  lifetimeLikesReceived: 4294967301n,
  memberSinceBlock: 1000,
  memberBar: 3,
  memberVouches: 2,
  memberLikes: 129n,
  invitesUsed: 1,
};

const ZERO: IdentityRecord = {
  lastActivityBlock: 0,
  lastDecayBlock: 0,
  invitedAtBlock: 0,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

/** 32 bytes 00 01 02 … 1f — the golden's identity for `identityRecordKey`. */
const IDENTITY_00_1F = new Uint8Array(32).map((_, i) => i);

describe('identityRecordBytes / identityRecordFromBytes', () => {
  // -------------------------------------------------------------------------
  // Goldens — measured against the node's tree; the vectors are authoritative
  // -------------------------------------------------------------------------

  describe('goldens', () => {
    it('every field non-zero, both bigints in play', () => {
      expect(hex(identityRecordBytes(FULL))).toBe(
        '80bb3fac02118580808010e8070302810101',
      );
    });

    it('every field zero', () => {
      expect(hex(identityRecordBytes(ZERO))).toBe('80000000000000000000');
    });

    // The base record { 42, 7, 0, 0n, 0, 0, 0, 0n, 0 } is `802a0700000000000000`;
    // toggling one field at a time isolates the byte it lives at, so a shift in
    // field order would move that byte and this vector would notice
    // (TYPES_INTERFACE → Layout — IdentityRecord).
    const BASE: IdentityRecord = {
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
    const BASE_HEX = '802a0700000000000000';

    it('invitedAtBlock 11 changes byte 3 alone against the base record', () => {
      expect(hex(identityRecordBytes(BASE))).toBe(BASE_HEX);
      const bytes = hex(identityRecordBytes({ ...BASE, invitedAtBlock: 11 }));
      expect(bytes).toBe('802a070b000000000000');
      expect(bytes.slice(0, 6)).toBe(BASE_HEX.slice(0, 6));   // bytes 0–2
      expect(bytes.slice(6, 8)).toBe('0b');                    // byte 3
      expect(bytes.slice(8, 20)).toBe(BASE_HEX.slice(8, 20)); // bytes 4–9
    });

    it('with invitedAtBlock 11, lifetimeLikesReceived 7n changes byte 4 alone', () => {
      const bytes = hex(
        identityRecordBytes({
          ...BASE,
          invitedAtBlock: 11,
          lifetimeLikesReceived: 7n,
        }),
      );
      expect(bytes).toBe('802a070b070000000000');
      expect(bytes.slice(0, 6)).toBe(BASE_HEX.slice(0, 6));    // bytes 0–2
      expect(bytes.slice(6, 8)).toBe('0b');                     // byte 3
      expect(bytes.slice(8, 10)).toBe('07');                    // byte 4
      expect(bytes.slice(10, 20)).toBe(BASE_HEX.slice(10, 20)); // bytes 5–9
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip — every field non-zero, both bigints above 2^32
  // -------------------------------------------------------------------------

  it('round-trips a record with every field non-zero and bigints above 2^32', () => {
    const record: IdentityRecord = {
      lastActivityBlock: 8123,
      lastDecayBlock: 300,
      invitedAtBlock: 17,
      lifetimeLikesReceived: 4294967301n, // 2^32 + 5
      memberSinceBlock: 1000,
      memberBar: 3,
      memberVouches: 2,
      memberLikes: 4294967419n, // 2^32 + 123
      invitesUsed: 1,
    };
    expect(identityRecordFromBytes(identityRecordBytes(record))).toEqual(record);
  });

  // -------------------------------------------------------------------------
  // The four-part boundary check
  // -------------------------------------------------------------------------

  describe('refusals', () => {
    it('a first byte other than IDENTITY_RECORD_TAG is invalid-tag', () => {
      const bytes = identityRecordBytes(FULL);
      const tampered = new Uint8Array(bytes);
      tampered[0] = 0x81; // NETWORK_RECORD_TAG on the box arm
      const err = failureOf(() => identityRecordFromBytes(tampered));
      expect(err).toBeInstanceOf(ReaderError);
      expect((err as ReaderError).code).toBe('invalid-tag');
    });

    it('trailing bytes are a rejection, not slack', () => {
      const bytes = identityRecordBytes(FULL);
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes);
      expect(failureOf(() => identityRecordFromBytes(padded))).toBe(
        'trailing-bytes',
      );
    });

    it('a non-minimal VLQ decodes to the same value and is still rejected', () => {
      // The ZERO record's second byte is `vlqU(lastActivityBlock)` — a bare
      // `0x00`. Replacing it with `0x80 0x00` decodes to the same value but is
      // non-minimal; step 3 of the boundary check refuses the re-encode compare.
      const bytes = identityRecordBytes(ZERO);
      const padded = new Uint8Array(bytes.length + 1);
      padded[0] = bytes[0]!;
      padded.set([0x80, 0x00], 1);
      padded.set(bytes.subarray(2), 3);
      expect(failureOf(() => identityRecordFromBytes(padded))).toBe(
        'non-canonical',
      );
    });

    it('a lifetimeLikesReceived of 2^64 refuses on write', () => {
      // `writeVlqU64OrThrow` throws outside `[0, 2^64)` — the encoder's domain
      // guard, which the record's counter-only fields discharge upstream.
      const overflow: IdentityRecord = { ...ZERO, lifetimeLikesReceived: 1n << 64n };
      expect(() => identityRecordBytes(overflow)).toThrow();
    });

    it('bytes missing a trailing field are refused, never defaulted', () => {
      // Under the positional layout the reader runs out of input on a short
      // record and throws (TYPES_INTERFACE → Layout — IdentityRecord). A silent
      // `0` default would mask the always-written rule: two byte strings would
      // decode to one record, which is two AVL values for one state — exactly
      // the fork the four-part boundary check closes.
      //
      //  802a070b0000000000 — tag + eight fields, missing `invitesUsed`
      //  802a07             — tag + two fields, then out of input
      //  802a               — tag + one field, then out of input
      for (const bytesHex of ['802a070b0000000000', '802a07', '802a']) {
        expect(() =>
          identityRecordFromBytes(new Uint8Array(Buffer.from(bytesHex, 'hex'))),
        ).toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // The tag — outside the box-type range, high bit set
  // -------------------------------------------------------------------------

  it('IDENTITY_RECORD_TAG is 0x80 — outside the box-type range, high bit set, refuses a box record', () => {
    // "Box" versus "not a box" is a single-bit test, and the range below the
    // high bit stays open to `BOX_TYPE_TAGS` (NODE_INTERFACE → Entity kinds;
    // TYPES_INTERFACE → Layout — Boxes). The tag is field 1 of the record's
    // layout (TYPES_INTERFACE → Layout — IdentityRecord), so it is the first
    // byte a decoder sees and the discriminator between the two kinds.
    expect(IDENTITY_RECORD_TAG).toBe(0x80);
    expect(IDENTITY_RECORD_TAG & 0x80).toBe(0x80);
    expect(IDENTITY_RECORD_TAG).toBeGreaterThan(
      Math.max(...Object.values(BOX_TYPE_TAGS)),
    );
    expect(identityRecordBytes(FULL)[0]).toBe(IDENTITY_RECORD_TAG);

    // A karma-box record — `boxRecordBytes` of any karma candidate — begins with
    // `enum8('karma') = 0x00`, which is below the high bit. The identity
    // decoder rejects it as not an identity record.
    const karma: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 300,
      owner: new Uint8Array(32).fill(0xaa),
    };
    const boxBytes = boxRecordBytes(karma, 'e'.repeat(64), 0);
    expect(boxBytes[0]).toBe(BOX_TYPE_TAGS.karma);
    expect(() => identityRecordFromBytes(boxBytes)).toThrow(
      /not an identity record/i,
    );
  });

  // -------------------------------------------------------------------------
  // `lifetimeLikesReceived` — `vlqU64` is variable-width
  // -------------------------------------------------------------------------

  it('lifetimeLikesReceived is variable-width under vlqU64 — equal length below 128 is not a rule', () => {
    // A width tracks the value's magnitude, and an assertion resting on equal
    // lengths below 128 would pin a coincidence: `vlqU64` uses one byte for
    // `[0, 128)` and grows a byte at every 2^7 step (TYPES_INTERFACE → Layout —
    // IdentityRecord). The record's length is the sum of every field's width,
    // so any goldens that compare lengths must state the values they hold at.
    const len = (likes: bigint): number =>
      identityRecordBytes({
        lastActivityBlock: 42,
        lastDecayBlock: 7,
        invitedAtBlock: 0,
        lifetimeLikesReceived: likes,
        memberSinceBlock: 0,
        memberBar: 0,
        memberVouches: 0,
        memberLikes: 0n,
        invitesUsed: 0,
      }).length;
    expect(len(0n)).toBe(len(3n));
    expect(len(127n)).toBe(len(0n));
    expect(len(128n)).toBe(len(0n) + 1);
  });
});

describe('identityRecordKey', () => {
  it('golden: bytes 00 01 02 … 1f', () => {
    expect(identityRecordKey(IDENTITY_00_1F)).toBe(
      'cb5f79b1d894ef2d1b90c068e8f7edb9fa92ab64d1cde52b62056b49701f4669',
    );
  });

  it('two identities produce two different keys', () => {
    const a = new Uint8Array(32).fill(0xaa);
    const b = new Uint8Array(32).fill(0xbb);
    expect(identityRecordKey(a)).not.toBe(identityRecordKey(b));
  });

  it('the key is never the raw identity hex', () => {
    // Records and boxes share one 32-byte AVL keyspace; a raw pubkey would let
    // an attacker grind a keypair whose bytes equal a live box id.
    expect(identityRecordKey(IDENTITY_00_1F)).not.toBe(hex(IDENTITY_00_1F));
  });
});
