import { el, reportNode } from '../dom';
import { card, type ParentRef } from './card';
import type { PostJson } from '../api/dto';
import type { FeedState, RenderCtx, Handlers } from '../model/state';

// The feed: roots and replies in one column, newest first.
// A reply shows its parent as a one-line reference, not a rendered card.

function ctlBtn(glyph: string, label: string, fn: () => void): HTMLElement {
  const b = el('button', 'ctl', glyph);
  b.setAttribute('aria-label', label);
  b.addEventListener('click', fn);
  return b;
}

function parentRefFor(post: PostJson, ctx: RenderCtx): ParentRef | null {
  const parentId = post.parentRefs[0];
  if (!parentId) return null;
  const parent = ctx.post(parentId);
  const excerpt = parent?.content ?? undefined;
  return {
    id: parentId,
    authorKey: parent?.author,
    excerpt: excerpt ? excerpt.slice(0, 80) : undefined,
  };
}

export function renderFeedInto(container: HTMLElement, feed: FeedState, handlers: Handlers, ctx: RenderCtx): void {
  container.textContent = '';

  const head = el('div', 'feed-head');
  head.appendChild(el('b', null, 'feed'));
  head.appendChild(ctlBtn('↻', 'refresh the feed', handlers.refreshFeed));
  // Ruling 8: the note reads "newest first", and nothing else.
  head.appendChild(el('span', 'note', 'newest first'));
  container.appendChild(head);

  if (feed.error) {
    container.appendChild(el('div', 'error', `can't reach the node right now — ${feed.error}`));
    return;
  }
  if (feed.report) container.appendChild(reportNode(feed.report));

  if (!feed.loaded && feed.loading) {
    container.appendChild(el('div', 'loading', 'loading…'));
    return;
  }

  // Pending (mempool) posts are the newest — they sit above the confirmed ones,
  // hollow, before any composer exists to create one.
  for (const p of feed.pending) {
    container.appendChild(card(p, { replyCount: null, parentRef: parentRefFor(p, ctx), onOpen: (id) => handlers.openThread(id, { from: 'feed' }) }));
  }
  for (const p of feed.posts) {
    container.appendChild(
      card(p, {
        open: ctx.openSet.has(p.id),
        replyCount: null,
        parentRef: parentRefFor(p, ctx),
        onOpen: (id) => handlers.openThread(id, { from: 'feed' }),
      }),
    );
  }

  if (feed.loaded && feed.posts.length === 0 && feed.pending.length === 0) {
    container.appendChild(el('div', 'loading', 'no posts yet.'));
  }

  // Load older is a button that reports what it did — never infinite scroll,
  // the variable-ratio lever the motion contract names.
  const foot = el('div', 'feed-foot');
  if (feed.next !== null) {
    const b = el('button', 'mini');
    b.setAttribute('aria-label', 'load older posts');
    b.appendChild(el('span', null, 'load older'));
    if (feed.loading) (b as HTMLButtonElement).disabled = true;
    else b.addEventListener('click', handlers.loadOlder);
    foot.appendChild(b);
    if (feed.olderReport) foot.appendChild(el('span', 'note', feed.olderReport));
  } else if (feed.loaded) {
    foot.appendChild(el('span', 'note', feed.olderReport ?? 'no older posts'));
  }
  container.appendChild(foot);
}
