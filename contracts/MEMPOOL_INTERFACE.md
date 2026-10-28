# MEMPOOL Interface Contract

**Component:** `@dagsocial/node` (store subsystem)
**Protocol version:** 1
**Last updated:** 2026-08-24

## Scope

The mempool is a unified pending-entry queue for all state-changing operations.
Nothing applies UTXO state immediately — every mutation is queued as a pool
entry, included in an ordering block, and applied atomically when the block
lands. The mempool is a store subsystem, not a separate process or package.

Located at `packages/node/src/store/mempool.ts`.

---

## Schema

Single SQLite table:

```sql
CREATE TABLE mempool (
    rowid             INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('utxo_tx')),
    utxo_tx_bytes     BLOB,            -- positional encodeTx bytes
    expires_at_height INTEGER NOT NULL, -- Block height after which entry is purged
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    like_target TEXT, like_liker TEXT,          -- gate metadata (below)
    invite_inviter TEXT, invite_invitee TEXT,   -- gate metadata (below)
    vouch_voucher TEXT, vouch_target TEXT,      -- gate metadata (below)
    tx_fee INTEGER, tx_bytes INTEGER,           -- fee-class metadata (§Eviction)
    max_valid_height INTEGER,                   -- utxo_tx only: validity ceiling, NULL = none (§Validity ceiling)
    tx_id TEXT,                                 -- the entry's own TxId (confirmed-entry cleanup)
    username_lower TEXT, username_claimant TEXT, -- claim-gate metadata (below)
    karma_owner TEXT, karma_spend INTEGER,      -- spend-gate metadata (below)
    withdraw_post TEXT,                         -- gate metadata (below)
    cost_estimate INTEGER                       -- the cost gate's marginal cost (§The cost gate); NULL uncosted
);

CREATE INDEX IF NOT EXISTS idx_mempool_tx_id ON mempool(tx_id) WHERE tx_id IS NOT NULL;

-- An entry's inputs, and the ids of the boxes it would create: one row a box.
CREATE TABLE mempool_inputs (
    box_id      TEXT PRIMARY KEY,
    entry_rowid INTEGER NOT NULL REFERENCES mempool(rowid) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE mempool_outputs (
    box_id      TEXT PRIMARY KEY,
    entry_rowid INTEGER NOT NULL REFERENCES mempool(rowid) ON DELETE CASCADE,
    owner       BLOB,              -- the box's owner, 32 bytes; NULL for a type that has none
    box_type    TEXT NOT NULL,     -- the box's type, as utxo_boxes names it
    value       INTEGER NOT NULL   -- the box's value
) WITHOUT ROWID;
CREATE INDEX idx_mempool_inputs_entry  ON mempool_inputs(entry_rowid);
CREATE INDEX idx_mempool_outputs_entry ON mempool_outputs(entry_rowid);
CREATE INDEX idx_mempool_outputs_owner ON mempool_outputs(owner, box_type, value DESC, box_id)
    WHERE owner IS NOT NULL;
```

The SQLite `rowid` is the canonical identifier for entries.

**An entry's inputs and outputs are rows keyed by box id**, written by `insertUtxoTx` in the transaction that writes
the entry; the output ids come from `materializeOutput`, the call block application makes. The pending view and the
conflict gate are point reads on them (→ getBoxWithPending). SQLite indexes no member of a JSON array, so a box id kept
in a column of the entry's own row is found only by reading every row: 311 inputs checked that way measured 644 ms
at a pool of 10 000, and 0.15 ms against `mempool_inputs` (2026-10-21). **One pending spender per box is the input
table's key**: the conflict gate refuses a second spender before the insert, with its 409 naming the box, and the key
holds the rule on any path that reaches the insert. An output id is a function of its transaction and position, and
the engine refuses a transaction that spends no input (`NODE_INTERFACE → validateTx`), so a second entry naming a pooled
output is that transaction again, which its inputs refuse first. **The rows leave with their entry on every path** —
confirmation, expiry, eviction, removal — by `ON DELETE CASCADE`, which holds because `initDb` turns foreign keys on;
the `entry_rowid` indexes are what the cascade and a per-entry read find them by.

**An output row carries its box's owner, type and value**, written from the box `materializeOutput` returns, so the
pending view asked by owner is a range of the owner index, and decodes the entries of the rows a page answers and no
other (→ getBoxesPageWithPending).

**`tx_id` is written at insert from the id `insertUtxoTx` is handed** (→ insertUtxoTx), so it costs
no hash of its own. It exists because cleanup has to find an entry *by transaction identity* when a
peer's block confirms it, and a scan that recomputes the id per candidate is the cost measured under
*Confirmed-entry cleanup* below. The index is **partial** — a row without a `tx_id` is not indexed.

⚠ **Rows written before the column existed carry `NULL` and no cleanup matches them.** They leave the
pool by expiry (→ What takes an entry out of the pool), the path every entry that does not confirm can
take.

⛔ **A WITHDRAWAL IS AN ORDINARY `utxo_tx` ROW.** It is a karma transaction carrying a
`UtxoTransaction.postWithdraw` payload (`NODE_INTERFACE` → Withdrawal transactions), so it is admitted,
priced, evicted, confirmed-cleaned and expired by exactly the paths above. **Its dedup is its
spent inputs** — a pooled withdrawal cannot be duplicated because its boxes are gone — so it needs no
id column of its own.

### PoolEntry (in-memory representation)

```typescript
interface PoolEntry {
  rowid: number;
  entryType: 'utxo_tx';
  utxoTxBytes: Uint8Array | null;
  expiresAtHeight: number;
  createdAt: string;
  costEstimate: number | null;
}
```

`costEstimate` is the row's `cost_estimate` — the estimate the creator packs by (→ The cost gate), `null` where
nothing has costed the row.

**One member, and the discriminator is kept rather than removed** — a second entry kind would
have to widen it, which is a compiler signal a bare row shape would not give. The payload is
decoded (`decodeTx`) on read by the
consumer (block creator or relay handler). The store does not decode payloads
on read; on **insert** of a
`utxo_tx` it walks the (already-decoded) transaction's outputs once to
populate the gate-metadata columns below — the single chokepoint every
insertion path (HTTP routes and gossip relay alike) goes through, which is
what makes the correctness gates unable to miss an entry (→ Correctness gates).

### Gate metadata columns

Nullable, populated by `insertUtxoTx` from the transaction outputs, indexed
(partial indexes over non-null values):

| Column | Populated when the tx has | Value |
|---|---|---|
| `like_target` | `likeTarget` set (the like tx field, not a box) | `likeTarget` (hex) |
| `like_liker` | `likeTarget` set AND `tx.signatures` has exactly one key | that key (hex). **Any other key count → NULL** — an unpaired row matches no `hasPendingLike` query. First-key-wins was rejected: a spare signature could pin a victim's `(liker, target)` pair and DoS their like at the gateway |
| `invite_inviter` | a `bond` output | `inviterId` (hex) — **the bond is what names an inviter**, one transaction per invite |
| `invite_invitee` | a `bond` output | `inviteePublicKey` (hex) — `hasPendingInvitee` keys on it |
| `vouch_voucher` | a `vouch` output | `voucherId` (hex) |
| `vouch_target` | a `vouch` output | `targetId` (hex) — `hasPendingVouch` keys on the pair |
| `username_lower` | a `username` output — a claim | the name's canonical form, the byte-wise ASCII lowercase (`TYPES_INTERFACE` → Content limits) |
| `username_claimant` | a `username` output — a claim | its `owner` (hex) |
| `withdraw_post` | `postWithdraw` set | `postWithdraw.postId` (hex) — `hasPendingWithdraw` keys on it |
| `karma_owner` | a `karma` output, or an output of type `karma_price`, `like_accrual`, `bond` or `vouch` — a karma transaction, whether or not it spends (`NODE_INTERFACE` → Karma transition rules) — AND `tx.signatures` has exactly one key | that key (hex) — the karma inputs' owner, the one key `validateTx` admits in a karma transaction's map. **Any other key count → NULL**, as `like_liker`. A consolidation, a claim and a withdrawal write it too: each moves the owner's own box, and the reads by owner find the row by it (→ getOwnKarmaBoxIdsWithPending; → The fill budget is bytes → "An entry whose owner owes decay adds the squaring") |
| `karma_spend` | an output of type `karma_price`, `like_accrual`, `bond` or `vouch` AND exactly one signature key | the summed value of those outputs — the transaction's spend; NULL for a karma transaction that spends nothing |

---

## API Surface

### insertUtxoTx

```
insertUtxoTx(tx: UtxoTransaction, txId: TxId, expiresAtHeight: number, costEstimate?: number | null): number
```

**`txId` is `computeTxId(tx)` as its caller computed it, and the insert hashes nothing.** Admission hands the id it
looked the pool up by (→ getHeldEntry); a switch's re-insertion hands the id the reverted block declared, which its
application held to the bytes. The row is keyed by it and its outputs' box ids derive from it (→ Schema).

Encodes the UTXO transaction (`encodeTx`) and inserts a `utxo_tx` entry, populating
the gate-metadata columns from the transaction's outputs (see above). Returns
the SQLite `rowid`. Throws `MempoolFullError` at the size cap, and
**`TxTooLargeError` when the encoding exceeds `MAX_TX_BYTES`.**

⛔ **The size bound lives here because this is the only door.** Every submission route reaches the
pool through this function, and it already computes `encodeTx(tx)` — so one check covers them all
and costs no extra encoding. A rule per route is a rule someone adds a route without.

**It is the pool's own bound, not a restatement of validation's.** `@dagsocial/validation`'s
`verifyTxStructure` carries the same bound and runs where a stranger's transaction arrives — net's gossip validator,
and node's HTTP edge, which answers an oversize request 413 before any check that costs (`NODE_INTERFACE → HTTP API →
"A write request's transaction is checked whole before anything reads it"`). The reorg re-insertion arrives by
neither, and this check is the one every insert passes whichever way it came: a transaction above `MAX_TX_BYTES` in
the pool would be mined into a block this node's *own* `verifyOrderingBlockStructure` refuses at apply — a
self-rejecting block, recovered at the cost of one block by `submitMinedBlock`'s eviction.

⚠ **Reorg re-insertion must not let this throw escape.** `fork-resolution` re-inserts reverted
transactions inside the chain-switch SQLite transaction, where an escaping error rolls back the
switch and strands the node on the lighter chain. `TxTooLargeError` is dropped and logged there, as
`MempoolFullError` already is. A transaction that rode in a block cannot exceed the bound — validation
refuses those — so the path should never trip it, and it is defended anyway.

**The conflict gate runs before the capacity gate.** An arrival spending a box a pooled entry spends is refused
(`PendingSpendConflictError`, 409) before it can displace anything: a full credit class would otherwise evict its
cheapest resident for an arrival that is then refused — or, where that resident is the conflicting entry itself,
replace it, which this pool never does (→ No replacement semantics). The relay reaches the gate with such an
arrival, since it validates against the confirmed set alone (→ getBoxWithPending). Admission asks both gates first, and
writes nothing then (→ assertPoolAdmits).

**One SQLite transaction.** The eviction a full credit class makes, the entry's row and its input and output rows
commit together or not at all (`ARCHITECTURE → "Single-transaction atomic writes"`); inside a caller's transaction —
the reorg's re-insertion — it runs as a savepoint of that one.

- `expiresAtHeight` is the block height at which the entry becomes invalid.
- `costEstimate` is the cost gate's marginal cost, written as the row's `cost_estimate` (→ The cost gate); a caller
  that did not cost the transaction — a reorg's re-insertion — passes none, and the row carries NULL.

### assertPoolAdmits

```
assertPoolAdmits(tx: UtxoTransaction): void
```

**The pool's own refusals, asked before the cost gate.** It throws what `insertUtxoTx`'s conflict and capacity gates
would throw for `tx` at that moment — `PendingSpendConflictError` for an input a pooled entry spends, then
`MempoolFullError` for a full class the arrival cannot enter (→ Size cap; → Eviction, inside the credit class only) —
and writes nothing: a displacement it finds open is the insert's to make. `admitTx` calls it after the correctness gates
and the floor and before the cost gate (→ The cost gate), so a transaction the pool would refuse never costs the
speculative block — on the gossip relay above all, which validates against the confirmed set alone (→ getBoxWithPending)
and reaches the conflict gate here.

**One statement of each gate.** `insertUtxoTx` runs the same two checks through the same code and acts on their
answer — refusing, or displacing the cheapest resident — and it alone runs on the reorg path, which reaches the store
directly. Admission is synchronous from this call to the insert, so the two answer alike.

### setCostEstimate

```
setCostEstimate(rowid: number, costEstimate: number): void
```

Writes a row's `cost_estimate` once the creator has costed it alone (→ The cost gate; `MINING_INTERFACE → Template and
submit → "Packing to the budget"`). It is the one write the fill makes to the pool while it reads it, and it moves
neither a row's class nor its rate, so the fill's order stands (→ Ordering).

### getHeldEntry

```
getHeldEntry(txId: string): { expiresAtHeight: number; txBytes: Uint8Array } | null
```

The pool's entry for one transaction id — its expiry and its stored bytes — or `null` where none stands: one point read
of `idx_mempool_tx_id`. It is the one read of an entry by id: admission's first question, and the read a pending post's
`tx` bytes come from (`NODE_INTERFACE → Posts → "The creating transaction rides a post row"`).

**A transaction the pool holds is answered as held, before anything reads state.** Every admission path — each write
route and the gossip relay — asks `getHeldEntry` for the transaction's id once the request or the packet has passed the
checks that read nothing but itself, and an entry standing ends the path: no service check, no `validateTx`, no gate, no
floor, no cost gate and no insert runs, so the spends the pool holds for the transaction — of its inputs, and of its
owner's karma (→ Correctness gates) — are never held against the transaction that made them. **The id is the
transaction**: it leaves the signatures out (`TYPES_INTERFACE → Layout — UtxoTransaction`), so an arrival whose
signatures differ from the pooled entry's is the same transaction, and the pooled bytes are the ones that stand. What
each path answers is its own
(`NODE_INTERFACE → Service Layer Architecture → "A transaction the pool already holds is answered as held"`; → Relay
Integration).

### Correctness gates

```
hasPendingLike(targetPostId: string, likerId: string): boolean
countPendingInvites(inviterId: string): number
hasPendingInvitee(inviteeId: string): boolean
hasPendingVouch(voucherId: string, targetId: string): boolean
hasPendingClaim(nameLower: string): boolean
hasPendingClaimBy(claimantId: string): boolean
hasPendingWithdraw(postId: string): boolean
pendingKarmaSpend(ownerId: string): bigint
```

SQL `EXISTS`/`COUNT` over the gate-metadata columns — never a bounded scan.
These gates see every row regardless of pool size. Hex parameters compare
against the columns exactly as stored. `hasPendingVouch` is keyed on the pair: it mirrors one
live vouch per `(voucher, target)` (`NODE_INTERFACE` → Vouch transition rules), and a voucher's
other pending casts are no reason to refuse one. `hasPendingClaim` mirrors one live name per canonical
form and `hasPendingClaimBy` one name per identity (`NODE_INTERFACE` → Username transition rules). **A
burn needs no gate of its own**: it spends the name box, and a second spend of that box is the
pending-spend conflict every transaction meets.

**Admission runs the gates, on every path.** `admitTx` refuses, before the pool, a transaction a pending entry already
answers: a like whose `(liker, target)` one carries; a claim whose canonical name or claimant one carries; a vouch whose
pair one carries; a bond whose invitee one names (`hasPendingInvitee`) — the invitee is an account once the first
lands, so the second could never apply; a bond by a member whose pending bonds already take every invite its record
leaves it, `countPendingInvites(inviter) ≥ ⌊memberVouches / D(N)⌋ − invitesUsed` (`ARCHITECTURE → The invite budget`;
a root's are not counted), because two invites by one member in one block read the record as the first left it
(`NODE_INTERFACE → Bond transition rules`); and a withdrawal of a post one already withdraws (`hasPendingWithdraw`).
The gossip relay and every write route meet them alike, each refusal its route's named answer (`NODE_INTERFACE → HTTP
API`). The reorg path, which reaches the store directly, meets none: a transaction a reverted block carried was valid
beside that block's others, and the creator's screen answers for it beside the pool's (`MINING_INTERFACE → Template
and submit`). **A transaction the pool itself holds never reaches them** — admission asks for its id first
(→ getHeldEntry) — so a gate refuses only another transaction.

**`pendingKarmaSpend` is an input of `validateTx`, not a gate a path can skip.** It answers the `SUM` of
`karma_spend` over the rows whose `karma_owner` is the owner — what the pool's karma transactions have
already spent of that owner's karma, `0n` where it holds none. Admission's `held` is the confirmed karma
sum less it (`NODE_INTERFACE` → Karma transition rules), in the deps of the HTTP routes and of the relay
alike, so a transaction is judged against the owner's karma as the pool's entries ahead of it leave it — and never
against its own entry, since a transaction the pool holds is answered before `validateTx` runs (→ getHeldEntry). An
entry that leaves the pool — confirmed, expired or removed — leaves the sum with its row.

### The cost gate

**A transaction that alone cannot fit a block is refused at admission.** The pool runs it as the only user
transaction of a candidate block at `tip + 1` — the settlement built as the creator builds one, its producer the
all-zero key, which signs nothing, so the settlement counts every actor the transaction carries and the cost is the same
whoever mines — over an **unrecorded** tree view (`NODE_INTERFACE → The block proof`), and refuses it when that block's
cost is over `MAX_BLOCK_COST` (`CONSENSUS_INTERFACE → The block's cost`), the reason naming the cost, or when that
block is refused for its signatures alone, before its cost is counted. **A transaction that cannot be costed alone is
admitted on the other gates** — one spending a pooled output, a settlement the tip cannot build, a node with no prover:
packing trims it if it does not fit. Without it a transaction no block can carry would sit in the pool, trimmed from
every template until it expired. **The run reads two karma boxes per owner at most**
(`CONSENSUS_INTERFACE → The block's cost`), so what an owner holds does not price their transaction out of
the gate. A transaction that fits alone may still be
trimmed from a full block: that is packing (`MINING_INTERFACE → Template and submit → "Packing to the budget"`), not
admission.

**The candidate carries the id admission computed.** Its body declares it, the settlement build reads it
(`CONSENSUS_INTERFACE → The settlement build`), and `applyBlock` holds it to the transaction's bytes as it holds any
block's (`CONSENSUS_INTERFACE → Applying a block`) — so the gate hashes the transaction once, in that check.

**The gate keeps what it measured.** A row carries the transaction's **marginal cost** as `cost_estimate` — its
single-transaction block's cost less the empty block's at the same tip, the empty block's computed once a tip — the
estimate the creator packs by. A row the gate did not cost — a reorg's re-insertion, or a transaction it admitted
uncostable — carries NULL until the creator costs it.

### getBoxWithPending

```
getBoxWithPending(boxId: string): AnyBox | null
```

The pending view of one box: the confirmed UTXO set **∪** pending outputs **−** pending inputs, the
subtraction first and over both halves — a box a pooled entry already spends is not spendable again,
confirmed or pending. ⛔ **The subtraction answers as the pending-spend conflict, never as an absent
box**: for a box a pooled entry spends the view throws `PendingSpendConflictError` (409) where
`validateTx` reads the input, so every write route's 409 is reachable and a client can tell a box tied
up in the pool from one spent on chain (`WEB_INTERFACE → The wallet → "Nothing retries"`); `null` is the
answer for a box that exists nowhere. **Three point reads**, in that order: the box's `mempool_inputs` row, present
being the conflict; the confirmed set; the box's `mempool_outputs` row, with the bytes of the entry it names, decoded
for that one box (→ Schema). **Submission's `getBox`, and nothing else's.** The HTTP routes validate against
it, so a transaction spending the change of one still in the pool is admitted — and a child therefore
enters the pool only while its predecessor is confirmed or already pooled, and the fill selects it only
after its predecessor (→ Block Creator Integration), the order the ordering rule at apply requires
(`NODE_INTERFACE → Block finalization`). The relay path validates against the confirmed set alone (`getBox`), which is
stricter and orders the same way. ⛔ **Never block application's.** Apply resolves inputs against the
confirmed set (`NODE_INTERFACE → Block finalization`); a block's inputs decided by one node's unshared
pool would be a fork.

### getOwnKarmaBoxIdsWithPending

```
getOwnKarmaBoxIdsWithPending(ownerId: string): string[]
```

`getBoxWithPending`'s view, asked by owner: the ids of the owner's **unmarked** karma boxes among the
confirmed set and the pooled transactions' outputs, less every box a pooled transaction spends. It is
submission's `getOwnKarmaBoxIds` — rule 3 of `NODE_INTERFACE → Karma transition rules → "An identity
holds at most two karma boxes"` — and nothing else's. An owner with a pooled karma spend holds that
spend's change, and none where it returned no change; an owner with nothing pooled holds their
confirmed own box. So a transaction that chains on a pooled spend names its change, and one that names
the income box alone is admitted exactly where the pool's entries ahead of it leave the owner no own
box. **It is the unmarked rows of the set `getBoxesPageWithPending` reads for karma**, over that read's one statement
of the set — a pooled karma output is unmarked by rule 2, so the marked row is the confirmed income box alone — and
decodes no entry. The relay answers the same rule over
the confirmed set, as it resolves inputs.

### getBoxesPageWithPending

```
getBoxesPageWithPending(owner: Uint8Array, boxType: 'karma' | 'credit', page: Page<BoxKey>):
  { rows: (KarmaBox | CreditBox)[], next: BoxKey | null, count: number }
getBoxTotalWithPending(owner: Uint8Array, boxType: 'karma' | 'credit'): bigint
```

`getBoxWithPending`'s view, asked by owner and type: the owner's confirmed boxes of the type that no `mempool_inputs`
row names, and the `mempool_outputs` rows of the type to the owner that no `mempool_inputs` row names — so a pooled
output a later pooled entry spends is out, and the end of a chain of pooled spends is in. One page in
`value DESC, id` strictly after `after`, by the page contract (`NODE_INTERFACE → Store Interface`), the two halves
merged in that order; `count` and the total over the whole set. **The set is stated once**, a fragment the page, the
`COUNT`, the `SUM` and `getOwnKarmaBoxIdsWithPending` share. A pooled row is returned as the box `materializeOutput`
returns, with the id block application will give it. It is the listings' `pending=1`
(NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending view, as admission spends from it"), the view a
client builds on — **never a rule's input and never block application's**, for the reason `getBoxWithPending` is not
(→ getBoxWithPending).

### getPendingEntries

```
getPendingEntries(limit: number, afterRowid?: number): PoolEntry[]
```

Returns pending entries in FIFO order (`ORDER BY rowid ASC`), up to `limit`,
starting after `afterRowid` (default `0` — from the beginning). Every row is a `utxo_tx`;
the caller (block creator) decodes the payload.

Entries are not filtered by expiry here — the pool holds none the tip has passed
(→ followAppliedBlock).

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

### followAppliedBlock

```
followAppliedBlock(height: number, appliedTxIds: readonly string[], spentBoxIds: readonly string[]): number
```

The pool's part of every applied block
(→ What takes an entry out of the pool → "The pool follows every applied block, on every node"), run inside the block's
own write. First each applied transaction's entry leaves by `tx_id` (`removeUtxoTxEntry`) — confirmed, so it takes no
dependents and its post's row stays, which the apply confirms. Then, through `removeUnconfirmed`, every entry spending a
box in `spentBoxIds` — every box the block's mutations remove, the body's and the settlement's — and, through
`purgeExpired(height)`, every entry past its expiry or its ceiling. `height` is the applied block's, the new tip: the
boundary block assembly drew at the same tip. Each set is an indexed read — the spent boxes against
`mempool_inputs`' key, bound as one value (`json_each`), expiry a range of `idx_mempool_expires`, the ceiling a range of
`idx_mempool_ceiling` — never a scan of the pool. Returns the number of entries that left unconfirmed.

### purgeExpired

```
purgeExpired(currentHeight: number): number
```

`followAppliedBlock`'s expiry half, and nothing else's call: every entry whose `expires_at_height` is below
`currentHeight`, **and every entry whose `max_valid_height` is** (→ Validity ceiling), leaves through
`removeUnconfirmed`, its dependents with it. Returns the number of entries removed, dependents among them.

### removeUnconfirmed

```
removeUnconfirmed(rowids: readonly number[]): number
```

**Every exit of an entry that did not confirm runs through it**: the entries named, every pooled entry spending an
output of one of them or replying to its post — a pending row whose parent ref names that post, found through its
`tx_id` — and so on down
(→ What takes an entry out of the pool → "An entry that leaves unconfirmed takes its dependents"), and each such post
entry's pending row (NODE_INTERFACE → Post transactions). The dependents are read before any row leaves, since the
output rows they are found through leave with their entry. One SQLite transaction — inside a caller's, a savepoint of
that one. Its callers: `followAppliedBlock`, the credit class's eviction at the cap
(→ Eviction, inside the credit class only), the creator's eviction of the rows a refused body's screen refuses, and the
sweep of a mined block the intake refused (→ Block Creator Integration). Returns the number of entries removed.

### removeEntry

```
removeEntry(rowid: number): void
```

Deletes a single entry by rowid, with its post's pending row and no dependents: the sweep of a mined block that
applied. The block creator tracks which rowids the template carried and removes them once the intake answers; the
block's own application has already removed each by `tx_id` (→ followAppliedBlock), so the sweep is the backstop the
rule *cleanup reaches every row* asks for (→ Confirmed-entry cleanup reaches every row).

---

### setMempoolCap

```
setMempoolCap(n: number): void
```

Sets the pool bound `classCaps()` splits between the credit and karma classes
(*Size cap — reject, never evict*; *Eviction, inside the credit class only*).
`index.ts` calls it once at startup with the parsed `maxMempoolEntries`; the
store starts at `DEFAULT_MAX_MEMPOOL_ENTRIES`, the constant `config.ts` imports
for the setting's default. Throws on anything but a positive safe integer and
leaves the bound unchanged.

## Lifecycle

```
   ┌────────────────────────────┐   ┌──────────────────┐
   │  API routes (POST /posts,  │   │  Gossip relay    │
   │  /likes, /invites,         │   │  (onTx)          │
   │  /vouches, /credits/…,     │   │                  │
   │  /posts/:id/withdraw)      │   │                  │
   └─────────────┬──────────────┘   └────────┬─────────┘
                 │ insertUtxoTx              │ insertUtxoTx
                 ▼                           ▼
                ┌─────────────────────────────┐
                │        Mempool (SQLite)     │  ← entries sit here, unconfirmed
                └──────────────┬──────────────┘
                               │ createOrderingBlock() — internal miner
                               │ solves, or an external miner submits
                               │ (production is difficulty-regulated;
                               │ nothing in the pool triggers it)
                               ▼
                 ┌───────────────────────────┐
                 │ 1. fill to the byte and   │
                 │    cost budgets           │
                 │ 2. assemble body +        │
                 │    settlement transaction │
                 │ 3. speculate the body;    │
                 │    over budget → trim,    │
                 │    under → refill once;   │
                 │    rejected →             │
                 │    removeUnconfirmed,     │
                 │    back to 1              │
                 │ 4. mine / sign            │
                 └─────────────┬─────────────┘
                               │ submitMinedBlock()
                               ▼
                 ┌───────────────────────────┐
                 │ 1. the intake's item:     │
                 │    admit, bind, stage,    │
                 │    apply (embedded txs,   │
                 │    posts confirmed,       │
                 │    followAppliedBlock)    │
                 │ 2. the sweep per rowid:   │
                 │    applied → removeEntry, │
                 │    refused →              │
                 │    removeUnconfirmed      │
                 └───────────────────────────┘
```

### Entry states

| State | How entered | How exited |
|-------|------------|------------|
| **Pending** | `insertUtxoTx` | Confirmed by an applied block → `followAppliedBlock`, or the sweep of a mined block that applied → `removeEntry`; every other exit → `removeUnconfirmed` |
| **Confirmed** | An applied block's cleanup (`followAppliedBlock`), or the sweep of a mined block that applied (`removeEntry`) | Gone from mempool; state now in ledger |
| **Evicted** | A body this node built was rejected — at speculation, the rows its screen refuses (every row, where it refuses no pooled one); at finalize, every row it carried — or the credit class's cap displaced it | Gone from mempool; state never applied |
| **Expired** | The applied block that passes its expiry or its ceiling (`followAppliedBlock`) | Gone from mempool; state never applied |
| **Spent elsewhere** | An applied block spent one of its inputs (`followAppliedBlock`) | Gone from mempool; state never applied |
| **Orphaned** | An entry whose output it spends left unconfirmed (`removeUnconfirmed`) | Gone from mempool; state never applied |

### Expiry

- **TTL:** 720 blocks (~12h at 60s block time)
- **Expiry check:** at each applied block, on every node (`followAppliedBlock`), not on a timer
- **Expired entries** are silently dropped — the API already returned
  `{ status: "pending" }` to the client; the client should re-submit if their
  operation times out

---

## No batch linking

**Every entry stands alone.** A post is one transaction carrying its payload and
its karma lock, so nothing produces multiple pool entries that must travel
together.

| Operation | Pool entry type |
|-----------|----------------|
| `POST /posts` | `utxo_tx` |
| `POST /likes` | `utxo_tx` |
| `POST /invites` | `utxo_tx` |
| `POST /vouches` · `DELETE /vouches/:targetId` | `utxo_tx` |
| `POST /credits/transfer` | `utxo_tx` |
| Relay: inbound UTXO tx (`onTx`) | `utxo_tx` |
| `POST /posts/:id/withdraw` | `utxo_tx` |

---

## Block Creator Integration

The block creator (`services/block-creator.ts`) is the sole consumer of
pending entries:

1. Reads a pool that holds no entry the tip has passed: expiry is block application's (`followAppliedBlock`), and the
   tip moves only by an applied block
2. Draws pending entries — the karma class in FIFO order, then the credit class by fee rate (→ Ordering) — and fills
   to `BLOCK_BODY_BUDGET_BYTES`, `MAX_SETTLEMENT_BYTES` and the cost budget less `PACKING_COST_MARGIN`
   (`MINING_INTERFACE → Template and submit → "Packing to the budget"`), **skipping an
   entry whose declared `protocolVersion` is not the era of the block being built**
   (`protocolVersionAt(schedule, height)`, `ARCHITECTURE → Protocol Versioning`). A skipped entry
   stays pooled and leaves by expiry (→ What takes an entry out of the pool, 2) — never evicted for
   its version, never included. Without the skip, the first block of a new era would carry every
   pre-boundary entry into a body the mutation phase rejects. **The fill skips, the same way, an entry
   that depends on what the body it builds does not hold**: an input that is neither in the confirmed
   set nor an output of an entry already selected; a like's target or a reply's parent that is neither
   a confirmed post nor the post of an entry already selected; a withdrawal's post that is not
   confirmed. Such an entry stays pooled for a block that carries what it waits on, and one whose
   dependency never comes leaves by expiry; a child the fill meets ahead of its parent waits a block.
   Admission reads the pool's pending state for an input and for a reply's parent, only a reorg
   returns a like's target or a withdrawal's post to the pool, and the owner's pending spend only
   lowers what admission allowed — so a transaction a body's screen refuses is never one that waits
   (`MINING_INTERFACE → Template and submit`)
3. Every entry is a `utxo_tx` → `utxoTxIds` / `utxoTxs`
4. Tracks `confirmedRowids` — **every** row the template carries
5. Once the intake answers a mined block, the sweep of each tracked rowid: `removeEntry` where the block applied,
   `removeUnconfirmed` where the intake refused it. **A body the mutation phase rejects loses, the same way, the rows
   of the transactions its screen refuses** (`removeUnconfirmed`) — every row it carried, where the screen refuses no
   pooled one — and the creator fills again from what remains (`MINING_INTERFACE → Template and submit`); a rejected
   body that carried no row ends the build. Rows a *peer's* block confirms are reached by that block's application
   (`followAppliedBlock`), not by this step

### The fill budget is bytes; `getPendingEntries` is a count

⛔ **A SQL `LIMIT` does not express a byte budget.** The two do not correspond: 2 MB of body is
roughly 2,026 max-size post transactions but roughly 4,264 likes, against a pool that holds up to
`MAX_MEMPOOL_ENTRIES`. The creator therefore pages with `iteratePendingEntries` and stops when the
budget is spent — **a large fixed count is not a substitute.** An under-fetch produces short blocks
while every test still passes and every block still validates, which is the failure mode that reads
as working software.

**The budget is not spent in SQL, and that is deliberate.** A query can weigh
`length(utxo_tx_bytes)` and nothing else — not the 32-byte `utxoTxIds` entry, not the `lp` prefix, not
the array count prefixes, not the reserve. Budgeting there would need a padding constant, which
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

The budget is spent in this order: the settlement transaction's
footprint first — both mandatory, and neither the miner's to trim — then transactions
with what remains. The settlement's size depends on what the fill selected, so the
trim loop re-derives it per iteration rather than measuring it once.

⛔ **The settlement's footprint is NOT a fixed reservation, and `entryByteCost` is what keeps
the loop bound.** A settlement grows with **what the fill selected** — one accrual marker
consumed per like — so seeding the fill with its maximum would reserve most of the block.
Instead **`entryByteCost` includes each entry's MARGINAL cost to the settlement**, not only
its own encoded length, so the accumulator stays nearly right and *"the sizer has the last
word"* is undisturbed. ⚠ **The marginal cost is not uniform across entry kinds** — a like adds
a marker the settlement consumes and may add an author's carry-box output; an ordinary credit
transfer adds nothing — and under-reserving is the direction that puts an assembled body over
a budget every peer measures. ✅ **Popping is monotone**, so the trim loop converges: removing
a transaction removes its settlement contribution too, and the settlement is rebuilt on each
iteration rather than measured once. **One pop returns bytes to the settlement** — an unvouch of
a vouch the lapse leg lists, whose removal puts that vouch back in the leg (`NODE_INTERFACE → The
settlement transaction → "The lapse leg leaves out a vouch the body spends"`): one input and one
escrow output, which the unvouch itself carried beside its signature, so the tree is smaller after
that pop as after any other.

⛔ **The settlement is trimmed against its own bound as well.** The loop pops a user entry while
the rebuilt settlement encodes above `MAX_SETTLEMENT_BYTES` (`TYPES_INTERFACE` → Size caps), not
only while the tree exceeds the body budget — every body-driven settlement leg (markers, fee boxes,
touched identities, carry boxes, grants, withdrawal locks) shrinks with the body. **One state-driven
leg grows under a pop**: the lapse leg takes back a listed vouch when the unvouch that spent it is
popped (above), so the settlement is measured again after every rebuild and the loop pops while it
is over. The state-driven legs are capped by consensus and cannot push an empty body's settlement
over the bound — the empty body's settlement holds the whole lapse list — so the loop always
terminates with a legal settlement, and a size refusal at submit is unreachable (`MINING_INTERFACE`
→ Template and submit).

⛔ **The fill counts the settlement's bytes.** A second accumulator — the empty
body's settlement plus each entry's `settlementMarginalBytes` — ends a class's fill at the entry that would take it
above `MAX_SETTLEMENT_BYTES`, as the first ends it at the body budget; it is blind to the settlement's count prefixes and
to its first protocol-box input, a few bytes across the body, and it counts the whole lapse list under an unvouch that
takes a vouch out of it — over, the safe direction. **A pop for the settlement drops the tail entries whose
marginal bytes cover the overshoot**, never one entry a rebuild: an entry that adds nothing to the settlement — an
ordinary karma transfer by an owner who owes no decay — takes nothing off it. **So the settlement's loop runs at most once, but for a returned
vouch**: a dropped tail holding such an unvouch covers the overshoot and returns that vouch's bytes, and the loop pops
again where the rebuilt settlement is still over. The settlement's pop runs after the body's, and popping only shrinks
the tree, so it cannot reopen the body's bound. Measured 2026-09-30, a pool of fee-paying transfers meets the settlement's
bound at 3 122 entries, 88.5% of the cost budget, before the body's.

⛔ **An entry whose owner owes decay adds the squaring.** Its figure is `settlementMarginalBytes` plus
`decayLegMaxBytes` — two inputs and one karma output at most (`CONSENSUS_INTERFACE → The settlement build`) — in the
accumulator and in the pop's covering sum alike. The predicate is `karmaOwed > 0n` for the entry's `karma_owner` at
the block's height over confirmed state, the reader admission's `owed` already is (`NODE_INTERFACE → Karma transition
rules → "Engine inputs the rule needs"`). It holds wherever the settlement squares that owner: a body adds no karma to
an owner's boxes, so what they owe after it is never more than before. Two entries of one such owner both reserve it —
over, the safe direction. **A leg the covering sum does not price is a leg a pop cannot take off**: an overshoot made
of unpriced bytes is covered by no tail, and the pop then drops the whole selection. **The income box's input is
bounded and not priced**, as the carry box's is: one per paid owner, beside marker terms that each take their own
input off with the entry. **The predicate is read once per owner per build** — the owner's karma sum and their
record — and a second pass of the trim reads nothing.

⛔ **An entry whose marker pays an author who owes decay adds that author's squaring.** The settlement squares every
owner it pays (`NODE_INTERFACE → Karma decay → "A block squares every identity it touches or pays"`), and a like's or
a reply's `like_accrual` output names the author it pays. The entry's figure gains `decayLegMaxBytes` for each author
its markers name for whom the predicate above holds — read for the author as for an owner, once per author per
build, in the accumulator and in the pop's covering sum alike. Over, the safe direction, where the payout stays in
the author's carry, where two entries pay one author, and where the author is also an entry's owner. **The capped
legs' payees** — a settling bond's inviter, a returning escrow's owner — are squared in the empty body's settlement
the fill starts from, so their squarings sit in its baseline, priced by the build itself.

**Measured 2026-10-12** (`block-creator-stale-owners.test.ts`; every owner owes decay and holds an own box and an
income box): a pool of 1 000 consolidations fills to 868 — the settlement's budget over the 115-byte reservation —
and that template's settlement encodes in 59 164 bytes; a pool of 1 500 likes fills to 679, at 32 + 115 an entry, in
68 112 bytes. A squaring's own bytes are below its reservation — one input and one output where the spend named both
boxes — so the fill ends short of the bound and the sizer pops nothing. A pool of 3 200 likes by owners who owe
nothing fills to 2 590 with the term as without it.

**Measured 2026-10-28** (`block-creator-stale-authors.test.ts`): a pool of 1 500 likes whose likers and author all
owe decay fills to 381, at 32 + 115 + 115 an entry, and that template's settlement encodes in 38 380 bytes; a pool of
3 000 likes by likers who owe nothing, each paying a distinct author who owes decay, fills to 679, at 32 + 115 an
entry, in 45 590 bytes.

### Confirmed-entry cleanup reaches every row, and it is a lookup rather than a scan

**Two paths clear a confirmed entry.** A block this node produced is cleaned by rowid
(`confirmedRowids`, step 5), which reaches every included entry wherever it sits. A block arriving
**from a peer** is cleaned by `removeUtxoTxEntry(txId)` — an indexed delete on `tx_id`; the key is written at
insert.

**The rule is that cleanup reaches every row**, whatever its depth. An entry left behind holds a
slot, and the creator later rebuilds it into a block that apply refuses as inapplicable; the chain
recovers, because `submitMinedBlock` evicts the row even on rejection, so the cost is one wasted block
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

- **`onTx(tx)`**: `getHeldEntry` → `validateTx` (read-only) → `admitTx`, its correctness gates (→ Correctness gates)
  as every route's → `insertUtxoTx(tx, txId, expiresAtHeight)`. **A transaction the pool holds answers `false` at the
  lookup** — not admitted, so not forwarded — and logs nothing: a copy of a pooled transaction arriving again is
  ordinary gossip (→ getHeldEntry).
  There is no sub-block relay handler — a post arrives as a transaction through
  `onTx` (`NODE_INTERFACE` → Relay handlers). It answers whether it admitted the
  transaction, and net forwards an admitted one and no other (`NET_INTERFACE` →
  Forwarding Rule).

State is applied later when an ordering block containing these entries is
received and applied.

### Relay: ordering block application

When an ordering block is received from gossip:

1. Full validation (structure, chain-link, PoW, signature)
2. For each `utxoTxId`: decode from mempool or reconstruct, **fully re-validate with
   `validateTx`**, then `applyTx`
3. Confirm the block's posts (ids from its post transactions)
4. The pool follows the block (`followAppliedBlock`): confirmed entries leave by `tx_id`, then the entries the block
   leaves no place for (→ What takes an entry out of the pool)

⛔ **Step 2 is full re-validation, never a liveness-only re-check.** A permissionless block
producer can embed a transaction that never passed pool entry or relay validation, so
authorization, transitions and conservation must not be assumed of anything a block carries
(NODE_INTERFACE → Block finalization).

### What takes an entry out of the pool

**Five mechanisms, and none of them re-checks a pooled entry's validity on a timer.**

1. **Confirmation.** A transaction a block applies leaves by `tx_id`; a block this node mined is
   swept by rowid in `submitMinedBlock`, which reaches every included entry wherever it sits.
2. **Expiry.** Every insert carries `expiresAtHeight = <insert height> + MEMPOOL_EXPIRY_BLOCKS`, and
   an entry whose expiry — or validity ceiling (→ Validity ceiling) — the chain passes leaves with the block that
   passes it.
3. **The cap.** The credit class evicts its lowest fee-rate row; the karma class rejects at the cap
   and never evicts (→ Size cap).
4. **A rejected body.** When the mutation phase refuses the body, the build evicts the rows of the
   transactions the body's screen refuses — every row the body included, where the screen refuses no pooled one —
   and reassembles (MINING_INTERFACE → Template and submit). **This is what
   removes an entry that has gone invalid while its inputs are still live**, on a node that builds templates — a
   liveness test cannot see that class; on a node that builds none, such an entry leaves by its expiry.
5. **A block's spends.** An entry spending a box an applied block spent — any box the block's mutations remove, the
   body's and the settlement's — leaves with that block: the chain has spent its input, so no block can carry it.

**The pool follows every applied block, on every node.** Confirmation, expiry and a block's spends run in the block's
own write (→ followAppliedBlock), so a peer's block, a block this node mined and each block a reorg applies take them
alike, and a node that builds no template — a `server` node — keeps no entry the chain has spent or passed.
Confirmation runs first, so an applied transaction is never read as a spend of its own inputs.

**An entry that leaves unconfirmed takes its dependents.** Every pooled entry spending an output of an entry that leaves
by mechanisms 2–5, or replying to the post it carries, leaves with it, and so on down: no block this node builds can
carry it without the entry it depends on, and a pending reply would stand under a parent this node no longer holds
(→ removeUnconfirmed). A confirmed entry takes none — its outputs exist now. A post entry that leaves unconfirmed takes
its pending row (`NODE_INTERFACE → Post transactions`).

**A reorg returns what it reverts and nothing else.** The transactions of the blocks a reorg reverts go back to the
pool (`NODE_INTERFACE → Block Journal`); an entry that a reverted block's spends or its
expiry removed stays gone, and its submitter sends it again (→ Expiry).

---

## Design Decisions

### Size cap — reject, never evict

The pool holds at most `MAX_MEMPOOL_ENTRIES` rows (config, default 10000)
across all entry types. Every insert function checks the count and throws a
typed `MempoolFullError` at the cap. An unbounded pool was a disk-DoS lever
(trivially via `/faucet` flood).

The cap is the node's `maxMempoolEntries` setting, handed to the store by `index.ts`
at startup through `setMempoolCap(n)` — `store/mempool.ts` does not read `config`.
The store starts at the same default the setting has (`DEFAULT_MAX_MEMPOOL_ENTRIES`,
10000, exported by the store and imported by `config.ts` for its default — one
source), so a store opened without a node, as a test opens one, is bounded the way
production is; `setMempoolCap` refuses anything but a positive integer.

Three insert callers, three behaviors:

| Caller | At the cap |
|---|---|
| HTTP routes | **503** with a generic body (`{ error: 'mempool full' }`) |
| Gossip relay (`onTx`) | drop the entry, log, answer `false` — never throw; the transaction is not forwarded |
| **Reorg re-insertion** (`services/fork-resolution.ts`) | drop, log, continue |

The reorg caller is not optional politeness: re-insertion of reverted
txs runs *inside* the chain-switch SQLite transaction, so an
escaping `MempoolFullError` would roll back the switch and strand the node on
the lighter chain — mempool pressure escalated into a consensus-liveness
failure.

### Eviction, inside the credit class only

The pool is capped **per class**. Credit entries occupy at most
`MEMPOOL_CREDIT_SHARE_PCT` of `maxMempoolEntries`; karma-side entries hold the
rest. When the credit class is full, an arriving transaction bidding above its
cheapest resident **displaces** that resident; one bidding below is rejected.
The karma-side class rejects at its cap and never evicts.

**A displaced resident takes its dependents**
(`removeUnconfirmed`; → What takes an entry out of the pool → "An entry that leaves unconfirmed takes its dependents"),
**and an arrival never displaces what it depends on**: an arrival spending an output of the cheapest resident, or of an
entry that would leave with it, is rejected as one bidding below is, since admitting it would pool an entry whose input
no longer exists.

⚠ **The cheapest resident's bid is read back as a `bigint` at the row
boundary.** `tx_fee` spans the box-value domain (TYPES_INTERFACE → Box value
domain), and a plain integer read rounds silently above 2⁵³ — the displacement
comparison would then weigh a fee no transaction carries.

**Fee-ordered eviction over a single pool would be worse than none.** Every
karma-side operation bids zero — posts, likes, invites, vouches, a backer's unstake
(`NODE_INTERFACE → Backer transition rules`, a karma-class entry: its outputs are a stake
and a marker, not credit) — so paying
traffic would evict all of them, and the coinbase's inclusion bonus
(MINING_INTERFACE → Coinbase Application) would then pay for work that could no
longer reach the pool at all. The class boundary is what keeps the bonus
reachable.

Every applied block still reclaims space (→ followAppliedBlock), so a full pool also drains on
its own as entries expire, confirm or are spent elsewhere.

### Storage rent is refused at admission

A node refuses a **rent transaction** — an unsigned `credit` spend, admitted by authorization only
because every input is rent-eligible (NODE_INTERFACE → "Storage rent is a transition requiring no
signature"). **Policy, not consensus**, the same standing the fee floor below has: a block carrying
one is valid whoever built it.

⛔ **Refusal is what makes collection the block producer's.** A transaction carries no author, so
consensus has no key against which to test a producer restriction. Removing the pool path leaves a
producer placing one directly into its own block as the only route **on nodes applying this policy**.

⚠ **It protects the consume-whole branch.** A box that cannot cover its charge is taken entire; open
submission would let anyone race for under-funded boxes instead of only whoever wins a block.

### Validity ceiling

**An entry whose validity is capped from above by block height leaves the pool once the chain passes
that cap.** The ceiling itself is defined once, against the consensus rules it mirrors
(NODE_INTERFACE → Validity ceiling); this section states only what the pool does with it.

`max_valid_height` is written at insert from the transaction's bytes, beside `tx_fee` and `tx_bytes`
and on the same standing — no state is read, so an entry carries its ceiling whether or not this node
has ever seen the inputs. `NULL` means no ceiling and is the ordinary case.

**The pool reclaims; it does not screen.** The block that passes an entry's ceiling removes it (→ followAppliedBlock),
alongside the entries whose expiry it passes. This catches an entry that was live when
it was inserted and went dead as the tip rose — a vouch cast nobody mined inside its window is the
case that exists today, and it needs no reorg to arise.

⛔ **`insertUtxoTx` does not test the ceiling, and the reason is not the fee floor's.** The floor
stays above the store because the store cannot tell a submitter from the reorg caller (Fee floor,
below). A ceiling could be tested there safely — it is derived rather than chosen, so it reads the
same for every caller — but it would be testing something that cannot arrive: every submission path
runs `validateTx` first, so only a switch's re-insertion can offer a past-ceiling transaction, and the store
does not hold the height to judge it against.

⛔ **The reorg caller screens before the store.** The switch's `reorg` knows the height its re-insertion is
for — the tip the reorg is moving to, the same height its `mempoolExpiry` is derived from — and drops
a transaction whose ceiling lies below it rather than offering it to the pool. **The screen is a skip,
never a throw**: re-insertion runs inside the transaction that applies the new chain, and an error
that path does not recognise would abort the reorg and leave the node on a chain it has already scored
as the lighter one.

⚠ **Screening against the tip the reorg is moving to is correct whether that tip rose or fell.** It
asks whether the transaction can validate at the height it is being returned for, which is a question
about that height and carries no assumption about the direction the chain moved.

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

### Blob storage

Entries are stored as encoded blobs rather than parsed columns — a `utxo_tx`
row holds positional `encodeTx` bytes. This avoids double-parsing (decode off the wire → JSON for SQLite →
re-encode for broadcast) and keeps the mempool schema agnostic to entry
structure. The block creator decodes entries when assembling blocks.

### No separate tables

A single table with a type discriminator rather than one table per entry type.
This gives unified FIFO ordering and simpler expiry. `mempool_inputs` and `mempool_outputs` are not entry
tables: they hold no entry, only the box ids of the entries the one table holds, which the entry's own row
cannot index (→ Schema).

---

## Invariants

- All state mutations flow through the mempool — no direct `consumeBox` or
  `insertBox` calls in HTTP routes or relay handlers
- Mempool entries are encoded blobs — the store layer does not parse them
- Expiry is checked at each applied block, on every node, not on a background timer
- Confirmed entries leave with the block that applies them; an entry that leaves unconfirmed takes its dependents
- The pool holds a transaction once, and no entry spending a box the chain has spent: a transaction it holds is
  answered as held before any check, and every applied block removes the entries its spends leave no place for
- FIFO ordering within the karma-side class; fee-rate ordering within the credit
  class
- Size-capped **per class**. The karma-side class rejects at its cap
  (`MempoolFullError` → 503); the credit class displaces its cheapest resident
  for a higher bidder and rejects a lower one. **No replacement** on either
- Mempool is a node-local data structure — it is NOT gossiped
