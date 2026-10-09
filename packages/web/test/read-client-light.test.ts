// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeClient, PageError } from '../src/api/client';
import { PageError as PageErrorFromErrors } from '../src/api/errors';
import type { LightJson, WithdrawnJson } from '../src/api/dto';

// `light=1` beside the list reads: every list of the answer is read field by
// field through `readLightRows` (WEB_INTERFACE → The extension → "The light
// read"). A list read brings no bytes and is not checked (→ "The post
// check"); the single post read keeps `tx=1` where a verifier is held
// (→ "The post check" → "the single post read's, asked with `tx=1`").

const VIEWER = 'aa'.repeat(32);
const SUBJECT = 'bb'.repeat(32);
const ID_1 = '00'.repeat(32);
const ID_2 = '11'.repeat(32);

function lightRow(id: string): LightJson {
  return {
    kind: 'light', id, parentRefs: [], status: 'confirmed',
    blockHeight: 100, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
  };
}

function withdrawnRow(id: string): WithdrawnJson {
  return {
    kind: 'withdrawn', id, author: '33'.repeat(32), withdrawnAtHeight: 1, parentRefs: [],
    descendantCount: 0, authorName: null, txId: '44'.repeat(32),
  };
}

let calls: string[];
let answers: unknown[];

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      const body = answers.shift() ?? {};
      return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (): NodeClient => new NodeClient(() => '');

describe('read client — the list reads under light=1 carry light=1 and no tx', () => {
  it('feed under light sends light=1 and no tx', async () => {
    answers.push({ posts: [], pending: [], pendingCount: 0, next: null });
    const c = client();
    await c.feed({ limit: 30 }, VIEWER, undefined, true, false, true);
    expect(calls[0]).toBe(`/posts?limit=30&viewer=${VIEWER}&roots=1&light=1`);
    expect(calls[0]).not.toContain('tx=1');
  });

  it('thread under light sends light=1 and no tx', async () => {
    answers.push({ post: null, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0 });
    const c = client();
    await c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true);
    expect(calls[0]).toBe(`/posts/${SUBJECT}/thread?limit=50&viewer=${VIEWER}&light=1`);
    expect(calls[0]).not.toContain('tx=1');
  });

  it('feed with neither keeps no tx and no light', async () => {
    answers.push({ posts: [], pending: [], pendingCount: 0, next: null });
    const c = client();
    await c.feed({ limit: 30 }, VIEWER);
    expect(calls[0]).toBe(`/posts?limit=30&viewer=${VIEWER}`);
  });
});

describe('read client — the single post read keeps tx=1 where a verifier is held', () => {
  it('post sends tx=1 under withTx; nothing else of the URL moves', async () => {
    answers.push({});
    const c = client();
    await c.post(SUBJECT, VIEWER, true);
    expect(calls[0]).toBe(`/posts/${SUBJECT}?viewer=${VIEWER}&tx=1`);
  });

  it('post sends no tx under no withTx', async () => {
    answers.push({});
    const c = client();
    await c.post(SUBJECT, VIEWER);
    expect(calls[0]).toBe(`/posts/${SUBJECT}?viewer=${VIEWER}`);
  });
});

describe('read client — under light=1 every list is replaced by readLightRows', () => {
  it("feed answers posts and pending as LightJson/WithdrawnJson rows", async () => {
    answers.push({ posts: [lightRow(ID_1), withdrawnRow(ID_2)], pending: [lightRow(ID_1)], pendingCount: 1, next: null });
    const c = client();
    const res = await c.feed({ limit: 30 }, VIEWER, undefined, false, false, true);
    expect(res.posts).toHaveLength(2);
    expect(res.pending).toHaveLength(1);
    expect((res.posts[0] as LightJson).kind).toBe('light');
    expect((res.posts[1] as WithdrawnJson).kind).toBe('withdrawn');
    expect((res.pending[0] as LightJson).kind).toBe('light');
  });

  it('thread answers post, ancestors, descendants and pending as light rows', async () => {
    answers.push({
      post: lightRow(SUBJECT), ancestors: [lightRow(ID_1)], ancestorCount: 1,
      descendants: [lightRow(ID_2)], descendantCount: 1, next: null,
      pending: [lightRow(ID_1)], pendingCount: 1,
    });
    const c = client();
    const res = await c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true);
    expect(res).not.toBeNull();
    expect((res!.post as LightJson).kind).toBe('light');
    expect((res!.ancestors[0] as LightJson).kind).toBe('light');
    expect((res!.descendants[0] as LightJson).kind).toBe('light');
    expect((res!.pending[0] as LightJson).kind).toBe('light');
  });

  it('a thread whose post is null passes under light=1', async () => {
    answers.push({ post: null, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0 });
    const c = client();
    const res = await c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true);
    expect(res).not.toBeNull();
    expect(res!.post).toBeNull();
  });
});

describe('read client — a malformed row in any list of a light answer is a PageError', () => {
  it('a malformed row in feed.posts throws PageError', async () => {
    answers.push({ posts: [{ ...lightRow(ID_1), id: 'oops' }], pending: [], pendingCount: 0, next: null });
    const c = client();
    await expect(c.feed({ limit: 30 }, VIEWER, undefined, false, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a malformed row in feed.pending throws PageError', async () => {
    answers.push({ posts: [], pending: [{ ...lightRow(ID_1), likeCount: -1 }], pendingCount: 0, next: null });
    const c = client();
    await expect(c.feed({ limit: 30 }, VIEWER, undefined, false, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a malformed row in thread.ancestors throws PageError', async () => {
    answers.push({
      post: lightRow(SUBJECT), ancestors: [{ ...lightRow(ID_1), parentRefs: [1, 2] }],
      ancestorCount: 1, descendants: [], descendantCount: 0, next: null, pending: [], pendingCount: 0,
    });
    const c = client();
    await expect(c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a malformed row in thread.descendants throws PageError', async () => {
    answers.push({
      post: lightRow(SUBJECT), ancestors: [], ancestorCount: 0,
      descendants: [{ ...lightRow(ID_1), status: 'rejected' }], descendantCount: 1,
      next: null, pending: [], pendingCount: 0,
    });
    const c = client();
    await expect(c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a malformed row in thread.pending throws PageError', async () => {
    answers.push({
      post: lightRow(SUBJECT), ancestors: [], ancestorCount: 0,
      descendants: [], descendantCount: 0, next: null,
      pending: [{ ...lightRow(ID_1), authorName: 'al ice' }], pendingCount: 1,
    });
    const c = client();
    await expect(c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a malformed subject (thread.post) throws PageError', async () => {
    answers.push({
      post: { ...lightRow(SUBJECT), id: 'short' },
      ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0,
      next: null, pending: [], pendingCount: 0,
    });
    const c = client();
    await expect(c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true)).rejects.toBeInstanceOf(PageError);
  });
});

describe('read client — a light answer whose list is missing or is not an array is a PageError', () => {
  it('a light feed answer whose `pending` is missing throws PageError', async () => {
    answers.push({ posts: [lightRow(ID_1)], pendingCount: 0, next: null });
    const c = client();
    await expect(c.feed({ limit: 30 }, VIEWER, undefined, false, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a light feed answer whose `pending` is null throws PageError', async () => {
    answers.push({ posts: [], pending: null, pendingCount: 0, next: null });
    const c = client();
    await expect(c.feed({ limit: 30 }, VIEWER, undefined, false, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a light feed answer whose `pending` is a string throws PageError', async () => {
    answers.push({ posts: [], pending: 'oops', pendingCount: 0, next: null });
    const c = client();
    await expect(c.feed({ limit: 30 }, VIEWER, undefined, false, false, true)).rejects.toBeInstanceOf(PageError);
  });

  it('a light thread answer whose `ancestors` is missing throws PageError', async () => {
    answers.push({
      post: lightRow(SUBJECT), ancestorCount: 0,
      descendants: [], descendantCount: 0, next: null,
      pending: [], pendingCount: 0,
    });
    const c = client();
    await expect(c.thread(SUBJECT, { limit: 50 }, VIEWER, false, true)).rejects.toBeInstanceOf(PageError);
  });
});

describe('read client — PageError the module exports is the one api/errors defines', () => {
  it("client.PageError is errors.PageError, so no caller's catch misses a throw", () => {
    expect(PageError).toBe(PageErrorFromErrors);
  });
});
