/**
 * The golden-vector harness.
 *
 * A golden vector is a committed fixture: a value, the exact bytes it encodes
 * to, and the codec that joins them. Every vector is asserted **both
 * directions** — encode produces the bytes, and decoding the bytes reproduces
 * the value — so a changed byte fails whichever way the drift came from.
 *
 * Two jobs, in this order of importance:
 *
 *  1. **Drift detector.** Every id, root and preimage in the system is frozen
 *     here, so the corpus is what separates "moved because the dialect changed"
 *     from "moved because something is wrong".
 *  2. **Conformance suite.** The `.json` files carry no TypeScript: an
 *     independent implementation reads them directly and checks itself against
 *     the same bytes. That is half the reason the positional format exists —
 *     a format nobody can write a second implementation of is not a
 *     specification.
 *
 * See `README.md` in this directory for how to add a vector.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  enum8,
  firstDifference,
  readArr,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readOpt,
  readU8,
  readVlqS,
  readVlqU,
  readVlqU64,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeOpt,
  writeU8OrThrow,
  writeVlqS,
  writeVlqU,
  writeVlqU64OrThrow,
} from '../../src/codec.js';

// ---------------------------------------------------------------------------
// The vector file format
// ---------------------------------------------------------------------------

/**
 * How a vector names its codec. A bare string is a leaf; the object forms
 * compose, so `{"arr": {"opt": "vlqU"}}` is a valid descriptor and later
 * phases add struct names as new leaves.
 */
export type CodecDescriptor =
  | string
  | { arr: CodecDescriptor }
  | { opt: CodecDescriptor }
  | { enum8: string };

export interface GoldenVector {
  /** `group/case` — appears verbatim in the test name. */
  name: string;
  codec: CodecDescriptor;
  /** The value, in this file's JSON encoding (see `README.md`). */
  value: unknown;
  /** Lowercase hex of the canonical bytes. */
  bytes: string;
  /**
   * Use `value` exactly as JSON gives it, skipping the per-codec parse. For
   * the malformed inputs that exercise the sentinel path.
   */
  raw?: boolean;
  /** Set `false` when the bytes are not meant to decode (sentinel vectors). */
  decode?: boolean;
  /** Why this vector exists, when that is not obvious from the name. */
  note?: string;
}

export interface RejectVector {
  name: string;
  codec: CodecDescriptor;
  /** Lowercase hex of the bytes that must be rejected. */
  bytes: string;
  /** Expected `CodecError.failure`, for a boundary-check rejection. */
  failure?: string;
  /** Expected `ReaderError.code`, for a rejection wire itself makes. */
  code?: string;
  note?: string;
}

export function loadVectors(file: string): GoldenVector[] {
  return readJson(file).vectors as GoldenVector[];
}

export function loadRejects(file: string): RejectVector[] {
  return readJson(file).rejects as RejectVector[];
}

function readJson(file: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(file, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hex — test-side only. `src/codec.ts` owns the production boundary.
// ---------------------------------------------------------------------------

export function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`hex: odd length ${s.length} in "${s}"`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex: bad pair "${s.slice(i * 2, i * 2 + 2)}" in "${s}"`);
    out[i] = byte;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// The readable diff — what a reviewer sees when a byte moves
// ---------------------------------------------------------------------------

/**
 * Assert two byte strings are identical, and on failure say exactly where.
 *
 * A bare `toEqual` on a 200-byte `Uint8Array` prints two walls of decimal and
 * leaves the reader to find the difference. Every vector in the corpus runs
 * through this assertion, so it has to make "which field moved" answerable at
 * a glance.
 */
export function assertBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  const at = firstDifference(actual, expected);
  if (at === -1) return;

  const e = toHex(expected);
  const a = toHex(actual);
  // Line up the caret under the differing pair in the `actual` row: the row's
  // prefix is `  actual   (` + the length + ` B): `.
  const prefix = `  actual   (${actual.length} B): `.length;
  throw new Error(
    [
      `${label} — bytes differ at offset ${at}`,
      '',
      `  expected (${expected.length} B): ${e}`,
      `  actual   (${actual.length} B): ${a}`,
      `${' '.repeat(prefix + at * 2)}^^`,
      '',
      at >= expected.length
        ? '  (actual is longer than expected)'
        : at >= actual.length
          ? '  (actual is shorter than expected)'
          : `  expected 0x${e.slice(at * 2, at * 2 + 2)}, got 0x${a.slice(at * 2, at * 2 + 2)}`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Value codecs — one per row of TYPES_INTERFACE → Serialization → Primitives
// ---------------------------------------------------------------------------

export interface ValueCodec<T> {
  /** JSON form → in-memory value. */
  parse(json: unknown): T;
  write(w: ByteWriter, value: T): void;
  read(r: ByteReader): T;
}

/** `{"$special": "NaN"}` and friends — JSON has no literal for these. */
const SPECIALS: Record<string, unknown> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
  undefined: undefined,
};

function parseSpecials(json: unknown): unknown {
  if (json !== null && typeof json === 'object' && '$special' in json) {
    const key = (json as { $special: string }).$special;
    if (!(key in SPECIALS)) throw new Error(`unknown $special "${key}"`);
    return SPECIALS[key];
  }
  return json;
}

const asNumber = (json: unknown): number => parseSpecials(json) as number;
const asString = (json: unknown): string => parseSpecials(json) as string;

/** The `MintReason` tag table (`utxo.ts`). */
export const MINT_REASON = enum8<'genesis' | 'genesis-committee'>('mintReason', {
  genesis: 6,
  'genesis-committee': 13,
});

/** The `PostType` tag table (`post.ts`). */
const POST_TYPE_ENUM = enum8<'regular' | 'profile'>('postType', { regular: 0, profile: 1 });

const ENUM_TABLES: Record<string, ReturnType<typeof enum8>> = {
  mintReason: MINT_REASON as ReturnType<typeof enum8>,
  postType: POST_TYPE_ENUM as ReturnType<typeof enum8>,
};

const LEAF_CODECS: Record<string, ValueCodec<never>> = {
  u8: codec(asNumber, writeU8OrThrow, readU8),
  vlqU: codec(asNumber, writeVlqU, readVlqU),
  vlqS: codec(asNumber, writeVlqS, readVlqS),
  // Decimal string in, `bigint` out — JSON numbers cannot carry a u64.
  vlqU64: codec((j) => BigInt(j as string), writeVlqU64OrThrow, readVlqU64),

  b32hex: fixedHex(32),
  b33hex: fixedHex(33),
  b64hex: fixedHex(64),

  b32bytes: fixedBytes(32),
  b64bytes: fixedBytes(64),

  lp: codec((j) => hex(j as string), writeLp, readLp),
  lpUtf8: codec(asString, writeLpUtf8, readLpUtf8),
};

function codec<T>(
  parse: (json: unknown) => T,
  write: (w: ByteWriter, v: T) => void,
  read: (r: ByteReader) => T,
): ValueCodec<never> {
  return { parse, write, read } as unknown as ValueCodec<never>;
}

function fixedHex(n: number): ValueCodec<never> {
  return codec<string>(
    asString,
    (w, v) => writeHexNOrThrow(w, v, n),
    (r) => readHexN(r, n),
  );
}

function fixedBytes(n: number): ValueCodec<never> {
  return codec<Uint8Array>(
    (j) => hex(j as string),
    (w, v) => writeBytesNOrThrow(w, v, n),
    (r) => readBytesN(r, n),
  );
}

/** Register a struct codec so vectors can name it. `structs.ts` and `probe.ts` call this. */
export function registerStruct<T>(name: string, value: ValueCodec<T>): void {
  LEAF_CODECS[name] = value as unknown as ValueCodec<never>;
}

/** Resolve a descriptor into the codec it names, composing `arr` / `opt`. */
export function resolveCodec(desc: CodecDescriptor): ValueCodec<unknown> {
  if (typeof desc === 'string') {
    const leaf = LEAF_CODECS[desc];
    if (!leaf) throw new Error(`unknown codec "${desc}" — register it in harness.ts`);
    return leaf as unknown as ValueCodec<unknown>;
  }
  if ('arr' in desc) {
    const inner = resolveCodec(desc.arr);
    return {
      parse: (j) => (j as unknown[]).map((x) => inner.parse(x)),
      write: (w, v) => writeArr(w, v as unknown[], (ww, x) => inner.write(ww, x)),
      read: (r) => readArr(r, (rr) => inner.read(rr)),
    };
  }
  if ('opt' in desc) {
    const inner = resolveCodec(desc.opt);
    return {
      parse: (j) => (j === null ? null : inner.parse(j)),
      write: (w, v) => writeOpt(w, v, (ww, x) => inner.write(ww, x)),
      read: (r) => readOpt(r, (rr) => inner.read(rr)),
    };
  }
  if ('enum8' in desc) {
    const table = ENUM_TABLES[desc.enum8];
    if (!table) throw new Error(`unknown enum8 table "${desc.enum8}"`);
    return {
      parse: (j) => parseSpecials(j) as string,
      write: (w, v) => table.write(w, v as string),
      read: (r) => table.read(r),
    };
  }
  throw new Error(`unrecognized codec descriptor: ${JSON.stringify(desc)}`);
}

/**
 * Present a value codec as a `StructCodec`, so **every** vector — down to a
 * lone `vlqU` — runs through `decodeStruct` and gets all four boundary-check
 * steps. That is deliberate: it is what lets a one-byte fixture assert that
 * non-minimal VLQ is rejected, without a struct to wrap it in.
 */
export function asStruct(name: string, value: ValueCodec<unknown>): StructCodec<unknown> {
  return { name, write: (w, v) => value.write(w, v), read: (r) => value.read(r) };
}

/** The descriptor as a short string, for test names. */
export function describeCodec(desc: CodecDescriptor): string {
  if (typeof desc === 'string') return desc;
  if ('arr' in desc) return `arr(${describeCodec(desc.arr)})`;
  if ('opt' in desc) return `opt(${describeCodec(desc.opt)})`;
  return `enum8(${desc.enum8})`;
}
