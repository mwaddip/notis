import { el, reportNode } from '../dom';
import { card, submissionToPost, flightFor, listCardOpts, type CardOpts } from './card';
import type { PostJson } from '../api/dto';
import { FEED_COMPOSER_KEY, type FeedState, type RenderCtx, type Handlers } from '../model/state';

// The feed: roots alone, newest first — it reads GET /posts?roots=1, so no reply
// renders here; a reply is reached through its thread or its author's window
// (WEB_INTERFACE → What the feed reads).

function ctlBtn(glyph: string, label: string, fn: () => void): HTMLElement {
  const b = el('button', 'ctl', glyph);
  b.setAttribute('aria-label', label);
  b.addEventListener('click', fn);
  return b;
}

/** The reader's own card, once an identity is loaded (WEB_INTERFACE → The profile window). */
function isYou(author: string, ctx: RenderCtx): boolean {
  return ctx.ownKey !== null && author === ctx.ownKey;
}

/** The opts a feed card carries: the identity display — the prefix opens the
 *  author window (WEB_INTERFACE → The identity display) — and the content-image
 *  opts every card shares (WEB_INTERFACE → Content). */
function identityOpts(ctx: RenderCtx, handlers: Handlers): Partial<CardOpts> {
  return {
    onAuthor: (key) => handlers.openAuthor(key, { from: 'feed' }),
    expanded: ctx.expandedImages,
    onExpand: handlers.expandImage,
    onCollapse: handlers.collapseImage,
  };
}

function feedCardOpts(p: PostJson, ctx: RenderCtx, handlers: Handlers): CardOpts {
  const locked = ctx.identity?.locked ?? false;
  return {
    open: ctx.openSet.has(p.id),
    replyCount: p.descendantCount,
    onOpen: (id) => handlers.openThread(id, { from: 'feed' }),
    you: isYou(p.author, ctx),
    ...identityOpts(ctx, handlers),
    ...listCardOpts(p, { ...ctx, locked }, handlers),
  };
}

/** Replace one card in the feed container by post id — the like's press changes
 *  only that card and nothing else moves (WEB_INTERFACE → What the feed reads,
 *  and what a card shows for it). */
export function replaceFeedCard(container: HTMLElement, post: PostJson, ctx: RenderCtx, handlers: Handlers): void {
  const old = container.querySelector<HTMLElement>(`[data-post-id="${post.id}"]`);
  if (!old) return;
  old.replaceWith(card(post, feedCardOpts(post, ctx, handlers)));
}

export function renderFeedInto(container: HTMLElement, feed: FeedState, handlers: Handlers, ctx: RenderCtx): void {
  container.textContent = '';

  const head = el('div', 'feed-head');
  head.appendChild(el('b', null, 'feed'));
  head.appendChild(ctlBtn('↻', 'refresh the feed', handlers.refreshFeed));
  // Ruling 8: the note reads "newest first", and nothing else.
  head.appendChild(el('span', 'note', 'newest first'));
  // `new post`, not `post`: the composer it opens has its own post button, and
  // two controls with different words a few pixels apart is a trap. Only with an
  // identity loaded (WEB_INTERFACE → The write surface).
  if (ctx.writeEnabled) {
    const nb = el('button', 'word');
    nb.setAttribute('data-composer-open', FEED_COMPOSER_KEY);
    nb.setAttribute('aria-label', 'write a new post');
    nb.textContent = 'new post';
    nb.addEventListener('click', () => handlers.openComposer(null));
    head.appendChild(nb);
  }
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

  // Directly under the bar, which is where a new thread will land — the feed is
  // newest first. The composer collapses into the pending card in the same slot.
  const feedComposer = ctx.composerFor(null);
  if (feedComposer) container.appendChild(feedComposer);

  // The client's own root submissions, newest first, above the node's rows.
  const locked = ctx.identity?.locked ?? false;
  for (const sub of [...ctx.submissionsFor(null)].reverse()) {
    const post = submissionToPost(sub, ctx.ownName?.name ?? null);
    container.appendChild(card(post, { replyCount: null, flight: flightFor(sub, handlers.tryAgain), onOpen: (id) => handlers.openThread(id, { from: 'feed' }), you: isYou(sub.author, ctx), ...identityOpts(ctx, handlers), ...listCardOpts(post, { ...ctx, locked }, handlers) }));
  }

  // Pending (mempool) posts are the newest — they sit above the confirmed ones,
  // hollow, before any composer exists to create one.
  for (const p of feed.pending) {
    container.appendChild(card(p, { replyCount: p.descendantCount, onOpen: (id) => handlers.openThread(id, { from: 'feed' }), you: isYou(p.author, ctx), ...identityOpts(ctx, handlers) }));
  }
  for (const p of feed.posts) {
    container.appendChild(card(p, feedCardOpts(p, ctx, handlers)));
  }

  if (feed.loaded && feed.posts.length === 0 && feed.pending.length === 0) {
    container.appendChild(el('div', 'loading', 'no posts yet.'));
  }

  // Load older is a button that reports what it did — never infinite scroll,
  // the variable-ratio lever the motion contract names.
  const foot = el('div', 'feed-foot');
  if (feed.next !== null) {
    const b = el('button', 'word');
    b.setAttribute('aria-label', 'load older posts');
    b.textContent = 'load older';
    if (feed.loading) (b as HTMLButtonElement).disabled = true;
    else b.addEventListener('click', handlers.loadOlder);
    foot.appendChild(b);
    if (feed.olderReport) foot.appendChild(el('span', 'note', feed.olderReport));
  } else if (feed.loaded) {
    foot.appendChild(el('span', 'note', feed.olderReport ?? 'no older posts'));
  }
  container.appendChild(foot);
}
