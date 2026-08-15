# MEMPOOL Interface Contract

**Component:** `@dagsocial/node` (store subsystem)
**Protocol version:** 1
**Last updated:** 2026-07-29

## Scope

The mempool is a unified pending-entry queue for all state-changing operations.
Nothing applies UTXO state immediately — every mutation is queued as a pool
entry, included in an ordering block, and applied atomically when the block
lands. The mempool is a store subsystem, not a separate process or package.

Located at `packages/node/src/store/mempool.ts`. Replaces the old `sub_blocks`
table (removed).

---

## Schema

Single SQLite table:

```sql
CREATE TABLE mempool (
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('subblock', 'utxo_tx', 'prune')),
    subblock_cbor     BLOB,            -- CBOR-encoded SubBlock (null for non-subblock)
    utxo_tx_cbor      BLOB,            -- CBOR-encoded UtxoTransaction (null for non-utxo_tx)
    prune_entry_cbor  BLOB,            -- CBOR-encoded PruneEntry (null for non-prune)
    batch_id          TEXT,            -- Links sub-block + UTXO payloads from same operation
    expires_at_height INTEGER NOT NULL, -- Block height after which entry is purged
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

No separate `id` column — the SQLite `rowid` is the canonical identifier for
entries.

### PoolEntry (in-memory representation)

```typescript
> **The mempool holds one entry type: transactions.** A post is a transaction, so
> the post/lock pair that `batch_id` existed to regroup is a single object and the
> column goes with it. Elsewhere in this file the mempool is described as storing
> sub-block CBOR — it never did; the column was `subblock_id TEXT` and content
> lived in the DAG store. **Where those descriptions conflict with this interface,
> this wins.**

interface PoolEntry {
  rowid: number;
  entryType: 'subblock' | 'utxo_tx' | 'prune';
  subblockId: string | null;      // postId — sub-block content lives in the DAG store
  utxoTxCbor: Uint8Array | null;
  pruneEntryCbor: Uint8Array | null;
  batchId: string | null;
  expiresAtHeight: number;
  createdAt: string;
}
```

Entries are decoded from CBOR on read by the consumer (block creator or relay
handler). The store does not decode payloads on read; on **insert** of a
`utxo_tx` it walks the (already-decoded) transaction's outputs once to
populate the gate-metadata columns below — the single chokepoint every
insertion path (HTTP routes and gossip relay alike) goes through, which is
what makes the correctness gates unable to miss an entry (audit M-8).

### Gate metadata columns

Nullable, populated by `insertUtxoTx` from the transaction outputs, indexed
(partial indexes over non-null values):

| Column | Populated when the tx has | Value |
|---|---|---|
| `like_target` | `likeTarget` set (P2-D — the like tx field, not a box) | `likeTarget` (hex) |
| `like_liker` | `likeTarget` set AND `tx.signatures` has exactly one key | that key (hex). **Any other key count → NULL** — an unpaired row matches no `hasPendingLike` query. First-key-wins was rejected: a spare signature could pin a victim's `(liker, target)` pair and DoS their like at the gateway |
| `invite_inviter` | an `invite` output | `inviterId` (hex) |
| `vouch_voucher` | a `vouch` output | `voucherId` (hex) |

---

## API Surface

### insertMempoolSubBlock

```
insertMempoolSubBlock(sb: SubBlock, expiresAtHeight: number, batchId?: string | null): number
```

Encodes the sub-block as CBOR and inserts a `subblock` entry. Returns the
SQLite `rowid` of the new row.

- `batchId` is optional. When set (e.g., to `postId`), links this sub-block
  to UTXO transactions in the same batch.
- `expiresAtHeight` is typically `currentHeight + 720` (~12h at 60s blocks).

### insertUtxoTx

```
insertUtxoTx(tx: UtxoTransaction, batchId: string | null, expiresAtHeight: number): number
```

Encodes the UTXO transaction as CBOR and inserts a `utxo_tx` entry, populating
the gate-metadata columns from the transaction's outputs (see above). Returns
the SQLite `rowid`. Throws `MempoolFullError` at the size cap.

- `batchId` is null for standalone transactions (likes, invites, faucet).
  Set to a post ID for batch-linked transactions (karma-lock on post creation).
- `expiresAtHeight` is the block height at which the entry becomes invalid.

### Correctness gates (audit M-8)

```
hasPendingLike(targetPostId: string, likerId: string): boolean
countPendingInvites(inviterId: string): number
hasPendingVouch(voucherId: string): boolean
```

SQL `EXISTS`/`COUNT` over the gate-metadata columns — never a bounded scan.
The previous implementation decoded `getPendingEntries(1000)` per request, so
any entry past row 1000 was silently invisible to the duplicate-like and
`MAX_PENDING_INVITES` checks. These gates see every row regardless of pool
size. Hex parameters compare against the columns exactly as stored.

### removeSubBlockEntries

```
removeSubBlockEntries(postIds: string[]): number
```

Deletes `subblock` entries whose `subblock_id` is in `postIds`; returns the
count. Used by block application to clear confirmed sub-blocks — replaces the
former fetch-1000-and-find loop, which stopped removing entries past row 1000
(bookkeeping only; no consensus behavior change).

### insertMempoolPrune

```
insertMempoolPrune(entry: PruneEntry, expiresAtHeight: number): number
```

Encodes the PruneEntry as CBOR and inserts a `prune` entry. Returns the
SQLite `rowid`.

### drainMempoolPrunes

```
drainMempoolPrunes(limit: number): PruneEntry[]
```

Decodes and returns prune entries in FIFO order (`ORDER BY rowid ASC`), up
to `limit`. Returns decoded PruneEntry objects (not raw CBOR).

### removeMempoolPrunes

```
removeMempoolPrunes(entryIds: string[]): void
```

Deletes prune entries by rowid. Called during block finalization for each
confirmed prune entry.

### getPendingEntries

```
getPendingEntries(limit: number): PoolEntry[]
```

Returns pending entries in FIFO order (`ORDER BY rowid ASC`), up to `limit`.
All entries are returned — `subblock`, `utxo_tx`, and `prune` types. The caller
(block creator) is responsible for decoding and organizing entries by type
and batch.

Entries are NOT filtered by expiry here — the caller calls `purgeExpired`
first before fetching.

### purgeExpired

```
purgeExpired(currentHeight: number): number
```

Deletes all entries where `expires_at_height < currentHeight`. Returns the
number of deleted rows.

Called at the start of block creation, before `getPendingEntries`. Ensures
expired entries never make it into a block.

### removeEntry

```
removeEntry(rowid: number): void
```

Deletes a single entry by rowid. Called during block finalization for each
confirmed entry. The block creator tracks which rowids were included in the
block and removes them after the block is stored.

Batch cleanup happens through `removeEntry` per rowid.

---

## Lifecycle

```
                   ┌──────────────┐
                   │  API Route   │
                   │  (POST /posts,│
                   │   /likes,     │
                   │   /invites,   │
                   │   /faucet)    │
                   └──────┬───────┘
                          │ insertMempoolSubBlock / insertUtxoTx
                          ▼
                   ┌──────────────┐
                   │   Mempool    │  ← entries sit here, unconfirmed
                   │  (SQLite)    │
                   └──────┬───────┘
                          │
            ┌─────────────┼─────────────┐
            │             │             │
            ▼             ▼             ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │  Timer   │ │  Sub-blk │ │ External │
      │  fires   │ │  counter │ │  miner   │
      │ (60s)    │ │ >= min   │ │ submits  │
      └────┬─────┘ └────┬─────┘ └────┬─────┘
           │            │            │
           └────────────┼────────────┘
                        │ createOrderingBlock()
                        ▼
                 ┌──────────────┐
                 │ 1. purgeExpired │
                 │ 2. getPending   │
                 │ 3. Assemble     │
                 │    block        │
                 │ 4. Mine / sign  │
                 └──────┬───────┘
                        │ finalizeBlock()
                        ▼
                 ┌──────────────┐
                 │ 1. Store block│
                 │ 2. Apply UTXO │
                 │ 3. Confirm    │
                 │    posts      │
                 │ 4. removeEntry│
                 │    per rowid  │
                 └──────────────┘
```

### Entry states

| State | How entered | How exited |
|-------|------------|------------|
| **Pending** | `insertMempoolSubBlock` / `insertUtxoTx` | Included in block → `removeEntry`; or `purgeExpired` |
| **Confirmed** | Block finalization (`removeEntry`) | Gone from mempool; state now in ledger |
| **Expired** | `purgeExpired` during block assembly | Gone from mempool; state never applied |

### Expiry

- **TTL:** 720 blocks (~12h at 60s block time)
- **Expiry check:** at block assembly time (`purgeExpired`), not on a timer
- **Expired entries** are silently dropped — the API already returned
  `{ status: "pending" }` to the client; the client should re-submit if their
  operation times out

---

## Batch Linking

Operations that produce multiple pool entries (sub-block + UTXO payloads) are
linked via `batch_id`. This ensures the block creator processes them atomically.

### Current batch-linked operations

| Operation | Sub-block | UTXO payloads | batch_id |
|-----------|-----------|---------------|----------|
| `POST /posts` | 1 sub-block | 1 karma-lock tx | `postId` |

The block creator resolves batches during assembly: for each batch_id, it
includes the sub-block and all linked UTXO entries in the same block.

### Standalone (non-batched) operations

| Operation | Pool entry type | batch_id |
|-----------|----------------|----------|
| `POST /likes` (locked) | `utxo_tx` | null |
| `POST /likes/remove` | `utxo_tx` | null |
| `POST /invites` | `utxo_tx` | null |
| `POST /invites/claim` | `utxo_tx` | null |
| `POST /invites/cancel` | `utxo_tx` | null |
| `POST /faucet` | `utxo_tx` | null |
| Relay: inbound sub-block | `subblock` | null |
| Relay: inbound UTXO tx | `utxo_tx` | null |

---

## Block Creator Integration

The block creator (`services/block-creator.ts`) is the sole consumer of
pending entries:

1. Calls `purgeExpired(currentHeight)` — drops stale entries
2. Draws pending entries in FIFO order and fills up to `BLOCK_BODY_BUDGET_BYTES`
3. Separates entries by `entryType`:
   - `subblock` entries → decoded, included as `subBlockRefs`
   - `utxo_tx` entries with `batch_id = null` → either attached to matching
     sub-blocks (likes by targetPostId) or listed as standalone `utxoTxIds`
   - `utxo_tx` entries with `batch_id ≠ null` → resolved against their batch's
     sub-block, included as `utxoTxIds`
   - `prune` entries → decoded via `drainMempoolPrunes`, included as
     `pruneEntries`
4. Tracks `confirmedRowids` (set of rowids included in the block)
5. After block finalization: `removeEntry(rowid)` for each confirmed rowid,
   `removeMempoolPrunes(entryIds)` for confirmed prune entries

### The fill budget is bytes; `getPendingEntries` is a count

⛔ **`getPendingEntries(limit)` is a SQL `LIMIT` and does not express a byte budget.** The two do not
correspond: 2 MB of body is roughly 2,030 max-size post transactions but roughly 4,283 likes, against
a pool that holds up to `MAX_MEMPOOL_ENTRIES`. Step 2 must therefore page, or take a byte-aware
query — **a large fixed count is not a substitute.** An under-fetch produces short blocks while every
test still passes and every block still validates, which is the failure mode that reads as working
software.

The budget is spent in this order: `pruneEntries` and `coinbaseOutputs` first — both mandatory, and
neither the miner's to trim — then transactions with what remains.

### Confirmed-entry cleanup is bounded by the pool, not by a literal

**Two paths clear a confirmed entry, and only one of them is complete.** A block this node produced is
cleaned by rowid (`confirmedRowids`, step 5), which reaches every included entry wherever it sits. A
block arriving **from a peer** is cleaned by block application scanning pending entries and matching
recomputed `TxId`s — and that scan's bound is what decides whether the cleanup is total.

⛔ **The scan bound must not be a literal.** Bounded below `MAX_MEMPOOL_ENTRIES`, a confirmed
transaction sitting past it is never removed: it holds a slot, the creator later rebuilds it into a
block, and apply rejects that block because the transaction can no longer be applied. The chain
recovers — `finalizeBlock` evicts the row even on rejection — so the cost is one wasted block rather
than a stall, and it is invisible until the pool is deeper than the bound.

⚠ **A fill budget and a scan bound that happen to be equal are not the same rule**, and this is what
made the defect unreachable rather than absent: while both were `1000`, no block could confirm an
entry the scan could not see. A byte budget breaks that coincidence — it drains 2,030–4,283 rows —
so the scan must be bounded by the pool's own capacity rather than by a number that used to match.

### ~~Like attachment during assembly~~ — DELETED (P2-D)

There is no like attachment, no sidecar array and no standalone `likeBoxId` pool. A like
transaction (`likeTarget` set) is an ordinary mempool UTXO entry pulled into `utxoTxIds`
like every other transaction.

---

## Relay Integration

Inbound relay handlers insert into the mempool rather than applying state:

- **`onSubBlock(sb)`**: validate (read-only) → `insertMempoolSubBlock(sb, expiresAtHeight)`
- **`onTx(tx)`**: `validateTx` (read-only) → `insertUtxoTx(tx, null, expiresAtHeight)`

State is applied later when an ordering block containing these entries is
received and applied.

### Relay: ordering block application

When an ordering block is received from gossip:

1. Full validation (structure, chain-link, PoW, signature)
2. For each `utxoTxId`: decode from mempool or reconstruct, call
   `revalidateTxInContext` (liveness only), then `applyTx`
3. Confirm sub-blocks and their posts
4. Remove confirmed entries from mempool

---

## Design Decisions

### Size cap — reject, never evict (audit M-8)

The pool holds at most `MAX_MEMPOOL_ENTRIES` rows (config, default 10000)
across all entry types. Every insert function checks the count and throws a
typed `MempoolFullError` at the cap. An unbounded pool was a disk-DoS lever
(trivially via `/faucet` flood).

Three insert callers, three behaviors:

| Caller | At the cap |
|---|---|
| HTTP routes | **503** with a generic body (`{ error: 'mempool full' }`) |
| Gossip relay (`onTx` / `onSubBlock`) | drop the entry, log, never throw |
| **Reorg re-insertion** (`services/fork-resolution.ts`) | drop, log, continue |

The reorg caller is not optional politeness: re-insertion of reverted
txs/sub-blocks/prunes runs *inside* the chain-switch SQLite transaction, so an
escaping `MempoolFullError` would roll back the switch and strand the node on
the lighter chain — mempool pressure escalated into a consensus-liveness
failure.

Rejection, not eviction: eviction needs fee-based prioritization to decide
*what* to evict, and there are no fees yet — that remains deferred to the fee
market. `purgeExpired` still reclaims space every block, so a full pool
drains on its own as entries expire or confirm.

### No replacement semantics

Entries are never replaced or updated. If a user submits a new operation that
supersedes an old one (e.g., cancel an invite), the old entry still exists in
the pool. The block creator processes entries in FIFO order — if the cancel
arrives after the invite, both are in the pool and the cancel will fail at
apply time (invite already consumed). This is acceptable for now; replacement
semantics (RBF) require fees and are deferred.

### FIFO ordering

Entries are ordered by `rowid ASC` (insertion order). No priority queue.
Without fees, there's no basis for prioritization beyond arrival time.

### CBOR storage

Entries are stored as CBOR blobs rather than parsed columns. This avoids
double-parsing (CBOR on wire → JSON for SQLite → CBOR for broadcast) and
keeps the mempool schema agnostic to entry structure. The block creator
decodes CBOR when assembling blocks.

### No separate tables

A single table with a type discriminator rather than separate `sub_blocks`
and `utxo_txs` tables. This gives unified FIFO ordering, simpler expiry,
and simpler batch resolution (shared `batch_id` column). The old `sub_blocks`
table was removed during the mempool migration.

---

## Invariants

- All state mutations flow through the mempool — no direct `consumeBox` or
  `insertBox` calls in HTTP routes or relay handlers
- Mempool entries are CBOR blobs — the store layer does not parse them
- Expiry is checked at block assembly time, not on a background timer
- Batch-linked entries share a `batch_id` and are included atomically in
  the same ordering block
- Confirmed entries are removed by rowid after block finalization
- FIFO ordering (by insertion) — no priority, no reordering
- Size-capped with rejection (`MempoolFullError` → 503); no replacement, no
  fee-based eviction
- Mempool is a node-local data structure — it is NOT gossiped
