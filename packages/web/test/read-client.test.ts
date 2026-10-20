import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeClient } from '../src/api/client';
import { jsonResponse } from './honest-page';

// The read client stays GET-only; these pin the URLs it builds — a `viewer` query
// carried when passed and omitted when not, and the `/karma/:key` read.

const VIEWER = 'aa'.repeat(32);
const K1 = '11'.repeat(32);
let calls: string[];

// Each route's one honest body a non-paged route or an empty last page of the
// paged routes answers, chosen by the URL's path.
function bodyFor(url: string): unknown {
  const u = new URL(url, 'http://node.test');
  const p = u.pathname;
  if (p === '/posts') return { posts: [], next: null, pending: [], pendingCount: 0 };
  if (p.endsWith('/thread')) return { post: null, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0 };
  if (p.startsWith('/karma/')) return {
    userId: K1, total: '0', effective: '0', boxes: [], boxCount: 0, next: null, height: 1,
    lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
    memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0',
    invitesUsed: 0, member: false, invitesAvailable: 0,
  };
  if (p.startsWith('/credits/')) return { userId: K1, total: '0', boxes: [], boxCount: 0, next: null };
  if (p === '/vouches') {
    if (u.searchParams.has('cooldowns')) return { cooldowns: [], count: 0, next: null };
    return { vouches: [], count: 0, next: null };
  }
  if (p.startsWith('/invites/')) return { bonds: [], bondCount: 0, next: null };
  if (p === '/usernames') return { name: 'x', owner: K1, boxId: K1, claimedAtBlock: 0 };
  if (p.startsWith('/usernames/')) return { name: 'x', owner: K1, boxId: K1, claimedAtBlock: 0 };
  // Any single-post read in these url tests reads a non-null body: a 404
  // elsewhere turns into null, and that path is pinned by its own case.
  if (p.startsWith('/posts/')) return {
    id: K1, content: 'x', contentHash: '00'.repeat(32), author: K1,
    parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 100, blockIndex: 0, blockCreatedAt: 0, likeCount: 0,
    descendantCount: 0, authorName: null, likedByViewer: null,
    txId: 'ff'.repeat(32), confirmedAuthor: null,
  };
  return {};
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse(bodyFor(String(url)));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (): NodeClient => new NodeClient(() => ''); // same-origin (empty base)

describe('read client — the viewer query', () => {
  it('carries viewer on feed, thread and post when passed, omits it when not', async () => {
    const c = client();
    await c.feed({ limit: 30 }, VIEWER);
    expect(calls[0]).toBe(`/posts?limit=30&viewer=${VIEWER}`);

    await c.feed({ limit: 30 });
    expect(calls[1]).toBe('/posts?limit=30');
    expect(calls[1]).not.toContain('viewer');

    await c.post('pid1', VIEWER);
    expect(calls[2]).toBe(`/posts/pid1?viewer=${VIEWER}`);

    await c.post('pid1');
    expect(calls[3]).toBe('/posts/pid1');

    await c.thread('tid', { limit: 50 }, VIEWER);
    expect(calls[4]).toBe(`/posts/tid/thread?limit=50&viewer=${VIEWER}`);
  });
});

describe('read client — karma', () => {
  it('reads /karma/:key and pages with after, and carries no viewer', async () => {
    const c = client();
    await c.karma('key1', { limit: 100 });
    expect(calls[0]).toBe('/karma/key1?limit=100');

    await c.karma('key1', { after: 'boxkey', limit: 100 });
    expect(calls[1]).toBe('/karma/key1?limit=100&after=boxkey');
    expect(calls[1]).not.toContain('viewer');
  });
});

describe('read client — the membership arms', () => {
  it('builds the four GET urls, none carrying viewer', async () => {
    const c = client();
    await c.vouchesByTarget('key1', { limit: 1 });
    expect(calls[0]).toBe('/vouches?target=key1&limit=1');

    await c.vouchesByVoucher('key1', { limit: 50, after: 'box9' });
    expect(calls[1]).toBe('/vouches?voucher=key1&limit=50&after=box9');

    await c.vouchCooldowns('key1', { limit: 50 });
    expect(calls[2]).toBe('/vouches?voucher=key1&cooldowns=1&limit=50');

    await c.bonds('key1', { limit: 50, after: 'b3' });
    expect(calls[3]).toBe('/invites/key1?limit=50&after=b3');

    for (const url of calls) expect(url).not.toContain('viewer');
  });
});

describe('read client — the author-posts filter', () => {
  it('feed carries author when passed and omits it when not', async () => {
    const c = client();
    await c.feed({ limit: 30 }, VIEWER, 'authorkey');
    expect(calls[0]).toBe(`/posts?limit=30&author=authorkey&viewer=${VIEWER}`);

    await c.feed({ limit: 30 }, VIEWER);
    expect(calls[1]).toBe(`/posts?limit=30&viewer=${VIEWER}`);
    expect(calls[1]).not.toContain('author');
  });
});

describe('read client — usernameByOwner', () => {
  it('reads /usernames?owner=<key>', async () => {
    const c = client();
    await c.usernameByOwner('key1');
    expect(calls[0]).toBe('/usernames?owner=key1');
    expect(calls[0]).not.toContain('viewer');
  });

  it('returns null on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    );
    const result = await client().usernameByOwner('key1');
    expect(result).toBeNull();
  });
});

describe('read client — the feed roots filter', () => {
  it('the feed carries roots=1; the author-posts read carries author and no roots', async () => {
    const c = client();
    await c.feed({ limit: 30 }, VIEWER, undefined, true);
    expect(calls[0]).toBe(`/posts?limit=30&viewer=${VIEWER}&roots=1`);

    await c.feed({ limit: 30 }, VIEWER, 'authorkey');
    expect(calls[1]).toBe(`/posts?limit=30&author=authorkey&viewer=${VIEWER}`);
    expect(calls[1]).not.toContain('roots');

    // roots=0 is never sent — the node rejects it, so a falsy roots omits the query.
    await c.feed({ limit: 30 }, VIEWER, undefined, false);
    expect(calls[2]).not.toContain('roots');
  });
});

describe('read client — credits and the handle read', () => {
  it('credits reads /credits/:key and pages with after, carries no viewer', async () => {
    const c = client();
    await c.credits('key1', { limit: 100 });
    expect(calls[0]).toBe('/credits/key1?limit=100');
    await c.credits('key1', { after: 'boxkey', limit: 100 });
    expect(calls[1]).toBe('/credits/key1?limit=100&after=boxkey');
    for (const url of calls) expect(url).not.toContain('viewer');
  });

  it('usernameByName reads /usernames/:name, strips one leading @, returns null on 404', async () => {
    const c = client();
    await c.usernameByName('alice');
    expect(calls[0]).toBe('/usernames/alice');
    await c.usernameByName('@bob');
    expect(calls[1]).toBe('/usernames/bob');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    );
    expect(await client().usernameByName('nope')).toBeNull();
  });
});
