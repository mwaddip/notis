import { describe, it, expect } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  ReaderError,
  MAX_VLQ_BYTES,
  encodeVlqU,
  encodeVlqZigZag,
  encodeVlqBigInt,
  encodeVlqZigZagBigInt,
} from '@dagsocial/wire';

const U64_MAX = 0xffffffffffffffffn;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * THE EQUIVALENCE PIN.
 *
 * The `number` and `bigint` paths must produce byte-identical output for every
 * value in the overlapping domain. That is the entire safety argument for
 * *adding* a path rather than *forking* the encoding: if it fails, the repo has
 * two encodings, and every id in the system depends on which one a call site
 * reached for.
 *
 * The boundary set is the one measured against `@ergots/scorex` on 2026-08-09
 * (0 mismatches), so a failure here means this port drifted — not that the
 * reference disagrees.
 */
describe('EQUIVALENCE PIN — number path === bigint path', () => {
  const PLAIN = [0, 1, 127, 128, 255, 300, 16383, 16384, 2 ** 31, 2 ** 32, 2 ** 53 - 1];
  const ZIGZAG = [0, -1, 1, -128, 127, -(2 ** 31)];

  it.each(PLAIN)('encodeVlqU(%d) === encodeVlqBigInt(BigInt(%d))', (v) => {
    expect(encodeVlqBigInt(BigInt(v))).toEqual(encodeVlqU(v));
  });

  it.each(ZIGZAG)('encodeVlqZigZag(%d) === encodeVlqZigZagBigInt(BigInt(%d))', (v) => {
    expect(encodeVlqZigZagBigInt(BigInt(v))).toEqual(encodeVlqZigZag(v));
  });

  it.each(PLAIN)('ByteWriter: writeVlqU(%d) === writeVlqBigInt', (v) => {
    const wn = new ByteWriter();
    wn.writeVlqU(v);
    const wb = new ByteWriter();
    wb.writeVlqBigInt(BigInt(v));
    expect(wb.toBytes()).toEqual(wn.toBytes());
  });

  it.each(ZIGZAG)('ByteWriter: writeVlqS(%d) === writeVlqBigIntSigned', (v) => {
    const wn = new ByteWriter();
    wn.writeVlqS(v);
    const wb = new ByteWriter();
    wb.writeVlqBigIntSigned(BigInt(v));
    expect(wb.toBytes()).toEqual(wn.toBytes());
  });

  // The pin is two-sided: the readers must agree on the same bytes too, or a
  // shared encoding would still be read back into two different values.
  it.each(PLAIN)('ByteReader: readVlqU(%d bytes) === readVlqBigInt', (v) => {
    const bytes = encodeVlqU(v);
    expect(new ByteReader(bytes).readVlqBigInt()).toBe(BigInt(new ByteReader(bytes).readVlqU()));
  });

  it.each(ZIGZAG)('ByteReader: readVlqS(%d bytes) === readVlqBigIntSigned', (v) => {
    const bytes = encodeVlqZigZag(v);
    expect(new ByteReader(bytes).readVlqBigIntSigned()).toBe(
      BigInt(new ByteReader(bytes).readVlqS()),
    );
  });

  it('agrees on the exact byte sequences, not merely with itself', () => {
    // Spot-check against literals so a symmetric bug in both paths cannot pass.
    expect(encodeVlqBigInt(0n)).toEqual(new Uint8Array([0x00]));
    expect(encodeVlqBigInt(127n)).toEqual(new Uint8Array([0x7f]));
    expect(encodeVlqBigInt(128n)).toEqual(new Uint8Array([0x80, 0x01]));
    expect(encodeVlqBigInt(300n)).toEqual(new Uint8Array([0xac, 0x02]));
    expect(encodeVlqBigInt(16383n)).toEqual(new Uint8Array([0xff, 0x7f]));
    expect(encodeVlqZigZagBigInt(0n)).toEqual(new Uint8Array([0x00]));
    expect(encodeVlqZigZagBigInt(-1n)).toEqual(new Uint8Array([0x01]));
    expect(encodeVlqZigZagBigInt(1n)).toEqual(new Uint8Array([0x02]));
    expect(encodeVlqZigZagBigInt(-128n)).toEqual(new Uint8Array([0xff, 0x01]));
    expect(encodeVlqZigZagBigInt(-(2n ** 31n))).toEqual(
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]),
    );
  });
});

describe('unsigned bigint VLQ — round-trip', () => {
  const VALUES = [
    0n,
    1n,
    127n,
    128n,
    255n,
    300n,
    16383n,
    16384n,
    2n ** 31n,
    2n ** 32n,
    2n ** 53n - 1n,
    // Above here the `number` path cannot represent the value at all.
    2n ** 53n,
    2n ** 53n + 1n,
    2n ** 56n,
    2n ** 62n,
    2n ** 63n - 1n,
    2n ** 63n,
    U64_MAX - 1n,
    U64_MAX,
  ];

  it.each(VALUES)('round-trips %s through the standalone encoder', (v) => {
    const r = new ByteReader(encodeVlqBigInt(v));
    expect(r.readVlqBigInt()).toBe(v);
    expect(r.isExhausted).toBe(true);
  });

  it.each(VALUES)('round-trips %s through ByteWriter', (v) => {
    const w = new ByteWriter();
    w.writeVlqBigInt(v);
    const r = new ByteReader(w.toBytes());
    expect(r.readVlqBigInt()).toBe(v);
    expect(r.isExhausted).toBe(true);
  });

  it('encodes u64 max in exactly MAX_VLQ_BYTES bytes', () => {
    expect(encodeVlqBigInt(U64_MAX).length).toBe(MAX_VLQ_BYTES);
  });

  it('rejects a negative value', () => {
    expect(() => encodeVlqBigInt(-1n)).toThrow(/negative/);
    expect(() => new ByteWriter().writeVlqBigInt(-1n)).toThrow(/negative/);
  });

  it('rejects a value past u64 — it would decode wrapped everywhere else', () => {
    expect(() => encodeVlqBigInt(U64_MAX + 1n)).toThrow(/exceeds u64/);
    expect(() => encodeVlqBigInt(2n ** 128n)).toThrow(/exceeds u64/);
    expect(() => new ByteWriter().writeVlqBigInt(U64_MAX + 1n)).toThrow(/exceeds u64/);
  });
});

describe('signed bigint VLQ — round-trip', () => {
  const VALUES = [
    0n,
    1n,
    -1n,
    127n,
    -127n,
    128n,
    -128n,
    1000n,
    -1000n,
    2n ** 31n,
    -(2n ** 31n),
    2n ** 52n,
    -(2n ** 52n),
    // Beyond the `number` ZigZag domain (doubling leaves safe-integer range).
    2n ** 53n,
    -(2n ** 53n),
    2n ** 62n,
    -(2n ** 62n),
    I64_MAX,
    I64_MIN,
  ];

  it.each(VALUES)('round-trips %s through the standalone encoder', (v) => {
    const r = new ByteReader(encodeVlqZigZagBigInt(v));
    expect(r.readVlqBigIntSigned()).toBe(v);
    expect(r.isExhausted).toBe(true);
  });

  it.each(VALUES)('round-trips %s through ByteWriter', (v) => {
    const w = new ByteWriter();
    w.writeVlqBigIntSigned(v);
    const r = new ByteReader(w.toBytes());
    expect(r.readVlqBigIntSigned()).toBe(v);
    expect(r.isExhausted).toBe(true);
  });

  it('rejects values outside i64, where the mask is not injective', () => {
    // Without the guard 2^63 would zigzag to the same single 0x00 byte as 0n.
    expect(encodeVlqZigZagBigInt(0n)).toEqual(new Uint8Array([0x00]));
    expect(() => encodeVlqZigZagBigInt(I64_MAX + 1n)).toThrow(/outside i64/);
    expect(() => encodeVlqZigZagBigInt(I64_MIN - 1n)).toThrow(/outside i64/);
    expect(() => new ByteWriter().writeVlqBigIntSigned(I64_MAX + 1n)).toThrow(/outside i64/);
  });
});

describe('bigint VLQ — adversarial bytes', () => {
  it('accepts non-minimal encodings (canonicity is enforced one layer up)', () => {
    // 0x81 0x00 is a redundant encoding of 1n. Decoding it is CORRECT here and
    // matches the reference; the re-encode-and-byte-compare that rejects it
    // lives in the codec layer above, and only works because decode is
    // permissive while re-encode is minimal.
    expect(new ByteReader(new Uint8Array([0x81, 0x00])).readVlqBigInt()).toBe(1n);
    expect(new ByteReader(new Uint8Array([0x80, 0x80, 0x00])).readVlqBigInt()).toBe(0n);
    // ...and the minimal re-encode differs, which is what makes that check work.
    expect(encodeVlqBigInt(1n)).toEqual(new Uint8Array([0x01]));
    expect(encodeVlqBigInt(1n)).not.toEqual(new Uint8Array([0x81, 0x00]));
  });

  it('wraps mod 2^64 on decode, exactly like sigma-rust get_u64 / JVM getULong', () => {
    // Nine continuation bytes carrying zero, then a final byte at shift 63.
    const pad = Array<number>(9).fill(0x80);
    // 0x02 << 63 === 2^64 -> wraps to 0
    expect(new ByteReader(new Uint8Array([...pad, 0x02])).readVlqBigInt()).toBe(0n);
    // 0x03 << 63 === 2^64 + 2^63 -> wraps to 2^63
    expect(new ByteReader(new Uint8Array([...pad, 0x03])).readVlqBigInt()).toBe(2n ** 63n);
    // 0x01 << 63 === 2^63, no wrap
    expect(new ByteReader(new Uint8Array([...pad, 0x01])).readVlqBigInt()).toBe(2n ** 63n);
  });

  it('throws vlq-overflow past MAX_VLQ_BYTES rather than reading forever', () => {
    const bytes = new Uint8Array([...Array<number>(MAX_VLQ_BYTES).fill(0x80), 0x01]);
    const r = new ByteReader(bytes);
    expect(() => r.readVlqBigInt()).toThrow(ReaderError);
    try {
      new ByteReader(bytes).readVlqBigInt();
    } catch (e) {
      expect((e as ReaderError).code).toBe('vlq-overflow');
    }
    // The cap bounds the read: it stopped at MAX_VLQ_BYTES, it did not run on.
    expect(r.position).toBe(MAX_VLQ_BYTES);
  });

  it('throws truncated on a VLQ that runs off the end', () => {
    for (const bytes of [[0x80], [0xff, 0xff], [0x80, 0x80, 0x80]]) {
      const r = new ByteReader(new Uint8Array(bytes));
      try {
        r.readVlqBigInt();
        throw new Error('expected a throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ReaderError);
        expect((e as ReaderError).code).toBe('truncated');
      }
    }
  });

  it('throws on an empty reader', () => {
    expect(() => new ByteReader(new Uint8Array(0)).readVlqBigInt()).toThrow(ReaderError);
    expect(() => new ByteReader(new Uint8Array(0)).readVlqBigIntSigned()).toThrow(ReaderError);
  });

  it('leaves the cursor where the VLQ ended, so adjacent fields still read', () => {
    const w = new ByteWriter();
    w.writeVlqBigInt(U64_MAX);
    w.writeVlqBigIntSigned(-42n);
    w.writeU8(0xab);
    const r = new ByteReader(w.toBytes());
    expect(r.readVlqBigInt()).toBe(U64_MAX);
    expect(r.readVlqBigIntSigned()).toBe(-42n);
    expect(r.readU8()).toBe(0xab);
    expect(r.isExhausted).toBe(true);
  });
});

describe('MAX_VLQ_BYTES', () => {
  it('is ceil(64 / 7) and is the one the number path already used', () => {
    expect(MAX_VLQ_BYTES).toBe(10);
    expect(MAX_VLQ_BYTES).toBe(Math.ceil(64 / 7));
  });
});
