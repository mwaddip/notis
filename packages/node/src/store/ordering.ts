import { getDb } from './db.js';
import {
  encodeHeader,
  decodeHeader,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeInterlinks,
  decodeInterlinks,
} from '@dagsocial/types';
import type { OrderingBlock, BlockHeader } from '@dagsocial/types';
import type { PoPowHeader } from '@dagsocial/nipopow';
import { MAX_NIPOPOW_PARAM } from '@dagsocial/nipopow';
import { blockHash } from '@dagsocial/validation';
import { UnreadableStoredBlockError, UnhashableStoredHeaderError } from '../services/corrupt-state.js';

// ---------------------------------------------------------------------------
// Row shape (blob-based)
// ---------------------------------------------------------------------------

interface OrderingBlockRow {
  height: number;
  header_bytes: Buffer;
  utxotx_tree_bytes: Buffer;
  validator_signature: Buffer;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The one frame that knows these bytes are ours.
 *
 * A decode failure here is never "bad input" — nothing a peer sends is stored
 * in these two columns, only this node's own re-encoding of a block that
 * already cleared the apply gate (the full argument, with the writer
 * enumeration and the rejected alternative, is on `UnreadableStoredBlockError`).
 * Downstream that fact is gone: `applyOrderingBlock`'s totality catch sees a
 * `ReaderError` and cannot tell it from the one `decodeTx` raises over the
 * block's own `utxoTxs`, which is peer-chosen and an ordinary rejection. And
 * apply is only one of six callers — `extendsOurTip`, `findForkPoint`,
 * `revertBlock`, the block creator and two routes read through here too, none
 * of them through a catch that could promote anything.
 *
 * `CorruptChainStateError` is what that catch already re-throws and what
 * `failStopIfCorruptChain` already stops for, so this needs no boundary edit:
 * exactly the property `corrupt-state.test.ts` pins as "a third kind must not
 * need a boundary edit to be fatal".
 */
function rowToOrderingBlock(row: OrderingBlockRow): OrderingBlock {
  try {
    return {
      header: decodeHeader(new Uint8Array(row.header_bytes)),
      utxoTxTree: decodeUtxoTxTree(new Uint8Array(row.utxotx_tree_bytes)),
      validatorSignature: new Uint8Array(row.validator_signature),
    };
  } catch (err) {
    // Every throw, not only `ReaderError`. The codec's contract is that decode
    // raises `ReaderError` (`CodecError` extends it), but the claim being made
    // is about the *bytes* — that they are ours — and that holds however the
    // decoder fails. Narrowing to a class would leave a `TypeError` from a
    // decoder bug reported as an arriving block's rejection, which is the same
    // misattribution one layer down.
    throw new UnreadableStoredBlockError('getOrderingBlock', row.height, err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new ordering block — the only write path into `ordering_blocks`.
 *
 * **The provenance claim, stated here because several arguments elsewhere rest
 * on it.** This is the table's only INSERT, and in `src` it has exactly one
 * caller: `block-apply.ts` imports it as `storeCreateOrderingBlock` and calls
 * it from `applyBlockBody`. What it stores is `encodeHeader` /
 * `encodeUtxoTxTree` **of the decoded block** — this
 * node's own re-encoding, never the bytes a peer sent. So no input a peer can
 * choose reaches a reader of this table, and a row that disagrees with our own
 * writer means local corruption or a bug in us.
 *
 * **Two gates sit above that call and they are not interchangeable.**
 * `applyOrderingBlock` runs `verifyOrderingBlockStructure` before the body,
 * whose header checks *are* `verifyHeaderFieldDomains`; `applyBlockBody` runs
 * its own `prevBlockHash` and height chain-link checks above the call. A site
 * citing this claim names whichever of the two its own conclusion needs — a
 * `blockHash` of `null` needs the header-domain gate, an all-zeros height-1
 * `prevBlockHash` needs the chain-link one.
 *
 * ⚠ **A second writer belongs nowhere else.** Added here it lands directly
 * under the sentence saying there is one; added anywhere else it falsifies
 * every argument above and nothing says so.
 *
 * ⚠ **Neither obvious grep re-derives the enumeration.** `createOrderingBlock`
 * is also the block creator's own function (`services/block-creator.ts`), so a
 * search on the exported name returns two unrelated functions, and a search on
 * the alias returns only the sites already using the alias. Re-derive by arity
 * — this writer takes a block, the creator's takes nothing — or by import
 * source, and search the table name for the INSERT. The claim is about `src`:
 * tests write through this writer or through the raw-SQL poison helper that
 * exists to store rows this guard refuses.
 */
export function createOrderingBlock(block: OrderingBlock, interlinks: string[]): void {
  const db = getDb();

  // The row's `block_hash` is computed here from the node's own decoded header.
  // The gates above this writer's one caller — `verifyHeaderFieldDomains` via
  // `verifyOrderingBlockStructure` — exclude headers `blockHash` rejects, so a
  // null here is a bug in us, not bad input.
  const hash = blockHash(block.header);
  if (hash === null) {
    throw new UnhashableStoredHeaderError('createOrderingBlock', block.header.height);
  }

  db.prepare(
    `INSERT INTO ordering_blocks
       (height, header_bytes, utxotx_tree_bytes,
        validator_signature, created_at, block_hash, interlinks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    block.header.height,
    Buffer.from(encodeHeader(block.header)),
    Buffer.from(encodeUtxoTxTree(block.utxoTxTree)),
    Buffer.from(block.validatorSignature),
    block.header.createdAt,
    hash,
    Buffer.from(encodeInterlinks(interlinks)),
  );
}

/**
 * Retrieve an ordering block by height.
 * Returns null if no block exists at that height.
 */
export function getOrderingBlock(height: number): OrderingBlock | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM ordering_blocks WHERE height = ?')
    .get(height) as OrderingBlockRow | undefined;
  return row ? rowToOrderingBlock(row) : null;
}

/**
 * Delete an ordering block at the given height (for rollback).
 */
export function deleteOrderingBlock(height: number): void {
  getDb().prepare('DELETE FROM ordering_blocks WHERE height = ?').run(height);
}

/**
 * Return the current chain height (max height in ordering_blocks).
 * Returns 0 if no blocks exist yet.
 */
/**
 * Return the block header's `createdAt` for a given height, or null if no
 * block exists there. The column stores the header value directly
 * (`storeOrderingBlock` writes `block.header.createdAt`).
 */
export function getBlockCreatedAt(height: number): number | null {
  const row = getDb()
    .prepare('SELECT created_at FROM ordering_blocks WHERE height = ?')
    .get(height) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

export function getCurrentHeight(): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COALESCE(MAX(height), 0) AS h FROM ordering_blocks')
    .get() as { h: number };
  return row.h;
}

/**
 * The height of the block that would carry a transaction admitted now — the tip
 * plus one. A transaction is judged at the height of the block that would carry
 * it, so admission reads this rather than the tip (NODE_INTERFACE → validateTx).
 */
export function nextBlockHeight(): number {
  return getCurrentHeight() + 1;
}

export function getOrderingBlockHash(height: number): string | null {
  const row = getDb()
    .prepare('SELECT block_hash FROM ordering_blocks WHERE height = ?')
    .get(height) as { block_hash: string } | undefined;
  return row?.block_hash ?? null;
}

export function getHeightByBlockHash(hash: string): number | null {
  const row = getDb()
    .prepare('SELECT height FROM ordering_blocks WHERE block_hash = ?')
    .get(hash) as { height: number } | undefined;
  return row?.height ?? null;
}

/**
 * The stored interlink vector at a height, decoded; `null` for no row
 * (NODE_INTERFACE → Ordering blocks).
 */
export function getInterlinks(height: number): string[] | null {
  const row = getDb()
    .prepare('SELECT interlinks FROM ordering_blocks WHERE height = ?')
    .get(height) as { interlinks: Buffer } | undefined;
  if (!row) return null;
  return decodeInterlinks(new Uint8Array(row.interlinks));
}

// ---------------------------------------------------------------------------
// Nipopow reader reads (NODE_INTERFACE → Nipopow reader)
// ---------------------------------------------------------------------------

interface PopowRow {
  header_bytes: Buffer;
  interlinks: Buffer;
}

// NODE_INTERFACE → Nipopow reader: every throw, not only `ReaderError`
function rowToPopowHeader(row: PopowRow, site: string, height: number): PoPowHeader {
  try {
    return {
      header: decodeHeader(new Uint8Array(row.header_bytes)),
      interlinks: decodeInterlinks(new Uint8Array(row.interlinks)),
    };
  } catch (err) {
    throw new UnreadableStoredBlockError(site, height, err);
  }
}

export function getPopowHeaderByHash(hash: string): PoPowHeader | null {
  const row = getDb()
    .prepare('SELECT header_bytes, interlinks, height FROM ordering_blocks WHERE block_hash = ?')
    .get(hash) as (PopowRow & { height: number }) | undefined;
  return row ? rowToPopowHeader(row, 'getPopowHeaderByHash', row.height) : null;
}

export function getPopowHeaderAtHeight(height: number): PoPowHeader | null {
  const row = getDb()
    .prepare('SELECT header_bytes, interlinks FROM ordering_blocks WHERE height = ?')
    .get(height) as PopowRow | undefined;
  return row ? rowToPopowHeader(row, 'getPopowHeaderAtHeight', height) : null;
}

/** Decode each row's header, tagging a corrupt one with the reading function's name. */
function decodeHeaderRows(
  rows: Array<{ header_bytes: Buffer; height: number }>,
  fnName: string,
): BlockHeader[] {
  return rows.map((row) => {
    try {
      return decodeHeader(new Uint8Array(row.header_bytes));
    } catch (err) {
      throw new UnreadableStoredBlockError(fnName, row.height, err);
    }
  });
}

export function getLastHeaders(n: number): BlockHeader[] {
  if (n > MAX_NIPOPOW_PARAM) n = MAX_NIPOPOW_PARAM;
  const rows = getDb()
    .prepare('SELECT header_bytes, height FROM ordering_blocks ORDER BY height DESC LIMIT ?')
    .all(n) as Array<{ header_bytes: Buffer; height: number }>;
  rows.reverse();
  return decodeHeaderRows(rows, 'getLastHeaders');
}

export function getHeadersAfter(height: number, n: number): BlockHeader[] {
  if (n > MAX_NIPOPOW_PARAM) n = MAX_NIPOPOW_PARAM;
  const rows = getDb()
    .prepare('SELECT header_bytes, height FROM ordering_blocks WHERE height > ? ORDER BY height ASC LIMIT ?')
    .all(height, n) as Array<{ header_bytes: Buffer; height: number }>;
  return decodeHeaderRows(rows, 'getHeadersAfter');
}

/**
 * Headers above `height`, ascending, at most `n` — the caller bounds `n`.
 *
 * Not the NiPoPoW prover's read (`getHeadersAfter`, capped at
 * `MAX_NIPOPOW_PARAM`): fork resolution needs every header above the fork
 * for `ourWork`, which can be up to `maxReorgDepth` (NODE_INTERFACE →
 * Store Interface → Ordering blocks).
 */
export function getHeadersAbove(height: number, n: number): BlockHeader[] {
  const rows = getDb()
    .prepare('SELECT header_bytes, height FROM ordering_blocks WHERE height > ? ORDER BY height ASC LIMIT ?')
    .all(height, n) as Array<{ header_bytes: Buffer; height: number }>;
  return decodeHeaderRows(rows, 'getHeadersAbove');
}
