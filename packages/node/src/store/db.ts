import Database from 'better-sqlite3';
import { emitDbOpenStarted, emitDbOpenComplete } from '../journal.js';

let db: Database.Database | null = null;

const MIGRATIONS = [
  // Posts DAG
  `CREATE TABLE IF NOT EXISTS dag_posts (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,       -- hex of the 32-byte content commitment
    content TEXT,                     -- NULL = placeholder (structure known, body not held)
    author BLOB NOT NULL,             -- 32-byte Ed25519 public key
    parent_refs TEXT NOT NULL,       -- JSON array of PostId strings
    protocol_version INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'regular',  -- PostType: 'regular' | 'profile'
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed'
    block_height INTEGER,            -- NULL until confirmed
    block_index INTEGER,             -- NULL until confirmed; committed position in block
    withdrawn_at_height INTEGER      -- NULL = not withdrawn; set = withdrawal confirmed at this height
  )`,

  `CREATE TABLE IF NOT EXISTS dag_parent_refs (
    post_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    PRIMARY KEY (post_id, parent_id)
  )`,

  // Stumps — the columns `Stump` declares and no others. A stump's subtree
  // Merkle root, its prune signature and its karma deltas live in the prune
  // transaction the block carries, never in the row the settlement writes.
  `CREATE TABLE IF NOT EXISTS dag_stumps (
    id TEXT PRIMARY KEY,
    root_post_hash TEXT NOT NULL,
    author_id BLOB NOT NULL,          -- 32-byte Ed25519 public key
    reply_count INTEGER NOT NULL,
    upvote_count INTEGER NOT NULL,
    protocol_version INTEGER NOT NULL,
    compacted_at_block_height INTEGER NOT NULL
  )`,

  // UTXO boxes
  //
  // created_at_block carries the box's own `createdAtBlock` field — what the
  // creator declared and `canonicalBoxBytes` encodes. The column is NOT
  // committed in the stateRoot, so a node bootstrapping from an AVL snapshot
  // cannot reconstruct it.
  //
  // tx_id/output_index are the box's creating-transaction provenance
  // (NODE_INTERFACE → "Box provenance columns").
  //
  // NOT NULL is also the only thing here that fails LOUDLY. `TextEncoder`
  // encodes `undefined` as zero bytes and `u32BE` maps it to the sentinel, so a
  // box with missing provenance derives a stable *wrong* id rather than
  // throwing — invisible in a phase where every golden legitimately moves. The
  // constraint is what turns that into an error.
  //
  // A (tx_id, output_index) pair names exactly one box by construction, so no
  // valid block can trip the constraint — it turns a derivation bug into a loud
  // failure instead of silent state corruption.
  //
  `CREATE TABLE IF NOT EXISTS utxo_boxes (
    id TEXT PRIMARY KEY,
    box_type TEXT NOT NULL,           -- in enum8 tag order: 'karma' | 'credit' | 'genesis_proof' | 'bond' | 'post_lock' | 'vouch' | 'emission' | 'treasury' | 'fee' | 'karma_pool' | 'like_accrual' | 'vouch_escrow'
    value INTEGER NOT NULL,
    created_at_block INTEGER NOT NULL,
    spent_at_block INTEGER,           -- NULL = unspent
    owner BLOB,                       -- 32-byte public key (NULL for invite/genesis_proof/bond/vouch/emission/treasury/fee/karma_pool boxes)
    extra_data TEXT,                  -- JSON for box-specific fields (inviteePublicKey, targetPostId, etc.)
    tx_id TEXT NOT NULL,              -- Creating transaction — real or synthetic mint (Spec G)
    output_index INTEGER NOT NULL,    -- u32 position within that transaction's outputs
    UNIQUE(tx_id, output_index)
  )`,

  // Identity records — the second committed entity alongside boxes (Spec G D4).
  // Per-identity decay clock; a creator-declared box height would let a backdated
  // box backdate its owner's clock, and the created_at_block column is
  // uncommitted, so the clock lives in committed state
  // (NODE_INTERFACE → Populating the record).
  //
  // Keyed on the raw 32 Ed25519 public-key bytes (UserId — Spec G D5 withdrawn,
  // there is no separate IdentityId type). The AVL key is DERIVED as
  // blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32], never the raw bytes —
  // both are total functions of the identity, so the two cannot drift.
  //
  // invited_at_block: the height an invite claim applied, 0 = never invited.
  // Written only by block application when a claim applies, and read by the
  // bond's probation deadline (NODE_INTERFACE → Identity Records). It is NOT the
  // invite bar — that is the existence of the row. Committed state, and an
  // always-present field of the record's AVL value encoding.
  //
  // lifetime_likes_received: likes this identity has received, ever. Incremented
  // by per-block like settlement and decremented by nothing — prune deletes
  // like_records and must not reach this column, because a bond settling on a
  // count that a THIRD PARTY can lower would let a pruning author destroy an
  // inviter's stake.
  `CREATE TABLE IF NOT EXISTS identity_records (
    identity_id BLOB PRIMARY KEY,
    last_activity_block INTEGER NOT NULL,
    last_decay_block INTEGER NOT NULL,
    invited_at_block INTEGER NOT NULL DEFAULT 0,
    lifetime_likes_received INTEGER NOT NULL DEFAULT 0
  )`,

  // Like-records (NODE_INTERFACE → "Like-records"): (liker, targetPostId) pairs,
  // written ONLY at block application, never by an HTTP route. Content-layer
  // consensus state (the block_topology tier): deterministic by replay,
  // journalled with exact inverses, not in the stateRoot. Records die with
  // the post on prune and survive withdraw; applied_at_block is the height
  // the like's block settled at.
  `CREATE TABLE IF NOT EXISTS like_records (
    target_post_id TEXT NOT NULL,
    liker_id BLOB NOT NULL,            -- 32-byte Ed25519 public key
    applied_at_block INTEGER NOT NULL,
    PRIMARY KEY (target_post_id, liker_id)
  )`,

  // Mempool (UTXO transaction pool). A database predating a schema change is the
  // operator's to wipe: the node neither versions its store nor refuses to start
  // against an old one (NODE_INTERFACE → No store schema version, and none is
  // owed).
  //
  // The like_/invite_/vouch_ columns are gate metadata (audit M-8): populated by
  // insertUtxoTx from the tx outputs so the correctness gates are plain SQL over
  // every row, not a decode-scan of the first 1000. `tx_fee` and `tx_bytes` are
  // the same principle for the pool's two classes and its ordering
  // (MEMPOOL_INTERFACE → Eviction, inside the credit class only).
  `CREATE TABLE IF NOT EXISTS mempool (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('utxo_tx', 'prune')),
    utxo_tx_bytes BLOB,
    prune_entry_cbor BLOB,
    expires_at_height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    like_target TEXT,
    like_liker TEXT,
    invite_inviter TEXT,
    vouch_voucher TEXT,
    tx_fee INTEGER,
    tx_bytes INTEGER,
    tx_inputs TEXT,
    tx_output_ids TEXT,
    tx_id TEXT,
    prune_entry_id TEXT,
    max_valid_height INTEGER
  )`,

  // System config (persistent node-level keypairs, etc.)
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
  )`,

  // Ordering blocks
  `CREATE TABLE IF NOT EXISTS ordering_blocks (
    height INTEGER PRIMARY KEY,
    header_bytes BLOB NOT NULL,
    utxotx_tree_bytes BLOB NOT NULL,
    validator_signature BLOB NOT NULL,  -- 64 bytes
    created_at INTEGER NOT NULL,
    block_hash TEXT NOT NULL UNIQUE,     -- 64-char lowercase hex, blockHash(header)
    interlinks BLOB NOT NULL            -- encodeInterlinks(vector), NODE_INTERFACE → Ordering blocks
  )`,

  // Block journal (CBOR-encoded undo data per block)
  `CREATE TABLE IF NOT EXISTS block_journal (
    block_height INTEGER PRIMARY KEY,
    journal_cbor BLOB NOT NULL
  )`,

  // Discovered peers — persistence behind net's PeerStorage seam (audit L-14).
  // Shaped to net's PeerRecord, keyed by multiaddr: PeerDb dedupes by address,
  // and a libp2p peerId is freely regenerable so it makes a worthless key.
  `CREATE TABLE IF NOT EXISTS peers (
    address           TEXT PRIMARY KEY,
    last_seen_ms      INTEGER NOT NULL,
    agent_name        TEXT NOT NULL,
    node_name         TEXT NOT NULL,
    protocol_version  INTEGER NOT NULL,
    capabilities      TEXT NOT NULL    -- JSON array of message codes
  )`,

  // Refused headers — the chain-selection memory (NODE_INTERFACE → Refused
  // headers). One row per block whose header passed verification and whose body
  // the apply funnel rejected during a reorg.
  `CREATE TABLE IF NOT EXISTS refused_headers (
    hash        TEXT PRIMARY KEY,
    height      INTEGER NOT NULL,
    refused_at  INTEGER NOT NULL
  )`,
];

function migrateAvlTree(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='avl_tree_versions'")
    .all() as Array<{ name: string }>;
  if (tables.length > 0) return;

  database.exec(`
    CREATE TABLE avl_tree_versions (
      version BLOB PRIMARY KEY,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE avl_tree_nodes (
      version BLOB NOT NULL REFERENCES avl_tree_versions(version),
      label BLOB NOT NULL,
      node_data BLOB NOT NULL,
      PRIMARY KEY (version, label)
    );
  `);
}

function migrateBlockTopology(database: Database.Database): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='block_topology'")
    .all() as Array<{ name: string }>;
  if (tables.length > 0) return;

  database.exec(`
    CREATE TABLE IF NOT EXISTS block_topology (
      post_id TEXT PRIMARY KEY,
      parent_refs TEXT NOT NULL,
      author TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      pruned_at_height INTEGER,
      pruned_root TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_block_topology_height
      ON block_topology(block_height);
    CREATE INDEX IF NOT EXISTS idx_block_topology_pruned
      ON block_topology(pruned_at_height, post_id)
      WHERE pruned_at_height IS NOT NULL;
  `);
}

/**
 * The columns a pooled transaction's own fields are lifted into at insert —
 * `tx_inputs`, the box ids it spends; `tx_output_ids`, the ids of the boxes it
 * creates; and `tx_id`, its own `TxId`. The first two are the pending view the
 * admission path resolves against: confirmed set ∪ pending outputs − pending
 * inputs. The third is how an applied block finds the row it confirmed. Same
 * principle as the like/invite/vouch gate columns above — the queries stay
 * plain SQL over every row rather than a decode-scan of the first N.
 *
 * **The base `CREATE TABLE` is what a fresh database gets; the ALTER pass is
 * what reaches an existing one.** Both are needed and neither is redundant: a
 * column added to the base table alone never reaches an existing database, and
 * one added to the ALTER pass alone leaves a fresh schema that does not
 * describe itself.
 *
 * Each column is guarded on its own, so a database that gained one before the
 * other still gains the one it lacks — and so the pass is a no-op on a fresh
 * database whose base table already declared them.
 *
 * Rows written before a column existed hold NULL, and `json_each` reads NULL as
 * zero rows rather than raising — such an entry matches no conflict query, and
 * serves no pending output. A NULL `tx_id` matches no cleanup either, which
 * leaves the row to expire; the alternative is decoding every legacy blob at
 * startup to backfill an id for a pool that drains within
 * `MEMPOOL_EXPIRY_BLOCKS` anyway.
 */
function migrateMempoolTxColumns(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info('mempool')").all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some(c => c.name === name);

  if (!has('tx_inputs')) database.exec(`ALTER TABLE mempool ADD COLUMN tx_inputs TEXT`);
  if (!has('tx_output_ids')) database.exec(`ALTER TABLE mempool ADD COLUMN tx_output_ids TEXT`);
  if (!has('tx_id')) database.exec(`ALTER TABLE mempool ADD COLUMN tx_id TEXT`);
  // The pool's class and its price. `tx_fee` NULL means karma-side — nothing it
  // could bid — and a number means credit-side, zero included
  // (MEMPOOL_INTERFACE → Eviction, inside the credit class only). A row written
  // before these existed holds NULL for both, so it reads as karma-side and is
  // never evicted; the pool drains within `MEMPOOL_EXPIRY_BLOCKS` regardless.
  if (!has('tx_fee')) database.exec(`ALTER TABLE mempool ADD COLUMN tx_fee INTEGER`);
  if (!has('tx_bytes')) database.exec(`ALTER TABLE mempool ADD COLUMN tx_bytes INTEGER`);
  if (!has('prune_entry_id')) database.exec(`ALTER TABLE mempool ADD COLUMN prune_entry_id TEXT`);
}

/**
 * Partial indexes over the mempool gate-metadata columns (audit M-8). Created
 * after the mempool migrations so they land on whichever CREATE TABLE ran last.
 * A database predating the gate columns fails loudly here at startup rather
 * than silently at the first insert — pre-stable, DB reset acceptable.
 *
 * `idx_mempool_tx_inputs` covers a membership test, not a lookup: a B-tree over
 * the JSON text cannot resolve `json_each(...) WHERE value = ?`. It earns its
 * place as the covering index the scan reads, which is also what confines the
 * scan to rows that carry inputs at all.
 *
 * `idx_mempool_tx_id` is a lookup, and it is the one carrying a measured cost.
 * Block application removes each confirmed transaction through it; matching by
 * recomputed `TxId` over the pool instead measures 27 s per applied block
 * against a full pool where this measures 7.5 ms (2026-08-15). See
 * MEMPOOL_INTERFACE → Confirmed-entry cleanup reaches every row.
 *
 * `idx_mempool_fee_rate` is an **expression** index over the same division the
 * eviction query orders by, and it is the second one with a measured cost. Once
 * the credit class is full every arriving credit transaction compares itself
 * against the cheapest resident, so that query runs per insert on exactly the
 * path a flood takes. Measured 2026-08-15 at `maxMempoolEntries = 10,000` —
 * 10,000 rows, 5,000 of them credit:
 *
 * | query | no index | this index |
 * |---|---|---|
 * | cheapest credit resident (per insert at capacity) | 0.636 ms | **0.001 ms** |
 * | credit-class count (per insert) | 0.302 ms | 0.070 ms |
 * | the fill's ordering pass (per block) | 2.65 ms | **2.29 ms** |
 * | write maintenance | 0.0082 ms/row | 0.0076 ms/row |
 *
 * **The ordering pass is faster with the index and not despite it**, but only
 * because `iterateCreditByRate` declines to order *through* it — see the unary
 * `+` there. Asked to satisfy the ORDER BY as well, the same query measures
 * 2.88 ms: a full-class read pays a random row lookup per entry on a
 * non-covering traversal, and an in-memory sort beats that. Confining the scan
 * to credit rows is the part worth having.
 *
 * **Write maintenance is below measurement resolution** — 3,000 raw inserts and
 * deletes differ by less than the run-to-run spread, and the indexed insert
 * measured marginally *faster*, which is noise rather than an effect. Index
 * cost here is a read-path question only.
 *
 * ⛔ **Two indexes are deliberately absent.** The karma-class count is served by
 * none: a partial index on `tx_fee IS NOT NULL` cannot answer `IS NULL`, and
 * that count measures 0.300 ms with or without any shape — the cost of an
 * unfiltered `COUNT(*)` over the same table, so bounding the pool per class is
 * no dearer than bounding it whole. An index on `tx_fee` alone would take the
 * credit-class count from 0.070 ms to 0.032 ms; at 3.8% of a ~1 ms insert that
 * is below what earns a permanent schema object, and it is not a write-cost
 * argument — write cost was measured and is nil for both.
 */
function migrateDagPostsColumns(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info('dag_posts')").all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some(c => c.name === name);

  if (!has('withdrawn_at_height')) database.exec(`ALTER TABLE dag_posts ADD COLUMN withdrawn_at_height INTEGER`);
}

function migrateBlockTopologyColumns(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info('block_topology')").all() as Array<{ name: string }>;
  const has = (name: string): boolean => cols.some(c => c.name === name);

  if (!has('pruned_at_height')) database.exec(`ALTER TABLE block_topology ADD COLUMN pruned_at_height INTEGER`);
  if (!has('pruned_root')) database.exec(`ALTER TABLE block_topology ADD COLUMN pruned_root TEXT`);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_block_topology_pruned
      ON block_topology(pruned_at_height, post_id)
      WHERE pruned_at_height IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_utxo_boxes_post_lock_target
      ON utxo_boxes(json_extract(extra_data, '$.targetPostId'))
      WHERE box_type = 'post_lock' AND spent_at_block IS NULL;
  `);
}

function createMempoolGateIndexes(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_mempool_like
      ON mempool(like_target, like_liker) WHERE like_target IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_invite
      ON mempool(invite_inviter) WHERE invite_inviter IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_vouch
      ON mempool(vouch_voucher) WHERE vouch_voucher IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_expires
      ON mempool(expires_at_height);
    CREATE INDEX IF NOT EXISTS idx_mempool_tx_inputs
      ON mempool(tx_inputs) WHERE tx_inputs IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_tx_output_ids
      ON mempool(tx_output_ids) WHERE tx_output_ids IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_tx_id
      ON mempool(tx_id) WHERE tx_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_prune_entry_id
      ON mempool(prune_entry_id) WHERE prune_entry_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mempool_fee_rate
      ON mempool(CAST(tx_fee AS REAL) / tx_bytes) WHERE tx_fee IS NOT NULL;
  `);
}

// NODE_INTERFACE → Store Interface → "A page read touches limit + 1 entries of one index"
function createPageIndexes(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_utxo_boxes_owner_type_value
      ON utxo_boxes(owner, box_type, value DESC, id)
      WHERE spent_at_block IS NULL;
    CREATE INDEX IF NOT EXISTS idx_dag_posts_confirmed
      ON dag_posts(block_height, block_index)
      WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS idx_dag_parent_refs_parent
      ON dag_parent_refs(parent_id);
  `);
}

export function initDb(path: string): void {
  // JOURNAL_EVENTS → Phase Timing Events. `db_open_complete` is emitted at the
  // END of this function, not after the last `migrate*` call: the contract puts
  // it after the migrations have run, and the gate indexes are the last pass
  // that has to succeed before the database is usable.
  const startedAt = Date.now();
  emitDbOpenStarted(path);

  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  migrateAvlTree(db);
  migrateBlockTopology(db);
  migrateBlockTopologyColumns(db);
  migrateMempoolTxColumns(db);
  migrateDagPostsColumns(db);
  createMempoolGateIndexes(db);
  createPageIndexes(db);

  emitDbOpenComplete(Date.now() - startedAt);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
