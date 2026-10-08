// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createPostResolver } from '../src/extension/post-resolver';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type { PostJson, PostStatus } from '../src/api/dto';

// The extension's resolver (WEB_INTERFACE → The extension → "The resolve"):
// `createPostResolver` wraps the pure `resolvePosts` with a real `fetch`,
// strips a trailing `/` from each base as `NodeClient.url` does, and keeps
// the round-robin pointer across calls.

const hid = (s: string): string =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');

function row(label: string, content: string | null = 'text'): PostJson {
  return {
    id: hid(label), content, contentHash: hid('h' + label),
    author: hid('a'), parentRefs: [], protocolVersion: 1, type: 'regular',
    status: 'confirmed' as PostStatus, blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: hid('tx' + label), tx: 'de'.repeat(16),
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** A fake `fetch` that answers from a FIFO per URL. A `null` entry rejects.
 *  Every call is recorded. */
function fakeFetch(answers: Map<string, Array<{ status: number; body: unknown } | null>>): {
  calls: FetchCall[];
  fetch: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fn = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    const q = answers.get(u) ?? [];
    const next = q.shift();
    if (next === undefined || next === null) return Promise.reject(new Error('refused'));
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: 'OK',
      json: async () => {
        if (next.body === undefined) throw new SyntaxError('not JSON');
        return next.body;
      },
    } as Response);
  }) as unknown as typeof fetch;
  return { calls, fetch: fn };
}

function bound(r: PostJson): PostCheck {
  return { status: 'bound', id: r.id, txBytes: new Uint8Array(0), author: r.author, parent: null };
}
const nothingToBind: PostCheck = { status: 'nothing-to-bind' };

/** A check that reads the first row of each call as a bound full row. */
function checkByFirstRow(rows: unknown[]): PostCheck[] {
  return rows.map((r) => {
    if (typeof r === 'object' && r !== null && typeof (r as PostJson).id === 'string') {
      return bound(r as PostJson);
    }
    return nothingToBind;
  });
}

describe('post-resolver — URL, method, Content-Type and body of one request', () => {
  it('posts /posts/batch?tx=1 with Content-Type application/json and the body {ids}', async () => {
    const r = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    const bounds: PostJson[] = [];
    await resolver.resolve([r.id], (ps) => bounds.push(...ps.map((p) => p.row)));
    expect(net.calls).toHaveLength(1);
    const c = net.calls[0]!;
    expect(c.url).toBe('http://a.test/posts/batch?tx=1');
    expect(c.init?.method).toBe('POST');
    const headers = c.init?.headers as Record<string, string> | undefined;
    expect(headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(c.init?.body))).toEqual({ ids: [r.id] });
    // No credentials and no other query.
    expect(c.init && 'credentials' in c.init ? c.init.credentials : undefined).toBeUndefined();
    expect(bounds).toHaveLength(1);
  });
});

describe('post-resolver — a status outside 2xx, a bad body and a network failure each serve nothing', () => {
  it('a 404 serves nothing and the next node is asked', async () => {
    const r = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 404, body: {} }]],
      ['http://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    const bounds: PostJson[] = [];
    const ends = await resolver.resolve([r.id], (ps) => bounds.push(...ps.map((p) => p.row)));
    expect(ends.size).toBe(0);
    expect(net.calls.map((c) => c.url)).toEqual([
      'http://a.test/posts/batch?tx=1',
      'http://b.test/posts/batch?tx=1',
    ]);
  });

  it('a 500 serves nothing', async () => {
    const r = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 500, body: {} }]],
      ['http://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    const bounds: PostJson[] = [];
    await resolver.resolve([r.id], (ps) => bounds.push(...ps.map((p) => p.row)));
    expect(net.calls.map((c) => c.url)[1]).toBe('http://b.test/posts/batch?tx=1');
  });

  it('a body that is not JSON serves nothing', async () => {
    const r = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 200, body: undefined }]],
      ['http://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    await resolver.resolve([r.id], () => {});
    expect(net.calls.map((c) => c.url)[1]).toBe('http://b.test/posts/batch?tx=1');
  });

  it('a rejected fetch serves nothing', async () => {
    const r = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown } | null>>([
      ['http://a.test/posts/batch?tx=1', [null]],
      ['http://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    await resolver.resolve([r.id], () => {});
    expect(net.calls.map((c) => c.url)[1]).toBe('http://b.test/posts/batch?tx=1');
  });
});

describe('post-resolver — the pointer moves across two calls', () => {
  it('the second call starts at the next node', async () => {
    const r0 = row('r0'); const r1 = row('r1');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r0] } }]],
      ['http://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r1] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    await resolver.resolve([r0.id], () => {});
    await resolver.resolve([r1.id], () => {});
    expect(net.calls.map((c) => c.url)).toEqual([
      'http://a.test/posts/batch?tx=1',
      'http://b.test/posts/batch?tx=1',
    ]);
  });
});

describe('post-resolver — nodes() is read at each call', () => {
  it('a nodes() change between calls moves the second call to the new base', async () => {
    const r0 = row('r0'); const r1 = row('r1');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r0] } }]],
      ['http://c.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r1] } }]],
    ]);
    const net = fakeFetch(ans);
    let bases = ['http://a.test'];
    const resolver = createPostResolver({
      nodes: () => bases, fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    await resolver.resolve([r0.id], () => {});
    bases = ['http://c.test'];
    await resolver.resolve([r1.id], () => {});
    expect(net.calls.map((c) => c.url)).toEqual([
      'http://a.test/posts/batch?tx=1',
      'http://c.test/posts/batch?tx=1',
    ]);
  });
});

describe('post-resolver — a base with a trailing slash', () => {
  it("the url is <base>/posts/batch?tx=1, as NodeClient.url builds its own", async () => {
    const r = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test/'], fetch: net.fetch, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    await resolver.resolve([r.id], () => {});
    expect(net.calls[0]!.url).toBe('http://a.test/posts/batch?tx=1');
  });
});
