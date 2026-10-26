// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { karmaResult } from './karma-fixture';
import { setNode, prefs } from '../src/prefs';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient, Rejection } from '../src/api/write';
import type {
  BlockCurrent, CreditsResult, FeedResult, KarmaResult, PostResult, StatusResult, UsernameResult,
  VouchesTargetResult, VouchesVoucherResult,
} from '../src/api/dto';

// WEB_INTERFACE → The wallet → "A rejection's words follow the node's
// message, never its status alone": the pool's box conflict reads *that
// rep is still tied up in a spend that has not landed.* on every rep
// surface, with its existing prefix. The cases drive each surface
// through the App's own flows and read the line the App renders.

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const BOX = '11'.repeat(32);
const NAME_BOX = '22'.repeat(32);
const USERNAME_BOX = '33'.repeat(32);
const INVITEE = 'cc'.repeat(32);
const TARGET1 = 'c1'.repeat(32);
const POST_ID = 'dd'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const BOX_CONFLICT: Rejection = {
  status: 409,
  message: `Input ${NAME_BOX} is already spent by a pending transaction`,
};
const BOX_CONFLICT_LINE = 'that rep is still tied up in a spend that has not landed.';

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '10', inviteBondMax: '1000', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function confirmedPost(id: string, author: string = AUTHOR, likedByViewer: boolean | null = false): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer, confirmedAuthor: author, txId: 'ff'.repeat(32),
  };
}

/** Build the App with a controllable write client and a `profileKarma`/`status`
 *  pre-populated so a flow runs its full path and lands on the surface line
 *  the rejection drives it to. */
function appHarness(opts: {
  rejection?: Rejection;
  heldName?: UsernameResult | null;
  likedByViewer?: boolean | null;
  feedPostId?: string;
}) {
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  } as unknown as AppIdentity;

  const karma: KarmaResult = karmaResult({
    userId: PUB, total: '1000', effective: '1000',
    boxes: [{ boxId: BOX, value: '1000' }], boxCount: 1,
    height: 6000, member: true, memberSinceBlock: 100,
  });
  const feedPostId = opts.feedPostId ?? TARGET1;
  const held = opts.heldName ?? null;

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [confirmedPost(feedPostId, AUTHOR, opts.likedByViewer ?? null)], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id, AUTHOR, opts.likedByViewer ?? null),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async () => karma,
    credits: async (): Promise<CreditsResult> => ({ userId: PUB, total: '0', boxes: [], boxCount: 0, next: null }),
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => held,
    usernameByName: async () => null,
  };

  const r = opts.rejection;
  // Each write route answers `r` as its rejection when set; else a plain OK.
  const writeClient = {
    submitPost: async () => r ?? { postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: '00'.repeat(32) },
    submitLike: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720 },
    submitVouch: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720 },
    submitUnvouch: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720 },
    submitInvite: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720, bondBoxId: USERNAME_BOX },
    submitWithdraw: async () => r ?? { status: 'submitted', txId: '00'.repeat(32), postId: feedPostId, expiresAtHeight: 6720 },
    submitClaim: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720, name: 'Alice' },
    submitBurn: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720 },
    submitSend: async () => r ?? { status: 'pending', txId: '00'.repeat(32), expiresAtHeight: 6720 },
  } as unknown as WriteClient;

  const ledger = new PendingLedger(PUB);
  const app = new App(fakeApi, writeClient, identity, ledger);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  // Populate `profileKarma`/`state.status` so each flow's floor check passes.
  const raw = app as unknown as { profileKarma: KarmaResult | null; state: { status: StatusResult | null; authors: Map<string, { flight: { stage: string; reason?: string } | null }> }; ownName: UsernameResult | null; usernameFlight: { stage: string; reason?: string } | null; inviteFlight: { stage: string; reason?: string } | null };
  raw.profileKarma = karma;
  raw.state.status = statusResult();
  raw.ownName = held;

  return {
    app,
    raw,
    drive: app as unknown as {
      likePost(id: string): Promise<void>;
      withdrawPost(id: string): Promise<void>;
      vouch(key: string): Promise<void>;
      invite(inviteeKey: string, bond: bigint): Promise<void>;
      claimUsername(name: string): Promise<void>;
      burnUsername(): Promise<void>;
      openComposer(parentId: string | null): void;
      submitComposer(parentId: string | null, text: string): Promise<void>;
      openAuthor(key: string, origin: unknown): void;
      loadFeed(): Promise<void>;
      composers: Map<string, { el: HTMLElement }>;
      state: { feed: { report: string | null }; authors: Map<string, { flight: { stage: string; reason?: string } | null }> };
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  setNode('');
});

// WEB_INTERFACE → The wallet → "A rejection's words follow the node's
// message, never its status alone".
describe('each rep surface reads the box-conflict sentence from the node\'s message', () => {
  it('post: the submission card the composer collapses into reads the floor sentence', async () => {
    // The box-conflict comes back from the node after sign — the composer has
    // collapsed into the pending submission card, which carries the reason as
    // the surface line (WEB_INTERFACE → The wallet → "A rejection's words
    // follow the node's message, never its status alone").
    const h = appHarness({ rejection: BOX_CONFLICT });
    await h.drive.loadFeed();
    await flush();
    h.drive.openComposer(null);
    await flush();
    const ctrl = h.drive.composers.get('@feed')!;
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    await h.drive.submitComposer(null, 'a thread');
    const sub = (h.app as unknown as { state: { submissions: Array<{ reason: string | null; stage: string }> } }).state.submissions[0]!;
    expect({ stage: sub.stage, reason: sub.reason }).toEqual({ stage: 'rejected', reason: BOX_CONFLICT_LINE });
  });

  it('like: the card\'s report line reads *like rejected: that rep is still tied up …*', async () => {
    const h = appHarness({ rejection: BOX_CONFLICT, likedByViewer: false });
    await h.drive.loadFeed();
    await flush();
    await h.drive.likePost(TARGET1);
    await flush();
    expect(h.drive.state.feed.report).toBe('like rejected: ' + BOX_CONFLICT_LINE);
  });

  it('vouch: the `your vouch` row\'s flight line reads *vouch rejected: that rep is still tied up …*', async () => {
    const h = appHarness({ rejection: BOX_CONFLICT });
    await h.drive.loadFeed();
    await flush();
    h.drive.openAuthor(AUTHOR, { from: 'feed' });
    await flush();
    await h.drive.vouch(AUTHOR);
    await flush();
    const authorData = (h.app as unknown as { authorData: Map<string, { flight: { stage: string; reason?: string } | null }> }).authorData;
    expect(authorData.get(AUTHOR)?.flight?.reason).toBe('vouch rejected: ' + BOX_CONFLICT_LINE);
  });

  it('invite: the invites row\'s flight line reads *invite rejected: that rep is still tied up …*', async () => {
    const h = appHarness({ rejection: BOX_CONFLICT });
    await h.drive.loadFeed();
    await flush();
    await h.drive.invite(INVITEE, 100n);
    await flush();
    expect(h.raw.inviteFlight?.reason).toBe('invite rejected: ' + BOX_CONFLICT_LINE);
  });

  it('withdraw: the column\'s report line reads *withdraw rejected: that rep is still tied up …*', async () => {
    // The reader's own post, so `withdrawPost` can run; the feed carries it,
    // so the report line lands on the feed.
    const h = appHarness({ rejection: BOX_CONFLICT, feedPostId: POST_ID });
    // The feed's post is the reader's own, so `withdrawPost` runs its flight;
    // the write answers the box conflict and the report lands on the feed.
    (h.raw as unknown as { state: { feed: { posts: PostResult[] } } }).state.feed.posts = [confirmedPost(POST_ID, PUB)];
    await flush();
    await h.drive.withdrawPost(POST_ID);
    await flush();
    expect(h.drive.state.feed.report).toBe('withdraw rejected: ' + BOX_CONFLICT_LINE);
  });

  it('claim: the username row\'s flight line reads *claim rejected: that rep is still tied up …*', async () => {
    const h = appHarness({ rejection: BOX_CONFLICT });
    await h.drive.loadFeed();
    await flush();
    await h.drive.claimUsername('Alice');
    await flush();
    expect(h.raw.usernameFlight?.reason).toBe('claim rejected: ' + BOX_CONFLICT_LINE);
  });

  it('burn: the username row\'s flight line reads *burn rejected: that rep is still tied up …*', async () => {
    const held: UsernameResult = { name: 'Alice', owner: PUB, boxId: NAME_BOX, claimedAtBlock: 5000 };
    const h = appHarness({ rejection: BOX_CONFLICT, heldName: held });
    await h.drive.loadFeed();
    await flush();
    await h.drive.burnUsername();
    await flush();
    expect(h.raw.usernameFlight?.reason).toBe('burn rejected: ' + BOX_CONFLICT_LINE);
  });
});

describe('a like the node already holds reads from the node\'s own words', () => {
  it('like answered 400 Already liked this post reads *like rejected: you have already liked this post*', async () => {
    const alreadyLiked: Rejection = { status: 400, message: 'Already liked this post' };
    const h = appHarness({ rejection: alreadyLiked, likedByViewer: false });
    await h.drive.loadFeed();
    await flush();
    await h.drive.likePost(TARGET1);
    await flush();
    expect(h.drive.state.feed.report).toBe('like rejected: you have already liked this post');
  });
});

// WEB_INTERFACE → The withdraw control — the node's known refusals mapped
// to sentences; a pending withdrawal is not a withdrawn post.
describe('a withdraw of a post the node already holds pending reads the pending line', () => {
  it('withdraw answered 409 "A withdrawal of this post is already pending" reads *withdraw rejected: a withdrawal of this post is already pending.*', async () => {
    const alreadyPending: Rejection = {
      status: 409,
      message: 'A withdrawal of this post is already pending',
    };
    const h = appHarness({ rejection: alreadyPending, feedPostId: POST_ID });
    (h.raw as unknown as { state: { feed: { posts: PostResult[] } } }).state.feed.posts = [confirmedPost(POST_ID, PUB)];
    await flush();
    await h.drive.withdrawPost(POST_ID);
    await flush();
    expect(h.drive.state.feed.report).toBe('withdraw rejected: a withdrawal of this post is already pending.');
  });
});
