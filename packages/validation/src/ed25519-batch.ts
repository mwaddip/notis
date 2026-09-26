import { ed25519 } from '@noble/curves/ed25519.js';
import type { EdwardsPoint } from '@noble/curves/abstract/edwards.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { verifyEd25519 } from './verify.js';

/** One signature a batch checks: the 64-byte signature, the signed message and the raw 32-byte key. */
export interface Ed25519BatchEntry {
  readonly signature: Uint8Array;
  readonly message: Uint8Array;
  readonly publicKey: Uint8Array;
}

const Point = ed25519.Point;
const Fn = Point.Fn;
/** The group order `L`. */
const L = Fn.ORDER;

/** The transcript's domain, hashed as its ASCII bytes (VALIDATION_INTERFACE → verifyEd25519Batch). */
const BATCH_DOMAIN = 'dagsocial/ed25519-batch/1';
/** A coefficient's width: 128 bits (VALIDATION_INTERFACE → verifyEd25519Batch). */
const BATCH_COEFFICIENT_BYTES = 16;

const DOMAIN_BYTES = Uint8Array.from(BATCH_DOMAIN, (ch) => ch.charCodeAt(0));

/** The byte test `verifyEd25519` applies to each argument (VALIDATION_INTERFACE → Acceptance criterion). */
function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

/** A signature of 64 bytes, a message of bytes and a key of 32 — the shape every entry passes first. */
function hasEntryShape(entry: unknown): entry is Ed25519BatchEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const { signature, message, publicKey } = entry as Record<string, unknown>;
  return (
    isBytes(signature) &&
    signature.length === 64 &&
    isBytes(message) &&
    isBytes(publicKey) &&
    publicKey.length === 32
  );
}

/** `LE32(value)` written at `offset`. */
function writeLE32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * `T = SHA-512("dagsocial/ed25519-batch/1" ‖ LE32(n) ‖ for each entry in order: signature(64) ‖
 * publicKey(32) ‖ LE32(|message|) ‖ message)` (VALIDATION_INTERFACE → verifyEd25519Batch → "The
 * coefficients are derived from the batch, never drawn"). Every entry must have passed its shape
 * check. Exported for the suite, not from the package.
 */
export function transcriptOf(entries: ReadonlyArray<Ed25519BatchEntry>): Uint8Array {
  let size = DOMAIN_BYTES.length + 4;
  for (const { message } of entries) size += 64 + 32 + 4 + message.length;
  const preimage = new Uint8Array(size);
  preimage.set(DOMAIN_BYTES, 0);
  let offset = DOMAIN_BYTES.length;
  writeLE32(preimage, offset, entries.length);
  offset += 4;
  for (const { signature, message, publicKey } of entries) {
    preimage.set(signature, offset);
    offset += 64;
    preimage.set(publicKey, offset);
    offset += 32;
    writeLE32(preimage, offset, message.length);
    offset += 4;
    preimage.set(message, offset);
    offset += message.length;
  }
  return sha512(preimage);
}

/**
 * A coefficient from its digest: the first 16 bytes read little-endian, a zero taken as 1
 * (VALIDATION_INTERFACE → verifyEd25519Batch). Exported for the suite, not from the package.
 */
export function coefficientFrom(digest: Uint8Array): bigint {
  const z = bytesToNumberLE(digest.subarray(0, BATCH_COEFFICIENT_BYTES));
  return z === 0n ? 1n : z;
}

/**
 * `zᵢ = coefficientFrom(SHA-512(T ‖ LE32(i)))` for `i` from 0 to `count − 1`
 * (VALIDATION_INTERFACE → verifyEd25519Batch). Exported for the suite, not from the package.
 */
export function coefficientsOf(transcript: Uint8Array, count: number): bigint[] {
  const preimage = new Uint8Array(transcript.length + 4);
  preimage.set(transcript, 0);
  const coefficients: bigint[] = [];
  for (let i = 0; i < count; i++) {
    writeLE32(preimage, transcript.length, i);
    coefficients.push(coefficientFrom(sha512(preimage)));
  }
  return coefficients;
}

/**
 * A point decoded strictly — `y < p`, and `x = 0` with the sign bit set refused — or `null` for an
 * encoding noble's decoder throws on (VALIDATION_INTERFACE → Acceptance criterion).
 */
function decodePoint(bytes: Uint8Array): EdwardsPoint | null {
  try {
    return Point.fromBytes(bytes, false);
  } catch {
    return null;
  }
}

/**
 * The bucket window's width for a multi-scalar multiplication over `pointCount` points. Exported for
 * the suite, not from the package.
 */
export function windowBitsFor(pointCount: number): number {
  if (pointCount < 64) return 4;
  if (pointCount < 512) return 6;
  if (pointCount < 4096) return 9;
  if (pointCount < 20000) return 11;
  return 12;
}

/** `Σ scalars[i]·points[i]`, every scalar in `[0, L)`, by the bucket method. */
function multiScalarMultiply(points: readonly EdwardsPoint[], scalars: readonly bigint[]): EdwardsPoint {
  const c = windowBitsFor(points.length);
  const windows = Math.ceil(Fn.BITS / c);
  const mask = (1n << BigInt(c)) - 1n;
  const buckets: Array<EdwardsPoint | null> = new Array<EdwardsPoint | null>(1 << c);
  let acc = Point.ZERO;
  for (let w = windows - 1; w >= 0; w--) {
    for (let j = 0; j < c; j++) acc = acc.double();
    buckets.fill(null);
    const shift = BigInt(w * c);
    for (let i = 0; i < points.length; i++) {
      const digit = Number((scalars[i]! >> shift) & mask);
      if (digit === 0) continue;
      const bucket = buckets[digit];
      buckets[digit] = bucket ? bucket.add(points[i]!) : points[i]!;
    }
    // Σ d·bucket[d], as the running sum of the buckets from the top added once per step down.
    let running = Point.ZERO;
    let windowSum = Point.ZERO;
    for (let d = buckets.length - 1; d >= 1; d--) {
      const bucket = buckets[d];
      if (bucket) running = running.add(bucket);
      windowSum = windowSum.add(running);
    }
    acc = acc.add(windowSum);
  }
  return acc;
}

/**
 * Every entry checked as `verifyEd25519` checks it, the whole batch in one cofactored equation
 * (VALIDATION_INTERFACE → verifyEd25519Batch).
 *
 * `true` exactly when every entry passes `verifyEd25519`, except that a batch holding an entry that
 * fails answers `true` with probability at most 2⁻¹²⁸ over its coefficients. Total: a malformed
 * entry answers `false`, never a throw. The empty batch is `true`; a batch of one is
 * `verifyEd25519` itself.
 */
export function verifyEd25519Batch(entries: ReadonlyArray<Ed25519BatchEntry>): boolean {
  if (!Array.isArray(entries)) return false;
  const n = entries.length;
  if (n === 0) return true;
  if (n === 1) {
    const only: unknown = entries[0];
    if (typeof only !== 'object' || only === null) return false;
    const { signature, message, publicKey } = only as Ed25519BatchEntry;
    return verifyEd25519(signature, message, publicKey);
  }

  for (let i = 0; i < n; i++) {
    if (!hasEntryShape(entries[i])) return false;
  }
  const z = coefficientsOf(transcriptOf(entries), n);

  // [8]( Σ zᵢ·Rᵢ + Σ (zᵢ·kᵢ)·Aᵢ − (Σ zᵢ·Sᵢ)·B ) = 0, each distinct key one point whose scalar
  // sums its entries' zᵢ·kᵢ (VALIDATION_INTERFACE → verifyEd25519Batch).
  const points: EdwardsPoint[] = [];
  const scalars: bigint[] = [];
  const keySlot = new Map<string, number>();
  let sumZS = 0n;
  for (let i = 0; i < n; i++) {
    const { signature, message, publicKey } = entries[i]!;
    const s = bytesToNumberLE(signature.subarray(32, 64));
    if (s >= L) return false;

    const key = bytesToHex(publicKey);
    let slot = keySlot.get(key);
    if (slot === undefined) {
      const a = decodePoint(publicKey);
      if (a === null || a.isSmallOrder()) return false;
      slot = points.length;
      points.push(a);
      scalars.push(0n);
      keySlot.set(key, slot);
    }

    const rBytes = signature.subarray(0, 32);
    const r = decodePoint(rBytes);
    if (r === null) return false;

    // kᵢ = SHA-512(Rᵢ ‖ Aᵢ ‖ Mᵢ) mod L, over the entry's own bytes.
    const challenge = new Uint8Array(64 + message.length);
    challenge.set(rBytes, 0);
    challenge.set(publicKey, 32);
    challenge.set(message, 64);
    const k = Fn.create(bytesToNumberLE(sha512(challenge)));

    const zi = z[i]!;
    points.push(r);
    scalars.push(zi);
    scalars[slot] = Fn.create(scalars[slot]! + zi * k);
    sumZS = Fn.create(sumZS + zi * s);
  }
  points.push(Point.BASE);
  scalars.push(Fn.neg(sumZS));

  return multiScalarMultiply(points, scalars).clearCofactor().is0();
}
