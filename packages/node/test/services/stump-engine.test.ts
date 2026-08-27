import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTxId,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { UtxoTransaction, PruneCommit } from '@dagsocial/types';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';

// ---------------------------------------------------------------------------
// Dynamic import helpers (vi.resetModules isolation)
// ---------------------------------------------------------------------------

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => import('better-sqlite3').Database;
    closeDb: () => void;
  };
}

async function importTopology() {
  return await import('../../src/store/topology.js');
}

async function importStore() {
  return await import('../../src/store/index.js');
}

async function importStumpEngine() {
  return await import('../../src/services/stump-engine.js');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

function makePruneCommit(rootPostHash: string): PruneCommit {
  return { rootPostHash };
}

function buildPruneTx(
  inputBoxId: string,
  ownerPub: Uint8Array,
  ownerPriv: KeyObject,
  prune: PruneCommit,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [inputBoxId],
    outputs: [{ boxType: 'karma' as const, value: 100n, createdAtBlock: 0, owner: ownerPub }],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    prune,
  };
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), ownerPriv);
  tx.signatures[Buffer.from(ownerPub).toString('hex')] = new Uint8Array(sig);
  return tx;
}

/**
 * Seed the ordering_blocks table at the given height so getCurrentHeight
 * returns it. A minimal row — only the height column matters for the read.
 */
function seedHeight(db: import('better-sqlite3').Database, height: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO ordering_blocks
       (height, header_bytes, utxotx_tree_bytes, validator_signature, created_at, block_hash, interlinks)
     VALUES (?, zeroblob(1), zeroblob(1), zeroblob(64), 0, ?, zeroblob(1))`,
  ).run(height, '0'.repeat(64));
}

/**
 * Seed a karma box so insertUtxoTx's pending-spend check can see its input.
 */
function seedKarmaBox(
  db: import('better-sqlite3').Database,
  id: string,
  owner: Uint8Array,
): void {
  db.prepare(
    `INSERT INTO utxo_boxes (id, box_type, value, created_at_block, owner, tx_id, output_index)
     VALUES (?, 'karma', 100, 0, ?, ?, 0)`,
  ).run(id, Buffer.from(owner), '0'.repeat(64));
}

async function buildDeps(): Promise<UtxoEngineDeps> {
  const store = await importStore();
  const dbMod = await importDb();
  return {
    getBox: store.getBoxWithPending,
    insertBox: store.insertBox,
    consumeBox: store.consumeBox,
    getKarmaBox: store.getKarmaBox,
    getKarmaValue: store.getKarmaValue,
    getIdentityRecord: store.getIdentityRecord,
    hasActiveVouchEscrow: store.hasActiveVouchEscrow,
    vouchCooldownBlocks: 0,
    inviteBondMin: 0n,
    inviteBondMax: 0n,
    decayCfg: { staleThresholdBlocks: 0, decayIntervalBlocks: 0, decayAmount: 0n, karmaMinimum: 0n },
    storageRentPeriodBlocks: 0,
    getBoxProvenance: store.getBoxProvenance,
    getTopologyAuthor: store.getTopologyAuthorBytes,
    runInTransaction: (fn: () => void) => dbMod.getDb().transaction(fn)(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ROOT_POST_ID = 'aa'.repeat(32);
const REPLY_POST_ID = 'bb'.repeat(32);
const KARMA_BOX_ID = 'ff'.repeat(32);

describe('stump-engine (prune transaction rail)', () => {
  let db: import('better-sqlite3').Database;
  let ownerPub: Uint8Array;
  let ownerPriv: KeyObject;
  const authorHex = () => Buffer.from(ownerPub).toString('hex');

  beforeEach(async () => {
    vi.resetModules();
    const dbMod = await importDb();
    dbMod.initDb(':memory:');
    db = dbMod.getDb();

    const kp = generateKeyPairSync('ed25519');
    ownerPub = rawPublicKey(kp.publicKey);
    ownerPriv = kp.privateKey;
  });

  afterEach(async () => {
    vi.resetModules();
  });

  it('accepts a well-formed prune transaction', async () => {
    const topology = await importTopology();
    topology.insertBlockTopology(ROOT_POST_ID, [], authorHex(), 1);
    topology.insertBlockTopology(REPLY_POST_ID, [ROOT_POST_ID], authorHex(), 1);
    seedHeight(db, 2);
    seedKarmaBox(db, KARMA_BOX_ID, ownerPub);

    const prune = makePruneCommit(ROOT_POST_ID);
    const tx = buildPruneTx(KARMA_BOX_ID, ownerPub, ownerPriv, prune);

    const deps = await buildDeps();
    const engine = await importStumpEngine();
    const result = engine.executePrune(deps, tx, 2);
    expect(result.txId).toBe(computeTxId(tx));
  });

  it('rejects a root not confirmed in an earlier block (pending post — the getSubtree→topology change)', async () => {
    seedHeight(db, 2);
    seedKarmaBox(db, KARMA_BOX_ID, ownerPub);

    db.prepare(
      `INSERT INTO dag_posts (id, content_hash, content, author, parent_refs, protocol_version, status)
       VALUES (?, ?, 'hello', ?, '[]', 1, 'pending')`,
    ).run(ROOT_POST_ID, '0'.repeat(64), Buffer.from(ownerPub));

    const prune = makePruneCommit(ROOT_POST_ID);
    const tx = buildPruneTx(KARMA_BOX_ID, ownerPub, ownerPriv, prune);

    const deps = await buildDeps();
    const engine = await importStumpEngine();
    expect(() => engine.executePrune(deps, tx, 2)).toThrow(/not confirmed in an earlier block/);
  });

  it('rejects a root confirmed at the current height (same-block, maturity bind)', async () => {
    const topology = await importTopology();
    topology.insertBlockTopology(ROOT_POST_ID, [], authorHex(), 2);
    seedHeight(db, 2);
    seedKarmaBox(db, KARMA_BOX_ID, ownerPub);

    const prune = makePruneCommit(ROOT_POST_ID);
    const tx = buildPruneTx(KARMA_BOX_ID, ownerPub, ownerPriv, prune);

    const deps = await buildDeps();
    const engine = await importStumpEngine();
    expect(() => engine.executePrune(deps, tx, 2)).toThrow(/not confirmed in an earlier block/);
  });
});
