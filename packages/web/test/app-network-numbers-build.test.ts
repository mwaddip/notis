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
// Three surfaces through the App reach the three groups of call sites:
//
//   · the author window's your-vouch row renders `vouchCooldownBlocks` into a
//     `.hint .mono` under the row — the site in `yourVouchFor`;
//   · the unvouch the App builds carries `vouch.createdAtBlock + cooldown`
//     as the `vouch_escrow` output's `releaseAtBlock` — the site in
//     `submitDeps()`' `network: BUILD_NETWORK`;
//   · the `@profile` window's invite form defaults its bond to the minimum and
//     writes `min`/`max` from the range — the two sites in `ctx()`' `invite`
//     and `canAffordMinBond`.
//
// `/status` answers 99999 for all four of its per-network fields — far from
// each of `profileFor('testnet')`'s (`inviteBondMin` 100n · `inviteBondMax`
// 1000n · `vouchCooldownBlocks` 60 · `inviteProbationBlocks` 43200).

const ME = 'aa'.repeat(32);
const X = 'bb'.repeat(32);
const V1 = 'dd'.repeat(32);
const VOUCH_BOX = '22'.repeat(32);
const KBOX = '11'.repeat(32);
const CREATED_AT = 50;
const BLOCK_HEIGHT = 100;
const FAR = 99999;
const BIG_EFFECTIVE = '100000000'; // covers status' 99999 and the profile's 100

// Module-scoped state the harness mutates — reset in `beforeEach`.
let vouchesByVoucherRows: VouchesVoucherResult['vouches'] = [];
let seenUnvouchTx: Record<string, unknown> | undefined;
let signedTxId: string = '';

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
    boxCount: 1, total: BIG_EFFECTIVE, effective: BIG_EFFECTIVE,
    boxes: [{ boxId: KBOX, value: BIG_EFFECTIVE }], height: BLOCK_HEIGHT,
  });
}

function fakeApi(): Api {
  return {
    feed: async (): Promise<FeedResult> => ({
      posts: [postJson('p1', X)], next: null, pending: [], pendingCount: 0,
    }),
    thread: async () => null,
    post: async (id) => ({ ...postJson(id, X), confirmedAuthor: X }),
    status: async () => statusAt(BLOCK_HEIGHT),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: BLOCK_HEIGHT, hash: null }),
    karma: async (key) => memberKarma(key),
    vouchesByTarget: async (key): Promise<VouchesTargetResult> => ({
      vouches: [{ voucherId: V1, targetId: key, voucherName: null, targetName: null }],
      count: 1, next: null,
    }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> =>
      ({ vouches: vouchesByVoucherRows, count: vouchesByVoucherRows.length, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> =>
      ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async (key) => ({ userId: key, total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

function fakeWrite(): WriteClient {
  return {
    submitUnvouch: async (_targetHex: string, tx: Record<string, unknown>) => {
      seenUnvouchTx = tx;
      return { status: 'pending', txId: signedTxId, expiresAtHeight: BLOCK_HEIGHT + 720 };
    },
  } as unknown as WriteClient;
}

function fakeIdentity(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: ME, locked: false }),
    sign: async (_bytes: Uint8Array, txId: string) => {
      signedTxId = txId;
      return { signature: 'cc'.repeat(64) };
    },
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
  openProfile(): void;
  unvouch(key: string): Promise<void>;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Load prefs/App through `vi.resetModules` and a dynamic import after setting
// (or not) the `notis-network` meta on the shell head. Mounts the App and
// loads the feed and membership state.
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
  return { panes, drive };
}

// The number inside the stakes hint under the `your vouch` row of the author
// window — the `.hint .mono` the view's `yourVouch` renderer writes.
function stakesCooldownNumber(panes: HTMLElement): string | null {
  const yv = [...panes.querySelectorAll('.row')]
    .find((r) => r.querySelector('label')?.textContent === 'your vouch');
  return yv?.querySelector('.hint .mono')?.textContent ?? null;
}

function escrowReleaseAtBlock(tx: Record<string, unknown> | undefined): unknown {
  const outputs = tx?.['outputs'] as Array<Record<string, unknown>> | undefined;
  const escrow = outputs?.find((o) => o['boxType'] === 'vouch_escrow');
  return escrow?.['releaseAtBlock'];
}

function inviteBondInput(panes: HTMLElement): HTMLInputElement | null {
  return panes.querySelector('form.invite-form input[type="number"]');
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vouchesByVoucherRows = [];
  seenUnvouchTx = undefined;
  signedTxId = '';
});
afterEach(() => { vi.resetModules(); });

describe('WEB_INTERFACE → Invariants → "A per-network number is read, never assumed" — the stakes hint', () => {
  it('with no `notis-network` meta, the author window\'s stakes hint reads `vouchCooldownBlocks` from `/status`', async () => {
    const { panes, drive } = await harness({ metaNetwork: null });
    drive.openAuthor(X, { from: 'feed' });
    await flush();
    expect(stakesCooldownNumber(panes)).toBe(String(FAR));
  });

  it('with `notis-network=testnet`, the author window\'s stakes hint reads `vouchCooldownBlocks` from the profile — `/status`\'s 99999 is ignored', async () => {
    const { panes, drive } = await harness({ metaNetwork: 'testnet' });
    drive.openAuthor(X, { from: 'feed' });
    await flush();
    const expected = profileFor('testnet').vouchCooldownBlocks;
    expect(expected).not.toBe(FAR);
    expect(stakesCooldownNumber(panes)).toBe(String(expected));
  });
});

describe('WEB_INTERFACE → Invariants → "A per-network number is read, never assumed" — the unvouch the App builds', () => {
  // The reader has one standing vouch for X, so the author window's your-vouch
  // row shows the `unvouch` word (`yv.kind === 'vouched'`); pressing it runs
  // `submitUnvouchFlow` through `submitDeps()`, whose `network: BUILD_NETWORK`
  // is the only input to the `vouch_escrow` output's `releaseAtBlock`.
  function stageVouchForX(): void {
    vouchesByVoucherRows = [{
      boxId: VOUCH_BOX, value: '1', createdAtBlock: CREATED_AT,
      voucherId: ME, targetId: X, voucherName: null, targetName: null,
    }];
  }

  it('with no `notis-network` meta, `releaseAtBlock` is `createdAtBlock + vouchCooldownBlocks` from `/status`', async () => {
    stageVouchForX();
    const { drive } = await harness({ metaNetwork: null });
    drive.openAuthor(X, { from: 'feed' });
    await flush();
    await drive.unvouch(X);
    await flush();
    expect(escrowReleaseAtBlock(seenUnvouchTx)).toBe(CREATED_AT + FAR);
  });

  it('with `notis-network=testnet`, `releaseAtBlock` is `createdAtBlock + vouchCooldownBlocks` from the profile — `/status`\'s 99999 is ignored', async () => {
    stageVouchForX();
    const { drive } = await harness({ metaNetwork: 'testnet' });
    drive.openAuthor(X, { from: 'feed' });
    await flush();
    await drive.unvouch(X);
    await flush();
    const expected = profileFor('testnet').vouchCooldownBlocks;
    expect(expected).not.toBe(FAR);
    expect(escrowReleaseAtBlock(seenUnvouchTx)).toBe(CREATED_AT + expected);
  });
});

describe('WEB_INTERFACE → Invariants → "A per-network number is read, never assumed" — the invite form', () => {
  // The `@profile` window renders the invite form when the karma loaded holds a
  // member with an invite available and rep that covers the minimum bond
  // (WEB_INTERFACE → The profile window → "The `invites` row"); the default
  // bond and the input's `min`/`max` are written from the one place.
  it('with no `notis-network` meta, the invite form\'s default bond and `min`/`max` read from `/status`', async () => {
    const { panes, drive } = await harness({ metaNetwork: null });
    drive.openProfile();
    await flush();
    const bond = inviteBondInput(panes);
    expect(bond).not.toBeNull();
    expect(bond!.value).toBe(String(FAR));
    expect(bond!.min).toBe(String(FAR));
    expect(bond!.max).toBe(String(FAR));
  });

  it('with `notis-network=testnet`, the invite form\'s default bond and `min`/`max` read from the profile — `/status`\'s 99999 is ignored', async () => {
    const { panes, drive } = await harness({ metaNetwork: 'testnet' });
    drive.openProfile();
    await flush();
    const p = profileFor('testnet');
    expect(p.inviteBondMin.toString()).not.toBe(String(FAR));
    expect(p.inviteBondMax.toString()).not.toBe(String(FAR));
    const bond = inviteBondInput(panes);
    expect(bond).not.toBeNull();
    expect(bond!.value).toBe(p.inviteBondMin.toString());
    expect(bond!.min).toBe(p.inviteBondMin.toString());
    expect(bond!.max).toBe(p.inviteBondMax.toString());
  });
});
