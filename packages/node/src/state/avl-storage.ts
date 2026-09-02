import type { VersionedAVLStorage, BatchAVLProver, AvlTreeConfig } from '@ergots/avltree';
import { serializeNode, deserializeNode, label, newInternal } from '@ergots/avltree';
import type { AvlNode } from '@ergots/avltree';
import type Database from 'better-sqlite3';

/**
 * SQLite-backed VersionedAVLStorage.
 *
 * NODE_INTERFACE → AVL+ State Root → "AVL storage shares nodes across versions;
 * a row is a node's lifetime". A node's label is the hash of its content and
 * its children's labels, so an unchanged subtree carries the same label in
 * every version and `avl_tree_nodes` holds it once per lifetime, keyed
 * `(label, first_seen_height)`; `avl_tree_versions` is one row per applied
 * block, the version being the digest (root label ‖ tree height). An update at
 * height `h` orphans the previous tree's nodes the new tree no longer holds and
 * writes the new tree's nodes that have no live row; a version resolves from
 * its root label through the rows alive at its height.
 */
export class SqliteAvlStorage implements VersionedAVLStorage {
  private db: Database.Database;
  private config: AvlTreeConfig;

  constructor(db: Database.Database, config: AvlTreeConfig) {
    this.db = db;
    this.config = config;
  }

  update(prover: BatchAVLProver, additionalData: [Uint8Array, Uint8Array][]): void {
    const newVersion = prover.digest();
    if (!newVersion) throw new Error('Prover digest is null');
    const height = blockHeightOf(additionalData);

    // Valid here because `generateProofAndUpdateStorage` runs update before
    // the proof that rebases the cycle: the previous cycle's nodes whose
    // labels the current tree no longer holds.
    const removed = prover.removedNodes();

    const orphan = this.db.prepare(
      'UPDATE avl_tree_nodes SET orphaned_at_height = ? WHERE label = ? AND orphaned_at_height IS NULL',
    );
    const hasLiveRow = this.db.prepare(
      'SELECT 1 FROM avl_tree_nodes WHERE label = ? AND orphaned_at_height IS NULL LIMIT 1',
    );
    const insertNode = this.db.prepare(
      'INSERT INTO avl_tree_nodes (label, node_data, first_seen_height, orphaned_at_height) VALUES (?, ?, ?, NULL)',
    );
    const insertVersion = this.db.prepare(
      'INSERT INTO avl_tree_versions (version, height) VALUES (?, ?)',
    );

    this.db.transaction(() => {
      // Orphan before writing. The removed set and the new tree are disjoint,
      // so the walk never consults a row the orphaning touches; the order is
      // stated so that every live row the walk reads is a row the new tree
      // holds. A reported label with no live row is the never-persisted
      // first-cycle sentinel leaf — zero rows updated is fine.
      for (const node of removed) orphan.run(height, label(node));
      this.writeLifetimes(prover.root, height, hasLiveRow, insertNode);
      insertVersion.run(newVersion, height);
    })();
  }

  /**
   * Walk from the root: a label with a live row is a subtree shared with a
   * retained version — a live ancestor has live descendants — so the walk
   * stops there; every other node is a new lifetime first seen at `height`.
   */
  private writeLifetimes(
    node: AvlNode,
    height: number,
    hasLiveRow: Database.Statement,
    insertNode: Database.Statement,
  ): void {
    const nodeLabel = label(node);
    if (hasLiveRow.get(nodeLabel) !== undefined) return;
    insertNode.run(nodeLabel, serializeNode(node, this.config), height);
    if (node.kind === 'internal') {
      this.writeLifetimes(node.left, height, hasLiveRow, insertNode);
      this.writeLifetimes(node.right, height, hasLiveRow, insertNode);
    }
  }

  rollback(version: Uint8Array): [AvlNode, number] {
    const atHeight = this.versionHeight(version);
    if (atHeight === null) {
      throw new Error(`Version not found: ${Buffer.from(version).toString('hex')}`);
    }

    const alive = this.db.prepare(
      'SELECT node_data FROM avl_tree_nodes WHERE label = ? ' +
      'AND first_seen_height <= ? AND (orphaned_at_height IS NULL OR orphaned_at_height > ?)',
    );

    // Resolve from the root label (version = rootLabel || tree height), reading
    // per label the row alive at the version's height. Lifetimes of one label
    // never overlap, so exactly one row answers; none is local corruption, and
    // the resolution fails closed rather than hand the prover a tree it cannot
    // traverse. deserializeNode returns an internal node's children as
    // LabelNode stubs; nodes are immutable, so stubs are resolved into real
    // subtrees by constructing fresh internal nodes. The internal `key` is not
    // part of the label but the prover descends by it, so it is carried through.
    const resolve = (nodeLabel: Uint8Array): AvlNode => {
      const rows = alive.all(nodeLabel, atHeight, atHeight) as Array<{ node_data: Buffer }>;
      if (rows.length !== 1) {
        const hex = Buffer.from(nodeLabel).toString('hex');
        throw new Error(
          rows.length === 0
            ? `Missing node for label ${hex} alive at height ${atHeight}`
            : `Overlapping lifetimes for label ${hex} at height ${atHeight} (${rows.length} rows)`,
        );
      }
      const node = deserializeNode(new Uint8Array(rows[0]!.node_data), this.config);
      if (node.kind !== 'internal') return node;
      const left = resolve(label(node.left));
      const right = resolve(label(node.right));
      return newInternal(left, right, node.balance, node.key);
    };

    const root = resolve(version.slice(0, 32));
    const treeHeight = version[32]!;
    return [root, treeHeight];
  }

  version(): Uint8Array | null {
    const row = this.db
      .prepare('SELECT version FROM avl_tree_versions ORDER BY height DESC LIMIT 1')
      .get() as { version: Buffer } | undefined;
    return row ? new Uint8Array(row.version) : null;
  }

  rollbackVersions(): Uint8Array[] {
    const rows = this.db
      .prepare('SELECT version FROM avl_tree_versions ORDER BY height ASC')
      .all() as Array<{ version: Buffer }>;
    return rows.map(r => new Uint8Array(r.version));
  }

  /**
   * Return the version digest at or before the given block height.
   * Returns the version with the highest height <= maxHeight, or null if none.
   */
  versionAtOrBeforeHeight(maxHeight: number): Uint8Array | null {
    const row = this.db
      .prepare('SELECT version FROM avl_tree_versions WHERE height <= ? ORDER BY height DESC LIMIT 1')
      .get(maxHeight) as { version: Buffer } | undefined;
    return row ? new Uint8Array(row.version) : null;
  }

  /** Return the block height for a stored version, or null if not found. */
  versionHeight(version: Uint8Array): number | null {
    const row = this.db
      .prepare('SELECT height FROM avl_tree_versions WHERE version = ?')
      .get(version) as { height: number } | undefined;
    return row ? row.height : null;
  }

  /**
   * The fork revert's inverse of the update at this height: the rows first
   * seen at `height` go, the rows orphaned at `height` are live again, and the
   * version row(s) at `height` go, so the version below reads exactly as it
   * did. A block re-applied at the height then writes fresh rows — nothing
   * first seen there remains to clash with — and the same content-addressed
   * version row inserts again.
   */
  deleteVersionAtHeight(height: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM avl_tree_nodes WHERE first_seen_height = ?').run(height);
      this.db.prepare(
        'UPDATE avl_tree_nodes SET orphaned_at_height = NULL WHERE orphaned_at_height = ?',
      ).run(height);
      this.db.prepare('DELETE FROM avl_tree_versions WHERE height = ?').run(height);
    })();
  }

  /**
   * A row orphaned at or below the cutoff was read by versions below its
   * orphan height only, all of them deleted here, so it goes with them; a row
   * orphaned above the cutoff is still read by a retained version.
   */
  pruneVersionsBefore(cutoffHeight: number): void {
    this.db.transaction(() => {
      this.db.prepare(
        'DELETE FROM avl_tree_nodes WHERE orphaned_at_height IS NOT NULL AND orphaned_at_height <= ?',
      ).run(cutoffHeight);
      this.db.prepare('DELETE FROM avl_tree_versions WHERE height < ?').run(cutoffHeight);
    })();
  }

  flush(): void {
    // SQLite WAL is auto-flushed; explicit checkpoint for durability
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

/** The block height rides `additionalData` under the all-zero sentinel key, 4-byte big-endian. */
function blockHeightOf(additionalData: [Uint8Array, Uint8Array][]): number {
  for (const [k, v] of additionalData) {
    if (k.length === 32 && k.every(b => b === 0)) {
      return new DataView(v.buffer, v.byteOffset, v.length).getUint32(0, false);
    }
  }
  return 0;
}
