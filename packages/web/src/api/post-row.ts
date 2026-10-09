import { MAX_CONTENT_BYTES } from '@dagsocial/types';
import type { PostJson, PostType, WithdrawnJson } from './dto';
import {
  isHex64Lower, isNonNegSafeInt, isNonNegSafeIntOrNull, isStatus,
  isParentRefs, isAuthorName, readWithdrawn,
} from './row-fields';

// The row readers the post check lets through
// (WEB_INTERFACE → The extension → "A checked row is taken field by field",
// → "A row that is not well-formed is not shown and not cached"). A `bound`
// row is rebuilt from its own fields as a `PostJson` of exactly those fields
// — no `tx`, no key beyond — and a withdrawn row as a `WithdrawnJson` of its
// own. Both are total: any value in, a rebuilt row or `null` out, never a
// throw. The field predicates and the withdrawn-row rule are the ones
// `light-page.ts` already applies to a light answer (`./row-fields`).

const utf8 = new TextEncoder();

function isPostType(v: unknown): v is PostType {
  return v === 'regular' || v === 'profile';
}

/** A `bound` row's `content` is `null`, or a string whose UTF-8 encoding is
 *  1 to `MAX_CONTENT_BYTES` bytes (TYPES_INTERFACE → Content limits). A
 *  signature binds text of any length, so the length is held here. */
function isContent(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  const bytes = utf8.encode(v).length;
  return bytes >= 1 && bytes <= MAX_CONTENT_BYTES;
}

/** A row the post check answered `bound`, rebuilt from its own fields;
 *  `null` where it is not well-formed (WEB_INTERFACE → The extension →
 *  "A checked row is taken field by field"). A fresh object of the sixteen
 *  fields alone — no `tx`, no `kind`, no `confirmedAuthor`, no key beyond —
 *  so a key a node carries does not reach the client's state or its cache.
 *  Total: any value in, a row or `null` out, never a throw. */
export function readBoundRow(row: unknown): PostJson | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
  const raw = row as Record<string, unknown>;
  if (!isHex64Lower(raw['id'])) return null;
  if (!isHex64Lower(raw['txId'])) return null;
  if (!isHex64Lower(raw['contentHash'])) return null;
  if (!isHex64Lower(raw['author'])) return null;
  if (!isParentRefs(raw['parentRefs'])) return null;
  if (!isContent(raw['content'])) return null;
  if (!isNonNegSafeInt(raw['protocolVersion'])) return null;
  if (!isPostType(raw['type'])) return null;
  if (!isStatus(raw['status'])) return null;
  if (!isNonNegSafeIntOrNull(raw['blockHeight'])) return null;
  if (!isNonNegSafeIntOrNull(raw['blockIndex'])) return null;
  if (!isNonNegSafeIntOrNull(raw['blockCreatedAt'])) return null;
  if (!isNonNegSafeInt(raw['likeCount'])) return null;
  if (!isNonNegSafeInt(raw['descendantCount'])) return null;
  if (!isAuthorName(raw['authorName'])) return null;
  const liked = raw['likedByViewer'];
  if (liked !== null && typeof liked !== 'boolean') return null;
  return {
    id: raw['id'],
    txId: raw['txId'],
    contentHash: raw['contentHash'],
    author: raw['author'],
    parentRefs: [...raw['parentRefs']],
    content: raw['content'],
    protocolVersion: raw['protocolVersion'],
    type: raw['type'],
    status: raw['status'],
    blockHeight: raw['blockHeight'],
    blockIndex: raw['blockIndex'],
    blockCreatedAt: raw['blockCreatedAt'],
    likeCount: raw['likeCount'],
    descendantCount: raw['descendantCount'],
    authorName: raw['authorName'],
    likedByViewer: liked,
  };
}

/** A withdrawn row, rebuilt from its own fields; `null` where it is not
 *  well-formed (WEB_INTERFACE → The extension → "A row that is not
 *  well-formed is not shown and not cached"). The rule is the one
 *  `light-page.ts` already applies to a withdrawn row of a light answer
 *  (`./row-fields` → `readWithdrawn`). Total: any value in, a row or `null`
 *  out, never a throw. */
export function readWithdrawnRow(row: unknown): WithdrawnJson | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
  return readWithdrawn(row as Record<string, unknown>);
}
