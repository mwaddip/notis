/**
 * The interlink vector — codec, commitment, update rule.
 *
 * TYPES_INTERFACE → Interlink vector.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { ByteWriter, ReaderError } from '@dagsocial/wire';
import { CodecError, writeVlqU, writeHexNOrThrow } from '../src/codec.js';
import {
  INTERLINK_DOMAIN,
  encodeInterlinks,
  decodeInterlinks,
  interlinkRoot,
  updateInterlinks,
} from '../src/interlinks.js';
import { MAX_INTERLINKS, LEVEL_CAP } from '../src/constants.js';

// Fixture ids — 32-byte hex strings.
const ID_A = 'aa'.repeat(32);
const ID_B = 'bb'.repeat(32);
const ID_C = 'cc'.repeat(32);
const ID_D = 'dd'.repeat(32);

// ---------------------------------------------------------------------------
// Codec round-trip
// ---------------------------------------------------------------------------

describe('encodeInterlinks / decodeInterlinks', () => {
  it('round-trips the empty vector', () => {
    const encoded = encodeInterlinks([]);
    expect(decodeInterlinks(encoded)).toEqual([]);
  });

  it('round-trips a single id', () => {
    const vector = [ID_A];
    expect(decodeInterlinks(encodeInterlinks(vector))).toEqual(vector);
  });

  it('round-trips several ids', () => {
    const vector = [ID_A, ID_B, ID_C, ID_D];
    expect(decodeInterlinks(encodeInterlinks(vector))).toEqual(vector);
  });

  it('round-trips at MAX_INTERLINKS', () => {
    const vector = Array.from({ length: MAX_INTERLINKS }, (_, i) =>
      (i % 256).toString(16).padStart(2, '0').repeat(32),
    );
    expect(decodeInterlinks(encodeInterlinks(vector))).toEqual(vector);
  });

  // TYPES_INTERFACE → Interlink vector: "the count is refused before the
  // first element". A count of 258 followed by too few bytes must fail on
  // the count, not on truncation.
  it('refuses 258 entries before the first element', () => {
    const w = new ByteWriter();
    writeVlqU(w, 258);
    // Write one id — if the bound didn't fire, we'd get a truncation error
    // instead of array-too-large.
    writeHexNOrThrow(w, ID_A, 32);
    const bytes = w.toBytes();
    expect(() => decodeInterlinks(bytes)).toThrow(ReaderError);
    try {
      decodeInterlinks(bytes);
    } catch (e) {
      expect((e as ReaderError).code).toBe('array-too-large');
    }
  });

  it('refuses a non-canonical encoding', () => {
    // Encode a valid vector, then pad the count's VLQ with a leading 0x80
    // byte to make it non-minimal.
    const valid = encodeInterlinks([ID_A]);
    // The first byte is vlqU(1) = 0x01. Replace with 0x81 0x00 (non-minimal).
    const nonMinimal = new Uint8Array(valid.length + 1);
    nonMinimal[0] = 0x81;
    nonMinimal[1] = 0x00;
    nonMinimal.set(valid.subarray(1), 2);
    expect(() => decodeInterlinks(nonMinimal)).toThrow(CodecError);
    try {
      decodeInterlinks(nonMinimal);
    } catch (e) {
      expect((e as CodecError).failure).toBe('non-canonical');
    }
  });
});

// ---------------------------------------------------------------------------
// interlinkRoot — commitment
// ---------------------------------------------------------------------------

describe('interlinkRoot', () => {
  function manualRoot(ids: string[]): string {
    // Hand-derive: blake2b512(INTERLINK_DOMAIN || vlqU(n) || b32 × n)[:32]
    const w = new ByteWriter();
    writeVlqU(w, ids.length);
    for (const id of ids) writeHexNOrThrow(w, id, 32);
    const encoded = w.toBytes();
    return createHash('blake2b512')
      .update(INTERLINK_DOMAIN)
      .update(encoded)
      .digest()
      .subarray(0, 32)
      .toString('hex');
  }

  it('empty vector — a real digest over vlqU(0)', () => {
    const root = interlinkRoot([]);
    expect(root).toBe(manualRoot([]));
    // Not a zero sentinel — it is a real hash.
    expect(root).not.toBe('00'.repeat(32));
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('one id', () => {
    expect(interlinkRoot([ID_A])).toBe(manualRoot([ID_A]));
  });

  it('several ids', () => {
    const vector = [ID_A, ID_B, ID_C];
    expect(interlinkRoot(vector)).toBe(manualRoot(vector));
  });

  it('order matters — [A, B] !== [B, A]', () => {
    expect(interlinkRoot([ID_A, ID_B])).not.toBe(interlinkRoot([ID_B, ID_A]));
  });
});

// ---------------------------------------------------------------------------
// updateInterlinks — TYPES_INTERFACE → Interlink vector, update rule
// ---------------------------------------------------------------------------

describe('updateInterlinks', () => {
  // Genesis: prevLevel === Infinity → [prevHash]
  it('genesis (Infinity) produces [prevHash]', () => {
    expect(updateInterlinks([], ID_A, Infinity)).toEqual([ID_A]);
  });

  // Level 0: unchanged structure, fresh array.
  it('level 0 returns a fresh copy of prev', () => {
    const prev = [ID_A];
    const result = updateInterlinks(prev, ID_B, 0);
    expect(result).toEqual([ID_A]);
    expect(result).not.toBe(prev);
  });

  // Level 1: position 1 becomes prevHash.
  it('level 1 overwrites position 1', () => {
    const prev = [ID_A, ID_B];
    const result = updateInterlinks(prev, ID_C, 1);
    expect(result).toEqual([ID_A, ID_C]);
  });

  // Grow past the end: level >= prev.length extends the vector.
  it('grows when level >= prev.length', () => {
    const prev = [ID_A];
    const result = updateInterlinks(prev, ID_B, 2);
    // Position 0 (genesis) kept, positions 1 and 2 become prevHash.
    expect(result).toEqual([ID_A, ID_B, ID_B]);
  });

  // Overwrite inside, keep above.
  it('overwrites 1..L and keeps positions above L', () => {
    const prev = [ID_A, ID_B, ID_C, ID_D];
    const result = updateInterlinks(prev, 'ee'.repeat(32), 2);
    // Positions 1 and 2 → prevHash; position 3 (above L) kept.
    expect(result).toEqual([ID_A, 'ee'.repeat(32), 'ee'.repeat(32), ID_D]);
  });

  // Level exactly at prev.length - 1: no growth, all 1..L overwritten.
  it('fills all positions 1..L when L = prev.length - 1', () => {
    const prev = [ID_A, ID_B, ID_C];
    const result = updateInterlinks(prev, ID_D, 2);
    expect(result).toEqual([ID_A, ID_D, ID_D]);
  });

  // Chain of level-0 blocks keeps [id(1)].
  it('chain of level-0 blocks keeps [genesis]', () => {
    let v = updateInterlinks([], ID_A, Infinity); // I(2) = [id(1)]
    v = updateInterlinks(v, ID_B, 0);              // level 0 → unchanged
    v = updateInterlinks(v, ID_C, 0);              // level 0 → unchanged
    expect(v).toEqual([ID_A]);
  });

  // RangeError cases.
  it('throws RangeError for negative level', () => {
    expect(() => updateInterlinks([ID_A], ID_B, -1)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer level', () => {
    expect(() => updateInterlinks([ID_A], ID_B, 1.5)).toThrow(RangeError);
  });

  it('throws RangeError for level above LEVEL_CAP', () => {
    expect(() => updateInterlinks([ID_A], ID_B, LEVEL_CAP + 1)).toThrow(RangeError);
  });

  it('throws RangeError for NaN', () => {
    expect(() => updateInterlinks([ID_A], ID_B, NaN)).toThrow(RangeError);
  });

  it('throws RangeError for empty prev with finite level', () => {
    expect(() => updateInterlinks([], ID_A, 0)).toThrow(RangeError);
  });
});
