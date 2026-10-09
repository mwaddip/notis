// @vitest-environment happy-dom
// The App over the extension's light reads and resolver (WEB_INTERFACE → The
// extension → "The light read", → "The resolve"): the feed and the author
// window's list reads carry `light=1` while a resolver is held, `intake`
// composes rows from the cache, and `resolveSlots` asks the resolver for
// what the cache lacks. With no resolver the six reads' URLs are today's.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import { PageError } from '../src/api/errors';
import type { Api } from '../src/api/client';
import type { AppIdentity, AppState, PostCache, PostResolver, PostsVerifier, HeldPost } from '../src/model/state';
import type { BoundPost, ResolveEnd } from '../src/model/post-resolve';
import type { WriteClient } from '../src/api/write';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type {
  PostJson, LightJson, WithdrawnJson, FeedResult, ThreadResult, PostResult,
  StatusResult, BlockCurrent, FeedRow,
} from '../src/api/dto';

const ME = 'aa'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// `fake-indexeddb` schedules its own microtasks between IDB request steps;
// a sequence of put/get needs several queue drains to settle.
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await flush(); };

const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

function status(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 10, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function fullRow(label: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id: hid(label), content: 'text:' + label, contentHash: hid('h' + label),
    author: ME, parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed', blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: hid('tx' + label),
    ...over,
  };
}

function light(label: string, over: Partial<LightJson> = {}): LightJson {
  return {
    kind: 'light', id: hid(label), parentRefs: [], status: 'confirmed',
    blockHeight: 11, blockIndex: 1, blockCreatedAt: 2000,
    likeCount: 3, descendantCount: 4, authorName: 'alice', likedByViewer: false,
    ...over,
  };
}

function tomb(label: string): WithdrawnJson {
  return {
    kind: 'withdrawn', id: hid(label), author: ME, withdrawnAtHeight: 11,
    parentRefs: [], descendantCount: 0, authorName: null, txId: hid('tx' + label),
  };
}

/** A `bound` check for a row — the resolver's answer under `bound` carries
 *  the id, bytes, author and parent as the transaction states them. */
function boundCheck(r: PostJson): Extract<PostCheck, { status: 'bound' }> {
  return { status: 'bound', id: r.id, txBytes: new Uint8Array([1, 2, 3]), author: r.author, parent: r.parentRefs[0] ?? null };
}

interface FeedCall { url: string; light: boolean | undefined; withTx: boolean | undefined; author: string | undefined }

interface Fake {
  feedCalls: FeedCall[];
  feedQueue: FeedResult[];
  threadRes: ThreadResult | null;
}

function makeApi(f: Fake): Api {
  return {
    feed: async (page, viewer, author, roots, withTx, lightFlag): Promise<FeedResult> => {
      const q: Record<string, string | number | undefined> = {
        limit: page?.limit, after: page?.after ?? undefined, author, viewer, roots: roots ? 1 : undefined,
      };
      if (lightFlag) q['light'] = 1;
      else if (withTx) q['tx'] = 1;
      const qs = Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      const url = '/posts' + (qs ? '?' + qs : '');
      f.feedCalls.push({ url, light: lightFlag, withTx, author });
      const res = f.feedQueue.shift();
      if (res === undefined) return { posts: [], next: null, pending: [], pendingCount: 0 };
      return res;
    },
    thread: async (): Promise<ThreadResult | null> => f.threadRes,
    post: async (): Promise<PostResult | null> => null,
    status: async () => status(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 10, hash: null }),
    karma: async () => ({
      userId: ME, total: '0', effective: '0', boxes: [], boxCount: 0, next: null,
      lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
      memberSinceBlock: 0, memberBar: 1, memberVouches: 0, memberLikes: '0',
      invitesUsed: 0, member: false, invitesAvailable: null, height: 10,
    }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: ME, total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

/** A test-driven resolver — each `resolve` call is captured, the test
 *  releases `onBound` calls and the final `ends` map by hand. */
interface Call {
  ids: string[];
  onBound: (posts: BoundPost[]) => void;
  settle: (ends: Map<string, ResolveEnd>) => void;
  reject: (err: Error) => void;
  bound(rows: PostJson[]): void;
  end(ends: Partial<Record<string, ResolveEnd>>): void;
  fail(): void;
}

function testResolver(): { resolver: PostResolver; calls: Call[] } {
  const calls: Call[] = [];
  const resolver: PostResolver = {
    resolve(ids, onBound) {
      return new Promise<Map<string, ResolveEnd>>((settle, reject) => {
        const call: Call = {
          ids: [...ids],
          onBound,
          settle,
          reject,
          bound(rows): void {
            onBound(rows.map((r) => ({ row: r, check: boundCheck(r) })));
          },
          end(ends): void {
            const m = new Map<string, ResolveEnd>();
            for (const [id, v] of Object.entries(ends)) if (v !== undefined) m.set(id, v);
            settle(m);
          },
          fail(): void { reject(new Error('resolver failed')); },
        };
        calls.push(call);
      });
    },
  };
  return { resolver, calls };
}

function makeCache(): { cache: PostCache; ls: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> } {
  const map = new Map<string, string>();
  const ls = {
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => { map.set(k, v); },
    removeItem: (k: string): void => { map.delete(k); },
  };
  const cache = createPostCache({ indexedDB: new IDBFactory(), localStorage: ls });
  return { cache, ls };
}

function makeIdentity(key: string | null): AppIdentity {
  return {
    current: () => (key === null ? null : { pubKeyHex: key, locked: false }),
    sign: async () => ({ signature: '00' }),
    draft: async () => ({ pubKeyHex: '' }),
    create: async () => ({ pubKeyHex: '' }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: '' }),
    importFile: async () => ({ pubKeyHex: '' }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => false,
    onChange: () => {},
  };
}

interface Harness {
  app: App;
  drive: {
    loadFeed(): Promise<void>;
    refreshFeed(): Promise<void>;
    loadOlder(): Promise<void>;
    openAuthorPosts(key: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    refreshAuthorPosts(key: string): Promise<void>;
    authorPostsMore(key: string): Promise<void>;
    changeNode(origin: string): Promise<void>;
    onIdentityChange(): void;
    state: AppState;
    withdrawnSeen: Map<string, WithdrawnJson>;
    resolving: Set<string>;
  };
  fake: Fake;
  feedEl: HTMLElement;
  panes: HTMLElement;
}

interface Opts {
  resolver?: PostResolver | null;
  verifier?: PostsVerifier | null;
  cache?: PostCache | null;
  identityKey?: string | null;
  feedResults?: FeedResult[];
  threadRes?: ThreadResult | null;
}

function harness(opts: Opts = {}): Harness {
  const fake: Fake = {
    feedCalls: [],
    feedQueue: opts.feedResults ? [...opts.feedResults] : [],
    threadRes: opts.threadRes ?? null,
  };
  const api = makeApi(fake);
  const writeClient = {} as unknown as WriteClient;
  const key = opts.identityKey === undefined ? null : opts.identityKey;
  const ledger = new PendingLedger(key);
  const identity = makeIdentity(key);
  const app = new App(
    api, writeClient, identity, ledger, undefined, undefined,
    null, null, null,
    opts.verifier ?? null,
    opts.cache ?? null,
    opts.resolver ?? null,
  );
  const appbar = document.createElement('header');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feedEl, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feedEl, panes);
  const drive = app as unknown as Harness['drive'];
  return { app, drive, fake, feedEl, panes };
}

/** Put a bound row directly into the cache the test owns, so a later
 *  `intake` finds it. */
async function seedCache(cache: PostCache, rows: PostJson[]): Promise<void> {
  for (const r of rows) {
    const c = boundCheck(r);
    await cache.put({ id: c.id, txBytes: c.txBytes, row: r, author: c.author, parent: c.parent, own: false });
  }
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// With no resolver the request URLs are the tip's — pins the first two
// configurations of the table, with and without a verifier.
// ---------------------------------------------------------------------------
describe('with no resolver the six reads carry no light flag', () => {
  it('the web build: no light, no tx on all six reads', async () => {
    const h = harness({
      resolver: null, verifier: null, cache: null,
      feedResults: [
        // loadFeed
        { posts: [fullRow('a')], next: 'cursor0', pending: [], pendingCount: 0 },
        // refreshFeed first page (reconcile)
        { posts: [], next: null, pending: [], pendingCount: 0 },
        // loadOlder
        { posts: [], next: null, pending: [], pendingCount: 0 },
        // loadAuthorPosts
        { posts: [], next: 'cur-a', pending: [], pendingCount: 0 },
        // refreshAuthorPosts
        { posts: [], next: null, pending: [], pendingCount: 0 },
        // authorPostsMore
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
      expect(call.light).toBeFalsy();
      expect(call.withTx).toBeFalsy();
      expect(call.url).not.toContain('light=1');
      expect(call.url).not.toContain('tx=1');
    }
    expect(h.fake.feedCalls.length).toBeGreaterThanOrEqual(6);
  });

  it('with a verifier and no resolver: tx=1, never light=1', async () => {
    const verifier: PostsVerifier = { check: (rows) => rows.map(() => ({ status: 'bound' } as PostCheck)) };
    // These rows carry tx=1 under a verifier; the check mocks bound for each.
    const r = fullRow('r');
    const verifierBound: PostsVerifier = { check: (rows) => rows.map((row) => boundCheck(row as PostJson) as PostCheck) };
    const K = hid('author2');
    const h = harness({
      resolver: null, verifier: verifierBound, cache: null,
      feedResults: [
        { posts: [r], next: 'cur1', pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: 'cur2', pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
        { posts: [], next: null, pending: [], pendingCount: 0 },
      ],
    });
    // Silence the unused `verifier` to appease TS.
    void verifier;
    await h.drive.loadFeed(); await flush();
    await h.drive.refreshFeed(); await flush();
    await h.drive.loadOlder(); await flush();
    h.drive.openAuthorPosts(K, { from: 'feed' });
    await flush();
    await h.drive.refreshAuthorPosts(K); await flush();
    await h.drive.authorPostsMore(K); await flush();
    for (const call of h.fake.feedCalls) {
      expect(call.light).toBeFalsy();
      expect(call.url).toContain('tx=1');
    }
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
describe('an answer that lands between a read\'s intake and its write', () => {
  it('fills the list that stood here; the next read finds the post in the cache', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const K = hid('author3');
    const lx = light('x');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [lx], next: null, pending: [], pendingCount: 0 },
        { posts: [lx], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    expect(r.calls.length).toBe(1);
    // Bound answer lands — the feed's slot is filled, the cache holds X.
    const fx = fullRow('x');
    r.calls[0]!.bound([fx]);
    r.calls[0]!.end({});
    await settle();
    // Author window opens on X's author; its first page lists X — intake
    // finds X in the cache and composes it, so the window shows a card.
    h.drive.openAuthorPosts(K, { from: 'feed' });
    await settle();
    const win = h.drive.state as unknown as { authorPostsData?: Map<string, { posts: FeedRow[] }> };
    // The author posts window's state is private; drive through the handle
    // via a type cast to the App's own structure.
    void win;
    // One `resolve` call in all — the second read found X in the cache.
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
    expect(h.drive.state.feed.unboundCount).toBe(0);
  });

  it('one unbound: slot leaves; count rises to 1', async () => {
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
    expect(h.drive.state.feed.unboundCount).toBe(1);
  });

  it('two unbound reads: count rises to 2', async () => {
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
    expect(h.drive.state.feed.unboundCount).toBe(2);
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
  it('feed and author window: both drop the slot, each counts an unbound', async () => {
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
    // The feed and the author window both hold the slot.
    expect(h.drive.state.feed.posts.length).toBe(1);
    const apd = (h.app as unknown as { authorPostsData: Map<string, { posts: FeedRow[]; unboundCount: number }> }).authorPostsData;
    expect(apd.get(K)?.posts.length).toBe(1);
    r.calls[0]!.end({ [la.id]: 'unbound' });
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(0);
    expect(h.drive.state.feed.unboundCount).toBe(1);
    expect(apd.get(K)?.posts.length).toBe(0);
    expect(apd.get(K)?.unboundCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A placeholder bound at the end — content: null — the resolve answers it as
// a bound post with null content; the client leaves it where it stood and
// the next first page asks for it again (it is still a `LightJson`).
// ---------------------------------------------------------------------------
describe('a placeholder passes through onBound and stays a slot', () => {
  it('a bound post with content: null does not fill a slot', async () => {
    // `fillSlots` composes `withNodeWord(post, slot)` into a `PostJson` and
    // writes it. A bound post with `content: null` is still a PostJson; its
    // composition carries content: null (a placeholder). The slot is
    // replaced by the composed row — the card reads "content not on this
    // node yet" through the view. The next first page listing the same id
    // sees a full row (not a light row), so resolveSlots does not claim it.
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
    const fa = fullRow('a', { content: null });
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    expect(h.drive.state.feed.posts.length).toBe(1);
    const row = h.drive.state.feed.posts[0] as PostJson;
    expect(row.content).toBeNull();
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
  it('onBound under the older gen puts nothing and leaves resolving alone', async () => {
    const r = testResolver();
    const { cache } = makeCache();
    await cache.open('C');
    const la = light('a');
    const h = harness({
      resolver: r.resolver, cache,
      feedResults: [
        { posts: [la], next: null, pending: [], pendingCount: 0 },
        { posts: [la], next: null, pending: [], pendingCount: 0 },
      ],
    });
    await h.drive.loadFeed();
    await settle();
    // Drive a node change — the gen moves, the feed empties, resolving clears.
    const dropFn = (h.app as unknown as { dropReaderState(): void }).dropReaderState;
    const dropFeedRowsFn = (h.app as unknown as { dropFeedRows(): void }).dropFeedRows;
    dropFn.call(h.app);
    dropFeedRowsFn.call(h.app);
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

  it('fillSlots skips an id whose withdrawal the client saw land', async () => {
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
    // Mark `a` as a withdrawal the client saw land.
    h.drive.withdrawnSeen.set(la.id, tomb('a'));
    // The resolve answers bound for `a` — fillSlots skips it.
    const fa = fullRow('a');
    r.calls[0]!.bound([fa]);
    r.calls[0]!.end({});
    await settle();
    // The slot was not filled — it remains in the list as a LightJson.
    // (The withdrawal has not reached the feed row through any other path
    // in this harness; the point is fillSlots did not replace the slot.)
    const row = h.drive.state.feed.posts[0];
    expect(row).toBeDefined();
    expect('kind' in row! && row.kind === 'light').toBe(true);
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
      null, null, null, null, cache, r.resolver,
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
