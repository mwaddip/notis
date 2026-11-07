// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { WaitingStore, type WaitingStorage } from '../src/wallet/waiting';
import { fakeLockManager } from './fake-chrome';
import { ApiError } from '../src/api/errors';
import { karmaResult } from './karma-fixture';
import { setNode } from '../src/prefs';
import { contentHashHex } from '../src/integrity';
import type { Api } from '../src/api/client';
import type {
  AppIdentity, PostCache, TipVerifier, HeldPost, CachedThread,
} from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type {
  KarmaResult, PostJson, PostResult, StatusResult, FeedResult, BlockCurrent, CreditsResult,
} from '../src/api/dto';
import type { Anchor } from '@dagsocial/nipopow-client';
import type { TipVerdict } from '../src/model/tip-verdict';

// WEB_INTERFACE → The wallet → "A page no node answers offers what can wait":
// withdraw and the send row read the waiting view where the page's read of the
// view ended with no answer; the rep row, the balance row, the invite form,
// vouch and claim do not read it; the `your vouch` row on another key reads
// `—` while no rep view has been read.

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const BOX = '11'.repeat(32);
const CREDIT_BOX = '55'.repeat(32);
const CHAIN = 'ab'.repeat(32);
const OWN_POST = 'd'.repeat(64);

const NO_ANSWER = new ApiError(0, 'fetch failed');
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '10', inviteBondMax: '100', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function postJson(id: string, author: string, parentRefs: string[] = []): PostJson {
  return {
    id, content: 'x', contentHash: contentHashHex('x'), author, parentRefs, protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
  };
}
const asResult = (p: PostJson): PostResult => ({ ...p, confirmedAuthor: p.author });
function karmaFor(hex: string, boxes: Array<{ boxId: string; value: string }>, effective = '227'): KarmaResult {
  return karmaResult({ userId: hex, total: effective, effective, boxes, boxCount: boxes.length, height: 6000 });
}
function creditsFor(hex: string, boxes: Array<{ boxId: string; value: string }> = []): CreditsResult {
  const total = boxes.reduce((s, b) => s + BigInt(b.value), 0n).toString();
  return { userId: hex, total, boxes, boxCount: boxes.length, next: null };
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

interface KarmaBehavior {
  kind: 'answer' | 'no-answer' | 'bad-answer' | 'held';
  karma?: KarmaResult;
}
interface CreditsBehavior {
  kind: 'answer' | 'no-answer' | 'bad-answer';
  credits?: CreditsResult;
}

interface Opts {
  withSeam?: boolean;
  rememberChain?: string;
  karma?: KarmaBehavior;
  credits?: CreditsBehavior;
  threadThrows?: boolean;
  feedThrows?: boolean;
  otherReadsNoAnswer?: boolean;
  cachedRoots?: HeldPost[];
  cachedThread?: (id: string) => CachedThread | null;
  cachedByAuthor?: Map<string, HeldPost[]>;
}

interface Harness {
  app: App;
  karmaReads(): number;
  setKarma(k: KarmaBehavior): void;
  setCredits(c: CreditsBehavior): void;
  writeBodies: Array<{ kind: string; body: Record<string, unknown> }>;
  tipRuns: TipTrap[];
  switchNode(origin: string): Promise<void>;
  drive: {
    openComposer(parentId: string | null): void;
    submitComposer(parentId: string | null, text: string): Promise<void>;
    openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    openAuthor(key: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    openProfile(): void;
    openWallet(): void;
    withdrawPost(id: string): Promise<void>;
    send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
    loadFeed(): Promise<void>;
    loadMembershipState(): Promise<void>;
    refreshWalletCredits(): Promise<void>;
    composers: Map<string, { el: HTMLElement }>;
    ledger: PendingLedger;
    waitingStore: WaitingStore | null;
    tipChain: string | null;
    state: { workspace: unknown; submissions: unknown[] };
  };
}

function harness(opts: Opts = {}): Harness {
  if (opts.rememberChain !== undefined) {
    localStorage.setItem('notis.posts.chain', opts.rememberChain);
  }
  const signCalls: string[] = [];
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: async (_bytes, t) => { signCalls.push(t); return { signature: 'ab'.repeat(64) }; },
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  };

  let karma: KarmaBehavior = opts.karma ?? { kind: 'no-answer' };
  let credits: CreditsBehavior = opts.credits ?? { kind: 'no-answer' };
  let karmaN = 0;
  const otherNoAnswer = opts.otherReadsNoAnswer ?? true;

  const karmaRead = async (): Promise<KarmaResult> => {
    karmaN++;
    if (karma.kind === 'held') {
      return new Promise<KarmaResult>(() => { /* a pending read the test leaves pending */ });
    }
    if (karma.kind === 'no-answer') throw NO_ANSWER;
    if (karma.kind === 'bad-answer') throw new ApiError(500, 'server error');
    return karma.karma ?? karmaFor(PUB, [{ boxId: BOX, value: '227' }]);
  };
  const creditsRead = async (): Promise<CreditsResult> => {
    if (credits.kind === 'no-answer') throw NO_ANSWER;
    if (credits.kind === 'bad-answer') throw new ApiError(500, 'server error');
    return credits.credits ?? creditsFor(PUB, [{ boxId: CREDIT_BOX, value: '10000000000' }]);
  };

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => {
      if (opts.feedThrows ?? true) throw NO_ANSWER;
      return { posts: [], next: null, pending: [], pendingCount: 0 };
    },
    thread: async () => {
      if (opts.threadThrows ?? true) throw NO_ANSWER;
      return null;
    },
    post: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return null;
    },
    status: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return statusResult();
    },
    currentBlock: async (): Promise<BlockCurrent> => {
      if (otherNoAnswer) throw NO_ANSWER;
      return { height: 6001, hash: null };
    },
    karma: karmaRead,
    credits: creditsRead,
    vouchesByTarget: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return { vouches: [], count: 0, next: null };
    },
    vouchesByVoucher: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return { vouches: [], count: 0, next: null };
    },
    vouchCooldowns: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return { cooldowns: [], count: 0, next: null };
    },
    bonds: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return { bonds: [], bondCount: 0, next: null };
    },
    usernameByOwner: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return null;
    },
    usernameByName: async () => {
      if (otherNoAnswer) throw NO_ANSWER;
      return null;
    },
  };

  const writeBodies: Array<{ kind: string; body: Record<string, unknown> }> = [];
  const noAnswerRejection = { status: 0, message: 'fetch failed', noAnswer: true as const };
  const lastTxId = (): string => signCalls[signCalls.length - 1] ?? '';
  const writeClient = {
    submitPost: async (body: Record<string, unknown>) => {
      writeBodies.push({ kind: 'post', body });
      return noAnswerRejection;
    },
    submitLike: async (body: Record<string, unknown>) => {
      writeBodies.push({ kind: 'like', body });
      return noAnswerRejection;
    },
    submitSend: async (body: Record<string, unknown>) => {
      writeBodies.push({ kind: 'send', body });
      return noAnswerRejection;
    },
    submitVouch: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720 }),
    submitUnvouch: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720 }),
    submitInvite: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720, bondBoxId: 'bb'.repeat(32) }),
    submitWithdraw: async (postId: string, body: Record<string, unknown>) => {
      writeBodies.push({ kind: 'withdraw', body });
      void postId;
      return noAnswerRejection;
    },
    submitClaim: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720, name: 'x' }),
    submitBurn: async () => ({ status: 'pending' as const, txId: lastTxId(), expiresAtHeight: 6720 }),
  } as unknown as WriteClient;

  const roots = opts.cachedRoots ?? [];
  const byAuthor = opts.cachedByAuthor ?? new Map();
  const threadFn = opts.cachedThread;
  const postCache: PostCache = {
    open: async () => {},
    openRemembered: async () => {},
    put: async () => {},
    withdraw: async () => {},
    thread: async (id) => (threadFn ? threadFn(id) : null),
    getMany: async () => new Map(),
    refresh: async () => {},
    roots: async () => roots,
    byAuthor: async (k) => byAuthor.get(k) ?? [],
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
    : { storage: window.localStorage as WaitingStorage, locks: fakeLockManager() };

  const ledger = new PendingLedger(PUB);
  const app = new App(
    fakeApi, writeClient, identity, ledger, undefined, undefined,
    tipVerifier, undefined, undefined, undefined, postCache, undefined,
    undefined, waitingSeam,
  );
  const appbar = document.createElement('div');
  const feedEl = document.createElement('section'); feedEl.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feedEl, panes);
  // `start` runs the mount AND `rereadReaderState`/`loadFeed`, so a fresh
  // App's first reads of the reader's own state settle on their own — the
  // page's own-view read's outcome gates the waiting view
  // (WEB_INTERFACE → The wallet → "A page no node answers offers what can wait").
  app.start(appbar, feedEl, panes);

  return {
    app,
    karmaReads: () => karmaN,
    setKarma: (k) => { karma = k; },
    setCredits: (c) => { credits = c; },
    writeBodies,
    tipRuns,
    switchNode: async (origin) => {
      await (app as unknown as { changeNode(o: string): Promise<void> }).changeNode(origin);
    },
    drive: app as unknown as Harness['drive'],
  };
}

async function resolveTipRunVerified(h: Harness): Promise<void> {
  await flush();
  if (h.tipRuns.length === 0) await flush();
  const run = h.tipRuns[h.tipRuns.length - 1];
  if (run === undefined) throw new Error('no tip run started');
  run.resolve({ verdict: verifiedVerdict(2, 6001), anchor: anchorFor(6001), chain: CHAIN });
  await flush();
}

function primeRepBase(h: Harness, boxes: Array<{ boxId: string; value: bigint }>, effective = 227n): void {
  const store = h.drive.waitingStore;
  if (store === null) throw new Error('no waiting store to prime');
  store.recordBase('rep', {
    spendable: boxes,
    effective, height: 6000, era: 1, author: PUB,
  }, CHAIN);
}

function primeCreditsBase(h: Harness, boxes: Array<{ boxId: string; value: bigint }>): void {
  const store = h.drive.waitingStore;
  if (store === null) throw new Error('no waiting store to prime');
  store.recordBase('credits', {
    spendable: boxes,
    height: 6000, era: 1, author: PUB,
  }, CHAIN);
}

function ownRootHeld(id: string = OWN_POST): HeldPost {
  return { row: postJson(id, PUB), author: PUB, parent: null };
}
function ownThread(id: string = OWN_POST): CachedThread {
  return { post: postJson(id, PUB), ancestors: [], descendants: [] };
}

async function openOwnPane(h: Harness, id: string = OWN_POST): Promise<void> {
  h.drive.openThread(id, { from: 'feed' });
  await flush();
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

const withdrawBtn = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('#panes .meta .withdraw-ctl');

const sendRow = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#panes .send-row');

const balanceLineText = (): string =>
  document.querySelector<HTMLElement>('#panes .balance-row .credits-line')?.textContent ?? '';

function rowField(label: string): HTMLElement | null {
  for (const r of document.querySelectorAll<HTMLElement>('#panes .row')) {
    if (r.querySelector('label')?.textContent === label) return r.querySelector<HTMLElement>('.field');
  }
  return null;
}

const inviteFormEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#panes form.invite-form');

const invitesLineText = (): string =>
  document.querySelector<HTMLElement>('#panes .invites-field .invites-line')?.textContent ?? '';

const claimFormEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('#panes form.username-form');

// -------------------------------------------------------------------------

describe('a page no node answers: withdraw and the send row read the waiting view', () => {
  it('withdraw, extension: a rep base with a box; the button is enabled', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(false);
  });

  it('withdraw, no waiting view: no base recorded — the button is disabled with title "can\'t read your rep right now"', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
    });
    await resolveTipRunVerified(h);
    // No primeRepBase.
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(true);
    expect(wb!.title).toBe("can't read your rep right now");
  });

  it('withdraw, a waiting view of no box: the base holds no box — disabled with title "needs one rep box to sign with; this key has none"', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [], 0n); // a base with no spendable boxes
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(true);
    expect(wb!.title).toBe('needs one rep box to sign with; this key has none');
  });

  it('withdraw, read in flight: the rep read is held unresolved — the button is disabled (the waiting view is not read yet)', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
      karma: { kind: 'held' },
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(true);
  });

  it('withdraw, a node answered with no box: the held view decides — disabled with "needs one rep box…" though the base holds one', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
      karma: { kind: 'answer', karma: karmaFor(PUB, [], '0') },
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(true);
    expect(wb!.title).toBe('needs one rep box to sign with; this key has none');
  });

  it('withdraw, a node answered non-2xx with a status: the waiting view is not read — disabled with "can\'t read your rep right now"', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
      karma: { kind: 'bad-answer' },
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(true);
    expect(wb!.title).toBe("can't read your rep right now");
  });
});

// -------------------------------------------------------------------------

describe('a page no node answers: the send row reads the waiting credits view', () => {
  it('send, extension: a credits base with a box — the wallet shows the send row with the form, the balance reads "—"', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    primeCreditsBase(h, [{ boxId: CREDIT_BOX, value: 10_000_000_000n }]);
    h.drive.openWallet();
    await flush();
    const sr = sendRow();
    expect(sr).not.toBeNull();
    expect(sr!.hidden).toBe(false);
    // The balance line still reads `—` above the row.
    expect(balanceLineText()).toBe('—');
  });

  it('send, no credits base: the row stays hidden', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    // No primeCreditsBase.
    h.drive.openWallet();
    await flush();
    const sr = sendRow();
    expect(sr).not.toBeNull();
    // Control: no base → the row stays hidden under both current and new code.
    expect(sr!.hidden).toBe(true);
  });
});

// -------------------------------------------------------------------------

describe('the rep and balance rows read the node, not the waiting view', () => {
  it('the rep row reads `—` while a rep base stands', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    h.drive.openProfile();
    await flush();
    const repField = rowField('rep');
    expect(repField).not.toBeNull();
    expect(repField!.textContent?.trim()).toBe('—');
  });

  it('the balance row reads `—` while a credits base stands', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeCreditsBase(h, [{ boxId: CREDIT_BOX, value: 10_000_000_000n }]);
    h.drive.openWallet();
    await flush();
    expect(balanceLineText()).toBe('—');
  });
});

// -------------------------------------------------------------------------

describe('invite, claim and the invites line do not read the waiting view', () => {
  it('a base covering the bond, no node answer: the invite form is absent and the invites row reads "—"', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }], 1000n);
    h.drive.openProfile();
    await flush();
    expect(inviteFormEl()).toBeNull();
    expect(invitesLineText()).toBe('—');
  });

  it('claim: the profile window offers no claim form on a page no node answers', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    h.drive.openProfile();
    await flush();
    expect(claimFormEl()).toBeNull();
  });
});

// -------------------------------------------------------------------------

describe('the `your vouch` row reads `—` on another key while no rep view has been read', () => {
  it('extension build: another key reads muted `—`; the reader\'s own reads "this is you"', async () => {
    const h = harness({ rememberChain: CHAIN });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    h.drive.openAuthor(AUTHOR, { from: 'feed' });
    await flush();
    const field = rowField('your vouch');
    expect(field).not.toBeNull();
    expect(field!.textContent?.trim()).toBe('—');
    // The reader's own: open a second author window on PUB and verify "this is you".
    h.drive.openAuthor(PUB, { from: 'feed' });
    await flush();
    // The latest-opened author window stands at the front — read its field.
    const own = rowField('your vouch');
    expect(own).not.toBeNull();
    expect(own!.textContent).toContain('this is you');
  });

  it('web build (no seam): the row on another key reads `—` too', async () => {
    const h = harness({ withSeam: false });
    h.drive.openAuthor(AUTHOR, { from: 'feed' });
    await flush();
    const field = rowField('your vouch');
    expect(field).not.toBeNull();
    expect(field!.textContent?.trim()).toBe('—');
  });
});

// -------------------------------------------------------------------------

describe('the web build: no seam, no waiting view', () => {
  it('withdraw is disabled with "can\'t read your rep right now"', async () => {
    const h = harness({
      withSeam: false,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
    });
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    const wb = withdrawBtn();
    expect(wb).not.toBeNull();
    expect(wb!.disabled).toBe(true);
    expect(wb!.title).toBe("can't read your rep right now");
  });

  it('the send row is hidden', async () => {
    const h = harness({ withSeam: false });
    h.drive.openWallet();
    await flush();
    const sr = sendRow();
    expect(sr).not.toBeNull();
    expect(sr!.hidden).toBe(true);
  });
});

// -------------------------------------------------------------------------

describe('a node change drops the waiting arm; a node that answers later lands and takes over', () => {
  it('a node change: the controls read the waiting view again only once the new node\'s read ends with no answer', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    // The page is reading the waiting view — withdraw is enabled.
    expect(withdrawBtn()!.disabled).toBe(false);
    // A node change: the no-answer state drops with the reader's state. Hold
    // karma so the new node's read is pending — the gate must not read the
    // waiting view while the read is still in flight.
    h.setKarma({ kind: 'held' });
    await h.switchNode('http://other');
    await flush();
    expect(withdrawBtn()!.disabled).toBe(true);
  });

  it('a node answers later: a node answer of no box disables withdraw though the base holds one', async () => {
    const h = harness({
      rememberChain: CHAIN,
      cachedRoots: [ownRootHeld()],
      cachedThread: () => ownThread(),
    });
    await resolveTipRunVerified(h);
    primeRepBase(h, [{ boxId: BOX, value: 227n }]);
    await h.drive.loadFeed();
    await flush();
    await openOwnPane(h);
    expect(withdrawBtn()!.disabled).toBe(false);
    // The node answers with no box on the next read.
    h.setKarma({ kind: 'answer', karma: karmaFor(PUB, [], '0') });
    await h.drive.loadMembershipState();
    await flush();
    const wb = withdrawBtn()!;
    expect(wb.disabled).toBe(true);
    expect(wb.title).toBe('needs one rep box to sign with; this key has none');
  });
});

// Keep asResult referenced so the helper is available for later cases.
void asResult;
