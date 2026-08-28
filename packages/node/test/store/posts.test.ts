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

  it('queryPostsPage with author filter', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');

    const { commit: aliceCommit, content: aliceContent } = makeCommit({ content: 'alice post', author: uid('alice') });
    const { commit: bobCommit, content: bobContent } = makeCommit({ content: 'bob post', author: uid('bob') });

    insertPost(fixturePostId(aliceCommit), aliceCommit, aliceContent);
    confirmPost(fixturePostId(aliceCommit), 1, 0);
    insertPost(fixturePostId(bobCommit), bobCommit, bobContent);
    confirmPost(fixturePostId(bobCommit), 1, 1);

    const aliceResult = queryPostsPage({ author: uid('alice'), limit: 50 });
    expect(aliceResult.rows).toHaveLength(1);
    expect(aliceResult.rows[0]!.content).toBe('alice post');

    const allResult = queryPostsPage({ limit: 50 });
    expect(allResult.rows).toHaveLength(2);
  });

  it('queryPostsPage pagination walks next', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');

    for (let i = 0; i < 5; i++) {
      const { commit, content } = makeCommit({ content: `post-${i}` });
      insertPost(fixturePostId(commit), commit, content);
      confirmPost(fixturePostId(commit), 10, i);
    }

    const page1 = queryPostsPage({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0]!.content).toBe('post-4');
    expect(page1.rows[1]!.content).toBe('post-3');
    expect(page1.next).not.toBeNull();

    const page2 = queryPostsPage({ limit: 2, after: page1.next! });
    expect(page2.rows).toHaveLength(2);
    expect(page2.rows[0]!.content).toBe('post-2');
    expect(page2.rows[1]!.content).toBe('post-1');
    expect(page2.next).not.toBeNull();

    const page3 = queryPostsPage({ limit: 2, after: page2.next! });
    expect(page3.rows).toHaveLength(1);
    expect(page3.rows[0]!.content).toBe('post-0');
    expect(page3.next).toBeNull();
  });

  it('queryPostsPage: committed in rows, pending in pending field', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');

    const { commit: early, content: earlyContent } = makeCommit({ content: 'early' });
    const { commit: late, content: lateContent } = makeCommit({ content: 'late' });
    insertPost(fixturePostId(early), early, earlyContent);
    insertPost(fixturePostId(late), late, lateContent);
    confirmPost(fixturePostId(early), 10, 0);
    confirmPost(fixturePostId(late), 10, 1);

    const { commit: pend, content: pendContent } = makeCommit({ content: 'pending' });
    insertPost(fixturePostId(pend), pend, pendContent);

    const result = queryPostsPage({ limit: 50 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.content).toBe('late');
    expect(result.rows[1]!.content).toBe('early');
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.content).toBe('pending');
    expect(result.pendingCount).toBe(1);
  });

  it('confirmPost updates status, blockHeight and blockIndex', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'confirm me' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    const before = getPost(postId);
    expect(before && 'status' in before && before.status).toBe('pending');

    confirmPost(postId, 42, 3);

    const after = getPost(postId);
    expect(after && 'status' in after ? after.status : undefined).toBe('confirmed');
    expect(after && 'blockHeight' in after ? after.blockHeight : undefined).toBe(42);
    expect(after && 'blockIndex' in after ? after.blockIndex : undefined).toBe(3);
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

  it('getSubtreePage returns committed descendants (multi-level)', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');

    const { commit: rootCommit, content: rootContent } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(rootCommit);
    insertPost(rootId, rootCommit, rootContent);
    confirmPost(rootId, 1, 0);

    const { commit: childCommit, content: childContent } = makeCommit({ content: 'child', parentRefs: [rootId] });
    const childId = fixturePostId(childCommit);
    insertPost(childId, childCommit, childContent);
    confirmPost(childId, 2, 0);

    const { commit: gcCommit, content: gcContent } = makeCommit({ content: 'grandchild', parentRefs: [childId] });
    insertPost(fixturePostId(gcCommit), gcCommit, gcContent);
    confirmPost(fixturePostId(gcCommit), 3, 0);

    const result = getSubtreePage(rootId, { limit: 50 });
    expect(result.count).toBe(2);
    const contents = result.rows.map((p) => p.content);
    expect(contents).toEqual(['child', 'grandchild']);
    expect(result.pending).toHaveLength(0);
    expect(result.pendingCount).toBe(0);
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

  it('FeedService.getPost returns WithdrawnJson for a withdrawn post, not null', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'feed withdrawn' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);
    confirmPost(postId, 5, 0);

    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 10, content = NULL WHERE id = ?').run(postId);

    const { FeedService } = await import('../../src/services/feed-service.js');
    const feedService = new FeedService({
      getPost,
      queryPostsPage: () => ({ rows: [], next: null, pending: [], pendingCount: 0 }),
      getLikeRecordCount: () => 0,
      hasLikeRecord: () => false,
      getAncestorsNearest: () => ({ rows: [], count: 0 }),
      getSubtreePage: () => ({ rows: [], next: null, count: 0, pending: [], pendingCount: 0 }),
      getBlockCreatedAt: () => null,
    });

    const result = feedService.getPost(postId);
    expect(result).not.toBeNull();
    expect((result as any).kind).toBe('withdrawn');
    expect((result as any).withdrawnAtHeight).toBe(10);
    expect((result as any).author).toBe(hex(commit.author));
  });

  it('isStoredPost is true and isLivePost is false for the same withdrawn row', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPost } = await importPostsFresh();
    const { isStoredPost, isLivePost } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'guard test' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);
    confirmPost(postId, 5, 0);

    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 10, content = NULL WHERE id = ?').run(postId);

    const result = getPost(postId);
    expect(isStoredPost(result)).toBe(true);
    expect(isLivePost(result)).toBe(false);
  });

  it('withdrawn ancestor and descendant in a thread come back as WithdrawnJson, not PostJson', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPost, getAncestorsNearest, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');

    const { commit: rootCommit, content: rootContent } = makeCommit({ content: 'root' });
    const rootId = fixturePostId(rootCommit);
    insertPost(rootId, rootCommit, rootContent);
    confirmPost(rootId, 1, 0);

    const { commit: childCommit, content: childContent } = makeCommit({
      content: 'child',
      parentRefs: [rootId],
    });
    const childId = fixturePostId(childCommit);
    insertPost(childId, childCommit, childContent);
    confirmPost(childId, 2, 0);

    const { commit: grandCommit, content: grandContent } = makeCommit({
      content: 'grandchild',
      parentRefs: [childId],
    });
    const grandId = fixturePostId(grandCommit);
    insertPost(grandId, grandCommit, grandContent);
    confirmPost(grandId, 3, 0);

    // Withdraw root (ancestor) and grandchild (descendant)
    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 5, content = NULL WHERE id = ?').run(rootId);
    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 6, content = NULL WHERE id = ?').run(grandId);

    const { FeedService } = await import('../../src/services/feed-service.js');
    const feedService = new FeedService({
      getPost,
      queryPostsPage: () => ({ rows: [], next: null, pending: [], pendingCount: 0 }),
      getLikeRecordCount: () => 0,
      hasLikeRecord: () => false,
      getAncestorsNearest,
      getSubtreePage,
      getBlockCreatedAt: () => null,
    });

    const thread = feedService.getThread(childId, { limit: 50 })!;
    expect(thread).not.toBeNull();

    // The subject post is live
    expect((thread.post as any).content).toBe('child');

    // Root ancestor is withdrawn
    expect(thread.ancestors).toHaveLength(1);
    expect((thread.ancestors[0] as any).kind).toBe('withdrawn');
    expect((thread.ancestors[0] as any).withdrawnAtHeight).toBe(5);

    // Grandchild descendant is withdrawn
    expect(thread.descendants).toHaveLength(1);
    expect((thread.descendants[0] as any).kind).toBe('withdrawn');
    expect((thread.descendants[0] as any).withdrawnAtHeight).toBe(6);
  });

  it('a withdrawn post in queryPostsPage comes back as WithdrawnJson', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, getPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');

    const { commit, content } = makeCommit({ content: 'feed withdrawn' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);
    confirmPost(postId, 5, 0);

    getDb().prepare('UPDATE dag_posts SET withdrawn_at_height = 10, content = NULL WHERE id = ?').run(postId);

    const { FeedService } = await import('../../src/services/feed-service.js');
    const feedService = new FeedService({
      getPost,
      queryPostsPage,
      getLikeRecordCount: () => 0,
      hasLikeRecord: () => false,
      getAncestorsNearest: () => ({ rows: [], count: 0 }),
      getSubtreePage: () => ({ rows: [], next: null, count: 0, pending: [], pendingCount: 0 }),
      getBlockCreatedAt: () => null,
    });

    const result = feedService.queryPosts({ limit: 50 });
    const withdrawn = result.posts.find((p) => (p as any).id === postId);
    expect(withdrawn).toBeDefined();
    expect((withdrawn as any).kind).toBe('withdrawn');
    expect((withdrawn as any).withdrawnAtHeight).toBe(10);
  });

  // -------------------------------------------------------------------------
  // getAncestorsNearest
  // -------------------------------------------------------------------------

  it('getAncestorsNearest returns the nearest `limit` ancestors, oldest first', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getAncestorsNearest } = await importPostsFresh();

    initDb(':memory:');

    const { commit: c0, content: ct0 } = makeCommit({ content: 'root', parentRefs: [] });
    const id0 = fixturePostId(c0);
    insertPost(id0, c0, ct0);

    const { commit: c1, content: ct1 } = makeCommit({ content: 'child', parentRefs: [id0] });
    const id1 = fixturePostId(c1);
    insertPost(id1, c1, ct1);

    const { commit: c2, content: ct2 } = makeCommit({ content: 'grandchild', parentRefs: [id1] });
    const id2 = fixturePostId(c2);
    insertPost(id2, c2, ct2);

    const { commit: c3, content: ct3 } = makeCommit({ content: 'great-grandchild', parentRefs: [id2] });
    const id3 = fixturePostId(c3);
    insertPost(id3, c3, ct3);

    // Limit 2: the nearest two ancestors of great-grandchild are grandchild and child
    const result = getAncestorsNearest(id3, 2);
    expect(result.count).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(p => p.content)).toEqual(['child', 'grandchild']);
  });

  it('getAncestorsNearest returns full chain when limit exceeds depth', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, getAncestorsNearest } = await importPostsFresh();

    initDb(':memory:');

    const { commit: c0, content: ct0 } = makeCommit({ content: 'root', parentRefs: [] });
    const id0 = fixturePostId(c0);
    insertPost(id0, c0, ct0);

    const { commit: c1, content: ct1 } = makeCommit({ content: 'child', parentRefs: [id0] });
    const id1 = fixturePostId(c1);
    insertPost(id1, c1, ct1);

    const result = getAncestorsNearest(id1, 50);
    expect(result.count).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.content).toBe('root');
  });

  it('getAncestorsNearest stops at an ancestor with no dag_posts row', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, deletePostRows, getAncestorsNearest } = await importPostsFresh();

    initDb(':memory:');

    const { commit: cS, content: ctS } = makeCommit({ content: 'stump', parentRefs: [] });
    const idS = fixturePostId(cS);
    insertPost(idS, cS, ctS);

    const { commit: cR, content: ctR } = makeCommit({ content: 'reply', parentRefs: [idS] });
    const idR = fixturePostId(cR);
    insertPost(idR, cR, ctR);

    const { commit: cR2, content: ctR2 } = makeCommit({ content: 'reply2', parentRefs: [idR] });
    const idR2 = fixturePostId(cR2);
    insertPost(idR2, cR2, ctR2);

    deletePostRows([idS]);

    const result = getAncestorsNearest(idR2, 10);
    expect(result.count).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.content).toBe('reply');
  });

  it('getAncestorsNearest CTE recursive step searches dag_parent_refs and dag_posts on PK', async () => {
    const { initDb, getDb } = await importDbFresh();
    await importPostsFresh();

    initDb(':memory:');

    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN
         WITH RECURSIVE chain(pid, depth) AS (
           SELECT dpr.parent_id, 1
           FROM dag_parent_refs dpr
           JOIN dag_posts dp ON dp.id = dpr.parent_id
           WHERE dpr.post_id = ?
           UNION ALL
           SELECT dpr.parent_id, c.depth + 1
           FROM dag_parent_refs dpr
           JOIN chain c ON dpr.post_id = c.pid
           JOIN dag_posts dp ON dp.id = dpr.parent_id
         )
         SELECT dp.* FROM (
           SELECT pid, depth FROM chain ORDER BY depth ASC LIMIT ?
         ) nearest
         JOIN dag_posts dp ON dp.id = nearest.pid
         ORDER BY nearest.depth DESC`,
      )
      .all('dummy', 10) as Array<{ detail: string }>;
    const details = plan.map(r => r.detail).join('\n');
    expect(details).toContain('SEARCH dpr USING COVERING INDEX sqlite_autoindex_dag_parent_refs_1 (post_id=?)');
    expect(details).toContain('SEARCH dp USING COVERING INDEX sqlite_autoindex_dag_posts_1 (id=?)');
  });

  // -------------------------------------------------------------------------
  // getSubtreePage
  // -------------------------------------------------------------------------

  it('getSubtreePage returns descendants in committed order with count', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');

    const { commit: cRoot, content: ctRoot } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(cRoot);
    insertPost(rootId, cRoot, ctRoot);
    confirmPost(rootId, 1, 0);

    const { commit: c1, content: ct1 } = makeCommit({ content: 'child-b', parentRefs: [rootId] });
    const id1 = fixturePostId(c1);
    insertPost(id1, c1, ct1);
    confirmPost(id1, 3, 0);

    const { commit: c2, content: ct2 } = makeCommit({ content: 'child-a', parentRefs: [rootId] });
    const id2 = fixturePostId(c2);
    insertPost(id2, c2, ct2);
    confirmPost(id2, 2, 0);

    const { commit: c3, content: ct3 } = makeCommit({ content: 'grandchild', parentRefs: [id1] });
    const id3 = fixturePostId(c3);
    insertPost(id3, c3, ct3);
    confirmPost(id3, 2, 1);

    const result = getSubtreePage(rootId, { limit: 50 });
    expect(result.count).toBe(3);
    expect(result.rows.map(p => p.content)).toEqual(['child-a', 'grandchild', 'child-b']);
  });

  it('getSubtreePage splits pending into its own field', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');

    const { commit: cRoot, content: ctRoot } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(cRoot);
    insertPost(rootId, cRoot, ctRoot);
    confirmPost(rootId, 1, 0);

    const { commit: c1, content: ct1 } = makeCommit({ content: 'confirmed-1', parentRefs: [rootId] });
    const id1 = fixturePostId(c1);
    insertPost(id1, c1, ct1);
    confirmPost(id1, 2, 0);

    const { commit: c2, content: ct2 } = makeCommit({ content: 'confirmed-2', parentRefs: [rootId] });
    const id2 = fixturePostId(c2);
    insertPost(id2, c2, ct2);
    confirmPost(id2, 2, 1);

    // A pending descendant — no confirmPost call
    const { commit: c3, content: ct3 } = makeCommit({ content: 'pending-desc', parentRefs: [rootId] });
    const id3 = fixturePostId(c3);
    insertPost(id3, c3, ct3);

    const full = getSubtreePage(rootId, { limit: 50 });
    expect(full.count).toBe(3);
    expect(full.rows).toHaveLength(2);
    expect(full.pending).toHaveLength(1);
    expect(full.pending[0]!.content).toBe('pending-desc');
    expect(full.pendingCount).toBe(1);

    // Page of 1: committed only, count over all
    const page = getSubtreePage(rootId, { limit: 1 });
    expect(page.count).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(page.next).not.toBeNull();
  });

  // --- keyset pins ---

  it('feed continuation across a head insert: no overlap, no gap', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');
    for (let i = 0; i < 4; i++) {
      const { commit, content } = makeCommit({ content: `p${i}` });
      insertPost(fixturePostId(commit), commit, content);
      confirmPost(fixturePostId(commit), 10, i);
    }

    const page1 = queryPostsPage({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.next).not.toBeNull();
    const page1Ids = new Set(page1.rows.map(p => p.id));

    const { commit: newA, content: newAC } = makeCommit({ content: 'new-a' });
    insertPost(fixturePostId(newA), newA, newAC);
    confirmPost(fixturePostId(newA), 20, 0);
    const { commit: newB, content: newBC } = makeCommit({ content: 'new-b' });
    insertPost(fixturePostId(newB), newB, newBC);
    confirmPost(fixturePostId(newB), 20, 1);

    const page2 = queryPostsPage({ limit: 2, after: page1.next! });
    for (const p of page2.rows) expect(page1Ids.has(p.id)).toBe(false);
    expect(page2.rows).toHaveLength(2);
  });

  it('subtree continuation across a prune: no skip', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, deletePostRows, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');
    const { commit: rootC, content: rootCt } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(rootC);
    insertPost(rootId, rootC, rootCt);
    confirmPost(rootId, 1, 0);

    const childIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { commit, content } = makeCommit({ content: `child-${i}`, parentRefs: [rootId] });
      const id = fixturePostId(commit);
      insertPost(id, commit, content);
      confirmPost(id, 2, i);
      childIds.push(id);
    }

    const page1 = getSubtreePage(rootId, { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.next).not.toBeNull();

    deletePostRows([childIds[0]!]);

    const page2 = getSubtreePage(rootId, { limit: 2, after: page1.next! });
    expect(page2.rows).toHaveLength(1);
  });

  it('exact next on feed: exactly limit → null; limit + 1 → key', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');
    for (let i = 0; i < 2; i++) {
      const { commit, content } = makeCommit({ content: `e${i}` });
      insertPost(fixturePostId(commit), commit, content);
      confirmPost(fixturePostId(commit), 10, i);
    }
    const exact = queryPostsPage({ limit: 2 });
    expect(exact.next).toBeNull();

    const { commit: extra, content: extraC } = makeCommit({ content: 'extra' });
    insertPost(fixturePostId(extra), extra, extraC);
    confirmPost(fixturePostId(extra), 10, 2);
    const withExtra = queryPostsPage({ limit: 2 });
    expect(withExtra.next).not.toBeNull();
  });

  it('exact next on subtree: exactly limit → null; limit + 1 → key', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');
    const { commit: rootC, content: rootCt } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(rootC);
    insertPost(rootId, rootC, rootCt);
    confirmPost(rootId, 1, 0);

    for (let i = 0; i < 2; i++) {
      const { commit, content } = makeCommit({ content: `s${i}`, parentRefs: [rootId] });
      insertPost(fixturePostId(commit), commit, content);
      confirmPost(fixturePostId(commit), 2, i);
    }
    const exact = getSubtreePage(rootId, { limit: 2 });
    expect(exact.next).toBeNull();

    const { commit: extra, content: extraC } = makeCommit({ content: 'extra', parentRefs: [rootId] });
    insertPost(fixturePostId(extra), extra, extraC);
    confirmPost(fixturePostId(extra), 2, 2);
    const withExtra = getSubtreePage(rootId, { limit: 2 });
    expect(withExtra.next).not.toBeNull();
  });

  it('pending window larger than limit on feed', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, queryPostsPage } = await importPostsFresh();

    initDb(':memory:');
    for (let i = 0; i < 3; i++) {
      const { commit, content } = makeCommit({ content: `pend-${i}` });
      insertPost(fixturePostId(commit), commit, content);
    }
    const result = queryPostsPage({ limit: 2 });
    expect(result.pending).toHaveLength(2);
    expect(result.pendingCount).toBe(3);
    expect(result.pending[0]!.content).toBe('pend-2');
  });

  it('pending window larger than limit on subtree', async () => {
    const { initDb } = await importDbFresh();
    const { insertPost, confirmPost, getSubtreePage } = await importPostsFresh();

    initDb(':memory:');
    const { commit: rootC, content: rootCt } = makeCommit({ content: 'root', parentRefs: [] });
    const rootId = fixturePostId(rootC);
    insertPost(rootId, rootC, rootCt);
    confirmPost(rootId, 1, 0);

    for (let i = 0; i < 3; i++) {
      const { commit, content } = makeCommit({ content: `sub-pend-${i}`, parentRefs: [rootId] });
      insertPost(fixturePostId(commit), commit, content);
    }
    const result = getSubtreePage(rootId, { limit: 2 });
    expect(result.pending).toHaveLength(2);
    expect(result.pendingCount).toBe(3);
    expect(result.pending[0]!.content).toBe('sub-pend-2');
  });

  it('EXPLAIN QUERY PLAN: feed page ranges on row value', async () => {
    const { initDb, getDb } = await importDbFresh();
    initDb(':memory:');
    const db = getDb();

    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM dag_posts WHERE status = 'confirmed' AND (block_height, block_index) < (?, ?) ORDER BY block_height DESC, block_index DESC LIMIT ?`,
    ).all(10, 5, 11) as Array<{ detail: string }>;
    const detail = plan.map(r => r.detail).join(' ');
    expect(detail).toContain('(block_height,block_index)<(?,?)');

    const authorPlan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM dag_posts WHERE status = 'confirmed' AND author = ? AND (block_height, block_index) < (?, ?) ORDER BY block_height DESC, block_index DESC LIMIT ?`,
    ).all(Buffer.alloc(32), 10, 5, 11) as Array<{ detail: string }>;
    const authorDetail = authorPlan.map(r => r.detail).join(' ');
    expect(authorDetail).toContain('idx_dag_posts_author_confirmed');
  });

  it('EXPLAIN QUERY PLAN: subtree CTE uses idx_dag_parent_refs_parent', async () => {
    const { initDb, getDb } = await importDbFresh();
    initDb(':memory:');
    const db = getDb();

    const plan = db.prepare(
      `EXPLAIN QUERY PLAN WITH RECURSIVE subtree AS (
         SELECT dp.id FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         WHERE dpr.parent_id = ?
         UNION
         SELECT dp.id FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         JOIN subtree s ON dpr.parent_id = s.id
       )
       SELECT dp.* FROM dag_posts dp
       JOIN subtree s ON dp.id = s.id
       WHERE dp.status = 'confirmed'
       ORDER BY dp.block_height, dp.block_index LIMIT ?`,
    ).all('ab'.repeat(32), 11) as Array<{ detail: string }>;
    expect(plan.some(r => r.detail.includes('idx_dag_parent_refs_parent'))).toBe(true);
  });
});
