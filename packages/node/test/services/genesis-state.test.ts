import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { hexToBuf, profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import { makeTestConfig, mineNextBlock } from '../helpers.js';

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

/**
 * The faucet identity the running profile names, as raw bytes.
 *
 * ⛔ **Read off the profile, which is its single home.** The node holds no
 * secret to go with it, and a fixture carrying its own copy would be a second
 * source free to disagree with the one `genesisStateRoot` is pinned against.
 */
function faucetPubKey(network = 'devnet'): Uint8Array {
  const hex = profileFor(network as NetworkType).faucetPublicKey;
  if (hex === undefined) throw new Error(`${network} names no faucet identity`);
  return new Uint8Array(hexToBuf(hex));
}

function rootOf(s: Store): string {
  const digest = s.prover.getAvlProver().prover.digest();
  if (!digest) throw new Error('prover digest is null');
  return Buffer.from(digest).toString('hex');
}

/**
 * Boot a fresh store the way `index.ts` does, and return its height-0 root.
 *
 * The handle belongs to the caller on the way out and to this function on the
 * way down: seeding is a path that refuses, and a helper that only closes when
 * nothing went wrong leaks exactly the databases whose failures these tests are
 * about.
 */
async function seededRoot(dbPath: string): Promise<{ root: string; s: Store }> {
  const s = await importFresh();
  s.initDb(dbPath);
  try {
    s.prover.createAvlProver();
    s.genesis.seedGenesisState();
    return { root: rootOf(s), s };
  } catch (err) {
    s.closeDb();
    throw err;
  }
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
  let store: Store | null = null;
  try {
    const { root, s } = await seededRoot(':memory:');
    store = s;
    const boxTypes = s.utxo.getUnspentBoxes().map((b) => b.boxType).sort();
    const proof = s.utxo.getGenesisProofBox();
    if (!proof) throw new Error(`${network} seeded no genesis proof box`);
    const proofPayload = Buffer.from(proof.payload).toString('hex');
    return { root, boxTypes, proofPayload };
  } finally {
    // Beside the env restore, and for the same reason: the missing-proof-box
    // throw above is a path this helper is expected to take.
    store?.closeDb();
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
  try {
    s.prover.createAvlProver();
    // `rootOf` throws on a null digest, which is a real outcome for a prover
    // that failed to write its empty-tree version.
    return rootOf(s);
  } finally {
    s.closeDb();
  }
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

    const nr = s.records.getNetworkRecord();
    const networkPuts = [{ key: s.records.networkRecordKey(), network: nr }];

    const mirrorDb = new Database(':memory:');
    mirrorDb.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY, height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (
        label BLOB NOT NULL, node_data BLOB NOT NULL,
        first_seen_height INTEGER NOT NULL, orphaned_at_height INTEGER,
        PRIMARY KEY (label, first_seen_height));
    `);
    const mirror = s.prover.createAvlProver(mirrorDb);
    s.prover.bootstrapAvlProver(mirror, boxes, 0, records, networkPuts);
    expect(Buffer.from(mirror.prover.digest()!).toString('hex')).toBe(root);

    mirrorDb.close();
    s.closeDb();
  });

  it('the feed ORDER is not consensus-visible — a reversed feed reaches the same root', async () => {
    const { root, s } = await seededRoot(':memory:');
    const boxes = s.utxo.getUnspentBoxes();
    expect(boxes.length).toBeGreaterThan(1);
    const records = s.records.getAllIdentityRecords().map((r) => ({
      key: s.records.identityRecordKey(r.identityId),
      record: r.record,
    }));
    const nr = s.records.getNetworkRecord();
    const networkPuts = [{ key: s.records.networkRecordKey(), network: nr }];

    const mirrorDb = new Database(':memory:');
    mirrorDb.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY, height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (
        label BLOB NOT NULL, node_data BLOB NOT NULL,
        first_seen_height INTEGER NOT NULL, orphaned_at_height INTEGER,
        PRIMARY KEY (label, first_seen_height));
    `);
    const mirror = s.prover.createAvlProver(mirrorDb);
    s.prover.bootstrapAvlProver(mirror, [...boxes].reverse(), 0, [...records].reverse(), networkPuts);
    expect(Buffer.from(mirror.prover.digest()!).toString('hex')).toBe(root);

    mirrorDb.close();
    s.closeDb();
  });

  it('is idempotent — a second call leaves the root untouched', async () => {
    const { root, s } = await seededRoot(':memory:');
    s.genesis.seedGenesisState();
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

  it('mainnet seeds the proof, emission and pool boxes; the faucet networks seed five', async () => {
    // Not a restatement of `isFaucetNetwork` — it pins which boxes are OUTSIDE
    // that gate. Inside it, mainnet would have no genesis state at all and no
    // network identity at height 0; the emission box being outside it is what
    // lets mainnet pay a coinbase, since emission is released from that box
    // rather than minted (TYPES_INTERFACE → EmissionBox); and the karma supply
    // pool being outside it is what lets mainnet mint karma at all, since every
    // mint draws from that box (TYPES_INTERFACE → KarmaPoolBox).
    //
    // ⛔ **No `treasury` row on any network.** It would hold 0, and a
    // zero-value successor is not created — the first block whose
    // `split.treasury` is nonzero creates it. ⚠ **`karma_pool` is on every row
    // and would be created at 0 too**, which is the same-shaped fact with the
    // opposite answer: emission terminates, the pool never does, because burns
    // must always have somewhere to return.
    expect((await underProfile('mainnet')).boxTypes)
      .toEqual(['emission', 'genesis_proof', 'karma_pool']);
    expect((await underProfile('testnet')).boxTypes)
      .toEqual(['credit', 'emission', 'genesis_proof', 'karma', 'karma_pool']);
    expect((await underProfile('devnet')).boxTypes)
      .toEqual(['credit', 'emission', 'genesis_proof', 'karma', 'karma_pool']);
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

  it('each profile seeds exactly the root it pins', async () => {
    // ⚠ **This is what makes the three pinned constants facts rather than
    // trusted values.** They were emitted by running the seeder once and pasted
    // into `packages/types/src/network.ts` by hand; the tests around them assert
    // only that the three are *distinct*, which a wrong-but-different value
    // satisfies. A boot-time check catches a bad pin when someone starts a node.
    // This catches it on every gate run, in the package that derives the root.
    for (const network of ['mainnet', 'testnet', 'devnet']) {
      const seeded = await underProfile(network);
      expect(seeded.root, network).toBe(profileFor(network as NetworkType).genesisStateRoot);
    }
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

/**
 * A store that holds blocks and has never committed a genesis state.
 *
 * That combination is what an upgrade leaves behind: blocks on disk, no
 * `genesis_committed` row, and a tree that grew past genesis without ever
 * holding the genesis leaves. It cannot be seeded — a height-0 version written
 * into a grown tree makes `versionAtOrBeforeHeight` resolve state that never
 * existed — and it cannot be run, because its state root differs from its
 * network's at every height.
 */
describe('seedGenesisState — a store that predates the genesis state', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  async function storeWithBlocksAndNoGenesisFlag(): Promise<{
    s: Store;
    bc: typeof import('../../src/services/block-creator.js');
  }> {
    const { s } = await seededRoot(':memory:');
    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(makeTestConfig({ dbPath: ':memory:', nodeRole: 'miner' as const }));

    // One block past genesis is the whole requirement, and coinbase-only is what
    // this fixture can build: a post's karma box seeded after `seededRoot` is
    // absent from the tree the genesis bootstrap already built, and seeding it
    // before would put it in the genesis feed and move the pinned root.
    expect(await mineNextBlock(bc)).not.toBeNull();

    // Erase the flag, which leaves exactly the store an upgrade produces: the
    // seeder never ran here, and the boxes it would have written are absent from
    // both the UTXO set and the tree.
    s.getDb().prepare('DELETE FROM system_config WHERE key = ?').run('genesis_committed');
    expect(s.genesis.isGenesisCommitted()).toBe(false);
    return { s, bc };
  }

  it('refuses to start, naming the cause and the remedy rather than two digests', async () => {
    const { s, bc } = await storeWithBlocksAndNoGenesisFlag();
    try {
      let message = '';
      try { s.genesis.seedGenesisState(); } catch (err) { message = String(err); }

      expect(message).toMatch(/no committed genesis state/i);
      expect(message).toMatch(/refusing to start/i);
      // The operator has exactly one remedy and the message has to carry it —
      // the chain and the AVL store share a SQLite file and go together.
      expect(message).toMatch(/resync/i);
    } finally {
      bc.stopBlockCreator();
      s.closeDb();
    }
  });

  it('does not record the flag on the way out', async () => {
    // ⚠ **The half that made the silence permanent.** Marking committed and
    // returning is not "skip seeding this once": the flag is what
    // `seedGenesisState` keys on, so every later start skips too — and skipping
    // is also what bypasses `assertGenesisRoot`, the one comparison that could
    // name the fault. A node in this state answers every inbound block with a
    // root mismatch and has nothing left that mentions genesis.
    const { s, bc } = await storeWithBlocksAndNoGenesisFlag();
    try {
      expect(() => s.genesis.seedGenesisState()).toThrow();
      expect(s.genesis.isGenesisCommitted()).toBe(false);

      // A restart re-refuses rather than proceeding on a genesis nobody holds.
      expect(() => s.genesis.seedGenesisState()).toThrow();
    } finally {
      bc.stopBlockCreator();
      s.closeDb();
    }
  });

  it('control: a store with blocks AND the flag is left alone', async () => {
    // The ordinary restart, and the reason the refusal keys on the flag rather
    // than on the height: a node that has ever applied a block does not re-seed,
    // and must not be refused for it.
    const { s } = await seededRoot(':memory:');
    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(makeTestConfig({ dbPath: ':memory:', nodeRole: 'miner' as const }));
    try {
      // One block past genesis, coinbase-only — the flag, not the body, is what
      // this control turns on.
      expect(await mineNextBlock(bc)).not.toBeNull();
      expect(() => s.genesis.seedGenesisState()).not.toThrow();
    } finally {
      bc.stopBlockCreator();
      s.closeDb();
    }
  });
});

/**
 * Genesis is the state of an EMPTY store, and the precondition is asserted
 * rather than discovered.
 *
 * A store holding boxes before genesis runs cannot reproduce its network's
 * pinned root, so it is refused either way — but the two refusals do not say
 * the same thing. Left to `assertGenesisRoot`, the message names the profile
 * pin, which reads as a bad pin or a wrong network; and because the rollback
 * restores exactly the state that caused it, every subsequent start repeats the
 * same wrong diagnosis on an unbootable node.
 */
describe('seedGenesisState — a store that is not empty', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('refuses a pre-existing credit box, naming the store rather than the pin', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    s.prover.createAvlProver();

    // A store that already holds one of the boxes genesis seeds.
    // `ensureFaucetCreditBox` returns `existing[0]` of a `value DESC` read, so a
    // feed built from its return value is a strict subset of the UTXO set — and
    // the refusal below is what keeps that subset from reaching the tree.
    s.system.ensureFaucetCreditBox(faucetPubKey(), 1);
    expect(s.utxo.getCreditBoxes(faucetPubKey()).length).toBeGreaterThan(0);

    let message = '';
    try { s.genesis.seedGenesisState(); } catch (err) { message = String(err); }

    expect(message).toMatch(/already holds/i);
    expect(message).toMatch(/refusing to start/i);
    expect(message).toMatch(/resync/i);
    // ⚠ The diagnosis this replaces. Naming the pinned root here would send an
    // operator to `network.ts` for a store problem.
    expect(message).not.toContain(profileFor('devnet').genesisStateRoot);
    s.closeDb();
  });

  it('refuses a karma box whose identity record is missing', async () => {
    // `ensureSystemKarmaBox` writes the identity record only on its CREATE
    // path, so the branch that hands back a pre-existing box is exactly the one
    // that cannot promise the record the tree needs. Two boxes and zero records
    // is a 3-leaf tree measured against a 4-leaf pin — an assertable
    // precondition, not a root mismatch to puzzle over.
    const s = await importFresh();
    s.initDb(':memory:');
    s.prover.createAvlProver();

    s.system.ensureSystemKarmaBox(faucetPubKey(), 1);
    s.records.deleteIdentityRecord(faucetPubKey());
    expect(s.records.getAllIdentityRecords()).toHaveLength(0);

    expect(() => s.genesis.seedGenesisState())
      .toThrow(/already holds/i);
    s.closeDb();
  });

  it('the tree covers the whole UTXO set, not what the seeders returned', async () => {
    // The property the store-derived feed buys. A mirror fed from the store
    // reaches the same root, so nothing the store holds is outside the tree —
    // which a per-helper feed can only achieve by each helper returning
    // everything it wrote.
    const { root, s } = await seededRoot(':memory:');
    const boxes = s.utxo.getUnspentBoxes();
    const records = s.records.getAllIdentityRecords().map((r) => ({
      key: s.records.identityRecordKey(r.identityId),
      record: r.record,
    }));
    // devnet (the pinned test profile): karma, credit, proof, emission, pool.
    expect(boxes.length).toBe(5);
    expect(records.length).toBe(1);

    const nr = s.records.getNetworkRecord();
    const networkPuts = [{ key: s.records.networkRecordKey(), network: nr }];

    const mirrorDb = new Database(':memory:');
    mirrorDb.exec(`
      CREATE TABLE avl_tree_versions (
        version BLOB PRIMARY KEY, height INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE avl_tree_nodes (
        label BLOB NOT NULL, node_data BLOB NOT NULL,
        first_seen_height INTEGER NOT NULL, orphaned_at_height INTEGER,
        PRIMARY KEY (label, first_seen_height));
    `);
    const mirror = s.prover.createAvlProver(mirrorDb);
    s.prover.bootstrapAvlProver(mirror, boxes, 0, records, networkPuts);
    expect(Buffer.from(mirror.prover.digest()!).toString('hex')).toBe(root);

    mirrorDb.close();
    s.closeDb();
  });
});

/**
 * The fail-stop on a divergent genesis (ARCHITECTURE → "How the network is
 * committed"). What it guards is not a local anomaly: a node whose height-0
 * state differs from its network's forks from every honest peer at height 1,
 * and every symptom of that surfaces later and somewhere else.
 */
describe('assertGenesisRoot', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('passes on the state the seeder just built', async () => {
    const { s } = await seededRoot(':memory:');
    expect(() => s.genesis.assertGenesisRoot()).not.toThrow();
    s.closeDb();
  });

  it('refuses an unseeded tree, naming both roots', async () => {
    const s = await importFresh();
    s.initDb(':memory:');
    s.prover.createAvlProver();

    // The empty tree, which is what every network's height-0 root was until the
    // seeded boxes reached the tree. The message has to carry both values —
    // "mismatch" alone leaves an operator with a refusing node and no way to
    // tell a bad pin from a bad store.
    let message = '';
    try { s.genesis.assertGenesisRoot(); } catch (err) { message = String(err); }
    expect(message).toMatch(/genesis state root mismatch/i);
    expect(message).toContain(profileFor('devnet').genesisStateRoot);
    expect(message).toContain(await emptyTreeRoot());
    s.closeDb();
  });

  it('a tree that has moved past genesis fails it — which is why it is not a boot check', async () => {
    // Measured, because the placement rests on it: `seedGenesisState` is keyed
    // on the committed flag, so a restarted node does not re-seed and its
    // prover loads the tree at whatever height it stopped at. Comparing *that*
    // against the genesis pin at boot would refuse every node that has ever
    // applied a block. The check belongs on the path that builds the state.
    const { root: genesisRoot, s } = await seededRoot(':memory:');

    const bc = await import('../../src/services/block-creator.js');
    bc.startBlockCreator(makeTestConfig({ dbPath: ':memory:', nodeRole: 'miner' as const }));
    try {
      // Coinbase-only still moves the tree off genesis — the block releases the
      // emission box and creates its coinbase — and it is what this fixture can
      // build without seeding a box the genesis tree never received.
      expect(await mineNextBlock(bc)).not.toBeNull();

      expect(rootOf(s)).not.toBe(genesisRoot);
      expect(() => s.genesis.assertGenesisRoot()).toThrow(/genesis state root mismatch/i);
    } finally {
      bc.stopBlockCreator();
      s.closeDb();
    }
  });

  it('a divergent genesis is refused AND rolled back — never committed', async () => {
    // The reason the assertion sits inside the seeding transaction. Committed
    // first and checked after, the refusal would fire exactly once: the next
    // start finds `genesis_committed` set, skips seeding, and runs on the
    // divergent state with nothing left to check it.
    vi.resetModules();
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js',
      );
      return {
        ...actual,
        config: {
          ...actual.config,
          profile: { ...actual.config.profile, genesisStateRoot: 'ab'.repeat(33) },
        },
      };
    });
    try {
      const s = await importFresh();
      s.initDb(':memory:');
      s.prover.createAvlProver();

      expect(() => s.genesis.seedGenesisState())
        .toThrow(/genesis state root mismatch/i);

      // Nothing survived the throw: no flag, no boxes. A restart re-attempts
      // and re-fails, rather than booting on a genesis nobody agreed to.
      expect(s.genesis.isGenesisCommitted()).toBe(false);
      expect(s.utxo.getUnspentBoxes()).toHaveLength(0);

      // ⚠ **And the tree went back with them.** `bootstrapAvlProver` ran a
      // `performOneOperation` per leaf against the module-global prover's
      // in-memory tree, and SQLite's rollback reaches every row but none of that
      // memory. Left mutated, the prover would hold the genesis tree over a
      // store holding no genesis — and since the flag is unset, the next attempt
      // would seed into a tree that is no longer empty.
      expect(rootOf(s)).toBe(await emptyTreeRoot());
      s.closeDb();
    } finally {
      vi.doUnmock('../../src/config.js');
      vi.resetModules();
    }
  });
});
