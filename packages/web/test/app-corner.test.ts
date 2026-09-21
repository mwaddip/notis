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

// The verified tip (WEB_INTERFACE → The extension → "The verified tip") — the
// verifier is optional; the extension build hands one in, the web build hands
// none. `app-corner.test.ts`'s existing tests already cover the no-verifier
// arm — they construct the App with the six-parameter shape, so a seventh
// optional parameter leaves them untouched.

import type { TipVerifier } from '../src/model/state';
import type { TipVerdict } from '../src/model/tip-verdict';
import { prefs, setNode } from '../src/prefs';

interface VerifierRun {
  gen: number;
  readingBase: string;
  resolve: (v: TipVerdict) => void;
  reject: (e: unknown) => void;
  promise: Promise<TipVerdict>;
}

interface VerifierHarness {
  app: App;
  runs: VerifierRun[];
  drive: {
    verifier: TipVerifier | null;
    tipVerdict: TipVerdict | null | undefined;
    verifyTimer: unknown;
    verifyInFlight: boolean;
    verifyGen: number;
    lastVerifyBeganAt: number | null;
    cornerEl: HTMLButtonElement | null;
  };
}

function verifierHarness(): VerifierHarness {
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
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async (): Promise<KarmaResult> => karmaResult({ userId: PUB, total: '0', effective: '0', boxes: [], boxCount: 0, height: 6000 }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
  const writeClient = {} as unknown as WriteClient;

  const runs: VerifierRun[] = [];
  const verifier: TipVerifier = {
    run: (readingBase) => {
      let resolve!: (v: TipVerdict) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<TipVerdict>((r, j) => { resolve = r; reject = j; });
      runs.push({ gen: runs.length, readingBase, resolve, reject, promise });
      return promise;
    },
  };

  const ledger = new PendingLedger(PUB);
  const app = new App(fakeApi, writeClient, identity, ledger, undefined, undefined, verifier);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);

  return { app, runs, drive: app as unknown as VerifierHarness['drive'] };
}

const verified = (nodes: number, height: number): TipVerdict => ({ kind: 'verified', nodes, height });

describe('the App verified tip — construction and the reading-base run', () => {
  beforeEach(() => {
    // The prefs module keeps `prefs.node` between tests; reset so an earlier
    // `setNode('https://…')` never leaks into a later test.
    setNode('');
  });

  it('with no verifier the corner passes verdict `undefined`, no verification timer exists', async () => {
    const h = harness();
    await Promise.resolve(); await Promise.resolve();
    // The six-parameter harness constructs the App without a verifier — the
    // seventh parameter is optional; the state is set accordingly.
    const inner = h.app as unknown as { verifier: TipVerifier | null; tipVerdict: unknown; verifyTimer: unknown };
    expect(inner.verifier).toBeNull();
    expect(inner.tipVerdict).toBeUndefined();
    expect(inner.verifyTimer).toBeNull();
  });

  it('mounts and starts one run at once against the current prefs.node', async () => {
    // Set prefs.node before the App mounts, so the first run reads it.
    setNode('https://a.example');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(1);
    expect(h.runs[0]!.readingBase).toBe('https://a.example');
    expect(h.drive.verifyInFlight).toBe(true);
    expect(h.drive.verifyTimer).not.toBeNull();
    // The verdict is `null` until the run returns — the corner reads *checking*.
    expect(h.drive.tipVerdict).toBeNull();
  });

  it('a trigger during a run does nothing — the press is the run in flight', async () => {
    setNode('https://a.example');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(1);
    // Press during the run — no second run.
    h.drive.cornerEl!.dispatchEvent(new Event('click'));
    await Promise.resolve();
    expect(h.runs.length).toBe(1);
    // Resolve the run.
    h.runs[0]!.resolve(verified(2, 7766));
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.tipVerdict).toEqual({ kind: 'verified', nodes: 2, height: 7766 });
    // A press after — one more run.
    h.drive.cornerEl!.dispatchEvent(new Event('click'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(2);
  });

  it('the ten-minute timer runs one', async () => {
    vi.useFakeTimers();
    setNode('https://a.example');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(1);
    h.runs[0]!.resolve(verified(2, 7766));
    await Promise.resolve(); await Promise.resolve();
    // Ten minutes go by.
    vi.advanceTimersByTime(600_000);
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(2);
  });

  it('a hidden tab runs none and its verify timer is stopped', async () => {
    vi.useFakeTimers();
    setNode('https://a.example');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    // Resolve the mount run.
    h.runs[0]!.resolve(verified(2, 7766));
    await Promise.resolve(); await Promise.resolve();
    // Hide the tab.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(h.drive.verifyTimer).toBeNull();
    // Ten minutes pass with the tab hidden — no run starts.
    vi.advanceTimersByTime(600_000);
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(1);
  });

  it('visible again inside ten minutes → no run; outside → one run', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    setNode('https://a.example');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    h.runs[0]!.resolve(verified(2, 7766));
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(1);

    // Hide, wait five minutes, show — no run inside ten minutes of the last
    // that began.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(300_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(1);

    // Hide again, wait past ten minutes total, show — one run.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(310_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(2);
  });

  it('changeNode drops the verdict at once, bumps the generation and starts a new run; the old run\'s late verdict never renders', async () => {
    setNode('https://a.example');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs[0]!.readingBase).toBe('https://a.example');

    // Change the reading node while the first run is still in flight.
    void (h.app as unknown as { changeNode(o: string): Promise<void> }).changeNode('https://b.example');
    await Promise.resolve();
    // The verdict returned to null at once, and a new run started against the
    // new base.
    expect(h.drive.tipVerdict).toBeNull();
    expect(h.runs.length).toBe(2);
    expect(h.runs[1]!.readingBase).toBe('https://b.example');

    // The old run resolves late — under an older generation, the verdict is
    // dropped.
    h.runs[0]!.resolve(verified(9, 111));
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.tipVerdict).toBeNull();

    // The new run resolves — its verdict lands.
    h.runs[1]!.resolve(verified(2, 222));
    await Promise.resolve(); await Promise.resolve();
    expect(h.drive.tipVerdict).toEqual({ kind: 'verified', nodes: 2, height: 222 });
  });

  it('a throwing verifier → the verdict stays null (checking), one console.error, the next trigger runs again', async () => {
    setNode('https://a.example');
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]): void => { errors.push(a); };
    try {
      const h = verifierHarness();
      await Promise.resolve(); await Promise.resolve();
      expect(h.runs.length).toBe(1);
      h.runs[0]!.reject(new Error('boom'));
      await Promise.resolve(); await Promise.resolve();
      expect(h.drive.tipVerdict).toBeNull();
      expect(errors.length).toBe(1);
      // A press starts a new run — the throw did not seize the seam.
      h.drive.cornerEl!.dispatchEvent(new Event('click'));
      await Promise.resolve(); await Promise.resolve();
      expect(h.runs.length).toBe(2);
    } finally {
      console.error = origError;
    }
  });

  it('a rejection under the current generation drops the verdict — never leaves the old verdict standing', async () => {
    setNode('https://a.example');
    const origError = console.error;
    console.error = (): void => {};
    try {
      const h = verifierHarness();
      await Promise.resolve(); await Promise.resolve();
      // Run 1 resolves verified — the corner's title reads *verified across 2
      // nodes*, the dot is `led fresh`.
      h.runs[0]!.resolve(verified(2, 7766));
      await Promise.resolve(); await Promise.resolve();
      expect(h.drive.tipVerdict).toEqual({ kind: 'verified', nodes: 2, height: 7766 });
      const btn = h.drive.cornerEl!;
      expect(btn.querySelector('.led')!.className).toBe('led fresh');
      expect(btn.getAttribute('title')).toContain('verified across 2 nodes');

      // A press starts run 2.
      btn.dispatchEvent(new Event('click'));
      await Promise.resolve(); await Promise.resolve();
      expect(h.runs.length).toBe(2);

      // Run 2 rejects — tipVerdict is `null`, the title reads *checking the
      // chain · tip N*, the dot is `led checking`. Asserted on the rendered
      // corner, not only on the field (WEB_INTERFACE → The extension → "The
      // verified tip").
      h.runs[1]!.reject(new Error('boom'));
      await Promise.resolve(); await Promise.resolve();
      expect(h.drive.tipVerdict).toBeNull();
      expect(btn.querySelector('.led')!.className).toBe('led checking');
      expect(btn.getAttribute('title')).toBe('checking the chain · tip 6001');
    } finally {
      console.error = origError;
    }
  });

  it('an empty prefs.node runs nothing — the empty base is not asked', async () => {
    // The describe's beforeEach reset prefs.node to '' via setNode(''); the
    // App is constructed while that empty base holds.
    expect(prefs.node).toBe('');
    const h = verifierHarness();
    await Promise.resolve(); await Promise.resolve();
    expect(h.runs.length).toBe(0);
  });
});
