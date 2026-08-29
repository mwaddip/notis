import { describe, it, expect } from 'vitest';
import {
  icbrt,
  membershipBar,
  memberLikesBar,
  MEMBER_LIKES_MULTIPLIER,
} from '../src/index.js';

// TYPES_INTERFACE → Membership; ARCHITECTURE → Membership.
// The golden table is the contract's — each value is derived by hand
// (21³ = 9261 ≤ 10000 < 10648 = 22³) and pinned here, never regenerated
// from the function under test.

describe('icbrt', () => {
  it.each([
    [0, 0],
    [1, 1],
    [7, 1],
    [8, 2],
    [10, 2],
    [26, 2],
    [27, 3],
    [40, 3],
    [63, 3],
    [64, 4],
    [999, 9],
    [1000, 10],
    [1001, 10],
    [10_000, 21],
    [100_000, 46],
    [1_000_000, 100],
    [10_000_000, 215],
  ])('icbrt(%i) = %i', (n, expected) => {
    expect(icbrt(n)).toBe(expected);
  });

  it('cube boundaries: icbrt(r³) = r and icbrt(r³ − 1) = r − 1', () => {
    for (const r of [1, 2, 3, 10, 21, 46, 100, 215, 1000, 10_000, 100_000, 208063]) {
      expect(icbrt(r * r * r), `r=${r}`).toBe(r);
      if (r > 0) expect(icbrt(r * r * r - 1), `r=${r} minus one`).toBe(r - 1);
    }
  });

  it('icbrt(MAX_SAFE_INTEGER) = 208063', () => {
    expect(icbrt(Number.MAX_SAFE_INTEGER)).toBe(208063);
  });

  for (const [n, label] of [
    [-1, 'negative'],
    [1.5, 'non-integer'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [Number.MAX_SAFE_INTEGER + 1, 'above MAX_SAFE_INTEGER'],
  ] as const) {
    it(`throws on ${label}`, () => {
      expect(() => icbrt(n as number)).toThrow();
    });
  }
});

describe('membershipBar (D)', () => {
  // Golden table from ARCHITECTURE → Membership (k = 10, mainnet)
  it.each([
    [0, 10, 1],
    [1, 10, 2],
    [1, 1, 1],
    [4, 10, 3],
    [100, 10, 10],
    [1_000, 10, 21],
    [10_000, 10, 46],
    [100_000, 10, 100],
    [1_000_000, 10, 215],
  ])('membershipBar(%i, %i) = %i', (n, k, expected) => {
    expect(membershipBar(n, k)).toBe(expected);
  });

  it('floors at 1 — the bar is never zero', () => {
    expect(membershipBar(0, 0)).toBe(1);
    expect(membershipBar(0, 10)).toBe(1);
  });

  it('throws when k · N exceeds MAX_SAFE_INTEGER', () => {
    expect(() => membershipBar(Number.MAX_SAFE_INTEGER, 2)).toThrow();
  });

  it.each([
    [-1, 1],
    [1.5, 1],
    [1, -1],
    [1, 1.5],
    [NaN, 1],
    [1, NaN],
  ])('throws on invalid inputs (%s, %s)', (n, k) => {
    expect(() => membershipBar(n, k)).toThrow();
  });
});

describe('memberLikesBar (Y)', () => {
  // Y(N) = MEMBER_LIKES_MULTIPLIER · D(N) — the golden Y column
  it.each([
    [1, 10, 4],
    [4, 10, 6],
    [100, 10, 20],
    [1_000, 10, 42],
    [10_000, 10, 92],
    [100_000, 10, 200],
    [1_000_000, 10, 430],
  ])('memberLikesBar(%i, %i) = %i', (n, k, expected) => {
    expect(memberLikesBar(n, k)).toBe(expected);
  });

  it('is MEMBER_LIKES_MULTIPLIER × membershipBar', () => {
    for (const [n, k] of [[0, 10], [1, 1], [100, 10], [100_000, 10]] as const) {
      expect(memberLikesBar(n, k)).toBe(MEMBER_LIKES_MULTIPLIER * membershipBar(n, k));
    }
  });

  it('validates inputs the same way membershipBar does', () => {
    expect(() => memberLikesBar(-1, 1)).toThrow();
    expect(() => memberLikesBar(1, -1)).toThrow();
    expect(() => memberLikesBar(1.5, 1)).toThrow();
  });
});
