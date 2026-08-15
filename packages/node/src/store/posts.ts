import { getDb } from './db.js';
import type { Post, PostId, Stump } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PostRow {
  id: string;
  content: string;
  author: Buffer;             // 32-byte Ed25519 public key
  parent_refs: string;        // JSON array
  protocol_version: number;
  timestamp: number;
  raw_cbor: Buffer;
  status: string;
  block_height: number | null;
}

interface StumpRow {
  id: string;
  root_post_hash: string;
  author_id: Buffer;          // 32-byte Ed25519 public key
  reply_count: number;
  upvote_count: number;
  trigger: string;
  protocol_version: number;
  compacted_at_block_height: number;
  raw_cbor: Buffer;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * `dag_posts.status` — a post's local lifecycle. The column's whole domain:
 * every writer in this file sets one of these three and nothing else sets it.
 */
export type PostStatus = 'pending' | 'confirmed' | 'pruned';

/**
 * A stored post: the consensus `Post` plus the local column a reader needs.
 *
 * `status` is deliberately NOT a field on `Post`. `Post` is the consensus type
 * — shared with `@dagsocial/types`, hashed into the post id, and written to the
 * wire — and whether *this* node has seen a block confirm the post is a fact
 * about this node, not about the post. Two nodes hold the same post at
 * different statuses.
 *
 * Required rather than optional, so a caller that has no status fails to
 * compile instead of reporting one it never had.
 *
 * ⛔ **`id` is carried, not derived.** A post's id comes from the transaction
 * that created it (`computePostId(txId, index)` takes no `Post`), so the stored
 * row is the only party that knows it. A reader that tried to recompute it from
 * the fields would be reaching for a function that cannot exist.
 */
export interface StoredPost extends Post {
  id: PostId;
  status: PostStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPost(row: PostRow): StoredPost {
  return {
    id: row.id,
    content: row.content,
    author: new Uint8Array(row.author),
    parentRefs: JSON.parse(row.parent_refs) as string[],
    protocolVersion: row.protocol_version,
    timestamp: row.timestamp,
    // The one narrowing cast on this path — the column is TEXT, and the
    // schema's three-value domain is what `PostStatus` states. Same shape as
    // `rowToStump`'s `trigger`.
    status: row.status as PostStatus,
  };
}

function rowToStump(row: StumpRow): Stump {
  return {
    rootPostHash: row.root_post_hash,
    authorId: new Uint8Array(row.author_id),
    replyCount: row.reply_count,
    upvoteCount: row.upvote_count,
    trigger: row.trigger as Stump['trigger'],
    protocolVersion: row.protocol_version,
    compactedAtBlockHeight: row.compacted_at_block_height,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new post into dag_posts with status='pending', and a row into
 * dag_parent_refs for each parentId in post.parentRefs.
 *
 * ⛔ **`postId` is a PARAMETER and is not derivable from `post`.** A post's id
 * comes from the transaction that created it — `computePostId(txId, index)` takes
 * no `Post` (TYPES_INTERFACE → Hashing functions) — so the caller, which holds
 * that transaction, is the only party that can name the row.
 *
 * All writes are wrapped in a single transaction so a crash leaves no orphaned
 * rows.
 */
export function insertPost(postId: PostId, post: Post, rawCbor: Uint8Array): void {
  const db = getDb();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO dag_posts
         (id, content, author, parent_refs,
          protocol_version, timestamp, raw_cbor, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      postId,
      post.content,
      Buffer.from(post.author),
      JSON.stringify(post.parentRefs),
      post.protocolVersion,
      post.timestamp,
      Buffer.from(rawCbor),
    );

    const insertRef = db.prepare(
      'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
    );
    for (const parentId of post.parentRefs) {
      insertRef.run(postId, parentId);
    }
  })();
}

/**
 * Retrieve a post or stump by id.
 *
 * 1. Look in dag_posts first. If status != 'pruned', return the Post.
 * 2. If the post is pruned, look up the corresponding stump via root_post_hash.
 * 3. If not found in dag_posts at all, try dag_stumps by stump id directly.
 * 4. Return null if nothing matches.
 */
export function getPost(id: string): StoredPost | Stump | null {
  const db = getDb();

  // 1. Try dag_posts first
  const postRow = db
    .prepare('SELECT * FROM dag_posts WHERE id = ?')
    .get(id) as PostRow | undefined;

  if (postRow) {
    if (postRow.status !== 'pruned') {
      return rowToPost(postRow);
    }
    // Post is pruned — look up the stump
    const stumpRow = db
      .prepare('SELECT * FROM dag_stumps WHERE root_post_hash = ?')
      .get(id) as StumpRow | undefined;
    return stumpRow ? rowToStump(stumpRow) : null;
  }

  // 2. Not in dag_posts — try dag_stumps by id (direct stump lookup)
  const stumpRow = db
    .prepare('SELECT * FROM dag_stumps WHERE id = ?')
    .get(id) as StumpRow | undefined;
  if (stumpRow) {
    return rowToStump(stumpRow);
  }

  return null;
}

/**
 * Retrieve the raw CBOR bytes for a post or stump by id.
 * Returns null if not found. Used for independent hash recomputation
 * (validate-don't-trust: verify that the hash of the stored bytes matches
 * the claimed id).
 */
export function getPostRaw(id: string): Uint8Array | null {
  const db = getDb();

  // Try dag_posts first
  const postRow = db
    .prepare('SELECT raw_cbor FROM dag_posts WHERE id = ?')
    .get(id) as { raw_cbor: Buffer } | undefined;

  if (postRow) {
    return new Uint8Array(postRow.raw_cbor);
  }

  // Try dag_stumps
  const stumpRow = db
    .prepare('SELECT raw_cbor FROM dag_stumps WHERE id = ?')
    .get(id) as { raw_cbor: Buffer } | undefined;

  if (stumpRow) {
    return new Uint8Array(stumpRow.raw_cbor);
  }

  return null;
}

/**
 * Query live posts (status != 'pruned'), newest first.
 *
 * @param opts.author  Optional author filter.
 * @param opts.limit   Max rows to return (default 50).
 * @param opts.offset  Pagination offset (default 0).
 */
export function queryPosts(opts: {
  author?: Uint8Array;
  limit?: number;
  offset?: number;
}): StoredPost[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let sql = "SELECT * FROM dag_posts WHERE status != 'pruned'";
  const params: unknown[] = [];

  if (opts.author) {
    sql += ' AND author = ?';
    params.push(Buffer.from(opts.author));
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as PostRow[];
  return rows.map(rowToPost);
}

/**
 * Get pending (unconfirmed) posts, oldest first.
 */
export function getPendingPosts(limit: number): StoredPost[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM dag_posts WHERE status = 'pending' ORDER BY timestamp ASC LIMIT ?",
    )
    .all(limit) as PostRow[];
  return rows.map(rowToPost);
}

/**
 * Mark a post as confirmed at a given block height.
 */
export function confirmPost(postId: string, blockHeight: number): void {
  getDb()
    .prepare(
      "UPDATE dag_posts SET status = 'confirmed', block_height = ? WHERE id = ?",
    )
    .run(blockHeight, postId);
}

/**
 * Reverse a confirmPost by setting status back to 'pending'
 * and clearing block_height.
 */
export function unconfirmPost(subBlockId: string): void {
  getDb()
    .prepare(
      "UPDATE dag_posts SET status = 'pending', block_height = NULL WHERE id = ?",
    )
    .run(subBlockId);
}

/**
 * Walk up dag_parent_refs from a post to collect all ancestors in a straight
 * line (follows the first parent at each step). Returns posts in order from
 * genesis → immediate parent of the target. The target post itself is NOT
 * included. Pruned posts are skipped (they break the chain).
 */
export function getAncestors(postId: string): StoredPost[] {
  const db = getDb();
  const ancestors: StoredPost[] = [];
  const seen = new Set<string>();
  let currentId: string | null = postId;

  while (currentId) {
    const parents = getParentRefs(currentId);
    const firstParent: string | undefined = parents[0];
    if (!firstParent) break;

    // Follow the first parent for a deterministic linear chain
    if (seen.has(firstParent)) break; // cycle detection
    seen.add(firstParent);

    const row = db
      .prepare("SELECT * FROM dag_posts WHERE id = ? AND status != 'pruned'")
      .get(firstParent) as PostRow | undefined;
    if (!row) break;

    ancestors.unshift(rowToPost(row)); // prepend so order is genesis → parent
    currentId = firstParent;
  }

  return ancestors;
}

/**
 * Return the parent IDs for a given post, in insertion order.
 */
export function getParentRefs(postId: string): string[] {
  const rows = getDb()
    .prepare('SELECT parent_id FROM dag_parent_refs WHERE post_id = ?')
    .all(postId) as Array<{ parent_id: string }>;
  return rows.map((r) => r.parent_id);
}

// Reserved, never to be reused: `insertPostPlaceholder`. A placeholder existed
// because a block committed a post's TOPOLOGY (`SubBlockEntry`) while its content
// arrived separately. A post is now a transaction, so a node holding the block
// body holds the content — there is no state in which a confirmed post has no
// content, and nothing left for a content sweep to resolve.

/**
 * Return all descendant posts of the given root post, using a recursive CTE
 * over dag_parent_refs. The root post itself is NOT included in the result.
 */
export function getSubtree(postId: string): StoredPost[] {
  const db = getDb();
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree AS (
         SELECT dp.* FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         WHERE dpr.parent_id = ?

         UNION

         SELECT dp.* FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         JOIN subtree s ON dpr.parent_id = s.id
       )
       SELECT DISTINCT * FROM subtree`,
    )
    .all(postId) as PostRow[];
  return rows.map(rowToPost);
}

/**
 * Mark the entire reply subtree (including the root) as pruned.
 *
 * The Stump insertion is handled separately during block application.
 * This function only updates dag_posts status.
 */
export function pruneSubtree(rootPostId: string): void {
  const db = getDb();

  // Collect all post IDs in the subtree (root + descendants)
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM dag_posts WHERE id = ?

         UNION

         SELECT dp.id FROM dag_posts dp
         JOIN dag_parent_refs dpr ON dp.id = dpr.post_id
         JOIN subtree s ON dpr.parent_id = s.id
       )
       SELECT id FROM subtree`,
    )
    .all(rootPostId) as Array<{ id: string }>;

  if (rows.length === 0) return;

  const markPruned = db.prepare(
    "UPDATE dag_posts SET status = 'pruned' WHERE id = ?",
  );

  db.transaction(() => {
    for (const { id } of rows) {
      markPruned.run(id);
    }
  })();
}
