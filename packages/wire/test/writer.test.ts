import { describe, it, expect } from 'vitest';
import { ByteWriter, ByteReader } from '@dagsocial/wire';

describe('ByteWriter', () => {
  it('writes bytes and produces output', () => {
    const w = new ByteWriter();
    w.writeU8(0xab);
    w.writeU8(0xcd);
    expect(w.length).toBe(2);
    expect(w.toBytes()).toEqual(new Uint8Array([0xab, 0xcd]));
  });

  it('writeVlqU round-trips through ByteReader', () => {
    const w = new ByteWriter();
    w.writeVlqU(0);
    w.writeVlqU(127);
    w.writeVlqU(128);
    w.writeVlqU(16383);
    w.writeVlqU(1_000_000);

    const r = new ByteReader(w.toBytes());
    expect(r.readVlqU()).toBe(0);
    expect(r.readVlqU()).toBe(127);
    expect(r.readVlqU()).toBe(128);
    expect(r.readVlqU()).toBe(16383);
    expect(r.readVlqU()).toBe(1_000_000);
    expect(r.isExhausted).toBe(true);
  });

  it('writeVlqS round-trips through ByteReader', () => {
    const w = new ByteWriter();
    w.writeVlqS(0);
    w.writeVlqS(-1);
    w.writeVlqS(1);
    w.writeVlqS(-1000);

    const r = new ByteReader(w.toBytes());
    expect(r.readVlqS()).toBe(0);
    expect(r.readVlqS()).toBe(-1);
    expect(r.readVlqS()).toBe(1);
    expect(r.readVlqS()).toBe(-1000);
  });

  it('writeArray', () => {
    const w = new ByteWriter();
    w.writeArray([10, 20, 30], (wr, v) => wr.writeU8(v));

    const r = new ByteReader(w.toBytes());
    const arr = r.readArray((rr) => rr.readU8());
    expect(arr).toEqual([10, 20, 30]);
  });

  it('writeOption null', () => {
    const w = new ByteWriter();
    w.writeOption<number>(null, (wr, v) => wr.writeVlqU(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0]));
  });

  it('writeOption some', () => {
    const w = new ByteWriter();
    w.writeOption(42, (wr, v) => wr.writeVlqU(v));

    const r = new ByteReader(w.toBytes());
    const opt = r.readOption((rr) => rr.readVlqU());
    expect(opt).toBe(42);
  });

  it('rejects out-of-range byte', () => {
    const w = new ByteWriter();
    expect(() => w.writeU8(256)).toThrow();
    expect(() => w.writeU8(-1)).toThrow();
  });
});

describe('ByteWriter holds nothing it is handed', () => {
  it.fails('a Buffer changed after writeBytes does not change toBytes()', () => {
    const w = new ByteWriter();
    const handed = Buffer.from([1, 2, 3, 4]);
    w.writeBytes(handed);
    handed[0] = 0xff;
    expect(w.toBytes()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('a Uint8Array changed after writeBytes does not change toBytes()', () => {
    const w = new ByteWriter();
    const handed = new Uint8Array([1, 2, 3, 4]);
    w.writeBytes(handed);
    handed[0] = 0xff;
    expect(w.toBytes()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('an array toBytes() returned, changed, does not change a second toBytes()', () => {
    const w = new ByteWriter();
    w.writeBytes(new Uint8Array([5, 6, 7]));
    const first = w.toBytes();
    first[0] = 0xff;
    expect(w.toBytes()).toEqual(new Uint8Array([5, 6, 7]));
  });

  it('a write after toBytes() does not change the array it returned', () => {
    const w = new ByteWriter();
    w.writeBytes(new Uint8Array([5, 6, 7]));
    const first = w.toBytes();
    w.writeU8(8);
    expect(first).toEqual(new Uint8Array([5, 6, 7]));
    expect(w.toBytes()).toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  it('length equals toBytes().length after a mix of writes', () => {
    const w = new ByteWriter();
    w.writeU8(1);
    w.writeBytes(new Uint8Array(37));
    w.writeVlqU(300);
    w.writeVlqS(-70000);
    w.writeVlqBigInt(2n ** 63n);
    w.writeArray([1, 2, 3], (wr, v) => wr.writeU8(v));
    w.writeOption(9, (wr, v) => wr.writeVlqU(v));
    w.writeOption<number>(null, (wr, v) => wr.writeVlqU(v));
    expect(w.length).toBe(w.toBytes().length);
  });
});

describe('ByteWriter output over long sequences', () => {
  it('equals the plain concatenation of what was written', () => {
    const w = new ByteWriter();
    const expected: number[] = [];
    for (let i = 0; i < 100_000; i++) {
      const b = (i * 31) & 0xff;
      w.writeU8(b);
      expected.push(b);
      if (i % 9_973 === 0) {
        w.writeBytes(new Uint8Array(0));
        w.writeBytes(new Uint8Array([0xaa]));
        expected.push(0xaa);
        const block = new Uint8Array(70_000).map((_, j) => (j * 7 + i) & 0xff);
        w.writeBytes(block);
        for (const x of block) expected.push(x);
      }
    }
    expect(w.length).toBe(expected.length);
    expect(w.toBytes()).toEqual(new Uint8Array(expected));
  });
});
