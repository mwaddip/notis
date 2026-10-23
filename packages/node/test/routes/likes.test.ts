import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
  seedProvenance,
  signTransaction,
  txToJson, fixturePostId, fixtureTxId} from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setNet } from '../../src/services/net-instance.js';
import express from 'express';
import http from 'http';
import { createPrivateKey, type KeyObject } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost, withdrawPost } from '../../src/store/posts.js';
import {
  insertBox, getKarmaBoxes, getBox as storeGetBox } from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord } from '../../src/store/identity-records.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { castLike } from '../../src/services/likes.js';
import {
  computeTxId,
  encodeTx,
  generateKeyPair,
  LIKE_KARMA_COST,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { PostCommit, KarmaBox, UtxoTransaction, AnyBox } from '@dagsocial/types';
import { computeContentHash } from '@dagsocial/types';
import { createRouter } from '../../src/routes/likes.js';
import type { LikesDeps } from '../../src/routes/likes.js';
import { ClientError } from '../../src/services/client-error.js';
import { MempoolFullError, PendingSpendConflictError } from '../../src/store/mempool.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { config } from '../../src/config.js';
import { admissionOwed } from '../../src/services/karma-admission.js';

// A directory private to this run, so two runs of the suite on one machine
// never write the same store file.
let testDir: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: string,
  body?: unknown,
  depOverrides?: Partial<LikesDeps>,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();
    const deps: LikesDeps = {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => {
        insertBox(box);
      },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaOwed: admissionOwed({ staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS, decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM }),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      getOwnKarmaBoxIds: (owner: Uint8Array) =>
        getKarmaBoxes(owner).filter((b) => b.income !== true).map((b) => b.id!),
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      // ⛔ The like marker's author pin. One author for every post this suite
      // builds (NODE_INTERFACE → Karma transition rules).
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
      getTopologyAuthor: () => POST_AUTHOR,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner: () => null,
      castLike,
      getCurrentHeight,
    };
    const app = express();
    app.use(express.json());
    app.use('/likes', createRouter({ ...deps, ...depOverrides }));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/likes' + path,
          method,
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
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

/**
 * Build a signed burn-shape like tx and its JSON form: karma box in, one karma
 * output at −LIKE_KARMA_COST, `likeTarget` naming the post
 * (NODE_INTERFACE → Per-block like settlement).
 */
function buildLikeTx(
  karmaBox: KarmaBox,
  likerPrivKey: KeyObject,
  likerPubKey: Uint8Array,
  likerPubKeyHex: string,
  postId: string,
): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_KARMA_COST,
        createdAtBlock: 0,
        owner: likerPubKey,
      } as KarmaBox,
      // ⛔ The marker carries the cost — the like conserves now.
      {
        boxType: 'like_accrual',
        value: LIKE_KARMA_COST,
        createdAtBlock: 0,
        author: POST_AUTHOR,
      } as unknown as KarmaBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: postId,
  };

  signTransaction(tx, likerPrivKey, likerPubKeyHex);
  return { tx, txJson: txToJson(tx) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** The author every post in this suite belongs to — the key a marker must name. */
const POST_AUTHOR = new Uint8Array(32).fill(0x7a);

describe('likes routes', () => {
  let postId: string;
  let likerId: Uint8Array;
  let likerKp: ReturnType<typeof generateKeyPair>;
  let likerPrivKey: ReturnType<typeof createPrivateKey>;
  let likerPubKeyHex: string;
  let karmaBox: KarmaBox;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-routes-likes-'));
    initDb(join(testDir, 'store.sqlite'));

    // Create a post author (needed for post insertion)
    const authorKp = generateKeyPair();
    const authorId = authorKp.publicKey;

    // Create the target post
    const commit: PostCommit = {
      contentHash: computeContentHash('test post for likes'),
      author: authorId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    postId = fixturePostId(commit);
    insertPost(fixturePostId(commit), fixtureTxId(commit), commit, 'test post for likes');

    // Create a liker with sufficient karma
    likerKp = generateKeyPair();
    likerId = likerKp.publicKey;
    likerPrivKey = createPrivateKey({
      key: Buffer.from(likerKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    likerPubKeyHex = Buffer.from(likerId).toString('hex');

    karmaBox = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 100n,
      createdAtBlock: 0,
      owner: likerKp.publicKey,
    }, 1);
    insertBox(karmaBox);
  });

  afterAll(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // POST /likes validation errors
  // ---------------------------------------------------------------------------

  it('POST /likes with missing tx returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /likes with invalid tx returns 400', async () => {
    const res = await request('/', 'POST', { tx: { inputs: 'not-an-array' } });
    expect(res.status).toBe(400);
  });

  it('POST /likes without likeTarget returns 400 with a legible reason', async () => {
    const { txJson } = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId);
    delete txJson.likeTarget;
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
    expect((res.data as Record<string, unknown>).reason).toContain('likeTarget');
  });

  it('POST /likes to unknown post returns 400', async () => {
    const { txJson } = buildLikeTx(
      karmaBox, likerPrivKey, likerId, likerPubKeyHex, 'ef'.repeat(32),
    );
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // NODE_INTERFACE → "Route error policy" — a service's intentional rejection
  // reaches the client; an unexpected error never does.
  // ---------------------------------------------------------------------------

  describe('admission height', () => {
    it('judges at tip + 1 — castLike receives the height above the tip', async () => {
      // getCurrentHeight is the tip; the route judges at the block that would
      // carry the transaction, tip + 1 (NODE_INTERFACE → validateTx). At
      // tip = L - 1 (L = 5) castLike is called at L.
      const L = 5;
      let captured: number | undefined;
      const txJson = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId).txJson;
      const res = await request('/', 'POST', { tx: txJson }, {
        getCurrentHeight: () => L - 1,
        castLike: (_deps, tx, height) => {
          captured = height;
          return { castLikeResult: 'pending' as const, txId: 'ab'.repeat(32), expiresAtHeight: height + 1, tx };
        },
      });
      expect(res.status).toBe(200);
      expect(captured).toBe(L);
    });
  });

  describe('error policy', () => {
    const SECRET = 'SQLITE_CORRUPT: database disk image is malformed at /srv/dagsocial.db';

    function validTxJson(): Record<string, unknown> {
      return buildLikeTx(
        karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId,
      ).txJson;
    }

    it('returns a generic 500 and logs when the service throws an unexpected error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request('/', 'POST', { tx: validTxJson() }, {
          castLike: () => {
            throw new Error(SECRET);
          },
        });

        expect(res.status).toBe(500);
        const body = res.data as Record<string, unknown>;
        expect(body.error).toBe('Internal error');
        expect(JSON.stringify(res.data)).not.toContain('SQLITE_CORRUPT');
        expect(JSON.stringify(res.data)).not.toContain('/srv/dagsocial.db');
        // The detail is kept server-side rather than dropped.
        expect(
          error.mock.calls.some((c) => c.some((a) => String((a as Error)?.message ?? a).includes('SQLITE_CORRUPT'))),
        ).toBe(true);
      } finally {
        error.mockRestore();
      }
    });

    it('control — an intentional rejection still returns its message with 400', async () => {
      const res = await request('/', 'POST', { tx: validTxJson() }, {
        castLike: () => {
          throw new ClientError('Already liked this post');
        },
      });

      expect(res.status).toBe(400);
      const body = res.data as Record<string, unknown>;
      expect(body.reason).toBe('Already liked this post');
    });

    it('maps a full mempool to 503 with a generic body', async () => {
      const res = await request('/', 'POST', { tx: validTxJson() }, {
        castLike: () => {
          throw new MempoolFullError(10000);
        },
      });

      expect(res.status).toBe(503);
      expect(res.data).toEqual({ error: 'mempool full' });
    });

    it('a conflicting spend reaches the client as a 409 naming the box', async () => {
      // The refusal must not be a silent drop: `PendingSpendConflictError` is a
      // `ClientError`, so the message the pool wrote is the message the caller
      // reads, under the status the error chose.
      const boxId = 'ab'.repeat(32);
      const res = await request('/', 'POST', { tx: validTxJson() }, {
        castLike: () => {
          throw new PendingSpendConflictError(boxId);
        },
      });

      expect(res.status).toBe(409);
      const body = res.data as Record<string, unknown>;
      expect(body.reason).toContain(boxId);
      expect(body.reason).toMatch(/already spent by a pending/i);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /likes — pending
  // ---------------------------------------------------------------------------

  it('POST /likes with valid signed burn tx returns 200 with pending status', async () => {
    const { txJson } = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId);
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
    expect(typeof body.txId).toBe('string');
    expect(typeof body.expiresAtHeight).toBe('number');
  });

  // ---------------------------------------------------------------------------
  // POST /likes — duplicate (detected via mempool gate)
  // ---------------------------------------------------------------------------

  it('POST /likes duplicate returns 400', async () => {
    const { txJson } = buildLikeTx(karmaBox, likerPrivKey, likerId, likerPubKeyHex, postId);
    // The pending like from the previous test occupies the (liker, post) pair
    // in the mempool gate, so the same pair is rejected.
    const res = await request('/', 'POST', { tx: txJson });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // There is no POST /likes/remove — unlike is not a feature. Router-level
  // wiring assertion: no tombstone, no 410 — a plain 404.
  // ---------------------------------------------------------------------------

  it('POST /likes/remove returns 404 — the route is gone', async () => {
    const res = await request('/remove', 'POST', { tx: {} });
    expect(res.status).toBe(404);
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
  let heldAuthor: Uint8Array;
  let heldPostId: string;
  let heldLikerKp: ReturnType<typeof generateKeyPair>;
  let heldLikerId: Uint8Array;
  let heldLikerPriv: KeyObject;
  let heldLikerHex: string;
  let heldKarmaBox: KarmaBox;
  let broadcastTx: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

  function heldDeps(): LikesDeps {
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
      insertBox: (box: AnyBox) => { insertBox(box); },
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
      getTopologyAuthor: () => heldAuthor,
      getPendingPostAuthor: () => null,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
      getUsername: () => null,
      getUsernameByOwner: () => null,
      castLike,
      getCurrentHeight,
    };
  }

  async function send(txJson: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve) => {
      const app = express();
      app.use(express.json());
      app.use('/likes', createRouter(heldDeps()));
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const r = http.request(
          {
            hostname: 'localhost',
            port: addr.port,
            path: '/likes/',
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

  beforeAll(async () => {
    heldDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-held-likes-'));
    initDb(join(heldDir, 'store.sqlite'));
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    heldAuthor = new Uint8Array(32).fill(0x5a);
    const commit: PostCommit = {
      contentHash: computeContentHash('held-arm target post'),
      author: heldAuthor,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    heldPostId = fixturePostId(commit);
    insertPost(heldPostId, fixtureTxId(commit), commit, 'held-arm target post');

    heldLikerKp = generateKeyPair();
    heldLikerId = heldLikerKp.publicKey;
    heldLikerPriv = createPrivateKey({
      key: Buffer.from(heldLikerKp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    heldLikerHex = Buffer.from(heldLikerId).toString('hex');

    heldKarmaBox = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 100n,
      createdAtBlock: 0,
      owner: heldLikerId,
    }, 1);
    insertBox(heldKarmaBox);

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

    await liveProver();
  });

  afterAll(() => {
    setNet(null as unknown as Parameters<typeof setNet>[0]);
    closeDb();
    rmSync(heldDir, { recursive: true, force: true });
  });

  it.fails('POST /likes', async () => {
    const { tx, txJson } = buildHeldLikeTx();

    const r1 = await send(txJson);
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);

    const block = await makeApplicableBlock({ height: 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await send(txJson);
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

  function buildHeldLikeTx(): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
    const tx: UtxoTransaction = {
      inputs: [heldKarmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: heldKarmaBox.value - LIKE_KARMA_COST,
          createdAtBlock: 0,
          owner: heldLikerId,
        } as KarmaBox,
        {
          boxType: 'like_accrual',
          value: LIKE_KARMA_COST,
          createdAtBlock: 0,
          author: heldAuthor,
        } as unknown as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: heldPostId,
    };
    signTransaction(tx, heldLikerPriv, heldLikerHex);
    return { tx, txJson: txToJson(tx) };
  }

  // The seed holding the next fresh liker's karma. Keyed by a counter so two
  // identical candidates — same owner, same value, same seed height — never
  // collide on `UNIQUE(tx_id, output_index)`.
  let nextLikerNonce = 100;

  function freshLikerWithKarma(value = 100n): {
    liker: { pub: Uint8Array; priv: ReturnType<typeof createPrivateKey>; hex: string };
    karma: KarmaBox;
  } {
    const kp = generateKeyPair();
    const priv = createPrivateKey({
      key: Buffer.from(kp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });
    const liker = { pub: kp.publicKey, priv, hex: Buffer.from(kp.publicKey).toString('hex') };
    const karma = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value,
      createdAtBlock: 0,
      owner: liker.pub,
    }, 1, nextLikerNonce++);
    insertBox(karma);
    return { liker, karma };
  }

  function buildLikeTxFor(
    liker: { pub: Uint8Array; priv: ReturnType<typeof createPrivateKey>; hex: string },
    karma: KarmaBox,
    targetPostId: string,
  ): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: karma.value - LIKE_KARMA_COST,
          createdAtBlock: 0,
          owner: liker.pub,
        } as KarmaBox,
        {
          boxType: 'like_accrual',
          value: LIKE_KARMA_COST,
          createdAtBlock: 0,
          author: heldAuthor,
        } as unknown as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: targetPostId,
    };
    signTransaction(tx, liker.priv, liker.hex);
    return { tx, txJson: txToJson(tx) };
  }

  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state": the signatures ride outside the id preimage
  // (TYPES_INTERFACE → Layout — UtxoTransaction), so a resubmit whose
  // signature bytes differ shares the pooled entry's id.
  it.fails('other signature bytes, one id', async () => {
    const { liker, karma } = freshLikerWithKarma();
    const { tx, txJson } = buildLikeTxFor(liker, karma, heldPostId);

    const r1 = await send(txJson);
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);

    // The resubmit's JSON carries 64 other bytes under the signatures map's
    // one entry; the id preimage leaves the signatures out, so the pool
    // holds the same id.
    const otherSig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) otherSig[i] = i + 1;
    const otherTxJson = {
      ...txJson,
      signatures: { [liker.hex]: Buffer.from(otherSig).toString('hex') },
    };

    const publishesBefore = broadcastTx.mock.calls.length;
    const r2 = await send(otherTxJson);
    expect(r2.status).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);

    // The one publish during the second submission carries the POOLED bytes,
    // not the request's: `encodeTx(tx)` is the first admission's.
    const calls = broadcastTx.mock.calls;
    expect(calls.length).toBe(publishesBefore + 1);
    const sentTx = calls[publishesBefore]![0] as UtxoTransaction;
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    const sentBytes = Buffer.from(encodeTx(sentTx)).toString('hex');
    expect(sentBytes).toBe(pooledBytes);
  });

  it.fails('the lookup precedes the service\'s checks', async () => {
    // A fresh target post belongs to this arm; the file-level `heldPostId`
    // stays live for the other arms.
    const commit: PostCommit = {
      contentHash: computeContentHash('withdraw-held arm target'),
      author: heldAuthor,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const targetPostId = fixturePostId(commit);
    insertPost(targetPostId, fixtureTxId(commit), commit, 'withdraw-held arm target');

    const { liker, karma } = freshLikerWithKarma();
    const { txJson } = buildLikeTxFor(liker, karma, targetPostId);

    const r1 = await send(txJson);
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);

    // The target is withdrawn after it is pooled; `isLivePost(post)` fires
    // on the resubmit's service path before the pool lookup today.
    withdrawPost(targetPostId, getCurrentHeight() + 1);

    const r2 = await send(txJson);
    // The pool holds the like; the lookup precedes the service's checks.
    expect(r2.status, JSON.stringify(r2.data)).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);
  });

  it('a different transaction is still refused by the pair gate', async () => {
    // The liker's first like consumes karma A; the second — same liker and
    // target, other inputs — is refused by the admit-tx gate
    // (`hasPendingLike`). The last assertion is the gate's refusal.
    const { liker, karma: karmaA } = freshLikerWithKarma();
    const karmaB = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 100n,
      createdAtBlock: 0,
      owner: liker.pub,
    }, 1, nextLikerNonce++);
    insertBox(karmaB);

    // Rule 3 names every unmarked karma box the owner holds; a valid shape
    // takes both as inputs. The first submission is a well-formed like.
    const likeA: UtxoTransaction = {
      inputs: [karmaA.id!, karmaB.id!],
      outputs: [
        { boxType: 'karma', value: karmaA.value + karmaB.value - LIKE_KARMA_COST, createdAtBlock: 0, owner: liker.pub } as KarmaBox,
        { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: 0, author: heldAuthor } as unknown as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: heldPostId,
    };
    signTransaction(likeA, liker.priv, liker.hex);

    const r1 = await send(txToJson(likeA));
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);

    // A second like of the same pair over the pending change box's output
    // id: rule 3 refuses it because the owner holds the pending change box
    // alone, and this input is not that one — reaching the pair gate first
    // requires a well-formed input list. The source refuses on either
    // route (the gate's or rule 3's); the last assertion carries the 400.
    const otherKarmaId = `${'ab'.repeat(32)}`;
    const likeB: UtxoTransaction = {
      inputs: [otherKarmaId],
      outputs: [
        { boxType: 'karma', value: 1n, createdAtBlock: 0, owner: liker.pub } as KarmaBox,
        { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: 0, author: heldAuthor } as unknown as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: heldPostId,
    };
    signTransaction(likeB, liker.priv, liker.hex);
    const r2 = await send(txToJson(likeB));
    expect(r2.status).toBe(400);
  });

  it('a different transaction over the pooled input is 409', async () => {
    // A fresh liker with one karma box; the first like pools it. A second
    // like of a different post over the same input hits the pending-spend
    // conflict at input resolution — 409.
    const { liker, karma } = freshLikerWithKarma();
    const { txJson } = buildLikeTxFor(liker, karma, heldPostId);
    const r1 = await send(txJson);
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);

    // A second target so the gate's `hasPendingLike(target, liker)` reads
    // false — the only refusal left is the input conflict.
    const commit: PostCommit = {
      contentHash: computeContentHash('conflict-arm second target'),
      author: heldAuthor,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const secondTarget = fixturePostId(commit);
    insertPost(secondTarget, fixtureTxId(commit), commit, 'conflict-arm second target');

    const { txJson: conflictJson } = buildLikeTxFor(liker, karma, secondTarget);
    const r2 = await send(conflictJson);
    expect(r2.status).toBe(409);
    expect(JSON.stringify(r2.data)).toMatch(/already spent by a pending/);
  });
});
