// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api, Page } from '../src/api/client';
import type { AppIdentity, AppState, AuthorWindowData, FeedState } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { FeedResult, FeedRow, PostJson, PostResult, StatusResult, ThreadResult, VouchesTargetResult, WithdrawnJson } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { prefs, setNode, KEY_LAYOUT } from '../src/prefs';
import { contentHashHex } from '../src/integrity';

// A change of the reading node drops the feed's rows before its re-read, and a
// first page that fails leaves no row — neither the node before's nor one
// carrying the viewer before's marks (WEB_INTERFACE → The settings window, →
// "An identity change takes effect at once"). A feed, thread or author-posts
// read in flight across a node or identity change writes nothing when it
// answers — no row, no report, nothing in the post index — and a seed adoption
// never overrides a node the settings row set during the walk. Every `more` and
// `load older` continues the cursor or page it was asked for. The fake answers,
// per node, what the node held as each read began; the node is the base
// `prefs.node` names then.

const ME = 'aa'.repeat(32);
const ME2 = 'ab'.repeat(32);
const X = 'cd'.repeat(32);
const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

/** A 64-hex id per label, the same on every node. */
const hid = (label: string): string =>
  [...label].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

function row(label: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id: hid(label), content: label, contentHash: contentHashHex(label), author: X, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 1000, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, ...over,
  };
}

/** One node's rows. Lists page `pageSize` at a time, keyed by the last row's id. */
interface NodeData {
  feed: PostJson[];                     // roots, newest first
  replies: Map<string, PostJson[]>;     // a root's replies, oldest first
  authored: Map<string, PostJson[]>;    // an author's posts, newest first
  endorsers: Map<string, string[]>;     // a key's vouchers, newest first
  liked: Map<string, Set<string>>;      // a viewer's liked post ids
  withdrawn: Set<string>;               // post ids answered as the withdrawn marker
  pageSize: number;
}

function node(over: Partial<NodeData> = {}): NodeData {
  return {
    feed: [], replies: new Map(), authored: new Map(), endorsers: new Map(), liked: new Map(), withdrawn: new Set(),
    pageSize: 2, ...over,
  };
}

function pageOf<T>(rows: readonly T[], idOf: (r: T) => string, after: string | null | undefined, size: number): { rows: T[]; next: string | null } {
  const start = after ? rows.findIndex((r) => idOf(r) === after) + 1 : 0;
  const slice = rows.slice(start, start + size);
  return { rows: slice, next: start + size < rows.length && slice.length > 0 ? idOf(slice[slice.length - 1]!) : null };
}

/** A row as a viewer reads it: `likedByViewer` is that viewer's, null with none;
 *  a withdrawn post is its marker. */
function seenBy(n: NodeData, r: PostJson, viewer: string | undefined): FeedRow {
  if (n.withdrawn.has(r.id)) {
    const marker: WithdrawnJson = {
      kind: 'withdrawn', id: r.id, author: r.author, withdrawnAtHeight: 1000, parentRefs: r.parentRefs, descendantCount: 0, authorName: null,
    };
    return marker;
  }
  return { ...r, likedByViewer: viewer === undefined ? null : (n.liked.get(viewer)?.has(r.id) ?? false) };
}

function statusAt(height: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight: height, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000', membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
  };
}

interface Call { method: string; base: string; key: string | undefined; after: string | null; viewer: string | undefined }
interface Held extends Call { release(): void; fail(): void }
type Pick = (c: Call) => boolean;

/** The API over several nodes, keyed by the base a read begins under. A read the
 *  `hold` predicate names waits for its `release` or `fail`; one the `fail`
 *  predicate names rejects at once. */
function fakeNodes(nodes: Record<string, NodeData>, base: () => string) {
  const calls: Call[] = [];
  const held: Held[] = [];
  let hold: Pick = () => false;
  let fail: Pick = () => false;
  function answer<T>(method: string, key: string | undefined, page: Page | undefined, viewer: string | undefined, make: (n: NodeData) => T): Promise<T> {
    const c: Call = { method, base: base(), key, after: page?.after ?? null, viewer };
    calls.push(c);
    const refused = (): Error => new Error(`${method} at ${c.base} failed`);
    const n = nodes[c.base];
    if (n === undefined || fail(c)) return Promise.reject(refused());
    const value = make(n);
    if (!hold(c)) return Promise.resolve(value);
    return new Promise<T>((resolve, reject) => {
      held.push({ ...c, release: () => resolve(value), fail: () => reject(refused()) });
    });
  }
  const api: Api = {
    feed: (page, viewer, author) => answer(author === undefined ? 'feed' : 'authored', author, page, viewer, (n): FeedResult => {
      const rows = author === undefined ? n.feed : (n.authored.get(author) ?? []);
      const p = pageOf(rows, (r) => r.id, page?.after, n.pageSize);
      return { posts: p.rows.map((r) => seenBy(n, r, viewer)), next: p.next, pending: [], pendingCount: 0 };
    }),
    thread: (id, page, viewer) => answer('thread', id, page, viewer, (n): ThreadResult | null => {
      const root = n.feed.find((r) => r.id === id);
      const replies = n.replies.get(id);
      if (root === undefined || replies === undefined) return null;
      const p = pageOf(replies, (r) => r.id, page?.after, n.pageSize);
      return {
        post: seenBy(n, root, viewer), ancestors: [], ancestorCount: 0,
        descendants: p.rows.map((r) => seenBy(n, r, viewer)), descendantCount: replies.length,
        next: p.next, pending: [], pendingCount: 0,
      };
    }),
    post: (id, viewer) => answer('post', id, undefined, viewer, (n): PostResult | null => {
      const all = [...n.feed, ...[...n.replies.values()].flat(), ...[...n.authored.values()].flat()];
      const r = all.find((p) => p.id === id);
      return r === undefined ? null : { ...seenBy(n, r, viewer), confirmedAuthor: r.author };
    }),
    status: () => answer('status', undefined, undefined, undefined, () => statusAt(1000)),
    currentBlock: () => answer('currentBlock', undefined, undefined, undefined, () => ({ height: 1000, hash: null })),
    karma: (key) => answer('karma', key, undefined, undefined, () => karmaResult({
      userId: key, total: '219', effective: '219', boxes: [{ boxId: '1a'.repeat(32), value: '219' }], boxCount: 1,
      height: 1000, member: true, memberSinceBlock: 5, invitesAvailable: 2,
    })),
    credits: (key) => answer('credits', key, undefined, undefined, () => ({ userId: key, total: '0', boxes: [], boxCount: 0, next: null })),
    vouchesByTarget: (key, page) => answer('endorsers', key, page, undefined, (n): VouchesTargetResult => {
      const all = n.endorsers.get(key) ?? [];
      const p = pageOf(all, (v) => v, page?.after, n.pageSize);
      return { vouches: p.rows.map((v) => ({ voucherId: v, targetId: key, voucherName: null, targetName: null })), count: all.length, next: p.next };
    }),
    vouchesByVoucher: (key) => answer('vouchesByVoucher', key, undefined, undefined, () => ({ vouches: [], count: 0, next: null })),
    vouchCooldowns: (key) => answer('vouchCooldowns', key, undefined, undefined, () => ({ cooldowns: [], count: 0, next: null })),
    bonds: (key) => answer('bonds', key, undefined, undefined, () => ({ bonds: [], bondCount: 0, next: null })),
    usernameByOwner: (key) => answer('usernameByOwner', key, undefined, undefined, () => null),
    usernameByName: () => answer('usernameByName', undefined, undefined, undefined, () => null),
  };
  return {
    api, calls, held,
    setHold(p: Pick): void { hold = p; },
    setFail(p: Pick): void { fail = p; },
  };
}

type FakeNodes = ReturnType<typeof fakeNodes>;

/** An identity module whose key the test moves; a move fires onChange as the
 *  real module's create, import and forget do. */
function keyed(start: string) {
  let key = start;
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: key, locked: false }),
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
    onChange: (l) => { listeners.push(l); },
  };
  return {
    identity,
    setKey(k: string): void {
      key = k;
      for (const l of listeners) l({ pubKeyHex: k });
    },
  };
}

interface Drive {
  loadFeed(): Promise<void>;
  refreshFeed(): Promise<void>;
  loadOlder(): Promise<void>;
  changeNode(origin: string): Promise<void>;
  openThread(id: string, origin: { from: 'feed' }): void;
  refreshThread(id: string): Promise<void>;
  threadMore(id: string): Promise<void>;
  openAuthor(key: string, origin: { from: 'feed' }): void;
  refreshAuthor(key: string): Promise<void>;
  moreEndorsers(key: string): Promise<void>;
  openAuthorPosts(key: string, origin: { from: 'feed' }): void;
  loadAuthorPosts(key: string): Promise<void>;
  refreshAuthorPosts(key: string): Promise<void>;
  authorPostsMore(key: string): Promise<void>;
  pollTick(): Promise<void>;
  state: AppState;
  authorData: Map<string, AuthorWindowData>;
  authorPostsData: Map<string, FeedState>;
}

interface Harness {
  nodes: FakeNodes;
  drive: Drive;
  ledger: PendingLedger;
  feedEl: HTMLElement;
  panesEl: HTMLElement;
  setKey(k: string): void;
}

function mountShell(app: { mount(a: HTMLElement, f: HTMLElement, p: HTMLElement): void }): { feedEl: HTMLElement; panesEl: HTMLElement } {
  const appbar = document.createElement('header');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panesEl = document.createElement('section'); panesEl.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feedEl, panesEl);
  document.body.append(appbar, workspace);
  app.mount(appbar, feedEl, panesEl);
  return { feedEl, panesEl };
}

function harness(nodes: Record<string, NodeData>, opts: { layout?: string } = {}): Harness {
  const fake = fakeNodes(nodes, () => prefs.node);
  const id = keyed(ME);
  if (opts.layout) localStorage.setItem(KEY_LAYOUT, opts.layout);
  const ledger = new PendingLedger(ME);
  const app = new App(fake.api, {} as unknown as WriteClient, id.identity, ledger);
  const { feedEl, panesEl } = mountShell(app);
  return { nodes: fake, drive: app as unknown as Drive, ledger, feedEl, panesEl, setKey: id.setKey };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const cards = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>('[data-post-id]')].map((e) => e.dataset['postId'] ?? '');
/** Whether the card for a post offers the word `like` — the viewer has not liked it. */
const offersLike = (root: HTMLElement, id: string): boolean =>
  root.querySelector(`[data-post-id="${id}"] button[aria-label^="like this post"]`) !== null;
const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  setNode('');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The feed's rows across a change
// ---------------------------------------------------------------------------

describe('a node change drops the feed\'s rows, and a failed first page leaves none', () => {
  it('a node change whose feed re-read fails reads the error on an empty feed — no row of the node before while it reads, or after', async () => {
    setNode(A);
    const h = harness({ [A]: node({ feed: [row('A3'), row('A2'), row('A1')] }), [B]: node({ feed: [row('B1')] }) });
    await h.drive.loadFeed();
    expect(cards(h.feedEl)).toEqual([hid('A3'), hid('A2')]);

    h.nodes.setHold((c) => c.method === 'feed' && c.base === B);
    const change = h.drive.changeNode(B);
    await flush();
    expect(cards(h.feedEl)).toEqual([]);
    expect(h.feedEl.querySelector('.loading')?.textContent).toBe('loading…');

    h.nodes.held.find((x) => x.method === 'feed')!.fail();
    await change;
    await flush();
    expect(h.feedEl.querySelector('.error')).not.toBeNull();
    expect(cards(h.feedEl)).toEqual([]);
    const f = h.drive.state.feed;
    expect([f.posts, f.pending, f.next, f.report, f.olderReport]).toEqual([[], [], null, null, null]);
  });

  it('an identity change whose feed re-read fails leaves no row carrying the viewer before\'s marks — the next ↻ reads the first page for the new viewer', async () => {
    setNode(A);
    const liked = new Map([[ME, new Set([hid('A3')])]]);
    const h = harness({ [A]: node({ feed: [row('A3', { likeCount: 1 }), row('A2'), row('A1')], liked }) });
    await h.drive.loadFeed();
    expect(offersLike(h.feedEl, hid('A3'))).toBe(false);
    expect(offersLike(h.feedEl, hid('A2'))).toBe(true);

    h.nodes.setFail((c) => c.method === 'feed' && c.viewer === ME2);
    h.setKey(ME2);
    await flush();
    expect(h.drive.state.feed.posts).toEqual([]);
    expect(h.feedEl.querySelector('.error')).not.toBeNull();

    h.nodes.setFail(() => false);
    await h.drive.refreshFeed();
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('A3'), hid('A2')]);
    expect(offersLike(h.feedEl, hid('A3'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reads in flight across a change write nothing
// ---------------------------------------------------------------------------

describe('a feed, thread or author-posts read in flight across a change writes nothing', () => {
  it('a feed ↻ in flight across a node change answers late and writes nothing — no row, no report, nothing indexed', async () => {
    setNode(A);
    const a = node({ feed: [row('A3'), row('A2'), row('A1')] });
    const h = harness({ [A]: a, [B]: node({ feed: [row('B2'), row('B1')] }) });
    await h.drive.loadFeed();
    a.feed = [row('A4'), ...a.feed];

    h.nodes.setHold((c) => c.method === 'feed' && c.base === A);
    const stale = h.drive.refreshFeed();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.changeNode(B);
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('B2'), hid('B1')]);

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('B2'), hid('B1')]);
    expect(h.drive.state.feed.report).toBeNull();
    expect(h.drive.state.posts.has(hid('A4'))).toBe(false);
  });

  it('a load older in flight across a node change answers late and writes nothing — though both nodes of one chain stand at the same cursor', async () => {
    setNode(A);
    const feedOf = (likes: number): PostJson[] => ['F3', 'F2', 'F1'].map((l) => row(l, { likeCount: likes }));
    const h = harness({ [A]: node({ feed: feedOf(1) }), [B]: node({ feed: feedOf(5) }) });
    await h.drive.loadFeed();

    h.nodes.setHold((c) => c.method === 'feed' && c.base === A && c.after !== null);
    const stale = h.drive.loadOlder();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.changeNode(B);
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('F3'), hid('F2')]);
    expect(h.drive.state.feed.next).toBe(hid('F2'));

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('F3'), hid('F2')]);
    expect(h.drive.state.feed.next).toBe(hid('F2'));
    expect(h.drive.state.feed.olderReport).toBeNull();
    expect(h.drive.state.posts.has(hid('F1'))).toBe(false);
  });

  it('a first page read for the viewer before, answering after the new viewer\'s, writes nothing', async () => {
    setNode(A);
    const liked = new Map([[ME, new Set([hid('A2')])]]);
    const h = harness({ [A]: node({ feed: [row('A2', { likeCount: 1 }), row('A1')], liked }) });

    h.nodes.setHold((c) => c.method === 'feed' && c.viewer === ME);
    const stale = h.drive.loadFeed();
    await flush();
    h.setKey(ME2);
    await flush();
    expect(offersLike(h.feedEl, hid('A2'))).toBe(true);

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(offersLike(h.feedEl, hid('A2'))).toBe(true);
    expect(h.drive.state.feed.posts[0]?.likedByViewer).toBe(false);
  });

  it('a thread fetch in flight across a node change answers late and writes nothing — the thread and the post index stay the new node\'s', async () => {
    setNode(A);
    const T = row('T');
    const h = harness({
      [A]: node({ feed: [T], replies: new Map([[T.id, [row('R1', { likeCount: 1, parentRefs: [T.id] })]]]) }),
      [B]: node({ feed: [T], replies: new Map([[T.id, [row('R1', { likeCount: 5, parentRefs: [T.id] }), row('R2', { parentRefs: [T.id] })]]]) }),
    });
    h.nodes.setHold((c) => c.method === 'thread' && c.base === A);
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.changeNode(B);
    await flush();
    expect(cards(h.panesEl)).toEqual([T.id, hid('R1'), hid('R2')]);

    h.nodes.held[0]!.release();
    await flush();
    expect(cards(h.panesEl)).toEqual([T.id, hid('R1'), hid('R2')]);
    expect(h.drive.state.posts.get(hid('R1'))?.likeCount).toBe(5);
  });

  it('a thread fetch for the viewer before, answering after the new viewer\'s, writes nothing', async () => {
    setNode(A);
    const T = row('T');
    const liked = new Map([[ME, new Set([hid('R1')])]]);
    const h = harness({ [A]: node({ feed: [T], replies: new Map([[T.id, [row('R1', { likeCount: 1, parentRefs: [T.id] })]]]), liked }) });
    h.nodes.setHold((c) => c.method === 'thread' && c.viewer === ME);
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();

    h.setKey(ME2);
    await flush();
    expect(offersLike(h.panesEl, hid('R1'))).toBe(true);

    h.nodes.held[0]!.release();
    await flush();
    expect(offersLike(h.panesEl, hid('R1'))).toBe(true);
  });

  it('a thread ↻ in flight across a node change writes nothing — no report on the new node\'s thread', async () => {
    setNode(A);
    const T = row('T');
    const a = node({ feed: [T], replies: new Map([[T.id, [row('R1', { parentRefs: [T.id] })]]]), pageSize: 5 });
    const h = harness({ [A]: a, [B]: node({ feed: [T], replies: new Map([[T.id, [row('R1', { parentRefs: [T.id] })]]]), pageSize: 5 }) });
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    a.replies.set(T.id, [row('R1', { parentRefs: [T.id] }), row('R2', { parentRefs: [T.id] }), row('R3', { parentRefs: [T.id] })]);

    h.nodes.setHold((c) => c.method === 'thread' && c.base === A);
    const stale = h.drive.refreshThread(T.id);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.changeNode(B);
    await flush();
    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(h.drive.state.workspace.columns[0]!.report).toBeNull();
    expect(cards(h.panesEl)).toEqual([T.id, hid('R1')]);
    expect(h.drive.state.posts.has(hid('R3'))).toBe(false);
  });

  it('author-posts reads in flight across a node change write nothing — no report, no row in the post index', async () => {
    setNode(A);
    const h = harness({
      [A]: node({ authored: new Map([[X, [row('XA2'), row('XA1')]]]) }),
      [B]: node({ authored: new Map([[X, [row('XB1')]]]) }),
    });
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();

    h.nodes.setHold((c) => c.method === 'authored' && c.base === A);
    const first = h.drive.loadAuthorPosts(X);
    const refresh = h.drive.refreshAuthorPosts(X);
    await flush();
    expect(h.nodes.held).toHaveLength(2);

    await h.drive.changeNode(B);
    await flush();
    for (const x of h.nodes.held) x.release();
    await first;
    await refresh;
    await flush();
    expect(h.drive.state.workspace.columns[0]!.report).toBeNull();
    expect(ids(h.drive.authorPostsData.get(X)!.posts)).toEqual([hid('XB1')]);
    expect(h.drive.state.posts.has(hid('XA2'))).toBe(false);
    expect(cards(h.panesEl)).toEqual([hid('XB1')]);
  });

  it('a thread\'s more and an author-posts more in flight across a node change write nothing', async () => {
    setNode(A);
    const T = row('T');
    const h = harness({
      [A]: node({
        feed: [T],
        replies: new Map([[T.id, ['R1', 'R2', 'R3', 'R4'].map((l) => row(l, { parentRefs: [T.id] }))]]),
        authored: new Map([[X, [row('X4'), row('X3'), row('X2'), row('X1')]]]),
      }),
      [B]: node({ feed: [T], replies: new Map([[T.id, [row('R1', { parentRefs: [T.id] })]]]), authored: new Map([[X, [row('X1')]]]) }),
    });
    h.drive.openThread(T.id, { from: 'feed' });
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();

    h.nodes.setHold((c) => c.base === A && c.after !== null);
    const staleThread = h.drive.threadMore(T.id);
    const stalePosts = h.drive.authorPostsMore(X);
    await flush();
    expect(h.nodes.held).toHaveLength(2);

    await h.drive.changeNode(B);
    await flush();
    for (const x of h.nodes.held) x.release();
    await staleThread;
    await stalePosts;
    await flush();
    expect(ids(h.drive.state.threads.get(T.id)!.descendants)).toEqual([hid('R1')]);
    expect(ids(h.drive.authorPostsData.get(X)!.posts)).toEqual([hid('X1')]);
    expect(h.drive.state.posts.has(hid('R3'))).toBe(false);
    expect(h.drive.state.posts.has(hid('X2'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The seed walk
// ---------------------------------------------------------------------------

describe('the seed walk never overrides a node set while it probes', () => {
  it('a node set in the settings row while the walk probes the next seed stands; the walk adopts nothing', async () => {
    // The seed list is a build value read at import, so the modules load fresh
    // under the shell's `notis-nodes` (WEB_INTERFACE → "The client is served
    // from the node's own origin").
    vi.resetModules();
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'notis-nodes');
    meta.setAttribute('content', JSON.stringify([A, B]));
    document.head.appendChild(meta);
    const fresh = await import('../src/prefs');
    const { App: FreshApp } = await import('../src/app');
    expect(fresh.prefs.node).toBe(A);

    const fake = fakeNodes({ [A]: node(), [C]: node({ feed: [row('C1')] }) }, () => fresh.prefs.node);
    fake.setFail((c) => c.method === 'feed' && c.base === A);
    // The walk probes B through its own client — the browser's fetch — and the
    // probe is held until the test answers it.
    const probes: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => new Promise((resolve) => {
      probes.push(() => resolve({
        ok: url.startsWith(B + '/'), status: 200, statusText: 'OK',
        json: async (): Promise<FeedResult> => ({ posts: [row('B1')], next: null, pending: [], pendingCount: 0 }),
      }));
    })));

    const id = keyed(ME);
    const app = new FreshApp(fake.api, {} as unknown as WriteClient, id.identity, new PendingLedger(ME));
    const { feedEl } = mountShell(app);
    const drive = app as unknown as Drive;
    const boot = drive.loadFeed();
    await flush();
    expect(probes).toHaveLength(1);

    // The reader sets C in the settings row while the probe is out.
    await drive.changeNode(C);
    await flush();
    expect(cards(feedEl)).toEqual([hid('C1')]);

    probes[0]!();
    await boot;
    await flush();
    expect(fresh.prefs.node).toBe(C);
    expect(cards(feedEl)).toEqual([hid('C1')]);
  });
});

// ---------------------------------------------------------------------------
// Every continuation continues the cursor or page it was asked for
// ---------------------------------------------------------------------------

describe('a continuation continues the cursor or page it was asked for', () => {
  it('load older: a page answering after a ↻ moved the cursor writes nothing, and the next load older continues the new cursor', async () => {
    setNode(A);
    const a = node({ feed: [row('P3'), row('P2'), row('P1')], pageSize: 1 });
    const h = harness({ [A]: a });
    await h.drive.loadFeed();
    expect(h.drive.state.feed.next).toBe(hid('P3'));

    h.nodes.setHold((c) => c.method === 'feed' && c.after === hid('P3'));
    const stale = h.drive.loadOlder();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    // Forty-one newer posts: the ↻ pages to its cap without reaching the held
    // rows, so it replaces the feed and stands at a cursor of its own.
    const newer = Array.from({ length: 41 }, (_, i) => row('N' + String(41 - i)));
    a.feed = [...newer, ...a.feed];
    await h.drive.refreshFeed();
    await flush();
    expect(ids(h.drive.state.feed.posts)).toEqual(ids(newer.slice(0, 40)));
    expect(h.drive.state.feed.next).toBe(hid('N2'));

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(ids(h.drive.state.feed.posts)).toEqual(ids(newer.slice(0, 40)));
    expect(h.drive.state.feed.next).toBe(hid('N2'));

    await h.drive.loadOlder();
    await flush();
    expect(ids(h.drive.state.feed.posts)).toEqual(ids(newer));
  });

  it('a thread\'s more: a page answering after a ↻ re-read the thread writes nothing, and the next more continues the new page', async () => {
    setNode(A);
    const T = row('T');
    const replies = Array.from({ length: 42 }, (_, i) => row('R' + String(i + 1), { parentRefs: [T.id] }));
    const h = harness({ [A]: node({ feed: [T], replies: new Map([[T.id, replies]]), pageSize: 1 }) });
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    const thread = () => h.drive.state.threads.get(T.id)!;
    expect(thread().next).toBe(hid('R1'));

    h.nodes.setHold((c) => c.method === 'thread' && c.after === hid('R1'));
    const stale = h.drive.threadMore(T.id);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    // The ↻ reads the thread to its page cap and stands at a cursor of its own.
    h.nodes.setHold(() => false);
    await h.drive.refreshThread(T.id);
    await flush();
    expect(thread().descendants).toHaveLength(40);
    expect(thread().next).toBe(hid('R40'));

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(thread().descendants).toHaveLength(40);
    expect(thread().next).toBe(hid('R40'));

    await h.drive.threadMore(T.id);
    await flush();
    expect(ids(thread().descendants)).toEqual(ids(replies.slice(0, 41)));
  });

  it('an author-posts more: a page answering after a raise re-read the first page writes nothing, and the next more continues the new page', async () => {
    setNode(A);
    const a = node({ authored: new Map([[X, [row('X4'), row('X3'), row('X2'), row('X1')]]]) });
    const h = harness({ [A]: a });
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    const posts = () => h.drive.authorPostsData.get(X)!;
    expect(posts().next).toBe(hid('X3'));

    h.nodes.setHold((c) => c.method === 'authored' && c.after === hid('X3'));
    const stale = h.drive.authorPostsMore(X);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    // The author posts again; a press on their prefix raises the window, which
    // reads the first page again.
    a.authored.set(X, [row('X5'), ...a.authored.get(X)!]);
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    expect(ids(posts().posts)).toEqual([hid('X5'), hid('X4')]);

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(ids(posts().posts)).toEqual([hid('X5'), hid('X4')]);

    await h.drive.authorPostsMore(X);
    await flush();
    expect(ids(posts().posts)).toEqual([hid('X5'), hid('X4'), hid('X3'), hid('X2')]);
  });

  it('the endorsers\' more: a page answering after a ↻ re-read the list writes nothing, and the next more continues the new list', async () => {
    setNode(A);
    const V = (n: number): string => String(n).padStart(2, '0').repeat(32);
    const a = node({ endorsers: new Map([[X, [V(3), V(2), V(1)]]]) });
    const h = harness({ [A]: a });
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    const vouchers = (): string[] => h.drive.authorData.get(X)!.endorsers!.vouches.map((v) => v.voucherId);
    expect(vouchers()).toEqual([V(3), V(2)]);

    h.nodes.setHold((c) => c.method === 'endorsers' && c.after === V(2));
    const stale = h.drive.moreEndorsers(X);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.endorsers.set(X, [V(4), V(3), V(2), V(1)]);
    await h.drive.refreshAuthor(X);
    await flush();
    expect(vouchers()).toEqual([V(4), V(3)]);

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(vouchers()).toEqual([V(4), V(3)]);

    await h.drive.moreEndorsers(X);
    await flush();
    expect(vouchers()).toEqual([V(4), V(3), V(2), V(1)]);
  });
});

// ---------------------------------------------------------------------------
// A refresh lands on the rows standing when it lands; an unloaded list reads its
// first page
// ---------------------------------------------------------------------------

describe('a refresh lands on the rows standing as it lands', () => {
  it('a withdraw landing during a feed ↻\'s pages survives the ↻ — the withdrawn row never comes back', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ feed: [W, row('P2'), row('P1')] });
    const h = harness({ [A]: a });
    await h.drive.loadFeed();
    expect(cards(h.feedEl)).toEqual([W.id, hid('P2')]);
    h.ledger.add({ txId: 'e1'.repeat(32), kind: 'withdraw', postId: W.id, inputs: [], expiresAtHeight: 5000, submittedAtHeight: 990 });
    a.feed = [row('N'), ...a.feed];

    h.nodes.setHold((c) => c.method === 'feed' && c.after === null);
    const refresh = h.drive.refreshFeed();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    // The withdrawal lands while the ↻'s first page is out.
    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(cards(h.feedEl)).toEqual([hid('P2')]);

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('N'), hid('P2')]);
    expect(h.drive.state.feed.report).toBe('1 new post');
  });

  it('a load older landing during a feed ↻\'s pages survives the ↻', async () => {
    setNode(A);
    const a = node({ feed: ['P4', 'P3', 'P2', 'P1'].map((l) => row(l)) });
    const h = harness({ [A]: a });
    await h.drive.loadFeed();
    expect(h.drive.state.feed.next).toBe(hid('P3'));
    a.feed = [row('N'), ...a.feed];

    h.nodes.setHold((c) => c.method === 'feed' && c.after === null);
    const refresh = h.drive.refreshFeed();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.loadOlder();
    await flush();
    expect(ids(h.drive.state.feed.posts)).toEqual(['P4', 'P3', 'P2', 'P1'].map(hid));

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(ids(h.drive.state.feed.posts)).toEqual(['N', 'P4', 'P3', 'P2', 'P1'].map(hid));
    expect(h.drive.state.feed.next).toBeNull();
  });

  it('an author-posts more landing during the window\'s ↻ survives the ↻', async () => {
    setNode(A);
    const a = node({ authored: new Map([[X, ['X4', 'X3', 'X2', 'X1'].map((l) => row(l))]]) });
    const h = harness({ [A]: a });
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    a.authored.set(X, [row('X5'), ...a.authored.get(X)!]);

    h.nodes.setHold((c) => c.method === 'authored' && c.after === null);
    const refresh = h.drive.refreshAuthorPosts(X);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.authorPostsMore(X);
    await flush();
    expect(ids(h.drive.authorPostsData.get(X)!.posts)).toEqual(['X4', 'X3', 'X2', 'X1'].map(hid));

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(ids(h.drive.authorPostsData.get(X)!.posts)).toEqual(['X5', 'X4', 'X3', 'X2', 'X1'].map(hid));
  });
});

describe('a refresh on a list holding no first page reads the first page', () => {
  it('a ↻ on a feed whose first page failed reads one first page — never pages to the cap', async () => {
    setNode(A);
    const h = harness({ [A]: node({ feed: ['P5', 'P4', 'P3', 'P2', 'P1'].map((l) => row(l)) }) });
    h.nodes.setFail((c) => c.method === 'feed');
    await h.drive.loadFeed();
    expect(h.feedEl.querySelector('.error')).not.toBeNull();

    h.nodes.setFail(() => false);
    const before = h.nodes.calls.filter((c) => c.method === 'feed').length;
    await h.drive.refreshFeed();
    await flush();
    const reads = h.nodes.calls.filter((c) => c.method === 'feed').slice(before);
    expect(reads.map((c) => c.after)).toEqual([null]);
    expect(cards(h.feedEl)).toEqual([hid('P5'), hid('P4')]);
    expect(h.drive.state.feed.next).toBe(hid('P4'));
  });

  it('a ↻ on an author-posts window whose first page failed reads one first page — never pages to the cap', async () => {
    setNode(A);
    const h = harness({ [A]: node({ authored: new Map([[X, ['X5', 'X4', 'X3', 'X2', 'X1'].map((l) => row(l))]]) }) });
    h.nodes.setFail((c) => c.method === 'authored');
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    expect(h.drive.authorPostsData.get(X)!.error).not.toBeNull();

    h.nodes.setFail(() => false);
    const before = h.nodes.calls.filter((c) => c.method === 'authored').length;
    await h.drive.refreshAuthorPosts(X);
    await flush();
    const reads = h.nodes.calls.filter((c) => c.method === 'authored').slice(before);
    expect(reads.map((c) => c.after)).toEqual([null]);
    expect(ids(h.drive.authorPostsData.get(X)!.posts)).toEqual([hid('X5'), hid('X4')]);
  });
});

// ---------------------------------------------------------------------------
// No answer read before a landing stands over it: a withdrawal the client saw
// land is final on every write of rows, and a like's landed row stands over an
// answer read before it
// ---------------------------------------------------------------------------

let entrySeq = 0;
function entry(kind: 'withdraw' | 'like', postId: string): { txId: string; kind: 'withdraw' | 'like'; postId: string; inputs: string[]; expiresAtHeight: number; submittedAtHeight: number } {
  entrySeq += 1;
  return { txId: entrySeq.toString(16).padStart(2, '0').repeat(32), kind, postId, inputs: [], expiresAtHeight: 5000, submittedAtHeight: 990 };
}
const withdrawnCard = (root: HTMLElement, id: string): boolean => root.querySelector(`[data-post-id="${id}"] .withdrawn`) !== null;

describe('a withdrawal the client saw land stands over every answer read before it', () => {
  it('the feed\'s first page: the withdrawn root stays out', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ feed: [W, row('P1')] });
    const h = harness({ [A]: a });
    h.ledger.add(entry('withdraw', W.id));
    h.nodes.setHold((c) => c.method === 'feed');
    const first = h.drive.loadFeed();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);

    h.nodes.held[0]!.release();
    await first;
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('P1')]);
    // The post index holds live rows only: the page's live copy never enters it.
    expect(h.drive.state.posts.has(W.id)).toBe(false);
  });

  it('a feed ↻: the withdrawn root never enters, and the ↻ reports nothing new', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ feed: [row('P1')] });
    const h = harness({ [A]: a });
    await h.drive.loadFeed();
    a.feed = [W, ...a.feed];
    h.ledger.add(entry('withdraw', W.id));
    h.nodes.setHold((c) => c.method === 'feed');
    const refresh = h.drive.refreshFeed();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(cards(h.feedEl)).toEqual([hid('P1')]);
    expect(h.drive.state.feed.report).toBe('no new posts');
  });

  it('load older: the withdrawn root stays out', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ feed: [row('P3'), row('P2'), W, row('P1')] });
    const h = harness({ [A]: a });
    await h.drive.loadFeed();
    h.ledger.add(entry('withdraw', W.id));
    h.nodes.setHold((c) => c.method === 'feed' && c.after !== null);
    const older = h.drive.loadOlder();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await older;
    await flush();
    expect(cards(h.feedEl)).toEqual(['P3', 'P2', 'P1'].map(hid));
  });

  it('an author-posts first page: the withdrawn post stays out', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ authored: new Map([[ME, [W, row('P1', { author: ME })]]]) });
    const h = harness({ [A]: a });
    h.ledger.add(entry('withdraw', W.id));
    h.nodes.setHold((c) => c.method === 'authored');
    h.drive.openAuthorPosts(ME, { from: 'feed' });
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await flush();
    expect(ids(h.drive.authorPostsData.get(ME)!.posts)).toEqual([hid('P1')]);
  });

  it('an author-posts ↻: the withdrawn post never enters', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ authored: new Map([[ME, [row('P1', { author: ME })]]]) });
    const h = harness({ [A]: a });
    h.drive.openAuthorPosts(ME, { from: 'feed' });
    await flush();
    a.authored.set(ME, [W, ...a.authored.get(ME)!]);
    h.ledger.add(entry('withdraw', W.id));
    h.nodes.setHold((c) => c.method === 'authored');
    const refresh = h.drive.refreshAuthorPosts(ME);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(ids(h.drive.authorPostsData.get(ME)!.posts)).toEqual([hid('P1')]);
  });

  it('an author-posts more: the withdrawn post stays out', async () => {
    setNode(A);
    const W = row('W', { author: ME });
    const a = node({ authored: new Map([[ME, [row('P3', { author: ME }), row('P2', { author: ME }), W, row('P1', { author: ME })]]]) });
    const h = harness({ [A]: a });
    h.drive.openAuthorPosts(ME, { from: 'feed' });
    await flush();
    h.ledger.add(entry('withdraw', W.id));
    h.nodes.setHold((c) => c.method === 'authored' && c.after !== null);
    const more = h.drive.authorPostsMore(ME);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(W.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await more;
    await flush();
    expect(ids(h.drive.authorPostsData.get(ME)!.posts)).toEqual(['P3', 'P2', 'P1'].map(hid));
  });

  it('a thread\'s first page: the reply renders its withdrawn card, and the post index never takes it back', async () => {
    setNode(A);
    const T = row('T');
    const R = row('R', { author: ME, parentRefs: [T.id] });
    const a = node({ feed: [T], replies: new Map([[T.id, [R, row('R2', { parentRefs: [T.id] })]]]) });
    const h = harness({ [A]: a });
    h.ledger.add(entry('withdraw', R.id));
    h.nodes.setHold((c) => c.method === 'thread');
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(R.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await flush();
    expect(withdrawnCard(h.panesEl, R.id)).toBe(true);
    expect(h.drive.state.posts.has(R.id)).toBe(false);
  });

  it('a thread ↻: the reply keeps its withdrawn card, and the post index never takes it back', async () => {
    setNode(A);
    const T = row('T');
    const R = row('R', { author: ME, parentRefs: [T.id] });
    const a = node({ feed: [T], replies: new Map([[T.id, [R]]]) });
    const h = harness({ [A]: a });
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    expect(withdrawnCard(h.panesEl, R.id)).toBe(false);
    h.ledger.add(entry('withdraw', R.id));
    h.nodes.setHold((c) => c.method === 'thread');
    const refresh = h.drive.refreshThread(T.id);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(R.id);
    await h.drive.pollTick();
    await flush();
    expect(withdrawnCard(h.panesEl, R.id)).toBe(true);

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(withdrawnCard(h.panesEl, R.id)).toBe(true);
    expect(h.drive.state.posts.has(R.id)).toBe(false);
  });

  it('a thread\'s more: the reply renders its withdrawn card', async () => {
    setNode(A);
    const T = row('T');
    const R = row('R', { author: ME, parentRefs: [T.id] });
    const a = node({
      feed: [T],
      replies: new Map([[T.id, [row('R1', { parentRefs: [T.id] }), row('R2', { parentRefs: [T.id] }), R, row('R3', { parentRefs: [T.id] })]]]),
    });
    const h = harness({ [A]: a });
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    h.ledger.add(entry('withdraw', R.id));
    h.nodes.setHold((c) => c.method === 'thread' && c.after !== null);
    const more = h.drive.threadMore(T.id);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.withdrawn.add(R.id);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await more;
    await flush();
    expect(withdrawnCard(h.panesEl, R.id)).toBe(true);
  });
});

describe('a like\'s landed row stands over an answer read before it', () => {
  it('a thread ↻: the liked reply keeps the landed row', async () => {
    setNode(A);
    const T = row('T');
    const a = node({ feed: [T], replies: new Map([[T.id, [row('L', { parentRefs: [T.id] })]]]) });
    const h = harness({ [A]: a });
    h.drive.openThread(T.id, { from: 'feed' });
    await flush();
    expect(offersLike(h.panesEl, hid('L'))).toBe(true);
    h.ledger.add(entry('like', hid('L')));
    h.nodes.setHold((c) => c.method === 'thread');
    const refresh = h.drive.refreshThread(T.id);
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.liked.set(ME, new Set([hid('L')]));
    a.replies.set(T.id, [row('L', { parentRefs: [T.id], likeCount: 1 })]);
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(offersLike(h.panesEl, hid('L'))).toBe(false);

    h.nodes.held[0]!.release();
    await refresh;
    await flush();
    expect(offersLike(h.panesEl, hid('L'))).toBe(false);
  });

  it('the feed\'s first page, read again while the rows stand: the liked card keeps the landed row', async () => {
    setNode(A);
    const a = node({ feed: [row('L'), row('P1')] });
    const h = harness({ [A]: a });
    await h.drive.loadFeed();
    expect(offersLike(h.feedEl, hid('L'))).toBe(true);
    h.ledger.add(entry('like', hid('L')));
    h.nodes.setHold((c) => c.method === 'feed');
    const first = h.drive.loadFeed();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.liked.set(ME, new Set([hid('L')]));
    a.feed = [row('L', { likeCount: 1 }), row('P1')];
    await h.drive.pollTick();
    await flush();
    expect(offersLike(h.feedEl, hid('L'))).toBe(false);

    h.nodes.held[0]!.release();
    await first;
    await flush();
    expect(offersLike(h.feedEl, hid('L'))).toBe(false);
  });

  it('an author-posts first page, read again by a raise: the liked card keeps the landed row', async () => {
    setNode(A);
    const a = node({ authored: new Map([[X, [row('L'), row('P1')]]]) });
    const h = harness({ [A]: a });
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    expect(offersLike(h.panesEl, hid('L'))).toBe(true);
    h.ledger.add(entry('like', hid('L')));
    h.nodes.setHold((c) => c.method === 'authored');
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    a.liked.set(ME, new Set([hid('L')]));
    a.authored.set(X, [row('L', { likeCount: 1 }), row('P1')]);
    await h.drive.pollTick();
    await flush();

    h.nodes.held[0]!.release();
    await flush();
    expect(h.drive.authorPostsData.get(X)!.posts[0]?.likedByViewer).toBe(true);
    expect(offersLike(h.panesEl, hid('L'))).toBe(false);
  });
});
