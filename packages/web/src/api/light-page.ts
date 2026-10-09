import type { LightJson, WithdrawnJson } from './dto';
import { PageError } from './errors';
import {
  isHex64Lower, isNonNegSafeInt, isNonNegSafeIntOrNull, isStatus,
  isParentRefs, isAuthorName, readWithdrawn,
} from './row-fields';

// Read a light page's rows (WEB_INTERFACE → The extension → "The light read"):
// every row of every list of the answer is a `LightJson` or a `WithdrawnJson`
// with each field of its type, or the read fails as one the node did not
// answer. Each row answered is a fresh object of its type's fields alone — a
// key the type does not name is not carried
// (WEB_INTERFACE → The extension → "Each row is taken field by field").

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

/** One row of a light answer, rebuilt from its own fields; throws `PageError`
 *  on anything that is neither a well-formed `LightJson` nor a well-formed
 *  `WithdrawnJson` (WEB_INTERFACE → The extension → "The light read"). Total:
 *  no throw but `PageError`. */
export function readLightRow(row: unknown): LightJson | WithdrawnJson {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new PageError();
  const raw = row as Record<string, unknown>;
  const kind = raw['kind'];
  if (kind === 'light') {
    const r = readLight(raw);
    if (r === null) throw new PageError();
    return r;
  }
  if (kind === 'withdrawn') {
    const r = readWithdrawn(raw);
    if (r === null) throw new PageError();
    return r;
  }
  throw new PageError();
}

/** The rows of one list of a light answer, each rebuilt from its own fields;
 *  throws `PageError` on a value that is not an array, as on any row that is
 *  neither a well-formed `LightJson` nor a well-formed `WithdrawnJson`
 *  (WEB_INTERFACE → The extension → "A light page is held to its shape").
 *  Total: no throw but `PageError`. */
export function readLightRows(rows: unknown): Array<LightJson | WithdrawnJson> {
  if (!Array.isArray(rows)) throw new PageError();
  const out: Array<LightJson | WithdrawnJson> = [];
  for (const row of rows) out.push(readLightRow(row));
  return out;
}
