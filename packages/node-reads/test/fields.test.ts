// WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
// its own fields" — each predicate is total, so a node value of any shape
// ends in an accept or a refuse.

import { describe, it, expect } from 'vitest';
import { USERNAME_MAX_BYTES, isHex64 } from '@dagsocial/types';
import {
  isAuthorName,
  isBoxValue,
  isNonNegSafeInt,
  isNonNegSafeIntOrNull,
  isSum,
} from '../src/fields.js';

describe('isHex64', () => {
  it('accepts 64 lowercase hex digits', () => {
    expect(isHex64('ab'.repeat(32))).toBe(true);
    expect(isHex64('0'.repeat(64))).toBe(true);
    expect(isHex64('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('refuses uppercase hex', () => {
    expect(isHex64('AB'.repeat(32))).toBe(false);
    expect(isHex64('AbCd'.repeat(16))).toBe(false);
  });

  it('refuses 63 and 65 characters', () => {
    expect(isHex64('a'.repeat(63))).toBe(false);
    expect(isHex64('a'.repeat(65))).toBe(false);
  });

  it('refuses a non-string, including the empty string', () => {
    expect(isHex64('')).toBe(false);
    expect(isHex64(null)).toBe(false);
    expect(isHex64(undefined)).toBe(false);
    expect(isHex64(0)).toBe(false);
    expect(isHex64({})).toBe(false);
  });
});

describe('isNonNegSafeInt', () => {
  it('accepts 0, a positive integer, and MAX_SAFE_INTEGER', () => {
    expect(isNonNegSafeInt(0)).toBe(true);
    expect(isNonNegSafeInt(1)).toBe(true);
    expect(isNonNegSafeInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('refuses -1', () => {
    expect(isNonNegSafeInt(-1)).toBe(false);
  });

  it('refuses 0.5', () => {
    expect(isNonNegSafeInt(0.5)).toBe(false);
  });

  it('refuses 2**53 (above MAX_SAFE_INTEGER)', () => {
    expect(isNonNegSafeInt(2 ** 53)).toBe(false);
  });

  it('refuses NaN and infinities', () => {
    expect(isNonNegSafeInt(NaN)).toBe(false);
    expect(isNonNegSafeInt(Infinity)).toBe(false);
    expect(isNonNegSafeInt(-Infinity)).toBe(false);
  });

  it('refuses a string, including a decimal one', () => {
    expect(isNonNegSafeInt('1')).toBe(false);
    expect(isNonNegSafeInt('0')).toBe(false);
    expect(isNonNegSafeInt(null)).toBe(false);
  });
});

describe('isNonNegSafeIntOrNull', () => {
  it('accepts null', () => {
    expect(isNonNegSafeIntOrNull(null)).toBe(true);
  });

  it('accepts a non-negative safe integer', () => {
    expect(isNonNegSafeIntOrNull(0)).toBe(true);
    expect(isNonNegSafeIntOrNull(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('refuses the same values isNonNegSafeInt refuses', () => {
    expect(isNonNegSafeIntOrNull(-1)).toBe(false);
    expect(isNonNegSafeIntOrNull(0.5)).toBe(false);
    expect(isNonNegSafeIntOrNull(NaN)).toBe(false);
    expect(isNonNegSafeIntOrNull('1')).toBe(false);
    expect(isNonNegSafeIntOrNull(undefined)).toBe(false);
  });
});

describe('isBoxValue', () => {
  it('accepts "0"', () => {
    expect(isBoxValue('0')).toBe(true);
  });

  it('accepts "1" and other canonical nonzero decimals', () => {
    expect(isBoxValue('1')).toBe(true);
    expect(isBoxValue('42')).toBe(true);
    expect(isBoxValue('100')).toBe(true);
  });

  it('accepts the largest value, 2^63 - 1', () => {
    expect(isBoxValue('9223372036854775807')).toBe(true);
  });

  it('refuses 2^63', () => {
    expect(isBoxValue('9223372036854775808')).toBe(false);
  });

  it('refuses a leading zero: "01"', () => {
    expect(isBoxValue('01')).toBe(false);
  });

  it('refuses a negative sign: "-1"', () => {
    expect(isBoxValue('-1')).toBe(false);
  });

  it('refuses the empty string', () => {
    expect(isBoxValue('')).toBe(false);
  });

  it('refuses a leading space: " 1"', () => {
    expect(isBoxValue(' 1')).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isBoxValue(0)).toBe(false);
    expect(isBoxValue(1n)).toBe(false);
    expect(isBoxValue(null)).toBe(false);
  });
});

describe('isSum', () => {
  it('accepts "0" and a nonzero canonical decimal', () => {
    expect(isSum('0')).toBe(true);
    expect(isSum('1')).toBe(true);
    expect(isSum('42')).toBe(true);
  });

  it('accepts a decimal above 2^63', () => {
    expect(isSum('9223372036854775808')).toBe(true);
    expect(isSum('1'.padEnd(50, '0'))).toBe(true);
  });

  it('refuses a leading zero, a leading space, a sign and the empty string', () => {
    expect(isSum('01')).toBe(false);
    expect(isSum(' 1')).toBe(false);
    expect(isSum('-1')).toBe(false);
    expect(isSum('')).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isSum(1)).toBe(false);
    expect(isSum(null)).toBe(false);
  });
});

describe('isAuthorName', () => {
  it('accepts null', () => {
    expect(isAuthorName(null)).toBe(true);
  });

  it('accepts a one-byte name', () => {
    expect(isAuthorName('A')).toBe(true);
  });

  it('accepts a name at USERNAME_MAX_BYTES', () => {
    expect(isAuthorName('A'.repeat(USERNAME_MAX_BYTES))).toBe(true);
  });

  it('refuses a name one byte over USERNAME_MAX_BYTES', () => {
    expect(isAuthorName('A'.repeat(USERNAME_MAX_BYTES + 1))).toBe(false);
  });

  it('refuses a character outside the alphabet', () => {
    expect(isAuthorName('bad name')).toBe(false);
    expect(isAuthorName('with-hyphen')).toBe(false);
    expect(isAuthorName('é')).toBe(false);
  });

  it('refuses the empty string', () => {
    expect(isAuthorName('')).toBe(false);
  });

  it('refuses a number for a name', () => {
    expect(isAuthorName(1)).toBe(false);
    expect(isAuthorName(0)).toBe(false);
    expect(isAuthorName(undefined)).toBe(false);
  });
});
