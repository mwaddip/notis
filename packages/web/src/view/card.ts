import { el, shortHex } from '../dom';
import { parseContent, renderContent } from './content';
import { copyGlyph } from './glyphs';
import { markHandle } from './name-handle';
import type { FeedRow, LightJson, PostJson, WithdrawnJson } from '../api/dto';
import { isLight, isWithdrawn } from '../api/dto';
import { assertContentHash } from '../integrity';
import type { Submission, FlightStage } from '../model/state';

// One post card, used by both the feed and a thread. The strip is the only
// control; the card is not a button, so its text stays
// selectable and a pointer can be parked on it.


/** A client submission's flight, driving the stage line on its own pending card. */
export interface Flight {
  stage: FlightStage;
  reason?: string | null;
  expiresAtHeight?: number | null;
  onTryAgain?: (() => void) | null;
}

export interface CardOpts {
  open?: boolean;                        // this thread is open in a pane
  root?: boolean;                        // the pane's own root
  depth?: number;                        // indentation inside a thread
  replyCount?: number | null;            // the row's descendantCount; null → '?' (a submission alone)
  onOpen?: ((id: string) => void) | null; // strip handler; null → no open control
  // Content — an image loads on the reader's press (WEB_INTERFACE → Content).
  expanded?: ReadonlySet<string>;        // keys of images already shown: <postId>:<index in document order>
  onExpand?: (key: string) => void;      // the reader pressed to load one
  onCollapse?: (key: string) => void;    // a shown image failed to load — drop its key
  // Write surface — the like is on feed, author-posts and pane cards; reply and
  // withdraw are in a pane alone (WEB_INTERFACE → What the feed reads, and what a card shows for it).
  flight?: Flight | null;                // the stage line for the client's own submission
  onReply?: ((id: string) => void) | null; // ↩ reply — present on a withdrawn card too
  liked?: boolean;                       // show 'liked' rather than a control
  likePending?: boolean;                 // the like has not settled — inkMute, count + 1
  composerKey?: string;                  // for the data-composer-open focus hook
  you?: boolean;                         // the reader's own card — · you after the prefix
  // A press that may open a row under the card hands over the control pressed:
  // the row goes in under the card that control stands in, and whether the
  // identity is locked is read then, never when the card was drawn
  // (WEB_INTERFACE → What the feed reads, and what a card shows for it →
  // "A row's controls act on the card as it stands at the press").
  onLike?: ((id: string, control: HTMLElement) => void) | null;     // like — on another's confirmed post
  onWithdraw?: ((id: string, control: HTMLElement) => void) | null; // withdraw — on the reader's own, in a pane
  onLinkRefused?: (url: string, control: HTMLElement) => void;      // the clipboard took no write
  // The row held for this card, drawn beneath its meta row (WEB_INTERFACE →
  // What the feed reads, and what a card shows for it → "A row the reader
  // opened under a card outlasts a redraw of its list").
  heldRow?: HTMLElement | null;
  // The identity display (WEB_INTERFACE → The identity display).
  onAuthor?: ((key: string) => void) | null; // the prefix button opens the author window
  nameClay?: (key: string, name: string) => boolean; // the handle reads clay (→ The extension → "The verified names")
  // The author's own controls (WEB_INTERFACE → The withdraw control).
  withdraw?: 'pending' | Flight | null;  // 'pending' from the ledger, else the transient flight in the slot
  canWithdraw?: boolean;                 // false → disabled with the reason as the title
  // WEB_INTERFACE → Links
  linkUrl?: string;
}

/** Compact absolute local time; the on-chain marker is the block height, this
 *  is the header timestamp (unix ms) rendered for a human. Never relative — a
 *  relative time would have to keep moving, and nothing ticks here. */
function whenText(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

function whoRow(authorKey: string, authorName: string | null, whenMs: number | null, opts: CardOpts): HTMLElement {
  const who = el('div', 'who');
  // WEB_INTERFACE → The identity display — the handle @Name where the row
  // carries a name, else the key prefix in mono. Where the prefix is a control
  // the handle is the same control. In the extension a handle the chain does
  // not back is clay, the text alone; a handle that reads the check carries its
  // pair, so a result lands on it in place.
  const clay = authorName !== null && opts.nameClay !== undefined && opts.nameClay(authorKey, authorName);
  if (opts.onAuthor) {
    const b = el('button', authorName !== null ? 'handle authorbtn' : 'hex authorbtn');
    if (clay) b.classList.add('clay');
    if (authorName !== null && opts.nameClay !== undefined) markHandle(b, authorKey, authorName);
    b.textContent = authorName !== null ? '@' + authorName : shortHex(authorKey, 16);
    b.setAttribute('aria-label', 'open this author');
    b.addEventListener('click', () => opts.onAuthor!(authorKey));
    who.appendChild(b);
  } else {
    if (authorName !== null) {
      const h = el('span', 'handle', '@' + authorName);
      if (clay) h.classList.add('clay');
      if (opts.nameClay !== undefined) markHandle(h, authorKey, authorName);
      who.appendChild(h);
    } else {
      who.appendChild(el('span', 'hex', shortHex(authorKey, 16)));
    }
  }
  if (opts.you) who.appendChild(el('span', 'you', '· you'));
  if (whenMs != null) who.appendChild(el('span', 'when', whenText(whenMs)));
  return who;
}


function replyCountNode(count: number | null): HTMLElement | null {
  if (count === null) {
    // '?' remains on the reader's own submission alone — no node row until it
    // lands (WEB_INTERFACE → What the feed reads).
    const r = el('span', 'replies');
    r.appendChild(el('span', 'n', '?'));
    r.appendChild(document.createTextNode(' replies'));
    return r;
  }
  if (count <= 0) return null;
  const r = el('span', 'replies');
  r.appendChild(el('span', 'n', String(count)));
  r.appendChild(document.createTextNode(count === 1 ? ' reply' : ' replies'));
  return r;
}

/** The like count — `N liked`; absent at 0. The reader's state is the count's
 *  colour: inkMute at rest and while the reader's like is pending, greenText
 *  once a block took it (WEB_INTERFACE → What the feed reads, and what a card
 *  shows for it). */
function likedCount(likeCount: number, settled?: boolean): HTMLElement | null {
  if (likeCount <= 0) return null;
  const l = el('span', 'liked' + (settled ? ' settled' : ''));
  l.appendChild(el('span', 'n', String(likeCount)));
  l.appendChild(document.createTextNode(' liked'));
  return l;
}

function strip(id: string, opts: CardOpts, card: HTMLElement): void {
  const onOpen = opts.onOpen;
  if (!onOpen) {
    // Nothing to open — a pending post is not on the network yet. The band still
    // draws its edge so the text column lands one width down the whole column.
    const band = el('div', 'strip inert');
    band.setAttribute('aria-hidden', 'true');
    card.appendChild(band);
    return;
  }
  const s = el('button', 'strip', '›');
  s.setAttribute('aria-label', opts.open ? 'raise this thread in the open panes' : 'open this thread in a pane');
  s.setAttribute('aria-pressed', opts.open ? 'true' : 'false');
  s.addEventListener('click', () => onOpen(id));
  card.appendChild(s);
}

function shellClasses(extra: string, opts: CardOpts): string {
  return (
    'card' +
    extra +
    (opts.open ? ' open' : '') +
    (opts.root ? ' thread-root' : '') +
    (opts.depth ? ' depth-' + Math.min(opts.depth, 3) : '')
  );
}

/** The stage line — two stages then one of three endings (WEB_INTERFACE → The
 *  wallet). One fixed line box, so what it contains cannot change the card's
 *  height. Exported for the author window's your-vouch row. */
export function stageLine(flight: Flight): HTMLElement {
  const s = el('div', 'stage');
  const said = el('span', null);
  if (flight.stage === 'submitting') {
    said.textContent = 'submitting…';
  } else if (flight.stage === 'submitted') {
    said.textContent = 'submitted';
  } else if (flight.stage === 'rejected') {
    // Say what happened, never a status code (HOUSE_STYLE → Voice).
    said.textContent = flight.reason ?? '';
  } else {
    // "by", not "before": the entry is still eligible at its expiry height and is
    // purged once the tip passes it (reconcile's tip > expiresAtHeight).
    said.appendChild(document.createTextNode('no block took this by height '));
    said.appendChild(el('span', 'n', (flight.expiresAtHeight ?? 0).toLocaleString('en-GB')));
    said.appendChild(document.createTextNode('.'));
    s.appendChild(said);
    if (flight.onTryAgain) {
      const again = el('button', 'word');
      again.setAttribute('aria-label', 'build this again from your current balance and post it');
      again.textContent = 'try again';
      again.addEventListener('click', flight.onTryAgain);
      s.appendChild(again);
    }
    return s;
  }
  s.appendChild(said);
  return s;
}

/** The like area — the count `N liked`, then the word `like` while it can act,
 *  the reader's state as the count's colour (WEB_INTERFACE → What the feed reads,
 *  and what a card shows for it). */
function likeArea(post: PostJson, opts: CardOpts, meta: HTMLElement): void {
  if (opts.liked) {
    const count = post.likeCount + (opts.likePending ? 1 : 0);
    const lk = likedCount(count, !opts.likePending);
    if (lk) {
      lk.title = 'you liked this';
      lk.setAttribute('aria-label', 'you liked this');
      meta.appendChild(lk);
    }
    return;
  }
  const lk = likedCount(post.likeCount);
  if (lk) meta.appendChild(lk);
  if (opts.onLike) {
    const lb = el('button', 'word');
    lb.setAttribute('aria-label', 'like this post — permanent, and moves rep to its author');
    lb.textContent = 'like';
    lb.addEventListener('click', () => opts.onLike!(post.id, lb));
    meta.appendChild(lb);
  }
}

/** The withdraw slot — the meta row's first control on the reader's own confirmed
 *  live post, where `like` sits on another's (WEB_INTERFACE → The withdraw
 *  control). A pending or flighted withdrawal shows the stage line — `submitted`
 *  from the ledger, or the transient `submitting…`/expired flight; otherwise the
 *  `withdraw` button, disabled with the reason as its `title` when the key has no
 *  karma box to sign with (HOUSE_STYLE → Interaction). */
function withdrawArea(post: PostJson, opts: CardOpts): HTMLElement | null {
  const w = opts.withdraw ?? null;
  if (w === 'pending') return stageLine({ stage: 'submitted' });
  if (w !== null) return stageLine(w); // the transient flight — submitting or expired
  if (!opts.onWithdraw) return null;

  const wb = el('button', 'word withdraw-ctl');
  wb.textContent = 'withdraw';
  if (opts.canWithdraw === false) {
    (wb as HTMLButtonElement).disabled = true;
    const reason = 'needs one rep box to sign with; this key has none';
    wb.title = reason;
    wb.setAttribute('aria-label', reason);
    return wb;
  }
  wb.setAttribute('aria-label', 'withdraw this post — its content goes, its replies stay');
  wb.addEventListener('click', () => opts.onWithdraw!(post.id, wb));
  return wb;
}

/** ↩ reply — a ghost button in the meta row (WEB_INTERFACE → The write surface). */
function replyButton(id: string, opts: CardOpts): HTMLElement | null {
  if (!opts.onReply) return null;
  const rb = el('button', 'word reply-ctl');
  if (opts.composerKey) rb.setAttribute('data-composer-open', opts.composerKey);
  rb.setAttribute('aria-label', 'reply to this post');
  rb.appendChild(el('span', 'g', '↩'));
  rb.appendChild(document.createTextNode(' reply'));
  rb.addEventListener('click', () => opts.onReply!(id));
  return rb;
}

// WEB_INTERFACE → Links — the copy glyph at the meta row's right edge; where
// the clipboard is absent or takes no write, the press is handed on with the
// glyph, for the link held as text.
function linkButton(opts: CardOpts): HTMLElement | null {
  if (!opts.linkUrl) return null;
  const url = opts.linkUrl;
  let copied = false;
  const lb = el('button', 'word linkbtn');
  lb.setAttribute('aria-label', 'copy this post\'s link');
  lb.appendChild(copyGlyph());
  const refused = (): void => opts.onLinkRefused?.(url, lb);
  lb.addEventListener('click', () => {
    if (copied) return;
    if (typeof navigator.clipboard?.writeText !== 'function') {
      refused();
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => { copied = true; lb.textContent = 'copied'; },
      () => refused(),
    );
  });
  return lb;
}

/** Put a row under the card `at` stands in — `at` a control of the card, or a
 *  row already under it — directly beneath the meta row, replacing no node
 *  (WEB_INTERFACE → What the feed reads, and what a card shows for it →
 *  "Opening a row and ending one redraw nothing else"). Answers false where
 *  `at` stands in no card on screen. */
export function mountRow(at: HTMLElement, row: HTMLElement): boolean {
  if (!at.isConnected) return false;
  const body = at.closest('.card-body');
  const meta = body === null ? undefined : [...body.children].find((c) => c.classList.contains('meta'));
  if (meta === undefined) return false;
  meta.insertAdjacentElement('afterend', row);
  return true;
}

function inBlockNode(height: number): HTMLElement {
  const b = el('span', null);
  b.appendChild(document.createTextNode('in block '));
  b.appendChild(el('span', 'n', height.toLocaleString('en-GB')));
  return b;
}

/** A submission as a PostJson: status 'pending' until it lands, the identity's
 *  key as author, a locally-computed contentHash — so the render-path check is
 *  silent on it (WEB_INTERFACE → The wallet). */
export function submissionToPost(sub: Submission, ownName: string | null = null): PostJson {
  return {
    id: sub.postId ?? sub.txId ?? sub.localKey, // the node's id once it lands, so the strip opens the thread

    content: sub.content,
    contentHash: sub.contentHash,
    author: sub.author,
    parentRefs: sub.parentId ? [sub.parentId] : [],
    protocolVersion: 0,
    type: 'regular',
    status: sub.stage === 'landed' ? 'confirmed' : 'pending',
    blockHeight: sub.blockHeight,
    blockIndex: null,
    blockCreatedAt: null,
    likeCount: 0,
    // A submission's card reads replyCount: null and never fills the count cache,
    // so these are placeholders the render never reads (WEB_INTERFACE → What the feed reads).
    descendantCount: 0,
    authorName: ownName,
    // The row's creating transaction id (NODE_INTERFACE → Posts → "The
    // creating transaction rides a post row"). A submission that has yet to
    // land holds the client's own txId; before one exists the localKey holds
    // the row's identity and is used here too (the field is never read for a
    // submission card — WEB_INTERFACE → The wallet).
    txId: sub.txId ?? sub.localKey,
    likedByViewer: null,
  };
}

/** The flight opt for a submission — `try again` only on an expired one. */
export function flightFor(sub: Submission, tryAgain: (localKey: string) => void): Flight {
  return {
    stage: sub.stage,
    reason: sub.reason,
    expiresAtHeight: sub.expiresAtHeight,
    onTryAgain: sub.stage === 'expired' ? () => tryAgain(sub.localKey) : null,
  };
}

/** The like and link opts a feed card and an author-posts card carry — the shared
 *  half that a pane composes with reply and withdraw
 *  (WEB_INTERFACE → What the feed reads, and what a card shows for it). `list`
 *  names the list the card stands in — the feed, an author window, a pane —
 *  and rides each press with the post and the control pressed. */
export function listCardOpts(
  row: PostJson | WithdrawnJson,
  list: string,
  ctx: { writeEnabled: boolean; ownKey: string | null; likePending: (id: string) => boolean; linkUrl: (id: string) => string },
  handlers: {
    pressLike: (list: string, postId: string, control: HTMLElement) => void;
    linkRefused: (list: string, postId: string, url: string, control: HTMLElement) => void;
  },
): Partial<CardOpts> {
  const opts: Partial<CardOpts> = {};
  if (isWithdrawn(row) || row.status === 'confirmed') {
    opts.linkUrl = ctx.linkUrl(row.id);
    opts.onLinkRefused = (url, control) => handlers.linkRefused(list, row.id, url, control);
  }
  if (isWithdrawn(row) || !ctx.writeEnabled || row.status !== 'confirmed') return opts;
  const isOwn = ctx.ownKey !== null && row.author === ctx.ownKey;
  if (isOwn) return opts;
  const overlaid = ctx.likePending(row.id);
  const liked = overlaid || row.likedByViewer === true;
  if (liked) {
    opts.liked = true;
    opts.likePending = overlaid && row.likedByViewer !== true;
  } else {
    opts.onLike = (id, control) => handlers.pressLike(list, id, control);
  }
  return opts;
}

function livePostCard(post: PostJson, opts: CardOpts): HTMLElement {
  const flight = opts.flight ?? null;
  const landed = flight?.stage === 'landed';
  // A node's mempool post is pending; the client's own submission is pending
  // until it lands, when it fills and gains its meta row.
  const pending = post.status === 'pending' && !landed;
  const card = el('div', shellClasses(pending ? ' pending' : '', opts));
  card.dataset.postId = post.id;
  const body = el('div', 'card-body');

  body.appendChild(whoRow(post.author, post.authorName, post.blockCreatedAt, opts));

  if (post.content === null) {
    // Held by commit, body not yet backfilled on this node. Says what is,
    // without implying withdrawal — it is not the withdrawn state.
    body.appendChild(el('div', 'card-absent', 'content not on this node yet'));
  } else {
    // The read surface hashes here: recompute the body's commitment with the
    // shared implementation and assert it matches what the node served, showing
    // nothing.
    // WEB_INTERFACE → The client's builds substitute nothing
    assertContentHash(post.id, post.content, post.contentHash);
    // The content grammar builds the body's nodes (WEB_INTERFACE → Content →
    // "A newline is a line break, a blank line a paragraph").
    body.appendChild(
      renderContent(parseContent(post.content), {
        postId: post.id,
        expanded: opts.expanded,
        onExpand: opts.onExpand,
        onCollapse: opts.onCollapse,
      }),
    );
  }

  if (flight && flight.stage !== 'landed') {
    // The client's own in-flight submission — the stage line takes the meta's slot.
    body.appendChild(stageLine(flight));
  } else {
    const meta = el('div', 'meta');
    const rc = replyCountNode(opts.replyCount ?? null);
    if (rc) meta.appendChild(rc);
    // Controls only on a landed or confirmed card, never a node's pending one.
    if (!pending) {
      // The first slot: on the reader's own confirmed post the read-only like
      // count stays and the withdraw control — or its stage line in flight —
      // follows it; on another's, the like control (WEB_INTERFACE → The withdraw
      // control).
      const wa = withdrawArea(post, opts);
      if (wa) {
        const count = likedCount(post.likeCount);
        if (count) meta.appendChild(count);
        meta.appendChild(wa);
      } else {
        likeArea(post, opts, meta);
      }
      if (landed && post.blockHeight !== null) meta.appendChild(inBlockNode(post.blockHeight));
      const rb = replyButton(post.id, opts);
      if (rb) meta.appendChild(rb);
      const lnk = linkButton(opts);
      if (lnk) meta.appendChild(lnk);
    }
    body.appendChild(meta);
    // The row held for this card stands beneath the meta row; a pending card
    // has no control to open one from, and draws none.
    if (!pending && opts.heldRow) body.appendChild(opts.heldRow);
  }
  card.appendChild(body);

  // A pending post reserves the band but has no control — that also removes the
  // last way landing could move anything.
  strip(post.id, pending ? { ...opts, onOpen: null } : opts, card);
  return card;
}

function withdrawnCard(row: WithdrawnJson, opts: CardOpts): HTMLElement {
  const card = el('div', shellClasses('', opts));
  card.dataset.postId = row.id;
  const body = el('div', 'card-body');
  body.appendChild(whoRow(row.author, row.authorName, null, opts));
  // Withdrawn is never "deleted": its replies survive and hang off it. Saying
  // so is the whole difference (WEB_INTERFACE → The withdrawn state).
  body.appendChild(el('div', 'withdrawn', 'withdrawn by its author — the replies below are untouched'));
  const meta = el('div', 'meta');
  const rc = replyCountNode(opts.replyCount ?? null);
  if (rc) meta.appendChild(rc);
  // Reply survives withdrawal — replies to one are the whole difference from
  // deletion (WEB_INTERFACE → The write surface).
  const rb = replyButton(row.id, opts);
  if (rb) meta.appendChild(rb);
  const lnk = linkButton(opts);
  if (lnk) meta.appendChild(lnk);
  body.appendChild(meta);
  card.appendChild(body);
  strip(row.id, opts, card); // there is something beneath — keep the control
  return card;
}

/** The slot where a card will stand — a reader that lacks the post holds this
 *  against its id (WEB_INTERFACE → The extension → "The light read",
 *  HOUSE_STYLE → Motion → "A slot holds a post's place"). Draws what the row
 *  carries and no more: the handle when it names one, the time, the counts,
 *  everything in `inkMute`, with no text, no key and no control. The strip is
 *  inert, as a pending card's; no `:hover` applies, and the stylesheet
 *  declares no transition or animation on it. */
function slotCard(row: LightJson, opts: CardOpts): HTMLElement {
  const card = el('div', shellClasses(' slot', opts));
  card.dataset.postId = row.id;
  const body = el('div', 'card-body');

  const who = el('div', 'who');
  if (row.authorName !== null) {
    // A plain `span.handle` — never a button, no key prefix, no
    // `data-name-pair`, no `· you` (WEB_INTERFACE → The extension → "The
    // light read" → "The name on a slot is the node's word, unchecked").
    who.appendChild(el('span', 'handle', '@' + row.authorName));
  }
  if (row.blockCreatedAt !== null) who.appendChild(el('span', 'when', whenText(row.blockCreatedAt)));
  body.appendChild(who);

  // The text's place: one empty block, no words in it.
  body.appendChild(el('div', 'slot-text'));

  const meta = el('div', 'meta');
  const rc = replyCountNode(row.descendantCount);
  if (rc) meta.appendChild(rc);
  const lk = likedCount(row.likeCount);
  if (lk) meta.appendChild(lk);
  body.appendChild(meta);
  card.appendChild(body);

  // The inert strip — the pending card's — no open control, keeps the band so
  // the text column lands one width down the whole column.
  strip(row.id, { ...opts, onOpen: null }, card);
  return card;
}

/** Render any row the client holds: a live or pending post, the withdrawn
 *  state, or a slot (WEB_INTERFACE → The extension → "The light read"). */
export function card(row: FeedRow, opts: CardOpts = {}): HTMLElement {
  if (isWithdrawn(row)) return withdrawnCard(row, opts);
  if (isLight(row)) return slotCard(row, opts);
  return livePostCard(row, opts);
}
