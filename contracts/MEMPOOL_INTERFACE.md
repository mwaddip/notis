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
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    tx_id             TEXT             -- utxo_tx only: the entry's own TxId (confirmed-entry cleanup)
);

CREATE INDEX IF NOT EXISTS idx_mempool_tx_id ON mempool(tx_id) WHERE tx_id IS NOT NULL;
```

No separate `id` column — the SQLite `rowid` is the canonical identifier for
entries.

**`tx_id` is written at insert from the `computeTxId` `insertUtxoTx` already performs**, so it costs
no additional hash. It exists because cleanup has to find an entry *by transaction identity* when a
peer's block confirms it, and a scan that recomputes the id per candidate is the cost measured under
*Confirmed-entry cleanup* below. The index is **partial** — non-`utxo_tx` rows carry `NULL` and are
not indexed.

⚠ **Rows written before the column existed carry `NULL` and no cleanup matches them.** They leave the
pool by `purgeExpired` at their expiry height, which is the same path an unconfirmed entry always
took.

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
the SQLite `rowid`. Throws `MempoolFullError` at the size cap, and
**`TxTooLargeError` when the encoding exceeds `MAX_TX_BYTES`.**

⛔ **The size bound lives here because this is the only door.** Every submission route reaches the
pool through this function, and it already computes `encodeTx(tx)` — so one check covers them all
and costs no extra encoding. A rule per route is a rule someone adds a route without.

**It is node's own admission gate, not a restatement of validation's.**
`@dagsocial/validation`'s `verifyTxStructure` carries the same bound but runs only on net's gossip
path — **node calls it zero times** — so without this a transaction above `MAX_TX_BYTES` submitted to
this node's HTTP API would be pooled, mined, and then refused by this node's *own*
`verifyOrderingBlockStructure` at apply. A self-rejecting block, recovered at the cost of one block
by `finalizeBlock`'s eviction.

⚠ **Reorg re-insertion must not let this throw escape.** `fork-resolution` re-inserts reverted
transactions inside the chain-switch SQLite transaction, where an escaping error rolls back the
switch and strands the node on the lighter chain. `TxTooLargeError` is dropped and logged there, as
`MempoolFullError` already is. A transaction that rode in a block cannot exceed the bound — validation
refuses those — so the path should never trip it, and it is defended anyway.

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
getPendingEntries(limit: number, afterRowid?: number): PoolEntry[]
```

Returns pending entries in FIFO order (`ORDER BY rowid ASC`), up to `limit`,
starting after `afterRowid` (default `0` — from the beginning). All entries are
returned — `subblock`, `utxo_tx`, and `prune` types. The caller (block creator)
is responsible for decoding and organizing entries by type and batch.

Entries are NOT filtered by expiry here — the caller calls `purgeExpired`
first before fetching.

**`afterRowid` is a keyset cursor, not an offset**, so paging stays `O(page)` as the pool deepens
rather than re-walking what it already returned.

### iteratePendingEntries

```
iteratePendingEntries(): Generator<PoolEntry>
```

Pages through the whole pool in FIFO order via the `getPendingEntries` cursor, yielding one entry at
a time. **This is what a byte budget requires**: a caller filling to a byte target cannot know in
advance how many rows it needs, because entry sizes vary by more than 6× (a like against a max-size
post transaction). A generator lets the creator stop the moment the budget is spent, without either
over-fetching the pool or guessing a `LIMIT`.

### removeUtxoTxEntry

```
removeUtxoTxEntry(txId: string): number
```

Deletes the `utxo_tx` entry whose `tx_id` matches, returning the rows deleted. **The indexed lookup
that confirmed-entry cleanup runs** when a block arrives from a peer — see below for why a scan is
not an option.

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

⛔ **A SQL `LIMIT` does not express a byte budget.** The two do not correspond: 2 MB of body is
roughly 2,026 max-size post transactions but roughly 4,264 likes, against a pool that holds up to
`MAX_MEMPOOL_ENTRIES`. The creator therefore pages with `iteratePendingEntries` and stops when the
budget is spent — **a large fixed count is not a substitute.** An under-fetch produces short blocks
while every test still passes and every block still validates, which is the failure mode that reads
as working software.

**The budget is not spent in SQL, and that is deliberate.** A query can weigh
`length(utxo_tx_cbor)` and nothing else — not the 32-byte `utxoTxIds` entry, not the `lp` prefix, not
the four array count prefixes, not the reserve. Budgeting there would need a padding constant, which
is the arbitrary number moved one level down where no test can see it.

**How the accumulator and the authoritative measure reconcile:**

- Per-entry cost is **exact**: `utxoTxTreeByteLength` of a one-entry body minus an empty one, so the
  framing arithmetic stays in the encoder's mirror and is never restated here.
- The running total is blind to **one** thing: the two array count prefixes widen as the counts grow,
  under-counting by `2 × (vlqU(k) − 1)` — **at most 6 bytes** across the whole body.
- The creator then measures the assembled tree with `utxoTxTreeByteLength` and pops from the tail
  while it exceeds the budget. Minimum entry cost is 34 bytes, so that loop runs **at most once**.

⛔ **The sizer has the last word, so no body exceeds the budget.** An accumulator that is nearly right
plus a final exact measurement is a different guarantee from an accumulator trusted outright.

The budget is spent in this order: `pruneEntries` and `coinbaseOutputs` first — both mandatory, and
neither the miner's to trim — then transactions with what remains.

### Confirmed-entry cleanup reaches every row, and it is a lookup rather than a scan

**Two paths clear a confirmed entry.** A block this node produced is cleaned by rowid
(`confirmedRowids`, step 5), which reaches every included entry wherever it sits. A block arriving
**from a peer** is cleaned by `removeUtxoTxEntry(txId)` — an indexed delete on `tx_id`.

**The rule is that cleanup reaches every row**, whatever its depth. An entry left behind holds a
slot, and the creator later rebuilds it into a block that apply refuses as inapplicable; the chain
recovers, because `finalizeBlock` evicts the row even on rejection, so the cost is one wasted block
rather than a stall — and it is invisible until the pool is deeper than whatever bound was missed.

⛔ **A scan cannot satisfy that rule at any bound, and the numbers are why.** Cleanup by scanning
decodes candidate entries and recomputes a `TxId` per candidate, once per applied transaction, so it
is `O(applied × scanned)` with a blake2b inside. Measured 2026-08-15 through the real store, pool of
10,000 entries at 975 B each:

| Mechanism | Per applied block |
|---|---|
| Scan bounded at 1,000, `K = 1000` applied | **6.4 s** |
| Scan bounded at `MAX_MEMPOOL_ENTRIES`, `K = 2026` | **27.4 s** |
| Indexed delete on `tx_id`, `K = 2026` | **7.5 ms** |

27.4 s is a third of a 60 s block interval and a liveness failure during back-to-back sync — so
raising a scan bound to cover the pool trades a completeness gap for a worse one. The index is the
root cause fixed rather than the symptom bounded, and it is the same shape as the *Correctness gates*
above, which are SQL over indexed metadata columns for exactly this reason.

⚠ **A fill budget and a cleanup bound that happen to be equal are not the same rule.** While both
were `1000`, no block could confirm an entry the cleanup could not see, which made the gap
unreachable rather than absent. A byte budget drains 2,026–4,264 rows and breaks that coincidence.

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

### Eviction, inside the credit class only

The pool is capped **per class**. Credit entries occupy at most
`MEMPOOL_CREDIT_SHARE_PCT` of `maxMempoolEntries`; karma-side entries hold the
rest. When the credit class is full, an arriving transaction bidding above its
cheapest resident **displaces** that resident; one bidding below is rejected.
The karma-side class rejects at its cap and never evicts.

**Fee-ordered eviction over a single pool would be worse than none.** Every
karma-side operation bids zero — posts, likes, invites, vouches — so paying
traffic would evict all of them, and the coinbase's inclusion bonus
(MINING_INTERFACE → Coinbase Application) would then pay for work that could no
longer reach the pool at all. The class boundary is what keeps the bonus
reachable.

`purgeExpired` still reclaims space every block, so a full pool also drains on
its own as entries expire or confirm.

### Fee floor

A node refuses a credit transaction whose fee rate — the value of its `FeeBox` output in
base units per **in-block byte** — falls below `MIN_FEE_RATE_PER_BYTE`. This is **relay
policy, not consensus**: a transaction carrying no fee box is valid and a miner may mine one.

⛔ **A bid is read from the transaction's own bytes and resolves nothing.** The fee is a
`FeeBox` output (TYPES_INTERFACE → FeeBox), so a node prices an entry exactly whether or not
it has ever seen the inputs — the same standing the class already has, since
`outputs.every(…)` decides that from the same bytes. **There is no unpriceable credit
entry**, and no state a node must hold before it can order its own pool.

⚠ **The denominator is the in-block cost, not the bare encoded length.** A
transaction occupies its length-prefixed body *and* its fixed-width `utxoTxIds`
entry, and the block budget spends both — so that is the resource a bid is
measured against. An operator computing a floor from the encoded size alone
arrives at a number stricter than they intended, because the real denominator is
larger.

⛔ **The floor sits above `insertUtxoTx`, never inside it.** The reorg caller
re-inserts transactions the chain has already accepted, and an operator raises
the floor precisely under load — applied at the store, the floor would
permanently drop confirmed history. Re-insertion bypasses it.

### No replacement semantics

Entries are never replaced or updated. If a user submits a new operation that
supersedes an old one (e.g., cancel an invite), the old entry still exists in
the pool. The block creator processes entries in FIFO order — if the cancel
arrives after the invite, both are in the pool and the cancel will fail at
apply time (invite already consumed). This is acceptable for now; replacement
semantics (RBF) require fees and are deferred.

### Ordering — FIFO in the karma class, fee rate in the credit class

Karma-side entries are ordered by `rowid ASC` (insertion order): nothing bids, so
there is no basis for prioritization beyond arrival time. Credit entries are
ordered by descending fee rate.

**The block creator offers the byte budget to karma-side entries first**, then
fills the remainder with credit entries in rate order. That is a node's assembly
preference and no validator enforces it — a miner who fills credits first
forfeits the coinbase's inclusion bonus, which is what makes the order rational
rather than a rule.

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
- FIFO ordering within the karma-side class; fee-rate ordering within the credit
  class
- Size-capped **per class**. The karma-side class rejects at its cap
  (`MempoolFullError` → 503); the credit class displaces its cheapest resident
  for a higher bidder and rejects a lower one. **No replacement** on either
- Mempool is a node-local data structure — it is NOT gossiped
