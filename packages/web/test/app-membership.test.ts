// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { WriteClient } from '../src/api/write';
import type { AppIdentity } from '../src/model/state';
import type {
  FeedResult, PostJson, KarmaResult, StatusResult, BlockCurrent,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult,
} from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// The App's membership surface driven over fakes: a vouch's optimistic pending
// state and its landing through the author window, a rejection, an identity
// change rebuilding the vouch set, and the author window opening and loading.

const ME = 'aa'.repeat(32);
const X = 'bb'.repeat(32);
const V1 = 'dd'.repeat(32);
const SIG = 'cc'.repeat(64);

let idState: { pubKeyHex: string; locked: boolean } | null;
let onChangeCb: () => void;
let feedViewers: Array<string | undefined>;
let vouchSet: VouchesVoucherResult['vouches'];
let cooldowns: VouchCooldownsResult['cooldowns'];
let targetReads: string[];
let blockHeight: number;
let writeCalls: Array<{ kind: string; targetHex?: string }>;
let vouchResp: { ok: boolean };
let lastSigned: string;
let effective: string;

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
const KBOX = '11'.repeat(32);
function memberKarma(key: string): KarmaResult {
  return karmaResult({ userId: key, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1, total: effective, effective, boxes: [{ boxId: KBOX, value: effective }], height: blockHeight });
}

let ownNameResult: { name: string; owner: string; boxId: string; claimedAtBlock: number } | null;
let authorNameResults: Map<string, { name: string; owner: string; boxId: string; claimedAtBlock: number } | null>;

function fakeApi(): Api {
  return {
    feed: async (_p, viewer) => {
      feedViewers.push(viewer);
      return { posts: [post('p1', X)], next: null, pending: [], pendingCount: 0 } as FeedResult;
    },
    thread: async () => null,
    post: async (id) => ({ ...post(id, X), confirmedAuthor: X }),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: blockHeight, hash: null }),
    karma: async (key) => memberKarma(key),
    vouchesByTarget: async (key): Promise<VouchesTargetResult> => {
      targetReads.push(key);
      return { vouches: [{ voucherId: V1, targetId: key }], count: 3, next: null };
    },
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({ vouches: vouchSet, count: vouchSet.length, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns, count: cooldowns.length, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async (key) => authorNameResults?.get(key) ?? (key === ME ? ownNameResult : null),
  };
}

function fakeWrite(): WriteClient {
  return {
    submitVouch: async () => {
      writeCalls.push({ kind: 'vouch' });
      return vouchResp.ok ? { status: 'pending', txId: lastSigned, expiresAtHeight: blockHeight + 720 } : { status: 400, message: 'already vouched for this pair' };
    },
    submitUnvouch: async (targetHex: string) => {
      writeCalls.push({ kind: 'unvouch', targetHex });
      return { status: 'pending', txId: lastSigned, expiresAtHeight: blockHeight + 720 };
    },
  } as unknown as WriteClient;
}

function fakeIdentity(): AppIdentity {
  return {
    current: () => idState,
    sign: (txId: string) => { lastSigned = txId; return SIG; },
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
  vouch(key: string): Promise<void>;
  unvouch(key: string): Promise<void>;
  openAuthor(key: string, origin: { from: 'feed' } | { from: 'pane'; ci: number }): void;
  pollTick(): Promise<void>;
  ledger: { all(): Array<{ kind: string; postId: string }>; size: number };
  vouched: Map<string, unknown>;
}

function harness() {
  idState = { pubKeyHex: ME, locked: false };
  onChangeCb = () => {};
  feedViewers = [];
  vouchSet = [];
  cooldowns = [];
  targetReads = [];
  blockHeight = 100;
  writeCalls = [];
  vouchResp = { ok: true };
  lastSigned = '';
  effective = '250';
  ownNameResult = null;
  authorNameResults = new Map();

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

describe('no mark on a feed card', () => {
  it('a member sees no mark on another author in the feed', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    expect(h.feed.querySelector('.vmark')).toBeNull();
  });
});

describe('vouch through the author window', () => {
  it('a vouch lands a ledger entry and the your-vouch row changes', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await h.drive.vouch(X);
    await flush();
    expect(h.drive.ledger.all().some((e) => e.kind === 'vouch' && e.postId === X)).toBe(true);
    expect(writeCalls.some((c) => c.kind === 'vouch')).toBe(true);
  });

  it('a rejection removes the entry and shows the reason in the author window', async () => {
    const h = harness();
    vouchResp.ok = false;
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    await h.drive.vouch(X);
    await flush();
    expect(h.drive.ledger.all().some((e) => e.kind === 'vouch')).toBe(false);
    const authorWin = h.panes.querySelector('.winbody');
    expect(authorWin?.textContent).toContain('vouch rejected');
  });

  it('the vouch press sets the flight and the row carries the stage line', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    await h.drive.vouch(X);
    await flush();
    const authorWin = h.panes.querySelector('.winbody');
    expect(authorWin?.querySelector('.stage')?.textContent).toContain('submitted');
    const vouchWord = [...(authorWin?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'vouch');
    expect(vouchWord).toBeUndefined();
  });

  it('the poll lands a pending vouch — the vouched set gains the target and the flight clears', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    await h.drive.vouch(X);
    await flush();
    vouchSet = [{ boxId: '22'.repeat(32), value: '1', createdAtBlock: 100, voucherId: ME, targetId: X }];
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    expect(h.drive.vouched.has(X)).toBe(true);
    expect(h.drive.ledger.all().some((e) => e.kind === 'vouch')).toBe(false);
    const authorWin = h.panes.querySelector('.winbody');
    expect(authorWin?.textContent).toContain('vouched');
    expect(authorWin?.querySelector('.stage')).toBeNull();
  });
});

describe('the author window', () => {
  it('opens, renders its rows, and loads /karma and the endorsers', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    const labels = [...h.panes.querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(labels).toContain('key');
    expect(labels).toContain('endorsers');
    expect(h.panes.textContent).toContain(X);
    expect(targetReads).toContain(X);
  });

  it('an endorser row carries the prefix alone — no mark', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    const endorser = h.panes.querySelector('.endorser')!;
    expect(endorser.querySelector('.authorbtn')).not.toBeNull();
    expect(endorser.querySelector('.vmark')).toBeNull();
  });

  it('no display mark on the bar', async () => {
    const h = harness();
    vouchSet = [{ boxId: '22'.repeat(32), value: '1', createdAtBlock: 50, voucherId: ME, targetId: X }];
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    expect(h.panes.querySelector('.bar .vmark')).toBeNull();
  });

  it('an unvouch flight lands with an escrow — the your-vouch row reads the held reason', async () => {
    const h = harness();
    vouchSet = [{ boxId: '22'.repeat(32), value: '1', createdAtBlock: 50, voucherId: ME, targetId: X }];
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    await h.drive.unvouch(X);
    await flush();
    vouchSet = [];
    cooldowns = [{ boxId: 'e1', value: '1', releaseAtBlock: 200 }];
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    const yv = [...h.panes.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'your vouch');
    expect(yv?.textContent).toContain('held until block 200');
  });
});

describe('an identity change', () => {
  it('clears the vouch set for the new key', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    vouchSet = [{ boxId: '22'.repeat(32), value: '1', createdAtBlock: 100, voucherId: ME, targetId: X }];
    await h.drive.loadMembershipState();
    await flush();
    expect(h.drive.vouched.has(X)).toBe(true);
    idState = { pubKeyHex: 'dd'.repeat(32), locked: false };
    vouchSet = [];
    onChangeCb();
    await flush();
    expect(h.drive.vouched.has(X)).toBe(false);
  });
});

describe('the reader\'s own name read', () => {
  it('the header shows the handle @Name at tiling when the reader holds a name', async () => {
    const h = harness();
    ownNameResult = { name: 'TestUser', owner: ME, boxId: '55'.repeat(32), claimedAtBlock: 50 };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    const profileBtn = h.appbar.querySelector('[aria-label="open profile"]') as HTMLElement;
    expect(profileBtn).not.toBeNull();
    expect(profileBtn.textContent).toBe('@TestUser');
    expect(profileBtn.style.fontFamily).not.toContain('mono');
  });

  it('the header shows the hex prefix when no name is held', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    const profileBtn = h.appbar.querySelector('[aria-label="open profile"]') as HTMLElement;
    expect(profileBtn.style.fontFamily).toContain('mono');
  });
});

describe('the author window reads the subject\'s name', () => {
  it('the author window bar shows the handle when the subject holds a name', async () => {
    const h = harness();
    authorNameResults.set(X, { name: 'OtherUser', owner: X, boxId: '66'.repeat(32), claimedAtBlock: 60 });
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    const bar = h.panes.querySelector('.bar .bar-label .handle');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toBe('@OtherUser');
  });

  it('the author window name row reads @Name', async () => {
    const h = harness();
    authorNameResults.set(X, { name: 'OtherUser', owner: X, boxId: '66'.repeat(32), claimedAtBlock: 60 });
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    const nameRow = [...h.panes.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === 'name');
    expect(nameRow).not.toBeNull();
    expect(nameRow!.querySelector('.handle')?.textContent).toBe('@OtherUser');
  });
});
