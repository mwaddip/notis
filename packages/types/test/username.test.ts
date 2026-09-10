import { describe, it, expect } from 'vitest';
import { isValidUsernameBytes, canonicalUsernameBytes, USERNAME_MAX_BYTES } from '../src/index.js';

describe('isValidUsernameBytes', () => {
  it('accepts a 1-byte lowercase name', () => {
    expect(isValidUsernameBytes(new Uint8Array([0x61]))).toBe(true); // 'a'
  });

  it('accepts a USERNAME_MAX_BYTES name', () => {
    expect(isValidUsernameBytes(new Uint8Array(USERNAME_MAX_BYTES).fill(0x41))).toBe(true);
  });

  it('accepts digits, underscore and mixed case', () => {
    // 'Alice_99'
    expect(isValidUsernameBytes(new Uint8Array([0x41, 0x6c, 0x69, 0x63, 0x65, 0x5f, 0x39, 0x39]))).toBe(true);
  });

  it('refuses an empty name', () => {
    expect(isValidUsernameBytes(new Uint8Array(0))).toBe(false);
  });

  it('refuses a name over USERNAME_MAX_BYTES', () => {
    expect(isValidUsernameBytes(new Uint8Array(USERNAME_MAX_BYTES + 1).fill(0x61))).toBe(false);
  });

  it('refuses a space', () => {
    expect(isValidUsernameBytes(new Uint8Array([0x20]))).toBe(false); // ' '
  });

  it('refuses a dot', () => {
    expect(isValidUsernameBytes(new Uint8Array([0x2e]))).toBe(false); // '.'
  });

  it('refuses a hyphen', () => {
    expect(isValidUsernameBytes(new Uint8Array([0x2d]))).toBe(false); // '-'
  });

  it('refuses a byte outside ASCII', () => {
    expect(isValidUsernameBytes(new Uint8Array([0x80]))).toBe(false);
  });

  it('refuses a null byte', () => {
    expect(isValidUsernameBytes(new Uint8Array([0x00]))).toBe(false);
  });
});

describe('canonicalUsernameBytes', () => {
  it('lowercases A–Z', () => {
    // 'ALICE' → 'alice'
    const input = new Uint8Array([0x41, 0x4c, 0x49, 0x43, 0x45]);
    const expected = new Uint8Array([0x61, 0x6c, 0x69, 0x63, 0x65]);
    expect(canonicalUsernameBytes(input)).toEqual(expected);
  });

  it('does not touch lowercase, digits or underscore', () => {
    // 'alice_99'
    const input = new Uint8Array([0x61, 0x6c, 0x69, 0x63, 0x65, 0x5f, 0x39, 0x39]);
    expect(canonicalUsernameBytes(input)).toEqual(input);
  });

  it('handles mixed case', () => {
    // 'Alice_99' → 'alice_99'
    const input = new Uint8Array([0x41, 0x6c, 0x69, 0x63, 0x65, 0x5f, 0x39, 0x39]);
    const expected = new Uint8Array([0x61, 0x6c, 0x69, 0x63, 0x65, 0x5f, 0x39, 0x39]);
    expect(canonicalUsernameBytes(input)).toEqual(expected);
  });

  it('returns a new array', () => {
    const input = new Uint8Array([0x61]);
    const result = canonicalUsernameBytes(input);
    expect(result).not.toBe(input);
    expect(result).toEqual(input);
  });

  it('passes through bytes outside A–Z unchanged', () => {
    // Even bytes outside the valid alphabet pass through — the canonical form
    // is a pure map and the alphabet is not its concern.
    const input = new Uint8Array([0x2e, 0x41]);
    const expected = new Uint8Array([0x2e, 0x61]);
    expect(canonicalUsernameBytes(input)).toEqual(expected);
  });
});
