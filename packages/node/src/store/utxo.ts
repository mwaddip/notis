import { getDb } from './db.js';
import {
  isBlockJournalOpen,
  openBlockJournalHeight,
  recordBoxInsert,
  recordBoxRemove,
  recordKarmaSupplyDelta,
} from './journal.js';
import { getIdentityRecord, putIdentityRecord } from './identity-records.js';
import { countsAsCirculatingKarma } from '../karma-supply.js';
import { computePostId } from '@dagsocial/types';
import type {
  PostId,
  AnyBox,
  KarmaBox,
  CreditBox,
  GenesisProofBox,
  BondBox,
  PostLockBox,
  VouchBox,
  EmissionBox,
  TreasuryBox,
  KarmaPoolBox,
  VouchEscrowBox,
  LikeAccrualBox,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

// Row shape as returned by statements with .safeIntegers() — every INTEGER
// column arrives as bigint. `value` must stay bigint (loses precision above
// 2^53 otherwise); block-height columns are converted back to number in
// rowToBox.
interface UtxoRow {
  id: string;
  box_type: string;
  value: bigint;
  created_at_block: bigint;
  owner: Buffer | null;
  extra_data: string | null;
  // Creating-transaction provenance, NOT NULL
  // (NODE_INTERFACE → "Box provenance columns").
  tx_id: string;
  output_index: bigint;
}

// ---------------------------------------------------------------------------
// Extra data shapes (stored as JSON in extra_data column)
// ---------------------------------------------------------------------------

interface KarmaExtra {
  decayBurn?: boolean;
}

interface CreditExtra {
  lockedUntilBlock?: number;
}

interface GenesisProofExtra {
  // Raw bytes as a number array, like `post_lock.owner`. The hex form above is
  // for pubkeys; this payload is opaque to consensus and is not one.
  payload: number[];
}

interface BondExtra {
  inviterId: string;          // hex-encoded pubkey in JSON (Uint8Array in code)
  inviteePublicKey: string;   // hex-encoded pubkey — names the paired invite, and
                              // what `getBondFor` and the settlement sweep join on
}

/**
 * ⛔ **`targetPostId` here is DERIVED STATE, not box content.** The consensus
 * box carries no such field — it cannot, because a post's id comes from the
 * transaction that creates the lock, so the field would have to be known before
 * the `TxId` that produces it (TYPES_INTERFACE → PostLockBox). This column is
 * the local index that makes `getPostLockBox(postId)` a keyed lookup, written at
 * apply by every node identically — the same shape P2-D used for like
 * settlement.
 */
interface PostLockExtra {
  originalValue: string;   // bigint as decimal string (JSON cannot carry bigint)
  owner: number[];
  targetPostId: string;    // derived — see above; never read back onto the box
}

interface VouchExtra {
  voucherId: string;    // hex-encoded pubkey
  targetId: string;     // hex-encoded pubkey
}

interface VouchEscrowExtra {
  owner: string;           // hex-encoded pubkey — the voucher; where the karma returns
  releaseAtBlock: number;  // unvouch height + VOUCH_COOLDOWN_BLOCKS
}

/**
 * ⛔ **`author` goes in `extra_data`, not in the `owner` column, and the
 * distinction is the box's whole safety property.** `author` is attribution and
 * never authorization (TYPES_INTERFACE → LikeAccrualBox), and the `owner` column
 * is what every owner-keyed query in this file selects on — `getKarmaBoxes`,
 * `getCreditBoxes`, the decay owner scan. A marker in that column would answer
 * an ownership question it does not hold the answer to.
 */
interface LikeAccrualExtra {
  author: string;       // hex-encoded pubkey — the key the accrual is earmarked for
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex-encoded pubkey string (from JSON extra_data) to Uint8Array. */
function hexToPubkey(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Convert a Uint8Array pubkey to a hex string for JSON extra_data storage. */
function pubkeyToHex(pk: Uint8Array): string {
  return Buffer.from(pk).toString('hex');
}

/**
 * Provenance as the row carries it.
 *
 * Unconditional because `tx_id`/`output_index` are NOT NULL: a row cannot yield
 * a box without provenance, so there is nothing to assign conditionally.
 *
 * Key order and stray keys are not a hazard here either — the AVL value is
 * positional (`boxRecordBytes`), so the layout writes the fields it declares
 * and one it does not declare is unrepresentable rather than merely dangerous.
 */
function provenanceOf(row: UtxoRow): { txId: string; index: number } {
  return { txId: row.tx_id, index: Number(row.output_index) };
}

/**
 * The height to record in the `created_at_block` **store column**.
 *
 * Taken from the open block journal, never from the box (NODE_INTERFACE → "Box
 * Identity and Mint Provenance"). A box carries no height field at all, so
 * there is nothing else `insertBox` could read — the rule is enforced by
 * construction rather than by discipline at each producer.
 *
 * `0` when no journal is open. That is every non-block path — genesis and
 * bootstrap — and it is honest rather than a fallback: those boxes were not
 * created by block application, and `0` is not a real block height. The column
 * is display and `getUnspentBoxes` ordering only; consensus must never read it,
 * so an approximate value here cannot reach the `stateRoot`.
 */
function settledHeight(): number {
  return openBlockJournalHeight() ?? 0;
}

/**
 * Reconstruct a typed box from a utxo_boxes row.
 *
 * Columns id, box_type, value and owner are read directly; everything else is
 * parsed from the extra_data JSON column.
 *
 * `created_at_block` is deliberately NOT read: it is a store column and never a
 * box field (Spec G D3), and putting it back on the object would change every
 * box id — `canonicalBoxBytes` strips only `id`/`txId`/`index`, so any stray key
 * enters the hash. The same is true of any other decoration a display path might
 * want; add a separate query instead.
 */
function rowToBox(row: UtxoRow): AnyBox {
  const extra = row.extra_data ? JSON.parse(row.extra_data) : {};
  const prov = provenanceOf(row);

  switch (row.box_type) {
    case 'karma': {
      const e = extra as KarmaExtra;
      const kb: KarmaBox = {
        id: row.id,
        boxType: 'karma',
        value: row.value,
        owner: new Uint8Array(row.owner!),
        ...prov,
      };
      if (e.decayBurn !== undefined) {
        kb.decayBurn = e.decayBurn;
      }
      return kb;
    }

    case 'credit': {
      const e = extra as CreditExtra;
      const cb: CreditBox = {
        id: row.id,
        boxType: 'credit',
        value: row.value,
        owner: new Uint8Array(row.owner!),
        ...prov,
      };
      if (e.lockedUntilBlock !== undefined) {
        cb.lockedUntilBlock = e.lockedUntilBlock;
      }
      return cb;
    }

    case 'genesis_proof':
      return {
        id: row.id,
        boxType: 'genesis_proof',
        // `as 0n`: the row's real value, never a fabricated literal — same rule
        // as `vouch` below. The cast bridges the interface's literal type,
        // which documents the pinned constant rather than a storage guarantee.
        value: row.value as GenesisProofBox['value'],
        payload: new Uint8Array((extra as GenesisProofExtra).payload),
        ...prov,
      };

    case 'bond': {
      const e = extra as BondExtra;
      return {
        id: row.id,
        boxType: 'bond',
        value: row.value,
        inviterId: hexToPubkey(e.inviterId),
        inviteePublicKey: hexToPubkey(e.inviteePublicKey),
        ...prov,
      };
    }

    case 'post_lock': {
      const e = extra as PostLockExtra;
      // `targetPostId` is deliberately NOT put back on the box: it is this
      // store's index, and a box carrying it would be a second copy of state
      // the transaction already determines.
      return {
        id: row.id,
        boxType: 'post_lock',
        value: row.value,
        originalValue: BigInt(e.originalValue),
        owner: new Uint8Array(e.owner),
        ...prov,
      };
    }

    case 'vouch': {
      const e = extra as VouchExtra;
      return {
        id: row.id,
        boxType: 'vouch',
        // The row's real value, never a fabricated literal `1n`. The box id
        // hashes `canonicalBoxBytes` — value included — so a store that
        // rewrites the value on read returns a box whose bytes do not match
        // its own id, and an AVL prover re-bootstrapped from SQLite diverges
        // from one fed at insert time. The cast pin
        // (`vouch.value == VOUCH_KARMA_AMOUNT`, NODE_INTERFACE → "Vouch
        // transition rules") is what makes every *new* vouch hold exactly 1;
        // the store's job is to round-trip what is actually on disk. The
        // `as` cast bridges VouchBox's literal
        // `1n` value type, which documents the pinned constant rather than a
        // storage guarantee.
        value: row.value as VouchBox['value'],
        voucherId: hexToPubkey(e.voucherId),
        targetId: hexToPubkey(e.targetId),
        ...prov,
      };
    }

    case 'vouch_escrow': {
      const e = extra as VouchEscrowExtra;
      return {
        id: row.id,
        boxType: 'vouch_escrow',
        // ⛔ The row's real value, never `VOUCH_KARMA_AMOUNT`. What makes the
        // unvouch round trip conservation-**structural** is that the escrow
        // carries exactly what the consumed `VouchBox` held (TYPES_INTERFACE →
        // VouchEscrowBox), so a store that substituted the constant on read
        // would make the property true by coincidence instead.
        value: row.value,
        owner: hexToPubkey(e.owner),
        releaseAtBlock: e.releaseAtBlock,
        ...prov,
      };
    }

    case 'like_accrual': {
      const e = extra as LikeAccrualExtra;
      return {
        id: row.id,
        boxType: 'like_accrual',
        // ⛔ **One type, two lifetimes, and the row cannot tell them apart**
        // (TYPES_INTERFACE → LikeAccrualBox): `LIKE_KARMA_COST` on a marker, the
        // running remainder on a carry box. Nothing here distinguishes them
        // because the settlement consumes both in the same step.
        value: row.value,
        author: hexToPubkey(e.author),
        ...prov,
      };
    }

    // The three block-application boxes read back from the shared columns alone
    // — no owner, no extra_data (TYPES_INTERFACE → EmissionBox / TreasuryBox /
    // KarmaPoolBox: "no owner, and therefore no per-type trailing fields").
    // `extra` is parsed above and deliberately unread here: an arm that touched
    // it would be asserting a field the layout does not write.
    case 'emission':
      return {
        id: row.id,
        boxType: 'emission',
        value: row.value,
        ...prov,
      };

    case 'treasury':
      return {
        id: row.id,
        boxType: 'treasury',
        value: row.value,
        ...prov,
      };

    case 'karma_pool':
      return {
        id: row.id,
        boxType: 'karma_pool',
        value: row.value,
        ...prov,
      };

    // Created by a credit-side user transaction and consumed by the same
    // block's application, so a fee box is only ever read back inside the block
    // that made it (MINING_INTERFACE → Coinbase Application).
    case 'fee':
      return {
        id: row.id,
        boxType: 'fee',
        value: row.value,
        ...prov,
      };

    default:
      throw new Error(`Unknown box_type: ${row.box_type}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a single box by its id.
 * Returns null if no row matches.
 */
export function getBox(boxId: string): AnyBox | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM utxo_boxes WHERE id = ? AND spent_at_block IS NULL')
    .safeIntegers()
    .get(boxId) as UtxoRow | undefined;
  return row ? rowToBox(row) : null;
}

/**
 * Return the genesis proof box, or null if this store has not seeded one.
 *
 * No owner argument, unlike every other typed lookup here: the box has no
 * owner, and a network's genesis state holds exactly one of them.
 *
 * `spent_at_block IS NULL` is carried for uniformity with its siblings, not
 * because the column can move — no transition admits a `genesis_proof` input,
 * so no transaction can consume it.
 *
 * `ORDER BY id` because `LIMIT 1` alone names no row: SQLite is free to return
 * any of the matches, so a store holding two proof boxes would answer this
 * lookup differently between reads and `ensureGenesisProofBox` would report a
 * different box each time it declined to create one. Two is unreachable —
 * `OUTPUT_SHAPE` excludes `genesis_proof`, so no transaction can mint a second,
 * and `assertEmptyBeforeGenesis` refuses to seed over a first — which is an
 * argument about the rest of the tree, and the ordering costs nothing if it
 * expires.
 */
export function getGenesisProofBox(): GenesisProofBox | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'genesis_proof' AND spent_at_block IS NULL
       ORDER BY id
       LIMIT 1`,
    )
    .safeIntegers()
    .get() as UtxoRow | undefined;
  return row ? (rowToBox(row) as GenesisProofBox) : null;
}

/**
 * Return the unspent emission box, or null if this network has released its
 * whole schedule (TYPES_INTERFACE → EmissionBox).
 *
 * **`null` is a reachable, ordinary answer here, unlike `getGenesisProofBox`'s.**
 * Genesis seeds one on every network, and the last emitting block consumes it
 * and creates no successor, so above the terminus there is nothing to find and
 * nothing is released. A caller that treats `null` as a fault refuses every
 * block past the terminus.
 *
 * `ORDER BY id` for the reason its sibling above carries: `LIMIT 1` alone names
 * no row. Two unspent emission boxes are unreachable — `OUTPUT_SHAPE` excludes
 * the type so no transaction mints one, and block application consumes the
 * predecessor in the same block it writes the successor — but that is an
 * argument about the rest of the tree, and the ordering costs nothing if it
 * expires.
 */
export function getEmissionBox(): EmissionBox | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'emission' AND spent_at_block IS NULL
       ORDER BY id
       LIMIT 1`,
    )
    .safeIntegers()
    .get() as UtxoRow | undefined;
  return row ? (rowToBox(row) as EmissionBox) : null;
}

/**
 * Return the unspent treasury box, or null before the first block whose
 * `split.treasury` is nonzero (TYPES_INTERFACE → TreasuryBox).
 *
 * **`null` here means "not yet", where the emission box's means "no longer".**
 * Genesis creates none because it would hold `0`, and once created there is no
 * rule that reduces it — so this answers `null` for a prefix of the chain and
 * never again after.
 */
export function getTreasuryBox(): TreasuryBox | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'treasury' AND spent_at_block IS NULL
       ORDER BY id
       LIMIT 1`,
    )
    .safeIntegers()
    .get() as UtxoRow | undefined;
  return row ? (rowToBox(row) as TreasuryBox) : null;
}

/**
 * Return the unspent karma supply pool box (TYPES_INTERFACE → KarmaPoolBox).
 *
 * **`null` means the store has not been seeded**, and nothing else. Genesis
 * creates one on every network and the pool never terminates — burns must
 * always have somewhere to return, so a zero-value successor is created where
 * the emission box's is not. A caller reading `null` as "the supply is
 * exhausted" has the type exactly backwards.
 *
 * `ORDER BY id` for the reason its two siblings above carry: `LIMIT 1` alone
 * names no row.
 */
export function getKarmaPoolBox(): KarmaPoolBox | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'karma_pool' AND spent_at_block IS NULL
       ORDER BY id
       LIMIT 1`,
    )
    .safeIntegers()
    .get() as UtxoRow | undefined;
  return row ? (rowToBox(row) as KarmaPoolBox) : null;
}

/**
 * Return the single unspent karma box for the given owner, or null if none.
 */
export function getKarmaBox(owner: Uint8Array): KarmaBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL
       LIMIT 1`,
    )
    .safeIntegers()
    .get(Buffer.from(owner)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as KarmaBox) : null;
}

/**
 * Return all unspent karma boxes for the given owner, sorted by value
 * descending (largest-first for UTXO selection).
 */
export function getKarmaBoxes(owner: Uint8Array): KarmaBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      // ⛔ **`value DESC` ALONE IS NOT A TOTAL ORDER, and this list feeds a
      // derivation.** The decay pass lists these ids as the settlement's inputs
      // and the transaction id hashes them in order, so two owners' boxes of
      // EQUAL value — two faucet grants, a payout that matches an existing
      // balance — would be returned in whatever order SQLite chose and two nodes
      // would derive two different transactions (NODE_INTERFACE → A derived
      // quantity has TWO kinds of input). `id` breaks the tie and is one of the
      // three permitted orderings; `value DESC` stays because callers select
      // coins from the front.
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL
       ORDER BY value DESC, id`,
    )
    .safeIntegers()
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as KarmaBox[];
}

/**
 * Summed value of every unspent KarmaBox owned by `owner`.
 *
 * Consensus input, not a convenience read: bond settlement's unlock predicate
 * reads it at spend time (NODE_INTERFACE → "Bond transition rules"), so every
 * validation path — pool entry, relay, block application — must compute it
 * through this one function or nodes can split. It MUST sum all unspent boxes,
 * never read a single one: multiple unspent karma boxes per owner is reachable
 * (faucet grant + mint, or a karma split), and `getKarmaBox` above is `LIMIT 1`
 * with no `ORDER BY` — an arbitrary row, so a single-box read would give two
 * nodes with different physical row order different balances for the same
 * owner, and different unlock verdicts on the same settlement.
 *
 * Implemented over `getKarmaBoxes` so exactly one query names the
 * unspent-karma set — a second WHERE clause here would be a mirror
 * implementation.
 */
export function getKarmaValue(owner: Uint8Array): bigint {
  return getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n);
}

/**
 * Return the single unspent credit box for the given owner, or null if none.
 */
export function getCreditBox(owner: Uint8Array): CreditBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
       LIMIT 1`,
    )
    .safeIntegers()
    .get(Buffer.from(owner)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as CreditBox) : null;
}

/**
 * Return all unspent credit boxes for the given owner, sorted by value
 * descending (largest-first for UTXO selection).
 */
export function getCreditBoxes(owner: Uint8Array): CreditBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
       ORDER BY value DESC`,
    )
    .safeIntegers()
    .all(Buffer.from(owner)) as UtxoRow[];
  return rows.map(rowToBox) as CreditBox[];
}

/**
 * Return all unspent credit boxes for the given owner whose lockedUntilBlock
 * has passed (or is unset), sorted by value descending. Excludes boxes that
 * are still locked at the given block height.
 */
export function getUnlockedCreditBoxes(
  owner: Uint8Array,
  blockHeight: number,
): CreditBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'credit' AND spent_at_block IS NULL
         AND (json_extract(extra_data, '$.lockedUntilBlock') IS NULL
              OR json_extract(extra_data, '$.lockedUntilBlock') <= ?)
       ORDER BY value DESC`,
    )
    .safeIntegers()
    .all(Buffer.from(owner), blockHeight) as UtxoRow[];
  return rows.map(rowToBox) as CreditBox[];
}

/**
 * The bond naming this invitee, or null.
 *
 * `inviteePublicKey` IS the pairing — a key is invited at most once, so this
 * names exactly one live bond. `LIMIT 1` is safe for that reason and not by
 * hope: the invite transition bars a key that already holds an identity record,
 * and block application bars a second bond for a key within one block
 * (NODE_INTERFACE → Legal box transitions).
 */
export function getBondFor(inviteePublicKey: Uint8Array): BondBox | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'bond'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.inviteePublicKey') = ?
       LIMIT 1`,
    )
    .safeIntegers()
    .get(pubkeyToHex(inviteePublicKey)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as BondBox) : null;
}

/**
 * Every live bond whose invitee's grant applied at exactly `invitedAtBlock`.
 *
 * **Takes the invite height, not the settle height**, so this function knows
 * nothing about `INVITE_PROBATION_BLOCKS`: the caller subtracts, and no network
 * parameter reaches the store. `processMaturedBonds` is the caller and it is the
 * one place the deadline is computed.
 *
 * The join runs through the identity record because a bond carries neither half
 * of its own deadline — the height lives on the invitee's record and the length
 * on the profile. `inviteePublicKey` is the only pairing either side needs.
 *
 * ⚠ **`0` means *never invited*, and the caller's subtraction lands on it at
 * exactly `height == INVITE_PROBATION_BLOCKS`** — so unguarded, every uninvited
 * identity that holds a record matches at once and every open invite's bond
 * settles for free in one block. **Two guards hold that shut and either alone
 * suffices**: the `invited_at_block > 0` predicate here and the caller's early
 * return. They are the same rule written twice rather than two independent
 * checks, which is why `invite-block-apply.test.ts` has to remove both before
 * its case fails.
 */
export function getBondsInvitedAt(invitedAtBlock: number): BondBox[] {
  const rows = getDb()
    .prepare(
      `SELECT b.* FROM utxo_boxes b
       WHERE b.box_type = 'bond'
         AND b.spent_at_block IS NULL
         AND json_extract(b.extra_data, '$.inviteePublicKey') IN (
           SELECT lower(hex(identity_id)) FROM identity_records
           WHERE invited_at_block > 0 AND invited_at_block = ?
         )
       ORDER BY b.id`,
    )
    .safeIntegers()
    .all(invitedAtBlock) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as BondBox);
}

/**
 * Return all bond boxes associated with the given inviter.
 */
export function getBondBoxes(inviterId: Uint8Array): BondBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'bond'
         AND json_extract(extra_data, '$.inviterId') = ?`,
    )
    .safeIntegers()
    .all(pubkeyToHex(inviterId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as BondBox);
}

/**
 * Return the hex-encoded liker IDs for everyone holding a like-record on
 * the given post (N4a — reads `like_records`, the source of truth since
 * per-block settlement). Used by the feed API to tell clients who has liked.
 * Ordered by liker id so the listing is a function of state, not row order.
 */
export function getLikersForPost(targetPostId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT liker_id FROM like_records
       WHERE target_post_id = ?
       ORDER BY liker_id`,
    )
    .all(targetPostId) as { liker_id: Buffer }[];
  return rows.map((r) => r.liker_id.toString('hex'));
}

/**
 * Every live `VouchEscrowBox` whose cooldown has run out at `height`.
 *
 * `<=` and not `==`: an escrow whose release height fell inside a reorged-away
 * span would otherwise wait forever. The settlement consumes what is due, so
 * "due" has to mean *at or before*.
 *
 * ⛔ **`ORDER BY id` is a consensus obligation, not tidiness.** The settlement
 * emits one karma credit per escrow and its outputs are hashed in order, so two
 * nodes reading this in different orders derive two different transactions.
 * Ascending box id is one of the three orderings the block fixes
 * (NODE_INTERFACE → Determinism is this mechanism's whole risk).
 */
export function getVouchEscrowsDueAt(height: number): VouchEscrowBox[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'vouch_escrow'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.releaseAtBlock') <= ?
       ORDER BY id`,
    )
    .safeIntegers()
    .all(height) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as VouchEscrowBox);
}

/**
 * Every live escrow this voucher holds, ascending box id.
 *
 * ⚠ **It reports no target, because the box carries none**
 * (TYPES_INTERFACE → VouchEscrowBox). What an escrow can report is the value and
 * the release height, which is what a voucher needs to know.
 */
export function getVouchEscrowsFor(voucherId: Uint8Array): VouchEscrowBox[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'vouch_escrow'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.owner') = ?
       ORDER BY id`,
    )
    .safeIntegers()
    .all(pubkeyToHex(voucherId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as VouchEscrowBox);
}

/**
 * Does this voucher hold an unreleased escrow?
 *
 * ⛔ **KEYED ON THE VOUCHER ALONE, BECAUSE THE BOX CARRIES NO TARGET.**
 * `VouchEscrowBox` carries `owner` and `releaseAtBlock` and nothing else
 * (TYPES_INTERFACE → VouchEscrowBox), so a pair-scoped question is one this
 * state cannot answer. **A voucher cooling down may not recast at all**, which
 * is the stronger of the two readings and the only one the box supports.
 *
 * ⚠ **Stronger in the direction the design already leans.** The staked karma is
 * in the escrow rather than in the voucher's karma boxes, so
 * `VOUCH_MIN_BALANCE` already withholds it from a recast; this makes that a
 * stated rule instead of an arithmetic accident.
 */
export function hasActiveVouchEscrow(voucherId: Uint8Array): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM utxo_boxes
       WHERE box_type = 'vouch_escrow'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.owner') = ?`,
    )
    .get(pubkeyToHex(voucherId));
  return row !== undefined;
}

/**
 * The live carry box for one author, or null.
 *
 * ⛔ **One per author is an invariant of the settlement, not of this query.**
 * The settlement consumes an author's carry box in the same step that emits the
 * replacement, so a second one cannot arise; `ORDER BY id LIMIT 1` is the stated
 * total order every protocol-box read in this package carries, so a defect
 * upstream degrades to a deterministic verdict rather than to a fork.
 *
 * ⛔ **`exclude` is not an optimisation — it is the only thing that separates a
 * carry box from a marker.** The two share a type and are told apart by lifetime
 * alone (TYPES_INTERFACE → LikeAccrualBox); at the point the settlement is
 * derived, this block's markers are live `like_accrual` boxes naming the same
 * author. Their ids are the caller's, from the body, so the discrimination is
 * block content and not a heuristic on value — a carry of `1` and a marker of
 * `LIKE_KARMA_COST` are indistinguishable by value at the constants in force.
 */
export function getLikeCarryBox(
  author: Uint8Array,
  exclude: Set<string>,
): LikeAccrualBox | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'like_accrual'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.author') = ?
       ORDER BY id`,
    )
    .safeIntegers()
    .all(pubkeyToHex(author)) as UtxoRow[];
  for (const row of rows) {
    if (!exclude.has(row.id)) return rowToBox(row) as LikeAccrualBox;
  }
  return null;
}

/**
 * Return all unspent post lock boxes for per-block vesting.
 *
 * Ordered by box id — consensus code iterates the result, so the order must
 * be deterministic across nodes.
 */
export function getUnspentPostLockBoxes(): PostLockBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock' AND spent_at_block IS NULL
       ORDER BY id`,
    )
    .safeIntegers()
    .all() as UtxoRow[];
  return rows.map((r) => rowToBox(r) as PostLockBox);
}

/**
 * Return the unspent PostLockBox for a specific post, if any.
 */
export function getPostLockBox(targetPostId: string): PostLockBox | null {
  const db = getDb();
  const row = db
    .prepare(
      // One lock per post is the transition's invariant, so this names one box.
      // ⛔ **The stated order is what keeps a defect upstream from becoming a
      // fork**: both prune settlement and post-lock vesting walk this result
      // into the settlement, so a second lock for one post would otherwise let
      // two nodes pick different boxes and derive different transactions.
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL
       ORDER BY id LIMIT 1`,
    )
    .safeIntegers()
    .get(targetPostId) as UtxoRow | undefined;
  if (!row) return null;
  return rowToBox(row) as PostLockBox;
}

/**
 * Bump an identity's activity clock to the height of the block being applied
 * (NODE_INTERFACE → "Populating the record").
 *
 * Called from `insertBox` for every karma box with `decayBurn !== true` — the
 * staleness predicate ("no unspent non-decay karma box newer than the
 * threshold") read from the write end. Recording it at the store choke point is
 * what makes the clock correct by construction rather than by re-derivation at
 * each of the eight producers.
 *
 * `lastDecayBlock` is carried through untouched: the fields of the record
 * have different writers, and an activity bump that reset the decay clock would
 * hand the owner a free interval. `invitedAtBlock` likewise — the grant path owns it, and
 * this hook fires on the claim's OWN karma output, so a bump that reset it would
 * erase the height the very same transaction is being recorded for. And
 * `lifetimeLikesReceived`: this hook fires on the like PAYOUT's minted box, so a
 * reset here would destroy the very count that payout was made against.
 *
 * With no journal open — genesis, bootstrap, any non-block path — this records
 * nothing, consistent with every other choke-point hook. Consensus only reads
 * the record during block application, and a height invented outside a block
 * would not be a settled one.
 */
function bumpActivityClock(owner: Uint8Array): void {
  const height = openBlockJournalHeight();
  if (height === null) return;
  const existing = getIdentityRecord(owner);
  putIdentityRecord(owner, {
    lastActivityBlock: height,
    lastDecayBlock: existing?.lastDecayBlock ?? 0,
    invitedAtBlock: existing?.invitedAtBlock ?? 0,
    lifetimeLikesReceived: existing?.lifetimeLikesReceived ?? 0n,
  });
}

/**
 * Insert a box into the utxo_boxes table.
 *
 * Common fields are stored directly; box-type-specific fields are serialised
 * into the extra_data JSON column.
 */
/**
 * ⛔ **THE TWO DERIVATION ROUTES FOR A POST LOCK'S TARGET, stated together
 * because a reader who sees only one will "simplify" the other away.**
 *
 * A lock carries no `targetPostId` (TYPES_INTERFACE → PostLockBox), so the
 * index below is derived — and the derivation differs by which transaction
 * created the box:
 *
 *  1. **The original lock** is an output of the POST'S OWN transaction, so its
 *     provenance names that transaction and the target is
 *     `computePostId(box.txId, 0)`. Any node holding the box can recompute it.
 *  2. **The remainder lock** (a partially-vested lock, re-created after a tally)
 *     is an output of a SYNTHETIC MINT transaction, so its provenance names the
 *     mint and NOT the post. Route 1 would derive a wrong id from it. The caller
 *     passes the target explicitly; it is recoverable because
 *     `postlockRemainderContext(postId)` puts the post id in the mint subject.
 *
 * ⚠ **Route 1 does not cover route 2 and never will.** Collapsing them silently
 * re-points every remainder lock at an id derived from a mint.
 */
export function insertBox(box: AnyBox, postLockTarget?: PostId): void {
  // Never record an insert without its boxId — the apply funnel's totality
  // catch converts this throw into a block rejection.
  if (isBlockJournalOpen() && !box.id) {
    throw new Error('insertBox: box.id must be set while a block journal is open');
  }

  const db = getDb();

  // Build extra_data and column values per box type
  let extraData: unknown;
  let owner: Buffer | null = null;
  // Set below iff this box is a non-decay karma box — the identity whose
  // activity clock this insertion advances. Carried out of the
  // switch rather than bumped inside it so the record is written *after* the
  // box row and its journal entry, keeping reverse-order rollback in the order
  // the two writes happened.
  let activityOwner: Uint8Array | null = null;

  switch (box.boxType) {
    case 'karma': {
      const k = box as KarmaBox;
      const ke: KarmaExtra = {};
      if (k.decayBurn !== undefined) {
        ke.decayBurn = k.decayBurn;
      }
      extraData = ke satisfies KarmaExtra;
      owner = Buffer.from(k.owner);
      // `!== true`, not `=== undefined`: a decay-burn box is the one karma box
      // that must NOT reset the clock, and `decayBurn: false` is normal
      // activity. This is the same test `isIdentityStale` applied to boxes.
      if (k.decayBurn !== true) activityOwner = k.owner;
      break;
    }
    case 'credit': {
      const c = box as CreditBox;
      const ce: CreditExtra = {};
      if (c.lockedUntilBlock !== undefined) {
        ce.lockedUntilBlock = c.lockedUntilBlock;
      }
      extraData = ce satisfies CreditExtra;
      owner = Buffer.from(c.owner);
      break;
    }
    case 'genesis_proof': {
      const g = box as GenesisProofBox;
      // No `owner`: the box has no holder, so the column stays NULL, which is
      // what the schema's per-type note describes.
      extraData = { payload: Array.from(g.payload) } satisfies GenesisProofExtra;
      break;
    }
    case 'bond': {
      const b = box as BondBox;
      extraData = {
        inviterId: pubkeyToHex(b.inviterId),
        inviteePublicKey: pubkeyToHex(b.inviteePublicKey),
      } satisfies BondExtra;
      break;
    }
    case 'post_lock': {
      const p = box as PostLockBox;
      owner = Buffer.from(p.owner);
      // Route 2 when the caller names the target, route 1 otherwise — see the
      // two routes on `insertBox` above.
      if (postLockTarget === undefined && !p.txId) {
        throw new Error('insertBox: a post_lock box needs provenance or an explicit target');
      }
      extraData = {
        originalValue: p.originalValue.toString(),
        owner: Array.from(p.owner),
        targetPostId: postLockTarget ?? computePostId(p.txId!, 0),
      } satisfies PostLockExtra;
      break;
    }
    case 'vouch': {
      const v = box as VouchBox;
      extraData = {
        voucherId: pubkeyToHex(v.voucherId),
        targetId: pubkeyToHex(v.targetId),
      } satisfies VouchExtra;
      break;
    }
    case 'vouch_escrow': {
      const v = box as VouchEscrowBox;
      extraData = {
        owner: pubkeyToHex(v.owner),
        releaseAtBlock: v.releaseAtBlock,
      } satisfies VouchEscrowExtra;
      break;
    }
    case 'like_accrual': {
      const a = box as LikeAccrualBox;
      extraData = { author: pubkeyToHex(a.author) } satisfies LikeAccrualExtra;
      break;
    }
    // No `owner` and no per-type fields on any of the four, so the columns
    // they share with every box carry the whole box — the same shape
    // `genesis_proof` has, minus its payload. `extraData` stays `{}` rather
    // than NULL so `rowToBox`'s `JSON.parse` sees the same empty object every
    // other ownerless arm does.
    case 'emission':
    case 'treasury':
    case 'karma_pool':
    case 'fee': {
      extraData = {};
      break;
    }
    default:
      throw new Error(`Unknown box type: ${(box as AnyBox).boxType}`);
  }

  // Plain INSERT, deliberately not INSERT OR REPLACE: an id collision hits the
  // `id` PRIMARY KEY, which the apply funnel's totality catch turns into a
  // block rejection. OR REPLACE would silently drop the colliding box instead —
  // state corruption in place of a loud failure. Provenance-derived ids make
  // the collision structurally unreachable, so this is the backstop for that
  // property rather than a live path (NODE_INTERFACE → "Box provenance
  // columns").
  db.prepare(
    `INSERT INTO utxo_boxes
       (id, box_type, value, created_at_block, spent_at_block,
        owner, extra_data,
        tx_id, output_index)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    box.id,
    box.boxType,
    box.value,
    settledHeight(),
    owner,
    JSON.stringify(extraData),
    box.txId,
    box.index,
  );

  recordBoxInsert(box);

  // A karma-bearing box entering the live set is karma entering circulation, so
  // the pool owes the same amount (TYPES_INTERFACE → KarmaPoolBox). Accounted at
  // this choke point rather than at the producers, which is what makes the
  // supply non-inflatable **by construction**: a mint site added later cannot
  // forget to draw, because drawing is not something its author does.
  if (countsAsCirculatingKarma(box.boxType)) recordKarmaSupplyDelta(box.value);

  if (activityOwner !== null) bumpActivityClock(activityOwner);
}

/**
 * A consume named a box this store does not hold live — absent, or already
 * spent.
 *
 * ⚠ **Deliberately not a `CorruptChainStateError`.** The apply funnel's
 * totality catch converts this into a block rejection, the shape the `Insert`
 * arm's primary-key failure already takes: a caller naming a box the store does
 * not hold live costs the block, never the node. A `CorruptChainStateError`
 * subclass would reach `failStopIfCorruptChain` and end the process instead
 * (NODE_INTERFACE → "What the funnel's totality catch is FOR").
 *
 * The id is a field rather than only a message, following the fail-stop family:
 * the diagnostic should not be parsed back out of prose.
 */
export class BoxNotLiveError extends Error {
  constructor(readonly boxId: string) {
    super(`consumeBox: ${boxId} names no live box — absent, or already spent`);
    this.name = 'BoxNotLiveError';
  }
}

/**
 * Mark a **live** box spent at the given block height.
 *
 * ⛔ **The `spent_at_block IS NULL` predicate and the row-count check are ONE
 * guard.** The predicate alone leaves the `UPDATE` a no-op while
 * `recordBoxRemove` still journals a remove, and `proverFeedFromJournal` does
 * not dedupe repeated removes — so that entry reaches the AVL+ tree, which
 * refuses a `Remove` of a key it does not hold and stops the node
 * (`DivergedStateTreeError`, the `Remove` arm). Together they make a journalled
 * remove follow a spend that happened rather than a caller's assumption.
 *
 * `recordBoxRemove` runs downstream of the check, so a refused consume journals
 * nothing (NODE_INTERFACE → Store Interface, the `consumeBox` row).
 *
 * **`RETURNING` rather than a second read**, and it tightens the guard above
 * rather than only saving a round trip: the row is the spend that happened, so
 * the type and value accounted below are the ones this call actually removed —
 * a `SELECT` beforehand would describe a box the `UPDATE` might then not match.
 * `safeIntegers`, because `value` is a `bigint` above 2⁵³.
 */
export function consumeBox(boxId: string, consumedAtBlock: number): void {
  const spent = getDb()
    .prepare(
      `UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ? AND spent_at_block IS NULL
       RETURNING box_type, value`,
    )
    .safeIntegers()
    .get(consumedAtBlock, boxId) as { box_type: string; value: bigint } | undefined;
  if (spent === undefined) throw new BoxNotLiveError(boxId);
  recordBoxRemove(boxId);

  // The mirror of `insertBox`'s accounting: karma leaving the live set is karma
  // leaving circulation, and the pool takes it back (TYPES_INTERFACE →
  // KarmaPoolBox). Consume and insert are the only writers of the live set —
  // `deleteBox` and `unconsumeBox` are journal-replay inverses and account
  // nothing, for the reason they journal nothing — so the pair is the whole of
  // it.
  if (countsAsCirculatingKarma(spent.box_type as AnyBox['boxType'])) {
    recordKarmaSupplyDelta(-spent.value);
  }
}

/**
 * Reverse a consumeBox by clearing spent_at_block.
 * Fork-rollback inverse — never records to the block journal.
 */
export function unconsumeBox(boxId: string): void {
  getDb().prepare('UPDATE utxo_boxes SET spent_at_block = NULL WHERE id = ?').run(boxId);
}

/**
 * Delete a box entirely (for rolling back an insertBox).
 * Fork-rollback inverse — never records to the block journal.
 */
export function deleteBox(boxId: string): void {
  getDb().prepare('DELETE FROM utxo_boxes WHERE id = ?').run(boxId);
}

/**
 * Return all unspent boxes from the UTXO set.
 * Used to bootstrap the AVL prover on startup.
 */
export function getUnspentBoxes(): AnyBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, box_type, value, created_at_block, owner, extra_data,
              tx_id, output_index
       FROM utxo_boxes
       WHERE spent_at_block IS NULL
       ORDER BY created_at_block ASC`,
    )
    .safeIntegers()
    .all() as UtxoRow[];
  return rows.map(rowToBox);
}
