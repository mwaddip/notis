// Shared harness for the App's extension-build reads over the light / resolver
// path (WEB_INTERFACE → The extension → "The light read", → "The resolve",
// → "The post cache"). `app-light.test.ts`, `app-light-thread.test.ts` and
// `app-card-rows.test.ts` import this module; the fake `Api`'s `thread` and
// `feed` both record arguments and dequeue answers. A case that writes takes
// `lockableIdentity` and `recordingWrites` beside it.

import { IDBFactory } from 'fake-indexeddb';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { createPostCache } from '../src/extension/post-cache';
import type { Api } from '../src/api/client';
import type { Mode } from '../src/mode';
import type { AppIdentity, AppState, PostCache, PostResolver, PostsVerifier } from '../src/model/state';
import type { BoundPost, ResolveEnd } from '../src/model/post-resolve';
import type { WriteClient } from '../src/api/write';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type {
  PostJson, LightJson, WithdrawnJson, FeedResult, ThreadResult, PostResult,
  StatusResult, BlockCurrent, KarmaResult,
} from '../src/api/dto';
import { karmaResult } from './karma-fixture';

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
  /** `GET /posts/:id` by id — an id named here answers its entry, any other
   *  `postRes`. */
  postById?: Map<string, PostResult | null>;
  /** A thread read by id, answered once `threadQueue` is empty. */
  threadById?: Map<string, ThreadResult>;
  /** The reader's `/karma`; absent is the no-record page. */
  karma?: KarmaResult;
  /** The reader's `/credits`; absent is the empty listing. */
  credits?: import('../src/api/dto').CreditsResult;
  /** The reader's `/usernames?owner=`; absent is `null` (no name held). */
  ownName?: import('../src/api/dto').UsernameResult;
  /** The reader's `/invites/:key`; absent is no standing bond. */
  bonds?: import('../src/api/dto').BondsResult;
  /** The height `GET /blocks/current` answers; absent is 10. */
  height?: number;
  /** When set, every membership-level read (`/karma`, `/status`,
   *  `/vouches` by voucher, `/vouches` cooldowns, `/invites`,
   *  `/usernames?owner=`) awaits this before answering — a case opens the
   *  profile with the reads in flight and releases them by hand through the
   *  gate's `release()`. Default: no gate; every call resolves at once. */
  membershipGate?: Promise<void>;
}

/** A gate on the membership reads — set `f.membershipGate` to the gate's
 *  promise, call `release()` to let the reads answer. */
export interface MembershipGate {
  readonly promise: Promise<void>;
  release(): void;
}

export function membershipGate(): MembershipGate {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
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
      const next = f.threadQueue.length > 0 ? f.threadQueue.shift() : f.threadById?.get(id);
      if (next === undefined || next === null) return null;
      if (next instanceof Error) throw next;
      return next;
    },
    post: async (id, _viewer, withTx): Promise<PostResult | null> => {
      f.postCalls.push({ id, withTx });
      const named = f.postById?.get(id);
      return named !== undefined ? named : f.postRes;
    },
    status: async () => { await f.membershipGate; return status(); },
    currentBlock: async (): Promise<BlockCurrent> => ({ height: f.height ?? 10, hash: null }),
    karma: async () => { await f.membershipGate; return f.karma ?? {
      userId: ME, total: '0', effective: '0', boxes: [], boxCount: 0, next: null,
      lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
      memberSinceBlock: 0, memberBar: 1, memberVouches: 0, memberLikes: '0',
      invitesUsed: 0, member: false, invitesAvailable: null, height: 10,
    }; },
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => { await f.membershipGate; return { vouches: [], count: 0, next: null }; },
    vouchCooldowns: async () => { await f.membershipGate; return { cooldowns: [], count: 0, next: null }; },
    bonds: async () => { await f.membershipGate; return f.bonds ?? { bonds: [], bondCount: 0, next: null }; },
    usernameByOwner: async () => { await f.membershipGate; return f.ownName ?? null; },
    credits: async () => f.credits ?? ({ userId: ME, total: '0', boxes: [], boxCount: 0, next: null }),
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

/** An identity whose lock and key a case moves. `setLocked` flips the lock
 *  and tells no one — an unlock or a lock made in another page of the
 *  extension reaches `current()` that way; `changeKey` loads another key and
 *  fires `onChange` (WEB_INTERFACE → The identity module). `sign` answers
 *  `locked` while locked. */
export interface LockableIdentity {
  identity: AppIdentity;
  /** Every passphrase `unlock` was called with, in order. */
  unlocks: string[];
  /** The transaction ids signed, in order. */
  signed: string[];
  setLocked(locked: boolean): void;
  changeKey(key: string): void;
}

export function lockableIdentity(key: string, locked = true): LockableIdentity {
  const unlocks: string[] = [];
  const signed: string[] = [];
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  let cur = key;
  let isLocked = locked;
  return {
    unlocks,
    signed,
    setLocked: (next) => { isLocked = next; },
    changeKey: (next) => {
      cur = next;
      isLocked = true;
      for (const l of listeners) l({ pubKeyHex: next });
    },
    identity: {
      current: () => ({ pubKeyHex: cur, locked: isLocked }),
      sign: async (_bytes, txId) => {
        if (isLocked) return { locked: true };
        signed.push(txId);
        return { signature: 'ab'.repeat(64) };
      },
      draft: async () => ({ pubKeyHex: cur }),
      create: async () => ({ pubKeyHex: cur }),
      discardDraft: () => {},
      inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: cur }),
      importFile: async () => ({ pubKeyHex: cur }),
      exportFile: async () => '',
      unlock: async (p) => { unlocks.push(p); isLocked = false; },
      lock: async () => { isLocked = true; },
      forget: async () => {},
      backedUp: () => false,
      onChange: (l) => { listeners.push(l); },
    },
  };
}

/** A write client that records what reaches it and answers as a node that
 *  took the transaction: the id it echoes is the last one `id` signed, which
 *  is the id the flow built (WEB_INTERFACE → The wallet). */
export interface RecordingWrites {
  client: WriteClient;
  /** The target of every like submitted, in order. */
  likes: string[];
  /** The post of every withdrawal submitted, in order. */
  withdrawals: string[];
  /** The content of every post submitted, in order. */
  posts: string[];
  /** The id the node answers the next submitted post under. */
  nextPostId: string;
}

export function recordingWrites(id: LockableIdentity, expiresAtHeight = 730): RecordingWrites {
  const last = (): string => id.signed[id.signed.length - 1]!;
  const w: RecordingWrites = {
    likes: [],
    withdrawals: [],
    posts: [],
    nextPostId: hid('new'),
    client: {
      submitLike: async (tx: Record<string, unknown>) => {
        w.likes.push(String(tx['likeTarget']));
        return { status: 'pending', txId: last(), expiresAtHeight };
      },
      submitWithdraw: async (postId: string) => {
        w.withdrawals.push(postId);
        return { status: 'submitted', txId: last(), postId, expiresAtHeight };
      },
      submitPost: async (_tx: Record<string, unknown>, content: string) => {
        w.posts.push(content);
        return { postId: w.nextPostId, status: 'pending', expiresAtHeight, txId: last() };
      },
    } as unknown as WriteClient,
  };
  return w;
}

/** A `/karma` page holding one box — a key that can sign a like, a reply and
 *  a withdrawal (WEB_INTERFACE → The withdraw control). */
export function karmaWithBox(key: string): KarmaResult {
  return karmaResult({ userId: key, total: '227', effective: '227', boxes: [{ boxId: '11'.repeat(32), value: '227' }], boxCount: 1, height: 10 });
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
    loadMembershipState(): Promise<void>;
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
  /** The identity the App holds, in place of the unlocked one `identityKey`
   *  makes; `identityKey` still names the ledger's key. */
  identity?: AppIdentity;
  writeClient?: WriteClient;
  feedResults?: FeedResult[];
  threadResults?: Array<ThreadResult | null | Error>;
  postRes?: PostResult | null;
  karma?: KarmaResult;
  /** The reader's `/credits` the fake answers before a case changes it; absent
   *  is the empty listing. */
  credits?: import('../src/api/dto').CreditsResult;
  /** The reader's name — the fake's `/usernames?owner=`. */
  ownName?: import('../src/api/dto').UsernameResult;
  /** The reader's standing bonds — the fake's `/invites/:key`. */
  bonds?: import('../src/api/dto').BondsResult;
  mode?: Mode;
  /** `start` drives `App.start` instead of `App.mount` — the product's own
   *  path at page load, which fires `loadFeed`, `fetchThread` for every window
   *  of the restored arrangement, and `rereadReaderState`. Default is `mount`
   *  (every case driving its own reads). */
  boot?: 'mount' | 'start';
  /** The gate the fake holds — the harness writes it onto the fake before any
   *  read fires, so a case opting into `boot: 'start'` can hold the start-up
   *  reads back. */
  membershipGate?: Promise<void>;
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
    postById: new Map(),
    threadById: new Map(),
    karma: opts.karma,
    credits: opts.credits,
    ownName: opts.ownName,
    bonds: opts.bonds,
    membershipGate: opts.membershipGate,
  };
  const api = makeApi(fake);
  const writeClient = opts.writeClient ?? ({} as unknown as WriteClient);
  const key = opts.identityKey === undefined ? null : opts.identityKey;
  const ledger = new PendingLedger(key);
  const identity = opts.identity ?? makeIdentity(key);
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
  if (opts.boot === 'start') app.start(appbar, feedEl, panes, opts.mode);
  else app.mount(appbar, feedEl, panes, opts.mode);
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
