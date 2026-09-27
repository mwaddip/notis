/**
 * The tree-record value codecs — TYPES_INTERFACE → Layout — tree records.
 *
 * Goldens are hand-derived from the layout table, never computed by the
 * codecs under test.
 */

import { describe, it, expect } from 'vitest';
import { ReaderError } from '@dagsocial/wire';
import { CodecError } from '../src/codec.js';
import {
  networkRecordBytes,
  networkRecordFromBytes,
  nameRecordBytes,
  nameRecordFromBytes,
  holderRecordBytes,
  holderRecordFromBytes,
  postRecordBytes,
  postRecordFromBytes,
  LIKE_MARKER,
  INDEX_MARKER,
  vouchPairValue,
  vouchPairBoxId,
  castCountBytes,
  castCountFromBytes,
  boxFromRecordBytes,
  type PostRecord,
} from '../src/tree-records.js';
import { BOX_TYPE_TAGS, boxRecordBytes } from '../src/utxo.js';
import type { AnyBoxCandidate } from '../src/utxo.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const id = (byte: number) => new Uint8Array(32).fill(byte);

/** The `CodecError.failure` a decode produced, or the thrown value itself. */
function failureOf(fn: () => unknown): string | unknown {
  try {
    fn();
  } catch (err) {
    return err instanceof CodecError ? err.failure : err;
  }
  return 'DID NOT THROW';
}

describe('networkRecordBytes / networkRecordFromBytes', () => {
  it('golden: memberCount 7 — u8(0x81) ‖ vlqU(7)', () => {
    expect(hex(networkRecordBytes({ memberCount: 7 }))).toBe('8107');
  });

  it('round-trips a multi-byte VLQ count', () => {
    expect(networkRecordFromBytes(networkRecordBytes({ memberCount: 300 }))).toEqual({
      memberCount: 300,
    });
  });

  it('refuses a wrong tag', () => {
    const bytes = networkRecordBytes({ memberCount: 1 });
    const tampered = new Uint8Array(bytes);
    tampered[0] = 0x82;
    const err = failureOf(() => networkRecordFromBytes(tampered));
    expect(err).toBeInstanceOf(ReaderError);
    expect((err as ReaderError).code).toBe('invalid-tag');
  });

  it('refuses trailing bytes', () => {
    const bytes = networkRecordBytes({ memberCount: 1 });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(failureOf(() => networkRecordFromBytes(padded))).toBe('trailing-bytes');
  });

  it('refuses a non-minimal VLQ', () => {
    // memberCount 0 is the bare byte 0x00; 0x80 0x00 decodes to the same value
    // non-minimally.
    const bytes = networkRecordBytes({ memberCount: 0 }); // 81 00
    const padded = Uint8Array.of(bytes[0]!, 0x80, 0x00);
    expect(failureOf(() => networkRecordFromBytes(padded))).toBe('non-canonical');
  });
});

describe('nameRecordBytes / nameRecordFromBytes', () => {
  const boxId = 'ab'.repeat(32);

  it('golden — u8(0x82) ‖ b32(boxId) ‖ vlqU(claimedAtBlock)', () => {
    expect(hex(nameRecordBytes({ boxId, claimedAtBlock: 300 }))).toBe(
      `82${'ab'.repeat(32)}ac02`,
    );
  });

  it('round-trips', () => {
    expect(nameRecordFromBytes(nameRecordBytes({ boxId, claimedAtBlock: 300 }))).toEqual({
      boxId,
      claimedAtBlock: 300,
    });
  });

  it('refuses a wrong tag', () => {
    const bytes = nameRecordBytes({ boxId, claimedAtBlock: 300 });
    const tampered = new Uint8Array(bytes);
    tampered[0] = 0x81;
    expect(() => nameRecordFromBytes(tampered)).toThrow(/not a name record/);
  });

  it('refuses trailing bytes', () => {
    const bytes = nameRecordBytes({ boxId, claimedAtBlock: 300 });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(failureOf(() => nameRecordFromBytes(padded))).toBe('trailing-bytes');
  });

  it('refuses the old 33-byte form with no height — reader exhausted before it', () => {
    const old = Uint8Array.of(0x82, ...Buffer.from(boxId, 'hex'));
    expect(old.length).toBe(33);
    expect(() => nameRecordFromBytes(old)).toThrow();
  });
});

describe('holderRecordBytes / holderRecordFromBytes', () => {
  it('golden — absent box: u8(0x83) ‖ u8(1) ‖ opt-absent', () => {
    expect(hex(holderRecordBytes({ claimAvailable: true, boxId: null }))).toBe('830100');
  });

  it('golden — present box: u8(0x83) ‖ u8(0) ‖ opt-present ‖ b32(boxId)', () => {
    const boxId = 'cd'.repeat(32);
    expect(hex(holderRecordBytes({ claimAvailable: false, boxId }))).toBe(
      `830001${'cd'.repeat(32)}`,
    );
  });

  it('round-trips both branches', () => {
    expect(
      holderRecordFromBytes(holderRecordBytes({ claimAvailable: true, boxId: null })),
    ).toEqual({ claimAvailable: true, boxId: null });
    const boxId = 'ef'.repeat(32);
    expect(holderRecordFromBytes(holderRecordBytes({ claimAvailable: false, boxId }))).toEqual({
      claimAvailable: false,
      boxId,
    });
  });

  it('refuses a wrong tag', () => {
    const bytes = holderRecordBytes({ claimAvailable: true, boxId: null });
    const tampered = new Uint8Array(bytes);
    tampered[0] = 0x82;
    expect(() => holderRecordFromBytes(tampered)).toThrow(/not a holder record/);
  });

  it('refuses trailing bytes', () => {
    const bytes = holderRecordBytes({ claimAvailable: true, boxId: null });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(failureOf(() => holderRecordFromBytes(padded))).toBe('trailing-bytes');
  });
});

describe('postRecordBytes / postRecordFromBytes', () => {
  it('golden — withdrawn: 84 ‖ 01×32 ‖ ac 02 ‖ 01', () => {
    expect(hex(postRecordBytes({ author: id(1), height: 300, standing: 'withdrawn' }))).toBe(
      `84${'01'.repeat(32)}ac0201`,
    );
  });

  it('golden — live, height 0: 84 ‖ 02×32 ‖ 00 ‖ 00', () => {
    expect(hex(postRecordBytes({ author: id(2), height: 0, standing: 'live' }))).toBe(
      `84${'02'.repeat(32)}0000`,
    );
  });

  it('round-trips', () => {
    const rec: PostRecord = { author: id(3), height: 12345, standing: 'live' };
    expect(postRecordFromBytes(postRecordBytes(rec))).toEqual(rec);
  });

  it('refuses a standing byte of 2', () => {
    const bytes = postRecordBytes({ author: id(1), height: 0, standing: 'live' });
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] = 2;
    expect(() => postRecordFromBytes(tampered)).toThrow();
  });

  it('refuses a wrong tag', () => {
    const bytes = postRecordBytes({ author: id(1), height: 0, standing: 'live' });
    const tampered = new Uint8Array(bytes);
    tampered[0] = 0x83;
    expect(() => postRecordFromBytes(tampered)).toThrow(/not a post record/);
  });

  it('refuses trailing bytes', () => {
    const bytes = postRecordBytes({ author: id(1), height: 0, standing: 'live' });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(failureOf(() => postRecordFromBytes(padded))).toBe('trailing-bytes');
  });

  it('refuses a non-minimal VLQ height', () => {
    const bytes = postRecordBytes({ author: id(1), height: 0, standing: 'live' });
    // tag(1) + author(32) + height(1 byte at offset 33) + standing(1 byte at 34)
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes.subarray(0, 33), 0);
    padded.set([0x80, 0x00], 33);
    padded.set(bytes.subarray(34), 35);
    expect(failureOf(() => postRecordFromBytes(padded))).toBe('non-canonical');
  });
});

describe('LIKE_MARKER / INDEX_MARKER', () => {
  it('are the single tag bytes 0x85 and 0x86', () => {
    expect([...LIKE_MARKER]).toEqual([0x85]);
    expect([...INDEX_MARKER]).toEqual([0x86]);
  });
});

describe('vouchPairValue / vouchPairBoxId', () => {
  it('golden — u8(0x87) ‖ b32(boxId)', () => {
    expect(hex(vouchPairValue(id(3)))).toBe(`87${'03'.repeat(32)}`);
  });

  it('round-trips', () => {
    expect(vouchPairBoxId(vouchPairValue(id(9)))).toEqual(id(9));
  });

  it('refuses a wrong tag', () => {
    const bytes = vouchPairValue(id(1));
    const tampered = new Uint8Array(bytes);
    tampered[0] = 0x86;
    expect(() => vouchPairBoxId(tampered)).toThrow();
  });

  it('refuses trailing bytes', () => {
    const bytes = vouchPairValue(id(1));
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(failureOf(() => vouchPairBoxId(padded))).toBe('trailing-bytes');
  });
});

describe('castCountBytes / castCountFromBytes', () => {
  it('golden — count 300: u8(0x88) ‖ vlqU(300)', () => {
    expect(hex(castCountBytes(300))).toBe('88ac02');
  });

  it('round-trips a multi-byte VLQ count', () => {
    expect(castCountFromBytes(castCountBytes(300))).toBe(300);
  });

  it('golden — count 1: u8(0x88) ‖ vlqU(1)', () => {
    expect(hex(castCountBytes(1))).toBe('8801');
  });

  it('throws encoding a count of 0 — a count of 0 is no entry', () => {
    expect(() => castCountBytes(0)).toThrow();
  });

  it('throws encoding a negative, a fractional and an unsafe count', () => {
    expect(() => castCountBytes(-1)).toThrow();
    expect(() => castCountBytes(1.5)).toThrow();
    expect(() => castCountBytes(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it('refuses a stored count of 0 on decode', () => {
    const err = failureOf(() => castCountFromBytes(Uint8Array.of(0x88, 0x00)));
    expect(err).toBeInstanceOf(ReaderError);
    expect((err as ReaderError).code).toBe('out-of-domain');
  });

  it('refuses a wrong tag', () => {
    const bytes = castCountBytes(1);
    const tampered = new Uint8Array(bytes);
    tampered[0] = 0x87;
    expect(() => castCountFromBytes(tampered)).toThrow(/not a cast count/);
  });

  it('refuses trailing bytes', () => {
    const bytes = castCountBytes(1);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(failureOf(() => castCountFromBytes(padded))).toBe('trailing-bytes');
  });

  it('refuses a non-minimal VLQ (88 81 00)', () => {
    const padded = Uint8Array.of(0x88, 0x81, 0x00);
    expect(failureOf(() => castCountFromBytes(padded))).toBe('non-canonical');
  });
});

describe('boxFromRecordBytes', () => {
  const txId = 'e'.repeat(64);

  const FIXTURES: AnyBoxCandidate[] = [
    { boxType: 'karma', value: 100n, createdAtBlock: 10, owner: id(1) },
    { boxType: 'credit', value: 50n, createdAtBlock: 10, owner: id(2) },
    { boxType: 'genesis_proof', value: 0n, createdAtBlock: 10, payload: new Uint8Array([1, 2, 3]) },
    { boxType: 'bond', value: 100n, createdAtBlock: 10, inviterId: id(3), inviteePublicKey: id(4) },
    { boxType: 'vouch', value: 1n, createdAtBlock: 10, voucherId: id(5), targetId: id(6) },
    { boxType: 'emission', value: 1000n, createdAtBlock: 10 },
    { boxType: 'treasury', value: 1000n, createdAtBlock: 10 },
    { boxType: 'fee', value: 5n, createdAtBlock: 10 },
    { boxType: 'karma_pool', value: 1000n, createdAtBlock: 10 },
    { boxType: 'like_accrual', value: 1n, createdAtBlock: 10, author: id(7) },
    { boxType: 'vouch_escrow', value: 1n, createdAtBlock: 10, owner: id(8), releaseAtBlock: 20 },
    { boxType: 'karma_price', value: 5n, createdAtBlock: 10 },
    {
      boxType: 'username',
      value: 0n,
      createdAtBlock: 10,
      owner: id(9),
      name: new TextEncoder().encode('alice'),
    },
    { boxType: 'backer_stake', value: 0n, createdAtBlock: 10, owner: id(10), weight: 100n },
    { boxType: 'backer_unstake', value: 0n, createdAtBlock: 10, owner: id(11), weight: 50n },
    { boxType: 'backer_pool', value: 1000n, createdAtBlock: 10, staked: 500n, accrual: 20n },
  ];

  it('covers every BOX_TYPE_TAGS entry exactly once', () => {
    expect(FIXTURES.map((f) => f.boxType).sort()).toEqual(Object.keys(BOX_TYPE_TAGS).sort());
  });

  it.each(FIXTURES)('decodes a stored $boxType box, id included', (candidate) => {
    const bytes = boxRecordBytes(candidate, txId, 0);
    const boxId = 'f'.repeat(64);
    const box = boxFromRecordBytes(boxId, bytes);
    expect(box).toEqual({ ...candidate, txId, index: 0, id: boxId });
  });

  it('refuses every record tag 0x80-0x87', () => {
    for (let tag = 0x80; tag <= 0x87; tag++) {
      expect(() => boxFromRecordBytes('f'.repeat(64), Uint8Array.of(tag))).toThrow(/record/);
    }
  });
});
