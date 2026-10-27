// MEMPOOL_INTERFACE → What takes an entry out of the pool → "The pool follows
// every applied block, on every node."; → "An entry that leaves unconfirmed
// takes its dependents."; → "A reorg returns what it reverts and nothing else."
// NODE_INTERFACE → Post transactions → "The pending row is the mempool entry's
// DAG shadow".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  computeTxId,
  computePostId,
  computeBoxId,
  computeContentHash,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
  makeKarmaBox,
  makeTestIdentity,
  seedBoxes,
  signTransaction,
  toHex,
  wireIntakeForTests,
  type TestIdentity,
} from '../helpers.js';
import type { PostServiceDeps } from '../../src/services/post-service.js';

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as typeof import('../../src/store/mempool.js');
}

async function importDb() {
  return (await import('../../src/store/db.js')) as typeof import('../../src/store/db.js');
}

async function importPosts() {
  return (await import('../../src/store/posts.js')) as typeof import('../../src/store/posts.js');
}

async function importFork() {
  return (await import('../../src/services/fork-resolution.js')) as typeof import('../../src/services/fork-resolution.js');
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as typeof import('../../src/store/utxo.js');
}

/** A signed thread post over `karmaInput`. */
function buildThread(author: TestIdentity, karmaInput: KarmaBox, content: string): UtxoTransaction {
  const change = karmaInput.value - POST_PRICE_THREAD;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({ boxType: 'karma', value: change, createdAtBlock: 0, owner: author.userId } as unknown as AnyBox);
  }
  outputs.push({ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: 0 } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: {
      contentHash: computeContentHash(content),
      author: author.userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    },
  };
  signTransaction(tx, author.privateKey, toHex(author.userId));
  return tx;
}

/** A signed reply over `karmaInput`, naming `parentPostId` and crediting `parentAuthor`. */
function buildReply(
  author: TestIdentity,
  karmaInput: KarmaBox,
  content: string,
  parentPostId: string,
  parentAuthor: Uint8Array,
): UtxoTransaction {
  const change = karmaInput.value - POST_PRICE_REPLY;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({ boxType: 'karma', value: change, createdAtBlock: 0, owner: author.userId } as unknown as AnyBox);
  }
  outputs.push({ boxType: 'karma_price', value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, createdAtBlock: 0 } as unknown as AnyBox);
  outputs.push({ boxType: 'like_accrual', value: REPLY_AUTHOR_SHARE, createdAtBlock: 0, author: parentAuthor } as unknown as AnyBox);
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: {
      contentHash: computeContentHash(content),
      author: author.userId,
      parentRefs: [parentPostId],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    },
  };
  signTransaction(tx, author.privateKey, toHex(author.userId));
  return tx;
}

/** A signed karma consolidation over `karmaInput` — one input, one same-owner
 * same-value karma output. Non-post, non-price, so admitWriteTx admits it with
 * the pending view's own-karma rule met (MEMPOOL_INTERFACE →
 * getOwnKarmaBoxIdsWithPending). */
function buildConsolidation(author: TestIdentity, karmaInput: KarmaBox): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaInput.id!],
    outputs: [
      { boxType: 'karma', value: karmaInput.value, createdAtBlock: 0, owner: author.userId } as unknown as AnyBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, author.privateKey, toHex(author.userId));
  return tx;
}

/** The materialized karma output at index 0 of a thread, reply or consolidation. */
function changeBox(tx: UtxoTransaction, author: TestIdentity): KarmaBox {
  const txId = computeTxId(tx);
  const o = tx.outputs[0] as KarmaBox;
  const materialized = {
    boxType: 'karma' as const,
    value: o.value,
    createdAtBlock: 0,
    owner: author.userId,
    txId,
    index: 0,
  };
  return { ...materialized, id: computeBoxId(materialized) };
}

/** The engine deps every admission path reads over the real store — the
 * shape `test/services/karma-spend-admission.test.ts` builds, resolved
 * dynamically against the module graph `freshNode` just reset. */
async function buildEngineDeps(): Promise<UtxoEngineDeps> {
  const store = await import('../../src/store/index.js');
  const karmaAdm = await import('../../src/services/karma-admission.js');
  const dbMod = await import('../../src/store/db.js');
  const { config } = await import('../../src/config.js');
  const decayCfg = {
    staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
    decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  };
  return {
    getBox: store.getBoxWithPending,
    insertBox: store.insertBox,
    consumeBox: store.consumeBox,
    getKarmaValue: karmaAdm.admissionHeld,
    getOwnKarmaBoxIds: karmaAdm.admissionGetOwnKarmaBoxIds,
    getKarmaOwed: karmaAdm.admissionOwed(decayCfg),
    getIdentityRecord: store.getIdentityRecord,
    hasActiveVouchEscrow: store.hasActiveVouchEscrow,
    vouchCooldownBlocks: 2,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg,
    storageRentPeriodBlocks: 40,
    getBoxProvenance: () => null,
    getTopologyAuthor: (postId: string) => store.getTopologyAuthorBytes(postId),
    getPendingPostAuthor: store.getPendingPostAuthor,
    runInTransaction: (fn: () => void) => (dbMod.getDb().transaction(fn) as () => void)(),
    getVouchBox: store.getVouchBox,
    getNetworkRecord: store.getNetworkRecord,
    membershipBarMultiplier: 1,
    putIdentityRecord: store.putIdentityRecord,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
}

/** The deps `routes/posts.ts` passes `createPost`, over the engine deps and
 * the store's `getPost`/`insertPost` the way admission writes them. */
async function buildPostDeps(engine: UtxoEngineDeps, getCurrentHeight: () => number): Promise<PostServiceDeps> {
  const store = await import('../../src/store/index.js');
  const verifier = await import('../../src/services/verifier.js');
  const admit = await import('../../src/services/admit-tx.js');
  const consensus = await import('@dagsocial/consensus');
  return {
    verifyPost: verifier.verifyPost,
    getKarmaBoxes: store.getKarmaBoxes,
    getIdentityRecord: engine.getIdentityRecord,
    decayCfg: engine.decayCfg,
    getPost: store.getPost,
    insertPost: store.insertPost,
    getCurrentHeight,
    protocolVersionSchedule: engine.protocolVersionSchedule,
    admitTx: admit.admitTx,
    getHeldEntry: store.getHeldEntry,
    validateTx: (tx, i, h) => consensus.validateTx(engine, tx, i, h),
    getBox: engine.getBox,
    runInTransaction: engine.runInTransaction,
  };
}

/** A fresh in-memory node with a live prover and the intake wired. */
async function freshNode(): Promise<void> {
  vi.resetModules();
  const db = await importDb();
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const { setClock } = await import('../../src/services/difficulty.js');
  setClock(() => 1_700_000_000_000 + 40 * 86_400_000);
  await liveProver();
  await wireIntakeForTests();
  const vt = await import('vitest');
  vt.vi.spyOn(console, 'warn').mockImplementation(() => {});
  vt.vi.spyOn(console, 'log').mockImplementation(() => {});
  vt.vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('every applied block lets the pool follow it, on every node', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    const db = await importDb();
    db.closeDb();
    vi.restoreAllMocks();
    vi.doUnmock('../../src/config.js');
  });

  it('a block applying a conflicting post removes the pooled entry and its pending row', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 1);
    await seedBoxes([X]);

    const mem = await importMempool();
    const posts = await importPosts();
    const engine = await buildEngineDeps();
    const postDeps = await buildPostDeps(engine, () => 0);
    const create = await import('../../src/services/post-service.js');

    // The pool entry, the pending row and the parent refs are what createPost
    // writes in one store transaction (NODE_INTERFACE → Post transactions →
    // "The pending row is the mempool entry's DAG shadow").
    const Tpool = buildThread(A, X, 'contentious thread');
    const Tpool_id = computeTxId(Tpool);
    const Tpool_post = computePostId(Tpool_id, 0);
    create.createPost(postDeps, Tpool, 'contentious thread');

    expect(mem.pendingKarmaSpend(toHex(A.userId))).toBe(POST_PRICE_THREAD);
    expect(posts.getPost(Tpool_post)).not.toBeNull();

    const Tblock = buildThread(A, X, 'the block\'s thread');
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [Tblock] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    expect(posts.getPost(Tpool_post)).toBeNull();
    expect(mem.pendingKarmaSpend(toHex(A.userId))).toBe(0n);
  });

  it('a block at expiresAtHeight keeps the entry, the next block removes it', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 2);
    await seedBoxes([X]);

    const mem = await importMempool();
    // The expiry boundary is this case's subject: the entry carries an
    // `expiresAtHeight` the chain reaches in two blocks, which `insertUtxoTx`
    // takes directly (MEMPOOL_INTERFACE → insertUtxoTx; → Expiry).
    const T = buildThread(A, X, 'T expiring');
    mem.insertUtxoTx(T, computeTxId(T), 2);

    const b1 = await makeApplicableBlock({ height: 1 });
    expect(await applyBlockThroughIntake(b1)).toBe(true);
    expect(mem.getPendingEntries(10)).toHaveLength(1);

    const b2 = await makeApplicableBlock({ height: 2 });
    expect(await applyBlockThroughIntake(b2)).toBe(true);
    // The block at expiresAtHeight keeps the entry (2 < 2 is false).
    expect(mem.getPendingEntries(10)).toHaveLength(1);

    const b3 = await makeApplicableBlock({ height: 3 });
    expect(await applyBlockThroughIntake(b3)).toBe(true);
    // The block at expiresAtHeight + 1 removes it.
    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  it('a chain of pooled spenders leaves with the entry whose input the block takes', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 3);
    await seedBoxes([X]);

    const mem = await importMempool();
    const engine = await buildEngineDeps();
    const postDeps = await buildPostDeps(engine, () => 0);
    const create = await import('../../src/services/post-service.js');
    const admit = await import('../../src/services/admit-tx.js');
    const consensus = await import('@dagsocial/consensus');

    const Troot = buildThread(A, X, 'root of a chain');
    create.createPost(postDeps, Troot, 'root of a chain');
    const Troot_change = changeBox(Troot, A);

    // Chained karma consolidations spending the predecessor's pending change —
    // admitted against the pending view as a write route admits them
    // (MEMPOOL_INTERFACE → getBoxWithPending; → getOwnKarmaBoxIdsWithPending).
    const Tchild = buildConsolidation(A, Troot_change);
    admit.admitWriteTx(() => {}, (t, i, h) => consensus.validateTx(engine, t, i, h), Tchild, 1, '');
    const Tchild_change = changeBox(Tchild, A);

    const Tgrand = buildConsolidation(A, Tchild_change);
    admit.admitWriteTx(() => {}, (t, i, h) => consensus.validateTx(engine, t, i, h), Tgrand, 1, '');

    expect(mem.getPendingEntries(10)).toHaveLength(3);

    // Another spender of X by A — the block carries it; the whole chain
    // leaves together.
    const Tblock = buildThread(A, X, 'the block\'s spender');
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [Tblock] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  it('a pooled reply leaves with the parent whose input the block spends', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const B = makeTestIdentity();
    const Xa = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 10);
    const Xb = makeKarmaBox(POST_PRICE_REPLY * 10n, B.userId, 0, 11);
    await seedBoxes([Xa, Xb]);

    const mem = await importMempool();
    const posts = await importPosts();
    const db = (await importDb()).getDb();
    const engine = await buildEngineDeps();
    const postDeps = await buildPostDeps(engine, () => 0);
    const create = await import('../../src/services/post-service.js');

    const P = buildThread(A, Xa, 'a parent in the pool');
    const P_id = computeTxId(P);
    const P_post = computePostId(P_id, 0);
    create.createPost(postDeps, P, 'a parent in the pool');

    const R = buildReply(B, Xb, 'a reply to the pending parent', P_post, A.userId);
    const R_id = computeTxId(R);
    const R_post = computePostId(R_id, 0);
    create.createPost(postDeps, R, 'a reply to the pending parent');

    expect(posts.getPost(P_post)).not.toBeNull();
    expect(posts.getPost(R_post)).not.toBeNull();
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ?').get(R_post)).toBeDefined();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    const Tblock = buildThread(A, Xa, 'the block\'s thread over Xa');
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [Tblock] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    expect(posts.getPost(R_post)).toBeNull();
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ?').get(R_post)).toBeUndefined();
  });

  it('a confirmed entry leaves alone and its dependent stays pooled', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 20);
    await seedBoxes([X]);

    const mem = await importMempool();
    const engine = await buildEngineDeps();
    const postDeps = await buildPostDeps(engine, () => 0);
    const create = await import('../../src/services/post-service.js');
    const admit = await import('../../src/services/admit-tx.js');
    const consensus = await import('@dagsocial/consensus');

    const T = buildThread(A, X, 'the one the block carries');
    create.createPost(postDeps, T, 'the one the block carries');
    const T_change = changeBox(T, A);

    const Tdep = buildConsolidation(A, T_change);
    admit.admitWriteTx(() => {}, (t, i, h) => consensus.validateTx(engine, t, i, h), Tdep, 1, '');

    expect(mem.getPendingEntries(10)).toHaveLength(2);

    const block = await makeApplicableBlock({ height: 1, utxoTxs: [T] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const kept = mem.getPendingEntries(10);
    expect(kept).toHaveLength(1);
    // The one entry that remains is Tdep — its id read from its stored
    // tx_id compared to computeTxId(Tdep).
    const db = (await importDb()).getDb();
    const row = db.prepare('SELECT tx_id FROM mempool WHERE rowid = ?').get(kept[0]!.rowid) as { tx_id: string };
    expect(row.tx_id).toBe(computeTxId(Tdep));
  });

  it('a reorg does not return a transaction the new branch spends past', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 30);
    await seedBoxes([X]);

    const mem = await importMempool();

    // Both branches build their blocks over the same pre-apply state (genesis
    // plus seeded X). The reorg restores the prover to the fork point,
    // re-inserts the reverted branch's transaction into the pool at Phase 2,
    // and the Phase 3 apply of the new branch's block removes it through
    // followAppliedBlock.
    const { stagePrefix } = await import('./fork-resolution-fixtures.js');

    const Tnew = buildThread(A, X, 'chain B\'s thread over X');
    const blockB1 = await makeApplicableBlock({ height: 1, utxoTxs: [Tnew] });
    const hashes = await stagePrefix([blockB1]);

    const Trev = buildThread(A, X, 'chain A\'s thread over X');
    const blockA1 = await makeApplicableBlock({ height: 1, utxoTxs: [Trev] });
    expect(await applyBlockThroughIntake(blockA1)).toBe(true);

    const fork = await importFork();
    fork.reorg(0, hashes);

    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  it('deletePendingPost leaves a confirmed reply row and its parent refs', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const B = makeTestIdentity();
    const Xa = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 40);
    const Xb = makeKarmaBox(POST_PRICE_REPLY * 10n, B.userId, 0, 41);
    await seedBoxes([Xa, Xb]);

    const posts = await importPosts();
    const db = (await importDb()).getDb();

    const P = buildThread(A, Xa, 'the confirmed parent');
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [P] });
    expect(await applyBlockThroughIntake(b1)).toBe(true);
    const P_post = computePostId(computeTxId(P), 0);

    const R = buildReply(B, Xb, 'the confirmed reply', P_post, A.userId);
    const b2 = await makeApplicableBlock({ height: 2, utxoTxs: [R] });
    expect(await applyBlockThroughIntake(b2)).toBe(true);
    const R_post = computePostId(computeTxId(R), 0);

    expect(posts.getPost(R_post)?.status).toBe('confirmed');
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ? AND parent_id = ?').get(R_post, P_post)).toBeDefined();

    posts.deletePendingPost(R_post);

    expect(posts.getPost(R_post)?.status).toBe('confirmed');
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ? AND parent_id = ?').get(R_post, P_post)).toBeDefined();
  });

  it('an entry past its ceiling leaves with the block at ceiling + 1', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 50);
    await seedBoxes([X]);

    const mem = await importMempool();
    // The ceiling boundary is this case's subject: a vouch cast carries a
    // ceiling the rules give it (MEMPOOL_INTERFACE → Validity ceiling), and
    // the entry rides `insertUtxoTx` with that ceiling. With the vouch
    // output's createdAtBlock = 10, the ceiling is 15.
    const dummyKey = toHex(A.userId);
    const voucher = Buffer.from('ee'.repeat(32), 'hex');
    const target = Buffer.from('11'.repeat(32), 'hex');
    const vouchTx: UtxoTransaction = {
      inputs: [X.id!],
      outputs: [
        { boxType: 'karma', value: 99n, owner: A.userId, createdAtBlock: 10 } as unknown as AnyBox,
        {
          boxType: 'vouch', value: 1n, createdAtBlock: 10,
          voucherId: new Uint8Array(voucher), targetId: new Uint8Array(target),
        } as unknown as AnyBox,
      ],
      signatures: { [dummyKey]: new Uint8Array(64) },
      protocolVersion: PROTOCOL_VERSION,
    };
    mem.insertUtxoTx(vouchTx, computeTxId(vouchTx), 1000);

    for (let h = 1; h <= 15; h++) {
      const b = await makeApplicableBlock({ height: h });
      expect(await applyBlockThroughIntake(b)).toBe(true);
    }
    // The block at ceiling keeps the entry.
    expect(mem.getPendingEntries(10)).toHaveLength(1);

    const b16 = await makeApplicableBlock({ height: 16 });
    expect(await applyBlockThroughIntake(b16)).toBe(true);
    // The block at ceiling + 1 removes it.
    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  it('a block whose settlement spends a pooled entry\'s box takes the entry', async () => {
    // MEMPOOL_INTERFACE → What takes an entry out of the pool → "A block's
    // spends" names "any box the block's mutations remove, the body's and the
    // settlement's". vi.doMock compresses the stale threshold and the decay
    // interval so a stale identity's post-body karma is squared in a
    // reachable height (NODE_INTERFACE → Karma decay).
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js',
      );
      return {
        ...actual,
        config: Object.freeze({
          ...actual.config,
          karmaStaleThresholdBlocks: 3,
          karmaDecayIntervalBlocks: 1,
        }),
      };
    });
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 60);
    await seedBoxes([X]);

    const mem = await importMempool();
    const utxo = await importUtxo();
    const engine = await buildEngineDeps();
    const postDeps = await buildPostDeps(engine, () => 0);
    const create = await import('../../src/services/post-service.js');
    const admit = await import('../../src/services/admit-tx.js');
    const consensus = await import('@dagsocial/consensus');

    // Tb pools a post of A, admitted while the identity is fresh (judged-for
    // height 1, stale threshold 3). Tp pools a consolidation of Tb's pending
    // change — the identity's karma box in the pending view — admitted the
    // same way.
    const Tb = buildThread(A, X, 'the body\'s thread over X');
    create.createPost(postDeps, Tb, 'the body\'s thread over X');
    const Tb_change = changeBox(Tb, A);

    const Tp = buildConsolidation(A, Tb_change);
    admit.admitWriteTx(() => {}, (t, i, h) => consensus.validateTx(engine, t, i, h), Tp, 1, '');

    // Controls: Tb_change is A's in the pending view before the block, and
    // Tp sits in the pool before the block.
    expect(utxo.getBox(Tb_change.id!)).toBeNull();
    expect(mem.findPendingOutput(Tb_change.id!)).not.toBeNull();
    expect(mem.getPendingEntries(10)).toHaveLength(2);

    // Empty blocks carry the chain past the stale threshold without touching A.
    for (let h = 1; h <= 4; h++) {
      const b = await makeApplicableBlock({ height: h });
      expect(await applyBlockThroughIntake(b)).toBe(true);
    }

    // The block at height 5 carries Tb; the body spends X and emits
    // Tb_change, the post-body karma projection for A names Tb_change, and
    // the settlement decays A — it consumes Tb_change and emits a
    // decay-burn karma box (NODE_INTERFACE → Karma decay).
    const block = await makeApplicableBlock({ height: 5, utxoTxs: [Tb] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    // The block's effects remove Tb_change — the body creates it and the
    // settlement consumes it, in that block, so the store answers it as
    // spent after the apply.
    expect(utxo.getBox(Tb_change.id!)).toBeNull();
    expect(mem.findPendingOutput(Tb_change.id!)).toBeNull();
    // Tp — the entry whose input the settlement spent — leaves with the block.
    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });
});
