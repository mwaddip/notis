import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NodeClient } from '../src/api/client';
import { jsonResponse } from './honest-page';

// The rule the client builds URLs by: a base that ends with `/` and one that
// does not resolve to the same URL — a trailing `/` is stripped, exactly one
// of them (WEB_INTERFACE → "The client is served from the node's own origin").
// Driven through `NodeClient.url`, so the rule is read where the client reads
// the node.

let calls: string[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse({ posts: [], next: null, pending: [], pendingCount: 0 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a base and its trailing-slash twin build the same URL', () => {
  it('strips the one trailing `/` on a base that carries one', async () => {
    const c = new NodeClient(() => 'http://a/');
    await c.feed({ limit: 30 });
    expect(calls[0]).toBe('http://a/posts?limit=30');
  });

  it('leaves a base that carries no trailing `/` as is', async () => {
    const c = new NodeClient(() => 'http://a');
    await c.feed({ limit: 30 });
    expect(calls[0]).toBe('http://a/posts?limit=30');
  });

  it('strips one `/` on a base that ends with `//` — one, not every trailing', async () => {
    const c = new NodeClient(() => 'http://a//');
    await c.feed({ limit: 30 });
    expect(calls[0]).toBe('http://a//posts?limit=30');
  });
});
