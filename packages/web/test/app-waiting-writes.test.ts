// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { WaitingStore, type WaitingStorage } from '../src/wallet/waiting';
import { fakeLockManager } from './fake-chrome';
import { ApiError } from '../src/api/errors';
import { karmaResult as karmaFixture } from './karma-fixture';
import { setNode } from '../src/prefs';
import type { Api } from '../src/api/client';
import type { AppIdentity, PostCache, TipVerifier, HeldPost } from '../src/model/state';
import type { WriteClient, LikeSubmitResult, PostSubmitResult, SendSubmitResult } from '../src/api/write';
import type { KarmaResult, PostResult, StatusResult, FeedResult, BlockCurrent, CreditsResult } from '../src/api/dto';
import type { Anchor } from '@dagsocial/nipopow-client';
import type { TipVerdict } from '../src/model/tip-verdict';

// WEB_INTERFACE → The wallet → "A write no node answers waits", → "Waiting
// writes go out at the first answer", → "A refusal ends what it strands",
// → "A waiting write is drawn as pending".

const PUB = 'aa'.repeat(32);
const PUB2 = 'cc'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const BOX = '11'.repeat(32);
const CREDIT_BOX = '55'.repeat(32);
const TARGET = 'c1'.repeat(32);
const RECIPIENT = 'd1'.repeat(32);
const CHAIN = 'ab'.repeat(32);

const NO_ANSWER = new ApiError(0, 'fetch failed');
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function confirmedPost(id: string, author = AUTHOR): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: author, txId: 'ff'.repeat(32),
  };
}
function karmaFor(hex = PUB, effective = '227'): KarmaResult {
  return karmaFixture({ userId: hex, total: effective, effective, boxes: [{ boxId: BOX, value: effective }], boxCount: 1, height: 6000 });
}
function creditsFor(hex = PUB): CreditsResult {
  return { userId: hex, total: '10000000000', boxes: [{ boxId: CREDIT_BOX, value: '10000000000' }], boxCount: 1, next: null };
}

function fakeHeader(height: number, suffix = 'aa'): Anchor['tip'] {
  return {
    protocolVersion: 1, height,
    prevBlockHash: '00'.repeat(32), utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + suffix,
    validatorId: new Uint8Array(32),
    powNonce: 0, powTargetBits: 0x1d00ffff, createdAt: 0,
    interlinkRoot: '00'.repeat(32), adProofsRoot: '00'.repeat(32),
  };
}
function anchorFor(h: number): Anchor { return { tip: fakeHeader(h), suffixHead: fakeHeader(h - 19) }; }
const verifiedVerdict = (nodes: number, height: number): TipVerdict => ({ kind: 'verified', nodes, height });

interface TipRunLike { verdict: TipVerdict; anchor: Anchor | null; chain: string | null }
interface TipTrap { resolve: (v: TipRunLike) => void; reject: (e: unknown) => void; promise: Promise<TipRunLike> }

interface Opts {
  withIdentity?: boolean;
  withSeam?: boolean;
  readsNoAnswer?: boolean;
  writeNoAnswer?: boolean;
  karmaBox?: string;
  cachedAuthors?: Map<string, string>;
  rememberChain?: string | null;
}

interface Harness {
  app: App;
  storage: Storage;
  karmaReads(): number;
  feedReads(): number;
  cornerReads(): number;
  postPosts(): number;
  likePosts(): number;
  sendPosts(): number;
  signCount(): number;
  setReadsNoAnswer(v: boolean): void;
  setWriteNoAnswer(v: boolean): void;
  holdNextPost(): void;
  releaseNextPost(): void;
  tipRuns: TipTrap[];
  writeBodies: Array<{ kind: string; body: Record<string, unknown> }>;
  switchIdentity(key: string | null): void;
  drive: {
    openComposer(parentId: string | null): void;
    submitComposer(parentId: string | null, text: string): Promise<void>;
    likePost(postId: string): Promise<void>;
    send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
    loadFeed(): Promise<void>;
    cornerTick(): Promise<void>;
    startVerification(): void;
    optimisticLikes: Set<string>;
    state: { feed: unknown; submissions: Array<{ stage: string; txId: string | null; postId: string | null; reason: string | null; content: string; parentId: string | null }> };
    ledger: PendingLedger;
    pollTimer: unknown;
    composers: Map<string, { el: HTMLElement }>;
    waitingStore: WaitingStore | null;
    tipChain: string | null;
  };
}

/** Compute postId the way the client does — must match what WaitingStore
 *  recorded for a waiting post entry. */
async function computePostIdForTx(txId: string): Promise<string> {
  const { computePostId } = await import('@dagsocial/types');
  return computePostId(txId, 0);
}

function harness(opts: Opts = {}): Harness {
  // The seam's `rememberedChain` is the App's one path to the chain the
  // post-cache module stored (WEB_INTERFACE → The extension → "The post
  // cache"). The harness defaults to `CHAIN`; `rememberChain: null` opts out.
  const chainForSeam = opts.rememberChain === null ? null : (opts.rememberChain ?? CHAIN);
  const signCalls: string[] = [];
  const currentKey: { hex: string | null } = { hex: opts.withIdentity === false ? null : PUB };
  let changeListener: ((id: { pubKeyHex: string } | null) => void) | null = null;

  const identity: AppIdentity = {
    current: () => (currentKey.hex === null ? null : { pubKeyHex: currentKey.hex, locked: false }),
    sign: async (_bytes, t) => { signCalls.push(t); return { signature: 'ab'.repeat(64) }; },
    draft: async () => ({ pubKeyHex: currentKey.hex ?? PUB }),
    create: async () => ({ pubKeyHex: currentKey.hex ?? PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: (fn) => { changeListener = fn; },
  };

  let readsNoAnswer = opts.readsNoAnswer ?? false;
  let writeNoAnswer = opts.writeNoAnswer ?? false;

  let karmaN = 0;
  let feedN = 0;
  let cornerN = 0;
  let postN = 0;
  let likeN = 0;
  let sendN = 0;

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => {
      feedN++;
      if (readsNoAnswer) throw NO_ANSWER;
      return { posts: [], next: null, pending: [], pendingCount: 0 };
    },
    thread: async () => null,
    post: async (id) => {
      if (readsNoAnswer) throw NO_ANSWER;
      return confirmedPost(id);
    },
    status: async () => {
      if (readsNoAnswer) throw NO_ANSWER;
      return statusResult();
    },
    currentBlock: async (): Promise<BlockCurrent> => {
      cornerN++;
      if (readsNoAnswer) throw NO_ANSWER;
      return { height: 6001, hash: null };
    },
    karma: async () => {
      karmaN++;
      if (readsNoAnswer) throw NO_ANSWER;
      return karmaFor(currentKey.hex ?? PUB);
    },
    credits: async () => {
      if (readsNoAnswer) throw NO_ANSWER;
      return creditsFor(currentKey.hex ?? PUB);
    },
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    usernameByName: async () => null,
  };

  const writeBodies: Array<{ kind: string; body: Record<string, unknown> }> = [];
  const noAnswerRejection = { status: 0, message: 'fetch failed', noAnswer: true as const };
  let heldPostResolve: (() => void) | null = null;
  let holdPostNext = false;
  const lastTxId = (): string => signCalls[signCalls.length - 1] ?? '';

  const writeClient = {
    submitPost: async (body: Record<string, unknown>, content: string): Promise<PostSubmitResult | typeof noAnswerRejection> => {
      postN++;
      writeBodies.push({ kind: 'post', body });
      void content;
      if (writeNoAnswer) return noAnswerRejection;
      if (holdPostNext) {
        holdPostNext = false;
        await new Promise<void>((r) => { heldPostResolve = r; });
      }
      const tx = lastTxId();
      const { computePostId } = await import('@dagsocial/types');
      return { postId: computePostId(tx, 0), status: 'pending', expiresAtHeight: 6720, txId: tx };
    },
    submitLike: async (body: Record<string, unknown>): Promise<LikeSubmitResult | typeof noAnswerRejection> => {
      likeN++;
      writeBodies.push({ kind: 'like', body });
      if (writeNoAnswer) return noAnswerRejection;
      return { status: 'pending', txId: lastTxId(), expiresAtHeight: 6720 };
    },
    submitSend: async (body: Record<string, unknown>): Promise<SendSubmitResult | typeof noAnswerRejection> => {
      sendN++;
      writeBodies.push({ kind: 'send', body });
      if (writeNoAnswer) return noAnswerRejection;
      return { status: 'pending', txId: lastTxId(), expiresAtHeight: 6720 };
    },
    submitVouch: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720 }),
    submitUnvouch: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720 }),
    submitInvite: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720, bondBoxId: 'bb'.repeat(32) }),
    submitWithdraw: async () => ({ status: 'submitted' as const, txId: lastTxId(), postId: 'x', expiresAtHeight: 6720 }),
    submitClaim: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720, name: 'x' }),
    submitBurn: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720 }),
  } as unknown as WriteClient;

  // Minimal PostCache for cachedAuthor: answers from a Map; everything else no-op.
  const cachedAuthors = opts.cachedAuthors ?? new Map<string, string>();
  const postCache: PostCache = {
    open: async () => {},
    openRemembered: async () => {},
    put: async () => {},
    withdraw: async () => {},
    thread: async () => null,
    getMany: async (ids) => {
      const out = new Map<string, HeldPost>();
      for (const id of ids) {
        const author = cachedAuthors.get(id);
        if (author !== undefined) {
          out.set(id, { row: confirmedPost(id, author), author, parent: null });
        }
      }
      return out;
    },
    refresh: async () => {},
    roots: async () => [],
    byAuthor: async () => [],
  };

  const tipRuns: TipTrap[] = [];
  const tipVerifier: TipVerifier = {
    run: () => {
      let resolve!: (v: TipRunLike) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<TipRunLike>((r, j) => { resolve = r; reject = j; });
      tipRuns.push({ resolve, reject, promise });
      return promise;
    },
  };

  const waitingSeam = opts.withSeam === false
    ? undefined
    : {
        storage: window.localStorage as WaitingStorage,
        locks: fakeLockManager(),
        rememberedChain: (): string | null => chainForSeam,
      };

  const ledger = new PendingLedger(currentKey.hex);
  const app = new App(
    fakeApi, writeClient, identity, ledger, undefined, undefined,
    tipVerifier, undefined, undefined, undefined, postCache, undefined,
    undefined, waitingSeam,
  );
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);

  return {
    app,
    storage: window.localStorage,
    karmaReads: () => karmaN,
    feedReads: () => feedN,
    cornerReads: () => cornerN,
    postPosts: () => postN,
    likePosts: () => likeN,
    sendPosts: () => sendN,
    signCount: () => signCalls.length,
    setReadsNoAnswer: (v) => { readsNoAnswer = v; },
    setWriteNoAnswer: (v) => { writeNoAnswer = v; },
    holdNextPost: () => { holdPostNext = true; },
    releaseNextPost: () => { heldPostResolve?.(); heldPostResolve = null; },
    tipRuns,
    writeBodies,
    switchIdentity: (key) => {
      currentKey.hex = key;
      if (changeListener !== null) changeListener(key === null ? null : { pubKeyHex: key });
    },
    drive: app as unknown as Harness['drive'],
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function resolveTipRunVerified(h: Harness): Promise<void> {
  await flush();
  // The App started a verification at mount; drain it with a verified verdict.
  if (h.tipRuns.length === 0) await flush();
  const run = h.tipRuns[h.tipRuns.length - 1];
  if (run === undefined) throw new Error('no tip run started');
  run.resolve({ verdict: verifiedVerdict(2, 6001), anchor: anchorFor(6001), chain: CHAIN });
  await flush();
}

/** Record a rep and a credits base so a flow whose reads get no answer can
 *  build from the view (WEB_INTERFACE → The wallet → "The waiting view"). */
function primeBases(h: Harness): void {
  const store = h.drive.waitingStore;
  if (store === null) throw new Error('no waiting store to prime');
  store.recordBase('rep', {
    spendable: [{ boxId: BOX, value: 227n }],
    effective: 227n, height: 6000, era: 1, author: PUB,
  }, CHAIN);
  store.recordBase('credits', {
    spendable: [{ boxId: CREDIT_BOX, value: 10_000_000_000n }],
    height: 6000, era: 1, author: PUB,
  }, CHAIN);
}

// -------------------------------------------------------------------------
// The waiting arm.
// -------------------------------------------------------------------------

describe('a post pressed with no node answering draws waiting for a node', () => {
  it('a root post waits: no POST goes, the submission reads stage waiting, the ledger holds a waiting entry', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.postPosts()).toBe(0);
    const subs = h.drive.state.submissions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.stage).toBe('waiting');
    expect(subs[0]!.txId).not.toBeNull();
    const entries = h.drive.ledger.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('post');
    expect(entries[0]!.waiting).toBe(true);
  });
});

describe('it is sent when the corner\'s read next answers, and goes on as submitted', () => {
  it('cornerTick success triggers flush — one POST /posts, the submission settles as submitted', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.postPosts()).toBe(0);
    // Reads come back; cornerTick succeeds and triggers the flush.
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    expect(h.postPosts()).toBe(1);
    const subs = h.drive.state.submissions;
    expect(subs[0]!.stage).toBe('submitted');
    expect(subs[0]!.postId).not.toBeNull();
    // The entry is no longer waiting.
    const e = h.drive.ledger.all()[0]!;
    expect(e.waiting).toBeUndefined();
  });
});

describe('a like pressed with no node answering keeps its overlay muted, and is sent at the answer', () => {
  it('like waits, overlay stands, flush sends it once', async () => {
    const cache = new Map<string, string>([[TARGET, AUTHOR]]);
    const h = harness({ rememberChain: CHAIN, cachedAuthors: cache });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    await h.drive.likePost(TARGET);
    await flush();
    // The overlay stands muted (via pendingLikeTargets reading the ledger).
    expect(h.drive.optimisticLikes.has(TARGET)).toBe(true);
    // No POST — the reads got no answer, the write was not called.
    expect(h.likePosts()).toBe(0);
    // One waiting like in the ledger.
    expect(h.drive.ledger.all().filter((e) => e.kind === 'like' && e.waiting === true)).toHaveLength(1);
    // Reads come back; cornerTick triggers the flush; one POST goes out.
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    expect(h.likePosts()).toBe(1);
  });
});

describe('a send to a key waits and goes out at the answer', () => {
  it('a send waits, cornerTick success triggers flush, POST /credits/transfer leaves once', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    await h.drive.send(RECIPIENT, null, 1_250_000_000n);
    await flush();
    expect(h.sendPosts()).toBe(0);
    const waiting = h.drive.ledger.all().find((e) => e.kind === 'send');
    expect(waiting?.waiting).toBe(true);
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    expect(h.sendPosts()).toBe(1);
    const sent = h.drive.ledger.all().find((e) => e.kind === 'send');
    expect(sent?.waiting).toBeUndefined();
  });
});

describe('a reload with waiting entries draws them waiting and sends them at the first answer', () => {
  it('a fresh App over the same storage holds the waiting entry and sends it at the first cornerTick', async () => {
    // First App: prime a waiting post.
    const h1 = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h1);
    primeBases(h1);
    h1.setReadsNoAnswer(true);
    h1.drive.openComposer(null);
    await h1.drive.submitComposer(null, 'a thread');
    await flush();
    const h1Waiting = h1.drive.ledger.all().filter((e) => e.waiting === true);
    expect(h1Waiting).toHaveLength(1);
    const txIdOfStored = h1Waiting[0]!.txId;
    // Rebuild a second App over the same localStorage; the ledger restores,
    // and so does the waiting store for that key.
    document.body.innerHTML = '';
    const h2 = harness({ rememberChain: CHAIN });
    // The restored ledger has the waiting entry.
    expect(h2.drive.ledger.all().filter((e) => e.waiting === true)).toHaveLength(1);
    // The signing happened in h1, so h2's write client echoes a stale `txId`
    // by default. Override it to echo the restored entry's txId — in
    // production the node computes the id from the signed bytes.
    const { computePostId } = await import('@dagsocial/types');
    const wc = (h2.app as unknown as { writeClient: { submitPost: (b: unknown, c: string) => Promise<unknown> } }).writeClient;
    let posts = 0;
    wc.submitPost = async (): Promise<PostSubmitResult> => {
      posts++;
      return { postId: computePostId(txIdOfStored, 0), status: 'pending', expiresAtHeight: 6720, txId: txIdOfStored };
    };
    await resolveTipRunVerified(h2);
    await h2.drive.cornerTick();
    await flush();
    expect(posts).toBe(1);
    const e = h2.drive.ledger.all()[0]!;
    expect(e.waiting).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// A waiting post's pending card is drawn from its record after a reload
// (WEB_INTERFACE → The wallet → "A waiting write is drawn as pending").
// -------------------------------------------------------------------------

describe('a waiting post is drawn as pending across a reload', () => {
  it('a reload draws a waiting post\'s pending card from its record, waiting for a node', async () => {
    const h1 = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h1);
    primeBases(h1);
    h1.setReadsNoAnswer(true);
    h1.drive.openComposer(null);
    await h1.drive.submitComposer(null, 'a thread');
    await flush();
    const waiting1 = h1.drive.ledger.all().find((e) => e.waiting === true)!;
    const storedTxId = waiting1.txId;
    const storedPostId = waiting1.postId;
    // A fresh App over the same localStorage — the waiting store rehydrates
    // the submission so the pending card can be drawn without a node listing.
    document.body.innerHTML = '';
    const h2 = harness({ rememberChain: CHAIN });
    await flush();
    const subs = h2.drive.state.submissions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.stage).toBe('waiting');
    expect(subs[0]!.txId).toBe(storedTxId);
    expect(subs[0]!.postId).toBe(storedPostId);
    expect(subs[0]!.content).toBe('a thread');
    expect(subs[0]!.parentId).toBeNull(); // a root
  });

  it('a waiting reply drawn after a reload sits under its parent', async () => {
    const parentId = 'c2'.repeat(32);
    const cache = new Map<string, string>([[parentId, AUTHOR]]);
    const h1 = harness({ rememberChain: CHAIN, cachedAuthors: cache });
    await resolveTipRunVerified(h1);
    primeBases(h1);
    h1.setReadsNoAnswer(true);
    h1.drive.openComposer(parentId);
    await h1.drive.submitComposer(parentId, 'a reply');
    await flush();
    const waiting1 = h1.drive.ledger.all().find((e) => e.waiting === true)!;
    expect(waiting1.kind).toBe('post');
    document.body.innerHTML = '';
    const h2 = harness({ rememberChain: CHAIN, cachedAuthors: cache });
    await flush();
    const subs = h2.drive.state.submissions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.parentId).toBe(parentId);
    expect(subs[0]!.content).toBe('a reply');
    expect(subs[0]!.stage).toBe('waiting');
  });

  it('a waiting post drawn after a reload stands once while the listing fails', async () => {
    const h1 = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h1);
    primeBases(h1);
    h1.setReadsNoAnswer(true);
    h1.drive.openComposer(null);
    await h1.drive.submitComposer(null, 'a thread');
    await flush();
    const waiting1 = h1.drive.ledger.all().find((e) => e.waiting === true)!;
    const postId = waiting1.postId!;
    // A fresh App over the same localStorage: the submission is hydrated as
    // waiting, and the cache's roots carry the same post (its onCachePost
    // ran at the wait in h1). The feed's first page fails, the cache draws,
    // and the card must stand once — the submission's card alone.
    document.body.innerHTML = '';
    const h2 = harness({ rememberChain: CHAIN });
    const row = confirmedPost(postId, PUB);
    const held: HeldPost = { row, author: PUB, parent: null };
    const cache = (h2.app as unknown as { postCache: PostCache }).postCache;
    cache.roots = async (): Promise<HeldPost[]> => [held];
    h2.setReadsNoAnswer(true);
    await resolveTipRunVerified(h2);
    await h2.drive.loadFeed();
    await flush();
    const cards = document.querySelectorAll(`.card[data-post-id="${postId}"]`);
    expect(cards).toHaveLength(1);
  });

  it('the drawn card goes on as submitted when the send pass sends it', async () => {
    const h1 = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h1);
    primeBases(h1);
    h1.setReadsNoAnswer(true);
    h1.drive.openComposer(null);
    await h1.drive.submitComposer(null, 'a thread');
    await flush();
    const waiting1 = h1.drive.ledger.all().find((e) => e.waiting === true)!;
    const txIdOfStored = waiting1.txId;
    // A fresh App over the same storage: submission hydrates waiting, ledger
    // restores waiting. Override the write client to echo the stored txId —
    // in production the node computes the id from the signed bytes.
    document.body.innerHTML = '';
    const h2 = harness({ rememberChain: CHAIN });
    const { computePostId } = await import('@dagsocial/types');
    const wc = (h2.app as unknown as { writeClient: { submitPost: (b: unknown, c: string) => Promise<unknown> } }).writeClient;
    wc.submitPost = async (): Promise<PostSubmitResult> => ({
      postId: computePostId(txIdOfStored, 0), status: 'pending', expiresAtHeight: 6720, txId: txIdOfStored,
    });
    await resolveTipRunVerified(h2);
    await h2.drive.cornerTick();
    await flush();
    const subs = h2.drive.state.submissions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.stage).toBe('submitted');
    expect(subs[0]!.txId).toBe(txIdOfStored);
    expect(subs[0]!.postId).toBe(computePostId(txIdOfStored, 0));
  });
});

describe('nothing is sent before the tip run names the chain', () => {
  it('a cornerTick before the tip run does not send a waiting write', async () => {
    const h = harness({ rememberChain: CHAIN });
    // Resolve the first tip run (so the post flow has a chain to build under
    // via `rememberedChain`, not `tipChain`).
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    // One waiting entry. Now simulate: the App's tipChain is cleared (as on a
    // node change). A cornerTick succeeding must not send anything while the
    // chain is not named by the verifier.
    (h.app as unknown as { tipChain: string | null }).tipChain = null;
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    expect(h.postPosts()).toBe(0); // nothing sent while tipChain is null
  });
});

describe('an identity change: the other key\'s waiting writes are neither drawn nor sent, and go out when it is loaded again', () => {
  it('switch, then back', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    const firstEntries = h.drive.ledger.all();
    expect(firstEntries.filter((e) => e.waiting === true)).toHaveLength(1);
    const firstTxId = firstEntries[0]!.txId;
    // Switch to PUB2.
    h.switchIdentity(PUB2);
    await flush();
    expect(h.drive.ledger.all()).toHaveLength(0); // PUB2 has no waiting writes
    // A cornerTick while PUB2 is loaded must not send PUB1's entries. Keep
    // reads no-answer so the switch-back's loadFeed does not auto-flush.
    await h.drive.cornerTick();
    await flush();
    expect(h.postPosts()).toBe(0);
    // Switch back to PUB1, reads still no-answer.
    h.switchIdentity(PUB);
    await flush();
    const restored = h.drive.ledger.all().find((e) => e.txId === firstTxId);
    expect(restored?.waiting).toBe(true);
    // Reads come back; a cornerTick triggers flush and sends it.
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    expect(h.postPosts()).toBe(1);
  });
});

describe('a press made while the send pass runs waits behind it and builds on the view after it', () => {
  it('a new like waits behind the flush, no second POST before the flush answers', async () => {
    const cache = new Map<string, string>([[TARGET, AUTHOR]]);
    const h = harness({ rememberChain: CHAIN, cachedAuthors: cache });
    await resolveTipRunVerified(h);
    primeBases(h);
    // Record a waiting post so there's work for the flush.
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    // Now hold the next POST /posts and let the flush fire via cornerTick.
    h.setReadsNoAnswer(false);
    h.holdNextPost();
    void h.drive.cornerTick();
    await flush();
    // The flush is sending the post — held. A like press now waits behind it.
    expect(h.postPosts()).toBe(1); // sent, held
    void h.drive.likePost(TARGET);
    await flush();
    expect(h.likePosts()).toBe(0); // waits behind the flush
    // Release the flush — the second press runs.
    h.releaseNextPost();
    await flush();
    expect(h.likePosts()).toBe(1);
  });
});

describe('a refused waiting write and the one behind it read their lines', () => {
  it('a refused like strands the one behind it', async () => {
    const cache = new Map<string, string>([[TARGET, AUTHOR]]);
    const h = harness({ rememberChain: CHAIN, cachedAuthors: cache });
    await resolveTipRunVerified(h);
    primeBases(h);
    // Two waiting likes — the second spends the first's change.
    h.setReadsNoAnswer(true);
    await h.drive.likePost(TARGET);
    await flush();
    const target2 = 'c2'.repeat(32);
    cache.set(target2, AUTHOR);
    await h.drive.likePost(target2);
    await flush();
    expect(h.drive.ledger.all().filter((e) => e.waiting === true)).toHaveLength(2);
    // The write client answers a client rejection on the next like (409).
    const writeMock = (h.app as unknown as { writeClient: WriteClient }).writeClient;
    const originalLike = writeMock.submitLike.bind(writeMock);
    let seq = 0;
    writeMock.submitLike = (async (body: Record<string, unknown>) => {
      seq++;
      if (seq === 1) return { status: 409, message: 'already liked this post' };
      return originalLike(body);
    }) as typeof writeMock.submitLike;
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    // Both are gone from the store and the ledger — the first refused, the
    // second stranded as 'behind-refused'.
    expect(h.drive.ledger.all().filter((e) => e.kind === 'like')).toHaveLength(0);
  });
});

describe('the poll does not run for waiting entries alone', () => {
  it('a waiting-only ledger does not start the poll timer', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.drive.pollTimer).toBeNull();
  });
});

describe('a waiting entry another page sent is released here and reconciled', () => {
  it('the store record is gone, a cornerTick answers, the entry is released at that tip, and reconcile lands it', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    const waiting = h.drive.ledger.all().find((e) => e.waiting === true);
    expect(waiting?.kind).toBe('post');
    const txId = waiting!.txId;
    // Another page's send pass absorbed the store record — ours did not.
    h.drive.waitingStore!.remove(txId);
    // Reads come back; a cornerTick answers at a tip above zero. The orphan
    // release runs on that tick (even though the store lists nothing to
    // flush) and stamps the entry's submittedAtHeight at viewerTip.
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    const released = h.drive.ledger.all().find((e) => e.txId === txId)!;
    expect(released.waiting).toBeUndefined();
    expect(released.submittedAtHeight).toBe(6001);
    expect(released.expiresAtHeight).toBeGreaterThan(6001);
    // Reconcile the entry: the node answers confirmed; the entry lands and
    // is removed from the ledger.
    await (h.app as unknown as { pollTick(): Promise<void> }).pollTick();
    await flush();
    expect(h.drive.ledger.all().find((e) => e.txId === txId)).toBeUndefined();
  });
});

describe('no release before a tip is read', () => {
  it('an identity change with an orphaned waiting entry: the entry still reads waiting until a cornerTick answers', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    const waiting = h.drive.ledger.all().find((e) => e.waiting === true);
    const txId = waiting!.txId;
    h.drive.waitingStore!.remove(txId); // another page dealt with it
    // Switch to PUB2, then back to PUB: dropReaderState sets viewerTip to 0.
    h.switchIdentity(PUB2);
    await flush();
    h.switchIdentity(PUB);
    await flush();
    // The restored ledger still holds the entry as waiting — no tip is read,
    // so releaseOrphanWaiting did nothing on the identity change.
    const afterSwitch = h.drive.ledger.all().find((e) => e.txId === txId)!;
    expect(afterSwitch.waiting).toBe(true);
    // Now a cornerTick answers — release runs.
    h.setReadsNoAnswer(false);
    await h.drive.cornerTick();
    await flush();
    const released = h.drive.ledger.all().find((e) => e.txId === txId)!;
    expect(released.waiting).toBeUndefined();
  });
});

describe('the web build never waits', () => {
  it('no seam: a read with no answer ends the press as today\'s transport failure', async () => {
    const h = harness({ withSeam: false });
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.drive.ledger.all()).toHaveLength(0);
    const subs = h.drive.state.submissions;
    // The composer path: pre-sign read threw and onSigned never fired — the
    // composer is still open with its text, no submission landed.
    expect(subs).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
// The composer's affordability read: WEB_INTERFACE → Invariants →
// "Affordability is known before the attempt" — a read no node answers takes
// the waiting view's `effective` instead, so a composer opened while no node
// answers offers `post` as the post it would make can wait.
// -------------------------------------------------------------------------

const postBtnOf = (el: HTMLElement): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent === 'post' || b.textContent === 'working…') as HTMLButtonElement;
const karmaText = (el: HTMLElement): string | null => el.querySelector('.karma')?.textContent ?? null;

describe('a composer opened while no node answers offers post against the waiting view', () => {
  it('a recorded base with effective >= the price → post enabled; pressing it waits (one waiting entry, no POST)', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeBases(h); // effective 227, well over the thread price of 5
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await flush();
    const ctrl = (h.drive.composers as Map<string, { el: HTMLElement }>).get('@feed')!;
    // The composer reads the waiting view's `effective` (227) and enables post;
    // the foot carries the price, not the error line.
    expect(karmaText(ctrl.el)).not.toBe("can't read your rep right now");
    // Type some content so the content gate passes, then press `post`.
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    expect(postBtnOf(ctrl.el).disabled).toBe(false);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    // The press waits: no POST goes out, one waiting entry in the ledger.
    expect(h.postPosts()).toBe(0);
    const waiting = h.drive.ledger.all().filter((e) => e.kind === 'post' && e.waiting === true);
    expect(waiting).toHaveLength(1);
  });
});

describe('a waiting view below the price disables post and says so', () => {
  it('a recorded base with effective < the price → post stays disabled with the floor line', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    // Record a rep base that cannot afford a thread (price 5): effective 2.
    const store = h.drive.waitingStore!;
    store.recordBase('rep', {
      spendable: [{ boxId: BOX, value: 2n }],
      effective: 2n, height: 6000, era: 1, author: PUB,
    }, CHAIN);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await flush();
    const ctrl = (h.drive.composers as Map<string, { el: HTMLElement }>).get('@feed')!;
    expect(karmaText(ctrl.el)).toBe('not enough rep to post right now');
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    expect(postBtnOf(ctrl.el).disabled).toBe(true);
  });
});

describe('with no waiting view the composer foot reads the failed-read line', () => {
  it('no recorded base: the foot says it could not be read, post stays disabled', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    // No primeBases: there is no waiting view to fall back on.
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await flush();
    const ctrl = (h.drive.composers as Map<string, { el: HTMLElement }>).get('@feed')!;
    expect(karmaText(ctrl.el)).toBe("can't read your rep right now");
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    expect(postBtnOf(ctrl.el).disabled).toBe(true);
  });
});

// The two reads of the seam's `rememberedChain` on the write path — the
// composer's affordability (WEB_INTERFACE → Invariants → "Affordability is
// known before the attempt") and the submit flow's `chain()` through
// `submitDeps.waiting.chain` (WEB_INTERFACE → The wallet → "The view and every
// waiting write carry the chain's name") — are the two the submit flow and
// the composer take where no tip run has named a chain. Each is held by one
// case here: drop the seam read from `readAffordability` and case 1 goes red;
// drop it from `submitDeps` and case 2 goes red.
describe('a composer opened while no node answers and no tip run has named a chain takes the chain from the seam', () => {
  it('seam rememberedChain answers the chain of the recorded rep base; post is affordable', async () => {
    const h = harness({ rememberChain: CHAIN });
    // No resolveTipRunVerified — the seam names the chain.
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await flush();
    const ctrl = (h.drive.composers as Map<string, { el: HTMLElement }>).get('@feed')!;
    expect(karmaText(ctrl.el)).not.toBe("can't read your rep right now");
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    expect(postBtnOf(ctrl.el).disabled).toBe(false);
  });
});

describe('a post pressed with no node answering and no tip run runs the chain from the seam', () => {
  it('seam rememberedChain names the chain; the press writes a waiting record under that chain', async () => {
    const h = harness({ rememberChain: CHAIN });
    // No resolveTipRunVerified — the seam names the chain.
    primeBases(h);
    h.setReadsNoAnswer(true);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.postPosts()).toBe(0);
    const subs = h.drive.state.submissions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.stage).toBe('waiting');
    expect(subs[0]!.txId).not.toBeNull();
    const entries = h.drive.ledger.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('post');
    expect(entries[0]!.waiting).toBe(true);
  });
});

// -------------------------------------------------------------------------
// The waiting arm under *your-node* (WEB_INTERFACE → The wallet → "Waiting
// writes go out at the first answer" — "None goes out while the verdict
// reads *your-node*"). A waitable press signs and keeps waiting; the send
// pass does not run while the verdict stands; at the first answered read
// after the verdict leaves *your-node*, the pass runs as every trigger
// runs it.
// -------------------------------------------------------------------------

const yourNodeMemory = (): TipVerdict => ({ kind: 'refused', reason: 'your-node', which: 'memory', height: 6001 });

async function resolveTipRunYourNode(h: Harness): Promise<void> {
  await flush();
  if (h.tipRuns.length === 0) await flush();
  const run = h.tipRuns[h.tipRuns.length - 1];
  if (run === undefined) throw new Error('no tip run started');
  run.resolve({ verdict: yourNodeMemory(), anchor: null, chain: CHAIN });
  await flush();
}

describe('a waitable write under your-node is signed and kept waiting, no POST leaves', () => {
  // AssertionError: expected 1 to be +0 — the POST goes out; the verdict is
  // not read and the flow does not take the waiting arm.
  it.fails('a root post under your-node waits: no POST, the submission reads stage waiting', async () => {
    const h = harness({ rememberChain: CHAIN });
    // A verified run first, so the chain is named and bases are primed.
    await resolveTipRunVerified(h);
    primeBases(h);
    // Then a your-node run — the verdict freezes writes; reads still answer.
    (h.app as unknown as { startVerification: () => void }).startVerification();
    await resolveTipRunYourNode(h);
    // The reads still answer — press the composer, write waits anyway.
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.postPosts()).toBe(0);
    const subs = h.drive.state.submissions;
    expect(subs).toHaveLength(1);
    expect(subs[0]!.stage).toBe('waiting');
    expect(subs[0]!.txId).not.toBeNull();
    const entries = h.drive.ledger.all();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('post');
    expect(entries[0]!.waiting).toBe(true);
  });
});

describe('the send pass does not run while your-node stands, and runs at the first answered read after it leaves', () => {
  // AssertionError: expected 1 to be +0 — the flush runs under your-node;
  // flushWaitingWrites has no verdict gate.
  it.fails('cornerTick while your-node does not flush; once the verdict leaves, the pass runs', async () => {
    const h = harness({ rememberChain: CHAIN });
    // Prime: verified first, then your-node, then press a post waiting.
    await resolveTipRunVerified(h);
    primeBases(h);
    (h.app as unknown as { startVerification: () => void }).startVerification();
    await resolveTipRunYourNode(h);
    h.drive.openComposer(null);
    await h.drive.submitComposer(null, 'a thread');
    await flush();
    expect(h.postPosts()).toBe(0);
    // A cornerTick's successful read happens here. Your-node is standing,
    // so no POST leaves — none goes out while the verdict reads your-node.
    await h.drive.cornerTick();
    await flush();
    expect(h.postPosts()).toBe(0);
    // Flip the verdict out of your-node. The next tip run returns verified.
    (h.app as unknown as { startVerification: () => void }).startVerification();
    const run = h.tipRuns[h.tipRuns.length - 1]!;
    run.resolve({ verdict: verifiedVerdict(2, 6002), anchor: anchorFor(6002), chain: CHAIN });
    await flush();
    // The first answered read after the verdict left your-node triggers the
    // pass. A corner tick is such a read.
    await h.drive.cornerTick();
    await flush();
    expect(h.postPosts()).toBe(1);
  });
});

void computePostIdForTx; // keep the helper available for future tests
