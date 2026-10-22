import { getDb, prepared } from './db.js';
import { getBox, rowToBox } from './utxo.js';
import type { UtxoRow } from './utxo.js';
import { deletePendingPost } from './posts.js';
import type { BoxKey, Page, PageResult } from './index.js';
import { ClientError } from '../services/client-error.js';
import { materializeOutput, ceilingOf } from '@dagsocial/consensus';
import type {
  UtxoTransaction,
  BondBox,
  VouchBox,
  UsernameBox,
  AnyBox,
  KarmaBox,
  CreditBox,
} from '@dagsocial/types';
import {
  MAX_TX_BYTES,
  MEMPOOL_CREDIT_SHARE_PCT,
  encodeTx,
  decodeTx,
  computeTxId,
  computePostId,
  utxoTxTreeByteLength,
  canonicalUsernameBytes,
} from '@dagsocial/types';
import { isCreditSideTx } from '@dagsocial/consensus';
import { settlementMarginalBytes } from '@dagsocial/consensus';

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
 * (MEMPOOL_INTERFACE → Eviction, inside the credit class only).
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

/**
 * An empty body: three count prefixes and nothing else.
 *
 * ⛔ **A SIZING PROBE, NOT A BLOCK.** It constructs no block, reaches no
 * validation, and the rule that every body carries a settlement transaction
 * does not govern it — the whole point is to have a zero to take a delta
 * against.
 */
const EMPTY_BODY_BYTES = utxoTxTreeByteLength({
  utxoTxIds: [],
  utxoTxs: [],
});

/** A well-formed stand-in, so the probe below measures a real `b32` entry. */
const PROBE_TX_ID = '0'.repeat(64);

/**
 * What one transaction costs **inside a block body** — its fixed-width
 * `utxoTxIds` entry, the length-prefixed body beside it, and what it adds to the
 * block's settlement transaction.
 *
 * The difference between a one-entry body and an empty one is exactly that
 * entry's own contribution, because every other term of the sum is unchanged.
 *
 * ⛔ **The settlement term is not optional** (MEMPOOL_INTERFACE → The fill budget
 * is bytes). It rides in the same body and
 * grows with what the fill selected — a fee box adds one input to it, a bond one
 * output — so an entry priced by its own encoding alone leaves the accumulator
 * blind to a structure that grows with the very thing it is measuring, and
 * *"the trim loop runs at most once"* stops holding.
 *
 * This, not the bare encoded length, is what a fee is divided by: the block
 * budget is what 3a made scarce, and a transaction should be ranked by the
 * resource it actually consumes. The block creator spends the same number
 * against the same budget.
 */
export function entryByteCost(txBytes: Uint8Array): number {
  return (
    utxoTxTreeByteLength({
      utxoTxIds: [PROBE_TX_ID],
      utxoTxs: [txBytes],
    }) - EMPTY_BODY_BYTES + settlementMarginalBytes(decodeTx(txBytes))
  );
}

/**
 * Thrown by `insertUtxoTx` when one of the transaction's inputs is already
 * spent by an entry the pool holds.
 *
 * Two pooled transactions naming one box put both into one block, where the
 * first spends the box and the second's input does not resolve — the ordering
 * rule rejects the block (NODE_INTERFACE → Block finalization → "The body is
 * in dependency order, and that is a consensus rule").
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
 * Thrown by `insertUtxoTx` for a transaction above `MAX_TX_BYTES`
 * (MEMPOOL_INTERFACE → insertUtxoTx → "It is the pool's own bound, not
 * a restatement of validation's"): the pool's own bound, which every
 * insert passes whichever way it came — the HTTP edge, the gossip
 * relay, and the reorg's re-insertion. `encodeTx(tx).length` is the
 * measure. A `ClientError`, so the message reaches the submitter;
 * 413, the well-formed request too large.
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
 * In-memory representation of a pending pool entry (MEMPOOL_INTERFACE →
 * PoolEntry). `entryType` is the single value `'utxo_tx'` — nothing else
 * rides the pool. `costEstimate` is the row's marginal cost, `null` where
 * nothing costed it (MEMPOOL_INTERFACE → The cost gate).
 */
export interface PoolEntry {
  rowid: number;
  entryType: 'utxo_tx';
  utxoTxBytes: Uint8Array | null;
  expiresAtHeight: number;
  createdAt: string;
  costEstimate: number | null;
  /**
   * The karma inputs' owner (hex) — the one key `validateTx` admits in a
   * karma transaction's signatures map (MEMPOOL_INTERFACE → Gate metadata
   * columns), the `karma_owner` column; `null` where the row has no karma
   * spend and no owner to key on. The fill reads this to ask the decay
   * predicate for one owner per entry (NODE_INTERFACE → Karma transition
   * rules → "Engine inputs the rule needs").
   */
  karmaOwner: string | null;
}

interface MempoolRow {
  rowid: number;
  entry_type: string;
  utxo_tx_bytes: Buffer | null;
  expires_at_height: number;
  created_at: string;
  cost_estimate: number | null;
  karma_owner: string | null;
}

function rowToEntry(row: MempoolRow): PoolEntry {
  return {
    rowid: row.rowid,
    entryType: row.entry_type as 'utxo_tx',
    utxoTxBytes: row.utxo_tx_bytes ? new Uint8Array(row.utxo_tx_bytes) : null,
    expiresAtHeight: row.expires_at_height,
    createdAt: row.created_at,
    costEstimate: row.cost_estimate,
    karmaOwner: row.karma_owner,
  };
}

// The one source of the default pool capacity. config.ts imports this
// constant so the application layer's parse and the storage layer's bound
// share one literal (ARCHITECTURE → Package boundaries).
export const DEFAULT_MAX_MEMPOOL_ENTRIES = 10000;

let maxEntries = DEFAULT_MAX_MEMPOOL_ENTRIES;

/**
 * Set the pool capacity. Called once at startup from `index.ts` with the
 * parsed `config.maxMempoolEntries` (MEMPOOL_INTERFACE → Size cap — reject,
 * never evict).
 */
export function setMempoolCap(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`setMempoolCap: invalid capacity ${n}`);
  }
  maxEntries = n;
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
  const cap = maxEntries;
  const credit = Math.floor((cap * MEMPOOL_CREDIT_SHARE_PCT) / 100);
  return { credit, karma: cap - credit };
}

/**
 * How many entries each class currently holds.
 *
 * ⛔ **`tx_fee` alone decides, and the two counts partition the table.** Only a
 * credit-side transaction ever sets it, so `IS NULL` catches karma-side
 * transactions and rows written before the column existed alike — all of which
 * bid nothing and belong to the class that does not order by price.
 */
function classCount(db: ReturnType<typeof getDb>, poolClass: PoolClass): number {
  const test = poolClass === 'credit' ? 'IS NOT NULL' : 'IS NULL';
  const row = prepared(db, `SELECT COUNT(*) AS n FROM mempool WHERE tx_fee ${test}`).get() as { n: number };
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
 *
 * ⚠ **`entry_type` is filtered here and deliberately not in `classCount`.** This
 * query names a row to delete, so it must reach only transactions. The count
 * above bounds the table and must reach every row. Same column, two
 * questions.
 */
function cheapestCreditEntry(
  db: ReturnType<typeof getDb>,
): { rowid: number; fee: bigint; bytes: number } | null {
  // MEMPOOL_INTERFACE → Eviction, inside the credit class only
  const row = prepared(db, `SELECT rowid, tx_fee, tx_bytes FROM mempool
      WHERE entry_type = 'utxo_tx' AND tx_fee IS NOT NULL AND tx_bytes > 0
      ORDER BY CAST(tx_fee AS REAL) / tx_bytes ASC, rowid ASC
      LIMIT 1`, true).get() as { rowid: bigint; tx_fee: bigint; tx_bytes: bigint } | undefined;
  if (!row) return null;
  return { rowid: Number(row.rowid), fee: row.tx_fee, bytes: Number(row.tx_bytes) };
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
 * Checked by every insert path — an unbounded pool is a disk-DoS lever
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

  prepared(db, 'DELETE FROM mempool WHERE rowid = ?').run(cheapest.rowid);
}

export interface GateMetadata {
  likeTarget: string | null;
  likeLiker: string | null;
  inviteInviter: string | null;
  inviteInvitee: string | null;
  vouchVoucher: string | null;
  vouchTarget: string | null;
  usernameLower: string | null;
  usernameClaimant: string | null;
  karmaOwner: string | null;
  karmaSpend: bigint | null;
  withdrawPost: string | null;
}

/**
 * Lift the fields the correctness gates query on. This is the single chokepoint
 * every insertion path (HTTP routes and gossip relay alike) passes through,
 * which is what makes the gates unable to miss an entry. First output of each
 * kind wins for the output-derived columns — the gate columns are singular per
 * the contract, matching the services' own `outputs.find(...)` semantics.
 *
 * MEMPOOL_INTERFACE → Correctness gates. Exported so admission reads the same
 * fields the row carries — one derivation, read twice.
 *
 * The like columns derive from the tx-level `likeTarget` field: a like is a
 * burn transaction, not a box. The liker is the karma inputs' owner — the
 * single signing key. The store cannot resolve input boxes, so the signature
 * map is where the transaction itself names that key; `castLike` enforces
 * exactly one signature on entry, and a multi-key map derives no liker (the
 * unpaired row matches no `hasPendingLike` query, and a spare signature cannot
 * pin someone else's `(liker, target)` pair).
 */
export function gateMetadata(tx: UtxoTransaction): GateMetadata {
  const meta: GateMetadata = {
    likeTarget: null,
    likeLiker: null,
    inviteInviter: null,
    inviteInvitee: null,
    vouchVoucher: null,
    vouchTarget: null,
    usernameLower: null,
    usernameClaimant: null,
    karmaOwner: null,
    karmaSpend: null,
    withdrawPost: null,
  };

  if (tx.postWithdraw !== undefined) {
    meta.withdrawPost = tx.postWithdraw.postId;
  }

  if (tx.likeTarget !== undefined) {
    meta.likeTarget = tx.likeTarget;
    const signers = Object.keys(tx.signatures ?? {});
    meta.likeLiker = signers.length === 1 ? signers[0]! : null;
  }

  // MEMPOOL_INTERFACE → Gate metadata columns: the karma spend row, and the
  // `karma_owner` column that `getOwnKarmaBoxIdsWithPending` keys on
  // (MEMPOOL_INTERFACE → getOwnKarmaBoxIdsWithPending). `karma_owner` is the
  // one signing key — any other key count leaves the row unpaired, mirroring
  // `like_liker`'s rule — and it is written for every karma transaction, not
  // only the spending ones: a consolidation, a name claim and a withdrawal
  // move the owner's own box without a karma_price / like_accrual / bond /
  // vouch output, so a reader keyed on this column would miss them. The row
  // is a karma transaction's whenever it carries one of {karma, karma_price,
  // like_accrual, bond, vouch} as an output — the admitted karma-arm shapes
  // (NODE_INTERFACE → Legal box transitions). `karma_spend` stays the summed
  // value of the spend's exits alone: `pendingKarmaSpend` sums nothing from a
  // row that spends none, and a non-spending karma transaction leaves `held`
  // what the pool's spends ahead of it leave it.
  let karmaSpend = 0n;
  let hasKarmaArmOutput = false;
  for (const output of tx.outputs ?? []) {
    if (
      output.boxType === 'karma_price' ||
      output.boxType === 'like_accrual' ||
      output.boxType === 'bond' ||
      output.boxType === 'vouch'
    ) {
      karmaSpend += (output as { value: bigint }).value;
      hasKarmaArmOutput = true;
    } else if (output.boxType === 'karma') {
      hasKarmaArmOutput = true;
    }
  }
  if (hasKarmaArmOutput) {
    const signers = Object.keys(tx.signatures ?? {});
    if (signers.length === 1) {
      meta.karmaOwner = signers[0]!;
      meta.karmaSpend = karmaSpend > 0n ? karmaSpend : null;
    }
  }

  for (const output of tx.outputs ?? []) {
    // ⛔ **The BOND is what names an inviter now**, because the bond is the
    // invite (ARCHITECTURE → Invite System). The column's subject is unchanged —
    // an inviter with a pending invite — and only the box carrying it moved.
    if (output.boxType === 'bond' && meta.inviteInviter === null) {
      meta.inviteInviter = Buffer.from((output as BondBox).inviterId).toString('hex');
      meta.inviteInvitee = Buffer.from((output as BondBox).inviteePublicKey).toString('hex');
    } else if (output.boxType === 'vouch' && meta.vouchVoucher === null) {
      meta.vouchVoucher = Buffer.from((output as VouchBox).voucherId).toString('hex');
      meta.vouchTarget = Buffer.from((output as VouchBox).targetId).toString('hex');
    } else if (output.boxType === 'username' && meta.usernameLower === null) {
      const nameBytes = (output as UsernameBox).name;
      const canonical = canonicalUsernameBytes(nameBytes);
      meta.usernameLower = Buffer.from(canonical).toString('utf8');
      meta.usernameClaimant = Buffer.from((output as UsernameBox).owner).toString('hex');
    }
  }

  return meta;
}

/**
 * The boxes this transaction would create, in output order.
 *
 * Derived through `materializeOutput`, never re-derived here: outputs are
 * client-supplied and may carry any of `id`/`txId`/`index`, and that function is
 * where stripping them and computing the real id is stated. Block application
 * materializes the same outputs through the same call, so the pool's prediction
 * and the block's result cannot disagree.
 *
 * `txId` is a parameter rather than a second `computeTxId` call, so the id this
 * row is keyed on and the ids of the boxes it promises come from one hash.
 *
 * MEMPOOL_INTERFACE → Schema → "An output row carries its box's owner, type
 * and value": the row is written from the box this returns, so the pool's
 * owner-type-value triple is `materializeOutput`'s on the same output.
 */
function materializedOutputs(tx: UtxoTransaction, txId: string): AnyBox[] {
  return (tx.outputs ?? []).map((out, i) => materializeOutput(out, txId, i));
}

/**
 * What a transaction bids, and therefore which class it lands in.
 *
 * `null` means karma-side: nothing it could bid, so it is neither ordered by
 * price nor evictable. A credit-side transaction always yields a number, zero
 * included — a zero-fee transfer is valid consensus and holds a credit slot
 * until a paying one displaces it (MEMPOOL_INTERFACE → Fee floor).
 *
 * ⛔ **The bid is a property of the transaction's own bytes and resolves
 * nothing** (MEMPOOL_INTERFACE → Fee floor). The fee is a `FeeBox` output the
 * transaction names, so a node prices an entry exactly whether or not it has
 * ever seen the inputs — the same standing the class already has, since
 * `isCreditSideTx` decides that from the same bytes. **There is no unpriceable
 * credit entry**, and the pool's two questions are one shape.
 */
export function bidOf(tx: UtxoTransaction): bigint | null {
  if (!isCreditSideTx(tx)) return null;
  return (tx.outputs ?? [])
    .filter((out) => out.boxType === 'fee')
    .reduce((sum, out) => sum + out.value, 0n);
}

/**
 * `costEstimate` is the cost gate's marginal cost for `tx`, kept with its row; a
 * caller that did not cost it — a reorg's re-insertion — passes none, and the
 * row carries NULL (MEMPOOL_INTERFACE → The cost gate).
 */
export function insertUtxoTx(
  tx: UtxoTransaction,
  expiresAtHeight: number,
  costEstimate: number | null = null,
): number {
  const db = getDb();

  // The size bound runs before the SQLite transaction opens — the measure is
  // the transaction's own bytes, needs no pool state, and an oversize
  // transaction opens no transaction at all.
  const encoded = encodeTx(tx);
  if (encoded.length > MAX_TX_BYTES) throw new TxTooLargeError(encoded.length);

  // MEMPOOL_INTERFACE → Validity ceiling — stored at insert, reclaimed by
  // purgeExpired. The reorg caller screens before offering (NODE_INTERFACE →
  // Validity ceiling); insertUtxoTx does not test it.
  const ceiling = ceilingOf(tx);

  const inputs = tx.inputs ?? [];
  const txId = computeTxId(tx);
  const outputs = materializedOutputs(tx, txId);
  const meta = gateMetadata(tx);

  // One SQLite transaction: the conflict gate (before the capacity gate),
  // the eviction a full credit class makes, and the entry's row plus its
  // input and output rows commit together or not at all
  // (MEMPOOL_INTERFACE → insertUtxoTx → "The conflict gate runs before the
  // capacity gate.", → "One SQLite transaction.").
  return db.transaction(() => {
    const conflict = hasPendingSpend(inputs);
    if (conflict !== null) throw new PendingSpendConflictError(conflict);

    // The class and the price, before the capacity gate that spends them. The
    // byte cost is what this entry would occupy in a block, not the bare
    // encoding — the budget is the resource being rationed.
    const fee = bidOf(tx);
    const bytes = entryByteCost(encoded);
    assertCapacity(db, fee === null ? 'karma' : 'credit', fee, bytes);

    const result = prepared(db, `INSERT INTO mempool (entry_type, utxo_tx_bytes, expires_at_height,
                            like_target, like_liker, invite_inviter, invite_invitee,
                            vouch_voucher, vouch_target,
                            tx_id, tx_fee, tx_bytes,
                            max_valid_height,
                            username_lower, username_claimant,
                            karma_owner, karma_spend,
                            withdraw_post,
                            cost_estimate)
       VALUES ('utxo_tx', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Buffer.from(encoded),
      expiresAtHeight,
      meta.likeTarget,
      meta.likeLiker,
      meta.inviteInviter,
      meta.inviteInvitee,
      meta.vouchVoucher,
      meta.vouchTarget,
      txId,
      fee === null ? null : fee,
      bytes,
      ceiling,
      meta.usernameLower,
      meta.usernameClaimant,
      meta.karmaOwner,
      meta.karmaSpend,
      meta.withdrawPost,
      costEstimate,
    );
    const entryRowid = Number(result.lastInsertRowid);

    // One row per input, one row per output — the pending view's tables
    // (MEMPOOL_INTERFACE → Schema). The output row carries the box's owner,
    // type and value from `materializeOutput`'s box, so the view by owner
    // (MEMPOOL_INTERFACE → getBoxesPageWithPending) is a range of
    // `idx_mempool_outputs_owner`; `owner` is NULL for a box type with
    // none.
    const insertInput = prepared(db, 'INSERT INTO mempool_inputs (box_id, entry_rowid) VALUES (?, ?)');
    for (const boxId of inputs) insertInput.run(boxId, entryRowid);
    const insertOutput = prepared(db, `INSERT INTO mempool_outputs
         (box_id, entry_rowid, owner, box_type, value) VALUES (?, ?, ?, ?, ?)`);
    for (const box of outputs) {
      const ownerBuf = ('owner' in box && box.owner instanceof Uint8Array)
        ? Buffer.from(box.owner)
        : null;
      insertOutput.run(box.id!, entryRowid, ownerBuf, box.boxType, box.value);
    }

    return entryRowid;
  })();
}

/**
 * Write the marginal cost of the row `rowid`, a row costed after it was pooled
 * (MEMPOOL_INTERFACE → The cost gate).
 */
export function setCostEstimate(rowid: number, costEstimate: number): void {
  prepared(getDb(), 'UPDATE mempool SET cost_estimate = ? WHERE rowid = ?').run(costEstimate, rowid);
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
  const row = prepared(db, `SELECT 1 FROM mempool WHERE like_target = ? AND like_liker = ? LIMIT 1`).get(targetPostId, likerId);
  return row !== undefined;
}

export function countPendingInvites(inviterId: string): number {
  const db = getDb();
  const row = prepared(db, `SELECT COUNT(*) AS n FROM mempool WHERE invite_inviter = ?`).get(inviterId) as { n: number };
  return row.n;
}

// MEMPOOL_INTERFACE → Correctness gates — the invitee is an account once the
// first bond lands, so a second bond naming the same key can never apply.
export function hasPendingInvitee(inviteeId: string): boolean {
  const db = getDb();
  const row = prepared(db, `SELECT 1 FROM mempool WHERE invite_invitee = ? LIMIT 1`).get(inviteeId);
  return row !== undefined;
}

// MEMPOOL_INTERFACE → Correctness gates — a second withdrawal of a post one
// pending row already withdraws.
export function hasPendingWithdraw(postId: string): boolean {
  const db = getDb();
  const row = prepared(db, `SELECT 1 FROM mempool WHERE withdraw_post = ? LIMIT 1`).get(postId);
  return row !== undefined;
}

export function hasPendingVouch(voucherId: string, targetId: string): boolean {
  const db = getDb();
  const row = prepared(db, `SELECT 1 FROM mempool WHERE vouch_voucher = ? AND vouch_target = ? LIMIT 1`).get(voucherId, targetId);
  return row !== undefined;
}

// MEMPOOL_INTERFACE → Correctness gates
export function hasPendingClaim(nameLower: string): boolean {
  const db = getDb();
  const row = prepared(db, `SELECT 1 FROM mempool WHERE username_lower = ? LIMIT 1`).get(nameLower);
  return row !== undefined;
}

export function hasPendingClaimBy(claimantId: string): boolean {
  const db = getDb();
  const row = prepared(db, `SELECT 1 FROM mempool WHERE username_claimant = ? LIMIT 1`).get(claimantId);
  return row !== undefined;
}

/**
 * MEMPOOL_INTERFACE → Correctness gates → "`pendingKarmaSpend` is an input of
 * `validateTx`, not a gate a path can skip". The `SUM` of `karma_spend` over
 * the rows whose `karma_owner` is `ownerId`, `0n` where it holds none —
 * admission's `held` is the confirmed karma sum less it (NODE_INTERFACE →
 * Karma transition rules). `.safeIntegers()` keeps the sum in `bigint`: a box
 * value is below `BOX_VALUE_BOUND` and above what a double holds exactly
 * (TYPES_INTERFACE → Box value domain), so a cast through `number` would lose
 * low bits as the pool grows.
 */
export function pendingKarmaSpend(ownerId: string): bigint {
  const db = getDb();
  const row = prepared(db, `SELECT COALESCE(SUM(karma_spend), 0) AS total FROM mempool WHERE karma_owner = ?`, true).get(ownerId) as { total: bigint };
  return row.total;
}

/**
 * The first of `boxIds` already spent by a pending entry, or `null` when none
 * is. Returned rather than a boolean so the refusal can name the box that
 * collided instead of only reporting that one did.
 *
 * A point read on `mempool_inputs` per id, the first hit returned
 * (MEMPOOL_INTERFACE → Schema → "An entry's inputs and outputs are rows
 * keyed by box id").
 */
export function hasPendingSpend(boxIds: string[]): string | null {
  if (boxIds.length === 0) return null;
  const db = getDb();
  const stmt = prepared(db, `SELECT 1 FROM mempool_inputs WHERE box_id = ? LIMIT 1`);
  for (const id of boxIds) {
    if (stmt.get(id) !== undefined) return id;
  }
  return null;
}

/**
 * The box a pooled transaction would create under `boxId`, or `null`.
 *
 * `mempool_outputs` names the entry whose bytes answer this one box; the
 * decoded transaction's `materializeOutput` returns the box application
 * will write (MEMPOOL_INTERFACE → Schema; → getBoxWithPending).
 */
export function findPendingOutput(boxId: string): AnyBox | null {
  const db = getDb();
  const row = prepared(db, `SELECT mempool.utxo_tx_bytes AS utxo_tx_bytes
       FROM mempool_outputs
       JOIN mempool ON mempool.rowid = mempool_outputs.entry_rowid
      WHERE mempool_outputs.box_id = ?`).get(boxId) as { utxo_tx_bytes: Buffer } | undefined;
  if (!row) return null;

  const tx = decodeTx(new Uint8Array(row.utxo_tx_bytes));
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
  if (hasPendingSpend([boxId]) !== null) throw new PendingSpendConflictError(boxId);
  return getBox(boxId) ?? findPendingOutput(boxId);
}

// The pending view as `getBoxWithPending` sees it, asked by owner and type
// (MEMPOOL_INTERFACE → getBoxesPageWithPending). The set is a pair of
// fragments the page, its COUNT, its SUM and rule 3's unmarked karma read
// share, so the whole-set rule is stated once. The exclusion of
// `mempool_inputs` rows is a correlated `NOT EXISTS` on each half, so each
// probe reads `SEARCH mempool_inputs USING PRIMARY KEY`.
const CONFIRMED_PENDING_WHERE =
  `owner = ? AND box_type = ? AND spent_at_block IS NULL
   AND NOT EXISTS (SELECT 1 FROM mempool_inputs
                    WHERE mempool_inputs.box_id = utxo_boxes.id)`;
const POOLED_PENDING_WHERE =
  `owner = ? AND box_type = ?
   AND NOT EXISTS (SELECT 1 FROM mempool_inputs
                    WHERE mempool_inputs.box_id = mempool_outputs.box_id)`;

interface PendingPageRow { id: string; value: bigint; src: bigint }

// One page over the merged set, ordered `value DESC, id`, strictly after
// `after`. Each half is read in the two-range form on `after` — the equal
// value tail (`value = ? AND id > ?`) and the lesser values (`value < ?`) —
// so SQLite walks each half's index in order and the outer merge sorts the
// result in list order without a temp B-tree, matching `boxPageQuery`'s
// shape (NODE_INTERFACE → Store Interface → "A page read touches `limit +
// 1` entries of one index that serves both its predicate and its order.").
// `src` tags the row's half so the second pass reads it from the right
// table: 0 = confirmed, 1 = pooled.
function pendingPageRows(
  db: ReturnType<typeof getDb>,
  ownerBuf: Buffer,
  boxType: 'karma' | 'credit',
  after: BoxKey | undefined,
  limit: number,
): PendingPageRow[] {
  if (!after) {
    return prepared(db, `SELECT id, value, src FROM (
         SELECT id, value, 0 AS src FROM utxo_boxes WHERE ${CONFIRMED_PENDING_WHERE}
         UNION ALL
         SELECT box_id AS id, value, 1 AS src FROM mempool_outputs WHERE ${POOLED_PENDING_WHERE}
       ) ORDER BY value DESC, id LIMIT ?`, true)
      .all(ownerBuf, boxType, ownerBuf, boxType, limit + 1) as PendingPageRow[];
  }
  return prepared(db, `SELECT id, value, src FROM (
         SELECT id, value, 0 AS src FROM utxo_boxes
          WHERE ${CONFIRMED_PENDING_WHERE} AND value = ? AND id > ?
         UNION ALL
         SELECT id, value, 0 AS src FROM utxo_boxes
          WHERE ${CONFIRMED_PENDING_WHERE} AND value < ?
         UNION ALL
         SELECT box_id AS id, value, 1 AS src FROM mempool_outputs
          WHERE ${POOLED_PENDING_WHERE} AND value = ? AND box_id > ?
         UNION ALL
         SELECT box_id AS id, value, 1 AS src FROM mempool_outputs
          WHERE ${POOLED_PENDING_WHERE} AND value < ?
       ) ORDER BY value DESC, id LIMIT ?`, true)
    .all(ownerBuf, boxType, after.value, after.id,
         ownerBuf, boxType, after.value,
         ownerBuf, boxType, after.value, after.id,
         ownerBuf, boxType, after.value,
         limit + 1) as PendingPageRow[];
}

/**
 * `getBoxWithPending`'s view, asked by owner and type: the owner's confirmed
 * unspent boxes of the type that no `mempool_inputs` row names, and the
 * `mempool_outputs` rows of the type to the owner that no `mempool_inputs`
 * row names (MEMPOOL_INTERFACE → getBoxesPageWithPending). One page in
 * `value DESC, id` strictly after `after`, the two halves merged in list
 * order; a confirmed row returned as `rowToBox` returns it, a pooled row as
 * the box `materializeOutput` returns.
 *
 * The decode runs over the pooled rows the page answers alone — one entry
 * read per answered pooled row, as `findPendingOutput` does for one id —
 * never over the pool.
 */
export function getBoxesPageWithPending(
  owner: Uint8Array,
  boxType: 'karma' | 'credit',
  page: Page<BoxKey>,
): PageResult<KarmaBox | CreditBox, BoxKey> {
  const db = getDb();
  const ownerBuf = Buffer.from(owner);
  const limit = page.limit;

  const rows = pendingPageRows(db, ownerBuf, boxType, page.after, limit);
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;

  const boxes: (KarmaBox | CreditBox)[] = kept.map((r) => {
    // `safeIntegers` reads SQLite's `0 AS src` back as `0n`, so the half
    // discriminator stays in bigint everywhere.
    const box = r.src === 0n ? getBox(r.id) : findPendingOutput(r.id);
    // The ids come from the same store as the row reads and run in one
    // synchronous call; a missing box names an inconsistency in the
    // store, and the read throws.
    if (!box) throw new Error(`pending view row missing: ${r.id}`);
    return box as KarmaBox | CreditBox;
  });

  const last = kept[kept.length - 1];
  const next: BoxKey | null = hasMore && last
    ? { value: last.value, id: last.id }
    : null;

  // COUNT over the whole set, both halves added. Each sub-count reads one
  // index range (its half's), and the correlated `NOT EXISTS` probes
  // `mempool_inputs`'s primary key.
  const countRow = prepared(db, `SELECT
       (SELECT COUNT(*) FROM utxo_boxes WHERE ${CONFIRMED_PENDING_WHERE})
     + (SELECT COUNT(*) FROM mempool_outputs WHERE ${POOLED_PENDING_WHERE})
       AS cnt`)
    .get(ownerBuf, boxType, ownerBuf, boxType) as { cnt: number };

  return { rows: boxes, next, count: countRow.cnt };
}

/**
 * The sum of the set `getBoxesPageWithPending` reads, both halves added
 * (MEMPOOL_INTERFACE → getBoxesPageWithPending; NODE_INTERFACE → Store
 * Interface → Mempool). `safeIntegers` keeps the sum in `bigint`: a box
 * value can exceed what a double holds exactly (TYPES_INTERFACE → Box
 * value domain), so a cast through `number` would lose low bits as the
 * pool grows.
 */
export function getBoxTotalWithPending(owner: Uint8Array, boxType: 'karma' | 'credit'): bigint {
  const ownerBuf = Buffer.from(owner);
  const row = prepared(getDb(), `SELECT
       COALESCE((SELECT SUM(value) FROM utxo_boxes WHERE ${CONFIRMED_PENDING_WHERE}), 0)
     + COALESCE((SELECT SUM(value) FROM mempool_outputs WHERE ${POOLED_PENDING_WHERE}), 0)
       AS s`, true)
    .get(ownerBuf, boxType, ownerBuf, boxType) as { s: bigint };
  return row.s;
}

/**
 * Submission's answer to rule 3 of NODE_INTERFACE → Karma transition rules →
 * "An identity holds at most two karma boxes": the ids of the owner's unmarked
 * karma boxes under `getBoxWithPending`'s view
 * (MEMPOOL_INTERFACE → getOwnKarmaBoxIdsWithPending → "It is the unmarked
 * rows of the set `getBoxesPageWithPending` reads for karma").
 *
 * Reads the same fragment pair the page, its `COUNT` and the `SUM` share
 * (`CONFIRMED_PENDING_WHERE` and `POOLED_PENDING_WHERE`), with the box type
 * pinned to `karma`. The confirmed half additionally filters out the income
 * mark; a pooled karma output is unmarked by rule 2 of
 * NODE_INTERFACE → Karma transition rules → "No karma output carries the
 * mark", so the pool rows need no further filter. Admission wires this as
 * the engine's `getOwnKarmaBoxIds`; the relay's `getOwnKarmaBoxIds` reads
 * the confirmed set alone.
 */
export function getOwnKarmaBoxIdsWithPending(ownerId: string): string[] {
  const db = getDb();
  const ownerBuf = Buffer.from(ownerId, 'hex');

  // The confirmed half's rows, reconstructed through `rowToBox` so the mark
  // is decoded where every other karma reader decodes it. An owner holds at
  // most two karma rows (NODE_INTERFACE → Karma transition rules → "An
  // identity holds at most two karma boxes"), so the read is bounded.
  const rows = prepared(db, `SELECT * FROM utxo_boxes
       WHERE ${CONFIRMED_PENDING_WHERE}`, true)
    .all(ownerBuf, 'karma') as UtxoRow[];
  const confirmedIds: string[] = [];
  for (const row of rows) {
    const box = rowToBox(row) as KarmaBox;
    if (box.income === true) continue;
    confirmedIds.push(box.id!);
  }

  // The pooled half. A pooled karma output is unmarked by rule 2 of
  // NODE_INTERFACE → Karma transition rules → "No karma output carries the
  // mark".
  const pooled = prepared(db, `SELECT box_id AS id FROM mempool_outputs
       WHERE ${POOLED_PENDING_WHERE}`)
    .all(ownerBuf, 'karma') as Array<{ id: string }>;

  return [...confirmedIds, ...pooled.map((r) => r.id)];
}

/**
 * The stored `utxo_tx_bytes` of the pool entry whose `tx_id` equals the
 * argument, or `null` when no such entry stands — the bytes a pending
 * `PostJson`'s `tx` field is read from (NODE_INTERFACE → Posts → "The creating
 * transaction rides a post row").
 */
export function getPendingUtxoTxBytesByTxId(txId: string): Uint8Array | null {
  const row = prepared(getDb(), `SELECT utxo_tx_bytes FROM mempool
        WHERE entry_type = 'utxo_tx' AND tx_id = ?`)
    .get(txId) as { utxo_tx_bytes: Buffer | null } | undefined;
  if (!row || !row.utxo_tx_bytes) return null;
  return new Uint8Array(row.utxo_tx_bytes);
}

/** The columns a `PoolEntry` is read from — every reader of the pool selects these. */
const ENTRY_COLUMNS = `rowid, entry_type, utxo_tx_bytes,
                       expires_at_height, created_at, cost_estimate, karma_owner`;

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
  const rows = prepared(db, `SELECT ${ENTRY_COLUMNS}
     FROM mempool
     WHERE rowid > ?
     ORDER BY rowid ASC
     LIMIT ?`).all(afterRowid, limit) as MempoolRow[];
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
 * The karma-side class in FIFO order, paged by the keyset cursor above.
 *
 * Nothing here bids, so arrival is the only basis for prioritisation there is
 * (MEMPOOL_INTERFACE → Ordering). Every pool entry is a `utxo_tx`; this class
 * holds the ones with no fee.
 */
function* iterateKarmaFifo(): Generator<PoolEntry> {
  const db = getDb();
  let afterRowid = 0;
  for (;;) {
    const rows = prepared(db, `SELECT ${ENTRY_COLUMNS} FROM mempool
        WHERE tx_fee IS NULL AND rowid > ?
        ORDER BY rowid ASC
        LIMIT ?`).all(afterRowid, PENDING_PAGE_SIZE) as MempoolRow[];
    if (rows.length === 0) return;
    for (const row of rows) yield rowToEntry(row);
    if (rows.length < PENDING_PAGE_SIZE) return;
    afterRowid = rows[rows.length - 1]!.rowid;
  }
}

/**
 * The credit class in descending fee rate.
 *
 * ⛔ **The `rowid` keyset the FIFO iterator uses cannot page this**, because
 * `rowid` is not the ordering key here: a page boundary in rate order has no
 * expression in the table's own b-tree. So the order is settled first over ids
 * alone — no blob leaves the database for it — and bodies are then fetched a
 * page at a time and re-sequenced. Ordering the whole class costs a few tens of
 * kilobytes rather than the pool's full weight, and the memory bound the paging
 * exists for is kept.
 *
 * The same `REAL` division as the eviction query, safe for the same reason and
 * unsafe to copy for the same one: this is a node's own assembly preference and
 * no validator recomputes it.
 *
 * ⚠ **The id list is safe to hold across the body fetches, and that is not a
 * TOCTOU gap.** The only consumer is the block creator's fill, which is
 * synchronous and adds and removes no row while it runs — `purgeExpired` has
 * already finished and `submitMinedBlock` has not begun; its one write is a row's
 * estimate (`setCostEstimate`), which moves neither the class nor a rate. Neither
 * a transaction nor a defensive re-check is needed; the missing-row skip below
 * exists so the loop is total, not because a row is expected to vanish.
 */
function* iterateCreditByRate(): Generator<PoolEntry> {
  const db = getDb();
  // ⚠ **The unary `+` is load-bearing, not a typo.** It makes the ORDER BY term
  // non-indexable, so `idx_mempool_fee_rate` confines the scan to credit rows
  // without being asked to satisfy the ordering as well — which it can only do
  // by a random row lookup per entry. This pass reads the whole
  // class, so an in-memory sort wins: 2.29 ms against 2.88 ms for the same
  // query without the `+`, and 2.65 ms with no index at all (2026-08-15, a
  // 10,000-row pool of which 5,000 are credit). Removing it costs half a
  // millisecond per block and nothing will fail.
  const ordered = prepared(db, `SELECT rowid FROM mempool
      WHERE entry_type = 'utxo_tx' AND tx_fee IS NOT NULL AND tx_bytes > 0
      ORDER BY +CAST(tx_fee AS REAL) / tx_bytes DESC, rowid ASC`).all() as Array<{ rowid: number }>;

  for (let i = 0; i < ordered.length; i += PENDING_PAGE_SIZE) {
    const page = ordered.slice(i, i + PENDING_PAGE_SIZE).map((r) => r.rowid);
    const rows = db.prepare(
      `SELECT ${ENTRY_COLUMNS} FROM mempool
        WHERE rowid IN (${page.map(() => '?').join(',')})`,
    ).all(...page) as MempoolRow[];
    // SQL answers in table order; the rate order is this loop's to restore. A
    // row missing from the answer was deleted between the two queries, which is
    // a skip rather than a fault.
    const byRowid = new Map(rows.map((row) => [row.rowid, row]));
    for (const rowid of page) {
      const row = byRowid.get(rowid);
      if (row) yield rowToEntry(row);
    }
  }
}

/**
 * Pending entries, drawn a page at a time.
 *
 * A consumer takes what it needs and stops; nothing beyond the last page it
 * pulled is ever read. Each page is a completed query rather than one held-open
 * cursor, so a consumer may write to the pool between entries — which a cursor
 * would refuse for as long as it stayed open.
 *
 * With no class named, every entry in FIFO order — the whole-pool view, for
 * consumers that are not assembling a block. Named, the class's own ordering
 * (MEMPOOL_INTERFACE → Ordering).
 */
export function* iteratePendingEntries(
  opts: { klass?: PoolClass } = {},
): Generator<PoolEntry> {
  if (opts.klass === 'karma') return yield* iterateKarmaFifo();
  if (opts.klass === 'credit') return yield* iterateCreditByRate();

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
 * ⛔ **Keyed, never scanned** (MEMPOOL_INTERFACE → Confirmed-entry cleanup
 * reaches every row). This is the whole of how a block
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
  return prepared(db, 'DELETE FROM mempool WHERE tx_id = ?').run(txId).changes;
}

// MEMPOOL_INTERFACE → removeUnconfirmed. The entries named, every pooled entry
// spending an output of one of them or replying to its post — the dependents
// read before any row leaves, so the output rows and the pending post rows the
// walk reads leave with their entry. One SQLite transaction (a savepoint inside
// a caller's). Each read is on an index: SCAN json_each →
// idx_mempool_outputs_entry → mempool_inputs' primary key for the output half,
// idx_dag_parent_refs_parent → dag_posts' primary key → idx_mempool_tx_id for
// the parent-ref half.
export function removeUnconfirmed(rowids: readonly number[]): number {
  if (rowids.length === 0) return 0;
  const db = getDb();
  return db.transaction(() => {
    const closure = new Set<number>();
    const txIdOf = new Map<number, string | null>();
    let frontier: readonly number[] = Array.from(new Set(rowids));
    while (frontier.length > 0) {
      const added: number[] = [];
      for (const rowid of frontier) {
        if (closure.has(rowid)) continue;
        closure.add(rowid);
        const row = prepared(
          db,
          "SELECT tx_id FROM mempool WHERE rowid = ? AND entry_type = 'utxo_tx'",
        ).get(rowid) as { tx_id: string | null } | undefined;
        txIdOf.set(rowid, row?.tx_id ?? null);
        added.push(rowid);
      }
      if (added.length === 0) break;
      // Entries whose input is the output of a just-added entry.
      const outRows = prepared(
        db,
        `SELECT DISTINCT mi.entry_rowid AS rowid
           FROM mempool_outputs mo
           JOIN mempool_inputs mi ON mi.box_id = mo.box_id
          WHERE mo.entry_rowid IN (SELECT value FROM json_each(?))`,
      ).all(JSON.stringify(added)) as Array<{ rowid: number }>;
      // Pending posts replying to a just-added entry's post, found through
      // dag_parent_refs (idx_dag_parent_refs_parent) and the reply's own
      // transaction id (idx_mempool_tx_id).
      const parentIds: string[] = [];
      for (const r of added) {
        const tx = txIdOf.get(r);
        if (typeof tx === 'string' && tx.length > 0) {
          parentIds.push(computePostId(tx, 0));
        }
      }
      let refRows: Array<{ rowid: number }> = [];
      if (parentIds.length > 0) {
        // INDEXED BY idx_dag_parent_refs_parent: the store keeps no statistics,
        // so the planner walks the pending-post leg first and leaves
        // idx_dag_parent_refs_parent on an empty join.
        refRows = prepared(
          db,
          `SELECT m.rowid AS rowid
             FROM dag_parent_refs dpr INDEXED BY idx_dag_parent_refs_parent
             JOIN dag_posts dp ON dp.id = dpr.post_id AND dp.status = 'pending'
             JOIN mempool m ON m.tx_id = dp.tx_id
            WHERE dpr.parent_id IN (SELECT value FROM json_each(?))`,
        ).all(JSON.stringify(parentIds)) as Array<{ rowid: number }>;
      }
      const nextFrontier: number[] = [];
      for (const r of outRows) if (!closure.has(r.rowid)) nextFrontier.push(r.rowid);
      for (const r of refRows) if (!closure.has(r.rowid)) nextFrontier.push(r.rowid);
      frontier = nextFrontier;
    }
    // Delete each closure entry's pending post row (NODE_INTERFACE → Post
    // transactions → "The pending row is the mempool entry's DAG shadow"),
    // then the entries themselves — one bound value through json_each so one
    // DELETE reaches the whole set and SQLite's variable cap stays unspent.
    for (const rowid of closure) {
      const tx = txIdOf.get(rowid);
      if (typeof tx === 'string' && tx.length > 0) {
        deletePendingPost(computePostId(tx, 0));
      }
    }
    const ids = Array.from(closure);
    const result = prepared(
      db,
      'DELETE FROM mempool WHERE rowid IN (SELECT value FROM json_each(?))',
    ).run(JSON.stringify(ids));
    return result.changes;
  })();
}

// MEMPOOL_INTERFACE → followAppliedBlock. The pool's part of every applied
// block, inside its write: each applied transaction leaves by tx_id, then,
// through removeUnconfirmed, every entry a spent box takes with it (one bound
// value on mempool_inputs' primary key) and every entry past its expiry or its
// ceiling. Confirmation runs first, so an applied transaction is never read as
// a spend of its own inputs.
export function followAppliedBlock(
  height: number,
  appliedTxIds: readonly string[],
  spentBoxIds: readonly string[],
): number {
  const db = getDb();
  return db.transaction(() => {
    for (const txId of appliedTxIds) removeUtxoTxEntry(txId);
    let unconfirmed = 0;
    if (spentBoxIds.length > 0) {
      const rows = prepared(
        db,
        `SELECT DISTINCT entry_rowid FROM mempool_inputs
           WHERE box_id IN (SELECT value FROM json_each(?))`,
      ).all(JSON.stringify(spentBoxIds)) as Array<{ entry_rowid: number }>;
      unconfirmed += removeUnconfirmed(rows.map((r) => r.entry_rowid));
    }
    unconfirmed += purgeExpired(height);
    return unconfirmed;
  })();
}

// MEMPOOL_INTERFACE → purgeExpired. followAppliedBlock's expiry half: every
// entry past its expiry or its ceiling leaves through removeUnconfirmed, its
// dependents with it. Each predicate is one indexed range —
// idx_mempool_expires and idx_mempool_ceiling.
export function purgeExpired(currentHeight: number): number {
  const db = getDb();
  const rows = prepared(
    db,
    `SELECT rowid FROM mempool WHERE expires_at_height < ?
     UNION
     SELECT rowid FROM mempool WHERE max_valid_height IS NOT NULL AND max_valid_height < ?`,
  ).all(currentHeight, currentHeight) as Array<{ rowid: number }>;
  return removeUnconfirmed(rows.map((r) => r.rowid));
}

export function removeEntry(rowid: number): void {
  const db = getDb();
  // The pool DELETE and the pending post's row deletion are one multi-table
  // mutation (ARCHITECTURE → "Single-transaction atomic writes").
  db.transaction(() => {
    // NODE_INTERFACE → Post transactions — the pending-row rule.
    const row = prepared(db, "SELECT tx_id FROM mempool WHERE rowid = ? AND entry_type = 'utxo_tx' AND tx_id IS NOT NULL").get(rowid) as { tx_id: string } | undefined;
    if (row) {
      deletePendingPost(computePostId(row.tx_id, 0));
    }
    prepared(db, 'DELETE FROM mempool WHERE rowid = ?').run(rowid);
  })();
}

