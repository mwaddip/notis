import { describe, it, expect, vi, afterEach } from 'vitest';
import { NodeClient, PageError, ApiError } from '../src/api/client';

// Every paged read answers a page or throws where a non-2xx throws: an object
// whose list is an array and whose `next` is null or a key — a non-empty string
// with no lone surrogate, which the next read carries as `after`
// (NODE_INTERFACE → "Every list a view returns is a page", WEB_INTERFACE →
// "Paging is keyset, never offset"). Each route is read over a stubbed fetch,
// its list named by the route.

const KEY = 'aa'.repeat(32);
let calls: string[] = [];

function serve(body: unknown, status = 200): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Not OK',
        json: async () => body,
      } as Response;
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
  read: (c: NodeClient) => Promise<unknown>;
  page: (over?: Record<string, unknown>) => Record<string, unknown>;
}

const ROUTES: Route[] = [
  {
    name: 'feed — GET /posts',
    list: 'posts',
    read: (c) => c.feed({ limit: 30 }, undefined, undefined, true),
    page: (over = {}) => ({ posts: [], next: null, pending: [], pendingCount: 0, ...over }),
  },
  {
    name: 'thread — GET /posts/:id/thread',
    list: 'descendants',
    read: (c) => c.thread('ab'.repeat(32), { limit: 50 }),
    page: (over = {}) => ({
      post: null, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0, ...over,
    }),
  },
  {
    name: 'karma — GET /karma/:key',
    list: 'boxes',
    read: (c) => c.karma(KEY),
    page: (over = {}) => ({ userId: KEY, total: '0', effective: '0', boxes: [], boxCount: 0, next: null, height: 1, ...over }),
  },
  {
    name: 'credits — GET /credits/:key',
    list: 'boxes',
    read: (c) => c.credits(KEY),
    page: (over = {}) => ({ userId: KEY, total: '0', boxes: [], boxCount: 0, next: null, ...over }),
  },
  {
    name: 'vouchesByTarget — GET /vouches?target=',
    list: 'vouches',
    read: (c) => c.vouchesByTarget(KEY),
    page: (over = {}) => ({ vouches: [], count: 0, next: null, ...over }),
  },
  {
    name: 'vouchesByVoucher — GET /vouches?voucher=',
    list: 'vouches',
    read: (c) => c.vouchesByVoucher(KEY),
    page: (over = {}) => ({ vouches: [], count: 0, next: null, ...over }),
  },
  {
    name: 'vouchCooldowns — GET /vouches?voucher=&cooldowns=1',
    list: 'cooldowns',
    read: (c) => c.vouchCooldowns(KEY),
    page: (over = {}) => ({ cooldowns: [], count: 0, next: null, ...over }),
  },
  {
    name: 'bonds — GET /invites/:key',
    list: 'bonds',
    read: (c) => c.bonds(KEY),
    page: (over = {}) => ({ bonds: [], bondCount: 0, next: null, ...over }),
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

const WELL_FORMED: Array<{ name: string; next: string | null }> = [
  { name: 'a last page, `next` null', next: null },
  { name: 'a `next` key', next: `1250000000:${'ab'.repeat(32)}` },
  { name: 'a `next` holding a surrogate pair', next: '5:\u{1F600}' },
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
      it(`${w.name} → the page as served`, async () => {
        const body = r.page({ next: w.next });
        serve(body);
        await expect(r.read(client())).resolves.toEqual(body);
      });
    }
    it(`a list holding rows → the page as served`, async () => {
      const body = r.page({ [r.list]: [{ id: 'row' }], next: 'k' });
      serve(body);
      await expect(r.read(client())).resolves.toEqual(body);
    });
  });
}

describe('read client — the page check stands behind the status check', () => {
  it('a non-2xx still throws ApiError, never PageError', async () => {
    serve({}, 500);
    await expect(client().karma(KEY)).rejects.toBeInstanceOf(ApiError);
  });

  it("the thread's 404 is the post gone — null, not a malformed page", async () => {
    serve({}, 404);
    await expect(client().thread('ab'.repeat(32))).resolves.toBeNull();
  });

  it('a read that is not paged takes its body as served', async () => {
    serve({});
    await expect(client().status()).resolves.toEqual({});
    await expect(client().currentBlock()).resolves.toEqual({});
    await expect(client().post('ab'.repeat(32))).resolves.toEqual({});
    await expect(client().usernameByOwner(KEY)).resolves.toEqual({});
  });
});
