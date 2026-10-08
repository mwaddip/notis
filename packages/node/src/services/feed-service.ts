import type { PostType, TxId } from '@dagsocial/types';
import { utxoTxBytesIn, ReaderError } from '@dagsocial/types';
import type { PostStatus, StoredPost } from '../store/posts.js';
import type { Page, PostKey } from '../store/index.js';
import { nameFor } from './name-cache.js';
import {
  ConfirmedPostTxNotInBlockBodyError,
  UnreadableStoredBlockError,
} from './corrupt-state.js';

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
  // Same section: a confirmed post's bytes are read out of the stored body at
  // its `blockHeight` by its `tx_id` through `utxoTxBytesIn`, the body neither
  // decoded nor kept. The raw `utxotx_tree_bytes` of the row, `null` for a
  // height with no row (TYPES_INTERFACE → One transaction of a body).
  getUtxoTxTreeBytes: (height: number) => Uint8Array | null;
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

// NODE_INTERFACE → Posts → "A light row is a post's id and the node's word"
export interface LightJson {
  kind: 'light';
  id: string;
  parentRefs: string[];
  status: PostStatus;
  blockHeight: number | null;
  blockIndex: number | null;
  blockCreatedAt: number | null;
  likeCount: number;
  descendantCount: number;
  authorName: string | null;
  likedByViewer: boolean | null;
}

// Every list of FeedResult and ThreadResult, and ThreadResult.post, is one of
// three arms — NODE_INTERFACE → Posts → "A light row is a post's id and the
// node's word", "The JSON projection has two arms where the store has one
// shape".
export type PostRow = PostJson | WithdrawnJson | LightJson;

export interface ThreadResult {
  post: PostRow | null;
  ancestors: PostRow[];
  ancestorCount: number;
  descendants: PostRow[];
  descendantCount: number;
  next: PostKey | null;
  pending: PostRow[];
  pendingCount: number;
}

export interface FeedResult {
  posts: PostRow[];
  next: PostKey | null;
  pending: PostRow[];
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

// NODE_INTERFACE → Posts → "A light row is a post's id and the node's word"
function postToLightJson(
  post: StoredPost,
  likeCount: number,
  descendantCount: number,
  authorName: string | null,
  likedByViewer: boolean | null,
  blockCreatedAt: number | null,
): LightJson {
  return {
    kind: 'light',
    id: post.id,
    parentRefs: post.parentRefs,
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
    txId: post.txId,
    author: Buffer.from(post.author).toString('hex'),
    parentRefs: post.parentRefs,
    withdrawnAtHeight: post.withdrawnAtHeight!,
    descendantCount,
    authorName,
  };
}

/**
 * Reads a confirmed row's creating transaction out of its stored body by id,
 * the body neither decoded nor kept — one body's bytes in memory at a time
 * (NODE_INTERFACE → Posts → "The creating transaction rides a post row";
 * TYPES_INTERFACE → One transaction of a body).
 *
 * A page's rows arrive in block order (`ORDER BY block_height, block_index` in
 * `store/posts.ts`), so rows that share a height reuse the last bytes read; a
 * thread's ancestors, descendants and pending each arrive sorted inside their
 * own list, so each list reads one body per distinct height. **Pending bytes
 * come from the pool, confirmed from the stored body**: a pending row's bytes
 * are the pool entry under `txId`, `null` when the entry is gone (reorg,
 * expiry); a confirmed row's are what `utxoTxBytesIn` returns for the stored
 * body at `blockHeight`.
 */
class TxBytesResolver {
  private lastHeight: number | null = null;
  private lastBytes: Uint8Array | null = null;

  constructor(
    private getPendingByTxId: (txId: TxId) => Uint8Array | null,
    private getUtxoTxTreeBytes: (height: number) => Uint8Array | null,
  ) {}

  /** The bytes of a pending row's creating transaction, or `null` if its pool entry is gone. */
  pending(txId: string): string | null {
    const bytes = this.getPendingByTxId(txId);
    return bytes ? Buffer.from(bytes).toString('hex') : null;
  }

  /**
   * The bytes of a confirmed row's creating transaction, read out of the
   * stored body at `blockHeight` by `txId`.
   *
   * `utxoTxBytesIn` answering `null` is `ConfirmedPostTxNotInBlockBodyError`
   * (NODE_INTERFACE → Posts). A height with no stored row, or bytes
   * `utxoTxBytesIn` cannot read (`ReaderError`), is a stored chain that will
   * not read — raised as `UnreadableStoredBlockError`, the same class
   * `rowToOrderingBlock` promotes for a stored body whose bytes do not decode
   * (store/ordering.ts → `createOrderingBlock`'s provenance claim).
   */
  confirmed(postId: string, blockHeight: number, txId: string): string {
    if (this.lastHeight !== blockHeight) {
      const bytes = this.getUtxoTxTreeBytes(blockHeight);
      if (bytes === null) {
        throw new UnreadableStoredBlockError(
          'feed-service.getUtxoTxTreeBytes',
          blockHeight,
          new Error(`no ordering_blocks row at height ${blockHeight} for confirmed post`),
        );
      }
      this.lastHeight = blockHeight;
      this.lastBytes = bytes;
    }
    let out: Uint8Array | null;
    try {
      out = utxoTxBytesIn(this.lastBytes!, txId);
    } catch (err) {
      if (err instanceof ReaderError) {
        throw new UnreadableStoredBlockError(
          'feed-service.utxoTxBytesIn',
          blockHeight,
          err,
        );
      }
      throw err;
    }
    if (out === null) {
      throw new ConfirmedPostTxNotInBlockBodyError('feed-service', blockHeight, postId, txId);
    }
    return Buffer.from(out).toString('hex');
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
    light: boolean,
    precomputedDescendantCount?: number,
  ): PostRow {
    const descendantCount = precomputedDescendantCount ?? this.deps.getDescendantCount(post.id);
    const authorName = this.authorNameFor(post.author, nameCache);
    // NODE_INTERFACE → Posts → "A withdrawn row is its WithdrawnJson, whole":
    // a withdrawn row is its WithdrawnJson under either form, and a
    // WithdrawnJson carries no `tx` — it holds no text for a transaction to
    // bind.
    if (post.withdrawnAtHeight !== null) {
      return withdrawnToJson(post, descendantCount, authorName);
    }
    const likeCount = this.deps.getLikeRecordCount(post.id);
    // NODE_INTERFACE → Posts → "A light row is a post's id and the node's
    // word": no `TxBytesResolver` built and no body read for a light row.
    if (light) {
      return postToLightJson(
        post,
        likeCount,
        descendantCount,
        authorName,
        this.likedByViewer(post.id, viewer),
        this.blockCreatedAtFor(post),
      );
    }
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
      ? new TxBytesResolver(this.deps.getPendingUtxoTxBytesByTxId, this.deps.getUtxoTxTreeBytes)
      : null;
  }

  getPost(id: string, viewer: Uint8Array | null = null, tx = false): PostJson | WithdrawnJson | null {
    const result = this.deps.getPost(id);
    if (result === null) return null;
    // NODE_INTERFACE → Posts: `GET /posts/:id` takes no `light`.
    return this.storedPostToJson(result, viewer, new Map(), this.makeTxResolver(tx), false) as
      PostJson | WithdrawnJson;
  }

  queryPosts(opts: {
    author?: Uint8Array;
    roots?: boolean;
    limit: number;
    after?: PostKey;
    viewer?: Uint8Array | null;
    tx?: boolean;
    light?: boolean;
  }): FeedResult {
    const result = this.deps.queryPostsPage({
      author: opts.author,
      roots: opts.roots,
      limit: opts.limit,
      after: opts.after,
    });
    const viewer = opts.viewer ?? null;
    const nameCache = new Map<string, string | null>();
    const light = opts.light ?? false;
    // NODE_INTERFACE → Posts → "`light` and `tx` do not combine": the route
    // 400s when both are set, so a resolver is built only when `light` is off.
    const txResolver = light ? null : this.makeTxResolver(opts.tx ?? false);
    return {
      posts: result.rows.map((post) => this.storedPostToJson(post, viewer, nameCache, txResolver, light)),
      next: result.next,
      pending: result.pending.map((post) => this.storedPostToJson(post, viewer, nameCache, txResolver, light)),
      pendingCount: result.pendingCount,
    };
  }

  getThread(
    id: string,
    page: Page<PostKey>,
    viewer: Uint8Array | null = null,
    tx = false,
    light = false,
  ): ThreadResult | null {
    const result = this.deps.getPost(id);
    if (result === null) return null;

    // NODE_INTERFACE → Posts: a withdrawn subject answers ancestors, descendants
    // and pending as a live subject does — the row, its topology and every
    // descendant's anchor survive the withdrawal.
    const post = result;
    const nameCache = new Map<string, string | null>();
    // NODE_INTERFACE → Posts → "`light` and `tx` do not combine".
    const txResolver = light ? null : this.makeTxResolver(tx);

    const ancestorResult = this.deps.getAncestorsNearest(id, page.limit);
    const ancestors = ancestorResult.rows.map((p) => this.storedPostToJson(p, viewer, nameCache, txResolver, light));

    const descendantResult = this.deps.getSubtreePage(id, page);
    const descendants = descendantResult.rows.map((p) => this.storedPostToJson(p, viewer, nameCache, txResolver, light));

    // NODE_INTERFACE → "A page read touches limit + 1 entries of one index
    // that serves both its predicate and its order": getDescendantCount is one
    // walk per row it is read for — descendantResult.count is already the
    // head's own walk, so its PostJson takes that value rather than reading it
    // again.
    const postJson = this.storedPostToJson(post, viewer, nameCache, txResolver, light, descendantResult.count);

    return {
      post: postJson,
      ancestors,
      ancestorCount: ancestorResult.count,
      descendants,
      descendantCount: descendantResult.count,
      next: descendantResult.next,
      pending: descendantResult.pending.map((p) => this.storedPostToJson(p, viewer, nameCache, txResolver, light)),
      pendingCount: descendantResult.pendingCount,
    };
  }

}
