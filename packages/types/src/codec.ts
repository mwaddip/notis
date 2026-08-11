/**
 * The positional codec layer — field primitives and the boundary check.
 *
 * Spec: `docs/specs/2026-08-09-positional-wire-format.md`.
 * Contract: `contracts/TYPES_INTERFACE.md` → Serialization.
 *
 * This module is the seam between `@dagsocial/wire` (raw `ByteReader` /
 * `ByteWriter` / VLQ, zero dependencies) and every consensus preimage in the
 * system. It adds three things wire deliberately does not have:
 *
 *  1. **The notation** of the contract's Primitives table, one function per
 *     row, so a struct codec reads like its byte-layout table and a reviewer
 *     can cross-check the two line by line.
 *  2. **Encode-side totality** (spec §2.5) — wire's writers throw; these
 *     absorb an out-of-domain value into an unreachable sentinel wherever
 *     that is possible, and are named `…OrThrow` wherever it is not.
 *  3. **The four-part boundary check** (spec §2.1) as one entry point, so no
 *     struct codec can skip a step.
 *
 * No node builtins and no `Buffer`: Phase 7 puts the demo UI on this same
 * codec, and `@dagsocial/wire` is browser-clean for that reason. Hex
 * conversion below is hand-rolled rather than `Buffer.from(hex, 'hex')` both
 * for that and because `Buffer` silently drops invalid nibbles.
 *
 * ⚠ **No hashing lives here** (spec §2.4). This layer produces preimages; the
 * `blake2b512(…).subarray(0, 32)` that consumes them stays where it is.
 */

import { ByteReader, ByteWriter, ReaderError } from '@dagsocial/wire';

// ---------------------------------------------------------------------------
// Totality — the sentinel, and where it cannot reach
// ---------------------------------------------------------------------------

/**
 * The all-ones u64 written in place of a `number` field outside the encodable
 * domain: `ff ff ff ff ff ff ff ff ff 01`, ten bytes.
 *
 * This ports the reasoning in `post.ts`'s Totality note above `postFieldBytes`,
 * not a new scheme. Wire's writers throw on non-integers, negatives, and
 * anything past `MAX_SAFE_INTEGER` (`wire/src/vlq.ts:3-9`), and `signingHash`
 * is reached with malformed posts — `@dagsocial/validation`'s `isSignablePost`
 * admits them — so a throwing writer turns a malformed post into a panic and
 * breaks the no-panic contract validation asserts (audits M-5/M-6).
 *
 * The sentinel is unreachable from a well-formed field because the encodable
 * `number` domain is the non-negative safe integers, topping out at 2^53−1.
 * A malformed value therefore never encodes to the same bytes as a well-formed
 * one. Two *malformed* values can collide with each other; that residue is the
 * same one `post.ts` documents, and it closes at its root by tightening the
 * upstream guard, not here.
 *
 * **Totality is achievable exactly where the encodable domain is narrower than
 * the wire domain.** That holds for `vlqU`/`vlqS` (a `number` inside a u64),
 * for `lp`/`lpUtf8` (the *length* is a `number` inside a u64, so a malformed
 * payload sentinels its length prefix), for `enum8` (a tag set inside a byte)
 * and for `writeBool` (`{0,1}` inside a byte). It does **not** hold for
 * `vlqU64` (a `bigint` spans the full u64), for `u8` (a byte), nor for
 * `b32`/`b33`/`b64` (a fixed-width field's wire domain is every value of that
 * width). Those writers throw and say so in their names; their domains must be
 * established upstream.
 *
 * ⚠ The contract calls the `bigint` case "the one stated exception". It is
 * the one that was *noticed*, but it is not the only one — the rule above
 * yields four, and the other three are fixed-width fields the spec introduced
 * in the same change. Recorded for main; see the Phase 1b report.
 */
export const VLQ_SENTINEL = 0xffff_ffff_ffff_ffffn;

/** True for the values the `vlqU` writer encodes faithfully. */
function isEncodableVlqU(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * True for the values the `vlqS` writer encodes faithfully.
 *
 * ZigZag doubles the magnitude before the VLQ sees it, so the domain is
 * `[-2^52, 2^52 - 1]` — the values whose zigzag is still a safe integer. Its
 * widest encoding is eight bytes, so the ten-byte sentinel stays unreachable
 * on this path too.
 */
function isEncodableVlqS(n: unknown): n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) return false;
  const zz = n >= 0 ? n * 2 : -n * 2 - 1;
  return Number.isSafeInteger(zz);
}

/** True for a real byte view — `Uint8Array`, not merely array-like. */
function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

// ---------------------------------------------------------------------------
// Hex — THE boundary, and the only one
// ---------------------------------------------------------------------------
//
// Ids, roots and digests are hex `string` in memory and raw bytes on the wire
// (spec §2.3). The conversion lives here and nowhere else: a `hexToBuf` or a
// `.toString('hex')` at any other encoding site is a double-hexing defect.
//
// Lowercase only. Every producer in the repo emits `.digest().toString('hex')`,
// which is lowercase, and `readHexN` below returns lowercase — so accepting
// uppercase would make two in-memory spellings of one id, which is the exact
// "one value, two representations" class this format exists to close.

const HEX = '0123456789abcdef';

/**
 * Parse exactly `n` bytes of lowercase hex. Returns `null` — never throws —
 * for anything else: wrong type, wrong length, or a non-hex character.
 * Callers decide whether that is a sentinel or a throw.
 */
function hexToBytesExact(hex: unknown, n: number): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length !== n * 2) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hi = HEX.indexOf(hex[i * 2]!);
    const lo = HEX.indexOf(hex[i * 2 + 1]!);
    if (hi < 0 || lo < 0) return null;
    out[i] = hi * 16 + lo;
  }
  return out;
}

/** Render bytes as lowercase hex. The inverse of `hexToBytesExact`. */
function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return s;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Which of the boundary check's guarantees the bytes failed. */
export type CodecFailure =
  /** Step 2 — bytes remained after the schema was satisfied. */
  | 'trailing-bytes'
  /** Step 3 — the bytes re-encode differently, e.g. a non-minimal VLQ. */
  | 'non-canonical'
  /** Step 3 — the decoded value has no encoding, so the input had none either. */
  | 'unencodable'
  /** Step 1 — the per-struct reader failed in a way that is not a `ReaderError`. */
  | 'reader-fault';

/**
 * A boundary-check rejection.
 *
 * Extends `ReaderError` because the contract is "decode throws `ReaderError`;
 * every caller converts it to a verdict" (spec §2.1 step 4) — the three
 * existing call sites catch that class, and spec §2.2 routes it to
 * `PenaltyKind.ProtocolViolation`.
 *
 * ⚠ `code` is `'invalid-tag'` because `ReaderErrorCode` — owned by
 * `@dagsocial/wire` — has no member meaning "well-formed but not canonical".
 * `'invalid-tag'` is the least-wrong of the eight: it already means "the bytes
 * were present and wrong, which is not truncation", and unlike `'truncated'`
 * and `'wrong-magic'` it carries no fallback semantics in `@dagsocial/net`.
 * The precise reason is on `failure`, which is what a caller should switch on.
 * Recorded for main: `ReaderErrorCode` wants a `'non-canonical'` member.
 */
export class CodecError extends ReaderError {
  constructor(
    message: string,
    public readonly failure: CodecFailure,
  ) {
    super(message, 'invalid-tag');
    this.name = 'CodecError';
  }
}

// ---------------------------------------------------------------------------
// Primitives — one function per row of TYPES_INTERFACE → Serialization
// ---------------------------------------------------------------------------

/**
 * `u8(x)` — one raw byte.
 *
 * **THROWS**, and the golden corpus is why. A first draft sentinelled `0xff`
 * here; the corpus's decode direction caught it immediately, because `readU8`
 * returns `255` and `writeU8(255)` produced `0xff` right back — so the
 * "sentinel" round-tripped and a malformed field decoded as the number 255
 * rather than being rejected.
 *
 * A bare `u8`'s wire domain is the whole byte, so it has no unreachable
 * sentinel — same structural situation as `vlqU64` and the fixed-width
 * writers. Note that the `u8` *fields* in the layout tables never hit this:
 * `isTreasury` and `decayBurn` are booleans (`writeBool`, whose `{0,1}` domain
 * really is narrower) and box/trigger tags are `enum8` (a closed table). Both
 * of those stay total.
 *
 * @throws {Error} unless `value` is an integer in `0..255`
 */
export function writeU8OrThrow(w: ByteWriter, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`writeU8OrThrow: not a byte: ${String(value)}`);
  }
  w.writeU8(value);
}

/** `u8(x)` — one byte, unconstrained on the way in. */
export function readU8(r: ByteReader): number {
  return r.readU8();
}

/**
 * `u8(x)` from a boolean.
 *
 * Total, and soundly so: `readBool` rejects anything but `0x00` / `0x01`, so
 * the encodable domain is `{0, 1}` and `0xff` is unreachable from a valid
 * value — it cannot decode back into anything at all.
 */
export function writeBool(w: ByteWriter, value: boolean): void {
  w.writeU8(value === true ? 1 : value === false ? 0 : 0xff);
}

/** `u8(x)` to a boolean — strict, no truthy coercion. */
export function readBool(r: ByteReader): boolean {
  return r.readBool();
}

/** `vlqU(x)` — unsigned VLQ from a `number`. Total: sentinel, never throws. */
export function writeVlqU(w: ByteWriter, value: number): void {
  if (isEncodableVlqU(value)) {
    w.writeVlqU(value);
    return;
  }
  w.writeVlqBigInt(VLQ_SENTINEL);
}

/**
 * `vlqU(x)` — unsigned VLQ to a `number`.
 *
 * Throws `vlq-overflow` past `MAX_SAFE_INTEGER`, which is what keeps the
 * sentinel from ever decoding back into a plausible value.
 */
export function readVlqU(r: ByteReader): number {
  return r.readVlqU();
}

/** `vlqS(x)` — ZigZag VLQ from a `number`. Total: sentinel, never throws. */
export function writeVlqS(w: ByteWriter, value: number): void {
  if (isEncodableVlqS(value)) {
    w.writeVlqS(value);
    return;
  }
  w.writeVlqBigInt(VLQ_SENTINEL);
}

/** `vlqS(x)` — ZigZag VLQ to a `number`. */
export function readVlqS(r: ByteReader): number {
  return r.readVlqS();
}

/**
 * `vlqU(x)` — unsigned VLQ from a **`bigint`**, over the full u64.
 *
 * **THROWS. The one writer here that does, and deliberately** (spec §2.5).
 * `value: bigint` fields span the entire u64 wire domain, so no sentinel is
 * unreachable: an all-ones u64 is a legal box value, and writing it to signal
 * "malformed" would make a malformed box encode identically to a well-formed
 * one — a consensus-level id collision, which is strictly worse than the panic
 * it would be avoiding.
 *
 * Every call site must therefore establish the domain first. Named for that:
 * the exception is visible where it is used, not buried in this docstring.
 *
 * Spec §2.5 assigns that establishing to the call site, not to this writer —
 * NODE_INTERFACE → "The output domain check".
 *
 * @throws {Error} if `value` is negative or above `2^64 - 1`
 */
export function writeVlqU64OrThrow(w: ByteWriter, value: bigint): void {
  if (typeof value !== 'bigint') {
    throw new Error(`writeVlqU64OrThrow: not a bigint: ${String(value)}`);
  }
  w.writeVlqBigInt(value);
}

/**
 * `vlqU(x)` — unsigned VLQ to a **`bigint`**, over the full u64.
 *
 * Wraps mod 2^64 on the way out, matching sigma-rust and JVM scorex. That
 * makes `decode ∘ encode` the identity while `encode ∘ decode` is not, and the
 * asymmetry is load-bearing: it is what leaves a ten-byte non-minimal encoding
 * detectable by the re-encode compare rather than silently accepted.
 */
export function readVlqU64(r: ByteReader): bigint {
  return r.readVlqBigInt();
}

/**
 * `b32` / `b33` / `b64` from a hex `string` — fixed-length raw bytes, no
 * length prefix. The hex→bytes half of the boundary.
 *
 * **THROWS**, for the same reason `writeVlqU64OrThrow` does: a fixed-width
 * field's wire domain is every value of that width, so it has no unreachable
 * sentinel. Padding or truncating a malformed id to `n` bytes would map it
 * onto a well-formed id's encoding.
 *
 * ⚠ **Domain obligation, currently unmet for posts.**
 * `@dagsocial/validation`'s `isSignablePost` pins `typeof ref === 'string'` and
 * `isBytes(author)` but **not** their lengths, so `signingHash` is today
 * reachable with a 31-byte author or a `parentRefs` entry of `"hello"`. Once
 * `post.ts` moves onto fixed-width fields (Phase 2), that is a live panic and
 * an M-5/M-6 regression unless the guard is tightened first.
 *
 * @throws {Error} unless `hex` is exactly `n * 2` lowercase hex characters
 */
export function writeHexNOrThrow(w: ByteWriter, hex: string, n: number): void {
  const bytes = hexToBytesExact(hex, n);
  if (bytes === null) {
    throw new Error(
      `writeHexNOrThrow: expected ${n * 2} lowercase hex chars, got ${
        typeof hex === 'string' ? `${hex.length} chars` : typeof hex
      }`,
    );
  }
  w.writeBytes(bytes);
}

/**
 * `b32` / `b33` / `b64` to a hex `string` — the bytes→hex half of the
 * boundary. Always lowercase, so it round-trips through `writeHexNOrThrow`.
 */
export function readHexN(r: ByteReader, n: number): string {
  return bytesToHex(r.readBytes(n));
}

/**
 * `b32` / `b64` from a `Uint8Array` — for the fields typed as raw bytes in
 * memory rather than hex (`Post.author`, `Post.challenge`, every signature).
 *
 * **THROWS** on a wrong length, per `writeHexNOrThrow`'s reasoning and with
 * the same unmet domain obligation.
 *
 * @throws {Error} unless `bytes` is a `Uint8Array` of exactly `n` bytes
 */
export function writeBytesNOrThrow(w: ByteWriter, bytes: Uint8Array, n: number): void {
  if (!isBytes(bytes) || bytes.length !== n) {
    throw new Error(
      `writeBytesNOrThrow: expected ${n} bytes, got ${
        isBytes(bytes) ? `${bytes.length}` : typeof bytes
      }`,
    );
  }
  w.writeBytes(bytes);
}

/**
 * `b32` / `b64` to a `Uint8Array`.
 *
 * Copies. `ByteReader.readBytes` returns a *subarray* — a view onto the input
 * buffer — so without this the decoded struct would alias the untrusted bytes
 * it came from, and a later mutation of either would silently corrupt the
 * other. `ByteWriter.writeBytes` already copies on the way in; this is the
 * matching half.
 */
export function readBytesN(r: ByteReader, n: number): Uint8Array {
  return r.readBytes(n).slice();
}

/**
 * `lp(x)` — `vlqU(byteLength) ‖ bytes`.
 *
 * Total: a non-byte-view writes the sentinel *as its length prefix* and no
 * payload. Unreachable from a well-formed field, because a real byte length is
 * a safe integer — the same argument as `vlqU`, applied to the length rather
 * than the value.
 */
export function writeLp(w: ByteWriter, bytes: Uint8Array): void {
  if (!isBytes(bytes)) {
    w.writeVlqBigInt(VLQ_SENTINEL);
    return;
  }
  w.writeVlqU(bytes.length);
  w.writeBytes(bytes);
}

/** `lp(x)` — length-prefixed bytes. Copies, per `readBytesN`. */
export function readLp(r: ByteReader): Uint8Array {
  return r.readBytes(r.readVlqU()).slice();
}

/**
 * `lpUtf8(s)` — `vlqU(utf8ByteLength) ‖ utf8Bytes`.
 *
 * Total by the same sentinel-the-length route. The type check is not
 * decoration: `TextEncoder.encode` coerces through `String()`, so without it
 * `undefined` and the literal string `"undefined"` produce identical bytes.
 */
export function writeLpUtf8(w: ByteWriter, value: string): void {
  if (typeof value !== 'string') {
    w.writeVlqBigInt(VLQ_SENTINEL);
    return;
  }
  const bytes = new TextEncoder().encode(value);
  w.writeVlqU(bytes.length);
  w.writeBytes(bytes);
}

/**
 * `lpUtf8(s)` — length-prefixed UTF-8.
 *
 * `TextDecoder` with `fatal: true`: the default replaces malformed sequences
 * with U+FFFD, which would decode two distinct byte strings to one value and
 * hand the re-encode compare a mismatch it could only report as
 * "non-canonical". Rejecting here names the actual fault.
 */
export function readLpUtf8(r: ByteReader): string {
  const bytes = r.readBytes(r.readVlqU());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReaderError('readLpUtf8: not valid UTF-8', 'invalid-tag');
  }
}

/** `arr(xs, f)` — `vlqU(count) ‖ f(x)…`. */
export function writeArr<T>(w: ByteWriter, items: T[], f: (w: ByteWriter, x: T) => void): void {
  if (!Array.isArray(items)) {
    // Sentinel as the count, per `writeLp`. A real count is a safe integer.
    w.writeVlqBigInt(VLQ_SENTINEL);
    return;
  }
  w.writeVlqU(items.length);
  for (const item of items) f(w, item);
}

/**
 * `arr(xs, f)` — count-prefixed array.
 *
 * Delegates to `ByteReader.readArray`, which enforces `MAX_ARRAY_LENGTH`
 * (`array-too-large`) before allocating.
 */
export function readArr<T>(r: ByteReader, f: (r: ByteReader) => T): T[] {
  return r.readArray(f);
}

/**
 * `opt(x, f)` — `u8(0)` absent, `u8(1) ‖ f(x)` present.
 *
 * `undefined` counts as absent alongside `null`. Wire's `writeOption` tests
 * `=== null` only, and the optional fields in the layout tables are declared
 * `decayBurn?: boolean` / `lockedUntilBlock?: number` — so an absent field
 * arrives as `undefined` and would otherwise take the *present* branch and
 * serialize nothing after the tag.
 */
export function writeOpt<T>(
  w: ByteWriter,
  value: T | null | undefined,
  f: (w: ByteWriter, v: T) => void,
): void {
  if (value === null || value === undefined) {
    w.writeU8(0);
    return;
  }
  w.writeU8(1);
  f(w, value);
}

/** `opt(x, f)` — absent is `null`. Rejects any tag but `0x00` / `0x01`. */
export function readOpt<T>(r: ByteReader, f: (r: ByteReader) => T): T | null {
  return r.readOption(f);
}

// ---------------------------------------------------------------------------
// enum8 — a reserved tag table
// ---------------------------------------------------------------------------

/** A named `u8` tag table with both directions built once. */
export interface Enum8<T extends string> {
  readonly name: string;
  /** Total: a value outside the table writes `0xff`, which the table reserves. */
  write(w: ByteWriter, value: T): void;
  /** Throws `invalid-tag` for a byte outside the table. */
  read(r: ByteReader): T;
}

/**
 * Build an `enum8` codec from a tag table.
 *
 * **Tags reserve retired values and are never renumbered** (TYPES_INTERFACE →
 * Primitives). A renumber silently moves every id and `stateRoot` covering the
 * tag — the T2b `0x03` lesson, now inside id preimages. Reserve a retired tag
 * by leaving its number out of the table, never by reusing it.
 *
 * The table itself is code, not untrusted input, so the construction-time
 * checks below throw: a duplicate or out-of-range tag is a build defect and
 * should be loud.
 *
 * @throws {Error} on a duplicate tag, a tag outside `0..0xfe`, or a table that
 *   claims `0xff` — which is reserved as the out-of-domain sentinel
 */
export function enum8<T extends string>(name: string, tags: Readonly<Record<T, number>>): Enum8<T> {
  const forward = new Map<string, number>();
  const reverse = new Map<number, T>();
  for (const [key, tag] of Object.entries(tags) as [T, number][]) {
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xfe) {
      throw new Error(`enum8(${name}): tag for "${key}" must be an integer in 0..254, got ${tag}`);
    }
    if (reverse.has(tag)) {
      throw new Error(`enum8(${name}): tag ${tag} is claimed by both "${reverse.get(tag)}" and "${key}"`);
    }
    forward.set(key, tag);
    reverse.set(tag, key);
  }
  return {
    name,
    write(w: ByteWriter, value: T): void {
      // Total: the tag set is narrower than the byte, so 0xff is unreachable
      // from a valid value — the sentinel argument, at byte width.
      w.writeU8(forward.get(value as string) ?? 0xff);
    },
    read(r: ByteReader): T {
      const tag = r.readU8();
      const value = reverse.get(tag);
      if (value === undefined) {
        throw new ReaderError(`enum8(${name}): unknown tag ${tag}`, 'invalid-tag');
      }
      return value;
    },
  };
}

// ---------------------------------------------------------------------------
// The boundary check
// ---------------------------------------------------------------------------

/**
 * A struct's normative byte layout: the field order *is* the specification
 * (spec §2.3), and `write` and `read` must walk it in the same order.
 *
 * Supply the pair; `decodeStruct` supplies all four steps of the boundary
 * check. That direction matters — an "assert canonical" a caller has to
 * remember to invoke is the exact shape that produced this defect class
 * (`verifyOrderingBlockStructure` *was* the someone-else-re-checks-it step).
 */
export interface StructCodec<T> {
  /** Diagnostic name — appears in every rejection message. */
  readonly name: string;
  write(w: ByteWriter, value: T): void;
  read(r: ByteReader): T;
}

/** Encode a struct through its layout. */
export function encodeStruct<T>(codec: StructCodec<T>, value: T): Uint8Array {
  const w = new ByteWriter();
  codec.write(w, value);
  return w.toBytes();
}

/**
 * Decode a struct through its layout, performing the whole boundary check
 * (spec §2.1). One entry point, four steps:
 *
 *  1. **Project onto the schema** — `codec.read` walks the declared fields in
 *     normative order. Unknown keys are unrepresentable; key order does not
 *     exist.
 *  2. **Assert `isExhausted`** — trailing bytes are a rejection, not slack.
 *  3. **Re-encode and byte-compare.** ⚠ Not redundant, and this is the step
 *     most likely to look removable. VLQ accepts non-minimal encodings —
 *     `0x81 0x00` decodes to `1` exactly as `0x01` does, up to ten bytes of
 *     padding per integer field — and `@dagsocial/wire` accepts them
 *     **deliberately** (WIRE_INTERFACE → "Two asymmetries are deliberate").
 *     Canonicity is enforced *here*, and only works because decode is
 *     permissive and re-encode is minimal. Tightening either side for symmetry
 *     breaks it.
 *  4. **Throw.** Callers convert to a verdict; the no-panic invariant is
 *     discharged at each boundary rather than inside the codec.
 *
 * @throws {ReaderError} — `CodecError` for a boundary-check failure, wire's
 *   own `ReaderError` for a short or malformed read
 */
export function decodeStruct<T>(codec: StructCodec<T>, bytes: Uint8Array): T {
  const reader = new ByteReader(bytes);

  // 1 — project onto the schema
  let value: T;
  try {
    value = codec.read(reader);
  } catch (err) {
    if (err instanceof ReaderError) throw err;
    // A per-struct reader that fails any other way still must not panic past
    // this boundary. The original message is carried, not swallowed.
    throw new CodecError(
      `${codec.name}: reader faulted: ${err instanceof Error ? err.message : String(err)}`,
      'reader-fault',
    );
  }

  // 2 — no appended junk
  if (!reader.isExhausted) {
    throw new CodecError(
      `${codec.name}: ${bytes.length - reader.position} trailing byte(s) after ${reader.position}`,
      'trailing-bytes',
    );
  }

  // 3 — re-encode and byte-compare
  let reencoded: Uint8Array;
  try {
    reencoded = encodeStruct(codec, value);
  } catch (err) {
    // The bytes decoded to a value with no encoding — a domain the throwing
    // writers reject. The input was not canonical either way.
    throw new CodecError(
      `${codec.name}: decoded value is unencodable: ${err instanceof Error ? err.message : String(err)}`,
      'unencodable',
    );
  }
  const diff = firstDifference(bytes, reencoded);
  if (diff !== -1) {
    throw new CodecError(
      `${codec.name}: non-canonical encoding — input ${bytes.length} byte(s), re-encoded ` +
        `${reencoded.length}, first difference at offset ${diff}`,
      'non-canonical',
    );
  }

  return value;
}

/** Offset of the first differing byte, or −1 when the two are identical. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}
