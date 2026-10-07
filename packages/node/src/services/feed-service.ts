import type { OrderingBlock, PostType, TxId } from '@dagsocial/types';
import type { PostStatus, StoredPost } from '../store/posts.js';
import type { Page, PostKey } from '../store/index.js';
import { nameFor } from './name-cache.js';
import { ConfirmedPostTxNotInBlockBodyError } from './corrupt-state.js';

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
  // NODE_INTERFACE → Posts → "The creating transaction rides a post row": the
  // pool entry a pending post's bytes are read from, by `tx_id`.
  getPendingUtxoTxBytesByTxId: (txId: TxId) => Uint8Array | null;
  // Same section: a confirmed post's bytes are the body element at its
  // `blockHeight` that `utxoTxIds` lists under its `tx_id` — one body read per
  // distinct height of a response, no transaction decoded.
  getOrderingBlock: (height: number) => OrderingBlock | null;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PostJson {
  id: string;
  txId: string;                   // NODE_INTERFACE → Posts → "The creating transaction rides a post row"
  tx?: string | null;             // with `?tx=1` alone: the creating transaction as `encodeTx` writes it, hex
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
  txId: string;                   // NODE_INTERFACE → Posts → "The creating transaction rides a post row"
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
  tx: string | null | undefined,
): PostJson {
  const json: PostJson = {
    id: post.id,
    txId: post.txId,
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
  if (tx !== undefined) json.tx = tx;
  return json;
}

function withdrawnToJson(
  post: StoredPost,
  descendantCount: number,
  authorName: string | null,
): WithdrawnJson {
  return {
    kind: 'withdrawn',
    id: post.id,
    txId: post.txId,
    author: Buffer.from(post.author).toString('hex'),
    parentRefs: post.parentRefs,
    withdrawnAtHeight: post.withdrawnAtHeight!,
    descendantCount,
    authorName,
  };
}

/**
 * The per-response index of block bodies, keyed by block height — the body is
 * read once per distinct height of a response and nothing of it decoded
 * (NODE_INTERFACE → Posts → "The creating transaction rides a post row").
 */
class TxBytesResolver {
  private bodies = new Map<number, Map<string, Uint8Array>>();

  constructor(
    private getPendingByTxId: (txId: TxId) => Uint8Array | null,
    private getOrderingBlock: (height: number) => OrderingBlock | null,
  ) {}

  /** The bytes of a pending row's creating transaction, or `null` if its pool entry is gone. */
  pending(txId: string): string | null {
    const bytes = this.getPendingByTxId(txId);
    return bytes ? Buffer.from(bytes).toString('hex') : null;
  }

  /**
   * The bytes of a confirmed row's creating transaction — the element of the
   * stored body at `blockHeight` that `utxoTxIds` lists under `txId`. Throws
   * `ConfirmedPostTxNotInBlockBodyError` if the block lists no such id.
   */
  confirmed(postId: string, blockHeight: number, txId: string): string {
    let byTxId = this.bodies.get(blockHeight);
    if (!byTxId) {
      byTxId = new Map<string, Uint8Array>();
      const block = this.getOrderingBlock(blockHeight);
      if (block) {
        const { utxoTxIds, utxoTxs } = block.utxoTxTree;
        for (let i = 0; i < utxoTxIds.length; i++) {
          const raw = utxoTxs[i];
          if (raw) byTxId.set(utxoTxIds[i]!, raw);
        }
      }
      this.bodies.set(blockHeight, byTxId);
    }
    const bytes = byTxId.get(txId);
    if (!bytes) {
      throw new ConfirmedPostTxNotInBlockBodyError('feed-service', blockHeight, postId, txId);
    }
    return Buffer.from(bytes).toString('hex');
  }
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
    txResolver: TxBytesResolver | null,
    precomputedDescendantCount?: number,
  ): PostJson | WithdrawnJson {
    const descendantCount = precomputedDescendantCount ?? this.deps.getDescendantCount(post.id);
    const authorName = this.authorNameFor(post.author, nameCache);
    // NODE_INTERFACE → Posts → "The creating transaction rides a post row":
    // a WithdrawnJson carries no `tx` — it holds no text for a transaction to bind.
    if (post.withdrawnAtHeight !== null) {
      return withdrawnToJson(post, descendantCount, authorName);
    }
    const likeCount = this.deps.getLikeRecordCount(post.id);
    let tx: string | null | undefined;
    if (txResolver) {
      tx = post.status === 'pending'
        ? txResolver.pending(post.txId)
        : txResolver.confirmed(post.id, post.blockHeight!, post.txId);
    }
    return postToJson(
      post,
      likeCount,
      descendantCount,
      authorName,
      this.likedByViewer(post.id, viewer),
      this.blockCreatedAtFor(post),
      tx,
    );
  }

  private authorNameFor(author: Uint8Array, nameCache: Map<string, string | null>): string | null {
    return nameFor(Buffer.from(author).toString('hex'), nameCache, this.deps.getUsernameByOwner);
  }

  private makeTxResolver(tx: boolean): TxBytesResolver | null {
    return tx
      ? new TxBytesResolver(this.deps.getPendingUtxoTxBytesByTxId, this.deps.getOrderingBlock)
      : null;
  }

  getPost(id: string, viewer: Uint8Array | null = null, tx = false): PostJson | WithdrawnJson | null {
    const result = this.deps.getPost(id);
    if (result === null) return null;
    return this.storedPostToJson(result, viewer, new Map(), this.makeTxResolver(tx));
  }

  queryPosts(opts: {
    author?: Uint8Array;
    roots?: boolean;
    limit: number;
    after?: PostKey;
    viewer?: Uint8Array | null;
    tx?: boolean;
  }): FeedResult {
    const result = this.deps.queryPostsPage({
      author: opts.author,
      roots: opts.roots,
      limit: opts.limit,
      after: opts.after,
    });
    const viewer = opts.viewer ?? null;
    const nameCache = new Map<string, string | null>();
    const txResolver = this.makeTxResolver(opts.tx ?? false);
    return {
      posts: result.rows.map((post) => this.storedPostToJson(post, viewer, nameCache, txResolver)),
      next: result.next,
      pending: result.pending.map((post) => this.storedPostToJson(post, viewer, nameCache, txResolver)),
      pendingCount: result.pendingCount,
    };
  }

  getThread(
    id: string,
    page: Page<PostKey>,
    viewer: Uint8Array | null = null,
    tx = false,
  ): ThreadResult | null {
    const result = this.deps.getPost(id);
    if (result === null) return null;

    // NODE_INTERFACE → Posts: a withdrawn subject answers ancestors, descendants
    // and pending as a live subject does — the row, its topology and every
    // descendant's anchor survive the withdrawal.
    const post = result;
    const nameCache = new Map<string, string | null>();
    const txResolver = this.makeTxResolver(tx);

    const ancestorResult = this.deps.getAncestorsNearest(id, page.limit);
    const ancestors = ancestorResult.rows.map((p) => this.storedPostToJson(p, viewer, nameCache, txResolver));

    const descendantResult = this.deps.getSubtreePage(id, page);
    const descendants = descendantResult.rows.map((p) => this.storedPostToJson(p, viewer, nameCache, txResolver));

    // NODE_INTERFACE → "A page read touches limit + 1 entries of one index
    // that serves both its predicate and its order": getDescendantCount is one
    // walk per row it is read for — descendantResult.count is already the
    // head's own walk, so its PostJson takes that value rather than reading it
    // again.
    const postJson = this.storedPostToJson(post, viewer, nameCache, txResolver, descendantResult.count);

    return {
      post: postJson,
      ancestors,
      ancestorCount: ancestorResult.count,
      descendants,
      descendantCount: descendantResult.count,
      next: descendantResult.next,
      pending: descendantResult.pending.map((p) => this.storedPostToJson(p, viewer, nameCache, txResolver)),
      pendingCount: descendantResult.pendingCount,
    };
  }
}
