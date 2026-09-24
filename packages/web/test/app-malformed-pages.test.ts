// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { NodeClient, PageError } from '../src/api/client';
import { PendingLedger } from '../src/wallet/ledger';
import { readBuildContext, readCreditContext } from '../src/wallet/reads';
import type { AppIdentity, AuthorWindowData, FeedState, ThreadState } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BondsResult, CreditsResult, KarmaResult, PostJson, StatusResult } from '../src/api/dto';
import type { PendingEntry } from '../src/wallet/types';
import type { Flight } from '../src/view/card';
import { karmaResult } from './karma-fixture';
import { prefs, setNode } from '../src/prefs';

// A page that is not a page throws in the read client, where a non-2xx throws
// (NODE_INTERFACE → "Every list a view returns is a page"), so every loop that
// follows `next` ends at it in its caller's failure path, a refresh re-reads no
// first page, and no read that brought one stores its cursor (WEB_INTERFACE →
// "Paging is keyset, never offset"). The App runs over the real NodeClient and a
// scripted fetch; each malformed script answers a last page once a route has
// been asked CAP times, so a client that follows the page ends and the request
// count shows it.

const ME = 'aa'.repeat(32);
const X = 'cd'.repeat(32);
const P = '31'.repeat(32);
const T = '41'.repeat(32);
const [A, B, C, D] = ['51', '52', '53', '54'].map((b) => b.repeat(32)) as [string, string, string, string];
const [R1, R2] = ['61', '62'].map((b) => b.repeat(32)) as [string, string];
const [B1, B2, B3] = ['71', '72', '73'].map((b) => b.repeat(32)) as [string, string, string];
const HEIGHT = 1070;
const CAP = 12;
const LONE_SURROGATE = JSON.parse('"\\ud800"') as string;
const NOT_A_PAGE = "the node's answer is not a page";

type Route =
  | 'feed' | 'thread' | 'post' | 'status' | 'currentBlock' | 'karma' | 'credits'
  | 'vouchesByTarget' | 'vouchesByVoucher' | 'vouchCooldowns' | 'bonds' | 'usernames';

interface Req { route: Route; key: string | null; after: string | null }
interface Answer { status: number; body: unknown }
type Handler = (req: Req, nth: number) => Answer;

const ok = (body: unknown): Answer => ({ status: 200, body });
const NOT_FOUND: Answer = { status: 404, body: {} };

function classify(u: URL): { route: Route; key: string | null } {
  const p = u.pathname;
  const q = u.searchParams;
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/karma\/([^/]+)$/))) return { route: 'karma', key: m[1]! };
  if ((m = p.match(/^\/credits\/([^/]+)$/))) return { route: 'credits', key: m[1]! };
  if ((m = p.match(/^\/invites\/([^/]+)$/))) return { route: 'bonds', key: m[1]! };
  if (p === '/vouches') {
    if (q.has('target')) return { route: 'vouchesByTarget', key: q.get('target') };
    if (q.has('cooldowns')) return { route: 'vouchCooldowns', key: q.get('voucher') };
    return { route: 'vouchesByVoucher', key: q.get('voucher') };
  }
  if ((m = p.match(/^\/posts\/([^/]+)\/thread$/))) return { route: 'thread', key: m[1]! };
  if ((m = p.match(/^\/posts\/([^/]+)$/))) return { route: 'post', key: m[1]! };
  if (p === '/posts') return { route: 'feed', key: q.get('author') };
  if (p === '/status') return { route: 'status', key: null };
  if (p === '/blocks/current') return { route: 'currentBlock', key: null };
  if (p.startsWith('/usernames')) return { route: 'usernames', key: null };
  throw new Error(`no route for ${u.href}`);
}

function statusAt(height: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight: height, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000', membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
  };
}

function post(id: string, author: string): PostJson {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 1000, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
  };
}

const feedPage = (ids: string[], next: unknown, author = X): Record<string, unknown> =>
  ({ posts: ids.map((id) => post(id, author)), next, pending: [], pendingCount: 0 });
const threadPage = (ids: string[], next: unknown): Record<string, unknown> => ({
  post: post(T, X), ancestors: [], ancestorCount: 0, descendants: ids.map((id) => post(id, X)),
  descendantCount: ids.length, next, pending: [], pendingCount: 0,
});
const karmaPage = (key: string, ids: string[], next: unknown): Record<string, unknown> => ({
  ...karmaResult({
    userId: key, total: '219', effective: '219', boxes: ids.map((boxId) => ({ boxId, value: '73' })),
    boxCount: ids.length, height: HEIGHT, member: true, memberSinceBlock: 5, invitesAvailable: 2,
  }),
  next,
});
const creditsPage = (key: string, ids: string[], next: unknown): Record<string, unknown> =>
  ({ userId: key, total: '1250000000', boxes: ids.map((boxId) => ({ boxId, value: '1250000000' })), boxCount: ids.length, next });
const vouchesPage = (next: unknown): Record<string, unknown> => ({ vouches: [], count: 0, next });
const cooldownsPage = (next: unknown): Record<string, unknown> => ({ cooldowns: [], count: 0, next });
const bondsPage = (next: unknown): Record<string, unknown> => ({ bonds: [], bondCount: 0, next });

function without(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[field];
  return copy;
}

/** A malformed answer until the route has been asked CAP times, then a last page. */
const capped = (malformed: (req: Req) => unknown, last: unknown): Handler =>
  (req, nth) => ok(nth > CAP ? last : malformed(req));

function fakeNode() {
  const requests: Req[] = [];
  const handlers = new Map<Route, Handler>();
  const defaults: Record<Route, Handler> = {
    feed: () => ok(feedPage([], null)),
    thread: () => NOT_FOUND,
    post: () => NOT_FOUND,
    status: () => ok(statusAt(HEIGHT)),
    currentBlock: () => ok({ height: HEIGHT, hash: null }),
    karma: (r) => ok(karmaPage(r.key ?? ME, [B1], null)),
    credits: (r) => ok(creditsPage(r.key ?? ME, [B1], null)),
    vouchesByTarget: () => ok(vouchesPage(null)),
    vouchesByVoucher: () => ok(vouchesPage(null)),
    vouchCooldowns: () => ok(cooldownsPage(null)),
    bonds: () => ok(bondsPage(null)),
    usernames: () => NOT_FOUND,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), 'http://node.test');
    const { route, key } = classify(u);
    const req: Req = { route, key, after: u.searchParams.get('after') };
    requests.push(req);
    const nth = requests.filter((r) => r.route === route).length;
    const a = (handlers.get(route) ?? defaults[route])(req, nth);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, statusText: String(a.status), json: async () => a.body } as Response;
  }));
  return {
    on(route: Route, h: Handler): void { handlers.set(route, h); },
    count(route: Route, key?: string): number {
      return requests.filter((r) => r.route === route && (key === undefined || r.key === key)).length;
    },
  };
}

function identity(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: ME, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  };
}

interface Drive {
  loadMembershipState(): Promise<void>;
  refreshOwnKarma(): Promise<void>;
  refreshWalletCredits(): Promise<void>;
  pollTick(): Promise<void>;
  loadFeed(): Promise<void>;
  refreshFeed(): Promise<void>;
  loadOlder(): Promise<void>;
  fetchThread(id: string): Promise<void>;
  refreshThread(id: string): Promise<void>;
  threadMore(id: string): Promise<void>;
  ensureAuthorData(key: string): string;
  loadAuthorData(key: string): Promise<void>;
  moreEndorsers(key: string): Promise<void>;
  ensurePostsData(key: string): string;
  loadAuthorPosts(key: string): Promise<void>;
  refreshAuthorPosts(key: string): Promise<void>;
  authorPostsMore(key: string): Promise<void>;
  moreBonds(): Promise<void>;
  likePost(id: string): Promise<void>;
  unvouch(key: string): Promise<void>;
  send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
  profileKarma: KarmaResult | null;
  walletCredits: CreditsResult | null;
  bondsView: BondsResult | null;
  sendFlight: Flight | null;
  authorData: Map<string, AuthorWindowData>;
  authorPostsData: Map<string, FeedState>;
  state: { feed: FeedState; threads: Map<string, ThreadState> };
}

interface Harness { node: ReturnType<typeof fakeNode>; ledger: PendingLedger; drive: Drive }

function harness(entries: PendingEntry[] = []): Harness {
  const node = fakeNode();
  const ledger = new PendingLedger(ME);
  for (const e of entries) ledger.add(e);
  const app = new App(new NodeClient(() => ''), {} as unknown as WriteClient, identity(), ledger, undefined, undefined, null, null);
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);
  return { node, ledger, drive: app as unknown as Drive };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const GRANT: PendingEntry = { txId: 'e1'.repeat(32), kind: 'grant', postId: ME, inputs: [], expiresAtHeight: 5000, submittedAtHeight: 1060 };
const CREDIT_GRANT: PendingEntry = { txId: 'e2'.repeat(32), kind: 'creditGrant', postId: B2, inputs: [], expiresAtHeight: 5000, submittedAtHeight: 1060 };
const SEND: PendingEntry = {
  txId: 'e3'.repeat(32), kind: 'send', postId: X, inputs: [B1], expiresAtHeight: 5000, submittedAtHeight: 1060,
  send: { toHex: X, toName: null, amount: 100000000n, boxId: 'e4'.repeat(32) },
};

beforeEach(() => {
  // The poll and the corner run on intervals; a test ticks the poll by hand.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The reader's own listings — the five call sites of readOwnKarma and
// readOwnCredits, each against five shapes
// ---------------------------------------------------------------------------

type ListingPage = (ids: string[], next: unknown) => Record<string, unknown>;

const SHAPES: Array<{ name: string; requests: number; answer: (after: string | null, page: ListingPage) => unknown }> = [
  { name: 'a first page with no `next`', requests: 1, answer: (_after, page) => without(page([B1], null), 'next') },
  {
    name: 'a following page with no `next`', requests: 2,
    answer: (after, page) => (after === null ? page([B1], 'k1') : without(page([B2], null), 'next')),
  },
  { name: 'a numeric `next`', requests: 1, answer: (_after, page) => page([B1], 7) },
  { name: 'a `next` holding a lone surrogate', requests: 1, answer: (_after, page) => page([B1], `5:${LONE_SURROGATE}`) },
  { name: 'a `boxes` that is not an array', requests: 1, answer: (_after, page) => ({ ...page([B1], null), boxes: 'abc' }) },
];

interface Held { karma: KarmaResult | null; credits: CreditsResult | null }

const SITES: Array<{
  name: string;
  listing: 'karma' | 'credits';
  entries: PendingEntry[];
  run(d: Drive): Promise<void>;
  kept(h: Harness, held: Held): void;
}> = [
  {
    name: 'the membership read (loadMembershipState) keeps the last listing',
    listing: 'karma', entries: [],
    run: (d) => d.loadMembershipState(),
    kept: (h, held) => expect(h.drive.profileKarma).toBe(held.karma),
  },
  {
    name: 'the rep row\'s re-read (refreshOwnKarma) keeps the last listing',
    listing: 'karma', entries: [],
    run: (d) => d.refreshOwnKarma(),
    kept: (h, held) => expect(h.drive.profileKarma).toBe(held.karma),
  },
  {
    name: 'the tick\'s /karma read keeps the grant pending and the last listing',
    listing: 'karma', entries: [GRANT],
    run: (d) => d.pollTick(),
    kept: (h, held) => {
      expect(h.ledger.size).toBe(1);
      expect(h.drive.profileKarma).toBe(held.karma);
    },
  },
  {
    name: 'the balance row\'s re-read (refreshWalletCredits) keeps the last listing',
    listing: 'credits', entries: [],
    run: (d) => d.refreshWalletCredits(),
    kept: (h, held) => expect(h.drive.walletCredits).toBe(held.credits),
  },
  {
    name: 'the tick\'s /credits read keeps the credits grant pending and the last listing',
    listing: 'credits', entries: [CREDIT_GRANT],
    run: (d) => d.pollTick(),
    kept: (h, held) => {
      expect(h.ledger.size).toBe(1);
      expect(h.drive.walletCredits).toBe(held.credits);
    },
  },
];

describe('the reader\'s own listing reads end on a malformed page, in their callers\' failure paths', () => {
  for (const site of SITES) {
    for (const shape of SHAPES) {
      it(`${site.name} — ${shape.name}: ${shape.requests} request${shape.requests === 1 ? '' : 's'}`, async () => {
        const h = harness(site.entries);
        await h.drive.refreshOwnKarma();
        await h.drive.refreshWalletCredits();
        const held: Held = { karma: h.drive.profileKarma, credits: h.drive.walletCredits };
        expect(held.karma).not.toBeNull();
        expect(held.credits).not.toBeNull();

        const page: ListingPage = site.listing === 'karma'
          ? (ids, next) => karmaPage(ME, ids, next)
          : (ids, next) => creditsPage(ME, ids, next);
        h.node.on(site.listing, capped((req) => shape.answer(req.after, page), page([], null)));
        const before = h.node.count(site.listing, ME);
        await site.run(h.drive);
        await flush();
        expect(h.node.count(site.listing, ME) - before).toBe(shape.requests);
        site.kept(h, held);
      });
    }
  }

  for (const listing of ['karma', 'credits'] as const) {
    it(`an honest three-page /${listing} is still read whole`, async () => {
      const h = harness();
      const page: ListingPage = listing === 'karma'
        ? (ids, next) => karmaPage(ME, ids, next)
        : (ids, next) => creditsPage(ME, ids, next);
      h.node.on(listing, (req) => ok(
        req.after === null ? page([B1], 'k1') : req.after === 'k1' ? page([B2], 'k2') : page([B3], null),
      ));
      if (listing === 'karma') await h.drive.refreshOwnKarma();
      else await h.drive.refreshWalletCredits();
      expect(h.node.count(listing, ME)).toBe(3);
      const read = listing === 'karma' ? h.drive.profileKarma : h.drive.walletCredits;
      expect(read?.boxes.map((b) => b.boxId)).toEqual([B1, B2, B3]);
      expect(read?.boxCount).toBe(3);
      expect(read?.next).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Every other loop that follows `next`, against a node answering no `next`
// ---------------------------------------------------------------------------

describe('every other loop that follows `next` ends at a page with no `next`', () => {
  it('the vouch set (readVouchSet) — one request, the membership read keeps what it held', async () => {
    const h = harness();
    await h.drive.refreshOwnKarma();
    const held = h.drive.profileKarma;
    h.node.on('vouchesByVoucher', capped(() => without(vouchesPage(null), 'next'), vouchesPage(null)));
    const before = h.node.count('vouchesByVoucher', ME);
    await h.drive.loadMembershipState();
    expect(h.node.count('vouchesByVoucher', ME) - before).toBe(1);
    expect(h.drive.profileKarma).toBe(held);
  });

  it('the escrow (readEscrow) — one request, the membership read keeps what it held', async () => {
    const h = harness();
    await h.drive.refreshOwnKarma();
    const held = h.drive.profileKarma;
    h.node.on('vouchCooldowns', capped(() => without(cooldownsPage(null), 'next'), cooldownsPage(null)));
    const before = h.node.count('vouchCooldowns', ME);
    await h.drive.loadMembershipState();
    expect(h.node.count('vouchCooldowns', ME) - before).toBe(1);
    expect(h.drive.profileKarma).toBe(held);
  });

  it('a send\'s recipient listing (readAllCreditBoxes) — one request, the send stays pending', async () => {
    const h = harness([SEND]);
    h.node.on('credits', capped(
      (req) => (req.key === X ? without(creditsPage(X, [B2], null), 'next') : creditsPage(ME, [B1], null)),
      creditsPage(X, [], null),
    ));
    await h.drive.pollTick();
    expect(h.node.count('credits', X)).toBe(1);
    expect(h.ledger.size).toBe(1);
  });

  it('the reads before a rep write (readBuildContext) — one request, then PageError', async () => {
    const h = fakeNode();
    h.on('karma', capped(() => without(karmaPage(ME, [B1], null), 'next'), karmaPage(ME, [], null)));
    await expect(readBuildContext(new NodeClient(() => ''), new PendingLedger(ME), ME)).rejects.toBeInstanceOf(PageError);
    expect(h.count('karma', ME)).toBe(1);
  });

  it('a like whose reads meet it ends in *like rejected: can\'t reach the node right now.*', async () => {
    const h = harness();
    h.node.on('feed', () => ok(feedPage([P], null)));
    await h.drive.loadFeed();
    h.node.on('post', (req) => (req.key === P ? ok({ ...post(P, X), confirmedAuthor: X }) : NOT_FOUND));
    h.node.on('karma', capped(() => without(karmaPage(ME, [B1], null), 'next'), karmaPage(ME, [], null)));
    const before = h.node.count('karma', ME);
    await h.drive.likePost(P);
    expect(h.node.count('karma', ME) - before).toBe(1);
    expect(h.drive.state.feed.report).toBe("like rejected: can't reach the node right now.");
  });

  it('the reads before a send (readCreditContext) — one request, then PageError', async () => {
    const h = fakeNode();
    h.on('credits', capped(() => without(creditsPage(ME, [B1], null), 'next'), creditsPage(ME, [], null)));
    await expect(readCreditContext(new NodeClient(() => ''), new PendingLedger(ME), ME)).rejects.toBeInstanceOf(PageError);
    expect(h.count('credits', ME)).toBe(1);
  });

  it('a send whose reads meet it ends in *send rejected: can\'t reach the node right now.*', async () => {
    const h = harness();
    h.node.on('credits', capped(() => without(creditsPage(ME, [B1], null), 'next'), creditsPage(ME, [], null)));
    const before = h.node.count('credits', ME);
    await h.drive.send(X, null, 100000000n);
    expect(h.node.count('credits', ME) - before).toBe(1);
    expect(h.drive.sendFlight).toEqual({ stage: 'rejected', reason: "send rejected: can't reach the node right now." });
  });

  it('an unvouch resolving its box (resolveVouchBox) — one request, *unvouch rejected: can\'t reach the node right now.*', async () => {
    const h = harness();
    h.drive.ensureAuthorData(X);
    h.node.on('vouchesByVoucher', capped(() => without(vouchesPage(null), 'next'), vouchesPage(null)));
    await h.drive.unvouch(X);
    expect(h.node.count('vouchesByVoucher', ME)).toBe(1);
    expect(h.drive.authorData.get(X)?.flight).toEqual({ stage: 'rejected', reason: "unvouch rejected: can't reach the node right now." });
  });
});

// ---------------------------------------------------------------------------
// The capped refreshes re-read no first page
// ---------------------------------------------------------------------------

describe('a refresh meeting a page with no `next` re-reads no first page and duplicates no row', () => {
  it('the thread\'s ↻ — one request, the error line, the rows it held', async () => {
    const h = harness();
    h.node.on('thread', () => ok(threadPage([R1, R2], null)));
    await h.drive.fetchThread(T);
    h.node.on('thread', capped(() => without(threadPage([R1, R2], null), 'next'), threadPage([], null)));
    const before = h.node.count('thread', T);
    await h.drive.refreshThread(T);
    const t = h.drive.state.threads.get(T)!;
    expect(h.node.count('thread', T) - before).toBe(1);
    expect(t.error).toBe(NOT_A_PAGE);
    expect(t.descendants.map((r) => r.id)).toEqual([R1, R2]);
  });

  it('the feed\'s ↻ (reconcileNewer) — one request, the error line, the rows it held', async () => {
    const h = harness();
    h.node.on('feed', () => ok(feedPage([A, B], null)));
    await h.drive.loadFeed();
    h.node.on('feed', capped(() => without(feedPage([C, D], null), 'next'), feedPage([], null)));
    const before = h.node.count('feed');
    await h.drive.refreshFeed();
    expect(h.node.count('feed') - before).toBe(1);
    expect(h.drive.state.feed.error).toBe(NOT_A_PAGE);
    expect(h.drive.state.feed.posts.map((p) => p.id)).toEqual([A, B]);
  });

  it('a posts window\'s ↻ (reconcileNewer) — one request, the error line, the rows it held', async () => {
    const h = harness();
    h.drive.ensurePostsData(X);
    h.node.on('feed', () => ok(feedPage([A, B], null)));
    await h.drive.loadAuthorPosts(X);
    h.node.on('feed', capped(() => without(feedPage([C, D], null), 'next'), feedPage([], null)));
    const before = h.node.count('feed', X);
    await h.drive.refreshAuthorPosts(X);
    const f = h.drive.authorPostsData.get(X)!;
    expect(h.node.count('feed', X) - before).toBe(1);
    expect(f.error).toBe(NOT_A_PAGE);
    expect(f.posts.map((p) => p.id)).toEqual([A, B]);
  });
});

// ---------------------------------------------------------------------------
// A read that meets a malformed page stores no cursor from it
// ---------------------------------------------------------------------------

describe('no read stores the cursor of a page that is not a page', () => {
  it('the feed\'s first page with a numeric `next` — the error line, no rows, no `load older`', async () => {
    const h = harness();
    h.node.on('feed', () => ok(feedPage([A], 7)));
    await h.drive.loadFeed();
    const feed = h.drive.state.feed;
    expect(h.node.count('feed')).toBe(1);
    expect(feed.error).toBe(NOT_A_PAGE);
    expect(feed.next).toBeNull();
    expect(feed.posts).toEqual([]);
  });

  it('`load older` answered with no `next` — the cursor it continued stands', async () => {
    const h = harness();
    h.node.on('feed', (req) => ok(req.after === null ? feedPage([A], 'k1') : without(feedPage([B], null), 'next')));
    await h.drive.loadFeed();
    await h.drive.loadOlder();
    const feed = h.drive.state.feed;
    expect(feed.error).toBe(NOT_A_PAGE);
    expect(feed.next).toBe('k1');
    expect(feed.posts.map((p) => p.id)).toEqual([A]);
  });

  it('a thread\'s first page with a `next` holding a lone surrogate — the error line, no cursor', async () => {
    const h = harness();
    h.node.on('thread', () => ok(threadPage([R1], `5:${LONE_SURROGATE}`)));
    await h.drive.fetchThread(T);
    const t = h.drive.state.threads.get(T)!;
    expect(t.error).toBe(NOT_A_PAGE);
    expect(t.next).toBeNull();
    expect(t.descendants).toEqual([]);
  });

  it('a thread\'s `more` answered with an empty `next` — the cursor it continued stands', async () => {
    const h = harness();
    h.node.on('thread', (req) => ok(req.after === null ? threadPage([R1], 'k1') : threadPage([R2], '')));
    await h.drive.fetchThread(T);
    await h.drive.threadMore(T);
    const t = h.drive.state.threads.get(T)!;
    expect(t.error).toBe(NOT_A_PAGE);
    expect(t.next).toBe('k1');
    expect(t.descendants.map((r) => r.id)).toEqual([R1]);
  });

  it('the endorsers\' first page with no `next` — the window keeps no list and offers no `more`', async () => {
    const h = harness();
    h.drive.ensureAuthorData(X);
    h.node.on('vouchesByTarget', () => ok(without(vouchesPage(null), 'next')));
    await h.drive.loadAuthorData(X);
    const d = h.drive.authorData.get(X)!;
    expect(d.endorsers).toBeNull();
    expect(d.endorsersNext).toBe(false);
  });

  it('the endorsers\' `more` answered with no `next` — the list it continued stands', async () => {
    const h = harness();
    h.drive.ensureAuthorData(X);
    h.node.on('vouchesByTarget', (req) => ok(req.after === null ? vouchesPage('k1') : without(vouchesPage(null), 'next')));
    await h.drive.loadAuthorData(X);
    const d = h.drive.authorData.get(X)!;
    const from = d.endorsers;
    expect(from?.next).toBe('k1');
    await h.drive.moreEndorsers(X);
    expect(d.endorsers).toBe(from);
    expect(d.endorsersNext).toBe(true);
  });

  it('a posts window\'s first page with a numeric `next` — the error line, no cursor', async () => {
    const h = harness();
    h.drive.ensurePostsData(X);
    h.node.on('feed', () => ok(feedPage([A], 7)));
    await h.drive.loadAuthorPosts(X);
    const f = h.drive.authorPostsData.get(X)!;
    expect(f.error).toBe(NOT_A_PAGE);
    expect(f.next).toBeNull();
    expect(f.loaded).toBe(false);
  });

  it('a posts window\'s `more` answered with no `next` — the cursor it continued stands', async () => {
    const h = harness();
    h.drive.ensurePostsData(X);
    h.node.on('feed', (req) => ok(req.after === null ? feedPage([A], 'k1') : without(feedPage([B], null), 'next')));
    await h.drive.loadAuthorPosts(X);
    await h.drive.authorPostsMore(X);
    const f = h.drive.authorPostsData.get(X)!;
    expect(f.error).toBe(NOT_A_PAGE);
    expect(f.next).toBe('k1');
    expect(f.posts.map((p) => p.id)).toEqual([A]);
  });

  it('the bonds\' first page with no `next` — the membership read keeps no bonds', async () => {
    const h = harness();
    h.node.on('bonds', () => ok(without(bondsPage(null), 'next')));
    await h.drive.loadMembershipState();
    expect(h.drive.bondsView).toBeNull();
  });

  it('the bonds\' `more` answered with no `next` — the page it continued stands', async () => {
    const h = harness();
    h.node.on('bonds', (req) => ok(req.after === null ? bondsPage('k1') : without(bondsPage(null), 'next')));
    await h.drive.loadMembershipState();
    const from = h.drive.bondsView;
    expect(from?.next).toBe('k1');
    await h.drive.moreBonds();
    expect(h.drive.bondsView).toBe(from);
  });
});
