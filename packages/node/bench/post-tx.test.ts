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
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeInterlinks,
  hash32,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type { BlockHeader, PostCommit, UtxoTxTree } from '@dagsocial/types';
import { initDb, getDb, closeDb } from '../src/store/db.js';
import * as store from '../src/store/index.js';
import { FeedService } from '../src/services/feed-service.js';

/**
 * What `GET /posts?limit=100&tx=1` costs when its 100 rows sit in 100 distinct
 * full (2 MB) blocks (NODE_INTERFACE → Posts → "The creating transaction rides
 * a post row"). The bench seeds `ordering_blocks` directly with real
 * encoded bodies of near-cap size and `dag_posts` with confirmed rows at those
 * heights, then times the three post routes through a minimal Express app
 * wired to the real `FeedService` and store readers. The suite excludes
 * `bench/**`; this file is `vitest.bench.config.ts`'s alone.
 */

// ---------------------------------------------------------------------------
// Sizing — one small post tx (128 B) plus K filler txs chosen to approach
// MAX_BLOCK_BODY_BYTES without crossing it.
// ---------------------------------------------------------------------------
const POST_TX_BYTES = 128;
const FILLER_TX_BYTES = 19_900;
const FILLER_PER_BLOCK = 100;
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

// Hand-walk the stored body bytes to find one transaction's bytes by its id,
// without decoding the tree to objects (bench-only; TYPES_INTERFACE →
// Serialization → UTXO_TX_TREE: `arr(utxoTxIds, b32) ‖ arr(utxoTxs, lp)`).
function readVlqU(buf: Uint8Array, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i]!;
    i += 1;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: i };
}

function findTxBytesByIdHandWalk(body: Uint8Array, targetId: Uint8Array): Uint8Array | null {
  // Section 1: arr(utxoTxIds, b32).
  const h1 = readVlqU(body, 0);
  const nIds = h1.value;
  let p = h1.next;
  let hit = -1;
  for (let j = 0; j < nIds; j++) {
    let match = true;
    for (let k = 0; k < 32; k++) {
      if (body[p + k] !== targetId[k]) { match = false; break; }
    }
    if (match) { hit = j; }
    p += 32;
  }
  if (hit < 0) return null;
  // Section 2: arr(utxoTxs, lp).
  const h2 = readVlqU(body, p);
  p = h2.next;
  for (let j = 0; j < hit; j++) {
    const h = readVlqU(body, p);
    p = h.next + h.value;
  }
  const h = readVlqU(body, p);
  return body.subarray(h.next, h.next + h.value);
}

// ---------------------------------------------------------------------------
// Seed shape — one PostCommit per block, with its 32-byte txId generated
// here. The resolver decodes `utxoTxTree` and reads `utxoTxs[i]` by the row's
// `tx_id`; the content of those bytes never enters the decode path, so a real
// `encodeTx` is not necessary for the measurement.
// ---------------------------------------------------------------------------
interface SeededPost {
  postId: string;
  txId: string;
  blockHeight: number;
  postTxBytes: Uint8Array;
}

function makeFillerTree(postTxId: Uint8Array, postTxBytes: Uint8Array): UtxoTxTree {
  const utxoTxIds: string[] = [bytesToHex(postTxId)];
  const utxoTxs: Uint8Array[] = [postTxBytes];
  for (let i = 0; i < FILLER_PER_BLOCK; i++) {
    utxoTxIds.push(bytesToHex(new Uint8Array(randomBytes(32))));
    utxoTxs.push(new Uint8Array(randomBytes(FILLER_TX_BYTES)));
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
): SeededPost {
  const postTxIdBytes = new Uint8Array(randomBytes(32));
  const postTxBytes = new Uint8Array(randomBytes(POST_TX_BYTES));
  const tree = makeFillerTree(postTxIdBytes, postTxBytes);
  const treeBytes = encodeUtxoTxTree(tree);
  const header = fillerHeader(height);
  const headerBytes = encodeHeader(header);
  const validatorSig = new Uint8Array(randomBytes(64));
  const interlinks = encodeInterlinks([]);
  // A per-row unique hex string for `block_hash` (UNIQUE). The gates above
  // `createOrderingBlock` are not needed here — the bench seeds raw rows and
  // its only reader is `getOrderingBlock`.
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

// ---------------------------------------------------------------------------
// Minimal Express app — the three GET post routes, wired to the real
// FeedService over the real store readers.
// ---------------------------------------------------------------------------
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
    getOrderingBlock: store.getOrderingBlock,
  });
  const app = express();
  app.get('/posts', (req, res) => {
    const limit = Number(req.query['limit'] ?? 100);
    const tx = req.query['tx'] === '1';
    const result = feed.queryPosts({ limit, tx });
    res.json({ ...result, next: result.next });
  });
  app.get('/posts/:id', (req, res) => {
    const tx = req.query['tx'] === '1';
    const result = feed.getPost(req.params['id']!, null, tx);
    if (!result) { res.status(404).json({ error: 404 }); return; }
    res.json(result);
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

describe("post-tx bench — the post routes' tx=1 over full blocks", () => {
  it('seeds 100 full blocks and times the four cases plus the split', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'notis-post-tx-bench-'));
    const dbPath = join(scratch, 'bench.db');
    try {
      initDb(dbPath);
      const db = getDb();

      // ----- Seed Phase A: 100 posts in 100 distinct full blocks ----------
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

      const beforeSeed = memNow();
      const seeded: SeededPost[] = [];
      let bodySizeDistinct = 0;
      const seedTx = db.transaction(() => {
        for (let h = 1; h <= BLOCK_COUNT; h++) {
          const row = seedBlockRow(insertBlock, insertPostRow, h);
          seeded.push(row);
        }
      });
      seedTx();
      {
        const row = db.prepare('SELECT LENGTH(utxotx_tree_bytes) AS n FROM ordering_blocks WHERE height = ?').get(1) as { n: number };
        bodySizeDistinct = row.n;
      }
      const afterSeedA = memNow();
      console.log(`\n==== seed A: ${BLOCK_COUNT} posts in ${BLOCK_COUNT} full blocks (seeded rows directly) ====`);
      console.log(`body bytes per block (height 1): ${bodySizeDistinct} / cap ${MAX_BLOCK_BODY_BYTES}`);
      console.log(`memory after seed A: heapUsed=${mb(afterSeedA.heapUsed)} MB, arrayBuffers=${mb(afterSeedA.arrayBuffers)} MB, rss=${mb(afterSeedA.rss)} MB (delta from pre-seed: heap ${mb(afterSeedA.heapUsed - beforeSeed.heapUsed)} MB, arrBuf ${mb(afterSeedA.arrayBuffers - beforeSeed.arrayBuffers)} MB)`);

      const app = makeApp();

      // ----- Case 1: /posts?limit=100 (no tx) -----------------------------
      const c1 = await timeSeries(app, '/posts?limit=100');
      // ----- Case 2: /posts?limit=100&tx=1 over 100 distinct full blocks --
      const c2 = await timeSeries(app, '/posts?limit=100&tx=1');
      // ----- Case 4: /posts/:id?tx=1 one row, one full body ---------------
      const singleId = seeded[Math.floor(seeded.length / 2)]!.postId;
      const c4 = await timeSeries(app, `/posts/${singleId}?tx=1`);

      // ----- Case 5: where the time goes for case 2 (one full response) ---
      //    sqliteReadMs: raw blob read of the 100 bodies
      //    decodeMs: decodeUtxoTxTree over the 100 bodies
      //    mapBuildMs: build 100 Maps (one per height) keyed txId → bytes
      //    hexEncodeMs: Buffer.from(bytes).toString('hex') over the 100 post rows
      const stmt = db.prepare('SELECT utxotx_tree_bytes AS b FROM ordering_blocks WHERE height = ?');
      const splitReps = 10;
      const sqliteMs: number[] = [];
      const decodeMs: number[] = [];
      const mapBuildMs: number[] = [];
      const hexMs: number[] = [];
      for (let r = 0; r < splitReps; r++) {
        // sqliteRead
        {
          const t = nowMs();
          const blobs: Buffer[] = [];
          for (const s of seeded) {
            const row = stmt.get(s.blockHeight) as { b: Buffer };
            blobs.push(row.b);
          }
          sqliteMs.push(msOf(nowMs() - t));
          // decode
          const t2 = nowMs();
          const trees: UtxoTxTree[] = [];
          for (const b of blobs) trees.push(decodeUtxoTxTree(new Uint8Array(b)));
          decodeMs.push(msOf(nowMs() - t2));
          // mapBuild — one Map per height, as TxBytesResolver.confirmed does
          const t3 = nowMs();
          const maps: Array<Map<string, Uint8Array>> = [];
          for (const t_ of trees) {
            const m = new Map<string, Uint8Array>();
            for (let i = 0; i < t_.utxoTxIds.length; i++) {
              const raw = t_.utxoTxs[i];
              if (raw) m.set(t_.utxoTxIds[i]!, raw);
            }
            maps.push(m);
          }
          mapBuildMs.push(msOf(nowMs() - t3));
          // hex encode of the 100 post rows
          const t4 = nowMs();
          for (let i = 0; i < seeded.length; i++) {
            const bytes = maps[i]!.get(seeded[i]!.txId)!;
            // force the string's materialization
            if (Buffer.from(bytes).toString('hex').length === 0) throw new Error('empty');
          }
          hexMs.push(msOf(nowMs() - t4));
        }
      }

      // ----- Case 6: hand-walk the stored body — the narrower read --------
      const handWalkMs: number[] = [];
      for (let r = 0; r < splitReps; r++) {
        const t = nowMs();
        for (const s of seeded) {
          const row = stmt.get(s.blockHeight) as { b: Buffer };
          const body = new Uint8Array(row.b);
          const target = Buffer.from(s.txId, 'hex');
          const bytes = findTxBytesByIdHandWalk(body, new Uint8Array(target));
          if (!bytes || bytes.length !== POST_TX_BYTES) throw new Error(`hand walk miss at height ${s.blockHeight}`);
          if (Buffer.from(bytes).toString('hex').length === 0) throw new Error('empty');
        }
        handWalkMs.push(msOf(nowMs() - t));
      }

      // Byte-equality against the decoded path: a correctness guard that the
      // hand-walk measurement is of the same answer.
      {
        const row = stmt.get(seeded[0]!.blockHeight) as { b: Buffer };
        const body = new Uint8Array(row.b);
        const target = Buffer.from(seeded[0]!.txId, 'hex');
        const got = findTxBytesByIdHandWalk(body, new Uint8Array(target))!;
        const tree = decodeUtxoTxTree(body);
        const idx = tree.utxoTxIds.indexOf(seeded[0]!.txId);
        const ref = tree.utxoTxs[idx]!;
        expect(Buffer.from(got).equals(Buffer.from(ref))).toBe(true);
      }

      // ----- Case 7: peak heap/arrayBuffers during a case-2 burst --------
      const memBefore = memNow();
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
      const memAfter = memNow();

      // ----- Reset for case 3: 100 posts in ONE block --------------------
      // Clear and reseed one full block carrying 100 post txs plus filler.
      db.exec('DELETE FROM dag_posts');
      db.exec('DELETE FROM ordering_blocks');
      const seededOne: SeededPost[] = [];
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
          seededOne.push({ postId, txId, blockHeight: height, postTxBytes: postBytes[i]! });
        }
      }
      const c3 = await timeSeries(app, '/posts?limit=100&tx=1');

      // ----- Report ------------------------------------------------------
      const line = (name: string, s: { msAll: number[]; bytes: number }): string => {
        const med = median(s.msAll);
        const p95 = percentile(s.msAll, 95);
        const mx = Math.max(...s.msAll);
        return `  ${name.padEnd(44)} | ${med.toFixed(1).padStart(9)} | ${p95.toFixed(1).padStart(7)} | ${mx.toFixed(1).padStart(7)} | ${String(s.bytes).padStart(11)}`;
      };
      console.log(`\n==== cases 1–4 (median / p95 / max ms over ${REPS} reps, response bytes) ====`);
      console.log(`  case                                         |    median |     p95 |     max | resp bytes`);
      console.log(line('1. /posts?limit=100 (no tx)', c1));
      console.log(line('2. /posts?limit=100&tx=1 (100 full blocks)', c2));
      console.log(line('3. /posts?limit=100&tx=1 (one block)', c3));
      console.log(line('4. /posts/:id?tx=1 (one row, one body)', c4));

      console.log(`\n==== case 5 — where the time goes for case 2 (${splitReps} reps, median ms over the 100 rows) ====`);
      console.log(`  sqlite blob read  : ${median(sqliteMs).toFixed(1)} ms  (worst ${Math.max(...sqliteMs).toFixed(1)})`);
      console.log(`  decodeUtxoTxTree  : ${median(decodeMs).toFixed(1)} ms  (worst ${Math.max(...decodeMs).toFixed(1)})`);
      console.log(`  build id→bytes map: ${median(mapBuildMs).toFixed(1)} ms  (worst ${Math.max(...mapBuildMs).toFixed(1)})`);
      console.log(`  hex-encode answer : ${median(hexMs).toFixed(1)} ms  (worst ${Math.max(...hexMs).toFixed(1)})`);
      const splitTotal = median(sqliteMs) + median(decodeMs) + median(mapBuildMs) + median(hexMs);
      console.log(`  sum of medians    : ${splitTotal.toFixed(1)} ms`);

      console.log(`\n==== case 6 — hand-walk the stored body (no decode, bench-only) ====`);
      console.log(`  median ${median(handWalkMs).toFixed(1)} ms, worst ${Math.max(...handWalkMs).toFixed(1)} ms, over the same 100 rows`);
      console.log(`  case 2 median for reference: ${median(c2.msAll).toFixed(1)} ms (end-to-end, through Express/FeedService)`);

      console.log(`\n==== case 7 — peak memory during a case-2 burst of ${REPS} calls ====`);
      console.log(`  before: heapUsed=${mb(memBefore.heapUsed)} MB, arrayBuffers=${mb(memBefore.arrayBuffers)} MB, rss=${mb(memBefore.rss)} MB`);
      console.log(`  peak:   heapUsed=${mb(peakHeap)} MB, arrayBuffers=${mb(peakArrBuf)} MB, rss=${mb(peakRss)} MB`);
      console.log(`  after:  heapUsed=${mb(memAfter.heapUsed)} MB, arrayBuffers=${mb(memAfter.arrayBuffers)} MB, rss=${mb(memAfter.rss)} MB`);
      console.log(`  peak delta over before: heap ${mb(peakHeap - memBefore.heapUsed)} MB, arrBuf ${mb(peakArrBuf - memBefore.arrayBuffers)} MB`);

      expect(c2.msAll.length).toBe(REPS);
    } finally {
      closeDb();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
