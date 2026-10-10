// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FeedRow, LightJson, PostJson, PostResult, ThreadResult, WithdrawnJson, FeedResult } from '../src/api/dto';
import { isLight, isWithdrawn } from '../src/api/dto';
import type { Mode } from '../src/mode';
import {
  ME, fullRow, light, tomb, harness, testResolver, makeCache, settle,
  lockableIdentity, recordingWrites, karmaWithBox,
  type Harness, type LockableIdentity, type RecordingWrites, type Call,
} from './app-light-shared';

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list".
// Every case presses the control on a card the App drew, types in the row's
// own field, and causes a redraw by what causes one in the product.

const OTHER = 'ee'.repeat(32); // another author
const NEXT_KEY = 'cc'.repeat(32); // the key an identity change loads
const QUESTION = 'withdraw this post? the content goes; the replies stay.';

interface Rig extends Harness {
  id: LockableIdentity;
  writes: RecordingWrites;
  resolves: Call[];
  /** The number of rows the App holds. */
  held(): number;
}

const page = (posts: Array<PostJson | LightJson>): { posts: FeedRow[]; next: null; pending: FeedRow[]; pendingCount: number } =>
  ({ posts, next: null, pending: [], pendingCount: 0 });

const thread = (root: PostJson, descendants: FeedRow[], ancestors: FeedRow[] = []): ThreadResult => ({
  post: root, ancestors, ancestorCount: ancestors.length, descendants, descendantCount: descendants.length,
  next: null, pending: [], pendingCount: 0,
});

const asResult = (row: PostJson): PostResult => ({ ...row, confirmedAuthor: row.author });

/** The last rig built in this case; the file's afterEach reads it. */
let currentRig: Rig | null = null;

/** An App over the shared fakes: an identity whose lock the case moves, a
 *  write client that records, a key holding one rep box, and the node's
 *  answers for the feed and for each thread named. `resolver` hands the App
 *  the extension's seams, so a slot can fill or leave. */
function rig(o: {
  feed: Array<PostJson | LightJson>;
  threads?: ThreadResult[];
  locked?: boolean;
  resolver?: boolean;
  feedPages?: FeedResult[];
  mode?: Mode;
}): Rig {
  const id = lockableIdentity(ME, o.locked ?? true);
  const writes = recordingWrites(id);
  const r = o.resolver ? testResolver() : null;
  const feedResults: FeedResult[] = [page(o.feed), ...(o.feedPages ?? [])];
  const h = harness({
    identityKey: ME, identity: id.identity, writeClient: writes.client, karma: karmaWithBox(ME),
    resolver: r?.resolver ?? null, cache: r ? makeCache().cache : null,
    feedResults, mode: o.mode,
  });
  const answer = (row: FeedRow | null): void => {
    if (row !== null && !isWithdrawn(row) && !isLight(row)) h.fake.postById!.set(row.id, asResult(row));
  };
  for (const row of o.feed) answer(row);
  for (const p of o.feedPages ?? []) for (const row of [...p.posts, ...p.pending]) answer(row);
  for (const t of o.threads ?? []) {
    h.fake.threadById!.set(t.post!.id, t);
    for (const row of [t.post, ...t.ancestors, ...t.descendants]) answer(row);
  }
  const rig: Rig = {
    ...h, id, writes, resolves: r?.calls ?? [],
    held: () => (h.app as unknown as { cardRows: { size: number } }).cardRows.size,
  };
  currentRig = rig;
  return rig;
}

/** The reads a start makes: the feed's first page and the reader's own state. */
async function boot(h: Rig): Promise<void> {
  await h.drive.loadFeed();
  await h.drive.loadMembershipState();
  await settle();
}

const cardOf = (root: ParentNode, id: string): HTMLElement => {
  const c = root.querySelector<HTMLElement>(`.card[data-post-id="${id}"]`);
  if (c === null) throw new Error('no card drawn for ' + id.slice(0, 8));
  return c;
};
const wordIn = (root: ParentNode, text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === text);
  if (b === undefined) throw new Error('no control reads ' + text);
  return b;
};
const likeOf = (card: HTMLElement): HTMLButtonElement => wordIn(card.querySelector('.meta')!, 'like');
const withdrawOf = (card: HTMLElement): HTMLButtonElement => card.querySelector<HTMLButtonElement>('.meta .withdraw-ctl')!;
const linkOf = (card: HTMLElement): HTMLButtonElement => card.querySelector<HTMLButtonElement>('.meta .linkbtn')!;
const fieldOf = (root: ParentNode): HTMLInputElement => root.querySelector<HTMLInputElement>('input[type="password"]')!;
const submit = (root: ParentNode): void => {
  root.querySelector('form.pf')!.dispatchEvent(new Event('submit', { cancelable: true }));
};
const esc = (at: HTMLElement): void => {
  at.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};
const regions = (h: Rig): HTMLElement[] => [...h.panes.querySelectorAll<HTMLElement>('.region')];

/** The strip on a feed card opens its thread in a pane. */
async function openFromFeed(h: Rig, id: string): Promise<void> {
  cardOf(h.feedEl, id).querySelector<HTMLButtonElement>('button.strip')!.click();
  await settle();
}

/** The clipboard refuses every write until the case ends. */
function refuseClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: () => Promise.reject(new Error('refused')) },
    writable: true, configurable: true,
  });
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  currentRig = null;
});
afterEach(() => {
  if (currentRig !== null) {
    const inDoc = document.querySelectorAll('.card-unlock, .card-confirm, .card-link').length;
    expect(inDoc).toBe(currentRig.held());
  }
  if (originalClipboard === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  else Object.defineProperty(navigator, 'clipboard', originalClipboard);
});

describe('a feed card\'s unlock row outlasts a redraw of the feed', () => {
  it('a slot leaving redraws the feed; A\'s card is a new node, A\'s unlock row the same node beneath it, the field holds the text, the focus is in the field; the form submits, unlocks, and the like goes out for A', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = light('B');
    const h = rig({ feed: [A, B], resolver: true });
    await boot(h);

    const pressed = cardOf(h.feedEl, A.id);
    likeOf(pressed).click();
    const row = cardOf(h.feedEl, A.id).querySelector<HTMLElement>('.card-unlock')!;
    expect(row).not.toBeNull();
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();
    expect(document.activeElement).toBe(field);

    // The slot's resolve ends with no node serving it: the feed is drawn whole.
    expect(h.resolves.length).toBe(1);
    h.resolves[0]!.end({ [B.id]: 'unserved' });
    await settle();

    const redrawn = cardOf(h.feedEl, A.id);
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);

    submit(row);
    await settle();
    expect(h.id.unlocks).toEqual(['secret']);
    expect(h.writes.likes).toEqual([A.id]);
  });
});

describe('a row belongs to the card it was opened under', () => {
  it('two lists: a row opened under the feed\'s card is not under the pane\'s card for the same post', async () => {
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [A], threads: [thread(A, [])] });
    await boot(h);
    await openFromFeed(h, A.id);
    likeOf(cardOf(h.feedEl, A.id)).click();
    expect(cardOf(h.feedEl, A.id).querySelector('.card-unlock')).not.toBeNull();
    expect(cardOf(h.panes, A.id).querySelector('.card-unlock')).toBeNull();
  });
});

describe('a link row outlasts a redraw of the feed', () => {
  it('the clipboard refuses, the link row stands; a slot leaving redraws the feed and the row stands', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = light('B');
    const h = rig({ feed: [A, B], resolver: true });
    refuseClipboard();
    await boot(h);
    const pressed = cardOf(h.feedEl, A.id);
    linkOf(pressed).click();
    await settle();
    const row = cardOf(h.feedEl, A.id).querySelector<HTMLElement>('.card-link');
    expect(row).not.toBeNull();
    h.resolves[0]!.end({ [B.id]: 'unserved' });
    await settle();
    const redrawn = cardOf(h.feedEl, A.id);
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.querySelector('.card-link')).toBe(row);
  });
});

// WEB_INTERFACE → "Opening a row and ending one redraw nothing else".
describe('opening a row and ending one replace no other node of the list', () => {
  it('feed: a locked like puts the unlock form under the card pressed, the focus in its field; Esc and a submit take it out; neither card is replaced by the row', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = fullRow('B', { author: OTHER });
    const h = rig({ feed: [A, B] });
    await boot(h);
    const a = cardOf(h.feedEl, A.id);
    const b = cardOf(h.feedEl, B.id);

    likeOf(a).click();
    expect(cardOf(h.feedEl, B.id)).toBe(b);
    expect(cardOf(h.feedEl, A.id)).toBe(a);
    const row = a.querySelector<HTMLElement>('.card-unlock')!;
    expect(row).not.toBeNull();
    expect(a.querySelector('.meta')!.nextElementSibling).toBe(row);
    // The focus is in the field as the press returns — no frame is awaited.
    expect(document.activeElement).toBe(fieldOf(row));
    expect(h.writes.likes).toEqual([]);

    esc(fieldOf(row));
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(cardOf(h.feedEl, B.id)).toBe(b);
    expect(cardOf(h.feedEl, A.id)).toBe(a);
    expect(h.held()).toBe(0);

    likeOf(a).click();
    const again = a.querySelector<HTMLElement>('.card-unlock')!;
    fieldOf(again).value = 'pw';
    submit(again);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(h.writes.likes).toEqual([A.id]);
    expect(document.querySelector('.card-unlock')).toBeNull();
    // The like redraws the card it is on and no other.
    expect(cardOf(h.feedEl, B.id)).toBe(b);
  });

  it('pane: the question goes in under the card pressed and comes out at keep and at Esc; a locked withdraw puts the unlock form in its place, and its submit sends one withdrawal', async () => {
    const P = fullRow('P'); // the reader's own
    const R = fullRow('R', { author: OTHER, parentRefs: [P.id] });
    const h = rig({ feed: [P], threads: [thread(P, [R])] });
    await boot(h);
    await openFromFeed(h, P.id);
    const p = cardOf(h.panes, P.id);
    const r = cardOf(h.panes, R.id);

    withdrawOf(p).click();
    expect(cardOf(h.panes, R.id)).toBe(r);
    expect(cardOf(h.panes, P.id)).toBe(p);
    const q = p.querySelector<HTMLElement>('.card-confirm')!;
    expect(q).not.toBeNull();
    expect(p.querySelector('.meta')!.nextElementSibling).toBe(q);
    expect(q.querySelector('.q')?.textContent).toBe(QUESTION);
    expect([...q.querySelectorAll('button')].map((x) => x.textContent)).toEqual(['withdraw', 'keep']);
    // Withdrawn is never "deleted" (WEB_INTERFACE → The withdrawn state).
    expect(p.textContent!.toLowerCase()).not.toContain('delete');
    for (const x of p.querySelectorAll('button')) {
      expect(((x.getAttribute('aria-label') ?? '') + x.title).toLowerCase()).not.toContain('delete');
    }
    // A second press opens no second question.
    withdrawOf(p).click();
    expect(p.querySelectorAll('.card-confirm')).toHaveLength(1);

    wordIn(q, 'keep').click();
    expect(document.querySelector('.card-confirm')).toBeNull();
    expect(document.activeElement).toBe(withdrawOf(p));
    expect(cardOf(h.panes, R.id)).toBe(r);
    expect(h.held()).toBe(0);

    withdrawOf(p).click();
    esc(wordIn(p.querySelector('.card-confirm')!, 'keep'));
    expect(document.querySelector('.card-confirm')).toBeNull();
    expect(document.activeElement).toBe(withdrawOf(p));
    expect(h.writes.withdrawals).toEqual([]);

    // The identity is locked: the question's withdraw yields its place to the
    // unlock form (WEB_INTERFACE → The withdraw control).
    withdrawOf(p).click();
    wordIn(p.querySelector('.card-confirm')!, 'withdraw').click();
    expect(p.querySelector('.card-confirm')).toBeNull();
    const unlock = p.querySelector<HTMLElement>('.card-unlock')!;
    expect(unlock).not.toBeNull();
    expect(p.querySelector('.meta')!.nextElementSibling).toBe(unlock);
    expect(cardOf(h.panes, R.id)).toBe(r);
    expect(cardOf(h.panes, P.id)).toBe(p);
    expect(h.writes.withdrawals).toEqual([]);
    // One of the two at a time: the card's withdraw opens no question beside it.
    withdrawOf(p).click();
    expect(p.querySelector('.card-confirm')).toBeNull();
    expect(p.querySelectorAll('.card-unlock')).toHaveLength(1);

    fieldOf(unlock).value = 'pw';
    submit(unlock);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(h.writes.withdrawals).toEqual([P.id]);
    expect(document.querySelector('.card-unlock')).toBeNull();
  });
});

describe('the question takes the focus as the press returns', () => {
  it('keep holds the focus with no frame awaited', async () => {
    const P = fullRow('P');
    const h = rig({ feed: [P], threads: [thread(P, [])], locked: false });
    await boot(h);
    await openFromFeed(h, P.id);
    withdrawOf(cardOf(h.panes, P.id)).click();
    expect(document.activeElement).toBe(wordIn(h.panes.querySelector('.card-confirm')!, 'keep'));
  });
});

// WEB_INTERFACE → "A row's controls act on the card as it stands at the press".
describe('a row\'s controls act on the card the row stands under', () => {
  it('one post open in two panes: keep in the second pane returns the focus to the withdraw control of that pane', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const P = fullRow('P', { parentRefs: [Q.id] }); // the reader's own reply
    const h = rig({ feed: [Q], threads: [thread(Q, [P]), thread(P, [], [Q])], locked: false });
    await boot(h);
    await openFromFeed(h, Q.id); // the parent's thread, P at depth 1
    cardOf(regions(h)[0]!, P.id).querySelector<HTMLButtonElement>('button.strip')!.click(); // P's own thread, one column right
    await settle();
    expect(regions(h)).toHaveLength(2);
    expect(withdrawOf(cardOf(regions(h)[0]!, P.id))).not.toBeNull();

    withdrawOf(cardOf(regions(h)[1]!, P.id)).click();
    expect(regions(h)[0]!.querySelector('.card-confirm')).toBeNull();
    const q = regions(h)[1]!.querySelector<HTMLElement>('.card-confirm')!;
    expect(q).not.toBeNull();
    wordIn(q, 'keep').click();
    expect(document.querySelector('.card-confirm')).toBeNull();
    expect(document.activeElement).toBe(withdrawOf(cardOf(regions(h)[1]!, P.id)));
  });
});

/** The profile window, opened from the header. */
async function openProfile(h: Rig): Promise<HTMLElement> {
  document.querySelector<HTMLButtonElement>('[aria-label="open profile"]')!.click();
  await settle();
  return h.panes.querySelector<HTMLElement>('.pp-field')!;
}

describe('a card\'s own like reads the lock at the press', () => {
  it('unlocked from the profile window: like on a feed card and on a pane card each send one like and open no unlock form', async () => {
    const A = fullRow('A', { author: OTHER });
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [A, Q], threads: [thread(Q, [R]), thread(R, [], [Q])] });
    await boot(h);
    await openFromFeed(h, Q.id); // column 0
    cardOf(regions(h)[0]!, R.id).querySelector<HTMLButtonElement>('button.strip')!.click(); // R's thread, column 1
    await settle();

    const pp = await openProfile(h); // stacks over Q's thread in column 0
    const feedCard = cardOf(h.feedEl, A.id);
    const paneCard = cardOf(regions(h)[1]!, R.id);
    wordIn(pp, 'unlock').click();
    fieldOf(pp).value = 'pw';
    submit(pp);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    // Neither card was drawn since the unlock.
    expect(cardOf(h.feedEl, A.id)).toBe(feedCard);
    expect(cardOf(regions(h)[1]!, R.id)).toBe(paneCard);

    likeOf(feedCard).click();
    await settle();
    expect(h.feedEl.querySelector('.card-unlock')).toBeNull();
    expect(h.writes.likes).toEqual([A.id]);

    likeOf(cardOf(regions(h)[1]!, R.id)).click();
    await settle();
    expect(document.querySelector('.card .card-unlock')).toBeNull();
    expect(h.writes.likes).toEqual([A.id, R.id]);
  });

  it('locked from the profile window: like opens the unlock form and sends no like', async () => {
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [A], locked: false });
    await boot(h);
    const pp = await openProfile(h);
    const card = cardOf(h.feedEl, A.id);
    wordIn(pp, 'lock').click();
    await settle();
    expect(h.id.identity.current()?.locked).toBe(true);
    expect(cardOf(h.feedEl, A.id)).toBe(card); // not drawn since the lock

    likeOf(card).click();
    await settle();
    expect(card.querySelector('.card-unlock')).not.toBeNull();
    expect(h.writes.likes).toEqual([]);
    expect(h.id.signed).toEqual([]);
  });

  it('unlocked from the profile window with an unlock form open under a card: the form is gone, its field empty, and no card is replaced', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = fullRow('B', { author: OTHER });
    const h = rig({ feed: [A, B] });
    await boot(h);
    likeOf(cardOf(h.feedEl, A.id)).click();
    const row = h.feedEl.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'half';

    const pp = await openProfile(h);
    const a = cardOf(h.feedEl, A.id);
    const b = cardOf(h.feedEl, B.id);
    expect(a.querySelector('.card-unlock')).toBe(row);
    wordIn(pp, 'unlock').click();
    fieldOf(pp).value = 'pw';
    submit(pp);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(row.isConnected).toBe(false);
    expect(field.value).toBe('');
    expect(h.held()).toBe(0);
    expect(cardOf(h.feedEl, A.id)).toBe(a);
    expect(cardOf(h.feedEl, B.id)).toBe(b);
    expect(h.writes.likes).toEqual([]);
  });
});

// WEB_INTERFACE → What the feed reads, and what a card shows for it →
// "A row the reader opened under a card outlasts a redraw of its list": a row
// stands under a card that offers the control it was opened from.
describe('a row stands under a card that offers the control it was opened from', () => {
  it('a withdrawn card in a pane keeps its copy glyph and so its link row, across a redraw', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const W: WithdrawnJson = { ...tomb('W'), author: OTHER, parentRefs: [Q.id] };
    const h = rig({ feed: [Q], threads: [thread(Q, [W])] });
    refuseClipboard();
    await boot(h);
    await openFromFeed(h, Q.id);
    const pressed = cardOf(h.panes, W.id);
    expect(pressed.querySelector('.withdrawn')).not.toBeNull();
    linkOf(pressed).click();
    await settle();
    const row = cardOf(h.panes, W.id).querySelector<HTMLElement>('.card-link');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.hex')?.textContent).toContain('p/' + W.id);

    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const redrawn = cardOf(h.panes, W.id);
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.querySelector('.withdrawn')).not.toBeNull();
    expect(redrawn.querySelector('.card-link')).toBe(row);
  });

  it('a landed reply of the reader\'s own stands as a submission card in a pane: the clipboard absent, its link row stands under it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const h = rig({ feed: [Q], threads: [thread(Q, [])], locked: false });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, writable: true, configurable: true });
    await boot(h);
    await openFromFeed(h, Q.id);

    // The reader replies under Q through the composer, and the poll lands it.
    cardOf(h.panes, Q.id).querySelector<HTMLButtonElement>('.reply-ctl')!.click();
    await settle();
    const composer = h.panes.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a reply';
    text.dispatchEvent(new Event('input'));
    wordIn(composer, 'post').click();
    await settle();
    expect(h.writes.posts).toEqual(['a reply']);
    const NEW = h.writes.nextPostId;
    h.fake.postById!.set(NEW, asResult(fullRow('new', { id: NEW, content: 'a reply', parentRefs: [Q.id] })));
    await h.drive.pollTick();
    await settle();
    const landed = cardOf(h.panes, NEW);
    expect(landed.classList.contains('pending')).toBe(false);

    linkOf(landed).click();
    const row = cardOf(h.panes, NEW).querySelector<HTMLElement>('.card-link');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.hex')?.textContent).toContain('p/' + NEW);
    // The glyph stays (WEB_INTERFACE → Links).
    expect(linkOf(cardOf(h.panes, NEW)).querySelector('svg')).not.toBeNull();
  });

  it('an unlock form for a like ends when a redraw draws the card with the like on it', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R])] });
    await boot(h);
    await openFromFeed(h, Q.id);
    likeOf(cardOf(h.panes, R.id)).click();
    const row = cardOf(h.panes, R.id).querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'half';

    // The reader's like for R landed from another tab: the pane's ↻ reads it.
    h.fake.threadById!.set(Q.id, thread(Q, [{ ...R, likedByViewer: true, likeCount: 1 }]));
    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    expect(cardOf(h.panes, R.id).querySelector('.liked')).not.toBeNull();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(field.value).toBe('');
    expect(h.held()).toBe(0);
  });

  it('the question ends when the post\'s withdrawal is submitted from another pane, and the withdrawn card it lands as carries none', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const P = fullRow('P', { parentRefs: [Q.id] }); // the reader's own reply
    const h = rig({ feed: [Q], threads: [thread(Q, [P]), thread(P, [], [Q])], locked: false });
    await boot(h);
    await openFromFeed(h, Q.id);
    cardOf(regions(h)[0]!, P.id).querySelector<HTMLButtonElement>('button.strip')!.click();
    await settle();

    withdrawOf(cardOf(regions(h)[0]!, P.id)).click(); // the question in the parent's thread
    expect(regions(h)[0]!.querySelector('.card-confirm')).not.toBeNull();
    withdrawOf(cardOf(regions(h)[1]!, P.id)).click(); // and in P's own
    wordIn(regions(h)[1]!.querySelector('.card-confirm')!, 'withdraw').click();
    await settle();
    expect(h.writes.withdrawals).toEqual([P.id]);
    // Neither card offers `withdraw` while the withdrawal is submitted.
    expect(withdrawOf(cardOf(regions(h)[0]!, P.id))).toBeNull();
    expect(document.querySelector('.card-confirm')).toBeNull();
    expect(h.held()).toBe(0);

    const marker: WithdrawnJson = { ...tomb('P'), parentRefs: [Q.id] };
    h.fake.postById!.set(P.id, { ...marker, confirmedAuthor: ME });
    h.fake.height = 11;
    await h.drive.pollTick();
    await settle();
    expect(cardOf(regions(h)[0]!, P.id).querySelector('.withdrawn')).not.toBeNull();
    expect(cardOf(regions(h)[1]!, P.id).querySelector('.withdrawn')).not.toBeNull();
    expect(document.querySelector('.card-confirm')).toBeNull();
    expect(h.held()).toBe(0);
  });

  it('the unlock form opens beside a link row and ends beside it; the link row stands when the like redraws its card', async () => {
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [A] });
    refuseClipboard();
    await boot(h);
    linkOf(cardOf(h.feedEl, A.id)).click();
    await settle();
    const card = cardOf(h.feedEl, A.id);
    const link = card.querySelector<HTMLElement>('.card-link')!;
    expect(link).not.toBeNull();

    likeOf(card).click();
    const unlock = card.querySelector<HTMLElement>('.card-unlock')!;
    expect(unlock).not.toBeNull();
    expect(card.querySelector('.card-link')).toBe(link);
    // The form under the meta row, the link row beneath it.
    expect([...card.querySelector('.card-body')!.children].slice(-3)).toEqual([card.querySelector('.meta'), unlock, link]);

    esc(fieldOf(unlock));
    expect(card.querySelector('.card-unlock')).toBeNull();
    expect(card.querySelector('.card-link')).toBe(link);
    expect(h.held()).toBe(1);

    likeOf(card).click();
    const again = card.querySelector<HTMLElement>('.card-unlock')!;
    fieldOf(again).value = 'pw';
    submit(again);
    await settle();
    expect(h.writes.likes).toEqual([A.id]);
    const liked = cardOf(h.feedEl, A.id);
    expect(liked).not.toBe(card);
    expect(liked.querySelector('.liked')).not.toBeNull();
    expect(liked.querySelector('.card-link')).toBe(link);
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(h.held()).toBe(1);
  });
});

describe('a change of identity ends every row', () => {
  it('a change of key: no row in the document, and the field of the unlock form that stood reads empty', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = fullRow('B', { author: OTHER });
    const h = rig({ feed: [A, B] });
    refuseClipboard();
    await boot(h);
    linkOf(cardOf(h.feedEl, B.id)).click();
    await settle();
    const link = h.feedEl.querySelector<HTMLElement>('.card-link')!;
    expect(link).not.toBeNull();
    likeOf(cardOf(h.feedEl, A.id)).click();
    const row = h.feedEl.querySelector<HTMLElement>('.card-unlock')!;
    expect(row).not.toBeNull();
    const field = fieldOf(row);
    field.value = 'secret';

    h.fake.feedQueue.push(page([A, B])); // the feed, read again for the new key
    h.id.changeKey(NEXT_KEY);
    expect(row.isConnected).toBe(false);
    expect(link.isConnected).toBe(false);
    expect(field.value).toBe('');
    expect(h.held()).toBe(0);
    await settle();
    expect(cardOf(h.feedEl, A.id)).not.toBeNull();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(document.querySelector('.card-link')).toBeNull();
  });
});

describe('an unlock made where the App is not told ends the unlock rows', () => {
  it('the lock flips with no notice: the next redraw of the list draws no unlock form and holds none, and like then sends', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = light('B');
    const h = rig({ feed: [A, B], resolver: true });
    await boot(h);
    likeOf(cardOf(h.feedEl, A.id)).click();
    const row = h.feedEl.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'half';

    h.id.setLocked(false); // unlocked in another page of the extension
    h.resolves[0]!.end({ [B.id]: 'unserved' }); // the slot leaves: the feed is drawn whole
    await settle();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(row.isConnected).toBe(false);
    expect(field.value).toBe('');
    expect(h.held()).toBe(0);

    likeOf(cardOf(h.feedEl, A.id)).click();
    await settle();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(h.writes.likes).toEqual([A.id]);
  });

  it('the lock flips with no notice and the reader presses like under the form: the like goes out and the form ends', async () => {
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [A] });
    await boot(h);
    likeOf(cardOf(h.feedEl, A.id)).click();
    const row = h.feedEl.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'half';

    h.id.setLocked(false);
    likeOf(cardOf(h.feedEl, A.id)).click();
    await settle();
    expect(h.writes.likes).toEqual([A.id]);
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(field.value).toBe('');
    expect(h.held()).toBe(0);
  });

  it('an unlock in the composer\'s foot ends the unlock form under a card at once', async () => {
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [A] });
    await boot(h);
    likeOf(cardOf(h.feedEl, A.id)).click();
    const row = h.feedEl.querySelector<HTMLElement>('.card .card-unlock')!;
    const field = fieldOf(row);
    field.value = 'half';

    wordIn(h.feedEl.querySelector('.feed-head')!, 'new post').click();
    await settle();
    const composer = h.feedEl.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a root';
    text.dispatchEvent(new Event('input'));
    wordIn(composer, 'post').click(); // locked: the unlock form takes the composer's foot
    await settle();
    const foot = composer.querySelector<HTMLElement>('.composer-foot')!;
    fieldOf(foot).value = 'pw';
    submit(foot);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(h.writes.posts).toEqual(['a root']);
    expect(h.feedEl.querySelector('.card .card-unlock')).toBeNull();
    expect(row.isConnected).toBe(false);
    expect(field.value).toBe('');
    expect(h.held()).toBe(0);
  });
});

describe('a feed card replaced alone moves no focus', () => {
  it('a slot filling in place leaves the focus on the control of the open composer that holds it', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = light('B');
    const h = rig({ feed: [A, B], resolver: true, locked: false });
    await boot(h);
    wordIn(h.feedEl.querySelector('.feed-head')!, 'new post').click();
    await settle();
    const type = h.feedEl.querySelector<HTMLSelectElement>('.composer select.composer-type')!;
    type.focus();
    expect(document.activeElement).toBe(type);

    const untouched = cardOf(h.feedEl, A.id);
    h.resolves[0]!.bound([fullRow('B', { author: OTHER })]);
    await settle();
    expect(cardOf(h.feedEl, B.id).classList.contains('slot')).toBe(false);
    expect(cardOf(h.feedEl, A.id)).toBe(untouched); // the slot became its card in place
    expect(document.activeElement).toBe(type);
  });
});

describe('an @posts window card\'s unlock row outlasts a slot filling and a slot leaving', () => {
  it('two slots in the window beside the unlock row: a fill and a leaving each redraw the window, the row is the same node under A\'s card both times', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = light('B'), C = light('C');
    const h = rig({
      feed: [],
      resolver: true,
      feedPages: [{ posts: [A, B, C], next: null, pending: [], pendingCount: 0 }],
    });
    await boot(h);
    h.drive.openAuthorPosts(OTHER, { from: 'feed' });
    await settle();
    const pressed = cardOf(h.panes, A.id);
    likeOf(pressed).click();
    const row = pressed.querySelector<HTMLElement>('.card-unlock')!;
    expect(row).not.toBeNull();
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();
    expect(document.activeElement).toBe(field);

    const call = h.resolves.find((c) => c.ids.includes(B.id) && c.ids.includes(C.id))!;
    call.bound([fullRow('B', { author: OTHER })]);
    await settle();
    const afterFill = cardOf(h.panes, A.id);
    expect(afterFill).not.toBe(pressed);
    expect(afterFill.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);

    call.end({ [C.id]: 'unserved' });
    await settle();
    const afterLeave = cardOf(h.panes, A.id);
    expect(afterLeave).not.toBe(afterFill);
    expect(afterLeave.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('a pane\'s unlock row outlasts a descendant slot filling and another leaving', () => {
  it('two descendant slots beside the unlock row under a reply\'s card: a fill and a leaving each redraw the thread, the row stands under R both times', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const X = light('X', { parentRefs: [Q.id] }), Y = light('Y', { parentRefs: [Q.id] });
    const h = rig({
      feed: [Q],
      threads: [thread(Q, [R, X, Y])],
      resolver: true,
    });
    await boot(h);
    await openFromFeed(h, Q.id);
    const pressed = cardOf(h.panes, R.id);
    likeOf(pressed).click();
    const row = pressed.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    const call = h.resolves.find((c) => c.ids.includes(X.id) && c.ids.includes(Y.id))!;
    call.bound([fullRow('X', { author: OTHER, parentRefs: [Q.id] })]);
    await settle();
    const afterFill = cardOf(h.panes, R.id);
    expect(afterFill).not.toBe(pressed);
    expect(afterFill.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);

    call.end({ [Y.id]: 'unserved' });
    await settle();
    const afterLeave = cardOf(h.panes, R.id);
    expect(afterLeave).not.toBe(afterFill);
    expect(afterLeave.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('a feed card\'s unlock row stands when a slot in pending fills', () => {
  it('a slot in feed.pending filling redraws the feed whole; the row under A is the same node, with its text and focus kept', async () => {
    const A = fullRow('A', { author: OTHER });
    const B = light('B');
    const h = rig({ feed: [], resolver: true });
    h.fake.feedQueue[0] = { posts: [A], next: null, pending: [B], pendingCount: 1 };
    h.fake.postById!.set(A.id, asResult(A));
    await boot(h);
    const pressed = cardOf(h.feedEl, A.id);
    likeOf(pressed).click();
    const row = pressed.querySelector<HTMLElement>('.card-unlock')!;
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    const call = h.resolves.find((c) => c.ids.includes(B.id))!;
    call.bound([fullRow('B', { author: OTHER })]);
    await settle();
    const redrawn = cardOf(h.feedEl, A.id);
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});

describe('the question stands under its card across a pane redraw', () => {
  it('a ↻ of the pane redraws P\'s card; the question is the same node, and its withdraw sends one withdrawal for P', async () => {
    const P = fullRow('P');
    const h = rig({ feed: [P], threads: [thread(P, [])], locked: false });
    await boot(h);
    await openFromFeed(h, P.id);
    const pressed = cardOf(h.panes, P.id);
    withdrawOf(pressed).click();
    const q = pressed.querySelector<HTMLElement>('.card-confirm')!;
    expect(q).not.toBeNull();

    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const redrawn = cardOf(h.panes, P.id);
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.querySelector('.card-confirm')).toBe(q);

    wordIn(q, 'withdraw').click();
    await settle();
    expect(h.writes.withdrawals).toEqual([P.id]);
  });

  it('a ↻ of the pane redraws P\'s card; keep ends the question and the focus returns to the withdraw control of the card on screen', async () => {
    const P = fullRow('P');
    const h = rig({ feed: [P], threads: [thread(P, [])], locked: false });
    await boot(h);
    await openFromFeed(h, P.id);
    const pressed = cardOf(h.panes, P.id);
    withdrawOf(pressed).click();
    const q = pressed.querySelector<HTMLElement>('.card-confirm')!;

    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const redrawn = cardOf(h.panes, P.id);
    expect(redrawn.querySelector('.card-confirm')).toBe(q);

    wordIn(q, 'keep').click();
    expect(document.querySelector('.card-confirm')).toBeNull();
    const ctl = withdrawOf(cardOf(h.panes, P.id));
    expect(document.activeElement).toBe(ctl);
    expect(ctl.isConnected).toBe(true);
    expect(h.writes.withdrawals).toEqual([]);
  });
});

describe('the lock changes under the question across a pane redraw', () => {
  it('question opened unlocked, lock flips with no notice, a ↻ redraws; the question\'s withdraw puts the unlock form under the card on screen, submit sends the withdrawal', async () => {
    const P = fullRow('P');
    const h = rig({ feed: [P], threads: [thread(P, [])], locked: false });
    await boot(h);
    await openFromFeed(h, P.id);
    const pressed = cardOf(h.panes, P.id);
    withdrawOf(pressed).click();
    const q = pressed.querySelector<HTMLElement>('.card-confirm')!;

    h.id.setLocked(true);
    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const redrawn = cardOf(h.panes, P.id);
    expect(redrawn.querySelector('.card-confirm')).toBe(q);

    wordIn(q, 'withdraw').click();
    expect(document.querySelector('.card-confirm')).toBeNull();
    const unlock = cardOf(h.panes, P.id).querySelector<HTMLElement>('.card-unlock')!;
    expect(unlock).not.toBeNull();
    expect(h.writes.withdrawals).toEqual([]);

    fieldOf(unlock).value = 'pw';
    submit(unlock);
    await settle();
    expect(h.id.unlocks).toEqual(['pw']);
    expect(h.writes.withdrawals).toEqual([P.id]);
  });

  it('question opened locked, unlock flips with no notice, a ↻ redraws; the question\'s withdraw sends one withdrawal and opens no unlock form', async () => {
    const P = fullRow('P');
    const h = rig({ feed: [P], threads: [thread(P, [])] });
    await boot(h);
    await openFromFeed(h, P.id);
    const pressed = cardOf(h.panes, P.id);
    withdrawOf(pressed).click();
    const q = pressed.querySelector<HTMLElement>('.card-confirm')!;

    h.id.setLocked(false);
    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const redrawn = cardOf(h.panes, P.id);
    expect(redrawn.querySelector('.card-confirm')).toBe(q);

    wordIn(q, 'withdraw').click();
    await settle();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(h.id.unlocks).toEqual([]);
    expect(h.writes.withdrawals).toEqual([P.id]);
  });
});

describe('a pollTick landing of a reader\'s own reply leaves rows under other cards standing', () => {
  it('a link row under A in the feed and one under Q in the pane: the reply to Q lands through pollTick; both rows are the same node, A\'s card untouched', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const A = fullRow('A', { author: OTHER });
    const h = rig({ feed: [Q, A], threads: [thread(Q, [])], locked: false });
    refuseClipboard();
    await boot(h);
    await openFromFeed(h, Q.id);
    const feedA = cardOf(h.feedEl, A.id);
    linkOf(feedA).click();
    await settle();
    const feedRow = feedA.querySelector<HTMLElement>('.card-link')!;
    expect(feedRow).not.toBeNull();

    const paneQ = cardOf(h.panes, Q.id);
    linkOf(paneQ).click();
    await settle();
    const paneRow = paneQ.querySelector<HTMLElement>('.card-link')!;
    expect(paneRow).not.toBeNull();

    cardOf(h.panes, Q.id).querySelector<HTMLButtonElement>('.reply-ctl')!.click();
    await settle();
    const composer = h.panes.querySelector<HTMLElement>('.composer')!;
    const text = composer.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    text.value = 'a reply';
    text.dispatchEvent(new Event('input'));
    wordIn(composer, 'post').click();
    await settle();
    expect(h.writes.posts).toEqual(['a reply']);
    const NEW = h.writes.nextPostId;
    h.fake.postById!.set(NEW, asResult(fullRow('new', { id: NEW, content: 'a reply', parentRefs: [Q.id] })));
    await h.drive.pollTick();
    await settle();

    expect(cardOf(h.feedEl, A.id)).toBe(feedA);
    expect(feedA.querySelector('.card-link')).toBe(feedRow);
    const paneQAfter = cardOf(h.panes, Q.id);
    expect(paneQAfter.querySelector('.card-link')).toBe(paneRow);
  });
});

describe('a reply that leaves its list on a pane\'s ↻ ends the row under it', () => {
  it('the ↻\'s answer no longer lists R: no row in the document and held() is 0', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R])] });
    refuseClipboard();
    await boot(h);
    await openFromFeed(h, Q.id);
    linkOf(cardOf(h.panes, R.id)).click();
    await settle();
    expect(cardOf(h.panes, R.id).querySelector('.card-link')).not.toBeNull();
    expect(h.held()).toBe(1);

    h.fake.threadById!.set(Q.id, thread(Q, []));
    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    expect(h.panes.querySelector(`.card[data-post-id="${R.id}"]`)).toBeNull();
    expect(document.querySelector('.card-link')).toBeNull();
    expect(h.held()).toBe(0);
  });

  it('a later ↻ lists R again: R\'s card is drawn, carrying no row', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R])] });
    refuseClipboard();
    await boot(h);
    await openFromFeed(h, Q.id);
    linkOf(cardOf(h.panes, R.id)).click();
    await settle();

    h.fake.threadById!.set(Q.id, thread(Q, []));
    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    expect(h.held()).toBe(0);

    h.fake.threadById!.set(Q.id, thread(Q, [R]));
    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const card = cardOf(h.panes, R.id);
    expect(card.querySelector('.card-link')).toBeNull();
    expect(h.held()).toBe(0);
  });
});

describe('a list leaves and returns to the screen', () => {
  it('a second window in the pane\'s column brought to the front: held() is 0, the row\'s field reads empty; the thread brought back draws its card with no row', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R])] });
    refuseClipboard();
    await boot(h);
    await openFromFeed(h, Q.id);
    linkOf(cardOf(h.panes, R.id)).click();
    await settle();
    const row = cardOf(h.panes, R.id).querySelector<HTMLElement>('.card-link')!;
    expect(row).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[aria-label="open profile"]')!.click();
    await settle();
    expect(h.held()).toBe(0);
    expect(h.panes.querySelector(`.card[data-post-id="${R.id}"]`)).toBeNull();
    expect(row.isConnected).toBe(false);

    (h.app as unknown as { handlers: { focus(id: string): void } }).handlers.focus(Q.id);
    await settle();
    const card = cardOf(h.panes, R.id);
    expect(card.querySelector('.card-link')).toBeNull();
    expect(h.held()).toBe(0);
  });

  it('a window closed with a row under one of its cards: held() is 0', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({ feed: [Q], threads: [thread(Q, [R])] });
    refuseClipboard();
    await boot(h);
    await openFromFeed(h, Q.id);
    linkOf(cardOf(h.panes, R.id)).click();
    await settle();
    expect(h.held()).toBe(1);

    (h.app as unknown as { handlers: { close(id: string): void } }).handlers.close(Q.id);
    await settle();
    expect(h.held()).toBe(0);
    expect(h.panes.querySelector(`.card[data-post-id="${R.id}"]`)).toBeNull();
  });
});

describe('on the standalone page a card\'s unlock row outlasts a redraw of the thread', () => {
  it('the ↻ reloads the thread; the row is the same node under R, its text and focus kept', async () => {
    const Q = fullRow('Q', { author: OTHER });
    const R = fullRow('R', { author: OTHER, parentRefs: [Q.id] });
    const h = rig({
      feed: [],
      threads: [thread(Q, [R])],
      mode: { kind: 'standalone', id: Q.id, base: '/' },
    });
    await (h.drive as unknown as { fetchThread(id: string): Promise<void> }).fetchThread(Q.id);
    await settle();
    const pressed = cardOf(h.panes, R.id);
    likeOf(pressed).click();
    const row = pressed.querySelector<HTMLElement>('.card-unlock')!;
    expect(row).not.toBeNull();
    const field = fieldOf(row);
    field.value = 'secret';
    field.focus();

    h.panes.querySelector<HTMLButtonElement>('[aria-label="refresh replies to this thread"]')!.click();
    await settle();
    const redrawn = cardOf(h.panes, R.id);
    expect(redrawn).not.toBe(pressed);
    expect(redrawn.querySelector('.card-unlock')).toBe(row);
    expect(fieldOf(row).value).toBe('secret');
    expect(document.activeElement).toBe(field);
  });
});
