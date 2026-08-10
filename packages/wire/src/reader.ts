import { ReaderError } from './errors.js';

export const MAX_ARRAY_LENGTH = 1 << 24;

/**
 * Hard cap on the number of bytes a single VLQ may occupy: `ceil(64 / 7)`, the
 * exact width of a canonical u64 — which `readVlqBigInt` / `encodeVlqBigInt`
 * now reach. A value in the narrower `number` range [0, 2^53-1] needs at most 8,
 * so for that path the remaining two bytes are slack that tolerates
 * non-canonical zero-padded encodings. Either way it bounds the read loop on a
 * malformed stream, and it matches the contract's "exceeds 10 bytes" rule.
 */
export const MAX_VLQ_BYTES = 10;

export class ByteReader {
  private _position = 0;
  private _positionLimit: number;

  constructor(private readonly bytes: Uint8Array) {
    this._positionLimit = bytes.length;
  }

  get position(): number { return this._position; }
  get remaining(): number { return this.bytes.length - this._position; }
  get isExhausted(): boolean { return this._position >= this.bytes.length; }

  private checkPositionLimit(): void {
    if (this._position > this._positionLimit) {
      throw new ReaderError(
        `position limit ${this._positionLimit} reached at position ${this._position}`,
        'position-limit-exceeded',
      );
    }
  }

  readU8(): number {
    this.checkPositionLimit();
    if (this._position >= this.bytes.length) {
      throw new ReaderError(`readU8: EOF at ${this._position}`, 'truncated');
    }
    return this.bytes[this._position++]!;
  }

  readBytes(n: number): Uint8Array {
    this.checkPositionLimit();
    if (this.remaining < n) {
      throw new ReaderError(`readBytes(${n}): only ${this.remaining} available`, 'truncated');
    }
    const out = this.bytes.subarray(this._position, this._position + n);
    this._position += n;
    return out;
  }

  readBool(): boolean {
    const b = this.readU8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new ReaderError(`readBool: expected 0 or 1, got ${b}`, 'invalid-tag');
  }

  readVlqU(): number {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (true) {
      const b = this.readU8();
      bytesRead++;
      // Multiplication instead of bitwise shift: `<<` coerces to 32 bits and
      // would silently corrupt anything at or above 2^32. `(b & 0x7f) * 2**shift`
      // is exact for every shift used here (7 significant bits scaled by a power
      // of two), so the only inexactness risk is the running sum — guarded below.
      const chunk = (b & 0x7f) * (2 ** shift);
      if (chunk > Number.MAX_SAFE_INTEGER - value) {
        throw new ReaderError('readVlqU: value exceeds safe integer range', 'vlq-overflow');
      }
      value += chunk;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (bytesRead >= MAX_VLQ_BYTES) {
        throw new ReaderError(`readVlqU: VLQ exceeds ${MAX_VLQ_BYTES} bytes`, 'vlq-overflow');
      }
    }
    return value;
  }

  readVlqS(): number {
    const u = this.readVlqU();
    // ZigZag decode, arithmetic rather than `(u >>> 1) ^ -(u & 1)`: the bitwise
    // form coerces to 32 bits and misdecodes any zigzag value at or above 2^32.
    // even -> u/2, odd -> -(u+1)/2.
    const half = Math.floor(u / 2);
    return u % 2 === 0 ? half : -(half + 1);
  }

  /**
   * Reads an unsigned VLQ as a `bigint` over the full u64 range.
   *
   * Accumulates into 64 bits and WRAPS on the way out (`BigInt.asUintN(64, …)`)
   * exactly as the references do — sigma-rust `vlq_encode::get_u64`, JVM
   * scorex-util `getULong`, both the protobuf `CodedInputStream` loop. A 10-byte
   * encoding whose bits run past bit 63 therefore decodes to the same value here
   * as it does everywhere else, rather than to a wider bigint only this
   * implementation would produce.
   *
   * **Non-minimal encodings are accepted, by design.** `0x81 0x00` decodes to
   * `1n` just as `0x01` does. Canonicity is enforced one layer up, by
   * re-encoding and byte-comparing the result — which works only because decode
   * is permissive and re-encode is minimal. Rejecting here would not be
   * stricter, it would break that layering.
   *
   * Port note: scorex checks its position limit once at entry and then reads
   * unchecked, so a VLQ may straddle an armed limit like the JVM `getULong`.
   * That distinction cannot arise in this package — `_positionLimit` is
   * constructor-only and always `bytes.length`, and `forkSubReader` was stripped
   * (WIRE_INTERFACE → "Stripped from scorex") — so this uses the same checked
   * `readU8()` as `readVlqU`, and no unchecked read primitive is introduced.
   *
   * - **Throws:** `ReaderError('truncated')` if truncated mid-VLQ
   * - **Throws:** `ReaderError('vlq-overflow')` if the encoding exceeds
   *   `MAX_VLQ_BYTES`
   */
  readVlqBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < MAX_VLQ_BYTES; i++) {
      const b = this.readU8();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw new ReaderError(`readVlqBigInt: VLQ exceeds ${MAX_VLQ_BYTES} bytes`, 'vlq-overflow');
  }

  /**
   * Reads a ZigZag-encoded signed VLQ as a `bigint` over the i64 range.
   *
   * `(zz >> 1n) ^ -(zz & 1n)` — the bitwise form the `number` path cannot use,
   * because there `-(u & 1)` is 32-bit. On BigInt it sign-extends natively:
   * `-(1n)` is `-1n` at arbitrary precision, and XOR with it flips every bit,
   * yielding the negative value directly.
   */
  readVlqBigIntSigned(): bigint {
    const zz = this.readVlqBigInt();
    return (zz >> 1n) ^ -(zz & 1n);
  }

  readArray<T>(reader: (r: ByteReader) => T): T[] {
    const length = this.readVlqU();
    if (length > MAX_ARRAY_LENGTH) {
      throw new ReaderError(`readArray: length ${length} exceeds max ${MAX_ARRAY_LENGTH}`, 'array-too-large');
    }
    // An element reader consumes at least one byte, so a count above the bytes
    // remaining cannot decode — WIRE_INTERFACE → "MAX_ARRAY_LENGTH bounds the
    // count, not the memory".
    if (length > this.remaining) {
      throw new ReaderError(
        `readArray: length ${length} exceeds ${this.remaining} byte(s) remaining`,
        'truncated',
      );
    }
    const out: T[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = reader(this);
    return out;
  }

  readOption<T>(reader: (r: ByteReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return reader(this);
    throw new ReaderError(`readOption: expected tag 0 or 1, got ${tag}`, 'invalid-tag');
  }
}
