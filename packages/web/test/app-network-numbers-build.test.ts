// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { profileFor } from '@dagsocial/types';
import type { Api } from '../src/api/client';
import type { WriteClient } from '../src/api/write';
import type { AppIdentity } from '../src/model/state';
import type {
  FeedResult, PostJson, KarmaResult, StatusResult, BlockCurrent,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult,
} from '../src/api/dto';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';

// WEB_INTERFACE → Invariants → "A per-network number is read, never assumed":
// a build whose shell head carries `notis-network` reads the four numbers from
// that network's profile, never from a node's `/status`. The App passes
// `BUILD_NETWORK` — read by `prefs` from the meta at module load — to
// `networkNumbers(network, status)` at every site, so the App itself is loaded
// after the meta is set through `vi.resetModules` and a dynamic import.
//
// The author window's your-vouch row is the shortest driver: the stakes
// sentence reads `vouchCooldownBlocks` through `yourVouchFor` and renders it
// into a `.hint .mono` under the row — one of the three sites in `app.ts`
// where `networkNumbers(BUILD_NETWORK, this.state.status)` is called.
// `/status` answers 99999 for all four of its per-network fields — far from
// each of `profileFor('testnet')`'s — so a build that reads the profile shows
// `vouchCooldownBlocks` of 60 and one that reads `/status` shows 99999.

const ME = 'aa'.repeat(32);
const X = 'bb'.repeat(32);
const V1 = 'dd'.repeat(32);
const SIG = 'cc'.repeat(64);
const KBOX = '11'.repeat(32);

// `/status` answers four numbers far from `profileFor('testnet')`'s:
//   inviteBondMin 100n · inviteBondMax 1000n · vouchCooldownBlocks 60 ·
//   inviteProbationBlocks 43200.
const FAR = 99999;

function postJson(id: string, author: string): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0,
    authorName: null, likedByViewer: null, txId: 'ff'.repeat(32),
  };
}

function statusAt(blockHeight: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight, protocolVersion: 1,
    postCount: 1, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0',
    inviteProbationBlocks: FAR, vouchCooldownBlocks: FAR,
    inviteBondMin: String(FAR), inviteBondMax: String(FAR),
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

function memberKarma(key: string): KarmaResult {
  return karmaResult({
    userId: key, member: true, invitesAvailable: 2, memberSinceBlock: 5,
    boxCount: 1, total: '250', effective: '250',
    boxes: [{ boxId: KBOX, value: '250' }], height: 100,
  });
}

function fakeApi(): Api {
  return {
    feed: async (): Promise<FeedResult> => ({
      posts: [postJson('p1', X)], next: null, pending: [], pendingCount: 0,
    }),
    thread: async () => null,
    post: async (id) => ({ ...postJson(id, X), confirmedAuthor: X }),
    status: async () => statusAt(100),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 100, hash: null }),
    karma: async (key) => memberKarma(key),
    vouchesByTarget: async (key): Promise<VouchesTargetResult> => ({
      vouches: [{ voucherId: V1, targetId: key, voucherName: null, targetName: null }],
      count: 1, next: null,
    }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> =>
      ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> =>
      ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async (key) => ({ userId: key, total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

function fakeWrite(): WriteClient {
  return {} as unknown as WriteClient;
}

function fakeIdentity(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: ME, locked: false }),
    sign: async () => ({ signature: SIG }),
    onChange: () => {},
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
  } as unknown as AppIdentity;
}

interface Drive {
  loadFeed(): Promise<void>;
  loadMembershipState(): Promise<void>;
  openAuthor(key: string, origin: { from: 'feed' }): void;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Load the App after setting (or not) the `notis-network` meta on the shell
// head — `prefs.ts` reads the meta once at module load, and the modules are
// reset for a fresh read. Mounts the App and opens an author window for X.
async function harness(opts: { metaNetwork: string | null }): Promise<{
  panes: HTMLElement; drive: Drive;
}> {
  if (opts.metaNetwork !== null) {
    const m = document.createElement('meta');
    m.setAttribute('name', 'notis-network');
    m.setAttribute('content', opts.metaNetwork);
    document.head.appendChild(m);
  }
  vi.resetModules();
  const { App } = await import('../src/app');
  const app = new App(fakeApi(), fakeWrite(), fakeIdentity());
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  const drive = app as unknown as Drive;
  await drive.loadFeed();
  await drive.loadMembershipState();
  await flush();
  drive.openAuthor(X, { from: 'feed' });
  await flush();
  return { panes, drive };
}

// The number inside the stakes hint under the `your vouch` row of the author
// window — the `.hint .mono` the view's `yourVouch` renderer writes.
function stakesCooldownNumber(panes: HTMLElement): string | null {
  const yv = [...panes.querySelectorAll('.row')]
    .find((r) => r.querySelector('label')?.textContent === 'your vouch');
  return yv?.querySelector('.hint .mono')?.textContent ?? null;
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => { vi.resetModules(); });

describe('WEB_INTERFACE → Invariants → "A per-network number is read, never assumed"', () => {
  it('with no `notis-network` meta, the author window\'s stakes hint reads `vouchCooldownBlocks` from `/status`', async () => {
    const { panes } = await harness({ metaNetwork: null });
    expect(stakesCooldownNumber(panes)).toBe(String(FAR));
  });

  it('with `notis-network=testnet`, the author window\'s stakes hint reads `vouchCooldownBlocks` from the profile — `/status`\'s 99999 is ignored', async () => {
    const { panes } = await harness({ metaNetwork: 'testnet' });
    const expected = profileFor('testnet').vouchCooldownBlocks;
    expect(expected).not.toBe(FAR);
    expect(stakesCooldownNumber(panes)).toBe(String(expected));
  });
});
