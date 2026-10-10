import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import {
  bytesToHex,
  computePostId,
  encodeHeader,
  encodeTx,
  encodeUtxoTxTree,
  encodeInterlinks,
  hash32,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type { BlockHeader, PostCommit, UtxoTxTree } from '@dagsocial/types';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import * as store from '../src/store/index.js';
import { FeedService } from '../src/services/feed-service.js';
import { parseBatchIds, isBatchIdsError } from '../src/routes/page.js';
import { makeTestIdentity, makeCreditBox, makeCreditTx } from '../test/helpers.js';

/**
 * What the post routes' `tx=1` read costs when its rows sit in full blocks: a
 * confirmed row's bytes come from `getUtxoTxTreeBytes(height)` +
 * `utxoTxBytesIn(bytes, txId)` (NODE_INTERFACE → Posts; TYPES_INTERFACE → One
 * transaction of a body), the body neither decoded nor kept.
 *
 * Timed: `GET /posts?limit=100` bare, with `tx=1` and with `light=1`;
 * `GET /posts/:id?tx=1`; `POST /posts/batch` of 100 ids with and without
 * `tx=1`. Also reported: the response sizes of the three pages, peak memory
 * over a burst of `tx=1` pages, and the split of one `tx=1` page over Seeding A
 * into blob read, walk and hex encoding. Three seedings:
 *
 *   - A: 100 blocks, each carrying one small post-shaped tx plus 100 fillers
 *     of ~19.9 KB (101 elements a body); and 100 posts in one block of that
 *     shape.
 *   - B: 100 blocks, each carrying one small post-shaped tx plus as many
 *     credit-send-sized fillers (`SMALL_PER_BLOCK`) as fill the body to
 *     `MAX_BLOCK_BODY_BYTES` — the id array is the costly shape for
 *     `utxoTxBytesIn` and the one the contract's figure is measured on; and
 *     100 posts in one block of that shape. The batch and light cases run
 *     over the 100-block form.
 *   - C: 50 blocks, each carrying two posts plus Seeding B's filler count;
 *     the batch case asks for its 100 posts interleaved so no two
 *     neighbours in the request share a block.
 *
 * The suite excludes `bench/**`; this file is `vitest.bench.config.ts`'s alone.
 */

const POST_TX_BYTES = 128;
const FILLER_TX_BYTES = 19_900;
const FILLER_PER_BLOCK = 100;        // Seeding A
const BLOCK_COUNT = 100;
const REPS = 20;
const WARMUPS = 3;

function nowMs(): number {
  return Number(process.hrtime.bigint());
}

function msOf(deltaNs: number): number {
  return deltaNs / 1_000_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function forceGc(): void {
  if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
}

interface Mem {
  heapUsed: number;
  arrayBuffers: number;
  rss: number;
}

function memNow(): Mem {
  forceGc();
  const u = process.memoryUsage();
  return { heapUsed: u.heapUsed, arrayBuffers: u.arrayBuffers, rss: u.rss };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

// The byte length of a real credit-send transaction, measured once from
// `makeCreditTx` + `encodeTx` — the elements of Seeding B are random bytes of
// this length so the walk's measurement reflects a real-sized element.
function realCreditSendByteLength(): number {
  const spender = makeTestIdentity();
  const input = makeCreditBox(1_000_000n, spender.userId, 0);
  const tx = makeCreditTx(spender, [input], 1n);
  return encodeTx(tx).length;
}

// ---------------------------------------------------------------------------
// Seed shape — one PostCommit per block, with its 32-byte txId generated
// here. The resolver reads `utxoTxs[i]` by the row's `tx_id` through
// `utxoTxBytesIn`; the content of those bytes never affects the walk, so a
// real `encodeTx` is not necessary for the per-element bytes.
// ---------------------------------------------------------------------------
interface SeededPost {
  postId: string;
  txId: string;
  blockHeight: number;
  postTxBytes: Uint8Array;
}

function makeTree(postTxId: Uint8Array, postTxBytes: Uint8Array, fillerCount: number, fillerBytes: number): UtxoTxTree {
  const utxoTxIds: string[] = [bytesToHex(postTxId)];
  const utxoTxs: Uint8Array[] = [postTxBytes];
  for (let i = 0; i < fillerCount; i++) {
    utxoTxIds.push(bytesToHex(new Uint8Array(randomBytes(32))));
    utxoTxs.push(new Uint8Array(randomBytes(fillerBytes)));
  }
  return { utxoTxIds, utxoTxs };
}

function fillerHeader(height: number): BlockHeader {
  const h32 = () => bytesToHex(hash32(new Uint8Array([height & 0xff])));
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: h32(),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 1,
    createdAt: 1_700_000_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function seedBlockRow(
  insertBlock: Database.Statement,
  insertPostRow: Database.Statement,
  height: number,
  fillerCount: number,
  fillerBytes: number,
): SeededPost {
  const postTxIdBytes = new Uint8Array(randomBytes(32));
  const postTxBytes = new Uint8Array(randomBytes(POST_TX_BYTES));
  const tree = makeTree(postTxIdBytes, postTxBytes, fillerCount, fillerBytes);
  const treeBytes = encodeUtxoTxTree(tree);
  const header = fillerHeader(height);
  const headerBytes = encodeHeader(header);
  const validatorSig = new Uint8Array(randomBytes(64));
  const interlinks = encodeInterlinks([]);
  const blockHashHex = bytesToHex(hash32(headerBytes));
  insertBlock.run(
    height,
    Buffer.from(headerBytes),
    Buffer.from(treeBytes),
    Buffer.from(validatorSig),
    header.createdAt,
    blockHashHex,
    Buffer.from(interlinks),
  );

  const txId = bytesToHex(postTxIdBytes);
  const postId = computePostId(txId, 0);
  const author = new Uint8Array(randomBytes(32));
  const commit: PostCommit = {
    protocolVersion: 1,
    type: 'regular',
    author,
    parentRefs: [],
    contentHash: new Uint8Array(randomBytes(32)),
  };
  const contentHashHex = bytesToHex(commit.contentHash);
  const content = `post-at-${height}`;
  insertPostRow.run(
    postId,
    txId,
    contentHashHex,
    content,
    Buffer.from(author),
    JSON.stringify([]),
    commit.protocolVersion,
    commit.type,
    'confirmed',
    height,
    0,
  );
  return { postId, txId, blockHeight: height, postTxBytes };
}

function makeApp(): express.Express {
  const feed = new FeedService({
    getPost: store.getPost,
    queryPostsPage: store.queryPostsPage,
    getLikeRecordCount: store.getLikeRecordCount,
    getDescendantCount: store.getDescendantCount,
    hasLikeRecord: store.hasLikeRecord,
    getAncestorsNearest: store.getAncestorsNearest,
    getSubtreePage: store.getSubtreePage,
    getBlockCreatedAt: store.getBlockCreatedAt,
    getUsernameByOwner: store.getUsernameByOwner,
    getPendingUtxoTxBytesByTxId: () => null,
    getUtxoTxTreeBytes: store.getUtxoTxTreeBytes,
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/posts', (req, res) => {
    const limit = Number(req.query['limit'] ?? 100);
    const tx = req.query['tx'] === '1';
    const light = req.query['light'] === '1';
    const result = feed.queryPosts({ limit, tx, light });
    res.json({ ...result, next: result.next });
  });
  app.get('/posts/:id', (req, res) => {
    const tx = req.query['tx'] === '1';
    const result = feed.getPost(req.params['id']!, null, tx);
    if (!result) { res.status(404).json({ error: 404 }); return; }
    res.json(result);
  });
  // NODE_INTERFACE → Posts → "The batch read answers posts by id"
  app.post('/posts/batch', (req, res) => {
    const ids = parseBatchIds(req.body);
    if (isBatchIdsError(ids)) { res.status(400).json({ error: ids.error }); return; }
    const tx = req.query['tx'] === '1';
    const posts = feed.getPosts(ids, null, tx);
    res.json({ posts });
  });
  return app;
}

async function callOnce(app: express.Express, path: string): Promise<{ ms: number; bytes: number }> {
  const t0 = nowMs();
  const res = await request(app).get(path).expect(200);
  const ms = msOf(nowMs() - t0);
  const bytes = Buffer.byteLength(JSON.stringify(res.body));
  return { ms, bytes };
}

async function timeSeries(app: express.Express, path: string): Promise<{ msAll: number[]; bytes: number }> {
  for (let i = 0; i < WARMUPS; i++) await request(app).get(path).expect(200);
  const msAll: number[] = [];
  let bytes = 0;
  for (let i = 0; i < REPS; i++) {
    const r = await callOnce(app, path);
    msAll.push(r.ms);
    bytes = r.bytes;
  }
  return { msAll, bytes };
}

// NODE_INTERFACE → Posts → "The batch read answers posts by id"
async function callOnceBatch(app: express.Express, path: string, body: object): Promise<{ ms: number; bytes: number }> {
  const t0 = nowMs();
  const res = await request(app).post(path).send(body).expect(200);
  const ms = msOf(nowMs() - t0);
  const bytes = Buffer.byteLength(JSON.stringify(res.body));
  return { ms, bytes };
}

async function timeSeriesBatch(app: express.Express, path: string, body: object): Promise<{ msAll: number[]; bytes: number }> {
  for (let i = 0; i < WARMUPS; i++) await request(app).post(path).send(body).expect(200);
  const msAll: number[] = [];
  let bytes = 0;
  for (let i = 0; i < REPS; i++) {
    const r = await callOnceBatch(app, path, body);
    msAll.push(r.ms);
    bytes = r.bytes;
  }
  return { msAll, bytes };
}

interface BurstResult {
  before: Mem;
  peak: { heapUsed: number; arrayBuffers: number; rss: number };
  after: Mem;
}

async function case7Burst(app: express.Express): Promise<BurstResult> {
  const before = memNow();
  let peakHeap = 0;
  let peakArrBuf = 0;
  let peakRss = 0;
  for (let i = 0; i < REPS; i++) {
    await request(app).get('/posts?limit=100&tx=1').expect(200);
    const u = process.memoryUsage();
    if (u.heapUsed > peakHeap) peakHeap = u.heapUsed;
    if (u.arrayBuffers > peakArrBuf) peakArrBuf = u.arrayBuffers;
    if (u.rss > peakRss) peakRss = u.rss;
  }
  const after = memNow();
  return { before, peak: { heapUsed: peakHeap, arrayBuffers: peakArrBuf, rss: peakRss }, after };
}

describe("post-tx bench — the post routes' tx=1 over full blocks (narrow read)", () => {
  it('seeds the two shapes and times the cases over the narrow read', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'notis-post-tx-bench-'));
    const dbPath = join(scratch, 'bench.db');
    try {
      initDb(dbPath);
      const db = getDb();

      // Measure a real credit-send once — Seeding B's element length.
      const smallTxBytes = realCreditSendByteLength();
      // Each small element costs 32 (id) + vlqU(len) + len bytes in the body;
      // target the body cap with headroom and solve for N.
      const APPROX_PER_SMALL = 32 + 2 + smallTxBytes;
      const SMALL_PER_BLOCK = Math.max(
        1,
        Math.floor((MAX_BLOCK_BODY_BYTES - 1024 - POST_TX_BYTES - 2 - 32) / APPROX_PER_SMALL),
      );

      // Prepared inserts.
      const insertBlock = db.prepare(
        `INSERT INTO ordering_blocks
           (height, header_bytes, utxotx_tree_bytes, validator_signature,
            created_at, block_hash, interlinks)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertPostRow = db.prepare(
        `INSERT INTO dag_posts
           (id, tx_id, content_hash, content, author, parent_refs,
            protocol_version, type, status, block_height, block_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      // ============== Seeding A — 101 elements a body ======================
      const beforeSeedA = memNow();
      const seededA: SeededPost[] = [];
      const seedTxA = db.transaction(() => {
        for (let h = 1; h <= BLOCK_COUNT; h++) {
          seededA.push(seedBlockRow(insertBlock, insertPostRow, h, FILLER_PER_BLOCK, FILLER_TX_BYTES));
        }
      });
      seedTxA();
      const bodySizeA = (db.prepare('SELECT LENGTH(utxotx_tree_bytes) AS n FROM ordering_blocks WHERE height = ?').get(1) as { n: number }).n;
      const afterSeedA = memNow();
      console.log(`\n==== seed A: ${BLOCK_COUNT} posts in ${BLOCK_COUNT} full blocks, ${FILLER_PER_BLOCK + 1} elements a body ====`);
      console.log(`body bytes per block (height 1): ${bodySizeA} / cap ${MAX_BLOCK_BODY_BYTES}`);
      console.log(`memory after seed A: heapUsed=${mb(afterSeedA.heapUsed)} MB, arrayBuffers=${mb(afterSeedA.arrayBuffers)} MB, rss=${mb(afterSeedA.rss)} MB (delta from pre: heap ${mb(afterSeedA.heapUsed - beforeSeedA.heapUsed)} MB, arrBuf ${mb(afterSeedA.arrayBuffers - beforeSeedA.arrayBuffers)} MB)`);

      const app = makeApp();

      // ----- Cases 1,2,4 over A ------------------------------------------
      const c1A = await timeSeries(app, '/posts?limit=100');
      const c2A = await timeSeries(app, '/posts?limit=100&tx=1');
      const singleIdA = seededA[Math.floor(seededA.length / 2)]!.postId;
      const c4A = await timeSeries(app, `/posts/${singleIdA}?tx=1`);

      // ----- Case 5: where the time goes for case 2 under seed A ---------
      //   blobRead: sqlite blob read of the 100 bodies, column-only.
      //   walk:     utxoTxBytesIn over each (body, txId) pair.
      //   hex:      Buffer.from(bytes).toString('hex') over the 100 post rows.
      const { utxoTxBytesIn } = await import('@dagsocial/types');
      const stmt = db.prepare('SELECT utxotx_tree_bytes AS b FROM ordering_blocks WHERE height = ?');
      const splitReps = 10;
      const blobReadMs: number[] = [];
      const walkMs: number[] = [];
      const hexMs: number[] = [];
      for (let r = 0; r < splitReps; r++) {
        const t = nowMs();
        const blobs: Uint8Array[] = [];
        for (const s of seededA) {
          const row = stmt.get(s.blockHeight) as { b: Buffer };
          blobs.push(new Uint8Array(row.b));
        }
        blobReadMs.push(msOf(nowMs() - t));
        const t2 = nowMs();
        const found: Array<Uint8Array | null> = [];
        for (let i = 0; i < seededA.length; i++) {
          found.push(utxoTxBytesIn(blobs[i]!, seededA[i]!.txId));
        }
        walkMs.push(msOf(nowMs() - t2));
        const t3 = nowMs();
        for (const b of found) {
          if (!b) throw new Error('miss');
          if (Buffer.from(b).toString('hex').length === 0) throw new Error('empty');
        }
        hexMs.push(msOf(nowMs() - t3));
      }

      // Correctness guard: the walk returns the same bytes decodeUtxoTxTree would.
      {
        const { decodeUtxoTxTree } = await import('@dagsocial/types');
        const row = stmt.get(seededA[0]!.blockHeight) as { b: Buffer };
        const body = new Uint8Array(row.b);
        const got = utxoTxBytesIn(body, seededA[0]!.txId)!;
        const tree = decodeUtxoTxTree(body);
        const idx = tree.utxoTxIds.indexOf(seededA[0]!.txId);
        const ref = tree.utxoTxs[idx]!;
        expect(Buffer.from(got).equals(Buffer.from(ref))).toBe(true);
      }

      // ----- Case 7 (A): peak heap/arrayBuffers over a case-2 burst -------
      const burstA = await case7Burst(app);

      // ----- Reset for case 3 (A): 100 posts in ONE block -----------------
      db.exec('DELETE FROM dag_posts');
      db.exec('DELETE FROM ordering_blocks');
      {
        const height = 1;
        const postIdsBytes: Uint8Array[] = [];
        const postBytes: Uint8Array[] = [];
        for (let i = 0; i < BLOCK_COUNT; i++) {
          postIdsBytes.push(new Uint8Array(randomBytes(32)));
          postBytes.push(new Uint8Array(randomBytes(POST_TX_BYTES)));
        }
        const ids: string[] = postIdsBytes.map((b) => bytesToHex(b));
        const txs: Uint8Array[] = postBytes.slice();
        for (let i = 0; i < FILLER_PER_BLOCK; i++) {
          ids.push(bytesToHex(new Uint8Array(randomBytes(32))));
          txs.push(new Uint8Array(randomBytes(FILLER_TX_BYTES)));
        }
        const tree: UtxoTxTree = { utxoTxIds: ids, utxoTxs: txs };
        const treeBytes = encodeUtxoTxTree(tree);
        const header = fillerHeader(height);
        const headerBytes = encodeHeader(header);
        insertBlock.run(
          height,
          Buffer.from(headerBytes),
          Buffer.from(treeBytes),
          Buffer.from(new Uint8Array(randomBytes(64))),
          header.createdAt,
          bytesToHex(hash32(headerBytes)),
          Buffer.from(encodeInterlinks([])),
        );
        for (let i = 0; i < BLOCK_COUNT; i++) {
          const txId = ids[i]!;
          const postId = computePostId(txId, 0);
          const author = new Uint8Array(randomBytes(32));
          insertPostRow.run(
            postId,
            txId,
            bytesToHex(new Uint8Array(randomBytes(32))),
            `post-${i}`,
            Buffer.from(author),
            JSON.stringify([]),
            1,
            'regular',
            'confirmed',
            height,
            i,
          );
        }
      }
      const c3A = await timeSeries(app, '/posts?limit=100&tx=1');

      // ============== Seeding B — a body filled to the cap with small elements ==
      // The id array is read on every call, so the small-tx body is the
      // costly shape and the one the contract's figure must come from.
      db.exec('DELETE FROM dag_posts');
      db.exec('DELETE FROM ordering_blocks');
      const beforeSeedB = memNow();
      const seededB: SeededPost[] = [];
      const seedTxB = db.transaction(() => {
        for (let h = 1; h <= BLOCK_COUNT; h++) {
          seededB.push(seedBlockRow(insertBlock, insertPostRow, h, SMALL_PER_BLOCK, smallTxBytes));
        }
      });
      seedTxB();
      const bodySizeB = (db.prepare('SELECT LENGTH(utxotx_tree_bytes) AS n FROM ordering_blocks WHERE height = ?').get(1) as { n: number }).n;
      const afterSeedB = memNow();
      console.log(`\n==== seed B: ${BLOCK_COUNT} posts in ${BLOCK_COUNT} full blocks, ${SMALL_PER_BLOCK + 1} elements a body (one small post + ${SMALL_PER_BLOCK} credit-send-sized fillers of ${smallTxBytes} bytes each) ====`);
      console.log(`body bytes per block (height 1): ${bodySizeB} / cap ${MAX_BLOCK_BODY_BYTES}`);
      console.log(`memory after seed B: heapUsed=${mb(afterSeedB.heapUsed)} MB, arrayBuffers=${mb(afterSeedB.arrayBuffers)} MB, rss=${mb(afterSeedB.rss)} MB (delta from pre: heap ${mb(afterSeedB.heapUsed - beforeSeedB.heapUsed)} MB, arrBuf ${mb(afterSeedB.arrayBuffers - beforeSeedB.arrayBuffers)} MB)`);

      // Case 2 over B
      const c2B = await timeSeries(app, '/posts?limit=100&tx=1');

      // Case 7 (B)
      const burstB = await case7Burst(app);

      // ----- The batch read and the light page over B (NODE_INTERFACE → Posts)
      // Seeding B is the fullest shape — 100 ids in 100 distinct full blocks
      // of credit-send-sized elements. The POST /posts/batch bench covers
      // its cost ("Its cost is a page's").
      const seededBIds = seededB.map((s) => s.postId);
      const batchBody = { ids: seededBIds };
      const bTxB = await timeSeriesBatch(app, '/posts/batch?tx=1', batchBody);
      const bNoTxB = await timeSeriesBatch(app, '/posts/batch', batchBody);
      const lightB = await timeSeries(app, '/posts?limit=100&light=1');
      // Response body sizes of the same 100 rows: full, tx=1, light=1.
      const fullBytesB = (await callOnce(app, '/posts?limit=100')).bytes;
      const txBytesB = (await callOnce(app, '/posts?limit=100&tx=1')).bytes;
      const lightBytesB = (await callOnce(app, '/posts?limit=100&light=1')).bytes;

      // ----- The batch read over 50 blocks: 100 ids, interleaved so no two
      //       neighbours share a block. Seeding C: each pair (2*k, 2*k+1) of
      //       `seededC` shares a block.
      db.exec('DELETE FROM dag_posts');
      db.exec('DELETE FROM ordering_blocks');
      const seededC: SeededPost[] = [];
      {
        // 50 blocks, each carrying two posts plus the Seeding-B filler count.
        const BLOCKS = 50;
        const POSTS_PER_BLOCK = 2;
        for (let h = 1; h <= BLOCKS; h++) {
          const utxoTxIds: string[] = [];
          const utxoTxs: Uint8Array[] = [];
          const postMeta: Array<{ txId: string; txBytes: Uint8Array }> = [];
          for (let p = 0; p < POSTS_PER_BLOCK; p++) {
            const postTxIdBytes = new Uint8Array(randomBytes(32));
            const postTxBytes = new Uint8Array(randomBytes(POST_TX_BYTES));
            const txId = bytesToHex(postTxIdBytes);
            utxoTxIds.push(txId);
            utxoTxs.push(postTxBytes);
            postMeta.push({ txId, txBytes: postTxBytes });
          }
          for (let i = 0; i < SMALL_PER_BLOCK; i++) {
            utxoTxIds.push(bytesToHex(new Uint8Array(randomBytes(32))));
            utxoTxs.push(new Uint8Array(randomBytes(smallTxBytes)));
          }
          const tree: UtxoTxTree = { utxoTxIds, utxoTxs };
          const treeBytes = encodeUtxoTxTree(tree);
          const header = fillerHeader(h);
          const headerBytes = encodeHeader(header);
          insertBlock.run(
            h,
            Buffer.from(headerBytes),
            Buffer.from(treeBytes),
            Buffer.from(new Uint8Array(randomBytes(64))),
            header.createdAt,
            bytesToHex(hash32(headerBytes)),
            Buffer.from(encodeInterlinks([])),
          );
          for (let p = 0; p < POSTS_PER_BLOCK; p++) {
            const { txId, txBytes } = postMeta[p]!;
            const postId = computePostId(txId, 0);
            const author = new Uint8Array(randomBytes(32));
            insertPostRow.run(
              postId,
              txId,
              bytesToHex(new Uint8Array(randomBytes(32))),
              `post-${h}-${p}`,
              Buffer.from(author),
              JSON.stringify([]),
              1,
              'regular',
              'confirmed',
              h,
              p,
            );
            seededC.push({ postId, txId, blockHeight: h, postTxBytes: txBytes });
          }
        }
      }
      // Interleave: no two neighbours share a block. seededC is in insertion
      // order (height ascending, index 0 then 1 for each block). firsts =
      // every block's first post (h1-idx0, h2-idx0, …, h50-idx0); seconds =
      // every block's second post (h1-idx1, h2-idx1, …, h50-idx1). The two
      // concatenated give [h1-idx0, h2-idx0, …, h50-idx0, h1-idx1, h2-idx1,
      // …, h50-idx1]: a neighbour pair is (h-idx0, (h+1)-idx0) or (h-idx1,
      // (h+1)-idx1) inside a half, and (h50-idx0, h1-idx1) at the seam.
      const firsts = seededC.filter((_, i) => i % 2 === 0).map((s) => s.postId);
      const seconds = seededC.filter((_, i) => i % 2 === 1).map((s) => s.postId);
      const interleaved = [...firsts, ...seconds];
      // Sanity: 100 ids, every neighbour pair sits in different blocks.
      {
        const heightOf = new Map(seededC.map((s) => [s.postId, s.blockHeight] as const));
        for (let i = 1; i < interleaved.length; i++) {
          if (heightOf.get(interleaved[i - 1]!) === heightOf.get(interleaved[i]!)) {
            throw new Error(`interleaving collision at ${i}`);
          }
        }
      }
      const bInterleavedTxB = await timeSeriesBatch(app, '/posts/batch?tx=1', { ids: interleaved });

      // Case 3 (B): 100 posts in ONE block of the small shape
      db.exec('DELETE FROM dag_posts');
      db.exec('DELETE FROM ordering_blocks');
      {
        const height = 1;
        const postIdsBytes: Uint8Array[] = [];
        const postBytes: Uint8Array[] = [];
        for (let i = 0; i < BLOCK_COUNT; i++) {
          postIdsBytes.push(new Uint8Array(randomBytes(32)));
          postBytes.push(new Uint8Array(randomBytes(POST_TX_BYTES)));
        }
        const ids: string[] = postIdsBytes.map((b) => bytesToHex(b));
        const txs: Uint8Array[] = postBytes.slice();
        for (let i = 0; i < SMALL_PER_BLOCK; i++) {
          ids.push(bytesToHex(new Uint8Array(randomBytes(32))));
          txs.push(new Uint8Array(randomBytes(smallTxBytes)));
        }
        const tree: UtxoTxTree = { utxoTxIds: ids, utxoTxs: txs };
        const treeBytes = encodeUtxoTxTree(tree);
        const header = fillerHeader(height);
        const headerBytes = encodeHeader(header);
        insertBlock.run(
          height,
          Buffer.from(headerBytes),
          Buffer.from(treeBytes),
          Buffer.from(new Uint8Array(randomBytes(64))),
          header.createdAt,
          bytesToHex(hash32(headerBytes)),
          Buffer.from(encodeInterlinks([])),
        );
        for (let i = 0; i < BLOCK_COUNT; i++) {
          const txId = ids[i]!;
          const postId = computePostId(txId, 0);
          const author = new Uint8Array(randomBytes(32));
          insertPostRow.run(
            postId,
            txId,
            bytesToHex(new Uint8Array(randomBytes(32))),
            `post-${i}`,
            Buffer.from(author),
            JSON.stringify([]),
            1,
            'regular',
            'confirmed',
            height,
            i,
          );
        }
      }
      const c3B = await timeSeries(app, '/posts?limit=100&tx=1');

      // ----- Report ------------------------------------------------------
      const line = (name: string, s: { msAll: number[]; bytes: number }): string => {
        const med = median(s.msAll);
        const p95 = percentile(s.msAll, 95);
        const mx = Math.max(...s.msAll);
        return `  ${name.padEnd(50)} | ${med.toFixed(1).padStart(9)} | ${p95.toFixed(1).padStart(7)} | ${mx.toFixed(1).padStart(7)} | ${String(s.bytes).padStart(11)}`;
      };
      console.log(`\n==== cases 1,2,4 — seed A (${FILLER_PER_BLOCK + 1} elements a body), ${REPS} reps ====`);
      console.log(`  case                                               |    median |     p95 |     max | resp bytes`);
      console.log(line('1. /posts?limit=100 (no tx)', c1A));
      console.log(line('2A. /posts?limit=100&tx=1 (100 full blocks, A)', c2A));
      console.log(line('3A. /posts?limit=100&tx=1 (one block, A)', c3A));
      console.log(line('4. /posts/:id?tx=1 (one row, one body, A)', c4A));

      console.log(`\n==== case 5 — where the time goes for case 2A (${splitReps} reps, median ms over the 100 rows) ====`);
      console.log(`  sqlite blob read (col-only): ${median(blobReadMs).toFixed(1)} ms  (worst ${Math.max(...blobReadMs).toFixed(1)})`);
      console.log(`  utxoTxBytesIn walk         : ${median(walkMs).toFixed(1)} ms  (worst ${Math.max(...walkMs).toFixed(1)})`);
      console.log(`  hex-encode answer          : ${median(hexMs).toFixed(1)} ms  (worst ${Math.max(...hexMs).toFixed(1)})`);
      const splitTotal = median(blobReadMs) + median(walkMs) + median(hexMs);
      console.log(`  sum of medians             : ${splitTotal.toFixed(1)} ms`);

      console.log(`\n==== cases 2,3 — seed B (${SMALL_PER_BLOCK + 1} elements a body, credit-send-sized), ${REPS} reps ====`);
      console.log(`  case                                               |    median |     p95 |     max | resp bytes`);
      console.log(line('2B. /posts?limit=100&tx=1 (100 full blocks, B)', c2B));
      console.log(line('3B. /posts?limit=100&tx=1 (one block, B)', c3B));

      const burstLine = (label: string, b: BurstResult): void => {
        console.log(`  ${label}:`);
        console.log(`    before: heapUsed=${mb(b.before.heapUsed)} MB, arrayBuffers=${mb(b.before.arrayBuffers)} MB, rss=${mb(b.before.rss)} MB`);
        console.log(`    peak:   heapUsed=${mb(b.peak.heapUsed)} MB, arrayBuffers=${mb(b.peak.arrayBuffers)} MB, rss=${mb(b.peak.rss)} MB`);
        console.log(`    after:  heapUsed=${mb(b.after.heapUsed)} MB, arrayBuffers=${mb(b.after.arrayBuffers)} MB, rss=${mb(b.after.rss)} MB`);
        console.log(`    peak delta over before: heap ${mb(b.peak.heapUsed - b.before.heapUsed)} MB, arrBuf ${mb(b.peak.arrayBuffers - b.before.arrayBuffers)} MB`);
      };
      console.log(`\n==== case 7 — peak memory during a case-2 burst of ${REPS} calls ====`);
      burstLine('seed A', burstA);
      burstLine('seed B', burstB);

      // ----- The batch read and the light page report -----
      console.log(`\n==== the batch read and the light page over seed B (${SMALL_PER_BLOCK + 1} elements a body), ${REPS} reps ====`);
      console.log(`  case                                               |    median |     p95 |     max | resp bytes`);
      console.log(line('POST /posts/batch?tx=1 (100 ids, 100 full blocks, B)', bTxB));
      console.log(line('POST /posts/batch     (100 ids, 100 full blocks, B)', bNoTxB));
      console.log(line('POST /posts/batch?tx=1 (100 ids, 50 blocks, interleaved, B)', bInterleavedTxB));
      console.log(line('GET /posts?limit=100&light=1 (B)', lightB));

      console.log(`\n==== response body size of three pages of the same 100 rows, seed B ====`);
      console.log(`  full      : ${fullBytesB} bytes`);
      console.log(`  tx=1      : ${txBytesB} bytes`);
      console.log(`  light=1   : ${lightBytesB} bytes`);

      expect(c2A.msAll.length).toBe(REPS);
      expect(c2B.msAll.length).toBe(REPS);
      expect(bTxB.msAll.length).toBe(REPS);
      expect(bNoTxB.msAll.length).toBe(REPS);
      expect(bInterleavedTxB.msAll.length).toBe(REPS);
      expect(lightB.msAll.length).toBe(REPS);
    } finally {
      closeDb();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
