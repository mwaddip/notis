import type { LightJson, WithdrawnJson, PostStatus } from './dto';
import { PageError } from './client';
import { isValidUsernameBytes } from '@dagsocial/types';

// Read a light page's rows (WEB_INTERFACE → The extension → "The light read"):
// every row of every list of the answer is a `LightJson` or a `WithdrawnJson`
// with each field of its type, or the read fails as one the node did not
// answer. Each row answered is a fresh object of its type's fields alone — a
// key the type does not name is not carried (contract → "Each row is taken
// field by field").

const HEX64 = /^[0-9a-f]{64}$/;
const utf8 = new TextEncoder();

function isHex64Lower(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isNonNegSafeIntOrNull(v: unknown): v is number | null {
  return v === null || isNonNegSafeInt(v);
}

function isStatus(v: unknown): v is PostStatus {
  return v === 'pending' || v === 'confirmed';
}

/** A row's `parentRefs` is an array of none or one 64-lowercase-hex string
 *  (NODE_INTERFACE → Posts → "A light row is a post's id and the node's
 *  word", TYPES_INTERFACE → Content limits — MAX_PARENT_REFS). */
function isParentRefs(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > 1) return false;
  for (const p of v) if (!isHex64Lower(p)) return false;
  return true;
}

/** `authorName` is `null` or a well-formed name — the one rule
 *  `isValidUsernameBytes` of `@dagsocial/types` states over its UTF-8 bytes
 *  (TYPES_INTERFACE → Content limits). The web client is served by that rule,
 *  never a copy of it. */
function isAuthorName(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== 'string') return false;
  return isValidUsernameBytes(utf8.encode(v));
}

function readLight(raw: Record<string, unknown>): LightJson | null {
  if (raw['kind'] !== 'light') return null;
  if (!isHex64Lower(raw['id'])) return null;
  if (!isParentRefs(raw['parentRefs'])) return null;
  if (!isStatus(raw['status'])) return null;
  if (!isNonNegSafeIntOrNull(raw['blockHeight'])) return null;
  if (!isNonNegSafeIntOrNull(raw['blockIndex'])) return null;
  if (!isNonNegSafeIntOrNull(raw['blockCreatedAt'])) return null;
  if (!isNonNegSafeInt(raw['likeCount'])) return null;
  if (!isNonNegSafeInt(raw['descendantCount'])) return null;
  if (!isAuthorName(raw['authorName'])) return null;
  const liked = raw['likedByViewer'];
  if (liked !== null && typeof liked !== 'boolean') return null;
  // A fresh object of the type's fields alone — a key the type does not name
  // is not carried (WEB_INTERFACE → The extension → "The light read" → "Each
  // row is taken field by field").
  return {
    kind: 'light',
    id: raw['id'],
    parentRefs: [...raw['parentRefs']],
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

function readWithdrawn(raw: Record<string, unknown>): WithdrawnJson | null {
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

/** The rows of one list of a light answer, each rebuilt from its own fields;
 *  throws `PageError` on any row that is neither a well-formed `LightJson` nor
 *  a well-formed `WithdrawnJson` (WEB_INTERFACE → The extension → "The light
 *  read"). Total: no throw but `PageError`. */
export function readLightRows(rows: readonly unknown[]): Array<LightJson | WithdrawnJson> {
  const out: Array<LightJson | WithdrawnJson> = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new PageError();
    const raw = row as Record<string, unknown>;
    const kind = raw['kind'];
    if (kind === 'light') {
      const r = readLight(raw);
      if (r === null) throw new PageError();
      out.push(r);
    } else if (kind === 'withdrawn') {
      const r = readWithdrawn(raw);
      if (r === null) throw new PageError();
      out.push(r);
    } else {
      throw new PageError();
    }
  }
  return out;
}
