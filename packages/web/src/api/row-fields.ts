import { isValidUsernameBytes } from '@dagsocial/types';
import type { PostStatus, WithdrawnJson } from './dto';

// Field predicates and the withdrawn-row reader shared by the two readers of
// the extension's post reads — the light reader (`light-page.ts`) and the
// bound-row reader (`post-row.ts`). One implementation of each field rule,
// imported from both, keeps every list and every single read holding to the
// same shape (WEB_INTERFACE → The extension → "Each row is taken field by
// field", → "A checked row is taken field by field").

const HEX64 = /^[0-9a-f]{64}$/;
const utf8 = new TextEncoder();

export function isHex64Lower(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

export function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function isNonNegSafeIntOrNull(v: unknown): v is number | null {
  return v === null || isNonNegSafeInt(v);
}

export function isStatus(v: unknown): v is PostStatus {
  return v === 'pending' || v === 'confirmed';
}

/** A row's `parentRefs` is an array of none or one 64-lowercase-hex string
 *  (NODE_INTERFACE → Posts → "A light row is a post's id and the node's
 *  word", TYPES_INTERFACE → Content limits). */
export function isParentRefs(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > 1) return false;
  for (const p of v) if (!isHex64Lower(p)) return false;
  return true;
}

/** `authorName` is `null` or a well-formed name — the one rule
 *  `isValidUsernameBytes` of `@dagsocial/types` states over its UTF-8 bytes
 *  (TYPES_INTERFACE → Content limits). The web client is served by that rule,
 *  never a copy of it. */
export function isAuthorName(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  return isValidUsernameBytes(utf8.encode(v));
}

/** A withdrawn row, rebuilt from its own fields; `null` where a field is not
 *  well-formed. The row is a fresh object of its type's fields alone — a key
 *  the type does not name is not carried (WEB_INTERFACE → The extension →
 *  "The light read", → "A checked row is taken field by field"). */
export function readWithdrawn(raw: Record<string, unknown>): WithdrawnJson | null {
  if (raw['kind'] !== 'withdrawn') return null;
  if (!isHex64Lower(raw['id'])) return null;
  if (!isHex64Lower(raw['txId'])) return null;
  if (!isHex64Lower(raw['author'])) return null;
  if (!isParentRefs(raw['parentRefs'])) return null;
  if (!isNonNegSafeInt(raw['withdrawnAtHeight'])) return null;
  if (!isNonNegSafeInt(raw['descendantCount'])) return null;
  if (!isAuthorName(raw['authorName'])) return null;
  return {
    kind: 'withdrawn',
    id: raw['id'],
    author: raw['author'],
    withdrawnAtHeight: raw['withdrawnAtHeight'],
    parentRefs: [...raw['parentRefs']],
    descendantCount: raw['descendantCount'],
    authorName: raw['authorName'],
    txId: raw['txId'],
  };
}
