// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import { karmaResult } from './karma-fixture';
import { prefs, setNode } from '../src/prefs';
import { KARMA_MINIMUM, LIKE_KARMA_COST, POST_PRICE_THREAD, USERNAME_BURN_PRICE, VOUCH_MIN_BALANCE } from '@dagsocial/types';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { BlockCurrent, FeedResult, KarmaResult, PostResult, StatusResult, CreditsResult } from '../src/api/dto';
import type { WriteClient, LikeSubmitResult } from '../src/api/write';

// WEB_INTERFACE → The wallet → "The floor is the client's to know" —
// each gate boundary read one rep either side of its own rule, driven
// through the App over its spendable-view fakes.

const PUB = 'ab'.repeat(32);
const AUTHOR = 'cd'.repeat(32);
const BOX = '55'.repeat(32);
const TARGET1 = 'c1'.repeat(32);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function statusWith(inviteBondMin: string, inviteBondMax: string): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin, inviteBondMax, membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function confirmedPost(id: string, likedByViewer: boolean | null = false): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: AUTHOR, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer, confirmedAuthor: AUTHOR, txId: 'ff'.repeat(32),
  };
}

/** Build the App over fakes with a stated effective and face. The App's
 *  `profileKarma` and `state.status` are set directly so each boundary case
 *  reads the number the App's rule reads, with no await on the mount's own
 *  reads. */
function buildApp(opts: { effective: bigint; faceValue: bigint; inviteBondMin?: string; inviteBondMax?: string }) {
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
  const status = statusWith(opts.inviteBondMin ?? '100', opts.inviteBondMax ?? '1000');
  let karmaN = 0;
  let likeN = 0;
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [confirmedPost(TARGET1)], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id, false),
    status: async () => status,
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

  // Set the number the App's rule reads, so the boundary cases hold the
  // gate they test without racing the mount's own reads.
  const raw = app as unknown as { profileKarma: KarmaResult | null; state: { status: StatusResult | null } };
  raw.profileKarma = karma;
  raw.state.status = status;

  return {
    app,
    priv: app as unknown as {
      canAffordMinBond(): boolean;
      canAffordBurn(): boolean;
      inviteBondMaxForForm(): string | null;
      yourVouchFor(key: string): { kind: string; text?: string } | null;
    },
    drive: app as unknown as {
      likePost(postId: string): Promise<void>;
      openComposer(parentId: string | null): void;
      composers: Map<string, { el: HTMLElement }>;
      optimisticLikes: Set<string>;
      state: { feed: { report: string | null } };
      loadFeed(): Promise<void>;
      profileKarma: KarmaResult | null;
    },
    karmaReads: () => karmaN,
    likePosts: () => likeN,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});

beforeEach(() => {
  localStorage.clear();
});

// WEB_INTERFACE → The profile window → "The `invites` row" — the form is
// shown while `effective − inviteBondMin ≥ KARMA_MINIMUM`.
describe('the invite form is shown at the floor boundary', () => {
  it('absent at effective = inviteBondMin + KARMA_MINIMUM − 1', () => {
    const bondMin = 100n;
    const h = buildApp({ effective: bondMin + KARMA_MINIMUM - 1n, faceValue: 1000n, inviteBondMin: bondMin.toString() });
    expect(h.priv.canAffordMinBond()).toBe(false);
  });

  it('present at effective = inviteBondMin + KARMA_MINIMUM', () => {
    const bondMin = 100n;
    const h = buildApp({ effective: bondMin + KARMA_MINIMUM, faceValue: 1000n, inviteBondMin: bondMin.toString() });
    expect(h.priv.canAffordMinBond()).toBe(true);
  });
});

// WEB_INTERFACE → The profile window → "The `invites` row" — the bond's
// `max` is the lesser of the network's and `effective − KARMA_MINIMUM`.
describe('the bond field\'s max is the lesser of the network\'s and effective minus the floor', () => {
  it('effective − KARMA_MINIMUM is the lesser: the form max reads it', () => {
    // headroom = 50 - 10 = 40; networkMax = 1000; the form reads 40.
    const h = buildApp({ effective: 50n, faceValue: 1000n, inviteBondMin: '10', inviteBondMax: '1000' });
    expect(h.priv.inviteBondMaxForForm()).toBe('40');
  });

  it('inviteBondMax is the lesser: the form max reads it', () => {
    // headroom = 10_000 - 10 = 9990; networkMax = 1000; the form reads 1000.
    const h = buildApp({ effective: 10_000n, faceValue: 20_000n, inviteBondMin: '10', inviteBondMax: '1000' });
    expect(h.priv.inviteBondMaxForForm()).toBe('1000');
  });
});

// WEB_INTERFACE → The username row — `burn` is enabled while
// `effective − USERNAME_BURN_PRICE ≥ KARMA_MINIMUM`.
describe('burn is enabled at the floor boundary', () => {
  it('enabled at effective = USERNAME_BURN_PRICE + KARMA_MINIMUM', () => {
    const h = buildApp({ effective: USERNAME_BURN_PRICE + KARMA_MINIMUM, faceValue: 1000n });
    expect(h.priv.canAffordBurn()).toBe(true);
  });

  it('disabled at effective = USERNAME_BURN_PRICE + KARMA_MINIMUM − 1', () => {
    const h = buildApp({ effective: USERNAME_BURN_PRICE + KARMA_MINIMUM - 1n, faceValue: 1000n });
    expect(h.priv.canAffordBurn()).toBe(false);
  });
});

// WEB_INTERFACE → The author window — the `your vouch` row's reason
// *the last N rep is for posting* below `VOUCH_MIN_BALANCE`.
describe('the `your vouch` row reads the floor sentence at the boundary', () => {
  it('reason text at effective = VOUCH_MIN_BALANCE − 1 is the floor sentence', () => {
    const h = buildApp({ effective: VOUCH_MIN_BALANCE - 1n, faceValue: 100n });
    const yv = h.priv.yourVouchFor(AUTHOR);
    expect(yv).toEqual({ kind: 'reason', text: `the last ${KARMA_MINIMUM} rep is for posting` });
  });

  it('vouch control (not a reason) at effective = VOUCH_MIN_BALANCE', () => {
    const h = buildApp({ effective: VOUCH_MIN_BALANCE, faceValue: 100n });
    const yv = h.priv.yourVouchFor(AUTHOR);
    expect(yv?.kind).not.toBe('reason');
  });
});

// WEB_INTERFACE → Invariants → "Affordability is known before the attempt" —
// the composer's `post` is enabled at `effective = price`.
describe('the composer\'s post is enabled at effective = the price', () => {
  it('post enabled at effective = POST_PRICE_THREAD', async () => {
    const h = buildApp({ effective: POST_PRICE_THREAD, faceValue: 1000n });
    await flush();
    h.drive.openComposer(null);
    await flush();
    const ctrl = h.drive.composers.get('@feed')!;
    const post = [...ctrl.el.querySelectorAll('button')].find((b) => b.textContent === 'post') as HTMLButtonElement;
    const ta = ctrl.el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'a thread';
    ta.dispatchEvent(new Event('input'));
    expect(post.disabled).toBe(false);
  });
});

// WEB_INTERFACE → The wallet → "`like` stays live at the floor" — a press
// one above the floor sends; a press with no karma read answered yet hands
// the press to the flow.
describe('the like press at the floor boundary', () => {
  it('press at effective = KARMA_MINIMUM + LIKE_KARMA_COST sends', async () => {
    const h = buildApp({ effective: KARMA_MINIMUM + LIKE_KARMA_COST, faceValue: 1000n });
    await h.drive.loadFeed();
    await flush();
    const likeBefore = h.likePosts();
    await h.drive.likePost(TARGET1);
    await flush();
    expect(h.likePosts() - likeBefore).toBe(1);
  });

  it('press with profileKarma null sends its flow, which at the floor ends with no POST, overlay undone, and the report line is the floor sentence', async () => {
    const h = buildApp({ effective: KARMA_MINIMUM, faceValue: 1000n });
    await h.drive.loadFeed();
    await flush();
    // Clear `profileKarma` to hand the press to the flow's own read; the
    // flow's `readBuildContext` answers `effective = KARMA_MINIMUM` and
    // refuses with the floor sentence. The flow being called means a karma
    // read happens — a null-safe check at the press would skip it.
    h.drive.profileKarma = null;
    const likeBefore = h.likePosts();
    const karmaBefore = h.karmaReads();
    await h.drive.likePost(TARGET1);
    await flush();
    expect({
      extraPosts: h.likePosts() - likeBefore,
      flowReadKarma: h.karmaReads() - karmaBefore > 0,
      overlay: h.drive.optimisticLikes.has(TARGET1),
      report: h.drive.state.feed.report,
    }).toEqual({
      extraPosts: 0,
      flowReadKarma: true,
      overlay: false,
      report: 'like not sent: the last 10 rep is for posting.',
    });
  });
});
