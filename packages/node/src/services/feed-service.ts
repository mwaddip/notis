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
    roots?: boolean;
    limit: number;
    after?: PostKey;
  }) => { rows: StoredPost[]; next: PostKey | null; pending: StoredPost[]; pendingCount: number };
  getLikeRecordCount: (postId: string) => number;
  getDescendantCount: (postId: string) => number;
  getVouchCountForTarget: (targetId: Uint8Array) => number;
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
  descendantCount: number;
  authorVouchCount: number;
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
  descendantCount: number,
  authorVouchCount: number,
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
    descendantCount,
    authorVouchCount,
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

  private storedPostToJson(
    post: StoredPost,
    viewer: Uint8Array | null,
    vouchCountCache: Map<string, number>,
    precomputedDescendantCount?: number,
  ): PostJson | WithdrawnJson {
    if (post.withdrawnAtHeight !== null) return withdrawnToJson(post);
    const likeCount = this.deps.getLikeRecordCount(post.id);
    const descendantCount = precomputedDescendantCount ?? this.deps.getDescendantCount(post.id);
    const authorVouchCount = this.authorVouchCountFor(post.author, vouchCountCache);
    return postToJson(
      post,
      likeCount,
      descendantCount,
      authorVouchCount,
      this.likedByViewer(post.id, viewer),
      this.blockCreatedAtFor(post),
    );
  }

  // NODE_INTERFACE → Posts: authorVouchCount is read once per distinct author
  // per response — vouchCountCache is a Map local to one queryPosts/getThread/getPost call.
  private authorVouchCountFor(author: Uint8Array, vouchCountCache: Map<string, number>): number {
    const key = Buffer.from(author).toString('hex');
    const cached = vouchCountCache.get(key);
    if (cached !== undefined) return cached;
    const count = this.deps.getVouchCountForTarget(author);
    vouchCountCache.set(key, count);
    return count;
  }

  getPost(id: string, viewer: Uint8Array | null = null): PostJson | StumpJson | PrunedJson | WithdrawnJson | null {
    const result = this.deps.getPost(id);
    if (!result) return null;
    if (isStoredPost(result)) {
      return this.storedPostToJson(result, viewer, new Map());
    }
    if (isStump(result)) return stumpToJson(result);
    if (isPrunedTombstone(result)) return prunedToJson(result);
    return null;
  }

  queryPosts(opts: {
    author?: Uint8Array;
    roots?: boolean;
    limit: number;
    after?: PostKey;
    viewer?: Uint8Array | null;
  }): FeedResult {
    const result = this.deps.queryPostsPage({
      author: opts.author,
      roots: opts.roots,
      limit: opts.limit,
      after: opts.after,
    });
    const viewer = opts.viewer ?? null;
    const vouchCountCache = new Map<string, number>();
    return {
      posts: result.rows.map((post) => this.storedPostToJson(post, viewer, vouchCountCache)),
      next: result.next,
      pending: result.pending.map((post) => this.storedPostToJson(post, viewer, vouchCountCache)),
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
    const vouchCountCache = new Map<string, number>();

    const ancestorResult = this.deps.getAncestorsNearest(id, page.limit);
    const ancestors = ancestorResult.rows.map((p) => this.storedPostToJson(p, viewer, vouchCountCache));

    const descendantResult = this.deps.getSubtreePage(id, page);
    const descendants = descendantResult.rows.map((p) => this.storedPostToJson(p, viewer, vouchCountCache));

    // NODE_INTERFACE → "A page read touches limit + 1 entries of one index
    // that serves both its predicate and its order": getDescendantCount is one
    // walk per row it is read for — descendantResult.count is already the
    // head's own walk, so its PostJson takes that value rather than reading it
    // again.
    const postJson = this.storedPostToJson(post, viewer, vouchCountCache, descendantResult.count);

    return {
      post: postJson,
      ancestors,
      ancestorCount: ancestorResult.count,
      descendants,
      descendantCount: descendantResult.count,
      next: descendantResult.next,
      pending: descendantResult.pending.map((p) => this.storedPostToJson(p, viewer, vouchCountCache)),
      pendingCount: descendantResult.pendingCount,
    };
  }
}
