import { getDb } from './db.js';
import {
  isBlockJournalOpen,
  openBlockJournalHeight,
  recordBoxInsert,
  recordBoxRemove,
} from './journal.js';
import { getIdentityRecord, putIdentityRecord } from './identity-records.js';
import { BOX_GUARDS } from '@dagsocial/types';
import type {
  AnyBox,
  KarmaBox,
  CreditBox,
  InviteBox,
  GenesisProofBox,
  BondBox,
  PostLockBox,
  VouchBox,
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

interface InviteExtra {
  inviterId: string;          // hex-encoded pubkey in JSON (Uint8Array in code)
  inviteePublicKey: string;   // hex-encoded pubkey — `getInviteFor` queries on it
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

interface PostLockExtra {
  originalValue: string;   // bigint as decimal string (JSON cannot carry bigint)
  owner: number[];
  targetPostId: string;
}

interface VouchExtra {
  voucherId: string;    // hex-encoded pubkey
  targetId: string;     // hex-encoded pubkey
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
 * Columns id, box_type, value and owner are read directly; `guard` comes from
 * `BOX_GUARDS`, which `@dagsocial/types` owns as the one mapping from
 * discriminant to guard. Everything else is parsed from the extra_data JSON
 * column.
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
        guard: BOX_GUARDS.karma,
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
        guard: BOX_GUARDS.credit,
        ...prov,
      };
      if (e.lockedUntilBlock !== undefined) {
        cb.lockedUntilBlock = e.lockedUntilBlock;
      }
      return cb;
    }

    case 'invite':
      return {
        id: row.id,
        boxType: 'invite',
        value: row.value,
        inviterId: hexToPubkey((extra as InviteExtra).inviterId),
        inviteePublicKey: hexToPubkey((extra as InviteExtra).inviteePublicKey),
        guard: BOX_GUARDS.invite,
        ...prov,
      };

    case 'genesis_proof':
      return {
        id: row.id,
        boxType: 'genesis_proof',
        // `as 0n`: the row's real value, never a fabricated literal — same rule
        // as `vouch` below. The cast bridges the interface's literal type,
        // which documents the pinned constant rather than a storage guarantee.
        value: row.value as GenesisProofBox['value'],
        payload: new Uint8Array((extra as GenesisProofExtra).payload),
        guard: BOX_GUARDS.genesis_proof,
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
        guard: BOX_GUARDS.bond,
        ...prov,
      };
    }

    case 'post_lock': {
      const e = extra as PostLockExtra;
      return {
        id: row.id,
        boxType: 'post_lock',
        value: row.value,
        originalValue: BigInt(e.originalValue),
        owner: new Uint8Array(e.owner),
        targetPostId: e.targetPostId,
        guard: BOX_GUARDS.post_lock,
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
        guard: BOX_GUARDS.vouch,
        ...prov,
      };
    }

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
 * because the column can move — the box's `unspendable` guard is refused by
 * `checkGuards`, so no transaction can consume it.
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
      `SELECT * FROM utxo_boxes
       WHERE owner = ? AND box_type = 'karma' AND spent_at_block IS NULL
       ORDER BY value DESC`,
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
 * Every open invite created by the given inviter — created, neither claimed nor
 * cancelled.
 *
 * An invite has no expiry, so "open" is the whole of it: unspent IS open
 * (NODE_INTERFACE → Store).
 */
export function getOpenInvites(inviterId: Uint8Array): InviteBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'invite'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.inviterId') = ?`,
    )
    .safeIntegers()
    .all(pubkeyToHex(inviterId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as InviteBox);
}

/**
 * The at-most-one live invite naming this key, or null.
 *
 * At most one because an invite may not name an existing account and a claim
 * makes the invitee one, so a key is invited at most once — and invite creation
 * is where that is enforced (NODE_INTERFACE → "Bond transition rules"). `LIMIT
 * 1` is safe for that reason and not by hope; a second row would mean the
 * create-time bar had been bypassed, which is a consensus fault rather than a
 * case to order around.
 */
export function getInviteFor(inviteePublicKey: Uint8Array): InviteBox | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'invite'
         AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.inviteePublicKey') = ?
       LIMIT 1`,
    )
    .safeIntegers()
    .get(pubkeyToHex(inviteePublicKey)) as UtxoRow | undefined;
  return row ? (rowToBox(row) as InviteBox) : null;
}

/**
 * The bond paired with this invitee's invite, or null.
 *
 * `inviteePublicKey` IS the pairing — the invite and the bond are pinned to one
 * key at creation and a key is invited at most once, so this names exactly one
 * live pair. The claim, cancel and settlement paths all resolve through here.
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
 * Every live bond whose invitee's claim applied at exactly `invitedAtBlock`.
 *
 * **Takes the claim height, not the settle height**, so this function knows
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
      `SELECT * FROM utxo_boxes
       WHERE box_type = 'post_lock'
         AND json_extract(extra_data, '$.targetPostId') = ?
         AND spent_at_block IS NULL`,
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
 * hand the owner a free interval. `likeCarry` likewise — it is
 * settlement-owned, and zeroing it here would confiscate accrued likes on
 * every karma receipt. `invitedAtBlock` likewise — the claim path owns it, and
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
    likeCarry: existing?.likeCarry ?? 0n,
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
export function insertBox(box: AnyBox): void {
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
    case 'invite': {
      const i = box as InviteBox;
      extraData = {
        inviterId: pubkeyToHex(i.inviterId),
        inviteePublicKey: pubkeyToHex(i.inviteePublicKey),
      } satisfies InviteExtra;
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
      extraData = {
        originalValue: p.originalValue.toString(),
        owner: Array.from(p.owner),
        targetPostId: p.targetPostId,
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
        owner, guard, extra_data,
        tx_id, output_index)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    box.id,
    box.boxType,
    box.value,
    settledHeight(),
    owner,
    box.guard,
    JSON.stringify(extraData),
    box.txId,
    box.index,
  );

  recordBoxInsert(box);

  if (activityOwner !== null) bumpActivityClock(activityOwner);
}

/**
 * Mark a box as spent at the given block height.
 */
export function consumeBox(boxId: string, consumedAtBlock: number): void {
  getDb()
    .prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?')
    .run(consumedAtBlock, boxId);
  recordBoxRemove(boxId);
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
