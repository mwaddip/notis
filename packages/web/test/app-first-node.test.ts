// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "A page's first node reads the feed again" —
// a page whose feed found no node before its first check reached one reads
// the feed once more when it does; only the page's first node asks it. And
// "Until the page's first check has ended, the feed's no-node line reads
// *searching for a connection…*"; after a first check that reached no node,
// it reads as a failed listing does.
//
// The extension build's no-node ending is the seed walk's `walked === null`
// branch (WEB_INTERFACE → "The client is served from the node's own
// origin"). The harness sets `notis-nodes` before importing `prefs` so
// `BUILD_NODE_BASES` is non-empty, and stubs `fetch` so the walk's own
// `NodeClient` reads what the case needs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Api } from '../src/api/client';
import type { AppIdentity, TipRun, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type {
  BlockCurrent, FeedResult, KarmaResult, StatusResult, CreditsResult, UsernameResult,
  VouchesVoucherResult, VouchesTargetResult, VouchCooldownsResult, BondsResult,
} from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { jsonResponse } from './honest-page';

const PUB = 'aa'.repeat(32);
const SEED_A = 'http://seed-a.test';
const SEED_B = 'http://seed-b.test';

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function makeIdentity(): AppIdentity {
  return {
    current: () => null,
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => false,
    onChange: () => {},
  };
}

interface Harness {
  app: unknown;
  state: {
    feedResults: Array<FeedResult | Error>;
    currentBlockThrows: boolean;
    feedCalls: number;
    currentBlockCalls: number;
  };
  verifier: {
    runCalls: number;
    settle: (run: TipRun) => void;
  };
  drive: {
    loadFeed(): Promise<void>;
    cornerTick?: () => Promise<void>;
    state: { feed: { error: string | null; loaded: boolean; posts: unknown[] } };
  };
  feedEl: HTMLElement;
}

interface HarnessOpts {
  nodesMeta: readonly string[];
  storedNode?: string | undefined;
  // A probe fetch over the build nodes: given the URL the case decides the response.
  probeFetch?: (url: string) => Promise<Response>;
}

async function harness(opts: HarnessOpts): Promise<Harness> {
  const state = {
    feedResults: [] as Array<FeedResult | Error>,
    currentBlockThrows: true,
    feedCalls: 0,
    currentBlockCalls: 0,
  };
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => {
      state.feedCalls += 1;
      const r = state.feedResults.shift();
      if (r === undefined) throw new Error('offline');
      if (r instanceof Error) throw r;
      return r;
    },
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => {
      state.currentBlockCalls += 1;
      if (state.currentBlockThrows) throw new Error('offline');
      return { height: 6001, hash: null };
    },
    karma: async (): Promise<KarmaResult> => karmaResult({
      userId: PUB, total: '0', effective: '0', boxes: [], boxCount: 0, height: 6000,
    }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };

  const verifierState = {
    runCalls: 0,
    pending: [] as Array<(run: TipRun) => void>,
  };
  const verifier: TipVerifier = {
    run(): Promise<TipRun> {
      verifierState.runCalls += 1;
      return new Promise((settle) => { verifierState.pending.push(settle); });
    },
  };
  const settleLast = (run: TipRun): void => {
    const p = verifierState.pending.shift();
    if (p !== undefined) p(run);
  };

  // Place the `notis-nodes` meta before any `prefs` import so the build
  // const is read with the case's seed list.
  vi.resetModules();
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'notis-nodes');
  meta.setAttribute('content', JSON.stringify(opts.nodesMeta));
  document.head.appendChild(meta);
  const prefs = await import('../src/prefs');
  if (opts.storedNode !== undefined) {
    localStorage.setItem(prefs.KEY_NODE, opts.storedNode);
    prefs.setNode(opts.storedNode);
  } else {
    localStorage.removeItem(prefs.KEY_NODE);
    prefs.setNode('');
  }
  const probe = opts.probeFetch ?? (async () => new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => probe(String(input))));

  const { App } = await import('../src/app');
  const { PendingLedger } = await import('../src/wallet/ledger');
  const ledger = new PendingLedger(PUB);
  const app = new App(
    fakeApi,
    {} as unknown as WriteClient,
    makeIdentity(),
    ledger,
    undefined,
    undefined,
    verifier,
  );
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  (app as unknown as { mount(a: HTMLElement, f: HTMLElement, p: HTMLElement): void }).mount(appbar, feed, panes);

  return {
    app,
    state,
    verifier: {
      get runCalls() { return verifierState.runCalls; },
      settle: settleLast,
    },
    drive: app as unknown as Harness['drive'],
    feedEl: feed,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const landedRow = (): FeedResult => ({
  posts: [{
    id: '11'.repeat(32), content: 'hello', contentHash: '22'.repeat(32),
    author: 'bb'.repeat(32), parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
  }] as unknown as FeedResult['posts'],
  next: null, pending: [], pendingCount: 0,
});

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the feed re-reads when the page\'s first node is reached', () => {
  it('the feed found no node, the first check then reaches a node — the feed reads once more and its rows land', async () => {
    // The walkSeedList probes the build nodes — both fail — so the catch
    // lands in the walk's no-node ending.
    const h = await harness({ nodesMeta: [SEED_A, SEED_B], probeFetch: async () => new Response(null, { status: 503 }) });
    h.state.feedResults = [new Error('offline'), landedRow()];
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.error, 'first loadFeed failed with no node').not.toBeNull();
    expect(h.drive.state.feed.loaded).toBe(false);
    // Simulate first check ended by resolving the verifier.
    h.verifier.settle({
      verdict: { kind: 'thin', reason: 'no-proof', height: null },
      anchor: null, chain: null, firstCheckEnded: true,
    });
    await flush();
    // The node becomes reachable; cornerTick succeeds.
    h.state.currentBlockThrows = false;
    await (h.drive.cornerTick as () => Promise<void>)();
    await flush();
    // The feed re-reads and its rows land.
    expect(h.state.feedCalls, 'loadFeed ran a second time').toBeGreaterThanOrEqual(2);
    expect(h.drive.state.feed.loaded).toBe(true);
    expect(h.drive.state.feed.error).toBeNull();
    expect(h.drive.state.feed.posts.length).toBe(1);
  });

  it('a node reached again later on a page whose feed answered reads nothing', async () => {
    const h = await harness({ nodesMeta: [], storedNode: 'http://node.test' });
    h.state.feedResults = [landedRow()];
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.loaded).toBe(true);
    const feedCallsAfterFirst = h.state.feedCalls;
    // Later: a cornerTick reaches the node. The feed must not re-read.
    h.state.currentBlockThrows = false;
    await (h.drive.cornerTick as () => Promise<void>)();
    await flush();
    expect(h.state.feedCalls, 'no second loadFeed on a page whose feed answered')
      .toBe(feedCallsAfterFirst);
  });
});

describe('the feed\'s no-node line reads "searching for a connection…" until the first check has ended', () => {
  it('before the first check ends the feed\'s no-node line reads "searching for a connection…"', async () => {
    const h = await harness({ nodesMeta: [SEED_A, SEED_B], probeFetch: async () => new Response(null, { status: 503 }) });
    h.state.feedResults = [new Error('offline')];
    await h.drive.loadFeed();
    await flush();
    // The verifier has not resolved — first check has not ended.
    const err = h.feedEl.querySelector<HTMLElement>('.error');
    expect(err, 'the error line is rendered').not.toBeNull();
    expect(err!.textContent)
      .toBe("can't reach the node right now — searching for a connection…");
  });

  it('after a first check that reached no node, lookup included, it reads as a failed listing does', async () => {
    const h = await harness({ nodesMeta: [SEED_A, SEED_B], probeFetch: async () => new Response(null, { status: 503 }) });
    h.state.feedResults = [new Error('offline')];
    await h.drive.loadFeed();
    await flush();
    // The verifier resolves — the first check has ended (with no node).
    h.verifier.settle({
      verdict: { kind: 'thin', reason: 'no-proof', height: null },
      anchor: null, chain: null, firstCheckEnded: true,
    });
    await flush();
    const err = h.feedEl.querySelector<HTMLElement>('.error');
    expect(err, 'the error line is rendered').not.toBeNull();
    expect(err!.textContent)
      .toBe("can't reach the node right now — no node answered — set one in settings");
  });
});

// The seed walk and the msg(e) branch stand beside the no-node rule
// (WEB_INTERFACE → The extension → "A page's first node reads the feed again" —
// the rule changes the no-node line's words before the first check ends, and
// adds the one re-read; a failure that is not no-node keeps its own message,
// and the seed walk still probes the build's bases).
describe('the seed walk and the msg(e) branch stand beside the no-node rule', () => {
  it('a failed first page whose seed walk adopts a base lands that base\'s rows (the extension build)', async () => {
    // The walk probes SEED_A (fails) then SEED_B (answers one row). The
    // adoption moves `prefs.node` to SEED_B and its page lands.
    const bRow = landedRow();
    const probeFetch = async (url: string): Promise<Response> => {
      if (url.startsWith(SEED_A)) return new Response(null, { status: 503 });
      if (url.startsWith(SEED_B)) return jsonResponse(bRow);
      return new Response(null, { status: 404 });
    };
    const h = await harness({ nodesMeta: [SEED_A, SEED_B], probeFetch });
    h.state.feedResults = [new Error('offline')];
    await h.drive.loadFeed();
    await flush();
    expect(h.drive.state.feed.error, 'the adoption cleared the error line').toBeNull();
    expect(h.drive.state.feed.loaded, 'the feed is loaded').toBe(true);
    expect(h.drive.state.feed.posts.length).toBe(1);
  });

  it('a failed first page that is not no-node — the walk not taken — shows its own message, not searching', async () => {
    // A stored node preference prevents the walk — the catch goes to the
    // msg(e) branch, which keeps the error message verbatim and does not
    // flip the feed into the no-node state (no re-read, no searching text).
    const h = await harness({ nodesMeta: [], storedNode: 'http://node.test' });
    h.state.feedResults = [new Error('node answered 500')];
    await h.drive.loadFeed();
    await flush();
    const err = h.feedEl.querySelector<HTMLElement>('.error');
    expect(err, 'the error line is rendered').not.toBeNull();
    expect(err!.textContent)
      .toBe("can't reach the node right now — node answered 500");
    // The msg(e) branch sets no flag: a cornerTick success later does not
    // trigger a re-read.
    const feedCallsAfterFail = h.state.feedCalls;
    h.state.currentBlockThrows = false;
    await (h.drive.cornerTick as () => Promise<void>)();
    await flush();
    expect(h.state.feedCalls, 'no re-read on a non-no-node failure').toBe(feedCallsAfterFail);
  });
});

// WEB_INTERFACE → The extension → "The page's first node reads the reader's
// own state again" — a page whose read of the reader's own state (the two
// listings, /status, the vouch set and the escrow, the bonds, the reader's
// name) failed before its first check reached a node reads it once more when
// that node is reached, beside the feed. A page whose read of it answered
// reads nothing then.

interface ReaderDrive {
  loadFeed(): Promise<void>;
  cornerTick(): Promise<void>;
  loadMembershipState(): Promise<void>;
  refreshWalletCredits(): Promise<void>;
  state: {
    feed: { error: string | null; loaded: boolean };
    status: StatusResult | null;
    workspace: unknown;
  };
  ownName: UsernameResult | null;
  ownNameLoaded: boolean;
  walletCredits: CreditsResult | null;
  openWallet(): void;
}

interface ReaderState {
  reads: {
    karma: number; status: number; vouchesByVoucher: number; vouchCooldowns: number;
    bonds: number; nameByOwner: number; credits: number; currentBlock: number; feed: number;
  };
  allThrow: boolean;      // when true every reader-state read throws
  currentBlockThrows: boolean;
  statusThrows: boolean;  // for the wallet-status case: a /status that fails alone
  creditsThrows: boolean; // for the wallet-status case: a /credits that fails alone
}

interface ReaderHarness {
  app: unknown;
  state: ReaderState;
  verifier: { settle: (run: TipRun) => void; runCalls: number };
  drive: ReaderDrive;
}

function makeIdentityLoaded(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
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
}

async function readerHarness(opts: { walletOpen?: boolean } = {}): Promise<ReaderHarness> {
  const state: ReaderState = {
    reads: {
      karma: 0, status: 0, vouchesByVoucher: 0, vouchCooldowns: 0,
      bonds: 0, nameByOwner: 0, credits: 0, currentBlock: 0, feed: 0,
    },
    allThrow: true,
    currentBlockThrows: true,
    statusThrows: false,
    creditsThrows: false,
  };
  const emptyFeed = (): FeedResult => ({ posts: [], next: null, pending: [], pendingCount: 0 });
  const karmaAnswer = (): KarmaResult => karmaResult({
    userId: PUB, total: '0', effective: '0', boxes: [], boxCount: 0, height: 6000,
  });
  const creditsAnswer = (): CreditsResult => ({
    userId: PUB, total: '0', boxes: [], boxCount: 0, next: null,
  });
  const fail = (what: string): never => { throw new Error(`${what} offline`); };
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => {
      state.reads.feed += 1;
      if (state.allThrow) return fail('feed');
      return emptyFeed();
    },
    thread: async () => null,
    post: async () => null,
    status: async (): Promise<StatusResult> => {
      state.reads.status += 1;
      if (state.allThrow || state.statusThrows) return fail('status');
      return statusResult();
    },
    currentBlock: async (): Promise<BlockCurrent> => {
      state.reads.currentBlock += 1;
      if (state.currentBlockThrows) return fail('currentBlock');
      return { height: 6001, hash: null };
    },
    karma: async (): Promise<KarmaResult> => {
      state.reads.karma += 1;
      if (state.allThrow) return fail('karma');
      return karmaAnswer();
    },
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => {
      state.reads.vouchesByVoucher += 1;
      if (state.allThrow) return fail('vouchesByVoucher');
      return { vouches: [], count: 0, next: null };
    },
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => {
      state.reads.vouchCooldowns += 1;
      if (state.allThrow) return fail('vouchCooldowns');
      return { cooldowns: [], count: 0, next: null };
    },
    bonds: async (): Promise<BondsResult> => {
      state.reads.bonds += 1;
      if (state.allThrow) return fail('bonds');
      return { bonds: [], bondCount: 0, next: null };
    },
    usernameByOwner: async (): Promise<UsernameResult | null> => {
      state.reads.nameByOwner += 1;
      if (state.allThrow) return fail('usernameByOwner');
      return null;
    },
    credits: async (): Promise<CreditsResult> => {
      state.reads.credits += 1;
      if (state.allThrow || state.creditsThrows) return fail('credits');
      return creditsAnswer();
    },
    usernameByName: async () => null,
  };

  const verifierState = {
    runCalls: 0,
    pending: [] as Array<(run: TipRun) => void>,
  };
  const verifier: TipVerifier = {
    run(): Promise<TipRun> {
      verifierState.runCalls += 1;
      return new Promise((settle) => { verifierState.pending.push(settle); });
    },
  };
  const settleLast = (run: TipRun): void => {
    const p = verifierState.pending.shift();
    if (p !== undefined) p(run);
  };

  // Fresh prefs module per case — the test asserts no node answers at boot
  // and none should be stored, so no walk and a bare base.
  vi.resetModules();
  document.head.innerHTML = '';
  const prefs = await import('../src/prefs');
  localStorage.removeItem(prefs.KEY_NODE);
  prefs.setNode('');

  const { App } = await import('../src/app');
  const { PendingLedger } = await import('../src/wallet/ledger');
  const ledger = new PendingLedger(PUB);
  const app = new App(
    fakeApi,
    {} as unknown as WriteClient,
    makeIdentityLoaded(),
    ledger,
    undefined,
    undefined,
    verifier,
  );
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  (app as unknown as { mount(a: HTMLElement, f: HTMLElement, p: HTMLElement): void }).mount(appbar, feed, panes);
  if (opts.walletOpen === true) {
    (app as unknown as { openWallet(): void }).openWallet();
  }

  return {
    app,
    state,
    verifier: {
      get runCalls() { return verifierState.runCalls; },
      settle: settleLast,
    },
    drive: app as unknown as ReaderDrive,
  };
}

describe("the page's first node reads the reader's own state again", () => {
  it('a boot read of the reader\'s own state fails, the first check then reaches a node — state.status is set and ownName is read', async () => {
    const h = await readerHarness();
    // Boot: the identity's state reads all fail.
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.state.status, 'the boot read of the reader\'s own state landed nothing').toBeNull();
    expect(h.drive.ownNameLoaded, 'the name is not loaded yet').toBe(false);
    const statusCallsBefore = h.state.reads.status;
    const nameCallsBefore = h.state.reads.nameByOwner;
    // The first node answers.
    h.state.allThrow = false;
    h.state.currentBlockThrows = false;
    await h.drive.cornerTick();
    await flush();
    // The reader's own state reads once more. state.status now holds the
    // node's answer, the name is loaded.
    expect(h.state.reads.status, 'status was re-read at the first answered tick').toBeGreaterThan(statusCallsBefore);
    expect(h.state.reads.nameByOwner, 'the name was re-read').toBeGreaterThan(nameCallsBefore);
    expect(h.drive.state.status, 'state.status now holds the node\'s answer').not.toBeNull();
    expect(h.drive.ownNameLoaded, 'ownNameLoaded is true').toBe(true);
  });

  it('a boot read of the reader\'s own state that answered reads nothing more at the first answered tick', async () => {
    const h = await readerHarness();
    // Boot: every reader-state read answers.
    h.state.allThrow = false;
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.state.status, 'state.status is set at boot').not.toBeNull();
    const statusCallsBefore = h.state.reads.status;
    // The first node answers.
    h.state.currentBlockThrows = false;
    await h.drive.cornerTick();
    await flush();
    // No re-read at the tick: the boot read answered.
    expect(h.state.reads.status, 'no re-read of status at the tick').toBe(statusCallsBefore);
  });

  it('a restored @wallet at boot whose read failed re-reads /credits at the first answered tick', async () => {
    const h = await readerHarness({ walletOpen: true });
    // Boot: the wallet's read fails along with the rest.
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(h.drive.walletCredits, 'the wallet\'s read landed nothing').toBeNull();
    const creditsCallsBefore = h.state.reads.credits;
    // The first node answers.
    h.state.allThrow = false;
    h.state.currentBlockThrows = false;
    await h.drive.cornerTick();
    await flush();
    expect(h.state.reads.credits, 'credits was re-read at the first answered tick').toBeGreaterThan(creditsCallsBefore);
    expect(h.drive.walletCredits, 'walletCredits holds the node\'s answer').not.toBeNull();
  });

  // WEB_INTERFACE → The extension → "The page's first node reads the reader's
  // own state again" — each piece (the membership state; the wallet's
  // listing) carries its own flag, so a landing of one does not clear the
  // other's owed re-read.
  it('the wallet lands after the membership read failed, the first answered tick re-reads the membership state', async () => {
    const h = await readerHarness({ walletOpen: true });
    // Boot: every reader-state read fails. Both pieces are owed a re-read.
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(h.drive.state.status, 'the membership read landed nothing at boot').toBeNull();
    expect(h.drive.walletCredits, 'the wallet read landed nothing at boot').toBeNull();
    // The wallet's reads land before the first answered tick (another node
    // answered the wallet alone). The membership state is not re-read here.
    h.state.allThrow = false;
    await h.drive.refreshWalletCredits();
    await flush();
    expect(h.drive.walletCredits, 'the wallet read landed').not.toBeNull();
    const karmaCallsBefore = h.state.reads.karma;
    const nameCallsBefore = h.state.reads.nameByOwner;
    // The first node answers the tick. The membership state's flag stands
    // across the wallet's landing — the tick re-reads it.
    h.state.currentBlockThrows = false;
    await h.drive.cornerTick();
    await flush();
    expect(h.state.reads.karma, 'karma was re-read at the first answered tick').toBeGreaterThan(karmaCallsBefore);
    expect(h.state.reads.nameByOwner, 'the name was re-read at the first answered tick').toBeGreaterThan(nameCallsBefore);
  });

  it('the membership state lands after the wallet read failed, the first answered tick re-reads the wallet\'s listing and not the membership state', async () => {
    const h = await readerHarness({ walletOpen: true });
    // Boot: every reader-state read fails.
    await h.drive.refreshWalletCredits();
    await flush();
    expect(h.drive.walletCredits, 'the wallet read landed nothing at boot').toBeNull();
    // The membership state lands before the first answered tick — /credits
    // still fails so the wallet's piece is unread.
    h.state.allThrow = false;
    h.state.creditsThrows = true;
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.state.status, 'the membership read landed').not.toBeNull();
    const karmaCallsBefore = h.state.reads.karma;
    const nameCallsBefore = h.state.reads.nameByOwner;
    const creditsCallsBefore = h.state.reads.credits;
    // The first node answers the tick, /credits now too. The wallet's
    // listing's flag stands across the membership state's landing.
    h.state.creditsThrows = false;
    h.state.currentBlockThrows = false;
    await h.drive.cornerTick();
    await flush();
    expect(h.state.reads.credits, 'credits was re-read at the first answered tick').toBeGreaterThan(creditsCallsBefore);
    expect(h.state.reads.karma, 'karma was not re-read (the membership state landed)').toBe(karmaCallsBefore);
    expect(h.state.reads.nameByOwner, 'the name was not re-read (the membership state landed)').toBe(nameCallsBefore);
  });
});
