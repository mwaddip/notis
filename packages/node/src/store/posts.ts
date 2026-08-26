import { getDb } from './db.js';
import type { PostCommit, PostId, PostType, Stump } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PostRow {
  id: string;
  content_hash: string;           // hex of 32-byte commitment
  content: string | null;         // NULL = placeholder
  author: Buffer;                 // 32-byte Ed25519 public key
  parent_refs: string;            // JSON array
  protocol_version: number;
  type: string;                   // PostType stored as text
  status: string;
  block_height: number | null;
  block_index: number | null;
  withdrawn_at_height: number | null;
}

interface StumpRow {
  id: string;
  root_post_hash: string;
  author_id: Buffer;              // 32-byte Ed25519 public key
  reply_count: number;
  upvote_count: number;
  protocol_version: number;
  compacted_at_block_height: number;
}

interface TopologyRow {
  post_id: string;
  parent_refs: string;            // JSON array
  author: string;                 // hex
  block_height: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PostStatus = 'pending' | 'confirmed';

export interface StoredPost {
  id: PostId;
  content: string | null;
  contentHash: string;            // hex
  author: Uint8Array;
  parentRefs: PostId[];
  protocolVersion: number;
  type: PostType;
  status: PostStatus;
  blockHeight: number | null;
  blockIndex: number | null;
  withdrawnAtHeight: number | null;
}

export interface PrunedTombstone {
  kind: 'pruned';
  id: PostId;
  author: string;                 // hex, from block_topology
  rootPostHash: PostId;
  compactedAtBlockHeight: number;
}

export interface DeletedPostRow {
  id: PostId;
  contentHash: string;
  content: string | null;
  author: Uint8Array;
  parentRefs: PostId[];
  protocolVersion: number;
  type: PostType;
  status: PostStatus;
  blockHeight: number | null;
  blockIndex: number | null;
  withdrawnAtHeight: number | null;
}

export function isStoredPost(x: StoredPost | Stump | PrunedTombstone | null): x is StoredPost {
  return x !== null && 'status' in x && !('rootPostHash' in x) && !('kind' in x);
}

export function isLivePost(x: StoredPost | Stump | PrunedTombstone | null): x is StoredPost {
  return isStoredPost(x) && x.withdrawnAtHeight === null;
}

export function isStump(x: StoredPost | Stump | PrunedTombstone | null): x is Stump {
  return x !== null && 'rootPostHash' in x && !('kind' in x);
}

export function isPrunedTombstone(x: StoredPost | Stump | PrunedTombstone | null): x is PrunedTombstone {
  return x !== null && 'kind' in x && (x as PrunedTombstone).kind === 'pruned';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPost(row: PostRow): StoredPost {
  return {
    id: row.id,
    content: row.content,
    contentHash: row.content_hash,
    author: new Uint8Array(row.author),
    parentRefs: JSON.parse(row.parent_refs) as string[],
    protocolVersion: row.protocol_version,
    type: row.type as PostType,
    status: row.status as PostStatus,
    blockHeight: row.block_height,
    blockIndex: row.block_index,
    withdrawnAtHeight: row.withdrawn_at_height,
  };
}

function rowToStump(row: StumpRow): Stump {
  return {
    rootPostHash: row.root_post_hash,
    authorId: new Uint8Array(row.author_id),
    replyCount: row.reply_count,
    upvoteCount: row.upvote_count,
    protocolVersion: row.protocol_version,
    compactedAtBlockHeight: row.compacted_at_block_height,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function insertPost(postId: PostId, commit: PostCommit, content: string | null): void {
  const db = getDb();
  const contentHash = Buffer.from(commit.contentHash).toString('hex');

  db.transaction(() => {
    db.prepare(
      `INSERT INTO dag_posts
         (id, content_hash, content, author, parent_refs,
          protocol_version, type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      postId,
      contentHash,
      content,
      Buffer.from(commit.author),
      JSON.stringify(commit.parentRefs),
      commit.protocolVersion,
      commit.type,
    );

    const insertRef = db.prepare(
      'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
    );
    for (const parentId of commit.parentRefs) {
      insertRef.run(postId, parentId);
    }
  })();
}

export function setPostBody(postId: string, content: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE dag_posts SET content = ? WHERE id = ? AND content IS NULL AND withdrawn_at_height IS NULL`,
    )
    .run(content, postId);
  return result.changes > 0;
}

export function getPost(id: string): StoredPost | Stump | PrunedTombstone | null {
  const db = getDb();

  // 1. dag_posts row → StoredPost
  const postRow = db
    .prepare('SELECT * FROM dag_posts WHERE id = ?')
    .get(id) as PostRow | undefined;

  if (postRow) {
    return rowToPost(postRow);
  }

  // 2. dag_stumps by id → Stump
  const stumpRow = db
    .prepare('SELECT * FROM dag_stumps WHERE id = ?')
    .get(id) as StumpRow | undefined;
  if (stumpRow) {
    return rowToStump(stumpRow);
  }

  // 3. block_topology chain to a stump → PrunedTombstone
  return getPrunedTombstone(id);
}

export function getPrunedTombstone(id: string): PrunedTombstone | null {
  const db = getDb();

  // NODE_INTERFACE → Resolution order for a post id, step 3: walk parent_refs from block_topology
  // until a dag_stumps id is found. The chain is bounded by confirmed topology depth.
  const topoRow = db
    .prepare('SELECT * FROM block_topology WHERE post_id = ?')
    .get(id) as TopologyRow | undefined;
  if (!topoRow) return null;

  let currentId = id;
  const seen = new Set<string>();
  while (true) {
    seen.add(currentId);
    const row = db
      .prepare('SELECT * FROM block_topology WHERE post_id = ?')
      .get(currentId) as TopologyRow | undefined;
    if (!row) return null;

    const parents: string[] = JSON.parse(row.parent_refs);
    const parentId = parents[0];
    if (!parentId) return null;

    const stump = db
      .prepare('SELECT compacted_at_block_height FROM dag_stumps WHERE id = ?')
      .get(parentId) as { compacted_at_block_height: number } | undefined;
    if (stump) {
      return {
        kind: 'pruned',
        id,
        author: topoRow.author,
        rootPostHash: parentId,
        compactedAtBlockHeight: stump.compacted_at_block_height,
      };
    }

    const parentStump = db
      .prepare('SELECT compacted_at_block_height FROM dag_stumps WHERE root_post_hash = ?')
      .get(parentId) as { compacted_at_block_height: number } | undefined;
    if (parentStump) {
      return {
        kind: 'pruned',
        id,
        author: topoRow.author,
        rootPostHash: parentId,
        compactedAtBlockHeight: parentStump.compacted_at_block_height,
      };
    }

    if (seen.has(parentId)) return null;
    currentId = parentId;
  }
}

export function getMissingBodies(limit: number): Array<{ id: string; contentHash: string }> {
  const rows = getDb()
    .prepare(
      `SELECT id, content_hash FROM dag_posts
       WHERE content IS NULL AND withdrawn_at_height IS NULL
       ORDER BY block_height DESC, block_index DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; content_hash: string }>;
  return rows.map(r => ({ id: r.id, contentHash: r.content_hash }));
}

export function getPlaceholdersAt(height: number): Array<{ id: string; contentHash: string }> {
  const rows = getDb()
    .prepare(
      `SELECT id, content_hash FROM dag_posts
       WHERE block_height = ? AND content IS NULL AND withdrawn_at_height IS NULL`,
    )
    .all(height) as Array<{ id: string; content_hash: string }>;
  return rows.map(r => ({ id: r.id, contentHash: r.content_hash }));
}

export function queryPosts(opts: {
  author?: Uint8Array;
  limit?: number;
  offset?: number;
}): StoredPost[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let sql = 'SELECT * FROM dag_posts';
  const params: unknown[] = [];

  if (opts.author) {
    sql += ' WHERE author = ?';
    params.push(Buffer.from(opts.author));
  }

  sql += ` ORDER BY
    CASE WHEN block_height IS NULL THEN 0 ELSE 1 END,
    CASE WHEN block_height IS NULL THEN rowid ELSE NULL END DESC,
    block_height DESC, block_index DESC
    LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as PostRow[];
  return rows.map(rowToPost);
}

export function getPendingPosts(limit: number): StoredPost[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM dag_posts WHERE status = 'pending' ORDER BY rowid ASC LIMIT ?",
    )
    .all(limit) as PostRow[];
  return rows.map(rowToPost);
}

export function confirmPost(postId: string, blockHeight: number, blockIndex: number): void {
  getDb()
    .prepare(
      "UPDATE dag_posts SET status = 'confirmed', block_height = ?, block_index = ? WHERE id = ?",
    )
    .run(blockHeight, blockIndex, postId);
}

export function unconfirmPost(postId: string): void {
  getDb()
    .prepare(
      "UPDATE dag_posts SET status = 'pending', block_height = NULL, block_index = NULL WHERE id = ?",
    )
    .run(postId);
}

export function deletePendingPost(postId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM dag_parent_refs WHERE post_id = ?').run(postId);
    db.prepare("DELETE FROM dag_posts WHERE id = ? AND status = 'pending'").run(postId);
  })();
}

export function deletePostRows(ids: string[]): DeletedPostRow[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const deleted: DeletedPostRow[] = [];

  const selectPost = db.prepare('SELECT * FROM dag_posts WHERE id = ?');
  const deleteRefs = db.prepare('DELETE FROM dag_parent_refs WHERE post_id = ?');
  const deletePost = db.prepare('DELETE FROM dag_posts WHERE id = ?');

  for (const id of ids) {
    const row = selectPost.get(id) as PostRow | undefined;
    if (!row) continue;

    const parentRefs = db
      .prepare('SELECT parent_id FROM dag_parent_refs WHERE post_id = ?')
      .all(id) as Array<{ parent_id: string }>;

    deleted.push({
      id: row.id,
      contentHash: row.content_hash,
      content: row.content,
      author: new Uint8Array(row.author),
      parentRefs: parentRefs.map(r => r.parent_id),
      protocolVersion: row.protocol_version,
      type: row.type as PostType,
      status: row.status as PostStatus,
      blockHeight: row.block_height,
      blockIndex: row.block_index,
      withdrawnAtHeight: row.withdrawn_at_height,
    });

    deleteRefs.run(id);
    deletePost.run(id);
  }

  return deleted;
}

export function restorePostRows(rows: DeletedPostRow[]): void {
  const db = getDb();
  const insertPostStmt = db.prepare(
    `INSERT INTO dag_posts
       (id, content_hash, content, author, parent_refs,
        protocol_version, type, status, block_height, block_index,
        withdrawn_at_height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRef = db.prepare(
    'INSERT OR IGNORE INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)',
  );

  for (const row of rows) {
    insertPostStmt.run(
      row.id,
      row.contentHash,
      row.content,
      Buffer.from(row.author),
      JSON.stringify(row.parentRefs),
      row.protocolVersion,
      row.type,
      row.status,
      row.blockHeight,
      row.blockIndex,
      row.withdrawnAtHeight,
    );
    for (const parentId of row.parentRefs) {
      insertRef.run(row.id, parentId);
    }
  }
}

export function getAncestors(postId: string): StoredPost[] {
  const db = getDb();
  const ancestors: StoredPost[] = [];
  const seen = new Set<string>();
  let currentId: string | null = postId;

  while (currentId) {
    const parents = getParentRefs(currentId);
    const firstParent: string | undefined = parents[0];
    if (!firstParent) break;

    if (seen.has(firstParent)) break;
    seen.add(firstParent);

    const row = db
      .prepare('SELECT * FROM dag_posts WHERE id = ?')
      .get(firstParent) as PostRow | undefined;
    if (!row) break;

    ancestors.unshift(rowToPost(row));
    currentId = firstParent;
  }

  return ancestors;
}

export function getParentRefs(postId: string): string[] {
  const rows = getDb()
    .prepare('SELECT parent_id FROM dag_parent_refs WHERE post_id = ?')
    .all(postId) as Array<{ parent_id: string }>;
  return rows.map((r) => r.parent_id);
}

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
