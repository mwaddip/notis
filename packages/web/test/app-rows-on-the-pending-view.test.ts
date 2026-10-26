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
import type { BlockHeader } from '@dagsocial/types';
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

function fakeHeader(height: number): BlockHeader {
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(32),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 0x1d00ffff,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function anchorFor(h: number): Anchor {
  return { tip: fakeHeader(h), suffixHead: { header: fakeHeader(h - 19), interlinks: [] } };
}

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
  it('a profile open fires /karma — one of the reader\'s own reads carries `pending`, one plain stands beside it under the figures verifier', async () => {
    setNode('https://a.example');
    const h = harness();
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    const own = h.karmaReads.filter((r) => r.key === PUB);
    expect(own.length).toBeGreaterThan(0); // control: a read did fire
    expect(own.some((r) => r.pending)).toBe(true);
    expect(own.some((r) => !r.pending)).toBe(true); // the plain beside the view, under the harness's verifier
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
  it('a wallet open fires /credits — one of the reader\'s own reads carries `pending`, one plain stands beside it under the figures verifier', async () => {
    setNode('https://a.example');
    const h = harness();
    await flush();
    const inner = h.app as unknown as { openWallet(): void };
    inner.openWallet();
    await flush();
    const own = h.creditsReads.filter((r) => r.key === PUB);
    expect(own.length).toBeGreaterThan(0); // control: a read did fire
    expect(own.some((r) => r.pending)).toBe(true);
    expect(own.some((r) => !r.pending)).toBe(true); // the plain beside the view, under the harness's verifier
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

// ---------------------------------------------------------------------------
// The verified-figures line reads the plain listing's figure and boxCount,
// never the view's: the clause names the view beside the proven amount, and
// an empty plain beside a non-empty view yields the clause alone.
// WEB_INTERFACE → The extension → "The verified figures", → The profile
// window → "The `rep` row is the rep view's `effective` alone", → The wallet
// window → "The `balance` row".
// ---------------------------------------------------------------------------

const RUN_H = 6001;
const PROVEN_H = RUN_H - 19; // suffixHead.header.height

function karmaProvenAtHeight(effective: string): KarmaResult {
  return karmaResult({
    userId: PUB,
    total: effective,
    effective,
    boxes: [{ boxId: BOX_K, value: effective }],
    boxCount: 1,
    height: 5990,
    member: true,
    memberSinceBlock: 100,
  });
}

function karmaEmpty(): KarmaResult {
  return karmaResult({
    userId: PUB,
    total: '0',
    effective: '0',
    boxes: [],
    boxCount: 0,
    height: 5990,
    member: true,
    memberSinceBlock: 100,
  });
}

function emptyLedgerSums(): { proven: bigint; young: bigint; unchecked: bigint; absent: bigint; unlisted: bigint; undecided: bigint } {
  return { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, undecided: 0n };
}

function karmaProvenResult(value: bigint): FiguresResult {
  return {
    boxes: [{ boxId: BOX_K, boxClass: 'karma', value, lockedUntilBlock: null, status: 'proven', verdict: '' }],
    record: { status: 'absent' },
    karma: { ...emptyLedgerSums(), proven: value, effective: value, holdings: 'read', holdingsVerdict: null },
    credits: { ...emptyLedgerSums(), holdings: 'read', holdingsVerdict: null },
    heightAfter: RUN_H,
    failed: false,
  };
}

function creditsProvenResult(value: bigint): FiguresResult {
  return {
    boxes: [{ boxId: BOX_C, boxClass: 'credit', value, lockedUntilBlock: null, status: 'proven', verdict: '' }],
    record: { status: 'absent' },
    karma: { ...emptyLedgerSums(), effective: 0n, holdings: 'read', holdingsVerdict: null },
    credits: { ...emptyLedgerSums(), proven: value, holdings: 'read', holdingsVerdict: null },
    heightAfter: RUN_H,
    failed: false,
  };
}

function karmaEmptyResult(): FiguresResult {
  return {
    boxes: [],
    record: { status: 'absent' },
    karma: { ...emptyLedgerSums(), effective: 0n, holdings: 'read', holdingsVerdict: null },
    credits: { ...emptyLedgerSums(), holdings: 'read', holdingsVerdict: null },
    heightAfter: RUN_H,
    failed: false,
  };
}

function repRow(): Element | null {
  for (const r of document.querySelectorAll('.winbody .row')) {
    const label = r.querySelector('label');
    if (label?.textContent === 'rep') return r.querySelector('.field');
  }
  return null;
}

async function resolveTipThenFigures(h: Harness, result: FiguresResult): Promise<void> {
  h.tipRuns[0]!.resolve({ verdict: { kind: 'verified', nodes: 2, height: RUN_H }, anchor: anchorFor(RUN_H), chain: null });
  await flush();
  // The tip resolver fires refreshOwnKarma (and refreshWalletCredits with
  // the wallet open), whose plain lands trigger `startFigures`. If a plain
  // read lands while a run is in flight (the two refreshes run in
  // parallel), the run's resolver kicks a fresh run. Resolve each queued
  // call in order and let the chain settle on the one that holds every
  // plain listing fresh.
  for (let i = 0; i < h.figuresCalls.length; i++) {
    h.figuresCalls[i]!.resolve(result);
    await flush();
  }
}

describe('the verified-figures line reads the plain listing, not the view', () => {
  it('rep: plain `effective` 87 with one proven box, view `effective` 82 — mono reads 82, hint names 82 beside the proven amount', async () => {
    setNode('https://a.example');
    const h = harness({
      karmaView: () => karmaProvenAtHeight('82'),
      karmaPlain: () => karmaProvenAtHeight('87'),
    });
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    await resolveTipThenFigures(h, karmaProvenResult(87n));

    const field = repRow();
    expect(field).not.toBeNull(); // control: the rep row drew
    expect(field!.querySelector('.mono')!.textContent).toBe('82');
    const hint = field!.querySelector<HTMLElement>('.hint');
    expect(hint).not.toBeNull(); // control: the line stands
    expect(hint!.textContent).toBe(`87 rep proven at block ${PROVEN_H} · 82 rep to spend in the next block, by this node's word`);
  });

  it('balance, wallet open: plain one 87.5 $NOTIS box proven, view one 75 $NOTIS box — the gold figure reads 75, the hint names 75 beside the proven amount', async () => {
    setNode('https://a.example');
    const h = harness({
      creditsView: () => creditsWith(PUB, '7500000000'),
      creditsPlain: () => creditsWith(PUB, '8750000000'),
    });
    await flush();
    const inner = h.app as unknown as { openProfile(): void; openWallet(): void };
    inner.openProfile();
    inner.openWallet();
    await flush();
    await resolveTipThenFigures(h, creditsProvenResult(8_750_000_000n));

    const gold = document.querySelector<HTMLElement>('.credits-line .mono.gold');
    expect(gold).not.toBeNull(); // control: the gold figure drew
    expect(gold!.textContent).toBe('75');
    const hint = document.querySelector<HTMLElement>('.credits-line .hint');
    expect(hint).not.toBeNull(); // control: the line stands
    expect(hint!.textContent).toBe(`87.5 $NOTIS proven at block ${PROVEN_H} · 75 $NOTIS to spend in the next block, by this node's word`);
  });

  it('rep: plain listing empty, view one box with `effective` 5 — the hint reads the clause alone', async () => {
    setNode('https://a.example');
    const h = harness({
      karmaView: () => karmaProvenAtHeight('5'),
      karmaPlain: () => karmaEmpty(),
    });
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    await resolveTipThenFigures(h, karmaEmptyResult());

    const field = repRow();
    expect(field).not.toBeNull(); // control: the rep row drew
    expect(field!.querySelector('.mono')!.textContent).toBe('5');
    const hint = field!.querySelector<HTMLElement>('.hint');
    expect(hint).not.toBeNull(); // control: the line stands
    expect(hint!.textContent).toBe("5 rep to spend in the next block, by this node's word");
  });
});
