import { describe, it, expect } from 'vitest';
import { blockWork } from '../src/index.js';

describe('blockWork', () => {
  it('equals 2^targetBits at every integer target, exactly', () => {
    for (let bits = 0; bits <= 256; bits++) {
      expect(blockWork(bits)).toBe(1n << BigInt(bits));
    }
  });

  it('is 1 at targetBits 0 — every digest meets an all-ones target', () => {
    expect(blockWork(0)).toBe(1n);
  });

  it('is 2^256 at targetBits 256 — only the all-zero digest meets it', () => {
    expect(blockWork(256)).toBe(1n << 256n);
  });

  it('refuses exactly what powTarget refuses', () => {
    expect(blockWork(257)).toBeNull();
    expect(blockWork(-1)).toBeNull();
    expect(blockWork(1.5)).toBeNull();
    expect(blockWork(NaN)).toBeNull();
    expect(blockWork(Infinity)).toBeNull();
  });
});
