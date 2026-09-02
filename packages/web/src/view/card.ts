import { el, shortHex } from '../dom';
import type { PostJson, Tombstone, StumpJson, PrunedJson, WithdrawnJson } from '../api/dto';
import { isTombstone } from '../api/dto';

// One post card, used by both the feed and a thread. The strip is the only
// control (thread-panes → §2.1); the card is not a button, so its text stays
// selectable and a pointer can be parked on it.

export interface ParentRef {
  id: string;
  authorKey?: string | undefined; // resolved only when the parent is in view
  excerpt?: string | undefined;
}

export interface CardOpts {
  open?: boolean;                        // this thread is open in a pane
  root?: boolean;                        // the pane's own root
  depth?: number;                        // indentation inside a thread
  replyCount?: number | null;            // null → '?' (a feed row does not know)
  parentRef?: ParentRef | null;          // a feed reply's one-line reference
  onOpen?: ((id: string) => void) | null; // strip handler; null → no open control
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
  // No naming layer exists — the public key is the identity (spec → §8). The
  // prefix is machine data, so mono.
  who.appendChild(el('span', 'hex', shortHex(authorKey, 16)));
  if (whenMs != null) who.appendChild(el('span', 'when', whenText(whenMs)));
  return who;
}

function replyCountNode(count: number | null): HTMLElement | null {
  if (count === null) {
    // Honest: the feed row carries no descendant count, so '?'. Finding out
    // would cost a thread fetch per card (WEB_INTERFACE → the feed section).
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
  line.appendChild(document.createTextNode('in reply to'));
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
    // one width down the whole column (thread-panes → §2.1).
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

function livePostCard(post: PostJson, opts: CardOpts): HTMLElement {
  const pending = post.status === 'pending';
  const card = el('div', shellClasses(pending ? ' pending' : '', opts));
  const body = el('div', 'card-body');

  if (opts.parentRef) body.appendChild(parentRefNode(opts.parentRef));
  body.appendChild(whoRow(post.author, post.blockCreatedAt));

  if (post.content === null) {
    // Held by commit, body not yet backfilled on this node. Says what is,
    // without implying withdrawal (spec → §10 records this as a fourth case the
    // three absence states do not cover).
    body.appendChild(el('div', 'card-absent', 'content not on this node yet'));
  } else {
    body.appendChild(el('div', 'card-content', post.content));
  }

  const meta = el('div', 'meta');
  const rc = replyCountNode(opts.replyCount ?? null);
  if (rc) meta.appendChild(rc);
  if (!pending) {
    const lk = likeNode(post.likeCount);
    if (lk) meta.appendChild(lk);
  }
  body.appendChild(meta);
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
