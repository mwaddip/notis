// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Anchor, NameClaim, NameResult, NameStatus } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { AppIdentity, AppState, NamesVerifier, Submission, TipVerifier } from '../src/model/state';
import type {
  BondsResult, FeedResult, PostJson, StatusResult, ThreadResult, UsernameResult, VouchesTargetResult,
} from '../src/api/dto';
import type { TipVerdict } from '../src/model/tip-verdict';
import { namePair } from '../src/model/name-verdict';
import { card } from '../src/view/card';
import { PendingLedger } from '../src/wallet/ledger';
import { setNode } from '../src/prefs';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// The App's name checks (WEB_INTERFACE → The extension → "The verified names"):
// every pair on screen after each tip run that ends verified; a pair first on a
// surface against the anchor standing; one batch in flight, a trigger during it
// marking one more, `every` over `new`; a check that ends `unchecked` asks for
// one tip run; a node change drops the results, an identity change keeps them;
// no anchor, nothing runs. A result that changes a pair's clay lands on its
// handles in place, and one that does not touches nothing (HOUSE_STYLE →
// Motion). The web build is handed no verifier and asks nothing more.
//
// Every source a handle renders from carries, in some test here, a pair no
// other source shows, so a source the App missed is a pair never asked.

const NODE_A = 'https://a.example';
const NODE_B = 'https://b.example';

const ME = 'aa'.repeat(32);   // the reader, holding Me_1
const ME2 = 'a2'.repeat(32);  // a second identity, holding Two
const A = 'bb'.repeat(32);    // Alice — ROOT's author, the author and posts windows' subject
const B = 'cc'.repeat(32);    // Bob — ROOT2's author and REPLY's
const V = 'dd'.repeat(32);    // Vic — Alice's endorser: the endorsers alone
const I = 'ee'.repeat(32);    // Ivy — the reader's invitee: the bonds alone
const C = 'f1'.repeat(32);    // Cat — REPLY2's author: ROOT2's thread alone
const W = '12'.repeat(32);    // Wes — Bob's endorser: Bob's author window alone
const D = 'd4'.repeat(32);    // Dee — ROOT3's author: the feed's rows alone
const P = 'b4'.repeat(32);    // Pam — PEND's author: the feed's mempool rows alone
const E = 'e4'.repeat(32);    // Eve — ROOT5's author: her posts window's rows alone
const K = 'c4'.repeat(32);    // Kay — an author window's subject with no endorsers: the subject's name alone
const T = 'a4'.repeat(32);    // Tom — ROOT4's author: ROOT4's thread alone
const N = '94'.repeat(32);    // Neo — ROOTN's author: the feed after a ↻
const U = '84'.repeat(32);    // Uma — the second page of the reader's bonds
const Z = '7a'.repeat(32);    // Zed — ROOT6's author, a withdrawn root: the thread's root alone

const ROOT = '1'.repeat(64);
const ROOT2 = '2'.repeat(64);
const REPLY = '3'.repeat(64);
const REPLY2 = '4'.repeat(64);
const ROOT3 = '5'.repeat(64);
const PEND = '6'.repeat(64);
const ROOT4 = '7'.repeat(64);
const ROOT5 = '8'.repeat(64);
const ROOTN = '9'.repeat(64);
const ROOT6 = 'f'.repeat(64);

const MINE = namePair(ME, 'Me_1');
const ALICE = namePair(A, 'Alice');
const BOB = namePair(B, 'Bob');
const VIC = namePair(V, 'Vic');
const IVY = namePair(I, 'Ivy');
const CAT = namePair(C, 'Cat');
const WES = namePair(W, 'Wes');
const DEE = namePair(D, 'Dee');
const PAM = namePair(P, 'Pam');
const EVE = namePair(E, 'Eve');
const KAY = namePair(K, 'Kay');
const TOM = namePair(T, 'Tom');
const NEO = namePair(N, 'Neo');
const UMA = namePair(U, 'Uma');
const ZED = namePair(Z, 'Zed');
const TWO = namePair(ME2, 'Two');
/** The pairs `everySurface` puts on screen: Alice's and Bob's through several
 *  sources, every other pair through one alone. */
const ON_SCREEN = [MINE, ALICE, BOB, VIC, IVY, DEE, PAM, EVE, KAY];

function post(id: string, author: string, authorName: string, content: string, parents: string[] = []): PostJson {
  return {
    id, content, contentHash: contentHashHex(content), author, parentRefs: parents,
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 90, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName, likedByViewer: null,
  };
}

function submission(localKey: string, parentId: string | null): Submission {
  return {
    localKey, content: 'mine', parentId, author: ME, contentHash: contentHashHex('mine'),
    stage: 'submitted', txId: null, postId: null, blockHeight: null, expiresAtHeight: 190, reason: null,
  };
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 8, pendingPosts: 1,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 43200,
    vouchCooldownBlocks: 60, inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

/** What the fake node answers, changeable by a test, and what it was asked. */
interface World {
  names: Map<string, UsernameResult>;
  feedPosts: PostJson[];
  threadReads: number;
  usernameByOwner: string[];
  usernameByName: number;
}

function world(): World {
  return {
    names: new Map<string, UsernameResult>([
      [ME, { name: 'Me_1', owner: ME, boxId: '51'.repeat(32), claimedAtBlock: 40 }],
      [ME2, { name: 'Two', owner: ME2, boxId: '50'.repeat(32), claimedAtBlock: 39 }],
      [A, { name: 'Alice', owner: A, boxId: '52'.repeat(32), claimedAtBlock: 41 }],
      [B, { name: 'Bob', owner: B, boxId: '53'.repeat(32), claimedAtBlock: 42 }],
      [K, { name: 'Kay', owner: K, boxId: '54'.repeat(32), claimedAtBlock: 43 }],
    ]),
    feedPosts: [post(ROOT, A, 'Alice', 'the root'), post(ROOT2, B, 'Bob', 'second root'), post(ROOT3, D, 'Dee', 'dee writes')],
    threadReads: 0,
    usernameByOwner: [],
    usernameByName: 0,
  };
}

function fakeApi(w: World): Api {
  const pending: PostJson = { ...post(PEND, P, 'Pam', 'not in a block yet'), status: 'pending', blockHeight: null, blockIndex: null };
  const byAuthor = new Map<string, PostJson[]>([
    [A, [post(ROOT, A, 'Alice', 'the root')]],
    [B, [post(ROOT2, B, 'Bob', 'second root')]],
    [E, [post(ROOT5, E, 'Eve', 'eve writes')]],
  ]);
  const thread = (root: PostJson, replies: PostJson[]): ThreadResult => ({
    post: root, ancestors: [], ancestorCount: 0, descendants: replies, descendantCount: replies.length,
    next: null, pending: [], pendingCount: 0,
  });
  const threads = new Map<string, ThreadResult>([
    [ROOT, thread(post(ROOT, A, 'Alice', 'the root'), [post(REPLY, B, 'Bob', 'a reply', [ROOT])])],
    [ROOT2, thread(post(ROOT2, B, 'Bob', 'second root'), [post(REPLY2, C, 'Cat', 'cat replies', [ROOT2])])],
    [ROOT4, thread(post(ROOT4, T, 'Tom', 'tom writes'), [])],
    [ROOT6, {
      post: { kind: 'withdrawn', id: ROOT6, author: Z, withdrawnAtHeight: 95, parentRefs: [], descendantCount: 0, authorName: 'Zed' },
      ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0,
    }],
  ]);
  const endorsers = new Map<string, VouchesTargetResult>([
    [A, { vouches: [{ voucherId: V, targetId: A, voucherName: 'Vic', targetName: 'Alice' }], count: 1, next: null }],
    [B, { vouches: [{ voucherId: W, targetId: B, voucherName: 'Wes', targetName: 'Bob' }], count: 1, next: null }],
  ]);
  const bond = (invitee: string, name: string): BondsResult['bonds'][number] => ({
    id: invitee.slice(0, 2).repeat(32), value: '100', inviterId: ME, inviteePublicKey: invitee, inviterName: 'Me_1', inviteeName: name,
  });
  return {
    feed: async (_page, _viewer, author): Promise<FeedResult> => (author === undefined
      ? { posts: [...w.feedPosts], next: null, pending: [pending], pendingCount: 1 }
      : { posts: byAuthor.get(author) ?? [], next: null, pending: [], pendingCount: 0 }),
    thread: async (id) => {
      w.threadReads += 1;
      return threads.get(id) ?? null;
    },
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async () => ({ height: 100, hash: null }),
    karma: async (key) => karmaResult({
      userId: key, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1,
      total: '250', effective: '250', boxes: [{ boxId: '11'.repeat(32), value: '250' }], height: 100,
    }),
    credits: async (key) => ({ userId: key, total: '0', boxes: [], boxCount: 0, next: null }),
    vouchesByTarget: async (key) => endorsers.get(key) ?? { vouches: [], count: 0, next: null },
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async (_key, page) => (page?.after === 'b1'
      ? { bonds: [bond(U, 'Uma')], bondCount: 2, next: null }
      : { bonds: [bond(I, 'Ivy')], bondCount: 2, next: 'b1' }),
    usernameByOwner: async (key) => {
      w.usernameByOwner.push(key);
      return w.names.get(key) ?? null;
    },
    usernameByName: async () => {
      w.usernameByName += 1;
      return null;
    },
  };
}

function header(height: number, tag: string): BlockHeader {
  return {
    protocolVersion: 1, height, prevBlockHash: '00'.repeat(32), utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + tag, validatorId: new Uint8Array(32), powNonce: 0,
    powTargetBits: 0x1d00ffff, createdAt: 0, interlinkRoot: '00'.repeat(32),
  };
}

function anchorFor(h: number): Anchor {
  return { tip: header(h, 'aa'), suffixHead: { header: header(h - 19, 'bb'), interlinks: [] } };
}

interface TipRunHandle {
  resolve: (run: { verdict: TipVerdict; anchor: Anchor | null }) => void;
  reject: (e: unknown) => void;
}

interface NameCall {
  base: string;
  claim: NameClaim;
  anchor: Anchor;
  resolve: (r: NameResult) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

type Origin = { from: 'feed' } | { from: 'pane'; ci: number };
interface Drive {
  loadFeed(): Promise<void>;
  refreshFeed(): Promise<void>;
  loadMembershipState(): Promise<void>;
  openProfile(): void;
  openThread(id: string, origin: Origin): void;
  openAuthor(key: string, origin: Origin): void;
  openAuthorPosts(key: string, origin: Origin): void;
  openComposer(parentId: string | null): void;
  focus(id: string): void;
  closeWindow(id: string): void;
  moreBonds(): Promise<void>;
  changeNode(origin: string): Promise<void>;
  reconcile(tip: number): Promise<void>;
  renderHeader(): void;
  renderFeed(): void;
  renderPanes(): void;
  nameChecks: Map<string, NameResult>;
  cornerEl: HTMLButtonElement | null;
  state: AppState;
}

interface Harness {
  appbar: HTMLElement;
  feed: HTMLElement;
  panes: HTMLElement;
  drive: Drive;
  world: World;
  tipRuns: TipRunHandle[];
  nameCalls: NameCall[];
  setKey(key: string): void;
}

/** The App over fakes: the extension build's tip verifier and names verifier,
 *  each run held until the test answers it — or, with `verifiers: false`, the
 *  web build, handed neither. */
function harness(opts: { verifiers?: boolean; world?: World; ledger?: PendingLedger } = {}): Harness {
  const verifiers = opts.verifiers ?? true;
  const w = opts.world ?? world();
  let key = ME;
  let listener: ((id: { pubKeyHex: string } | null) => void) | null = null;
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: key, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    onChange: (l) => { listener = l; },
    draft: async () => ({ pubKeyHex: key }),
    create: async () => ({ pubKeyHex: key }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: key }),
    importFile: async () => ({ pubKeyHex: key }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
  };
  const tipRuns: TipRunHandle[] = [];
  const tipVerifier: TipVerifier = {
    run: () => new Promise((resolve, reject) => { tipRuns.push({ resolve, reject }); }),
  };
  const nameCalls: NameCall[] = [];
  const namesVerifier: NamesVerifier = {
    run: (base, claim, anchor) => new Promise((resolve, reject) => {
      nameCalls.push({ base, claim, anchor, resolve, reject, settled: false });
    }),
  };
  const app = new App(
    fakeApi(w), undefined, identity, opts.ledger, undefined, undefined,
    verifiers ? tipVerifier : undefined, undefined, verifiers ? namesVerifier : undefined,
  );
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);
  return {
    appbar, feed, panes, drive: app as unknown as Drive, world: w, tipRuns, nameCalls,
    setKey: (k) => { key = k; listener?.({ pubKeyHex: k }); },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Every source a handle renders from, on screen at once: the feed and its
 *  mempool row, the header at tiling, the profile in column 0, ROOT's thread in
 *  1, Alice's author window in 2 and her posts window in 3, Eve's posts window
 *  in 4 and Kay's author window in 5. */
async function everySurface(h: Harness): Promise<void> {
  await h.drive.loadFeed();
  await h.drive.loadMembershipState();
  h.drive.openProfile();
  await flush();
  h.drive.openThread(ROOT, { from: 'pane', ci: 0 });
  await flush();
  h.drive.openAuthor(A, { from: 'pane', ci: 1 });
  await flush();
  h.drive.openAuthorPosts(A, { from: 'pane', ci: 2 });
  await flush();
  h.drive.openAuthorPosts(E, { from: 'pane', ci: 3 });
  await flush();
  h.drive.openAuthor(K, { from: 'pane', ci: 4 });
  await flush();
}

/** Answer tip run `i` verified, with its anchor. */
async function verify(h: Harness, i: number, anchor: Anchor): Promise<void> {
  h.tipRuns[i]!.resolve({ verdict: { kind: 'verified', nodes: 2, height: anchor.tip.height }, anchor });
  await flush();
}

function claimPair(claim: NameClaim): string {
  if (!('key' in claim)) throw new Error('a label is a key and a name');
  return namePair(claim.key, claim.name);
}
const pairOf = (c: NameCall): string => claimPair(c.claim);

function result(status: NameStatus, claim: NameClaim): NameResult {
  const held = status === 'proven' || status === 'young';
  return {
    status,
    owner: held && 'key' in claim ? claim.key : null,
    name: held ? claim.name : null,
    boxId: '5f'.repeat(32),
    heightAfter: null,
    verdict: status,
  };
}

/** Answer every check as it is asked — a batch asks one after another — until
 *  none waits; the checks answered, in order. */
async function answer(h: Harness, statusOf: (claim: NameClaim) => NameStatus): Promise<NameCall[]> {
  const done: NameCall[] = [];
  for (let round = 0; round < 100; round++) {
    const waiting = h.nameCalls.filter((c) => !c.settled);
    if (waiting.length === 0) break;
    for (const c of waiting) {
      c.settled = true;
      c.resolve(result(statusOf(c.claim), c.claim));
      done.push(c);
    }
    await flush();
  }
  return done;
}

/** Answer the one check waiting. */
async function answerOne(h: Harness, status: NameStatus): Promise<NameCall> {
  const waiting = h.nameCalls.filter((c) => !c.settled);
  expect(waiting).toHaveLength(1);
  const c = waiting[0]!;
  c.settled = true;
  c.resolve(result(status, c.claim));
  await flush();
  return c;
}

const pressCorner = async (h: Harness): Promise<void> => {
  h.drive.cornerEl!.dispatchEvent(new Event('click'));
  await flush();
};

function col(h: Harness, ci: number): HTMLElement {
  return h.panes.querySelectorAll<HTMLElement>('.col')[ci]!;
}
function rowField(root: HTMLElement, label: string): HTMLElement {
  const r = [...root.querySelectorAll('.row')].find((x) => x.querySelector('label')?.textContent === label);
  return r!.querySelector<HTMLElement>('.field')!;
}
function marked(pair: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-name-pair]')].filter((e) => e.dataset.namePair === pair);
}
function textNode(root: Node, text: string): Text | null {
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent === text) return child as Text;
    const found = textNode(child, text);
    if (found) return found;
  }
  return null;
}

/** Every mutation under the three surfaces from now on. */
function observe(h: Harness): () => MutationRecord[] {
  const records: MutationRecord[] = [];
  const mo = new MutationObserver((rs) => records.push(...rs));
  for (const root of [h.appbar, h.feed, h.panes]) {
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return () => {
    records.push(...mo.takeRecords());
    return records;
  };
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode(NODE_A);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the name checks — every pair on screen after a verified run', () => {
  it('checks every pair every source shows, each once, at the reading node against the anchor the run wrote', async () => {
    const h = harness();
    await everySurface(h);
    const reads = [...h.world.usernameByOwner];
    const a1 = anchorFor(100);
    await verify(h, 0, a1);
    const first = await answer(h, () => 'proven');
    expect(first.map(pairOf).sort()).toEqual([...ON_SCREEN].sort());
    for (const c of first) {
      expect(c.base).toBe(NODE_A);
      expect(c.anchor).toBe(a1);
    }
    // The next verified run — a press of the corner — checks every pair again,
    // each once, against its own anchor.
    await pressCorner(h);
    const a2 = anchorFor(101);
    await verify(h, 1, a2);
    const second = await answer(h, () => 'proven');
    expect(second.map(pairOf).sort()).toEqual([...ON_SCREEN].sort());
    for (const c of second) expect(c.anchor).toBe(a2);
    // The checks are the seam's own requests: the read client asked for no name.
    expect(h.world.usernameByOwner).toEqual(reads);
    expect(h.world.usernameByName).toBe(0);
  });

  it('a thread the node answers nothing for draws its bar from the row the App already holds, and that pair is on screen', async () => {
    const h = harness();
    await everySurface(h);
    // Eve's posts window closes; her row stays in the App's post index, and a
    // thread on it that the node answers 404 for reads its bar from there.
    h.drive.closeWindow('@posts:' + E);
    await flush();
    h.drive.openThread(ROOT5, { from: 'pane', ci: 3 });
    await flush();
    const bars = [...h.panes.querySelectorAll('.bar-label .handle')].map((e) => e.textContent);
    expect(bars).toContain('@Eve');
    await verify(h, 0, anchorFor(100));
    const checked = await answer(h, () => 'proven');
    expect(checked.map(pairOf)).toContain(EVE);
  });
});

describe('the name checks — a pair first on a surface', () => {
  async function decided(): Promise<{ h: Harness; a1: Anchor }> {
    const h = harness();
    await everySurface(h);
    const a1 = anchorFor(100);
    await verify(h, 0, a1);
    await answer(h, () => 'proven');
    return { h, a1 };
  }

  it('an author window\'s endorser is checked once against the anchor standing; its decided subject is not, and nothing is asked on a redraw', async () => {
    const { h, a1 } = await decided();
    const before = h.nameCalls.length;
    h.drive.openAuthor(B, { from: 'pane', ci: 5 });
    await flush();
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([WES]);
    expect(fresh[0]!.anchor).toBe(a1);
    h.drive.renderHeader();
    h.drive.renderFeed();
    h.drive.renderPanes();
    await flush();
    expect(h.nameCalls).toHaveLength(before + 1);
  });

  it('a window opened over rows the App already holds is checked with no read — a closed thread reopened', async () => {
    const h = harness();
    await everySurface(h);
    // ROOT2's thread — Cat's reply — opens and closes before any anchor stands.
    h.drive.openThread(ROOT2, { from: 'pane', ci: 0 });
    await flush();
    h.drive.closeWindow(ROOT2);
    await flush();
    await verify(h, 0, anchorFor(100));
    const first = await answer(h, () => 'proven');
    expect(first.map(pairOf)).not.toContain(CAT);
    const reads = h.world.threadReads;
    h.drive.openThread(ROOT2, { from: 'pane', ci: 0 });
    await flush();
    const reopened = await answer(h, () => 'proven');
    expect(reopened.map(pairOf)).toEqual([CAT]);
    expect(h.world.threadReads).toBe(reads);
  });

  it('a row the feed\'s ↻ brings is checked', async () => {
    const { h } = await decided();
    h.world.feedPosts.unshift(post(ROOTN, N, 'Neo', 'neo writes'));
    await h.drive.refreshFeed();
    await flush();
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([NEO]);
  });

  it('a standing bond the invites row\'s `more` brings is checked', async () => {
    const { h } = await decided();
    await h.drive.moreBonds();
    await flush();
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([UMA]);
  });

  it('a thread whose root is withdrawn is checked — the withdrawn card and the bar draw its author\'s handle', async () => {
    const { h } = await decided();
    h.drive.openThread(ROOT6, { from: 'pane', ci: 5 });
    await flush();
    expect(col(h, 6).querySelector('.bar-label .handle')?.textContent).toBe('@Zed');
    expect(col(h, 6).querySelector(`.card[data-post-id="${ROOT6}"] .who .handle`)?.textContent).toBe('@Zed');
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([ZED]);
  });

  it('a thread that lands behind another window in its stack is checked — its bar draws the root\'s handle', async () => {
    const { h } = await decided();
    h.drive.openThread(ROOT4, { from: 'pane', ci: 0 });
    h.drive.focus(ROOT);
    await flush();
    const bar = [...col(h, 1).querySelectorAll('.bar-label .handle')].map((e) => e.textContent);
    expect(bar).toContain('@Tom');
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([TOM]);
  });

  it('the reader\'s claim landing draws the new name in the header and the username row, and it is checked', async () => {
    const w = world();
    w.names.delete(ME); // the reader holds no name yet
    const ledger = new PendingLedger(ME);
    ledger.add({ txId: '77'.repeat(32), kind: 'claim', postId: 'Me_1', inputs: [], expiresAtHeight: 190, submittedAtHeight: 100 });
    const h = harness({ world: w, ledger });
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    const first = await answer(h, () => 'proven');
    expect(first.map(pairOf)).not.toContain(MINE);
    // The claim in flight is the reader's typed name, muted, and no site.
    const pendingHandle = rowField(col(h, 0), 'username').querySelector<HTMLElement>('.handle.inkmute')!;
    expect(pendingHandle.textContent).toBe('@Me_1');
    expect(pendingHandle.dataset.namePair).toBeUndefined();
    w.names.set(ME, { name: 'Me_1', owner: ME, boxId: '51'.repeat(32), claimedAtBlock: 101 });
    await h.drive.reconcile(101);
    await flush();
    expect(h.appbar.textContent).toContain('@Me_1');
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([MINE]);
  });
});

describe('the name checks — one batch in flight', () => {
  it('pairs appearing during a batch make one more batch of those pairs, not two', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    expect(h.nameCalls).toHaveLength(1); // one check at a time
    h.drive.openAuthor(B, { from: 'pane', ci: 5 }); // Wes
    await flush();
    h.drive.openThread(ROOT2, { from: 'pane', ci: 0 }); // Cat
    await flush();
    expect(h.nameCalls).toHaveLength(1);
    const all = (await answer(h, () => 'proven')).map(pairOf);
    expect(all).toHaveLength(ON_SCREEN.length + 2);
    expect(all.slice(0, ON_SCREEN.length).sort()).toEqual([...ON_SCREEN].sort());
    expect(all.slice(ON_SCREEN.length).sort()).toEqual([CAT, WES].sort());
  });

  it('`every` wins over a later `new`: a verified run during a batch makes the one more batch check every pair on screen, each against the anchor standing', async () => {
    const h = harness();
    await everySurface(h);
    const a1 = anchorFor(100);
    await verify(h, 0, a1);
    await pressCorner(h);
    const a2 = anchorFor(101);
    await verify(h, 1, a2); // marks every
    h.drive.openAuthor(B, { from: 'pane', ci: 5 }); // marks new after it: Wes
    await flush();
    const all = await answer(h, () => 'proven');
    expect(all).toHaveLength(ON_SCREEN.length + ON_SCREEN.length + 1);
    expect(all.slice(0, ON_SCREEN.length).map(pairOf).sort()).toEqual([...ON_SCREEN].sort());
    expect(all.slice(ON_SCREEN.length).map(pairOf).sort()).toEqual([...ON_SCREEN, WES].sort());
    // The first check began under a1; every one after it began under a2.
    expect(all[0]!.anchor).toBe(a1);
    for (const c of all.slice(1)) expect(c.anchor).toBe(a2);
  });

  it('a batch ends where no anchor stands — a run ending thin during it — and the pairs it did not reach keep no result', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await answerOne(h, 'proven');
    await pressCorner(h);
    h.tipRuns[1]!.resolve({ verdict: { kind: 'thin', reason: 'one-node', height: 101 }, anchor: null });
    await flush();
    await answerOne(h, 'proven');
    expect(h.nameCalls.filter((c) => !c.settled)).toHaveLength(0);
    expect(h.nameCalls).toHaveLength(2);
    expect(h.drive.nameChecks.size).toBe(2);
  });
});

describe('the name checks — `unchecked` asks for one tip run', () => {
  it('however many pairs of a batch end `unchecked`, one tip run, and the pairs are checked again on its result', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await answer(h, (c) => (claimPair(c) === ALICE || claimPair(c) === BOB ? 'unchecked' : 'proven'));
    expect(h.tipRuns).toHaveLength(2); // the one extra run
    const a2 = anchorFor(101);
    await verify(h, 1, a2);
    const again = await answer(h, () => 'proven');
    expect(again.map(pairOf).sort()).toEqual([...ON_SCREEN].sort());
    for (const c of again) expect(c.anchor).toBe(a2);
    expect(h.drive.nameChecks.get(ALICE)?.status).toBe('proven');
    expect(h.drive.nameChecks.get(BOB)?.status).toBe('proven');
  });

  it('a pair that ends `unchecked` again after the run it asked for asks for none, until a run no check asked for — a press of the corner', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await answer(h, (c) => (claimPair(c) === ALICE ? 'unchecked' : 'proven'));
    expect(h.tipRuns).toHaveLength(2);
    await verify(h, 1, anchorFor(101));
    await answer(h, (c) => (claimPair(c) === ALICE ? 'unchecked' : 'proven'));
    expect(h.drive.nameChecks.get(ALICE)?.status).toBe('unchecked');
    expect(h.tipRuns).toHaveLength(2); // the second `unchecked` asks for none
    await pressCorner(h);
    expect(h.tipRuns).toHaveLength(3);
    await verify(h, 2, anchorFor(102));
    await answer(h, (c) => (claimPair(c) === ALICE ? 'unchecked' : 'proven'));
    expect(h.tipRuns).toHaveLength(4); // the press let it ask once more
  });
});

describe('the name checks — the node, the identity, the anchor', () => {
  it('a node change drops every result; a check answering for the node before writes nothing, and its batch asks no more', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await answerOne(h, 'unproven');
    await answerOne(h, 'unproven');
    expect(h.drive.nameChecks.size).toBe(2);
    expect(document.querySelector('.clay')).not.toBeNull();
    const stale = h.nameCalls.find((c) => !c.settled)!;
    void h.drive.changeNode(NODE_B);
    await flush();
    expect(h.drive.nameChecks.size).toBe(0);
    expect(document.querySelector('.clay')).toBeNull();
    const asked = h.nameCalls.length;
    stale.settled = true;
    stale.resolve(result('unproven', stale.claim));
    await flush();
    expect(h.drive.nameChecks.size).toBe(0);
    expect(document.querySelector('.clay')).toBeNull();
    expect(h.nameCalls).toHaveLength(asked);
    // The new node's own verified run checks the pairs at the new node.
    await verify(h, 1, anchorFor(90));
    const fresh = await answer(h, () => 'proven');
    expect(fresh.length).toBeGreaterThan(0);
    for (const c of fresh) expect(c.base).toBe(NODE_B);
  });

  it('an identity change keeps every result — a name\'s check reads no identity — and checks the new key\'s own name alone', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await answer(h, (c) => (claimPair(c) === ALICE ? 'unproven' : 'proven'));
    const held = new Map(h.drive.nameChecks);
    expect(held.size).toBe(ON_SCREEN.length);
    h.setKey(ME2);
    await flush();
    await flush();
    const fresh = await answer(h, () => 'proven');
    expect(fresh.map(pairOf)).toEqual([TWO]);
    for (const [pair, r] of held) expect(h.drive.nameChecks.get(pair)).toBe(r);
    // The feed read again for the new viewer still draws Alice's pair clay.
    const handle = h.feed.querySelector(`.card[data-post-id="${ROOT}"] .who .handle`)!;
    expect(handle.classList.contains('clay')).toBe(true);
  });

  it('no anchor, no request — before the first run, under a thin verdict, and after a run that throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await everySurface(h);
    h.drive.renderHeader();
    h.drive.renderFeed();
    h.drive.renderPanes();
    await flush();
    expect(h.nameCalls).toHaveLength(0);
    h.tipRuns[0]!.resolve({ verdict: { kind: 'thin', reason: 'one-node', height: 100 }, anchor: null });
    await flush();
    h.drive.openAuthor(B, { from: 'pane', ci: 5 });
    await flush();
    expect(h.nameCalls).toHaveLength(0);
    await pressCorner(h);
    h.tipRuns[1]!.reject(new Error('the run failed'));
    await flush();
    h.drive.renderPanes();
    await flush();
    expect(h.nameCalls).toHaveLength(0);
    expect(h.drive.nameChecks.size).toBe(0);
    expect(document.querySelector('.clay')).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('a check the seam fails to answer keeps no result — one console.error — the batch goes on, and a later surface asks for it again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    const failed = h.nameCalls[0]!;
    failed.settled = true;
    failed.reject(new Error('the seam failed'));
    await flush();
    const rest = await answer(h, () => 'proven');
    expect(rest).toHaveLength(ON_SCREEN.length - 1);
    expect(h.drive.nameChecks.has(pairOf(failed))).toBe(false);
    expect(h.drive.nameChecks.size).toBe(ON_SCREEN.length - 1);
    expect(errors).toHaveBeenCalledTimes(1);
    h.drive.renderFeed();
    await flush();
    const retried = await answer(h, () => 'proven');
    expect(retried.map(pairOf)).toEqual([pairOf(failed)]);
  });
});

describe('the name checks — every handle carries the pair it reads', () => {
  it('each site marks its handle with the key and the name it asks the check for; the name row marks the handle its line follows; a prefix carries none', async () => {
    const h = harness();
    await everySurface(h);
    // The reader's own root in the feed, and a reply under ROOT in the pane —
    // the who row's text variant, a card with no author control.
    h.drive.state.submissions.push(submission('own-root', null), submission('own-reply', ROOT));
    h.drive.renderFeed();
    h.drive.renderPanes();
    const pairAt = (root: Element, text: string): string | undefined => {
      const e = [...root.querySelectorAll<HTMLElement>('.handle')].find((x) => x.textContent === text);
      expect(e, `a handle reading ${text}`).toBeDefined();
      return e!.dataset.namePair;
    };
    const feedWho = (id: string): Element => h.feed.querySelector(`.card[data-post-id="${id}"] .who`)!;
    const paneWho = (ci: number, id: string): Element => col(h, ci).querySelector(`.card[data-post-id="${id}"] .who`)!;
    const bar = (ci: number): Element => col(h, ci).querySelector('.bar-label')!;
    expect(pairAt(feedWho(ROOT), '@Alice')).toBe(ALICE);
    expect(pairAt(feedWho(ROOT3), '@Dee')).toBe(DEE);
    expect(pairAt(feedWho(PEND), '@Pam')).toBe(PAM);
    expect(pairAt(feedWho('own-root'), '@Me_1')).toBe(MINE);
    expect(pairAt(bar(1), '@Alice')).toBe(ALICE);
    expect(pairAt(paneWho(1, ROOT), '@Alice')).toBe(ALICE);
    expect(pairAt(paneWho(1, REPLY), '@Bob')).toBe(BOB);
    expect(paneWho(1, 'own-reply').querySelector('span.handle')).not.toBeNull();
    expect(pairAt(paneWho(1, 'own-reply'), '@Me_1')).toBe(MINE);
    expect(pairAt(bar(2), '@Alice')).toBe(ALICE);
    expect(pairAt(rowField(col(h, 2), 'name'), '@Alice')).toBe(ALICE);
    expect(pairAt(col(h, 2).querySelector('.endorser')!, '@Vic')).toBe(VIC);
    expect(pairAt(bar(3), '@Alice')).toBe(ALICE);
    expect(pairAt(paneWho(3, ROOT), '@Alice')).toBe(ALICE);
    expect(pairAt(paneWho(4, ROOT5), '@Eve')).toBe(EVE);
    expect(pairAt(bar(5), '@Kay')).toBe(KAY);
    expect(pairAt(rowField(col(h, 5), 'name'), '@Kay')).toBe(KAY);
    expect(pairAt(col(h, 0).querySelector('.bond')!, '@Ivy')).toBe(IVY);
    expect(pairAt(rowField(col(h, 0), 'username'), '@Me_1')).toBe(MINE);
    expect(h.appbar.querySelector<HTMLElement>('button[aria-label="open profile"]')!.dataset.namePair).toBe(MINE);
    // Every handle on the page is a site; the two name rows carry the line mark.
    for (const e of document.querySelectorAll<HTMLElement>('.handle')) expect(e.dataset.namePair).toBeDefined();
    const lined = [...document.querySelectorAll<HTMLElement>('[data-name-line]')];
    expect(lined).toHaveLength(2);
    expect(lined.every((e) => rowField(col(h, 2), 'name').contains(e) || rowField(col(h, 5), 'name').contains(e))).toBe(true);
    // Eve's posts window bar is her prefix — no author window read her name.
    expect(bar(4).querySelector('.hex')).not.toBeNull();
    expect(bar(4).querySelector('[data-name-pair]')).toBeNull();
  });

  it('a card drawn with no check to read carries no pair; drawn with one, its handle carries the row\'s', () => {
    const row = post(ROOT, A, 'Alice', 'the root');
    expect(card(row, { onAuthor: () => {} }).querySelector('[data-name-pair]')).toBeNull();
    expect(card(row, {}).querySelector('[data-name-pair]')).toBeNull();
    const button = card(row, { onAuthor: () => {}, nameClay: () => false }).querySelector<HTMLElement>('button.handle')!;
    expect(button.dataset.namePair).toBe(ALICE);
    const span = card(row, { nameClay: () => false }).querySelector<HTMLElement>('span.handle')!;
    expect(span.dataset.namePair).toBe(ALICE);
    const nameless = card({ ...row, authorName: null }, { onAuthor: () => {}, nameClay: () => false });
    expect(nameless.querySelector('[data-name-pair]')).toBeNull();
  });
});

describe('the name checks — a result lands in place', () => {
  it('a result that leaves every pair ink — proven, young, unchecked — touches no node on any surface', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await flush();
    const records = observe(h);
    const inks: NameStatus[] = ['proven', 'young', 'unchecked'];
    let i = 0;
    const done = await answer(h, () => inks[i++ % inks.length]!);
    expect(done).toHaveLength(ON_SCREEN.length);
    expect(records()).toEqual([]);
  });

  it('a clay result flips that pair\'s handles and no other node — the line joins the author window\'s name row; the scroll, a composer\'s draft and focus, and a selection hold', async () => {
    const h = harness();
    await everySurface(h);
    // The reader mid-read: the feed composer open with a draft and focus, the
    // feed and every pane body scrolled, words selected in Bob's feed card.
    h.drive.openComposer(null);
    await flush();
    const textarea = h.feed.querySelector<HTMLTextAreaElement>('textarea.composer-text')!;
    textarea.value = 'a draft';
    textarea.focus();
    h.feed.scrollTop = 120;
    const bodies = [...h.panes.querySelectorAll<HTMLElement>('.region-body')];
    bodies.forEach((b, i) => { b.scrollTop = 10 + i; });
    const words = textNode(h.feed.querySelector(`.card[data-post-id="${ROOT2}"]`)!, 'second root')!;
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 6);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await verify(h, 0, anchorFor(100));
    await flush();

    const alice = marked(ALICE);
    // The feed card, the thread bar, the pane's root card, the author window's
    // bar and name row, the posts window's bar and card.
    expect(alice).toHaveLength(7);
    const nodes = [...h.appbar.querySelectorAll('*'), ...h.feed.querySelectorAll('*'), ...h.panes.querySelectorAll('*')];
    const records = observe(h);
    await answer(h, (c) => (claimPair(c) === ALICE ? 'unproven' : 'proven'));

    const rs = records();
    const attributes = rs.filter((r) => r.type === 'attributes');
    const children = rs.filter((r) => r.type === 'childList');
    expect(attributes.length + children.length).toBe(rs.length);
    expect(attributes.every((r) => r.attributeName === 'class')).toBe(true);
    expect(attributes).toHaveLength(alice.length);
    expect(new Set(attributes.map((r) => r.target))).toEqual(new Set(alice));
    for (const e of alice) expect(e.classList.contains('clay')).toBe(true);
    const nameField = rowField(col(h, 2), 'name');
    expect(children).toHaveLength(1);
    expect(children[0]!.target).toBe(nameField);
    expect(children[0]!.removedNodes).toHaveLength(0);
    expect(children[0]!.addedNodes).toHaveLength(1);
    const line = children[0]!.addedNodes[0] as HTMLElement;
    expect(line.matches('div.hint.clay')).toBe(true);
    expect(line.textContent).toBe("this node's answer for this name did not verify");
    expect(line.previousElementSibling).toBe(alice.find((e) => nameField.contains(e)));
    expect(document.querySelectorAll('.hint.clay')).toHaveLength(1);
    // Every node stands where it stood; nothing scrolled; the draft, its focus
    // and the selection are the reader's still.
    for (const n of nodes) expect(n.isConnected).toBe(true);
    expect(h.feed.scrollTop).toBe(120);
    bodies.forEach((b, i) => expect(b.scrollTop).toBe(10 + i));
    expect(h.feed.querySelector('textarea.composer-text')).toBe(textarea);
    expect(textarea.value).toBe('a draft');
    expect(document.activeElement).toBe(textarea);
    expect(selection.rangeCount).toBe(1);
    expect(selection.getRangeAt(0).startContainer).toBe(words);
    expect(selection.toString()).toBe('second');
  });

  it('a clay pair that proves on the next run turns ink where it stands, its line leaving with it', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await answer(h, (c) => (claimPair(c) === ALICE ? 'absent' : 'proven'));
    const alice = marked(ALICE);
    for (const e of alice) expect(e.classList.contains('clay')).toBe(true);
    const nameField = rowField(col(h, 2), 'name');
    const line = nameField.querySelector('.hint.clay')!;
    expect(line).not.toBeNull();
    await pressCorner(h);
    await verify(h, 1, anchorFor(101));
    await flush();
    const records = observe(h);
    await answer(h, () => 'proven');
    const rs = records();
    const attributes = rs.filter((r) => r.type === 'attributes');
    const children = rs.filter((r) => r.type === 'childList');
    expect(attributes.length + children.length).toBe(rs.length);
    expect(attributes).toHaveLength(alice.length);
    expect(new Set(attributes.map((r) => r.target))).toEqual(new Set(alice));
    for (const e of alice) {
      expect(e.isConnected).toBe(true);
      expect(e.classList.contains('clay')).toBe(false);
    }
    expect(children).toHaveLength(1);
    expect(children[0]!.target).toBe(nameField);
    expect([...children[0]!.removedNodes]).toEqual([line]);
    expect(children[0]!.addedNodes).toHaveLength(0);
    expect(document.querySelector('.clay')).toBeNull();
  });

  it('the reader\'s own name turns clay where it stands — the header word and the profile\'s username row — and nothing else moves', async () => {
    const h = harness();
    await everySurface(h);
    await verify(h, 0, anchorFor(100));
    await flush();
    const mine = marked(MINE);
    const word = h.appbar.querySelector<HTMLElement>('button[aria-label="open profile"]')!;
    const usernameHandle = rowField(col(h, 0), 'username').querySelector<HTMLElement>('.handle')!;
    expect(new Set(mine)).toEqual(new Set([word, usernameHandle]));
    const records = observe(h);
    await answer(h, (c) => (claimPair(c) === MINE ? 'no-proof' : 'proven'));
    const rs = records();
    expect(rs.every((r) => r.type === 'attributes' && r.attributeName === 'class')).toBe(true);
    expect(rs).toHaveLength(2);
    expect(new Set(rs.map((r) => r.target))).toEqual(new Set(mine));
    expect(word.classList.contains('clay')).toBe(true);
    expect(word.textContent).toBe('@Me_1');
    expect(usernameHandle.classList.contains('clay')).toBe(true);
    expect(word.isConnected).toBe(true);
  });
});

describe('the web build — no verifier', () => {
  it('asks nothing beyond the reads its surfaces make, every handle ink', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(String(url));
      return new Response('{}');
    });
    const h = harness({ verifiers: false });
    await everySurface(h);
    h.drive.openAuthor(B, { from: 'pane', ci: 5 });
    await flush();
    h.drive.openThread(ROOT2, { from: 'pane', ci: 0 });
    await flush();
    h.drive.renderHeader();
    h.drive.renderFeed();
    h.drive.renderPanes();
    await flush();
    expect(h.tipRuns).toHaveLength(0);
    expect(h.nameCalls).toHaveLength(0);
    expect(requests).toEqual([]);
    // The name reads are the surfaces' own: the reader's at the membership read
    // and the profile's open, then each author window's subject.
    expect([...h.world.usernameByOwner].sort()).toEqual([ME, ME, A, K, B].sort());
    expect(h.world.usernameByName).toBe(0);
    expect(h.drive.nameChecks.size).toBe(0);
    expect(document.querySelector('.clay')).toBeNull();
    expect(document.querySelectorAll('.handle').length).toBeGreaterThan(0);
  });
});
