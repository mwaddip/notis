import { getDb } from './db.js';
import {
  decodeHeader,
  decodeInterlinks,
  decodeOrderingBlock,
  encodeHeader,
  encodeInterlinks,
  updateInterlinks,
} from '@dagsocial/types';
import { blockWork, level } from '@dagsocial/validation';
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
 * replaced by `hashes`, in one transaction. `hashes[i]` lands at height
 * `forkHeight + 1 + i`.
 */
export function rewriteBestChain(forkHeight: number, hashes: readonly string[]): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM best_chain WHERE height > ?').run(forkHeight);
    const ins = db.prepare('INSERT INTO best_chain (height, hash) VALUES (?, ?)');
    for (let i = 0; i < hashes.length; i++) {
      ins.run(forkHeight + 1 + i, hashes[i]);
    }
  })();
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
    .prepare('SELECT block_bytes, from_peer FROM staged_blocks WHERE hash = ?')
    .get(hash) as { block_bytes: Buffer; from_peer: string } | undefined;
  if (!row) return null;
  return {
    block: decodeOrderingBlock(new Uint8Array(row.block_bytes)),
    fromPeer: row.from_peer,
  };
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

/**
 * NODE_INTERFACE → Fork choice decides on verified headers → "The header tree
 * is every stored header": in production, admission writes each row before
 * apply. A node whose chain was built outside the pipeline — fixtures that
 * drive the apply funnel directly, a store seeded by other means — reaches
 * the pipeline with headers in `ordering_blocks` and no rows in
 * `block_headers`. This function walks the applied chain once and inserts
 * missing rows, and drops any `best_chain` row above the applied tip (left
 * by a revert whose caller did not rewrite the tree), bringing the tree in
 * sync with the applied chain so a mined block or a page admitted next finds
 * its parent.
 *
 * Idempotent per row: a row already present is left as it stands. The
 * `anchorBits` is the profile's anchor bits for `level` on the parent header.
 */
export function syncHeaderTreeFromApplied(anchorBits: number): void {
  const db = getDb();
  const tipRow = db.prepare('SELECT MAX(height) AS h FROM ordering_blocks').get() as { h: number | null };
  const tipHeight = tipRow?.h ?? 0;
  // Drop best_chain and block_headers rows above the applied tip: a revert
  // whose caller did not rewrite the tree leaves them pointing at reverted
  // blocks, and admission reads best_chain for both "the extension gate" and
  // "the switch" — a stale row would refuse mining or score the mined block
  // as a side branch.
  db.prepare('DELETE FROM best_chain WHERE height > ?').run(tipHeight);
  db.prepare('DELETE FROM block_headers WHERE height > ?').run(tipHeight);
  if (tipHeight <= 0) return;
  // Iterate heights 1..tipHeight, caching the previous row to carry
  // chainWork, interlinks and pathTa forward.
  let prevRow: HeaderRow | null = null;
  let prevHashHex: string | null = null;
  for (let h = 1; h <= tipHeight; h++) {
    const row = db.prepare('SELECT header_bytes, interlinks, block_hash FROM ordering_blocks WHERE height = ?').get(h) as
      | { header_bytes: Buffer; interlinks: Buffer; block_hash: string }
      | undefined;
    if (row === undefined) break;
    const hashHex = row.block_hash;
    // The best chain tracks the applied chain — a stale best_chain row at
    // this height (from an earlier branch that got reverted) is overwritten
    // to match the applied block.
    const bestAt = db.prepare('SELECT hash FROM best_chain WHERE height = ?').get(h) as { hash: string } | undefined;
    if (bestAt !== undefined && bestAt.hash !== hashHex) {
      db.prepare('DELETE FROM best_chain WHERE height = ?').run(h);
    }
    const already = db.prepare('SELECT hash FROM block_headers WHERE hash = ?').get(hashHex) as { hash: string } | undefined;
    if (already !== undefined) {
      // Keep the row; make sure best_chain names it.
      const bestNow = db.prepare('SELECT hash FROM best_chain WHERE height = ?').get(h) as { hash: string } | undefined;
      if (bestNow === undefined) {
        db.prepare('INSERT INTO best_chain (height, hash) VALUES (?, ?)').run(h, hashHex);
      }
      prevRow = getHeaderRow(hashHex);
      prevHashHex = hashHex;
      continue;
    }
    let header: BlockHeader;
    try {
      header = decodeHeader(new Uint8Array(row.header_bytes));
    } catch (err) {
      throw new UnreadableStoredBlockError('syncHeaderTreeFromApplied', h, err);
    }
    const workHere = blockWork(header.powTargetBits);
    if (workHere === null) {
      // A stored header outside the work domain is local corruption — same
      // class a decode refuses raises.
      throw new UnreadableStoredBlockError('syncHeaderTreeFromApplied', h, new Error('powTargetBits outside domain'));
    }
    const parentChainWork = prevRow?.chainWork ?? 0n;
    const chainWork = parentChainWork + workHere;
    // The interlinks the header commits to — the vector built from the
    // parent's interlinks and `level(parent, anchorBits)`. For height 1 the
    // vector is empty.
    let interlinks: string[];
    if (h === 1 || prevRow === null) {
      interlinks = [];
    } else {
      const parentLevel = level(prevRow.header, anchorBits);
      interlinks = parentLevel === null
        ? prevRow.interlinks
        : updateInterlinks(prevRow.interlinks, prevHashHex!, parentLevel);
    }
    const pathTa = h === 1 ? (header.createdAt ?? 0) : (prevRow?.pathTa ?? 0);
    insertHeader({
      hash: hashHex,
      height: h,
      prevHash: header.prevBlockHash,
      header,
      interlinks,
      chainWork,
      pathTa,
    });
    // The best chain tracks the applied chain — a sync inserts the row and
    // the best_chain entry together (NODE_INTERFACE → "An admitted header is
    // stored when it extends the best chain.").
    const bestHere = db.prepare('SELECT hash FROM best_chain WHERE height = ?').get(h) as { hash: string } | undefined;
    if (bestHere === undefined) {
      db.prepare('INSERT INTO best_chain (height, hash) VALUES (?, ?)').run(h, hashHex);
    }
    prevRow = getHeaderRow(hashHex);
    prevHashHex = hashHex;
  }
}
