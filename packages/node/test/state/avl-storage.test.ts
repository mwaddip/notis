import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BatchAVLProver, PersistentBatchAVLProver, label } from '@ergots/avltree';
import type { AvlNode } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';

// The tables initDb creates (NODE_INTERFACE → AVL+ State Root → "AVL storage
// shares nodes across versions; a row is a node's lifetime").
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE avl_tree_nodes (
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      first_seen_height INTEGER NOT NULL,
      orphaned_at_height INTEGER,
      PRIMARY KEY (label, first_seen_height)
    );
    CREATE INDEX idx_avl_tree_nodes_orphaned ON avl_tree_nodes(orphaned_at_height);
    CREATE INDEX idx_avl_tree_nodes_first_seen ON avl_tree_nodes(first_seen_height);
  `);
  return db;
}

const HEIGHT_SENTINEL = new Uint8Array(32); // all zeros

/** Storage codec config -- must match each test's BatchAVLProver key length. */
const AVL_CONFIG = { keyLength: 32, valueLengthOpt: null };

/** A 32-byte key carrying `i` in its first two bytes; `i >= 1` avoids the all-zero sentinel. */
function keyOf(i: number): Uint8Array {
  const key = new Uint8Array(32);
  key[0] = (i >> 8) & 0xff;
  key[1] = i & 0xff;
  return key;
}

/** The production driver: update, then the proof that rebases the cycle. */
function checkpoint(persisted: PersistentBatchAVLProver, height: number): Uint8Array {
  persisted.generateProofAndUpdateStorage([[HEIGHT_SENTINEL, encodeHeight(height)]]);
  return persisted.digest();
}

function insert(persisted: PersistentBatchAVLProver, i: number, value = new Uint8Array([i & 0xff])): void {
  const result = persisted.performOneOperation({ tag: 'Insert', key: keyOf(i), value });
  if (!result.success) throw new Error(`Insert of key ${i} refused`);
}

function remove(persisted: PersistentBatchAVLProver, i: number): void {
  const result = persisted.performOneOperation({ tag: 'Remove', key: keyOf(i) });
  if (!result.success) throw new Error(`Remove of key ${i} refused`);
}

function countRows(db: Database.Database, where = '1'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM avl_tree_nodes WHERE ${where}`).get() as { n: number }).n;
}

function treeNodeCount(node: AvlNode): number {
  if (node.kind !== 'internal') return 1;
  return 1 + treeNodeCount(node.left) + treeNodeCount(node.right);
}

function findLeaf(node: AvlNode, key: Uint8Array): AvlNode | null {
  if (node.kind === 'leaf') return Buffer.from(node.key).equals(Buffer.from(key)) ? node : null;
  if (node.kind !== 'internal') return null;
  return findLeaf(node.left, key) ?? findLeaf(node.right, key);
}

/** Every row as `labelHex:first:orphaned`, sorted — the table's exact content. */
function tableRows(db: Database.Database): string[] {
  const rows = db.prepare(
    'SELECT label, first_seen_height AS f, orphaned_at_height AS o FROM avl_tree_nodes',
  ).all() as Array<{ label: Buffer; f: number; o: number | null }>;
  return rows.map(r => `${r.label.toString('hex')}:${r.f}:${r.o ?? 'live'}`).sort();
}

function rootLabelOf(version: Uint8Array): Buffer {
  return Buffer.from(version.slice(0, 32));
}

describe('SqliteAvlStorage', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('version() returns null on empty storage', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    expect(storage.version()).toBeNull();
  });

  it('update() then version() returns the digest', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    // Insert a single key-value pair
    const key = new Uint8Array(32);
    key[0] = 0x01;
    const value = new Uint8Array([0xaa, 0xbb]);
    prover.performOneOperation({ tag: 'Insert', key, value });

    const digest = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    expect(storage.version()).toEqual(digest);
  });

  it('update() -> rollback() roundtrip with single insert', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    const key = new Uint8Array(32);
    key[0] = 0x01;
    const value = new Uint8Array([0xaa, 0xbb]);
    prover.performOneOperation({ tag: 'Insert', key, value });

    const digestBefore = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    // Create fresh prover and rollback
    const prover2 = new BatchAVLProver(32, null);
    const persisted = new PersistentBatchAVLProver(prover2, storage, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    expect(persisted.digest()).toEqual(digestBefore);
    expect(persisted.unauthenticatedLookup(key)).toEqual(value);
  });

  it('update() -> rollback() roundtrip with 100 inserts', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const prover = new BatchAVLProver(32, null);

    // Start at 1 to avoid all-zeros key (AVL negative-infinity sentinel).
    const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    for (let i = 1; i <= 100; i++) {
      const key = new Uint8Array(32);
      key[0] = (i >> 8) & 0xff;
      key[1] = i & 0xff;
      const value = new Uint8Array([i & 0xff]);
      prover.performOneOperation({ tag: 'Insert', key, value });
      entries.push({ key, value });
    }

    const digestBefore = prover.digest()!;
    storage.update(prover, [[HEIGHT_SENTINEL, encodeHeight(1)]]);

    // Rollback fresh prover
    const prover2 = new BatchAVLProver(32, null);
    const persisted = new PersistentBatchAVLProver(prover2, storage, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    expect(persisted.digest()).toEqual(digestBefore);

    for (const { key, value } of entries) {
      expect(persisted.unauthenticatedLookup(key)).toEqual(value);
    }
  });

  it('pruneVersionsBefore() drops the versions below the cutoff and the rows only they read', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const persisted = new PersistentBatchAVLProver(
      new BatchAVLProver(32, null), storage, [[HEIGHT_SENTINEL, encodeHeight(0)]],
    );

    // Heights 1..5, one insert each; the constructor wrote the empty tree at 0.
    const versions: Uint8Array[] = [];
    for (let h = 1; h <= 5; h++) {
      insert(persisted, h);
      versions.push(checkpoint(persisted, h));
    }
    expect(storage.rollbackVersions().length).toBe(6);
    expect(countRows(db, 'orphaned_at_height IS NOT NULL AND orphaned_at_height <= 3')).toBeGreaterThan(0);

    storage.pruneVersionsBefore(3);

    // Heights 3, 4, 5 remain.
    const remaining = storage.rollbackVersions().map(v => storage.versionHeight(v));
    expect(remaining).toEqual([3, 4, 5]);
    // Every row orphaned at or below the cutoff is gone; rows orphaned above
    // it stay, because the retained versions still read them.
    expect(countRows(db, 'orphaned_at_height IS NOT NULL AND orphaned_at_height <= 3')).toBe(0);
    expect(countRows(db, 'orphaned_at_height IS NOT NULL AND orphaned_at_height > 3')).toBeGreaterThan(0);
    // The live rows are exactly the tip tree — shared rows survive the prune.
    expect(countRows(db, 'orphaned_at_height IS NULL')).toBe(treeNodeCount(persisted.prover.root));
    // The oldest retained version still resolves to its recorded root.
    const [root3, height3] = storage.rollback(versions[2]!);
    expect(Buffer.from(label(root3))).toEqual(rootLabelOf(versions[2]!));
    expect(height3).toBe(versions[2]![32]);
    persisted.rollback(versions[2]!);
    expect(persisted.digest()).toEqual(versions[2]);
  });

  it('rollbackVersions() returns all versions', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);

    // Insert at version 1
    const prover1 = new BatchAVLProver(32, null);
    const key1 = new Uint8Array(32);
    key1[0] = 0x01;
    prover1.performOneOperation({ tag: 'Insert', key: key1, value: new Uint8Array([1]) });
    storage.update(prover1, [[HEIGHT_SENTINEL, encodeHeight(1)]]);
    const v1 = storage.version()!;

    // Insert a different key at version 2 (byte 0 = 0x02, not 0x01)
    const key2 = new Uint8Array(32);
    key2[0] = 0x02;
    prover1.performOneOperation({ tag: 'Insert', key: key2, value: new Uint8Array([2]) });
    storage.update(prover1, [[HEIGHT_SENTINEL, encodeHeight(2)]]);
    const v2 = storage.version()!;

    const versions = storage.rollbackVersions();
    expect(versions.length).toBe(2);
    expect(versions.map(v => Buffer.from(v).toString('hex')).sort()).toEqual(
      [v1, v2].map(v => Buffer.from(v).toString('hex')).sort()
    );
  });

  it('a version writes the changed paths, never the tree, and every version still resolves', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const persisted = new PersistentBatchAVLProver(
      new BatchAVLProver(32, null), storage, [[HEIGHT_SENTINEL, encodeHeight(0)]],
    );

    const SEED = 200;
    const VERSIONS = 50;
    for (let i = 1; i <= SEED; i++) insert(persisted, i);
    checkpoint(persisted, 1);
    const rowsAfterSeed = countRows(db);
    // The seed tree: a leaf per key plus the sentinel, an internal node per
    // leaf less one — every node written once.
    expect(rowsAfterSeed).toBe(treeNodeCount(persisted.prover.root) + 1); // + the empty tree's sentinel row, orphaned at 1

    const versions: Uint8Array[] = [];
    for (let h = 2; h <= VERSIONS + 1; h++) {
      insert(persisted, SEED + h);
      versions.push(checkpoint(persisted, h));
    }
    const rowsFinal = countRows(db);

    // One insert rewrites the root-to-leaf path of the new leaf and of its
    // predecessor (whose nextLeafKey changes) plus a bounded rotation, so it
    // adds O(height) rows; an AVL tree over 250 keys is at most
    // ceil(1.44 · log2(252)) ≈ 12 deep. 3 · ceil(log2(250)) = 24 per version
    // is a loose ceiling on that, and far below the ≈ 400 rows a copy of the
    // whole tree per version would add.
    const added = rowsFinal - rowsAfterSeed;
    expect(added).toBeLessThan(VERSIONS * 3 * Math.ceil(Math.log2(SEED + VERSIONS)));
    expect(added).toBeGreaterThan(VERSIONS); // at least the new leaf and a new root each time

    // Live rows are exactly the tip tree: every node it holds has a live row
    // and no orphaned node kept one.
    expect(countRows(db, 'orphaned_at_height IS NULL')).toBe(treeNodeCount(persisted.prover.root));

    // Each of the 50 versions resolves to its recorded root and tree height.
    expect(versions.length).toBe(VERSIONS);
    for (const v of versions) {
      const [root, treeHeight] = storage.rollback(v);
      expect(Buffer.from(label(root))).toEqual(rootLabelOf(v));
      expect(treeHeight).toBe(v[32]);
    }
  });

  it('deleteVersionAtHeight() is the exact inverse of the update at that height', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const persisted = new PersistentBatchAVLProver(
      new BatchAVLProver(32, null), storage, [[HEIGHT_SENTINEL, encodeHeight(0)]],
    );

    for (let i = 1; i <= 50; i++) insert(persisted, i);
    checkpoint(persisted, 1);
    insert(persisted, 101);
    const v2 = checkpoint(persisted, 2);
    const rowsAfter2 = tableRows(db);
    insert(persisted, 102);
    const v3 = checkpoint(persisted, 3);
    const rowsAfter3 = tableRows(db);
    expect(rowsAfter3).not.toEqual(rowsAfter2);
    expect(countRows(db, 'first_seen_height = 3')).toBeGreaterThan(0);
    expect(countRows(db, 'orphaned_at_height = 3')).toBeGreaterThan(0);

    storage.deleteVersionAtHeight(3);

    expect(storage.rollbackVersions().map(v => storage.versionHeight(v))).toEqual([0, 1, 2]);
    expect(countRows(db, 'first_seen_height = 3')).toBe(0);
    expect(countRows(db, 'orphaned_at_height = 3')).toBe(0);
    // The table reads exactly as it did after the update at 2.
    expect(tableRows(db)).toEqual(rowsAfter2);
    const [root2] = storage.rollback(v2);
    expect(Buffer.from(label(root2))).toEqual(rootLabelOf(v2));

    // A block re-applied at 3 writes fresh rows — no primary-key clash — and
    // the store ends where the first application left it.
    persisted.rollback(v2);
    insert(persisted, 102);
    expect(checkpoint(persisted, 3)).toEqual(v3);
    expect(tableRows(db)).toEqual(rowsAfter3);
    const [root3] = storage.rollback(v3);
    expect(Buffer.from(label(root3))).toEqual(rootLabelOf(v3));
  });

  it('a label that recurs after its rows were orphaned gets a fresh lifetime', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const persisted = new PersistentBatchAVLProver(
      new BatchAVLProver(32, null), storage, [[HEIGHT_SENTINEL, encodeHeight(0)]],
    );

    const K = 7;
    for (let i = 1; i <= 20; i++) insert(persisted, i);
    checkpoint(persisted, 1);
    const leaf = findLeaf(persisted.prover.root, keyOf(K));
    expect(leaf).not.toBeNull();
    const leafLabel = Buffer.from(label(leaf!));
    const lifetimes = (): Array<{ f: number; o: number | null }> =>
      db.prepare(
        'SELECT first_seen_height AS f, orphaned_at_height AS o FROM avl_tree_nodes WHERE label = ? ORDER BY f',
      ).all(leafLabel) as Array<{ f: number; o: number | null }>;
    expect(lifetimes()).toEqual([{ f: 1, o: null }]);

    // Remove k at 2: its leaf leaves the tree, so its row is orphaned at 2.
    remove(persisted, K);
    checkpoint(persisted, 2);
    expect(lifetimes()).toEqual([{ f: 1, o: 2 }]);

    // Re-insert the identical k at 3: same key, value and successor, so the
    // leaf's label recurs — a fresh row first seen at 3, not a revived one.
    // Key 21 rides along so the tree at 3 is not the tree at 1: the version
    // digest is the versions table's primary key.
    insert(persisted, K);
    insert(persisted, 21);
    const v3 = checkpoint(persisted, 3);
    expect(findLeaf(persisted.prover.root, keyOf(K))).not.toBeNull();
    expect(Buffer.from(label(findLeaf(persisted.prover.root, keyOf(K))!))).toEqual(leafLabel);
    expect(lifetimes()).toEqual([{ f: 1, o: 2 }, { f: 3, o: null }]);

    // Pruning past 2 deletes the old lifetime; the version at 3 still resolves.
    storage.pruneVersionsBefore(3);
    expect(lifetimes()).toEqual([{ f: 3, o: null }]);
    const [root3] = storage.rollback(v3);
    expect(Buffer.from(label(root3))).toEqual(rootLabelOf(v3));
    persisted.rollback(v3);
    expect(persisted.unauthenticatedLookup(keyOf(K))).toEqual(new Uint8Array([K]));
  });

  it('rollback() fails closed on a missing row and on an unknown version', () => {
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const persisted = new PersistentBatchAVLProver(
      new BatchAVLProver(32, null), storage, [[HEIGHT_SENTINEL, encodeHeight(0)]],
    );
    for (let i = 1; i <= 10; i++) insert(persisted, i);
    const v1 = checkpoint(persisted, 1);
    expect(() => storage.rollback(v1)).not.toThrow();

    const unknown = new Uint8Array(v1);
    unknown[0] = unknown[0]! ^ 0xff;
    expect(() => storage.rollback(unknown)).toThrow(/Version not found/);

    db.prepare('DELETE FROM avl_tree_nodes WHERE label = ?').run(rootLabelOf(v1));
    expect(() => storage.rollback(v1)).toThrow(/Missing node/);
  });
});

function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false); // BE
  return buf;
}
