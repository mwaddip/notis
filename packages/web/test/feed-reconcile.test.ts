import { describe, it, expect } from 'vitest';
import { reconcileNewer, type RawPage } from '../src/model/feed-reconcile';
import type { PostJson } from '../src/api/dto';

const id = (n: number): string => n.toString(16).padStart(64, '0');
function post(n: number): PostJson {
  return {
    id: id(n), content: `#${n}`, contentHash: '0'.repeat(64), author: 'a'.repeat(64),
    parentRefs: [], protocolVersion: 1, type: 'regular', status: 'confirmed',
    blockHeight: 1, blockIndex: 0, blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
  };
}

describe('reconcileNewer', () => {
  it('pages to the reconnection point and prepends a contiguous run with no hole', async () => {
    // Held top is #100; a burst of #5..#1 arrived across three pages, and page 3
    // reaches the held #100 — the reconnection point.
    const held = [post(100), post(101)];
    const pages: Record<string, RawPage> = {
      null: { posts: [post(5), post(4)], next: 'c1' },
      c1: { posts: [post(3), post(2)], next: 'c2' },
      c2: { posts: [post(1), post(100)], next: 'c3' },
    };
    let calls = 0;
    const r = await reconcileNewer(held, async (after) => { calls++; return pages[String(after)]!; }, 40);

    expect(calls).toBe(3);
    // The collected run is exactly the new posts, then the held top follows with
    // no gap and no repeat — a prepend, not a hole.
    expect(r.posts.map((p) => p.id)).toEqual([5, 4, 3, 2, 1, 100, 101].map(id));
    expect(new Set(r.posts.map((p) => p.id)).size).toBe(r.posts.length);
    expect(r.next).toBeUndefined(); // prepend branch leaves `next` unchanged
    expect(r.newCount).toBe(5);
  });

  it('replaces and resets next when it never reconnects, bounded by the cap', async () => {
    const held = [post(100)];
    let calls = 0;
    const r = await reconcileNewer(
      held,
      async () => { calls++; return { posts: [post(1000 + calls)], next: 'more' }; },
      3,
    );

    expect(calls).toBe(3); // the cap bounds a stream that always has a next
    expect(r.posts.map((p) => p.id)).toEqual([id(1001), id(1002), id(1003)]); // held dropped
    // The old top is not left dangling below the new window — it is gone, not a hole.
    expect(r.posts.some((p) => p.id === id(100))).toBe(false);
    expect(r.next).toBe('more'); // reset so `load older` continues from here
    expect(r.newCount).toBe(3);
  });

  it('reports nothing new and keeps next unchanged when the first page reconnects at once', async () => {
    const held = [post(100)];
    const r = await reconcileNewer(held, async () => ({ posts: [post(100)], next: 'c1' }), 40);
    expect(r.posts.map((p) => p.id)).toEqual([id(100)]);
    expect(r.newCount).toBe(0);
    expect(r.next).toBeUndefined();
  });
});
