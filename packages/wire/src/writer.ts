import { encodeVlqBigInt, encodeVlqZigZagBigInt, zigZag } from './vlq.js';

export class ByteWriter {
  // One buffer, doubled when a write would overrun it:
  // WIRE_INTERFACE → ByteWriter → "A write costs what its bytes cost".
  private buffer = new Uint8Array(64);
  private _length = 0;

  get length(): number { return this._length; }

  writeU8(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`writeU8: out of range: ${byte}`);
    }
    this.reserve(1);
    this.buffer[this._length] = byte;
    this._length += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this._length);
    this._length += bytes.length;
  }

  private reserve(extra: number): void {
    const needed = this._length + extra;
    if (needed <= this.buffer.length) return;
    const grown = new Uint8Array(Math.max(this.buffer.length * 2, needed));
    grown.set(this.buffer.subarray(0, this._length));
    this.buffer = grown;
  }

  writeVlqU(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`writeVlqU: invalid value: ${value}`);
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new Error('writeVlqU: value exceeds safe integer range');
    }
    // Arithmetic, not bitwise: `&`/`>>>` coerce to 32 bits, which silently
    // mis-encodes every value at or above 2^32.
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
    const zz = zigZag(value);
    this.writeVlqU(zz);
  }

  /**
   * Writes an unsigned VLQ from a `bigint` over the full u64 range.
   *
   * Delegates to `encodeVlqBigInt` rather than carrying its own loop: each
   * encoding has one loop, the `number` one in `writeVlqU` and this one in
   * `encodeVlqBigInt` (`WIRE_INTERFACE → encodeVlqU`). Its bytes are consensus —
   * box ids, tx ids, post ids, Merkle roots and the `stateRoot` all ride on them.
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
    return this.buffer.slice(0, this._length);
  }
}
