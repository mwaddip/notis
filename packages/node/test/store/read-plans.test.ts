// MEMPOOL_INTERFACE → Schema → "An entry's inputs and outputs are rows keyed
// by box id"; MEMPOOL_INTERFACE → getBoxWithPending → "Three point reads";
// NODE_INTERFACE → Store Interface → "A page read touches limit + 1 entries
// of one index that serves both its predicate and its order";
// NODE_INTERFACE → Store Interface → "A read the node runs per request or
// per block touches what it answers".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  computeBoxId,
  canonicalBoxBytes,
  u32BE,
  type VouchBox,
  type CreditBox,
} from '@dagsocial/types';

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/** Record every SQL text `fn()` prepares on `db`. */
function recordPrepared<T>(
  db: Database.Database,
  fn: () => T,
): { result: T; sqls: string[] } {
  const sqls: string[] = [];
  // better-sqlite3's `prepare` is a prototype method; the instance has no
  // own binding, so a direct assignment shadows it for the span of the call.
  const original = db.prepare.bind(db) as (sql: string) => ReturnType<Database.Database['prepare']>;
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    writable: true,
    value: function (sql: string) {
      sqls.push(sql);
      return original(sql);
    },
  });
  try {
    return { result: fn(), sqls };
  } finally {
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
}

/** EXPLAIN QUERY PLAN each recorded text, bind every `?` with an empty string. */
function planOf(db: Database.Database, sql: string): string {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  const binds = Array.from({ length: placeholders }, () => '');
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

const OWNER_HEX = 'cc'.repeat(32);
const POOLED_INPUT = 'dd'.repeat(32);
const ABSENT_ID = 'ff'.repeat(32);

/** A karma transaction the pool holds: one signature, one karma output of its owner. */
function karmaTx() {
  return {
    inputs: [POOLED_INPUT],
    outputs: [
      { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: bytes(OWNER_HEX) },
    ],
    signatures: { [OWNER_HEX]: new Uint8Array(64) },
    protocolVersion: 1,
  };
}

/**
 * Set the pool up in `dbFile`, pool one karma transaction, and return the
 * id of the one output it would create — `materializeOutput`'s id, the
 * derivation the insert uses.
 */
async function setUpPool(dbFile: string): Promise<string> {
  vi.resetModules();
  const dbMod = await importDbFresh();
  dbMod.initDb(dbFile);
  const mem = await import('../../src/store/mempool.js');
  const { computeTxId } = await import('@dagsocial/types');
  const { materializeOutput } = await import('@dagsocial/consensus');
  const tx = karmaTx();
  mem.insertUtxoTx(tx as never, 100);
  const txId = computeTxId(tx as never);
  const output = materializeOutput(tx.outputs[0] as never, txId, 0);
  dbMod.closeDb();
  return output.id!;
}

/**
 * Record `fn`'s prepared statements on a handle freshly opened against
 * `dbFile`. Each read is recorded on a handle opened for it, so a
 * statement compiled earlier on another handle cannot hide that read's
 * statement from the recorder.
 */
async function recordReadOn<T>(
  dbFile: string,
  fn: (mem: typeof import('../../src/store/mempool.js')) => T,
): Promise<{ result: T; sqls: string[]; db: Database.Database }> {
  vi.resetModules();
  const dbMod = await importDbFresh();
  dbMod.initDb(dbFile);
  const mem = await import('../../src/store/mempool.js');
  const db = dbMod.getDb();
  const run = recordPrepared(db, () => fn(mem));
  return { result: run.result, sqls: run.sqls, db };
}

/**
 * Open a handle freshly against `dbFile`, load the given store modules, and
 * record every SQL text `fn` prepares — the same recorder shape as
 * `recordReadOn`, but handing the caller whichever store module its read
 * sits in. Each read is recorded on a handle opened for it; a statement
 * compiled on another handle cannot hide that read's statement from the
 * recorder.
 */
async function recordStoreRead<T, Mods>(
  dbFile: string,
  load: () => Promise<Mods>,
  fn: (m: Mods) => T,
): Promise<{ result: T; sqls: string[]; db: Database.Database }> {
  vi.resetModules();
  const dbMod = await importDbFresh();
  dbMod.initDb(dbFile);
  const mods = await load();
  const db = dbMod.getDb();
  const run = recordPrepared(db, () => fn(mods));
  return { result: run.result, sqls: run.sqls, db };
}

/** Seed a candidate box, derive its id, and insert through `insertBox`. */
async function seedThroughStore(dbFile: string, boxes: Record<string, unknown>[]): Promise<void> {
  vi.resetModules();
  const dbMod = await importDbFresh();
  dbMod.initDb(dbFile);
  const utxo = await import('../../src/store/utxo.js');
  const FIXTURE_TX_DOMAIN = new TextEncoder().encode('dagsocial/test-fixture-tx/1');
  let nonce = 0;
  for (const candidate of boxes) {
    const txIdHex = createHash('blake2b512')
      .update(FIXTURE_TX_DOMAIN)
      .update(canonicalBoxBytes(candidate as never))
      .update(u32BE(1))
      .update(u32BE(nonce++))
      .digest()
      .subarray(0, 32)
      .toString('hex');
    const withProv = { ...candidate, txId: txIdHex, index: 0 };
    const id = computeBoxId(withProv as never);
    utxo.insertBox({ ...withProv, id } as never);
  }
  dbMod.closeDb();
}

describe('each pending read\'s prepared statement runs through indexes', () => {
  let tmpDir: string;
  let dbFile: string;
  let pooledOutput: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-read-plans-'));
    dbFile = path.join(tmpDir, 'pool.db');
    pooledOutput = await setUpPool(dbFile);
  });

  afterEach(async () => {
    const dbMod = await importDbFresh();
    dbMod.closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hasPendingSpend reads a SEARCH on mempool_inputs by box_id', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.hasPendingSpend([POOLED_INPUT, ABSENT_ID]),
    );

    expect(result).toBe(POOLED_INPUT);
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b[^|]*\bbox_id\b/i.test(p))).toBe(true);
  });

  it('getBoxWithPending on a pooled output reads a SEARCH on mempool_outputs', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.getBoxWithPending(pooledOutput),
    );

    expect(result).not.toBeNull();
    expect((result as { id?: string }).id).toBe(pooledOutput);
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_outputs\b/i.test(p))).toBe(true);
  });

  it('getBoxWithPending on an absent id searches inputs and outputs, scans neither mempool nor json_each', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.getBoxWithPending(ABSENT_ID),
    );

    expect(result).toBeNull();
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_outputs\b/i.test(p))).toBe(true);
  });

  it('getOwnKarmaBoxIdsWithPending\'s spends read a SEARCH on mempool_inputs', async () => {
    const { result, sqls, db } = await recordReadOn(dbFile, (mem) =>
      mem.getOwnKarmaBoxIdsWithPending(OWNER_HEX),
    );

    // The owner's pooled karma output is `pooledOutput`; nothing spends it,
    // so it stays in the kept set.
    expect(result).toContain(pooledOutput);
    expect(sqls.length).toBeGreaterThan(0);

    const plans = sqls.map((sql) => planOf(db, sql));
    expect(plans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?mempool(?!_)/i.test(p))).toBe(true);
    expect(plans.every((p) => !/json_each/i.test(p))).toBe(true);
    expect(plans.some((p) => /\bSEARCH\b[^|]*\bmempool_inputs\b/i.test(p))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NODE_INTERFACE → Store Interface → "A read the node runs per request or per
// block touches what it answers": the voucher's vouch page, the escrow page
// and its probes, the ownerless singletons, the rent selection, the
// placeholder reads and the `best_chain` prunes/mark delete.
// ---------------------------------------------------------------------------

describe('the voucher, escrow, singleton, rent, placeholder and best_chain reads explained', () => {
  let tmpDir: string;
  let dbFile: string;
  const voucher = bytes('11'.repeat(32));
  const otherVoucher = bytes('22'.repeat(32));
  const owner = bytes('44'.repeat(32));

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-read-plans-'));
    dbFile = path.join(tmpDir, 'store.db');
  });

  afterEach(async () => {
    const dbMod = await importDbFresh();
    dbMod.closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the voucher\'s vouch page, with and without after, and its count — on idx_utxo_boxes_vouch_voucher', async () => {
    const voucherHex = Buffer.from(voucher).toString('hex');
    const t1 = bytes('aa'.repeat(32));
    const t2 = bytes('bb'.repeat(32));
    const t3 = bytes('cc'.repeat(32));
    const vouches = [
      { boxType: 'vouch' as const, value: 1n, createdAtBlock: 0, voucherId: voucher, targetId: t1 },
      { boxType: 'vouch' as const, value: 1n, createdAtBlock: 0, voucherId: voucher, targetId: t2 },
      { boxType: 'vouch' as const, value: 1n, createdAtBlock: 0, voucherId: voucher, targetId: t3 },
      { boxType: 'vouch' as const, value: 1n, createdAtBlock: 0, voucherId: otherVoucher, targetId: t1 },
    ];
    await seedThroughStore(dbFile, vouches);

    // No-`after`.
    const noAfter = await recordStoreRead(
      dbFile,
      async () => ({ vq: await import('../../src/store/vouch-queries.js') }),
      ({ vq }) => vq.getVouchesForVoucherPage(voucher, { limit: 10 }),
    );
    expect(noAfter.result.rows.map((r: VouchBox) => Buffer.from(r.voucherId).toString('hex'))).toEqual([voucherHex, voucherHex, voucherHex]);
    expect(noAfter.result.count).toBe(3);
    expect(noAfter.sqls.length).toBeGreaterThan(0);

    // With `after`.
    const firstId = noAfter.result.rows[0]!.id!;
    const withAfter = await recordStoreRead(
      dbFile,
      async () => ({ vq: await import('../../src/store/vouch-queries.js') }),
      ({ vq }) => vq.getVouchesForVoucherPage(voucher, { limit: 10, after: firstId }),
    );
    expect(withAfter.result.count).toBe(3);
    expect(withAfter.sqls.length).toBeGreaterThan(0);

    const allPlans = [
      ...noAfter.sqls.map((s) => planOf(noAfter.db, s)),
      ...withAfter.sqls.map((s) => planOf(withAfter.db, s)),
    ];
    expect(allPlans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?utxo_boxes\b/i.test(p))).toBe(true);
    expect(allPlans.every((p) => /idx_utxo_boxes_vouch_voucher/i.test(p))).toBe(true);
  });

  it('the escrow page with and without after, its count, getVouchEscrowsFor and hasActiveVouchEscrow — on idx_utxo_boxes_escrow_owner', async () => {
    const escrows = [
      { boxType: 'vouch_escrow' as const, value: 1n, createdAtBlock: 0, owner: voucher, releaseAtBlock: 10 },
      { boxType: 'vouch_escrow' as const, value: 2n, createdAtBlock: 0, owner: voucher, releaseAtBlock: 11 },
      { boxType: 'vouch_escrow' as const, value: 3n, createdAtBlock: 0, owner: voucher, releaseAtBlock: 12 },
      { boxType: 'vouch_escrow' as const, value: 1n, createdAtBlock: 0, owner: otherVoucher, releaseAtBlock: 10 },
    ];
    await seedThroughStore(dbFile, escrows);

    const page = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getVouchEscrowsForPage(voucher, { limit: 2 }),
    );
    expect(page.result.rows.length).toBe(2);
    expect(page.result.count).toBe(3);
    expect(page.sqls.length).toBeGreaterThan(0);

    const nextId = page.result.rows[0]!.id!;
    const pageWithAfter = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getVouchEscrowsForPage(voucher, { limit: 2, after: nextId }),
    );
    expect(pageWithAfter.sqls.length).toBeGreaterThan(0);

    const forAll = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getVouchEscrowsFor(voucher),
    );
    expect(forAll.result.length).toBe(3);
    expect(forAll.sqls.length).toBeGreaterThan(0);

    const probe = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.hasActiveVouchEscrow(voucher),
    );
    expect(probe.result).toBe(true);
    expect(probe.sqls.length).toBeGreaterThan(0);

    const allPlans = [
      ...page.sqls.map((s) => planOf(page.db, s)),
      ...pageWithAfter.sqls.map((s) => planOf(pageWithAfter.db, s)),
      ...forAll.sqls.map((s) => planOf(forAll.db, s)),
      ...probe.sqls.map((s) => planOf(probe.db, s)),
    ];
    expect(allPlans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?utxo_boxes\b/i.test(p))).toBe(true);
    expect(allPlans.every((p) => /idx_utxo_boxes_escrow_owner/i.test(p))).toBe(true);
  });

  it('the five ownerless singletons — SEARCH on idx_utxo_boxes_owner_type_value', async () => {
    // One singleton of each ownerless type.
    const singletons = [
      { boxType: 'genesis_proof' as const, value: 0n, createdAtBlock: 0, payload: new Uint8Array([1, 2, 3]) },
      { boxType: 'emission' as const, value: 100n, createdAtBlock: 0 },
      { boxType: 'treasury' as const, value: 50n, createdAtBlock: 0 },
      { boxType: 'karma_pool' as const, value: 10n, createdAtBlock: 0 },
      { boxType: 'backer_pool' as const, value: 20n, createdAtBlock: 0, staked: 0n, accrual: 0n },
    ];
    await seedThroughStore(dbFile, singletons);

    const genesis = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getGenesisProofBox(),
    );
    expect(genesis.result).not.toBeNull();
    expect(genesis.sqls.length).toBeGreaterThan(0);

    const emission = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getEmissionBox(),
    );
    expect(emission.result).not.toBeNull();
    expect(emission.sqls.length).toBeGreaterThan(0);

    const treasury = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getTreasuryBox(),
    );
    expect(treasury.result).not.toBeNull();
    expect(treasury.sqls.length).toBeGreaterThan(0);

    const karmaPool = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getKarmaPoolBox(),
    );
    expect(karmaPool.result).not.toBeNull();
    expect(karmaPool.sqls.length).toBeGreaterThan(0);

    const backerPool = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getBackerPoolBox(),
    );
    expect(backerPool.result).not.toBeNull();
    expect(backerPool.sqls.length).toBeGreaterThan(0);

    const allPlans = [
      ...genesis.sqls.map((s) => planOf(genesis.db, s)),
      ...emission.sqls.map((s) => planOf(emission.db, s)),
      ...treasury.sqls.map((s) => planOf(treasury.db, s)),
      ...karmaPool.sqls.map((s) => planOf(karmaPool.db, s)),
      ...backerPool.sqls.map((s) => planOf(backerPool.db, s)),
    ];
    expect(allPlans.every((p) => /\bSEARCH\b[^|]*\bidx_utxo_boxes_owner_type_value\b/i.test(p))).toBe(true);
  });

  it('getRentEligibleCreditBoxes — idx_utxo_boxes_credit_created, no USE TEMP B-TREE', async () => {
    const credits = [
      { boxType: 'credit' as const, value: 10n, createdAtBlock: 1, owner },
      { boxType: 'credit' as const, value: 20n, createdAtBlock: 2, owner },
      { boxType: 'credit' as const, value: 30n, createdAtBlock: 3, owner },
    ];
    await seedThroughStore(dbFile, credits);

    const read = await recordStoreRead(
      dbFile,
      async () => ({ utxo: await import('../../src/store/utxo.js') }),
      ({ utxo }) => utxo.getRentEligibleCreditBoxes(100, 10, 64),
    );
    const rentRows = read.result as Array<{ box: CreditBox; txId: string; index: number }>;
    expect(rentRows.length).toBe(3);
    expect(read.sqls.length).toBeGreaterThan(0);

    const plans = read.sqls.map((s) => planOf(read.db, s));
    expect(plans.every((p) => /idx_utxo_boxes_credit_created/i.test(p))).toBe(true);
    expect(plans.every((p) => !/USE TEMP B-TREE/i.test(p))).toBe(true);
  });

  it('getPlaceholdersAt and getMissingBodies — SEARCH on idx_dag_posts_placeholder, no USE TEMP B-TREE', async () => {
    // Seed one placeholder row (content NULL) at block height 5.
    vi.resetModules();
    const dbMod = await importDbFresh();
    dbMod.initDb(dbFile);
    const db = dbMod.getDb();
    db.prepare(
      `INSERT INTO dag_posts (id, tx_id, content_hash, content, author, parent_refs,
         protocol_version, type, status, block_height, block_index)
       VALUES (?, ?, ?, NULL, ?, '[]', 1, 'regular', 'confirmed', 5, 0)`,
    ).run('aa'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32), Buffer.alloc(32));
    dbMod.closeDb();

    const atHeight = await recordStoreRead(
      dbFile,
      async () => ({ posts: await import('../../src/store/posts.js') }),
      ({ posts }) => posts.getPlaceholdersAt(5),
    );
    expect(atHeight.result.length).toBe(1);
    expect(atHeight.sqls.length).toBeGreaterThan(0);

    const missing = await recordStoreRead(
      dbFile,
      async () => ({ posts: await import('../../src/store/posts.js') }),
      ({ posts }) => posts.getMissingBodies(),
    );
    expect(missing.result.length).toBe(1);
    expect(missing.sqls.length).toBeGreaterThan(0);

    const atPlans = atHeight.sqls.map((s) => planOf(atHeight.db, s));
    const missPlans = missing.sqls.map((s) => planOf(missing.db, s));
    expect(atPlans.some((p) => /\bSEARCH\b[^|]*\bidx_dag_posts_placeholder\b/i.test(p))).toBe(true);
    expect(missPlans.every((p) => /idx_dag_posts_placeholder/i.test(p))).toBe(true);
    expect(missPlans.every((p) => !/USE TEMP B-TREE/i.test(p))).toBe(true);
  });

  it('pruneHeadersBelow and removeHeaderSubtree\'s best_chain delete — no SCAN best_chain, uses idx_best_chain_hash', async () => {
    // Seed one applied header, one `best_chain` entry, and one `staged_blocks`
    // row below the floor.
    vi.resetModules();
    const dbMod = await importDbFresh();
    dbMod.initDb(dbFile);
    const db = dbMod.getDb();
    db.prepare(
      `INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
    ).run('aa'.repeat(32), 'bb'.repeat(32), Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(40));
    db.prepare('INSERT INTO best_chain (height, hash) VALUES (1, ?)').run('aa'.repeat(32));
    db.prepare(
      `INSERT INTO staged_blocks (hash, height, block_bytes, from_peer)
       VALUES (?, 1, ?, 'p1')`,
    ).run('cc'.repeat(32), Buffer.alloc(0));
    db.prepare(
      `INSERT INTO block_headers (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a)
       VALUES (?, 1, ?, ?, ?, ?, 0)`,
    ).run('cc'.repeat(32), 'bb'.repeat(32), Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(40));
    dbMod.closeDb();

    const prune = await recordStoreRead(
      dbFile,
      async () => ({ ht: await import('../../src/store/header-tree.js') }),
      ({ ht }) => ht.pruneHeadersBelow(100),
    );
    expect(prune.sqls.length).toBeGreaterThan(0);

    const subtree = await recordStoreRead(
      dbFile,
      async () => ({ ht: await import('../../src/store/header-tree.js') }),
      ({ ht }) => ht.removeHeaderSubtree('aa'.repeat(32)),
    );
    expect(subtree.sqls.length).toBeGreaterThan(0);

    // Only statements that touch `best_chain` or `staged_blocks` or
    // `block_headers` and name `IN (SELECT hash FROM best_chain)` or
    // `IN (SELECT hash FROM sub)` carry the plans the index serves. The two
    // prune statements and the subtree's `DELETE FROM best_chain` are the
    // three the brief names.
    const prunePlans = prune.sqls.map((s) => planOf(prune.db, s));
    expect(prunePlans.every((p) => !/\bSCAN\s+(?:TABLE\s+)?best_chain\b/i.test(p))).toBe(true);
    expect(prunePlans.some((p) => /\bidx_best_chain_hash\b/i.test(p))).toBe(true);

    const bestChainDeletes = subtree.sqls
      .filter((s) => /DELETE FROM best_chain WHERE hash IN/i.test(s))
      .map((s) => planOf(subtree.db, s));
    expect(bestChainDeletes.length).toBeGreaterThan(0);
    expect(bestChainDeletes.every((p) => !/\bSCAN\s+(?:TABLE\s+)?best_chain\b/i.test(p))).toBe(true);
    expect(bestChainDeletes.every((p) => /\bidx_best_chain_hash\b/i.test(p))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guards — the escrow page's route end-to-end, and /status's sums held to
// the owner index.
// ---------------------------------------------------------------------------

describe('the escrow page answers through its route', () => {
  let tmpDir: string;
  let dbFile: string;
  const voucher = bytes('11'.repeat(32));
  const otherVoucher = bytes('22'.repeat(32));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-read-plans-'));
    dbFile = path.join(tmpDir, 'store.db');
  });

  afterEach(async () => {
    const dbMod = await importDbFresh();
    dbMod.closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fetchJson(port: number, pathAndQuery: string): Promise<{ status: number; data: Record<string, unknown> }> {
    return new Promise((resolve) => {
      http.get({ hostname: '127.0.0.1', port, path: pathAndQuery }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) as Record<string, unknown> });
        });
      });
    });
  }

  it('GET /vouches?voucher=X&cooldowns=1 pages the voucher\'s escrows in ascending box id', async () => {
    // Three escrows this voucher holds, plus one of another voucher's.
    const escrows = [
      { boxType: 'vouch_escrow' as const, value: 1n, createdAtBlock: 0, owner: voucher, releaseAtBlock: 10 },
      { boxType: 'vouch_escrow' as const, value: 2n, createdAtBlock: 0, owner: voucher, releaseAtBlock: 11 },
      { boxType: 'vouch_escrow' as const, value: 3n, createdAtBlock: 0, owner: voucher, releaseAtBlock: 12 },
      { boxType: 'vouch_escrow' as const, value: 1n, createdAtBlock: 0, owner: otherVoucher, releaseAtBlock: 10 },
    ];
    await seedThroughStore(dbFile, escrows);

    vi.resetModules();
    const dbMod = await importDbFresh();
    dbMod.initDb(dbFile);
    const { createRouter } = await import('../../src/routes/vouches.js');
    const { castVouch, initiateUnvouch } = await import('../../src/services/vouch.js');
    const {
      hasActiveVouchEscrow, getUsernameByOwner,
    } = await import('../../src/store/index.js');
    const { config } = await import('../../src/config.js');

    const deps = {
      getBox: () => null,
      insertBox: () => {},
      consumeBox: () => {},
      getKarmaOwed: () => 0n,
      getKarmaValue: () => 0n,
      getOwnKarmaBoxIds: () => [],
      getIdentityRecord: () => null,
      hasActiveVouchEscrow,
      vouchCooldownBlocks: config.vouchCooldownBlocks,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: 0,
        decayIntervalBlocks: 0,
        decayAmount: 0n,
        karmaMinimum: 0n,
      },
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => fn(),
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner,
      castVouch,
      initiateUnvouch,
      getCurrentHeight: () => 100,
    };

    const app = express();
    app.use(express.json());
    app.use(createRouter(deps as never));
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const voucherHex = Buffer.from(voucher).toString('hex');
      const first = await fetchJson(addr.port, `/?voucher=${voucherHex}&cooldowns=1&limit=2`);
      expect(first.status).toBe(200);
      const firstBody = first.data as { cooldowns: Array<{ boxId: string }>; count: number; next: string | null };
      expect(firstBody.count).toBe(3);
      expect(firstBody.cooldowns.length).toBe(2);
      // Ascending box id.
      expect(firstBody.cooldowns[0]!.boxId < firstBody.cooldowns[1]!.boxId).toBe(true);
      expect(firstBody.next).toBe(firstBody.cooldowns[1]!.boxId);

      const second = await fetchJson(
        addr.port,
        `/?voucher=${voucherHex}&cooldowns=1&limit=2&after=${firstBody.next}`,
      );
      expect(second.status).toBe(200);
      const secondBody = second.data as { cooldowns: Array<{ boxId: string }>; count: number; next: string | null };
      expect(secondBody.cooldowns.length).toBe(1);
      expect(secondBody.next).toBeNull();
      // Strictly after the first page's last.
      expect(secondBody.cooldowns[0]!.boxId > firstBody.cooldowns[1]!.boxId).toBe(true);
    } finally {
      server.close();
      dbMod.closeDb();
    }
  });
});

describe('/status\'s sums stay on the owner index', () => {
  let tmpDir: string;
  let dbFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-read-plans-'));
    dbFile = path.join(tmpDir, 'store.db');
  });

  afterEach(async () => {
    const dbMod = await importDbFresh();
    dbMod.closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('each SUM over utxo_boxes /status prepares explains to idx_utxo_boxes_owner_type_value', async () => {
    vi.resetModules();
    const dbMod = await importDbFresh();
    dbMod.initDb(dbFile);
    const db = dbMod.getDb();
    const { createRouter, KARMA_SUPPLY_TYPES } = await import('../../src/routes/blocks.js');
    const { getOrderingBlock, getOrderingBlockHash, getCurrentHeight } = await import('../../src/store/ordering.js');
    const { getBlockProof } = await import('../../src/store/block-proofs.js');

    const deps = {
      getOrderingBlock, getOrderingBlockHash, getCurrentHeight,
      getPostCount: () => 0,
      getPendingPostCount: () => 0,
      getTotalKarma: () => {
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes
              WHERE box_type IN (${KARMA_SUPPLY_TYPES.map(() => '?').join(', ')})
                AND spent_at_block IS NULL`,
          )
          .safeIntegers()
          .get(...KARMA_SUPPLY_TYPES) as { s: bigint };
        return row.s;
      },
      getLiquidKarma: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'karma' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      getTotalCredits: () => {
        const row = db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM utxo_boxes WHERE box_type = 'credit' AND spent_at_block IS NULL",
          )
          .safeIntegers()
          .get() as { s: bigint };
        return row.s;
      },
      networkType: 'devnet',
      inviteProbationBlocks: 0,
      vouchCooldownBlocks: 2,
      inviteBondMin: 1n,
      inviteBondMax: 10n,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      countUsernames: () => 0,
      getBlockProof,
    };

    const sqlsSeen: string[] = [];
    const original = db.prepare.bind(db) as (sql: string) => ReturnType<Database.Database['prepare']>;
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      writable: true,
      value: function (sql: string) {
        sqlsSeen.push(sql);
        return original(sql);
      },
    });

    const app = express();
    app.use(express.json());
    app.use(createRouter(deps));
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      await new Promise<void>((resolve) => {
        http.get({ hostname: '127.0.0.1', port: addr.port, path: '/status' }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        });
      });

      // The /status route prepares three SUMs over `utxo_boxes` — the three
      // the brief names (`SELECT COALESCE(SUM(value), 0) …`). Each explains
      // to the owner index.
      const sumSqls = sqlsSeen.filter((s) =>
        /SELECT\s+COALESCE\s*\(\s*SUM\s*\(\s*value\s*\)/i.test(s) && /utxo_boxes/i.test(s),
      );
      expect(sumSqls.length).toBe(3);

      Object.defineProperty(db, 'prepare', { configurable: true, writable: true, value: original });
      for (const sql of sumSqls) {
        const plan = planOf(db, sql);
        expect(plan).toMatch(/idx_utxo_boxes_owner_type_value/i);
      }
    } finally {
      server.close();
      dbMod.closeDb();
    }
  });
});
