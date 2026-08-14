import { getDb } from './db.js';
import { config } from '../config.js';
import { ClientError } from '../services/client-error.js';
import type {
  UtxoTransaction,
  PruneEntry,
  InviteBox,
  VouchBox,
} from '@dagsocial/types';
import { encodeTx, computePruneEntryId } from '@dagsocial/types';
import { encode as cborEncode, decode as cborDecode } from 'cbor-x';

/**
 * Thrown by every mempool insert when the pool is at `MAX_MEMPOOL_ENTRIES`.
 * Rejection, not eviction: eviction needs fee-based prioritization and there
 * are no fees yet (audit M-8). Routes map this to 503; the gossip relay and
 * reorg re-insertion drop the entry and log.
 */
export class MempoolFullError extends Error {
  constructor(public readonly cap: number) {
    super(`Mempool full: at capacity (${cap} entries)`);
    this.name = 'MempoolFullError';
  }
}

/**
 * Thrown by `insertUtxoTx` when one of the transaction's inputs is already
 * spent by an entry the pool holds.
 *
 * Two pooled transactions naming one box put both into one block, where the
 * first spends the box and the second cannot apply — the state a block is
 * invalid for carrying (NODE_INTERFACE → the apply funnel's block validity).
 * Refusing at admission is what keeps this node from composing such a block.
 *
 * A `ClientError`, so the refusal reaches the submitter as its own message
 * rather than a generic 500: a pool declining a conflicting spend is an
 * intentional rejection, not a fault. 409, because the request is well formed
 * and conflicts with state the pool already holds.
 */
export class PendingSpendConflictError extends ClientError {
  constructor(public readonly boxId: string) {
    super(`Input ${boxId} is already spent by a pending transaction`, 409);
    this.name = 'PendingSpendConflictError';
  }
}

export interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx' | 'prune';
  subblockId: string | null;
  utxoTxCbor: Uint8Array | null;
  pruneEntryCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  subblock_id: string | null;
  utxo_tx_cbor: Buffer | null;
  prune_entry_cbor: Buffer | null;
  batch_id: string | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'subblock' | 'utxo_tx' | 'prune',
    subblockId: row.subblock_id,
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    pruneEntryCbor: row.prune_entry_cbor ? new Uint8Array(row.prune_entry_cbor) : null,
    batchId: row.batch_id,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
  };
}

/**
 * Reject the insert when the pool is already at the configured cap. Checked by
 * every insert path — an unbounded pool was a disk-DoS lever (audit M-8).
 */
function assertCapacity(db: ReturnType<typeof getDb>): void {
  const cap = config.maxMempoolEntries;
  const row = db.prepare('SELECT COUNT(*) AS n FROM mempool').get() as { n: number };
  if (row.n >= cap) throw new MempoolFullError(cap);
}

interface GateMetadata {
  likeTarget: string | null;
  likeLiker: string | null;
  inviteInviter: string | null;
  vouchVoucher: string | null;
}

/**
 * Lift the fields the correctness gates query on. This is the single chokepoint
 * every insertion path (HTTP routes and gossip relay alike) passes through,
 * which is what makes the gates unable to miss an entry. First output of each
 * kind wins for the output-derived columns — the gate columns are singular per
 * the contract, matching the services' own `outputs.find(...)` semantics.
 *
 * The like columns derive from the tx-level `likeTarget` field: a like is a
 * burn transaction, not a box. The liker is the karma inputs' owner — the
 * single signing key. The store cannot resolve input boxes, so the signature
 * map is where the transaction itself names that key; `castLike` enforces
 * exactly one signature on entry, and a multi-key map derives no liker (the
 * unpaired row matches no `hasPendingLike` query, and a spare signature cannot
 * pin someone else's `(liker, target)` pair).
 */
function gateMetadata(tx: UtxoTransaction): GateMetadata {
  const meta: GateMetadata = {
    likeTarget: null,
    likeLiker: null,
    inviteInviter: null,
    vouchVoucher: null,
  };

  if (tx.likeTarget !== undefined) {
    meta.likeTarget = tx.likeTarget;
    const signers = Object.keys(tx.signatures ?? {});
    meta.likeLiker = signers.length === 1 ? signers[0]! : null;
  }

  for (const output of tx.outputs ?? []) {
    if (output.boxType === 'invite' && meta.inviteInviter === null) {
      meta.inviteInviter = Buffer.from((output as InviteBox).inviterId).toString('hex');
    } else if (output.boxType === 'vouch' && meta.vouchVoucher === null) {
      meta.vouchVoucher = Buffer.from((output as VouchBox).voucherId).toString('hex');
    }
  }

  return meta;
}

export function insertSubBlock(
  postId: string,
  expiresAtHeight: number,
  batchId: string | null = null,
): number {
  const db = getDb();
  assertCapacity(db);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, subblock_id, batch_id, expires_at_height)
     VALUES ('subblock', ?, ?, ?)`,
  ).run(postId, batchId, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

export function insertUtxoTx(
  tx: UtxoTransaction,
  batchId: string | null,
  expiresAtHeight: number,
): number {
  const db = getDb();
  assertCapacity(db);

  const inputs = tx.inputs ?? [];
  const conflict = hasPendingSpend(inputs);
  if (conflict !== null) throw new PendingSpendConflictError(conflict);

  const cbor = encodeTx(tx);
  const meta = gateMetadata(tx);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, utxo_tx_cbor, batch_id, expires_at_height,
                          like_target, like_liker, invite_inviter, vouch_voucher,
                          tx_inputs)
     VALUES ('utxo_tx', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Buffer.from(cbor),
    batchId,
    expiresAtHeight,
    meta.likeTarget,
    meta.likeLiker,
    meta.inviteInviter,
    meta.vouchVoucher,
    JSON.stringify(inputs),
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Correctness gates (audit M-8)
//
// SQL over the gate-metadata columns — never a bounded scan. A gate that
// decodes `getPendingEntries(N)` per request cannot see an entry past row N,
// which makes the duplicate-like and MAX_PENDING_INVITES checks silently
// partial. Parameters are hex strings, compared against the columns as stored.
// ---------------------------------------------------------------------------

export function hasPendingLike(targetPostId: string, likerId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM mempool WHERE like_target = ? AND like_liker = ? LIMIT 1`,
  ).get(targetPostId, likerId);
  return row !== undefined;
}

export function countPendingInvites(inviterId: string): number {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM mempool WHERE invite_inviter = ?`,
  ).get(inviterId) as { n: number };
  return row.n;
}

export function hasPendingVouch(voucherId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM mempool WHERE vouch_voucher = ? LIMIT 1`,
  ).get(voucherId);
  return row !== undefined;
}

/**
 * The first of `boxIds` already spent by a pending entry, or `null` when none
 * is. Returned rather than a boolean so the refusal can name the box that
 * collided instead of only reporting that one did.
 *
 * `tx_inputs IS NOT NULL` is what the partial index covers, and it is the whole
 * filter needed: sub-block and prune rows carry no inputs, and a row written
 * before the column existed reads as zero `json_each` rows.
 */
export function hasPendingSpend(boxIds: string[]): string | null {
  if (boxIds.length === 0) return null;
  const db = getDb();
  const stmt = db.prepare(
    `SELECT 1 FROM mempool
      WHERE tx_inputs IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(mempool.tx_inputs) WHERE value = ?)
      LIMIT 1`,
  );
  for (const id of boxIds) {
    if (stmt.get(id) !== undefined) return id;
  }
  return null;
}

/**
 * Delete confirmed sub-block entries by postId — a keyed DELETE, never a
 * bounded fetch-and-find loop, which would stop removing entries past its cap
 * (bookkeeping only — no consensus behaviour change). Chunked because a single
 * block may carry up to `maxSubBlocksPerBlock` refs, above SQLite's bound
 * parameter limit.
 */
export function removeSubBlockEntries(postIds: string[]): number {
  if (postIds.length === 0) return 0;
  const db = getDb();
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < postIds.length; i += CHUNK) {
    const chunk = postIds.slice(i, i + CHUNK);
    const result = db.prepare(
      `DELETE FROM mempool
       WHERE entry_type = 'subblock'
         AND subblock_id IN (${chunk.map(() => '?').join(',')})`,
    ).run(...chunk);
    removed += result.changes;
  }
  return removed;
}

export function getPendingEntries(limit: number): PoolEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, entry_type, subblock_id, utxo_tx_cbor, prune_entry_cbor, batch_id,
            expires_at_height, created_at
     FROM mempool
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(limit) as MempoolRow[];
  return rows.map(rowToEntry);
}

export function purgeExpired(currentHeight: number): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM mempool WHERE expires_at_height < ?',
  ).run(currentHeight);
  return result.changes;
}

export function removeEntry(rowid: number): void {
  const db = getDb();
  db.prepare('DELETE FROM mempool WHERE rowid = ?').run(rowid);
}

/**
 * The `prune_entry_cbor` blob is written and read by this module alone — it is
 * a local pool row, on no wire and under no committed root — so its codec is
 * the `cborEncode`/`cborDecode` pair above, stated once and symmetric by
 * construction. A consensus encoder must not be borrowed for it: those state a
 * committed layout that is `@dagsocial/types`' to change, and a dialect change
 * there is invisible to a reader in this package.
 */
export function insertMempoolPrune(
  entry: PruneEntry,
  expiresAtHeight: number,
): number {
  const db = getDb();
  assertCapacity(db);
  const cbor = Buffer.from(cborEncode(entry));
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, prune_entry_cbor, expires_at_height)
     VALUES ('prune', ?, ?)`,
  ).run(cbor, expiresAtHeight);
  return Number(result.lastInsertRowid);
}

/**
 * One row's entry, or `null` when this node cannot read a blob it wrote.
 *
 * Isolated per row, and it decides two things at once. A sibling's failure must
 * not destroy a readable row — a bulk `map` after a bulk DELETE loses the
 * whole batch to one bad blob. And the unreadable row is dropped rather than
 * re-raised, because it sits in front of `drainMempoolPrunes`, the miner's
 * first read at every block interval: a row nobody can decode would otherwise
 * stop the node producing for as long as it stays, and this blob is local,
 * uncommitted, and re-issuable by its author. Loud, because a store that
 * returns something its own writer cannot have produced is a defect, not an
 * event.
 */
function decodePruneRow(row: { rowid: number; prune_entry_cbor: Buffer }): PruneEntry | null {
  try {
    return cborDecode(row.prune_entry_cbor) as PruneEntry;
  } catch (err) {
    console.error(`Dropping unreadable mempool prune row ${row.rowid}:`, err);
    return null;
  }
}

export function drainMempoolPrunes(limit: number): PruneEntry[] {
  const db = getDb();
  // Every row is decoded before the DELETE and inside one transaction: the
  // blob is the entry's only copy, so nothing is removed until its own read has
  // returned a verdict.
  return db.transaction((): PruneEntry[] => {
    const rows = db.prepare(
      `SELECT rowid, prune_entry_cbor FROM mempool
       WHERE entry_type = 'prune'
       ORDER BY rowid ASC LIMIT ?`,
    ).all(limit) as Array<{ rowid: number; prune_entry_cbor: Buffer }>;

    if (rows.length === 0) return [];

    const entries = rows.map(decodePruneRow);

    const ids = rows.map(r => r.rowid);
    db.prepare(
      `DELETE FROM mempool WHERE rowid IN (${ids.map(() => '?').join(',')})`,
    ).run(...ids);

    return entries.filter((e): e is PruneEntry => e !== null);
  })();
}

/**
 * Remove prune entries from the mempool by their computed entry IDs.
 * O(n) full scan over all prune entries in mempool — callsite is reorg(),
 * which is infrequent and typically operates on a small mempool.
 */
export function removeMempoolPrunes(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const db = getDb();

  // Read all prune entries, compute their IDs, and delete matches
  const rows = db.prepare(
    `SELECT rowid, prune_entry_cbor FROM mempool WHERE entry_type = 'prune'`,
  ).all() as Array<{ rowid: number; prune_entry_cbor: Buffer }>;

  const toDelete: number[] = [];
  for (const row of rows) {
    // Same isolation as the drain, and here it also keeps a reorg from failing
    // on a row it was not looking for.
    const entry = decodePruneRow(row);
    if (entry === null) continue;
    const id = computePruneEntryId(entry);
    if (entryIds.includes(id)) {
      toDelete.push(row.rowid);
    }
  }

  if (toDelete.length > 0) {
    db.prepare(
      `DELETE FROM mempool WHERE rowid IN (${toDelete.map(() => '?').join(',')})`,
    ).run(...toDelete);
  }
}
