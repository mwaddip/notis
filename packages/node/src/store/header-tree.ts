import { getDb } from './db.js';
import {
  decodeHeader,
  decodeInterlinks,
  decodeOrderingBlock,
  encodeHeader,
  encodeInterlinks,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import { UnreadableStoredBlockError } from '../services/corrupt-state.js';

/**
 * One row of `block_headers`, decoded for a reader.
 *
 * NODE_INTERFACE → Header tree: a row is written once and carries every field
 * admission wrote. `header` is `decodeHeader(header_bytes)`, `interlinks` the
 * vector this header commits to, `chainWork` the cumulative work through this
 * header, `pathTa` the `createdAt` of block 1 on this header's path (the
 * header's own `createdAt` at height 1).
 */
export interface HeaderRow {
  hash: string;
  height: number;
  prevHash: string;
  header: BlockHeader;
  interlinks: string[];
  chainWork: bigint;
  pathTa: number;
}

/** NODE_INTERFACE → Header tree → "`chain_work` is fixed-width so the column orders": 40 bytes, big-endian. */
const CHAIN_WORK_BYTES = 40;

function workToBlob(work: bigint): Buffer {
  if (work < 0n) throw new RangeError(`header-tree: chain_work negative: ${work}`);
  const b = Buffer.alloc(CHAIN_WORK_BYTES);
  let w = work;
  for (let i = CHAIN_WORK_BYTES - 1; i >= 0; i--) {
    b[i] = Number(w & 0xffn);
    w >>= 8n;
  }
  if (w !== 0n) {
    throw new RangeError(`header-tree: chain_work exceeds ${CHAIN_WORK_BYTES} bytes`);
  }
  return b;
}

function workFromBlob(buf: Buffer): bigint {
  let w = 0n;
  for (const byte of buf) w = (w << 8n) | BigInt(byte);
  return w;
}

interface Row {
  hash: string;
  height: number;
  prev_hash: string;
  header_bytes: Buffer;
  interlinks: Buffer;
  chain_work: Buffer;
  path_t_a: number;
}

function rowToHeaderRow(row: Row): HeaderRow {
  // NODE_INTERFACE → "Reach is the live argument, not the halt": a stored row
  // whose header or interlinks will not decode is local corruption — one INSERT
  // under one caller, this node's own re-encoding — so decode faults rise as
  // `UnreadableStoredBlockError` for the fail-stop boundary rather than as a
  // bare `ReaderError` filed by a contained catch as the peer's.
  let header: BlockHeader;
  let interlinks: string[];
  try {
    header = decodeHeader(new Uint8Array(row.header_bytes));
  } catch (err) {
    throw new UnreadableStoredBlockError('getHeaderRow', row.height, err);
  }
  try {
    interlinks = decodeInterlinks(new Uint8Array(row.interlinks));
  } catch (err) {
    throw new UnreadableStoredBlockError('getHeaderRow', row.height, err);
  }
  return {
    hash: row.hash,
    height: row.height,
    prevHash: row.prev_hash,
    header,
    interlinks,
    chainWork: workFromBlob(row.chain_work),
    pathTa: row.path_t_a,
  };
}

/**
 * NODE_INTERFACE → Header tree → "A header row is written once": idempotent on
 * `hash`; a repeat call is a no-op. One row per hash.
 */
export function insertHeader(row: HeaderRow): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO block_headers
       (hash, height, prev_hash, header_bytes, interlinks, chain_work, path_t_a)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.hash,
    row.height,
    row.prevHash,
    Buffer.from(encodeHeader(row.header)),
    Buffer.from(encodeInterlinks(row.interlinks)),
    workToBlob(row.chainWork),
    row.pathTa,
  );
}

/** NODE_INTERFACE → Header tree: point read on `hash`. */
export function getHeaderRow(hash: string): HeaderRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM block_headers WHERE hash = ?').get(hash) as Row | undefined;
  return row ? rowToHeaderRow(row) : null;
}

/** NODE_INTERFACE → Header tree: the top `best_chain` entry's row; `null` before the first header. */
export function getBestTip(): HeaderRow | null {
  const db = getDb();
  const top = db.prepare('SELECT hash FROM best_chain ORDER BY height DESC LIMIT 1').get() as
    | { hash: string }
    | undefined;
  if (!top) return null;
  return getHeaderRow(top.hash);
}

/** NODE_INTERFACE → Header tree: point read on `best_chain`. */
export function getBestHashAt(height: number): string | null {
  const db = getDb();
  const row = db.prepare('SELECT hash FROM best_chain WHERE height = ?').get(height) as
    | { hash: string }
    | undefined;
  return row ? row.hash : null;
}

/**
 * NODE_INTERFACE → Header tree. `rewriteBestChain`: entries above `forkHeight`
 * replaced by `hashes`, and the `staged_blocks` rows of the hashes that leave
 * the index deleted, in one transaction. A hash rewritten in place keeps its
 * staged row.
 */
export function rewriteBestChain(forkHeight: number, hashes: readonly string[]): void {
  const db = getDb();
  db.transaction(() => {
    // The hashes that leave: those above `forkHeight` in `best_chain` whose
    // hash is not one of `hashes`. Deleted from `staged_blocks` first so the
    // next step may free the index row.
    const kept = new Set(hashes);
    const leaving = db
      .prepare('SELECT hash FROM best_chain WHERE height > ?')
      .all(forkHeight) as Array<{ hash: string }>;
    const unstageOne = db.prepare('DELETE FROM staged_blocks WHERE hash = ?');
    for (const row of leaving) {
      if (!kept.has(row.hash)) unstageOne.run(row.hash);
    }
    db.prepare('DELETE FROM best_chain WHERE height > ?').run(forkHeight);
    const ins = db.prepare('INSERT INTO best_chain (height, hash) VALUES (?, ?)');
    for (let i = 0; i < hashes.length; i++) {
      ins.run(forkHeight + 1 + i, hashes[i]);
    }
  })();
}

/**
 * NODE_INTERFACE → Header tree. `heaviestHeaders`: rows in descending
 * `chain_work` over `idx_block_headers_work`, read one at a time; a reader
 * stops as soon as its first reachable branch is found (Fork choice decides on
 * verified headers → "The best chain is the heaviest reachable branch.").
 */
export function* heaviestHeaders(): Iterable<HeaderRow> {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM block_headers ORDER BY chain_work DESC');
  for (const row of stmt.iterate() as Iterable<Row>) {
    yield rowToHeaderRow(row);
  }
}

/**
 * NODE_INTERFACE → Header tree. `hasStagedBlock`: point read, no decode;
 * whether an id is staged (for `wantedBlocks` and the switch's wait).
 */
export function hasStagedBlock(hash: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 AS one FROM staged_blocks WHERE hash = ?').get(hash) as
    | { one: number }
    | undefined;
  return row !== undefined;
}

/**
 * NODE_INTERFACE → Header tree. `removeHeaderSubtree`: the row, every
 * descendant, their `best_chain` entries and their `staged_blocks` rows, in one
 * transaction. The subtree is reached through `idx_block_headers_prev` by a
 * recursive CTE.
 */
export function removeHeaderSubtree(hash: string): void {
  const db = getDb();
  db.transaction(() => {
    const subtree = `
      WITH RECURSIVE sub(hash) AS (
        SELECT ?
        UNION ALL
        SELECT bh.hash FROM block_headers bh JOIN sub ON bh.prev_hash = sub.hash
      )
    `;
    db.prepare(
      `${subtree} DELETE FROM best_chain WHERE hash IN (SELECT hash FROM sub)`,
    ).run(hash);
    db.prepare(
      `${subtree} DELETE FROM staged_blocks WHERE hash IN (SELECT hash FROM sub)`,
    ).run(hash);
    db.prepare(
      `${subtree} DELETE FROM block_headers WHERE hash IN (SELECT hash FROM sub)`,
    ).run(hash);
  })();
}

/**
 * NODE_INTERFACE → Header tree. `pruneHeadersBelow`: rows off the best chain
 * below `height`, with their staged blocks. Best-chain rows are kept — they are
 * the applied chain or ahead of it (NODE_INTERFACE → Fork choice decides on
 * verified headers → "Pruning").
 */
export function pruneHeadersBelow(height: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM staged_blocks
       WHERE height < ? AND hash NOT IN (SELECT hash FROM best_chain)`,
    ).run(height);
    db.prepare(
      `DELETE FROM block_headers
       WHERE height < ? AND hash NOT IN (SELECT hash FROM best_chain)`,
    ).run(height);
  })();
}

/**
 * NODE_INTERFACE → Header tree → "A staged block is bytes this node bound":
 * `stageBlock` writes the delivered block alongside the peer that delivered
 * it. One row per hash; the second insert on the same hash is a no-op (the
 * block is already the one the first delivery bound).
 */
export function stageBlock(
  hash: string,
  height: number,
  bytes: Uint8Array,
  fromPeer: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO staged_blocks (hash, height, block_bytes, from_peer)
     VALUES (?, ?, ?, ?)`,
  ).run(hash, height, Buffer.from(bytes), fromPeer);
}

/**
 * NODE_INTERFACE → Header tree. `getStagedBlock`: point read on `hash`; the
 * stored bytes decode to the `OrderingBlock` the binding wrote. A row that
 * will not decode is local corruption, like a stored block's — the caller's
 * `failStopIfCorruptChain` boundary handles it.
 */
export function getStagedBlock(
  hash: string,
): { block: OrderingBlock; fromPeer: string } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT height, block_bytes, from_peer FROM staged_blocks WHERE hash = ?')
    .get(hash) as { height: number; block_bytes: Buffer; from_peer: string } | undefined;
  if (!row) return null;
  let block: OrderingBlock;
  try {
    block = decodeOrderingBlock(new Uint8Array(row.block_bytes));
  } catch (err) {
    throw new UnreadableStoredBlockError('getStagedBlock', row.height, err);
  }
  return { block, fromPeer: row.from_peer };
}

/**
 * NODE_INTERFACE → Header tree. `unstageBlock`: the row leaves when its
 * block applies, when its header leaves the best chain, or when pruned
 * (NODE_INTERFACE → Fork choice decides on verified headers → "A bound block
 * is staged, and applied from staging.").
 */
export function unstageBlock(hash: string): void {
  const db = getDb();
  db.prepare('DELETE FROM staged_blocks WHERE hash = ?').run(hash);
}

