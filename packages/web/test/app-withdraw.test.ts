// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, AppState } from '../src/model/state';
import type { WriteClient, Rejection, WithdrawSubmitResult } from '../src/api/write';
import type {
  KarmaResult, PostJson, PostResult, StatusResult, ThreadResult, FeedResult, BlockCurrent, WithdrawnJson,
} from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// The App's withdraw wiring: the flight in the slot, the poll's landing that
// replaces the row in place, the expiry, and the rejection endings — driven over
// fakes and asserted on state and the rendered pane. card.test.ts covers the
// control's own DOM; here an identity is always loaded and owns the post.

const PUB = 'aa'.repeat(32);   // the reader
const S = 'bb'.repeat(32);     // another author, replying
const OTHER = 'cc'.repeat(32); // a root by someone else
const BOX = '11'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6001, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function postJson(id: string, author: string, parentRefs: string[] = []): PostJson {
  return {
    id, content: 'x', contentHash: contentHashHex('x'), author, parentRefs, protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, likedByViewer: null,
  };
}
const asResult = (p: PostJson): PostResult => ({ ...p, confirmedAuthor: p.author });
function tomb(id: string, parentRefs: string[]): PostResult {
  return { kind: 'withdrawn', id, author: PUB, withdrawnAtHeight: 6002, parentRefs, confirmedAuthor: PUB } as WithdrawnJson & { confirmedAuthor: string | null };
}

interface WithdrawResp { kind: 'ok' | 'reject' | 'throw'; }

function harness(resp: WithdrawResp = { kind: 'ok' }) {
  const signCalls: string[] = [];
  let listener: ((id: { pubKeyHex: string } | null) => void) | null = null;
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: (t) => { signCalls.push(t); return 'ab'.repeat(64); },
    draft: () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: () => {},
    forget: () => {},
    backedUp: () => false,
    onChange: (l) => { listener = l; },
  };
  const last = (): string => signCalls[signCalls.length - 1]!;
  let blockHeight = 6001;

  // The node's current view of each post — flipped to a tombstone on withdrawal.
  const nodePosts = new Map<string, PostResult>();
  const nodeThreads = new Map<string, ThreadResult>();
  let feedPosts: PostJson[] = [];

  const karma: KarmaResult = karmaResult({ userId: PUB, total: '227', effective: '227', boxes: [{ boxId: BOX, value: '227' }], boxCount: 1, height: 6001 });
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: feedPosts, next: null, pending: [], pendingCount: 0 }),
    thread: async (id) => nodeThreads.get(id) ?? null,
    post: async (id) => nodePosts.get(id) ?? null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: blockHeight, hash: null }),
    karma: async () => karma,
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
  };
  const writeClient = {
    submitWithdraw: async (postId: string): Promise<WithdrawSubmitResult | Rejection> => {
      if (resp.kind === 'throw') throw new Error('node unreachable');
      if (resp.kind === 'reject') return { status: 403, message: 'not the post author' };
      return { status: 'submitted', txId: last(), postId, expiresAtHeight: 6720 };
    },
  } as unknown as WriteClient;

  const ledger = new PendingLedger(PUB);
  const app = new App(fakeApi, writeClient, identity, ledger);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);

  const drive = app as unknown as {
    withdrawPost(postId: string): Promise<void>;
    pollTick(): Promise<void>;
    loadFeed(): Promise<void>;
    loadMembershipState(): Promise<void>;
    openThread(id: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
    state: AppState;
    withdrawFlights: Map<string, unknown>;
  };

  return {
    app, ledger, panes, drive, feed,
    setHeight: (h: number) => { blockHeight = h; },
    setNode: (id: string, p: PostResult) => nodePosts.set(id, p),
    setThread: (id: string, t: ThreadResult) => nodeThreads.set(id, t),
    setFeed: (posts: PostJson[]) => { feedPosts = posts; },
    fireIdentityChange: () => listener?.({ pubKeyHex: PUB }),
  };
}

const singleThread = (root: PostJson, descendants: PostJson[]): ThreadResult => ({
  post: root, ancestors: [], ancestorCount: 0, descendants, descendantCount: descendants.length,
  next: null, pending: [], pendingCount: 0,
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => { vi.useRealTimers(); });

/** An open pane on a thread whose root is the reader's own post P, one reply by S
 *  beneath it; the feed holds P. profileKarma loaded so canSignWithdraw is true. */
async function ownRootOpen(h: ReturnType<typeof harness>): Promise<{ P: string; R: string }> {
  const P = 'd'.repeat(64), R = 'e'.repeat(64);
  const root = postJson(P, PUB);
  const reply = postJson(R, S, [P]);
  h.setNode(P, asResult(root));
  h.setNode(R, asResult(reply));
  h.setThread(P, singleThread(root, [reply]));
  h.setFeed([root]);
  await h.drive.loadFeed();
  await h.drive.loadMembershipState(); // profileKarma → canSignWithdraw
  h.drive.openThread(P, { from: 'feed' });
  await flush();
  return { P, R };
}

describe('the App withdraw flight', () => {
  it('renders submitting… synchronously, then submitted from the ledger on a 2xx', async () => {
    const h = harness();
    const { P } = await ownRootOpen(h);
    const p = h.drive.withdrawPost(P); // not awaited — the sync prefix set the flight and rendered
    expect(h.panes.querySelector('.stage')?.textContent).toBe('submitting…');
    await p;
    // The transient flight stepped aside; the ledger's entry renders 'submitted'.
    expect(h.drive.withdrawFlights.has(P)).toBe(false);
    expect(h.ledger.all().map((e) => e.kind)).toEqual(['withdraw']);
    expect(h.panes.querySelector('.stage')?.textContent).toBe('submitted');
  });

  it('the poll lands it: the pane root becomes the withdrawn card with the reply beneath, the feed drops it', async () => {
    const h = harness();
    const { P, R } = await ownRootOpen(h);
    await h.drive.withdrawPost(P);
    // A second unrelated thread, to prove the landing does not tear it down.
    const other = postJson('f'.repeat(64), OTHER);
    h.setNode(other.id, asResult(other));
    h.setThread(other.id, singleThread(other, []));
    h.drive.openThread(other.id, { from: 'pane', ci: 1 });
    await flush();
    const region2Before = h.panes.querySelectorAll('.region')[1];

    // The node now answers a tombstone for P; the poll reconciles on a height move.
    h.setNode(P, tomb(P, []));
    h.setHeight(6002);
    await h.drive.pollTick();

    // The pane's root is the withdrawn card, the reply still beneath it — scoped
    // to P's region (the second region holds an unrelated post).
    const region0 = h.panes.querySelectorAll('.region')[0]!;
    expect(region0.querySelector('.withdrawn')?.textContent).toContain('withdrawn by its author');
    expect(region0.querySelectorAll('.card-content').length).toBe(1); // only the reply keeps content
    // Dropped from the feed and the live-post index; the entry cleared.
    expect(h.drive.state.feed.posts.some((x) => x.id === P)).toBe(false);
    expect(h.drive.state.posts.has(P)).toBe(false);
    expect(h.ledger.size).toBe(0);
    // The unrelated region survived by reference — nothing else re-rendered.
    expect(h.panes.querySelectorAll('.region')[1]).toBe(region2Before);
    void R;
  });

  it('a withdrawn reply lands at its own depth, its child beneath it', async () => {
    const h = harness();
    // P (by OTHER) → R (the reader's own) → G (by S).
    const P = 'a'.repeat(64), R = 'b'.repeat(64), G = 'c'.repeat(64);
    const root = postJson(P, OTHER);
    const mine = postJson(R, PUB, [P]);
    const grand = postJson(G, S, [R]);
    h.setNode(R, asResult(mine));
    h.setThread(P, singleThread(root, [mine, grand]));
    h.setFeed([mine]);
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    h.drive.openThread(P, { from: 'feed' });
    await flush();

    await h.drive.withdrawPost(R);
    h.setNode(R, tomb(R, [P])); // the tombstone keeps its parentRef
    h.setHeight(6002);
    await h.drive.pollTick();

    // R renders as the withdrawn card at depth 1; G stays beneath it at depth 2.
    const withdrawn = h.panes.querySelector('.card.depth-1 .withdrawn');
    expect(withdrawn).not.toBeNull();
    expect(h.panes.querySelector('.card.depth-2')).not.toBeNull();
    expect(h.drive.state.feed.posts.some((x) => x.id === R)).toBe(false);
  });

  it('expired renders the sentence and try again; try again submits anew', async () => {
    const h = harness();
    const { P } = await ownRootOpen(h);
    await h.drive.withdrawPost(P);
    expect(h.ledger.size).toBe(1);
    // The tip passes the expiry with no tombstone — expired.
    h.setHeight(6721);
    await h.drive.pollTick();
    expect(h.ledger.size).toBe(0);
    const stage = h.panes.querySelector('.stage')!;
    expect(stage.textContent).toContain('no block took this by height');
    expect(stage.textContent).toContain('6,720');
    // `try again` rebuilds and submits — a fresh entry lands.
    const again = [...h.panes.querySelectorAll('button')].find((b) => b.textContent === 'try again')!;
    again.click();
    await flush();
    expect(h.ledger.all().map((e) => e.kind)).toEqual(['withdraw']);
  });

  it('a rejection reports in the region line and returns the control, leaving nothing pending', async () => {
    const h = harness({ kind: 'reject' });
    const { P } = await ownRootOpen(h);
    await h.drive.withdrawPost(P);
    expect(h.ledger.size).toBe(0);
    expect(h.drive.withdrawFlights.has(P)).toBe(false);
    // The region's report line names the rejection; the withdraw control is back.
    const region = h.panes.querySelector('.region');
    expect(region?.textContent).toContain('withdraw rejected: not the post author');
    expect(h.panes.querySelector('.withdraw-ctl')).not.toBeNull();
  });

  it('a transport failure ends the flight and leaves nothing pending', async () => {
    const h = harness({ kind: 'throw' });
    const { P } = await ownRootOpen(h);
    await h.drive.withdrawPost(P);
    expect(h.ledger.size).toBe(0);
    expect(h.drive.withdrawFlights.has(P)).toBe(false);
    const region = h.panes.querySelector('.region');
    expect(region?.textContent).toContain("withdraw rejected: can't reach the node right now.");
    expect(h.panes.querySelector('.withdraw-ctl')).not.toBeNull();
  });

  it('an identity change clears the transient withdraw flights', async () => {
    const h = harness();
    const { P } = await ownRootOpen(h);
    // Drive an expired flight into the map, then change identity.
    await h.drive.withdrawPost(P);
    h.setHeight(6721);
    await h.drive.pollTick();
    expect(h.drive.withdrawFlights.has(P)).toBe(true);
    h.fireIdentityChange();
    expect(h.drive.withdrawFlights.size).toBe(0);
  });
});
