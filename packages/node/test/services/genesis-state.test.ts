import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';

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

/**
 * Boot a fresh store under a named profile and report what its genesis holds.
 *
 * ⚠ `vitest.config.ts` pins `NETWORK_TYPE: 'devnet'` in its `env` block, which
 * OVERRIDES the shell — an `NETWORK_TYPE=… vitest` prefix is silently ignored,
 * so in-test assignment plus `vi.resetModules()` is the only way to reach
 * another profile. The previous value is **restored, never deleted**: a bare
 * `delete` leaves every later file in this worker on whatever `loadConfig`
 * defaults to rather than on the pinned devnet.
 */
async function underProfile(
  network: string,
): Promise<{ root: string; boxTypes: string[]; proofPayload: string }> {
  const previous = process.env['NETWORK_TYPE'];
  process.env['NETWORK_TYPE'] = network;
  vi.resetModules();
  try {
    const { root, s } = await seededRoot(':memory:');
    const boxTypes = s.utxo.getUnspentBoxes().map((b) => b.boxType).sort();
    const proof = s.utxo.getGenesisProofBox();
    if (!proof) throw new Error(`${network} seeded no genesis proof box`);
    const proofPayload = Buffer.from(proof.payload).toString('hex');
    s.closeDb();
    return { root, boxTypes, proofPayload };
  } finally {
    if (previous === undefined) delete process.env['NETWORK_TYPE'];
    else process.env['NETWORK_TYPE'] = previous;
    vi.resetModules();
  }
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

  it('seeds the proof box on every network, carrying that profile payload', async () => {
    for (const network of ['mainnet', 'testnet', 'devnet']) {
      const seeded = await underProfile(network);
      expect(seeded.proofPayload, network).toBe(profileFor(network as NetworkType).genesisProofPayload);
    }
  });

  it('mainnet seeds the proof box alone; the faucet networks seed three', async () => {
    // Not a restatement of `isFaucetNetwork` — it pins that the proof box is
    // OUTSIDE that gate. Inside it, mainnet would have no genesis state at all
    // and no network identity at height 0.
    expect((await underProfile('mainnet')).boxTypes).toEqual(['genesis_proof']);
    expect((await underProfile('testnet')).boxTypes).toEqual(['credit', 'genesis_proof', 'karma']);
    expect((await underProfile('devnet')).boxTypes).toEqual(['credit', 'genesis_proof', 'karma']);
  });

  it('the three networks reach three distinct height-0 roots', async () => {
    // ⚠ **Roots, not payloads.** testnet and devnet share the hardcoded system
    // identity and both box values, so their karma and credit boxes are
    // byte-identical and carry the same ids. The proof box is the only thing
    // separating those two genesis states — a payload that never reached the
    // tree would leave them colliding silently, and a test over the profile
    // strings could not see it.
    const roots = [];
    for (const network of ['mainnet', 'testnet', 'devnet']) {
      roots.push((await underProfile(network)).root);
    }
    expect(new Set(roots).size).toBe(3);
    for (const root of roots) expect(root).toMatch(/^[0-9a-f]{66}$/);
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
