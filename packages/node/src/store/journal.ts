import { getDb, prepared } from './db.js';
import { encode, decode } from 'cbor-x';
import type { AnyBox, IdentityRecord, UserId } from '@dagsocial/types';
import type { NetworkRecord } from './identity-records.js';
import type { UsernameRow, HolderRecord } from './usernames.js';
import { UnreadableStoredBlockError } from '../services/corrupt-state.js';

// ---------------------------------------------------------------------------
// Journal types (node-owned — NODE_INTERFACE → Block Journal)
// ---------------------------------------------------------------------------

/** One primitive box mutation, in application order. */
export interface BoxMutation {
  kind: 'box';
  op: 'insert' | 'remove';
  boxId: string;
  /** Full box — present iff op === 'insert'. */
  box?: AnyBox;
}

/** One identity-record write, in application order. */
export interface RecordMutation {
  kind: 'record';
  /** hex — `identityKey(identityId)`, the record's tree key (TYPES_INTERFACE → The tree keys). */
  key: string;
  /** The raw 32 bytes, so rollback can address the SQL row. */
  identityId: UserId;
  /** The value written. */
  record: IdentityRecord;
  /** Prior value — absent iff the key did not exist. */
  replaced?: IdentityRecord;
}

/** One network-record write, in application order. */
export interface NetworkMutation {
  kind: 'network';
  memberCount: number;
  replaced: NetworkRecord;
}

/** The name record — tree key `nameKey(nameLower)`. */
export interface UsernameMutation {
  kind: 'username';
  nameLower: string;
  row: UsernameRow | null;
  replaced?: UsernameRow;
}

/** The holder record — tree key `holderKey(owner)`. */
export interface HolderMutation {
  kind: 'holder';
  owner: UserId;
  record: HolderRecord | null;
  replaced?: HolderRecord;
}

/**
 * A mutation of any **committed** entity (NODE_INTERFACE → Block Journal): one
 * discriminated union rather than parallel arrays, in the block's application
 * order, which a revert replays in reverse. The tree's writes come from the same
 * effects through `treeWritesOf` (CONSENSUS_INTERFACE → The tree writes), not
 * from this log.
 */
export type JournalMutation = BoxMutation | RecordMutation | NetworkMutation | UsernameMutation | HolderMutation;

/**
 * The record a block's effects are journalled into, and the one a revert
 * undoes the block from (NODE_INTERFACE → Block Journal). `mutations` is the
 * ordered primitive log; the remaining fields are typed side-records for
 * non-box effects, each with an exact inverse.
 */
export interface BlockJournal {
  blockHeight: number;
  /** Ordered, application order — replayed in reverse by a revert. */
  mutations: JournalMutation[];
  /** The post ids this block committed. Inverse: unconfirmPost (NODE_INTERFACE → Block Journal). */
  confirmedPostIds: string[];
  /** Mempool re-insertion only. */
  appliedUtxoTxs: Array<{ txId: string; txBytes: Uint8Array }>;
  /** Inverse: deleteLikeRecord. */
  likeRecordInsertions: Array<{ targetPostId: string; likerId: UserId }>;
  /** Inverse: restore the prior content and clear the marker. */
  withdrawnPosts: Array<{ id: string; content: string | null }>;
}

// ---------------------------------------------------------------------------
// Persistence — one CBOR-encoded row per applied block
// ---------------------------------------------------------------------------

function toBuffer(data: unknown): Buffer {
  return Buffer.from(encode(data) as unknown as Uint8Array);
}

export function insertBlockJournal(journal: BlockJournal): void {
  const db = getDb();
  prepared(db, `INSERT OR REPLACE INTO block_journal (block_height, journal_cbor) VALUES (?, ?)`).run(journal.blockHeight, toBuffer(journal));
}

// Note for consumers: CBOR round-trips the bigint and byte fields, but the
// side-record `voucherId`/`targetId`/`likerId` come back as plain Uint8Array
// — never assume Buffer.
//
// NODE_INTERFACE → Block Journal: a row that will not decode raises
// `UnreadableStoredBlockError`. The row holds this node's own CBOR encoding
// written by `insertBlockJournal`, so bytes that will not decode are local
// corruption, as `UnreadableStoredBlockError` carries whole.
export function getBlockJournal(height: number): BlockJournal | null {
  const db = getDb();
  const row = prepared(db, 'SELECT journal_cbor FROM block_journal WHERE block_height = ?').get(height) as { journal_cbor: Buffer } | undefined;
  if (!row) return null;
  try {
    return decode(row.journal_cbor) as BlockJournal;
  } catch (err) {
    throw new UnreadableStoredBlockError('getBlockJournal', height, err);
  }
}

export function deleteBlockJournal(height: number): void {
  prepared(getDb(), 'DELETE FROM block_journal WHERE block_height = ?').run(height);
}

export function purgeOldJournals(belowHeight: number): void {
  prepared(getDb(), 'DELETE FROM block_journal WHERE block_height < ?').run(belowHeight);
}

/**
 * NODE_INTERFACE → Block Journal: the lowest `block_height` a journal row is
 * kept for; `null` for an empty table. `block_height INTEGER PRIMARY KEY` is
 * the table's row key — the rowid alias — so the row ordering IS the
 * `block_height` ordering and `MIN(block_height)` is the first row, with no
 * separate index.
 */
export function getLowestJournalHeight(): number | null {
  const row = prepared(getDb(), 'SELECT MIN(block_height) AS h FROM block_journal')
    .get() as { h: number | null };
  return row.h;
}
