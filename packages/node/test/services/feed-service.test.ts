import { fixturePostId } from '../helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { computePostId, encodePost, PROTOCOL_VERSION } from '@dagsocial/types';
import type { Post } from '@dagsocial/types';

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
  pruneSubtree,
  confirmPost,
  getBlockCreatedAt,
} from '../../src/store/index.js';
import { FeedService } from '../../src/services/feed-service.js';
import type { PostJson } from '../../src/services/feed-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A returned DTO as a plain record.
 *
 * These tests assert on key **presence and absence** — `authorId` gone,
 * `rootPostHash` gone, `kind` absent on a live post — which the declared
 * `PostJson`/`StumpJson` interfaces cannot express, and an interface carries no
 * index signature so it is not castable to `Record<string, unknown>` either.
 * A shallow copy of the own enumerable properties is exactly the set `toEqual`
 * compares, and it is obtained by running code rather than by asserting a type.
 */
function asRecord(v: object | null): Record<string, unknown> {
  if (v === null) throw new Error('expected a DTO, got null');
  return Object.fromEntries(Object.entries(v));
}

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Create a minimal Post object for testing. */
function makePost(
  content: string,
  author: Uint8Array,
  parentRefs: string[],
): Post {
  return {
    content,
    author,
    parentRefs,
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
  };
}

/** Insert a post and return its computed ID. */
function insertTestPost(post: Post): string {
  const postId = fixturePostId(post);
  insertPost(fixturePostId(post), post, encodePost(post));
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

  // The scalar fields of the stump the settled prune leaves behind.
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

    // A live thread: root with one reply.
    liveRootId = insertTestPost(makePost('Live root', authorId, []));
    liveReplyId = insertTestPost(makePost('Live reply', authorId, [liveRootId]));

    // A pruned thread, settled exactly as block-apply settlement step 6
    // produces it: insertStump, then pruneSubtree.
    prunedRootId = insertTestPost(makePost('Doomed root', authorId, []));
    insertTestPost(makePost('Doomed reply', authorId, [prunedRootId]));
    insertStump({
      rootPostHash: prunedRootId,
      authorId,
      ...stumpScalars,
    });
    pruneSubtree(prunedRootId);

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
    expect(r['author']).toBe(Buffer.from(authorId).toString('hex'));
    expect(r['likeCount']).toBe(0);
    expect(r['likers']).toEqual([]);
  });

  it('getPost on a pruned root returns StumpJson, not the raw Stump', () => {
    // CHANGED 2026-08-08 with the contracted `StumpJson` shape (NODE_INTERFACE
    // → Posts). This test asserted "returns the Stump as-is" — the raw object,
    // `authorId` still a Uint8Array — which is exactly the defect: `res.json`
    // serialized it index-keyed (`{"0":…,"1":…}`) at the route above.
    const r = asRecord(feedService.getPost(prunedRootId));
    expect(r).not.toBeNull();
    expect(r).toEqual({
      kind: 'stump',
      id: prunedRootId,
      author: Buffer.from(authorId).toString('hex'),
      ...stumpScalars,
    });
    // The author is hex — `PostJson.author`'s convention — never index-keyed.
    expect(r['author']).toMatch(/^[0-9a-f]{64}$/);
    expect(r['authorId']).toBeUndefined();
    expect(r['rootPostHash']).toBeUndefined();
    // A stump is not a post: no content, no like counters.
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
    expect(t!.post!.id).toBe(liveReplyId);
    expect(t!.ancestors.map((p) => p.id)).toEqual([liveRootId]);
    expect(t!.descendants).toEqual([]);
  });

  it('getThread on a pruned root returns the stump shell as StumpJson', () => {
    // `ThreadJson.post` is `PostJson | StumpJson | null`, so the stump arm
    // needs no cast: the shell below is asserted at its own type rather than
    // through an `as unknown as PostJson` the compiler would have to be told
    // to ignore.
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
    // `status` is node-local state that `Post` deliberately does not carry, so
    // it reaches a response only if the store's own record does. Asserting the
    // value against `dag_posts` is what separates "serves the column" from
    // "serves a constant that happens to look plausible".
    expect(asRecord(feedService.getPost(liveRootId))['status']).toBe('pending');

    confirmPost(liveRootId, 42, 0);
    expect(asRecord(feedService.getPost(liveRootId))['status']).toBe('confirmed');
  });

  it('every path that serves a post serves its status', () => {
    // Four store reads back the four `postToJson` call sites — `getPost`,
    // `queryPosts`, and the thread's ancestors and descendants. Each maps rows
    // through `rowToPost` independently, so a path that dropped the column
    // would be invisible to a test that only exercised one of them.
    confirmPost(liveRootId, 42, 0);

    const listed = feedService.queryPosts({ author: authorId });
    expect(listed.find((p) => p.id === liveRootId)!.status).toBe('confirmed');
    expect(listed.find((p) => p.id === liveReplyId)!.status).toBe('pending');

    const thread = feedService.getThread(liveReplyId)!;
    expect((thread.post as PostJson).status).toBe('pending');
    expect(thread.ancestors.map((p) => p.status)).toEqual(['confirmed']);

    const rootThread = feedService.getThread(liveRootId)!;
    expect(rootThread.descendants.map((p) => p.status)).toEqual(['pending']);
  });
});
