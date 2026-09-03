import { el, shortHex } from '../dom';
import type { PostJson, Tombstone, StumpJson, PrunedJson, WithdrawnJson } from '../api/dto';
import { isTombstone } from '../api/dto';
import { assertContentHash } from '../integrity';
import type { Submission, FlightStage } from '../model/state';

// One post card, used by both the feed and a thread. The strip is the only
// control; the card is not a button, so its text stays
// selectable and a pointer can be parked on it.

export interface ParentRef {
  id: string;
  authorKey?: string | undefined; // resolved only when the parent is in view
  excerpt?: string | undefined;
}

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
  replyCount?: number | null;            // null → '?' (a feed row does not know)
  parentRef?: ParentRef | null;          // a feed reply's one-line reference
  onOpen?: ((id: string) => void) | null; // strip handler; null → no open control
  // Write surface (panes only) — absent on a read-only feed card.
  flight?: Flight | null;                // the stage line for the client's own submission
  onReply?: ((id: string) => void) | null; // ↩ reply — present on withdrawn and stumps too
  onLike?: ((id: string) => void) | null;   // like — absent by §7's exclusions
  liked?: boolean;                       // show 'liked' rather than a control
  likePending?: boolean;                 // the like has not settled — inkMute, count + 1
  composerKey?: string;                  // for the data-composer-open focus hook
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

function whoRow(authorKey: string, whenMs: number | null): HTMLElement {
  const who = el('div', 'who');
  // No naming layer exists — the public key is the identity. The
  // prefix is machine data, so mono.
  who.appendChild(el('span', 'hex', shortHex(authorKey, 16)));
  if (whenMs != null) who.appendChild(el('span', 'when', whenText(whenMs)));
  return who;
}

function replyCountNode(count: number | null): HTMLElement | null {
  if (count === null) {
    // Honest: the feed row carries no descendant count, so '?'. Finding out
    // would cost a thread fetch per card.
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

function likeNode(likeCount: number): HTMLElement | null {
  if (likeCount <= 0) return null;
  // `like` NEVER takes an s — a present-tense verb ("7 like this"), not a count
  // of objects; the protocol has no like object. Read-only here: no viewer is
  // sent, so there is no "you liked this" and no unlike.
  const l = el('span', 'like');
  l.appendChild(el('span', 'n', String(likeCount)));
  l.appendChild(document.createTextNode(' like'));
  return l;
}

function parentRefNode(ref: ParentRef): HTMLElement {
  const line = el('div', 'parentref');
  line.appendChild(el('span', 'g', '↳'));
  line.appendChild(el('span', 'lbl', 'in reply to'));
  if (ref.authorKey) line.appendChild(el('span', 'hex', shortHex(ref.authorKey, 10)));
  line.appendChild(el('span', 'hex', shortHex(ref.id, 10)));
  if (ref.excerpt) line.appendChild(el('span', 'excerpt', ref.excerpt));
  return line;
}

function strip(id: string, opts: CardOpts, card: HTMLElement): void {
  const onOpen = opts.onOpen;
  if (!onOpen) {
    // Nothing to open — a stump has nothing beneath it, a pending post is not on
    // the network yet. The band still draws its edge so the text column lands
    // one width down the whole column.
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
 *  height. */
function stageLine(flight: Flight): HTMLElement {
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
    said.appendChild(document.createTextNode('no block took this before height '));
    said.appendChild(el('span', 'n', (flight.expiresAtHeight ?? 0).toLocaleString('en-GB')));
    said.appendChild(document.createTextNode('.'));
    s.appendChild(said);
    if (flight.onTryAgain) {
      const again = el('button', 'mini');
      again.setAttribute('aria-label', 'build this again from your current balance and post it');
      again.appendChild(el('span', null, 'try again'));
      again.addEventListener('click', flight.onTryAgain);
      s.appendChild(again);
    }
    return s;
  }
  s.appendChild(said);
  return s;
}

/** The like area — 'liked' once done (no undoing it), a like button otherwise, or
 *  the read-only count on a feed card. `like` never takes an s. */
function likeArea(post: PostJson, opts: CardOpts): HTMLElement | null {
  if (opts.liked) {
    // inkMute until a block takes it, greenText after — the karma colour.
    const l = el('span', 'liked' + (opts.likePending ? '' : ' settled'));
    const count = post.likeCount + (opts.likePending ? 1 : 0);
    if (count > 0) l.appendChild(el('span', 'n', String(count)));
    l.appendChild(el('span', null, 'liked'));
    return l;
  }
  if (opts.onLike) {
    const lb = el('button', 'likebtn');
    lb.setAttribute('aria-label', 'like this post — permanent, and moves karma to its author');
    if (post.likeCount > 0) lb.appendChild(el('span', 'n', String(post.likeCount)));
    lb.appendChild(el('span', null, 'like'));
    lb.addEventListener('click', () => opts.onLike!(post.id));
    return lb;
  }
  return likeNode(post.likeCount);
}

/** ↩ reply — a ghost button in the meta row (WEB_INTERFACE → The write surface). */
function replyButton(id: string, opts: CardOpts): HTMLElement | null {
  if (!opts.onReply) return null;
  const rb = el('button', 'mini reply-ctl');
  if (opts.composerKey) rb.setAttribute('data-composer-open', opts.composerKey);
  rb.setAttribute('aria-label', 'reply to this post');
  rb.appendChild(el('span', 'g', '↩'));
  rb.appendChild(el('span', null, 'reply'));
  rb.addEventListener('click', () => opts.onReply!(id));
  return rb;
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
export function submissionToPost(sub: Submission): PostJson {
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

function livePostCard(post: PostJson, opts: CardOpts): HTMLElement {
  const flight = opts.flight ?? null;
  const landed = flight?.stage === 'landed';
  // A node's mempool post is pending; the client's own submission is pending
  // until it lands, when it fills and gains its meta row.
  const pending = post.status === 'pending' && !landed;
  const card = el('div', shellClasses(pending ? ' pending' : '', opts));
  const body = el('div', 'card-body');

  if (opts.parentRef) body.appendChild(parentRefNode(opts.parentRef));
  body.appendChild(whoRow(post.author, post.blockCreatedAt));

  if (post.content === null) {
    // Held by commit, body not yet backfilled on this node. Says what is,
    // without implying withdrawal — it is not one of the three absence states.
    body.appendChild(el('div', 'card-absent', 'content not on this node yet'));
  } else {
    // The read surface hashes here: recompute the body's commitment with the
    // shared implementation and assert it matches what the node served, showing
    // nothing.
    // WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim
    assertContentHash(post.id, post.content, post.contentHash);
    body.appendChild(el('div', 'card-content', post.content));
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
      const lk = likeArea(post, opts);
      if (lk) meta.appendChild(lk);
      if (landed && post.blockHeight !== null) meta.appendChild(inBlockNode(post.blockHeight));
      const rb = replyButton(post.id, opts);
      if (rb) meta.appendChild(rb);
    }
    body.appendChild(meta);
  }
  card.appendChild(body);

  // A pending post reserves the band but has no control — that also removes the
  // last way landing could move anything.
  strip(post.id, pending ? { ...opts, onOpen: null } : opts, card);
  return card;
}

function withdrawnCard(row: WithdrawnJson, opts: CardOpts): HTMLElement {
  const card = el('div', shellClasses('', opts));
  const body = el('div', 'card-body');
  if (opts.parentRef) body.appendChild(parentRefNode(opts.parentRef));
  body.appendChild(whoRow(row.author, null));
  // Withdrawn is never "deleted": its replies survive and hang off it. Saying
  // so is the whole difference (WEB_INTERFACE → The three absence states).
  body.appendChild(el('div', 'withdrawn', 'withdrawn by its author — the replies below are untouched'));
  const meta = el('div', 'meta');
  const rc = replyCountNode(opts.replyCount ?? null);
  if (rc) meta.appendChild(rc);
  // Reply survives withdrawal — replies to one are the whole difference from
  // deletion (WEB_INTERFACE → The write surface).
  const rb = replyButton(row.id, opts);
  if (rb) meta.appendChild(rb);
  body.appendChild(meta);
  card.appendChild(body);
  strip(row.id, opts, card); // there is something beneath — keep the control
  return card;
}

function stumpCard(row: StumpJson, opts: CardOpts): HTMLElement {
  const card = el('div', shellClasses(' stump', opts));
  const body = el('div', 'card-body');
  body.appendChild(whoRow(row.author, null));
  const s = el('div', 'stump-body');
  s.appendChild(document.createTextNode('subtree withdrawn by its author. '));
  s.appendChild(el('span', 'n', String(row.replyCount)));
  s.appendChild(document.createTextNode(' replies and '));
  s.appendChild(el('span', 'n', String(row.upvoteCount)));
  s.appendChild(document.createTextNode(' upvotes settled at height '));
  s.appendChild(el('span', 'n', row.compactedAtBlockHeight.toLocaleString('en-GB')));
  s.appendChild(document.createTextNode('.'));
  body.appendChild(s);
  // A stump accepts a reply — parent refs may point at one and the interface
  // should not forbid what the protocol permits (WEB_INTERFACE → The write surface).
  const rb = replyButton(row.id, opts);
  if (rb) {
    const meta = el('div', 'meta');
    meta.appendChild(rb);
    body.appendChild(meta);
  }
  card.appendChild(body);
  strip(row.id, { ...opts, onOpen: null }, card); // no strip — nothing beneath
  return card;
}

function prunedCard(row: PrunedJson, opts: CardOpts): HTMLElement {
  const card = el('div', shellClasses('', opts));
  const body = el('div', 'card-body');
  body.appendChild(whoRow(row.author, null));
  const s = el('div', 'pruned-body');
  s.appendChild(document.createTextNode('pruned under root '));
  s.appendChild(el('span', 'n', shortHex(row.rootPostHash, 16)));
  s.appendChild(document.createTextNode(' at height '));
  s.appendChild(el('span', 'n', row.compactedAtBlockHeight.toLocaleString('en-GB')));
  s.appendChild(document.createTextNode('.'));
  body.appendChild(s);
  card.appendChild(body);
  strip(row.id, { ...opts, onOpen: null }, card); // no strip — nothing beneath
  return card;
}

/** Render any post-shaped row: a live/pending post, or one of the three
 *  absence states. */
export function card(row: PostJson | Tombstone, opts: CardOpts = {}): HTMLElement {
  if (isTombstone(row)) {
    if (row.kind === 'withdrawn') return withdrawnCard(row, opts);
    if (row.kind === 'stump') return stumpCard(row, opts);
    return prunedCard(row, opts);
  }
  return livePostCard(row, opts);
}
