import { uid, fixturePostId } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  insertPost,
  getPost,
  queryPosts,
  getPendingPosts,
  confirmPost,
  getParentRefs,
  getSubtree,
  pruneSubtree,
} from '../../src/store/posts.js';
import { insertStump } from '../../src/store/stumps.js';
import { computePostId } from '@dagsocial/types';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type { Post, Stump } from '@dagsocial/types';

const TEST_DB = '/tmp/dagsocial-test-posts-store.sqlite';

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    content: 'integration test post',
    author: uid('author-integration'),
    parentRefs: [],
    protocolVersion: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeStump(rootPostHash: string, overrides: Partial<Stump> = {}): Stump {
  return {
    rootPostHash,
    authorId: uid('author-integration'),
    replyCount: 0,
    upvoteCount: 0,
    trigger: 'author',
    protocolVersion: 1,
    compactedAtBlockHeight: 1,
    ...overrides,
  };
}

describe('posts store (integration)', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  it('inserts and retrieves a post via getPost', () => {
    const post = makePost({ content: 'integration round-trip' });
    insertPost(fixturePostId(post), post, bytes(16));
    const id = fixturePostId(post);
    const retrieved = getPost(id);
    expect(retrieved).not.toBeNull();
    const p = retrieved as Post;
    expect(p.content).toBe('integration round-trip');
    expect(p.author).toEqual(uid('author-integration'));
    expect(p.parentRefs).toEqual([]);
  });

  it('queryPosts returns live posts ordered newest first', () => {
    const post1 = makePost({ content: 'older', timestamp: 1000 });
    const post2 = makePost({ content: 'newer', timestamp: 2000 });
    insertPost(fixturePostId(post1), post1, bytes(8));
    insertPost(fixturePostId(post2), post2, bytes(8));

    const results = queryPosts({});
    const contents = results.map((p) => p.content);
    const idxNewer = contents.indexOf('newer');
    const idxOlder = contents.indexOf('older');
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it('queryPosts filters by author', () => {
    const suffix = Date.now().toString();
    const alice = uid('alice-int-' + suffix);
    const bob = uid('bob-int-' + suffix);

    insertPost(fixturePostId(makePost({ author: alice, content: 'alice post' })), makePost({ author: alice, content: 'alice post' }), bytes(8));
    insertPost(fixturePostId(makePost({ author: bob, content: 'bob post' })), makePost({ author: bob, content: 'bob post' }), bytes(8));

    const aliceResults = queryPosts({ author: alice });
    expect(aliceResults.every((p) => Buffer.from(p.author).equals(Buffer.from(alice)))).toBe(true);

    const bobResults = queryPosts({ author: bob });
    expect(bobResults.every((p) => Buffer.from(p.author).equals(Buffer.from(bob)))).toBe(true);
  });

  it('post lifecycle: pending -> confirm -> not in pending', () => {
    const post = makePost({ content: 'lifecycle-' + Date.now() });
    insertPost(fixturePostId(post), post, bytes(8));
    const postId = fixturePostId(post);

    // Should be pending
    const pending = getPendingPosts(100);
    const pendingIds = pending.map((p) => fixturePostId(p));
    expect(pendingIds).toContain(postId);

    // Confirm
    confirmPost(postId, 5);

    // No longer pending
    const afterConfirm = getPendingPosts(100);
    const afterIds = afterConfirm.map((p) => fixturePostId(p));
    expect(afterIds).not.toContain(postId);
  });

  it('getParentRefs returns correct parent IDs', () => {
    // A ref is `b32` now, so the per-run uniqueness has to live inside the hex
    // rather than in a `'ref-a-'` prefix. The suffix is what keeps two runs
    // against the same (non-`:memory:`) database from colliding.
    const suffix = Date.now().toString(16).padStart(16, '0').slice(-16);
    const refs = ['a1'.repeat(24) + suffix, 'b2'.repeat(24) + suffix];

    const post = makePost({ parentRefs: refs });
    insertPost(fixturePostId(post), post, bytes(8));
    const postId = fixturePostId(post);

    expect(getParentRefs(postId)).toEqual(refs);
  });

  it('getSubtree returns all descendants across levels', () => {
    // Root
    const root = makePost({ content: 'tree-root', parentRefs: [] });
    insertPost(fixturePostId(root), root, bytes(8));
    const rootId = fixturePostId(root);

    // Child
    const child = makePost({ content: 'tree-child', parentRefs: [rootId] });
    insertPost(fixturePostId(child), child, bytes(8));
    const childId = fixturePostId(child);

    // Grandchild
    const grandchild = makePost({ content: 'tree-grandchild', parentRefs: [childId] });
    insertPost(fixturePostId(grandchild), grandchild, bytes(8));

    const subtree = getSubtree(rootId);
    const contents = subtree.map((p) => p.content).sort();
    expect(contents).toEqual(['tree-child', 'tree-grandchild']);
  });

  it('pruneSubtree marks posts as pruned and inserts stump', () => {
    const root = makePost({ content: 'prune-root', parentRefs: [] });
    insertPost(fixturePostId(root), root, bytes(8));
    const rootId = fixturePostId(root);

    const child = makePost({ content: 'prune-child', parentRefs: [rootId] });
    insertPost(fixturePostId(child), child, bytes(8));

    const stump = makeStump(rootId, {
      replyCount: 1,
      upvoteCount: 3,
      compactedAtBlockHeight: 10,
    });

    pruneSubtree(rootId);
    insertStump(stump);

    // Root post should now return a Stump
    const rootResult = getPost(rootId);
    expect(rootResult).not.toBeNull();
    const rootStump = rootResult as Stump;
    expect(rootStump.rootPostHash).toBe(rootId);
    expect(rootStump.replyCount).toBe(1);
    expect(rootStump.upvoteCount).toBe(3);
  });

  it('getPost returns null for unknown id', () => {
    expect(getPost('definitely-not-a-real-post-id-' + Date.now())).toBeNull();
  });
});
