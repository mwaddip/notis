import { getDb } from './db.js';
import { getBox } from './utxo.js';
import { config } from '../config.js';
import { ClientError } from '../services/client-error.js';
import { materializeOutput } from '../services/utxo-engine.js';
import type {
  UtxoTransaction,
  PruneEntry,
  InviteBox,
  VouchBox,
  AnyBox,
} from '@dagsocial/types';
import { encodeTx, decodeTx, computeTxId, computePruneEntryId } from '@dagsocial/types';
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

/**
 * ⛔ **Two entry types, and `batchId` is gone with the pair it regrouped**
 * (MEMPOOL_INTERFACE → PoolEntry). A post and its karma lock were two objects
 * that had to be evicted and re-injected together, which is what `batchId`
 * expressed; a post is now the payload of the lock transaction, so there is one
 * object and nothing to group.
 */
export interface PoolEntry {
  rowid: number;
  entryType: 'utxo_tx' | 'prune';
  utxoTxCbor: Uint8Array | null;
  pruneEntryCbor: Uint8Array | null;
  expiresAtHeight: number;
  createdAt: string;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  utxo_tx_cbor: Buffer | null;
  prune_entry_cbor: Buffer | null;
  expires_at_height: number;
  created_at: string;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'utxo_tx' | 'prune',
    utxoTxCbor: row.utxo_tx_cbor ? new Uint8Array(row.utxo_tx_cbor) : null,
    pruneEntryCbor: row.prune_entry_cbor ? new Uint8Array(row.prune_entry_cbor) : null,
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

// Reserved, never to be reused: `insertSubBlock` and `removeSubBlockEntries`. A
// post enters the pool as the transaction that creates it.

/**
 * The ids of the boxes this transaction would create.
 *
 * Derived through `materializeOutput`, never re-derived here: outputs are
 * client-supplied and may carry any of `id`/`txId`/`index`, and that function is
 * where stripping them and computing the real id is stated. Block application
 * materializes the same outputs through the same call, so the pool's prediction
 * and the block's result cannot disagree.
 */
function outputBoxIds(tx: UtxoTransaction): string[] {
  const txId = computeTxId(tx);
  return (tx.outputs ?? []).map((out, i) => materializeOutput(out, txId, i).id!);
}

export function insertUtxoTx(
  tx: UtxoTransaction,
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
    `INSERT INTO mempool (entry_type, utxo_tx_cbor, expires_at_height,
                          like_target, like_liker, invite_inviter, vouch_voucher,
                          tx_inputs, tx_output_ids)
     VALUES ('utxo_tx', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Buffer.from(cbor),
    expiresAtHeight,
    meta.likeTarget,
    meta.likeLiker,
    meta.inviteInviter,
    meta.vouchVoucher,
    JSON.stringify(inputs),
    JSON.stringify(outputBoxIds(tx)),
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Correctness gates (audit M-8)
//
// SQL over the gate-metadata columns — never a bounded scan. A gate that
// decodes `getPendingEntries(N)` per request cannot see an entry past row N,
// which makes the duplicate-like and pending-invite checks silently
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
 * The box a pooled transaction would create under `boxId`, or `null`.
 *
 * One targeted decode, not a scan: the index finds the single row whose output
 * ids contain `boxId`, and only that entry is decoded. The ids were computed at
 * insert by the same `materializeOutput` the block path uses, so the box
 * returned here is the box application will write.
 */
export function findPendingOutput(boxId: string): AnyBox | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT utxo_tx_cbor FROM mempool
      WHERE tx_output_ids IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(mempool.tx_output_ids) WHERE value = ?)
      LIMIT 1`,
  ).get(boxId) as { utxo_tx_cbor: Buffer } | undefined;
  if (!row) return null;

  const tx = decodeTx(new Uint8Array(row.utxo_tx_cbor));
  const txId = computeTxId(tx);
  for (let i = 0; i < tx.outputs.length; i++) {
    const box = materializeOutput(tx.outputs[i]!, txId, i);
    if (box.id === boxId) return box;
  }
  return null;
}

/**
 * A box as the pending view sees it: the confirmed UTXO set **∪** pending
 * outputs **−** pending inputs.
 *
 * ⛔ **Admission only.** Block application resolves inputs against the confirmed
 * set alone — it imports `getBox` directly — and must keep doing so: letting
 * pool contents decide what a block may spend would make consensus depend on
 * local, unshared state.
 *
 * The subtraction comes first and applies to both halves: a box a pooled entry
 * already spends is not spendable again, whether it was confirmed or is itself
 * pending. That is what lets a chained transaction be admitted while its
 * predecessor's input stays refused.
 */
export function getBoxWithPending(boxId: string): AnyBox | null {
  if (hasPendingSpend([boxId]) !== null) return null;
  return getBox(boxId) ?? findPendingOutput(boxId);
}

/**
 * The pooled transaction that spends `boxId`, or `null`. At most one can exist
 * — that is what the conflicting-spend gate guarantees.
 */
function findPendingSpender(boxId: string): UtxoTransaction | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT utxo_tx_cbor FROM mempool
      WHERE tx_inputs IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(mempool.tx_inputs) WHERE value = ?)
      LIMIT 1`,
  ).get(boxId) as { utxo_tx_cbor: Buffer } | undefined;
  return row ? decodeTx(new Uint8Array(row.utxo_tx_cbor)) : null;
}

/** An owned box — the only kind a spend chain can be followed through. */
type OwnedBox = AnyBox & { owner: Uint8Array };

function isOwned(box: AnyBox): box is OwnedBox {
  return 'owner' in box && (box as OwnedBox).owner instanceof Uint8Array;
}

/**
 * The live tip of `box`'s pending spend chain, or `null` if the chain ends in
 * the box being fully consumed.
 *
 * A node that builds its own transactions — the faucets are the only ones —
 * must spend the change of its pending transaction rather than the box that
 * transaction already consumed. Selecting from the confirmed set alone, two
 * grants in one block interval name the same box and the second is refused;
 * chained, both apply in one block, which is what the apply path's dependency
 * ordering is for.
 *
 * The successor is the output carrying the same owner and box type — the
 * change. This is local selection, not consensus: picking wrong yields a
 * transaction `validateTx` refuses, never a bad accept. A box owned by nobody,
 * or a spend that returns no change, ends the walk at `null`.
 *
 * ⚠ **Reachable only forward from a confirmed box.** A pending output paid to
 * this owner by someone else's transaction is not on any chain rooted here, so
 * it is not found. That errs toward under-counting the balance — a refusal at
 * worst, never an overspend.
 */
export function resolvePendingTip(box: AnyBox): AnyBox | null {
  if (!isOwned(box)) return findPendingSpender(box.id!) === null ? box : null;

  const ownerHex = Buffer.from(box.owner).toString('hex');
  let current: OwnedBox = box;
  // Output ids are hashes of their transaction, so a chain cannot close on
  // itself. The set is what makes that structural fact a local guarantee rather
  // than an assumption about the pool's contents.
  const seen = new Set<string>();

  for (;;) {
    const id = current.id;
    if (id === undefined || seen.has(id)) return null;
    seen.add(id);

    const spender = findPendingSpender(id);
    if (spender === null) return current;

    const txId = computeTxId(spender);
    const change = spender.outputs
      .map((out, i) => materializeOutput(out, txId, i))
      .find((out): out is OwnedBox =>
        out.boxType === current.boxType &&
        isOwned(out) &&
        Buffer.from(out.owner).toString('hex') === ownerHex,
      );
    if (change === undefined) return null;
    current = change;
  }
}

export function getPendingEntries(limit: number): PoolEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, entry_type, utxo_tx_cbor, prune_entry_cbor,
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
