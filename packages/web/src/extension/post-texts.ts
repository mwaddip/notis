// WEB_INTERFACE → The settings window → "The serve row",
// → The extension → "The post cache" → "A serving read is answered from it".
// The `PostTextProvider` the mesh client's serving reader answers from — a
// request for ids walks the cache's `getMany` and answers each id whose
// entry holds a live post's text. A withdrawn entry, one without text, or
// an id the cache lacks is left out. The read moves no entry's last-seen
// (`getMany` opens a readonly transaction).

import type { PostTextProvider } from '@dagsocial/net/browser';
import type { PostJson } from '../api/dto';
import type { PostCache } from '../model/state';

export function postTextsFromCache(
  cache: Pick<PostCache, 'getMany'>,
): PostTextProvider {
  return async (ids) => {
    const held = await cache.getMany(ids);
    const out = new Map<string, string>();
    for (const [id, entry] of held) {
      // A withdrawn row carries no `content`, so this one check answers
      // both arms of the rule — an entry that holds a live post's text
      // (WEB_INTERFACE → The extension → "The post cache" → "A serving
      // read is answered from it").
      const content = (entry.row as Partial<PostJson>).content;
      if (typeof content !== 'string') continue;
      out.set(id, content);
    }
    return out;
  };
}
