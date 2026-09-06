import { fixturePostId, makePostCommit, seedProvenance, uid } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import type { VouchBox } from '@dagsocial/types';
import {
  initDb,
  closeDb,
  insertPost,
  getPost as storeGetPost,
  queryPostsPage,
  getLikeRecordCount,
  getDescendantCount,
  getVouchCountForTarget,
  hasLikeRecord,
  getAncestorsNearest,
  getSubtreePage,
  insertBox,
  confirmPost,
  withdrawPost,
  getBlockCreatedAt,
} from '../../src/store/index.js';
import { FeedService } from '../../src/services/feed-service.js';
import type { PostJson, WithdrawnJson } from '../../src/services/feed-service.js';

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
  let liveRootId: string;
  let liveReplyId: string;
  let feedService: FeedService;

  beforeEach(() => {
    initDb(':memory:');
    const keys = generateKeyPairSync('ed25519');
    authorId = rawPublicKey(keys.publicKey);

    liveRootId = insertTestPost('Live root', authorId, []);
    liveReplyId = insertTestPost('Live reply', authorId, [liveRootId]);

    feedService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount,
      getVouchCountForTarget,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
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
    expect(r['likedByViewer']).toBeNull();
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
    const t = feedService.getThread(liveReplyId, { limit: 50 });
    expect(t).not.toBeNull();
    expect(t!.post).not.toBeNull();
    expect((t!.post as PostJson).id).toBe(liveReplyId);
    expect(t!.ancestors.map((p) => p.id)).toEqual([liveRootId]);
    expect(t!.ancestorCount).toBe(1);
    expect(t!.descendants).toEqual([]);
    expect(t!.descendantCount).toBe(0);
    expect(t!.next).toBeNull();
    expect(t!.pending).toEqual([]);
    expect(t!.pendingCount).toBe(0);
  });

  it('getThread on a withdrawn subject carries its live ancestor and descendant, as a live subject would', () => {
    const parentId = insertTestPost('A root whose reply is withdrawn', authorId, []);
    confirmPost(parentId, 60, 0);
    const subjectId = insertTestPost('The withdrawn reply', authorId, [parentId]);
    confirmPost(subjectId, 60, 1);
    withdrawPost(subjectId, 61);
    const childId = insertTestPost('A live reply under the withdrawn one', authorId, [subjectId]);
    confirmPost(childId, 62, 0);

    const t = feedService.getThread(subjectId, { limit: 50 });
    expect(t).not.toBeNull();
    expect((t!.post as WithdrawnJson).kind).toBe('withdrawn');
    expect((t!.post as WithdrawnJson).parentRefs).toEqual([parentId]);
    expect(t!.ancestors.map((p) => p.id)).toEqual([parentId]);
    expect(t!.ancestorCount).toBe(1);
    expect(t!.descendants.map((p) => p.id)).toEqual([childId]);
    expect(t!.descendantCount).toBe(1);
    expect(t!.next).toBeNull();
  });

  it('getThread returns null for an unknown id', () => {
    expect(feedService.getThread('ab'.repeat(32), { limit: 50 })).toBeNull();
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

    const result = feedService.queryPosts({ author: authorId, limit: 50 });
    expect((result.posts.find((p) => p.id === liveRootId) as PostJson).status).toBe('confirmed');
    expect((result.pending.find((p) => p.id === liveReplyId) as PostJson).status).toBe('pending');

    const thread = feedService.getThread(liveReplyId, { limit: 50 })!;
    expect((thread.post as PostJson).status).toBe('pending');
    expect(thread.ancestors.map((p) => (p as PostJson).status)).toEqual(['confirmed']);

    const rootThread = feedService.getThread(liveRootId, { limit: 50 })!;
    expect(rootThread.pending.map((p) => (p as PostJson).status)).toEqual(['pending']);
  });

  // -----------------------------------------------------------------------
  // descendantCount and authorVouchCount — NODE_INTERFACE → Posts
  // -----------------------------------------------------------------------

  it('descendantCount and authorVouchCount ride every PostJson arm', () => {
    const grandchildId = insertTestPost('A pending grandchild', authorId, [liveReplyId]);
    confirmPost(liveRootId, 10, 0);
    confirmPost(liveReplyId, 11, 0);

    const vouch = seedProvenance<VouchBox>({
      boxType: 'vouch' as const,
      value: 1n,
      createdAtBlock: 0,
      voucherId: uid('counts-voucher'),
      targetId: authorId,
    }, 1);
    insertBox(vouch);

    // Feed row: the confirmed root, 2 descendants (reply + grandchild), pending included
    const feed = feedService.queryPosts({ limit: 50 });
    const feedRow = feed.posts.find((p) => p.id === liveRootId) as PostJson;
    expect(feedRow.descendantCount).toBe(2);
    expect(feedRow.authorVouchCount).toBe(1);

    // Pending row: the grandchild, still pending, a leaf
    const pendingRow = feed.pending.find((p) => p.id === grandchildId) as PostJson;
    expect(pendingRow.descendantCount).toBe(0);
    expect(pendingRow.authorVouchCount).toBe(1);

    // Head
    const head = feedService.getPost(liveReplyId) as PostJson;
    expect(head.descendantCount).toBe(1);
    expect(head.authorVouchCount).toBe(1);

    // Ancestor
    const replyThread = feedService.getThread(liveReplyId, { limit: 50 })!;
    const ancestor = replyThread.ancestors[0] as PostJson;
    expect(ancestor.id).toBe(liveRootId);
    expect(ancestor.descendantCount).toBe(2);
    expect(ancestor.authorVouchCount).toBe(1);

    // Descendant
    const rootThread2 = feedService.getThread(liveRootId, { limit: 50 })!;
    const descendant = rootThread2.descendants[0] as PostJson;
    expect(descendant.id).toBe(liveReplyId);
    expect(descendant.descendantCount).toBe(1);
    expect(descendant.authorVouchCount).toBe(1);
  });

  it('authorVouchCount is read once per distinct author per response, and again on the next call', () => {
    const keysB = generateKeyPairSync('ed25519');
    const authorB = rawPublicKey(keysB.publicKey);
    insertTestPost('A second post by A', authorId, []);
    insertTestPost('A post by B', authorB, []);

    let vouchCalls = 0;
    const countingService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount,
      getVouchCountForTarget: (targetId: Uint8Array) => {
        vouchCalls++;
        return getVouchCountForTarget(targetId);
      },
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
      getBlockCreatedAt,
    });

    // The pending window holds 4 posts (liveRootId, liveReplyId, +2 new) across 2 distinct authors.
    countingService.queryPosts({ limit: 50 });
    expect(vouchCalls).toBe(2);

    countingService.queryPosts({ limit: 50 });
    expect(vouchCalls).toBe(4);
  });

  it('getThread reads the head\'s descendantCount once, and the head and the thread agree', () => {
    const descendantCalls: Record<string, number> = {};
    const countingGetDescendantCount = (postId: string): number => {
      descendantCalls[postId] = (descendantCalls[postId] ?? 0) + 1;
      return getDescendantCount(postId);
    };
    // Mirrors the store's own delegation (Store Interface → Posts DAG:
    // getSubtreePage's count runs getDescendantCount, stated once) through the
    // same dependency seam, since the store's own internal call is not
    // observable through injected deps.
    const countingGetSubtreePage: typeof getSubtreePage = (postId, page) => {
      const real = getSubtreePage(postId, page);
      return { ...real, count: countingGetDescendantCount(postId) };
    };

    const countingService = new FeedService({
      getPost: storeGetPost,
      queryPostsPage,
      getLikeRecordCount,
      getDescendantCount: countingGetDescendantCount,
      getVouchCountForTarget,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage: countingGetSubtreePage,
      getBlockCreatedAt,
    });

    const t = countingService.getThread(liveReplyId, { limit: 50 })!;
    expect(descendantCalls[liveReplyId]).toBe(1);
    expect((t.post as PostJson).descendantCount).toBe(t.descendantCount);
  });
});
