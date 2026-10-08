// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppState, PostsVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type {
  PostJson, PostResult, StatusResult, ThreadResult, FeedResult, BlockCurrent, WithdrawnJson,
} from '../src/api/dto';
import { contentHashHex } from '../src/integrity';

// The App's post-check wiring (WEB_INTERFACE → The extension → "The post
// check"): every row of a read passes through the verifier before it enters
// state; `bound` and `nothing-to-bind` enter, `unbound` is counted in the
// list's withheld line, `unserved` is dropped and uncounted. The web build
// is handed no verifier; it sends no `tx` on the three reads and shows every
// row the node serves.

const ME = 'aa'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function status(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 10, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function row(label: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id: hid(label), content: label, contentHash: contentHashHex(label),
    author: ME, parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed', blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: hid('tx' + label), tx: 'de'.repeat(16),
    ...over,
  };
}
function tomb(label: string): WithdrawnJson {
  return {
    kind: 'withdrawn', id: hid(label), author: ME, withdrawnAtHeight: 10,
    parentRefs: [], descendantCount: 0, authorName: null, txId: hid('tx' + label),
  };
}
const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

/** A verifier whose check() is scripted by a function the test owns. Also
 *  records every call so the test can count batches. */
function scriptedVerifier(decide: (row: unknown, idx: number) => PostCheck): {
  verifier: PostsVerifier;
  calls: Array<unknown[]>;
} {
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
  feedCalls: Array<{ withTx: boolean | undefined; url: string }>;
  feedRes: FeedResult;
  threadCalls: Array<{ withTx: boolean | undefined; id: string }>;
  threadRes: ThreadResult | null;
  postCalls: Array<{ withTx: boolean | undefined; id: string }>;
  postRes: PostResult | null;
}

function makeApi(f: Fake): Api {
  return {
    feed: async (_page, _viewer, _author, roots, withTx): Promise<FeedResult> => {
      f.feedCalls.push({ withTx, url: `/posts?roots=${roots ? 1 : 0}&tx=${withTx ? 1 : 0}` });
      return f.feedRes;
    },
    thread: async (id, _page, _viewer, withTx): Promise<ThreadResult | null> => {
      f.threadCalls.push({ withTx, id });
      return f.threadRes;
    },
    post: async (id, _viewer, withTx): Promise<PostResult | null> => {
      f.postCalls.push({ withTx, id });
      return f.postRes;
    },
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
  feedRes?: FeedResult;
  threadRes?: ThreadResult | null;
  postRes?: PostResult | null;
} = {}) {
  const fake: Fake = {
    feedCalls: [], feedRes: opts.feedRes ?? { posts: [], next: null, pending: [], pendingCount: 0 },
    threadCalls: [], threadRes: opts.threadRes ?? null,
    postCalls: [], postRes: opts.postRes ?? null,
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
  const app = new App(api, writeClient, identity, ledger, undefined, undefined, null, null, null, opts.verifier ?? null);
  const appbar = document.createElement('div');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feedEl, panes);
  app.mount(appbar, feedEl, panes);
  const drive = app as unknown as {
    loadFeed(): Promise<void>;
    refreshFeed(): Promise<void>;
    loadOlder(): Promise<void>;
    openThread(id: string, o: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    openAuthorPosts(key: string, o: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    state: AppState;
  };
  return { app, drive, fake, feedEl, panes };
}

beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; vi.useRealTimers(); });

const BOUND = (r: PostJson): PostCheck =>
  ({ status: 'bound', id: r.id, txBytes: new Uint8Array(0), author: r.author, parent: r.parentRefs[0] ?? null });
const UNBOUND: PostCheck = { status: 'unbound', reason: 'signature', verdict: 'unbound: the author signed something else' };
const NOTHING_TO_BIND: PostCheck = { status: 'nothing-to-bind' };
const UNSERVED: PostCheck = { status: 'unserved' };

describe('post-check — the feed, the author window, the thread render as with no verifier when every row is bound', () => {
  it('feed: three bound rows all render; no clay line', async () => {
    const a = row('a'), b = row('b'), c = row('c');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, b, c], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([a.id, b.id, c.id]);
    expect(h.drive.state.feed.unboundCount).toBe(0);
    expect(h.feedEl.querySelector('.withheld')).toBeNull();
  });
});

describe('post-check — a swap row is withheld; the line counts it', () => {
  it("the swap row is absent from the feed and counted; its page's other rows render", async () => {
    const a = row('a'), bad = row('b'), c = row('c');
    const sv = scriptedVerifier((r) => (r === bad ? UNBOUND : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, bad, c], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([a.id, c.id]);
    expect(h.drive.state.feed.unboundCount).toBe(1);
    const line = h.feedEl.querySelector('.withheld');
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe('1 post withheld — it does not match its signature');
    expect(line!.classList.contains('clay')).toBe(true);
  });

  it('the line reads plural when more than one is withheld', async () => {
    const a = row('a'), bad1 = row('b'), bad2 = row('c'), d = row('d');
    const sv = scriptedVerifier((r) => (r === bad1 || r === bad2 ? UNBOUND : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, bad1, bad2, d], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.unboundCount).toBe(2);
    const line = h.feedEl.querySelector('.withheld');
    expect(line!.textContent).toBe('2 posts withheld — they do not match their signatures');
  });

  it('refresh resets the count; the line goes when it is zero', async () => {
    const a = row('a'), bad = row('b');
    let returnBad = true;
    const sv = scriptedVerifier((r) => (returnBad && r === bad ? UNBOUND : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, bad], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.unboundCount).toBe(1);
    returnBad = false;
    h.fake.feedRes = { posts: [a, bad], next: null, pending: [], pendingCount: 0 };
    await h.drive.refreshFeed();
    await flush();
    expect(h.drive.state.feed.unboundCount).toBe(0);
    expect(h.feedEl.querySelector('.withheld')).toBeNull();
  });

  it('a `load older` adds to the standing count', async () => {
    const a = row('a'), b = row('b');
    const c = row('c'), bad = row('d');
    const sv = scriptedVerifier((r) => (r === bad ? UNBOUND : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, b], next: 'cur', pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.unboundCount).toBe(0);
    h.fake.feedRes = { posts: [c, bad], next: null, pending: [], pendingCount: 0 };
    await h.drive.loadOlder();
    await flush();
    expect(h.drive.state.feed.unboundCount).toBe(1);
  });
});

describe('post-check — unserved and nothing-to-bind', () => {
  it('an unserved row is absent from the feed and the line does not count it', async () => {
    const a = row('a'), gone = row('b', { tx: null });
    const sv = scriptedVerifier((r) => (r === gone ? UNSERVED : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, gone], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([a.id]);
    expect(h.drive.state.feed.unboundCount).toBe(0);
    expect(h.feedEl.querySelector('.withheld')).toBeNull();
  });

  it('a row that carries no tx key is unbound and counted', async () => {
    const a = row('a');
    // The row has no `tx` field at all — `no-tx` reason.
    const noTxRow: PostJson = { ...row('b') };
    delete noTxRow.tx;
    const sv = scriptedVerifier((r) => (r === noTxRow
      ? { status: 'unbound', reason: 'no-tx', verdict: 'unbound: no tx' }
      : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, noTxRow], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.unboundCount).toBe(1);
  });

  it('a withdrawn row (nothing-to-bind) renders as it does today', async () => {
    const a = row('a'), w = tomb('b');
    const sv = scriptedVerifier((r) => (r === w ? NOTHING_TO_BIND : BOUND(r as PostJson)));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, w], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    // Withdrawn rows are filtered out of the feed by its own existing rule
    // (not by the post check): the point is that nothing-to-bind does not
    // count toward the withheld line.
    expect(h.drive.state.feed.unboundCount).toBe(0);
  });
});

describe('post-check — a thread whose subject is unbound', () => {
  it('shows the clay line and nothing of the node\'s row', async () => {
    const subject = row('r');
    const d = row('d');
    const sv = scriptedVerifier((r) => (r === subject ? UNBOUND : BOUND(r as PostJson)));
    const thread: ThreadResult = {
      post: subject, ancestors: [], ancestorCount: 0,
      descendants: [d], descendantCount: 1, next: null, pending: [], pendingCount: 0,
    };
    const h = harness({ verifier: sv.verifier, threadRes: thread });
    h.drive.openThread(subject.id, { from: 'feed' });
    await flush();
    const t = h.drive.state.threads.get(subject.id)!;
    expect(t.subjectUnbound).toBe(true);
    expect(t.root).toBeNull();
    expect(t.unboundCount).toBe(1);
  });
});

describe('post-check — the single post read', () => {
  it('an unbound answer is used for nothing', async () => {
    const subject = row('p');
    const sv = scriptedVerifier(() => UNBOUND);
    const h = harness({ verifier: sv.verifier });
    // Call the private ingestOne through the state's single-row gate: the
    // reconciliation path uses it, so an unbound answer reads as a 404.
    const app = h.app as unknown as { ingestOne(r: PostJson | WithdrawnJson): PostJson | WithdrawnJson | null };
    expect(app.ingestOne(subject)).toBeNull();
    expect(sv.calls.length).toBe(1);
  });
});

describe('post-check — the web build is handed no verifier', () => {
  it('no feed request carries tx; every row renders; no line', async () => {
    const a = row('a'), b = row('b');
    const h = harness({ verifier: null, feedRes: { posts: [a, b], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(h.fake.feedCalls.every((c) => c.withTx === false || c.withTx === undefined)).toBe(true);
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(h.drive.state.feed.unboundCount).toBe(0);
    expect(h.feedEl.querySelector('.withheld')).toBeNull();
  });

  it('no thread request carries tx', async () => {
    const subject = row('p');
    const thread: ThreadResult = {
      post: subject, ancestors: [], ancestorCount: 0,
      descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0,
    };
    const h = harness({ verifier: null, threadRes: thread });
    h.drive.openThread(subject.id, { from: 'feed' });
    await flush();
    expect(h.fake.threadCalls.every((c) => c.withTx === false || c.withTx === undefined)).toBe(true);
  });
});

describe('post-check — one check call per read', () => {
  it('a feed first page is one batch', async () => {
    const a = row('a'), b = row('b'), c = row('c');
    const sv = scriptedVerifier((r) => BOUND(r as PostJson));
    const h = harness({ verifier: sv.verifier, feedRes: { posts: [a, b, c], next: null, pending: [], pendingCount: 0 } });
    await h.drive.loadFeed();
    await flush();
    expect(sv.calls.length).toBe(1);
    // The batch covers posts + pending.
    expect(sv.calls[0]!.length).toBe(3);
  });
});
