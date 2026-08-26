import type { PostType, Stump } from '@dagsocial/types';
import type { PostStatus, StoredPost, PrunedTombstone } from '../store/posts.js';
import { isStoredPost, isStump, isPrunedTombstone } from '../store/posts.js';

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

export interface WithdrawnJson {
  kind: 'withdrawn';
  id: string;
  author: string;
  withdrawnAtHeight: number;
}

export interface ThreadJson {
  post: PostJson | StumpJson | PrunedJson | WithdrawnJson | null;
  ancestors: Array<PostJson | WithdrawnJson>;
  descendants: Array<PostJson | WithdrawnJson>;
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

export function withdrawnToJson(post: StoredPost): WithdrawnJson {
  return {
    kind: 'withdrawn',
    id: post.id,
    author: Buffer.from(post.author).toString('hex'),
    withdrawnAtHeight: post.withdrawnAtHeight!,
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

  private storedPostToJson(post: StoredPost): PostJson | WithdrawnJson {
    if (post.withdrawnAtHeight !== null) return withdrawnToJson(post);
    const likeCount = this.deps.getLikeRecordCount(post.id);
    const likers = this.deps.getLikersForPost(post.id);
    return postToJson(post, likeCount, likers, this.blockCreatedAtFor(post));
  }

  getPost(id: string): PostJson | StumpJson | PrunedJson | WithdrawnJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;
    if (isStoredPost(result)) {
      if (result.withdrawnAtHeight !== null) return withdrawnToJson(result);
      const likeCount = this.deps.getLikeRecordCount(id);
      const likers = this.deps.getLikersForPost(id);
      return postToJson(result, likeCount, likers, this.blockCreatedAtFor(result));
    }
    if (isStump(result)) return stumpToJson(result);
    if (isPrunedTombstone(result)) return prunedToJson(result);
    return null;
  }

  queryPosts(opts: {
    author?: Uint8Array;
    limit?: number;
    offset?: number;
  }): Array<PostJson | WithdrawnJson> {
    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;
    const posts = this.deps.queryPosts({ author: opts.author, limit, offset });
    return posts.map((post) => this.storedPostToJson(post));
  }

  getThread(id: string): ThreadJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;

    if (isStoredPost(result)) {
      if (result.withdrawnAtHeight !== null) {
        return { post: withdrawnToJson(result), ancestors: [], descendants: [] };
      }
    }
    if (isStump(result)) {
      return { post: stumpToJson(result), ancestors: [], descendants: [] };
    }
    if (isPrunedTombstone(result)) {
      return { post: prunedToJson(result), ancestors: [], descendants: [] };
    }

    const post = result;
    const likeCount = this.deps.getLikeRecordCount(id);
    const likers = this.deps.getLikersForPost(id);
    const postJson = postToJson(post, likeCount, likers, this.blockCreatedAtFor(post));

    const ancestorPosts = this.deps.getAncestors(id);
    const ancestors = ancestorPosts.map((p) => this.storedPostToJson(p));

    const descendantPosts = this.deps.getSubtree(id);
    const descendants = descendantPosts.map((p) => this.storedPostToJson(p));

    return { post: postJson, ancestors, descendants };
  }
}
