import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * Genesis is **state, not a block**, and this suite pins the half of that claim
 * the tree has to carry: the boxes seeded at cold start reach the AVL+ tree, so
 * the height-0 root is a fact about the network rather than the empty-tree
 * digest every network would otherwise share.
 *
 * The property under test is a ROOT, not a row count. A test asserting "three
 * rows in `utxo_boxes`" passes on a store whose state root covers none of them,
 * which is exactly the state this suite exists to make impossible.
 */

async function importFresh() {
  const db = await import('../../src/store/db.js');
  const system = await import('../../src/store/system.js');
  const genesis = await import('../../src/services/genesis-state.js');
  const prover = await import('../../src/state/avl-prover.js');
  const records = await import('../../src/store/identity-records.js');
  const utxo = await import('../../src/store/utxo.js');
  return { ...db, system, genesis, prover, records, utxo };
}

type Store = Awaited<ReturnType<typeof importFresh>>;

function rootOf(s: Store): string {
  const digest = s.prover.getAvlProver().prover.digest();
  if (!digest) throw new Error('prover digest is null');
  return Buffer.from(digest).toString('hex');
}

/** Boot a fresh store the way `index.ts` does, and return its height-0 root. */
async function seededRoot(dbPath: string): Promise<{ root: string; s: Store }> {
  const s = await importFresh();
  s.initDb(dbPath);
  s.prover.createAvlProver();
  const keypair = s.system.initSystemKeypair();
  s.genesis.seedGenesisState(keypair.publicKey, 0);
  return { root: rootOf(s), s };
}

/** The digest of an untouched prover — no genesis, no blocks. */
async function emptyTreeRoot(): Promise<string> {
  vi.resetModules();
  const s = await importFresh();
  s.initDb(':memory:');
  s.prover.createAvlProver();
  const root = rootOf(s);
  s.closeDb();
  return root;
}

describe('seedGenesisState', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('commits the genesis boxes to the tree — the height-0 root is not the empty one', async () => {
    const empty = await emptyTreeRoot();
    vi.resetModules();
    const { root, s } = await seededRoot(':memory:');
    expect(root).not.toBe(empty);
    s.closeDb();
  });

  it('the digest is 33 bytes — a 32-byte root label plus the tree height', async () => {
    // Ergo's shape, and the reason a `/^[0-9a-f]{64}$/` pin on the profile field
    // would be wrong. `EMPTY_STATE_ROOT` in @dagsocial/types is hex(33) for the
    // same reason.
    const { root, s } = await seededRoot(':memory:');
    expect(root).toMatch(/^[0-9a-f]{66}$/);
    s.closeDb();
  });

  it('every seeded box and the system identity record is in the tree', async () => {
    // Built independently: a second prover fed exactly the boxes and the record
    // the store holds must reach the same root. A missing entry in either feed
    // shows up as a different digest, which a row count cannot see.
    const { root, s } = await seededRoot(':memory:');

    const boxes = s.utxo.getUnspentBoxes();
    const records = s.records.getAllIdentityRecords().map((r) => ({
      key: s.records.identityRecordKey(r.identityId),
      record: r.record,
    }));

    const mirrorDb = new Database(':memory:');
    // The AVL tables are created by `initDb`'s migrations, which this bare
    // handle has not run; the prover only needs its own two.
    mirrorDb.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY, height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (
        version BLOB NOT NULL REFERENCES avl_tree_versions(version),
        label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);
    const mirror = s.prover.createAvlProver(mirrorDb);
    s.prover.bootstrapAvlProver(mirror, boxes, 0, records);
    expect(Buffer.from(mirror.prover.digest()!).toString('hex')).toBe(root);

    mirrorDb.close();
    s.closeDb();
  });

  it('the feed ORDER is not consensus-visible — a reversed feed reaches the same root', async () => {
    // AVL+ shape is order-dependent, so the genesis root is only reproducible if
    // the order is specified rather than inherited from whatever sequence the
    // seeders happened to run in. The order is the canonical prover-feed order
    // (M-12): sorted by hex box id, inside `bootstrapAvlProver`. This is the
    // assertion that the caller's order cannot reach the tree.
    const { root, s } = await seededRoot(':memory:');
    const boxes = s.utxo.getUnspentBoxes();
    expect(boxes.length).toBeGreaterThan(1);
    const records = s.records.getAllIdentityRecords().map((r) => ({
      key: s.records.identityRecordKey(r.identityId),
      record: r.record,
    }));

    const mirrorDb = new Database(':memory:');
    mirrorDb.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY, height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (
        version BLOB NOT NULL REFERENCES avl_tree_versions(version),
        label BLOB NOT NULL, node_data BLOB NOT NULL, PRIMARY KEY (version, label));
    `);
    const mirror = s.prover.createAvlProver(mirrorDb);
    s.prover.bootstrapAvlProver(mirror, [...boxes].reverse(), 0, [...records].reverse());
    expect(Buffer.from(mirror.prover.digest()!).toString('hex')).toBe(root);

    mirrorDb.close();
    s.closeDb();
  });

  it('is idempotent — a second call leaves the root untouched', async () => {
    const { root, s } = await seededRoot(':memory:');
    const keypair = s.system.getSystemKeypair()!;
    s.genesis.seedGenesisState(keypair.publicKey, 0);
    expect(rootOf(s)).toBe(root);
    expect(s.genesis.isGenesisCommitted()).toBe(true);
    s.closeDb();
  });

  it('survives a restart — the reopened store loads the genesis tree, not the empty one', async () => {
    // The failure this catches is specific: the prover constructor writes the
    // EMPTY tree's version at height 0, and `version()` breaks a height tie
    // arbitrarily. Two height-0 versions would let a restart load the empty tree
    // back over the genesis one, with the boxes still in `utxo_boxes` — a store
    // whose state root does not cover its own UTXO set.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dagsocial-genesis-'));
    const dbPath = path.join(dir, 'restart.db');
    try {
      const first = await seededRoot(dbPath);
      first.s.closeDb();

      vi.resetModules();
      const reopened = await importFresh();
      reopened.initDb(dbPath);
      reopened.prover.createAvlProver();
      expect(rootOf(reopened)).toBe(first.root);
      expect(reopened.genesis.isGenesisCommitted()).toBe(true);
      reopened.closeDb();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
