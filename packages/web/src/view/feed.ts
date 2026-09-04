import { el, reportNode } from '../dom';
import { card, submissionToPost, flightFor, type ParentRef, type CardOpts } from './card';
import type { PostJson } from '../api/dto';
import { FEED_COMPOSER_KEY, type FeedState, type RenderCtx, type Handlers } from '../model/state';

// The feed: roots and replies in one column, newest first.
// A reply shows its parent as a one-line reference, not a rendered card.

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

function parentRefFor(post: PostJson, ctx: RenderCtx): ParentRef | null {
  const parentId = post.parentRefs[0];
  if (!parentId) return null;
  const parent = ctx.post(parentId);
  const excerpt = parent?.content ?? undefined;
  return {
    id: parentId,
    authorKey: parent?.author,
    excerpt: excerpt ? excerpt.slice(0, 80) : undefined,
    // The parent author's mark — the prefix stays text on a reply-ref line, so
    // the mark's ✓ is the way into their window (WEB_INTERFACE → The identity display).
    mark: parent ? ctx.markFor(parent.author) : null,
  };
}

/** The identity-display opts a feed card carries: the prefix opens the author
 *  window (a read, present even with no identity) and the vouch mark; the vouch
 *  and its unlock only with an identity loaded (WEB_INTERFACE → The identity display). */
function markOpts(author: string, ctx: RenderCtx, handlers: Handlers): Partial<CardOpts> {
  const opts: Partial<CardOpts> = {
    onAuthor: (key) => handlers.openAuthor(key, { from: 'feed' }),
    mark: ctx.markFor(author),
  };
  if (ctx.writeEnabled) {
    opts.onVouch = (key) => handlers.vouch(key);
    opts.locked = ctx.identity?.locked ?? false;
    opts.ownKey = ctx.ownKey ?? undefined;
    opts.onUnlock = (p) => handlers.unlockIdentity(p);
  }
  return opts;
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
    const nb = el('button', 'mini');
    nb.setAttribute('data-composer-open', FEED_COMPOSER_KEY);
    nb.setAttribute('aria-label', 'write a new post');
    nb.appendChild(el('span', null, 'new post'));
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
  for (const sub of [...ctx.submissionsFor(null)].reverse()) {
    container.appendChild(card(submissionToPost(sub), { replyCount: null, flight: flightFor(sub, handlers.tryAgain), onOpen: (id) => handlers.openThread(id, { from: 'feed' }), you: isYou(sub.author, ctx), ...markOpts(sub.author, ctx, handlers) }));
  }

  // Pending (mempool) posts are the newest — they sit above the confirmed ones,
  // hollow, before any composer exists to create one.
  for (const p of feed.pending) {
    container.appendChild(card(p, { replyCount: null, parentRef: parentRefFor(p, ctx), onOpen: (id) => handlers.openThread(id, { from: 'feed' }), you: isYou(p.author, ctx), ...markOpts(p.author, ctx, handlers) }));
  }
  for (const p of feed.posts) {
    container.appendChild(
      card(p, {
        open: ctx.openSet.has(p.id),
        replyCount: null,
        parentRef: parentRefFor(p, ctx),
        onOpen: (id) => handlers.openThread(id, { from: 'feed' }),
        you: isYou(p.author, ctx),
        ...markOpts(p.author, ctx, handlers),
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
