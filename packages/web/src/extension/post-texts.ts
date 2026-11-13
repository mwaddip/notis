import type { PostTextProvider } from '@dagsocial/net/browser';
import type { PostCache } from '../model/state';

export function postTextsFromCache(
  _cache: Pick<PostCache, 'getMany'>,
): PostTextProvider {
  return async () => new Map<string, string>();
}
