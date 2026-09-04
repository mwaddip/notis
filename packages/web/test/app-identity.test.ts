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
    sign: () => 'ab'.repeat(64),
    draft: () => ({ pubKeyHex: KEY }),
    create: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      fire({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    discardDraft: () => {},
    inspectFile: () => ({ kind: 'clear', pubKeyHex: KEY }),
    importFile: async () => {
      cur = { pubKeyHex: KEY, locked: false };
      fire({ pubKeyHex: KEY });
      return { pubKeyHex: KEY };
    },
    exportFile: async () => '{}',
    unlock: async () => {
      if (cur) cur = { pubKeyHex: cur.pubKeyHex, locked: false };
    },
    lock: () => {
      if (cur) cur = { pubKeyHex: cur.pubKeyHex, locked: true };
    },
    forget: () => {
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

function harness(ledger: PendingLedger = new PendingLedger(null)): Harness {
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
      likeCount: 0, likedByViewer: null, confirmedAuthor: KEY,
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
  };
  const writeClient = {} as unknown as WriteClient;

  const app = new App(fakeApi, writeClient, idn, ledger);
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

  it('the standing row reads the tier after the /karma read on open', async () => {
    const h = harness();
    await h.idn.create('pw');
    await flush();
    h.drive.openProfile();
    await flush();
    // The read re-renders the whole region, so standing updates from ctx.karma
    // rather than being left at "—" by a karma-field-only update.
    expect(document.querySelector('.winbody .standing')?.textContent).toBe('resident');
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
