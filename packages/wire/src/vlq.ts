import { ByteReader } from './reader.js';

export function encodeVlqU(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('encodeVlqU: value must be a non-negative integer');
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error('encodeVlqU: value exceeds safe integer range');
  }
  // Arithmetic, not bitwise: `&`/`>>>` coerce to 32 bits, which silently
  // mis-encodes every value at or above 2^32. Keep in sync with
  // ByteWriter.writeVlqU.
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) + 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return new Uint8Array(out);
}

export function decodeVlqU(reader: ByteReader): number {
  return reader.readVlqU();
}

export function encodeVlqZigZag(value: number): Uint8Array {
  if (!Number.isInteger(value)) {
    throw new Error('encodeVlqZigZag: value must be an integer');
  }
  // ZigZag, arithmetic rather than `(v << 1) ^ (v >> 31)`: the bitwise form is
  // 32-bit and corrupts anything outside ±2^31. Doubling can push a large
  // magnitude past the safe-integer range — encodeVlqU then rejects it loudly
  // instead of truncating. Keep in sync with ByteWriter.writeVlqS.
  const zz = value >= 0 ? value * 2 : -value * 2 - 1;
  return encodeVlqU(zz);
}

export function decodeVlqZigZag(reader: ByteReader): number {
  return reader.readVlqS();
}

/** Largest value the u64 wire domain can carry. */
const U64_MAX = 0xffffffffffffffffn;

/** The i64 domain the ZigZag pair encodes from. */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * Encodes a non-negative `bigint` as VLQ bytes over the full u64 range.
 *
 * Re-imported from `@ergots/scorex` — the same upstream this package was
 * extracted from — so the `number` path above and this one are two views of one
 * encoding, not two encodings. Over the overlapping domain `[0, 2^53-1]` they
 * are byte-identical, which is what makes adding a path safe rather than a
 * fork; `test/vlq-bigint.test.ts` pins that at the boundaries.
 *
 * Bitwise operators are correct here where they are not in the `number` path:
 * BigInt `&` and `>>` are arbitrary-precision and never coerce to 32 bits.
 *
 * - **Precondition:** `value >= 0n`, `value <= 2^64 - 1`
 * - **Throws:** `Error` if the precondition is violated
 */
export function encodeVlqBigInt(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error('encodeVlqBigInt: negative value');
  }
  if (value > U64_MAX) {
    // The wire carries u64 only. A wider value would decode WRAPPED mod 2^64 on
    // every implementation (see ByteReader.readVlqBigInt), so emitting bytes for
    // it would emit bytes that mean a different number on the way back — reject
    // at the source instead.
    throw new Error('encodeVlqBigInt: value exceeds u64');
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

/**
 * ZigZag-encodes a signed `bigint` over the i64 domain, then VLQ-encodes.
 *
 * - **Precondition:** `-2^63 <= value <= 2^63 - 1`
 * - **Throws:** `Error` if the precondition is violated
 */
export function encodeVlqZigZagBigInt(value: bigint): Uint8Array {
  if (value < I64_MIN || value > I64_MAX) {
    // Deliberate divergence from the scorex reference, which masks with no
    // guard. Outside i64 the mask is not injective — 2^63 zigzags to the same
    // single 0x00 byte as 0n — so an unguarded writer silently emits bytes for
    // a different value. The reference's own docstring states the i64 domain
    // ("values from -2^63 through 2^63 - 1"); this enforces what it states.
    // Inside the domain the bytes are unchanged, so the port stays faithful.
    throw new Error('encodeVlqZigZagBigInt: value outside i64 range');
  }
  // Two's-complement i64 ZigZag: (v << 1) ^ (v >> 63), with a sign-aware shift.
  // Masking emulates the i64 register the JVM / sigma-rust encode from. Agrees
  // byte-for-byte with encodeVlqZigZag over that function's narrower domain
  // (~±2^52, where doubling still fits a safe integer).
  const masked = value & U64_MAX;
  const sign = value < 0n ? U64_MAX : 0n;
  const zz = ((masked << 1n) & U64_MAX) ^ sign;
  return encodeVlqBigInt(zz);
}
