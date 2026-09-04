import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeClient } from '../src/api/client';

// The read client stays GET-only; these pin the URLs it builds — a `viewer` query
// carried when passed and omitted when not, and the new `/karma/:key` read.

const VIEWER = 'aa'.repeat(32);
let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as Response;
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
    await c.karma('key1');
    expect(calls[0]).toBe('/karma/key1');

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

    await c.vouchesByVoucher('key1', { after: 'box9' });
    expect(calls[1]).toBe('/vouches?voucher=key1&after=box9');

    await c.vouchCooldowns('key1');
    expect(calls[2]).toBe('/vouches?voucher=key1&cooldowns=1');

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
