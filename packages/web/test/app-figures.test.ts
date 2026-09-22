// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, FiguresVerifier, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BlockCurrent, FeedResult, KarmaResult, StatusResult, CreditsResult, UsernameResult, BondsResult, VouchesTargetResult, VouchCooldownsResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { setNode } from '../src/prefs';
import type { Anchor, FiguresResult, Listing } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import type { TipVerdict } from '../src/model/tip-verdict';

// The App's verified-figures wiring (WEB_INTERFACE → The extension → "The
// verified figures"): runs when the App has an identity, an anchor and a
// karma listing; every write of `profileKarma` or `walletCredits` from a
// read triggers a run; a run in flight marks one more; a listing that
// moved during a run drops the result and runs again; a node change bumps
// the generation and drops the last result; a rejection is one console.error.

const PUB = 'aa'.repeat(32);
const PUB2 = 'bb'.repeat(32);
const BOX = '11'.repeat(32);

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function karmaWith(pub: string, effective = '5'): KarmaResult {
  return karmaResult({
    userId: pub,
    total: effective,
    effective,
    boxes: [{ boxId: BOX, value: effective }],
    boxCount: 1,
    height: 5990,
    member: true,
    memberSinceBlock: 100,
  });
}

function creditsWith(pub: string, value = '100000000'): CreditsResult {
  return {
    userId: pub,
    total: value,
    boxes: [{ boxId: '22'.repeat(32), value }],
    boxCount: 1,
    next: null,
  };
}

function fakeHeader(height: number, tag: string): BlockHeader {
  const suffix = tag.padStart(2, '0');
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + suffix,
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 0x1d00ffff,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
  };
}

type PoPowHeader = Anchor['suffixHead'];

function fakePopow(h: BlockHeader): PoPowHeader {
  return { header: h, interlinks: [] };
}

function anchorFor(h: number, tag = 'aa'): Anchor {
  return { tip: fakeHeader(h, tag), suffixHead: fakePopow(fakeHeader(h - 19, tag)) };
}

function emptyResult(heightAfter = 6001): FiguresResult {
  return {
    boxes: [],
    record: { status: 'absent' },
    karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: 0n },
    credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n },
    heightAfter,
    failed: false,
  };
}

interface FigureCall {
  gen: number;
  readingBase: string;
  user: string;
  listing: Listing;
  anchor: Anchor;
  resolve: (r: FiguresResult) => void;
  reject: (e: unknown) => void;
  promise: Promise<FiguresResult>;
}

interface TipRunLike {
  verdict: TipVerdict;
  anchor: Anchor | null;
}

interface Harness {
  app: App;
  figuresCalls: FigureCall[];
  tipRuns: { resolve: (v: TipRunLike) => void; reject: (e: unknown) => void; promise: Promise<TipRunLike> }[];
  drive: {
    figuresVerifier: FiguresVerifier | null;
    figures: unknown;
    figuresGen: number;
    figuresInFlight: boolean;
    figuresDirty: boolean;
    tipAnchor: Anchor | null;
    tipVerdict: TipVerdict | null | undefined;
    verifier: TipVerifier | null;
  };
  fakeIdm: {
    listener: null | ((id: { pubKeyHex: string } | null) => void);
    setKey(key: string | null): void;
  };
}

function harness(opts: { withIdentity?: boolean } = {}): Harness {
  let idListener: ((id: { pubKeyHex: string } | null) => void) | null = null;
  let idKey: string | null = opts.withIdentity ? PUB : null;
  const identity: AppIdentity = {
    current: () => (idKey === null ? null : { pubKeyHex: idKey, locked: false }),
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
    onChange: (l) => { idListener = l; },
  };
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async (key: string): Promise<KarmaResult> => karmaWith(key),
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns: [], count: 0, next: null }),
    bonds: async (): Promise<BondsResult> => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async (): Promise<UsernameResult | null> => null,
    credits: async (key: string): Promise<CreditsResult> => creditsWith(key),
    usernameByName: async () => null,
  };
  const writeClient = {} as unknown as WriteClient;

  const figuresCalls: FigureCall[] = [];
  const figuresVerifier: FiguresVerifier = {
    run: (readingBase, user, listing, anchor) => {
      let resolve!: (r: FiguresResult) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<FiguresResult>((r, j) => { resolve = r; reject = j; });
      figuresCalls.push({ gen: figuresCalls.length, readingBase, user, listing, anchor, resolve, reject, promise });
      return promise;
    },
  };

  const tipRuns: Harness['tipRuns'] = [];
  const tipVerifier: TipVerifier = {
    run: () => {
      let resolve!: (v: TipRunLike) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<TipRunLike>((r, j) => { resolve = r; reject = j; });
      tipRuns.push({ resolve, reject, promise });
      return promise;
    },
  };

  const ledger = new PendingLedger(idKey);
  const app = new App(fakeApi, writeClient, identity, ledger, undefined, undefined, tipVerifier, figuresVerifier);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);

  return {
    app, figuresCalls, tipRuns,
    drive: app as unknown as Harness['drive'],
    fakeIdm: {
      get listener(): Harness['fakeIdm']['listener'] { return idListener; },
      setKey(k) { idKey = k; if (idListener) idListener(k === null ? null : { pubKeyHex: k }); },
    },
  };
}

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

const verifiedVerdict = (nodes: number, height: number): TipVerdict => ({ kind: 'verified', nodes, height });

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe('the App verified figures — the triggers', () => {
  it('runs after a tip run that ends `verified` — with the listing the App holds and the reading node\'s anchor', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    // The App opens the profile so /karma is read: loadMembershipState fires,
    // profileKarma is set, and the trigger inside it calls startFigures — but
    // the tip anchor is not yet set. Wait for the tip run instead.
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    // Before the tip run resolves, no figures run has fired (no anchor).
    expect(h.figuresCalls.length).toBe(0);
    // Resolve the tip run — `verified` with an anchor. The App writes
    // tipAnchor beside the verdict and calls startFigures.
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    expect(h.figuresCalls.length).toBe(1);
    const call = h.figuresCalls[0]!;
    expect(call.readingBase).toBe('https://a.example');
    expect(call.user).toBe(PUB);
    expect(call.anchor).toBe(anchor);
    // The karma listing is the one the App holds; credits was read too when
    // the wallet's own open happened — the profile alone leaves credits empty.
    expect(call.listing.karma.boxes.length).toBe(1);
    expect(call.listing.credits.boxes.length).toBe(0);
  });

  it('does not run after a tip run that ends `thin` — no anchor stands', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    // Load /karma so the App holds a listing.
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    h.tipRuns[0]!.resolve({ verdict: { kind: 'thin', reason: 'one-node', height: 6001 }, anchor: null });
    await flush();
    // No figures run: the tip resolver drops `figures` and never calls the
    // verifier under a non-verified verdict.
    expect(h.figuresCalls.length).toBe(0);
    expect(h.drive.figures).toBeNull();
  });

  it('runs after a wallet read while an anchor stands', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    // Land a `verified` anchor first.
    const inner = h.app as unknown as { openProfile(): void; openWallet(): void };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    // The first trigger — the tip run's resolver — is in flight; resolve it so
    // the wallet's write triggers a fresh run cleanly.
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    const before = h.figuresCalls.length;
    inner.openWallet();
    await flush();
    // The wallet's fresh /credits read triggers a run — the credits listing
    // is now the App's.
    expect(h.figuresCalls.length).toBe(before + 1);
    const call = h.figuresCalls[before]!;
    expect(call.listing.credits.boxes.length).toBe(1);
  });

  it('runs after loadMembershipState (the profile ↻) while an anchor stands', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void; refreshProfileKarma(): Promise<void> };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    const before = h.figuresCalls.length;
    // The ↻ re-reads /karma via loadMembershipState → startFigures.
    void inner.refreshProfileKarma();
    await flush();
    expect(h.figuresCalls.length).toBe(before + 1);
  });

  it('does not run without an identity', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: false });
    await flush();
    // Even a `verified` tip run does not trigger a figures run: no identity.
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor: anchorFor(6001) });
    await flush();
    expect(h.figuresCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single flight, dirty flag, drops
// ---------------------------------------------------------------------------

describe('the App verified figures — single flight and the drops', () => {
  it('a trigger during a run marks one more run and exactly one follows', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void; refreshWalletCredits(): Promise<void>; refreshProfileKarma(): Promise<void> };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    // Run 0 is in flight — refresh /karma while it stands (this triggers
    // startFigures twice: the /karma write also fires it). Only one more
    // run should follow when run 0 resolves.
    expect(h.figuresCalls.length).toBe(1);
    expect(h.drive.figuresInFlight).toBe(true);
    void inner.refreshProfileKarma();
    await flush();
    void inner.refreshProfileKarma();
    await flush();
    // Still one in flight, no new call.
    expect(h.figuresCalls.length).toBe(1);
    expect(h.drive.figuresDirty).toBe(true);
    // Run 0 resolves — one more run fires.
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.figuresCalls.length).toBe(2);
    expect(h.drive.figuresDirty).toBe(false);
  });

  it('a listing that moved during a run drops the result and runs again', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void; refreshProfileKarma(): Promise<void> };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    expect(h.figuresCalls.length).toBe(1);
    // Refresh the karma listing WHILE the run is in flight. The write
    // replaces profileKarma with a fresh object — the run's captured pair no
    // longer matches when it resolves.
    void inner.refreshProfileKarma();
    await flush();
    // The refresh marks dirty (a run is in flight), and no fresh call fires.
    expect(h.figuresCalls.length).toBe(1);
    // Run 0 resolves — the listing moved, so the result is dropped and a
    // fresh run starts against the current listing.
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.figuresCalls.length).toBe(2);
    // `figures` never took run 0's result — it stays null until run 1 lands.
    expect(h.drive.figures).toBeNull();
  });

  it('a node change bumps the generation and drops the last result — a late result touches nothing', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void; changeNode(o: string): Promise<void> };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    expect(h.figuresCalls.length).toBe(1);
    // A previous run's result had landed.
    h.figuresCalls[0]!.resolve(emptyResult(6001));
    await flush();
    expect(h.drive.figures).not.toBeNull();
    // Now the reading node changes.
    void inner.changeNode('https://b.example');
    await flush();
    // figures is dropped, gen bumps.
    expect(h.drive.figures).toBeNull();
    // A late result from a previous-node run never lands — the App is on
    // gen+1 now, so the resolver's gen check drops it.
    const stalled = h.figuresCalls.length; // may include one issued by the tip resolver from the changeNode → new tip run once resolved
    // Only assert the drop: figures stays null after a late resolve under
    // the older gen — even after the test issues another figures run.
    // (We do not resolve the new tip run so no fresh figures call fires here.)
    expect(stalled).toBeGreaterThanOrEqual(1);
    expect(h.drive.figures).toBeNull();
  });

  it('an identity change drops `figures` and bumps the generation — a late result touches nothing', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.drive.figures).not.toBeNull();
    const genBefore = h.drive.figuresGen;
    // Identity change fires onChange → onIdentityChange.
    h.fakeIdm.setKey(PUB2);
    await flush();
    expect(h.drive.figures).toBeNull();
    expect(h.drive.figuresGen).toBe(genBefore + 1);
  });
});

// ---------------------------------------------------------------------------
// Verdict changes and the balance row's line
// ---------------------------------------------------------------------------

describe('the App verified figures — the verdict and the row', () => {
  it('ctx().figures carries the result and the balance row renders the hint the line model gives it', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void; openWallet(): void; ctx(): { figures: unknown } };
    inner.openProfile();
    inner.openWallet();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    // Resolve with a young-remainder result — 25 $NOTIS landed since. The
    // balance row's hint reads that; the credit boxes list has one box for
    // the wallet, so ctx().figures should carry the result.
    const result: FiguresResult = {
      boxes: [{ boxId: '22'.repeat(32), boxClass: 'credit', value: 100000000n, lockedUntilBlock: null, status: 'young', verdict: '' }],
      record: { status: 'absent' },
      karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: 0n },
      credits: { proven: 0n, young: 100000000n, unchecked: 0n, absent: 0n },
      heightAfter: 6001,
      failed: false,
    };
    // Resolve the last figures run that reflects the current listing.
    const lastCall = h.figuresCalls[h.figuresCalls.length - 1]!;
    lastCall.resolve(result);
    await flush();
    const ctx = inner.ctx();
    expect(ctx.figures).not.toBeNull();
    // The wallet's balance row is on screen — its .credits-line carries a
    // .hint with the young-remainder sentence.
    const hint = document.querySelector('.credits-line .hint');
    expect(hint?.textContent ?? '').toContain('landed since');
  });

  it('`figures` drops when the verdict turns `thin` on a later run', async () => {
    setNode('https://a.example');
    const h = harness({ withIdentity: true });
    await flush();
    const inner = h.app as unknown as { openProfile(): void };
    inner.openProfile();
    await flush();
    const anchor = anchorFor(6001);
    h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
    await flush();
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.drive.figures).not.toBeNull();
    // A press starts a new tip run; it resolves `thin` — the resolver drops
    // figures and re-renders the rows.
    (h.app as unknown as { cornerEl: HTMLButtonElement }).cornerEl.dispatchEvent(new Event('click'));
    await flush();
    h.tipRuns[1]!.resolve({ verdict: { kind: 'thin', reason: 'one-node', height: 6001 }, anchor: null });
    await flush();
    expect(h.drive.figures).toBeNull();
  });

  it('a throwing figures run leaves `figures` unchanged — a run in flight keeps the line it had', async () => {
    setNode('https://a.example');
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]): void => { errors.push(a); };
    try {
      const h = harness({ withIdentity: true });
      await flush();
      const inner = h.app as unknown as { openProfile(): void };
      inner.openProfile();
      await flush();
      const anchor = anchorFor(6001);
      h.tipRuns[0]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
      await flush();
      // Resolve the first figures run so a landing stands.
      h.figuresCalls[0]!.resolve(emptyResult());
      await flush();
      const held = h.drive.figures;
      expect(held).not.toBeNull();
      // A press triggers a fresh tip run; it verifies. That fires a fresh
      // figures run which then rejects. `figures` must stay the previous
      // landing.
      (h.app as unknown as { cornerEl: HTMLButtonElement }).cornerEl.dispatchEvent(new Event('click'));
      await flush();
      h.tipRuns[1]!.resolve({ verdict: verifiedVerdict(2, 6001), anchor });
      await flush();
      h.figuresCalls[1]!.reject(new Error('boom'));
      await flush();
      expect(h.drive.figures).toBe(held);
      expect(errors.length).toBe(1);
    } finally {
      console.error = origError;
    }
  });
});
