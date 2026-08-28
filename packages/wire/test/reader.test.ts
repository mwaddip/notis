import { describe, it, expect } from 'vitest';
import { ByteReader, MAX_ARRAY_LENGTH, ReaderError } from '@dagsocial/wire';

describe('ByteReader', () => {
  it('reads a single byte', () => {
    const r = new ByteReader(new Uint8Array([0xab, 0xcd]));
    expect(r.readU8()).toBe(0xab);
    expect(r.readU8()).toBe(0xcd);
    expect(r.isExhausted).toBe(true);
  });

  it('reads multiple bytes', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    const bytes = r.readBytes(3);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.position).toBe(3);
  });

  it('tracks position and remaining', () => {
    const r = new ByteReader(new Uint8Array(10));
    expect(r.position).toBe(0);
    expect(r.remaining).toBe(10);
    expect(r.isExhausted).toBe(false);
    r.readBytes(10);
    expect(r.position).toBe(10);
    expect(r.remaining).toBe(0);
    expect(r.isExhausted).toBe(true);
  });

  it('throws on read past end', () => {
    const r = new ByteReader(new Uint8Array(1));
    r.readU8();
    expect(() => r.readU8()).toThrow(ReaderError);
  });

  it('reports truncated code on read past end', () => {
    const r = new ByteReader(new Uint8Array(1));
    r.readU8();
    try {
      r.readU8();
      expect.unreachable('expected readU8 to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError);
      expect((e as ReaderError).code).toBe('truncated');
    }
  });

  it('throws on readBytes past end', () => {
    const r = new ByteReader(new Uint8Array(2));
    expect(() => r.readBytes(5)).toThrow(ReaderError);
  });

  describe('readVlqU', () => {
    it('decodes a single-byte VLQ', () => {
      const r = new ByteReader(new Uint8Array([0x00]));
      expect(r.readVlqU()).toBe(0);
    });

    it('decodes a single-byte VLQ (max without continuation)', () => {
      const r = new ByteReader(new Uint8Array([0x7f]));
      expect(r.readVlqU()).toBe(127);
    });

    it('decodes a two-byte VLQ', () => {
      const r = new ByteReader(new Uint8Array([0x80, 0x01]));
      expect(r.readVlqU()).toBe(128);
    });

    it('decodes a three-byte VLQ', () => {
      const r = new ByteReader(new Uint8Array([0x80, 0x80, 0x01]));
      expect(r.readVlqU()).toBe(16384);
    });

    it('decodes max 32-bit value', () => {
      const r = new ByteReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]));
      expect(r.readVlqU()).toBe(0xffffffff);
    });

    it('decodes past 2^32 (full [0, 2^53-1] range)', () => {
      const r = new ByteReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x10]));
      expect(r.readVlqU()).toBe(2 ** 32);
    });

    it('throws on overflow', () => {
      // Continuation bits past the 10-byte cap — a bounded read, never an
      // unbounded loop. (Seven padding bytes are legal now that the range
      // reaches 2^53, so the cap is what has to fire here.)
      const r = new ByteReader(new Uint8Array(11).fill(0x80));
      expect(() => r.readVlqU()).toThrow(ReaderError);
    });

    it('throws when the decoded value would exceed the safe-integer range', () => {
      const r = new ByteReader(
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),
      );
      expect(() => r.readVlqU()).toThrow(ReaderError);
    });

    it('throws on truncated VLQ', () => {
      const r = new ByteReader(new Uint8Array([0x80]));
      expect(() => r.readVlqU()).toThrow(ReaderError);
    });
  });

  describe('readVlqS', () => {
    it('decodes zero', () => {
      const r = new ByteReader(new Uint8Array([0x00]));
      expect(r.readVlqS()).toBe(0);
    });

    it('decodes positive int', () => {
      const r = new ByteReader(new Uint8Array([0x02]));
      expect(r.readVlqS()).toBe(1);
    });

    it('decodes negative int', () => {
      const r = new ByteReader(new Uint8Array([0x01]));
      expect(r.readVlqS()).toBe(-1);
    });

    it('round-trip zigzag: small positives and negatives', () => {
      const cases = [0, 1, -1, 2, -2, 64, -64, 8192, -8192];
      for (const expected of cases) {
        // encode: zigzag = (n << 1) ^ (n >> 31)
        const zigzag = (expected << 1) ^ (expected >> 31);
        // VLQ encode the zigzag value
        const bytes = encodeVlqU(zigzag);
        const r = new ByteReader(bytes);
        expect(r.readVlqS()).toBe(expected);
      }
    });
  });

  it('readArray with VLQ length delegates to reader function', () => {
    // VLQ length = 2, followed by two u8 values
    const r = new ByteReader(new Uint8Array([0x02, 10, 20]));
    const result = r.readArray((rr) => rr.readU8());
    expect(result).toEqual([10, 20]);
  });

  it('readArray with empty array', () => {
    const r = new ByteReader(new Uint8Array([0x00, 99]));
    const result = r.readArray((rr) => rr.readU8());
    expect(result).toEqual([]);
    expect(r.readU8()).toBe(99); // consumed nothing past the length
  });

  describe('readArray count bound', () => {
    it('rejects a count above the bytes remaining before reading any element', () => {
      // Four VLQ bytes inside MAX_ARRAY_LENGTH: the count a pre-sizing reader
      // would turn into ~16.7M slots off a 7-byte message.
      const count = MAX_ARRAY_LENGTH - 1;
      const bytes = new Uint8Array([...encodeVlqU(count), 1, 2, 3]);
      const r = new ByteReader(bytes);

      let elementReads = 0;
      const code = readerErrorCode(() =>
        r.readArray((rr) => {
          elementReads++;
          return rr.readU8();
        }),
      );

      expect(code).toBe('truncated');
      // Both fail on a reader that sizes the array first and discovers the
      // shortfall element by element.
      expect(elementReads).toBe(0);
      expect(r.position).toBe(encodeVlqU(count).length);
    });

    it('keeps array-too-large for a count above the value-space cap', () => {
      const bytes = new Uint8Array([...encodeVlqU(MAX_ARRAY_LENGTH + 1), 1, 2, 3]);
      const r = new ByteReader(bytes);
      expect(readerErrorCode(() => r.readArray((rr) => rr.readU8()))).toBe('array-too-large');
    });

    it('accepts a count exactly equal to the bytes remaining', () => {
      const r = new ByteReader(new Uint8Array([0x03, 10, 20, 30]));
      expect(r.readArray((rr) => rr.readU8())).toEqual([10, 20, 30]);
      expect(r.isExhausted).toBe(true);
    });

    it('accepts an empty array with nothing remaining', () => {
      const r = new ByteReader(new Uint8Array([0x00]));
      expect(r.readArray((rr) => rr.readU8())).toEqual([]);
      expect(r.isExhausted).toBe(true);
    });

    it('accepts a nested array', () => {
      // arr(arr(u8)) — [[10], []]
      const r = new ByteReader(new Uint8Array([0x02, 0x01, 10, 0x00]));
      expect(r.readArray((rr) => rr.readArray((x) => x.readU8()))).toEqual([[10], []]);
      expect(r.isExhausted).toBe(true);
    });

    it('accepts a count far below the bytes remaining when elements are wide', () => {
      // The bound is one byte per element, so wide elements leave it slack —
      // loose, never wrong.
      const bytes = new Uint8Array([0x02, ...new Uint8Array(64).fill(7)]);
      const r = new ByteReader(bytes);
      const out = r.readArray((rr) => rr.readBytes(32));
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual(new Uint8Array(32).fill(7));
      expect(r.isExhausted).toBe(true);
    });

    it('still reports truncated from the element read when the count fits but the bytes do not', () => {
      // count 2 ≤ 40 remaining, yet two 32-byte elements need 64.
      const r = new ByteReader(new Uint8Array([0x02, ...new Uint8Array(40)]));
      expect(readerErrorCode(() => r.readArray((rr) => rr.readBytes(32)))).toBe('truncated');
    });
  });

  it('readOption handles null', () => {
    const r = new ByteReader(new Uint8Array([0]));
    expect(r.readOption((rr) => rr.readU8())).toBeNull();
  });

  it('readOption handles some', () => {
    const r = new ByteReader(new Uint8Array([1, 42]));
    expect(r.readOption((rr) => rr.readU8())).toBe(42);
  });

  it('readOption on a tag outside {0,1} is invalid-tag, not truncated', () => {
    // Controls for tags 0 and 1 are the two tests above.
    const r = new ByteReader(new Uint8Array([2, 42]));
    expect(readerErrorCode(() => r.readOption((rr) => rr.readU8()))).toBe('invalid-tag');
  });
});

/** Run fn, assert it throws a ReaderError, and return its code. */
function readerErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ReaderError);
    return (e as ReaderError).code;
  }
  expect.unreachable('expected a ReaderError');
}

/** Helper: encode an unsigned integer as VLQ bytes */
function encodeVlqU(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0x00]);
  const parts: number[] = [];
  while (n > 0) {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n > 0) byte |= 0x80;
    parts.push(byte);
  }
  return new Uint8Array(parts);
}
