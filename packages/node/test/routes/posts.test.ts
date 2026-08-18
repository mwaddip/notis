import {
  fixtureProvenance,
  rawPublicKey,
  seedProvenance,
  signTransaction,
  txToJson,
  uid, fixturePostId } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createHash, generateKeyPairSync, createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost, getPost, getPostRaw, queryPosts, getAncestors, getSubtree } from '../../src/store/posts.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
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
  encodePost,
  generateKeyPair,
  PROTOCOL_VERSION,
  computeBoxId,
  computePostId,
  POST_LOCK_THREAD_COST,
} from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  KarmaBox,
  PostLockBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { createRouter } from '../../src/routes/posts.js';
import { unlinkSync } from 'fs';

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
      getPostRaw,
      queryPosts,
      encodePost,
      verifyPost: overrides?.verifyPost ?? verifyPost,
      getKarmaBoxes,
      getKarmaBox,
      getLikeRecordCount,
      getLikersForPost,
      getAncestors,
      getSubtree,
      getCurrentHeight,
      admitTx: insertUtxoTx,
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
            // The three the hand-written deps object had fallen behind on.
            // Unreached by the karma-lock path this suite exercises, which is
            // why it stayed green — but an incomplete deps object throws the
            // moment a rule starts consulting one of them, and these wire to
            // the same store functions production does.
            getIdentityRecord: (identityId: Uint8Array) =>
              storeGetIdentityRecord(identityId),
            getKarmaValue: (owner: Uint8Array) =>
              getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
            hasActiveVouchEscrow: (voucherId: Uint8Array) =>
              hasActiveVouchEscrow(voucherId),
            vouchCooldownBlocks: 2,
            // No like reaches this router, so the marker's author pin has
            // nothing to resolve — stated rather than stubbed silently.
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

  it('POST /posts with an invalid hex author returns 400', async () => {
    const res = await request('/', 'POST', {
      tx: {
        inputs: ['11'.repeat(32)],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
        post: {
          content: 'test',
          author: 'not-hex!!@@',
          parentRefs: [],
          protocolVersion: 1,
          timestamp: Date.now(),
        },
      },
    });
    expect(res.status).toBe(400);
  });

  it('POST /posts with a transaction carrying no post returns 400', async () => {
    // The biconditional's request-shape half: a bare transaction is not a post
    // submission, and the route says so rather than inventing an empty payload.
    const res = await request('/', 'POST', {
      tx: {
        inputs: ['11'.repeat(32)],
        outputs: [],
        signatures: {},
        protocolVersion: 1,
      },
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

    // Setup: identity

    // Setup: karma box
    const karmaBox = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n,
      owner: userId,
    }, 1);
    const karmaBoxId = karmaBox.id;
    insertBox({ ...karmaBox, id: karmaBoxId });

    // Setup: challenge
    const challengeBytes = new Uint8Array(Buffer.from('cc'.repeat(32), 'hex'));

    const timestamp = Date.now();

    // Build karma-lock tx
    const newKarma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n - POST_LOCK_THREAD_COST,
      owner: userId,
    }, 1);
    const newKarmaId = newKarma.id;

    // ⛔ The lock names NO post. `targetPostId` is gone from `PostLockBox`
    // because a post's id comes from the transaction that creates the lock — the
    // field would have to be known before the `TxId` that produces it
    // (TYPES_INTERFACE → PostLockBox). The lock's target is the post riding the
    // same transaction, and the store indexes it at apply.
    const postLockBox: CandidateOf<PostLockBox> = {
      boxType: 'post_lock',
      value: POST_LOCK_THREAD_COST,
      originalValue: POST_LOCK_THREAD_COST,
      owner: userId,
    };

    const post = {
      content: 'hello mempool',
      author: userIdHex,
      parentRefs: [] as string[],
      protocolVersion: PROTOCOL_VERSION,
      timestamp,
    };

    const postTx: UtxoTransaction = {
      inputs: [karmaBoxId],
      outputs: [newKarma, postLockBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: { ...post, author: userId },
    };
    signTransaction(postTx, privKeyObj, userIdHex);
    const txJson = { ...txToJson(postTx), post };

    const mockVerify = () => ({ valid: true as const });

    const res = await request('/', 'POST', { tx: txJson },
      { verifyPost: mockVerify as typeof verifyPost });

    expect(res.status).toBe(200);

    const body = res.data as Record<string, unknown>;
    expect(body).toHaveProperty('postId');
    expect(body.status).toBe('pending');
    expect(typeof body.expiresAtHeight).toBe('number');

    // ⛔ ONE mempool entry, not two. The `batchId` that regrouped a post and its
    // lock is gone with the pair — asserting the COUNT is what catches a
    // reintroduced second insert.
    const entries = getPendingEntries(100);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe('utxo_tx');
    expect(entries[0]!.expiresAtHeight).toBe(body.expiresAtHeight);

    // …and the id the route reports is the one the transaction gives it.
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
  // Stumps over HTTP (NODE_INTERFACE → Posts, "Stump JSON shape").
  //
  // The service-level shape is pinned in feed-service.test.ts; these run the
  // response through `res.json`, which is where the defect actually showed:
  // the raw `Stump` went out with `authorId` — a Uint8Array — serialized
  // index-keyed as {"0":…,"1":…,…,"31":…}.
  // -----------------------------------------------------------------------

  describe('GET on a pruned root', () => {
    const stumpScalars = {
      replyCount: 3,
      upvoteCount: 2,
      trigger: 'storage_prune' as const,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: 11,
    };
    let stumpAuthor: Uint8Array;
    let prunedRootId: string;

    beforeAll(async () => {
      const { pruneSubtree } = await import('../../src/store/posts.js');
      const { insertStump } = await import('../../src/store/stumps.js');
      const keys = generateKeyPairSync('ed25519');
      stumpAuthor = rawPublicKey(keys.publicKey);

      const root = {
        content: 'doomed root',
        author: stumpAuthor,
        parentRefs: [] as string[],
        protocolVersion: PROTOCOL_VERSION,
        timestamp: 1_700_000_000_000,
      };
      const { computePostId } = await import('@dagsocial/types');
      prunedRootId = fixturePostId(root);
      insertPost(fixturePostId(root), root, encodePost(root));
      insertStump({ rootPostHash: prunedRootId, authorId: stumpAuthor, ...stumpScalars });
      pruneSubtree(prunedRootId);
    });

    it('GET /posts/:id answers 200 with the exact StumpJson', async () => {
      const res = await request(`/${prunedRootId}`, 'GET');
      // A stump is renderable tombstone data, not an absence — never a 404.
      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        kind: 'stump',
        id: prunedRootId,
        author: Buffer.from(stumpAuthor).toString('hex'),
        ...stumpScalars,
      });
      // The regression this closes: a 64-hex string, not an index-keyed object.
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
      // Verified rather than assumed: `queryPosts` selects
      // `FROM dag_posts WHERE status != 'pruned'` and maps every row through
      // `rowToPost`, so it reads no stump table at all.
      const res = await request('/', 'GET');
      expect(res.status).toBe(200);
      const feed = res.data as Array<Record<string, unknown>>;
      expect(feed.some((p) => p['id'] === prunedRootId)).toBe(false);
      expect(feed.some((p) => p['kind'] === 'stump')).toBe(false);
      expect(feed.every((p) => 'content' in p)).toBe(true);
    });
  });
});
