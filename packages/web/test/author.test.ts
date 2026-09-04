// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { authorBody, authorPostsBody, type AuthorCtx, type AuthorHandlers, type PostsCtx, type PostsHandlers } from '../src/view/author';
import type { Mark } from '../src/view/card';
import type { PostJson, KarmaResult } from '../src/api/dto';
import type { FeedState } from '../src/model/state';
import type { Origin } from '../src/model/workspace';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// The author window and the author-posts window render against narrow ctx/handler
// shapes (WEB_INTERFACE → The author window). These drive the pure views over
// fakes: the rows by node identity, the your-vouch states, an endorser prefix
// opening that window, the posts cards, and the placement origin.

const AUTHOR = 'ab'.repeat(32);
const ME = 'cd'.repeat(32);
const E1 = '11'.repeat(32);
const ORIGIN: Origin = { from: 'pane', ci: 0 };

function memberKarma(over: Partial<KarmaResult> = {}): KarmaResult {
  return karmaResult({ userId: AUTHOR, member: true, invitesAvailable: 2, memberSinceBlock: 4000, ...over });
}
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
    karma: memberKarma(),
    endorsers: { vouches: [{ voucherId: E1, targetId: AUTHOR }], count: 1, next: null },
    endorsersNext: false,
    membershipBars: { memberBar: 3, memberLikesBar: 6 },
    writeEnabled: true,
    ownKey: ME,
    locked: false,
    subjectMark: { state: 'plus', count: 3 },
    markFor: () => ({ state: 'plus', count: 0 }) as Mark,
    yourVouch: { kind: 'plus', cooldownBlocks: 60 },
    flight: null,
    ...over,
  };
}

describe('the author window', () => {
  it('with no identity is the read surface: key, standing, endorsers, no marks, no your-vouch row', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ writeEnabled: false, ownKey: null, subjectMark: null, markFor: () => null, yourVouch: null }));
    const labels = [...b.querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(labels).toEqual(['key', 'standing', 'endorsers', 'posts']); // no your-vouch row
    expect(b.querySelector('.vmark')).toBeNull(); // no marks
    // The whole key is shown, mono.
    expect(b.querySelector('.row .mono')?.textContent).toBe(AUTHOR);
  });

  it('the subject mark renders in the key row, and its ✓ opens no window until pressed', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ subjectMark: { state: 'check', count: 2 } }));
    const keyField = b.querySelector('.row .field')!;
    expect(keyField.querySelector('.vmark.check')).not.toBeNull();
  });

  it('the your-vouch row: + vouch with the stakes sentence and the cooldown from /status', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ yourVouch: { kind: 'plus', cooldownBlocks: 60 } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(yv.querySelector('.vmark.plus')).not.toBeNull();
    expect(yv.textContent).toContain('stakes 1 karma');
    expect(yv.textContent).toContain('60');
    (yv.querySelector('.vmark.plus') as HTMLElement).click();
    expect(h.calls.vouch).toEqual([AUTHOR]);
  });

  it('the your-vouch row: ✓ vouched since block N · unvouch, a visible held hint, and unvouch fires', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ yourVouch: { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(yv.textContent).toContain('vouched');
    expect(yv.textContent).toContain('5000');
    // The voice rule: what happens stated in visible text, not only an aria-label.
    expect(yv.textContent).toContain('held for');
    expect(yv.textContent).toContain('60');
    const unvouch = [...yv.querySelectorAll('button')].find((x) => x.textContent === 'unvouch')!;
    unvouch.click();
    expect(h.calls.unvouch).toEqual([AUTHOR]);
  });

  it('a flight ending shows in the your-vouch row whatever its ending — plus and vouched alike', () => {
    const h = noHandlers();
    // A rejected vouch from this window shows its reason in the row's stage line.
    const plus = authorBody(h, baseCtx({ yourVouch: { kind: 'plus', cooldownBlocks: 60 }, flight: { stage: 'rejected', reason: 'vouch rejected: already vouched' } }));
    const plusRow = [...plus.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(plusRow.querySelector('.stage')?.textContent).toContain('already vouched');
    // An unvouch's stage line shows on the vouched state too.
    const vouched = authorBody(h, baseCtx({ yourVouch: { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 }, flight: { stage: 'submitting' } }));
    const vRow = [...vouched.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(vRow.querySelector('.stage')?.textContent).toContain('submitting');
  });

  it('the your-vouch row: a one-line reason the reader cannot vouch', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ yourVouch: { kind: 'reason', text: 'vouching comes with membership' } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    expect(yv.textContent).toContain('vouching comes with membership');
    expect(yv.querySelector('button')).toBeNull(); // no action
  });

  it('an endorser row: the prefix opens THAT author\'s window, and their mark is present', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx());
    const endorser = b.querySelector('.endorser')!;
    const btn = endorser.querySelector('.authorbtn') as HTMLElement;
    btn.click();
    expect(h.calls.openAuthor).toEqual([[E1, ORIGIN]]);
    expect(endorser.querySelector('.vmark')).not.toBeNull(); // the reader can vouch an endorser
  });

  it('`more` follows next and posts opens the posts window with the placement origin', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ endorsersNext: true }));
    const more = [...b.querySelectorAll('button')].find((x) => x.textContent === 'more')!;
    more.click();
    expect(h.calls.moreEndorsers).toEqual([AUTHOR]);
    const posts = [...b.querySelectorAll('button')].find((x) => x.textContent === 'posts')!;
    posts.click();
    expect(h.calls.openAuthorPosts).toEqual([[AUTHOR, ORIGIN]]);
  });

  it('no endorsers reads "no vouches yet"', () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ endorsers: { vouches: [], count: 0, next: null } }));
    const endorsersField = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'endorsers')!;
    expect(endorsersField.textContent).toContain('no vouches yet');
  });

  it('a locked vouch mounts the unlock under the your-vouch row, then vouches', async () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ locked: true }));
    (b.querySelector('.field .vmark.plus') as HTMLElement).click();
    const form = b.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(h.calls.vouch).toHaveLength(0);
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.unlock).toEqual(['pw']);
    expect(h.calls.vouch).toEqual([AUTHOR]);
  });

  it('a locked unvouch mounts the unlock under the your-vouch row, then unvouches', async () => {
    const h = noHandlers();
    const b = authorBody(h, baseCtx({ locked: true, yourVouch: { kind: 'vouched', sinceBlock: 5000, cooldownBlocks: 60 } }));
    const yv = [...b.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch')!;
    [...yv.querySelectorAll('button')].find((x) => x.textContent === 'unvouch')!.click();
    const form = b.querySelector('.card-unlock form.pf') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(h.calls.unvouch).toHaveLength(0); // the unvouch waits on the unlock
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.unlock).toEqual(['pw']);
    expect(h.calls.unvouch).toEqual([AUTHOR]);
  });
});

// ---------------------------------------------------------------------------

const P1 = 'a'.repeat(64);
const P2 = 'b'.repeat(64);
function post(id: string, author: string): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 5, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
  };
}
function feedState(over: Partial<FeedState> = {}): FeedState {
  return { posts: [post(P1, AUTHOR), post(P2, ME)], pending: [], next: null, report: null, olderReport: null, loaded: true, loading: false, error: null, ...over };
}
const postsHandlers = (): PostsHandlers & { calls: Record<string, unknown[]> } => {
  const calls: Record<string, unknown[]> = { openThread: [], openAuthor: [], vouch: [], more: [] };
  return {
    calls,
    openThread: (id, o) => calls.openThread!.push([id, o]),
    openAuthor: (k, o) => calls.openAuthor!.push([k, o]),
    vouch: (k) => calls.vouch!.push(k),
    authorPostsMore: (k) => calls.more!.push(k),
    unlockIdentity: async () => {},
  };
};
function postsCtx(over: Partial<PostsCtx> = {}): PostsCtx {
  return {
    authorKey: AUTHOR, origin: ORIGIN, feed: feedState(), writeEnabled: true, ownKey: ME, locked: false,
    markFor: (k) => (k === ME ? null : ({ state: 'plus', count: 0 } as Mark)), ...over,
  };
}

describe('the author-posts window', () => {
  it('renders feed cards: the strip, the mark, · you on own — no like and no reply', () => {
    const h = postsHandlers();
    const b = authorPostsBody(h, postsCtx());
    const cards = b.querySelectorAll('.card');
    expect(cards.length).toBe(2);
    // The strip opens a thread; no like control and no reply control live here.
    expect(b.querySelector('.strip')).not.toBeNull();
    expect(b.querySelector('.likebtn')).toBeNull();
    expect(b.querySelector('.reply-ctl')).toBeNull();
    // A card by another author carries the mark; the reader's own reads · you.
    expect(cards[0]!.querySelector('.vmark')).not.toBeNull();
    expect(cards[1]!.querySelector('.you')?.textContent).toBe('· you');
    expect(cards[1]!.querySelector('.vmark')).toBeNull();
  });

  it('the strip opens a thread with the window\'s placement origin', () => {
    const h = postsHandlers();
    const b = authorPostsBody(h, postsCtx());
    (b.querySelector('.strip') as HTMLElement).click();
    expect(h.calls.openThread).toEqual([[P1, ORIGIN]]);
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
