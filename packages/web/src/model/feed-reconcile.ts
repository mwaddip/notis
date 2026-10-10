import type { PostJson, LightJson, FeedRow } from '../api/dto';
import { isWithdrawn } from '../api/dto';

// A feed row is a live post, a withdrawn marker or a slot (WEB_INTERFACE → The
// extension → "The light read"). The feed carries live rows — a full post the
// node served, or a slot a reader that lacks the post holds against its id —
// never a withdrawn marker, which is filtered out of a list (WEB_INTERFACE →
// The withdrawn state).
export const isLivePost = (r: FeedRow): r is PostJson | LightJson => !isWithdrawn(r);

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
 *
 * A row carried through is live — a full post or a slot: the feed holds either
 * (WEB_INTERFACE → The extension → "The light read"), and a slot keeps its
 * place by its id, as a full row does.
 */
export async function reconcileNewer(
  held: Array<PostJson | LightJson>,
  fetchPage: (after: string | null) => Promise<RawPage>,
  cap: number,
): Promise<{ posts: Array<PostJson | LightJson>; next: string | null | undefined; newCount: number }> {
  const haveIds = new Set(held.map((p) => p.id));
  const collected: Array<PostJson | LightJson> = [];
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

// These two functions form the lines a `↻` and a `load older` write, at the
// write and at every recount, so the two can never differ in wording or in
// the singular (WEB_INTERFACE → The extension →
// "A report counts the posts that stand").

/** The line a feed's ↻ or an author window's ↻ reports: how many new posts
 *  the read brought that still stand (WEB_INTERFACE → The extension →
 *  "A report counts the posts that stand"). */
export function newPostsLine(n: number): string {
  return n ? `${n} new ${n === 1 ? 'post' : 'posts'}` : 'no new posts';
}

/** The line a `load older` reports: how many older posts the page brought
 *  that still stand (WEB_INTERFACE → The extension → "A report counts the
 *  posts that stand"). */
export function olderPostsLine(n: number): string {
  return n ? `${n} older ${n === 1 ? 'post' : 'posts'}` : 'no older posts';
}

/** The ids a `↻` or a `load older` counted beside the text it wrote: a row
 *  comes off the count as its slot leaves, and the recount reads what is left
 *  only while the field still reads that text (WEB_INTERFACE → The extension →
 *  "A report counts the posts that stand"). */
export interface ReportCount {
  ids: Set<string>;
  text: string;
}
