import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { BatchAVLProver, label, serializeNode } from '@ergots/avltree';
import type { AvlNode } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';

// The in-place conversion of a per-version AVL store (NODE_INTERFACE → AVL+
// State Root → "AVL storage shares nodes across versions; a row is a node's
// lifetime", the closing paragraph).

async function importFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

const AVL_CONFIG = { keyLength: 32, valueLengthOpt: null };
const HEIGHT_SENTINEL = new Uint8Array(32);

/** The per-version layout: every node of the tree copied under every version. */
const PER_VERSION_LAYOUT = `
  CREATE TABLE avl_tree_versions (
    version BLOB PRIMARY KEY,
    height INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE avl_tree_nodes (
    version BLOB NOT NULL REFERENCES avl_tree_versions(version),
    label BLOB NOT NULL,
    node_data BLOB NOT NULL,
    PRIMARY KEY (version, label)
  );
`;

function keyOf(i: number): Uint8Array {
  const key = new Uint8Array(32);
  key[0] = (i >> 8) & 0xff;
  key[1] = i & 0xff;
  return key;
}

function encodeHeight(h: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, h, false);
  return buf;
}

/** The per-version writer: a version row, then every node under that version. */
function perVersionCheckpoint(raw: Database.Database, prover: BatchAVLProver, height: number): Uint8Array {
  const version = prover.digest();
  const insertVersion = raw.prepare('INSERT INTO avl_tree_versions (version, height) VALUES (?, ?)');
  const insertNode = raw.prepare(
    'INSERT OR REPLACE INTO avl_tree_nodes (version, label, node_data) VALUES (?, ?, ?)',
  );
  const walk = (node: AvlNode): void => {
    if (node.kind === 'internal') {
      walk(node.left);
      walk(node.right);
    }
    insertNode.run(version, label(node), serializeNode(node, AVL_CONFIG));
  };
  raw.transaction(() => {
    insertVersion.run(version, height);
    walk(prover.root);
  })();
  prover.generateProof();
  return version;
}

function findLeaf(node: AvlNode, key: Uint8Array): AvlNode | null {
  if (node.kind === 'leaf') return Buffer.from(node.key).equals(Buffer.from(key)) ? node : null;
  if (node.kind !== 'internal') return null;
  return findLeaf(node.left, key) ?? findLeaf(node.right, key);
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
}

interface OldStore {
  versions: Array<{ version: Uint8Array; height: number }>;
  /** Heights at which each label (hex) was present, from the per-version rows. */
  presence: Map<string, number[]>;
  leafLabelOfKey5: Buffer;
  root1: Buffer;
}

/**
 * Four versions at heights 1..4, one label present, absent, present again
 * across a gap: key 5 is removed at 2 and re-inserted at 3 with the same
 * value, so its leaf's label (key, value, successor) recurs. Key 12 rides the
 * re-insert so the tree at 3 is not the tree at 1 — the version digest is the
 * versions table's primary key.
 */
function buildOldStore(dbPath: string, heights: number[] = [1, 2, 3, 4]): OldStore {
  const raw = new Database(dbPath);
  raw.exec(PER_VERSION_LAYOUT);
  const prover = new BatchAVLProver(32, null);
  const versions: OldStore['versions'] = [];

  for (let i = 1; i <= 10; i++) {
    prover.performOneOperation({ tag: 'Insert', key: keyOf(i), value: new Uint8Array([i]) });
  }
  const leafLabelOfKey5 = Buffer.from(label(findLeaf(prover.root, keyOf(5))!));
  versions.push({ version: perVersionCheckpoint(raw, prover, heights[0]!), height: heights[0]! });
  const root1 = Buffer.from(versions[0]!.version.slice(0, 32));

  prover.performOneOperation({ tag: 'Remove', key: keyOf(5) });
  versions.push({ version: perVersionCheckpoint(raw, prover, heights[1]!), height: heights[1]! });

  prover.performOneOperation({ tag: 'Insert', key: keyOf(5), value: new Uint8Array([5]) });
  prover.performOneOperation({ tag: 'Insert', key: keyOf(12), value: new Uint8Array([12]) });
  versions.push({ version: perVersionCheckpoint(raw, prover, heights[2]!), height: heights[2]! });

  prover.performOneOperation({ tag: 'Insert', key: keyOf(11), value: new Uint8Array([11]) });
  versions.push({ version: perVersionCheckpoint(raw, prover, heights[3]!), height: heights[3]! });

  const presence = new Map<string, number[]>();
  const rows = raw.prepare(
    'SELECT n.label AS label, v.height AS height FROM avl_tree_nodes n JOIN avl_tree_versions v ON v.version = n.version ORDER BY v.height',
  ).all() as Array<{ label: Buffer; height: number }>;
  for (const r of rows) {
    const hex = r.label.toString('hex');
    presence.set(hex, [...(presence.get(hex) ?? []), r.height]);
  }
  raw.close();
  return { versions, presence, leafLabelOfKey5, root1 };
}

describe('migrateAvlTree — the per-version layout converts in place', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-avl-migration-'));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a fresh store gets the shared-nodes layout directly', async () => {
    const dbPath = path.join(tmpDir, 'fresh.db');
    const { initDb, getDb, closeDb } = await importFresh();
    initDb(dbPath);
    expect(columnsOf(getDb(), 'avl_tree_nodes')).toEqual([
      'label', 'node_data', 'first_seen_height', 'orphaned_at_height',
    ]);
    const idx = (getDb().pragma('index_list(avl_tree_nodes)') as Array<{ name: string }>).map(i => i.name);
    expect(idx).toContain('idx_avl_tree_nodes_orphaned');
    expect(idx).toContain('idx_avl_tree_nodes_first_seen');
    closeDb();
  });

  it('one row per label, lifetimes derived from the versions, every old version resolves', async () => {
    const dbPath = path.join(tmpDir, 'convert.db');
    const old = buildOldStore(dbPath);
    const gap = old.presence.get(old.leafLabelOfKey5.toString('hex'))!;
    expect(gap).toEqual([1, 3, 4]); // present, absent, present again
    const distinctLabels = old.presence.size;

    const { initDb, getDb, closeDb } = await importFresh();
    initDb(dbPath);
    const db = getDb();

    expect(columnsOf(db, 'avl_tree_nodes')).toEqual([
      'label', 'node_data', 'first_seen_height', 'orphaned_at_height',
    ]);
    const idx = (db.pragma('index_list(avl_tree_nodes)') as Array<{ name: string }>).map(i => i.name);
    expect(idx).toContain('idx_avl_tree_nodes_orphaned');
    expect(idx).toContain('idx_avl_tree_nodes_first_seen');

    // The versions table is untouched.
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    expect(storage.rollbackVersions().map(v => Buffer.from(v).toString('hex'))).toEqual(
      old.versions.map(v => Buffer.from(v.version).toString('hex')),
    );

    // One row per label: first_seen_height is the lowest height whose version
    // holds it, orphaned_at_height the height after the highest, NULL when the
    // tip holds it.
    const rows = db.prepare(
      'SELECT label, first_seen_height AS f, orphaned_at_height AS o FROM avl_tree_nodes',
    ).all() as Array<{ label: Buffer; f: number; o: number | null }>;
    expect(rows.length).toBe(distinctLabels);
    const tip = 4;
    for (const r of rows) {
      const heights = old.presence.get(r.label.toString('hex'))!;
      expect(heights, r.label.toString('hex')).toBeDefined();
      expect(r.f).toBe(Math.min(...heights));
      const max = Math.max(...heights);
      expect(r.o).toBe(max === tip ? null : max + 1);
    }
    // The label with the gap: one row, alive from 1 through the tip.
    expect(rows.filter(r => r.label.equals(old.leafLabelOfKey5)).map(r => [r.f, r.o])).toEqual([[1, null]]);
    // The first root left the tree at 2 and never recurred (the versions above
    // it hold a different key set or a different shape).
    const root1 = rows.filter(r => r.label.equals(old.root1));
    expect(root1.length).toBe(1);
    expect(root1[0]!.f).toBe(1);
    expect(root1[0]!.o).toBe(Math.max(...old.presence.get(old.root1.toString('hex'))!) + 1);

    // Every old version resolves to its recorded root, and reads as it did.
    for (const { version, height } of old.versions) {
      const [root, treeHeight] = storage.rollback(version);
      expect(Buffer.from(label(root))).toEqual(Buffer.from(version.slice(0, 32)));
      expect(treeHeight).toBe(version[32]);
      const reader = new BatchAVLProver(32, null);
      reader.restoreRoot(root, treeHeight);
      expect(reader.digest()).toEqual(version);
      expect(reader.unauthenticatedLookup(keyOf(5))).toEqual(height === 2 ? null : new Uint8Array([5]));
      expect(reader.unauthenticatedLookup(keyOf(11))).toEqual(height === 4 ? new Uint8Array([11]) : null);
    }
    closeDb();

    // A second open finds the shared layout and leaves it alone.
    vi.resetModules();
    const again = await importFresh();
    again.initDb(dbPath);
    expect(columnsOf(again.getDb(), 'avl_tree_nodes')).toEqual([
      'label', 'node_data', 'first_seen_height', 'orphaned_at_height',
    ]);
    expect((again.getDb().prepare('SELECT COUNT(*) AS n FROM avl_tree_nodes').get() as { n: number }).n)
      .toBe(distinctLabels);
    again.closeDb();
  });

  it('the converted store continues under the shared writer', async () => {
    const dbPath = path.join(tmpDir, 'continue.db');
    const old = buildOldStore(dbPath);
    const { initDb, getDb, closeDb } = await importFresh();
    initDb(dbPath);
    const db = getDb();
    const storage = new SqliteAvlStorage(db, AVL_CONFIG);
    const { PersistentBatchAVLProver } = await import('@ergots/avltree');
    const persisted = new PersistentBatchAVLProver(
      new BatchAVLProver(32, null), storage, [[HEIGHT_SENTINEL, encodeHeight(0)]],
    );
    expect(persisted.digest()).toEqual(old.versions[3]!.version);

    persisted.performOneOperation({ tag: 'Remove', key: keyOf(11) });
    persisted.generateProofAndUpdateStorage([[HEIGHT_SENTINEL, encodeHeight(5)]]);
    const v5 = persisted.digest();
    expect(storage.versionHeight(v5)).toBe(5);
    for (const { version } of old.versions) {
      const [root] = storage.rollback(version);
      expect(Buffer.from(label(root))).toEqual(Buffer.from(version.slice(0, 32)));
    }
    const [root5] = storage.rollback(v5);
    expect(Buffer.from(label(root5))).toEqual(Buffer.from(v5.slice(0, 32)));
    closeDb();
  });

  it('refuses a store whose retained versions are not contiguous heights', async () => {
    const dbPath = path.join(tmpDir, 'gap.db');
    buildOldStore(dbPath, [1, 2, 4, 5]);
    const { initDb, closeDb } = await importFresh();
    expect(() => initDb(dbPath)).toThrow(/contiguous/);
    closeDb();

    // The refusal left the per-version layout in place.
    const raw = new Database(dbPath);
    expect(columnsOf(raw, 'avl_tree_nodes')).toEqual(['version', 'label', 'node_data']);
    raw.close();
  });
});
