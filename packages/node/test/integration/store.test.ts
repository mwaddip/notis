import { uid, fixturePostId } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  insertPost,
  setPostBody,
  getPost,
  getMissingBodies,
  queryPosts,
  getPendingPosts,
  confirmPost,
  deletePostRows,
  restorePostRows,
  getParentRefs,
  getSubtree,
  isLivePost,
} from '../../src/store/posts.js';
import { computeContentHash } from '@dagsocial/types';
import { unlinkSync } from 'node:fs';
import type { PostCommit } from '@dagsocial/types';

const TEST_DB = '/tmp/dagsocial-test-posts-store.sqlite';

function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }

function makeCommit(overrides: Partial<PostCommit> & { content?: string } = {}): { commit: PostCommit; content: string } {
  const content = overrides.content ?? 'integration test post';
  const { content: _, ...rest } = overrides;
  const commit: PostCommit = {
    contentHash: computeContentHash(content),
    author: uid('author-integration'),
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular',
    ...rest,
  };
  return { commit, content };
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
    const { commit, content } = makeCommit({ content: 'integration round-trip' });
    const id = fixturePostId(commit);
    insertPost(id, commit, content);
    const retrieved = getPost(id);
    if (!isLivePost(retrieved)) throw new Error('expected StoredPost');
    expect(retrieved.content).toBe('integration round-trip');
    expect(retrieved.contentHash).toBe(hex(commit.contentHash));
    expect(retrieved.author).toEqual(uid('author-integration'));
    expect(retrieved.parentRefs).toEqual([]);
  });

  it('inserts a placeholder and backfills its body', () => {
    const { commit, content } = makeCommit({ content: 'backfill target' });
    const id = fixturePostId(commit);
    insertPost(id, commit, null);
    confirmPost(id, 1, 0);

    expect((getPost(id) as any).content).toBeNull();

    const missing = getMissingBodies(10);
    expect(missing.some(m => m.id === id)).toBe(true);

    const filled = setPostBody(id, content);
    expect(filled).toBe(true);
    expect((getPost(id) as any).content).toBe('backfill target');

    const missing2 = getMissingBodies(10);
    expect(missing2.some(m => m.id === id)).toBe(false);
  });

  it('queryPosts returns live posts ordered newest first', () => {
    const { commit: c1, content: content1 } = makeCommit({ content: 'older' });
    const { commit: c2, content: content2 } = makeCommit({ content: 'newer' });
    insertPost(fixturePostId(c1), c1, content1);
    insertPost(fixturePostId(c2), c2, content2);

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

    const { commit: ac, content: acContent } = makeCommit({ author: alice, content: 'alice post' });
    const { commit: bc, content: bcContent } = makeCommit({ author: bob, content: 'bob post' });
    insertPost(fixturePostId(ac), ac, acContent);
    insertPost(fixturePostId(bc), bc, bcContent);

    const aliceResults = queryPosts({ author: alice });
    expect(aliceResults.every((p) => Buffer.from(p.author).equals(Buffer.from(alice)))).toBe(true);
  });

  it('post lifecycle: pending -> confirm -> not in pending', () => {
    const { commit, content } = makeCommit({ content: 'lifecycle-' + Date.now() });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    const pending = getPendingPosts(100);
    expect(pending.some(p => p.id === postId)).toBe(true);

    confirmPost(postId, 5, 0);

    const afterConfirm = getPendingPosts(100);
    expect(afterConfirm.some(p => p.id === postId)).toBe(false);
  });

  it('getParentRefs returns correct parent IDs', () => {
    const suffix = Date.now().toString(16).padStart(16, '0').slice(-16);
    const refs = ['a1'.repeat(24) + suffix, 'b2'.repeat(24) + suffix];

    const { commit, content } = makeCommit({ parentRefs: refs });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    expect(getParentRefs(postId)).toEqual(refs);
  });

  it('getSubtree returns all descendants across levels', () => {
    const { commit: rootCommit, content: rootContent } = makeCommit({ content: 'tree-root', parentRefs: [] });
    const rootId = fixturePostId(rootCommit);
    insertPost(rootId, rootCommit, rootContent);

    const { commit: childCommit, content: childContent } = makeCommit({ content: 'tree-child', parentRefs: [rootId] });
    const childId = fixturePostId(childCommit);
    insertPost(childId, childCommit, childContent);

    const { commit: gcCommit, content: gcContent } = makeCommit({ content: 'tree-grandchild', parentRefs: [childId] });
    insertPost(fixturePostId(gcCommit), gcCommit, gcContent);

    const subtree = getSubtree(rootId);
    const contents = subtree.map((p) => p.content).sort();
    expect(contents).toEqual(['tree-child', 'tree-grandchild']);
  });

  it('deletePostRows deletes rows, restorePostRows restores them', () => {
    const { commit: rootCommit, content: rootContent } = makeCommit({ content: 'del-root' });
    const rootId = fixturePostId(rootCommit);
    insertPost(rootId, rootCommit, rootContent);
    confirmPost(rootId, 99, 0);

    const deleted = deletePostRows([rootId]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.content).toBe('del-root');
    expect(getPost(rootId)).toBeNull();

    restorePostRows(deleted);
    const restored = getPost(rootId);
    expect(isLivePost(restored)).toBe(true);
    expect((restored as any).content).toBe('del-root');
    expect((restored as any).blockHeight).toBe(99);
  });

  it('getPost returns null for unknown id', () => {
    expect(getPost('definitely-not-a-real-post-id-' + Date.now())).toBeNull();
  });
});
