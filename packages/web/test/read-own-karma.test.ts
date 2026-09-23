// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { AppIdentity } from '../src/model/state';
import type { KarmaResult } from '../src/api/dto';
import { karmaResult } from './karma-fixture';

// WEB_INTERFACE → "Paging is keyset, never offset" — the App's `readOwnKarma`
// follows `next` to the end. The first page's per-identity fields
// (`total`, `effective`, `height`, the clocks, the membership fields) stand;
// `boxes` is the concatenation, `boxCount` its length, `next` null. Named on
// the reader's own key by every site (WEB_INTERFACE → The extension → "The
// verified figures", § the karma listing is read whole).

const KEY = 'aa'.repeat(32);

function bareIdentity(): AppIdentity {
  return {
    current: () => null,
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: KEY }),
    create: async () => ({ pubKeyHex: KEY }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: KEY }),
    importFile: async () => ({ pubKeyHex: KEY }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => false,
    onChange: () => {},
  };
}

interface Drive {
  readOwnKarma(key: string): Promise<KarmaResult>;
}

/** A three-page /karma fake. Every page carries the identity's own fields
 *  (`total`, `effective`, `height`, the clocks, the membership) at their
 *  first-page values so the reader can prove the first page's are what land;
 *  `boxes` differ per page, `next` walks the cursor down. */
function threePageApi(): { api: Api; calls: { key: string; after: string | null }[] } {
  const calls: { key: string; after: string | null }[] = [];
  const page = (boxes: KarmaResult['boxes'], next: string | null): KarmaResult =>
    karmaResult({
      userId: KEY,
      total: '900',
      effective: '850',
      boxes,
      boxCount: boxes.length,
      next,
      height: 5000,
      lastActivityBlock: 4800,
      lastDecayBlock: 4900,
      lifetimeLikesReceived: '42',
      memberSinceBlock: 100,
      memberBar: 3,
      memberVouches: 5,
      memberLikes: '77',
      invitesUsed: 1,
      member: true,
      invitesAvailable: 2,
    });
  const api: Api = {
    feed: async () => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async () => ({ id: '00'.repeat(32), content: '', contentHash: '00'.repeat(32), author: KEY, parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 0, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: KEY }),
    status: async () => ({ networkType: 'testnet', blockHeight: 5000, protocolVersion: 1, postCount: 0, pendingPosts: 0, totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0, inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 } }),
    currentBlock: async () => ({ height: 5000, hash: null }),
    karma: async (key, page_opts) => {
      const after = (page_opts && page_opts.after !== undefined ? page_opts.after : null) as string | null;
      calls.push({ key, after });
      if (after === null) {
        return page([{ boxId: '11'.repeat(32), value: '300' }], 'cursor-1');
      }
      if (after === 'cursor-1') {
        // A second page. Every identity-scoped field is expected to match
        // the first page's on the wire — the App keeps the first page's
        // regardless.
        return page([{ boxId: '22'.repeat(32), value: '300' }], 'cursor-2');
      }
      if (after === 'cursor-2') {
        // The end — no `next`.
        return page([{ boxId: '33'.repeat(32), value: '300' }], null);
      }
      throw new Error(`unexpected after=${after}`);
    },
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: KEY, total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
  return { api, calls };
}

describe('readOwnKarma — the whole listing, per WEB_INTERFACE', () => {
  it('follows `next` to the end and concatenates boxes across three pages', async () => {
    const { api, calls } = threePageApi();
    const app = new App(api, undefined, bareIdentity());
    const result = await (app as unknown as Drive).readOwnKarma(KEY);

    // Three pages fetched — the first with no cursor, then the two `next`s.
    expect(calls).toEqual([
      { key: KEY, after: null },
      { key: KEY, after: 'cursor-1' },
      { key: KEY, after: 'cursor-2' },
    ]);
    // The three boxes are in order.
    expect(result.boxes.map((b) => b.boxId)).toEqual([
      '11'.repeat(32), '22'.repeat(32), '33'.repeat(32),
    ]);
    expect(result.boxCount).toBe(3);
    expect(result.next).toBeNull();
  });

  it('keeps the first page\'s `effective`, `height`, `total`, clocks and membership fields', async () => {
    const { api } = threePageApi();
    const app = new App(api, undefined, bareIdentity());
    const result = await (app as unknown as Drive).readOwnKarma(KEY);

    expect(result.userId).toBe(KEY);
    expect(result.effective).toBe('850');
    expect(result.total).toBe('900');
    expect(result.height).toBe(5000);
    expect(result.lastActivityBlock).toBe(4800);
    expect(result.lastDecayBlock).toBe(4900);
    expect(result.lifetimeLikesReceived).toBe('42');
    expect(result.memberSinceBlock).toBe(100);
    expect(result.memberBar).toBe(3);
    expect(result.memberVouches).toBe(5);
    expect(result.memberLikes).toBe('77');
    expect(result.invitesUsed).toBe(1);
    expect(result.member).toBe(true);
    expect(result.invitesAvailable).toBe(2);
  });

  it('a first page whose `next` is null asks once and stops', async () => {
    const calls: { key: string; after: string | null }[] = [];
    const api = (): Api => ({
      feed: async () => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
      thread: async () => null,
      post: async () => ({ id: '00'.repeat(32), content: '', contentHash: '00'.repeat(32), author: KEY, parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 0, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, confirmedAuthor: KEY }),
      status: async () => ({ networkType: 'testnet', blockHeight: 5000, protocolVersion: 1, postCount: 0, pendingPosts: 0, totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0, inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 } }),
      currentBlock: async () => ({ height: 5000, hash: null }),
      karma: async (key, page_opts) => {
        const after = (page_opts && page_opts.after !== undefined ? page_opts.after : null) as string | null;
        calls.push({ key, after });
        return karmaResult({ userId: KEY, total: '0', effective: '0', boxes: [], boxCount: 0, next: null });
      },
      vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
      vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
      vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
      bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
      usernameByOwner: async () => null,
      credits: async () => ({ userId: KEY, total: '0', boxes: [], boxCount: 0, next: null }),
      usernameByName: async () => null,
    });
    const app = new App(api(), undefined, bareIdentity());
    const result = await (app as unknown as Drive).readOwnKarma(KEY);
    expect(calls).toEqual([{ key: KEY, after: null }]);
    expect(result.boxes).toEqual([]);
    expect(result.boxCount).toBe(0);
    expect(result.next).toBeNull();
  });
});
