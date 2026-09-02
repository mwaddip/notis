import type { PostJson, FeedRow } from '../api/dto';
import { isWithdrawn } from '../api/dto';

// A feed row is a live post or a withdrawn marker; the feed renders posts only.
export const isLivePost = (r: FeedRow): r is PostJson => !isWithdrawn(r);

export interface RawPage {
  posts: FeedRow[];
  next: string | null;
}

/**
 * Reconcile the newest posts on top of what is already held. Pages from the
 * newest toward older, collecting posts not already held, until a page reaches
 * one that is — the reconnection point — or a bounded cap. Without this a burst
 * larger than one page would leave the new rows above the old ones with an
 * unmarked hole between them.
 *
 * On reconnection the collected run is contiguous with the held top, so it is
 * prepended and `next` is left unchanged (returned `undefined`). When the whole
 * span up to the cap is new and never reconnects, the held rows are older than
 * this window: the feed is replaced and `next` is reset to where paging stopped,
 * so `load older` continues correctly.
 */
export async function reconcileNewer(
  held: PostJson[],
  fetchPage: (after: string | null) => Promise<RawPage>,
  cap: number,
): Promise<{ posts: PostJson[]; next: string | null | undefined; newCount: number }> {
  const haveIds = new Set(held.map((p) => p.id));
  const collected: PostJson[] = [];
  let after: string | null = null;
  let lastNext: string | null = null;
  let reconnected = false;

  for (let page = 0; page < cap; page++) {
    const res = await fetchPage(after);
    for (const row of res.posts) {
      if (!isLivePost(row)) continue;
      if (haveIds.has(row.id)) {
        reconnected = true;
        break;
      }
      collected.push(row);
    }
    lastNext = res.next;
    if (reconnected || res.next === null) break;
    after = res.next;
  }

  if (reconnected || collected.length === 0) {
    return { posts: [...collected, ...held], next: undefined, newCount: collected.length };
  }
  return { posts: collected, next: lastNext, newCount: collected.length };
}
