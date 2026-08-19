/**
 * The positional codec layer — field primitives and the boundary check.
 *
 * Contract: `contracts/TYPES_INTERFACE.md` → Serialization.
 *
 * This module is the seam between `@dagsocial/wire` (raw `ByteReader` /
 * `ByteWriter` / VLQ, zero dependencies) and every consensus preimage in the
 * system. It adds three things wire deliberately does not have:
 *
 *  1. **The notation** of the contract's Primitives table, one function per
 *     row, so a struct codec reads like its byte-layout table and a reviewer
 *     can cross-check the two line by line.
 *  2. **Encode-side totality** (TYPES_INTERFACE → Totality) — wire's writers
 *     throw; these absorb an out-of-domain value into an unreachable sentinel
 *     wherever that is possible, and are named `…OrThrow` wherever it is not.
 *  3. **The four-part boundary check** (TYPES_INTERFACE → The boundary check)
 *     as one entry point, so no struct codec can skip a step.
 *
 * No node builtins and no `Buffer`: the demo UI is a second implementation of
 * these preimages in browser JS, so this codec has to stay runnable there, and
 * `@dagsocial/wire` is browser-clean for the same reason. Hex conversion below
 * is hand-rolled rather than `Buffer.from(hex, 'hex')` both for that and
 * because `Buffer` silently drops invalid nibbles.
 *
 * ⚠ **No hashing lives here.** This layer produces preimages; the
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
 * anything past `MAX_SAFE_INTEGER` (`wire/src/vlq.ts:3-9`), and `postFieldBytes`
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
 */
export const VLQ_SENTINEL = 0xffff_ffff_ffff_ffffn;

/**
 * Base-128 digit count for a `bigint` — `encodeVlqBigInt`'s loop
 * (`wire/src/vlq.ts`), counted rather than run.
 */
function vlqBigIntWidth(value: bigint): number {
  let n = 1;
  for (let v = value; v >= 0x80n; v >>= 7n) n++;
  return n;
}

/**
 * What a sentinelled field costs on the wire: `VLQ_SENTINEL`'s own width.
 *
 * **The `…ByteLength` mirrors below never under-report.** Each returns what its
 * writer produces, sentinel branches included — those are inside the encoder's
 * *success* domain, so a sizer that assumed a well-formed field would report
 * fewer bytes than the encoder writes, and a body measuring legal here while
 * encoding larger is one this node relays and its peers reject
 * (TYPES_INTERFACE → Sizing without encoding).
 *
 * Where a writer **throws** there is no width to mirror, and the mirrors return
 * this same maximum rather than throwing. A struct that cannot encode has no
 * length to under-report against, and the contract puts the body check inside
 * `verifyOrderingBlockStructure` (`@dagsocial/validation`), which runs on the
 * gossip relay path — a throwing sizer would leave gate ordering as the only
 * thing between untrusted bytes and a panic.
 */
const VLQ_SENTINEL_BYTE_LENGTH = vlqBigIntWidth(VLQ_SENTINEL);

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
// (TYPES_INTERFACE → Primitives). The conversion lives here and nowhere else: a `hexToBuf` or a
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
 * every caller converts it to a verdict" (TYPES_INTERFACE → The boundary check,
 * step 4) — callers catch that class, and `NET_INTERFACE` → Peer Penalty System
 * routes it to `PenaltyKind.ProtocolViolation`.
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
 * `decayBurn` is a boolean (`writeBool`, whose `{0,1}` domain really is
 * narrower) and box/trigger/reason tags are `enum8` (a closed table). Both
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

/**
 * The width `writeVlqU` produces — exact on both of its branches, so an
 * out-of-domain value costs the sentinel rather than its own digits.
 *
 * Arithmetic and not bitwise for the reason the writer states: `&`/`>>>` coerce
 * to 32 bits and would mis-count every value at or above 2^32.
 */
export function vlqUByteLength(value: number): number {
  if (!isEncodableVlqU(value)) return VLQ_SENTINEL_BYTE_LENGTH;
  let n = 1;
  for (let v = value; v >= 0x80; v = Math.floor(v / 128)) n++;
  return n;
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
 * **THROWS, and deliberately** (TYPES_INTERFACE → Totality).
 * `value: bigint` fields span the entire u64 wire domain, so no sentinel is
 * unreachable: an all-ones u64 is a value this writer must emit, and writing it
 * to signal "malformed" would make a malformed box encode identically to a
 * well-formed one — a consensus-level id collision, which is strictly worse than
 * the panic it would be avoiding.
 *
 * ⛔ **The narrower ACCEPTED domain does not free that sentinel.** Consensus
 * admits `[0, BOX_VALUE_BOUND)` (TYPES_INTERFACE → Box value domain), well
 * inside this writer's range — but the argument above rests on the **encodable**
 * domain, and that has not moved. This writer stays total over the whole u64, so
 * an all-ones value remains reachable **here** whatever consensus accepts, and
 * sentinelling it would collide exactly as it would have before.
 *
 * Every call site must therefore establish the domain first. Named for that:
 * the exception is visible where it is used, not buried in this docstring.
 *
 * TYPES_INTERFACE → Totality assigns that establishing to the call site, not to
 * this writer — see NODE_INTERFACE → "The output domain check".
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
 * The width `writeVlqU64OrThrow` produces.
 *
 * ⚠ **Total where that writer throws**, per `VLQ_SENTINEL_BYTE_LENGTH`. The
 * bound is `VLQ_SENTINEL` itself, which *is* the u64 maximum — so the value
 * that marks "out of domain" everywhere else in this file is here the largest
 * in-domain one, and doubles as the width returned for anything past it.
 */
export function vlqU64ByteLength(value: bigint): number {
  if (typeof value !== 'bigint' || value < 0n || value > VLQ_SENTINEL) {
    return VLQ_SENTINEL_BYTE_LENGTH;
  }
  return vlqBigIntWidth(value);
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
 * **The post path's domain is established upstream, not here.**
 * `@dagsocial/validation`'s `verifyPostFieldDomains` pins `author` at
 * 32 bytes and every `parentRefs` entry at 64 **lowercase** hex,
 * and `isSignablePost` is exactly that check — so `postFieldBytes` cannot reach
 * these writers out of domain. Lowercase is load-bearing: `'AB…'` and `'ab…'`
 * decode to identical bytes, so accepting both would make this boundary
 * non-injective.
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
 * memory rather than hex (`Post.author`, every signature).
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
 * The width `writeLp` produces — a non-byte-view costs its sentinel length
 * prefix and no payload.
 *
 * ⛔ **This is the mirror the under-report warning is about.** `UtxoTxTree`
 * carries `arr(utxoTxs, lp)` and `verifyOrderingBlockStructure` checks that
 * array's length alignment but not its element types, so a non-`Uint8Array`
 * element reaches the encoder and takes ten bytes there. Sizing it as
 * `vlqU(x.length) ‖ x.length` off whatever `.length` a foreign object happens to
 * expose is the divergence, and it is silent in the dangerous direction.
 */
export function lpByteLength(bytes: Uint8Array): number {
  if (!isBytes(bytes)) return VLQ_SENTINEL_BYTE_LENGTH;
  return vlqUByteLength(bytes.length) + bytes.length;
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
 * The width `writeArr` produces, given a per-element sizer — a non-array costs
 * its sentinel count and no elements.
 *
 * The count prefix is `vlqU` and therefore variable: a 128-element array's
 * prefix is not the width of a 127-element one, and neither is a 16,384-element
 * array's. `vlqUByteLength` is what keeps that from being a constant `1` on a
 * body holding thousands of transactions.
 */
export function arrByteLength<T>(items: T[], sizeOf: (x: T) => number): number {
  if (!Array.isArray(items)) return VLQ_SENTINEL_BYTE_LENGTH;
  let total = vlqUByteLength(items.length);
  for (const item of items) total += sizeOf(item);
  return total;
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
 * **Tags are never renumbered; retired values are remnant-bounded
 * reservations** (TYPES_INTERFACE → tag rules, condition 3). A renumber
 * silently moves every id and `stateRoot` covering the tag, and these tags sit
 * inside id preimages.
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
 * (TYPES_INTERFACE → Primitives), and `write` and `read` must walk it in the
 * same order.
 *
 * Supply the pair; `decodeStruct` supplies all four steps of the boundary
 * check. That direction matters — an "assert canonical" step a caller has to
 * remember to invoke is the exact shape that produced this defect class.
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
 * (TYPES_INTERFACE → The boundary check). One entry point, four steps:
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

/**
 * Write `n` as 4 bytes big-endian.
 *
 * Deliberately *total*: a value outside the encodable domain writes the
 * all-ones sentinel rather than throwing, so a malformed value can never turn
 * id derivation into a panic on untrusted input (audit M-5). The encodable
 * domain excludes the sentinel itself, so a well-formed value never collides
 * with a malformed one.
 *
 * ⛔ **`computePostId` hashes one, and its totality is the reason.** A post id is
 * derived from `(txId, index)` on the light-client path, from fields an attacker
 * supplies — so a throwing writer there would turn id derivation into a panic,
 * which is exactly what audit M-5 closed for the numeric fields.
 * `computeCandidateBoxId`'s `index` and `computeMintTxId`'s `height` are `vlqU`
 * instead; both forms are total, and which applies is stated per preimage.
 *
 * **Two mint `subject` encodings are also `u32BE`, and subjects are the
 * caller's.** `coinbase` and `genesis` encode a `u32BE` selector
 * (`node/src/mint-provenance.ts`), `computeMintTxId` takes those bytes
 * opaquely, and `NODE_INTERFACE.md`'s reason/subject table is what mandates the
 * form. One exported implementation is what stops node reimplementing it and
 * drifting — a silent divergence would move mint txIds, and through them every
 * box id, with nothing to catch it.
 */
const U32_SENTINEL = 0xffffffff;

export function u32BE(n: number): Uint8Array {
  const encodable = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < U32_SENTINEL;
  const v = encodable ? n : U32_SENTINEL;
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}
