import type { PostType, Stump } from '@dagsocial/types';
import type { PostStatus, StoredPost, PrunedTombstone } from '../store/posts.js';
import { isLivePost } from '../store/posts.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FeedServiceDeps {
  getPost: (id: string) => StoredPost | Stump | PrunedTombstone | null;
  queryPosts: (opts: {
    author?: Uint8Array;
    limit?: number;
    offset?: number;
  }) => StoredPost[];
  getLikeRecordCount: (postId: string) => number;
  getLikersForPost: (postId: string) => string[];
  getAncestors: (postId: string) => StoredPost[];
  getSubtree: (postId: string) => StoredPost[];
  getBlockCreatedAt: (height: number) => number | null;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PostJson {
  id: string;
  content: string | null;
  contentHash: string;
  author: string;
  parentRefs: string[];
  protocolVersion: number;
  type: PostType;
  status: PostStatus;
  blockHeight: number | null;
  blockIndex: number | null;
  blockCreatedAt: number | null;
  likeCount: number;
  likers: string[];
}

export interface StumpJson {
  kind: 'stump';
  id: string;
  author: string;
  replyCount: number;
  upvoteCount: number;
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export interface PrunedJson {
  kind: 'pruned';
  id: string;
  author: string;
  rootPostHash: string;
  compactedAtBlockHeight: number;
}

export interface ThreadJson {
  post: PostJson | StumpJson | PrunedJson | null;
  ancestors: PostJson[];
  descendants: PostJson[];
}

// ---------------------------------------------------------------------------
// Service helpers
// ---------------------------------------------------------------------------

export function postToJson(
  post: StoredPost,
  likeCount: number,
  likers: string[],
  blockCreatedAt: number | null,
): PostJson {
  return {
    id: post.id,
    content: post.content,
    contentHash: post.contentHash,
    author: Buffer.from(post.author).toString('hex'),
    parentRefs: post.parentRefs,
    protocolVersion: post.protocolVersion,
    type: post.type,
    status: post.status,
    blockHeight: post.blockHeight,
    blockIndex: post.blockIndex,
    blockCreatedAt,
    likeCount,
    likers,
  };
}

export function stumpToJson(stump: Stump): StumpJson {
  return {
    kind: 'stump',
    id: stump.rootPostHash,
    author: Buffer.from(stump.authorId).toString('hex'),
    replyCount: stump.replyCount,
    upvoteCount: stump.upvoteCount,
    protocolVersion: stump.protocolVersion,
    compactedAtBlockHeight: stump.compactedAtBlockHeight,
  };
}

export function prunedToJson(tombstone: PrunedTombstone): PrunedJson {
  return {
    kind: 'pruned',
    id: tombstone.id,
    author: tombstone.author,
    rootPostHash: tombstone.rootPostHash,
    compactedAtBlockHeight: tombstone.compactedAtBlockHeight,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FeedService {
  constructor(private deps: FeedServiceDeps) {}

  private blockCreatedAtFor(post: StoredPost): number | null {
    if (post.blockHeight === null) return null;
    return this.deps.getBlockCreatedAt(post.blockHeight);
  }

  getPost(id: string): PostJson | StumpJson | PrunedJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;
    if (isLivePost(result)) {
      const likeCount = this.deps.getLikeRecordCount(id);
      const likers = this.deps.getLikersForPost(id);
      return postToJson(result, likeCount, likers, this.blockCreatedAtFor(result));
    }
    if ('rootPostHash' in result && !('kind' in result)) {
      return stumpToJson(result as Stump);
    }
    return prunedToJson(result as PrunedTombstone);
  }

  queryPosts(opts: {
    author?: Uint8Array;
    limit?: number;
    offset?: number;
  }): PostJson[] {
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;
    const posts = this.deps.queryPosts({ author: opts.author, limit, offset });
    return posts.map((post) => {
      const postId = post.id;
      const likeCount = this.deps.getLikeRecordCount(postId);
      const likers = this.deps.getLikersForPost(postId);
      return postToJson(post, likeCount, likers, this.blockCreatedAtFor(post));
    });
  }

  getThread(id: string): ThreadJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;

    if ('rootPostHash' in result && !('kind' in result)) {
      return { post: stumpToJson(result as Stump), ancestors: [], descendants: [] };
    }
    if ('kind' in result && (result as PrunedTombstone).kind === 'pruned') {
      return { post: prunedToJson(result as PrunedTombstone), ancestors: [], descendants: [] };
    }

    const post = result as StoredPost;
    const likeCount = this.deps.getLikeRecordCount(id);
    const likers = this.deps.getLikersForPost(id);
    const postJson = postToJson(post, likeCount, likers, this.blockCreatedAtFor(post));

    const ancestorPosts = this.deps.getAncestors(id);
    const ancestors = ancestorPosts.map((p) => {
      const pid = p.id;
      const c = this.deps.getLikeRecordCount(pid);
      const l = this.deps.getLikersForPost(pid);
      return postToJson(p, c, l, this.blockCreatedAtFor(p));
    });

    const descendantPosts = this.deps.getSubtree(id);
    const descendants = descendantPosts.map((p) => {
      const pid = p.id;
      const c = this.deps.getLikeRecordCount(pid);
      const l = this.deps.getLikersForPost(pid);
      return postToJson(p, c, l, this.blockCreatedAtFor(p));
    });

    return { post: postJson, ancestors, descendants };
  }
}
