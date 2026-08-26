import { uid, fixturePostId } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { computeContentHash } from '@dagsocial/types';
import type { PostCommit, Stump } from '@dagsocial/types';

function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importPostsFresh() {
  return import('../../src/store/posts.js');
}

async function importStumpsFresh() {
  const mod = await import('../../src/store/stumps.js');
  return mod as {
    insertStump: (stump: Stump) => void;
    deleteStump: (id: string) => void;
  };
}

async function importTopology() {
  return import('../../src/store/topology.js');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommit(overrides: Partial<PostCommit> & { content?: string } = {}): { commit: PostCommit; content: string } {
  const content = overrides.content ?? 'Hello, world!';
  const { content: _, ...rest } = overrides;
  const commit: PostCommit = {
    contentHash: computeContentHash(content),
    author: uid('alice123'),
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular',
    ...rest,
  };
  return { commit, content };
}

function makeStump(overrides: Partial<Stump>): Stump {
  return {
    rootPostHash: '0000000000000000000000000000000000000000000000000000000000000000',
    authorId: uid('alice123'),
    replyCount: 0,
    upvoteCount: 0,
    protocolVersion: 1,
    compactedAtBlockHeight: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('posts store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('insertPost + getPost round-trip with body', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPost, isLivePost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'round-trip test' });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, content);

    const result = getPost(postId);
    if (!isLivePost(result)) throw new Error('expected StoredPost');
    expect(result.content).toBe('round-trip test');
    expect(result.contentHash).toBe(hex(commit.contentHash));
    expect(result.author).toEqual(uid('alice123'));
    expect(result.parentRefs).toEqual([]);
    expect(result.protocolVersion).toBe(1);
    expect(result.type).toBe('regular');
    expect(result.status).toBe('pending');
    expect(Object.keys(result).sort()).toEqual(
      ['author', 'blockHeight', 'blockIndex', 'content', 'contentHash', 'id', 'parentRefs', 'protocolVersion', 'status', 'type', 'withdrawnAtHeight'],
    );
  });

  it('insertPost with null body creates a placeholder', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPost, isLivePost } = await importPostsFresh();

    initDb(':memory:');

    const { commit } = makeCommit({ content: 'placeholder test' });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, null);

    const result = getPost(postId);
    expect(result).not.toBeNull();
    expect(isLivePost(result)).toBe(true);

    const retrieved = result as any;
    expect(retrieved.content).toBeNull();
    expect(retrieved.contentHash).toBe(hex(commit.contentHash));
    expect(retrieved.status).toBe('pending');
  });

  it('setPostBody fills a placeholder', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, setPostBody, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'backfill me' });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, null);
    expect((getPost(postId) as any).content).toBeNull();

    const filled = setPostBody(postId, content);
    expect(filled).toBe(true);

    expect((getPost(postId) as any).content).toBe('backfill me');

    // Second call is a no-op
    expect(setPostBody(postId, content)).toBe(false);
  });

  it('setPostBody returns false for nonexistent id', async () => {
    const { initDb } = await importDbFresh();
    const { setPostBody } = await importPostsFresh();

    initDb(':memory:');
    expect(setPostBody('nonexistent', 'body')).toBe(false);
  });

  it('getPost returns null for unknown id', async () => {
    const { initDb } = await importDbFresh();
    const { getPost } = await importPostsFresh();

    initDb(':memory:');

    const result = getPost('nonexistent-id');
    expect(result).toBeNull();
  });

  it('getPost returns Stump for a stump id', async () => {
    const { initDb } = await importDbFresh();
    const { getPost } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();

    initDb(':memory:');

    const stumpId = 'a1'.repeat(32);
    const stump = makeStump({
      rootPostHash: stumpId,
      replyCount: 5,
      upvoteCount: 10,
      compactedAtBlockHeight: 7,
    });
    insertStump(stump);

    const result = getPost(stumpId);
    expect(result).not.toBeNull();
    const retrieved = result as Stump;
    expect(retrieved.rootPostHash).toBe(stumpId);
    expect(retrieved.replyCount).toBe(5);
  });

  it('getPost returns PrunedTombstone for a pruned descendant', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { getPost, insertPost, confirmPost } = await importPostsFresh();
    const { insertStump } = await importStumpsFresh();
    const { insertBlockTopology } = await importTopology();

    initDb(':memory:');

    // Set up a root and a child in topology
    const { commit: rootCommit } = makeCommit({ content: 'root' });
    const rootId = fixturePostId(rootCommit);
    const { commit: childCommit } = makeCommit({ content: 'child', parentRefs: [rootId] });
    const childId = fixturePostId(childCommit);

    // Insert both posts so topology can be built
    insertPost(rootId, rootCommit, 'root');
    insertPost(childId, childCommit, 'child');
    confirmPost(rootId, 1, 0);
    confirmPost(childId, 1, 1);

    // Insert topology rows
    insertBlockTopology(rootId, [], hex(rootCommit.author), 1);
    insertBlockTopology(childId, [rootId], hex(childCommit.author), 1);

    // Now delete the posts and insert a stump for the root
    getDb().prepare('DELETE FROM dag_parent_refs WHERE post_id IN (?, ?)').run(rootId, childId);
    getDb().prepare('DELETE FROM dag_posts WHERE id IN (?, ?)').run(rootId, childId);
    insertStump(makeStump({ rootPostHash: rootId, compactedAtBlockHeight: 5 }));

    // Root id → stump
    const rootResult = getPost(rootId);
    expect(rootResult).not.toBeNull();
    expect('rootPostHash' in rootResult!).toBe(true);

    // Child id → PrunedTombstone
    const childResult = getPost(childId) as any;
    expect(childResult).not.toBeNull();
    expect(childResult.kind).toBe('pruned');
    expect(childResult.id).toBe(childId);
    expect(childResult.rootPostHash).toBe(rootId);
    expect(childResult.compactedAtBlockHeight).toBe(5);
  });

  it('getMissingBodies returns placeholders newest first', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getMissingBodies } = await importPostsFresh();

    initDb(':memory:');

    const { commit: c1 } = makeCommit({ content: 'first' });
    const id1 = fixturePostId(c1);
    const { commit: c2 } = makeCommit({ content: 'second' });
    const id2 = fixturePostId(c2);
    const { commit: c3 } = makeCommit({ content: 'third with body' });
    const id3 = fixturePostId(c3);

    insertPost(id1, c1, null);
    insertPost(id2, c2, null);
    insertPost(id3, c3, 'third with body');

    confirmPost(id1, 1, 0);
    confirmPost(id2, 2, 0);
    confirmPost(id3, 3, 0);

    const missing = getMissingBodies(10);
    expect(missing).toHaveLength(2);
    // Newest first: id2 at height 2, id1 at height 1
    expect(missing[0]!.id).toBe(id2);
    expect(missing[1]!.id).toBe(id1);
    expect(missing[0]!.contentHash).toBe(hex(c2.contentHash));
  });

  it('queryPosts with author filter', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, queryPosts } = await importPostsFresh();

    initDb(':memory:');

    const { commit: aliceCommit, content: aliceContent } = makeCommit({ content: 'alice post', author: uid('alice') });
    const { commit: bobCommit, content: bobContent } = makeCommit({ content: 'bob post', author: uid('bob') });

    insertPost(fixturePostId(aliceCommit), aliceCommit, aliceContent);
    insertPost(fixturePostId(bobCommit), bobCommit, bobContent);

    const aliceResults = queryPosts({ author: uid('alice') });
    expect(aliceResults).toHaveLength(1);
    expect(aliceResults[0]!.content).toBe('alice post');

    const allResults = queryPosts({});
    expect(allResults).toHaveLength(2);
  });

  it('queryPosts with limit/offset pagination', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, queryPosts } = await importPostsFresh();

    initDb(':memory:');

    for (let i = 0; i < 5; i++) {
      const { commit, content } = makeCommit({ content: `post-${i}` });
      insertPost(fixturePostId(commit), commit, content);
    }

    const all = queryPosts({});
    expect(all).toHaveLength(5);

    const page1 = queryPosts({ limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.content).toBe('post-4');
    expect(page1[1]!.content).toBe('post-3');

    const page2 = queryPosts({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
    expect(page2[0]!.content).toBe('post-2');
    expect(page2[1]!.content).toBe('post-1');

    const page3 = queryPosts({ limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
    expect(page3[0]!.content).toBe('post-0');
  });

  it('queryPosts: pending above confirmed, confirmed by (block_height, block_index)', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, queryPosts } = await importPostsFresh();

    initDb(':memory:');

    const { commit: early, content: earlyContent } = makeCommit({ content: 'early' });
    const { commit: late, content: lateContent } = makeCommit({ content: 'late' });
    insertPost(fixturePostId(early), early, earlyContent);
    insertPost(fixturePostId(late), late, lateContent);
    confirmPost(fixturePostId(early), 10, 0);
    confirmPost(fixturePostId(late), 10, 1);

    const { commit: pend, content: pendContent } = makeCommit({ content: 'pending' });
    insertPost(fixturePostId(pend), pend, pendContent);

    const all = queryPosts({});
    expect(all).toHaveLength(3);
    expect(all[0]!.content).toBe('pending');
    expect(all[1]!.content).toBe('late');
    expect(all[2]!.content).toBe('early');
  });

  it('getPendingPosts returns oldest first', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPendingPosts } = await importPostsFresh();

    initDb(':memory:');

    for (const label of ['oldest', 'middle', 'newest']) {
      const { commit, content } = makeCommit({ content: label });
      insertPost(fixturePostId(commit), commit, content);
    }

    const pending = getPendingPosts(10);
    expect(pending).toHaveLength(3);
    expect(pending[0]!.content).toBe('oldest');
    expect(pending[1]!.content).toBe('middle');
    expect(pending[2]!.content).toBe('newest');
  });

  it('getPendingPosts respects the limit parameter', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getPendingPosts } = await importPostsFresh();

    initDb(':memory:');

    for (let i = 0; i < 5; i++) {
      const { commit, content } = makeCommit({ content: `pending-${i}` });
      insertPost(fixturePostId(commit), commit, content);
    }

    const limited = getPendingPosts(3);
    expect(limited).toHaveLength(3);
    expect(limited[0]!.content).toBe('pending-0');
    expect(limited[1]!.content).toBe('pending-1');
    expect(limited[2]!.content).toBe('pending-2');
  });

  it('confirmPost updates status, blockHeight and blockIndex', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPendingPosts } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'confirm me' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    expect(getPendingPosts(10)).toHaveLength(1);

    confirmPost(postId, 42, 3);

    expect(getPendingPosts(10)).toHaveLength(0);

    const row = getDb()
      .prepare('SELECT status, block_height, block_index FROM dag_posts WHERE id = ?')
      .get(postId) as { status: string; block_height: number; block_index: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('confirmed');
    expect(row!.block_height).toBe(42);
    expect(row!.block_index).toBe(3);
  });

  it('getParentRefs returns array of parent IDs', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getParentRefs } = await importPostsFresh();

    initDb(':memory:');

    const refs3 = ['a1'.repeat(32), 'b2'.repeat(32), 'c3'.repeat(32)];
    const { commit, content } = makeCommit({ parentRefs: refs3 });
    insertPost(fixturePostId(commit), commit, content);

    const refs = getParentRefs(fixturePostId(commit));
    expect(refs).toEqual(refs3);
  });

  it('getSubtree returns all descendants (multi-level)', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getSubtree } = await importPostsFresh();

    initDb(':memory:');

    const { commit: rootCommit, content: rootContent } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(rootCommit);
    insertPost(rootId, rootCommit, rootContent);

    const { commit: childCommit, content: childContent } = makeCommit({ content: 'child', parentRefs: [rootId] });
    const childId = fixturePostId(childCommit);
    insertPost(childId, childCommit, childContent);

    const { commit: gcCommit, content: gcContent } = makeCommit({ content: 'grandchild', parentRefs: [childId] });
    insertPost(fixturePostId(gcCommit), gcCommit, gcContent);

    const subtree = getSubtree(rootId);
    expect(subtree).toHaveLength(2);
    const contents = subtree.map((p) => p.content).sort();
    expect(contents).toEqual(['child', 'grandchild']);
  });

  it('deletePostRows deletes rows and returns them for the journal', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, deletePostRows, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit: c1, content: content1 } = makeCommit({ content: 'root' });
    const id1 = fixturePostId(c1);
    const { commit: c2, content: content2 } = makeCommit({ content: 'child', parentRefs: [id1] });
    const id2 = fixturePostId(c2);

    insertPost(id1, c1, content1);
    insertPost(id2, c2, content2);
    confirmPost(id1, 1, 0);
    confirmPost(id2, 1, 1);

    const deleted = deletePostRows([id1, id2]);
    expect(deleted).toHaveLength(2);
    expect(deleted[0]!.id).toBe(id1);
    expect(deleted[0]!.content).toBe('root');
    expect(deleted[1]!.id).toBe(id2);
    expect(deleted[1]!.parentRefs).toEqual([id1]);

    // Rows are gone
    expect(getPost(id1)).toBeNull();
    expect(getPost(id2)).toBeNull();

    // Parent refs are gone
    const refs = getDb()
      .prepare('SELECT * FROM dag_parent_refs WHERE post_id IN (?, ?)')
      .all(id1, id2);
    expect(refs).toHaveLength(0);
  });

  it('restorePostRows restores deleted rows', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, deletePostRows, restorePostRows, getPost, isLivePost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'restore me' });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, content);
    confirmPost(postId, 1, 0);

    const deleted = deletePostRows([postId]);
    expect(getPost(postId)).toBeNull();

    restorePostRows(deleted);
    const restored = getPost(postId);
    expect(isLivePost(restored)).toBe(true);
    expect((restored as any).content).toBe('restore me');
    expect((restored as any).status).toBe('confirmed');
    expect((restored as any).blockHeight).toBe(1);
  });

  it('deletePendingPost removes a pending row', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, deletePendingPost, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'will be deleted' });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, content);
    expect(getPost(postId)).not.toBeNull();

    deletePendingPost(postId);
    expect(getPost(postId)).toBeNull();
  });

  it('deletePendingPost does not delete a confirmed row', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, deletePendingPost, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'confirmed' });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, content);
    confirmPost(postId, 1, 0);

    deletePendingPost(postId);
    expect(getPost(postId)).not.toBeNull();
  });

  it('insertPost stores under the id it is given', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'fresh post', author: new Uint8Array(32).fill(9) });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    const row = getDb()
      .prepare('SELECT content FROM dag_posts WHERE id = ?')
      .get(postId) as any;
    expect(row.content).toBe('fresh post');
  });

  it('isLivePost discriminates correctly', async () => {
    const { isLivePost } = await importPostsFresh();

    expect(isLivePost(null)).toBe(false);
    expect(isLivePost({ rootPostHash: 'abc', authorId: new Uint8Array(32), replyCount: 0, upvoteCount: 0, protocolVersion: 1, compactedAtBlockHeight: 1 })).toBe(false);
    expect(isLivePost({ kind: 'pruned' as const, id: 'x', author: '00', rootPostHash: 'y', compactedAtBlockHeight: 1 })).toBe(false);
    expect(isLivePost({
      id: 'x', content: null, contentHash: '00', author: new Uint8Array(32),
      parentRefs: [], protocolVersion: 1, type: 'regular' as const,
      status: 'pending' as const, blockHeight: null, blockIndex: null,
      withdrawnAtHeight: null,
    })).toBe(true);
  });

  it('isLivePost returns false for a withdrawn post', async () => {
    const { isLivePost } = await importPostsFresh();

    expect(isLivePost({
      id: 'x', content: null, contentHash: '00', author: new Uint8Array(32),
      parentRefs: [], protocolVersion: 1, type: 'regular' as const,
      status: 'confirmed' as const, blockHeight: 5, blockIndex: 0,
      withdrawnAtHeight: 10,
    })).toBe(false);
  });

  it('a withdrawn row is excluded from getMissingBodies, getPlaceholdersAt, and setPostBody', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getMissingBodies, getPlaceholdersAt, setPostBody } = await importPostsFresh();

    initDb(':memory:');

    const { commit } = makeCommit({ content: 'will withdraw' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, null);
    confirmPost(postId, 5, 0);

    // Mark as withdrawn directly
    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = ? WHERE id = ?').run(10, postId);

    expect(getMissingBodies(100)).toEqual([]);
    expect(getPlaceholdersAt(5)).toEqual([]);
    expect(setPostBody(postId, 'resurrected')).toBe(false);
  });

  it('reorg round-trip: a withdrawn row through deletePostRows → restorePostRows comes back still withdrawn', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, deletePostRows, restorePostRows, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'withdraw me' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);
    confirmPost(postId, 5, 0);

    // Mark as withdrawn directly, then null the content (as withdrawal does)
    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 10, content = NULL WHERE id = ?').run(postId);

    const deleted = deletePostRows([postId]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.withdrawnAtHeight).toBe(10);
    expect(deleted[0]!.content).toBeNull();

    restorePostRows(deleted);
    const restored = getPost(postId) as any;
    expect(restored).not.toBeNull();
    expect(restored.withdrawnAtHeight).toBe(10);
    expect(restored.content).toBeNull();

    // The restored row must NOT appear in getMissingBodies
    const { getMissingBodies } = await importPostsFresh();
    expect(getMissingBodies(100)).toEqual([]);
  });

  it('getPost returns a withdrawn post as a StoredPost with withdrawnAtHeight set, not null', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPost, isLivePost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'to be withdrawn' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);
    confirmPost(postId, 5, 0);

    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 10, content = NULL WHERE id = ?').run(postId);

    const result = getPost(postId);
    expect(result).not.toBeNull();
    expect(isLivePost(result)).toBe(false);
    expect((result as any).withdrawnAtHeight).toBe(10);
    expect((result as any).status).toBe('confirmed');
  });
});
