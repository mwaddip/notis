import { el, shortHex, endForm } from '../dom';
import { withheldLine } from './withheld-line';
import { unlockForm } from './passphrase';
import { card, stageLine, listCardOpts } from './card';
import { markHandle, nameLine } from './name-handle';
import type { Flight, CardRow } from './card';
import type { VouchesTargetResult, UsernameResult, PostJson } from '../api/dto';
import { isFull } from '../api/dto';
import type { FeedState, WindowBody } from '../model/state';
import type { Origin } from '../model/workspace';

// The author window and the author-posts window — WEB_INTERFACE → The author
// window. Views in the profile's row idiom: they declare the narrow shapes
// they read (AuthorCtx / PostsCtx) and call (AuthorHandlers / PostsHandlers), and
// the App's Handlers satisfy the second structurally. With no identity loaded
// the author window is the read surface exactly — no your-vouch row.
//
// The author window's body is one node from the window's open to its close
// (WEB_INTERFACE → The workspace → "A window's body stands while the window is
// open"): its rows are built once, `update` draws the name, the endorsers and
// the reader's relation from the state it reads, and the unlock row under
// `your vouch` stands through it while the identity is locked and the row
// still offers the word it was opened from (→ "A draw updates a standing body
// in place"). `vouch`, `unvouch`, an endorser's name and `posts` read the lock
// and the column the window stands in when pressed (→ "A window's controls act
// on the state as it stands at the press"). The author-posts window is drawn
// from its rows at every draw.

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
  | { kind: 'plus'; cooldownBlocks: number }                          // vouch, the stakes sentence
  | { kind: 'pending' }                                               // the flight's stage line in the word's place
  | { kind: 'vouched'; sinceBlock: number | null; cooldownBlocks: number } // vouched since N · unvouch, the held sentence
  | { kind: 'reason'; text: string };                                 // the one line the reader cannot vouch

export interface AuthorCtx {
  authorKey: string;
  origin: Origin;                       // where this window's children open — the placement rule
  endorsers: VouchesTargetResult | null; // GET /vouches?target, null while loading
  endorsersNext: boolean;               // a `more` control follows `next`
  writeEnabled: boolean;                // an identity is loaded
  ownKey: string | null;
  locked: boolean;
  yourVouch: YourVouch | null;
  flight: Flight | null;                // the your-vouch stage line while a flight runs
  username: UsernameResult | null;
  usernameLoaded: boolean;
  nameClay: (key: string, name: string) => boolean; // the handle reads clay (→ The extension → "The verified names")
}

export interface AuthorHandlers {
  openAuthor: (key: string, origin: Origin) => void;
  openAuthorPosts: (key: string, origin: Origin) => void;
  vouch: (key: string) => void;
  unvouch: (key: string) => void;
  moreEndorsers: (key: string) => void;
  unlockIdentity: (passphrase: string) => Promise<void>;
}

/** `read` answers the window's state as it stands when called; the subject's
 *  key is the window's own and never moves. */
export function authorBody(handlers: AuthorHandlers, read: () => AuthorCtx): WindowBody {
  const b = el('div', 'winbody');
  const authorKey = read().authorKey;

  // key — the whole key, mono (WEB_INTERFACE → The author window).
  {
    const { row: r, field } = row('key');
    field.appendChild(mono(authorKey));
    b.appendChild(r);
  }

  const name = row('name');
  const endorsersRow = row('endorsers');
  const yourVouchRow = row('your vouch');
  b.append(name.row, endorsersRow.row);

  // posts — a word that opens the author-posts window beside this one.
  const posts = row('posts');
  {
    const btn = el('button', 'word', 'posts');
    btn.setAttribute('aria-label', "open this author's posts");
    btn.addEventListener('click', () => handlers.openAuthorPosts(authorKey, read().origin));
    posts.field.appendChild(btn);
    b.appendChild(posts.row);
  }

  // A locked vouch or unvouch mounts its unlock under the your-vouch row — the
  // one unlock spot in this window; a correct passphrase ends the row and the
  // word pressed proceeds (WEB_INTERFACE → The identity module).
  let unlock: { row: HTMLElement; word: 'vouch' | 'unvouch' } | null = null;
  const endUnlock = (): void => {
    if (unlock !== null) endForm(unlock.row);
    unlock = null;
  };
  const press = (word: 'vouch' | 'unvouch'): void => {
    const go = (): void => (word === 'vouch' ? handlers.vouch(authorKey) : handlers.unvouch(authorKey));
    const now = read();
    if (!now.locked || now.ownKey === null) {
      go();
      return;
    }
    if (unlock !== null) return;
    const urow = el('div', 'card-unlock');
    urow.appendChild(
      unlockForm(
        now.ownKey,
        async (p) => {
          await handlers.unlockIdentity(p);
          endUnlock();
          go();
        },
        endUnlock,
      ),
    );
    unlock = { row: urow, word };
    yourVouchRow.row.after(urow);
  };

  const update = (): void => {
    const ctx = read();

    // name — @Name when held, `no name` muted when not, loading… before the read
    // (WEB_INTERFACE → The author window). A clay handle carries one clay line
    // beneath it, the element the figures' line is, drawn by this draw alone;
    // no other site grows one.
    name.field.replaceChildren();
    if (!ctx.usernameLoaded) {
      name.field.appendChild(el('span', 'inkmute', 'loading…'));
    } else if (ctx.username) {
      const handle = el('span', 'handle', '@' + ctx.username.name);
      markHandle(handle, authorKey, ctx.username.name);
      name.field.appendChild(handle);
      if (ctx.nameClay(authorKey, ctx.username.name)) {
        handle.classList.add('clay');
        name.field.appendChild(nameLine());
      }
    } else {
      name.field.appendChild(el('span', 'inkmute', 'no name'));
    }

    // endorsers — N vouches, then one row per voucher: their prefix (a ghost button
    // into their window). One page; `more` follows `next`.
    endorsersRow.field.replaceChildren();
    endorsers(endorsersRow.field, handlers, ctx, read);

    // your vouch — the reader's relation and the action, absent with no identity.
    const yv = ctx.yourVouch;
    if (yv === null) {
      yourVouchRow.row.remove();
    } else {
      if (yourVouchRow.row.parentNode !== b) posts.row.before(yourVouchRow.row);
      yourVouchRow.field.replaceChildren();
      yourVouch(yourVouchRow.field, yv, ctx.flight, press);
    }
    const offered = yv?.kind === 'plus' ? 'vouch' : yv?.kind === 'vouched' ? 'unvouch' : null;
    if (unlock !== null && (!ctx.locked || offered !== unlock.word)) endUnlock();
  };
  update();
  return { el: b, update };
}

function endorsers(field: HTMLElement, handlers: AuthorHandlers, ctx: AuthorCtx, read: () => AuthorCtx): void {
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
    // WEB_INTERFACE → The identity display — the handle where the row carries a
    // name, else the prefix; the same control, the handle clay where the chain
    // does not back it.
    const btn = el('button', v.voucherName !== null ? 'handle authorbtn' : 'hex authorbtn');
    if (v.voucherName !== null && ctx.nameClay(v.voucherId, v.voucherName)) btn.classList.add('clay');
    if (v.voucherName !== null) markHandle(btn, v.voucherId, v.voucherName);
    btn.textContent = v.voucherName !== null ? '@' + v.voucherName : shortHex(v.voucherId, 10);
    btn.setAttribute('aria-label', 'open this author');
    btn.addEventListener('click', () => handlers.openAuthor(v.voucherId, read().origin));
    line.appendChild(btn);
    field.appendChild(line);
  }
  if (ctx.endorsersNext) {
    const more = el('button', 'word', 'more');
    more.setAttribute('aria-label', 'load more endorsers');
    more.addEventListener('click', () => handlers.moreEndorsers(ctx.authorKey));
    field.appendChild(more);
  }
}

function yourVouch(field: HTMLElement, yv: YourVouch, flight: Flight | null, press: (word: 'vouch' | 'unvouch') => void): void {
  if (yv.kind === 'reason') {
    // A one-line reason the reader cannot vouch (WEB_INTERFACE → The author
    // window); no flight applies — there is nothing in flight.
    field.appendChild(el('span', 'hint', yv.text));
    return;
  }
  if (yv.kind === 'pending') {
    // WEB_INTERFACE → The author window: while the vouch flies the row carries
    // the flight's stage line in the word's place.
    if (flight) field.appendChild(stageLine(flight));
    return;
  }
  if (yv.kind === 'plus') {
    // vouch is a word, and this row is the one place a vouch is cast
    // (HOUSE_STYLE → Interaction → "A word is a control, and it wears no box").
    const btn = el('button', 'word');
    btn.textContent = 'vouch';
    btn.setAttribute('aria-label', 'vouch for this author — stakes 1 rep');
    btn.addEventListener('click', () => press('vouch'));
    field.appendChild(btn);
    const line = el('span', 'hint');
    line.append('stakes 1 rep, returned when you unvouch after a cooldown of ', mono(String(yv.cooldownBlocks)), ' blocks.');
    field.appendChild(line);
  } else {
    field.append(el('span', 'standing', 'vouched'));
    if (yv.sinceBlock !== null) {
      const since = el('span', 'hint');
      since.append(' since block ', mono(String(yv.sinceBlock)));
      field.appendChild(since);
    }
    const unvouch = el('button', 'word', 'unvouch');
    unvouch.setAttribute('aria-label', 'withdraw your vouch');
    unvouch.addEventListener('click', () => press('unvouch'));
    field.appendChild(unvouch);
    // The voice rule says what happens, in text — an aria-label is not that
    // (HOUSE_STYLE → Voice), parallel to the plus state's stakes sentence.
    const held = el('span', 'hint');
    held.append('your stake is held for ', mono(String(yv.cooldownBlocks)), ' blocks after an unvouch, and no new vouch until then.');
    field.appendChild(held);
  }
  // The flight's stage line, whatever its ending — a vouch or unvouch rejected or
  // expired from this window shows it here, not nowhere (WEB_INTERFACE → The
  // author window).
  if (flight) field.appendChild(stageLine(flight));
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
  likePending: (postId: string) => boolean;
  linkUrl: (id: string) => string;
  expandedImages: ReadonlySet<string>;    // images shown this session (WEB_INTERFACE → Content)
  nameClay: (key: string, name: string) => boolean; // the handle reads clay (→ The extension → "The verified names")
  // The window as a list a row belongs to, and the rows held for one of its
  // cards (WEB_INTERFACE → What the feed reads, and what a card shows for it →
  // "A row the reader opened under a card outlasts a redraw of its list").
  listKey: string;
  rowsUnder: (list: string, postId: string) => readonly CardRow[];
}

export interface PostsHandlers {
  openThread: (id: string, origin: Origin) => void;
  openAuthor: (key: string, origin: Origin) => void;
  pressLike: (list: string, postId: string, control: HTMLElement) => void;
  linkRefused: (list: string, postId: string, url: string, control: HTMLElement) => void;
  authorPostsMore: (key: string) => void;
  expandImage: (key: string) => void;     // an image loads on the reader's press (WEB_INTERFACE → Content)
  collapseImage: (key: string) => void;
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
  // The withheld line at the window's head (WEB_INTERFACE → The extension
  // → "The post check").
  const wl = withheldLine(feed.unboundCount);
  if (wl) b.appendChild(wl);
  if (feed.posts.length === 0) {
    b.appendChild(el('div', 'empty', 'no posts yet'));
    return b;
  }
  // A slot stands at the row the node named with no handler of its own
  // (WEB_INTERFACE → The extension → "The light read").
  for (const post of feed.posts) {
    if (isFull(post)) b.appendChild(postCard(post, handlers, ctx));
    else b.appendChild(card(post));
  }
  if (feed.next !== null) {
    const foot = el('div', 'feed-foot');
    const more = el('button', 'word', 'more posts');
    more.setAttribute('aria-label', 'load more posts by this author');
    more.addEventListener('click', () => handlers.authorPostsMore(ctx.authorKey));
    foot.appendChild(more);
    b.appendChild(foot);
  }
  return b;
}

/** One post by the author — the feed card's controls: like, link, the strip
 *  opening a thread one column right, the prefix, · you; no reply, which lives
 *  in the pane the strip opens (WEB_INTERFACE → The author window). */
function postCard(post: PostJson, handlers: PostsHandlers, ctx: PostsCtx): HTMLElement {
  const you = ctx.ownKey !== null && post.author === ctx.ownKey;
  return card(post, {
    replyCount: post.descendantCount,
    onOpen: (id) => handlers.openThread(id, ctx.origin),
    onAuthor: (key) => handlers.openAuthor(key, ctx.origin),
    nameClay: ctx.nameClay,
    you,
    expanded: ctx.expandedImages,
    onExpand: handlers.expandImage,
    onCollapse: handlers.collapseImage,
    ...listCardOpts(post, ctx.listKey, ctx, handlers),
  });
}
