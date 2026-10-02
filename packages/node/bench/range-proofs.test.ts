import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import {
  BatchAVLProver,
  BatchAVLVerifier,
  PersistentBatchAVLProver,
  StrictBatchAVLVerifier,
  label,
} from '@ergots/avltree';
import type { VersionedAVLStorage } from '@ergots/avltree';
import {
  TREE_KEY_LENGTH,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  creditOfKey,
  equalBytes,
  hexToBytes,
} from '@dagsocial/types';
import type { CandidateOf, CreditBox } from '@dagsocial/types';
import { holdingsPage, treeStateView, verifierSession } from '@dagsocial/consensus';
import type { TreeWrite } from '@dagsocial/consensus';
import { SqliteAvlStorage } from '../src/state/avl-storage.js';
import {
  HEIGHT_SENTINEL,
  checkpointProver,
  encodeHeight,
  performTreeWrites,
} from '../src/state/avl-prover.js';
import type { AvlProverHandle } from '../src/state/avl-prover.js';
import { RecentRoots } from '../src/state/recent-roots.js';
import {
  RANGE_PAGE_MAX,
  registerProofEndpoint,
  registerRangeEndpoint,
} from '../src/state/avl-endpoint.js';
import { AVL_SCHEMA } from '../src/store/db.js';

/**
 * The two proof routes and the kept roots over a 10^6-leaf tree
 * (NODE_INTERFACE → AVL+ State Root; → "A proof at an older height restores
 * a kept root"). The seed uses this package's own write path, each block
 * records lookups and performs writes through the same functions block
 * application calls, each checkpoint runs `checkpointProver` and
 * `recentRoots.record` as the funnel's success path does, and both routes
 * run on an Express app over `registerProofEndpoint` and
 * `registerRangeEndpoint`. The suite excludes `bench/**`; this file is
 * `vitest.bench.config.ts`'s alone.
 *
 * **A block is a block** (CONSENSUS_INTERFACE → Cost's replay table first
 * row): `BLOCK_SENDS` one-signer credit sends, each three recorded lookups
 * — the spent box, its owner-index entry, one other live box — two
 * `Remove`s and four `Insert`s. The 9 468 lookups go through
 * `prover.performLookupWithNeighbors`; the 18 936 writes are built as
 * `treeWritesOf` builds them (CONSENSUS_INTERFACE → The tree writes) and
 * performed through `performTreeWrites`: every `Remove` first in bytewise
 * key order, every `Insert` after in bytewise key order. The pool of
 * spendable boxes starts with the small owners' and grows with every block;
 * the large owner's boxes are never touched, so its holdings pages read the
 * same at every height.
 */

const TREE_CFG = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

// A credit transfer's counts (CONSENSUS_INTERFACE → Cost's replay table).
const LOOKUPS_PER_SEND = 3;
const REMOVES_PER_SEND = 2;
const INSERTS_PER_SEND = 4;
const WRITES_PER_SEND = REMOVES_PER_SEND + INSERTS_PER_SEND;

/** `BENCH_*` overrides let a sanity sub-run take the same code at smaller sizes. */
function envOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

const LARGE_OWNER_BOXES = envOrDefault('BENCH_LARGE_OWNER_BOXES', 21_700);
const SEED_LEAVES = envOrDefault('BENCH_SEED_LEAVES', 1_000_000);
const BLOCK_COUNT = envOrDefault('BENCH_BLOCK_COUNT', 70);
const BLOCK_SENDS = envOrDefault('BENCH_BLOCK_SENDS', 3156);
const SMALL_SENDS = envOrDefault('BENCH_SMALL_SENDS', 32);
const RANGE_PAGE_COUNT = Math.ceil(LARGE_OWNER_BOXES / RANGE_PAGE_MAX);

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Bytewise order of two keys — the one `treeWritesOf`'s sort reads. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** A 32-byte random owner id. */
function freshOwner(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** A 32-byte random box id. */
function freshBoxId(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** A credit box's record bytes under provenance (`boxRecordBytes`). */
function creditRecord(value: bigint, owner: Uint8Array, createdAtBlock: number): Uint8Array {
  const txId = bytesToHex(freshBoxId());
  const candidate: CandidateOf<CreditBox> = { boxType: 'credit', value, createdAtBlock, owner };
  return boxRecordBytes(candidate, txId, 0);
}

/** `global.gc()` runs twice to drive the mark-sweep through once; the config exposes it. */
function forceGc(): void {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
}

interface Mem {
  heapUsed: number;
  arrayBuffers: number;
  rss: number;
}

/** Memory now, after a forced GC pass: V8's heap, every array buffer the handle holds (keys and values live here), rss. */
function memNow(): Mem {
  forceGc();
  const u = process.memoryUsage();
  return { heapUsed: u.heapUsed, arrayBuffers: u.arrayBuffers, rss: u.rss };
}

/**
 * A pool of live, spendable boxes — small owners' boxes seeded, plus every
 * output box the blocks have created. The pool never holds the large owner's
 * boxes, so its holdings pages read the same at every height.
 */
class BoxPool {
  private readonly ids: Uint8Array[] = [];
  private readonly owners: Uint8Array[] = [];

  add(boxId: Uint8Array, owner: Uint8Array): void {
    this.ids.push(boxId);
    this.owners.push(owner);
  }

  size(): number {
    return this.ids.length;
  }

  boxId(i: number): Uint8Array {
    return this.ids[i]!;
  }

  owner(i: number): Uint8Array {
    return this.owners[i]!;
  }

  /** Remove the given indices in bulk (swap-and-pop). Caller passes any order; we sort descending internally. */
  removeIndices(indices: readonly number[]): void {
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) {
      const last = this.ids.length - 1;
      if (idx !== last) {
        this.ids[idx] = this.ids[last]!;
        this.owners[idx] = this.owners[last]!;
      }
      this.ids.pop();
      this.owners.pop();
    }
  }
}

interface Seeded {
  largeOwner: Uint8Array;
  largeBoxIds: Uint8Array[];
}

/**
 * The seed's writes and the handle for the pool and the large owner. Returns the writes to perform (every box's
 * `boxKey` and its `creditOfKey` index entry), the large owner's id and the ids of her boxes (for the proof routes to
 * read), and the pool filled with the small owners' boxes (never the large owner's).
 */
function buildSeedWrites(pool: BoxPool): { writes: Array<{ tag: 'Insert'; key: Uint8Array; value: Uint8Array }>; seeded: Seeded } {
  const writes: Array<{ tag: 'Insert'; key: Uint8Array; value: Uint8Array }> = [];
  const largeOwner = freshOwner();
  const largeBoxIds: Uint8Array[] = [];
  for (let i = 0; i < LARGE_OWNER_BOXES; i++) {
    const boxId = freshBoxId();
    largeBoxIds.push(boxId);
    const value = BigInt(1_000_000 + (i % 1000));
    writes.push({ tag: 'Insert', key: boxKey(boxId), value: creditRecord(value, largeOwner, 1) });
    writes.push({ tag: 'Insert', key: creditOfKey(largeOwner, boxId), value: new Uint8Array([0x86]) });
  }
  let placed = LARGE_OWNER_BOXES * 2;
  while (placed < SEED_LEAVES) {
    const owner = freshOwner();
    // Each small owner carries two boxes — four leaves (two box records, two index entries).
    for (let j = 0; j < 2 && placed < SEED_LEAVES; j++) {
      const boxId = freshBoxId();
      pool.add(boxId, owner);
      const value = BigInt(1_000 + j);
      writes.push({ tag: 'Insert', key: boxKey(boxId), value: creditRecord(value, owner, 1) });
      writes.push({ tag: 'Insert', key: creditOfKey(owner, boxId), value: new Uint8Array([0x86]) });
      placed += 2;
    }
  }
  return { writes, seeded: { largeOwner, largeBoxIds } };
}

/**
 * The handle the bench owns: a `PersistentBatchAVLProver` over a `SqliteAvlStorage` on a `mkdtemp` SQLite file and a
 * `RecentRoots(capacity, Number.MAX_SAFE_INTEGER)` — the capacity bound alone, so the measuring ring tracks every
 * block's root. A second `RecentRoots(capacity, maxNodes)` the caller keeps separately tracks the same roots under
 * the default count bound (NODE_INTERFACE → Configuration).
 */
function makeHandle(dbPath: string, capacity: number): { handle: AvlProverHandle } {
  const db = new Database(dbPath);
  db.exec(AVL_SCHEMA);
  const storage = new SqliteAvlStorage(db, TREE_CFG);
  const inner = new BatchAVLProver(TREE_KEY_LENGTH, null);
  const prover = new PersistentBatchAVLProver(inner, storage as VersionedAVLStorage, [
    [HEIGHT_SENTINEL, encodeHeight(0)],
  ]);
  const recentRoots = new RecentRoots(capacity, Number.MAX_SAFE_INTEGER);
  return { handle: { prover, storage, recentRoots } };
}

/** The Express app registering both routes over `handle` — `src/state/avl-endpoint.ts`. */
function makeApp(handle: AvlProverHandle): express.Express {
  const app = express();
  registerProofEndpoint(app, handle);
  registerRangeEndpoint(app, handle);
  return app;
}

interface BlockPicks {
  spent: number[];
  other: number[];
  outIds: Uint8Array[];
  outOwners: Uint8Array[];
  outRecords: Uint8Array[];
}

/**
 * Pick the block's spent indices, other-lookup indices, output ids, output owners and output records. Spent indices
 * are distinct and come from the pool through a per-block cursor; each other-lookup is picked from the pool's unspent
 * remainder, so the recorded lookup is of a live key. Output ids are random; each output's owner is either the
 * spender's or the paid party's — never the large owner's.
 */
function buildBlockPicks(pool: BoxPool, sends: number, height: number): BlockPicks {
  if (pool.size() < sends * 2) {
    throw new Error(`buildBlockPicks: pool holds ${pool.size()} boxes; needs ${sends * 2} unmarked for a block of ${sends} sends`);
  }
  const spentSet = new Set<number>();
  let cursor = (height * 7919) % pool.size();
  const nextUnspent = (): number => {
    while (spentSet.has(cursor)) cursor = (cursor + 1) % pool.size();
    const chosen = cursor;
    cursor = (cursor + 1) % pool.size();
    return chosen;
  };
  const spent: number[] = [];
  const other: number[] = [];
  for (let t = 0; t < sends; t++) {
    const sp = nextUnspent();
    spentSet.add(sp);
    spent.push(sp);
    // The other-lookup picks another currently-unspent index. We mark it as spent for the pool's cursor so later
    // sends in this block do not spend it (that would overlap writes: the key would be removed by this block and the
    // lookup of it would still be live). We never actually remove it from the pool.
    const ot = nextUnspent();
    spentSet.add(ot);
    other.push(ot);
  }
  const outIds: Uint8Array[] = [];
  const outOwners: Uint8Array[] = [];
  const outRecords: Uint8Array[] = [];
  for (let t = 0; t < sends; t++) {
    // One output back to the spender, one to the other-lookup's owner — neither is the large owner's by construction.
    for (let o = 0; o < 2; o++) {
      const outOwner = o === 0 ? pool.owner(spent[t]!) : pool.owner(other[t]!);
      const outId = freshBoxId();
      outIds.push(outId);
      outOwners.push(outOwner);
      outRecords.push(creditRecord(BigInt(100 + t + o), outOwner, height));
    }
  }
  return { spent, other, outIds, outOwners, outRecords };
}

/**
 * Apply one block at `height`. The lookups go through `prover.performLookupWithNeighbors`, the writes through
 * `performTreeWrites` ordered as `treeWritesOf` orders them — every `Remove` first in bytewise key order, every
 * `Insert` after in bytewise key order; no key is written twice. `checkpointProver` closes the block and
 * `handle.recentRoots.record` holds its root beside the store's count of the nodes the checkpoint orphaned
 * (`storage.lastRemovedCount`). The shadow ring records the same (height, root, treeHeight, replaced).
 */
function applyBlockLike(
  handle: AvlProverHandle,
  boundedRing: RecentRoots,
  pool: BoxPool,
  height: number,
  sends: number,
): { lookups: number; writes: number; replaced: number } {
  const picks = buildBlockPicks(pool, sends, height);
  const inner = handle.prover.prover;

  // Lookups: three per send — spent box, its index entry, one other live box.
  for (let t = 0; t < sends; t++) {
    const spentId = pool.boxId(picks.spent[t]!);
    const spentOwner = pool.owner(picks.spent[t]!);
    const otherId = pool.boxId(picks.other[t]!);
    inner.performLookupWithNeighbors(boxKey(spentId));
    inner.performLookupWithNeighbors(creditOfKey(spentOwner, spentId));
    inner.performLookupWithNeighbors(boxKey(otherId));
  }

  // Writes. Per send: two Removes (box key, index key) and four Inserts (two new boxes × two keys each). Build then
  // sort by tag then bytewise key — the order `treeWritesOf` answers for a block's writes.
  const removes: TreeWrite[] = [];
  for (let t = 0; t < sends; t++) {
    const spentId = pool.boxId(picks.spent[t]!);
    const spentOwner = pool.owner(picks.spent[t]!);
    removes.push({ tag: 'Remove', key: boxKey(spentId) });
    removes.push({ tag: 'Remove', key: creditOfKey(spentOwner, spentId) });
  }
  const inserts: TreeWrite[] = [];
  for (let i = 0; i < picks.outIds.length; i++) {
    const outId = picks.outIds[i]!;
    const outOwner = picks.outOwners[i]!;
    inserts.push({ tag: 'Insert', key: boxKey(outId), value: picks.outRecords[i]! });
    inserts.push({ tag: 'Insert', key: creditOfKey(outOwner, outId), value: new Uint8Array([0x86]) });
  }
  removes.sort((a, b) => compareBytes(a.key, b.key));
  inserts.sort((a, b) => compareBytes(a.key, b.key));
  performTreeWrites(handle.prover, height, [...removes, ...inserts], 'bench-block');

  // The block's checkpoint — same calls the funnel's success path makes.
  checkpointProver(handle, height);
  const replaced = handle.storage.lastRemovedCount();
  handle.recentRoots.record(height, handle.prover.prover.root, handle.prover.prover.height, replaced);
  boundedRing.record(height, handle.prover.prover.root, handle.prover.prover.height, replaced);

  // Pool: drop every spent, add every new output.
  pool.removeIndices(picks.spent);
  for (let i = 0; i < picks.outIds.length; i++) {
    pool.add(picks.outIds[i]!, picks.outOwners[i]!);
  }

  return { lookups: sends * LOOKUPS_PER_SEND, writes: sends * WRITES_PER_SEND, replaced };
}

/** The seed through `performTreeWrites` in 100 000-write chunks, with one `generateProofAndUpdateStorage` at height 0. */
function performSeed(handle: AvlProverHandle, seedWrites: Array<{ tag: 'Insert'; key: Uint8Array; value: Uint8Array }>): void {
  const CHUNK = 100_000;
  for (let i = 0; i < seedWrites.length; i += CHUNK) {
    performTreeWrites(handle.prover, 0, seedWrites.slice(i, i + CHUNK), 'bench-seed');
    // Rebase the proof cycle so the proof-cycle's working set stays bounded while we seed.
    handle.prover.prover.generateProof();
  }
  // `bootstrapAvlProver`'s shape: the constructor wrote an empty-tree version at height 0; the bootstrap replaces
  // that row with the seed's version at the same height.
  handle.storage.deleteVersionAtHeight(0);
  handle.prover.generateProofAndUpdateStorage([[HEIGHT_SENTINEL, encodeHeight(0)]]);
}

/** The single-key proof route — 20 calls per cell, each verified under the answered root. */
async function callProofOnce(app: express.Express, key: Uint8Array, atHeight: number | 'tip'): Promise<{ bytes: number; ms: number; proofBytes: number }> {
  const path = atHeight === 'tip'
    ? `/api/v1/proof/${bytesToHex(key)}`
    : `/api/v1/proof/${bytesToHex(key)}?atHeight=${atHeight}`;
  const t0 = nowMs();
  const res = await request(app).get(path).expect(200);
  const ms = nowMs() - t0;
  const bytes = JSON.stringify(res.body).length;
  const proofBytes = Buffer.from(res.body.proof as string, 'base64').length;
  const rootBytes = hexToBytes(res.body.stateRoot as string);
  const proof = Uint8Array.from(Buffer.from(res.body.proof as string, 'base64'));
  const verifier = new BatchAVLVerifier(rootBytes, proof, TREE_CFG);
  const lookup = verifier.performOneOperation({ tag: 'Lookup', key });
  if (!lookup.success) {
    throw new Error(`callProofOnce: the proof refuses the lookup under its answered root: ${verifier.getLastFailReason()}`);
  }
  return { bytes, ms, proofBytes };
}

/** The 256-entry range route — a page's lookups replayed through `holdingsPage` over `verifierSession`. */
async function callRangeOnce(
  app: express.Express,
  owner: Uint8Array,
  from: Uint8Array | null,
  atHeight: number | 'tip',
): Promise<{ bytes: number; ms: number; proofBytes: number; next: Uint8Array | null }> {
  const base = `/api/v1/range/credit/${bytesToHex(owner)}`;
  const q: string[] = [];
  if (atHeight !== 'tip') q.push(`atHeight=${atHeight}`);
  if (from !== null) q.push(`from=${bytesToHex(from)}`);
  q.push(`limit=${RANGE_PAGE_MAX}`);
  const path = `${base}?${q.join('&')}`;
  const t0 = nowMs();
  const res = await request(app).get(path).expect(200);
  const ms = nowMs() - t0;
  const bytes = JSON.stringify(res.body).length;
  const proofBytes = Buffer.from(res.body.proof as string, 'base64').length;
  const rootBytes = hexToBytes(res.body.stateRoot as string);
  const proof = Uint8Array.from(Buffer.from(res.body.proof as string, 'base64'));
  const verifier = new BatchAVLVerifier(rootBytes, proof, TREE_CFG);
  const view = treeStateView(verifierSession(verifier));
  const page = holdingsPage(view, 'credit', owner, from, RANGE_PAGE_MAX);
  return { bytes, ms, proofBytes, next: page.next };
}

/** Record block N+1's own operations as the bench performs them, then replay the proof the checkpoint answers. */
interface RecordedBlock {
  lookups: Uint8Array[];
  removes: Uint8Array[];
  inserts: Array<{ key: Uint8Array; value: Uint8Array }>;
}

/** The block the bench applies, with its lookups and writes captured in order. Used for the strict-replay check. */
function applyRecordedBlock(
  handle: AvlProverHandle,
  boundedRing: RecentRoots,
  pool: BoxPool,
  height: number,
  sends: number,
): { recorded: RecordedBlock; proof: Uint8Array; digestBefore: Uint8Array; digestAfter: Uint8Array } {
  const digestBefore = handle.prover.digest()!;
  const picks = buildBlockPicks(pool, sends, height);
  const inner = handle.prover.prover;

  const recordedLookups: Uint8Array[] = [];
  for (let t = 0; t < sends; t++) {
    const spentId = pool.boxId(picks.spent[t]!);
    const spentOwner = pool.owner(picks.spent[t]!);
    const otherId = pool.boxId(picks.other[t]!);
    const k1 = boxKey(spentId);
    const k2 = creditOfKey(spentOwner, spentId);
    const k3 = boxKey(otherId);
    inner.performLookupWithNeighbors(k1);
    inner.performLookupWithNeighbors(k2);
    inner.performLookupWithNeighbors(k3);
    recordedLookups.push(k1, k2, k3);
  }

  const removes: TreeWrite[] = [];
  for (let t = 0; t < sends; t++) {
    const spentId = pool.boxId(picks.spent[t]!);
    const spentOwner = pool.owner(picks.spent[t]!);
    removes.push({ tag: 'Remove', key: boxKey(spentId) });
    removes.push({ tag: 'Remove', key: creditOfKey(spentOwner, spentId) });
  }
  const inserts: TreeWrite[] = [];
  for (let i = 0; i < picks.outIds.length; i++) {
    const outId = picks.outIds[i]!;
    const outOwner = picks.outOwners[i]!;
    inserts.push({ tag: 'Insert', key: boxKey(outId), value: picks.outRecords[i]! });
    inserts.push({ tag: 'Insert', key: creditOfKey(outOwner, outId), value: new Uint8Array([0x86]) });
  }
  removes.sort((a, b) => compareBytes(a.key, b.key));
  inserts.sort((a, b) => compareBytes(a.key, b.key));
  const ordered: TreeWrite[] = [...removes, ...inserts];
  performTreeWrites(handle.prover, height, ordered, 'bench-block');

  const proof = checkpointProver(handle, height);
  const digestAfter = handle.prover.digest()!;
  const replaced = handle.storage.lastRemovedCount();
  handle.recentRoots.record(height, handle.prover.prover.root, handle.prover.prover.height, replaced);
  boundedRing.record(height, handle.prover.prover.root, handle.prover.prover.height, replaced);
  pool.removeIndices(picks.spent);
  for (let i = 0; i < picks.outIds.length; i++) {
    pool.add(picks.outIds[i]!, picks.outOwners[i]!);
  }

  // Capture the operations in the order the strict replay will perform them: all recorded lookups first, then every
  // Remove in bytewise order, then every Insert in bytewise order — the same order the prover executed.
  const recorded: RecordedBlock = {
    lookups: recordedLookups,
    removes: removes.map((r) => r.key),
    inserts: inserts.map((w) => {
      if (w.tag !== 'Insert') throw new Error('non-Insert in insert list');
      return { key: w.key, value: w.value };
    }),
  };
  return { recorded, proof, digestBefore, digestAfter };
}

/**
 * Strict-replay check: the block's proof carries exactly the operations the block performed, no route's recorded
 * lookups among them. Anchors at the block's parent digest, performs each operation in the order the prover did,
 * requires `isFullyConsumed()` and the digest the prover reached.
 */
function strictReplayCarriesBlockOnly(
  recorded: RecordedBlock,
  proof: Uint8Array,
  digestBefore: Uint8Array,
  digestAfter: Uint8Array,
): string {
  const verifier = new StrictBatchAVLVerifier(digestBefore, proof, TREE_CFG);
  if (verifier.digest() === null) {
    throw new Error(`strictReplayCarriesBlockOnly: proof does not anchor at the parent digest: ${verifier.getLastFailReason()}`);
  }
  for (const key of recorded.lookups) {
    const r = verifier.performOneOperation({ tag: 'Lookup', key });
    if (!r.success) throw new Error(`lookup refused by proof: ${verifier.getLastFailReason()}`);
  }
  for (const key of recorded.removes) {
    const r = verifier.performOneOperation({ tag: 'Remove', key });
    if (!r.success) throw new Error(`remove refused by proof: ${verifier.getLastFailReason()}`);
  }
  for (const { key, value } of recorded.inserts) {
    const r = verifier.performOneOperation({ tag: 'Insert', key, value });
    if (!r.success) throw new Error(`insert refused by proof: ${verifier.getLastFailReason()}`);
  }
  const reached = verifier.digest();
  if (reached === null) throw new Error('verifier answered null for its digest');
  if (!equalBytes(reached, digestAfter)) {
    throw new Error(`strict replay reached ${bytesToHex(reached)}, prover reached ${bytesToHex(digestAfter)}`);
  }
  if (!verifier.isFullyConsumed()) {
    throw new Error('strict replay did not fully consume the proof — the proof carries operations the block did not perform');
  }
  return bytesToHex(reached);
}

describe('range-proofs bench — a 10^6-leaf tree with full-block kept roots', () => {
  it('seeds, applies blocks of real send shape, times both routes, measures the kept roots by difference and a store resolve', async () => {
    const startWall = Date.now();
    const scratch = mkdtempSync(join(tmpdir(), 'notis-bench-'));
    const dbPath = join(scratch, 'bench.db');

    try {
      // -----------------------------------------------------------------
      // Seed the tree.
      // -----------------------------------------------------------------
      console.log(`\n==== seed: a tree of ${SEED_LEAVES} leaves — the large owner holds ${LARGE_OWNER_BOXES} credit boxes ====`);
      const beforeSeed = memNow();
      console.log(`memory before seed: heapUsed=${mb(beforeSeed.heapUsed)} MB, arrayBuffers=${mb(beforeSeed.arrayBuffers)} MB, rss=${mb(beforeSeed.rss)} MB`);
      const { handle } = makeHandle(dbPath, 64);
      // The measuring ring is bounded by count alone (`capacity = 64`, `maxNodes = MAX_SAFE_INTEGER`). The default
      // bound is also tracked, as a second ring with `maxNodes = 250_000` — references only, no second tree. The two
      // record the same roots and counts; the default bound evicts earlier when the sum of counts rises.
      const boundedRing = new RecentRoots(64, 250_000);
      const pool = new BoxPool();
      const seedT0 = nowMs();
      const { writes: seedWrites, seeded } = buildSeedWrites(pool);
      console.log(`seed writes: ${seedWrites.length} (${LARGE_OWNER_BOXES} large-owner boxes + ${pool.size()} pool boxes, each paired with its creditOfKey entry)`);
      performSeed(handle, seedWrites);
      const seedMs = nowMs() - seedT0;
      const afterSeed = memNow();
      console.log(`memory after seed:  heapUsed=${mb(afterSeed.heapUsed)} MB, arrayBuffers=${mb(afterSeed.arrayBuffers)} MB, rss=${mb(afterSeed.rss)} MB — seed took ${(seedMs / 1000).toFixed(1)} s`);
      console.log(`seed digest: ${bytesToHex(handle.prover.digest()!)}`);

      // -----------------------------------------------------------------
      // Full-block phase.
      // -----------------------------------------------------------------
      console.log(`\n==== full blocks: apply ${BLOCK_COUNT} blocks of ${BLOCK_SENDS} sends (${BLOCK_SENDS * LOOKUPS_PER_SEND} lookups, ${BLOCK_SENDS * WRITES_PER_SEND} writes) ====`);
      interface Snap {
        blocksApplied: number;
        measuringRoots: number;
        measuringSum: number;
        boundedRoots: number;
        boundedSum: number;
        heapUsed: number;
        arrayBuffers: number;
        rss: number;
      }
      const fullSnaps: Snap[] = [{
        blocksApplied: 0,
        measuringRoots: handle.recentRoots.snapshot().size,
        measuringSum: handle.recentRoots.nodesHeldBeyondTree(),
        boundedRoots: boundedRing.snapshot().size,
        boundedSum: boundedRing.nodesHeldBeyondTree(),
        heapUsed: afterSeed.heapUsed,
        arrayBuffers: afterSeed.arrayBuffers,
        rss: afterSeed.rss,
      }];
      let height = 1;
      const snapAt = new Set([1, 21, 64]);
      let totalReplacedFull = 0;
      for (; height <= BLOCK_COUNT; height++) {
        const r = applyBlockLike(handle, boundedRing, pool, height, BLOCK_SENDS);
        totalReplacedFull += r.replaced;
        if (snapAt.has(height)) {
          const m = memNow();
          fullSnaps.push({
            blocksApplied: height,
            measuringRoots: handle.recentRoots.snapshot().size,
            measuringSum: handle.recentRoots.nodesHeldBeyondTree(),
            boundedRoots: boundedRing.snapshot().size,
            boundedSum: boundedRing.nodesHeldBeyondTree(),
            heapUsed: m.heapUsed,
            arrayBuffers: m.arrayBuffers,
            rss: m.rss,
          });
        }
      }
      const tipHeight = BLOCK_COUNT;
      console.log(`\nFull-block memory table (each kept root replaced an average of ${Math.round(totalReplacedFull / BLOCK_COUNT)} nodes):`);
      console.log(`  blocks | measuring | nodes beyond | bounded | nodes beyond | heapUsed MB | arrBuf MB | rss MB`);
      for (const s of fullSnaps) {
        console.log(
          `  ${String(s.blocksApplied).padStart(6)} | ${String(s.measuringRoots).padStart(9)} | ` +
          `${String(s.measuringSum).padStart(12)} | ${String(s.boundedRoots).padStart(7)} | ` +
          `${String(s.boundedSum).padStart(12)} | ${mb(s.heapUsed).padStart(11)} | ` +
          `${mb(s.arrayBuffers).padStart(9)} | ${mb(s.rss).padStart(6)}`,
        );
      }

      // -----------------------------------------------------------------
      // Latency and size over the full-block ring, before clearing it.
      // -----------------------------------------------------------------
      const app = makeApp(handle);
      const digestBeforeRoutes = bytesToHex(handle.prover.digest()!);
      const ringHeights = [...handle.recentRoots.snapshot().keys()].sort((a, b) => a - b);
      const inRingOr = (want: number): number => {
        if (ringHeights.includes(want)) return want;
        return ringHeights[Math.floor(ringHeights.length / 2)] ?? want;
      };
      const back20 = inRingOr(tipHeight - 20);
      const back60 = inRingOr(tipHeight - 60);
      const heights: Array<'tip' | number> = ['tip', back20, back60];
      console.log(`\n==== latency and size — single-key proof route and 256-entry page route ====`);
      console.log(`  height | kind       | median ms | worst ms | proof B median | answer B median`);
      const latencyRows: Array<{ heightLabel: string; kind: string; medianMs: number; worstMs: number; medianProof: number; medianAnswer: number }> = [];
      for (const h of heights) {
        const singleResults: Array<{ bytes: number; ms: number; proofBytes: number }> = [];
        for (let i = 0; i < 20; i++) {
          const key = boxKey(seeded.largeBoxIds[(i * 1013) % seeded.largeBoxIds.length]!);
          singleResults.push(await callProofOnce(app, key, h));
        }
        const sMs = singleResults.map((r) => r.ms);
        const sProof = singleResults.map((r) => r.proofBytes);
        const sBytes = singleResults.map((r) => r.bytes);
        const row1 = {
          heightLabel: h === 'tip' ? 'tip' : String(h),
          kind: 'single-key',
          medianMs: median(sMs),
          worstMs: Math.max(...sMs),
          medianProof: median(sProof),
          medianAnswer: median(sBytes),
        };
        latencyRows.push(row1);
        console.log(`  ${row1.heightLabel.padStart(6)} | ${row1.kind.padEnd(10)} | ${row1.medianMs.toFixed(1).padStart(9)} | ${row1.worstMs.toFixed(1).padStart(8)} | ${String(row1.medianProof).padStart(14)} | ${String(row1.medianAnswer).padStart(15)}`);

        const rangeResults: Array<{ bytes: number; ms: number; proofBytes: number }> = [];
        let from: Uint8Array | null = null;
        for (let i = 0; i < 20; i++) {
          const r = await callRangeOnce(app, seeded.largeOwner, from, h);
          rangeResults.push(r);
          from = r.next;
        }
        const rMs = rangeResults.map((r) => r.ms);
        const rProof = rangeResults.map((r) => r.proofBytes);
        const rBytes = rangeResults.map((r) => r.bytes);
        const row2 = {
          heightLabel: h === 'tip' ? 'tip' : String(h),
          kind: '256-page',
          medianMs: median(rMs),
          worstMs: Math.max(...rMs),
          medianProof: median(rProof),
          medianAnswer: median(rBytes),
        };
        latencyRows.push(row2);
        console.log(`  ${row2.heightLabel.padStart(6)} | ${row2.kind.padEnd(10)} | ${row2.medianMs.toFixed(1).padStart(9)} | ${row2.worstMs.toFixed(1).padStart(8)} | ${String(row2.medianProof).padStart(14)} | ${String(row2.medianAnswer).padStart(15)}`);
      }

      // -----------------------------------------------------------------
      // Whole-range read.
      // -----------------------------------------------------------------
      console.log(`\n==== whole-range read — the large owner's ${LARGE_OWNER_BOXES} boxes at the tip (${RANGE_PAGE_COUNT} pages) ====`);
      const beforeFull = memNow();
      console.log(`memory before: heapUsed=${mb(beforeFull.heapUsed)} MB, arrayBuffers=${mb(beforeFull.arrayBuffers)} MB, rss=${mb(beforeFull.rss)} MB`);
      const fullT0 = nowMs();
      let fullFrom: Uint8Array | null = null;
      let totalPages = 0;
      let totalProofBytes = 0;
      do {
        const r = await callRangeOnce(app, seeded.largeOwner, fullFrom, 'tip');
        totalPages++;
        totalProofBytes += r.proofBytes;
        fullFrom = r.next;
      } while (fullFrom !== null);
      const fullMs = nowMs() - fullT0;
      const afterFull = memNow();
      console.log(`memory after:  heapUsed=${mb(afterFull.heapUsed)} MB, arrayBuffers=${mb(afterFull.arrayBuffers)} MB, rss=${mb(afterFull.rss)} MB`);
      console.log(`pages: ${totalPages}, total proof bytes: ${totalProofBytes}, wall-clock: ${(fullMs / 1000).toFixed(1)} s`);
      console.log(`heap delta: ${mb(afterFull.heapUsed - beforeFull.heapUsed)} MB; arrayBuffers delta: ${mb(afterFull.arrayBuffers - beforeFull.arrayBuffers)} MB`);
      expect(totalPages, 'the whole range reads to the end in exactly RANGE_PAGE_COUNT pages').toBe(RANGE_PAGE_COUNT);
      const digestAfterRoutes = bytesToHex(handle.prover.digest()!);
      expect(digestAfterRoutes, 'the routes restore the live root on every path').toBe(digestBeforeRoutes);

      // -----------------------------------------------------------------
      // The block after — the route's cycle does not leak into the next
      // block's proof. Record block N+1's own operations as the bench
      // performs them, take the proof `checkpointProver` answers and
      // replay it on a `StrictBatchAVLVerifier` anchored at block N's
      // digest: the same lookups and writes in order, the digest the
      // prover reached, `isFullyConsumed()` required. A proof that carried
      // any route's recorded lookup would not be fully consumed by the
      // block's operations alone.
      // -----------------------------------------------------------------
      console.log(`\n==== the block after — the proof carries only the block's own operations ====`);
      const nextHeight = tipHeight + 1;
      const applied = applyRecordedBlock(handle, boundedRing, pool, nextHeight, BLOCK_SENDS);
      const reached = strictReplayCarriesBlockOnly(applied.recorded, applied.proof, applied.digestBefore, applied.digestAfter);
      console.log(`block ${nextHeight} applied; strict replay anchored at ${bytesToHex(applied.digestBefore)} reached ${reached}, fully consumed`);

      // -----------------------------------------------------------------
      // Kept-root cost by difference — with the ring full, read memory and
      // the ring's sum of nodes; `clear()` the ring; read memory again.
      // The difference is what the ring held beyond the tree. The ring's
      // sum of nodes names the 63 kept roots above the lowest; from the
      // two: bytes a node, and megabytes a kept root. The bounded ring is
      // cleared with the measuring one so its references do not survive.
      // -----------------------------------------------------------------
      console.log(`\n==== kept-root cost by difference (full-block phase) ====`);
      const beforeClearFull = memNow();
      const measuringNodes = handle.recentRoots.nodesHeldBeyondTree();
      const measuringSize = handle.recentRoots.snapshot().size;
      const boundedNodes = boundedRing.nodesHeldBeyondTree();
      const boundedSize = boundedRing.snapshot().size;
      console.log(`measuring ring full: ${measuringSize} roots, ${measuringNodes} nodes above the lowest`);
      console.log(`bounded ring:        ${boundedSize} roots, ${boundedNodes} nodes above the lowest`);
      console.log(`memory with ring:    heapUsed=${mb(beforeClearFull.heapUsed)} MB, arrayBuffers=${mb(beforeClearFull.arrayBuffers)} MB, rss=${mb(beforeClearFull.rss)} MB`);
      handle.recentRoots.clear();
      boundedRing.clear();
      const afterClearFull = memNow();
      console.log(`memory after clear:  heapUsed=${mb(afterClearFull.heapUsed)} MB, arrayBuffers=${mb(afterClearFull.arrayBuffers)} MB, rss=${mb(afterClearFull.rss)} MB`);
      const heapHeldFull = beforeClearFull.heapUsed - afterClearFull.heapUsed;
      const bufHeldFull = beforeClearFull.arrayBuffers - afterClearFull.arrayBuffers;
      const bytesPerNodeFull = measuringNodes > 0 ? (heapHeldFull + bufHeldFull) / measuringNodes : 0;
      const rootsAboveLowest = Math.max(0, measuringSize - 1);
      const perRootFull = rootsAboveLowest > 0 ? (heapHeldFull + bufHeldFull) / rootsAboveLowest : 0;
      console.log(`held beyond tree (full blocks): heap ${mb(heapHeldFull)} MB + arrayBuffers ${mb(bufHeldFull)} MB = ${mb(heapHeldFull + bufHeldFull)} MB over ${measuringNodes} nodes = ${bytesPerNodeFull.toFixed(0)} bytes a node; ${mb(perRootFull)} MB a kept root (sum over ${rootsAboveLowest} roots above the lowest)`);

      // -----------------------------------------------------------------
      // Small-block phase — a hundredth the size, snapshots by blocks
      // applied, same difference measurement at the end.
      // -----------------------------------------------------------------
      console.log(`\n==== small blocks: apply ${BLOCK_COUNT} blocks of ${SMALL_SENDS} sends (${SMALL_SENDS * LOOKUPS_PER_SEND} lookups, ${SMALL_SENDS * WRITES_PER_SEND} writes) ====`);
      const smallBaseline = memNow();
      const smallSnaps: Snap[] = [{
        blocksApplied: 0,
        measuringRoots: handle.recentRoots.snapshot().size,
        measuringSum: handle.recentRoots.nodesHeldBeyondTree(),
        boundedRoots: boundedRing.snapshot().size,
        boundedSum: boundedRing.nodesHeldBeyondTree(),
        heapUsed: smallBaseline.heapUsed,
        arrayBuffers: smallBaseline.arrayBuffers,
        rss: smallBaseline.rss,
      }];
      let smallHeight = nextHeight + 1;
      let totalReplacedSmall = 0;
      for (let i = 1; i <= BLOCK_COUNT; i++, smallHeight++) {
        const r = applyBlockLike(handle, boundedRing, pool, smallHeight, SMALL_SENDS);
        totalReplacedSmall += r.replaced;
        if (snapAt.has(i)) {
          const m = memNow();
          smallSnaps.push({
            blocksApplied: i,
            measuringRoots: handle.recentRoots.snapshot().size,
            measuringSum: handle.recentRoots.nodesHeldBeyondTree(),
            boundedRoots: boundedRing.snapshot().size,
            boundedSum: boundedRing.nodesHeldBeyondTree(),
            heapUsed: m.heapUsed,
            arrayBuffers: m.arrayBuffers,
            rss: m.rss,
          });
        }
      }
      console.log(`\nSmall-block memory table (each kept root replaced an average of ${Math.round(totalReplacedSmall / BLOCK_COUNT)} nodes):`);
      console.log(`  blocks | measuring | nodes beyond | bounded | nodes beyond | heapUsed MB | arrBuf MB | rss MB`);
      for (const s of smallSnaps) {
        console.log(
          `  ${String(s.blocksApplied).padStart(6)} | ${String(s.measuringRoots).padStart(9)} | ` +
          `${String(s.measuringSum).padStart(12)} | ${String(s.boundedRoots).padStart(7)} | ` +
          `${String(s.boundedSum).padStart(12)} | ${mb(s.heapUsed).padStart(11)} | ` +
          `${mb(s.arrayBuffers).padStart(9)} | ${mb(s.rss).padStart(6)}`,
        );
      }
      console.log(`\n==== kept-root cost by difference (small-block phase) ====`);
      const beforeClearSmall = memNow();
      const smMeasuringNodes = handle.recentRoots.nodesHeldBeyondTree();
      const smMeasuringSize = handle.recentRoots.snapshot().size;
      const smBoundedNodes = boundedRing.nodesHeldBeyondTree();
      const smBoundedSize = boundedRing.snapshot().size;
      console.log(`measuring ring full: ${smMeasuringSize} roots, ${smMeasuringNodes} nodes above the lowest`);
      console.log(`bounded ring:        ${smBoundedSize} roots, ${smBoundedNodes} nodes above the lowest`);
      console.log(`memory with ring:    heapUsed=${mb(beforeClearSmall.heapUsed)} MB, arrayBuffers=${mb(beforeClearSmall.arrayBuffers)} MB, rss=${mb(beforeClearSmall.rss)} MB`);
      handle.recentRoots.clear();
      boundedRing.clear();
      const afterClearSmall = memNow();
      console.log(`memory after clear:  heapUsed=${mb(afterClearSmall.heapUsed)} MB, arrayBuffers=${mb(afterClearSmall.arrayBuffers)} MB, rss=${mb(afterClearSmall.rss)} MB`);
      const heapHeldSmall = beforeClearSmall.heapUsed - afterClearSmall.heapUsed;
      const bufHeldSmall = beforeClearSmall.arrayBuffers - afterClearSmall.arrayBuffers;
      const bytesPerNodeSmall = smMeasuringNodes > 0 ? (heapHeldSmall + bufHeldSmall) / smMeasuringNodes : 0;
      const smRootsAboveLowest = Math.max(0, smMeasuringSize - 1);
      const perRootSmall = smRootsAboveLowest > 0 ? (heapHeldSmall + bufHeldSmall) / smRootsAboveLowest : 0;
      console.log(`held beyond tree (small blocks): heap ${mb(heapHeldSmall)} MB + arrayBuffers ${mb(bufHeldSmall)} MB = ${mb(heapHeldSmall + bufHeldSmall)} MB over ${smMeasuringNodes} nodes = ${bytesPerNodeSmall.toFixed(0)} bytes a node; ${mb(perRootSmall)} MB a kept root (sum over ${smRootsAboveLowest} roots above the lowest)`);

      // -----------------------------------------------------------------
      // Resolve from the store — the second tree a route left to resolve,
      // or a reorg at a fork point with no kept root, would build.
      // -----------------------------------------------------------------
      console.log(`\n==== a resolve from the store — storage.rollback(<tip version>) ====`);
      const beforeRollback = memNow();
      console.log(`memory before rollback: heapUsed=${mb(beforeRollback.heapUsed)} MB, arrayBuffers=${mb(beforeRollback.arrayBuffers)} MB, rss=${mb(beforeRollback.rss)} MB`);
      const tipVersion = handle.storage.version();
      if (tipVersion === null) throw new Error('no tip version to roll back to');
      const rbT0 = nowMs();
      const [rolledRoot, rolledHeight] = handle.storage.rollback(tipVersion);
      const rbMs = nowMs() - rbT0;
      const afterRollback = memNow();
      console.log(`memory after rollback:  heapUsed=${mb(afterRollback.heapUsed)} MB, arrayBuffers=${mb(afterRollback.arrayBuffers)} MB, rss=${mb(afterRollback.rss)} MB`);
      console.log(`rollback took ${rbMs} ms; second tree has tree-height ${rolledHeight} and root label ${bytesToHex(label(rolledRoot))}`);
      const heapDeltaRb = afterRollback.heapUsed - beforeRollback.heapUsed;
      const bufDeltaRb = afterRollback.arrayBuffers - beforeRollback.arrayBuffers;
      console.log(`second tree cost: heap ${mb(heapDeltaRb)} MB + arrayBuffers ${mb(bufDeltaRb)} MB = ${mb(heapDeltaRb + bufDeltaRb)} MB`);
      expect(label(rolledRoot), 'the rolled root has the label the tip version names').toEqual(tipVersion.subarray(0, 32));

      const wall = (Date.now() - startWall) / 1000;
      console.log(`\n==== wall-clock: ${wall.toFixed(1)} s ====`);
      console.log(`latency summary:`);
      for (const row of latencyRows) {
        console.log(`  ${row.heightLabel} | ${row.kind} | median ${row.medianMs.toFixed(1)} ms | worst ${row.worstMs.toFixed(1)} ms | proof ${row.medianProof} B | answer ${row.medianAnswer} B`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
