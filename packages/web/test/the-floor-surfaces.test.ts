// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { profileBody, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { karmaResult } from './karma-fixture';
import { prefs, setNode } from '../src/prefs';
import { KARMA_MINIMUM, LIKE_KARMA_COST, USERNAME_BURN_PRICE } from '@dagsocial/types';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { BlockCurrent, FeedResult, KarmaResult, PostResult, StatusResult, CreditsResult } from '../src/api/dto';
import type { WriteClient, LikeSubmitResult } from '../src/api/write';
import type { Origin } from '../src/model/workspace';
import type { UsernameResult } from '../src/api/dto';

// WEB_INTERFACE → The wallet → "The floor is the client's to know":
//   What a surface offers reads the number the `rep` row shows.
// WEB_INTERFACE → The author window: the `your vouch` row's reason
//   *the last N rep is for posting* below `VOUCH_MIN_BALANCE`.
// WEB_INTERFACE → The username row: `burn`'s title
//   *a burn costs N rep, and the last M rep is for posting; this key has less*
//   while the floor would be crossed.
// WEB_INTERFACE → The wallet → "`like` stays live at the floor": a press the
//   row's number refuses answers *like not sent: the last N rep is for posting.*
//   in the report line and moves no count.

const KEY = 'ab'.repeat(32);
const ORIGIN: Origin = { from: 'pane', ci: 0 };
const unlocked = { pubKeyHex: KEY, locked: false };

// ---------------------------------------------------------------------------
// Profile view — burn's title at the floor's gate
// ---------------------------------------------------------------------------

function profileHandlers(over: Partial<ProfileHandlers> = {}): ProfileHandlers {
  return {
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: KEY }),
    draftIdentity: async () => ({ pubKeyHex: KEY }),
    createIdentity: async () => {},
    discardDraft: () => {},
    importIdentity: async () => {},
    exportIdentity: async () => {},
    forgetIdentity: async () => {},
    lockIdentity: async () => {},
    unlockIdentity: async () => {},
    askFaucet: () => {},
    invite: () => {},
    openAuthor: () => {},
    vouch: () => {},
    moreBonds: () => {},
    claimUsername: () => {},
    burnUsername: () => {},
    ...over,
  };
}

const HELD_NAME: UsernameResult = { name: 'Alice', owner: KEY, boxId: '44'.repeat(32), claimedAtBlock: 5000 };

function profileCtx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return {
    identity: unlocked,
    backedUp: false,
    karma: karmaResult({ userId: KEY, member: true, invitesAvailable: 2, memberSinceBlock: 5 }),
    karmaPlain: null,
    grant: null,
    invite: null,
    canAffordMinBond: false,
    bonds: null,
    inviteFlight: null,
    ownName: HELD_NAME,
    ownNameLoaded: true,
    usernameFlight: null,
    pendingUsername: null,
    canSignClaim: false,
    canAffordBurn: false,
    nameClay: () => false,
    verdict: undefined,
    figures: null,
    ...over,
  };
}

const renderProfile = (c: ProfileCtx): HTMLElement => profileBody(profileHandlers(), () => c, () => ORIGIN).el;

function burnButton(body: HTMLElement): HTMLButtonElement | null {
  for (const b of body.querySelectorAll('button')) if (b.textContent === 'burn') return b as HTMLButtonElement;
  return null;
}

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
});

describe('the username row — burn\'s title names the floor', () => {
  it.fails('burn is disabled with the floor-naming title while canAffordBurn is false', () => {
    const burn = burnButton(renderProfile(profileCtx({ canAffordBurn: false })));
    // WEB_INTERFACE → The username row — the title names the price and the
    // floor: *a burn costs N rep, and the last M rep is for posting; this
    // key has less* — M is KARMA_MINIMUM.
    expect({ disabled: burn?.disabled, title: burn?.title ?? '' })
      .toEqual({ disabled: true, title: `a burn costs ${USERNAME_BURN_PRICE} rep, and the last ${KARMA_MINIMUM} rep is for posting; this key has less` });
  });

  it('burn is enabled while canAffordBurn is true', () => {
    const burn = burnButton(renderProfile(profileCtx({ canAffordBurn: true })));
    expect({ disabled: burn?.disabled, title: burn?.title ?? '' }).toEqual({ disabled: false, title: '' });
  });
});

const AUTHOR = 'cd'.repeat(32);

// ---------------------------------------------------------------------------
// App — the composer's `post` and the like press at the floor
// ---------------------------------------------------------------------------

const PUB = KEY;
const BOX = '55'.repeat(32);
const TARGET1 = 'c1'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function appStatus(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function confirmedPost(id: string, likedByViewer: boolean | null = false): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: AUTHOR, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer, confirmedAuthor: AUTHOR, txId: 'ff'.repeat(32),
  };
}

/** Build the App with a karma whose face covers but whose `effective` is a
 *  stated bigint. The feed carries one post the viewer has not liked, so
 *  `pressLike` has a target. */
function appHarness(opts: { effective: bigint; faceValue: bigint; feedPost?: string }) {
  const signCalls: string[] = [];
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: async (_bytes, t) => { signCalls.push(t); return { signature: 'ab'.repeat(64) }; },
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  };
  const karma: KarmaResult = karmaResult({
    userId: PUB,
    total: opts.faceValue.toString(),
    effective: opts.effective.toString(),
    boxes: [{ boxId: BOX, value: opts.faceValue.toString() }],
    boxCount: 1,
    height: 6000,
    member: true,
    memberSinceBlock: 100,
  });
  let karmaN = 0;
  let likeN = 0;
  const feedPostId = opts.feedPost ?? TARGET1;
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [confirmedPost(feedPostId)], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id, false),
    status: async () => appStatus(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async () => { karmaN++; return karma; },
    credits: async (): Promise<CreditsResult> => ({ userId: PUB, total: '0', boxes: [], boxCount: 0, next: null }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    usernameByName: async () => null,
  };
  const last = (): string => signCalls[signCalls.length - 1] ?? '';
  const writeClient = {
    submitPost: async () => ({ postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: last() }),
    submitLike: async (): Promise<LikeSubmitResult> => { likeN++; return { status: 'pending', txId: last(), expiresAtHeight: 6720 }; },
    submitVouch: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720 }),
    submitUnvouch: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720 }),
    submitInvite: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720, bondBoxId: 'bb'.repeat(32) }),
    submitWithdraw: async () => ({ status: 'submitted', txId: last(), postId: 'x', expiresAtHeight: 6720 }),
    submitClaim: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720, name: 'x' }),
    submitBurn: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720 }),
    submitSend: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720 }),
  } as unknown as WriteClient;

  const ledger = new PendingLedger(PUB);
  const app = new App(fakeApi, writeClient, identity, ledger);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);

  return {
    app,
    karmaReads: () => karmaN,
    likePosts: () => likeN,
    drive: app as unknown as {
      likePost(postId: string): Promise<void>;
      openComposer(parentId: string | null): void;
      composers: Map<string, { el: HTMLElement }>;
      optimisticLikes: Set<string>;
      state: { feed: { report: string | null } };
      loadFeed(): Promise<void>;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  setNode('');
});

describe('the composer\'s `post` reads the view\'s `effective`, not the face', () => {
  it.fails('a face above the price and an `effective` below it disables `post`', async () => {
    const h = appHarness({ effective: 2n, faceValue: 100n });
    await flush();
    h.drive.openComposer(null);
    await flush();
    const ctrl = h.drive.composers.get('@feed')!;
    const post = [...ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'post') as HTMLButtonElement;
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    expect({ disabled: post.disabled, karma: ctrl.el.querySelector('.karma')?.textContent })
      .toEqual({ disabled: true, karma: 'not enough rep to post right now' });
  });
});

describe('the like press at the floor', () => {
  it.fails('press at effective = KARMA_MINIMUM reads no /karma, moves no count, sends nothing, and the report line is the floor sentence', async () => {
    const h = appHarness({ effective: KARMA_MINIMUM, faceValue: 100n });
    await h.drive.loadFeed();
    await flush();
    const likePostsBefore = h.likePosts();
    const karmaReadsBefore = h.karmaReads();
    await h.drive.likePost(TARGET1);
    await flush();
    expect({
      extraKarmaReads: h.karmaReads() - karmaReadsBefore,
      extraPosts: h.likePosts() - likePostsBefore,
      overlay: h.drive.optimisticLikes.has(TARGET1),
      report: h.drive.state.feed.report,
    }).toEqual({
      extraKarmaReads: 0,
      extraPosts: 0,
      overlay: false,
      report: 'like not sent: the last 10 rep is for posting.',
    });
  });

  it('press at effective = KARMA_MINIMUM + LIKE_KARMA_COST sends', async () => {
    const h = appHarness({ effective: KARMA_MINIMUM + LIKE_KARMA_COST, faceValue: 100n });
    await h.drive.loadFeed();
    await flush();
    const likePostsBefore = h.likePosts();
    await h.drive.likePost(TARGET1);
    await flush();
    expect(h.likePosts() - likePostsBefore).toBe(1);
  });
});
