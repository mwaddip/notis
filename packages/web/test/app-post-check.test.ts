// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppState, PostCache, CachedThread, HeldPost, PostResolver, PostsVerifier } from '../src/model/state';
import type { ResolveEnd } from '../src/model/post-resolve';
import type { WriteClient } from '../src/api/write';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type {
  PostJson, PostResult, StatusResult, ThreadResult, FeedResult, BlockCurrent, WithdrawnJson,
} from '../src/api/dto';
import { MAX_CONTENT_BYTES } from '@dagsocial/types';

// The single post read's one-row gate (WEB_INTERFACE → The extension →
// "The post check"): every row of the single post read — read with `tx=1`
// where a posts verifier is held — passes through the gate before it
// enters state and the cache; a withheld answer is used for nothing. The
// list reads bring no bytes and are not checked (→ "A list read brings no
// bytes and is not checked"); the extension-build configuration is
// `verifier + resolver`, and the App's constructor refuses one without
// the other, so a harness holding a verifier passes a resolver beside it.

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

/** A resolver that answers nothing: the stays cases drive the single post
 *  read's path, never a list, so the resolver is never asked. */
function emptyResolver(): PostResolver {
  return { resolve: async (): Promise<Map<string, ResolveEnd>> => new Map() };
}

interface Fake {
  feedRes: FeedResult;
  threadRes: ThreadResult | null;
  postRes: PostResult | null;
}

function makeApi(f: Fake): Api {
  return {
    feed: async (): Promise<FeedResult> => f.feedRes,
    thread: async (): Promise<ThreadResult | null> => f.threadRes,
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

/** A test-only PostCache that records every put and withdraw and reads
 *  nothing — thread and getMany answer empty. The App's cache interactions
 *  are started and not awaited by the renders, so the recorded calls are
 *  the test's assertion surface. */
function recordingCache(): { cache: PostCache; puts: Array<{ id: string; row: PostJson }>; withdraws: Array<{ id: string; row: WithdrawnJson }> } {
  const puts: Array<{ id: string; row: PostJson }> = [];
  const withdraws: Array<{ id: string; row: WithdrawnJson }> = [];
  const cache: PostCache = {
    open: async () => {},
    put: async (entry) => { puts.push({ id: entry.id, row: entry.row }); },
    withdraw: async (id, row) => { withdraws.push({ id, row }); },
    thread: async (): Promise<CachedThread | null> => null,
    getMany: async (): Promise<Map<string, HeldPost>> => new Map(),
    refresh: async () => {},
  };
  return { cache, puts, withdraws };
}

function harness(opts: {
  verifier?: PostsVerifier | null;
  feedRes?: FeedResult;
  threadRes?: ThreadResult | null;
  postRes?: PostResult | null;
  postCache?: PostCache | null;
  identityKey?: string | null;
} = {}) {
  const fake: Fake = {
    feedRes: opts.feedRes ?? { posts: [], next: null, pending: [], pendingCount: 0 },
    threadRes: opts.threadRes ?? null,
    postRes: opts.postRes ?? null,
  };
  const api = makeApi(fake);
  const writeClient = {} as unknown as WriteClient;
  const key = opts.identityKey ?? null;
  const ledger = new PendingLedger(key);
  const identity = {
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
  // The App's constructor refuses a verifier without a resolver, or the
  // reverse (WEB_INTERFACE → The extension → "The post check", → "The
  // resolve"). An empty resolver stands beside the verifier here, since
  // these cases drive the single post read's path alone.
  const verifier = opts.verifier ?? null;
  const resolver = verifier === null ? null : emptyResolver();
  const app = new App(
    api, writeClient, identity, ledger, undefined, undefined,
    null, null, null,
    verifier,
    opts.postCache ?? null,
    resolver,
  );
  const appbar = document.createElement('div');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feedEl, panes);
  app.mount(appbar, feedEl, panes);
  const drive = app as unknown as {
    loadFeed(): Promise<void>;
    openThread(id: string, o: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    pollTick(): Promise<void>;
    ingestOne(r: PostJson | WithdrawnJson): PostJson | WithdrawnJson | null;
    state: AppState;
  };
  return { app, drive, fake, feedEl, panes, ledger };
}

beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; vi.useRealTimers(); });

const BOUND = (r: PostJson): PostCheck =>
  ({ status: 'bound', id: r.id, txBytes: new Uint8Array(0), author: r.author, parent: r.parentRefs[0] ?? null });
const UNBOUND: PostCheck = { status: 'unbound', reason: 'signature', verdict: 'unbound: the author signed something else' };
const NOTHING_TO_BIND: PostCheck = { status: 'nothing-to-bind' };
const UNSERVED: PostCheck = { status: 'unserved' };

describe('post-check — the single post read', () => {
  it('an unbound answer is used for nothing', async () => {
    const subject = row('p');
    const sv = scriptedVerifier(() => UNBOUND);
    const h = harness({ verifier: sv.verifier });
    // The one-row gate drops an `unbound` row — a withheld answer. The
    // reconcile reads a withheld answer as nothing landing, never as the
    // node's 404 (WEB_INTERFACE → The extension → "The post check").
    const app = h.app as unknown as { ingestOne(r: PostJson | WithdrawnJson): PostJson | WithdrawnJson | null };
    expect(app.ingestOne(subject)).toBeNull();
    expect(sv.calls.length).toBe(1);
  });

  it('an unserved answer is used for nothing', async () => {
    const subject = row('p');
    const sv = scriptedVerifier(() => UNSERVED);
    const h = harness({ verifier: sv.verifier });
    const app = h.app as unknown as { ingestOne(r: PostJson | WithdrawnJson): PostJson | WithdrawnJson | null };
    expect(app.ingestOne(subject)).toBeNull();
    expect(sv.calls.length).toBe(1);
  });
});

// The single row's gate rebuilds through the readers and hands the rebuilt
// row on.

describe('post-check — ingestOne rebuilds the row and strips every extra', () => {
  it('a bound row carrying an extra key and `tx` enters state and the cache without either', async () => {
    const r = { ...row('p'), surprise: 'ignored', confirmedAuthor: 'xx'.repeat(32), tx: 'de'.repeat(16) };
    const sv = scriptedVerifier(() => BOUND(r as unknown as PostJson));
    const rec = recordingCache();
    const h = harness({ verifier: sv.verifier, postCache: rec.cache });
    const app = h.app as unknown as {
      ingestOne(r: unknown): PostJson | WithdrawnJson | null;
    };
    const kept = app.ingestOne(r as unknown as PostJson);
    expect(kept).not.toBeNull();
    expect(kept).not.toBe(r);
    const keptRow = kept as unknown as Record<string, unknown>;
    expect(keptRow['surprise']).toBeUndefined();
    expect(keptRow['confirmedAuthor']).toBeUndefined();
    expect(keptRow['tx']).toBeUndefined();
    await flush();
    expect(rec.puts).toHaveLength(1);
    const putRow = rec.puts[0]!.row as unknown as Record<string, unknown>;
    expect(putRow['surprise']).toBeUndefined();
    expect(putRow['confirmedAuthor']).toBeUndefined();
    expect(putRow['tx']).toBeUndefined();
  });

  it('a bound row with a string likeCount is withheld — nothing enters state, nothing is put', async () => {
    const bad = { ...row('p'), likeCount: '3' as unknown as number };
    const sv = scriptedVerifier(() => BOUND(bad as PostJson));
    const rec = recordingCache();
    const h = harness({ verifier: sv.verifier, postCache: rec.cache });
    const app = h.app as unknown as {
      ingestOne(r: unknown): PostJson | WithdrawnJson | null;
    };
    expect(app.ingestOne(bad as unknown as PostJson)).toBeNull();
    await flush();
    expect(rec.puts).toHaveLength(0);
  });

  it('a bound row whose content is over MAX_CONTENT_BYTES is withheld', async () => {
    const bad = { ...row('p'), content: 'a'.repeat(MAX_CONTENT_BYTES + 1) };
    const sv = scriptedVerifier(() => BOUND(bad as PostJson));
    const rec = recordingCache();
    const h = harness({ verifier: sv.verifier, postCache: rec.cache });
    const app = h.app as unknown as {
      ingestOne(r: unknown): PostJson | WithdrawnJson | null;
    };
    expect(app.ingestOne(bad as unknown as PostJson)).toBeNull();
    await flush();
    expect(rec.puts).toHaveLength(0);
  });
});

describe('post-check — ingestOne and the withdrawn arm', () => {
  it('a well-formed withdrawn answer calls the cache\'s withdraw once with the rebuilt row', async () => {
    const w = { ...tomb('p'), surprise: 'ignored' };
    const sv = scriptedVerifier(() => NOTHING_TO_BIND);
    const rec = recordingCache();
    const h = harness({ verifier: sv.verifier, postCache: rec.cache });
    const app = h.app as unknown as {
      ingestOne(r: unknown): PostJson | WithdrawnJson | null;
    };
    const kept = app.ingestOne(w as unknown as WithdrawnJson);
    expect(kept).not.toBeNull();
    expect((kept as WithdrawnJson).kind).toBe('withdrawn');
    await flush();
    expect(rec.withdraws).toHaveLength(1);
    expect(rec.withdraws[0]!.id).toBe(w.id);
    // The row handed to the cache carries no extra key.
    const r = rec.withdraws[0]!.row as unknown as Record<string, unknown>;
    expect(r['surprise']).toBeUndefined();
  });

  it('a withdrawn answer that is not well-formed is withheld — the cache is not told', async () => {
    const bad = { ...tomb('p'), author: 'nothex' as unknown as string };
    const sv = scriptedVerifier(() => NOTHING_TO_BIND);
    const rec = recordingCache();
    const h = harness({ verifier: sv.verifier, postCache: rec.cache });
    const app = h.app as unknown as {
      ingestOne(r: unknown): PostJson | WithdrawnJson | null;
    };
    expect(app.ingestOne(bad as unknown as WithdrawnJson)).toBeNull();
    await flush();
    expect(rec.withdraws).toHaveLength(0);
  });
});

describe('post-check — with no verifier the node\'s row goes through as it is', () => {
  it('a bound row with an extra key goes to state through ingestOne', async () => {
    const r = { ...row('p'), surprise: 'kept' };
    const h = harness({ verifier: null });
    const app = h.app as unknown as {
      ingestOne(r: unknown): PostJson | WithdrawnJson | null;
    };
    const kept = app.ingestOne(r as unknown as PostJson);
    expect(kept).toBe(r);
    expect((kept as unknown as Record<string, unknown>)['surprise']).toBe('kept');
  });
});

// The pending ledger's single post read is driven end to end: an entry in
// the ledger, the node's answer in `postRes`, then the poll. The ledger's
// read is the one site reconcile hands to each kind, so an answer that
// bypassed `ingestOne` would land here.

describe('post-check — the ledger\'s read hands reconcile the rebuilt row', () => {
  it('a like\'s landing writes the rebuilt row to state.posts and the cache, each without `tx`, `confirmedAuthor` or an extra key', async () => {
    const base = row('p', { likedByViewer: true });
    const answer = {
      ...base, likedByViewer: true, tx: 'de'.repeat(16),
      confirmedAuthor: ME, surprise: 'ignored',
    };
    const sv = scriptedVerifier(() => BOUND(answer as unknown as PostJson));
    const rec = recordingCache();
    const h = harness({
      verifier: sv.verifier, postCache: rec.cache,
      postRes: answer as unknown as PostResult, identityKey: ME,
    });
    h.ledger.add({
      txId: 'like' + base.id.slice(0, 10), kind: 'like', postId: base.id,
      inputs: [], expiresAtHeight: 721, submittedAtHeight: 1,
    });
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    const stored = h.drive.state.posts.get(base.id) as unknown as Record<string, unknown> | undefined;
    expect(stored).toBeDefined();
    expect(stored!['surprise']).toBeUndefined();
    expect(stored!['confirmedAuthor']).toBeUndefined();
    expect(stored!['tx']).toBeUndefined();
    expect(rec.puts).toHaveLength(1);
    const put = rec.puts[0]!.row as unknown as Record<string, unknown>;
    expect(put['surprise']).toBeUndefined();
    expect(put['confirmedAuthor']).toBeUndefined();
    expect(put['tx']).toBeUndefined();
  });

  it('a `bound` answer whose `likeCount` is a string is withheld: the entry stays, state.posts is empty, nothing is put', async () => {
    const base = row('p', { likedByViewer: true });
    const bad = { ...base, likeCount: '3' as unknown as number, likedByViewer: true };
    const sv = scriptedVerifier(() => BOUND(bad as PostJson));
    const rec = recordingCache();
    const h = harness({
      verifier: sv.verifier, postCache: rec.cache,
      postRes: bad as unknown as PostResult, identityKey: ME,
    });
    h.ledger.add({
      txId: 'like' + base.id.slice(0, 10), kind: 'like', postId: base.id,
      inputs: [], expiresAtHeight: 721, submittedAtHeight: 1,
    });
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(1);
    expect(h.drive.state.posts.get(base.id)).toBeUndefined();
    expect(rec.puts).toHaveLength(0);
  });

  it('a `bound` answer whose content is one byte over MAX_CONTENT_BYTES is withheld: the entry stays, state.posts is empty, nothing is put', async () => {
    const base = row('p', { likedByViewer: true });
    const bad = { ...base, content: 'a'.repeat(MAX_CONTENT_BYTES + 1), likedByViewer: true };
    const sv = scriptedVerifier(() => BOUND(bad as PostJson));
    const rec = recordingCache();
    const h = harness({
      verifier: sv.verifier, postCache: rec.cache,
      postRes: bad as unknown as PostResult, identityKey: ME,
    });
    h.ledger.add({
      txId: 'like' + base.id.slice(0, 10), kind: 'like', postId: base.id,
      inputs: [], expiresAtHeight: 721, submittedAtHeight: 1,
    });
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(1);
    expect(h.drive.state.posts.get(base.id)).toBeUndefined();
    expect(rec.puts).toHaveLength(0);
  });

  it('a well-formed withdrawn answer lands the withdrawal: the entry leaves, the cache\'s withdraw is called once with a rebuilt row', async () => {
    const w = { ...tomb('p'), surprise: 'ignored' };
    const sv = scriptedVerifier(() => NOTHING_TO_BIND);
    const rec = recordingCache();
    const h = harness({
      verifier: sv.verifier, postCache: rec.cache,
      postRes: w as unknown as PostResult, identityKey: ME,
    });
    h.ledger.add({
      txId: 'wd' + w.id.slice(0, 10), kind: 'withdraw', postId: w.id,
      inputs: [], expiresAtHeight: 721, submittedAtHeight: 1,
    });
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(rec.withdraws).toHaveLength(1);
    expect(rec.withdraws[0]!.id).toBe(w.id);
    const r = rec.withdraws[0]!.row as unknown as Record<string, unknown>;
    expect(r['surprise']).toBeUndefined();
  });

  it('a withdrawn answer whose `author` is not hex is withheld: the entry stays, the cache is not told', async () => {
    const w = { ...tomb('p'), author: 'nothex' as unknown as string };
    const sv = scriptedVerifier(() => NOTHING_TO_BIND);
    const rec = recordingCache();
    const h = harness({
      verifier: sv.verifier, postCache: rec.cache,
      postRes: w as unknown as PostResult, identityKey: ME,
    });
    h.ledger.add({
      txId: 'wd' + w.id.slice(0, 10), kind: 'withdraw', postId: w.id,
      inputs: [], expiresAtHeight: 721, submittedAtHeight: 1,
    });
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(1);
    expect(rec.withdraws).toHaveLength(0);
  });

  it('with no verifier the node\'s row is the row in state, extra key and all', async () => {
    const base = row('p', { likedByViewer: true });
    const answer = { ...base, likedByViewer: true, surprise: 'kept' };
    const h = harness({
      verifier: null, postRes: answer as unknown as PostResult, identityKey: ME,
    });
    h.ledger.add({
      txId: 'like' + base.id.slice(0, 10), kind: 'like', postId: base.id,
      inputs: [], expiresAtHeight: 721, submittedAtHeight: 1,
    });
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    const stored = h.drive.state.posts.get(base.id) as unknown as Record<string, unknown> | undefined;
    expect(stored).toBeDefined();
    expect(stored!['surprise']).toBe('kept');
  });
});
