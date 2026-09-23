// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, FiguresVerifier, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { CreditsResult, FeedResult, KarmaResult, StatusResult, UsernameResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { prefs, setNode, KEY_LAYOUT } from '../src/prefs';
import type { Anchor, FiguresResult, Listing } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import type { TipVerdict } from '../src/model/tip-verdict';

// A change of the reading node drops the reader's own state and reads it again
// from the new node (WEB_INTERFACE → The settings window, → The status corner),
// as an identity change does for the new key (→ The identity module): the rows
// read `—` while the reads are in flight and never the node before's figure; a
// read in flight for the node or the key before writes nothing when it answers;
// the tip the escrow gate reads is the new node's; the seed adoption drops and
// re-reads as the settings row does; open author windows are read again; a
// figures run in flight across either change never keeps the next one from
// starting. The fake API answers by the base `prefs.node` names as each read
// begins, so a read held across a change answers for the node it was sent to.

const ME = 'aa'.repeat(32);
const ME2 = 'ab'.repeat(32);
const X = 'cd'.repeat(32);
const A = 'https://a.example';
const B = 'https://b.example';

/** One node's answers for everything the reader's own state reads. */
interface NodeAnswers {
  height: number;
  effective: string;
  karmaBox: string;
  credits: string;
  creditBox: string;
  releaseAtBlock: number | null;
  name: string | null;
  endorsers: number;
}

const NODE_A: NodeAnswers = {
  height: 510, effective: '219', karmaBox: '1a'.repeat(32), credits: '1250000000', creditBox: '2a'.repeat(32),
  releaseAtBlock: null, name: 'Alice', endorsers: 3,
};
const NODE_B: NodeAnswers = {
  height: 495, effective: '100', karmaBox: '1b'.repeat(32), credits: '700000000', creditBox: '2b'.repeat(32),
  releaseAtBlock: null, name: null, endorsers: 7,
};

function statusAt(height: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight: height, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000', membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
  };
}

interface Call { method: string; base: string; key: string | undefined }
interface Held { method: string; base: string; key: string | undefined; release(): void }
type Pick3 = (method: string, base: string, key: string | undefined) => boolean;

/** The API over several nodes, keyed by the base a read begins under. A read the
 *  `hold` predicate names waits for its `release`, answering then for the node
 *  it was sent to; one the `fail` predicate names rejects. */
function fakeNodes(nodes: Record<string, NodeAnswers>, base: () => string) {
  const calls: Call[] = [];
  const held: Held[] = [];
  let hold: Pick3 = () => false;
  let fail: Pick3 = () => false;
  function answer<T>(method: string, key: string | undefined, make: (n: NodeAnswers) => T): Promise<T> {
    const at = base();
    calls.push({ method, base: at, key });
    const n = nodes[at];
    if (n === undefined || fail(method, at, key)) return Promise.reject(new Error(`${method} at ${at} failed`));
    if (!hold(method, at, key)) return Promise.resolve(make(n));
    return new Promise<T>((resolve) => {
      held.push({ method, base: at, key, release: () => resolve(make(n)) });
    });
  }
  const api: Api = {
    feed: (_page, _viewer, author) => answer('feed', author, (): FeedResult => ({ posts: [], next: null, pending: [], pendingCount: 0 })),
    thread: () => answer('thread', undefined, () => null),
    post: (id) => answer('post', id, () => null),
    status: () => answer('status', undefined, (n) => statusAt(n.height)),
    currentBlock: () => answer('currentBlock', undefined, (n) => ({ height: n.height, hash: null })),
    karma: (key) => answer('karma', key, (n): KarmaResult => karmaResult({
      userId: key, total: n.effective, effective: n.effective, boxes: [{ boxId: n.karmaBox, value: n.effective }],
      boxCount: 1, height: n.height, member: true, memberSinceBlock: 5, invitesAvailable: 2,
    })),
    credits: (key) => answer('credits', key, (n): CreditsResult => ({
      userId: key, total: n.credits, boxes: [{ boxId: n.creditBox, value: n.credits }], boxCount: 1, next: null,
    })),
    vouchesByTarget: (key) => answer('vouchesByTarget', key, (n) => ({ vouches: [], count: n.endorsers, next: null })),
    vouchesByVoucher: (key) => answer('vouchesByVoucher', key, () => ({ vouches: [], count: 0, next: null })),
    vouchCooldowns: (key) => answer('vouchCooldowns', key, (n) => ({
      cooldowns: n.releaseAtBlock === null ? [] : [{ boxId: 'e1'.repeat(32), value: '1', releaseAtBlock: n.releaseAtBlock }],
      count: n.releaseAtBlock === null ? 0 : 1,
      next: null,
    })),
    bonds: (key) => answer('bonds', key, () => ({ bonds: [], bondCount: 0, next: null })),
    usernameByOwner: (key) => answer('usernameByOwner', key, (n): UsernameResult | null => (
      n.name !== null && key === ME ? { name: n.name, owner: key, boxId: '55'.repeat(32), claimedAtBlock: 1 } : null
    )),
    usernameByName: () => answer('usernameByName', undefined, () => null),
  };
  return {
    api, calls, held,
    setHold(p: Pick3): void { hold = p; },
    setFail(p: Pick3): void { fail = p; },
  };
}

type FakeNodes = ReturnType<typeof fakeNodes>;

interface Keyed {
  identity: AppIdentity;
  setKey(key: string | null): void;
}

/** An identity module whose key the test moves; a move fires onChange as the
 *  real module's create, import and forget do. */
function keyed(start: string | null): Keyed {
  let key = start;
  const listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];
  const identity: AppIdentity = {
    current: () => (key === null ? null : { pubKeyHex: key, locked: false }),
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
    onChange: (l) => { listeners.push(l); },
  };
  return {
    identity,
    setKey(k) {
      key = k;
      for (const l of listeners) l(k === null ? null : { pubKeyHex: k });
    },
  };
}

interface FigureCall {
  readingBase: string;
  user: string;
  listing: Listing;
  anchor: Anchor;
  resolve(r: FiguresResult): void;
}
interface TipCall {
  readingBase: string;
  resolve(v: { verdict: TipVerdict; anchor: Anchor | null }): void;
}

interface Drive {
  changeNode(origin: string): Promise<void>;
  loadMembershipState(): Promise<void>;
  refreshProfileKarma(): Promise<void>;
  refreshWalletCredits(): Promise<void>;
  refreshAuthor(key: string): Promise<void>;
  openAuthor(key: string, origin: { from: 'feed' }): void;
  openAuthorPosts(key: string, origin: { from: 'feed' }): void;
  profileKarma: KarmaResult | null;
  walletCredits: CreditsResult | null;
  viewerTip: number;
  figures: unknown;
  figuresInFlight: boolean;
  state: { status: StatusResult | null };
}

interface Harness {
  app: App;
  nodes: FakeNodes;
  drive: Drive;
  appbar: HTMLElement;
  setKey(key: string | null): void;
  figuresCalls: FigureCall[];
  tipCalls: TipCall[];
}

/** Mount the shell and the App — `boot` runs `start`, the page's own boot,
 *  where the default mounts alone. */
function mountApp(app: App, boot = false): HTMLElement {
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  if (boot) app.start(appbar, feed, panes);
  else app.mount(appbar, feed, panes);
  return appbar;
}

function harness(opts: {
  layout?: string;
  a?: Partial<NodeAnswers>;
  b?: Partial<NodeAnswers>;
  verifiers?: boolean;
  boot?: boolean;
} = {}): Harness {
  const nodes = fakeNodes({ [A]: { ...NODE_A, ...opts.a }, [B]: { ...NODE_B, ...opts.b } }, () => prefs.node);
  const id = keyed(ME);
  const figuresCalls: FigureCall[] = [];
  const tipCalls: TipCall[] = [];
  const figuresVerifier: FiguresVerifier = {
    run: (readingBase, user, listing, anchor) => new Promise<FiguresResult>((resolve) => {
      figuresCalls.push({ readingBase, user, listing, anchor, resolve });
    }),
  };
  const tipVerifier: TipVerifier = {
    run: (readingBase) => new Promise((resolve) => { tipCalls.push({ readingBase, resolve }); }),
  };
  if (opts.layout) localStorage.setItem(KEY_LAYOUT, opts.layout);
  const app = new App(
    nodes.api, {} as unknown as WriteClient, id.identity, new PendingLedger(ME), undefined, undefined,
    opts.verifiers ? tipVerifier : null, opts.verifiers ? figuresVerifier : null,
  );
  const appbar = mountApp(app, opts.boot);
  return { app, nodes, drive: app as unknown as Drive, appbar, setKey: id.setKey, figuresCalls, tipCalls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const repField = (): HTMLElement | null => document.querySelector<HTMLElement>('.karma-field');
const repNumber = (): string | null => document.querySelector('.karma-field .mono')?.textContent ?? null;
const balanceLine = (): HTMLElement | null => document.querySelector<HTMLElement>('.credits-line');
const gold = (): string | null => document.querySelector('.credits-line .mono.gold')?.textContent ?? null;
const headerProfile = (h: Harness): string | null =>
  h.appbar.querySelector('button[aria-label="open profile"]')?.textContent ?? null;
const rowText = (label: string): string | null => {
  const r = [...document.querySelectorAll('.winbody .row')].find((x) => x.querySelector('label')?.textContent === label);
  return r?.textContent ?? null;
};

function fakeHeader(height: number, tag: string): BlockHeader {
  return {
    protocolVersion: 1, height, prevBlockHash: '00'.repeat(32), utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + tag, validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 0x1d00ffff,
    createdAt: 0, interlinkRoot: '00'.repeat(32),
  };
}
const anchorAt = (height: number, tag: string): Anchor => ({
  tip: fakeHeader(height, tag),
  suffixHead: { header: fakeHeader(height - 19, tag), interlinks: [] },
});
const verified = (height: number): TipVerdict => ({ kind: 'verified', nodes: 2, height });
function emptyResult(): FiguresResult {
  return {
    boxes: [], record: { status: 'absent' },
    karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: 0n },
    credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n },
    heightAfter: 0, failed: false,
  };
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  setNode('');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The settings row's change
// ---------------------------------------------------------------------------

describe('a node change — the reader\'s own state drops and is read from the new node', () => {
  it('the settings row\'s change re-reads the membership state and, the wallet open, the wallet from the new node; the rows render its figures', async () => {
    setNode(A);
    const h = harness({ layout: '@profile|@wallet' });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(repNumber()).toBe('219');
    expect(gold()).toBe('12.5');

    const before = h.nodes.calls.length;
    await h.drive.changeNode(B);
    await flush();

    const own = h.nodes.calls.slice(before).filter((c) => c.key === ME && c.method !== 'feed');
    expect(own.map((c) => c.method).sort()).toEqual(
      ['bonds', 'credits', 'karma', 'usernameByOwner', 'vouchCooldowns', 'vouchesByVoucher'],
    );
    expect(own.every((c) => c.base === B)).toBe(true);
    expect(h.nodes.calls.slice(before).some((c) => c.method === 'status' && c.base === B)).toBe(true);
    expect(repNumber()).toBe('100');
    expect(gold()).toBe('7');
    expect(h.drive.profileKarma?.effective).toBe('100');
    expect(h.drive.state.status?.blockHeight).toBe(495);
  });

  it('the wallet closed, a node change reads no /credits', async () => {
    setNode(A);
    const h = harness({ layout: '@profile' });
    await h.drive.loadMembershipState();
    await flush();
    const before = h.nodes.calls.length;
    await h.drive.changeNode(B);
    await flush();
    expect(h.nodes.calls.slice(before).some((c) => c.method === 'credits')).toBe(false);
    expect(repNumber()).toBe('100');
  });

  it('between the drop and the new node\'s answers the rep and balance rows read —, never the node before\'s figure', async () => {
    setNode(A);
    const h = harness({ layout: '@profile|@wallet' });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(repNumber()).toBe('219');
    expect(gold()).toBe('12.5');
    expect(headerProfile(h)).toBe('@Alice');

    h.nodes.setHold((method, base) => base === B && (method === 'karma' || method === 'credits'));
    void h.drive.changeNode(B);
    await flush();
    expect(repField()?.textContent).toBe('—');
    expect(balanceLine()?.textContent).toBe('—');
    expect(repNumber()).toBeNull();
    expect(gold()).toBeNull();
    // The node before's name is gone from the header with everything else loaded.
    expect(headerProfile(h)).toBe(ME.slice(0, 16) + '…');

    for (const x of h.nodes.held) x.release();
    await flush();
    expect(repNumber()).toBe('100');
    expect(gold()).toBe('7');
  });

  it('a membership read in flight for the node before, answering after the change, writes nothing', async () => {
    setNode(A);
    const h = harness({ layout: '@profile' });
    await h.drive.loadMembershipState();
    await flush();
    h.nodes.setHold((method, base) => base === A && method === 'karma');
    const stale = h.drive.refreshProfileKarma();
    await flush();
    expect(h.nodes.held).toHaveLength(1);

    await h.drive.changeNode(B);
    await flush();
    expect(repNumber()).toBe('100');

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(repNumber()).toBe('100');
    expect(h.drive.profileKarma?.effective).toBe('100');
    expect(h.drive.state.status?.blockHeight).toBe(495);
    // The late answer's heights never reach the gates' tip either.
    expect(h.drive.viewerTip).toBe(495);
  });

  it('a wallet read in flight for the node before, answering after the change, writes nothing', async () => {
    setNode(A);
    const h = harness({ layout: '@wallet' });
    await h.drive.refreshWalletCredits();
    await flush();
    expect(gold()).toBe('12.5');
    h.nodes.setHold((method, base) => base === A && method === 'credits');
    const stale = h.drive.refreshWalletCredits();
    await flush();

    await h.drive.changeNode(B);
    await flush();
    expect(gold()).toBe('7');

    h.nodes.held[0]!.release();
    await stale;
    await flush();
    expect(gold()).toBe('7');
    expect(h.drive.walletCredits?.boxes[0]?.boxId).toBe(NODE_B.creditBox);
  });

  it('the race is shared: reads in flight for the key before, answering after an identity change, write nothing', async () => {
    setNode(A);
    const h = harness({ layout: '@profile|@wallet' });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    h.nodes.setHold((method, _base, key) => key === ME && (method === 'karma' || method === 'credits'));
    const staleKarma = h.drive.refreshProfileKarma();
    const staleCredits = h.drive.refreshWalletCredits();
    await flush();
    expect(h.nodes.held).toHaveLength(2);

    h.setKey(ME2);
    await flush();
    expect(h.drive.profileKarma?.userId).toBe(ME2);
    expect(h.drive.walletCredits?.userId).toBe(ME2);

    for (const x of h.nodes.held) x.release();
    await staleKarma;
    await staleCredits;
    await flush();
    expect(h.drive.profileKarma?.userId).toBe(ME2);
    expect(h.drive.walletCredits?.userId).toBe(ME2);
  });

  it('VT-1: the escrow gate judges against the new node\'s tip — a stake held until 500, the node before at 510, the new one at 495, reads held', async () => {
    setNode(A);
    const h = harness({ a: { releaseAtBlock: 500 }, b: { releaseAtBlock: 500 } });
    h.drive.openAuthor(X, { from: 'feed' });
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.viewerTip).toBe(510);
    // The node before is past the release: the row offers the vouch.
    expect(rowText('your vouch')).toContain('vouch');
    expect(rowText('your vouch')).not.toContain('held until');

    await h.drive.changeNode(B);
    await flush();
    expect(h.drive.viewerTip).toBe(495);
    expect(rowText('your vouch')).toContain('your stake from an unvouch is held until block 500');
  });
});

// ---------------------------------------------------------------------------
// The seed adoption — through the real seed-list walk
// ---------------------------------------------------------------------------

describe('a window restored at boot has opened, and reads as a press opens it', () => {
  it('a restored @wallet reads its balance at start with no press', async () => {
    setNode(A);
    const h = harness({ layout: '@wallet', boot: true });
    await flush();
    expect(h.nodes.calls.some((c) => c.method === 'credits' && c.key === ME && c.base === A)).toBe(true);
    expect(gold()).toBe('12.5');
  });
});

describe('the seed adoption drops and re-reads as the settings row does', () => {
  it('a boot whose first seed does not answer the feed adopts the next, and every reader row is the adopted node\'s', async () => {
    // The seed list is a build value read at import, so the modules load
    // fresh under the shell's `notis-nodes` (WEB_INTERFACE → "The client is
    // served from the node's own origin").
    vi.resetModules();
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'notis-nodes');
    meta.setAttribute('content', JSON.stringify([A, B]));
    document.head.appendChild(meta);
    localStorage.setItem(KEY_LAYOUT, '@profile|@wallet');
    const fresh = await import('../src/prefs');
    const { App: FreshApp } = await import('../src/app');
    expect(fresh.prefs.node).toBe(A);

    const nodes = fakeNodes({ [A]: { ...NODE_A }, [B]: { ...NODE_B } }, () => fresh.prefs.node);
    // The first seed answers every read but the feed, and holds its /karma so
    // the membership read the boot sends it is still in flight at the adoption.
    nodes.setFail((method, base) => base === A && method === 'feed');
    nodes.setHold((method, base) => base === A && method === 'karma');
    // The walk probes each seed through its own client — the browser's fetch.
    const probed: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      probed.push(url);
      const ok = url.startsWith(B + '/');
      return {
        ok, status: ok ? 200 : 503, statusText: ok ? 'OK' : 'Service Unavailable',
        json: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
      };
    }));

    const id = keyed(ME);
    const app = new FreshApp(nodes.api, {} as unknown as WriteClient, id.identity, new PendingLedger(ME));
    const appbar = document.createElement('header');
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    const workspace = document.createElement('div'); workspace.className = 'workspace';
    workspace.append(feed, panes);
    document.body.append(appbar, workspace);
    app.start(appbar, feed, panes);
    await flush();
    await flush();

    expect(fresh.prefs.node).toBe(B);
    expect(probed.some((u) => u.startsWith(B + '/posts'))).toBe(true);
    expect(repNumber()).toBe('100');
    expect(gold()).toBe('7');

    // The first seed's membership read answers now: it writes nothing.
    expect(nodes.held.some((x) => x.base === A)).toBe(true);
    for (const x of nodes.held) x.release();
    await flush();
    expect(repNumber()).toBe('100');
    expect(gold()).toBe('7');
    const drive = app as unknown as Drive;
    expect(drive.profileKarma?.effective).toBe('100');
    expect(drive.state.status?.blockHeight).toBe(495);
  });
});

// ---------------------------------------------------------------------------
// The author windows — read again after either change
// ---------------------------------------------------------------------------

describe('open author windows are read again after an identity or node change', () => {
  it('an identity change re-reads an open author window, whose ↻ still reads', async () => {
    setNode(A);
    const h = harness();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    expect(rowText('endorsers')).toContain('3 vouches');

    h.setKey(ME2);
    await flush();
    expect(rowText('endorsers')).toContain('3 vouches');
    expect(rowText('name')).toContain('no name');

    const reads = h.nodes.calls.filter((c) => c.method === 'vouchesByTarget').length;
    await h.drive.refreshAuthor(X);
    await flush();
    expect(h.nodes.calls.filter((c) => c.method === 'vouchesByTarget').length).toBe(reads + 1);
  });

  it('an identity change re-reads an open author-posts window with the new viewer', async () => {
    setNode(A);
    const h = harness();
    h.drive.openAuthorPosts(X, { from: 'feed' });
    await flush();
    const before = h.nodes.calls.length;
    h.setKey(ME2);
    await flush();
    expect(h.nodes.calls.slice(before).some((c) => c.method === 'feed' && c.key === X)).toBe(true);
    expect(document.querySelector('.author-posts')?.textContent).toBe('no posts yet');
  });

  it('a node change re-reads an open author window from the new node', async () => {
    setNode(A);
    const h = harness();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    expect(rowText('endorsers')).toContain('3 vouches');

    const before = h.nodes.calls.length;
    await h.drive.changeNode(B);
    await flush();
    const reads = h.nodes.calls.slice(before).filter((c) => c.method === 'vouchesByTarget');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.base === B)).toBe(true);
    expect(rowText('endorsers')).toContain('7 vouches');
  });
});

// ---------------------------------------------------------------------------
// The verified figures across a change (WEB_INTERFACE → The extension → "The
// verified figures")
// ---------------------------------------------------------------------------

describe('the verified figures across a node or identity change', () => {
  it('after a node change with the wallet open, every figures run proves the new node\'s listings, never the node before\'s', async () => {
    setNode(A);
    const h = harness({ layout: '@profile|@wallet', verifiers: true });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    h.tipCalls[0]!.resolve({ verdict: verified(510), anchor: anchorAt(510, 'aa') });
    await flush();
    for (const c of [...h.figuresCalls]) c.resolve(emptyResult());
    await flush();
    for (const c of [...h.figuresCalls]) c.resolve(emptyResult());
    await flush();
    const before = h.figuresCalls.length;
    expect(before).toBeGreaterThan(0);

    await h.drive.changeNode(B);
    await flush();
    const tipB = h.tipCalls[h.tipCalls.length - 1]!;
    expect(tipB.readingBase).toBe(B);
    tipB.resolve({ verdict: verified(495), anchor: anchorAt(495, 'bb') });
    await flush();
    for (const c of h.figuresCalls.slice(before)) c.resolve(emptyResult());
    await flush();

    const runs = h.figuresCalls.slice(before);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r.readingBase).toBe(B);
      expect(r.listing.karma.boxes.map((b) => b.boxId)).toEqual([NODE_B.karmaBox]);
      expect(r.listing.credits.boxes.every((b) => b.boxId === NODE_B.creditBox)).toBe(true);
    }
    expect(runs[runs.length - 1]!.listing.credits.boxes.map((b) => b.boxId)).toEqual([NODE_B.creditBox]);
  });

  it('a node change landing mid-run: the next verified tip still starts a run, and the stale run touches nothing', async () => {
    setNode(A);
    const h = harness({ layout: '@profile', verifiers: true });
    await h.drive.loadMembershipState();
    await flush();
    h.tipCalls[0]!.resolve({ verdict: verified(510), anchor: anchorAt(510, 'aa') });
    await flush();
    expect(h.figuresCalls).toHaveLength(1);
    expect(h.drive.figuresInFlight).toBe(true);

    await h.drive.changeNode(B);
    await flush();
    expect(h.drive.figuresInFlight).toBe(false);
    h.tipCalls[h.tipCalls.length - 1]!.resolve({ verdict: verified(495), anchor: anchorAt(495, 'bb') });
    await flush();
    expect(h.figuresCalls).toHaveLength(2);
    expect(h.figuresCalls[1]!.readingBase).toBe(B);

    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.drive.figures).toBeNull();
    expect(h.drive.figuresInFlight).toBe(true);
  });

  it('an identity change landing mid-run: the new key\'s listing still starts a run', async () => {
    setNode(A);
    const h = harness({ layout: '@profile', verifiers: true });
    await h.drive.loadMembershipState();
    await flush();
    h.tipCalls[0]!.resolve({ verdict: verified(510), anchor: anchorAt(510, 'aa') });
    await flush();
    expect(h.figuresCalls).toHaveLength(1);

    h.setKey(ME2);
    await flush();
    expect(h.figuresCalls).toHaveLength(2);
    expect(h.figuresCalls[1]!.user).toBe(ME2);

    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.drive.figures).toBeNull();
    expect(h.drive.figuresInFlight).toBe(true);
  });
});
