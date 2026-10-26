// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api, Page } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { KarmaResult, PostResult, StatusResult, FeedResult, BlockCurrent, CreditsResult, BondsResult, UsernameResult, VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { setNode } from '../src/prefs';

// WEB_INTERFACE → The profile window → "The `rep` row is the rep view's
// `effective` alone" — the number takes a new value at every 2xx of the
// reader's own spend. The submit flow's own pre-read of /karma?pending=1
// stands, and after the 2xx a fresh /karma?pending=1 fires through
// `refreshOwnKarma` — two reads per rep spend. A send's 2xx re-reads
// /credits?pending=1 while the wallet window is open. An unvouch spends a
// `vouch` box and no view lists it, so no view re-reads.

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const TARGET_KEY = 'cd'.repeat(32);
const INVITEE_KEY = 'ee'.repeat(32);
const POST_ID = 'cc'.repeat(32);
const OWN_POST_ID = 'dd'.repeat(32);
const VOUCH_BOX_ID = '77'.repeat(32);
const USERNAME_BOX_ID = '66'.repeat(32);
const CREDIT_BOX_ID = '88'.repeat(32);
const BOX = '11'.repeat(32);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000', membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
  };
}

function confirmedPost(id: string, author: string): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: false, confirmedAuthor: author, txId: 'ff'.repeat(32),
  };
}

interface Harness {
  app: App;
  karmaReads: number;
  creditsReads: number;
  karmaViewReads: number;
  creditsViewReads: number;
  drive: {
    likePost(postId: string): Promise<void>;
    submitComposer(parentId: string | null, text: string): Promise<void>;
    openComposer(parentId: string | null): void;
    withdrawPost(postId: string): Promise<void>;
    vouch(key: string): Promise<void>;
    unvouch(key: string): Promise<void>;
    invite(key: string, bond: bigint): Promise<void>;
    claimUsername(name: string): Promise<void>;
    burnUsername(): Promise<void>;
    send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
    openWallet(): void;
    loadMembershipState(): Promise<void>;
  };
}

function harness(opts: { member?: boolean; forName?: string } = {}): Harness {
  // `sign` records each `txIdHex` the submit flow asks it to sign over; the
  // write client echoes `lastSigned()` so the submit flow's `body.txId ===
  // built.txId` check passes.
  const signedIds: string[] = [];
  const lastSigned = (): string => signedIds[signedIds.length - 1]!;
  const identity: AppIdentity = {
    current: () => ({ pubKeyHex: PUB, locked: false }),
    sign: async (_bytes, txIdHex) => {
      signedIds.push(txIdHex);
      return { signature: 'ab'.repeat(64) };
    },
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => false,
    onChange: () => {},
  };

  const karma: KarmaResult = karmaResult({
    userId: PUB, total: '227', effective: '227',
    boxes: [{ boxId: BOX, value: '227' }], boxCount: 1,
    height: 6000, member: !!opts.member,
    invitesAvailable: opts.member ? 5 : 0,
  });
  const credits: CreditsResult = {
    userId: PUB, total: '1000000000',
    boxes: [{ boxId: CREDIT_BOX_ID, value: '1000000000' }],
    boxCount: 1, next: null,
  };

  let karmaReads = 0;
  let creditsReads = 0;
  let karmaViewReads = 0;
  let creditsViewReads = 0;

  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id): Promise<PostResult | null> => {
      if (id === POST_ID) return confirmedPost(id, AUTHOR);
      if (id === OWN_POST_ID) return confirmedPost(id, PUB);
      return null;
    },
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async (_k, _p: Page, o?: { pending: true }) => {
      karmaReads += 1;
      if (o?.pending === true) karmaViewReads += 1;
      return karma;
    },
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({
      vouches: [{ voucherId: PUB, targetId: TARGET_KEY, boxId: VOUCH_BOX_ID, value: '1', createdAtBlock: 100, voucherName: null, targetName: null }],
      count: 1, next: null,
    }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns: [], count: 0, next: null }),
    bonds: async (): Promise<BondsResult> => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async (): Promise<UsernameResult | null> => (opts.forName
      ? { boxId: USERNAME_BOX_ID, name: opts.forName, owner: PUB, claimedAtBlock: 100 }
      : null),
    credits: async (_k, _p: Page, o?: { pending: true }) => {
      creditsReads += 1;
      if (o?.pending === true) creditsViewReads += 1;
      return credits;
    },
    usernameByName: async () => null,
  };

  const writeClient = {
    submitPost: async () => ({ postId: 'newpost', status: 'pending', expiresAtHeight: 6720, txId: lastSigned() }),
    submitLike: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720 }),
    submitVouch: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720 }),
    submitUnvouch: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720 }),
    submitInvite: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720, bondBoxId: 'bb'.repeat(32) }),
    submitWithdraw: async () => ({ status: 'submitted', txId: lastSigned(), postId: OWN_POST_ID, expiresAtHeight: 6720 }),
    submitClaim: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720, name: 'alice' }),
    submitBurn: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720 }),
    submitSend: async () => ({ status: 'pending', txId: lastSigned(), expiresAtHeight: 6720 }),
  } as unknown as WriteClient;

  const ledger = new PendingLedger(PUB);
  const app = new App(fakeApi, writeClient, identity, ledger);
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);

  return {
    app,
    get karmaReads(): number { return karmaReads; },
    get creditsReads(): number { return creditsReads; },
    get karmaViewReads(): number { return karmaViewReads; },
    get creditsViewReads(): number { return creditsViewReads; },
    drive: app as unknown as Harness['drive'],
  };
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
});

afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
// Each rep spend's 2xx re-reads /karma?pending=1 (two view reads per press:
// the pre-flight read, and `refreshOwnKarma` on 2xx)
// ---------------------------------------------------------------------------

interface Kind {
  name: string;
  member?: boolean;
  forName?: string;
  prepare?: (h: Harness) => Promise<void>;
  fire: (h: Harness) => Promise<void>;
}

const openProfile = async (h: Harness): Promise<void> => {
  await h.drive.loadMembershipState();
  await flush();
};

const REP_KINDS: Kind[] = [
  { name: 'a like', fire: (h) => h.drive.likePost(POST_ID) },
  {
    name: 'a post',
    prepare: async (h) => { h.drive.openComposer(null); await flush(); },
    fire: (h) => h.drive.submitComposer(null, 'hello world'),
  },
  { name: 'a vouch', member: true, fire: (h) => h.drive.vouch(TARGET_KEY) },
  { name: 'an invite', member: true, fire: (h) => h.drive.invite(INVITEE_KEY, 100n) },
  { name: 'a withdrawal', fire: (h) => h.drive.withdrawPost(OWN_POST_ID) },
  { name: 'a claim', fire: (h) => h.drive.claimUsername('alice') },
  { name: 'a burn', forName: 'alice', prepare: openProfile, fire: (h) => h.drive.burnUsername() },
];

describe("every rep spend's 2xx re-reads /karma?pending=1", () => {
  for (const kind of REP_KINDS) {
    it(`${kind.name}'s 2xx re-reads the rep view through refreshOwnKarma`, async () => {
      const h = harness({ member: kind.member, forName: kind.forName });
      await flush();
      if (kind.prepare) await kind.prepare(h);
      const before = h.karmaViewReads;
      await kind.fire(h);
      await flush();
      await flush();
      // The submit flow reads /karma?pending=1 once as a pre-flight; the 2xx
      // re-reads it a second time through `refreshOwnKarma`.
      expect(h.karmaViewReads).toBeGreaterThanOrEqual(before + 2);
    });
  }
});

// ---------------------------------------------------------------------------
// A send's 2xx re-reads /credits?pending=1 while the wallet window is open
// ---------------------------------------------------------------------------
describe("a send's 2xx re-reads /credits?pending=1 while the wallet window is open", () => {
  it("a send's 2xx re-reads the credits view through refreshWalletCredits", async () => {
    const h = harness();
    await flush();
    // Open the wallet so refreshWalletCredits fires on the 2xx.
    h.drive.openWallet();
    await flush();
    const before = h.creditsViewReads;
    await h.drive.send(TARGET_KEY, null, 100000000n);
    await flush();
    // The submit flow reads /credits?pending=1 once as a pre-flight; the 2xx
    // re-reads it a second time through `refreshWalletCredits`.
    expect(h.creditsViewReads).toBeGreaterThanOrEqual(before + 2);
  });
});

// ---------------------------------------------------------------------------
// An unvouch's 2xx re-reads nothing — the box spent is a vouch box, which no
// view lists.
// ---------------------------------------------------------------------------
describe("an unvouch's 2xx re-reads no view", () => {
  it('an unvouch spends a vouch box and no view lists it, so no view re-reads', async () => {
    const h = harness({ member: true });
    await flush();
    const karmaBefore = h.karmaViewReads;
    const creditsBefore = h.creditsViewReads;
    await h.drive.unvouch(TARGET_KEY);
    await flush();
    // No view read fires — the unvouch flow reads /status only.
    expect(h.karmaViewReads).toBe(karmaBefore);
    expect(h.creditsViewReads).toBe(creditsBefore);
  });
});
