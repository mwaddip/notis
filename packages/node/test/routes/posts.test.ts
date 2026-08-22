import {
  fixtureProvenance,
  rawPublicKey,
  seedProvenance,
  signTransaction,
  txToJson,
  uid, fixturePostId, makePostCommit } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, generateKeyPairSync, createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost, getPost, queryPosts, getAncestors, getSubtree, deletePostRows } from '../../src/store/posts.js';
import { getCurrentHeight, getBlockCreatedAt } from '../../src/store/ordering.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  insertBox,
  getBox as storeGetBox,
} from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord } from '../../src/store/identity-records.js';
import { hasActiveVouchEscrow } from '../../src/store/utxo.js';
import { getLikeRecordCount } from '../../src/store/likes.js';
import { getLikersForPost } from '../../src/store/utxo.js';
import { insertUtxoTx, getPendingEntries } from '../../src/store/mempool.js';
import { verifyPost } from '../../src/services/verifier.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import {
  generateKeyPair,
  computeContentHash,
  PROTOCOL_VERSION,
  computeBoxId,
  computePostId,
  POST_LOCK_THREAD_COST,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  KarmaBox,
  PostCommit,
  PostLockBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { createRouter } from '../../src/routes/posts.js';
import { unlinkSync } from 'fs';
import { config } from '../../src/config.js';

const TEST_DB = '/tmp/dagsocial-test-routes-posts.sqlite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  path: string,
  method: string,
  body?: unknown,
  overrides?: {
    verifyPost?: typeof import('../../src/services/verifier.js').verifyPost;
  },
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const db = getDb();
    const deps = {
      insertPost,
      getPost,
      queryPosts,
      verifyPost: overrides?.verifyPost ?? verifyPost,
      getKarmaBoxes,
      getIdentityRecord: storeGetIdentityRecord,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      getKarmaBox,
      getLikeRecordCount,
      getLikersForPost,
      getAncestors,
      getSubtree,
      getBlockCreatedAt,
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      getTopologyAuthor: () => null,
      getCurrentHeight,
      admitTx: insertUtxoTx,
      runInTransaction: (fn: () => void) => db.transaction(fn)(),
      validateTx: (tx: UtxoTransaction, height: number) => {
        return validateTx(
          {
            getBox: (id: string): AnyBox | null => {
              const box = storeGetBox(id);
              if (!box) return null;
              const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
              return r && r.spent_at_block === null ? box : null;
            },
            insertBox: (box: AnyBox) => {
              insertBox(box);
            },
            consumeBox: (id: string, atBlock: number) => {
              db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
            },
            getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
            getIdentityRecord: (identityId: Uint8Array) =>
              storeGetIdentityRecord(identityId),
            getKarmaValue: (owner: Uint8Array) =>
              getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
            hasActiveVouchEscrow: (voucherId: Uint8Array) =>
              hasActiveVouchEscrow(voucherId),
            vouchCooldownBlocks: 2,
            inviteBondMin: config.inviteBondMin,
            inviteBondMax: config.inviteBondMax,
            decayCfg: {
              staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
              decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
              decayAmount: KARMA_DECAY_AMOUNT,
              karmaMinimum: KARMA_MINIMUM,
            },
            getTopologyAuthor: () => null,
            runInTransaction: (fn: () => void) => {
              (db.transaction(fn) as () => void)();
            },
          },
          tx,
          height,
        );
      },
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/posts', createRouter(deps));
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const r = http.request(
        {
          hostname: 'localhost',
          port: addr.port,
          path: '/posts' + path,
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

describe('posts routes', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it('POST /posts with missing fields returns 400', async () => {
    const res = await request('/', 'POST', {});
    expect(res.status).toBe(400);
  });

  it('POST /posts with an invalid hex contentHash returns 400', async () => {
    const res = await request('/', 'POST', {
      tx: {
        inputs: ['11'.repeat(32)],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
        post: {
          contentHash: 'not-hex!!@@',
          author: '00'.repeat(32),
          parentRefs: [],
          protocolVersion: 1,
          type: 'regular',
        },
      },
      content: 'test',
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts with a transaction carrying no post returns 400', async () => {
    const res = await request('/', 'POST', {
      tx: {
        inputs: ['11'.repeat(32)],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
      },
      content: 'test',
    });
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Success case: post -> mempool batch with karmaLockTx
  // -----------------------------------------------------------------------

  it('POST /posts with valid post and karmaLockTx inserts batch into mempool', async () => {
    const kp = generateKeyPair();
    const userId = kp.publicKey;
    const userIdHex = Buffer.from(userId).toString('hex');
    const privKeyObj = createPrivateKey({
      key: Buffer.from(kp.secretKey),
      format: 'der',
      type: 'pkcs8',
    });

    const karmaBox = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n,
      createdAtBlock: 0,
      owner: userId,
    }, 1);
    const karmaBoxId = karmaBox.id;
    insertBox({ ...karmaBox, id: karmaBoxId });

    const newKarma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n - POST_LOCK_THREAD_COST,
      createdAtBlock: 0,
      owner: userId,
    }, 1);
    const newKarmaId = newKarma.id;

    const postLockBox: CandidateOf<PostLockBox> = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      createdAtBlock: 0,
      originalValue: POST_LOCK_THREAD_COST,
      owner: userId,
    };

    const content = 'hello mempool';
    const commit: PostCommit = {
      contentHash: computeContentHash(content),
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };

    const postTx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [newKarma, postLockBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: commit,
    };
    signTransaction(postTx, privKeyObj, userIdHex);

    const postJson = {
      contentHash: Buffer.from(commit.contentHash).toString('hex'),
      author: userIdHex,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const txJson = { ...txToJson(postTx), post: postJson };

    const mockVerify = () => ({ valid: true as const });

    const res = await request('/', 'POST', { tx: txJson, content },
      { verifyPost: mockVerify as typeof verifyPost });

    expect(res.status).toBe(200);

    const body = res.data as Record<string, unknown>;
    expect(body).toHaveProperty('postId');
    expect(body.status).toBe('pending');
    expect(typeof body.expiresAtHeight).toBe('number');

    const entries = getPendingEntries(100);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe('utxo_tx');
    expect(entries[0]!.expiresAtHeight).toBe(body.expiresAtHeight);

    expect(body.postId).toBe(computePostId(body.txId as string, 0));
  });

  // -----------------------------------------------------------------------
  // GET tests
  // -----------------------------------------------------------------------

  it('GET /posts/:id returns 404 for unknown post', async () => {
    const res = await request('/nonexistent-post-id', 'GET');
    expect(res.status).toBe(404);
  });

  it('GET /posts with pagination returns empty array when no posts', async () => {
    const res = await request('/', 'GET');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Stumps over HTTP
  // -----------------------------------------------------------------------

  describe('GET on a pruned root', () => {
    const stumpScalars = {
      replyCount: 3,
      upvoteCount: 2,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: 11,
    };
    let stumpAuthor: Uint8Array;
    let prunedRootId: string;

    beforeAll(async () => {
      const { insertStump } = await import('../../src/store/stumps.js');
      const keys = generateKeyPairSync('ed25519');
      stumpAuthor = rawPublicKey(keys.publicKey);

      const commit = makePostCommit(stumpAuthor, 'doomed root');
      prunedRootId = fixturePostId(commit);
      insertPost(prunedRootId, commit, 'doomed root');
      insertStump({ rootPostHash: prunedRootId, authorId: stumpAuthor, ...stumpScalars });
      deletePostRows([prunedRootId]);
    });

    it('GET /posts/:id answers 200 with the exact StumpJson', async () => {
      const res = await request(`/${prunedRootId}`, 'GET');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        kind: 'stump',
        id: prunedRootId,
        author: Buffer.from(stumpAuthor).toString('hex'),
        confirmedAuthor: null,
        ...stumpScalars,
      });
      const body = res.data as Record<string, unknown>;
      expect(typeof body['author']).toBe('string');
      expect(body['author']).toMatch(/^[0-9a-f]{64}$/);
      expect(body['authorId']).toBeUndefined();
      expect(JSON.stringify(res.data)).not.toContain('"0":');
    });

    it('GET /posts/:id/thread wraps the StumpJson in an empty thread', async () => {
      const res = await request(`/${prunedRootId}/thread`, 'GET');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        post: {
          kind: 'stump',
          id: prunedRootId,
          author: Buffer.from(stumpAuthor).toString('hex'),
          ...stumpScalars,
        },
        ancestors: [],
        descendants: [],
      });
    });

    it('GET /posts stays live-only — the stump never appears in the feed', async () => {
      const res = await request('/', 'GET');
      expect(res.status).toBe(200);
      const feed = res.data as Array<Record<string, unknown>>;
      expect(feed.some((p) => p['id'] === prunedRootId)).toBe(false);
      expect(feed.some((p) => p['kind'] === 'stump')).toBe(false);
    });
  });
});
