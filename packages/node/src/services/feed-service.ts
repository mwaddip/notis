import type { PostType, Stump } from '@dagsocial/types';
import type { PostStatus, StoredPost, PrunedTombstone } from '../store/posts.js';
import { isStoredPost, isStump, isPrunedTombstone } from '../store/posts.js';
import type { Page, PostKey } from '../store/index.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FeedServiceDeps {
  getPost: (id: string) => StoredPost | Stump | PrunedTombstone | null;
  queryPostsPage: (opts: {
    author?: Uint8Array;
    limit: number;
    after?: PostKey;
  }) => { rows: StoredPost[]; next: PostKey | null; pending: StoredPost[]; pendingCount: number };
  getLikeRecordCount: (postId: string) => number;
  hasLikeRecord: (postId: string, likerId: Uint8Array) => boolean;
  getAncestorsNearest: (postId: string, limit: number) => { rows: StoredPost[]; count: number };
  getSubtreePage: (postId: string, page: Page<PostKey>) => {
    rows: StoredPost[];
    next: PostKey | null;
    count: number;
    pending: StoredPost[];
    pendingCount: number;
  };
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
  likedByViewer: boolean | null;
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

// NODE_INTERFACE → "The JSON projection has a fourth arm where the store has three"
export interface WithdrawnJson {
  kind: 'withdrawn';
  id: string;
  author: string;
  parentRefs: string[];
  withdrawnAtHeight: number;
}

export interface ThreadResult {
  post: PostJson | StumpJson | PrunedJson | WithdrawnJson | null;
  ancestors: Array<PostJson | WithdrawnJson>;
  ancestorCount: number;
  descendants: Array<PostJson | WithdrawnJson>;
  descendantCount: number;
  next: PostKey | null;
  pending: Array<PostJson | WithdrawnJson>;
  pendingCount: number;
}

export interface FeedResult {
  posts: Array<PostJson | WithdrawnJson>;
  next: PostKey | null;
  pending: Array<PostJson | WithdrawnJson>;
  pendingCount: number;
}

// ---------------------------------------------------------------------------
// Service helpers
// ---------------------------------------------------------------------------

function postToJson(
  post: StoredPost,
  likeCount: number,
  likedByViewer: boolean | null,
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
    likedByViewer,
  };
}

function stumpToJson(stump: Stump): StumpJson {
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

function prunedToJson(tombstone: PrunedTombstone): PrunedJson {
  return {
    kind: 'pruned',
    id: tombstone.id,
    author: tombstone.author,
    rootPostHash: tombstone.rootPostHash,
    compactedAtBlockHeight: tombstone.compactedAtBlockHeight,
  };
}

function withdrawnToJson(post: StoredPost): WithdrawnJson {
  return {
    kind: 'withdrawn',
    id: post.id,
    author: Buffer.from(post.author).toString('hex'),
    parentRefs: post.parentRefs,
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

  private likedByViewer(postId: string, viewer: Uint8Array | null): boolean | null {
    if (!viewer) return null;
    return this.deps.hasLikeRecord(postId, viewer);
  }

  private storedPostToJson(post: StoredPost, viewer: Uint8Array | null): PostJson | WithdrawnJson {
    if (post.withdrawnAtHeight !== null) return withdrawnToJson(post);
    const likeCount = this.deps.getLikeRecordCount(post.id);
    return postToJson(post, likeCount, this.likedByViewer(post.id, viewer), this.blockCreatedAtFor(post));
  }

  getPost(id: string, viewer: Uint8Array | null = null): PostJson | StumpJson | PrunedJson | WithdrawnJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;
    if (isStoredPost(result)) {
      if (result.withdrawnAtHeight !== null) return withdrawnToJson(result);
      const likeCount = this.deps.getLikeRecordCount(id);
      return postToJson(result, likeCount, this.likedByViewer(id, viewer), this.blockCreatedAtFor(result));
    }
    if (isStump(result)) return stumpToJson(result);
    if (isPrunedTombstone(result)) return prunedToJson(result);
    return null;
  }

  queryPosts(opts: {
    author?: Uint8Array;
    limit: number;
    after?: PostKey;
    viewer?: Uint8Array | null;
  }): FeedResult {
    const result = this.deps.queryPostsPage({ author: opts.author, limit: opts.limit, after: opts.after });
    const viewer = opts.viewer ?? null;
    return {
      posts: result.rows.map((post) => this.storedPostToJson(post, viewer)),
      next: result.next,
      pending: result.pending.map((post) => this.storedPostToJson(post, viewer)),
      pendingCount: result.pendingCount,
    };
  }

  getThread(
    id: string,
    page: Page<PostKey>,
    viewer: Uint8Array | null = null,
  ): ThreadResult | null {
    const result = this.deps.getPost(id);
    if (!result) return null;

    if (isStump(result)) {
      return {
        post: stumpToJson(result),
        ancestors: [], ancestorCount: 0,
        descendants: [], descendantCount: 0,
        next: null, pending: [], pendingCount: 0,
      };
    }
    if (isPrunedTombstone(result)) {
      return {
        post: prunedToJson(result),
        ancestors: [], ancestorCount: 0,
        descendants: [], descendantCount: 0,
        next: null, pending: [], pendingCount: 0,
      };
    }

    // NODE_INTERFACE → Posts: a withdrawn subject answers ancestors, descendants
    // and pending as a live subject does — the row, its topology and every
    // descendant's anchor survive the withdrawal.
    const post = result;
    const postJson = this.storedPostToJson(post, viewer);

    const ancestorResult = this.deps.getAncestorsNearest(id, page.limit);
    const ancestors = ancestorResult.rows.map((p) => this.storedPostToJson(p, viewer));

    const descendantResult = this.deps.getSubtreePage(id, page);
    const descendants = descendantResult.rows.map((p) => this.storedPostToJson(p, viewer));

    return {
      post: postJson,
      ancestors,
      ancestorCount: ancestorResult.count,
      descendants,
      descendantCount: descendantResult.count,
      next: descendantResult.next,
      pending: descendantResult.pending.map((p) => this.storedPostToJson(p, viewer)),
      pendingCount: descendantResult.pendingCount,
    };
  }
}
