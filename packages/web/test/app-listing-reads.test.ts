// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, FiguresVerifier, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { CreditsResult, FeedResult, KarmaResult, PostResult, StatusResult } from '../src/api/dto';
import type { EntryKind } from '../src/wallet/types';
import { karmaResult } from './karma-fixture';
import { prefs, setNode, KEY_LAYOUT } from '../src/prefs';
import type { Anchor, FiguresResult, Listing } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import type { TipVerdict } from '../src/model/tip-verdict';

// Every listing a figures run proves was read after the run's anchor
// (WEB_INTERFACE → The extension → "The verified figures"): a verified tip reads
// the reader's listings first — /karma always, /credits while the wallet is
// open — a read's stamp is taken as it begins, a listing read before the anchor
// is never proven against it, and a credits listing not read after it goes to
// the run empty while its row, on screen, reads *not checked yet*. Every landing
// of the reader's own transaction re-reads the listing it changed, once per tick
// however many land in it, in every build (→ The profile window → "The `rep`
// row is the `effective` number alone").

const ME = 'aa'.repeat(32);
const X = 'cd'.repeat(32);
const NODE = 'https://a.example';
const K1 = '11'.repeat(32);
const K2 = '12'.repeat(32);
const K3 = '13'.repeat(32);
const C1 = '21'.repeat(32);
const C2 = '22'.repeat(32);
const P = '31'.repeat(32);
const L = '32'.repeat(32);
const W = '33'.repeat(32);

/** The node's state as the reads find it; a test moves it between reads. */
interface Chain {
  height: number;
  karma: { boxId: string; value: string }[];
  effective: string;
  credits: { boxId: string; value: string }[];
  posts: Map<string, PostResult>;
  vouchTargets: string[];
}

interface Call { method: string; key: string | undefined }
interface Held { method: string; release(): void }

function statusAt(height: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight: height, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000', membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
  };
}

function fakeNode(chain: Chain) {
  const calls: Call[] = [];
  const held: Held[] = [];
  let hold: (method: string) => boolean = () => false;
  let fail: (method: string) => boolean = () => false;
  function answer<T>(method: string, key: string | undefined, make: () => T): Promise<T> {
    calls.push({ method, key });
    if (fail(method)) return Promise.reject(new Error(`${method} failed`));
    if (!hold(method)) return Promise.resolve(make());
    return new Promise<T>((resolve) => { held.push({ method, release: () => resolve(make()) }); });
  }
  const api: Api = {
    feed: () => answer('feed', undefined, (): FeedResult => ({ posts: [], next: null, pending: [], pendingCount: 0 })),
    thread: () => answer('thread', undefined, () => null),
    post: (id) => answer('post', id, () => chain.posts.get(id) ?? null),
    status: () => answer('status', undefined, () => statusAt(chain.height)),
    currentBlock: () => answer('currentBlock', undefined, () => ({ height: chain.height, hash: null })),
    karma: (key) => answer('karma', key, (): KarmaResult => karmaResult({
      userId: key, total: chain.effective, effective: chain.effective, boxes: [...chain.karma],
      boxCount: chain.karma.length, height: chain.height, member: true, memberSinceBlock: 5, invitesAvailable: 2,
    })),
    credits: (key) => answer('credits', key, (): CreditsResult => ({
      userId: key, total: '0', boxes: [...chain.credits], boxCount: chain.credits.length, next: null,
    })),
    vouchesByTarget: () => answer('vouchesByTarget', undefined, () => ({ vouches: [], count: 0, next: null })),
    vouchesByVoucher: (key) => answer('vouchesByVoucher', key, () => ({
      vouches: chain.vouchTargets.map((t) => ({
        boxId: 'f0'.repeat(32), value: '1', createdAtBlock: 1000, voucherId: ME, targetId: t, voucherName: null, targetName: null,
      })),
      count: chain.vouchTargets.length,
      next: null,
    })),
    vouchCooldowns: (key) => answer('vouchCooldowns', key, () => ({ cooldowns: [], count: 0, next: null })),
    bonds: (key) => answer('bonds', key, () => ({ bonds: [], bondCount: 0, next: null })),
    usernameByOwner: (key) => answer('usernameByOwner', key, () => null),
    usernameByName: () => answer('usernameByName', undefined, () => null),
  };
  return {
    api, calls, held,
    setHold(p: (method: string) => boolean): void { hold = p; },
    setFail(p: (method: string) => boolean): void { fail = p; },
    count: (method: string): number => calls.filter((c) => c.method === method).length,
  };
}

function identity(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: ME, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  };
}

interface FigureCall { listing: Listing; anchor: Anchor; resolve(r: FiguresResult): void }
interface TipCall { resolve(v: { verdict: TipVerdict; anchor: Anchor | null }): void }

interface Drive {
  loadMembershipState(): Promise<void>;
  refreshProfileKarma(): Promise<void>;
  refreshWalletCredits(): Promise<void>;
  closeWindow(id: string): void;
  pollTick(): Promise<void>;
  profileKarma: KarmaResult | null;
  figures: unknown;
}

interface Harness {
  node: ReturnType<typeof fakeNode>;
  chain: Chain;
  ledger: PendingLedger;
  drive: Drive;
  figuresCalls: FigureCall[];
  tipCalls: TipCall[];
}

function harness(opts: { layout?: string; verifiers?: boolean; entries?: Array<{ kind: EntryKind; postId: string }> } = {}): Harness {
  const chain: Chain = {
    height: 1070,
    karma: [{ boxId: K1, value: '219' }],
    effective: '219',
    credits: [{ boxId: C1, value: '1250000000' }],
    posts: new Map(),
    vouchTargets: [],
  };
  const node = fakeNode(chain);
  const ledger = new PendingLedger(ME);
  for (const [i, e] of (opts.entries ?? []).entries()) {
    ledger.add({
      txId: (i + 1).toString(16).padStart(2, '0').repeat(32), kind: e.kind, postId: e.postId,
      inputs: [], expiresAtHeight: 5000, submittedAtHeight: 1060,
    });
  }
  const figuresCalls: FigureCall[] = [];
  const tipCalls: TipCall[] = [];
  const figuresVerifier: FiguresVerifier = {
    run: (_base, _user, listing, anchor) => new Promise<FiguresResult>((resolve) => {
      figuresCalls.push({ listing, anchor, resolve });
    }),
  };
  const tipVerifier: TipVerifier = {
    run: () => new Promise((resolve) => { tipCalls.push({ resolve }); }),
  };
  if (opts.layout) localStorage.setItem(KEY_LAYOUT, opts.layout);
  const app = new App(
    node.api, {} as unknown as WriteClient, identity(), ledger, undefined, undefined,
    opts.verifiers ? tipVerifier : null, opts.verifiers ? figuresVerifier : null,
  );
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);
  return { node, chain, ledger, drive: app as unknown as Drive, figuresCalls, tipCalls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const repNumber = (): string | null => document.querySelector('.karma-field .mono')?.textContent ?? null;
const repHint = (): HTMLElement | null => document.querySelector<HTMLElement>('.karma-field .hint');
const gold = (): HTMLElement | null => document.querySelector<HTMLElement>('.credits-line .mono.gold');
const balanceHint = (): HTMLElement | null => document.querySelector<HTMLElement>('.credits-line .hint');

function fakeHeader(height: number): BlockHeader {
  return {
    protocolVersion: 1, height, prevBlockHash: '00'.repeat(32), utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(32), validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 0x1d00ffff,
    createdAt: 0, interlinkRoot: '00'.repeat(32),
  };
}
const anchorAt = (height: number): Anchor => ({
  tip: fakeHeader(height),
  suffixHead: { header: fakeHeader(height - 19), interlinks: [] },
});
const verified = (height: number): { verdict: TipVerdict; anchor: Anchor } => ({
  verdict: { kind: 'verified', nodes: 2, height },
  anchor: anchorAt(height),
});
function emptyResult(): FiguresResult {
  return {
    boxes: [], record: { status: 'absent' },
    karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: 0n },
    credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n },
    heightAfter: 0, failed: false,
  };
}
const karmaIds = (c: FigureCall): string[] => c.listing.karma.boxes.map((b) => b.boxId);
const creditIds = (c: FigureCall): string[] => c.listing.credits.boxes.map((b) => b.boxId);

function confirmed(id: string, over: Partial<PostResult> = {}): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: ME, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 1081, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: ME,
    ...over,
  } as PostResult;
}
function withdrawn(id: string): PostResult {
  return {
    kind: 'withdrawn', id, author: ME, withdrawnAtHeight: 1081, parentRefs: [], descendantCount: 0,
    authorName: null, confirmedAuthor: ME,
  };
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});

// ---------------------------------------------------------------------------
// The stamp and the verified tip's reads
// ---------------------------------------------------------------------------

describe('a figures run proves a listing read after its anchor, and never one read before it', () => {
  it('step 24: a post spends the listed box, a newer anchor lands above the spend — the run proves the listing read after it, never the stale one', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', verifiers: true, entries: [{ kind: 'post', postId: P }] });
    await h.drive.loadMembershipState();
    await flush();
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    expect(h.figuresCalls).toHaveLength(1);
    expect(karmaIds(h.figuresCalls[0]!)).toEqual([K1]);
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();

    // The post lands at 1081, spending K1; the landing re-reads the listing.
    h.chain.posts.set(P, confirmed(P));
    h.chain.karma = [{ boxId: K2, value: '214' }];
    h.chain.effective = '214';
    h.chain.height = 1081;
    await h.drive.pollTick();
    await flush();
    expect(repNumber()).toBe('214');
    expect(karmaIds(h.figuresCalls[h.figuresCalls.length - 1]!)).toEqual([K2]);
    for (const c of h.figuresCalls) c.resolve(emptyResult());
    await flush();

    // A newer anchor above the spend — a press of the corner runs the tip
    // again — and the tip's trigger reads /karma first.
    h.chain.height = 1104;
    document.querySelector<HTMLButtonElement>('button.corner')!.click();
    await flush();
    expect(h.tipCalls).toHaveLength(2);
    const runsBefore = h.figuresCalls.length;
    const readsBefore = h.node.count('karma');
    h.tipCalls[1]!.resolve(verified(1104));
    // Nothing is proven before the read answers.
    expect(h.figuresCalls).toHaveLength(runsBefore);
    await flush();
    expect(h.node.count('karma')).toBe(readsBefore + 1);
    const after = h.figuresCalls.slice(runsBefore);
    expect(after).toHaveLength(1);
    expect(after[0]!.anchor.tip.height).toBe(1104);
    expect(karmaIds(after[0]!)).toEqual([K2]);
    expect(h.figuresCalls.some((c) => c.anchor.tip.height === 1104 && karmaIds(c).includes(K1))).toBe(false);
  });

  it('a listing whose stamp predates the anchor is never passed to a run — the tip\'s own read failing, no trigger proves it', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile|@wallet', verifiers: true });
    await h.drive.loadMembershipState();
    await flush();
    h.node.setFail((m) => m === 'karma');
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    // The tip's /karma read failed: the held listing was read before the anchor.
    expect(h.figuresCalls).toHaveLength(0);
    // A later trigger — the wallet's ↻ — still proves nothing against it.
    await h.drive.refreshWalletCredits();
    await flush();
    expect(h.figuresCalls).toHaveLength(0);
  });

  it('a read that begins before an anchor and ends after it carries the older stamp — its listing is not proven', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', verifiers: true });
    await h.drive.loadMembershipState();
    await flush();
    // A profile ↻ begins before the anchor and is held past it.
    h.node.setHold((m) => m === 'karma');
    const early = h.drive.refreshProfileKarma();
    await flush();
    expect(h.node.held).toHaveLength(1);
    // The anchor lands; its own /karma read fails, so the early read is the
    // one that answers after the anchor.
    h.node.setHold(() => false);
    h.node.setFail((m) => m === 'karma');
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    h.chain.effective = '218';
    h.node.held[0]!.release();
    await early;
    await flush();
    expect(repNumber()).toBe('218');
    expect(h.figuresCalls).toHaveLength(0);
  });

  it('the wallet closed, a verified tip reads /karma alone and passes the credits listing empty', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile|@wallet', verifiers: true });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    h.drive.closeWindow('@wallet');
    await flush();
    const creditsBefore = h.node.count('credits');
    const karmaBefore = h.node.count('karma');
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    expect(h.node.count('karma')).toBe(karmaBefore + 1);
    expect(h.node.count('credits')).toBe(creditsBefore);
    expect(h.figuresCalls).toHaveLength(1);
    expect(creditIds(h.figuresCalls[0]!)).toEqual([]);
  });

  it('the wallet open, a verified tip reads /credits too: the karma write runs with credits empty, the credits write marks exactly one more run with both', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile|@wallet', verifiers: true });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    const creditsBefore = h.node.count('credits');
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    expect(h.node.count('credits')).toBe(creditsBefore + 1);
    expect(h.figuresCalls).toHaveLength(1);
    expect(creditIds(h.figuresCalls[0]!)).toEqual([]);

    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.figuresCalls).toHaveLength(2);
    expect(karmaIds(h.figuresCalls[1]!)).toEqual([K1]);
    expect(creditIds(h.figuresCalls[1]!)).toEqual([C1]);
    // The first result was for a listing that moved; it never showed.
    expect(h.drive.figures).toBeNull();

    h.figuresCalls[1]!.resolve(emptyResult());
    await flush();
    expect(h.figuresCalls).toHaveLength(2);
    expect(h.drive.figures).not.toBeNull();
  });

  it('the wallet open and its /credits re-read failing: the balance reads muted *not checked yet* while the rep row reads its own result', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile|@wallet', verifiers: true });
    h.chain.karma = [{ boxId: K2, value: '209' }, { boxId: K3, value: '5' }];
    h.chain.effective = '214';
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(gold()?.textContent).toBe('12.5');

    h.node.setFail((m) => m === 'credits');
    h.tipCalls[0]!.resolve(verified(1104));
    await flush();
    expect(h.figuresCalls).toHaveLength(1);
    expect(creditIds(h.figuresCalls[0]!)).toEqual([]);
    h.figuresCalls[0]!.resolve({
      ...emptyResult(),
      record: { status: 'absent' },
      boxes: [
        { boxId: K2, boxClass: 'karma', value: 209n, lockedUntilBlock: null, status: 'proven', verdict: '' },
        { boxId: K3, boxClass: 'karma', value: 5n, lockedUntilBlock: null, status: 'young', verdict: '' },
      ],
      karma: { proven: 209n, young: 5n, unchecked: 0n, absent: 0n, effective: 209n },
      heightAfter: 1104,
    });
    await flush();

    expect(balanceHint()?.textContent).toBe('not checked yet');
    expect(balanceHint()?.classList.contains('clay')).toBe(false);
    expect(gold()?.classList.contains('clay')).toBe(false);
    expect(gold()?.textContent).toBe('12.5');
    expect(repHint()?.textContent).toBe('209 rep proven at block 1085 · 5 rep landed since');
  });
});

// ---------------------------------------------------------------------------
// The landings
// ---------------------------------------------------------------------------

describe('every landing of the reader\'s own transaction re-reads the listing it changed', () => {
  const landings: Array<{ kind: EntryKind; postId: string; land(chain: Chain): void }> = [
    { kind: 'post', postId: P, land: (c) => { c.posts.set(P, confirmed(P)); } },
    { kind: 'like', postId: L, land: (c) => { c.posts.set(L, confirmed(L, { author: X, confirmedAuthor: X, likedByViewer: true })); } },
    { kind: 'vouch', postId: X, land: (c) => { c.vouchTargets = [X]; } },
    { kind: 'withdraw', postId: W, land: (c) => { c.posts.set(W, withdrawn(W)); } },
  ];

  for (const l of landings) {
    it(`a ${l.kind}'s landing re-reads /karma and the rep row shows the node's new number — in the web build too`, async () => {
      setNode(NODE);
      const h = harness({ layout: '@profile', entries: [{ kind: l.kind, postId: l.postId }] });
      await h.drive.loadMembershipState();
      await flush();
      expect(repNumber()).toBe('219');

      l.land(h.chain);
      h.chain.karma = [{ boxId: K2, value: '218' }];
      h.chain.effective = '218';
      h.chain.height = 1081;
      const before = h.node.count('karma');
      await h.drive.pollTick();
      await flush();
      expect(h.ledger.size).toBe(0);
      expect(h.node.count('karma')).toBe(before + 1);
      expect(repNumber()).toBe('218');
      expect(h.drive.profileKarma?.boxes.map((b) => b.boxId)).toEqual([K2]);
    });
  }

  it('several landings in one tick re-read /karma once', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: landings.map((l) => ({ kind: l.kind, postId: l.postId })) });
    await h.drive.loadMembershipState();
    await flush();
    for (const l of landings) l.land(h.chain);
    h.chain.karma = [{ boxId: K2, value: '211' }];
    h.chain.effective = '211';
    h.chain.height = 1081;
    const before = h.node.count('karma');
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(h.node.count('karma')).toBe(before + 1);
    expect(repNumber()).toBe('211');
  });

  it('a faucet grant is decided on the same read: a grant and a post landing in one tick read /karma once', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'grant', postId: ME }, { kind: 'post', postId: P }] });
    h.chain.karma = [];
    h.chain.effective = '0';
    await h.drive.loadMembershipState();
    await flush();
    h.chain.posts.set(P, confirmed(P));
    h.chain.karma = [{ boxId: K2, value: '250' }];
    h.chain.effective = '250';
    h.chain.height = 1081;
    const before = h.node.count('karma');
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(h.node.count('karma')).toBe(before + 1);
    expect(repNumber()).toBe('250');
  });

  it('a pending entry that has not landed reads no listing', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'post', postId: P }] });
    await h.drive.loadMembershipState();
    await flush();
    h.chain.posts.set(P, confirmed(P, { status: 'pending', blockHeight: null }));
    h.chain.height = 1081;
    const before = h.node.count('karma');
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(1);
    expect(h.node.count('karma')).toBe(before);
  });

  it('a send\'s landing and a credits grant\'s in one tick read the reader\'s /credits once, the wallet closed', async () => {
    setNode(NODE);
    const h = harness({ entries: [] });
    h.ledger.add({
      txId: 'e1'.repeat(32), kind: 'send', postId: X, inputs: [C1], expiresAtHeight: 5000, submittedAtHeight: 1060,
      send: { toHex: X, toName: null, amount: 100000000n, boxId: 'e2'.repeat(32) },
    });
    h.ledger.add({ txId: 'e3'.repeat(32), kind: 'creditGrant', postId: C2, inputs: [], expiresAtHeight: 5000, submittedAtHeight: 1060 });
    // The recipient lists the payment; the reader's own listing holds the change and the grant.
    const recipient = { boxId: 'e2'.repeat(32), value: '100000000' };
    const api = h.node.api as { credits: Api['credits'] };
    const own = api.credits;
    api.credits = (key, page) => (key === X
      ? Promise.resolve({ userId: X, total: '100000000', boxes: [recipient], boxCount: 1, next: null })
      : own(key, page));
    h.chain.credits = [{ boxId: 'e4'.repeat(32), value: '1150000000' }, { boxId: C2, value: '10000000000' }];
    h.chain.height = 1081;
    const before = h.node.calls.filter((c) => c.method === 'credits' && c.key === ME).length;
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(h.node.calls.filter((c) => c.method === 'credits' && c.key === ME).length).toBe(before + 1);
  });
});
