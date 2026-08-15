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
import {
  MAX_TX_BYTES,
  MEMPOOL_CREDIT_SHARE_PCT,
  encodeTx,
  decodeTx,
  computeTxId,
  computePruneEntryId,
  utxoTxTreeByteLength,
} from '@dagsocial/types';
import { isCreditSideTx } from '../services/coinbase-split.js';
import { encode as cborEncode, decode as cborDecode } from 'cbor-x';

/**
 * Which half of the pool an entry occupies (MEMPOOL_INTERFACE → Eviction,
 * inside the credit class only). A credit-side transaction can bid; nothing
 * else in the system can, which is why the two are capped apart.
 */
export type PoolClass = 'credit' | 'karma';

/**
 * Thrown when the entry's **class** is full — the pool as a whole may have room.
 *
 * The karma-side class rejects at its cap and never evicts: every entry in it
 * bids zero, so there is nothing to order by and nothing that deserves to
 * displace anything. The credit class rejects only a transaction bidding at or
 * below its cheapest resident; a higher bid displaces that resident instead
 * (audit M-8, and the fee market that superseded its deferral).
 *
 * Routes map this to 503; the gossip relay and reorg re-insertion drop the
 * entry and log.
 */
export class MempoolFullError extends Error {
  constructor(
    public readonly cap: number,
    public readonly poolClass: PoolClass = 'karma',
  ) {
    super(`Mempool full: ${poolClass} class at capacity (${cap} entries)`);
    this.name = 'MempoolFullError';
  }
}

// ---------------------------------------------------------------------------
// Entry sizing
//
// Every number here comes from `utxoTxTreeByteLength`. The framing a
// transaction costs inside a body is the encoder's arithmetic and moves when
// the encoding does (TYPES_INTERFACE → Sizing without encoding); restating it
// here would put a second copy of the layout where nothing compares the two,
// which is the reason that export exists at all.
// ---------------------------------------------------------------------------

/** An empty body: four count prefixes and nothing else. */
const EMPTY_BODY_BYTES = utxoTxTreeByteLength({
  utxoTxIds: [],
  utxoTxs: [],
  pruneEntries: [],
  coinbaseOutputs: [],
});

/** A well-formed stand-in, so the probe below measures a real `b32` entry. */
const PROBE_TX_ID = '0'.repeat(64);

/**
 * What one transaction costs **inside a block body** — its fixed-width
 * `utxoTxIds` entry and the length-prefixed body beside it.
 *
 * The difference between a one-entry body and an empty one is exactly that
 * entry's contribution, because every other term of the sum is unchanged.
 *
 * This, not the bare encoded length, is what a fee is divided by: the block
 * budget is what 3a made scarce, and a transaction should be ranked by the
 * resource it actually consumes. The block creator spends the same number
 * against the same budget.
 */
export function entryByteCost(cbor: Uint8Array): number {
  return (
    utxoTxTreeByteLength({
      utxoTxIds: [PROBE_TX_ID],
      utxoTxs: [cbor],
      pruneEntries: [],
      coinbaseOutputs: [],
    }) - EMPTY_BODY_BYTES
  );
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
 * Thrown by `insertUtxoTx` for a transaction above `MAX_TX_BYTES`.
 *
 * ⛔ **The bound is consensus and this node calls no function that checks it.**
 * `verifyTxStructure` is where the rule lives (VALIDATION_INTERFACE → the
 * transaction size bound), and node's only entry into that namespace is the
 * whole object it hands `NetNode` — so the live call site is net's gossip
 * validator, and a transaction submitted to this node's own HTTP API reaches no
 * such check. Without this one it is admitted, drawn into a block by the
 * creator, and refused by this node's own `applyOrderingBlock`: work mined and
 * then thrown away by the miner that mined it.
 *
 * Admission is the choke point rather than each route, so a route added later
 * inherits the rule instead of needing it added — the same reason the gate
 * metadata is lifted here (audit M-8).
 *
 * **`encodeTx(tx).length` is the measure**, because that is the encoding these
 * bytes will ride in a block under: `insertUtxoTx` stores this node's own
 * re-encoding, not the bytes a submitter sent, so measuring the re-encoding
 * measures exactly the future cost.
 *
 * A `ClientError`, so the refusal reaches the submitter as its own message: an
 * over-size transaction is an intentional rejection, not a fault. 413, because
 * the request is well formed and too large.
 */
export class TxTooLargeError extends ClientError {
  constructor(public readonly encodedBytes: number) {
    super(
      `Transaction is ${encodedBytes} bytes, above the ${MAX_TX_BYTES}-byte ` +
        'limit — no block can carry it',
      413,
    );
    this.name = 'TxTooLargeError';
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
 * The two class caps. Credit entries hold `MEMPOOL_CREDIT_SHARE_PCT` of the
 * bound and karma-side entries hold the remainder, so a credit flood cannot
 * take the whole pool (MEMPOOL_INTERFACE → Eviction, inside the credit class
 * only).
 *
 * The karma cap takes the remainder rather than its own percentage, for the
 * same reason the miner floor does: two truncated shares of one bound do not
 * add back to it, and a pool that admits fewer entries than its own cap says is
 * a bound nobody can reason about.
 */
function classCaps(): { credit: number; karma: number } {
  const cap = config.maxMempoolEntries;
  const credit = Math.floor((cap * MEMPOOL_CREDIT_SHARE_PCT) / 100);
  return { credit, karma: cap - credit };
}

/**
 * How many entries each class currently holds.
 *
 * ⛔ **`tx_fee` alone decides, and the two counts partition the table.** Only a
 * credit-side transaction ever sets it, so `IS NULL` catches karma-side
 * transactions, prune entries and rows written before the column existed alike
 * — all of which bid nothing and belong to the class that does not order by
 * price. Filtering on `entry_type` as well would leave prune entries counted by
 * neither class and therefore bounded by nothing.
 */
function classCount(db: ReturnType<typeof getDb>, poolClass: PoolClass): number {
  const test = poolClass === 'credit' ? 'IS NOT NULL' : 'IS NULL';
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM mempool WHERE tx_fee ${test}`,
  ).get() as { n: number };
  return row.n;
}

/**
 * The cheapest credit entry in the pool, or `null` when the class is empty.
 *
 * ⚠ **The `REAL` is deliberate and it is safe HERE and nowhere else in this
 * package.** Ordering the pool is node-local relay policy that no validator
 * ever recomputes (MEMPOOL_INTERFACE → Ordering): two nodes may hold different
 * entries in a different order and both are correct. The integer alternative —
 * a rate scaled by a constant and stored — overflows: `tx_fee` alone can reach
 * the whole credit supply, and any scaling of it exceeds SQLite's signed 64-bit
 * INTEGER. Storing the fee and the byte cost apart, and dividing only to
 * compare, has no such ceiling.
 *
 * ⛔ **Do not copy this into a consensus path.** A float intermediate anywhere
 * producer and verifier must agree is a chain split.
 *
 * `rowid` breaks a tie, so equal bids are displaced in arrival order.
 */
function cheapestCreditEntry(
  db: ReturnType<typeof getDb>,
): { rowid: number; fee: bigint; bytes: number } | null {
  const row = db.prepare(
    `SELECT rowid, tx_fee, tx_bytes FROM mempool
      WHERE entry_type = 'utxo_tx' AND tx_fee IS NOT NULL AND tx_bytes > 0
      ORDER BY CAST(tx_fee AS REAL) / tx_bytes ASC, rowid ASC
      LIMIT 1`,
  ).get() as { rowid: number; tx_fee: number | bigint; tx_bytes: number } | undefined;
  if (!row) return null;
  return { rowid: row.rowid, fee: BigInt(row.tx_fee), bytes: row.tx_bytes };
}

/**
 * Make room for an arriving entry, or refuse it.
 *
 * Karma-side rejects at its cap: nothing in that class bids, so there is no
 * basis on which one entry deserves another's slot. The credit class compares
 * the arrival against its cheapest resident and displaces it when the arrival
 * pays more per byte — cross-multiplied, because THIS comparison decides
 * whether a transaction is dropped and the float above is only an ordering.
 *
 * Checked by every insert path — an unbounded pool was a disk-DoS lever
 * (audit M-8).
 */
function assertCapacity(
  db: ReturnType<typeof getDb>,
  poolClass: PoolClass,
  fee: bigint | null,
  bytes: number,
): void {
  const caps = classCaps();

  if (poolClass === 'karma' || fee === null) {
    if (classCount(db, 'karma') >= caps.karma) throw new MempoolFullError(caps.karma, 'karma');
    return;
  }

  if (classCount(db, 'credit') < caps.credit) return;

  const cheapest = cheapestCreditEntry(db);
  // A full class with nothing rankable in it — every resident predates the
  // columns, or a zero byte cost no encoder produces. Refuse rather than evict
  // blind: the arrival has not been shown to be worth more than anything.
  if (!cheapest) throw new MempoolFullError(caps.credit, 'credit');

  // `fee / bytes > cheapest.fee / cheapest.bytes`, without the division.
  const arriving = fee * BigInt(cheapest.bytes);
  const resident = cheapest.fee * BigInt(bytes);
  if (arriving <= resident) throw new MempoolFullError(caps.credit, 'credit');

  db.prepare('DELETE FROM mempool WHERE rowid = ?').run(cheapest.rowid);
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
 *
 * `txId` is a parameter rather than a second `computeTxId` call, so the id this
 * row is keyed on and the ids of the boxes it promises come from one hash.
 */
function outputBoxIds(tx: UtxoTransaction, txId: string): string[] {
  return (tx.outputs ?? []).map((out, i) => materializeOutput(out, txId, i).id!);
}

/**
 * What a transaction bids, and therefore which class it lands in.
 *
 * `null` means karma-side: nothing it could bid, so it is neither ordered by
 * price nor evictable. A credit-side transaction always yields a number, zero
 * included — a zero-fee transfer is valid consensus and holds a credit slot
 * until a paying one displaces it (MEMPOOL_INTERFACE → Fee floor).
 *
 * ⛔ **The class is decided by `isCreditSideTx` alone, never by whether the fee
 * could be computed.** Inputs resolve against the confirmed set and pending
 * outputs — chaining onto one's own pending change is ordinary here — but an
 * input resolving to neither means only that this node cannot price the entry,
 * not that it changed ledgers. Such an entry bids `0`, which puts it first in
 * line to be evicted; folding it into the karma class instead would let an
 * unpriceable credit transaction occupy a slot that nothing is allowed to
 * reclaim.
 */
function bidOf(tx: UtxoTransaction): bigint | null {
  if (!isCreditSideTx(tx)) return null;

  let inputSum = 0n;
  for (const boxId of tx.inputs ?? []) {
    const box = getBox(boxId) ?? findPendingOutput(boxId);
    if (!box) return 0n;
    inputSum += box.value;
  }
  const outputSum = (tx.outputs ?? []).reduce((sum, out) => sum + out.value, 0n);
  // `validateTx` admits no credit surplus, but admission is not the only caller
  // — reorg re-insertion arrives here directly — so a surplus bids nothing
  // rather than being stored as a negative the ordering would read as cheapest.
  return outputSum > inputSum ? 0n : inputSum - outputSum;
}

export function insertUtxoTx(
  tx: UtxoTransaction,
  expiresAtHeight: number,
): number {
  const db = getDb();

  // Before the conflict gate: the size bound is a property of the transaction
  // alone, so it needs no pool state and settles the verdict without running
  // one query per input.
  const cbor = encodeTx(tx);
  if (cbor.length > MAX_TX_BYTES) throw new TxTooLargeError(cbor.length);

  // The class and the price, before the capacity gate that spends them. The
  // byte cost is what this entry would occupy in a block, not the bare encoding
  // — the budget is the resource being rationed.
  const fee = bidOf(tx);
  const bytes = entryByteCost(cbor);
  assertCapacity(db, fee === null ? 'karma' : 'credit', fee, bytes);

  const inputs = tx.inputs ?? [];
  const conflict = hasPendingSpend(inputs);
  if (conflict !== null) throw new PendingSpendConflictError(conflict);

  const txId = computeTxId(tx);
  const meta = gateMetadata(tx);
  const result = db.prepare(
    `INSERT INTO mempool (entry_type, utxo_tx_cbor, expires_at_height,
                          like_target, like_liker, invite_inviter, vouch_voucher,
                          tx_inputs, tx_output_ids, tx_id, tx_fee, tx_bytes)
     VALUES ('utxo_tx', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Buffer.from(cbor),
    expiresAtHeight,
    meta.likeTarget,
    meta.likeLiker,
    meta.inviteInviter,
    meta.vouchVoucher,
    JSON.stringify(inputs),
    JSON.stringify(outputBoxIds(tx, txId)),
    txId,
    // `tx_fee` NULL is the karma class; a number is the credit class. One
    // column carries the class and the price because they are one fact — an
    // entry that can bid is an entry on the credit ledger.
    fee === null ? null : fee,
    bytes,
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

/**
 * Pending entries in FIFO order, at most `limit` of them, starting after
 * `afterRowid`.
 *
 * `afterRowid` is a **keyset** cursor, not an offset: `rowid` is the table's
 * own b-tree key, so each page is a range scan from where the last one ended
 * rather than a re-walk of everything before it. That is also what makes the
 * page sequence correct across the deletes that run between pages — an offset
 * would skip a row for every row removed behind the cursor.
 */
export function getPendingEntries(limit: number, afterRowid = 0): PoolEntry[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT rowid, entry_type, utxo_tx_cbor, prune_entry_cbor,
            expires_at_height, created_at
     FROM mempool
     WHERE rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`,
  ).all(afterRowid, limit) as MempoolRow[];
  return rows.map(rowToEntry);
}

/**
 * How many rows one page of `iteratePendingEntries` reads.
 *
 * It bounds memory per page and nothing else — the iterator pages until the
 * pool is exhausted or its consumer stops, so no value here can under-serve a
 * caller. That is what the shape is for: the block creator fills to a **byte**
 * budget, and the number of transactions that buys depends on their sizes, so
 * no count expresses it (MEMPOOL_INTERFACE → "The fill budget is bytes;
 * `getPendingEntries` is a count").
 */
const PENDING_PAGE_SIZE = 256;

/**
 * Every pending entry, in FIFO order, drawn a page at a time.
 *
 * A consumer takes what it needs and stops; nothing beyond the last page it
 * pulled is ever read. Each page is a completed query rather than one held-open
 * cursor, so a consumer may write to the pool between entries — which a cursor
 * would refuse for as long as it stayed open.
 */
export function* iteratePendingEntries(): Generator<PoolEntry> {
  let afterRowid = 0;
  for (;;) {
    const page = getPendingEntries(PENDING_PAGE_SIZE, afterRowid);
    if (page.length === 0) return;
    for (const entry of page) yield entry;
    if (page.length < PENDING_PAGE_SIZE) return;
    afterRowid = page[page.length - 1]!.rowid;
  }
}

/**
 * Delete the pooled transaction whose id is `txId`. Returns the number of rows
 * removed — 0 when the pool never held it, which is the ordinary case for a
 * block that arrived from a peer carrying work this node never saw.
 *
 * ⛔ **Keyed, never scanned** (MEMPOOL_INTERFACE → "Confirmed-entry cleanup is
 * bounded by the pool, not by a literal"). This is the whole of how a block
 * arriving from a peer clears what it confirmed, so any bound that misses a row
 * leaves it pending: it holds a pool slot, the creator rebuilds it into a later
 * block, and apply refuses that block. Unbounding a scan is not the alternative
 * either — matching by recomputed `TxId` decodes and re-hashes every pool row
 * for every applied transaction, which measures 27 s per applied block against
 * a full pool where this measures 7.5 ms (2026-08-15, 10,000 entries of 975
 * bytes, 2,026 applied).
 *
 * The stored id is safe to key cleanup on and would **not** be safe to commit a
 * block to. A stale or absent `tx_id` leaves a row pending, which the expiry
 * reclaims; a stale id in `utxoTxIds` would be a block this node's own applier
 * rejects. The creator therefore keeps deriving the ids it commits from the
 * bytes it commits.
 */
export function removeUtxoTxEntry(txId: string): number {
  const db = getDb();
  return db.prepare('DELETE FROM mempool WHERE tx_id = ?').run(txId).changes;
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
  // A prune entry bids nothing and is not a transaction, so it is bounded by
  // the karma-side cap — the class for everything the fee market does not
  // price.
  assertCapacity(db, 'karma', null, 0);
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
