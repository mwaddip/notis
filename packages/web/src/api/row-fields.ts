import {
  isHex64Lower, isNonNegSafeInt, isNonNegSafeIntOrNull, isAuthorName,
} from '@dagsocial/node-reads';
import type { PostStatus, WithdrawnJson } from './dto';

// The two post-row readers of the extension's post reads — the light reader
// (`light-page.ts`) and the bound-row reader (`post-row.ts`) — share the
// field predicates `@dagsocial/node-reads`' `fields.ts` names and the
// web-only pieces named here: the post status enum, parentRefs and the
// withdrawn-row rule, which are the web's alone.
// (WEB_INTERFACE → The extension → "Each row is taken field by field",
// → "A checked row is taken field by field").

export { isHex64Lower, isNonNegSafeInt, isNonNegSafeIntOrNull, isAuthorName };

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
