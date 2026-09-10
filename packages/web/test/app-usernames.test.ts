// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { WriteClient, ClaimSubmitResult, BurnSubmitResult, Rejection } from '../src/api/write';
import type { AppIdentity } from '../src/model/state';
import type {
  FeedResult, PostJson, KarmaResult, StatusResult, BlockCurrent, UsernameResult,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult,
} from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

const ME = 'aa'.repeat(32);
const KBOX = '11'.repeat(32);

let idState: { pubKeyHex: string; locked: boolean } | null;
let onChangeCb: () => void;
let blockHeight: number;
let effective: string;
let heldName: UsernameResult | null;
let claimResp: (() => ClaimSubmitResult | Rejection) | null;
let burnResp: (() => BurnSubmitResult | Rejection) | null;
const signCalls: string[] = [];
const last = (): string => signCalls[signCalls.length - 1]!;

function post(id: string, author: string): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 10, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
  };
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight, protocolVersion: 1, postCount: 1, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 43200,
    vouchCooldownBlocks: 60, inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

function memberKarma(): KarmaResult {
  return karmaResult({ userId: ME, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1, total: effective, effective, boxes: [{ boxId: KBOX, value: effective }], height: blockHeight });
}

function fakeApi(): Api {
  return {
    feed: async () => ({ posts: [post('p1', 'bb'.repeat(32))], next: null, pending: [], pendingCount: 0 } as FeedResult),
    thread: async () => null,
    post: async (id) => ({ ...post(id, 'bb'.repeat(32)), confirmedAuthor: 'bb'.repeat(32) }),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: blockHeight, hash: null }),
    karma: async () => memberKarma(),
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => heldName,
  };
}

function fakeWrite(): WriteClient {
  return {
    submitClaim: async () => claimResp ? claimResp() : ({ status: 'pending', txId: last(), expiresAtHeight: blockHeight + 720, name: 'Test' }),
    submitBurn: async () => burnResp ? burnResp() : ({ status: 'pending', txId: last(), expiresAtHeight: blockHeight + 720 }),
  } as unknown as WriteClient;
}

function fakeIdentity(): AppIdentity {
  return {
    current: () => idState,
    sign: (t: string) => { signCalls.push(t); return 'ab'.repeat(64); },
    onChange: (cb: () => void) => { onChangeCb = cb; },
    draft: () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: () => ({ kind: 'clear' as const, pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: () => {},
    forget: () => {},
    backedUp: () => true,
  } as unknown as AppIdentity;
}

interface Drive {
  loadFeed(): Promise<void>;
  loadMembershipState(): Promise<void>;
  claimUsername(name: string): Promise<void>;
  burnUsername(): Promise<void>;
  pollTick(): Promise<void>;
  ledger: { all(): Array<{ kind: string; postId: string }>; size: number };
  ownName: UsernameResult | null;
  ownNameLoaded: boolean;
  usernameFlight: { stage: string; reason?: string | null } | null;
}

function harness() {
  idState = { pubKeyHex: ME, locked: false };
  onChangeCb = () => {};
  blockHeight = 100;
  signCalls.length = 0;
  effective = '250';
  heldName = null;
  claimResp = null;
  burnResp = null;

  const app = new App(fakeApi(), fakeWrite(), fakeIdentity());
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  return { app, appbar, feed, panes, drive: app as unknown as Drive };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => { vi.useRealTimers(); });

describe('the claim flow', () => {
  it('a claim press creates a ledger entry with kind claim', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.claimUsername('Test');
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'claim');
    expect(entry).toBeDefined();
    expect(entry!.postId).toBe('Test');
  });

  it('a claim rejection sets the usernameFlight with the sentence', async () => {
    const h = harness();
    claimResp = () => ({ status: 409, message: 'name taken' } as unknown as ClaimSubmitResult);
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.claimUsername('Bob');
    await flush();
    expect(h.drive.usernameFlight?.stage).toBe('rejected');
    expect(h.drive.usernameFlight?.reason).toContain('that name is taken.');
  });

  it('a claim landing sets the own-name state and clears the flight', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.claimUsername('Alice');
    await flush();
    expect(h.drive.ledger.size).toBeGreaterThan(0);
    heldName = { name: 'Alice', owner: ME, boxId: '55'.repeat(32), claimedAtBlock: 101 };
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    expect(h.drive.ownName?.name).toBe('Alice');
    expect(h.drive.usernameFlight).toBeNull();
  });
});

describe('the burn flow', () => {
  it('a burn press resolves the name at the press and creates a ledger entry', async () => {
    const h = harness();
    heldName = { name: 'Alice', owner: ME, boxId: '55'.repeat(32), claimedAtBlock: 50 };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.burnUsername();
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'burn');
    expect(entry).toBeDefined();
    expect(entry!.postId).toBe('Alice');
  });

  it('a burn landing clears the name', async () => {
    const h = harness();
    heldName = { name: 'Alice', owner: ME, boxId: '55'.repeat(32), claimedAtBlock: 50 };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.burnUsername();
    await flush();
    heldName = null;
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    expect(h.drive.ownName).toBeNull();
    expect(h.drive.ownNameLoaded).toBe(true);
  });
});

describe('identity change', () => {
  it('an identity change resets the name state', async () => {
    const h = harness();
    heldName = { name: 'Alice', owner: ME, boxId: '55'.repeat(32), claimedAtBlock: 50 };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.ownName?.name).toBe('Alice');
    idState = null;
    onChangeCb();
    await flush();
    expect(h.drive.ownName).toBeNull();
    expect(h.drive.ownNameLoaded).toBe(false);
  });
});
