// WEB_INTERFACE → The settings window → "The serve row",
// → The extension → "The post cache" → "A serving read is answered from it".
// The `PostTextProvider` the mesh client's serving reader answers from — a
// request for ids walks the cache's `getMany` and answers each id whose
// entry holds a live post's text. A withdrawn entry, one without text, or
// an id the cache lacks is left out. The read moves no entry's last-seen
// (`getMany` opens a readonly transaction).

import type { PostTextProvider } from '@dagsocial/net/browser';
import { isWithdrawn } from '../api/dto';
import type { PostCache } from '../model/state';

export function postTextsFromCache(
  cache: Pick<PostCache, 'getMany'>,
): PostTextProvider {
  return async (ids) => {
    const held = await cache.getMany(ids);
    const out = new Map<string, string>();
    for (const [id, entry] of held) {
      if (isWithdrawn(entry.row)) continue;
      const content = entry.row.content;
      if (typeof content !== 'string') continue;
      out.set(id, content);
    }
    return out;
  };
}
