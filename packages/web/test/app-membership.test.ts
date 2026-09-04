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

// The App's membership surface driven over fakes: the mark on a feed card, a
// vouch's optimistic pending state and its landing, a rejection reverting the
// mark, an identity change rebuilding the vouch set, and the author window
// opening and loading.

const ME = 'aa'.repeat(32);
const X = 'bb'.repeat(32); // another author, present in the feed
const SIG = 'cc'.repeat(64);

let idState: { pubKeyHex: string; locked: boolean } | null;
let onChangeCb: () => void;
let feedViewers: Array<string | undefined>;
let vouchSet: VouchesVoucherResult['vouches']; // the reader's live vouches, mutable
let cooldowns: VouchCooldownsResult['cooldowns'];
let targetReads: string[]; // vouchesByTarget calls — the count cache
let blockHeight: number;
let writeCalls: Array<{ kind: string; targetHex?: string }>;
let vouchResp: { ok: boolean };
let lastSigned: string; // the txId the App signed — the node echoes it back
let effective: string; // the reader's effective karma — the vouch floor courtesy

function post(id: string, author: string): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 10, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
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
const KBOX = '11'.repeat(32); // a valid 64-hex box id — computeTxId encodes inputs as b32
function memberKarma(key: string): KarmaResult {
  // A member; `effective` drives the vouch-floor courtesy.
  return karmaResult({ userId: key, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1, total: effective, effective, boxes: [{ boxId: KBOX, value: effective }], height: blockHeight });
}

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
      return { vouches: [{ voucherId: ME, targetId: key }], count: 3, next: null };
    },
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({ vouches: vouchSet, count: vouchSet.length, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns, count: cooldowns.length, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
  };
}

function fakeWrite(): WriteClient {
  return {
    submitVouch: async () => {
      writeCalls.push({ kind: 'vouch' });
      // The node echoes the client's own signed txId (as a matching node does).
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

  const app = new App(fakeApi(), fakeWrite(), fakeIdentity());
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  return { app, feed, panes, drive: app as unknown as Drive };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => { vi.useRealTimers(); });

describe('the mark on a feed card', () => {
  it('a member sees the + mark on another author, absent before membership loads', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await flush();
    // Before membership state is read, no mark (member unknown).
    expect(h.feed.querySelector('.vmark')).toBeNull();
    await h.drive.loadMembershipState();
    await flush();
    // Now a member: the + mark on X's card, and the count read for the cache.
    expect(h.feed.querySelector('.vmark.plus')).not.toBeNull();
    expect(targetReads).toContain(X);
  });
});

describe('vouch from the mark', () => {
  it('marks pending at once and lands a vouch ledger entry', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await h.drive.vouch(X);
    await flush();
    // A vouch ledger entry, and the mark reads pending (muted ✓).
    expect(h.drive.ledger.all().some((e) => e.kind === 'vouch' && e.postId === X)).toBe(true);
    expect(h.feed.querySelector('.vmark.check.pending')).not.toBeNull();
    expect(writeCalls.some((c) => c.kind === 'vouch')).toBe(true);
  });

  it('a rejection reverts the mark to + and reports the reason', async () => {
    const h = harness();
    vouchResp.ok = false;
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await h.drive.vouch(X);
    await flush();
    // No entry, the mark back to +, and the reason on the feed.
    expect(h.drive.ledger.all().some((e) => e.kind === 'vouch')).toBe(false);
    expect(h.feed.querySelector('.vmark.plus')).not.toBeNull();
    expect(h.feed.textContent).toContain('vouch rejected');
  });

  it('the poll lands a pending vouch — the mark turns to ✓ in ink', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await h.drive.vouch(X);
    await flush();
    // The node now lists the pair; the tip moves and the poll reconciles.
    vouchSet = [{ boxId: '22'.repeat(32), value: '1', createdAtBlock: 100, voucherId: ME, targetId: X }];
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    expect(h.drive.vouched.has(X)).toBe(true);
    expect(h.drive.ledger.all().some((e) => e.kind === 'vouch')).toBe(false); // landed, entry gone
    expect(h.feed.querySelector('.vmark.check:not(.pending)')).not.toBeNull();
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
    // The window renders in a pane — the key row shows X's whole key.
    const labels = [...h.panes.querySelectorAll('.row > label')].map((l) => l.textContent);
    expect(labels).toContain('key');
    expect(labels).toContain('endorsers');
    expect(h.panes.textContent).toContain(X);
    // The endorsers were read (vouchesByTarget for the subject).
    expect(targetReads).toContain(X);
  });
});

describe('the mark disabled gates', () => {
  it('an escrow held past the tip disables the mark with the held reason (plain digits)', async () => {
    const h = harness();
    cooldowns = [{ boxId: 'e1', value: '1', releaseAtBlock: 200 }]; // > tip (100)
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    const mark = h.feed.querySelector('.vmark') as HTMLButtonElement;
    expect(mark.classList.contains('disabled')).toBe(true);
    expect(mark.disabled).toBe(true);
    expect(mark.title).toBe('your stake from an unvouch is held until block 200');
  });

  it('a balance below the floor disables the mark with the floor reason', async () => {
    const h = harness();
    effective = '5'; // below VOUCH_MIN_BALANCE (11)
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    const mark = h.feed.querySelector('.vmark') as HTMLButtonElement;
    expect(mark.classList.contains('disabled')).toBe(true);
    expect(mark.title).toContain('11 karma');
  });
});

describe('the author window through the App', () => {
  it("a vouched author's window carries the display ✓ on its bar", async () => {
    const h = harness();
    vouchSet = [{ boxId: '22'.repeat(32), value: '1', createdAtBlock: 50, voucherId: ME, targetId: X }];
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    h.drive.openAuthor(X, { from: 'feed' });
    await flush();
    expect(h.panes.querySelector('.bar .vmark.display.check')).not.toBeNull();
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
    // The node drops the pair and posts a cooldown; the poll lands the unvouch.
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
    // Switch identity: the vouch set is cleared, then rebuilt for the new key.
    idState = { pubKeyHex: 'dd'.repeat(32), locked: false };
    vouchSet = [];
    onChangeCb();
    await flush();
    expect(h.drive.vouched.has(X)).toBe(false);
  });
});
