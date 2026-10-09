// @vitest-environment happy-dom
// The App's post-cache wiring (WEB_INTERFACE → The extension → "The post
// cache"). The cache is handed to the App in the extension build alone; the
// web build is handed none and the App behaves as it does at HEAD. Every
// read still checks every row — the cache never substitutes for the check.
// The cache is read only when a thread's read from the node fails, never
// first. A put is started and never awaited by a render path.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, computePostId, encodeTx, hexToBytes, POST_PRICE_THREAD } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { checkPosts } from '@dagsocial/nipopow-client';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import { buildPost } from '../src/wallet/builders';
import type { Api } from '../src/api/client';
import type { AppState, PostCache, PostResolver, PostsVerifier, TipRun, TipVerifier } from '../src/model/state';
import type { ResolveEnd } from '../src/model/post-resolve';
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
const NOTHING_TO_BIND: PostCheck = { status: 'nothing-to-bind' };

/** A resolver that never asks for anything: the stays cases drive the
 *  single post read's path, a thread read that throws, the cache's own
 *  behaviour or the submit hook — never a list. */
function emptyResolver(): PostResolver {
  return { resolve: async (): Promise<Map<string, ResolveEnd>> => new Map() };
}

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
  feedCalls: Array<{ light: boolean | undefined }>;
  feedRes: FeedResult;
  threadCalls: Array<{ light: boolean | undefined; id: string }>;
  threadRes: ThreadResult | null;
  threadThrows: boolean;
  postRes: PostResult | null;
}

function makeApi(f: Fake): Api {
  return {
    feed: async (_page, _viewer, _author, _roots, light): Promise<FeedResult> => {
      f.feedCalls.push({ light });
      return f.feedRes;
    },
    thread: async (id, _page, _viewer, light): Promise<ThreadResult | null> => {
      f.threadCalls.push({ light, id });
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
  // The App's constructor refuses a verifier without a resolver, or the
  // reverse (WEB_INTERFACE → The extension → "The post check", → "The
  // resolve"). An empty resolver stands beside the verifier here, since
  // these cases drive the single post read's path, the thread read's
  // cache fallback, the cache's own behaviour or the submit hook — never
  // a list.
  const verifier = opts.verifier ?? null;
  const resolver = verifier === null ? null : emptyResolver();
  const app = new App(
    api, writeClient, identity, ledger, undefined, undefined, null, null, null,
    verifier,
    opts.cache ?? null,
    resolver,
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
      getMany: (ids) => cache.getMany(ids),
      refresh: (rs) => cache.refresh(rs),
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

// -------- F1: the reader's own post enters the cache from the signed
// transaction, under the client-derived id, and only when it passes the
// post check as `bound` (WEB_INTERFACE → The extension → "The post cache":
// "Only `bound` rows enter", "the reader's own post at its submit, from
// the transaction the client built").

/** Sign a built transaction with a fresh Ed25519 keypair. Returns the signed
 *  transaction, its id, and the author's hex. */
function signTx(content: string): { signedTx: UtxoTransaction; txId: string; authorHex: string } {
  const sk = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(sk);
  const authorHex = bytesToHex(pub);
  const built = buildPost(
    { spendable: [{ boxId: 'bb'.repeat(32), value: POST_PRICE_THREAD }], height: 10, era: 1, author: authorHex },
    content,
  );
  // The sign step attaches the signature to the tx itself (submit.ts' signBody).
  const sig = ed25519.sign(hexToBytes(built.txId), sk);
  built.tx.signatures = { [authorHex]: sig };
  return { signedTx: built.tx, txId: built.txId, authorHex };
}

describe('app-post-cache — the reader\'s own post enters only when the post check binds it', () => {
  it('a signed submit held own, keyed by computePostId(txId, 0), and the stored tx bytes bind under the real checkPosts', async () => {
    const { signedTx, txId, authorHex } = signTx('hello');
    const expectedId = computePostId(txId, 0);
    const { cache } = makeCache();
    await cache.open('C');
    // The App's identity reports the author key, so `own` is set on the put.
    const identity = {
      current: () => ({ pubKeyHex: authorHex, locked: false }),
      sign: async () => ({ signature: '00' }),
      draft: async () => ({ pubKeyHex: '' }), create: async () => ({ pubKeyHex: '' }),
      discardDraft: () => {}, inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: '' }),
      importFile: async () => ({ pubKeyHex: '' }), exportFile: async () => '',
      unlock: async () => {}, lock: async () => {}, forget: async () => {}, backedUp: () => false, onChange: () => {},
    };
    // A verifier that calls through to the real checkPosts, so the gate is
    // the one the node's rows pass.
    const verifier: PostsVerifier = { check: (rows) => checkPosts(rows) };
    const api = makeApi({ feedCalls: [], feedRes: { posts: [], next: null, pending: [], pendingCount: 0 }, threadCalls: [], threadRes: null, threadThrows: false, postRes: null });
    const writeClient = {} as unknown as WriteClient;
    const ledger = new PendingLedger(authorHex);
    const app = new App(api, writeClient, identity, ledger, undefined, undefined, null, null, null, verifier, cache, emptyResolver());
    const appbar = document.createElement('div');
    const feedEl = document.createElement('section'); feedEl.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feedEl, panes);
    app.mount(appbar, feedEl, panes);
    const hook = (app as unknown as { cachePostFromSubmit(c: string): (info: { signedTx: UtxoTransaction; txId: string }) => void }).cachePostFromSubmit('hello');
    hook({ signedTx, txId });
    await settle();
    const held = await cache.thread(expectedId);
    expect(held).not.toBeNull();
    expect(held!.post.id).toBe(expectedId);
    // The row is the submission's content, not any node fiction.
    expect((held!.post as PostJson).content).toBe('hello');
    // Round-trip: the stored tx bytes decode and bind under the real checkPosts.
    const re = await cache.thread(expectedId);
    // The cache strips `tx` from the stored row; reconstruct from `txBytes`
    // the way a feed/thread read would present it to the check.
    const reconstructed: PostJson = {
      ...(re!.post as PostJson),
      tx: bytesToHex(encodeTx(signedTx)),
    };
    const [checked] = checkPosts([reconstructed]);
    expect(checked?.status).toBe('bound');
  });

  it('a verifier answering `unbound` for the submit puts nothing', async () => {
    const { signedTx, txId, authorHex } = signTx('nope');
    const { cache } = makeCache();
    await cache.open('C');
    const identity = {
      current: () => ({ pubKeyHex: authorHex, locked: false }), sign: async () => ({ signature: '00' }),
      draft: async () => ({ pubKeyHex: '' }), create: async () => ({ pubKeyHex: '' }),
      discardDraft: () => {}, inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: '' }),
      importFile: async () => ({ pubKeyHex: '' }), exportFile: async () => '',
      unlock: async () => {}, lock: async () => {}, forget: async () => {}, backedUp: () => false, onChange: () => {},
    };
    const verifier: PostsVerifier = { check: (rows) => rows.map(() => ({ status: 'unbound', reason: 'signature', verdict: 'u' } as PostCheck)) };
    const api = makeApi({ feedCalls: [], feedRes: { posts: [], next: null, pending: [], pendingCount: 0 }, threadCalls: [], threadRes: null, threadThrows: false, postRes: null });
    const app = new App(api, {} as unknown as WriteClient, identity, new PendingLedger(authorHex), undefined, undefined, null, null, null, verifier, cache, emptyResolver());
    const appbar = document.createElement('div');
    const feedEl = document.createElement('section'); feedEl.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feedEl, panes);
    app.mount(appbar, feedEl, panes);
    (app as unknown as { cachePostFromSubmit(c: string): (info: { signedTx: UtxoTransaction; txId: string }) => void })
      .cachePostFromSubmit('nope')({ signedTx, txId });
    await settle();
    expect(await cache.thread(computePostId(txId, 0))).toBeNull();
  });

  it('with no posts verifier the submit puts nothing — the check is the one gate', async () => {
    const { signedTx, txId, authorHex } = signTx('silent');
    const { cache } = makeCache();
    await cache.open('C');
    const identity = {
      current: () => ({ pubKeyHex: authorHex, locked: false }), sign: async () => ({ signature: '00' }),
      draft: async () => ({ pubKeyHex: '' }), create: async () => ({ pubKeyHex: '' }),
      discardDraft: () => {}, inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: '' }),
      importFile: async () => ({ pubKeyHex: '' }), exportFile: async () => '',
      unlock: async () => {}, lock: async () => {}, forget: async () => {}, backedUp: () => false, onChange: () => {},
    };
    const api = makeApi({ feedCalls: [], feedRes: { posts: [], next: null, pending: [], pendingCount: 0 }, threadCalls: [], threadRes: null, threadThrows: false, postRes: null });
    const app = new App(api, {} as unknown as WriteClient, identity, new PendingLedger(authorHex), undefined, undefined, null, null, null, null, cache);
    const appbar = document.createElement('div');
    const feedEl = document.createElement('section'); feedEl.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feedEl, panes);
    app.mount(appbar, feedEl, panes);
    (app as unknown as { cachePostFromSubmit(c: string): (info: { signedTx: UtxoTransaction; txId: string }) => void })
      .cachePostFromSubmit('silent')({ signedTx, txId });
    await settle();
    expect(await cache.thread(computePostId(txId, 0))).toBeNull();
  });

  it('the submit\'s own entry survives an eviction that takes others', async () => {
    const { signedTx, txId, authorHex } = signTx('own');
    const { cache } = makeCache();
    await cache.open('C');
    const identity = {
      current: () => ({ pubKeyHex: authorHex, locked: false }), sign: async () => ({ signature: '00' }),
      draft: async () => ({ pubKeyHex: '' }), create: async () => ({ pubKeyHex: '' }),
      discardDraft: () => {}, inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: '' }),
      importFile: async () => ({ pubKeyHex: '' }), exportFile: async () => '',
      unlock: async () => {}, lock: async () => {}, forget: async () => {}, backedUp: () => false, onChange: () => {},
    };
    const verifier: PostsVerifier = { check: (rows) => checkPosts(rows) };
    const app = new App(makeApi({ feedCalls: [], feedRes: { posts: [], next: null, pending: [], pendingCount: 0 }, threadCalls: [], threadRes: null, threadThrows: false, postRes: null }), {} as unknown as WriteClient, identity, new PendingLedger(authorHex), undefined, undefined, null, null, null, verifier, cache, emptyResolver());
    const appbar = document.createElement('div');
    const feedEl = document.createElement('section'); feedEl.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feedEl, panes);
    app.mount(appbar, feedEl, panes);
    (app as unknown as { cachePostFromSubmit(c: string): (info: { signedTx: UtxoTransaction; txId: string }) => void })
      .cachePostFromSubmit('own')({ signedTx, txId });
    await settle();
    const ownId = computePostId(txId, 0);
    expect(await cache.thread(ownId)).not.toBeNull();
    // Fill the cache with other, non-own entries that push over the cap.
    const { POST_CACHE_BYTES } = await import('../src/model/state');
    const half = Math.floor(POST_CACHE_BYTES * 0.6);
    for (let i = 0; i < 3; i++) {
      await cache.put({ id: hid('f' + i), txBytes: new Uint8Array(half), row: row('f' + i), author: 'cc'.repeat(32), parent: null, own: false });
    }
    expect(await cache.thread(ownId)).not.toBeNull();
  });
});

// -------- F2: the cached thread is written through putThreadRows, so a
// withdrawal the client has seen land stays final, and no answer overwrites
// a newer one (WEB_INTERFACE → Reading the feed and threads → "No answer
// overwrites a newer one").

describe('app-post-cache — a cached thread goes through putThreadRows', () => {
  it('a post the client saw withdrawn renders withdrawn when the cache still holds its text', async () => {
    const subject = row('w');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache } = makeCache();
    await cache.open('C');
    const BS = BOUND(subject);
    if (BS.status !== 'bound') throw new Error('invariant');
    await cache.put({ id: subject.id, txBytes: BS.txBytes, row: subject, author: subject.author, parent: null, own: false });

    const h = harness({ verifier: sv.verifier, cache, threadThrows: true });
    // Record the withdrawal: as the App would after `nothing-to-bind` saw a
    // withdrawn row land. `withdrawnSeen` is the private map keyed by id.
    const w = tomb('w');
    (h.app as unknown as { withdrawnSeen: Map<string, WithdrawnJson> }).withdrawnSeen.set(subject.id, w);
    await h.drive.fetchThread(subject.id);
    await settle();
    const t = h.drive.state.threads.get(subject.id)!;
    expect(t.root).not.toBeNull();
    expect((t.root as WithdrawnJson).kind).toBe('withdrawn');
  });

  it('a cache answer arriving after a node change writes nothing', async () => {
    const subject = row('r');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const { cache: inner } = makeCache();
    await inner.open('C');
    const BS = BOUND(subject);
    if (BS.status !== 'bound') throw new Error('invariant');
    await inner.put({ id: subject.id, txBytes: BS.txBytes, row: subject, author: subject.author, parent: null, own: false });
    // Wrap the cache so a thread() read waits on a gate the test controls.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wrapped: PostCache = {
      open: (c) => inner.open(c),
      put: (e) => inner.put(e),
      withdraw: (i, r) => inner.withdraw(i, r),
      thread: async (i) => { await gate; return inner.thread(i); },
      getMany: (ids) => inner.getMany(ids),
      refresh: (rs) => inner.refresh(rs),
    };
    const h = harness({ verifier: sv.verifier, cache: wrapped, threadThrows: true });
    void h.drive.fetchThread(subject.id);
    // Bump the readerGen as a node change would, before the cache answers.
    (h.app as unknown as { readerGen: number }).readerGen += 1;
    release();
    await settle();
    const t = h.drive.state.threads.get(subject.id)!;
    // The cache's rows were dropped by the generation guard.
    expect(t.root).toBeNull();
  });
});

// -------- The tip run opens the cache under the chain it names, and a run
// naming another chain reopens it there (WEB_INTERFACE → The extension →
// "The post cache": "The database is named for the chain").

describe('app-post-cache — the cache opens under the chain the tip run names', () => {
  function anchor(): import('@dagsocial/nipopow-client').Anchor {
    return { tip: null, suffixHead: null, suffixEnd: null, headers: [] } as unknown as import('@dagsocial/nipopow-client').Anchor;
  }

  it('a run naming chain X opens under X; a second X does not reopen; a run naming Y reopens', async () => {
    const { cache } = makeCache();
    const opens: string[] = [];
    const wrapped: PostCache = {
      open: (c) => { opens.push(c); return cache.open(c); },
      put: (e) => cache.put(e),
      withdraw: (i, r) => cache.withdraw(i, r),
      thread: (i) => cache.thread(i),
      getMany: (ids) => cache.getMany(ids),
      refresh: (rs) => cache.refresh(rs),
    };
    const chains = ['X', 'X', 'Y'];
    let i = 0;
    const verifier: TipVerifier = {
      run: async (): Promise<TipRun> => {
        const chain = chains[i++]!;
        return { verdict: { kind: 'verified', nodes: 2, height: 10 }, anchor: anchor(), chain };
      },
    };
    const sv: PostsVerifier = { check: (rows) => rows.map(() => NOTHING_TO_BIND) };
    const api = makeApi({ feedCalls: [], feedRes: { posts: [], next: null, pending: [], pendingCount: 0 }, threadCalls: [], threadRes: null, threadThrows: false, postRes: null });
    const identity = {
      current: () => null, sign: async () => ({ signature: '00' }),
      draft: async () => ({ pubKeyHex: '' }), create: async () => ({ pubKeyHex: '' }),
      discardDraft: () => {}, inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: '' }),
      importFile: async () => ({ pubKeyHex: '' }), exportFile: async () => '',
      unlock: async () => {}, lock: async () => {}, forget: async () => {}, backedUp: () => false, onChange: () => {},
    };
    const { prefs } = await import('../src/prefs');
    prefs.node = 'http://x';
    const app = new App(api, {} as unknown as WriteClient, identity, new PendingLedger(null), undefined, undefined, verifier, null, null, sv, wrapped, emptyResolver());
    const appbar = document.createElement('div');
    const feedEl = document.createElement('section'); feedEl.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    document.body.append(appbar, feedEl, panes);
    app.mount(appbar, feedEl, panes);
    const drive = app as unknown as { startVerification(): void };
    // First run — chain X — opens under X.
    drive.startVerification();
    await settle();
    expect(opens).toEqual(['X']);
    // Second run — same chain — the open guard holds, no reopen.
    drive.startVerification();
    await settle();
    expect(opens).toEqual(['X']);
    // Third run — chain Y — opens under Y.
    drive.startVerification();
    await settle();
    expect(opens).toEqual(['X', 'Y']);
  });
});
