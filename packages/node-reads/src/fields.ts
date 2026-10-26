// WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
// its own fields" — each node field is held to its type by a total predicate:
// an id 64 lowercase hex (`isHex64` of `@dagsocial/types`), a height or a
// count a non-negative safe integer, a box value a canonical decimal string in
// `[0, 2⁶³)`
// (TYPES_INTERFACE → Box value domain), a sum a non-negative decimal string,
// a name `null` or a well-formed one (TYPES_INTERFACE → Content limits).

import { isValidUsernameBytes } from '@dagsocial/types';

const CANONICAL_NON_NEG_DECIMAL = /^(0|[1-9][0-9]*)$/;
const TWO_POW_63 = 1n << 63n;
const utf8 = new TextEncoder();

/** A non-negative safe integer — a height or a count. */
export function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** `null` or `isNonNegSafeInt`. */
export function isNonNegSafeIntOrNull(v: unknown): v is number | null {
  return v === null || isNonNegSafeInt(v);
}

/** A box value: a canonical non-negative decimal string in `[0, 2⁶³)`
 *  (TYPES_INTERFACE → Box value domain). Canonical means `0`, or a nonzero
 *  digit followed by digits: `01`, a sign, a space, an empty string and
 *  anything else are refused. */
export function isBoxValue(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!CANONICAL_NON_NEG_DECIMAL.test(v)) return false;
  return BigInt(v) < TWO_POW_63;
}

/** A sum: a canonical non-negative decimal string. Same canonical rule as
 *  `isBoxValue`, without the box-value ceiling. */
export function isSum(v: unknown): v is string {
  return typeof v === 'string' && CANONICAL_NON_NEG_DECIMAL.test(v);
}

/** `authorName` is `null` or a well-formed name — the one rule
 *  `isValidUsernameBytes` of `@dagsocial/types` states over its UTF-8 bytes
 *  (TYPES_INTERFACE → Content limits). */
export function isAuthorName(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  return isValidUsernameBytes(utf8.encode(v));
}
