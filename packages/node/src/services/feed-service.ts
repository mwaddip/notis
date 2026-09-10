import type { PostType } from '@dagsocial/types';
import type { PostStatus, StoredPost } from '../store/posts.js';
import type { Page, PostKey } from '../store/index.js';
import { nameFor } from './name-cache.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FeedServiceDeps {
  getPost: (id: string) => StoredPost | null;
  queryPostsPage: (opts: {
    author?: Uint8Array;
    roots?: boolean;
    limit: number;
    after?: PostKey;
  }) => { rows: StoredPost[]; next: PostKey | null; pending: StoredPost[]; pendingCount: number };
  getLikeRecordCount: (postId: string) => number;
  getDescendantCount: (postId: string) => number;
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
  getUsernameByOwner: (owner: Uint8Array | string) => { name: string } | null;
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
  authorName: string | null;
  likedByViewer: boolean | null;
}

// NODE_INTERFACE → "The JSON projection has two arms where the store has one shape"
export interface WithdrawnJson {
  kind: 'withdrawn';
  id: string;
  author: string;
  parentRefs: string[];
  withdrawnAtHeight: number;
  descendantCount: number;
  authorName: string | null;
}

export interface ThreadResult {
  post: PostJson | WithdrawnJson | null;
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
  authorName: string | null,
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
    authorName,
    likedByViewer,
  };
}

function withdrawnToJson(
  post: StoredPost,
  descendantCount: number,
  authorName: string | null,
): WithdrawnJson {
  return {
    kind: 'withdrawn',
    id: post.id,
    author: Buffer.from(post.author).toString('hex'),
    parentRefs: post.parentRefs,
    withdrawnAtHeight: post.withdrawnAtHeight!,
    descendantCount,
    authorName,
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
    nameCache: Map<string, string | null>,
    precomputedDescendantCount?: number,
  ): PostJson | WithdrawnJson {
    const descendantCount = precomputedDescendantCount ?? this.deps.getDescendantCount(post.id);
    const authorName = this.authorNameFor(post.author, nameCache);
    if (post.withdrawnAtHeight !== null) {
      return withdrawnToJson(post, descendantCount, authorName);
    }
    const likeCount = this.deps.getLikeRecordCount(post.id);
    return postToJson(
      post,
      likeCount,
      descendantCount,
      authorName,
      this.likedByViewer(post.id, viewer),
      this.blockCreatedAtFor(post),
    );
  }

  private authorNameFor(author: Uint8Array, nameCache: Map<string, string | null>): string | null {
    return nameFor(Buffer.from(author).toString('hex'), nameCache, this.deps.getUsernameByOwner);
  }

  getPost(id: string, viewer: Uint8Array | null = null): PostJson | WithdrawnJson | null {
    const result = this.deps.getPost(id);
    if (result === null) return null;
    return this.storedPostToJson(result, viewer, new Map());
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
    const nameCache = new Map<string, string | null>();
    return {
      posts: result.rows.map((post) => this.storedPostToJson(post, viewer, nameCache)),
      next: result.next,
      pending: result.pending.map((post) => this.storedPostToJson(post, viewer, nameCache)),
      pendingCount: result.pendingCount,
    };
  }

  getThread(
    id: string,
    page: Page<PostKey>,
    viewer: Uint8Array | null = null,
  ): ThreadResult | null {
    const result = this.deps.getPost(id);
    if (result === null) return null;

    // NODE_INTERFACE → Posts: a withdrawn subject answers ancestors, descendants
    // and pending as a live subject does — the row, its topology and every
    // descendant's anchor survive the withdrawal.
    const post = result;
    const nameCache = new Map<string, string | null>();

    const ancestorResult = this.deps.getAncestorsNearest(id, page.limit);
    const ancestors = ancestorResult.rows.map((p) => this.storedPostToJson(p, viewer, nameCache));

    const descendantResult = this.deps.getSubtreePage(id, page);
    const descendants = descendantResult.rows.map((p) => this.storedPostToJson(p, viewer, nameCache));

    // NODE_INTERFACE → "A page read touches limit + 1 entries of one index
    // that serves both its predicate and its order": getDescendantCount is one
    // walk per row it is read for — descendantResult.count is already the
    // head's own walk, so its PostJson takes that value rather than reading it
    // again.
    const postJson = this.storedPostToJson(post, viewer, nameCache, descendantResult.count);

    return {
      post: postJson,
      ancestors,
      ancestorCount: ancestorResult.count,
      descendants,
      descendantCount: descendantResult.count,
      next: descendantResult.next,
      pending: descendantResult.pending.map((p) => this.storedPostToJson(p, viewer, nameCache)),
      pendingCount: descendantResult.pendingCount,
    };
  }
}
