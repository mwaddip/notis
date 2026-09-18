// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BlockCurrent, FeedResult, PostResult, KarmaResult, StatusResult } from '../src/api/dto';
import { CORNER_POLL_MS, CORNER_STALE_MS } from '../src/view/corner';
import { karmaResult } from './karma-fixture';

// The App's status-corner wiring (WEB_INTERFACE → The status corner): a timer
// independent of the bounded landing poll, driven by visibility, an immediate
// read on visibility → visible and on the press. The visibility API is happy-
// dom's own — Object.defineProperty overrides visibilityState and dispatchEvent
// fires visibilitychange (the probe was refuted for the seam plan-b).

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function confirmedPost(id: string): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: AUTHOR, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: AUTHOR,
  };
}

interface Harness {
  app: App;
  ledger: PendingLedger;
  currentBlockCalls: { height: number }[];
  setHeight(h: number): void;
  setThrow(v: boolean): void;
  drive: {
    cornerEl: HTMLButtonElement | null;
    cornerTimer: unknown;
    cornerLastTip: number | null;
    cornerLastReadOk: boolean | null;
    cornerLastRiseAt: number | null;
    pollTimer: unknown;
    // For assertions on the App's shared viewerTip.
    viewerTip: number;
  };
}

function harness(): Harness {
  const identity: AppIdentity = {
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
  const currentBlockCalls: { height: number }[] = [];
  let blockHeight = 6001;
  let shouldThrow = false;

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => {
      if (shouldThrow) throw new Error('node unreachable');
      const b = { height: blockHeight, hash: null };
      currentBlockCalls.push({ height: b.height });
      return b;
    },
    karma: async (): Promise<KarmaResult> => karmaResult({ userId: PUB, total: '227', effective: '227', boxes: [{ boxId: '11'.repeat(32), value: '227' }], boxCount: 1, height: 6000 }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
  const writeClient = {} as unknown as WriteClient;

  const ledger = new PendingLedger(PUB);
  const app = new App(fakeApi, writeClient, identity, ledger);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);

  return {
    app, ledger, currentBlockCalls,
    setHeight: (h) => { blockHeight = h; },
    setThrow: (v) => { shouldThrow = v; },
    drive: app as unknown as Harness['drive'],
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // Default state — visibility comes back visible each test.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the App status corner — a timer independent of the bounded poll', () => {
  it('mounts a button.corner fixed to the viewport, in place under document.body', async () => {
    const h = harness();
    await flush();
    const btn = document.body.querySelector('button.corner');
    expect(btn).not.toBeNull();
    expect(h.drive.cornerEl).toBe(btn);
    // Exactly one mount — a second run leaves the same node in place.
    (h.app as unknown as { mountCorner(): void }).mountCorner();
    expect(document.body.querySelectorAll('button.corner').length).toBe(1);
  });

  it('reads at mount and once per CORNER_POLL_MS while visible', async () => {
    vi.useFakeTimers();
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    // The mount tick fired at once.
    expect(h.currentBlockCalls.length).toBe(1);
    // The bounded poll is off (no ledger entries); the corner's is on.
    expect(h.drive.pollTimer).toBeNull();
    expect(h.drive.cornerTimer).not.toBeNull();

    vi.advanceTimersByTime(CORNER_POLL_MS);
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(2);
    vi.advanceTimersByTime(CORNER_POLL_MS);
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(3);
  });

  it('the first answering read reads fresh; ten minutes with no rise turns stale; a rise resets to fresh', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    // WEB_INTERFACE → The status corner — the first answering read is treated
    // as a rise so a page never opens clay for a chain the client just saw.
    expect(h.drive.cornerLastReadOk).toBe(true);
    expect(h.drive.cornerLastTip).toBe(6001);
    expect(h.drive.cornerLastRiseAt).toBe(1_000_000);
    expect(h.drive.cornerEl!.querySelector('.led')!.classList.contains('fresh')).toBe(true);

    // Ten minutes of unchanged reads — the tip does not move; the corner turns stale.
    let elapsed = 0;
    while (elapsed <= CORNER_STALE_MS + CORNER_POLL_MS) {
      vi.advanceTimersByTime(CORNER_POLL_MS);
      await Promise.resolve(); await Promise.resolve();
      elapsed += CORNER_POLL_MS;
    }
    expect(h.drive.cornerEl!.querySelector('.led')!.classList.contains('stale')).toBe(true);

    // A rise — the tip moves; the corner turns fresh again.
    h.setHeight(6002);
    vi.advanceTimersByTime(CORNER_POLL_MS);
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.cornerLastTip).toBe(6002);
    expect(h.drive.cornerEl!.querySelector('.led')!.classList.contains('fresh')).toBe(true);
  });

  it('stops reading while hidden, resumes on visibility → visible with an immediate read', async () => {
    vi.useFakeTimers();
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(1);

    // Hide the tab.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(h.drive.cornerTimer).toBeNull();

    // Time passes — no reads.
    vi.advanceTimersByTime(CORNER_POLL_MS * 3);
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(1);

    // Show it again — an immediate read, then the timer resumes.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(2);
    expect(h.drive.cornerTimer).not.toBeNull();
    vi.advanceTimersByTime(CORNER_POLL_MS);
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(3);
  });

  it('a press reads at once', async () => {
    vi.useFakeTimers();
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(1);
    h.drive.cornerEl!.dispatchEvent(new Event('click'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.currentBlockCalls.length).toBe(2);
  });

  it('viewerTip follows the corner\'s reads', async () => {
    vi.useFakeTimers();
    const h = harness();
    // The mount-time tick fires synchronously against the harness\'s default
    // 6001, so viewerTip carries that at once — bumpTip runs on every answer.
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.viewerTip).toBe(6001);
    h.setHeight(7500);
    vi.advanceTimersByTime(CORNER_POLL_MS);
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.viewerTip).toBe(7500);
  });

  it('a failed read keeps the last number and turns the dot down', async () => {
    vi.useFakeTimers();
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.cornerEl!.querySelector('.led')!.classList.contains('fresh')).toBe(true);
    expect(h.drive.cornerLastTip).toBe(6001);

    h.setThrow(true);
    vi.advanceTimersByTime(CORNER_POLL_MS);
    await Promise.resolve(); await Promise.resolve();
    // The last number is preserved; the dot goes muted (down).
    expect(h.drive.cornerLastTip).toBe(6001);
    expect(h.drive.cornerLastReadOk).toBe(false);
    expect(h.drive.cornerEl!.querySelector('.led')!.classList.contains('down')).toBe(true);
    expect(h.drive.cornerEl!.querySelector('.tip')!.textContent).toBe('6001');
  });

  it('the bounded landing poll\'s cadence is unchanged — its timer is independent of the corner\'s', async () => {
    vi.useFakeTimers();
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    // Load an entry into the ledger, so the bounded poll would run: the two
    // timers coexist, each on its own cadence.
    h.ledger.add({
      kind: 'post', txId: 'tt'.repeat(32), postId: 'pp'.repeat(32),
      submittedAtHeight: 6000, expiresAtHeight: 6720,
      inputs: [],
    });
    // Manually start the poll (in production a submit path does this).
    (h.app as unknown as { startPoll(): void }).startPoll();
    expect(h.drive.pollTimer).not.toBeNull();
    expect(h.drive.cornerTimer).not.toBeNull();
    // The two timers hold distinct handles.
    expect(h.drive.pollTimer).not.toBe(h.drive.cornerTimer);
  });
});
