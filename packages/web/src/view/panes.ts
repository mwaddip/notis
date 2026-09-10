import { el, reportNode, shortHex } from '../dom';
import { card, submissionToPost, flightFor, listCardOpts, type CardOpts } from './card';
import { profileBody } from './profile';
import { authorBody, authorPostsBody, type AuthorCtx, type PostsCtx } from './author';
import { flattenThread } from '../model/thread';
import { identityHue } from '../model/identity';
import { isWithdrawn } from '../api/dto';
import { windowSubject } from '../model/arrangement';
import type { PostJson, WithdrawnJson } from '../api/dto';
import type { Column, Workspace } from '../model/workspace';
import type { Handlers, RenderCtx } from '../model/state';

// The tiling workspace on screen: one .col per column, framing one .region
// stack — the .col is the strip member (its width and snap), the .region the
// framed stack of title bars with the focused window's body below. Nothing is
// an accordion; no bar moves when the focus changes (WEB_INTERFACE → The workspace).

const EMPTY_TEXT =
  'No threads open. Use the › on the right edge of a post to open one here. ' +
  'Open several and they stack; the arrows on a bar give a thread its own pane.';

const isWin = (k: string): boolean => k.charAt(0) === '@';

function ctlBtn(glyph: string, label: string, fn: (() => void) | null, disabled?: boolean): HTMLElement {
  const b = el('button', 'ctl', glyph) as HTMLButtonElement;
  b.setAttribute('aria-label', label);
  if (disabled || !fn) {
    b.disabled = true; // kept in place so bar geometry never shifts
    return b;
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

interface BarLabel {
  authorKey: string | undefined;
  authorName: string | null;
  excerpt: string;
  replyCount: number;
  nested: boolean;
}

function threadLabel(k: string, ctx: RenderCtx): BarLabel {
  const t = ctx.thread(k);
  const root = t?.root;
  if (!t || t.loading || !root) {
    const p = ctx.post(k);
    return { authorKey: p?.author, authorName: p?.authorName ?? null, excerpt: t?.error ? 'unavailable' : 'loading…', replyCount: 0, nested: false };
  }
  const nested = [...t.ancestorIds].some((a) => a !== k && ctx.openSet.has(a));
  if (isWithdrawn(root)) {
    return { authorKey: root.author, authorName: root.authorName, excerpt: 'withdrawn', replyCount: 0, nested };
  }
  return { authorKey: root.author, authorName: root.authorName, excerpt: root.content ?? 'content not on this node yet', replyCount: t.descendantCount, nested };
}

function bar(k: string, ci: number, focused: boolean, lone: boolean, handlers: Handlers, ctx: RenderCtx): HTMLElement {
  const win = isWin(k);
  const b = el('div', 'bar' + (focused ? ' focused' : '') + (win ? ' win' : ''));

  const label = el('button', 'bar-label');
  label.addEventListener('click', () => handlers.focus(k));
  const ctl = el('div', 'bar-ctl');

  const sub = windowSubject(k);
  if (sub) {
    // An author or posts window — the kind, then the handle when the subject
    // holds a name, else the prefix in mono (WEB_INTERFACE → The identity display).
    label.setAttribute('aria-label', 'show this window');
    label.appendChild(el('span', 'name', sub.kind === 'author' ? 'author' : 'posts'));
    const subName = ctx.author.get(sub.key)?.username;
    if (subName) {
      label.appendChild(el('span', 'handle', '@' + subName.name));
    } else {
      label.appendChild(el('span', 'hex', shortHex(sub.key, 10)));
    }
    ctl.appendChild(
      ctlBtn('↻', sub.kind === 'author' ? 'refresh this author' : 'refresh these posts', () =>
        sub.kind === 'author' ? handlers.refreshAuthor(sub.key) : handlers.refreshAuthorPosts(sub.key),
      ),
    );
  } else if (win) {
    label.setAttribute('aria-label', 'show this window');
    label.appendChild(el('span', 'name', 'profile'));
    // The profile window's ↻ re-reads standing and karma — the first window with
    // something to refresh (WEB_INTERFACE → The profile window).
    ctl.appendChild(ctlBtn('↻', 'refresh standing and karma', () => handlers.refreshProfile()));
  } else {
    const m = threadLabel(k, ctx);
    // The spine: a 4px OKLCH edge from the author key. Set even while the thread
    // is still loading if the feed already knows the author.
    if (m.authorKey) b.style.setProperty('--idh', String(identityHue(m.authorKey)));
    label.setAttribute('aria-label', 'show this thread');
    if (m.authorName !== null) {
      label.appendChild(el('span', 'handle', '@' + m.authorName));
    } else {
      label.appendChild(el('span', 'hex', shortHex(m.authorKey ?? k, 10)));
    }
    label.appendChild(el('span', 'excerpt', m.excerpt));
    if (m.nested) label.appendChild(el('span', 'nested', '↳ nested'));
    if (m.replyCount > 0) label.appendChild(el('span', 'n', String(m.replyCount)));
    ctl.appendChild(ctlBtn('↻', 'refresh replies to this thread', () => handlers.refreshThread(k)));
  }

  b.appendChild(label);

  const what = win ? 'window' : 'thread';
  if (ctx.standalone) {
    // WEB_INTERFACE → The standalone thread — ↻ and nothing else.
  } else if (ctx.oneColumn) {
    // ↻ ✕ at one column — ← and → arrange columns, and a phone reader has one
    // screen at a time (WEB_INTERFACE → The workspace).
    ctl.appendChild(ctlBtn('✕', `close this ${what}`, () => handlers.close(k)));
  } else {
    ctl.appendChild(ctlBtn('←', `move this ${what} back into the stack on the left`, () => handlers.moveLeft(k), ci === 0));
    // → is disabled on a window alone in its column, where the move would change
    // nothing, as ← is in the leftmost column (WEB_INTERFACE → The workspace).
    ctl.appendChild(ctlBtn('→', `move this ${what} to its own pane on the right`, () => handlers.moveRight(k), lone));
    ctl.appendChild(ctlBtn('✕', `close this ${what}`, () => handlers.close(k)));
  }
  b.appendChild(ctl);
  return b;
}

/** The card opts for a pane card. The prefix opens the author window — a read,
 *  present even with no identity (WEB_INTERFACE → The identity display). The like
 *  and link come from listCardOpts; the pane adds ↩ reply and the withdraw
 *  control (WEB_INTERFACE → The withdraw control). */
function writeCardOpts(row: PostJson | WithdrawnJson, ci: number, ctx: RenderCtx, handlers: Handlers): Partial<CardOpts> {
  const locked = ctx.identity?.locked ?? false;
  const base: Partial<CardOpts> = {
    onAuthor: (key) => handlers.openAuthor(key, { from: 'pane', ci }),
    expanded: ctx.expandedImages,
    onExpand: handlers.expandImage,
    onCollapse: handlers.collapseImage,
    ...listCardOpts(row, { ...ctx, locked }, handlers),
  };
  if (!ctx.writeEnabled) return base;
  const opts: Partial<CardOpts> = {
    ...base,
    onReply: (id) => handlers.openComposer(id),
    composerKey: row.id,
    you: ctx.ownKey !== null && row.author === ctx.ownKey,
    locked: ctx.identity?.locked ?? false,
    ownKey: ctx.ownKey ?? undefined,
    onUnlock: (p) => handlers.unlockIdentity(p),
  };
  if (!isWithdrawn(row) && row.status === 'confirmed') {
    const isOwn = ctx.ownKey !== null && row.author === ctx.ownKey;
    if (isOwn) {
      opts.onWithdraw = (id) => handlers.withdrawPost(id);
      opts.withdraw = ctx.withdrawState(row.id);
      opts.canWithdraw = ctx.canSignWithdraw;
    }
  }
  return opts;
}

/** The author window's ctx, adapted from the App's RenderCtx — the App satisfies
 *  AuthorHandlers structurally, so `handlers` is passed straight through. */
function authorCtxFrom(key: string, ci: number, ctx: RenderCtx): AuthorCtx {
  const d = ctx.author.get(key);
  return {
    authorKey: key,
    origin: { from: 'pane', ci },
    karma: d?.karma ?? null,
    endorsers: d?.endorsers ?? null,
    endorsersNext: d?.endorsersNext ?? false,
    membershipBars: ctx.membershipBars,
    writeEnabled: ctx.writeEnabled,
    ownKey: ctx.ownKey,
    locked: ctx.identity?.locked ?? false,
    yourVouch: ctx.yourVouch(key),
    flight: d?.flight ?? null,
    username: d?.username ?? null,
    usernameLoaded: d?.usernameLoaded ?? false,
  };
}

function postsCtxFrom(key: string, ci: number, ctx: RenderCtx): PostsCtx {
  const f = ctx.authorPosts.get(key);
  return {
    authorKey: key,
    origin: { from: 'pane', ci },
    feed: f ?? { posts: [], pending: [], next: null, report: null, olderReport: null, loaded: false, loading: true, error: null },
    writeEnabled: ctx.writeEnabled,
    ownKey: ctx.ownKey,
    locked: ctx.identity?.locked ?? false,
    likePending: (id) => ctx.likePending(id),
    linkUrl: (id) => ctx.linkUrl(id),
    expandedImages: ctx.expandedImages,
  };
}

function renderRegionBody(body: HTMLElement, focusedK: string, ci: number, handlers: Handlers, ctx: RenderCtx): void {
  const sub = windowSubject(focusedK);
  if (sub?.kind === 'author') {
    body.appendChild(authorBody(handlers, authorCtxFrom(sub.key, ci, ctx)));
    return;
  }
  if (sub?.kind === 'posts') {
    body.appendChild(authorPostsBody(handlers, postsCtxFrom(sub.key, ci, ctx)));
    return;
  }
  if (isWin(focusedK)) {
    body.appendChild(profileBody(handlers, ctx, { from: 'pane', ci }));
    return;
  }
  const t = ctx.thread(focusedK);
  if (!t || t.loading) {
    body.appendChild(el('div', 'loading', 'loading…'));
    return;
  }
  if (t.error) {
    body.appendChild(el('div', 'error', `can't load this thread — ${t.error}`));
    return;
  }
  if (!t.root) {
    body.appendChild(el('div', 'loading', 'this post is gone.'));
    return;
  }

  const rootId = t.root.id;
  for (const node of flattenThread(t.root, t.descendants)) {
    const row = node.row;
    // A pane's own root does not advertise that it is open — you are looking at
    // it. A reply open in another pane still does.
    body.appendChild(
      card(row, {
        open: row.id !== rootId && ctx.openSet.has(row.id),
        root: row.id === rootId,
        depth: node.depth,
        replyCount: row.id === rootId ? t.descendantCount : node.replyCount,
        onOpen: (id) => handlers.openThread(id, { from: 'pane', ci }),
        ...writeCardOpts(row, ci, ctx, handlers),
      }),
    );
    // A reply composer open under this post, reused by reference across the
    // rebuild, and the client's own reply submissions beneath it.
    const composerEl = ctx.composerFor(row.id);
    if (composerEl) body.appendChild(composerEl);
    for (const sub of ctx.submissionsFor(row.id)) {
      const landed = sub.stage === 'landed' && sub.postId !== null;
      body.appendChild(
        card(submissionToPost(sub, ctx.ownName?.name ?? null), {
          depth: Math.min(node.depth + 1, 3),
          replyCount: null,
          flight: flightFor(sub, handlers.tryAgain),
          you: ctx.ownKey !== null && sub.author === ctx.ownKey,
          expanded: ctx.expandedImages,
          onExpand: handlers.expandImage,
          onCollapse: handlers.collapseImage,
          ...(landed
            ? { onOpen: (id) => handlers.openThread(id, { from: 'pane', ci }), onReply: (id) => handlers.openComposer(id), composerKey: sub.postId ?? undefined, linkUrl: ctx.linkUrl(sub.postId ?? sub.localKey) }
            : {}),
        }),
      );
    }
  }

  // Descendants load oldest-first, so paging forward loads newer replies below
  // — a conversation read top to bottom. The button reports what it did.
  if (t.next !== null) {
    const foot = el('div', 'feed-foot');
    const b = el('button', 'word');
    b.setAttribute('aria-label', 'load more replies');
    b.textContent = 'load more replies';
    b.addEventListener('click', () => handlers.threadMore(focusedK));
    foot.appendChild(b);
    body.appendChild(foot);
  }
}

/** The bars block for a column — every window's title bar in one fixed geometry.
 *  Exported so a thread's load can refresh the bars in place without touching the
 *  body (WEB_INTERFACE → The workspace). */
export function renderBars(column: Column, ci: number, handlers: Handlers, ctx: RenderCtx): HTMLElement {
  const bars = el('div', 'bars');
  const lone = column.wins.length === 1;
  column.wins.forEach((k, i) => bars.appendChild(bar(k, ci, i === column.focus, lone, handlers, ctx)));
  return bars;
}

export function renderRegionElement(column: Column, ci: number, handlers: Handlers, ctx: RenderCtx): HTMLElement {
  const regionEl = el('div', 'region');
  regionEl.dataset['uid'] = String(column.uid);

  regionEl.appendChild(renderBars(column, ci, handlers, ctx));

  if (column.report) regionEl.appendChild(reportNode(column.report));

  const body = el('div', 'region-body');
  const focusedK = column.wins[column.focus];
  if (focusedK != null) renderRegionBody(body, focusedK, ci, handlers, ctx);
  regionEl.appendChild(body);
  return regionEl;
}

export function renderPanesInto(container: HTMLElement, ws: Workspace, handlers: Handlers, ctx: RenderCtx): void {
  container.textContent = '';
  if (ws.columns.length === 0) {
    container.appendChild(el('div', 'empty', EMPTY_TEXT));
    return;
  }
  ws.columns.forEach((col, ci) => {
    const colEl = el('div', 'col');
    colEl.appendChild(renderRegionElement(col, ci, handlers, ctx));
    container.appendChild(colEl);
  });
}
