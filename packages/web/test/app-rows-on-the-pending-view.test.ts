// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api, Page } from '../src/api/client';
import type { AppIdentity, FiguresVerifier, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BlockCurrent, FeedResult, KarmaResult, StatusResult, CreditsResult, UsernameResult, BondsResult, VouchesTargetResult, VouchCooldownsResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { setNode } from '../src/prefs';
import type { Anchor, FiguresResult, Listing } from '@dagsocial/nipopow-client';
import type { TipVerdict } from '../src/model/tip-verdict';

// The row's figure is the view's; the valuation reproduces the plain
// listing's `effective`; a plain read stands beside each view for a
// verifier run (WEB_INTERFACE → The extension → "The verified figures" —
// "reading the reader's plain listings first, beside their views", →
// The wallet → "A landing reads the plain listings, never `pending=1`",
// → The profile window → "The `rep` row is the rep view's `effective`
// alone", → The wallet window → "The `balance` row").

const PUB = 'aa'.repeat(32);
const BOX_K = '11'.repeat(32);
const BOX_C = '22'.repeat(32);

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function karmaWith(pub: string, effective: string): KarmaResult {
  return karmaResult({
    userId: pub,
    total: effective,
    effective,
    boxes: [{ boxId: BOX_K, value: effective }],
    boxCount: 1,
    height: 5990,
    member: true,
    memberSinceBlock: 100,
  });
}

function creditsWith(pub: string, value: string): CreditsResult {
  return {
    userId: pub,
    total: value,
    boxes: [{ boxId: BOX_C, value }],
    boxCount: 1,
    next: null,
  };
}

// anchor fixtures stay for the figures / tip verifiers the harness holds —
// a test that drives a tip run brings its own anchor.

interface KarmaRead { key: string; pending: boolean }
interface CreditsRead { key: string; pending: boolean }

interface Harness {
  app: App;
  karmaReads: KarmaRead[];
  creditsReads: CreditsRead[];
  figuresCalls: Array<{ listing: Listing; resolve: (r: FiguresResult) => void }>;
  tipRuns: Array<{ resolve: (v: { verdict: TipVerdict; anchor: Anchor | null; chain: string | null }) => void }>;
}

function harness(opts: {
  withVerifier?: boolean;
  karmaView?: () => KarmaResult;
  karmaPlain?: () => KarmaResult;
  creditsView?: () => CreditsResult;
  creditsPlain?: () => CreditsResult;
} = {}): Harness {
  const idKey = PUB;
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: idKey, locked: false }),
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
  const karmaReads: KarmaRead[] = [];
  const creditsReads: CreditsRead[] = [];
  const defViewK = (): KarmaResult => karmaWith(PUB, '82');
  const defPlainK = (): KarmaResult => karmaWith(PUB, '87');
  const defViewC = (): CreditsResult => creditsWith(PUB, '7500000000');
  const defPlainC = (): CreditsResult => creditsWith(PUB, '8750000000');
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async (key: string, _page: Page, o?: { pending: true }): Promise<KarmaResult> => {
      const pending = o?.pending === true;
      karmaReads.push({ key, pending });
      return pending ? (opts.karmaView ?? defViewK)() : (opts.karmaPlain ?? defPlainK)();
    },
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns: [], count: 0, next: null }),
    bonds: async (): Promise<BondsResult> => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async (): Promise<UsernameResult | null> => null,
    credits: async (key: string, _page: Page, o?: { pending: true }): Promise<CreditsResult> => {
      const pending = o?.pending === true;
      creditsReads.push({ key, pending });
      return pending ? (opts.creditsView ?? defViewC)() : (opts.creditsPlain ?? defPlainC)();
    },
    usernameByName: async () => null,
  };
  const writeClient = {} as unknown as WriteClient;

  const figuresCalls: Harness['figuresCalls'] = [];
  const figuresVerifier: FiguresVerifier = {
    run: (_readingBase, _user, listing) => new Promise<FiguresResult>((resolve) => {
      figuresCalls.push({ listing, resolve });
    }),
  };
  const tipRuns: Harness['tipRuns'] = [];
  const tipVerifier: TipVerifier = {
    run: () => new Promise<{ verdict: TipVerdict; anchor: Anchor | null; chain: string | null }>((resolve) => {
      tipRuns.push({ resolve });
    }),
  };

  const ledger = new PendingLedger(idKey);
  const app = new App(
    fakeApi, writeClient, identity, ledger, undefined, undefined,
    opts.withVerifier === false ? null : tipVerifier,
    opts.withVerifier === false ? null : figuresVerifier,
  );
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);
  return { app, karmaReads, creditsReads, figuresCalls, tipRuns };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
});

afterEach(() => { vi.useRealTimers(); });

describe('the rep row reads the pending view', () => {
  it('a profile open fires /karma with pending=1 — control: a read did fire', async () => {
    setNode('https://a.example');
    const h = harness();
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    const own = h.karmaReads.filter((r) => r.key === PUB);
    expect(own.length).toBeGreaterThan(0); // control
    expect(own[0]!.pending).toBe(true);
  });

  it('the number the row renders is the pending view\'s `effective`', async () => {
    setNode('https://a.example');
    const h = harness();
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    // The rep row carries a mono span with the view's `effective`. Scan the
    // rows for the one whose label reads `rep`, read its field's mono.
    let repField: Element | null = null;
    for (const r of document.querySelectorAll('.winbody .row')) {
      const label = r.querySelector('label');
      if (label?.textContent === 'rep') { repField = r.querySelector('.field'); break; }
    }
    expect(repField).not.toBeNull(); // control: the rep row drew
    const mono = repField!.querySelector('.mono');
    expect(mono).not.toBeNull(); // control: the mono stands
    expect(mono!.textContent).toBe('82'); // the view answers 82
  });
});

describe('the balance row reads the pending view', () => {
  it('a wallet open fires /credits with pending=1 — control: a read did fire', async () => {
    setNode('https://a.example');
    const h = harness();
    await flush();
    const inner = h.app as unknown as { openWallet(): void };
    inner.openWallet();
    await flush();
    const own = h.creditsReads.filter((r) => r.key === PUB);
    expect(own.length).toBeGreaterThan(0); // control
    expect(own[0]!.pending).toBe(true);
  });
});

describe('the figures run reads the plain listing beside the view', () => {
  it('the plain /karma is read beside the view — one request each', async () => {
    setNode('https://a.example');
    const h = harness();
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    const own = h.karmaReads.filter((r) => r.key === PUB);
    const plain = own.filter((r) => !r.pending);
    const view = own.filter((r) => r.pending);
    expect(view.length).toBeGreaterThan(0); // control
    expect(plain.length).toBeGreaterThan(0);
  });

});

describe('a web build (no verifier) reads no plain listing beside the view', () => {
  it('a profile open under no verifier fires one /karma — the view only', async () => {
    setNode('https://a.example');
    const h = harness({ withVerifier: false });
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    const own = h.karmaReads.filter((r) => r.key === PUB);
    expect(own.length).toBeGreaterThan(0); // control
    expect(own.every((r) => r.pending)).toBe(true);
    expect(own.filter((r) => !r.pending).length).toBe(0);
  });
});
