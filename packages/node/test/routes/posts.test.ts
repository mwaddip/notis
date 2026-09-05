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
import { insertPost, getPost, queryPostsPage, getAncestorsNearest, getSubtreePage, deletePostRows, confirmPost, withdrawPost, getPendingPostAuthor } from '../../src/store/posts.js';
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
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
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
  LikeAccrualBox,
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
      getPendingPostAuthor,
      getCurrentHeight,
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
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
            getPendingPostAuthor,
            runInTransaction: (fn: () => void) => {
              (db.transaction(fn) as () => void)();
            },
      getVouchBox: () => null,
      getNetworkRecord: () => ({ memberCount: 1 }),
      membershipBarMultiplier: 1,
      putIdentityRecord: () => {},
      protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
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

  it('POST /posts admits a reply whose parent is pending in the pool', async () => {
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
    insertBox({ ...karmaBox, id: karmaBox.id });

    // Insert a pending thread to be the reply's parent.
    const threadContent = 'pending thread';
    const threadCommit: PostCommit = {
      contentHash: computeContentHash(threadContent),
      author: userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const threadId = fixturePostId(threadCommit);
    insertPost(threadId, threadCommit, threadContent);

    const replyContent = 'reply to pending';
    const replyCommit: PostCommit = {
      contentHash: computeContentHash(replyContent),
      author: userId,
      parentRefs: [threadId],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };

    const changeKarma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value: 100n - POST_PRICE_REPLY,
      createdAtBlock: 0,
      owner: userId,
    }, 1);
    const priceBox: CandidateOf<KarmaPriceBox> = {
      boxType: 'karma_price',
      value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE,
      createdAtBlock: 0,
    };
    const accrualBox: CandidateOf<LikeAccrualBox> = {
      boxType: 'like_accrual',
      value: REPLY_AUTHOR_SHARE,
      createdAtBlock: 0,
      author: userId,
    };

    const replyTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [changeKarma, priceBox, accrualBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: replyCommit,
    };
    signTransaction(replyTx, privKeyObj, userIdHex);

    const postJson = {
      contentHash: Buffer.from(replyCommit.contentHash).toString('hex'),
      author: userIdHex,
      parentRefs: [threadId],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const txJson = { ...txToJson(replyTx), post: postJson };

    const mockVerify = () => ({ valid: true as const });
    const res = await request('/', 'POST', { tx: txJson, content: replyContent },
      { verifyPost: mockVerify as typeof verifyPost });

    expect(res.status).toBe(200);
    const body = res.data as Record<string, unknown>;
    expect(body.status).toBe('pending');
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
    let withdrawnSubjectParentId: string;
    let withdrawnSubjectId: string;
    let withdrawnSubjectChildId: string;

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

      // A live parent, a withdrawn reply beneath it, and a live reply beneath that.
      const cp = makePostCommit(author, 'a root whose reply is withdrawn', { parentRefs: [] });
      withdrawnSubjectParentId = fixturePostId(cp);
      insertPost(withdrawnSubjectParentId, cp, 'a root whose reply is withdrawn');
      confirmPost(withdrawnSubjectParentId, 23, 0);

      const cr = makePostCommit(author, 'the withdrawn reply', { parentRefs: [withdrawnSubjectParentId] });
      withdrawnSubjectId = fixturePostId(cr);
      insertPost(withdrawnSubjectId, cr, 'the withdrawn reply');
      confirmPost(withdrawnSubjectId, 23, 1);
      withdrawPost(withdrawnSubjectId, 24);

      const cg = makePostCommit(author, 'a live reply under the withdrawn one', { parentRefs: [withdrawnSubjectId] });
      withdrawnSubjectChildId = fixturePostId(cg);
      insertPost(withdrawnSubjectChildId, cg, 'a live reply under the withdrawn one');
      confirmPost(withdrawnSubjectChildId, 25, 0);
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

    it("thread on a withdrawn subject: its live ancestor and descendant answer as a live subject's would", async () => {
      const res = await request(`/${withdrawnSubjectId}/thread`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const post = body['post'] as Record<string, unknown>;
      expect(post['kind']).toBe('withdrawn');
      expect(post['parentRefs']).toEqual([withdrawnSubjectParentId]);
      const ancestors = body['ancestors'] as Array<Record<string, unknown>>;
      expect(ancestors.map((a) => a['id'])).toEqual([withdrawnSubjectParentId]);
      expect(body['ancestorCount']).toBe(1);
      const descendants = body['descendants'] as Array<Record<string, unknown>>;
      expect(descendants.map((d) => d['id'])).toEqual([withdrawnSubjectChildId]);
      expect(body['descendantCount']).toBe(1);
      expect(body['next']).toBeNull();
      expect(body['pending']).toEqual([]);
      expect(body['pendingCount']).toBe(0);
    });

    it("a withdrawn post between two live posts still appears in its child's ancestors", async () => {
      const res = await request(`/${withdrawnSubjectChildId}/thread`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const ancestors = body['ancestors'] as Array<Record<string, unknown>>;
      expect(ancestors.map((a) => a['id'])).toEqual([withdrawnSubjectParentId, withdrawnSubjectId]);
      expect(ancestors[0]!['kind']).toBeUndefined();
      expect(ancestors[1]).toMatchObject({
        kind: 'withdrawn',
        id: withdrawnSubjectId,
        withdrawnAtHeight: 24,
      });
      expect(body['ancestorCount']).toBe(2);
    });

    it("withdrawing the parent too: its thread carries the withdrawn reply and the reply's own reply", async () => {
      withdrawPost(withdrawnSubjectParentId, 26);
      const res = await request(`/${withdrawnSubjectParentId}/thread`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const post = body['post'] as Record<string, unknown>;
      expect(post['kind']).toBe('withdrawn');
      const descendants = body['descendants'] as Array<Record<string, unknown>>;
      expect(descendants.map((d) => d['id'])).toEqual([withdrawnSubjectId, withdrawnSubjectChildId]);
      expect(descendants[0]).toMatchObject({
        kind: 'withdrawn',
        id: withdrawnSubjectId,
        parentRefs: [withdrawnSubjectParentId],
      });
      expect(body['descendantCount']).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Withdrawn view carries parentRefs
  // NODE_INTERFACE → "The JSON projection has a fourth arm where the store
  // has three"
  // -----------------------------------------------------------------------

  describe('withdrawn post view carries parentRefs', () => {
    let author: Uint8Array;
    let liveRootId: string;
    let withdrawnReplyId: string;
    let withdrawnSoloRootId: string;

    beforeAll(() => {
      const keys = generateKeyPairSync('ed25519');
      author = rawPublicKey(keys.publicKey);

      const rootCommit = makePostCommit(author, 'a live root, later given a withdrawn reply', { parentRefs: [] });
      liveRootId = fixturePostId(rootCommit);
      insertPost(liveRootId, rootCommit, 'a live root, later given a withdrawn reply');
      confirmPost(liveRootId, 50, 0);

      const replyCommit = makePostCommit(author, 'a reply, later withdrawn', { parentRefs: [liveRootId] });
      withdrawnReplyId = fixturePostId(replyCommit);
      insertPost(withdrawnReplyId, replyCommit, 'a reply, later withdrawn');
      confirmPost(withdrawnReplyId, 51, 0);
      withdrawPost(withdrawnReplyId, 52);

      const soloRootCommit = makePostCommit(author, 'a root, later withdrawn', { parentRefs: [] });
      withdrawnSoloRootId = fixturePostId(soloRootCommit);
      insertPost(withdrawnSoloRootId, soloRootCommit, 'a root, later withdrawn');
      confirmPost(withdrawnSoloRootId, 53, 0);
      withdrawPost(withdrawnSoloRootId, 54);
    });

    it('GET /posts/:id on a withdrawn reply answers parentRefs equal to its parent', async () => {
      const res = await request(`/${withdrawnReplyId}`, 'GET');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        kind: 'withdrawn',
        id: withdrawnReplyId,
        author: Buffer.from(author).toString('hex'),
        parentRefs: [liveRootId],
        withdrawnAtHeight: 52,
        confirmedAuthor: null,
      });
    });

    it('GET /posts/:id on a withdrawn root answers parentRefs: []', async () => {
      const res = await request(`/${withdrawnSoloRootId}`, 'GET');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({
        kind: 'withdrawn',
        id: withdrawnSoloRootId,
        author: Buffer.from(author).toString('hex'),
        parentRefs: [],
        withdrawnAtHeight: 54,
        confirmedAuthor: null,
      });
    });

    it("the live root's thread carries the withdrawn reply's parentRefs in descendants", async () => {
      const res = await request(`/${liveRootId}/thread`, 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const descendants = body['descendants'] as Array<Record<string, unknown>>;
      const found = descendants.find((d) => d['id'] === withdrawnReplyId);
      expect(found).toEqual({
        kind: 'withdrawn',
        id: withdrawnReplyId,
        author: Buffer.from(author).toString('hex'),
        parentRefs: [liveRootId],
        withdrawnAtHeight: 52,
      });
    });

    it("the feed carries the withdrawn reply's parentRefs", async () => {
      const res = await request('/', 'GET');
      expect(res.status).toBe(200);
      const body = res.data as Record<string, unknown>;
      const posts = body['posts'] as Array<Record<string, unknown>>;
      const found = posts.find((p) => p['id'] === withdrawnReplyId);
      expect(found).toEqual({
        kind: 'withdrawn',
        id: withdrawnReplyId,
        author: Buffer.from(author).toString('hex'),
        parentRefs: [liveRootId],
        withdrawnAtHeight: 52,
      });
    });
  });
});
