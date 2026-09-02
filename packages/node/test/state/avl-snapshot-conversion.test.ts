import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { BatchAVLProver, label } from '@ergots/avltree';
import type { AvlNode } from '@ergots/avltree';
import { SqliteAvlStorage } from '../../src/state/avl-storage.js';
import { config } from '../../src/config.js';

/**
 * Converts a real per-version store in place and measures it. Runs only with
 * `AVL_SNAPSHOT=<path>` set to a COPY of a node's `dagsocial.db` (initDb writes
 * to it); skipped otherwise. Every number it prints is the store's own
 * (NODE_INTERFACE → AVL+ State Root → "AVL storage shares nodes across
 * versions; a row is a node's lifetime", the conversion paragraph).
 */
const SNAPSHOT = process.env['AVL_SNAPSHOT'];

const SAMPLES = 20;
const PROBE_HEIGHT = 3000;

function treeNodeCount(node: AvlNode): number {
  if (node.kind !== 'internal') return 1;
  return 1 + treeNodeCount(node.left) + treeNodeCount(node.right);
}

function count(db: Database.Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

describe.skipIf(!SNAPSHOT)('the box snapshot converts in place (AVL_SNAPSHOT)', () => {
  it('per-version measurements, the conversion, and resolution of sampled versions', async () => {
    const dbPath = SNAPSHOT!;
    const report: string[] = [];
    const line = (s: string): void => { report.push(s); console.log(`SNAPSHOT ${s}`); };

    // --- before: the per-version layout, read-only ---------------------------
    const raw = new Database(dbPath, { readonly: true });
    const cols = (raw.pragma('table_info(avl_tree_nodes)') as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(['version', 'label', 'node_data']);
    const bytesBefore = fs.statSync(dbPath).size;
    const rowsBefore = count(raw, 'SELECT COUNT(*) AS n FROM avl_tree_nodes');
    const span = raw.prepare(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT height) AS d, MIN(height) AS lo, MAX(height) AS hi FROM avl_tree_versions',
    ).get() as { n: number; d: number; lo: number; hi: number };
    line(`file bytes before: ${bytesBefore}`);
    line(`avl_tree_nodes rows before: ${rowsBefore}`);
    line(`avl_tree_versions: ${span.n} rows, ${span.d} distinct heights, ${span.lo}..${span.hi}`);
    line(`rows per version before: ${(rowsBefore / span.n).toFixed(1)}`);

    // (ii) H4 — contiguous heights.
    expect(span.d).toBe(span.hi - span.lo + 1);
    expect(span.n).toBe(span.d);

    // (i) H3 — one label, one node_data.
    const t0 = Date.now();
    const labelsWithDistinctData = count(
      raw,
      'SELECT COUNT(*) AS n FROM (SELECT label FROM avl_tree_nodes GROUP BY label HAVING COUNT(DISTINCT node_data) > 1)',
    );
    const distinctLabels = count(raw, 'SELECT COUNT(DISTINCT label) AS n FROM avl_tree_nodes');
    line(`labels with more than one distinct node_data: ${labelsWithDistinctData} (distinct labels ${distinctLabels}, measured in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    expect(labelsWithDistinctData).toBe(0);
    const versionsBefore = (raw.prepare('SELECT version, height FROM avl_tree_versions ORDER BY height').all() as
      Array<{ version: Buffer; height: number }>).map(r => ({ version: new Uint8Array(r.version), height: r.height }));
    raw.close();

    // --- the conversion: initDb on the copy ---------------------------------
    const { initDb, getDb, closeDb } = await import('../../src/store/db.js');
    const t1 = Date.now();
    initDb(dbPath);
    const initSeconds = (Date.now() - t1) / 1000;
    const db = getDb();
    line(`initDb (conversion + VACUUM + the other migrations) wall seconds: ${initSeconds.toFixed(1)}`);

    const colsAfter = (db.pragma('table_info(avl_tree_nodes)') as Array<{ name: string }>).map(c => c.name);
    expect(colsAfter).toEqual(['label', 'node_data', 'first_seen_height', 'orphaned_at_height']);
    const rowsAfter = count(db, 'SELECT COUNT(*) AS n FROM avl_tree_nodes');
    const liveRows = count(db, 'SELECT COUNT(*) AS n FROM avl_tree_nodes WHERE orphaned_at_height IS NULL');
    line(`avl_tree_nodes rows after: ${rowsAfter} (live ${liveRows}, orphaned ${rowsAfter - liveRows})`);
    expect(rowsAfter).toBe(distinctLabels);
    const versionsAfter = (db.prepare('SELECT version, height FROM avl_tree_versions ORDER BY height').all() as
      Array<{ version: Buffer; height: number }>).map(r => ({ version: new Uint8Array(r.version), height: r.height }));
    expect(versionsAfter.map(v => Buffer.from(v.version).toString('hex'))).toEqual(
      versionsBefore.map(v => Buffer.from(v.version).toString('hex')),
    );

    // (vii) new rows per version after: rows first seen at each height above the oldest.
    const perHeight = db.prepare(
      'SELECT AVG(n) AS avg, MIN(n) AS min, MAX(n) AS max FROM (SELECT COUNT(*) AS n FROM avl_tree_nodes WHERE first_seen_height > ? GROUP BY first_seen_height)',
    ).get(span.lo) as { avg: number; min: number; max: number };
    const heightsWithRows = count(db, 'SELECT COUNT(DISTINCT first_seen_height) AS n FROM avl_tree_nodes WHERE first_seen_height > ?', span.lo);
    line(`new rows per version after (heights above ${span.lo}): avg ${perHeight.avg.toFixed(1)}, min ${perHeight.min}, max ${perHeight.max}, over ${heightsWithRows} heights`);
    line(`rows first seen at ${span.lo} (the oldest retained tree): ${count(db, 'SELECT COUNT(*) AS n FROM avl_tree_nodes WHERE first_seen_height = ?', span.lo)}`);

    // (iv) the tip resolves to its recorded root.
    const storage = new SqliteAvlStorage(db, { keyLength: config.avlKeyLength, valueLengthOpt: null });
    const tip = storage.version()!;
    expect(storage.versionHeight(tip)).toBe(span.hi);
    const t2 = Date.now();
    const [tipRoot, tipHeight] = storage.rollback(tip);
    const tipMs = Date.now() - t2;
    expect(Buffer.from(label(tipRoot))).toEqual(Buffer.from(tip.slice(0, 32)));
    expect(tipHeight).toBe(tip[32]);
    const tipNodes = treeNodeCount(tipRoot);
    line(`tip ${span.hi}: rollback ${tipMs}ms, tree nodes ${tipNodes}, tree height ${tipHeight}`);
    expect(liveRows).toBe(tipNodes);

    // (v) twenty versions across the window, both endpoints included.
    const heights = new Set<number>([span.lo, span.hi]);
    for (let i = 1; i < SAMPLES - 1; i++) {
      heights.add(span.lo + Math.round((i * (span.hi - span.lo)) / (SAMPLES - 1)));
    }
    let resolved = 0;
    for (const h of [...heights].sort((a, b) => a - b)) {
      const v = storage.versionAtOrBeforeHeight(h)!;
      expect(storage.versionHeight(v)).toBe(h);
      const [root, treeHeight] = storage.rollback(v);
      expect(Buffer.from(label(root))).toEqual(Buffer.from(v.slice(0, 32)));
      const reader = new BatchAVLProver(config.avlKeyLength, null);
      reader.restoreRoot(root, treeHeight);
      expect(reader.digest()).toEqual(v);
      resolved++;
    }
    line(`sampled versions resolved to their recorded root: ${resolved} of ${heights.size} (heights ${[...heights].sort((a, b) => a - b).join(', ')})`);
    expect(resolved).toBe(SAMPLES);

    // (vi) the probe height.
    const probe = storage.versionAtOrBeforeHeight(PROBE_HEIGHT)!;
    expect(probe).not.toBeNull();
    const [probeRoot] = storage.rollback(probe);
    expect(Buffer.from(label(probeRoot))).toEqual(Buffer.from(probe.slice(0, 32)));
    line(`versionAtOrBeforeHeight(${PROBE_HEIGHT}) -> height ${storage.versionHeight(probe)}, resolves`);

    closeDb();
    const bytesAfter = fs.statSync(dbPath).size;
    line(`file bytes after: ${bytesAfter}`);
    console.log(`SNAPSHOT REPORT\n${report.join('\n')}`);
  }, { timeout: 4 * 60 * 60_000 });
});
