import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import {
  computeTxId,
  encodeTx,
  MEMPOOL_EXPIRY_BLOCKS,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { withdrawRoutes } from '../../src/routes/withdraw.js';
import type { WithdrawDeps } from '../../src/routes/withdraw.js';
import { setNet } from '../../src/services/net-instance.js';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import {
  getKarmaBoxes,
  insertBox as storeInsertBox,
  getBox as storeGetBox,
} from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { executePostWithdraw } from '../../src/services/post-withdraw.js';
import { getTopologyAuthorBytes } from '../../src/store/topology.js';
import { admissionOwed } from '../../src/services/karma-admission.js';
import { config } from '../../src/config.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyBlockThroughIntake,
  changeBoxOf,
  liveProver,
  makeApplicableBlock,
  makeTestIdentity,
  seedPostTx,
  signTransaction,
  toHex,
  txToJson,
} from '../helpers.js';
import type { TestIdentity } from '../helpers.js';
import { insertPost } from '../../src/store/posts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonPostWithdrawTxBody(): Record<string, unknown> {
  return {
    inputs: ['a'.repeat(64)],
    outputs: [{ boxType: 'karma', value: '10', owner: '0'.repeat(64), createdAtBlock: 1 }],
    signatures: {},
    protocolVersion: 1,
    postWithdraw: {
      postId: 'd'.repeat(64),
    },
  };
}

const STUB_DEPS: UtxoEngineDeps = {
  getBox: () => null,
  insertBox: () => {},
  consumeBox: () => {},
  getKarmaOwed: () => 0n,
  getKarmaValue: () => 0n,
  getOwnKarmaBoxIds: () => [],
  getIdentityRecord: () => null,
  hasActiveVouchEscrow: () => false,
  vouchCooldownBlocks: 0,
  inviteBondMin: 0n,
  inviteBondMax: 0n,
  decayCfg: { staleThresholdBlocks: 0, decayIntervalBlocks: 0, decayAmount: 0n, karmaMinimum: 0n },
  storageRentPeriodBlocks: 0,
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
      getUsernameByOwner: () => null,
};

async function request(
  postId: string,
  body: unknown,
  executePostWithdrawImpl?: (deps: UtxoEngineDeps, tx: UtxoTransaction, height: number) => { txId: string; expiresAtHeight: number; tx: UtxoTransaction },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const deps = {
      ...STUB_DEPS,
      executePostWithdraw: executePostWithdrawImpl ?? ((_d: UtxoEngineDeps, t: UtxoTransaction, h: number) => ({ txId: 'c'.repeat(64), expiresAtHeight: h + MEMPOOL_EXPIRY_BLOCKS, tx: t })),
      getCurrentHeight: () => 10,
    };
    const app = express();
    app.use(express.json());
    app.use(withdrawRoutes(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: `/posts/${postId}/withdraw`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      if (body !== undefined) {
        r.write(JSON.stringify(body));
      }
      r.end();
    });
  });
}

const TEST_POST_HASH = 'd'.repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withdraw route', () => {
  afterEach(() => {
    setNet(null as unknown as Parameters<typeof setNet>[0]);
  });

  it('POST /posts/:id/withdraw with a postWithdraw transaction returns 201', async () => {
    const res = await request(TEST_POST_HASH, { tx: makeJsonPostWithdrawTxBody() });
    expect(res.status).toBe(201);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('submitted');
    expect(typeof body.txId).toBe('string');
    expect(body.postId).toBe(TEST_POST_HASH);
    expect(body.expiresAtHeight).toBe(11 + MEMPOOL_EXPIRY_BLOCKS);
  });

  it('POST /posts/:id/withdraw without tx field returns 400', async () => {
    const res = await request(TEST_POST_HASH, {});
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('postWithdraw transaction');
  });

  it('POST /posts/:id/withdraw without postWithdraw payload returns 400', async () => {
    const txBody = makeJsonPostWithdrawTxBody();
    delete txBody.postWithdraw;
    const res = await request(TEST_POST_HASH, { tx: txBody });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain('postWithdraw transaction');
  });

  it('POST /posts/:id/withdraw returns 400 when executePostWithdraw throws ClientError', async () => {
    const { ClientError } = await import('../../src/services/client-error.js');
    const res = await request(TEST_POST_HASH, { tx: makeJsonPostWithdrawTxBody() }, () => {
      throw new ClientError('Post is not confirmed in an earlier block');
    });
    expect(res.status).toBe(400);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toBe('Post is not confirmed in an earlier block');
  });

  it('POST /posts/:id/withdraw — a conflicting spend answers 409 naming the box', async () => {
    const { PendingSpendConflictError } = await import('../../src/store/mempool.js');
    const boxId = 'ab'.repeat(32);
    const res = await request(TEST_POST_HASH, { tx: makeJsonPostWithdrawTxBody() }, () => {
      throw new PendingSpendConflictError(boxId);
    });
    expect(res.status).toBe(409);
    const body = res.data as Record<string, unknown>;
    expect(body.error).toContain(boxId);
    expect(body.error).toMatch(/already spent by a pending/i);
  });

  it('POST /posts/:id/withdraw returns 500 for unexpected errors', async () => {
    const res = await request(TEST_POST_HASH, { tx: makeJsonPostWithdrawTxBody() }, () => {
      throw new Error('unexpected');
    });
    expect(res.status).toBe(500);
  });

  it('POST /posts/:id/withdraw whose matching postId is pooled is 201', async () => {
    // The matching case holds on both sides of the parameter check
    // (NODE_INTERFACE → Withdrawal, "the route holds the payload's `postId` to
    // `:id`"): the stub pools and the route reports submitted.
    const res = await request(TEST_POST_HASH, { tx: makeJsonPostWithdrawTxBody() });
    expect(res.status).toBe(201);
    expect((res.data as Record<string, unknown>).postId).toBe(TEST_POST_HASH);
  });

  it('POST /posts/:id/withdraw whose payload names a different post is refused 400', async () => {
    // NODE_INTERFACE → Withdrawal, "the route holds the payload's `postId` to
    // `:id`": the stub would pool, but the rule's answer is 400 before the
    // service is called.
    const otherId = 'e'.repeat(64);
    const res = await request(otherId, { tx: makeJsonPostWithdrawTxBody() });
    expect(res.status).toBe(400);
  });

  it('broadcasts the pooled postWithdraw transaction to peers', async () => {
    const broadcastTx = vi.fn((_tx: UtxoTransaction) => Promise.resolve());
    setNet({ broadcastTx } as unknown as Parameters<typeof setNet>[0]);

    let captured: UtxoTransaction | undefined;
    const res = await request(TEST_POST_HASH, { tx: makeJsonPostWithdrawTxBody() }, (_deps, tx, h) => {
      captured = tx;
      return { txId: 'c'.repeat(64), expiresAtHeight: h + MEMPOOL_EXPIRY_BLOCKS, tx };
    });

    expect(res.status).toBe(201);
    expect(broadcastTx).toHaveBeenCalledTimes(1);
    const sent = broadcastTx.mock.calls[0]![0] as UtxoTransaction;
    expect(computeTxId(sent)).toBe(computeTxId(captured!));
  });
});

// ---------------------------------------------------------------------------
// MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
// before anything reads state."
// NODE_INTERFACE → Service Layer Architecture → "A transaction the pool
// already holds is answered as held."
// ---------------------------------------------------------------------------
describe('a resubmit is answered as held', () => {
  let heldDir: string;
  let author: TestIdentity;
  let postId: string;
  let postTx: UtxoTransaction;
  let broadcastTx: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

  function heldDeps(): WithdrawDeps {
    const db = getDb();
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => { storeInsertBox(box); },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaOwed: admissionOwed({
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      }),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      getOwnKarmaBoxIds: (owner: Uint8Array) =>
        getKarmaBoxes(owner).filter((b) => b.income !== true).map((b) => b.id!),
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: getTopologyAuthorBytes,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => { (db.transaction(fn) as () => void)(); },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner: () => null,
      executePostWithdraw,
      getCurrentHeight,
    };
  }

  async function send(txJson: Record<string, unknown>, pid: string): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve) => {
      const app = express();
      app.use(express.json());
      app.use(withdrawRoutes(heldDeps()));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const r = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path: `/posts/${pid}/withdraw`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              server.close();
              try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) }); }
              catch { resolve({ status: res.statusCode ?? 0, data: d }); }
            });
          },
        );
        r.write(JSON.stringify({ tx: txJson }));
        r.end();
      });
    });
  }

  function buildWithdrawTx(karmaBox: KarmaBox): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
    const tx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [{ boxType: 'karma', value: karmaBox.value, createdAtBlock: 0, owner: author.userId } as never],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId },
    };
    signTransaction(tx, author.privateKey, toHex(author.userId));
    // `txToJson` carries `likeTarget` and no other envelope. The HTTP edge
    // reads `postWithdraw` through `checkRequestTx`, so the resubmit's JSON
    // body states it alongside the common fields.
    return { tx, txJson: { ...txToJson(tx), postWithdraw: { postId } } };
  }

  beforeAll(async () => {
    heldDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-held-withdraw-'));
    initDb(join(heldDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    author = makeTestIdentity();

    broadcastTx = vi.fn((_tx: UtxoTransaction) => Promise.resolve()) as unknown as typeof broadcastTx;
    const netStub = {
      penalizePeer: () => {},
      chainMoved: () => {},
      needHeaders: () => {},
      broadcastOrderingBlock: async () => {},
      broadcastTx,
      getConnectedPeers: () => [],
      tipApplied: () => {},
      setKarmaMembers: () => {},
      addKarmaMember: () => {},
      removeKarmaMember: () => {},
      requestPostBodies: async () => [],
    };
    setNet(netStub as unknown as Parameters<typeof setNet>[0]);

    // The post is seeded, then the block carrying its creating transaction is
    // applied through the intake. `executePostWithdraw` reads
    // `getTopologyHeight(postId) < currentBlockHeight`, so the post must sit
    // in a block below the one admission judges at.
    const seeded = await seedPostTx(author, 'withdraw-held-arm');
    postTx = seeded.tx;
    postId = seeded.postId;
    insertPost(postId, computeTxId(postTx), seeded.commit, seeded.content);

    await liveProver();
    const block = await makeApplicableBlock({ height: 1, utxoTxs: [postTx] });
    expect(await applyBlockThroughIntake(block)).toBe(true);
  });

  afterAll(() => {
    setNet(null as unknown as Parameters<typeof setNet>[0]);
    closeDb();
    rmSync(heldDir, { recursive: true, force: true });
  });

  it('POST /posts/:id/withdraw', async () => {
    const { tx, txJson } = buildWithdrawTx(changeBoxOf(postTx));

    const r1 = await send(txJson, postId);
    expect(r1.status, JSON.stringify(r1.data)).toBe(201);

    const block = await makeApplicableBlock({ height: 2 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await send(txJson, postId);
    expect(r2.status).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);
    expect((r2.data as Record<string, unknown>).expiresAtHeight)
      .toBe((r1.data as Record<string, unknown>).expiresAtHeight);

    const calls = broadcastTx.mock.calls;
    expect(calls.length).toBe(publishesBefore + 1);
    const sentTx = calls[publishesBefore]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(computeTxId(sentTx)).toBe(computeTxId(tx));
  });

  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state": the signatures ride outside the id preimage
  // (TYPES_INTERFACE → Layout — UtxoTransaction), so a resubmit whose
  // signature bytes differ shares the pooled entry's id, and the publish
  // reads the pooled bytes.
  it('other signature bytes, one id', async () => {
    const author2 = makeTestIdentity();
    const seeded = await seedPostTx(author2, 'withdraw-swap-arm');
    const postTx2 = seeded.tx;
    const postId2 = seeded.postId;
    insertPost(postId2, computeTxId(postTx2), seeded.commit, seeded.content);
    const seedBlock = await makeApplicableBlock({ height: getCurrentHeight() + 1, utxoTxs: [postTx2] });
    expect(await applyBlockThroughIntake(seedBlock)).toBe(true);

    // The withdraw transaction is built after the author's post is confirmed —
    // `executePostWithdraw` reads `getTopologyHeight(postId) < currentBlockHeight`.
    const authorHex = toHex(author2.userId);
    const tx: UtxoTransaction = {
      inputs: [changeBoxOf(postTx2).id!],
      outputs: [{ boxType: 'karma', value: changeBoxOf(postTx2).value, createdAtBlock: 0, owner: author2.userId } as never],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId: postId2 },
    };
    signTransaction(tx, author2.privateKey, authorHex);
    const txJson = { ...txToJson(tx), postWithdraw: { postId: postId2 } };

    const r1 = await send(txJson, postId2);
    expect(r1.status, JSON.stringify(r1.data)).toBe(201);

    const block = await makeApplicableBlock({ height: getCurrentHeight() + 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const otherSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) otherSig[i] = i + 1;
    const otherTxJson = {
      ...txJson,
      signatures: { [authorHex]: Buffer.from(otherSig).toString('hex') },
    };

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await send(otherTxJson, postId2);
    expect(r2.status).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);

    const calls = broadcastTx.mock.calls;
    expect(calls.length).toBe(publishesBefore + 1);
    const sentTx = calls[publishesBefore]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    const requestTx: UtxoTransaction = { ...tx, signatures: { [authorHex]: otherSig } };
    const requestBytes = Buffer.from(encodeTx(requestTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
    expect(sentBytes).not.toBe(requestBytes);
  });
});
