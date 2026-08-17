/**
 * Unit tests for the codec layer — the parts the golden corpus cannot reach.
 *
 * The corpus in `test/golden/` pins **bytes**. This file pins **behaviour**:
 * which writers throw and which cannot, the boundary check's error arms, and
 * the two aliasing/coercion traps that produce no visible byte difference
 * until something else corrupts.
 */

import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, ReaderError } from '@dagsocial/wire';
import {
  CodecError,
  type StructCodec,
  VLQ_SENTINEL,
  decodeStruct,
  encodeStruct,
  enum8,
  firstDifference,
  readBytesN,
  readHexN,
  readLp,
  readU8,
  readVlqU,
  writeArr,
  writeBool,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeOpt,
  writeU8OrThrow,
  writeVlqS,
  writeVlqU,
  writeVlqU64OrThrow,
} from '../src/codec.js';

const bytes = (f: (w: ByteWriter) => void): Uint8Array => {
  const w = new ByteWriter();
  f(w);
  return w.toBytes();
};

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const SENTINEL_HEX = 'ffffffffffffffffff01';
const ID32 = '00'.repeat(32);

// ---------------------------------------------------------------------------
// Totality — audits M-5/M-6, the property the whole layer exists to preserve
// ---------------------------------------------------------------------------

describe('total writers never throw', () => {
  // Everything `@dagsocial/validation`'s isSignablePost lets past, and more.
  const MALFORMED = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['fractional', 1.5],
    ['past 2^53', 2 ** 53],
    ['undefined', undefined],
    ['null', null],
    ['string', 'nope'],
    ['object', {}],
    ['array', []],
    ['bigint', 7n],
  ] as const;

  for (const [label, value] of MALFORMED) {
    it(`vlqU absorbs ${label}`, () => {
      expect(() => bytes((w) => writeVlqU(w, value as number))).not.toThrow();
    });
    it(`vlqS absorbs ${label}`, () => {
      expect(() => bytes((w) => writeVlqS(w, value as number))).not.toThrow();
    });
    it(`lp absorbs ${label}`, () => {
      expect(() => bytes((w) => writeLp(w, value as Uint8Array))).not.toThrow();
    });
    it(`lpUtf8 absorbs ${label}`, () => {
      expect(() => bytes((w) => writeLpUtf8(w, value as string))).not.toThrow();
    });
    it(`arr absorbs ${label}`, () => {
      expect(() =>
        bytes((w) => writeArr(w, value as number[], (ww, x) => writeVlqU(ww, x))),
      ).not.toThrow();
    });
    it(`bool absorbs ${label}`, () => {
      expect(() => bytes((w) => writeBool(w, value as boolean))).not.toThrow();
    });
  }

  it('the sentinel is the all-ones u64', () => {
    expect(VLQ_SENTINEL).toBe(2n ** 64n - 1n);
    expect(hex(bytes((w) => writeVlqU(w, Number.NaN)))).toBe(SENTINEL_HEX);
  });

  it('the sentinel is unreachable from a valid number field', () => {
    // The domain tops out at 2^53-1, whose encoding is eight bytes. The
    // sentinel is ten. No valid value can reach it — the argument post.ts's
    // Totality note makes for its all-ones sentinel, in the VLQ dialect.
    expect(bytes((w) => writeVlqU(w, Number.MAX_SAFE_INTEGER))).toHaveLength(8);
    expect(bytes((w) => writeVlqU(w, Number.NaN))).toHaveLength(10);
  });

  it('the sentinel does not decode back on the number path', () => {
    const r = new ByteReader(bytes((w) => writeVlqU(w, Number.NaN)));
    expect(() => readVlqU(r)).toThrow(ReaderError);
  });

  it('a length-prefixed field sentinels its length, not its payload', () => {
    expect(hex(bytes((w) => writeLp(w, undefined as unknown as Uint8Array)))).toBe(SENTINEL_HEX);
    expect(hex(bytes((w) => writeLpUtf8(w, 42 as unknown as string)))).toBe(SENTINEL_HEX);
  });

  it('lpUtf8 does not coerce a non-string through String()', () => {
    // TextEncoder.encode(undefined) yields the bytes of "undefined". Without
    // the type guard those two inputs would share an encoding.
    const fromUndefined = bytes((w) => writeLpUtf8(w, undefined as unknown as string));
    const fromLiteral = bytes((w) => writeLpUtf8(w, 'undefined'));
    expect(hex(fromUndefined)).not.toBe(hex(fromLiteral));
    expect(hex(fromUndefined)).toBe(SENTINEL_HEX);
  });
});

// ---------------------------------------------------------------------------
// The writers that throw, and why each has to
// ---------------------------------------------------------------------------

describe('throwing writers — no unreachable sentinel exists', () => {
  it('vlqU64 rejects out-of-domain bigints', () => {
    expect(() => bytes((w) => writeVlqU64OrThrow(w, -1n))).toThrow();
    expect(() => bytes((w) => writeVlqU64OrThrow(w, 2n ** 64n))).toThrow();
    expect(() => bytes((w) => writeVlqU64OrThrow(w, 7 as unknown as bigint))).toThrow();
  });

  it('vlqU64 accepts the whole u64 — which is why it cannot sentinel', () => {
    expect(hex(bytes((w) => writeVlqU64OrThrow(w, 0n)))).toBe('00');
    // The sentinel's own bytes, as a value this writer must accept — which is
    // what makes them unavailable to mean "malformed". Consensus accepting a
    // narrower box-value domain does not change that; the domain here is the
    // writer's (TYPES_INTERFACE → Box value domain).
    expect(hex(bytes((w) => writeVlqU64OrThrow(w, VLQ_SENTINEL)))).toBe(SENTINEL_HEX);
  });

  it('u8 rejects anything that is not a byte', () => {
    for (const bad of [-1, 256, 1.5, Number.NaN, undefined, '1']) {
      expect(() => bytes((w) => writeU8OrThrow(w, bad as number))).toThrow();
    }
    expect(hex(bytes((w) => writeU8OrThrow(w, 255)))).toBe('ff');
  });

  it('fixed-width hex rejects a wrong length, a wrong type, and non-hex', () => {
    for (const bad of ['', 'ab', `${ID32}00`, ID32.replace('0', 'g'), undefined, 42, null]) {
      expect(() => bytes((w) => writeHexNOrThrow(w, bad as string, 32))).toThrow();
    }
  });

  it('fixed-width hex rejects uppercase — one id, one spelling', () => {
    const upper = 'AB'.repeat(32);
    expect(() => bytes((w) => writeHexNOrThrow(w, upper, 32))).toThrow();
    expect(() => bytes((w) => writeHexNOrThrow(w, upper.toLowerCase(), 32))).not.toThrow();
  });

  it('fixed-width bytes rejects a wrong length and a non-view', () => {
    expect(() => bytes((w) => writeBytesNOrThrow(w, new Uint8Array(31), 32))).toThrow();
    expect(() => bytes((w) => writeBytesNOrThrow(w, new Uint8Array(33), 32))).toThrow();
    expect(() =>
      bytes((w) => writeBytesNOrThrow(w, [1, 2, 3] as unknown as Uint8Array, 32)),
    ).toThrow();
    expect(() => bytes((w) => writeBytesNOrThrow(w, new Uint8Array(32), 32))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The hex boundary
// ---------------------------------------------------------------------------

describe('hex ↔ bytes lives here and only here', () => {
  it('reads lowercase, so what comes out re-encodes', () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16));
    const out = readHexN(new ByteReader(raw), 32);
    expect(out).toBe(out.toLowerCase());
    expect(bytes((w) => writeHexNOrThrow(w, out, 32))).toEqual(raw);
  });

  it('an id costs 32 bytes, not 64 — the dialect change', () => {
    expect(bytes((w) => writeHexNOrThrow(w, ID32, 32))).toHaveLength(32);
    expect(new TextEncoder().encode(ID32)).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// opt / enum8 — the two combinators with their own traps
// ---------------------------------------------------------------------------

describe('opt', () => {
  it('treats undefined as absent, like null', () => {
    // Wire's own writeOption tests `=== null` only, and the optional fields in
    // the layout tables are declared `decayBurn?:` / `lockedUntilBlock?:` — so
    // an absent one arrives as undefined and would take the *present* branch.
    const absentNull = bytes((w) => writeOpt<number>(w, null, (ww, v) => writeVlqU(ww, v)));
    const absentUndef = bytes((w) => writeOpt<number>(w, undefined, (ww, v) => writeVlqU(ww, v)));
    expect(hex(absentUndef)).toBe(hex(absentNull));
    expect(hex(absentUndef)).toBe('00');
  });

  it('present-but-falsy is not absent', () => {
    expect(hex(bytes((w) => writeOpt(w, 0, (ww, v) => writeVlqU(ww, v))))).toBe('0100');
    expect(hex(bytes((w) => writeOpt(w, false, (ww, v) => writeBool(ww, v))))).toBe('0100');
    expect(hex(bytes((w) => writeOpt(w, '', (ww, v) => writeLpUtf8(ww, v))))).toBe('0100');
  });
});

describe('enum8', () => {
  const table = enum8<'a' | 'b'>('probe', { a: 0, b: 1 });

  it('round-trips its tags', () => {
    expect(hex(bytes((w) => table.write(w, 'a')))).toBe('00');
    expect(table.read(new ByteReader(Uint8Array.of(1)))).toBe('b');
  });

  it('rejects a tag outside the table rather than picking a neighbour', () => {
    expect(() => table.read(new ByteReader(Uint8Array.of(2)))).toThrow(ReaderError);
    expect(() => table.read(new ByteReader(Uint8Array.of(0xff)))).toThrow(ReaderError);
  });

  it('writes 0xff for a value outside the table, and it does not decode back', () => {
    const out = bytes((w) => table.write(w, 'nope' as 'a'));
    expect(hex(out)).toBe('ff');
    expect(() => table.read(new ByteReader(out))).toThrow(ReaderError);
  });

  it('refuses to build a table that claims the sentinel', () => {
    expect(() => enum8('bad', { x: 0xff })).toThrow(/0\.\.254/);
  });

  it('refuses a duplicate tag — a renumber moves every id covering it', () => {
    expect(() => enum8('bad', { x: 1, y: 1 })).toThrow(/claimed by both/);
  });

  it('refuses a non-integer or out-of-range tag', () => {
    expect(() => enum8('bad', { x: -1 })).toThrow();
    expect(() => enum8('bad', { x: 1.5 })).toThrow();
    expect(() => enum8('bad', { x: 256 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Aliasing — no byte difference, but a corruption waiting to happen
// ---------------------------------------------------------------------------

describe('decoded byte fields do not alias the input', () => {
  it('readBytesN copies', () => {
    const input = Uint8Array.from({ length: 32 }, () => 1);
    const out = readBytesN(new ByteReader(input), 32);
    input.fill(9);
    expect(out.every((b) => b === 1)).toBe(true);
  });

  it('readLp copies', () => {
    const input = Uint8Array.of(2, 7, 7);
    const out = readLp(new ByteReader(input));
    input.fill(9);
    expect([...out]).toEqual([7, 7]);
  });
});

// ---------------------------------------------------------------------------
// The boundary check's four steps
// ---------------------------------------------------------------------------

const vlqUStruct: StructCodec<number> = {
  name: 'VlqU',
  write: (w, v) => writeVlqU(w, v),
  read: (r) => readVlqU(r),
};

describe('the boundary check', () => {
  it('step 1 — projects onto the schema', () => {
    expect(decodeStruct(vlqUStruct, Uint8Array.of(1))).toBe(1);
  });

  it('step 2 — trailing bytes are a rejection, not slack', () => {
    let err: unknown;
    try {
      decodeStruct(vlqUStruct, Uint8Array.of(1, 0xff, 0xff));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).failure).toBe('trailing-bytes');
    expect((err as Error).message).toMatch(/2 trailing byte\(s\) after 1/);
  });

  it('step 3 — non-minimal VLQ is caught only by the re-encode compare', () => {
    // Decode alone is happy: wire accepts the padding deliberately.
    expect(readVlqU(new ByteReader(Uint8Array.of(0x81, 0x00)))).toBe(1);
    // The boundary check is not.
    let err: unknown;
    try {
      decodeStruct(vlqUStruct, Uint8Array.of(0x81, 0x00));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).failure).toBe('non-canonical');
    expect((err as Error).message).toMatch(/first difference at offset 0/);
  });

  it('step 3 — reports where the bytes diverged', () => {
    const arrStruct: StructCodec<number[]> = {
      name: 'Arr',
      write: (w, v) => writeArr(w, v, (ww, x) => writeVlqU(ww, x)),
      read: (r) => r.readArray((rr) => rr.readVlqU()),
    };
    let err: unknown;
    try {
      // count 2, then 0 and a padded 1 — the divergence is at offset 2.
      decodeStruct(arrStruct, Uint8Array.of(0x02, 0x00, 0x81, 0x00));
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/input 4 byte\(s\), re-encoded 3/);
    expect((err as Error).message).toMatch(/first difference at offset 2/);
  });

  it('a value with no encoding is a rejection, not a panic', () => {
    // Reachable in principle wherever a throwing writer sits behind a reader
    // with a wider range. Synthesised here because the real structs land in
    // Phases 2–5; without the guard this arm would escape decode as a plain
    // Error and break the no-panic invariant.
    const bad: StructCodec<string> = {
      name: 'Unencodable',
      write: (w, v) => writeHexNOrThrow(w, v, 32),
      read: (r) => {
        readU8(r);
        return 'not-hex';
      },
    };
    let err: unknown;
    try {
      decodeStruct(bad, Uint8Array.of(0));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).failure).toBe('unencodable');
  });

  it('a reader that faults some other way still throws ReaderError', () => {
    const bad: StructCodec<number> = {
      name: 'Faulty',
      write: (w, v) => writeVlqU(w, v),
      read: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    };
    let err: unknown;
    try {
      decodeStruct(bad, Uint8Array.of(0));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecError);
    expect((err as CodecError).failure).toBe('reader-fault');
    // The original cause is carried, not swallowed.
    expect((err as Error).message).toMatch(/cannot read properties of undefined/);
  });

  it('every rejection is a ReaderError, so callers catch one class', () => {
    // TYPES_INTERFACE → The boundary check, step 4: the codec signals by
    // throwing, callers try-wrap ReaderError, and NET_INTERFACE → Peer Penalty
    // System routes it to PenaltyKind.ProtocolViolation.
    for (const input of [
      Uint8Array.of(1, 1), // trailing
      Uint8Array.of(0x81, 0x00), // non-canonical
      new Uint8Array(), // truncated
    ]) {
      expect(() => decodeStruct(vlqUStruct, input)).toThrow(ReaderError);
    }
  });

  it('round-trips every value it accepts', () => {
    for (const v of [0, 1, 127, 128, 16383, 16384, Number.MAX_SAFE_INTEGER]) {
      expect(decodeStruct(vlqUStruct, encodeStruct(vlqUStruct, v))).toBe(v);
    }
  });
});

describe('firstDifference', () => {
  it('is -1 for identical inputs', () => {
    expect(firstDifference(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(-1);
    expect(firstDifference(new Uint8Array(), new Uint8Array())).toBe(-1);
  });

  it('reports the first differing byte', () => {
    expect(firstDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 9, 3))).toBe(1);
  });

  it('reports the length as the difference when one is a prefix of the other', () => {
    expect(firstDifference(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(2);
    expect(firstDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(2);
  });
});
