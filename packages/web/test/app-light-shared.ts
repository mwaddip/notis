// Shared harness for the App's extension-build reads over the light / resolver
// path (WEB_INTERFACE → The extension → "The light read", → "The resolve",
// → "The post cache"). `app-light.test.ts` and `app-light-thread.test.ts`
// import this module; the fake `Api`'s `thread` and `feed` both record
// arguments and dequeue answers.

import { IDBFactory } from 'fake-indexeddb';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import type { Api } from '../src/api/client';
import type { AppIdentity, AppState, PostCache, PostResolver, PostsVerifier } from '../src/model/state';
import type { BoundPost, ResolveEnd } from '../src/model/post-resolve';
import type { WriteClient } from '../src/api/write';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type {
  PostJson, LightJson, WithdrawnJson, FeedResult, ThreadResult, PostResult,
  StatusResult, BlockCurrent,
} from '../src/api/dto';

export const ME = 'aa'.repeat(32);

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// `fake-indexeddb` schedules its own microtasks between IDB request steps;
// a sequence of put/get needs several queue drains to settle.
export const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await flush(); };

export const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

export function status(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 10, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

export function fullRow(label: string, over: Partial<PostJson> = {}): PostJson {
  return {
    id: hid(label), content: 'text:' + label, contentHash: hid('h' + label),
    author: ME, parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed', blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: hid('tx' + label),
    ...over,
  };
}

export function light(label: string, over: Partial<LightJson> = {}): LightJson {
  return {
    kind: 'light', id: hid(label), parentRefs: [], status: 'confirmed',
    blockHeight: 11, blockIndex: 1, blockCreatedAt: 2000,
    likeCount: 3, descendantCount: 4, authorName: 'alice', likedByViewer: false,
    ...over,
  };
}

export function tomb(label: string): WithdrawnJson {
  return {
    kind: 'withdrawn', id: hid(label), author: ME, withdrawnAtHeight: 11,
    parentRefs: [], descendantCount: 0, authorName: null, txId: hid('tx' + label),
  };
}

/** A `bound` check for a row — the resolver's answer under `bound` carries
 *  the id, bytes, author and parent as the transaction states them. */
export function boundCheck(r: PostJson): Extract<PostCheck, { status: 'bound' }> {
  return { status: 'bound', id: r.id, txBytes: new Uint8Array([1, 2, 3]), author: r.author, parent: r.parentRefs[0] ?? null };
}

export interface FeedCall { url: string; light: boolean | undefined; author: string | undefined }
export interface ThreadCall { id: string; url: string; light: boolean | undefined; after: string | undefined }

export interface Fake {
  feedCalls: FeedCall[];
  feedQueue: FeedResult[];
  threadCalls: ThreadCall[];
  /** One entry per thread call: a result, `null` for a 404, or an `Error` to
   *  throw. A missing entry answers `null`. */
  threadQueue: Array<ThreadResult | null | Error>;
  /** One answer for every `GET /posts/:id` the ledger's poll fires; absent is
   *  `null` (the node knows no such post). */
  postRes: PostResult | null;
  postCalls: Array<{ id: string; withTx: boolean | undefined }>;
}

export function makeApi(f: Fake): Api {
  return {
    feed: async (page, viewer, author, roots, lightFlag): Promise<FeedResult> => {
      const q: Record<string, string | number | undefined> = {
        limit: page?.limit, after: page?.after ?? undefined, author, viewer, roots: roots ? 1 : undefined,
      };
      if (lightFlag) q['light'] = 1;
      const qs = Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      const url = '/posts' + (qs ? '?' + qs : '');
      f.feedCalls.push({ url, light: lightFlag, author });
      const res = f.feedQueue.shift();
      if (res === undefined) return { posts: [], next: null, pending: [], pendingCount: 0 };
      return res;
    },
    thread: async (id, page, viewer, lightFlag): Promise<ThreadResult | null> => {
      const q: Record<string, string | number | undefined> = {
        limit: page?.limit, after: page?.after ?? undefined, viewer,
      };
      if (lightFlag) q['light'] = 1;
      const qs = Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      const url = '/posts/' + encodeURIComponent(id) + '/thread' + (qs ? '?' + qs : '');
      f.threadCalls.push({ id, url, light: lightFlag, after: page?.after ?? undefined });
      const next = f.threadQueue.shift();
      if (next === undefined || next === null) return null;
      if (next instanceof Error) throw next;
      return next;
    },
    post: async (id, _viewer, withTx): Promise<PostResult | null> => {
      f.postCalls.push({ id, withTx });
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

/** A test-driven resolver — each `resolve` call is captured, the test
 *  releases `onBound` calls and the final `ends` map by hand. */
export interface Call {
  ids: string[];
  onBound: (posts: BoundPost[]) => void;
  settle: (ends: Map<string, ResolveEnd>) => void;
  reject: (err: Error) => void;
  bound(rows: PostJson[]): void;
  end(ends: Partial<Record<string, ResolveEnd>>): void;
  fail(): void;
}

export function testResolver(): { resolver: PostResolver; calls: Call[] } {
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

export function makeCache(): { cache: PostCache; ls: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> } {
  const map = new Map<string, string>();
  const ls = {
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => { map.set(k, v); },
    removeItem: (k: string): void => { map.delete(k); },
  };
  const cache = createPostCache({ indexedDB: new IDBFactory(), localStorage: ls });
  return { cache, ls };
}

export function makeIdentity(key: string | null): AppIdentity {
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

export interface Harness {
  app: App;
  drive: {
    loadFeed(): Promise<void>;
    refreshFeed(): Promise<void>;
    loadOlder(): Promise<void>;
    openAuthorPosts(key: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    refreshAuthorPosts(key: string): Promise<void>;
    authorPostsMore(key: string): Promise<void>;
    openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    fetchThread(id: string): Promise<void>;
    refreshThread(id: string): Promise<void>;
    threadMore(id: string): Promise<void>;
    renderRegionsFor(id: string): void;
    changeNode(origin: string): Promise<void>;
    onIdentityChange(): void;
    pollTick(): Promise<void>;
    state: AppState;
    withdrawnSeen: Map<string, WithdrawnJson>;
    resolving: Set<string>;
  };
  fake: Fake;
  feedEl: HTMLElement;
  panes: HTMLElement;
}

export interface Opts {
  resolver?: PostResolver | null;
  verifier?: PostsVerifier | null;
  cache?: PostCache | null;
  identityKey?: string | null;
  feedResults?: FeedResult[];
  threadResults?: Array<ThreadResult | null | Error>;
  postRes?: PostResult | null;
}

/** A stub verifier the extension-build configuration hands beside a resolver
 *  when a test does not script one — a list read brings no bytes and is not
 *  checked (WEB_INTERFACE → The extension → "The post check" → "A list read
 *  brings no bytes and is not checked"), so the stub is used for the single
 *  post read's one row at a time: a `WithdrawnJson` reads `nothing-to-bind`
 *  and every other row `bound`. */
export function stubVerifier(): PostsVerifier {
  return {
    check: (rows) => rows.map((r) => {
      const row = r as { kind?: string } & PostJson;
      if (row.kind === 'withdrawn') return { status: 'nothing-to-bind' } as PostCheck;
      return boundCheck(row);
    }),
  };
}

/** A stub resolver that never asks for anything: tests that drive only the
 *  single post read's path (`ingestOne`, the ledger's poll, the submit's
 *  cache hook) take it beside their verifier. */
export function stubResolver(): PostResolver {
  return { resolve: async () => new Map() };
}

export function harness(opts: Opts = {}): Harness {
  const fake: Fake = {
    feedCalls: [],
    feedQueue: opts.feedResults ? [...opts.feedResults] : [],
    threadCalls: [],
    threadQueue: opts.threadResults ? [...opts.threadResults] : [],
    postRes: opts.postRes ?? null,
    postCalls: [],
  };
  const api = makeApi(fake);
  const writeClient = {} as unknown as WriteClient;
  const key = opts.identityKey === undefined ? null : opts.identityKey;
  const ledger = new PendingLedger(key);
  const identity = makeIdentity(key);
  // The App's constructor refuses a posts verifier without a post resolver,
  // or a resolver without a verifier: the extension build is the one build
  // that holds either, and it holds both (WEB_INTERFACE → The extension →
  // "The post check", → "The resolve"). The harness fills the missing seam
  // of a pair with a stub, so a test naming one chooses that configuration
  // whole.
  let verifier = opts.verifier ?? null;
  let resolver = opts.resolver ?? null;
  if (resolver !== null && verifier === null) verifier = stubVerifier();
  if (verifier !== null && resolver === null) resolver = stubResolver();
  const app = new App(
    api, writeClient, identity, ledger, undefined, undefined,
    null, null, null,
    verifier,
    opts.cache ?? null,
    resolver,
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
export async function seedCache(cache: PostCache, rows: PostJson[]): Promise<void> {
  for (const r of rows) {
    const c = boundCheck(r);
    await cache.put({ id: c.id, txBytes: c.txBytes, row: r, author: c.author, parent: c.parent, own: false });
  }
}
