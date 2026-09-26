/**
 * The pin — TYPES_INTERFACE → The protocol hash: `hash32` must answer the same
 * bytes as `node:crypto`'s `createHash('blake2b512')`, truncated, over every
 * input size that crosses a BLAKE2b block-length boundary, over a preimage
 * split into several `update()` calls, and against RFC 7693's own vectors.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { hash32 } from '../src/hash.js';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Deterministic content — `i & 0xff`, never `Math.random`. */
function content(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

function nodeBlake2b32(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('blake2b512');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest().subarray(0, 32));
}

describe('hash32 — pinned to createHash(\'blake2b512\').digest().subarray(0, 32)', () => {
  const lengths = [0, 1, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 1000, 4096];

  for (const n of lengths) {
    it(`matches Node for a ${n}-byte input`, () => {
      const data = content(n);
      expect(hex(hash32(data))).toBe(hex(nodeBlake2b32(data)));
    });
  }

  it('answers a fresh 32-byte Uint8Array', () => {
    const out = hash32(content(10));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
  });
});

describe('hash32 — the parts are one stream', () => {
  const whole = content(97);

  // Each row sums to 97 — a different cut of the same preimage into `update()` calls.
  const segmentSplits: number[][] = [
    [0, 97],
    [97, 0],
    [1, 96],
    [48, 49],
    [96, 1],
    [10, 40, 47],
    [32, 32, 33],
    [1, 1, 1, 94],
  ];

  for (const lens of segmentSplits) {
    it(`hash32(a, b, ...) equals hash32(a ‖ b ‖ ...) split as [${lens.join(', ')}]`, () => {
      const parts: Uint8Array[] = [];
      let offset = 0;
      for (const len of lens) {
        parts.push(whole.slice(offset, offset + len));
        offset += len;
      }
      expect(offset).toBe(whole.length);
      expect(hex(hash32(...parts))).toBe(hex(hash32(whole)));
    });
  }
});

describe('hash32 — RFC 7693 reference vectors', () => {
  const encoder = new TextEncoder();

  it('hashes the empty input to the BLAKE2b-512 vector, truncated to 32 bytes', () => {
    expect(hex(hash32(encoder.encode('')))).toBe(
      '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419',
    );
  });

  it('hashes "abc" to the BLAKE2b-512 vector, truncated to 32 bytes', () => {
    expect(hex(hash32(encoder.encode('abc')))).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1',
    );
  });
});
