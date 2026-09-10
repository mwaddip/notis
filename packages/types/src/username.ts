import { USERNAME_MAX_BYTES } from './constants.js';

// ASCII byte boundaries — TYPES_INTERFACE → Content limits.
const A = 0x41; // 'A'
const Z = 0x5a; // 'Z'
const a = 0x61; // 'a'
const _0 = 0x30; // '0'
const _9 = 0x39; // '9'
const UNDERSCORE = 0x5f;

function isAlphabetByte(b: number): boolean {
  return (b >= A && b <= Z) || (b >= a && b <= (a + 25)) || (b >= _0 && b <= _9) || b === UNDERSCORE;
}

/**
 * Length in `[1, USERNAME_MAX_BYTES]` and every byte in `[A-Za-z0-9_]`.
 *
 * TYPES_INTERFACE → Content limits.
 */
export function isValidUsernameBytes(name: Uint8Array): boolean {
  if (name.length < 1 || name.length > USERNAME_MAX_BYTES) return false;
  for (let i = 0; i < name.length; i++) {
    if (!isAlphabetByte(name[i]!)) return false;
  }
  return true;
}

/**
 * The byte-wise ASCII lowercase: `A`–`Z` → `a`–`z`, every other byte
 * unchanged. Returns a new array.
 *
 * TYPES_INTERFACE → Content limits.
 */
export function canonicalUsernameBytes(name: Uint8Array): Uint8Array {
  const out = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) {
    const b = name[i]!;
    out[i] = (b >= A && b <= Z) ? b + 0x20 : b;
  }
  return out;
}
