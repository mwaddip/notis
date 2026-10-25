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

// WEB_INTERFACE → The wallet → "The reader's spends run one at a time, per
// ledger" and → "A press waiting its turn belongs to the key and the node
// of the press". Two queues: a rep queue (post / like / withdraw / vouch /
// invite / claim / burn) and a send queue; an unvouch queues with neither.
// A press waiting its turn captures the generation at the press; a node or
// identity change moves the generation, and the press's turn runs nothing.

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
  creditsReads(): number;
  likePosts(): number;
  sendPosts(): number;
  unvouchPosts(): number;
  holdNextLike(): void;
  releaseNextLike(result?: LikeSubmitResult): void;
  holdNextSend(): void;
  releaseNextSend(result?: SendSubmitResult): void;
  drive: {
    likePost(postId: string): Promise<void>;
    send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
    unvouch(key: string): Promise<void>;
    changeNode(origin: string): Promise<void>;
    optimisticLikes: Set<string>;
    sendFlight: unknown;
  };
}

/** The App over fakes, with the write client's `submitLike` and `submitSend`
 *  controllable: `holdNextLike()` makes the next POST /likes wait for
 *  `releaseNextLike()`; same for sends. */
function harness(opts: { karmaBox?: string } = {}): Harness {
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
  const last = (): string => signCalls[signCalls.length - 1]!;

  const karma: KarmaResult = karmaResult({
    userId: PUB, total: '227', effective: '227',
    boxes: [{ boxId: opts.karmaBox ?? BOX, value: '227' }], boxCount: 1, height: 6000,
  });

  let karmaN = 0;
  let creditsN = 0;
  let likeN = 0;
  let sendN = 0;
  let unvouchN = 0;

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async () => { karmaN++; return karma; },
    credits: async () => { creditsN++; return creditsResult(); },
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
    creditsReads: () => creditsN,
    likePosts: () => likeN,
    sendPosts: () => sendN,
    unvouchPosts: () => unvouchN,
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
  it.fails('a first like\'s POST held: the second like\'s overlay stands; no second /karma before the first\'s answer; released, the second\'s reads and its POST follow', async () => {
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

  it.fails('a send behind a held send: the second send\'s /credits read waits the same way', async () => {
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

  // The two queues are separate: a held rep spend never holds a send's reads.
  // Plain `it` — green on the code the gate reads (no queue, the flows run in
  // parallel) and green under the rule (the two queues run apart).
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

  // An unvouch is on neither queue — its reads and its write leave while a
  // like is held. Plain `it` — green on the code the gate reads (no queue)
  // and green under the rule (unvouch queues with neither).
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

describe('a press waiting its turn belongs to the node of the press', () => {
  it.fails('a second like waiting behind a held first: a node change ends the waiting press — no read, no POST', async () => {
    const h = harness();
    h.holdNextLike();
    const first = h.drive.likePost(TARGET1);
    await flush();
    const karmaAfterFirst = h.karmaReads();

    const second = h.drive.likePost(TARGET2);
    await flush();
    expect(h.drive.optimisticLikes.has(TARGET2)).toBe(true); // control: the overlay stands

    // Change the node before releasing the first — the waiting press belongs
    // to the node of the press.
    await h.drive.changeNode('https://b.example');

    // Release the first — the waiting press ends with the node change.
    h.releaseNextLike();
    await first;
    await flush();

    // The rule: no read for the waiting press and no second POST /likes.
    expect(h.karmaReads()).toBe(karmaAfterFirst);
    expect(h.likePosts()).toBe(1);

    // The second's promise settles without a POST leaving.
    await second;
  });

  // A note on identity-change: a change through `forget` + fresh `create`
  // takes the ledger with it (per-identity key, `onIdentityChange`), so the
  // waiting press's handling is the ledger's rebuild — the overlay the press
  // set is dropped, the submission list is cleared, and the queue is a new
  // one. The existing identity-change path through `changeNode` already
  // covers the shape of the ending; the harness here does not reach the
  // identity module's own `onChange`, so the specific identity-change case
  // is left for the module's own suite.
});
