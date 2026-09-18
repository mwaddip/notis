// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { KarmaResult, PostResult, StatusResult, FeedResult, BlockCurrent } from '../src/api/dto';
import type { PendingEntry } from '../src/wallet/types';
import type { WriteClient } from '../src/api/write';
import { prefs } from '../src/prefs';
import { karmaResult } from './karma-fixture';

// The App's identity wiring (5a): the header control's two states, the /karma read
// on the profile window, an identity change rebuilding the ledger and re-reading
// with the new viewer, and the faucet grant riding the bounded poll. Driven over a
// fake identity module (which fires onChange), a fake Api, and a stubbed fetch for
// the faucet. The locked-write check and · you are the next sub-phase.

const KEY = 'ab'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 2, memberLikesBar: 2 },
  };
}

/** A controllable identity module: current() is state, and create/import/forget
 *  fire onChange the way the real module does. */
function fakeIdentity(): AppIdentity {
  let cur: { pubKeyHex: string; locked: boolean } | null = null;
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  const fire = (id: { pubKeyHex: string } | null): void => {
    for (const l of listeners) l(id);
  };
  return {
    current: () => cur,
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: KEY }),
    create: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      fire({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: KEY }),
    importFile: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      fire({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    exportFile: async () => '{}',
    unlock: async () => {
      if (cur) cur = { pubKeyHex: cur.pubKeyHex, locked: false };
    },
    lock: async () => {
      if (cur) cur = { pubKeyHex: cur.pubKeyHex, locked: true };
    },
    forget: async () => {
      cur = null;
      fire(null);
    },
    backedUp: () => false,
    onChange: (l) => {
      listeners.push(l);
    },
  };
}

interface Drive {
  askFaucet(): Promise<void>;
  pollTick(): Promise<void>;
  openProfile(): void;
  ledger: PendingLedger;
  pollTimer: unknown;
  profileKarma: KarmaResult | null;
  grantView: { state: 'pending' } | { state: 'expired'; atHeight: number } | null;
}

interface Harness {
  app: App;
  idn: AppIdentity;
  appbar: HTMLElement;
  feed: HTMLElement;
  drive: Drive;
  feedViewers: Array<string | undefined>;
  karmaKeys: string[];
  setBoxCount(n: number): void;
  setHeight(h: number): void;
}

interface HarnessOpts {
  ledger?: PendingLedger;
  requestFaucetOrigin?: (origin: string) => Promise<boolean>;
}

function harness(opts: PendingLedger | HarnessOpts = {}): Harness {
  const optsObj: HarnessOpts = opts instanceof PendingLedger ? { ledger: opts } : opts;
  const ledger = optsObj.ledger ?? new PendingLedger(null);
  const idn = fakeIdentity();
  const feedViewers: Array<string | undefined> = [];
  const karmaKeys: string[] = [];
  let boxCount = 0;
  let height = 6001;

  const fakeApi: Api = {
    feed: async (_p, viewer): Promise<FeedResult> => {
      feedViewers.push(viewer);
      return { posts: [], next: null, pending: [], pendingCount: 0 };
    },
    thread: async () => null,
    post: async (id): Promise<PostResult> => ({
      id, content: 'x', contentHash: '00'.repeat(32), author: KEY, parentRefs: [], protocolVersion: 1,
      type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
      likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: KEY,
    }),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height, hash: null }),
    karma: async (key): Promise<KarmaResult> => {
      karmaKeys.push(key);
      return karmaResult({ userId: key, boxCount, total: boxCount > 0 ? '250' : '0', effective: boxCount > 0 ? '250' : '0' });
    },
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: "", total: "0", boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
  const writeClient = {} as unknown as WriteClient;

  const app = new App(fakeApi, writeClient, idn, ledger, undefined, optsObj.requestFaucetOrigin);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);

  return {
    app, idn, appbar, feed, feedViewers, karmaKeys,
    drive: app as unknown as Drive,
    setBoxCount: (n) => { boxCount = n; },
    setHeight: (h) => { height = h; },
  };
}

function headerText(appbar: HTMLElement): string {
  const control = appbar.querySelector('button[aria-label="open profile"]');
  return control?.textContent ?? '';
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  prefs.faucet = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the App identity control', () => {
  it('the header reads profile with no identity, the key prefix with one', async () => {
    const h = harness();
    expect(headerText(h.appbar)).toBe('profile');
    await h.idn.create('pw'); // fires onChange
    await flush();
    expect(headerText(h.appbar)).toBe(KEY.slice(0, 16) + '…');
  });

  it('an identity change re-reads the feed with the new viewer, and forget drops it', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    expect(h.feedViewers.at(-1)).toBe(KEY); // reads now carry the viewer
    h.idn.forget();
    await flush();
    expect(h.feedViewers.at(-1)).toBeUndefined(); // and none after forget
    expect(headerText(h.appbar)).toBe('profile');
  });

  it('forget removes the feed write control', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    expect(h.feed.querySelector('[data-composer-open]')).not.toBeNull();
    h.idn.forget();
    await flush();
    expect(h.feed.querySelector('[data-composer-open]')).toBeNull();
  });

  it('an identity change rebuilds the pending ledger for the new key', async () => {
    const h = harness();
    const before = h.drive.ledger;
    await h.idn.create('pw');
    await flush();
    expect(h.drive.ledger).not.toBe(before); // a fresh ledger, keyed by the new identity
  });

  it('a restored ledger with a pending entry starts the poll on mount', () => {
    vi.useFakeTimers();
    const ledger = new PendingLedger(KEY);
    ledger.add({ txId: 'cc'.repeat(32), kind: 'grant', postId: KEY, inputs: [], expiresAtHeight: 6100, submittedAtHeight: 6000 });
    const h = harness(ledger);
    expect(h.drive.pollTimer).not.toBeNull(); // the poll runs while the ledger holds an entry
  });
});

describe('the App profile window — /karma and the faucet grant', () => {
  it('opening the profile window reads /karma for the loaded key', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    h.karmaKeys.length = 0;
    h.drive.openProfile();
    await flush();
    expect(h.karmaKeys).toContain(KEY);
  });

  it('the rep row reads the effective number after the /karma read on open', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    h.setBoxCount(1); // the next /karma read carries the box, so effective is 250
    h.drive.openProfile();
    await flush();
    // The read re-renders the whole region, so the rep field updates from ctx.karma
    // rather than being left at "—" by a karma-field-only update.
    const rep = [...document.querySelectorAll('.winbody .row')].find((r) => r.querySelector('label')?.textContent === 'rep');
    expect(rep?.querySelector('.field .mono')?.textContent).toBe('250');
  });

  it('askFaucet adds a grant entry and starts the poll; the grant lands when a box appears', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    prefs.faucet = '/faucet';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 202,
        statusText: '',
        json: async () => ({ txId: 'cc'.repeat(32), status: 'pending', expiresAtHeight: 6100 }),
      })),
    );

    vi.useFakeTimers();
    await h.drive.askFaucet();
    const entries = h.drive.ledger.all();
    expect(entries.map((e: PendingEntry) => e.kind)).toEqual(['grant']);
    expect(entries[0]!.postId).toBe(KEY); // keyed by the key the grant was asked for
    expect(h.drive.pollTimer).not.toBeNull();
    expect(h.drive.grantView).toEqual({ state: 'pending' });

    // A poll tick while still zero leaves the grant pending.
    h.setBoxCount(0);
    h.setHeight(6002);
    await h.drive.pollTick();
    expect(h.drive.ledger.size).toBe(1);

    // The box appears — the grant lands and leaves the ledger.
    h.setBoxCount(1);
    h.setHeight(6003);
    await h.drive.pollTick();
    expect(h.drive.ledger.size).toBe(0);
    expect(h.drive.grantView).toBeNull();
    expect(h.drive.profileKarma?.boxCount).toBe(1);
  });

  it('a press on the key control inside the mounted profile window copies the loaded key (WEB_INTERFACE → The profile window → "The key is a control, and a press copies it")', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    h.drive.openProfile();
    await flush();
    const btn = document.querySelector('.winbody .row button.key-copy') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe(KEY);
    const writes: string[] = [];
    const originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => { writes.push(t); } },
    });
    try {
      btn.click();
      await flush();
      expect(writes).toEqual([KEY]);
      expect(btn.querySelector('.key-copy-note')?.textContent).toBe(' copied');
    } finally {
      if (originalClipboard === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    }
  });

  it('a grant expires past its height while still zero', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    prefs.faucet = '/faucet';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 202,
        statusText: '',
        json: async () => ({ txId: 'cc'.repeat(32), status: 'pending', expiresAtHeight: 6100 }),
      })),
    );
    vi.useFakeTimers();
    await h.drive.askFaucet();
    h.setBoxCount(0);
    h.setHeight(6101); // past expiresAtHeight
    await h.drive.pollTick();
    expect(h.drive.ledger.size).toBe(0);
    expect(h.drive.grantView).toEqual({ state: 'expired', atHeight: 6100 });
  });
});

// WEB_INTERFACE → The faucet step → "In the extension the press asks the
// browser for the faucet's origin first" — the extension arm carries the
// permission hook; the web arm carries none, and the ask leaves as today.
describe('the App faucet permission — the extension arm (rep step)', () => {
  const FAUCET_ORIGIN = 'https://faucet.example';

  // The button on the mounted profile window is the real click surface. The
  // profile window is opened first; the ask press then drives the App.
  async function pressAsk(h: Harness): Promise<HTMLButtonElement> {
    await h.idn.create('pw');
    await flush();
    prefs.faucet = FAUCET_ORIGIN;
    h.drive.openProfile();
    await flush();
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.winbody .row .word')]
      .find((b) => b.textContent === 'ask the faucet for rep')!;
    return btn;
  }

  it('the hook is invoked synchronously from the ask press, before any await; the faucet request has not left when the hook is held', async () => {
    // A hook that never resolves — it holds the App's `await` open. If the
    // ask reached the faucet before the hook returns, faucetKarmaCalls would
    // be non-zero right after the click.
    const hookCalls: string[] = [];
    const hook = (o: string): Promise<boolean> => {
      hookCalls.push(o);
      return new Promise(() => {}); // held for ever
    };
    const h = harness({ requestFaucetOrigin: hook });
    let faucetKarmaCalls = 0;
    (h.app as unknown as { faucetClient: { askKarma: (k: string) => Promise<unknown> } }).faucetClient = {
      askKarma: async () => { faucetKarmaCalls++; return { txId: 'cc'.repeat(32), status: 'pending', expiresAtHeight: 6100 }; },
    };
    const btn = await pressAsk(h);
    // The click is a synchronous dispatch; the listener runs `handlers.askFaucet()`
    // which void-calls this.askFaucet(); the sync prefix runs until the first
    // `await`. The hook must have been called by the time `.click()` returns.
    btn.click();
    expect(hookCalls).toEqual([FAUCET_ORIGIN]);
    expect(faucetKarmaCalls).toBe(0);
    // Two microtask flushes prove the hold: the outer askFaucet is suspended
    // on `await permission` and cannot reach `askKarma`.
    await flush();
    await flush();
    expect(faucetKarmaCalls).toBe(0);
  });

  it('a refused permission reports on the profile window and no faucet request leaves', async () => {
    const h = harness({ requestFaucetOrigin: async () => false });
    let faucetKarmaCalls = 0;
    (h.app as unknown as { faucetClient: { askKarma: (k: string) => Promise<unknown> } }).faucetClient = {
      askKarma: async () => { faucetKarmaCalls++; return { txId: 'cc'.repeat(32), status: 'pending', expiresAtHeight: 6100 }; },
    };
    const btn = await pressAsk(h);
    btn.click();
    await flush();
    await flush();
    expect(faucetKarmaCalls).toBe(0);
    expect(h.drive.ledger.size).toBe(0);
    // The report line is the profile column's — "the browser refused access to
    // that origin." — rendered as the .report node of the focused column.
    const report = document.querySelector('.report');
    expect(report?.textContent).toContain('the browser refused access to that origin.');
  });

  it('a granted permission lets the faucet request leave and the ledger holds the grant', async () => {
    const h = harness({ requestFaucetOrigin: async () => true });
    let faucetKarmaCalls = 0;
    (h.app as unknown as { faucetClient: { askKarma: (k: string) => Promise<unknown> } }).faucetClient = {
      askKarma: async () => { faucetKarmaCalls++; return { txId: 'cc'.repeat(32), status: 'pending', expiresAtHeight: 6100 }; },
    };
    const btn = await pressAsk(h);
    btn.click();
    await flush();
    await flush();
    expect(faucetKarmaCalls).toBe(1);
    const entries = h.drive.ledger.all();
    expect(entries.map((e: PendingEntry) => e.kind)).toEqual(['grant']);
    expect(h.drive.grantView).toEqual({ state: 'pending' });
  });

  it('with no hook (the web build), the ask leaves as today', async () => {
    const h = harness(); // no requestFaucetOrigin passed
    let faucetKarmaCalls = 0;
    (h.app as unknown as { faucetClient: { askKarma: (k: string) => Promise<unknown> } }).faucetClient = {
      askKarma: async () => { faucetKarmaCalls++; return { txId: 'cc'.repeat(32), status: 'pending', expiresAtHeight: 6100 }; },
    };
    const btn = await pressAsk(h);
    btn.click();
    await flush();
    await flush();
    expect(faucetKarmaCalls).toBe(1);
    const entries = h.drive.ledger.all();
    expect(entries.map((e: PendingEntry) => e.kind)).toEqual(['grant']);
  });
});
