import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeClient, PageError, ApiError } from '../src/api/client';
import { jsonResponse } from './honest-page';

// Every paged read answers a page or throws where a non-2xx throws: an object
// whose list is an array of exactly the limit asked where a `next` is named,
// and whose `next` is null or a key — a non-empty string with no lone
// surrogate, which the next read carries as `after` (NODE_INTERFACE → "Every
// list a view returns is a page", WEB_INTERFACE → Reading a node's answer →
// "Every page is held to the page the node serves"). Each route is read over
// a stubbed fetch, its list named by the route.

const KEY = 'aa'.repeat(32);
const KEY2 = 'bb'.repeat(32);
const BOX = 'ab'.repeat(32);
const BOX2 = 'cd'.repeat(32);
let calls: string[] = [];

function serve(body: unknown, status = 200): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse(body, status);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (): NodeClient => new NodeClient(() => '');

interface Route {
  name: string;
  list: string;
  limit: number;
  read: (c: NodeClient) => Promise<unknown>;
  page: (over?: Record<string, unknown>) => Record<string, unknown>;
  row: () => Record<string, unknown>;
}

// Each route's one honest row — the shape its reader rebuilds.
const fullPost = (): Record<string, unknown> => ({
  id: BOX, content: 'x', contentHash: '00'.repeat(32), author: KEY,
  parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed',
  blockHeight: 100, blockIndex: 0, blockCreatedAt: 0, likeCount: 0,
  descendantCount: 0, authorName: null, likedByViewer: null,
  txId: 'ff'.repeat(32),
});

const ROUTES: Route[] = [
  {
    name: 'feed — GET /posts', list: 'posts', limit: 1,
    read: (c) => c.feed({ limit: 1 }, undefined, undefined, true),
    page: (over = {}) => ({ posts: [], next: null, pending: [], pendingCount: 0, ...over }),
    row: () => fullPost(),
  },
  {
    name: 'thread — GET /posts/:id/thread', list: 'descendants', limit: 1,
    read: (c) => c.thread('ab'.repeat(32), { limit: 1 }),
    page: (over = {}) => ({
      post: null, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0, ...over,
    }),
    row: () => fullPost(),
  },
  {
    name: 'karma — GET /karma/:key', list: 'boxes', limit: 1,
    read: (c) => c.karma(KEY, { limit: 1 }),
    page: (over = {}) => ({
      userId: KEY, total: '0', effective: '0', boxes: [], boxCount: 0, next: null, height: 1,
      lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0',
      invitesUsed: 0, member: false, invitesAvailable: 0, ...over,
    }),
    row: () => ({ boxId: BOX, value: '1' }),
  },
  {
    name: 'credits — GET /credits/:key', list: 'boxes', limit: 1,
    read: (c) => c.credits(KEY, { limit: 1 }),
    page: (over = {}) => ({ userId: KEY, total: '0', boxes: [], boxCount: 0, next: null, ...over }),
    row: () => ({ boxId: BOX, value: '1' }),
  },
  {
    name: 'vouchesByTarget — GET /vouches?target=', list: 'vouches', limit: 1,
    read: (c) => c.vouchesByTarget(KEY, { limit: 1 }),
    page: (over = {}) => ({ vouches: [], count: 0, next: null, ...over }),
    row: () => ({ voucherId: KEY2, targetId: KEY, voucherName: null, targetName: null }),
  },
  {
    name: 'vouchesByVoucher — GET /vouches?voucher=', list: 'vouches', limit: 1,
    read: (c) => c.vouchesByVoucher(KEY, { limit: 1 }),
    page: (over = {}) => ({ vouches: [], count: 0, next: null, ...over }),
    row: () => ({ boxId: BOX, value: '1', createdAtBlock: 1, voucherId: KEY, targetId: KEY2, voucherName: null, targetName: null }),
  },
  {
    name: 'vouchCooldowns — GET /vouches?voucher=&cooldowns=1', list: 'cooldowns', limit: 1,
    read: (c) => c.vouchCooldowns(KEY, { limit: 1 }),
    page: (over = {}) => ({ cooldowns: [], count: 0, next: null, ...over }),
    row: () => ({ boxId: BOX, value: '1', releaseAtBlock: 1 }),
  },
  {
    name: 'bonds — GET /invites/:key', list: 'bonds', limit: 1,
    read: (c) => c.bonds(KEY, { limit: 1 }),
    page: (over = {}) => ({ bonds: [], bondCount: 0, next: null, ...over }),
    row: () => ({ id: BOX2, value: '100', inviterId: KEY, inviteePublicKey: KEY2, inviterName: null, inviteeName: null }),
  },
];

function without(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[field];
  return copy;
}

// A lone surrogate as a JSON body carries one — escaped in the text, lone once
// parsed.
const LONE_SURROGATE = JSON.parse('"\\ud800"') as string;

const MALFORMED: Array<{ name: string; body: (r: Route) => unknown }> = [
  { name: 'no `next`', body: (r) => without(r.page(), 'next') },
  { name: 'a numeric `next`', body: (r) => r.page({ next: 7 }) },
  { name: 'an empty `next`', body: (r) => r.page({ next: '' }) },
  { name: 'a `next` holding a lone surrogate', body: (r) => r.page({ next: `5:${LONE_SURROGATE}` }) },
  { name: 'a `next` that is an object', body: (r) => r.page({ next: {} }) },
  { name: 'no list', body: (r) => without(r.page(), r.list) },
  { name: 'a list that is a string', body: (r) => r.page({ [r.list]: 'abc' }) },
  { name: 'a list that is an object', body: (r) => r.page({ [r.list]: {} }) },
  { name: 'a list that is null', body: (r) => r.page({ [r.list]: null }) },
  { name: 'a body that is null', body: () => null },
  { name: 'a body that is an array', body: () => [] },
  { name: 'a body that is a string', body: () => 'page' },
];

const WELL_FORMED: Array<{ name: string; next: string | null; rows: 0 | 1 }> = [
  { name: 'a last page, `next` null', next: null, rows: 0 },
  { name: 'a `next` key, one row at the limit asked', next: `1250000000:${'ab'.repeat(32)}`, rows: 1 },
  { name: 'a `next` holding a surrogate pair, one row at the limit asked', next: '5:\u{1F600}', rows: 1 },
];

for (const r of ROUTES) {
  describe(`read client — ${r.name} answers a page or throws`, () => {
    for (const m of MALFORMED) {
      it(`${m.name} → PageError, after one request`, async () => {
        serve(m.body(r));
        const read = r.read(client());
        await expect(read).rejects.toBeInstanceOf(PageError);
        await expect(read).rejects.toThrow("the node's answer is not a page");
        expect(calls).toHaveLength(1);
      });
    }
    for (const w of WELL_FORMED) {
      it(`${w.name} → the page the reader rebuilds`, async () => {
        const list = w.rows === 1 ? [r.row()] : [];
        const body = r.page({ [r.list]: list, next: w.next });
        serve(body);
        const result = (await r.read(client())) as Record<string, unknown>;
        expect(result['next']).toBe(w.next);
        expect(result[r.list]).toEqual(list);
      });
    }
  });
}

describe('read client — the page check stands behind the status check', () => {
  it('a non-2xx still throws ApiError, never PageError', async () => {
    serve({}, 500);
    await expect(client().karma(KEY, { limit: 1 })).rejects.toBeInstanceOf(ApiError);
  });

  it("the thread's 404 is the post gone — null, not a malformed page", async () => {
    serve({}, 404);
    await expect(client().thread('ab'.repeat(32), { limit: 1 })).resolves.toBeNull();
  });

  it('a non-paged read whose body is not the route answer throws PageError', async () => {
    serve({});
    await expect(client().status()).rejects.toBeInstanceOf(PageError);
    await expect(client().currentBlock()).rejects.toBeInstanceOf(PageError);
    await expect(client().post('ab'.repeat(32))).rejects.toBeInstanceOf(PageError);
    await expect(client().usernameByOwner(KEY)).rejects.toBeInstanceOf(PageError);
  });
});
