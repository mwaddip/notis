import {
  rawPublicKey,
  seedProvenance,
  signTransaction,
  txToJson,
  fixturePostId, makePostCommit } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { generateKeyPairSync, createPrivateKey } from 'crypto';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { insertPost, getPost, queryPostsPage, getAncestorsNearest, getSubtreePage, deletePostRows, confirmPost, withdrawPost } from '../../src/store/posts.js';
import { getCurrentHeight, getBlockCreatedAt } from '../../src/store/ordering.js';
import {
  getKarmaBox,
  getKarmaBoxes,
  insertBox,
  getBox as storeGetBox,
} from '../../src/store/utxo.js';
import { getIdentityRecord as storeGetIdentityRecord } from '../../src/store/identity-records.js';
import { hasActiveVouchEscrow } from '../../src/store/utxo.js';
import { getLikeRecordCount, hasLikeRecord, insertLikeRecord } from '../../src/store/likes.js';
import { insertUtxoTx, getPendingEntries } from '../../src/store/mempool.js';
import { verifyPost } from '../../src/services/verifier.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import {
  generateKeyPair,
  computeContentHash,
  PROTOCOL_VERSION,
  computePostId,
  POST_PRICE_THREAD,
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
  KarmaPriceBox,
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
      queryPostsPage,
      verifyPost: overrides?.verifyPost ?? verifyPost,
      getKarmaBoxes,
      getIdentityRecord: storeGetIdentityRecord,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getKarmaBox,
      getLikeRecordCount,
      hasLikeRecord,
      getAncestorsNearest,
      getSubtreePage,
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
            storageRentPeriodBlocks: 40,
            getBoxProvenance: () => null,
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
  // Success case: post transaction and content admitted as pending
  // -----------------------------------------------------------------------

  it('POST /posts with valid post transaction and content is admitted as pending', async () => {
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
      value: 100n - POST_PRICE_THREAD,
      createdAtBlock: 0,
      owner: userId,
    }, 1);

    const priceBox: CandidateOf<KarmaPriceBox> = {
      boxType: 'karma_price',
      value: POST_PRICE_THREAD,
      createdAtBlock: 0,
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
      outputs: [newKarma, priceBox],
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

  it('GET /posts returns the paged shape', async () => {
    const res = await request('/', 'GET');
    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(Array.isArray(body['posts'])).toBe(true);
    expect(Array.isArray(body['pending'])).toBe(true);
    expect(typeof body['pendingCount']).toBe('number');
  });

  // -----------------------------------------------------------------------
  // Integer bounds on limit and after (NODE_INTERFACE → Posts)
  // -----------------------------------------------------------------------

  it('GET /posts?limit=-1 returns 400', async () => {
    const res = await request('/?limit=-1', 'GET');
    expect(res.status).toBe(400);
  });

  it('GET /posts?limit=abc returns 400', async () => {
    const res = await request('/?limit=abc', 'GET');
    expect(res.status).toBe(400);
  });

  it('GET /posts?after=malformed returns 400', async () => {
    const res = await request('/?after=malformed', 'GET');
    expect(res.status).toBe(400);
  });

  it('GET /posts?limit=200 clamps to 100 and returns 200', async () => {
    const res = await request('/?limit=200', 'GET');
    expect(res.status).toBe(200);
  });

  it('GET /posts?limit=0 returns 400', async () => {
    const res = await request('/?limit=0', 'GET');
    expect(res.status).toBe(400);
  });

  it('GET /posts with no params returns 200', async () => {
    const res = await request('/', 'GET');
    expect(res.status).toBe(200);
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
        ancestorCount: 0,
        descendants: [],
        descendantCount: 0,
        next: null,
        pending: [],
        pendingCount: 0,
      });
    });

    it('GET /posts stays live-only — the stump never appears in the feed', async () => {
      const res = await request('/', 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const feed = body['posts'] as Array<Record<string, unknown>>;
      expect(feed.some((p) => p['id'] === prunedRootId)).toBe(false);
      expect(feed.some((p) => p['kind'] === 'stump')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // viewer / likedByViewer
  // -----------------------------------------------------------------------

  describe('likedByViewer and viewer param', () => {
    let viewerHex: string;
    let viewerBytes: Uint8Array;
    let likedPostId: string;
    let unlikedPostId: string;

    beforeAll(() => {
      const keys = generateKeyPairSync('ed25519');
      const raw = keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      viewerBytes = new Uint8Array(raw.subarray(raw.length - 32));
      viewerHex = Buffer.from(viewerBytes).toString('hex');

      const authorKeys = generateKeyPairSync('ed25519');
      const authorRaw = authorKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      const author = new Uint8Array(authorRaw.subarray(authorRaw.length - 32));

      const commit1 = makePostCommit(author, 'liked post', { parentRefs: [] });
      likedPostId = fixturePostId(commit1);
      insertPost(likedPostId, commit1, 'liked post');
      confirmPost(likedPostId, 10, 0);
      insertLikeRecord(likedPostId, viewerBytes, 10);

      const commit2 = makePostCommit(author, 'unliked post', { parentRefs: [] });
      unlikedPostId = fixturePostId(commit2);
      insertPost(unlikedPostId, commit2, 'unliked post');
      confirmPost(unlikedPostId, 10, 1);
    });

    it('GET /posts?viewer= answers likedByViewer true for a liked post', async () => {
      const res = await request(`/?viewer=${viewerHex}`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const posts = body['posts'] as Array<Record<string, unknown>>;
      const liked = posts.find(p => p['id'] === likedPostId);
      expect(liked).toBeDefined();
      expect(liked!['likedByViewer']).toBe(true);
    });

    it('GET /posts?viewer= answers likedByViewer false for an unliked post', async () => {
      const res = await request(`/?viewer=${viewerHex}`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const posts = body['posts'] as Array<Record<string, unknown>>;
      const unliked = posts.find(p => p['id'] === unlikedPostId);
      expect(unliked).toBeDefined();
      expect(unliked!['likedByViewer']).toBe(false);
    });

    it('GET /posts without viewer answers likedByViewer null', async () => {
      const res = await request('/', 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const posts = body['posts'] as Array<Record<string, unknown>>;
      const post = posts.find(p => p['id'] === likedPostId);
      expect(post).toBeDefined();
      expect(post!['likedByViewer']).toBeNull();
    });

    it('GET /posts/:id?viewer= answers likedByViewer true', async () => {
      const res = await request(`/${likedPostId}?viewer=${viewerHex}`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect(body['likedByViewer']).toBe(true);
    });

    it('GET /posts?viewer=<bad> returns 400', async () => {
      const res = await request('/?viewer=tooshort', 'GET');
      expect(res.status).toBe(400);
      const body = res.data as Record<string, unknown>;
      expect(body['error']).toContain('viewer must be a 64-character hex string');
    });
  });

  // -----------------------------------------------------------------------
  // thread counts
  // -----------------------------------------------------------------------

  describe('thread pagination and counts', () => {
    let rootId: string;
    let childId: string;
    let grandchildId: string;
    let withdrawnRootId: string;
    let withdrawnChildId: string;

    beforeAll(() => {
      const keys = generateKeyPairSync('ed25519');
      const raw = keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      const author = new Uint8Array(raw.subarray(raw.length - 32));

      const c0 = makePostCommit(author, 'thread root', { parentRefs: [] });
      rootId = fixturePostId(c0);
      insertPost(rootId, c0, 'thread root');
      confirmPost(rootId, 20, 0);

      const c1 = makePostCommit(author, 'thread child', { parentRefs: [rootId] });
      childId = fixturePostId(c1);
      insertPost(childId, c1, 'thread child');
      confirmPost(childId, 21, 0);

      const c2 = makePostCommit(author, 'thread grandchild', { parentRefs: [childId] });
      grandchildId = fixturePostId(c2);
      insertPost(grandchildId, c2, 'thread grandchild');
      confirmPost(grandchildId, 22, 0);

      // A withdrawn root for the empty-thread test
      const cw = makePostCommit(author, 'withdrawn root', { parentRefs: [] });
      withdrawnRootId = fixturePostId(cw);
      insertPost(withdrawnRootId, cw, 'withdrawn root');
      confirmPost(withdrawnRootId, 23, 0);
      withdrawPost(withdrawnRootId, 24);

      const cwc = makePostCommit(author, 'withdrawn child', { parentRefs: [withdrawnRootId] });
      withdrawnChildId = fixturePostId(cwc);
      insertPost(withdrawnChildId, cwc, 'withdrawn child');
      confirmPost(withdrawnChildId, 23, 1);
    });

    it('thread?limit=1 on grandchild: one ancestor row, ancestorCount 2', async () => {
      const res = await request(`/${grandchildId}/thread?limit=1`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect((body['ancestors'] as unknown[]).length).toBe(1);
      expect(body['ancestorCount']).toBe(2);
    });

    it('thread descendants with after=<key of the first> skips the first', async () => {
      const res = await request(`/${rootId}/thread?limit=1&after=21:0`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const descs = body['descendants'] as Array<Record<string, unknown>>;
      expect(descs.length).toBe(1);
      expect(body['descendantCount']).toBe(2);
    });

    it('thread on a withdrawn subject: all lists empty, all counts 0, next null', async () => {
      const res = await request(`/${withdrawnRootId}/thread`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      expect(body['ancestors']).toEqual([]);
      expect(body['ancestorCount']).toBe(0);
      expect(body['descendants']).toEqual([]);
      expect(body['descendantCount']).toBe(0);
      expect(body['next']).toBeNull();
      expect(body['pending']).toEqual([]);
      expect(body['pendingCount']).toBe(0);
    });
  });
});
