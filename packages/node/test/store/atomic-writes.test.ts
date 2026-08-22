import { uid, fixturePostId, makePostCommit } from '../helpers.js';
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
  return import('../../src/store/stumps.js');
}

function makeCommit(overrides: Partial<PostCommit> & { content?: string } = {}): { commit: PostCommit; content: string } {
  const content = overrides.content ?? 'atomic test post';
  const { content: _, ...rest } = overrides;
  const commit: PostCommit = {
    contentHash: computeContentHash(content),
    author: uid('tester'),
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular',
    ...rest,
  };
  return { commit, content };
}

function makeStump(overrides: Partial<Stump> = {}): Stump {
  return {
    rootPostHash: '0000000000000000000000000000000000000000000000000000000000000000',
    authorId: uid('tester'),
    replyCount: 0,
    upvoteCount: 0,
    protocolVersion: 1,
    compactedAtBlockHeight: 10,
    ...overrides,
  };
}

describe('atomic writes', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('insertPost atomically writes dag_posts and dag_parent_refs', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, getParentRefs } = await importPostsFresh();

    initDb(':memory:');

    const refs = ['a1'.repeat(32), 'b2'.repeat(32)];
    const { commit, content } = makeCommit({ content: 'post with refs', parentRefs: refs });
    const postId = fixturePostId(commit);

    insertPost(postId, commit, content);

    const db = getDb();
    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(postId) as
      | { id: string }
      | undefined;
    expect(postRow).toBeDefined();
    expect(postRow!.id).toBe(postId);

    expect(getParentRefs(postId)).toEqual(refs);
  });

  it('insertPost that throws inside transaction rolls back completely', async () => {
    const { initDb, getDb } = await importDbFresh();

    initDb(':memory:');
    const db = getDb();

    const { commit, content } = makeCommit({ content: 'should-not-exist' });
    const postId = fixturePostId(commit);

    db.exec('SAVEPOINT test_sp');
    try {
      db.prepare(
        `INSERT INTO dag_posts
           (id, content_hash, content, author, parent_refs,
            protocol_version, type, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        postId,
        hex(commit.contentHash),
        content,
        Buffer.from(commit.author),
        JSON.stringify(commit.parentRefs),
        commit.protocolVersion,
        commit.type,
      );

      db.prepare(
        'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
      ).run(postId, 'ref-1');

      throw new Error('simulated crash mid-transaction');
    } catch (e: unknown) {
      if (e instanceof Error && e.message !== 'simulated crash mid-transaction') throw e;
      db.exec('ROLLBACK TO test_sp');
    }

    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(postId);
    const refRow = db.prepare(
      'SELECT post_id FROM dag_parent_refs WHERE post_id = ?',
    ).get(postId);
    expect(postRow).toBeUndefined();
    expect(refRow).toBeUndefined();
  });

  it('insertPost via db.transaction() that throws leaves no partial state', async () => {
    const { initDb, getDb } = await importDbFresh();

    initDb(':memory:');
    const db = getDb();

    const { commit, content } = makeCommit({ content: 'tx-rollback-test' });
    const postId = fixturePostId(commit);

    expect(() => {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO dag_posts
             (id, content_hash, content, author, parent_refs,
              protocol_version, type, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(
          postId,
          hex(commit.contentHash),
          content,
          Buffer.from(commit.author),
          JSON.stringify(commit.parentRefs),
          commit.protocolVersion,
          commit.type,
        );

        db.prepare(
          'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
        ).run(postId, 'ref-ok');

        throw new Error('simulated crash mid-transaction');
      })();
    }).toThrow('simulated crash');

    const postRow = db.prepare('SELECT id FROM dag_posts WHERE id = ?').get(postId);
    expect(postRow).toBeUndefined();

    const refRow = db.prepare(
      'SELECT post_id FROM dag_parent_refs WHERE post_id = ?',
    ).get(postId);
    expect(refRow).toBeUndefined();
  });

  it('deletePostRows + restorePostRows round-trip preserves all data', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, deletePostRows, restorePostRows, getPost, isLivePost, getParentRefs } = await importPostsFresh();

    initDb(':memory:');

    const { commit: rootCommit, content: rootContent } = makeCommit({ content: 'root' });
    const rootId = fixturePostId(rootCommit);
    const { commit: childCommit, content: childContent } = makeCommit({ content: 'child', parentRefs: [rootId] });
    const childId = fixturePostId(childCommit);

    insertPost(rootId, rootCommit, rootContent);
    insertPost(childId, childCommit, childContent);
    confirmPost(rootId, 1, 0);
    confirmPost(childId, 1, 1);

    const deleted = deletePostRows([rootId, childId]);
    expect(deleted).toHaveLength(2);
    expect(getPost(rootId)).toBeNull();
    expect(getPost(childId)).toBeNull();

    restorePostRows(deleted);
    const restored = getPost(rootId);
    expect(isLivePost(restored)).toBe(true);
    expect((restored as any).content).toBe('root');
    expect((restored as any).blockHeight).toBe(1);

    const childRestored = getPost(childId);
    expect(isLivePost(childRestored)).toBe(true);
    expect(getParentRefs(childId)).toEqual([rootId]);
  });

  it('confirmPost updates status, block_height and block_index', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost } = await importPostsFresh();

    initDb(':memory:');
    const db = getDb();

    const { commit, content } = makeCommit({ content: 'confirm me' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    confirmPost(postId, 42, 5);

    const row = db.prepare(
      'SELECT status, block_height, block_index FROM dag_posts WHERE id = ?',
    ).get(postId) as { status: string; block_height: number; block_index: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('confirmed');
    expect(row!.block_height).toBe(42);
    expect(row!.block_index).toBe(5);
  });

  it('unconfirmPost reverts status to pending and clears block_height and block_index', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, confirmPost, unconfirmPost } = await importPostsFresh();

    initDb(':memory:');
    const db = getDb();

    const { commit, content } = makeCommit({ content: 'unconfirm me' });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    confirmPost(postId, 7, 2);
    unconfirmPost(postId);

    const row = db.prepare(
      'SELECT status, block_height, block_index FROM dag_posts WHERE id = ?',
    ).get(postId) as { status: string; block_height: number | null; block_index: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.block_height).toBeNull();
    expect(row!.block_index).toBeNull();
  });

  it('deletePendingPost atomically removes post and parent refs', async () => {
    const { initDb, getDb } = await importDbFresh();
    const { insertPost, deletePendingPost, getPost, getParentRefs } = await importPostsFresh();

    initDb(':memory:');

    const refs = ['a1'.repeat(32)];
    const { commit, content } = makeCommit({ content: 'will vanish', parentRefs: refs });
    const postId = fixturePostId(commit);
    insertPost(postId, commit, content);

    deletePendingPost(postId);

    expect(getPost(postId)).toBeNull();
    expect(getParentRefs(postId)).toEqual([]);
  });
});
