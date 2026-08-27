import { fixturePostId, makePostCommit } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import {
  initDb,
  closeDb,
  insertPost,
  getPost as storeGetPost,
  queryPosts,
  getLikeRecordCount,
  getLikersForPost,
  getAncestors,
  getSubtree,
  insertStump,
  deletePostRows,
  confirmPost,
  getBlockCreatedAt,
} from '../../src/store/index.js';
import { FeedService } from '../../src/services/feed-service.js';
import type { PostJson } from '../../src/services/feed-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(v: object | null): Record<string, unknown> {
  if (v === null) throw new Error('expected a DTO, got null');
  return Object.fromEntries(Object.entries(v));
}

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function insertTestPost(content: string, author: Uint8Array, parentRefs: string[]): string {
  const commit = makePostCommit(author, content, { parentRefs });
  const postId = fixturePostId(commit);
  insertPost(postId, commit, content);
  return postId;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('feed-service', () => {
  let authorId: Uint8Array;
  let prunedRootId: string;
  let liveRootId: string;
  let liveReplyId: string;
  let feedService: FeedService;

  const stumpScalars = {
    replyCount: 1,
    upvoteCount: 0,
    protocolVersion: PROTOCOL_VERSION,
    compactedAtBlockHeight: 7,
  } as const;

  beforeEach(() => {
    initDb(':memory:');
    const keys = generateKeyPairSync('ed25519');
    authorId = rawPublicKey(keys.publicKey);

    liveRootId = insertTestPost('Live root', authorId, []);
    liveReplyId = insertTestPost('Live reply', authorId, [liveRootId]);

    // A pruned thread: insertStump then deletePostRows, as block-apply does.
    prunedRootId = insertTestPost('Doomed root', authorId, []);
    const doomedReplyId = insertTestPost('Doomed reply', authorId, [prunedRootId]);
    insertStump({
      rootPostHash: prunedRootId,
      authorId,
      ...stumpScalars,
    });
    deletePostRows([prunedRootId, doomedReplyId]);

    feedService = new FeedService({
      getPost: storeGetPost,
      queryPosts,
      getLikeRecordCount,
      getLikersForPost,
      getAncestors,
      getSubtree,
      getBlockCreatedAt,
    });
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // getPost
  // -----------------------------------------------------------------------

  it('getPost returns a live post as serialized PostJson (control)', () => {
    const r = asRecord(feedService.getPost(liveRootId));
    expect(r).not.toBeNull();
    expect(r['id']).toBe(liveRootId);
    expect(r['content']).toBe('Live root');
    expect(r['contentHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(r['author']).toBe(Buffer.from(authorId).toString('hex'));
    expect(r['likeCount']).toBe(0);
    expect(r['likers']).toEqual([]);
  });

  it('getPost on a pruned root returns StumpJson, not the raw Stump', () => {
    const r = asRecord(feedService.getPost(prunedRootId));
    expect(r).not.toBeNull();
    expect(r).toEqual({
      kind: 'stump',
      id: prunedRootId,
      author: Buffer.from(authorId).toString('hex'),
      ...stumpScalars,
    });
    expect(r['author']).toMatch(/^[0-9a-f]{64}$/);
    expect(r['authorId']).toBeUndefined();
    expect(r['rootPostHash']).toBeUndefined();
    expect('content' in r).toBe(false);
    expect('likeCount' in r).toBe(false);
  });

  it('a live post carries no `kind` — clients discriminate on its presence', () => {
    const r = asRecord(feedService.getPost(liveRootId));
    expect('kind' in r).toBe(false);
  });

  it('getPost returns null for an unknown id', () => {
    expect(feedService.getPost('ab'.repeat(32))).toBeNull();
  });

  // -----------------------------------------------------------------------
  // getThread
  // -----------------------------------------------------------------------

  it('getThread returns full thread context for a live post (control)', () => {
    const t = feedService.getThread(liveReplyId);
    expect(t).not.toBeNull();
    expect(t!.post).not.toBeNull();
    expect((t!.post as PostJson).id).toBe(liveReplyId);
    expect(t!.ancestors.map((p) => p.id)).toEqual([liveRootId]);
    expect(t!.descendants).toEqual([]);
  });

  it('getThread on a pruned root returns the stump shell as StumpJson', () => {
    const t = feedService.getThread(prunedRootId);
    expect(t).not.toBeNull();
    expect(t!.ancestors).toEqual([]);
    expect(t!.descendants).toEqual([]);
    expect(t!.post).toEqual({
      kind: 'stump',
      id: prunedRootId,
      author: Buffer.from(authorId).toString('hex'),
      ...stumpScalars,
    });
  });

  it('getThread returns null for an unknown id', () => {
    expect(feedService.getThread('ab'.repeat(32))).toBeNull();
  });

  // -----------------------------------------------------------------------
  // status — the local column, on every path that serves a post
  // -----------------------------------------------------------------------

  it('getPost serves the stored status, and it tracks confirmation', () => {
    expect(asRecord(feedService.getPost(liveRootId))['status']).toBe('pending');

    confirmPost(liveRootId, 42, 0);
    expect(asRecord(feedService.getPost(liveRootId))['status']).toBe('confirmed');
  });

  it('every path that serves a post serves its status', () => {
    confirmPost(liveRootId, 42, 0);

    const listed = feedService.queryPosts({ author: authorId });
    expect((listed.find((p) => p.id === liveRootId) as PostJson).status).toBe('confirmed');
    expect((listed.find((p) => p.id === liveReplyId) as PostJson).status).toBe('pending');

    const thread = feedService.getThread(liveReplyId)!;
    expect((thread.post as PostJson).status).toBe('pending');
    expect(thread.ancestors.map((p) => (p as PostJson).status)).toEqual(['confirmed']);

    const rootThread = feedService.getThread(liveRootId)!;
    expect(rootThread.descendants.map((p) => (p as PostJson).status)).toEqual(['pending']);
  });
});
