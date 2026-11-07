import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  boxRecordBytes,
  computeContentHash,
  computePostId,
  computeTxId,
  KARMA_MINIMUM,
  POST_PRICE_THREAD,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, KarmaBox, PostCommit, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput } from '@dagsocial/consensus';
import {
  blockBudgetSeam,
  liveProver,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';

/**
 * The gossip relay's transaction handler (NODE_INTERFACE → Relay handlers). A
 * policy refusal of a relayed transaction — the fee floor's, rent's, the cost
 * gate's — is this node's answer to it: the handler logs it as a refusal and
 * returns with the pool unchanged, and throws nothing for net to log as a
 * handler defect. A throw that is no refusal still reaches net.
 */

/** The config module with `overrides` over the process config — registered before the node's modules load. */
function configWith(overrides: Record<string, unknown>): void {
  vi.doMock('../../src/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config.js')>();
    return { ...actual, config: Object.freeze({ ...actual.config, ...overrides }) };
  });
}

/**
 * A fresh store holding one credit box of ten credits for a fresh sender — more
 * than a rent charge on it — and a prover over it.
 */
async function storeWithCredit() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const utxo = await import('../../src/store/utxo.js');
  const sender = makeTestIdentity();
  const box = makeCreditBox(10n * 10n ** 8n, sender.userId, 0, 1);
  utxo.insertBox(box);
  await liveProver();
  return { sender, box };
}

/** `tx` through the relay handler: the lines it warned, logged and errored, what it threw, and the pool after. */
async function relay(tx: UtxoTransaction) {
  const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
  const warned: string[] = [];
  const errored: string[] = [];
  const logged: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errored.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  let thrown: unknown = null;
  try {
    handleRelayedTx(tx, undefined, 'peer-relay');
  } catch (err) {
    thrown = err;
  }
  const mempool = await import('../../src/store/mempool.js');
  return { warned, errored, logged, thrown, pooled: mempool.getPendingEntries(10).length };
}

describe('the relay handler takes a policy refusal as an answer', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await import('../../src/store/db.js')).closeDb();
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/cost-estimate.js');
    vi.doUnmock('../../src/services/admit-tx.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a transaction under the fee floor is logged as refused, and nothing is thrown or pooled', async () => {
    configWith({ minFeeRatePerByte: 10n ** 6n });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1n));

    expect(run.thrown).toBeNull();
    expect(run.warned.some((line) => line.startsWith('Relayed tx refused: Fee rate below this node\'s floor'))).toBe(true);
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(0);
  });

  it('a rent transaction is logged as refused, and nothing is thrown or pooled', async () => {
    // Rent-eligible at the height that would carry it, tip + 1.
    configWith({ storageRentPeriodBlocks: 0 });
    const { box } = await storeWithCredit();
    const { getBoxProvenance } = await import('../../src/store/utxo.js');
    const provenance = getBoxProvenance(box.id!);
    if (provenance === null) throw new Error('the seeded box has no provenance');
    const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, provenance.txId, provenance.index).length);
    const rent: UtxoTransaction = {
      inputs: [box.id!],
      outputs: [
        { boxType: 'credit', value: box.value - charge, createdAtBlock: 1, owner: box.owner } as AnyBoxCandidate,
        { boxType: 'fee', value: charge, createdAtBlock: 1 } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };

    const run = await relay(rent);

    expect(run.thrown).toBeNull();
    expect(run.warned, JSON.stringify(run.warned)).toContain('Relayed tx refused: Rent transactions are not accepted for relay');
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(0);
  });

  it('a transaction no block can carry is logged as refused, and nothing is thrown or pooled', async () => {
    const budget = blockBudgetSeam();
    const { sender, box } = await storeWithCredit();
    budget.set(1);

    const run = await relay(makeCreditTx(sender, [box], 1_000n));

    expect(run.thrown).toBeNull();
    expect(run.warned.some((line) => line.startsWith('Relayed tx refused: A block carrying this transaction alone is over the budget'))).toBe(true);
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state."
  // NODE_INTERFACE → Relay handlers (mempool-based)
  // ---------------------------------------------------------------------------
  it('a pooled transaction relayed again is answered as held, logs nothing, pool unchanged', async () => {
    const { sender, box } = await storeWithCredit();
    const tx = makeCreditTx(sender, [box], 1_000n);

    // First admit: pool the transaction via admitTx directly.
    const adm = await import('../../src/services/admit-tx.js');
    const { MEMPOOL_EXPIRY_BLOCKS } = await import('@dagsocial/types');
    const mempoolMod = await import('../../src/store/mempool.js');
    const ord = await import('../../src/store/ordering.js');
    adm.admitTx(tx, computeTxId(tx), ord.getCurrentHeight() + 1 + MEMPOOL_EXPIRY_BLOCKS);
    const poolBefore = mempoolMod.getPendingEntries(10).length;

    const run = await relay(tx);

    expect(run.thrown).toBeNull();
    expect(run.warned).toEqual([]);
    expect(run.logged).toEqual([]);
    expect(run.errored).toEqual([]);
    expect(run.pooled).toBe(poolBefore);

    // NODE_INTERFACE → Relay handlers: a held transaction is a refusal — the
    // handler returns `false`, so net forwards nothing.
    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    expect(handleRelayedTx(tx, undefined, 'peer-relay')).toBe(false);
  });

  it('control: a throw from admission that is no refusal still reaches net', async () => {
    vi.doMock('../../src/services/admit-tx.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/services/admit-tx.js')>();
      return {
        ...actual,
        admitTx: () => {
          throw new Error('injected: admission fails');
        },
      };
    });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1_000n));

    expect(String(run.thrown)).toContain('injected: admission fails');
    expect(run.pooled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MEMPOOL_INTERFACE → getBoxWithPending → "A relayed transaction is judged
// against the pending view, as a submitted one is"; NODE_INTERFACE → Net
// Integration → Relay handlers (mempool-based). A parent pooled at this node
// leaves its outputs in the pending view, so the child a peer relays next is
// admitted; a conflict with a pooled entry's input answers one line and
// `false`; a missing input answers silently and moves
// `relayed_txs_input_missing_total`; a signature the map does not carry
// answers one line naming the refusal (NODE_INTERFACE → Admin Listener).
// ---------------------------------------------------------------------------

function newIdentityRecord() {
  return {
    lastActivityBlock: 0,
    lastDecayBlock: 0,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 1,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
  };
}

/** A fresh store holding one karma box of `value` for a fresh author, plus the author's identity record. */
async function storeWithKarma(value: bigint): Promise<{ author: ReturnType<typeof makeTestIdentity>; karmaBox: Stored<KarmaBox> }> {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const author = makeTestIdentity();
  const identityRecords = await import('../../src/store/identity-records.js');
  identityRecords.putIdentityRecord(author.userId, newIdentityRecord());
  const karmaBox = seedProvenance<KarmaBox>(
    { boxType: 'karma', value, createdAtBlock: 0, owner: author.userId },
    0,
    1,
  );
  const utxo = await import('../../src/store/utxo.js');
  utxo.insertBox(karmaBox);
  await liveProver();
  return { author, karmaBox };
}

/** A signed thread transaction spending `karma` for `content`, with the pooled post id its `insertPost` writes. */
function buildThread(
  author: ReturnType<typeof makeTestIdentity>,
  karma: KarmaBox,
  content: string,
): { tx: UtxoTransaction; content: string; postId: string } {
  const change = karma.value - POST_PRICE_THREAD;
  const outputs: AnyBox[] = [];
  if (change > 0n) {
    outputs.push({
      boxType: 'karma',
      value: change,
      createdAtBlock: 0,
      owner: author.userId,
    } as unknown as AnyBox);
  }
  outputs.push({
    boxType: 'karma_price',
    value: POST_PRICE_THREAD,
    createdAtBlock: 0,
  } as unknown as AnyBox);
  const commit: PostCommit = {
    contentHash: computeContentHash(content),
    author: author.userId,
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
  };
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: commit,
  };
  signTransaction(tx, author.privateKey, Buffer.from(author.userId).toString('hex'));
  const postId = computePostId(computeTxId(tx), 0);
  return { tx, content, postId };
}

/** The pending karma change box of a karma-arm transaction's output 0. */
function pendingKarmaChange(tx: UtxoTransaction): KarmaBox {
  return materializeOutput(tx.outputs[0]!, computeTxId(tx), 0) as KarmaBox;
}

/**
 * An admin app over the metrics module and inert net deps — the two counters
 * read on the shape `test/routes/admin.test.ts` reads (NODE_INTERFACE →
 * Admin Listener).
 */
async function statsCounters(): Promise<Record<string, unknown>> {
  const { createAdminRouter } = await import('../../src/routes/admin.js');
  const app = express();
  app.use(createAdminRouter({
    getConnectedPeers: () => [],
    syncPhase: () => 'idle',
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  }));
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      http
        .get(`http://127.0.0.1:${addr.port}/stats`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            server.close();
            const parsed = JSON.parse(body) as { counters: Record<string, unknown> };
            resolve(parsed.counters);
          });
        })
        .on('error', (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('the relay judges the transaction against the pending view', () => {
  beforeEach(async () => {
    vi.resetModules();
    const metrics = await import('../../src/metrics.js');
    metrics.resetForTests();
  });
  afterEach(async () => {
    (await import('../../src/store/db.js')).closeDb();
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('@dagsocial/consensus');
    vi.doUnmock('../../src/services/cost-estimate.js');
    vi.doUnmock('../../src/services/admit-tx.js');
    vi.restoreAllMocks();
    vi.resetModules();
    const metrics = await import('../../src/metrics.js');
    metrics.resetForTests();
  });

  it('a relayed post whose input is the change of a pooled post by the same author is pooled, and its post row is pending', async () => {
    const { author, karmaBox } = await storeWithKarma(2n * POST_PRICE_THREAD + KARMA_MINIMUM);
    const warned: string[] = [];
    const logged: string[] = [];
    const errored: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.map(String).join(' ')); });

    const parent = buildThread(author, karmaBox, 'parent thread');
    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    const parentAdmitted = handleRelayedTx(parent.tx, parent.content, 'peer-A');
    expect(parentAdmitted).toBe(true);

    const change = pendingKarmaChange(parent.tx);
    const child = buildThread(author, change, 'child thread');
    const childAdmitted = handleRelayedTx(child.tx, child.content, 'peer-A');
    expect(childAdmitted).toBe(true);

    const mempool = await import('../../src/store/mempool.js');
    expect(mempool.getPendingEntries(100).length).toBe(2);

    const posts = await import('../../src/store/posts.js');
    const childPost = posts.getPost(child.postId);
    expect(childPost).not.toBeNull();
    expect(childPost!.status).toBe('pending');
    expect(childPost!.content).toBe('child thread');
  });

  it('a relayed credit transfer spending the change of a pooled transfer by the same sender is pooled', async () => {
    const { sender, box } = await storeWithCredit();
    const warned: string[] = [];
    const logged: string[] = [];
    const errored: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.map(String).join(' ')); });

    const parent = makeCreditTx(sender, [box], 1_000n);
    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    expect(handleRelayedTx(parent, undefined, 'peer-A')).toBe(true);

    const parentChange = materializeOutput(parent.outputs[0]!, computeTxId(parent), 0) as import('@dagsocial/types').CreditBox;
    const child = makeCreditTx(sender, [parentChange], 1_000n);
    expect(handleRelayedTx(child, undefined, 'peer-A')).toBe(true);

    const mempool = await import('../../src/store/mempool.js');
    expect(mempool.getPendingEntries(100).length).toBe(2);
  });

  it.fails('a relayed transaction whose input exists nowhere is silent, moves relayed_txs_input_missing_total by one, and pools nothing', async () => {
    const { sender } = await storeWithCredit();
    // An input box the store has never seen — a credit box whose id derives
    // from a nonce the store never saw.
    const absentBox = makeCreditBox(1n * 10n ** 8n, sender.userId, 0, 7777);
    const tx = makeCreditTx(sender, [absentBox], 1n);

    const counters0 = await statsCounters();
    const before = ((counters0['relayed_txs_input_missing_total'] as number | undefined) ?? 0);

    const warned: string[] = [];
    const logged: string[] = [];
    const errored: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.map(String).join(' ')); });

    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    const returned = handleRelayedTx(tx, undefined, 'peer-A');
    expect(returned).toBe(false);
    expect(warned).toEqual([]);
    expect(logged).toEqual([]);
    expect(errored).toEqual([]);

    const mempool = await import('../../src/store/mempool.js');
    expect(mempool.getPendingEntries(10).length).toBe(0);

    const counters1 = await statsCounters();
    const after = ((counters1['relayed_txs_input_missing_total'] as number | undefined) ?? 0);
    expect(after).toBe(before + 1);
  });

  it('a relayed transaction whose input exists but whose owner signature is not in the map logs one line and pools nothing', async () => {
    const { sender, box } = await storeWithCredit();
    const tx = makeCreditTx(sender, [box], 1n);
    // Strip the signature — the input exists, the owner's entry is gone.
    tx.signatures = {};

    const warned: string[] = [];
    const logged: string[] = [];
    const errored: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.map(String).join(' ')); });

    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    const returned = handleRelayedTx(tx, undefined, 'peer-A');
    expect(returned).toBe(false);

    const refusalLines = warned.filter((l) => l.includes('Missing or invalid owner signature'));
    expect(refusalLines.length).toBe(1);

    const mempool = await import('../../src/store/mempool.js');
    expect(mempool.getPendingEntries(10).length).toBe(0);
  });

  it.fails('GET /stats serves relayed_txs_input_missing_total, 0 on a fresh process', async () => {
    const counters = await statsCounters();
    expect(counters['relayed_txs_input_missing_total']).toBe(0);
  });

  // MEMPOOL_INTERFACE → insertUtxoTx → "The conflict gate runs before the
  // capacity gate": an arrival spending a box a pooled entry spends answers
  // the conflict — one line, `false`, the pool as it stood.
  it('a relayed transaction spending a box a pooled entry spends answers false, one line naming the conflict, pool unchanged', async () => {
    const { sender, box } = await storeWithCredit();
    const parent = makeCreditTx(sender, [box], 1_000n);
    // Second transaction naming the same `box` as input — a conflicting
    // spender, not a chain.
    const conflicting = makeCreditTx(sender, [box], 2_000n);

    const warned: string[] = [];
    const logged: string[] = [];
    const errored: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errored.push(a.map(String).join(' ')); });

    const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
    expect(handleRelayedTx(parent, undefined, 'peer-A')).toBe(true);
    const mempool = await import('../../src/store/mempool.js');
    const pooledBefore = mempool.getPendingEntries(10);
    expect(pooledBefore.length).toBe(1);

    let thrown: unknown = null;
    let returned: unknown = null;
    try {
      returned = handleRelayedTx(conflicting, undefined, 'peer-A');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(returned).toBe(false);

    const conflictLines = warned.filter((l) => l.includes('input spent by a pending entry'));
    expect(conflictLines.length).toBe(1);

    const pooledAfter = mempool.getPendingEntries(10);
    expect(pooledAfter.length).toBe(1);
    expect(pooledAfter[0]!.rowid).toBe(pooledBefore[0]!.rowid);
  });
});
