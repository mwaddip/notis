import { el, reportNode, shortHex } from '../dom';
import { card, submissionToPost, flightFor, type CardOpts } from './card';
import { profileBody } from './profile';
import { flattenThread } from '../model/thread';
import { identityHue } from '../model/identity';
import { isTombstone } from '../api/dto';
import type { PostJson, Tombstone } from '../api/dto';
import type { Region, Workspace } from '../model/workspace';
import type { Handlers, RenderCtx } from '../model/state';

// The tiling workspace on screen: columns of regions, each region a stack of
// title bars in a fixed block at the top, then the body of whichever is
// focused. Nothing is an accordion; no bar moves when the focus
// changes.

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
  excerpt: string;
  replyCount: number;
  nested: boolean;
}

function threadLabel(k: string, ctx: RenderCtx): BarLabel {
  const t = ctx.thread(k);
  const root = t?.root;
  if (!t || t.loading || !root) {
    return { authorKey: ctx.post(k)?.author, excerpt: t?.error ? 'unavailable' : 'loading…', replyCount: 0, nested: false };
  }
  const nested = [...t.ancestorIds].some((a) => a !== k && ctx.openSet.has(a));
  if (isTombstone(root)) {
    const label = root.kind === 'withdrawn' ? 'withdrawn' : root.kind === 'stump' ? 'pruned subtree' : 'pruned';
    return { authorKey: root.author, excerpt: label, replyCount: 0, nested };
  }
  return { authorKey: root.author, excerpt: root.content ?? 'content not on this node yet', replyCount: t.descendantCount, nested };
}

function bar(k: string, ci: number, focused: boolean, handlers: Handlers, ctx: RenderCtx): HTMLElement {
  const win = isWin(k);
  const b = el('div', 'bar' + (focused ? ' focused' : '') + (win ? ' win' : ''));

  const label = el('button', 'bar-label');
  label.addEventListener('click', () => handlers.focus(k));
  const ctl = el('div', 'bar-ctl');

  if (win) {
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
    label.appendChild(el('span', 'hex', shortHex(m.authorKey ?? k, 10)));
    label.appendChild(el('span', 'excerpt', m.excerpt));
    if (m.nested) label.appendChild(el('span', 'nested', '↳ nested'));
    if (m.replyCount > 0) label.appendChild(el('span', 'n', String(m.replyCount)));
    ctl.appendChild(ctlBtn('↻', 'refresh replies to this thread', () => handlers.refreshThread(k)));
  }

  b.appendChild(label);

  const what = win ? 'window' : 'thread';
  ctl.appendChild(ctlBtn('←', `move this ${what} back into the stack on the left`, () => handlers.moveLeft(k), ci === 0));
  ctl.appendChild(ctlBtn('→', `move this ${what} to its own pane on the right`, () => handlers.moveRight(k)));
  ctl.appendChild(ctlBtn('↓', `move this ${what} to its own pane below`, () => handlers.moveBelow(k)));
  ctl.appendChild(ctlBtn('✕', `close this ${what}`, () => handlers.close(k)));
  b.appendChild(ctl);
  return b;
}

/** The write-surface opts for a card inside a pane: ↩ reply on every card (the
 *  card itself withholds it on a pending or pruned one), and the like control by
 *  §7's exclusions — live confirmed posts only, never withdrawn, stumps, pending
 *  or the reader's own. */
function writeCardOpts(row: PostJson | Tombstone, ctx: RenderCtx, handlers: Handlers): Partial<CardOpts> {
  if (!ctx.writeEnabled) return {};
  const opts: Partial<CardOpts> = {
    onReply: (id) => handlers.openComposer(id),
    composerKey: row.id, // a reply composer keys on its parent id
  };
  if (!isTombstone(row) && row.status === 'confirmed') {
    const overlaid = ctx.likePending(row.id);
    const liked = overlaid || row.likedByViewer === true;
    const isOwn = ctx.ownKey !== null && row.author === ctx.ownKey;
    if (liked) {
      opts.liked = true;
      opts.likePending = overlaid && row.likedByViewer !== true;
    } else if (!isOwn) {
      opts.onLike = (id) => handlers.likePost(id);
    }
  }
  return opts;
}

function renderRegionBody(body: HTMLElement, focusedK: string, ci: number, handlers: Handlers, ctx: RenderCtx): void {
  if (isWin(focusedK)) {
    body.appendChild(profileBody(handlers, ctx));
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
        ...writeCardOpts(row, ctx, handlers),
      }),
    );
    // A reply composer open under this post, reused by reference across the
    // rebuild, and the client's own reply submissions beneath it.
    const composerEl = ctx.composerFor(row.id);
    if (composerEl) body.appendChild(composerEl);
    for (const sub of ctx.submissionsFor(row.id)) {
      const landed = sub.stage === 'landed' && sub.postId !== null;
      body.appendChild(
        card(submissionToPost(sub), {
          depth: Math.min(node.depth + 1, 3),
          replyCount: null,
          flight: flightFor(sub, handlers.tryAgain),
          ...(landed
            ? { onOpen: (id) => handlers.openThread(id, { from: 'pane', ci }), onReply: (id) => handlers.openComposer(id), composerKey: sub.postId ?? undefined }
            : {}),
        }),
      );
    }
  }

  // Descendants load oldest-first, so paging forward loads newer replies below
  // — a conversation read top to bottom. The button reports what it did.
  if (t.next !== null) {
    const foot = el('div', 'feed-foot');
    const b = el('button', 'mini');
    b.setAttribute('aria-label', 'load more replies');
    b.appendChild(el('span', null, 'load more replies'));
    b.addEventListener('click', () => handlers.threadMore(focusedK));
    foot.appendChild(b);
    body.appendChild(foot);
  }
}

export function renderRegionElement(region: Region, ci: number, handlers: Handlers, ctx: RenderCtx): HTMLElement {
  const regionEl = el('div', 'region');
  regionEl.dataset['uid'] = String(region.uid);

  const bars = el('div', 'bars');
  region.wins.forEach((k, i) => bars.appendChild(bar(k, ci, i === region.focus, handlers, ctx)));
  regionEl.appendChild(bars);

  if (region.report) regionEl.appendChild(reportNode(region.report));

  const body = el('div', 'region-body');
  const focusedK = region.wins[region.focus];
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
    for (const region of col.regions) colEl.appendChild(renderRegionElement(region, ci, handlers, ctx));
    container.appendChild(colEl);
  });
}
