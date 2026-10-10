import { el, reportNode, shortHex } from '../dom';
import { card, submissionToPost, flightFor, listCardOpts, type CardOpts } from './card';
import { profileBody } from './profile';
import { settingsBody } from './settings';
import { walletBody } from './wallet';
import { authorBody, authorPostsBody, type AuthorCtx, type PostsCtx } from './author';
import { markHandle } from './name-handle';
import { flattenThread } from '../model/thread';
import { withheldLine, unservedSubjectLine } from './withheld-line';
import { identityHue } from '../model/identity';
import { isFull, isLight, isWithdrawn } from '../api/dto';
import { windowSubject } from '../model/arrangement';
import type { PostJson, WithdrawnJson } from '../api/dto';
import type { Column, Workspace } from '../model/workspace';
import type { Handlers, RenderCtx, Submission } from '../model/state';

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
  if (isLight(root)) {
    // A slot subject labels its bar as a loading thread does — no author key,
    // the handle alone when the row names one, and `loading…`
    // (WEB_INTERFACE → The extension → "The light read").
    return { authorKey: undefined, authorName: root.authorName, excerpt: 'loading…', replyCount: t.descendantCount, nested };
  }
  return { authorKey: root.author, authorName: root.authorName, excerpt: root.content ?? 'content not on this node yet', replyCount: t.descendantCount, nested };
}

/** The name an author or posts window's bar reads: the subject's, read by the
 *  author window, where that read holds one; else, on a posts window, the
 *  `authorName` of its first row whose author is the subject — every row of it
 *  is theirs, and the node fills the name on each (WEB_INTERFACE → The author
 *  window; NODE_INTERFACE → Usernames → "A list row carries its names"). */
function subjectName(sub: { kind: 'author' | 'posts'; key: string }, ctx: RenderCtx): string | null {
  const read = ctx.author.get(sub.key)?.username;
  if (read) return read.name;
  if (sub.kind === 'author') return null;
  // An author-posts bar reads its subject's name from full rows alone — a
  // slot carries a name but no key the bar can match (WEB_INTERFACE → The
  // extension → "The light read").
  return ctx.authorPosts.get(sub.key)?.posts.find((row) => isFull(row) && row.author === sub.key)?.authorName ?? null;
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
    const subName = subjectName(sub, ctx);
    if (subName !== null) {
      const h = el('span', 'handle', '@' + subName);
      if (ctx.nameClay(sub.key, subName)) h.classList.add('clay');
      markHandle(h, sub.key, subName);
      label.appendChild(h);
    } else {
      label.appendChild(el('span', 'hex', shortHex(sub.key, 10)));
    }
    ctl.appendChild(
      ctlBtn('↻', sub.kind === 'author' ? 'refresh this author' : 'refresh these posts', () =>
        sub.kind === 'author' ? handlers.refreshAuthor(sub.key) : handlers.refreshAuthorPosts(sub.key),
      ),
    );
  } else if (k === '@profile') {
    label.setAttribute('aria-label', 'show this window');
    label.appendChild(el('span', 'name', 'profile'));
    // The profile window's ↻ re-reads /karma/:key and the reader's name
    // (WEB_INTERFACE → The profile window).
    ctl.appendChild(ctlBtn('↻', 'refresh rep', () => handlers.refreshProfile()));
  } else if (k === '@settings') {
    label.setAttribute('aria-label', 'show this window');
    label.appendChild(el('span', 'name', 'settings'));
    // A control that does not apply renders disabled, never absent — nothing
    // here is read from the node (WEB_INTERFACE → The workspace,
    // → The settings window).
    ctl.appendChild(ctlBtn('↻', 'refresh — nothing to re-read', null, true));
  } else if (k === '@wallet') {
    label.setAttribute('aria-label', 'show this window');
    label.appendChild(el('span', 'name', 'wallet'));
    // The wallet window's ↻ re-reads /credits/:key
    // (WEB_INTERFACE → The wallet window).
    ctl.appendChild(ctlBtn('↻', 'refresh the balance', () => handlers.refreshWallet()));
  } else if (win) {
    // An @-window neither arm knows: the bar shell without a label, so the
    // close and move controls still apply. isWindowId filters on parse, so a
    // stored token that reaches here is a build seam, not a shipped state
    // (WEB_INTERFACE → The workspace).
    label.setAttribute('aria-label', 'show this window');
  } else {
    const m = threadLabel(k, ctx);
    // The spine: a 4px OKLCH edge from the author key. Set even while the thread
    // is still loading if the feed already knows the author.
    if (m.authorKey) b.style.setProperty('--idh', String(identityHue(m.authorKey)));
    label.setAttribute('aria-label', 'show this thread');
    if (m.authorName !== null) {
      const h = el('span', 'handle', '@' + m.authorName);
      if (m.authorKey !== undefined && ctx.nameClay(m.authorKey, m.authorName)) h.classList.add('clay');
      if (m.authorKey !== undefined) markHandle(h, m.authorKey, m.authorName);
      label.appendChild(h);
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
 *  control (WEB_INTERFACE → The withdraw control). `listKey` is the pane's
 *  focused window — the list a row opened under one of its cards belongs to
 *  (WEB_INTERFACE → What the feed reads, and what a card shows for it →
 *  "A row the reader opened under a card outlasts a redraw of its list"). */
function writeCardOpts(row: PostJson | WithdrawnJson, ci: number, listKey: string, ctx: RenderCtx, handlers: Handlers): Partial<CardOpts> {
  const base: Partial<CardOpts> = {
    onAuthor: (key) => handlers.openAuthor(key, { from: 'pane', ci }),
    nameClay: ctx.nameClay,
    expanded: ctx.expandedImages,
    onExpand: handlers.expandImage,
    onCollapse: handlers.collapseImage,
    ...listCardOpts(row, listKey, ctx, handlers),
    heldRow: ctx.heldCardRow(listKey, row.id),
  };
  if (!ctx.writeEnabled) return base;
  const opts: Partial<CardOpts> = {
    ...base,
    onReply: (id) => handlers.openComposer(id),
    composerKey: row.id,
    you: ctx.ownKey !== null && row.author === ctx.ownKey,
  };
  if (!isWithdrawn(row) && row.status === 'confirmed') {
    const isOwn = ctx.ownKey !== null && row.author === ctx.ownKey;
    if (isOwn) {
      opts.onWithdraw = (id, control) => handlers.pressWithdraw(listKey, id, control);
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
    endorsers: d?.endorsers ?? null,
    endorsersNext: d?.endorsersNext ?? false,
    writeEnabled: ctx.writeEnabled,
    ownKey: ctx.ownKey,
    locked: ctx.identity?.locked ?? false,
    yourVouch: ctx.yourVouch(key),
    flight: d?.flight ?? null,
    username: d?.username ?? null,
    usernameLoaded: d?.usernameLoaded ?? false,
    nameClay: ctx.nameClay,
  };
}

function postsCtxFrom(key: string, listKey: string, ci: number, ctx: RenderCtx): PostsCtx {
  const f = ctx.authorPosts.get(key);
  return {
    authorKey: key,
    origin: { from: 'pane', ci },
    feed: f ?? { posts: [], pending: [], next: null, report: null, olderReport: null, reportCount: null, olderReportCount: null, loaded: false, loading: true, error: null, unboundCount: 0 },
    writeEnabled: ctx.writeEnabled,
    ownKey: ctx.ownKey,
    likePending: (id) => ctx.likePending(id),
    linkUrl: (id) => ctx.linkUrl(id),
    expandedImages: ctx.expandedImages,
    nameClay: ctx.nameClay,
    listKey,
    heldCardRow: (list, id) => ctx.heldCardRow(list, id),
  };
}

/** A submission card and, when it has landed, the composer open beneath it and
 *  its own submissions in turn — each a level deeper than the card above it,
 *  to the cap a thread's rows hold (WEB_INTERFACE → "A landed submission is
 *  replied to where it stands"). A pending or expired card takes no reply, so
 *  neither hangs under it. */
function appendSubmissionBlock(
  body: HTMLElement,
  parentDepth: number,
  sub: Submission,
  ci: number,
  handlers: Handlers,
  ctx: RenderCtx,
): void {
  const depth = Math.min(parentDepth + 1, 3);
  const landed = sub.stage === 'landed' && sub.postId !== null;
  body.appendChild(
    card(submissionToPost(sub, ctx.ownName?.name ?? null), {
      depth,
      replyCount: null,
      flight: flightFor(sub, handlers.tryAgain),
      you: ctx.ownKey !== null && sub.author === ctx.ownKey,
      nameClay: ctx.nameClay,
      expanded: ctx.expandedImages,
      onExpand: handlers.expandImage,
      onCollapse: handlers.collapseImage,
      ...(landed
        ? { onOpen: (id) => handlers.openThread(id, { from: 'pane', ci }), onReply: (id) => handlers.openComposer(id), composerKey: sub.postId ?? undefined, linkUrl: ctx.linkUrl(sub.postId ?? sub.localKey) }
        : {}),
    }),
  );
  if (!landed || sub.postId === null) return;
  const composerEl = ctx.composerFor(sub.postId);
  if (composerEl) body.appendChild(composerEl);
  for (const child of ctx.submissionsFor(sub.postId)) {
    appendSubmissionBlock(body, depth, child, ci, handlers, ctx);
  }
}

function renderRegionBody(body: HTMLElement, focusedK: string, ci: number, handlers: Handlers, ctx: RenderCtx): void {
  const sub = windowSubject(focusedK);
  if (sub?.kind === 'author') {
    body.appendChild(authorBody(handlers, authorCtxFrom(sub.key, ci, ctx)));
    return;
  }
  if (sub?.kind === 'posts') {
    body.appendChild(authorPostsBody(handlers, postsCtxFrom(sub.key, focusedK, ci, ctx)));
    return;
  }
  if (focusedK === '@profile') {
    body.appendChild(profileBody(handlers, ctx, { from: 'pane', ci }));
    return;
  }
  if (focusedK === '@settings') {
    body.appendChild(settingsBody(handlers));
    return;
  }
  if (focusedK === '@wallet') {
    body.appendChild(walletBody(handlers, ctx));
    return;
  }
  if (isWin(focusedK)) {
    // An @-window neither arm knows renders nothing rather than the profile
    // (WEB_INTERFACE → The workspace).
    return;
  }
  const t = ctx.thread(focusedK);
  if (!t || t.loading) {
    body.appendChild(el('div', 'loading', 'loading…'));
    return;
  }
  if (t.error) {
    body.appendChild(el('div', 'error', `can't load this thread — ${t.error}`));
    // The post cache answers a failed read: when the subject is held, the
    // held rows render beneath the error line, each as any card renders
    // (WEB_INTERFACE → The extension → "The post cache"). With no root,
    // the error line stands alone.
    if (!t.root) return;
  }
  // A thread whose subject the check withheld renders no row (WEB_INTERFACE
  // → The extension → "The post check"): `'unbound'` shows the clay
  // withheld line, `'unserved'` shows one muted line and nothing else.
  if (t.subjectWithheld === 'unbound') {
    const wl = withheldLine(t.unboundCount);
    if (wl) body.appendChild(wl);
    return;
  }
  if (t.subjectWithheld === 'unserved') {
    body.appendChild(unservedSubjectLine());
    return;
  }
  if (!t.root) {
    body.appendChild(el('div', 'loading', 'this post is gone.'));
    return;
  }
  // The thread's withheld line, at its head: the count of `unbound` rows
  // this thread's standing reads withheld (WEB_INTERFACE → The extension →
  // "The post check").
  const twl = withheldLine(t.unboundCount);
  if (twl) body.appendChild(twl);

  const rootId = t.root.id;
  for (const node of flattenThread(t.root, t.descendants)) {
    const row = node.row;
    if (isLight(row)) {
      // A slot stands at the row's own depth with no handler of its own
      // (WEB_INTERFACE → The extension → "The light read").
      body.appendChild(card(row, { depth: node.depth }));
      continue;
    }
    // A pane's own root does not advertise that it is open — you are looking at
    // it. A reply open in another pane still does.
    body.appendChild(
      card(row, {
        open: row.id !== rootId && ctx.openSet.has(row.id),
        root: row.id === rootId,
        depth: node.depth,
        replyCount: row.id === rootId ? t.descendantCount : node.replyCount,
        onOpen: (id) => handlers.openThread(id, { from: 'pane', ci }),
        ...writeCardOpts(row, ci, focusedK, ctx, handlers),
      }),
    );
    // A reply composer open under this post, reused by reference across the
    // rebuild, and the client's own reply submissions beneath it.
    const composerEl = ctx.composerFor(row.id);
    if (composerEl) body.appendChild(composerEl);
    for (const sub of ctx.submissionsFor(row.id)) {
      appendSubmissionBlock(body, node.depth, sub, ci, handlers, ctx);
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
