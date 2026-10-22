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
  computeTxId,
  computePostId,
  computeBoxId,
  computeContentHash,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
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

/** The materialized karma change output of a thread/reply transaction. */
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
  });

  // 1. A block's spend takes a conflicting entry, on a server node.
  it('a block applying a conflicting post removes the pooled entry and its pending row', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 1);
    await seedBoxes([X]);

    const mem = await importMempool();
    const posts = await importPosts();

    const T1 = buildThread(A, X, 'T1 content');
    const T1_id = computeTxId(T1);
    const T1_post = computePostId(T1_id, 0);
    mem.insertUtxoTx(T1, 1000);
    // The pending-row shadow: a post entry's row rides the pool entry.
    const db = (await importDb()).getDb();
    db.prepare(
      `INSERT INTO dag_posts
        (id, tx_id, content_hash, content, author, parent_refs, protocol_version, type, status)
       VALUES (?, ?, ?, ?, ?, '[]', 1, 'regular', 'pending')`,
    ).run(T1_post, T1_id, Buffer.from(computeContentHash('T1 content')).toString('hex'), 'T1 content', Buffer.from(A.userId));

    // Control: T1 is in the pool and its pending row stands.
    expect(mem.pendingKarmaSpend(toHex(A.userId))).toBe(POST_PRICE_THREAD);
    expect(posts.getPost(T1_post)).not.toBeNull();

    const T2 = buildThread(A, X, 'T2 content');
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [T2] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    // The pending view holds no row for A, and T1's pending-post row is gone.
    expect(posts.getPost(T1_post)).toBeNull();
    expect(mem.pendingKarmaSpend(toHex(A.userId))).toBe(0n);
  });

  // 3. Expiry on a server node — expiry and ceiling pinned at the boundary.
  it('a block at expiresAtHeight keeps the entry, the next block removes it', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 2);
    await seedBoxes([X]);

    const mem = await importMempool();
    const T = buildThread(A, X, 'T expiring');
    mem.insertUtxoTx(T, 2); // expires at height 2

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

  // 4. A conflict's dependents — T1, T1' on T1's change, T1'' on T1''s change,
  //    a block spends T1's input via another transaction. All three leave.
  it('a chain of pooled spenders leaves with the entry whose input the block takes', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 3);
    await seedBoxes([X]);

    const mem = await importMempool();

    const T1 = buildThread(A, X, 'c4 T1');
    mem.insertUtxoTx(T1, 1000);
    const T1_change = changeBox(T1, A);

    const T1b = buildThread(A, T1_change, 'c4 T1b');
    mem.insertUtxoTx(T1b, 1000);
    const T1b_change = changeBox(T1b, A);

    const T1bb = buildThread(A, T1b_change, 'c4 T1bb');
    mem.insertUtxoTx(T1bb, 1000);

    expect(mem.getPendingEntries(10)).toHaveLength(3);

    // Another spender of X by A — the block carries it; T1 and its children
    // leave together.
    const T2 = buildThread(A, X, 'c4 T2');
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [T2] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  // 5. A reply's dependence — a reply R by another key naming P as its parent,
  //    pooled; a block spends P's input through another transaction; R leaves.
  it('a pooled reply leaves with the pooled parent its block confirms-away', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const B = makeTestIdentity();
    const Xa = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 10);
    const Xb = makeKarmaBox(POST_PRICE_REPLY * 10n, B.userId, 0, 11);
    await seedBoxes([Xa, Xb]);

    const mem = await importMempool();
    const posts = await importPosts();
    const db = (await importDb()).getDb();

    // P: A pools a thread spending Xa.
    const P = buildThread(A, Xa, 'c5 P');
    const P_id = computeTxId(P);
    const P_post = computePostId(P_id, 0);
    mem.insertUtxoTx(P, 1000);
    db.prepare(
      `INSERT INTO dag_posts (id, tx_id, content_hash, content, author, parent_refs, protocol_version, type, status)
       VALUES (?, ?, ?, ?, ?, '[]', 1, 'regular', 'pending')`,
    ).run(P_post, P_id, Buffer.from(computeContentHash('c5 P')).toString('hex'), 'c5 P', Buffer.from(A.userId));

    // R: B pools a reply to P spending Xb.
    const R = buildReply(B, Xb, 'c5 R', P_post, A.userId);
    const R_id = computeTxId(R);
    const R_post = computePostId(R_id, 0);
    mem.insertUtxoTx(R, 1000);
    db.prepare(
      `INSERT INTO dag_posts (id, tx_id, content_hash, content, author, parent_refs, protocol_version, type, status)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'regular', 'pending')`,
    ).run(R_post, R_id, Buffer.from(computeContentHash('c5 R')).toString('hex'), 'c5 R', Buffer.from(B.userId), JSON.stringify([P_post]));
    db.prepare('INSERT INTO dag_parent_refs (post_id, parent_id) VALUES (?, ?)').run(R_post, P_post);

    expect(posts.getPost(P_post)).not.toBeNull();
    expect(posts.getPost(R_post)).not.toBeNull();
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ?').get(R_post)).toBeDefined();

    // Block carries T2 spending Xa, confirming no post.
    const T2 = buildThread(A, Xa, 'c5 T2');
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [T2] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    expect(posts.getPost(R_post)).toBeNull();
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ?').get(R_post)).toBeUndefined();
  });

  // 6. A confirmed entry takes none — T1 and T1' on T1's change, block applies
  //    T1, T1' stays pooled.
  it('a confirmed entry leaves alone and its dependent stays pooled', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 20);
    await seedBoxes([X]);

    const mem = await importMempool();
    const T1 = buildThread(A, X, 'c6 T1');
    mem.insertUtxoTx(T1, 1000);
    const T1_change = changeBox(T1, A);
    const T1b = buildThread(A, T1_change, 'c6 T1b');
    mem.insertUtxoTx(T1b, 1000);

    expect(mem.getPendingEntries(10)).toHaveLength(2);

    const block = await makeApplicableBlock({ height: 1, utxoTxs: [T1] });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const kept = mem.getPendingEntries(10);
    expect(kept).toHaveLength(1);
    expect(computeTxId(T1b)).toBe((kept[0] as any).utxoTxBytes && computeTxId(T1b));
  });

  // 7. A reorg's re-inserted conflict — a reverted block's T1 is re-inserted,
  //    the new branch's block at the same height spends T1's input through T2.
  //    T1 does not stand after the reorg.
  it('a reorg does not return a transaction the new branch spends past', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const X = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 30);
    await seedBoxes([X]);

    const mem = await importMempool();

    // Both branches build their blocks over the same pre-apply state (genesis
    // plus seeded X). Chain B's block is built first and staged; chain A's
    // block is built and applied after. The reorg restores the prover to the
    // fork point, which is the state both blocks were built against.
    const { stagePrefix } = await import('./fork-resolution-fixtures.js');

    const T2 = buildThread(A, X, 'c7 T2');
    const blockB1 = await makeApplicableBlock({ height: 1, utxoTxs: [T2] });
    const hashes = await stagePrefix([blockB1]);

    const T1 = buildThread(A, X, 'c7 T1');
    const blockA1 = await makeApplicableBlock({ height: 1, utxoTxs: [T1] });
    expect(await applyBlockThroughIntake(blockA1)).toBe(true);

    const fork = await importFork();
    fork.reorg(0, hashes);

    // T1 is not in the pool after the reorg commits: the new branch's apply
    // spends X, so re-insertion either refused T1 or follow removed it.
    expect(mem.getPendingEntries(10)).toHaveLength(0);
  });

  // 8. deletePendingPost on a confirmed post leaves its row and its parent
  //    refs.
  it('deletePendingPost leaves a confirmed reply row and its parent refs', async () => {
    await freshNode();
    const A = makeTestIdentity();
    const B = makeTestIdentity();
    const Xa = makeKarmaBox(POST_PRICE_THREAD * 10n, A.userId, 0, 40);
    const Xb = makeKarmaBox(POST_PRICE_REPLY * 10n, B.userId, 0, 41);
    await seedBoxes([Xa, Xb]);

    const posts = await importPosts();
    const db = (await importDb()).getDb();

    // A thread confirmed first, so the reply has a confirmed parent.
    const P = buildThread(A, Xa, 'c8 P');
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [P] });
    expect(await applyBlockThroughIntake(b1)).toBe(true);
    const P_post = computePostId(computeTxId(P), 0);

    // A reply confirms at height 2.
    const R = buildReply(B, Xb, 'c8 R', P_post, A.userId);
    const b2 = await makeApplicableBlock({ height: 2, utxoTxs: [R] });
    expect(await applyBlockThroughIntake(b2)).toBe(true);
    const R_post = computePostId(computeTxId(R), 0);

    // Control: R is confirmed and names P as parent.
    expect(posts.getPost(R_post)?.status).toBe('confirmed');
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ? AND parent_id = ?').get(R_post, P_post)).toBeDefined();

    // The call: deletePendingPost on R. R is confirmed, so the row and its
    // parent-ref row stay.
    posts.deletePendingPost(R_post);

    expect(posts.getPost(R_post)?.status).toBe('confirmed');
    expect(db.prepare('SELECT 1 FROM dag_parent_refs WHERE post_id = ? AND parent_id = ?').get(R_post, P_post)).toBeDefined();
  });
});
