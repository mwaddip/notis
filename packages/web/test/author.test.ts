// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { authorBody, authorPostsBody, type AuthorCtx, type AuthorHandlers, type PostsCtx, type PostsHandlers } from '../src/view/author';
import type { PostJson } from '../src/api/dto';
import type { FeedState, WindowBody } from '../src/model/state';
import type { Origin } from '../src/model/workspace';
import { contentHashHex } from '../src/integrity';

// The author window and the author-posts window render against narrow ctx/handler
// shapes (WEB_INTERFACE → The author window). These drive the pure views over
// fakes: the rows by node identity, the your-vouch states, an endorser prefix
// opening that window, the posts cards, and the placement origin.

const AUTHOR = 'ab'.repeat(32);
const ME = 'cd'.repeat(32);
const E1 = '11'.repeat(32);
const ORIGIN: Origin = { from: 'pane', ci: 0 };

const noHandlers = (): AuthorHandlers & { calls: Record<string, unknown[]> } => {
  const calls: Record<string, unknown[]> = { openAuthor: [], openAuthorPosts: [], vouch: [], unvouch: [], moreEndorsers: [], unlock: [] };
  return {
    calls,
    openAuthor: (k, o) => calls.openAuthor!.push([k, o]),
    openAuthorPosts: (k, o) => calls.openAuthorPosts!.push([k, o]),
    vouch: (k) => calls.vouch!.push(k),
    unvouch: (k) => calls.unvouch!.push(k),
    moreEndorsers: (k) => calls.moreEndorsers!.push(k),
    unlockIdentity: async (p) => { calls.unlock!.push(p); },
  };
};

function baseCtx(over: Partial<AuthorCtx> = {}): AuthorCtx {
  return {
    authorKey: AUTHOR,
    origin: ORIGIN,
    endorsers: { vouches: [{ voucherId: E1, targetId: AUTHOR, voucherName: null, targetName: null }], count: 1, next: null },
    endorsersNext: false,
    writeEnabled: true,
    ownKey: ME,
    locked: false,
    yourVouch: { kind: 'plus', cooldownBlocks: 60 },
    flight: null,
    username: null,
    usernameLoaded: true,
    nameClay: () => false, // no check has decided a pair — every handle in ink
    ...over,
  };
}

const render = (h: AuthorHandlers, c: AuthorCtx): HTMLElement => authorBody(h, () => c).el;

/** A body over a state the case moves: `set` replaces what the body reads at
 *  its next draw and at the next press of one of its controls. */
function live(h: AuthorHandlers, c: AuthorCtx): { body: WindowBody; set(next: AuthorCtx): void } {
  let now = c;
  return { body: authorBody(h, () => now), set: (next) => { now = next; } };
}

describe('the author window', () => {
  it('with no identity is the read surface: key, name, endorsers, posts, no your-vouch row', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ writeEnabled: false, ownKey: null, yourVouch: null }));
    const labels = [...b.querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(labels).toEqual(['key', 'name', 'endorsers', 'posts']);
    expect(b.querySelector('.vmark')).toBeNull();
    expect(b.querySelector('.row .mono')?.textContent).toBe(AUTHOR);
  });

  it('the key row shows the whole key in mono, no mark', () => {
    const h = noHandlers();
    const b = render(h, baseCtx());
    const keyField = b.querySelector('.row .field')!;
    expect(keyField.querySelector('.mono')?.textContent).toBe(AUTHOR);
    expect(keyField.querySelector('.vmark')).toBeNull();
  });

  it('the your-vouch row: the word vouch with the stakes sentence and the cooldown from /status', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ yourVouch: { kind: 'plus', cooldownBlocks: 60 } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    const vouchBtn = [...yv.querySelectorAll('button')].find((x) => x.textContent === 'vouch')!;
    expect(vouchBtn).not.toBeNull();
    expect(vouchBtn.classList.contains('word')).toBe(true);
    expect(yv.textContent).toContain('stakes 1 rep');
    expect(yv.textContent).toContain('60');
    vouchBtn.click();
    expect(h.calls.vouch).toEqual([AUTHOR]);
  });

  it('the your-vouch row: vouched since block N · unvouch, a visible held hint, and unvouch fires', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ yourVouch: { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(yv.textContent).toContain('vouched');
    expect(yv.textContent).toContain('5000');
    expect(yv.textContent).toContain('held for');
    expect(yv.textContent).toContain('60');
    const unvouch = [...yv.querySelectorAll('button')].find((x) => x.textContent === 'unvouch')!;
    unvouch.click();
    expect(h.calls.unvouch).toEqual([AUTHOR]);
  });

  it('a pending vouch carries the flight stage line in the word\'s place — no vouch word', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ yourVouch: { kind: 'pending' }, flight: { stage: 'submitting' } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(yv.querySelector('.stage')?.textContent).toContain('submitting');
    expect([...yv.querySelectorAll('button')].find((x) => x.textContent === 'vouch')).toBeUndefined();
  });

  it('a flight ending shows in the your-vouch row whatever its ending — plus and vouched alike', () => {
    const h = noHandlers();
    const plus = render(h, baseCtx({ yourVouch: { kind: 'plus', cooldownBlocks: 60 }, flight: { stage: 'rejected', reason: 'vouch rejected: already vouched' } }));
    const plusRow = [...plus.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(plusRow.querySelector('.stage')?.textContent).toContain('already vouched');
    const vouched = render(h, baseCtx({ yourVouch: { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 }, flight: { stage: 'submitting' } }));
    const vRow = [...vouched.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(vRow.querySelector('.stage')?.textContent).toContain('submitting');
  });

  it('the your-vouch row: a one-line reason the reader cannot vouch', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ yourVouch: { kind: 'reason', text: 'vouching comes with membership' } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(yv.textContent).toContain('vouching comes with membership');
    expect(yv.querySelector('button')).toBeNull();
  });

  it('an endorser row: the prefix opens THAT author\'s window', () => {
    const h = noHandlers();
    const b = render(h, baseCtx());
    const endorser = b.querySelector('.endorser')!;
    const btn = endorser.querySelector('.authorbtn') as HTMLElement;
    expect(btn.classList.contains('hex')).toBe(true);
    btn.click();
    expect(h.calls.openAuthor).toEqual([[E1, ORIGIN]]);
    expect(endorser.querySelector('.vmark')).toBeNull();
  });

  it('an endorser row: the handle @Name when the row carries a name, the same control', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({
      endorsers: { vouches: [{ voucherId: E1, targetId: AUTHOR, voucherName: 'Alice', targetName: null }], count: 1, next: null },
    }));
    const endorser = b.querySelector('.endorser')!;
    const btn = endorser.querySelector('.authorbtn') as HTMLElement;
    expect(btn.textContent).toBe('@Alice');
    expect(btn.classList.contains('handle')).toBe(true);
    expect(btn.classList.contains('hex')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('open this author');
    btn.click();
    expect(h.calls.openAuthor).toEqual([[E1, ORIGIN]]);
  });

  it('`more` follows next and posts opens the posts window with the placement origin', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ endorsersNext: true }));
    const more = [...b.querySelectorAll('button')].find((x) => x.textContent === 'more')!;
    more.click();
    expect(h.calls.moreEndorsers).toEqual([AUTHOR]);
    const posts = [...b.querySelectorAll('button')].find((x) => x.textContent === 'posts')!;
    posts.click();
    expect(h.calls.openAuthorPosts).toEqual([[AUTHOR, ORIGIN]]);
  });

  it('no endorsers reads "no vouches yet"', () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ endorsers: { vouches: [], count: 0, next: null } }));
    const endorsersField = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'endorsers')!;
    expect(endorsersField.textContent).toContain('no vouches yet');
  });

  it('the name row: loading… before the read, @Name when held, no name when not', () => {
    const h = noHandlers();
    const loading = render(h, baseCtx({ usernameLoaded: false }));
    const nameRow = (b: HTMLElement): Element => [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'name')!;
    expect(nameRow(loading).textContent).toContain('loading…');

    const held = render(h, baseCtx({ username: { name: 'Alice', owner: AUTHOR, boxId: 'x', claimedAtBlock: 100 } }));
    expect(nameRow(held).querySelector('.handle')?.textContent).toBe('@Alice');

    const none = render(h, baseCtx({ username: null }));
    expect(nameRow(none).textContent).toContain('no name');
  });

  it('the rows are key · name · endorsers · your vouch · posts, and no standing row on either window', () => {
    const h = noHandlers();
    const withIdentity = [...render(h, baseCtx()).querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(withIdentity).toEqual(['key', 'name', 'endorsers', 'your vouch', 'posts']);
    const withoutIdentity = [...render(h, baseCtx({ writeEnabled: false, ownKey: null, yourVouch: null })).querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(withoutIdentity).toEqual(['key', 'name', 'endorsers', 'posts']);
  });

  it('a locked vouch mounts the unlock under the your-vouch row, then vouches', async () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ locked: true }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    const vouchBtn = [...yv.querySelectorAll('button')].find((x) => x.textContent === 'vouch')!;
    vouchBtn.click();
    const form = b.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(h.calls.vouch).toHaveLength(0);
    const pw = form.querySelector('input[type="password"]') as HTMLInputElement;
    pw.value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.unlock).toEqual(['pw']);
    expect(h.calls.vouch).toEqual([AUTHOR]);
    // The row has ended with its submit: out of the body, its field emptied.
    expect(b.querySelector('.card-unlock')).toBeNull();
    expect(pw.value).toBe('');
  });

  it('a locked unvouch mounts the unlock under the your-vouch row, then unvouches', async () => {
    const h = noHandlers();
    const b = render(h, baseCtx({ locked: true, yourVouch: { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    [...yv.querySelectorAll('button')].find((x) => x.textContent === 'unvouch')!.click();
    const form = b.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(h.calls.unvouch).toHaveLength(0);
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.unlock).toEqual(['pw']);
    expect(h.calls.unvouch).toEqual([AUTHOR]);
  });
});

// ---------------------------------------------------------------------------
// WEB_INTERFACE → The workspace → "A draw updates a standing body in place",
// → "A window's controls act on the state as it stands at the press",
// → "What ends a form in a window" — the author window's rows.
// ---------------------------------------------------------------------------

describe('the author window — the body across a draw', () => {
  const rowOf = (b: HTMLElement, label: string): HTMLElement =>
    [...b.querySelectorAll<HTMLElement>('.row')].find((r) => r.querySelector('label')?.textContent === label)!;
  const word = (root: HTMLElement, text: string): HTMLButtonElement =>
    [...root.querySelectorAll('button')].find((x) => x.textContent === text) as HTMLButtonElement;
  const vouched = { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 } as const;

  it('the body and its rows are the same nodes at every draw; the name, the endorsers and the relation follow the state', () => {
    const w = live(noHandlers(), baseCtx({ usernameLoaded: false, endorsers: null }));
    const b = w.body.el;
    const rows = [...b.querySelectorAll('.row')];
    expect(rowOf(b, 'name').textContent).toContain('loading…');
    w.set(baseCtx({
      username: { name: 'Alice', owner: AUTHOR, boxId: 'x', claimedAtBlock: 100 },
      yourVouch: vouched,
    }));
    w.body.update();
    expect(w.body.el).toBe(b);
    expect([...b.querySelectorAll('.row')]).toEqual(rows);
    expect(rowOf(b, 'name').querySelector('.handle')?.textContent).toBe('@Alice');
    expect(rowOf(b, 'endorsers').textContent).toContain('1 vouch');
    expect(rowOf(b, 'your vouch').textContent).toContain('vouched since block 5000');
  });

  it('the your-vouch row comes and goes with the reader\'s relation, between endorsers and posts', () => {
    const w = live(noHandlers(), baseCtx({ writeEnabled: false, ownKey: null, yourVouch: null }));
    const labels = (): Array<string | null> => [...w.body.el.querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(labels()).toEqual(['key', 'name', 'endorsers', 'posts']);
    w.set(baseCtx());
    w.body.update();
    expect(labels()).toEqual(['key', 'name', 'endorsers', 'your vouch', 'posts']);
    w.set(baseCtx({ writeEnabled: false, ownKey: null, yourVouch: null }));
    w.body.update();
    expect(labels()).toEqual(['key', 'name', 'endorsers', 'posts']);
  });

  it('the unlock row under your vouch stands across a draw while the identity reads locked, what is typed kept', () => {
    const w = live(noHandlers(), baseCtx({ locked: true }));
    const b = w.body.el;
    word(rowOf(b, 'your vouch'), 'vouch').click();
    const urow = b.querySelector('.card-unlock') as HTMLElement;
    const pw = urow.querySelector('input[type="password"]') as HTMLInputElement;
    pw.value = 'half';
    // A second press under the lock opens no second row.
    word(rowOf(b, 'your vouch'), 'vouch').click();
    expect(b.querySelectorAll('.card-unlock')).toHaveLength(1);

    w.set(baseCtx({ locked: true, endorsersNext: true }));
    w.body.update();
    expect(b.querySelector('.card-unlock')).toBe(urow);
    expect(rowOf(b, 'your vouch').nextElementSibling).toBe(urow);
    expect(pw.value).toBe('half');
  });

  it('a draw that reads the identity unlocked ends the unlock row, its field emptied', () => {
    const h = noHandlers();
    const w = live(h, baseCtx({ locked: true }));
    const b = w.body.el;
    word(rowOf(b, 'your vouch'), 'vouch').click();
    const pw = b.querySelector('.card-unlock input[type="password"]') as HTMLInputElement;
    pw.value = 'half';
    w.set(baseCtx()); // unlocked from another form
    w.body.update();
    expect(b.querySelector('.card-unlock')).toBeNull();
    expect(pw.value).toBe('');
    expect(h.calls.vouch).toEqual([]);
  });

  it('a draw that reads the row no longer offering the word the unlock was opened from ends the unlock row', () => {
    const w = live(noHandlers(), baseCtx({ locked: true }));
    const b = w.body.el;
    word(rowOf(b, 'your vouch'), 'vouch').click();
    const pw = b.querySelector('.card-unlock input[type="password"]') as HTMLInputElement;
    pw.value = 'half';
    w.set(baseCtx({ locked: true, yourVouch: vouched })); // the vouch landed from another tab
    w.body.update();
    expect(b.querySelector('.card-unlock')).toBeNull();
    expect(pw.value).toBe('');
    expect(word(rowOf(b, 'your vouch'), 'unvouch')).not.toBeUndefined();
  });

  it('vouch reads the lock when pressed: drawn unlocked and locked since, the press asks for the unlock; drawn locked and unlocked since, it vouches', () => {
    const h = noHandlers();
    const w = live(h, baseCtx());
    w.set(baseCtx({ locked: true })); // no draw between the lock and the press
    word(rowOf(w.body.el, 'your vouch'), 'vouch').click();
    expect(w.body.el.querySelector('.card-unlock')).not.toBeNull();
    expect(h.calls.vouch).toEqual([]);

    const h2 = noHandlers();
    const w2 = live(h2, baseCtx({ locked: true }));
    w2.set(baseCtx());
    word(rowOf(w2.body.el, 'your vouch'), 'vouch').click();
    expect(w2.body.el.querySelector('.card-unlock')).toBeNull();
    expect(h2.calls.vouch).toEqual([AUTHOR]);
  });

  it('an endorser\'s name and posts open beside the column the window stands in when pressed', () => {
    const h = noHandlers();
    const w = live(h, baseCtx());
    const endorser = w.body.el.querySelector('.endorser .authorbtn') as HTMLElement;
    const moved: Origin = { from: 'pane', ci: 2 };
    w.set(baseCtx({ origin: moved })); // the window moved, and no draw followed
    endorser.click();
    word(rowOf(w.body.el, 'posts'), 'posts').click();
    expect(h.calls.openAuthor).toEqual([[E1, moved]]);
    expect(h.calls.openAuthorPosts).toEqual([[AUTHOR, moved]]);
  });

  it('cancel ends the unlock row, its field emptied', () => {
    const w = live(noHandlers(), baseCtx({ locked: true }));
    const b = w.body.el;
    word(rowOf(b, 'your vouch'), 'vouch').click();
    const urow = b.querySelector('.card-unlock') as HTMLElement;
    const pw = urow.querySelector('input[type="password"]') as HTMLInputElement;
    pw.value = 'half';
    word(urow, 'cancel').click();
    expect(b.querySelector('.card-unlock')).toBeNull();
    expect(pw.value).toBe('');
  });

  it('Esc in the unlock row\'s field ends the row, its field emptied; the word vouch stands, nothing is unlocked or vouched, and nothing above the form reads the press', () => {
    const h = noHandlers();
    const w = live(h, baseCtx({ locked: true }));
    const b = w.body.el;
    word(rowOf(b, 'your vouch'), 'vouch').click();
    const urow = b.querySelector('.card-unlock') as HTMLElement;
    const pw = urow.querySelector('input[type="password"]') as HTMLInputElement;
    pw.value = 'half';
    let reached = 0;
    b.addEventListener('keydown', (e) => { if (e.key === 'Escape') reached += 1; });
    pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(reached).toBe(0);
    expect(b.querySelector('.card-unlock')).toBeNull();
    expect(pw.value).toBe('');
    expect(word(rowOf(b, 'your vouch'), 'vouch')).not.toBeUndefined();
    expect(h.calls.unlock).toEqual([]);
    expect(h.calls.vouch).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const P1 = 'a'.repeat(64);
const P2 = 'b'.repeat(64);
function post(id: string, author: string): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
  };
}
function feedState(over: Partial<FeedState> = {}): FeedState {
  return { posts: [post(P1, AUTHOR), post(P2, ME)], pending: [], next: null, report: null, olderReport: null, reportCount: null, olderReportCount: null, loaded: true, loading: false, error: null, unboundCount: 0, ...over };
}
const postsHandlers = (): PostsHandlers & { calls: Record<string, unknown[]> } => {
  const calls: Record<string, unknown[]> = { openThread: [], openAuthor: [], more: [], like: [], linkRefused: [] };
  return {
    calls,
    openThread: (id, o) => calls.openThread!.push([id, o]),
    openAuthor: (k, o) => calls.openAuthor!.push([k, o]),
    pressLike: (list, id, control) => calls.like!.push([list, id, control]),
    linkRefused: (list, id, url, control) => calls.linkRefused!.push([list, id, url, control]),
    authorPostsMore: (k) => calls.more!.push(k),
    expandImage: () => {},
    collapseImage: () => {},
  };
};
function postsCtx(over: Partial<PostsCtx> = {}): PostsCtx {
  return {
    authorKey: AUTHOR, origin: ORIGIN, feed: feedState(), writeEnabled: true, ownKey: ME,
    likePending: () => false, linkUrl: (id) => `http://localhost/p/${id}`,
    nameClay: () => false, // no check has decided a pair — every handle in ink
    expandedImages: new Set(),
    listKey: '@posts:' + AUTHOR,
    rowsUnder: () => [],
    ...over,
  };
}

describe('the author-posts window', () => {
  it('like and link on another author\'s card, the read-only count on own, no reply', () => {
    const h = postsHandlers();
    const b = authorPostsBody(h, postsCtx());
    const cards = b.querySelectorAll('.card');
    expect(cards.length).toBe(2);
    expect(b.querySelector('.strip')).not.toBeNull();
    expect([...cards[0]!.querySelectorAll('button')].some((b) => b.textContent === 'like')).toBe(true);
    expect(cards[0]!.querySelector('.linkbtn')).not.toBeNull();
    expect([...cards[1]!.querySelectorAll('button')].some((b) => b.textContent === 'like')).toBe(false);
    expect(cards[1]!.querySelector('.linkbtn')).not.toBeNull();
    expect(b.querySelector('.reply-ctl')).toBeNull();
    expect(cards[0]!.querySelector('.vmark')).toBeNull();
    expect(cards[1]!.querySelector('.you')?.textContent).toBe('· you');
  });

  it('the strip opens a thread with the window\'s placement origin', () => {
    const h = postsHandlers();
    const b = authorPostsBody(h, postsCtx());
    (b.querySelector('.strip') as HTMLElement).click();
    expect(h.calls.openThread).toEqual([[P1, ORIGIN]]);
  });

  // WEB_INTERFACE → What the feed reads, and what a card shows for it →
  // "A row's controls act on the card as it stands at the press" — the window
  // reads no lock: the press is handed on with the window as its list, the
  // post and the control pressed. What the press opens is the App's
  // (app-card-rows.test.ts).
  it('like hands the press on with the window\'s list, the post and the control pressed', () => {
    const h = postsHandlers();
    const b = authorPostsBody(h, postsCtx());
    const otherCard = b.querySelectorAll('.card')[0]!;
    const likeBtn = [...otherCard.querySelectorAll('button')].find((x) => x.textContent === 'like')!;
    likeBtn.click();
    expect(h.calls.like).toEqual([['@posts:' + AUTHOR, P1, likeBtn]]);
    expect(otherCard.querySelector('.card-unlock')).toBeNull();
  });

  it('`more posts` follows next; an empty page reads "no posts yet"', () => {
    const withMore = postsHandlers();
    const b = authorPostsBody(withMore, postsCtx({ feed: feedState({ next: 'cursor' }) }));
    const more = [...b.querySelectorAll('button')].find((x) => x.textContent === 'more posts')!;
    more.click();
    expect(withMore.calls.more).toEqual([AUTHOR]);

    const empty = authorPostsBody(postsHandlers(), postsCtx({ feed: feedState({ posts: [] }) }));
    expect(empty.querySelector('.empty')?.textContent).toBe('no posts yet');
  });
});

describe('a handle the chain does not back is clay (WEB_INTERFACE → The identity display, → The author window)', () => {
  const nameRow = (b: HTMLElement): HTMLElement =>
    [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'name')!.querySelector<HTMLElement>('.field')!;
  const clayFor = (key: string, name: string) => (k: string, n: string): boolean => k === key && n === name;

  it('the name row pairs the window\'s subject with its name — clay, and one clay line beneath the handle', () => {
    // The node's answer names another owner; the pair is the subject's key, the
    // key the handle stands beside.
    const b = render(noHandlers(), baseCtx({
      username: { name: 'Alice', owner: ME, boxId: 'x', claimedAtBlock: 100 },
      nameClay: clayFor(AUTHOR, 'Alice'),
    }));
    const field = nameRow(b);
    const handle = field.querySelector('.handle') as HTMLElement;
    expect([...handle.classList]).toEqual(['handle', 'clay']);
    expect(handle.textContent).toBe('@Alice');
    const line = handle.nextElementSibling as HTMLElement;
    expect(line.tagName).toBe('DIV');
    expect([...line.classList]).toEqual(['hint', 'clay']);
    expect(line.textContent).toBe("this node's answer for this name did not verify");
    expect(field.children).toHaveLength(2);
  });

  it('an ink pair: the name row as today — the handle alone, no line', () => {
    const b = render(noHandlers(), baseCtx({
      username: { name: 'Alice', owner: AUTHOR, boxId: 'x', claimedAtBlock: 100 },
      nameClay: clayFor(AUTHOR, 'alice'),
    }));
    const field = nameRow(b);
    expect([...(field.querySelector('.handle') as HTMLElement).classList]).toEqual(['handle']);
    expect(field.querySelector('.hint')).toBeNull();
    expect(field.children).toHaveLength(1);
  });

  it('no name, or not read yet — no handle, no line, the predicate never asked', () => {
    const asked: Array<[string, string]> = [];
    const nameClay = (k: string, n: string): boolean => { asked.push([k, n]); return true; };
    expect(nameRow(render(noHandlers(), baseCtx({ username: null, nameClay }))).querySelector('.clay')).toBeNull();
    expect(nameRow(render(noHandlers(), baseCtx({ usernameLoaded: false, nameClay }))).querySelector('.clay')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('an endorser row pairs the voucher\'s key with its name — clay on the same control; ink as today', () => {
    const endorsers = { vouches: [{ voucherId: E1, targetId: AUTHOR, voucherName: 'Vic', targetName: 'Alice' }], count: 1, next: null };
    const h = noHandlers();
    const clay = render(h, baseCtx({ endorsers, nameClay: clayFor(E1, 'Vic') })).querySelector('.endorser .authorbtn') as HTMLElement;
    expect([...clay.classList]).toEqual(['handle', 'authorbtn', 'clay']);
    expect(clay.textContent).toBe('@Vic');
    clay.click();
    expect(h.calls.openAuthor).toEqual([[E1, ORIGIN]]);
    const ink = render(noHandlers(), baseCtx({ endorsers, nameClay: clayFor(AUTHOR, 'Vic') })).querySelector('.endorser .authorbtn') as HTMLElement;
    expect([...ink.classList]).toEqual(['handle', 'authorbtn']);
  });

  it('the posts window\'s cards read the predicate — the clay pair\'s card alone', () => {
    const posts = [{ ...post(P1, AUTHOR), authorName: 'Alice' }, { ...post(P2, ME), authorName: 'Me' }];
    const b = authorPostsBody(postsHandlers(), postsCtx({ feed: feedState({ posts }), nameClay: clayFor(AUTHOR, 'Alice') }));
    const clay = b.querySelector(`.card[data-post-id="${P1}"] .who .handle`) as HTMLElement;
    expect([...clay.classList]).toEqual(['handle', 'authorbtn', 'clay']);
    const ink = b.querySelector(`.card[data-post-id="${P2}"] .who .handle`) as HTMLElement;
    expect([...ink.classList]).toEqual(['handle', 'authorbtn']);
  });
});
