// @vitest-environment happy-dom
// The App over the extension's light reads and resolver (WEB_INTERFACE → The
// extension → "The light read", → "The resolve"): the feed and the author
// window's list reads carry `light=1` while a resolver is held, `intake`
// composes rows from the cache, and `resolveSlots` asks the resolver for
// what the cache lacks. With no resolver no list read carries `light=1`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import { PageError } from '../src/api/errors';
import type { Api } from '../src/api/client';
import type { AppState, PostCache, HeldPost } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type {
  PostJson, LightJson, WithdrawnJson, FeedResult, FeedRow, PostResult,
} from '../src/api/dto';
import {
  ME, flush, settle, hid, status, fullRow, light, tomb,
  makeApi, testResolver, makeCache, makeIdentity, harness, seedCache, stubResolver, stubVerifier,
  type Fake,
} from './app-light-shared';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The App's constructor refuses a verifier without a resolver, or a
// resolver without a verifier (WEB_INTERFACE → The extension → "The post
// check", → "The resolve"): the extension build holds both; every other
// build holds neither.
// ---------------------------------------------------------------------------
describe('the App refuses half a seam', () => {
  it('a verifier without a resolver throws', () => {
    expect(() => new App(
      undefined, undefined, undefined, undefined, undefined, undefined,
      null, null, null, stubVerifier(), null, null,
    )).toThrow(/handed together/);
  });

  it('a resolver without a verifier throws', () => {
    expect(() => new App(
      undefined, undefined, undefined, undefined, undefined, undefined,
      null, null, null, null, null, stubResolver(),
    )).toThrow(/handed together/);
  });
});

// ---------------------------------------------------------------------------
// Every list read carries `light=1` under a resolver and none without it,
// over the six list-read paths (feed load, refresh, load older, author
// posts load, refresh, more) — WEB_INTERFACE → The extension → "The light
// read".
// ---------------------------------------------------------------------------
describe('the six list reads carry light under a resolver and none without it', () => {
  it('the web build: no light on all six reads', async () => {
    const h = harness({
      resolver: null, verifier: null, cache: null,
      feedResults: [
        { posts: [fullRow('a')], next: 'cursor0', pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: 'cur-a', pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed(); await flush();
    await h.drive.refreshFeed(); await flush();
    await h.drive.loadOlder(); await flush();
    const K = hid('author');
    h.drive.openAuthorPosts(K, { from: 'feed' });
    await flush();
    await h.drive.refreshAuthorPosts(K); await flush();
    await h.drive.authorPostsMore(K); await flush();
    for (const call of h.fake.feedCalls) {
      expect(call.url).not.toContain('light=1');
    }
    expect(h.fake.feedCalls.length).toBeGreaterThanOrEqual(6);
  });

  it('the extension build: light on all six reads', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [fullRow('a')], next: 'cursor0', pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: 'cur-a', pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed(); await flush();
    await h.drive.refreshFeed(); await flush();
    await h.drive.loadOlder(); await flush();
    const K = hid('author2');
    h.drive.openAuthorPosts(K, { from: 'feed' });
    await flush();
    await h.drive.refreshAuthorPosts(K); await flush();
    await h.drive.authorPostsMore(K); await flush();
    for (const call of h.fake.feedCalls) {
      expect(call.url).toContain('light=1');
    }
    expect(h.fake.feedCalls.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// The cache holds the page whole — intake composes every row from the cache,
// no resolve call, every card shows the listing's counts and name.
// ---------------------------------------------------------------------------
describe('intake composes a page whose rows the cache holds', () => {
  it('one request, light=1 and no tx; no resolve call; cards show the listing counts', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const a = fullRow('a'), b = fullRow('b');
    await seedCache(cache, [a, b]);
    // Each light row carries the listing's figures — likeCount 7, descendantCount 2.
    const la = light('a', { likeCount: 7, descendantCount: 2, authorName: null });
    const lb = light('b', { likeCount: 1, descendantCount: 0, authorName: 'bob' });
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    expect(h.fake.feedCalls.length).toBe(1);
    expect(h.fake.feedCalls[0]!.url).toContain('light=1');
    expect(h.fake.feedCalls[0]!.url).not.toContain('tx=1');
    expect(r.calls.length).toBe(0);
    // Both rows entered state as full posts, carrying the listing's figures.
    const posts = h.drive.state.feed.posts;
    expect(posts.length).toBe(2);
    expect(posts[0]!.id).toBe(a.id);
    expect(posts[1]!.id).toBe(b.id);
    expect((posts[0] as PostJson).likeCount).toBe(7);
    expect((posts[0] as PostJson).descendantCount).toBe(2);
    expect((posts[0] as PostJson).content).toBe('text:a');
    expect((posts[1] as PostJson).authorName).toBe('bob');
  });
});

// ---------------------------------------------------------------------------
// A cold page: slots first, then cards after onBound; each bound post lands
// in the cache.
// ---------------------------------------------------------------------------
describe('a cold page draws slots, then fills them from the resolver', () => {
  it('slot cards in the listing order; onBound fills; cache holds the bound rows after', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    // The two slot cards render in the feed, in listing order.
    const cards = h.feedEl.querySelectorAll<HTMLElement>('.card');
    const slots = h.feedEl.querySelectorAll<HTMLElement>('.card.slot');
    expect(slots.length).toBe(2);
    expect(cards[0]!.dataset['postId']).toBe(la.id);
    expect(cards[1]!.dataset['postId']).toBe(lb.id);
    // The resolver was asked for both ids in one call.
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id, lb.id]);
    const fa = fullRow('a'), fb = fullRow('b');
    r.calls[0]!.bound([fa, fb]);
    r.calls[0]!.end({});
    await settle();
    // After onBound, the feed holds the composed rows and the cards are no
    // longer slots.
    const posts = h.drive.state.feed.posts;
    expect(posts.length).toBe(2);
    expect((posts[0] as PostJson).content).toBe('text:a');
    const slotsAfter = h.feedEl.querySelectorAll<HTMLElement>('.card.slot');
    expect(slotsAfter.length).toBe(0);
    // The cache holds the bound rows.
    expect(await cache.thread(fa.id)).not.toBeNull();
    expect(await cache.thread(fb.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A landing of one post among several slots replaces that slot's node and no
// other — nothing else of the feed is rebuilt.
// ---------------------------------------------------------------------------
describe('a landing replaces the slot\'s node and no other', () => {
  it('two slots and a cached card: the filled one changes node, the rest stay the same node', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const cached = fullRow('x');
    await seedCache(cache, [cached]);
    const lx = light('x'), la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [lx, la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    // The cached row is composed into a card already; the two others are slots.
    const nodeX = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${lx.id}"]`)!;
    const nodeA = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${la.id}"]`)!;
    const nodeB = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${lb.id}"]`)!;
    expect(nodeX.classList.contains('slot')).toBe(false);
    expect(nodeA.classList.contains('slot')).toBe(true);
    expect(nodeB.classList.contains('slot')).toBe(true);
    // Resolve `a` alone — `b` stays a slot.
    const fa = fullRow('a');
    r.calls[0]!.bound([fa]);
    await settle();
    // The filled slot's node is a card now; the other two nodes are the same
    // nodes they were before the landing.
    const nodeXAfter = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${lx.id}"]`);
    const nodeAAfter = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${la.id}"]`);
    const nodeBAfter = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${lb.id}"]`);
    expect(nodeXAfter).toBe(nodeX);
    expect(nodeBAfter).toBe(nodeB);
    expect(nodeAAfter).not.toBe(nodeA);
    expect(nodeAAfter!.classList.contains('slot')).toBe(false);
    r.calls[0]!.end({});
  });
});

// ---------------------------------------------------------------------------
// A landing of thirty redraws the feed's cards once each — no full feed
// rebuild, which would replace every node including non-slot ones (the head,
// the foot, a cached card).
// ---------------------------------------------------------------------------
describe('a landing of thirty redraws the cards once each', () => {
  it('thirty slots filled in one onBound: non-slot nodes stay the same reference', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const lights: LightJson[] = [];
    const rows: PostJson[] = [];
    for (let i = 0; i < 30; i++) {
      const label = String.fromCharCode(97 + (i % 26)) + i;
      lights.push(light(label));
      rows.push(fullRow(label));
    }
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: lights, next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    // Save the feed head reference — a non-slot node that a renderFeed call
    // would rebuild.
    const headBefore = h.feedEl.querySelector('.feed-head');
    expect(headBefore).not.toBeNull();
    r.calls[0]!.bound(rows);
    r.calls[0]!.end({});
    await settle();
    const headAfter = h.feedEl.querySelector('.feed-head');
    // The feed was never redrawn whole — the head is the same node.
    expect(headAfter).toBe(headBefore);
    // Every slot became a card.
    expect(h.feedEl.querySelectorAll('.card.slot').length).toBe(0);
    expect(h.feedEl.querySelectorAll<HTMLElement>('[data-post-id]').length).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// The post index holds the composed row — the one drawn — not the resolver's
// batch row, which carries the batch's figures and `likedByViewer: null`.
// ---------------------------------------------------------------------------
describe('the post index holds the composed row', () => {
  it('after a landing, state.posts.get carries the listing\'s likeCount and likedByViewer', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    // The listing's row carries 7 likes and the viewer likes it.
    const la = light('a', { likeCount: 7, likedByViewer: true });
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    // The batch's row — the resolver's answer — carries different figures.
    const fa = fullRow('a', { likeCount: 0, likedByViewer: null });
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    const indexed = h.drive.state.posts.get(la.id);
    expect(indexed).toBeDefined();
    expect((indexed as PostJson).likeCount).toBe(7);
    expect((indexed as PostJson).likedByViewer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A page half held: the resolver is asked for the half the cache lacked.
// ---------------------------------------------------------------------------
describe('a page half held asks for only the other half', () => {
  it('intake fills the held id; resolveSlots asks the resolver for the other', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const a = fullRow('a');
    await seedCache(cache, [a]);
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([lb.id]);
  });
});

// ---------------------------------------------------------------------------
// Refresh is handed the composed rows, so the cache entry carries the
// listing's figures after.
// ---------------------------------------------------------------------------
describe('intake refreshes the cache with the composed rows', () => {
  it('the entry\'s row carries the new figures after one page', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const a = fullRow('a', { likeCount: 0, descendantCount: 0 });
    await seedCache(cache, [a]);
    const la = light('a', { likeCount: 9, descendantCount: 5 });
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    const held: Map<string, HeldPost> = await cache.getMany([a.id]);
    const row = held.get(a.id)?.row as PostJson | undefined;
    expect(row).toBeDefined();
    expect(row!.likeCount).toBe(9);
    expect(row!.descendantCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// A second ↻ while a resolve is in flight asks for no id twice.
// ---------------------------------------------------------------------------
describe('a second ↻ while a resolve is in flight asks for no id twice', () => {
  it('a slot standing in resolving stays claimed on the next read', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        // The ↻ reconnects at the slot — nothing new above it.
        { posts: [la], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    // Press ↻ — the slot stays, the resolve is still in flight.
    await h.drive.refreshFeed();
    await settle();
    expect(r.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// An answer that lands between a read's intake and its write: the author
// window's page's cache read is held open; onBound fires between the intake
// and the write; the window's X is a card, resolve was called once in all.
// ---------------------------------------------------------------------------
describe('an answer that lands between a read\'s cache read and its write', () => {
  it('fills the list that stood here; the author window\'s X is a card and never a slot; one resolve call in all', async () => {
    const r = testResolver();
    const { cache: realCache } = makeCache();
    await realCache.open('C');
    const K = hid('author3');
    const lx = light('x');
    // Hold the first getMany after arming — the author window's intake
    // suspends there, and X lands into the feed and the cache in the
    // meantime (WEB_INTERFACE → Reading the feed and threads → "No answer
    // overwrites a newer one").
    let holdNext = false;
    let heldRelease: (() => void) | null = null;
    const cache: PostCache = {
      open: realCache.open.bind(realCache),
      put: realCache.put.bind(realCache),
      withdraw: realCache.withdraw.bind(realCache),
      thread: realCache.thread.bind(realCache),
      refresh: realCache.refresh.bind(realCache),
      getMany: async (ids) => {
        const answer = await realCache.getMany(ids);
        if (!holdNext) return answer;
        holdNext = false;
        await new Promise<void>((resolve) => { heldRelease = resolve; });
        heldRelease = null;
        return answer;
      },
    };
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        // The feed's first page — lists X as a slot.
        { posts: [lx], next: null, pending: [], pendingCount: 0 },
        // The author window's first page — lists X as a slot.
        { posts: [lx], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    // Arm the hold — the next getMany suspends. The author window opens;
    // its loadAuthorPosts' intake calls getMany and is held.
    holdNext = true;
    h.drive.openAuthorPosts(K, { from: 'feed' });
    while (heldRelease === null) await flush();
    const release = heldRelease as () => void;
    // Land X — the feed's slot becomes a card and the cache holds X.
    const fx = fullRow('x');
    r.calls[0]!.bound([fx]);
    r.calls[0]!.end({});
    await settle();
    // The feed's X is a card now.
    const feedX = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${lx.id}"]`);
    expect(feedX?.classList.contains('slot')).toBe(false);
    // Release the held getMany — the author window's intake continues with
    // its stale (empty) answer, writes state, then resolveSlots re-reads the
    // cache and finds X.
    release();
    await settle();
    // The author window's X is a card (never a slot).
    const apd = (h.app as unknown as {
      authorPostsData: Map<string, { posts: FeedRow[] }>;
    }).authorPostsData;
    const posts = apd.get(K)?.posts ?? [];
    expect(posts.length).toBe(1);
    expect('kind' in posts[0]! && posts[0].kind === 'light').toBe(false);
    // One resolve call in all — the second cache read found X.
    expect(r.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unserved and unbound ends: the slot leaves, counts, and a later first page
// asks again.
// ---------------------------------------------------------------------------
describe('ends drop slots and count unbound ones', () => {
  it('one unserved: slot leaves; no line', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    r.calls[0]!.end({ [la.id]: 'unserved' });
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(0);
    expect(h.feedEl.querySelector('.withheld')).toBeNull();
  });

  it('one unbound: slot leaves; the feed\'s head reads the clay line', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    r.calls[0]!.end({ [la.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(0);
    const line = h.feedEl.querySelector('.withheld');
    expect(line?.textContent).toBe('1 post withheld — it does not match its signature');
  });

  it('two unbound reads: the clay line counts them', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    r.calls[0]!.end({ [la.id]: 'unbound', [lb.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(0);
    const line = h.feedEl.querySelector('.withheld');
    expect(line?.textContent).toBe('2 posts withheld — they do not match their signatures');
  });

  it('a ↻ starts the count again and a later end adds to it; a first page listing it again asks again', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        // The ↻'s reconnect: no held id reconnects (la was removed), so the
        // list is replaced with the two new rows.
        { posts: [la, lb], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    r.calls[0]!.end({ [la.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.unboundCount).toBe(1);
    await h.drive.refreshFeed();
    await settle();
    // The refresh reset the count to 0 (intake's answer under a resolver).
    // The list now holds la and lb slots.
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([la.id, lb.id]);
    // The refresh asked the resolver again for la and lb — nothing in resolving.
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids.sort()).toEqual([la.id, lb.id].sort());
    r.calls[1]!.end({ [la.id]: 'unbound', [lb.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.unboundCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// An id that ends while two lists hold its slot — the feed and an author
// window — leaves both, and an unbound one is counted at the head of each.
// ---------------------------------------------------------------------------
describe('an id ending while two lists hold its slot leaves both', () => {
  it('feed and author window: both drop the slot and both heads read the clay line', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const K = hid('author4');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        // The author window's first page lists the same id.
        { posts: [la], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    h.drive.openAuthorPosts(K, { from: 'feed' });
    await settle();
    // Both reads claim la — the first adds it to resolving, the second finds
    // it already there and does not claim. So one resolve call.
    expect(r.calls.length).toBe(1);
    r.calls[0]!.end({ [la.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(0);
    expect(h.feedEl.querySelector('.withheld')?.textContent)
      .toBe('1 post withheld — it does not match its signature');
    expect(h.panes.querySelector('.withheld')?.textContent)
      .toBe('1 post withheld — it does not match its signature');
  });
});

// ---------------------------------------------------------------------------
// A placeholder bound at the end — content: null — the resolve answers it as
// a bound post with null content; the client leaves it where it stood and
// the next first page asks for it again (it is still a `LightJson`).
// ---------------------------------------------------------------------------
describe('a placeholder bound at the end is a card reading content not on this node yet', () => {
  it('the entry carries no text; the next first page asks for the id again', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        // A later first page — through loadFeed, not reconcileNewer — lists
        // la again; intake re-reads the cache, finds the entry's text is
        // null, and leaves la a slot.
        { posts: [la], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    const fa = fullRow('a', { content: null });
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    // The slot became a card and the card reads *content not on this node yet*.
    const card = h.feedEl.querySelector<HTMLElement>(`[data-post-id="${la.id}"]`);
    expect(card).not.toBeNull();
    expect(card!.classList.contains('slot')).toBe(false);
    expect(card!.querySelector('.card-absent')?.textContent).toBe('content not on this node yet');
    // The cache entry holds no text — the row the cache gave is still a
    // placeholder, so a loadFeed that lists the id again asks the resolver
    // for the text (WEB_INTERFACE → The extension → "An entry without text
    // is not held").
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([la.id]);
  });
});

// ---------------------------------------------------------------------------
// load older and authorPostsMore append slots and fill them; a load older
// whose cursor moved while intake ran writes nothing.
// ---------------------------------------------------------------------------
describe('load older appends slots and resolves them', () => {
  it('a loadOlder adds slots and asks the resolver for the new ids', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: 'cur1', pending: [], pendingCount: 0 },
        { posts: [lb], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    await h.drive.loadOlder();
    await settle();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([la.id, lb.id]);
    // The resolver was asked twice — once for la, once for lb.
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([lb.id]);
  });

  it('a loadOlder whose cursor moved while its cache read was held writes nothing and clears feed.loading', async () => {
    const r = testResolver();
    const { cache: realCache } = makeCache();
    await realCache.open('C');
    const la = light('a'), lb = light('b'), lc = light('c');
    // Hold the first getMany after arming — the loadOlder's intake suspends
    // there (WEB_INTERFACE → Reading the feed and threads → "No answer
    // overwrites a newer one").
    let holdNext = false;
    let heldRelease: (() => void) | null = null;
    const cache: PostCache = {
      open: realCache.open.bind(realCache),
      put: realCache.put.bind(realCache),
      withdraw: realCache.withdraw.bind(realCache),
      thread: realCache.thread.bind(realCache),
      refresh: realCache.refresh.bind(realCache),
      getMany: async (ids) => {
        const answer = await realCache.getMany(ids);
        if (!holdNext) return answer;
        holdNext = false;
        await new Promise<void>((resolve) => { heldRelease = resolve; });
        heldRelease = null;
        return answer;
      },
    };
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: 'cur1', pending: [], pendingCount: 0 },
        // The loadOlder's page — intake is held mid-flight.
        { posts: [lb], next: null, pending: [], pendingCount: 0 },
        // A fresh loadFeed replaces the list and resets the cursor to 'cur2'.
        { posts: [lc], next: 'cur2', pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    holdNext = true;
    const olderDone = h.drive.loadOlder();
    // Settle until the hold is reached.
    while (heldRelease === null) await flush();
    const release = heldRelease as () => void;
    // A loadFeed meanwhile — resets feed.next to 'cur2'.
    await h.drive.loadFeed();
    await settle();
    expect(h.drive.state.feed.next).toBe('cur2');
    // Release the held getMany — loadOlder continues, finds the cursor
    // moved, writes nothing but clears feed.loading.
    release();
    await olderDone;
    await settle();
    // The row from loadOlder's page is not appended; the feed holds the
    // loadFeed's.
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([lc.id]);
    expect(h.drive.state.feed.next).toBe('cur2');
    expect(h.drive.state.feed.loading).toBe(false);
    expect(h.drive.state.feed.olderReport).toBeNull();
  });

  it('a loadOlder under a moved generation writes nothing', async () => {
    const r = testResolver();
    const { cache: realCache } = makeCache();
    await realCache.open('C');
    const la = light('a'), lb = light('b');
    // Hold the first getMany after arming — the loadOlder's intake suspends
    // there while onIdentityChange moves the generation.
    let holdNext = false;
    let heldRelease: (() => void) | null = null;
    const cache: PostCache = {
      open: realCache.open.bind(realCache),
      put: realCache.put.bind(realCache),
      withdraw: realCache.withdraw.bind(realCache),
      thread: realCache.thread.bind(realCache),
      refresh: realCache.refresh.bind(realCache),
      getMany: async (ids) => {
        const answer = await realCache.getMany(ids);
        if (!holdNext) return answer;
        holdNext = false;
        await new Promise<void>((resolve) => { heldRelease = resolve; });
        heldRelease = null;
        return answer;
      },
    };
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: 'cur1', pending: [], pendingCount: 0 },
        // loadOlder's page — the gen moves before it writes.
        { posts: [lb], next: null, pending: [], pendingCount: 0 },
        // The identity change's re-read of the feed.
        { posts: [], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    holdNext = true;
    const olderDone = h.drive.loadOlder();
    while (heldRelease === null) await flush();
    // The identity change moves the gen while loadOlder is in flight.
    const release = heldRelease as () => void;
    h.drive.onIdentityChange();
    release();
    await olderDone;
    await settle();
    // loadOlder's write never landed; the feed holds the identity change's
    // re-read, which is empty.
    expect(h.drive.state.feed.posts.length).toBe(0);
    expect(h.drive.state.feed.olderReport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// authorPostsMore appends slots and fills them.
// ---------------------------------------------------------------------------
describe('authorPostsMore appends slots and resolves them', () => {
  it('a `more` adds slots and asks the resolver for the new ids', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const K = hid('author5');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        // The author window's first page.
        { posts: [la], next: 'cur-a', pending: [], pendingCount: 0 },
        // The `more` page.
        { posts: [lb], next: null, pending: [], pendingCount: 0 },
      ],
    });
    h.drive.openAuthorPosts(K, { from: 'feed' });
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id]);
    await h.drive.authorPostsMore(K);
    await settle();
    const apd = (h.app as unknown as {
      authorPostsData: Map<string, { posts: FeedRow[] }>;
    }).authorPostsData;
    expect(apd.get(K)?.posts.map((p) => p.id)).toEqual([la.id, lb.id]);
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([lb.id]);
  });
});

// ---------------------------------------------------------------------------
// A withdrawn row in a light page empties the held entry's text and draws
// no live row in the list.
// ---------------------------------------------------------------------------
describe('a withdrawn row in a light page empties the held entry', () => {
  it('cache.withdraw is called; the row is filtered out of the live list', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const a = fullRow('a');
    await seedCache(cache, [a]);
    const w = tomb('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [w], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    // The feed holds no live row for a withdrawn one.
    expect(h.drive.state.feed.posts.length).toBe(0);
    // The cache entry's text is gone — thread() answers a WithdrawnJson now.
    const held = await cache.thread(a.id);
    expect(held).not.toBeNull();
    expect((held!.post as WithdrawnJson).kind).toBe('withdrawn');
  });
});

// ---------------------------------------------------------------------------
// A landing after the list moved on: a node change drops state; no cache
// put, nothing written, and the id is asked again on the next read.
// ---------------------------------------------------------------------------
describe('a landing after a node change writes nothing', () => {
  it('a changeNode landing between resolve and onBound writes nothing to the cache or the feed; the next read asks the id again', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        // The change's re-read's first page — empty, so no new slot.
        { posts: [], next: null, pending: [], pendingCount: 0 },
        // The next loadFeed's page lists the id again.
        { posts: [la], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    // A node change moves the gen; its re-read empties the feed and the next
    // read asks the resolver again.
    await h.drive.changeNode('http://second');
    await settle();
    expect(h.drive.resolving.size).toBe(0);
    // The old resolve answers now — its onBound fires under the older gen.
    const fa = fullRow('a');
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    // Nothing landed — the cache was not written, the feed stays empty.
    const held = await cache.getMany([la.id]);
    expect(held.size).toBe(0);
    expect(h.drive.state.feed.posts.length).toBe(0);
    // The next read asks the resolver again — resolving was cleared.
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([la.id]);
  });

  it('an onIdentityChange landing between resolve and onBound writes nothing to the cache or the feed; the next read asks the id again', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        // onIdentityChange calls loadFeed from inside — its empty page.
        { posts: [], next: null, pending: [], pendingCount: 0 },
        // The next loadFeed's page lists the id again.
        { posts: [la], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    h.drive.onIdentityChange();
    await settle();
    expect(h.drive.resolving.size).toBe(0);
    const fa = fullRow('a');
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    const held = await cache.getMany([la.id]);
    expect(held.size).toBe(0);
    expect(h.drive.state.feed.posts.length).toBe(0);
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(2);
    expect(r.calls[1]!.ids).toEqual([la.id]);
  });

  it('after a withdrawal landed in the feed: the row leaves and a bound resolve does not put it back', async () => {
    // The landing drives applyWithdrawLanding — a pending withdraw entry in
    // the ledger, the node answers the withdrawn row, pollTick fires
    // (WEB_INTERFACE → The withdraw control). A root's drop leaves the
    // feed, and the resolve that answers bound after is skipped because
    // withdrawnSeen holds the id.
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const w = tomb('a');
    const h = harness({
      resolver: r.resolver, cache, identityKey: ME,
      feedResults: [{ posts: [la], next: null, pending: [], pendingCount: 0 }],
      postRes: w as unknown as PostResult,
    });
    await h.drive.loadFeed();
    await settle();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([la.id]);
    const ledger = (h.app as unknown as { ledger: PendingLedger }).ledger;
    ledger.add({
      txId: hid('wd' + 'a'),
      kind: 'withdraw',
      postId: la.id,
      inputs: [],
      expiresAtHeight: 999,
      submittedAtHeight: 0,
    });
    await h.drive.pollTick();
    await settle();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([]);
    const fa = fullRow('a');
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No cache: with the resolver held but no cache (or getMany that rejects),
// every row is a slot and fills from the resolver.
// ---------------------------------------------------------------------------
describe('no cache: rows are slots and fill from the resolver alone', () => {
  it('postCache null: no cache call, slots stand, resolve asks every id', async () => {
    const r = testResolver();
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache: null,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id, lb.id]);
    const fa = fullRow('a'), fb = fullRow('b');
    r.calls[0]!.bound([fa, fb]);
    r.calls[0]!.end({});
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(2);
  });

  it('getMany that rejects reads the same as no cache', async () => {
    const r = testResolver();
    const la = light('a');
    const rejecting: PostCache = {
      open: async () => {},
      put: async () => {},
      withdraw: async () => {},
      thread: async () => null,
      getMany: async () => { throw new Error('nope'); },
      refresh: async () => {},
    };
    const h = harness({
      resolver: r.resolver, cache: rejecting,
      feedResults: [{ posts: [la], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id]);
  });

  it('a cache with no IndexedDB: every row is a slot, fills from the resolver, nothing throws', async () => {
    const r = testResolver();
    // The real adapter handed no indexedDB — every op is a no-op; the
    // module's two absorbed failures are a put that does not fit and this.
    const cache = createPostCache({ indexedDB: null, localStorage: null });
    await cache.open('C');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.ids).toEqual([la.id, lb.id]);
    const fa = fullRow('a'), fb = fullRow('b');
    r.calls[0]!.bound([fa, fb]);
    r.calls[0]!.end({});
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(2);
    expect(h.feedEl.querySelectorAll('.card.slot').length).toBe(0);
    // No IndexedDB, so the cache holds nothing — a later read asks again.
    const held = await cache.getMany([la.id, lb.id]);
    expect(held.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The reader's own pending post rides a light row from the feed's pending.
// The cache holds it as the reader's own; intake composes it; dedupeOwn drops
// it beside its submission card.
// ---------------------------------------------------------------------------
describe('the reader\'s own pending post is a card and never a slot', () => {
  it('intake composes it from the cache; dedupeOwn drops it from feed.pending', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    // The reader's own confirmed post is in the cache (as the submit path
    // puts it, `own: true`).
    const own = fullRow('o', { author: ME, status: 'pending' });
    await cache.put({
      id: own.id, txBytes: new Uint8Array([1, 2, 3]), row: own,
      author: own.author, parent: null, own: true,
    });
    const lo = light('o', { authorName: null });
    const h = harness({
      resolver: r.resolver, cache, identityKey: ME,
      feedResults: [{ posts: [], next: null, pending: [lo], pendingCount: 1 }],
    });
    // A pending post entry in the ledger: dedupeOwn drops the row from
    // feed.pending beside the submission card.
    const ledger = (h.app as unknown as { ledger: PendingLedger }).ledger;
    ledger.add({
      txId: own.txId!,
      kind: 'post',
      postId: own.id,
      inputs: [],
      submittedAtHeight: 0,
      expiresAtHeight: 999,
    });
    await h.drive.loadFeed();
    await settle();
    // No slot was ever drawn and no resolve was asked — the cache held it.
    expect(h.feedEl.querySelectorAll('.card.slot').length).toBe(0);
    expect(r.calls.length).toBe(0);
    // dedupeOwn dropped the pending row — feed.pending is empty.
    expect(h.drive.state.feed.pending.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A resolve that rejects closes its slots with no line.
// ---------------------------------------------------------------------------
describe('a resolve that rejects closes its slots with no line', () => {
  it('every asked id ends unserved; unboundCount stays 0', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a'), lb = light('b');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [{ posts: [la, lb], next: null, pending: [], pendingCount: 0 }],
    });
    await h.drive.loadFeed();
    await settle();
    r.calls[0]!.fail();
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(0);
    expect(h.drive.state.feed.unboundCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A light page of the wrong shape (PageError) is the list's error line and
// no row, and no resolve call.
// ---------------------------------------------------------------------------
describe('a light page of the wrong shape is the list\'s error line', () => {
  it('intake is never called; resolve is never asked', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const rejecting = {
      feed: async (): Promise<FeedResult> => { throw new PageError(); },
      thread: async () => null,
      post: async () => null,
      status: async () => status(),
      currentBlock: async () => ({ height: 10, hash: null }),
      karma: async () => ({ userId: ME, total: '0', effective: '0', boxes: [], boxCount: 0, next: null, lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0', memberSinceBlock: 0, memberBar: 1, memberVouches: 0, memberLikes: '0', invitesUsed: 0, member: false, invitesAvailable: null, height: 10 }),
      vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
      vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
      vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
      bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
      usernameByOwner: async () => null,
      credits: async () => ({ userId: ME, total: '0', boxes: [], boxCount: 0, next: null }),
      usernameByName: async () => null,
    } as unknown as Api;
    const writeClient = {} as unknown as WriteClient;
    const identity = makeIdentity(null);
    const ledger = new PendingLedger(null);
    const app = new App(
      rejecting, writeClient, identity, ledger, undefined, undefined,
      null, null, null, stubVerifier(), cache, r.resolver,
    );
    const appbar = document.createElement('header');
    const feedEl = document.createElement('section'); feedEl.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    const workspace = document.createElement('div'); workspace.className = 'workspace';
    workspace.append(feedEl, panes);
    document.body.append(appbar, workspace);
    app.mount(appbar, feedEl, panes);
    const drive = app as unknown as { loadFeed(): Promise<void>; state: AppState };
    await drive.loadFeed();
    await settle();
    expect(drive.state.feed.error).not.toBeNull();
    expect(drive.state.feed.posts.length).toBe(0);
    expect(r.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The seed walk: with no stored node and a first node that fails, the probe
// asks `light=1` and its page's slots are resolved under the adoption
// generation (WEB_INTERFACE → "The client is served from the node's own
// origin", → The extension → "The light read"). The walk uses a real
// NodeClient over `fetch`, so the test stubs `fetch` globally and loads
// prefs with a `notis-nodes` meta of its own.
// ---------------------------------------------------------------------------
describe('the seed walk under a resolver', () => {
  it('a failed first seed is skipped; the probe asks light=1; the adopted page\'s slots resolve', async () => {
    vi.resetModules();
    const SEED1 = 'http://seed1.example';
    const SEED2 = 'http://seed2.example';
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'notis-nodes');
    meta.setAttribute('content', JSON.stringify([SEED1, SEED2]));
    document.head.appendChild(meta);
    const fresh = await import('../src/prefs');
    const { App: FreshApp } = await import('../src/app');
    // The build's seed list reads the meta: SEED1 is the initial node.
    expect(fresh.BUILD_NODES).toEqual([SEED1, SEED2]);
    expect(fresh.prefs.node).toBe(SEED1);

    const la = light('a');
    const probed: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      probed.push(url);
      if (url.startsWith(SEED2)) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({ posts: [la], next: null, pending: [], pendingCount: 0 }),
        };
      }
      return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) };
    }));
    try {
      const r = testResolver();
      const { cache } = makeCache();
      await cache.open('C');
      const fake: Fake = { feedCalls: [], feedQueue: [], threadCalls: [], threadQueue: [], postRes: null, postCalls: [] };
      const api = makeApi(fake);
      // SEED1 is the initial node and its feed throws — the walk begins.
      api.feed = async () => { throw new Error('first seed fails'); };
      const identity = makeIdentity(null);
      const ledger = new PendingLedger(null);
      const app = new FreshApp(
        api, {} as unknown as WriteClient, identity, ledger, undefined, undefined,
        null, null, null, stubVerifier(), cache, r.resolver,
      );
      const appbar = document.createElement('header');
      const feedEl = document.createElement('section'); feedEl.id = 'feed';
      const panes = document.createElement('section'); panes.id = 'panes';
      const workspace = document.createElement('div'); workspace.className = 'workspace';
      workspace.append(feedEl, panes);
      document.body.append(appbar, workspace);
      app.mount(appbar, feedEl, panes);
      const drive = app as unknown as { loadFeed(): Promise<void>; state: AppState };
      await drive.loadFeed();
      await settle();
      // The probe asked SEED2 with light=1.
      expect(probed.some((u) => u.startsWith(SEED2) && u.includes('light=1'))).toBe(true);
      // The adopted node is SEED2.
      expect(fresh.prefs.node).toBe(SEED2);
      // The resolver was asked once for the adopted page's slot id.
      expect(r.calls.length).toBe(1);
      expect(r.calls[0]!.ids).toEqual([la.id]);
    } finally {
      vi.unstubAllGlobals();
      meta.remove();
    }
  });
});
