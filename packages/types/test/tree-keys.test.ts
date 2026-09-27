/**
 * The 65-byte tree keys and their ranges — TYPES_INTERFACE → The tree keys.
 *
 * Every expected byte string below is derived by hand from the contract's tag
 * table, never computed by the derivations under test.
 */

import { describe, it, expect } from 'vitest';
import {
  boxKey,
  identityKey,
  networkKey,
  nameKey,
  holderKey,
  postKey,
  likeKey,
  karmaOfKey,
  creditOfKey,
  escrowOfKey,
  escrowDueKey,
  bondDueKey,
  vouchPairKey,
  lapsedKey,
  accrualOfKey,
  typeKey,
  karmaOfRange,
  creditOfRange,
  escrowOfRange,
  accrualOfRange,
  vouchPairRange,
  escrowDueRange,
  bondDueRange,
  lapsedRange,
  typeRange,
  rangeStart,
  inRange,
  keyHeight,
  TREE_TAG,
  type TypeKeyBoxType,
} from '../src/tree-keys.js';
import { TREE_KEY_LENGTH } from '../src/constants.js';
import { BOX_TYPE_TAGS } from '../src/utxo.js';

const id = (byte: number) => new Uint8Array(32).fill(byte);
const zeros = (n: number) => new Array(n).fill(0);
const fill = (byte: number, n = 32) => new Array(n).fill(byte);

describe('tree keys (TYPES_INTERFACE → The tree keys)', () => {
  it('is 65 bytes with the tag first and zero padding last', () => {
    const k = boxKey(id(0xab));
    expect(TREE_KEY_LENGTH).toBe(65);
    expect(k.length).toBe(65);
    expect(k[0]).toBe(0x01);
    expect([...k.subarray(1, 33)]).toEqual(new Array(32).fill(0xab));
    expect([...k.subarray(33)]).toEqual(new Array(32).fill(0));
  });

  it('writes a due height big-endian so key order is height order', () => {
    const k = escrowDueKey(0x0102, id(0));
    expect([...k.subarray(0, 9)]).toEqual([TREE_TAG.escrowDue, 0, 0, 0, 0, 0, 0, 0x01, 0x02]);
    expect(keyHeight(k)).toBe(0x0102);
  });

  it('pads a 1-byte and a 24-byte name unambiguously, and refuses a non-canonical one', () => {
    const one = nameKey(new TextEncoder().encode('a'));
    const long = nameKey(new TextEncoder().encode('a'.repeat(24)));
    expect([...one.subarray(0, 3)]).toEqual([0x04, 0x61, 0]);
    expect(long[24]).toBe(0x61);
    expect(long[25]).toBe(0);
    expect(() => nameKey(new TextEncoder().encode('Ab'))).toThrow();
    expect(() => nameKey(new TextEncoder().encode('a'.repeat(25)))).toThrow();
  });

  it('throws on a wrong-width id rather than padding it', () => {
    expect(() => boxKey(new Uint8Array(31))).toThrow();
    expect(() => boxKey(new Uint8Array(33))).toThrow();
  });

  it('bounds a range by its prefix', () => {
    const r = karmaOfRange(id(7));
    expect(rangeStart(r).length).toBe(65);
    expect(inRange(rangeStart(r), r)).toBe(true);
    expect(inRange(rangeStart(karmaOfRange(id(8))), r)).toBe(false);
  });

  it('never uses a sentinel tag', () => {
    for (const tag of Object.values(TREE_TAG)) {
      expect(tag).not.toBe(0x00);
      expect(tag).not.toBe(0xff);
    }
  });

  // ---------------------------------------------------------------------------
  // One hand-derived vector per remaining derivation
  // ---------------------------------------------------------------------------

  it('identityKey — tag 0x02, one id, padded', () => {
    const k = identityKey(id(0x11));
    expect([...k]).toEqual([TREE_TAG.identity, ...fill(0x11), ...zeros(32)]);
  });

  it('networkKey — tag 0x03 alone, no fields', () => {
    const k = networkKey();
    expect([...k]).toEqual([TREE_TAG.network, ...zeros(64)]);
  });

  it('holderKey — tag 0x05, one id, padded', () => {
    const k = holderKey(id(0x22));
    expect([...k]).toEqual([TREE_TAG.holder, ...fill(0x22), ...zeros(32)]);
  });

  it('postKey — tag 0x06, one id, padded', () => {
    const k = postKey(id(0x33));
    expect([...k]).toEqual([TREE_TAG.post, ...fill(0x33), ...zeros(32)]);
  });

  it('likeKey — tag 0x07, two ids, fills all 65 bytes', () => {
    const k = likeKey(id(0x44), id(0x55));
    expect(k.length).toBe(65);
    expect([...k]).toEqual([TREE_TAG.like, ...fill(0x44), ...fill(0x55)]);
  });

  it('karmaOfKey — tag 0x10, two ids, fills all 65 bytes', () => {
    const k = karmaOfKey(id(0x66), id(0x77));
    expect([...k]).toEqual([TREE_TAG.karmaOf, ...fill(0x66), ...fill(0x77)]);
  });

  it('creditOfKey — tag 0x11, two ids', () => {
    const k = creditOfKey(id(0x88), id(0x99));
    expect([...k]).toEqual([TREE_TAG.creditOf, ...fill(0x88), ...fill(0x99)]);
  });

  it('escrowOfKey — tag 0x12, two ids', () => {
    const k = escrowOfKey(id(0xaa), id(0xbb));
    expect([...k]).toEqual([TREE_TAG.escrowOf, ...fill(0xaa), ...fill(0xbb)]);
  });

  it('bondDueKey — tag 0x14, u64 height then id, padded, height reads back', () => {
    const k = bondDueKey(0x0304, id(0x01));
    expect([...k.subarray(0, 9)]).toEqual([TREE_TAG.bondDue, 0, 0, 0, 0, 0, 0, 0x03, 0x04]);
    expect([...k.subarray(9, 41)]).toEqual(fill(0x01));
    expect([...k.subarray(41)]).toEqual(zeros(24));
    expect(keyHeight(k)).toBe(0x0304);
  });

  it('vouchPairKey — tag 0x15, two ids, fills all 65 bytes', () => {
    const k = vouchPairKey(id(0xcc), id(0xdd));
    expect(k.length).toBe(65);
    expect([...k]).toEqual([TREE_TAG.vouchPair, ...fill(0xcc), ...fill(0xdd)]);
  });

  it('lapsedKey — tag 0x16, one id, padded', () => {
    const k = lapsedKey(id(0xee));
    expect([...k]).toEqual([TREE_TAG.lapsed, ...fill(0xee), ...zeros(32)]);
  });

  it('accrualOfKey — tag 0x17, two ids', () => {
    const k = accrualOfKey(id(0x12), id(0x34));
    expect([...k]).toEqual([TREE_TAG.accrualOf, ...fill(0x12), ...fill(0x34)]);
  });

  it('typeKey — tag 0x18, the BOX_TYPE_TAGS byte, then the id, for each of the four types', () => {
    const cases: Array<[TypeKeyBoxType, number]> = [
      ['emission', BOX_TYPE_TAGS.emission],
      ['treasury', BOX_TYPE_TAGS.treasury],
      ['karma_pool', BOX_TYPE_TAGS.karma_pool],
      ['backer_pool', BOX_TYPE_TAGS.backer_pool],
    ];
    for (const [boxType, tagByte] of cases) {
      const k = typeKey(boxType, id(0x01));
      expect([...k]).toEqual([TREE_TAG.type, tagByte, ...fill(0x01), ...zeros(31)]);
    }
  });

  it('typeKey and typeRange throw on a box type outside the four', () => {
    expect(() => typeKey('karma' as TypeKeyBoxType, id(1))).toThrow();
    expect(() => typeRange('karma' as TypeKeyBoxType)).toThrow();
  });

  // ---------------------------------------------------------------------------
  // Every range's prefix
  // ---------------------------------------------------------------------------

  it('every range answers the tag plus the fields named so far, unpadded', () => {
    expect([...karmaOfRange(id(1)).prefix]).toEqual([TREE_TAG.karmaOf, ...fill(1)]);
    expect([...creditOfRange(id(2)).prefix]).toEqual([TREE_TAG.creditOf, ...fill(2)]);
    expect([...escrowOfRange(id(3)).prefix]).toEqual([TREE_TAG.escrowOf, ...fill(3)]);
    expect([...accrualOfRange(id(4)).prefix]).toEqual([TREE_TAG.accrualOf, ...fill(4)]);
    expect([...vouchPairRange(id(5)).prefix]).toEqual([TREE_TAG.vouchPair, ...fill(5)]);
    expect([...escrowDueRange().prefix]).toEqual([TREE_TAG.escrowDue]);
    expect([...bondDueRange().prefix]).toEqual([TREE_TAG.bondDue]);
    expect([...lapsedRange().prefix]).toEqual([TREE_TAG.lapsed]);
    expect([...typeRange('karma_pool').prefix]).toEqual([TREE_TAG.type, BOX_TYPE_TAGS.karma_pool]);
  });

  it('inRange matches a 1-byte prefix (a due/lapsed range) against a real key', () => {
    const r = bondDueRange();
    expect(inRange(bondDueKey(5, id(1)), r)).toBe(true);
    expect(inRange(escrowDueKey(5, id(1)), r)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Height domain
  // ---------------------------------------------------------------------------

  it('throws on a negative, a fractional and an unsafe height', () => {
    expect(() => escrowDueKey(-1, id(0))).toThrow();
    expect(() => escrowDueKey(1.5, id(0))).toThrow();
    expect(() => escrowDueKey(Number.MAX_SAFE_INTEGER + 1, id(0))).toThrow();
    expect(() => bondDueKey(-1, id(0))).toThrow();
  });

  it('keyHeight throws when the encoded height is above Number.MAX_SAFE_INTEGER', () => {
    const k = new Uint8Array(TREE_KEY_LENGTH);
    k[0] = TREE_TAG.escrowDue;
    k.fill(0xff, 1, 9); // u64 = 2^64 - 1
    expect(() => keyHeight(k)).toThrow();
  });
});
