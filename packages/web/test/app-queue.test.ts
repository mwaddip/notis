// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient, LikeSubmitResult, SendSubmitResult, VouchSubmitResult } from '../src/api/write';
import type { KarmaResult, PostResult, StatusResult, FeedResult, BlockCurrent, CreditsResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { setNode, prefs } from '../src/prefs';

// WEB_INTERFACE → The wallet → "The reader's spends run one at a time, per ledger" and → "A press waiting its turn belongs to the key and the node it was made under".
// Two queues: a rep queue (post / like / withdraw / vouch / invite / claim /
// burn) and a send queue; an unvouch queues with neither. A waiting press
// captures the generation at the press; a node or identity change moves the
// generation, and the press's turn runs nothing.

const PUB = 'aa'.repeat(32);
const PUB2 = 'cc'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const BOX = '11'.repeat(32);
const CREDIT_BOX = '55'.repeat(32);
const TARGET1 = 'c1'.repeat(32);
const TARGET2 = 'c2'.repeat(32);
const RECIPIENT = 'd1'.repeat(32);

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function confirmedPost(id: string): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: AUTHOR, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: AUTHOR, txId: 'ff'.repeat(32),
  };
}
function creditsResult(): CreditsResult {
  return { userId: PUB, total: '10000000000', boxes: [{ boxId: CREDIT_BOX, value: '10000000000' }], boxCount: 1, next: null };
}

interface Harness {
  app: App;
  karmaReads(): number;
  karmaPendingReads(): number;
  creditsReads(): number;
  creditsPendingReads(): number;
  likePosts(): number;
  sendPosts(): number;
  unvouchPosts(): number;
  signCount(): number;
  holdNextLike(): void;
  releaseNextLike(result?: LikeSubmitResult): void;
  holdNextSend(): void;
  releaseNextSend(result?: SendSubmitResult): void;
  switchCurrent(key: string): void;
  fireIdentityChange(): void;
  drive: {
    likePost(postId: string): Promise<void>;
    send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
    unvouch(key: string): Promise<void>;
    changeNode(origin: string): Promise<void>;
    openComposer(parentId: string | null): void;
    submitComposer(parentId: string | null, text: string): Promise<void>;
    composers: Map<string, { el: HTMLElement }>;
    optimisticLikes: Set<string>;
    sendFlight: unknown;
    state: { feed: { posts: Array<{ id: string }>; report: string | null } };
  };
}

/** The App over fakes, with the write client's `submitLike` and `submitSend`
 *  controllable: `holdNextLike()` makes the next POST /likes wait for
 *  `releaseNextLike()`; same for sends. The identity exposes `switchCurrent`
 *  and `fireIdentityChange` so a case can move `current()` and trigger the
 *  listener the App registered. */
function harness(opts: { karmaBox?: string } = {}): Harness {
  const signCalls: string[] = [];
  const currentKey = { hex: PUB };
  let changeListener: ((id: { pubKeyHex: string } | null) => void) | null = null;
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: currentKey.hex, locked: false }),
    sign: async (_bytes, t) => { signCalls.push(t); return { signature: 'ab'.repeat(64) }; },
    draft: async () => ({ pubKeyHex: currentKey.hex }),
    create: async () => ({ pubKeyHex: currentKey.hex }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: currentKey.hex }),
    importFile: async () => ({ pubKeyHex: currentKey.hex }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: (fn) => { changeListener = fn; },
  };
  const last = (): string => signCalls[signCalls.length - 1]!;

  const karma: KarmaResult = karmaResult({
    userId: PUB, total: '227', effective: '227',
    boxes: [{ boxId: opts.karmaBox ?? BOX, value: '227' }], boxCount: 1, height: 6000,
  });

  let karmaN = 0;
  let karmaPendingN = 0;
  let creditsN = 0;
  let creditsPendingN = 0;
  let likeN = 0;
  let sendN = 0;
  let unvouchN = 0;

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async (_k, _p, o) => { karmaN++; if (o?.pending === true) karmaPendingN++; return karma; },
    credits: async (_k, _p, o) => { creditsN++; if (o?.pending === true) creditsPendingN++; return creditsResult(); },
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({
      vouches: [{ boxId: '77'.repeat(32), value: '1', createdAtBlock: 5900, voucherId: PUB, targetId: PUB2, voucherName: null, targetName: null }],
      count: 1, next: null,
    }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    usernameByName: async () => null,
  };

  // Controllable write client: a `hold*` flag makes the next matching call
  // return a Promise the test resolves through `release*`.
  let holdLikeResolve: ((r: LikeSubmitResult) => void) | null = null;
  let holdLikeNext = false;
  let holdSendResolve: ((r: SendSubmitResult) => void) | null = null;
  let holdSendNext = false;

  const writeClient = {
    submitPost: async () => ({ postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: last() }),
    submitLike: async (): Promise<LikeSubmitResult> => {
      likeN++;
      const txId = last();
      if (holdLikeNext) {
        holdLikeNext = false;
        return new Promise<LikeSubmitResult>((resolve) => {
          holdLikeResolve = (r) => resolve({ ...r, txId });
        });
      }
      return { status: 'pending', txId, expiresAtHeight: 6720 };
    },
    submitVouch: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720 }),
    submitUnvouch: async (): Promise<VouchSubmitResult> => {
      unvouchN++;
      return { status: 'pending', txId: last(), expiresAtHeight: 6720 };
    },
    submitInvite: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720, bondBoxId: 'bb'.repeat(32) }),
    submitWithdraw: async () => ({ status: 'submitted', txId: last(), postId: 'x', expiresAtHeight: 6720 }),
    submitClaim: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720, name: 'x' }),
    submitBurn: async () => ({ status: 'pending', txId: last(), expiresAtHeight: 6720 }),
    submitSend: async (): Promise<SendSubmitResult> => {
      sendN++;
      const txId = last();
      if (holdSendNext) {
        holdSendNext = false;
        return new Promise<SendSubmitResult>((resolve) => {
          holdSendResolve = (r) => resolve({ ...r, txId });
        });
      }
      return { status: 'pending', txId, expiresAtHeight: 6720 };
    },
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
    karmaPendingReads: () => karmaPendingN,
    creditsReads: () => creditsN,
    creditsPendingReads: () => creditsPendingN,
    likePosts: () => likeN,
    sendPosts: () => sendN,
    unvouchPosts: () => unvouchN,
    signCount: () => signCalls.length,
    holdNextLike: () => { holdLikeNext = true; },
    releaseNextLike: (r) => {
      const resolve = holdLikeResolve;
      holdLikeResolve = null;
      if (resolve === null) throw new Error('no held like');
      resolve(r ?? { status: 'pending', txId: '', expiresAtHeight: 6720 });
    },
    holdNextSend: () => { holdSendNext = true; },
    releaseNextSend: (r) => {
      const resolve = holdSendResolve;
      holdSendResolve = null;
      if (resolve === null) throw new Error('no held send');
      resolve(r ?? { status: 'pending', txId: '', expiresAtHeight: 6720 });
    },
    switchCurrent: (hex) => { currentKey.hex = hex; },
    fireIdentityChange: () => { if (changeListener !== null) changeListener({ pubKeyHex: currentKey.hex }); },
    drive: app as unknown as Harness['drive'],
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the reader\'s spends run one at a time, per ledger', () => {
  it('a first like\'s POST held: the second like\'s overlay stands; no second /karma before the first\'s answer; released, the second\'s reads and its POST follow', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();
    // Control: the first like's reads happened and its POST is held.
    expect(h.karmaReads()).toBeGreaterThanOrEqual(1);
    const karmaAfterFirst = h.karmaReads();
    expect(h.likePosts()).toBe(1);

    const second = h.drive.likePost(TARGET2);
    await flush();
    // Control: the second's overlay stands at the press.
    expect(h.drive.optimisticLikes.has(TARGET2)).toBe(true);

    // The rule: no second /karma while the first is held.
    expect(h.karmaReads()).toBe(karmaAfterFirst);
    // And no second POST /likes.
    expect(h.likePosts()).toBe(1);

    // Release the first; the second's reads and its POST follow.
    h.releaseNextLike();
    await first;
    await flush();
    expect(h.karmaReads()).toBeGreaterThan(karmaAfterFirst);
    expect(h.likePosts()).toBe(2);
    await second;
  });

  it('a send behind a held send: the second send\'s /credits read waits the same way', async () => {
    const h = harness();
    h.holdNextSend();
    const first = h.drive.send(RECIPIENT, null, 1_250_000_000n);
    await flush();
    expect(h.creditsReads()).toBeGreaterThanOrEqual(1);
    const creditsAfterFirst = h.creditsReads();
    expect(h.sendPosts()).toBe(1);

    const second = h.drive.send(RECIPIENT, null, 500_000_000n);
    await flush();
    // The rule: no second /credits while the first is held.
    expect(h.creditsReads()).toBe(creditsAfterFirst);
    expect(h.sendPosts()).toBe(1);

    h.releaseNextSend();
    await first;
    await flush();
    expect(h.creditsReads()).toBeGreaterThan(creditsAfterFirst);
    expect(h.sendPosts()).toBe(2);
    await second;
  });

  // The two queues run apart: a held rep spend never holds a send's reads.
  it('a held like does not hold a send\'s /credits read', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();
    expect(h.likePosts()).toBe(1); // control: the like's POST is held

    const sendRun = h.drive.send(RECIPIENT, null, 1_250_000_000n);
    await flush();
    // The send's /credits read happened and its POST left.
    expect(h.creditsReads()).toBeGreaterThanOrEqual(1);
    expect(h.sendPosts()).toBe(1);

    h.releaseNextLike();
    await first;
    await sendRun;
  });

  // An unvouch queues with neither: its reads and its write leave while a
  // like is held.
  it('with a like held, an unvouch\'s reads and its write leave', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();
    expect(h.likePosts()).toBe(1); // control

    const unvouchRun = h.drive.unvouch(PUB2);
    await flush();
    // The unvouch's write left.
    expect(h.unvouchPosts()).toBe(1);

    h.releaseNextLike();
    await first;
    await unvouchRun;
  });
});

describe('a press waiting its turn belongs to the node and key of the press', () => {
  it('a second like waiting behind a held first: a node change ends the waiting press — no karma?pending=1 after the change, no sign at or after release, no second POST /likes', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();

    const second = h.drive.likePost(TARGET2);
    await flush();
    expect(h.drive.optimisticLikes.has(TARGET2)).toBe(true); // control: the overlay stands

    // Change the node before releasing the first.
    await h.drive.changeNode('https://b.example');

    const pendingKarmaBeforeRelease = h.karmaPendingReads();
    const signsBeforeRelease = h.signCount();
    h.releaseNextLike();
    await first;
    await flush();
    await second;

    // The waiting press's own effects:
    // (a) exactly one karma?pending=1 read happens after the change — the
    //     first press's 2xx re-reads the rep view through `refreshOwnKarma`
    //     (WEB_INTERFACE → The profile window → "The `rep` row is the rep
    //     view's `effective` alone"); the waiting press fires none.
    expect(h.karmaPendingReads() - pendingKarmaBeforeRelease).toBe(1);
    // (b) no sign call happens at or after release — the waiting press never signs.
    expect(h.signCount() - signsBeforeRelease).toBe(0);
    // (c) the LAST assertion: no second POST /likes leaves.
    expect(h.likePosts()).toBe(1);
  });

  it('a second like waiting behind a held first: an identity change ends the waiting press — no sign at or after release, no second POST /likes', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();

    const second = h.drive.likePost(TARGET2);
    await flush();
    expect(h.drive.optimisticLikes.has(TARGET2)).toBe(true); // control: the overlay stands

    // Switch current() to PUB2 and fire the registered onChange listener,
    // as a `forget` + fresh `create` through the identity module would.
    h.switchCurrent(PUB2);
    h.fireIdentityChange();

    const signsBeforeRelease = h.signCount();
    h.releaseNextLike();
    await first;
    await flush();
    await second;

    // Waiting press's own effects:
    // (a) no sign call at or after release — the waiting press never signs.
    expect(h.signCount() - signsBeforeRelease).toBe(0);
    // (b) the LAST assertion: no second POST /likes leaves.
    expect(h.likePosts()).toBe(1);
  });
});

// WEB_INTERFACE → The wallet → "A press waiting its turn belongs to the key and the node it was made under" — a change of the node ends the press as a decline ends one (its step undone, the composer still open with its text, the line *… not sent.*).
describe('a node change ends a waiting press as a decline does', () => {
  it('a like waiting behind a held like, node change, release: the waiting like\'s overlay is gone', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();

    const second = h.drive.likePost(TARGET2);
    await flush();
    // Control, before the node change: the waiting overlay stands.
    expect(h.drive.optimisticLikes.has(TARGET2)).toBe(true);

    // Change the node, release the first.
    await h.drive.changeNode('https://b.example');
    h.releaseNextLike();
    await first;
    await flush();
    await second;

    // The rule: the decline path takes the overlay off — the press's step is
    // undone, as the amendment names.
    expect(h.drive.optimisticLikes.has(TARGET2)).toBe(false);
  });

  it('a composer\'s post waiting behind a held like, node change, release: the composer is open, holds its text, `post` enabled, foot reads *post not sent.*', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();

    h.drive.openComposer(null);
    const ctrl = h.drive.composers.get('@feed')!;
    (ctrl.el.querySelector('.composer-text') as HTMLTextAreaElement).value = 'a draft that waits';
    const second = h.drive.submitComposer(null, 'a draft that waits');
    await flush();

    // Control, before the node change: the composer is open with its text and
    // its `sending` look (the press stays before the queue).
    expect(h.drive.composers.get('@feed')).toBeDefined();

    await h.drive.changeNode('https://b.example');
    h.releaseNextLike();
    await first;
    await flush();
    await second;

    // The rule: composer open with its text, re-enabled, foot *post not sent.*
    const ctrl2 = h.drive.composers.get('@feed');
    expect(ctrl2).toBeDefined();
    const ta = ctrl2!.el.querySelector('.composer-text') as HTMLTextAreaElement;
    expect(ta.value).toBe('a draft that waits');
    expect(ctrl2!.el.querySelector('.karma')?.textContent).toBe('post not sent.');
  });
});

// WEB_INTERFACE → The wallet → "A press waiting its turn belongs to the key and the node it was made under" — the key-change arm. On an identity change the identity module clears the overlays and the flights (onIdentityChange); the queue's turn for the waiting press runs nothing. Were the key check at `'cancelled'` deleted, the synthesized decline would run for the old key's press and write *like not sent.* to a surface the old key no longer owns. The control shows the surface IS reachable: the same arrangement with a node change writes the line.
describe('a key-change cancellation writes no decline line for the old key\'s press', () => {
  it('a like waiting behind a held like, identity change, release: no "like not sent." lands in the feed report line', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();
    const second = h.drive.likePost(TARGET2);
    await flush();

    h.switchCurrent(PUB2);
    h.fireIdentityChange();
    await flush();
    // Seed the feed so a wayward setReportForPost would land its line.
    h.drive.state.feed.posts.push(confirmedPost(TARGET2) as unknown as { id: string });

    h.releaseNextLike();
    await first;
    await flush();
    await second;

    expect(h.drive.state.feed.report).not.toBe('like not sent.');
  });

  it('control: a like waiting behind a held like, node change, release: the decline writes "like not sent." to the feed report line', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();
    const second = h.drive.likePost(TARGET2);
    await flush();

    await h.drive.changeNode('https://b.example');
    // Seed the feed so setReportForPost's line reaches `state.feed.report`.
    h.drive.state.feed.posts.push(confirmedPost(TARGET2) as unknown as { id: string });

    h.releaseNextLike();
    await first;
    await flush();
    await second;

    expect(h.drive.state.feed.report).toBe('like not sent.');
  });
});
