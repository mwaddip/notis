import { el, shortHex } from '../dom';
import { unlockForm } from './passphrase';
import { card, markNode, stageLine } from './card';
import { standing } from './profile';
import type { Mark, Flight } from './card';
import type { KarmaResult, VouchesTargetResult, PostJson } from '../api/dto';
import type { FeedState } from '../model/state';
import type { Origin } from '../model/workspace';

// The author window and the author-posts window — WEB_INTERFACE → The author
// window. Pure views in the profile's row idiom: they declare the narrow shapes
// they read (AuthorCtx / PostsCtx) and call (AuthorHandlers / PostsHandlers), and
// the App's RenderCtx and Handlers satisfy them structurally, so there is one
// contract, not two. With no identity loaded the window is the read surface
// exactly — no marks, no your-vouch row.

function row(label: string): { row: HTMLElement; field: HTMLElement } {
  const r = el('div', 'row');
  r.appendChild(el('label', null, label));
  const field = el('div', 'field');
  r.appendChild(field);
  return { row: r, field };
}
function mono(text: string): HTMLElement {
  return el('span', 'mono', text);
}

/** The your-vouch row's state, computed by the App (WEB_INTERFACE → The author
 *  window). `null` with no identity loaded — the row is absent. */
export type YourVouch =
  | { kind: 'plus'; cooldownBlocks: number }        // + vouch, the stakes sentence
  | { kind: 'vouched'; sinceBlock: number | null }  // ✓ vouched since block N · unvouch
  | { kind: 'reason'; text: string };               // the one line the reader cannot vouch

export interface AuthorCtx {
  authorKey: string;
  origin: Origin;                       // where this window's children open — the placement rule
  karma: KarmaResult | null;            // /karma/:key, null while loading
  endorsers: VouchesTargetResult | null; // GET /vouches?target, null while loading
  endorsersNext: boolean;               // a `more` control follows `next`
  membershipBars: { memberBar: number; memberLikesBar: number } | null; // /status, the resident line
  writeEnabled: boolean;                // an identity is loaded
  ownKey: string | null;
  locked: boolean;
  subjectMark: Mark | null;             // the reader's mark for the subject
  markFor: (key: string) => Mark | null; // an endorser's mark
  yourVouch: YourVouch | null;
  flight: Flight | null;                // the your-vouch stage line while a flight runs
}

export interface AuthorHandlers {
  openAuthor: (key: string, origin: Origin) => void;
  openAuthorPosts: (key: string, origin: Origin) => void;
  vouch: (key: string) => void;
  unvouch: (key: string) => void;
  moreEndorsers: (key: string) => void;
  unlockIdentity: (passphrase: string) => Promise<void>;
}

export function authorBody(handlers: AuthorHandlers, ctx: AuthorCtx): HTMLElement {
  const b = el('div', 'winbody');

  // A locked vouch mounts its unlock under the your-vouch row — the one unlock
  // spot in this window (WEB_INTERFACE → The identity module). Kept in a closure
  // so the mark's + press can reach it.
  let yourVouchRow: HTMLElement | null = null;
  const vouchAction = (key: string): void => {
    if (ctx.locked && ctx.ownKey && yourVouchRow) {
      mountRowUnlock(yourVouchRow, ctx.ownKey, handlers.unlockIdentity, () => handlers.vouch(key));
      return;
    }
    handlers.vouch(key);
  };
  // The mark's handlers: no `locked`, so markNode calls onVouch directly and the
  // unlock is this window's, not a card's.
  const markHandlers = { onVouch: vouchAction, onAuthor: (k: string) => handlers.openAuthor(k, ctx.origin) };

  // key — the whole key, mono, and the subject's mark after it.
  {
    const { row: r, field } = row('key');
    field.appendChild(mono(ctx.authorKey));
    if (ctx.subjectMark) field.appendChild(markNode(ctx.authorKey, ctx.subjectMark, markHandlers));
    b.appendChild(r);
  }

  // standing — the node's word, the same function the profile renders.
  {
    const { row: r, field } = row('standing');
    standing(field, ctx.karma, ctx.membershipBars);
    b.appendChild(r);
  }

  // endorsers — N vouches, then one row per voucher: their prefix (a ghost button
  // into their window) and their mark. One page; `more` follows `next`.
  {
    const { row: r, field } = row('endorsers');
    endorsers(field, handlers, ctx, markHandlers);
    b.appendChild(r);
  }

  // your vouch — the reader's relation and the action, absent with no identity.
  if (ctx.yourVouch) {
    const { row: r, field } = row('your vouch');
    yourVouchRow = r;
    yourVouch(field, handlers, ctx, vouchAction);
    b.appendChild(r);
  }

  // posts — a word that opens the author-posts window beside this one.
  {
    const { row: r, field } = row('posts');
    const btn = el('button', 'mini', 'posts');
    btn.setAttribute('aria-label', "open this author's posts");
    btn.addEventListener('click', () => handlers.openAuthorPosts(ctx.authorKey, ctx.origin));
    field.appendChild(btn);
    b.appendChild(r);
  }

  return b;
}

function endorsers(field: HTMLElement, handlers: AuthorHandlers, ctx: AuthorCtx, markHandlers: { onVouch: (k: string) => void; onAuthor: (k: string) => void }): void {
  const e = ctx.endorsers;
  if (e === null) {
    field.appendChild(el('span', 'inkmute', 'loading…'));
    return;
  }
  if (e.count === 0) {
    field.appendChild(el('span', 'inkmute', 'no vouches yet'));
    return;
  }
  const n = el('div', 'hint');
  n.append(mono(String(e.count)), e.count === 1 ? ' vouch' : ' vouches');
  field.appendChild(n);
  for (const v of e.vouches) {
    const line = el('div', 'endorser');
    const btn = el('button', 'hex authorbtn');
    btn.textContent = shortHex(v.voucherId, 10);
    btn.setAttribute('aria-label', 'open this author');
    btn.addEventListener('click', () => handlers.openAuthor(v.voucherId, ctx.origin));
    line.appendChild(btn);
    const mark = ctx.markFor(v.voucherId);
    if (mark) line.appendChild(markNode(v.voucherId, mark, markHandlers));
    field.appendChild(line);
  }
  if (ctx.endorsersNext) {
    const more = el('button', 'mini', 'more');
    more.setAttribute('aria-label', 'load more endorsers');
    more.addEventListener('click', () => handlers.moreEndorsers(ctx.authorKey));
    field.appendChild(more);
  }
}

function yourVouch(field: HTMLElement, handlers: AuthorHandlers, ctx: AuthorCtx, vouchAction: (k: string) => void): void {
  const yv = ctx.yourVouch!;
  if (yv.kind === 'plus') {
    // The mark as on a card, with the sentence stating what a vouch stakes.
    field.appendChild(markNode(ctx.authorKey, { state: 'plus', count: null }, { onVouch: vouchAction, onAuthor: (k) => handlers.openAuthor(k, ctx.origin) }));
    const line = el('span', 'hint');
    line.append('stakes 1 karma, returned when you unvouch after a cooldown of ', mono(String(yv.cooldownBlocks)), ' blocks.');
    field.appendChild(line);
    return;
  }
  if (yv.kind === 'vouched') {
    field.append(el('span', 'standing', 'vouched'));
    if (yv.sinceBlock !== null) {
      const since = el('span', 'hint');
      since.append(' since block ', mono(String(yv.sinceBlock)));
      field.appendChild(since);
    }
    const unvouch = el('button', 'mini', 'unvouch');
    unvouch.setAttribute('aria-label', 'withdraw your vouch — the stake is held through a cooldown, then returns');
    unvouch.addEventListener('click', () => handlers.unvouch(ctx.authorKey));
    field.appendChild(unvouch);
    // The flight's stage line below the action while it runs.
    if (ctx.flight) field.appendChild(stageLine(ctx.flight));
    return;
  }
  // A one-line reason the reader cannot vouch (WEB_INTERFACE → The author window).
  field.appendChild(el('span', 'hint', yv.text));
}

/** The unlock form in a row under the your-vouch row; a correct passphrase loads
 *  the seed and the vouch proceeds (WEB_INTERFACE → The identity module). */
function mountRowUnlock(anchorRow: HTMLElement, ownKey: string, onUnlock: (p: string) => Promise<void>, onProceed: () => void): void {
  if (anchorRow.parentElement?.querySelector('.card-unlock')) return; // already open
  const urow = el('div', 'card-unlock');
  urow.appendChild(
    unlockForm(
      ownKey,
      async (p) => {
        await onUnlock(p);
        onProceed();
      },
      () => urow.remove(),
    ),
  );
  anchorRow.insertAdjacentElement('afterend', urow);
}

// ---------------------------------------------------------------------------
// The author-posts window — @posts:<64hex> (WEB_INTERFACE → The author window).
// The author's committed posts as feed cards: the strip, the prefix and the
// mark, · you — no like and no reply, which live in the pane the strip opens.
// ---------------------------------------------------------------------------

export interface PostsCtx {
  authorKey: string;
  origin: Origin;
  feed: FeedState;                        // the author's posts, the feed's own state shape
  writeEnabled: boolean;
  ownKey: string | null;
  locked: boolean;
  markFor: (key: string) => Mark | null;
}

export interface PostsHandlers {
  openThread: (id: string, origin: Origin) => void;
  openAuthor: (key: string, origin: Origin) => void;
  vouch: (key: string) => void;
  authorPostsMore: (key: string) => void;
  unlockIdentity: (passphrase: string) => Promise<void>;
}

export function authorPostsBody(handlers: PostsHandlers, ctx: PostsCtx): HTMLElement {
  const b = el('div', 'region-body author-posts');
  const feed = ctx.feed;
  if (!feed.loaded && feed.loading) {
    b.appendChild(el('div', 'loading', 'loading…'));
    return b;
  }
  if (feed.error) {
    b.appendChild(el('div', 'error', `can't load these posts — ${feed.error}`));
    return b;
  }
  if (feed.posts.length === 0) {
    b.appendChild(el('div', 'empty', 'no posts yet'));
    return b;
  }
  for (const post of feed.posts) {
    b.appendChild(postCard(post, handlers, ctx));
  }
  if (feed.next !== null) {
    const foot = el('div', 'feed-foot');
    const more = el('button', 'mini', 'more posts');
    more.setAttribute('aria-label', 'load more posts by this author');
    more.addEventListener('click', () => handlers.authorPostsMore(ctx.authorKey));
    foot.appendChild(more);
    b.appendChild(foot);
  }
  return b;
}

/** One post by the author, a read-only feed card: the strip opens a thread one
 *  column right, the prefix and mark, · you — no like and no reply. */
function postCard(post: PostJson, handlers: PostsHandlers, ctx: PostsCtx): HTMLElement {
  const you = ctx.ownKey !== null && post.author === ctx.ownKey;
  return card(post, {
    replyCount: null, // a list, like the feed — no descendant count
    onOpen: (id) => handlers.openThread(id, ctx.origin),
    onAuthor: (key) => handlers.openAuthor(key, ctx.origin),
    onVouch: (key) => handlers.vouch(key),
    mark: ctx.markFor(post.author),
    you,
    // A locked vouch here mounts under the card's own meta, as on the feed.
    locked: ctx.locked,
    ownKey: ctx.ownKey ?? undefined,
    onUnlock: (p) => handlers.unlockIdentity(p),
  });
}
