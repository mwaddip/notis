import { encodeVlqBigInt, encodeVlqZigZagBigInt } from './vlq.js';

export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number { return this._length; }

  writeU8(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`writeU8: out of range: ${byte}`);
    }
    this.chunks.push(new Uint8Array([byte]));
    this._length += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice()); // defensive copy
    this._length += bytes.length;
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeVlqU(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`writeVlqU: invalid value: ${value}`);
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error('writeVlqU: value exceeds safe integer range');
    }
    // Arithmetic, not bitwise: `&`/`>>>` coerce to 32 bits, which silently
    // mis-encodes every value at or above 2^32. Keep in sync with encodeVlqU.
    let v = value;
    while (v >= 0x80) {
      this.writeU8((v % 128) + 0x80);
      v = Math.floor(v / 128);
    }
    this.writeU8(v);
  }

  writeVlqS(value: number): void {
    if (!Number.isInteger(value)) {
      throw new Error(`writeVlqS: not an integer: ${value}`);
    }
    // ZigZag, arithmetic rather than `(v << 1) ^ (v >> 31)`: the bitwise form is
    // 32-bit and corrupts anything outside ±2^31. Doubling can push a large
    // magnitude past the safe-integer range — writeVlqU then rejects it loudly
    // instead of truncating. Keep in sync with encodeVlqZigZag.
    const zz = value >= 0 ? value * 2 : -value * 2 - 1;
    this.writeVlqU(zz);
  }

  /**
   * Writes an unsigned VLQ from a `bigint` over the full u64 range.
   *
   * Delegates to `encodeVlqBigInt` rather than carrying its own loop. The
   * `number` pair above duplicates its loop and keeps the two in sync by
   * comment; that is the existing shape and is left alone, but it is not the
   * shape to extend into a path whose bytes are consensus — box ids, tx ids,
   * post ids, Merkle roots and the `stateRoot` all ride on these. One loop
   * cannot drift from itself.
   *
   * - **Throws:** `Error` if negative or above `2^64 - 1`
   */
  writeVlqBigInt(value: bigint): void {
    this.writeBytes(encodeVlqBigInt(value));
  }

  /**
   * Writes a ZigZag-encoded signed VLQ from a `bigint` over the i64 range.
   *
   * - **Throws:** `Error` if outside `[-2^63, 2^63 - 1]`
   */
  writeVlqBigIntSigned(value: bigint): void {
    this.writeBytes(encodeVlqZigZagBigInt(value));
  }

  writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void {
    this.writeVlqU(items.length);
    for (const item of items) serializer(this, item);
  }

  writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void {
    if (value === null) {
      this.writeU8(0);
      return;
    }
    this.writeU8(1);
    serializer(this, value);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
