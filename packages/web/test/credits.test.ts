// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { formatCredits, parseCredits, BASE_UNITS_PER_CREDIT } from '../src/model/credits';

// The denomination module — WEB_INTERFACE → The wallet ("A credits amount
// crosses the API in base units and reaches the face in $NOTIS"). Every surface
// that shows a credits amount reads it; the shape is pinned here.

describe('formatCredits — base units → the face string', () => {
  it('the vector table', () => {
    expect(formatCredits(0n)).toBe('0');
    expect(formatCredits(100000000n)).toBe('1');
    expect(formatCredits(1250000000n)).toBe('12.5');
    expect(formatCredits(1n)).toBe('0.00000001');
    expect(formatCredits(12345678900000000n)).toBe('123456789');
  });

  it('trailing zeros drop after the point but the leading whole stays', () => {
    expect(formatCredits(150000000n)).toBe('1.5'); // 1.50000000 → 1.5
    expect(formatCredits(10000000n)).toBe('0.1');  // 0.10000000 → 0.1
  });

  it('the constant is 10⁸', () => {
    expect(BASE_UNITS_PER_CREDIT).toBe(100000000n);
  });
});

describe('parseCredits — the face string → base units', () => {
  it('the vector table', () => {
    expect(parseCredits('12.5')).toBe(1250000000n);
    expect(parseCredits('100')).toBe(10000000000n);
  });

  it('at most eight decimals, no fewer', () => {
    expect(parseCredits('0.00000001')).toBe(1n);
    expect(parseCredits('0.123456789')).toBeNull(); // nine decimals
  });

  it('the ends are trimmed', () => {
    expect(parseCredits('  1.5  ')).toBe(150000000n);
  });

  it('every refusal named in §1 answers null', () => {
    expect(parseCredits('')).toBeNull();
    expect(parseCredits('.5')).toBeNull();     // no leading digit
    expect(parseCredits('12.')).toBeNull();    // trailing point
    expect(parseCredits('1e3')).toBeNull();    // exponent
    expect(parseCredits('-1')).toBeNull();     // sign
    expect(parseCredits('1 2')).toBeNull();    // whitespace inside
    expect(parseCredits('1.2.3')).toBeNull();  // two points
    expect(parseCredits('abc')).toBeNull();
  });
});
