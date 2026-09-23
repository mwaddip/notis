// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, AppState, FiguresVerifier, TipVerifier } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BondsResult, CreditsResult, KarmaResult, PostResult, StatusResult } from '../src/api/dto';
import type { EntryKind } from '../src/wallet/types';
import { karmaResult } from './karma-fixture';
import { prefs, setNode, KEY_LAYOUT } from '../src/prefs';
import type { Anchor, FiguresResult, Listing } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import type { TipVerdict } from '../src/model/tip-verdict';

// The newest read of each piece of the reader's own state wins, whichever lands
// last: the two listings, /status, the vouch set with its escrow, the bonds and
// the reader's own name. An answer whose read began before the held answer's
// read never replaces it — against a landing's reads and against a second
// membership read — and a figures run proves the listing the row holds. A bonds
// page continues the first page it was asked for. The fake answers what the node
// held as each read began, so a read held past a change answers the older state.

const ME = 'aa'.repeat(32);
const X = 'cd'.repeat(32);
const NODE = 'https://a.example';
const K1 = '11'.repeat(32);
const K2 = '12'.repeat(32);
const K3 = '13'.repeat(32);
const C1 = '21'.repeat(32);
const C2 = '22'.repeat(32);
const P = '31'.repeat(32);
const I0 = '40'.repeat(32);
const I1 = '41'.repeat(32);
const I2 = '42'.repeat(32);
const I3 = '43'.repeat(32);
const BOND_PAGE = 2;

/** The node's state as the reads find it; a test moves it between reads. */
interface Chain {
  height: number;
  karma: { boxId: string; value: string }[];
  effective: string;
  credits: { boxId: string; value: string; lockedUntilBlock?: number }[];
  vouchTargets: string[];
  escrow: number | null;    // an unvouch's stake held until this block
  bonds: string[];          // invitee keys, newest first
  name: string | null;
  posts: Map<string, PostResult>;
}

interface Held { method: string; after: string | null; release(): void }

function statusAt(height: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight: height, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000', membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
  };
}

function bondsPage(chain: Chain, after: string | null): BondsResult {
  const start = after === null ? 0 : chain.bonds.indexOf(after) + 1;
  const keys = chain.bonds.slice(start, start + BOND_PAGE);
  return {
    bonds: keys.map((k) => ({ id: k, value: '100', inviterId: ME, inviteePublicKey: k, inviterName: null, inviteeName: null })),
    bondCount: chain.bonds.length,
    next: start + BOND_PAGE < chain.bonds.length ? keys[keys.length - 1]! : null,
  };
}

/** One node. Every answer is what the chain holds as the read begins; a read the
 *  `hold` predicate names waits for its `release`. */
function fakeNode(chain: Chain) {
  const calls: { method: string; key: string | undefined }[] = [];
  const held: Held[] = [];
  let hold: (method: string, after: string | null) => boolean = () => false;
  function answer<T>(method: string, key: string | undefined, after: string | null, make: () => T): Promise<T> {
    calls.push({ method, key });
    const value = make();
    if (!hold(method, after)) return Promise.resolve(value);
    return new Promise<T>((resolve) => { held.push({ method, after, release: () => resolve(value) }); });
  }
  const api: Api = {
    feed: () => answer('feed', undefined, null, () => ({ posts: [], next: null, pending: [], pendingCount: 0 })),
    thread: () => answer('thread', undefined, null, () => null),
    post: (id) => answer('post', id, null, () => chain.posts.get(id) ?? null),
    status: () => answer('status', undefined, null, () => statusAt(chain.height)),
    currentBlock: () => answer('currentBlock', undefined, null, () => ({ height: chain.height, hash: null })),
    karma: (key) => answer('karma', key, null, (): KarmaResult => karmaResult({
      userId: key, total: chain.effective, effective: chain.effective, boxes: [...chain.karma],
      boxCount: chain.karma.length, height: chain.height, member: true, memberSinceBlock: 5, invitesAvailable: 2,
    })),
    credits: (key) => answer('credits', key, null, (): CreditsResult => ({
      userId: key, total: '0', boxes: chain.credits.map((b) => ({ ...b })), boxCount: chain.credits.length, next: null,
    })),
    vouchesByTarget: (key) => answer('vouchesByTarget', key, null, () => ({ vouches: [], count: 0, next: null })),
    vouchesByVoucher: (key) => answer('vouchesByVoucher', key, null, () => ({
      vouches: chain.vouchTargets.map((t) => ({
        boxId: 'f0'.repeat(32), value: '1', createdAtBlock: 1000, voucherId: ME, targetId: t, voucherName: null, targetName: null,
      })),
      count: chain.vouchTargets.length,
      next: null,
    })),
    vouchCooldowns: (key) => answer('vouchCooldowns', key, null, () => ({
      cooldowns: chain.escrow === null ? [] : [{ boxId: 'e1'.repeat(32), value: '1', releaseAtBlock: chain.escrow }],
      count: chain.escrow === null ? 0 : 1,
      next: null,
    })),
    bonds: (key, page) => answer('bonds', key, page?.after ?? null, () => bondsPage(chain, page?.after ?? null)),
    usernameByOwner: (key) => answer('usernameByOwner', key, null, () => (
      chain.name === null ? null : { name: chain.name, owner: key, boxId: '55'.repeat(32), claimedAtBlock: 1 }
    )),
    usernameByName: () => answer('usernameByName', undefined, null, () => null),
  };
  return {
    api, calls, held,
    setHold(p: (method: string, after: string | null) => boolean): void { hold = p; },
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
  openAuthor(key: string, origin: { from: 'feed' }): void;
  refreshAuthor(key: string): Promise<void>;
  moreBonds(): Promise<void>;
  pollTick(): Promise<void>;
  profileKarma: KarmaResult | null;
  walletCredits: CreditsResult | null;
  viewerTip: number;
  bondsView: BondsResult | null;
  figures: unknown;
  state: AppState;
}

interface Harness {
  node: ReturnType<typeof fakeNode>;
  chain: Chain;
  ledger: PendingLedger;
  drive: Drive;
  appbar: HTMLElement;
  figuresCalls: FigureCall[];
  tipCalls: TipCall[];
}

function harness(opts: { layout?: string; verifiers?: boolean; entries?: Array<{ kind: EntryKind; postId: string }> } = {}): Harness {
  const chain: Chain = {
    height: 1070,
    karma: [{ boxId: K1, value: '219' }],
    effective: '219',
    credits: [{ boxId: C1, value: '1250000000' }],
    vouchTargets: [],
    escrow: null,
    bonds: [],
    name: null,
    posts: new Map(),
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
  return { node, chain, ledger, drive: app as unknown as Drive, appbar, figuresCalls, tipCalls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const repNumber = (): string | null => document.querySelector('.karma-field .mono')?.textContent ?? null;
const gold = (): string | null => document.querySelector('.credits-line .mono.gold')?.textContent ?? null;
const headerProfile = (h: Harness): string | null =>
  h.appbar.querySelector('button[aria-label="open profile"]')?.textContent ?? null;
const standing = (): string | null => document.querySelector('.standing')?.textContent ?? null;
const vouchWord = (): Element | null => document.querySelector('button[aria-label="vouch for this author — stakes 1 rep"]');
const bondKeys = (h: Harness): string[] => h.drive.bondsView?.bonds.map((b) => b.inviteePublicKey) ?? [];
const bondRows = (): number => document.querySelectorAll('.invites-bonds .bond').length;

function fakeHeader(height: number): BlockHeader {
  return {
    protocolVersion: 1, height, prevBlockHash: '00'.repeat(32), utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(32), validatorId: new Uint8Array(32), powNonce: 0, powTargetBits: 0x1d00ffff,
    createdAt: 0, interlinkRoot: '00'.repeat(32),
  };
}
const verified = (height: number): { verdict: TipVerdict; anchor: Anchor } => ({
  verdict: { kind: 'verified', nodes: 2, height },
  anchor: { tip: fakeHeader(height), suffixHead: { header: fakeHeader(height - 19), interlinks: [] } },
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

function confirmed(id: string): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: ME, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 1081, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: ME,
  } as PostResult;
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});

// ---------------------------------------------------------------------------
// The two listings
// ---------------------------------------------------------------------------

describe('the newest read of a listing wins', () => {
  it('two /karma reads answered out of order — a profile ↻ held past a landing: the rep row holds the landing\'s later-begun read', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'post', postId: P }] });
    await h.drive.loadMembershipState();
    await flush();
    expect(repNumber()).toBe('219');

    // A profile ↻ begins while the post is still pending, and is held.
    h.node.setHold((m) => m === 'karma');
    const early = h.drive.refreshProfileKarma();
    await flush();
    expect(h.node.held).toHaveLength(1);

    // The post lands; the tick's /karma read begins after the ↻'s and answers first.
    h.node.setHold(() => false);
    h.chain.posts.set(P, confirmed(P));
    h.chain.karma = [{ boxId: K2, value: '214' }];
    h.chain.effective = '214';
    h.chain.height = 1081;
    await h.drive.pollTick();
    await flush();
    expect(repNumber()).toBe('214');

    // The ↻ answers last, with the listing the node held when it began.
    h.node.held[0]!.release();
    await early;
    await flush();
    expect(repNumber()).toBe('214');
    expect(h.drive.profileKarma?.boxes.map((b) => b.boxId)).toEqual([K2]);
  });

  it('a membership read begun before a verified tip, answering after the tip\'s own /karma read: the row keeps the tip\'s listing and the run over it is shown', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', verifiers: true });
    await h.drive.loadMembershipState();
    await flush();

    h.node.setHold((m) => m === 'karma');
    const early = h.drive.refreshProfileKarma();
    await flush();
    // The node moves on; the verified tip reads /karma after it and proves that.
    h.node.setHold(() => false);
    h.chain.karma = [{ boxId: K2, value: '214' }];
    h.chain.effective = '214';
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    expect(repNumber()).toBe('214');
    expect(h.figuresCalls).toHaveLength(1);
    expect(karmaIds(h.figuresCalls[0]!)).toEqual([K2]);

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(repNumber()).toBe('214');

    // The run was over the listing the row still holds: its result stands, and
    // no second run is owed.
    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.figuresCalls).toHaveLength(1);
    expect(h.drive.figures).not.toBeNull();
  });

  it('two /credits reads answered out of order: the balance holds the later-begun read\'s listing', async () => {
    setNode(NODE);
    const h = harness({ layout: '@wallet' });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(gold()).toBe('12.5');

    h.node.setHold((m) => m === 'credits');
    const early = h.drive.refreshWalletCredits();
    await flush();
    h.node.setHold(() => false);
    h.chain.credits = [{ boxId: C2, value: '700000000' }];
    await h.drive.refreshWalletCredits();
    await flush();
    expect(gold()).toBe('7');

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(gold()).toBe('7');
    expect(h.drive.walletCredits?.boxes.map((b) => b.boxId)).toEqual([C2]);
  });

  it('a wallet ↻ begun before a verified tip, answering after the tip\'s own /credits read: the run proves the tip\'s listing', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile|@wallet', verifiers: true });
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();

    h.node.setHold((m) => m === 'credits');
    const early = h.drive.refreshWalletCredits();
    await flush();
    h.node.setHold(() => false);
    h.chain.credits = [{ boxId: C2, value: '700000000' }];
    h.tipCalls[0]!.resolve(verified(1070));
    await flush();
    // The karma write ran first with credits passed empty; the credits write
    // marked one more run.
    expect(h.figuresCalls).toHaveLength(1);
    expect(creditIds(h.figuresCalls[0]!)).toEqual([]);

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(gold()).toBe('7');

    h.figuresCalls[0]!.resolve(emptyResult());
    await flush();
    expect(h.figuresCalls).toHaveLength(2);
    expect(creditIds(h.figuresCalls[1]!)).toEqual([C2]);
  });
});

// ---------------------------------------------------------------------------
// The rest of the membership answer
// ---------------------------------------------------------------------------

describe('the newest read of each piece of the membership answer wins', () => {
  it('a just-landed vouch\'s row does not offer vouch again when a membership read begun before the landing answers after it', async () => {
    setNode(NODE);
    const h = harness({ entries: [{ kind: 'vouch', postId: X }] });
    h.drive.openAuthor(X, { from: 'feed' });
    await h.drive.loadMembershipState();
    await flush();
    expect(vouchWord()).toBeNull(); // pending: the ledger holds the vouch

    h.node.setHold((m) => m === 'vouchesByVoucher');
    const early = h.drive.refreshProfileKarma();
    await flush();
    h.node.setHold(() => false);
    h.chain.vouchTargets = [X];
    h.chain.height = 1081;
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(standing()).toBe('vouched');

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(standing()).toBe('vouched');
    expect(vouchWord()).toBeNull();
  });

  it('a just-claimed @Name stays in the header when a membership read begun before the claim landed answers after it', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'claim', postId: 'Alice' }] });
    await h.drive.loadMembershipState();
    await flush();
    expect(headerProfile(h)).toBe(ME.slice(0, 16) + '…');

    h.node.setHold((m) => m === 'usernameByOwner');
    const early = h.drive.refreshProfileKarma();
    await flush();
    h.node.setHold(() => false);
    h.chain.name = 'Alice';
    h.chain.height = 1081;
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(headerProfile(h)).toBe('@Alice');

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(headerProfile(h)).toBe('@Alice');
  });

  it('the older /status never replaces the newer — a box unlocked at the newer height stays spendable', async () => {
    setNode(NODE);
    const h = harness({ layout: '@wallet' });
    h.chain.credits = [{ boxId: C1, value: '1250000000' }, { boxId: C2, value: '500000000', lockedUntilBlock: 1080 }];
    await h.drive.loadMembershipState();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(gold()).toBe('12.5'); // C2 locked at 1070

    h.node.setHold((m) => m === 'status');
    const early = h.drive.refreshProfileKarma();
    await flush();
    h.node.setHold(() => false);
    h.chain.height = 1090;
    await h.drive.refreshProfileKarma();
    await flush();
    expect(gold()).toBe('17.5');

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(h.drive.state.status?.blockHeight).toBe(1090);
    expect(gold()).toBe('17.5');
  });

  it('a just-landed invite\'s bond stays listed when a membership read begun before the landing answers after it', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'invite', postId: I1 }] });
    await h.drive.loadMembershipState();
    await flush();
    expect(bondRows()).toBe(0);

    h.node.setHold((m) => m === 'bonds');
    const early = h.drive.refreshProfileKarma();
    await flush();
    h.node.setHold(() => false);
    h.chain.bonds = [I1];
    h.chain.height = 1081;
    await h.drive.pollTick();
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(bondKeys(h)).toEqual([I1]);

    h.node.held[0]!.release();
    await early;
    await flush();
    expect(bondKeys(h)).toEqual([I1]);
    expect(bondRows()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The other direction: a landing's read, older than a membership read
// ---------------------------------------------------------------------------

describe('a landing\'s read held past a later-begun membership read never replaces its answer', () => {
  it('the tick\'s /karma read: the rep row keeps the membership read\'s listing', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'post', postId: P }] });
    await h.drive.loadMembershipState();
    await flush();
    h.chain.posts.set(P, confirmed(P));
    h.chain.karma = [{ boxId: K2, value: '214' }];
    h.chain.effective = '214';
    h.chain.height = 1081;
    h.node.setHold((m) => m === 'karma');
    const tick = h.drive.pollTick();
    await flush();
    expect(h.node.held).toHaveLength(1);

    h.node.setHold(() => false);
    h.chain.karma = [{ boxId: K3, value: '210' }];
    h.chain.effective = '210';
    await h.drive.refreshProfileKarma();
    await flush();
    expect(repNumber()).toBe('210');

    h.node.held[0]!.release();
    await tick;
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(repNumber()).toBe('210');
  });

  it('the tick\'s vouch-set read: the your-vouch row keeps the membership read\'s answer', async () => {
    setNode(NODE);
    const h = harness({ entries: [{ kind: 'vouch', postId: X }] });
    h.drive.openAuthor(X, { from: 'feed' });
    await h.drive.loadMembershipState();
    await flush();
    // The tick's read begins before the vouch lands.
    h.chain.height = 1081;
    h.node.setHold((m) => m === 'vouchesByVoucher');
    const tick = h.drive.pollTick();
    await flush();
    expect(h.node.held).toHaveLength(1);

    h.node.setHold(() => false);
    h.chain.vouchTargets = [X];
    await h.drive.refreshProfileKarma();
    await flush();
    expect(standing()).toBe('vouched');

    h.node.held[0]!.release();
    await tick;
    await flush();
    // The tick decided nothing on its older read; the window's ↻ draws the
    // vouch set the App holds.
    await h.drive.refreshAuthor(X);
    await flush();
    expect(standing()).toBe('vouched');
    expect(vouchWord()).toBeNull();
  });

  it('the tick\'s bonds read: the invites row keeps the membership read\'s bonds', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'invite', postId: I1 }] });
    await h.drive.loadMembershipState();
    await flush();
    h.chain.bonds = [I1];
    h.chain.height = 1081;
    h.node.setHold((m) => m === 'bonds');
    const tick = h.drive.pollTick();
    await flush();
    expect(h.node.held).toHaveLength(1);

    h.node.setHold(() => false);
    h.chain.bonds = [I2, I1];
    await h.drive.refreshProfileKarma();
    await flush();
    expect(bondKeys(h)).toEqual([I2, I1]);

    h.node.held[0]!.release();
    await tick;
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(bondKeys(h)).toEqual([I2, I1]);
  });

  it('the tick\'s name read: the header keeps the membership read\'s answer', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'claim', postId: 'Alice' }] });
    await h.drive.loadMembershipState();
    await flush();
    // The claim has landed as the tick's read begins; the name is gone again
    // by the time the membership read begins.
    h.chain.name = 'Alice';
    h.chain.height = 1081;
    h.node.setHold((m) => m === 'usernameByOwner');
    const tick = h.drive.pollTick();
    await flush();
    expect(h.node.held).toHaveLength(1);

    h.node.setHold(() => false);
    h.chain.name = null;
    await h.drive.refreshProfileKarma();
    await flush();
    expect(headerProfile(h)).toBe(ME.slice(0, 16) + '…');

    h.node.held[0]!.release();
    await tick;
    await flush();
    expect(h.ledger.size).toBe(0);
    expect(headerProfile(h)).toBe(ME.slice(0, 16) + '…');
  });
});

// ---------------------------------------------------------------------------
// A listing's height feeds the tip the gates read
// ---------------------------------------------------------------------------

describe('every /karma read feeds the tip the gates read', () => {
  it('the verified tip\'s /karma height releases a stake the escrow gate held', async () => {
    setNode(NODE);
    const h = harness({ verifiers: true });
    h.chain.escrow = 1075;
    h.drive.openAuthor(X, { from: 'feed' });
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.viewerTip).toBe(1070);
    expect(document.querySelector('.winbody')?.textContent).toContain('held until block 1075');
    expect(vouchWord()).toBeNull();

    // Blocks pass; the verified tip's own /karma read is the first read of the
    // new height.
    h.chain.height = 1080;
    h.tipCalls[0]!.resolve(verified(1080));
    await flush();
    expect(h.drive.viewerTip).toBe(1080);

    await h.drive.refreshAuthor(X);
    await flush();
    expect(vouchWord()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The bonds continuation
// ---------------------------------------------------------------------------

describe('a bonds page continues the page it was asked for', () => {
  it('a page answering after a landing replaced the first page writes nothing, and the next more continues the new page', async () => {
    setNode(NODE);
    const h = harness({ layout: '@profile', entries: [{ kind: 'invite', postId: I0 }] });
    h.chain.bonds = [I1, I2, I3];
    await h.drive.loadMembershipState();
    await flush();
    expect(bondKeys(h)).toEqual([I1, I2]);

    // `more` asks for the page after I2, and is held.
    h.node.setHold((m, after) => m === 'bonds' && after !== null);
    const stale = h.drive.moreBonds();
    await flush();
    expect(h.node.held).toHaveLength(1);

    // The invite lands; the tick reads the first page again.
    h.node.setHold(() => false);
    h.chain.bonds = [I0, I1, I2, I3];
    h.chain.height = 1081;
    await h.drive.pollTick();
    await flush();
    expect(bondKeys(h)).toEqual([I0, I1]);

    h.node.held[0]!.release();
    await stale;
    await flush();
    expect(bondKeys(h)).toEqual([I0, I1]);

    await h.drive.moreBonds();
    await flush();
    expect(bondKeys(h)).toEqual([I0, I1, I2, I3]);
    expect(bondRows()).toBe(4);
  });
});
