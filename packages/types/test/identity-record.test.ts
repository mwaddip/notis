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
  type IdentityRecord,
} from '../src/identity-record.js';

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
