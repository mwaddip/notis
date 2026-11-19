// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "A page's first node reads the feed again" —
// a page whose feed found no node before its first check reached one reads
// the feed once more when it does; only the page's first node asks it. And
// "Until the page's first check has ended, the feed's no-node line reads
// *searching for a connection…*"; after a first check that reached no node,
// it reads as a failed listing does.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, TipRun, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BlockCurrent, FeedResult, KarmaResult, StatusResult } from '../src/api/dto';
import { setNode, writeStore, KEY_NODE } from '../src/prefs';
import { karmaResult } from './karma-fixture';

const PUB = 'aa'.repeat(32);

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
  app: App;
  // Mutable state the fake api reads.
  state: {
    feedResults: Array<FeedResult | Error>;
    currentBlockThrows: boolean;
    feedCalls: number;
    currentBlockCalls: number;
  };
  // The verifier the App holds.
  verifier: {
    runCalls: number;
    settle: (run: TipRun) => void;
    reject: (e: Error) => void;
  };
  drive: {
    loadFeed(): Promise<void>;
    cornerTick?: () => Promise<void>;
    state: { feed: { error: string | null; loaded: boolean; posts: unknown[] } };
  };
  feedEl: HTMLElement;
}

function harness(): Harness {
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
    pending: [] as Array<{ settle: (run: TipRun) => void; reject: (e: Error) => void }>,
  };
  const verifier: TipVerifier = {
    run(): Promise<TipRun> {
      verifierState.runCalls += 1;
      return new Promise((settle, reject) => {
        verifierState.pending.push({ settle, reject });
      });
    },
  };
  const settleLast = (run: TipRun): void => {
    const p = verifierState.pending.shift();
    if (p !== undefined) p.settle(run);
  };
  const rejectLast = (e: Error): void => {
    const p = verifierState.pending.shift();
    if (p !== undefined) p.reject(e);
  };

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
  app.mount(appbar, feed, panes);

  return {
    app,
    state,
    verifier: {
      get runCalls() { return verifierState.runCalls; },
      settle: settleLast,
      reject: rejectLast,
    },
    drive: app as unknown as Harness['drive'],
    feedEl: feed,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  // Ensure the walkSeedList path is not taken — set a node preference.
  writeStore(KEY_NODE, 'http://node.test');
  setNode('http://node.test');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the feed re-reads when the page\'s first node is reached', () => {
  it('the feed found no node, the first check then reaches a node — the feed reads once more and its rows land', async () => {
    const h = harness();
    // The first loadFeed throws (no node). The second one — triggered by
    // the cornerTick's first success — brings a row.
    const landedRow: FeedResult = {
      posts: [{
        id: 'p1'.padEnd(64, '0'), content: 'hello', contentHash: '11'.repeat(32),
        author: 'bb'.repeat(32), parentRefs: [], protocolVersion: 1,
        type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
        likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
      }] as unknown as FeedResult['posts'],
      next: null, pending: [], pendingCount: 0,
    };
    h.state.feedResults = [new Error('offline'), landedRow];
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
    const h = harness();
    // The first loadFeed succeeds.
    const landedRow: FeedResult = {
      posts: [{
        id: 'p1'.padEnd(64, '0'), content: 'hello', contentHash: '11'.repeat(32),
        author: 'bb'.repeat(32), parentRefs: [], protocolVersion: 1,
        type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
        likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
      }] as unknown as FeedResult['posts'],
      next: null, pending: [], pendingCount: 0,
    };
    h.state.feedResults = [landedRow];
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
    const h = harness();
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
    const h = harness();
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
