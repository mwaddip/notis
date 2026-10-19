// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createPostResolver } from '../src/extension/post-resolver';
import type { PostCheck } from '@dagsocial/nipopow-client';
import { POST_BATCH_READ_BYTES } from '@dagsocial/nipopow-client';
import { MAX_CONTENT_BYTES, MAX_TX_BYTES } from '@dagsocial/types';
import { BATCH_READ_MAX } from '../src/model/post-resolve';
import type { PostJson, PostStatus } from '../src/api/dto';

// The extension's resolver (WEB_INTERFACE → The extension → "The resolve"):
// `createPostResolver` wraps the pure `resolvePosts` with a real `fetch`,
// trims bases then drops duplicates, hands each `ask` the resolve's abort
// signal, and keeps the round-robin pointer across calls — moved at the
// call, not at the answer.

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

/** A fake `fetch` that answers from a FIFO per URL. A `null` entry rejects,
 *  an entry whose `body` is `undefined` serves text that is not JSON, and
 *  every other entry serves the stringified body. Every call is recorded.
 *  Each answer is a real `Response` built from the body text, so the
 *  resolver's capped reader reads the body as it does from the network. */
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
    const text = next.body === undefined ? 'not json' : JSON.stringify(next.body);
    return Promise.resolve(new Response(text, { status: next.status, statusText: 'OK' }));
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

describe('post-resolver — URL, method, Content-Type, body and signal of one request', () => {
  it('posts /posts/batch?tx=1 with Content-Type application/json, the body {ids} and a signal', async () => {
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
    expect(c.init?.signal).toBeInstanceOf(AbortSignal);
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

describe('post-resolver — trim, then drop duplicates', () => {
  it("['https://a.test/', 'https://a.test', 'https://b.test'] is two nodes", async () => {
    const r0 = row('r0');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['https://a.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r0] } }]],
      ['https://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r0] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['https://a.test/', 'https://a.test', 'https://b.test'],
      fetch: net.fetch, check: checkByFirstRow, now: () => 0, until: () => new Promise(() => {}),
    });
    await resolver.resolve([r0.id], () => {});
    // One request to a.test — the second base is a duplicate under trim.
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe('https://a.test/posts/batch?tx=1');
  });
});

describe("post-resolver — the pointer moves at the call", () => {
  it('two resolve() calls made with no `await` between them, over three nodes: the first goes to A, the second to B', async () => {
    const r0 = row('r0'); const r1 = row('r1');
    const ans = new Map<string, Array<{ status: number; body: unknown }>>([
      ['http://a.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r0] } }]],
      ['http://b.test/posts/batch?tx=1', [{ status: 200, body: { posts: [r1] } }]],
    ]);
    const net = fakeFetch(ans);
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test', 'http://c.test'],
      fetch: net.fetch, check: checkByFirstRow, now: () => 0, until: () => new Promise(() => {}),
    });
    const p1 = resolver.resolve([r0.id], () => {});
    const p2 = resolver.resolve([r1.id], () => {});
    await Promise.all([p1, p2]);
    expect(net.calls.map((c) => c.url).sort()).toEqual([
      'http://a.test/posts/batch?tx=1',
      'http://b.test/posts/batch?tx=1',
    ]);
    // The first chunk of each resolve went to its own node — the pointer
    // moved before the first promise settled.
    const first = net.calls.find((c) => c.url === 'http://a.test/posts/batch?tx=1');
    const second = net.calls.find((c) => c.url === 'http://b.test/posts/batch?tx=1');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
  });
});

// WEB_INTERFACE → The extension → "Every answer is read under its route's cap"
// — a body longer than its cap is read no further, and the request answers as
// one whose body does not parse: it serves nothing, and its ids go on to the
// next node. CONSTANTS → Light client reads — `POST_BATCH_READ_BYTES`.

const worstRow = (label: string): PostJson => ({
  id: hid(label),
  txId: hid('tx' + label),
  content: '"'.repeat(MAX_CONTENT_BYTES),
  contentHash: hid('h' + label),
  author: hid('a' + label),
  parentRefs: [hid('p' + label)],
  protocolVersion: 1,
  type: 'regular',
  status: 'confirmed' as PostStatus,
  blockHeight: 10,
  blockIndex: 0,
  blockCreatedAt: 0,
  likeCount: 0,
  descendantCount: 0,
  authorName: 'A'.repeat(24),
  likedByViewer: true,
  tx: 'ab'.repeat(MAX_TX_BYTES),
});

const boundEvery = (rows: unknown[]): PostCheck[] =>
  rows.map((r) => {
    if (typeof r === 'object' && r !== null && typeof (r as PostJson).id === 'string') {
      return bound(r as PostJson);
    }
    return nothingToBind;
  });

/** Stream `text` as UTF-8 chunks of `chunkSize` bytes, under no
 *  Content-Length. The counter records how many bytes have been enqueued,
 *  and the flag turns true when the reader cancels the stream. */
function streamingResponse(text: string, chunkSize: number): {
  res: Response;
  counts: { pulled: number; cancelled: boolean };
} {
  const bytes = new TextEncoder().encode(text);
  const counts = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counts.pulled >= bytes.byteLength) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, bytes.byteLength - counts.pulled);
      controller.enqueue(bytes.subarray(counts.pulled, counts.pulled + n));
      counts.pulled += n;
    },
    cancel() {
      counts.cancelled = true;
    },
  });
  return { res: new Response(stream, { status: 200 }), counts };
}

/** Stream `bodyBytes` of ASCII `a` as chunks of `chunkSize` bytes, under no
 *  Content-Length. The counter and the flag read what the stream delivered
 *  and whether the reader cancelled it. */
function streamingBytesResponse(bodyBytes: number, chunkSize: number): {
  res: Response;
  counts: { pulled: number; cancelled: boolean };
} {
  const counts = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counts.pulled >= bodyBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, bodyBytes - counts.pulled);
      counts.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(97));
    },
    cancel() {
      counts.cancelled = true;
    },
  });
  return { res: new Response(stream, { status: 200 }), counts };
}

describe("post-resolver — the batch read is capped at POST_BATCH_READ_BYTES", () => {
  it('a 2xx body one byte over the cap serves nothing and the next node is asked', async () => {
    const r = row('r0');
    const target = POST_BATCH_READ_BYTES + 1;
    const skeleton = JSON.stringify({ posts: [r], pad: '' });
    const padLen = target - skeleton.length;
    const bodyText = JSON.stringify({ posts: [r], pad: 'a'.repeat(padLen) });
    const bodyBytes = new TextEncoder().encode(bodyText).byteLength;
    // control — the body is exactly one byte over the cap
    expect(bodyBytes).toBe(POST_BATCH_READ_BYTES + 1);
    const calls: FetchCall[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u === 'http://a.test/posts/batch?tx=1') {
        const { res } = streamingResponse(bodyText, 128 * 1024);
        return Promise.resolve(res);
      }
      if (u === 'http://b.test/posts/batch?tx=1') {
        return Promise.resolve(new Response(JSON.stringify({ posts: [r] }), { status: 200 }));
      }
      return Promise.reject(new Error('unexpected url'));
    }) as unknown as typeof fetch;
    const resolver = createPostResolver({
      nodes: () => ['http://a.test', 'http://b.test'], fetch: fetchFn, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    const bounds: PostJson[] = [];
    const ends = await resolver.resolve([r.id], (ps) => bounds.push(...ps.map((p) => p.row)));
    // control — no id ended unserved or unbound
    expect(ends.size).toBe(0);
    // control — the id was bound by one row
    expect(bounds).toHaveLength(1);
    // last — the second node was asked after the first refused
    expect(calls.map((c) => c.url)[1]).toBe('http://b.test/posts/batch?tx=1');
  });

  it('a body many times the cap is pulled no further than the cap and one chunk', async () => {
    const chunkSize = 1024;
    const totalBytes = POST_BATCH_READ_BYTES * 4;
    const { res, counts } = streamingBytesResponse(totalBytes, chunkSize);
    const calls: FetchCall[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      return Promise.resolve(res);
    }) as unknown as typeof fetch;
    const resolver = createPostResolver({
      nodes: () => ['http://a.test'], fetch: fetchFn, check: checkByFirstRow,
      now: () => 0, until: () => new Promise(() => {}),
    });
    const r = row('r0');
    await resolver.resolve([r.id], () => {});
    // last — pulled no further than the cap and about one chunk; a stream's
    // default queueing strategy may prefetch a chunk ahead of the reader's cancel.
    expect(counts.pulled).toBeLessThanOrEqual(POST_BATCH_READ_BYTES + 2 * chunkSize);
  });

  it('BATCH_READ_MAX rows at 2 · MAX_CONTENT_BYTES content and 2 · MAX_TX_BYTES tx bind', async () => {
    const rows: PostJson[] = [];
    for (let i = 0; i < BATCH_READ_MAX; i++) rows.push(worstRow('r' + i));
    const bodyText = JSON.stringify({ posts: rows });
    const bodyBytes = new TextEncoder().encode(bodyText).byteLength;
    // control — the longest honest body is at most the cap
    expect(bodyBytes).toBeLessThanOrEqual(POST_BATCH_READ_BYTES);
    const calls: FetchCall[] = [];
    const fetchFn = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(bodyText, { status: 200 }));
    }) as unknown as typeof fetch;
    const resolver = createPostResolver({
      nodes: () => ['http://a.test'], fetch: fetchFn, check: boundEvery,
      now: () => 0, until: () => new Promise(() => {}),
    });
    const bounds: PostJson[] = [];
    const ends = await resolver.resolve(rows.map((r) => r.id), (ps) => bounds.push(...ps.map((p) => p.row)));
    // control — no id ended unserved or unbound
    expect(ends.size).toBe(0);
    // last — every row bound, in one request
    expect(bounds).toHaveLength(BATCH_READ_MAX);
  });
});

describe("post-resolver — the signal reads aborted after a deadline-ended resolve", () => {
  it('fetch receives a signal whose aborted turns true', async () => {
    const r = row('r0');
    // A fetch that never resolves — a promise that only settles when the
    // signal aborts (rejects as any aborted fetch does).
    const seenSignals: AbortSignal[] = [];
    const fetchFn = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) seenSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as unknown as typeof fetch;
    // A controlled clock so until(deadline) can be settled by hand.
    let t = 0;
    const waiters: Array<{ at: number; resolve: () => void }> = [];
    const now = (): number => t;
    const until = (at: number): Promise<void> => new Promise<void>((resolve) => {
      if (t >= at) { resolve(); return; }
      waiters.push({ at, resolve });
    });
    const tick = (ms: number): Promise<void> => {
      t += ms;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.at <= t) { waiters[i]!.resolve(); waiters.splice(i, 1); }
      }
      return Promise.resolve().then(() => Promise.resolve());
    };

    const resolver = createPostResolver({
      nodes: () => ['http://a.test'], fetch: fetchFn, check: checkByFirstRow, now, until,
    });
    const p = resolver.resolve([r.id], () => {});
    await tick(11_000); // past BATCH_RESOLVE_MS
    const ends = await p;
    expect(ends.get(r.id)).toBe('unserved');
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]!.aborted).toBe(true);
  });
});
