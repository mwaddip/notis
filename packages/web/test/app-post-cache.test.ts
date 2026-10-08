// @vitest-environment happy-dom
// The App's post-cache wiring (WEB_INTERFACE → The extension → "The post
// cache"). The cache is handed to the App in the extension build alone; the
// web build is handed none and the App behaves as it does at HEAD. Every
// read still checks every row — the cache never substitutes for the check.
// The cache is read only when a thread's read from the node fails, never
// first. A put is started and never awaited by a render path.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import type { Api } from '../src/api/client';
import type { AppState, PostCache, PostsVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type {
  PostJson, PostResult, StatusResult, ThreadResult, FeedResult, BlockCurrent, WithdrawnJson,
} from '../src/api/dto';

const ME = 'aa'.repeat(32);
const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// `fake-indexeddb` schedules its own microtasks between IDB request steps;
// a sequence of put/get needs several queue drains to settle. 10 drains is
// enough for every chain this suite builds.
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await flush(); };

function row(label: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id: hid(label), content: label, contentHash: hid('h' + label),
    author: ME, parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed', blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: hid('tx' + label), tx: 'de'.repeat(16),
    ...over,
  };
}
function tomb(label: string): WithdrawnJson {
  return {
    kind: 'withdrawn', id: hid(label), author: ME, withdrawnAtHeight: 11,
    parentRefs: [], descendantCount: 0, authorName: null, txId: hid('tx' + label),
  };
}
function status(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 10, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

/** The `bound` check carries the id, bytes, author and parent (the fields the
 *  cache keys on). Use a dummy `txBytes`. */
const BOUND = (r: PostJson): PostCheck =>
  ({ status: 'bound', id: r.id, txBytes: new Uint8Array([1, 2, 3]), author: r.author, parent: r.parentRefs[0] ?? null });
const UNBOUND: PostCheck = { status: 'unbound', reason: 'signature', verdict: 'u' };
const NOTHING_TO_BIND: PostCheck = { status: 'nothing-to-bind' };
const UNSERVED: PostCheck = { status: 'unserved' };

function scriptedVerifier(decide: (row: unknown, idx: number) => PostCheck): { verifier: PostsVerifier; calls: Array<unknown[]> } {
  const calls: Array<unknown[]> = [];
  return {
    calls,
    verifier: {
      check: (rows: unknown[]): PostCheck[] => {
        calls.push(rows);
        return rows.map((r, i) => decide(r, i));
      },
    },
  };
}

interface Fake {
  feedCalls: Array<{ withTx: boolean | undefined }>;
  feedRes: FeedResult;
  threadCalls: Array<{ withTx: boolean | undefined; id: string }>;
  threadRes: ThreadResult | null;
  threadThrows: boolean;
  postRes: PostResult | null;
}

function makeApi(f: Fake): Api {
  return {
    feed: async (_page, _viewer, _author, _roots, withTx): Promise<FeedResult> => {
      f.feedCalls.push({ withTx });
      return f.feedRes;
    },
    thread: async (id, _page, _viewer, withTx): Promise<ThreadResult | null> => {
      f.threadCalls.push({ withTx, id });
      if (f.threadThrows) throw new Error('offline');
      return f.threadRes;
    },
    post: async (): Promise<PostResult | null> => f.postRes,
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

function harness(opts: {
  verifier?: PostsVerifier | null;
  cache?: PostCache | null;
  feedRes?: FeedResult;
  threadRes?: ThreadResult | null;
  postRes?: PostResult | null;
  threadThrows?: boolean;
} = {}) {
  const fake: Fake = {
    feedCalls: [], feedRes: opts.feedRes ?? { posts: [], next: null, pending: [], pendingCount: 0 },
    threadCalls: [], threadRes: opts.threadRes ?? null,
    threadThrows: opts.threadThrows ?? false,
    postRes: opts.postRes ?? null,
  };
  const api = makeApi(fake);
  const writeClient = {} as unknown as WriteClient;
  const ledger = new PendingLedger(null);
  const identity = {
    current: () => null,
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
  const app = new App(
    api, writeClient, identity, ledger, undefined, undefined, null, null, null,
    opts.verifier ?? null,
    opts.cache ?? null,
  );
  const appbar = document.createElement('div');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feedEl, panes);
  app.mount(appbar, feedEl, panes);
  const drive = app as unknown as {
    loadFeed(): Promise<void>;
    refreshFeed(): Promise<void>;
    openThread(id: string, o: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    fetchThread(id: string): Promise<void>;
    refreshThread(id: string): Promise<void>;
    renderRegionsFor(id: string): void;
    state: AppState;
  };
  return { app, drive, fake, feedEl, panes };
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

beforeEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('app-post-cache — bound rows put, non-bound rows never', () => {
  it('a feed read puts its bound rows and never an unbound or unserved row', async () => {
    const a = row('a'), bad = row('b'), gone = row('c', { tx: null });
    const sv = scriptedVerifier((r) => (r === bad ? UNBOUND : r === gone ? UNSERVED : BOUND(r as PostJson)));
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({ verifier: sv.verifier, cache, feedRes: { posts: [a, bad, gone], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await settle();
    expect(await cache.thread(a.id)).not.toBeNull();
    expect(await cache.thread(bad.id)).toBeNull();
    expect(await cache.thread(gone.id)).toBeNull();
  });

  it('a thread read puts its bound rows', async () => {
    const subject = row('r');
    const d = row('d');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({
      verifier: sv.verifier, cache,
      threadRes: { post: subject, ancestors: [], ancestorCount: 0, descendants: [d], descendantCount: 1, next: null, pending: [], pendingCount: 0 },
    });
    h.drive.openThread(subject.id, { from: 'feed' });
    await settle();
    expect(await cache.thread(subject.id)).not.toBeNull();
    expect(await cache.thread(d.id)).not.toBeNull();
  });
});

describe('app-post-cache — a withdrawn row for a held id empties its text', () => {
  it('calls withdraw on the cache for a nothing-to-bind withdrawn row', async () => {
    const r = row('r');
    const w = tomb('r'); // same id (same label), the withdrawn marker
    expect(w.id).toBe(r.id);
    const sv = scriptedVerifier((rr) => (rr === r ? BOUND(r) : NOTHING_TO_BIND));
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({
      verifier: sv.verifier, cache,
      threadRes: { post: r, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0 },
    });
    await h.drive.fetchThread(r.id);
    await settle();
    // The subject was put — the cache holds it as a live row.
    const first = await cache.thread(r.id);
    expect(first).not.toBeNull();
    // Second read brings a withdrawn row.
    h.fake.threadRes = { post: w, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0 };
    await h.drive.refreshThread(r.id);
    await settle();
    const t = await cache.thread(r.id);
    expect(t).not.toBeNull();
    expect((t!.post as WithdrawnJson).kind).toBe('withdrawn');
  });
});

describe('app-post-cache — a thread read that throws reads the cache', () => {
  it('with the subject held: the error line and the held rows render', async () => {
    const subject = row('r');
    const d = row('d');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache } = makeCache();
    await cache.open('C');
    // Seed the cache with the subject and one descendant.
    const BOUND_SUBJECT = BOUND(subject);
    if (BOUND_SUBJECT.status !== 'bound') throw new Error('invariant');
    await cache.put({ id: subject.id, txBytes: BOUND_SUBJECT.txBytes, row: subject, author: subject.author, parent: null, own: false });
    const BOUND_D = BOUND({ ...d, parentRefs: [subject.id] });
    if (BOUND_D.status !== 'bound') throw new Error('invariant');
    await cache.put({ id: d.id, txBytes: BOUND_D.txBytes, row: { ...d, parentRefs: [subject.id] }, author: d.author, parent: subject.id, own: false });

    const h = harness({ verifier: sv.verifier, cache, threadThrows: true });
    await h.drive.fetchThread(subject.id);
    await settle();
    h.drive.renderRegionsFor(subject.id);
    const t = h.drive.state.threads.get(subject.id)!;
    expect(t.error).not.toBeNull();
    expect(t.root).not.toBeNull();
    expect(t.root!.id).toBe(subject.id);
    // The pane renders the error line and the subject card beneath.
    // The pane is only rendered when a region is open; after `fetchThread`
    // the ThreadState carries root and error — the render path is in
    // `panes.ts`' thread branch (WEB_INTERFACE → The extension → "The post
    // cache"), covered by `view/panes.ts` directly in `panes.test.ts`.
  });

  it('with the subject not held: today\'s failed read, unchanged', async () => {
    const subject = row('r');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache } = makeCache();
    await cache.open('C');
    const h = harness({ verifier: sv.verifier, cache, threadThrows: true });
    await h.drive.fetchThread(subject.id);
    await settle();
    const t = h.drive.state.threads.get(subject.id)!;
    expect(t.error).not.toBeNull();
    expect(t.root).toBeNull();
  });

  it('after such a failure, a read that answers replaces the rows', async () => {
    const subject = row('r');
    const d = row('d');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache } = makeCache();
    await cache.open('C');
    const BOUND_SUBJECT = BOUND(subject);
    if (BOUND_SUBJECT.status !== 'bound') throw new Error('invariant');
    await cache.put({ id: subject.id, txBytes: BOUND_SUBJECT.txBytes, row: subject, author: subject.author, parent: null, own: false });

    const h = harness({ verifier: sv.verifier, cache, threadThrows: true });
    await h.drive.fetchThread(subject.id);
    await settle();
    expect(h.drive.state.threads.get(subject.id)!.root).not.toBeNull();
    expect(h.drive.state.threads.get(subject.id)!.error).not.toBeNull();
    // Now the node answers.
    h.fake.threadThrows = false;
    h.fake.threadRes = { post: subject, ancestors: [], ancestorCount: 0, descendants: [d], descendantCount: 1, next: null, pending: [], pendingCount: 0 };
    await h.drive.refreshThread(subject.id);
    await settle();
    const t = h.drive.state.threads.get(subject.id)!;
    expect(t.error).toBeNull();
    expect(t.root).not.toBeNull();
    expect(t.descendants.map((r) => r.id)).toEqual([d.id]);
  });
});

describe('app-post-cache — a thread read that answers does not call thread()', () => {
  it('counts zero cache.thread calls on a successful read', async () => {
    const subject = row('r');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache } = makeCache();
    await cache.open('C');
    // Wrap `thread` to count — the harness does not expose a counting cache,
    // so install a proxy.
    let threadCalls = 0;
    const counted: PostCache = {
      open: (c) => cache.open(c),
      put: (e) => cache.put(e),
      withdraw: (i, r) => cache.withdraw(i, r),
      thread: (i) => { threadCalls++; return cache.thread(i); },
    };
    const h = harness({
      verifier: sv.verifier, cache: counted,
      threadRes: { post: subject, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0 },
    });
    h.drive.openThread(subject.id, { from: 'feed' });
    await settle();
    expect(threadCalls).toBe(0);
  });
});

describe('app-post-cache — with no cache handed in, nothing of this happens', () => {
  it('a thread read that throws leaves no rows and no cache call', async () => {
    const subject = row('r');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const h = harness({ verifier: sv.verifier, cache: null, threadThrows: true });
    await h.drive.fetchThread(subject.id);
    await flush();
    const t = h.drive.state.threads.get(subject.id)!;
    expect(t.error).not.toBeNull();
    expect(t.root).toBeNull();
  });
});
