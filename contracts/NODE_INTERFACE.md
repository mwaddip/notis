# NODE Interface Contract

**Component:** `@dagsocial/node`
**Protocol version:** 1
**Last updated:** 2026-08-19

## Scope

HTTP server exposing the DAGsocial API. Owns: post
verifier (Stage 2 stateful validation), UTXO engine,
like processing, invite creation and bond resolution, ordering block creator,
stump engine, mining subsystem, unified mempool, and persistent storage (SQLite).

Depends on:
- `@dagsocial/types` — shared data structures and constants
- `@dagsocial/validation` — Stage 1 stateless checks (PoW, signatures,
  structural validity)
- `@dagsocial/net` — libp2p networking for ordering block and UTXO
  transaction gossip

---

## Values are BigInt (P0 — Spec B)

Box `value` and every credit/karma **amount** are `bigint` (8-decimal integer base
units of 10⁻⁸ credit; karma small bigints). Rationale + the type-level contract:
`TYPES_INTERFACE.md` "Value denomination (P0)". No float math anywhere in a consensus
value path. Node-side obligations:

- **Authoritative value guard.** `utxo-engine.checkOutputValues` (engine) and
  `assertValidBoxValue` (`routes/json-to-tx`, the HTTP→tx edge) enforce
  `typeof value === 'bigint' && value >= 0n && value < BOX_VALUE_BOUND` — the **tight** bound.
  ⛔ **The number is `@dagsocial/types`' (TYPES_INTERFACE → "Box value domain"), imported and never
  restated** — it was stated three times across two packages, and `validation`'s copy said in its
  own comment that it was written to match node's.
  `@dagsocial/validation`'s coinbase check is the loose structural pre-filter; this is
  the tight apply-side twin — the two move together. The HTTP edge coerces the incoming
  JSON value (string or number) to `bigint` before it enters consensus.
- **All value arithmetic is `bigint`** — conservation sums, coinbase split, like
  settlement and carry, decay, fees. `Math.max/min/floor` **throw** on bigint: use
  bigint operators and manual min/max; bigint `/` truncates toward zero (the intended
  floor).
- **JSON boundaries emit strings (client-visible).** JSON cannot carry a bigint
  (`JSON.stringify(5n)` throws). Every HTTP response field carrying a box `value` or a
  `total` is serialized as a **decimal string**; the demo UI parses them with `BigInt()`
  (its phase). Same for the SQLite `extra_data` `originalValue` (coerce before
  `JSON.stringify`) and any stdout log field carrying an amount.
- **`block-creator.computeUtxoTxRoot` coinbase leaf** — ⚠ **SUPERSEDED 2026-08-17: the leaf
  class and its encoder are both gone.** `coinbaseOutputBytes` has no definition anywhere;
  coinbase outputs are outputs of the block's settlement transaction and reach `utxoTxRoot`
  under the `'utxotx'` leaf that transaction's id already gets. ✅ **The conclusion this bullet
  drew survives its subject**: a byte encoder is not a JSON boundary, so the decimal-string
  workaround stays retired — `value` rides as `vlqU64` inside `boxContentBytes` instead.
  The bullet above still governs every *JSON* boundary; this one is not among them. This is the
  `utxoTxRoot` coinbase Merkle leaf —
  **consensus**; the *same* function is both producer (block build) and verifier
  (`block-apply` recompute), so the leaf bytes cannot diverge between the two roles. What
  Phase 4 adds is that they cannot diverge from the **wire** encoding of the same struct
  either — see `TYPES_INTERFACE` → "Merkle leaf preimages are the struct's own wire bytes".
- **SQLite `.safeIntegers()`** on every `value`-column read and on `SUM(value)`
  (`getTotalKarma` / `getTotalCredits`) — without it better-sqlite3 returns a lossy
  `number` and loses precision above 2⁵³.
- **DB reset.** Box ids and the AVL `stateRoot` changed in the types phase — fresh
  chain / coordinated cutover, no in-place migration.
- **Demo UI (`public/index.html`).** Its hand-rolled box encoder is **positional**,
  mirroring `canonicalBoxBytes` field for field — `enum8(boxType) ‖ vlqU64(value) ‖
  vlqU(createdAtBlock)` then the per-type tail — and must be **byte-identical to
  `@dagsocial/types`** so client-built box ids match the node. It parses API
  `value`/`total` with `BigInt()`. A box-value mirror test pins the byte-identity.
  ⛔ **A prefix field missing there breaks `computeTxId` for every box type at
  once**, and the failure surfaces as a signature rejection that names no encoding.

> ## ⛔ THE DEMO UI IS A SECOND IMPLEMENTATION OF CONSENSUS RULES, AND NO GATE REACHES IT
>
> `vitest` never loads this file and nginx serves it statically, so **every mirror in it is checked
> by reading and by running the browser, and by nothing else.** Its own doc block states the failure
> mode: *a missing entry does not throw, it derives a **wrong id that looks well-formed**.*
>
> The mirrors this binds: `BOX_TYPE_TAGS` and the per-type `boxTypeFields` arms (which must track
> `TYPES_INTERFACE`'s tag table and layouts), the full `computeTxId` mirror whose output `signTx`
> signs, and the like transaction's `LikeAccrualBox` construction (§Likes). A divergence in the
> `computeTxId` mirror is the one that breaks users outright: the browser signs one id, the node
> computes another, and **every browser-built transaction is rejected** — with no typecheck or test
> in this repo able to see it.

---

## Unified Mempool

All state-changing operations flow through a single mempool. No operation
applies UTXO state immediately — every mutation is queued as a pool entry,
included in an ordering block, and applied atomically when the block is
finalized. See `MEMPOOL_INTERFACE.md` for the full contract.

**Key properties:**
- Single SQLite table `mempool` with type discriminator (`utxo_tx` | `prune`)
- FIFO ordering by insertion (`ORDER BY rowid ASC`)
- TTL: 720 blocks (~12h at 60s block time)
- Expired entries purged at block assembly time
- Confirmed entries removed after block finalization
- No replacement semantics
  > ⚠ **"No size cap" was wrong and has been removed.** A cap exists, is documented in
  > detail in `MEMPOOL_INTERFACE.md`, and is **enforced at all three insert sites**
  > (`MAX_MEMPOOL_ENTRIES`, default `10000`). `MEMPOOL_INTERFACE.md` is authoritative for
  > mempool behaviour; this section is a summary and must not restate its rules. Two
  > documents disagreeing about whether a bound exists is worse than either being wrong
  > alone — a reader here would size a DoS assumption on a cap that is actually present.

---

## HTTP API

Base URL: `http://{host}:{port}` (default: `localhost:3000`)
All responses are JSON. Binary fields (public keys, signatures)
are hex-encoded.

`userId` on the wire is hex-encoded (64 hex chars). Internally `UserId` is
`Uint8Array` (32 raw bytes).

### Posts

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts` | Post fields (hex) + `karmaLockTx` (JSON-serialized UtxoTransaction) | `{ postId, status: "pending", expiresAtHeight, txId }` (200) | 400 on validation failure |
| `GET` | `/posts/:id` | — | `PostJson` (`id`, `status`, `likeCount`, `likers`, `blockHeight`, `blockIndex`, `blockCreatedAt`) or `StumpJson` (below) | 404 |
| `GET` | `/posts/:id/thread` | — | `{ post, ancestors, descendants }` — full thread context; `post` is `PostJson` or `StumpJson` | 404 |
| `GET` | `/posts` | `?author=hex&limit=50&offset=0` | PostJson[] (same shape, live only, no stumps; ordering below) | — |

**PostJson time and order (decided 2026-08-20).** A post has no timestamp
(TYPES_INTERFACE → Layout — Post). `PostJson` carries the post's `type` with the rest of its
fields, plus three node-local columns: `blockHeight` and `blockIndex` — the confirming block
and the post's committed position in it — and `blockCreatedAt`, the confirming block
**header's** `createdAt`, joined from the store (`ordering_blocks.created_at` holds exactly
that value). All three are `null` while the post is pending; clients render the pending
state, not a time. Feed order: confirmed posts by `(blockHeight, blockIndex)` — the
committed order, newest first; pending posts above them, by arrival.

**Stump JSON shape (decided 2026-08-08).** A pruned root stays a 200 on
`GET /posts/:id` — a stump is real, renderable tombstone data, not an absence.
The response is a distinct `StumpJson`, discriminated by an explicit `kind`
field rather than by which keys happen to be missing:

```
StumpJson = {
  kind: 'stump',
  id: rootPostHash,          // the pruned root's post id (64-hex)
  author: hex(authorId),     // 32-byte Ed25519 key as hex — PostJson.author's convention
  replyCount: number,
  upvoteCount: number,
  protocolVersion: number,
  compactedAtBlockHeight: number
}
```

`PostJson` carries no `kind` field; clients discriminate on its presence.
`GET /posts/:id/thread` on a stump returns
`{ post: StumpJson, ancestors: [], descendants: [] }`. The feed listing
(`GET /posts`) remains live-posts-only — no stumps, unchanged.

**Implemented 2026-08-08** (`stumpToJson`, beside `postToJson`). What it
replaced: the raw `Stump` went out as-is, so `res.json` serialized `authorId`
— a `Uint8Array` — index-keyed as `{"0":…,"1":…}`, and `getThread` cast the raw
stump through `as unknown as PostJson`.

The enabler was the dependency typing, and it ran deeper than the unit expected.
`FeedServiceDeps.getPost` was `unknown | null`, which **collapses to `unknown`**,
so the stump arm was invisible to the compiler. Naming the store's real
signature (`Post | Stump | null`) made the compiler force the same correction
through `VerifierDeps` and `PostServiceDeps`, which carried the identical
`unknown` and which nothing had thought to look at. All three now name the
union, with zero casts — so re-widening any of them cannot silently typecheck
the stump arm away, and a future variant in the store's return breaks at the
boundary instead of in a response body.

**Post submission flow (mempool-based):**

**A post is submitted as one transaction** carrying the post payload and locking
the author's karma. There is no `batchId`, no challenge, and no PoW — the flow,
its validation and its store writes are "Post transactions" below. The
transaction is built and signed **client-side**; the server validates it, does
NOT build it.

⚠ **A post transaction arriving does not signal the block creator.** What goes into a block and
when one is produced are separate questions: production is difficulty-regulated, and a rebuild
mid-solve would void every miner's in-flight work (`MINING_INTERFACE` → GET /mining/template).
The post is stored and servable immediately; what waits for the next block is finalization, not
visibility.

Parent refs may point to live posts or stumps. Both are valid — the DAG
traversal handles both transparently.

State is NOT changed at submission. The post and its karma lock are applied when
an ordering block includes the transaction.

### Likes

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/likes` | `{ tx: UtxoTransaction }` — client-signed like tx (`likeTarget` set) | `{ status: "pending", txId, expiresAtHeight }` | 400 if `likeTarget` missing/malformed, post unknown or pruned, insufficient karma, already liked, or tx invalid |

**There is no `/likes/remove`** (unlike is not a feature), no free tier, and no refund
schedule. One like per `(liker, post)`, forever, costing exactly `LIKE_KARMA_COST`.

**Like flow:**

1. Extract `likeTarget` from the tx; reject if absent or not 64-hex
2. Verify the target post exists and is live (not pruned)
3. Verify not already liked: like-record `(liker, targetPostId)` absent AND
   `hasPendingLike` over the mempool gate metadata
4. `validateTx` — the engine enforces the biconditional like shape **both ways** (§validateTx
   step 7): karma inputs one owner, exactly one karma output same owner, plus exactly one
   `LikeAccrualBox` output of exactly `LIKE_KARMA_COST` whose `author` is the target's author —
   and the transaction **conserves**. There is no deficit.
5. Insert into mempool: `insertUtxoTx(tx, expiresAtHeight)` (gate metadata
   `like_target`/`like_liker` from `likeTarget` + the signer)
6. Return `{ status: "pending", txId, expiresAtHeight }`

The gateway checks are courtesy; **the consensus checks run again at apply** (see UTXO
engine → like transition, and Block application → per-block like settlement). The liker is
the karma inputs' owner — no separate liker field exists anywhere.

**The marker is client-built.** The transaction is **client-signed** before it reaches this
endpoint, so the client constructs the `LikeAccrualBox` output and signs over it — and it must
learn the target's **author** to do so, from the same source consensus uses: **`block_topology`,
never `dag_posts.author`**, which carries a zeroed author on placeholder rows. An author read
from the wrong table earmarks karma to the zero key while every gateway check passes.

**Step 3's duplicate-like gate is load-bearing, not courtesy-only in effect.** Conservation
cannot see a repeat: a second like on the same post is a perfectly balanced transaction, so
only the like-record check refuses it.

**A like tx still carries exactly one signature.** The marker is an output, not a signer, and
the liker is the karma inputs' owner.

**A like tx carries exactly one signature — the liker's** (decided in N1, ratified
2026-08-08). `castLike` rejects multi-signature like txs with a legible 400, and the
mempool gate derives `like_liker` as NULL from any signature map without exactly one key.
Rationale: a first-key-wins derivation would let a valid tx carrying a spare signature pin
an arbitrary `(liker, target)` pair in the gate and block that pair's real like — a
gateway DoS for the price of one extra signature.

### Invites

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/invites` | `{ tx: UtxoTransaction }` — inviter-signed create tx naming the invitee's public key | `{ status: "pending", txId, expiresAtHeight, bondBoxId }` | 400 if insufficient karma, 400 if that key is already an account |

**There is one step, and no secret in it** (`ARCHITECTURE` → Invite System). The
invitee shares their public key out of band; the inviter submits one transaction,
and the block's settlement grants the invitee the bond's value from the pool.

**Create flow:**

1. Verify the inviter holds ≥ **this transaction's own bond value** in available
   karma. ⛔ **Against the bond named, never against a constant** — the inviter
   picks it, so a fixed threshold passes someone who cannot afford the invite
   they built, and the rejection then arrives from conservation, which is the
   message this layer exists to replace. The bond is still the whole cost: the
   grant comes from the pool, so the inviter never pays it
2. Verify the named `inviteePublicKey` has **no `IdentityRecord` at all** —
   `ARCHITECTURE → Invite System` argues why the weaker test fails.
   ⛔ **This service-layer check is a courtesy, exactly as the vouch balance gate
   is:** a record-existence query cannot see a **sibling transaction in the same
   block** naming the same key. The consensus rule *"no other bond in this block
   names this key"* (§Legal box transitions) is what closes the duplicate grant
3. Build the transaction: karma box → karma box (`balance − bond`) + **`BondBox`
   only**
4. `insertUtxoTx(tx, expiresAtHeight)`; return the one box id

Block application writes `invitedAtBlock` at the grant, which starts the
probation clock; the key becomes an account in the same step, which is what bars
any further invite naming it. The bond settles `INVITE_PROBATION_BLOCKS` after
creation, so nothing stays open. `expiresAtHeight` on the response is the
**mempool** entry's expiry.

### Vouches

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `POST` | `/vouches` | `castVouch` | Signed UTXO tx (KarmaBox to KarmaBox + VouchBox) |
| `DELETE` | `/vouches/:targetId` | `initiateUnvouch` | Signed UTXO tx (VouchBox to none) |
| `GET` | `/vouches?target=X` | `getVouchesForTarget` | List vouchers for identity |
| `GET` | `/vouches?voucher=X` | `getVouchesByVoucher` | List who identity vouches for |
| `GET` | `/vouches?voucher=X&cooldowns=1` | `getVouchCooldowns` | Active cooldowns |

**Single active vouch (L-4):** each identity may vouch for at most one target
at a time (ARCHITECTURE invariant). `castVouch` rejects when the voucher has
ANY active VouchBox — not merely one for the same target — or any pending
vouch transaction in the mempool (`hasPendingVouch`). The pair-scoped
cooldown check (no re-vouch of the same target during its cooldown) is
**also a consensus rule as of P2-B phase 2** — the service check is now the
mempool-side mirror of the apply-time gate, not the only enforcement (see
"Vouch transition rules"). The single-active-vouch and pending-vouch checks
above remain service-layer policy.

> ✅ **The demo UI builds and signs both transactions.** `buildVouchTx` and `buildUnvouchTx` in
> `node/public/index.html` construct them, `signTxId` signs, and both handlers POST `{ tx }`.
> Unvouch resolves the VouchBox id from `GET /vouches?voucher=` — the only arm carrying `boxId` —
> **at click time**, since a box can be spent between opening a profile and pressing the button.
>
> ⚠ **The page's builders are pinned to the consensus rule, not merely present.**
> `test/unit/ui-crypto-mirror.test.ts` lifts both out of the page **by name** and pins
> `ui.computeTxId(pageTx)` against `computeTxId(jsonToTx(wireForm))` — the digest a vouch
> signature is actually over — and `test/routes/vouches.test.ts` drives the same lifted builders
> through the live routes. A re-implementation of the page's arithmetic in a test would pin
> nothing; lifting by name is what makes the page the subject.

**The JSON edge (rides the tx-envelope bundle):** `jsonToTx`'s
`BINARY_BOX_FIELDS` lacks `voucherId`/`targetId`, so even a correctly built
vouch-cast tx arrives with those two fields as hex *strings* and dies at the
step-4 schema (`bytes32`) — the cast is inexpressible over HTTP JSON. The
bundle adds both entries (sender+receiver: the UI's `canonicalBoxBytes`
mirror already lists them) plus route tests through the JSON edge for cast
and unvouch. `GET /vouches?voucher=X` gains a `boxId` per entry — the future
unvouch builder must name the VouchBox it spends, and no read surface exposes
box ids today.

**Route error policy (L-12):** services signal intentional, client-safe
rejections with a typed client-error class; route handlers return its message
with the mapped status (400/404/409). Any other thrown error returns a
**generic** body (`{ error: "Internal error" }`, 500) and is logged
server-side with full detail — `err.message` from unexpected errors never
reaches a response. `MempoolFullError` maps to 503 with a generic
"mempool full" body. Applies to all tx-submitting routes (posts, likes,
invites, vouches, credits, faucet, prune).

### Pruning

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts/:id/prune` | `{ rootPostHash: hex, authorId: hex, subtreeMerkleRoot: hex, subtreePostIds: hex[], signature: hex(128) }` | `{ status: "deleted", entryId: hex, postId: hex, replyCount: number }` (201) | 400 if post is not root (has parent), 403 if not author, 404 |

**Prune flow:**

1. Client walks reply subtree locally, builds Merkle root over postIds,
   signs `blake2b512(rootPostHash || subtreeMerkleRoot).subarray(0,32)`
   with Ed25519 key
2. Node verifies: post exists and is live, author matches, signature valid,
   subtreePostIds match actual reply tree, Merkle root matches postId list
3. Node builds PruneEntry, enqueues in mempool. Nothing is broadcast at
   this point — the prune propagates inside the ordering block that carries
   it, and each node derives its own stump at settlement (see below)
4. At block application: verify authorship binding (`entry.authorId` equals
   the `block_topology`-recorded author of `rootPostHash`; reject the block if
   no topology row exists — an unconfirmed root is not prunable), verify
   signature, verify topology via block_topology CTE, verify Merkle root,
   settle UTXO deterministically — the settlement transaction consumes the
   subtree's PostLockBoxes and refunds **every lock owner except
   `entry.authorId`**, whose own locks go to the pool — and delete the
   subtree's like-records (journalled, so a reverted prune restores them),
   insert the Stump derived from the verified entry
   (**unconditional** — a node holding no DAG content records the same
   stump), then prune DAG content when present.
   **The stump's `upvoteCount` is the like tally of the pruned subtree**: the
   count of like-records the deletion removed, the root's likes included
   (`replyCount` counts replies, so it excludes the root). Like-records derive
   from applied blocks, so the count is the same on every synced node, and a
   reverted prune restores the exact rows — a re-apply recounts the identical
   set

**Stumps are derived state.** A `dag_stumps` row is a local projection of a
PruneEntry inside an applied ordering block — never information in its own
right. `insertStump` has exactly one caller: prune settlement in block
application. No network input writes the table. Inbound stump gossip is not
consumed, and no stump pull protocol exists: a gossiped stump is unverifiable
by construction (it carries neither the author signature nor
`subtreePostIds`, so a receiver has nothing to check it against), while the
table it would write is trusted by both the read API (`getPost` resolves
stumps) and the relay verifier (parent-existence, step 8) — which is why
nothing unverified may reach it (audit F-api-20, and the sweep-response
variant found alongside it: a peer answering a stump pull could return
entries that were never requested, each stored and its prune replayed
against live content).

### UTXO queries

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/karma/:userId` | `{ userId: hex, total, boxes: [{ boxId, value }] }` | — |
| `GET` | `/credits/:userId` | `{ userId: hex, total, boxes: [{ boxId, value, lockedUntilBlock? }] }` | — |
| `GET` | `/invites/:userId` | `{ bonds: [{ id, value, inviterId, inviteePublicKey }] }` — a bond IS the open invite; there is no second list | — |

Multi-box UTXO model — identities can hold multiple karma/credit boxes.
`total` is the sum across all boxes. **`value` and `total` are decimal strings** in
the JSON (box values are `bigint`; JSON cannot carry one) — clients parse them with
`BigInt(...)`. Applies to every response carrying a `value`/`total` (`/karma`,
`/credits`, `/status` totals, mining template, etc.). See "Values are BigInt (P0)".

### Credits (testnet)

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/credits/transfer` | `{ tx: UtxoTransaction }` — client-built, client-signed | `{ status: "pending", txId, expiresAtHeight }` | 400 on invalid tx or signature |
| `POST` | `/credits/faucet` | `{ to: hex }` | `{ amount, txId }` | 403 if not testnet, 409 if already funded |

**A credit transfer is a transaction, and it settles when it is mined**
(P2-B phase 3). The client builds and signs it; the node decodes it with
`jsonToTx`, validates it with `validateTx`, pools it with `insertUtxoTx` and
relays it with `net.broadcastTx` — the same path invites, vouches and likes
already take. Credits move at block application on every node, not when the
HTTP call returns.

This replaced a handler that took `{ from, to, amount, signature }` and
**rebuilt the transaction server-side**, which was wrong twice over:

- **It bypassed consensus entirely** (audit F-consensus-7). `sendCredits`
  called `consumeBox`/`insertBox` directly with no block and no open journal,
  so the transfer entered no block, produced no journal entries, and never
  reached the AVL feed. The node's digest kept matching its peers while its
  box table did not, and the divergence surfaced at the next restart — when
  the prover re-bootstraps from `getUnspentBoxes()` and every later block
  fails its `stateRoot` check. A permanent self-fork with a cause hours old.
- **It duplicated transaction construction.** The demo UI already built the
  complete transaction and signed its id, then discarded it and sent the
  parts; the node rebuilt it. Box-selection order, output shape and field
  order had to agree byte-for-byte across two implementations or the
  signature stopped verifying, and nothing tested that. The client-built
  form deletes the second implementation rather than documenting it.

`expectedHeight` is gone. Since Spec G no output carries a height, so the
transaction and its id are height-independent and the parameter pinned
nothing.

### Blocks

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/blocks/:height` | OrderingBlock object (JSON with hex fields) | 400 if NaN, 404 |
| `GET` | `/blocks/current` | `{ height, hash }` — **`hash` is nullable** | — |

**`hash` is `string | null`** (Phase 1f). It is `blockHash` of the stored tip
header, and that function returns `null` for a header outside the encodable domain
(`VALIDATION_INTERFACE` → `blockHash`). A stored tip cannot be outside it — every header in the
store passed `verifyOrderingBlockStructure` at apply, whose header checks *are*
`verifyHeaderFieldDomains` — so `null` here means the node's own chain state is corrupt.

It is exposed rather than suppressed deliberately. The alternatives were a 500, which conflates
"corrupt state" with "request failed", and a fabricated placeholder hash, which is the class of
lie this whole bundle exists to remove. A client seeing `null` learns something true.

### Faucet

**The node serves no faucet, and holds no key it could sign one with.** `POST /faucet` and
`POST /credits/faucet` do not exist; both answer 404 on every network.

A faucet is an **ordinary account** whose secret lives in a service outside the node. Genesis seeds
that account's karma and credit boxes on the networks whose profile names a `faucetPublicKey`;
mainnet's does not, so no faucet identity exists in mainnet state. **Absence of the field is the whole
of the gate** — the seeded boxes reach `genesisStateRoot`, so a node that invents a faucet identity
computes a different root and cannot join the network. The gate is chain-committed rather than read
from configuration, which is what distinguishes it from the allow-list it replaced.

**The two assets reach a newcomer by different routes, and the difference is a property of the
assets.** Credits are tradeable, so the service sends them by an ordinary owner-signed transfer and no
rule is involved. Karma is non-transferable, so it cannot be sent at all: the service **invites**, and
the block's settlement grants the invitee out of the supply pool. There is no karma transfer to
perform, and no exemption that would make one legal.

⛔ **A user transaction may never name the karma pool.** The settlement is the pool's only spender and
it spends once per block, from state fixed before the body applies — a second spender names a box the
settlement already consumed, and the loser is permanently invalid rather than deferred. **A faucet
transaction drawing on the pool directly is unbuildable, whatever authorises it.** That is why the
faucet is a client of the invite grant rather than a transition of its own.

⛔ **No privileged key is representable.** `getSystemKeypair`, `signWithSystemKey`,
`initSystemKeypair`, the `system_keypair` row and `isSystemBox` are gone, along with the same-owner
karma exemption `isSystemBox` gated. No consensus rule resolves against a configured key.

**Idempotency is consensus state, not a ledger.** An invite may name only a key holding no identity
record, checked in the invite transition — so an identity is granted once, ever, from state that is in
the AVL root and reads the same way on every node. The `faucet_grants` table is gone: a node-local row
cannot decide a validity question identically across a network, which is the property that made the
grant ledger unusable as a consensus input.

### Mining

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `GET` | `/mining/template` | `?miner=hex(32)` optional payout override | Template (nested header + body sections + `powPreimage`) — see `MINING_INTERFACE.md` | 400, 401, 404 |
| `POST` | `/mining/submit` | `{ powNonce: number, height: number }` | `{ blockHash, height }` (201) | 400, 401, 422 |

Mounted **only** when `NODE_ROLE=miner`. A miner node is by definition one
that serves templates — the node holds no solver of its own. That role requires
a configured non-empty `MINING_SECRET` — startup fails otherwise; there is no
unauthenticated passthrough. Every request needs
`Authorization: Bearer <MINING_SECRET>` (constant-time comparison), and the
`?miner=` coinbase payout override sits behind that auth (audit M-7). Full
endpoint semantics in `MINING_INTERFACE.md`.
### Status

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/status` | `{ networkType, blockHeight, postCount, pendingPosts, totalKarma, liquidKarma, totalCredits, inviteProbationBlocks }` |

> ⚠ **`totalKarma` is karma in existence; `liquidKarma` is karma its owner can spend now.**
> `totalKarma` sums the karma-bearing types; `liquidKarma` sums `karma` alone. `credit` is the
> other ledger and `genesis_proof` holds no value on either.

#### Three karma sets, and none derives from another

**Each is a different question, and a box type may answer them differently:**

| Set | Answers | Read by |
|---|---|---|
| the **transition** set | may a karma spend create this box type? | `utxo-engine.ts`'s karma transition arm |
| the **supply** set | does this box type's value count as karma that **exists**? | `getTotalKarma` |
| the **conservation** set | does this box type participate in the total that **never changes**? | the axiom's check (ARCHITECTURE → The conservation axiom) |

⛔ **`karma_pool` IS THE FIRST TYPE WHOSE ANSWERS DIFFER, AND IT IS WHY THE THIRD SET EXISTS.**
Transition **no**, supply **no**, conservation **yes**. Every earlier case had the answers coincide,
so a single shared list happened to be right; here it would be **actively wrong**.

⛔ **THE CONSERVATION TOTAL IS `circulating + pool`, AND IT IS A DIFFERENT SUM FROM `getTotalKarma`.**
Measured, not reasoned: a like burn given a correct pool sink — consume `karma(40)`, insert
`karma(39)`, consume `pool(P)`, insert `pool(P+1)` — still moves the circulating accrual by `−1`,
because the pool is deliberately outside the supply set. ⚠ **So "the circulating delta is zero at
every commit" is NOT the axiom's check** — it is true only while nothing can name the pool, and it
stops being true the moment anything legitimately does. **Do not use the supply accrual to assert
conservation.**

⛔ **NEITHER SET MAY BE DEFINED AS THE OTHER, OR DERIVED FROM IT.** They hold the same members
today, and they hold them **for two different reasons** — every karma-bearing type currently happens
also to be one a user transaction may create. That coincidence is a fact about the present type
list, not a rule, and a single shared constant encodes it as though it were one.

⛔ **A KARMA-BEARING TYPE CAN BELONG TO NEITHER SET, AND `karma_pool` IS ONE.** The karma supply
pool holds the karma not in circulation and is spent **only by the block's settlement
transaction** — it never reaches `validateTx`. So it joins `genesis_proof`, `emission` and
`treasury` in being **barred from both transaction positions**, which puts it outside the
transition set; and its value must **never** reach `totalKarma`, which reports circulation and
would otherwise overstate it by the entire uncirculated supply — that puts it outside the supply
set.

⚠ **Membership is therefore three-way, not two.** "Which of the two lists?" is the wrong question to
ask of a new box type. The right one is asked twice, independently: *may a karma spend create it?*
and *does its value count as karma that exists?* — and **both answers may be no.** That is exactly
what a single shared list could not express, and it is the reason the two exist even while their
members coincide.

✅ **The credit ledger already works this way, and it is the precedent.** The credit transition arm
names its allowed outputs **inline** (`credit` or `fee`), and `getTotalCredits` keys on `credit`
independently. Neither reads the other, so `emission` and `treasury` are not *excluded* from the
credit supply — they were never in it. `getTotalCredits`'s own comment states the discipline:
*"Keyed on `credit` by name rather than by excluding them, so a later credit-bearing box type is a
deliberate addition here."* **An allow-list per question, never one list per ledger.**

⚠ **A fixture assertion pins the supply set and must say so.** `blocks.test.ts` asserts that the box
types it seeds equal the karma family; keyed on the transition set it turns red when a
transition-only type is added and invites the wrong repair — adding a fixture, which is exactly the
defect. **It belongs to the supply set.**

> ✅ **RESOLVED — `inviteProbationBlocks` is served. Verified 2026-08-11.** This read
> `AHEAD OF CODE` until Phase 9. The node resolves it from the network profile in
> `node/src/config.ts` and serves it from both `node/src/server.ts` and the status route in
> `node/src/routes/blocks.ts`; the demo UI consumes it rather than holding a constant.
> Confirmed against the running node as well — `notis.fun/testnet/api/status` returns
> `inviteProbationBlocks`. A plain `number`, not a decimal string: unlike `totalKarma` /
> `totalCredits` it is not a `bigint` server-side.
>
> **Why a per-network value has to be served rather than known.** ⚠ **The instance below is
> historical and its mechanism is gone** — there are no bond commits, and a bond carries no
> probation window for a client to reproduce. It is kept because the RULE it illustrates is live
> and the field is still served: the probation length now dates a bond's settlement through
> `IdentityRecord.invitedAtBlock`, so a client that wants to *display* when a bond settles still
> has to learn it from the node.
>
> The original instance: the UI built bond commits, `utxo-engine` required the window to equal
> `config.inviteProbationBlocks` **exactly**, and the UI hardcoded `1000`. That agreed on every
> network only while the node also read the constant — once the node resolved the field from the
> network profile, a devnet node wanted `10` and every devnet bond commit was rejected.
>
> The general rule this instance is an example of: **a per-network consensus value the client must
> reproduce is served by the node, never held as a client constant.** A client constant is a second
> source for a value `NETWORK_TYPE` is
> supposed to select alone, and it fails silently — the UI has no way to learn it guessed wrong,
> because the rejection arrives as a generic invalid-transition error.
>
> The UI reads it with a `1000` default, matching the safe-failure direction of its existing
> `networkType || 'mainnet'`.

> ✅ **`networkMode` → `networkType` landed in P2-A phase 4**, in the same commit as the demo
> UI change because renaming a response field is a breaking API change. `totalKarma` and
> `totalCredits` are **decimal strings**, not numbers — they are `bigint` server-side and
> JSON has no such type. The parked e2e harness's `waitForReady` picks up the new name when
> it is rewritten (`test/e2e/README.md`).
>
> ✅ **`identityCount` is gone, 2026-08-07.** The demo UI used to render `s.identityCount` in
> its status bar — a field this endpoint has never emitted — so a live node showed
> "Identities: **undefined**". Its only producer was `src/routes/status.ts`, a router that was
> **exported and never mounted**, querying three tables that do not exist (`blocks`, `posts`,
> `identities`). Both the UI row and that file were deleted. `/status` did **not** gain the
> field: there is no identity table by design. The residue came from an abandoned design in
> which the node generated keypairs server-side, which is also why the dead router expected an
> `identities` table.

### Link previews

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/preview/:id` | OG-tagged HTML page with JS redirect to the demo UI |

### Static

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/` | Demo UI (`public/index.html`) |

---

## Verifier Contract

`verifyPost(deps, post: Post): { valid: boolean; error?: string }`

Verification order (fail-fast):

0. **Field domains** — `verifyPostFieldDomains`. The precondition, not a
   courtesy: fixed-width writers throw on out-of-domain input, so the domain is
   established before the payload can reach `computeTxId`
1. **Content** — 1–`MAX_CONTENT_BYTES` UTF-8 bytes, non-empty; then the
   character restrictions (no control, zero-width, or bidi characters)
2. **Parent refs count** — at most `MAX_PARENT_REFS`
3. **Protocol version** — strict equality with `PROTOCOL_VERSION`
4. **Karma** — the author's **summed** karma must cover the lock: threads (no
   parentRefs) ≥ `POST_LOCK_THREAD_COST`, replies ≥ `POST_LOCK_REPLY_COST`.
   ⚠ An early, friendlier rejection, NOT the enforcement point — the engine's
   post biconditional is what a block re-validates
5. **Parent refs existence** — every referenced id resolves to a post or stump

There is no challenge, no PoW and no signature check: authorship is the creating
transaction's signature over its `TxId` ("Post transactions"), and a parent
ref's id cannot be recomputed from the parent post — a post id is
provenance-derived, so the store's recorded id is the only statement of it and
existence is what remains checkable here.

---

## UTXO Engine Contract

The UTXO engine manages box lifecycle, transaction validation, and
conservation rules. Karma sufficiency is judged against the **effective**
value (`ARCHITECTURE` → Karma decay); conservation is checked over face
values. The engine is split into three functions:

### validateTx

```
validateTx(deps, tx: UtxoTransaction, currentBlockHeight: number): UtxoResult
```

Full read-only validation. Performs all checks without modifying state. The
step numbers below are the code's own — one numbering, shared by every
citation of a `validateTx` step in this repo:

0. Transaction envelope shape (`checkTxEnvelope`, its own section below) —
   ahead of every other read of `tx`.
1. No duplicate input box IDs
2. All input boxes exist and are unspent
3. Spend timing: no input is spent before the unlock height its type states
   (see "Spend timing" below). Runs ahead of authorization — timing is
   cheaper than signature verification and refuses a transaction that cannot
   succeed either way.
4. All inputs have the same boxType
5. Output shape: every output is a non-null object matching the closed
   per-boxType schema — exact key set and every field's runtime type (see
   "Output shape" below). This is the **first step that reads `tx.outputs`**:
   steps 6–9 operate on outputs whose
   structure and field types are already pinned, and may dereference output
   fields freely. (Step position changed by the field-type pin — the check
   originally ran last; see the placement note in "Output shape".)
6. No output claims a height the chain has not reached:
   `createdAtBlock <= currentBlockHeight` for every output. One-directional —
   backdating an output is bounded only where a rule deriving from the field
   imposes its own check (TYPES_INTERFACE → BoxCandidate; the vouch cast
   window under "Vouch transition rules" is one).
7. Value conservation: `sum(input values) == sum(output values)` **across the
   transaction as a whole — one total per side, not per box type —
   unconditionally. The exception list is empty.** Every user transaction's
   cost lands in a box the transaction itself outputs: a like's in its
   `LikeAccrualBox`, an unvouch's stake in its `VouchEscrowBox`, a credit fee
   in its `FeeBox` — so the sums balance with no carve-out
   (`ARCHITECTURE → The conservation axiom`: every operation names a source
   and a sink).

   > ⛔ **PER-TYPE EQUALITY WOULD REJECT MOST KARMA TRANSACTIONS.** Value
   > changes **form** inside the karma family: an invite is
   > `karma(K) → karma(K−B) + bond(B)`, which conserves as one
   > total and fails per type. Posting and vouch casting have the same shape.
   > Step 4 constrains the **inputs** to a single box type; the outputs
   > deliberately span several, and `checkValueConservation` reduces each side
   > to one `bigint` with no type predicate anywhere in it.

   > **A whole-input fee is expressible, and the encoding is worth knowing.** An
   > output `value` is a **non-negative** `bigint` (step 5's schema, `u64`), so
   > `credit(X) → fee(X)` pays the entire input and conserves. What the transition
   > rules refuse is the zero-**length** output list — a constraint on the output
   > list's shape, not on the fee's size. **The two are independent, and reading the
   > first as bounding the second is wrong.**

   > ⛔ **AN EMPTY EXCEPTION LIST IS WHERE THE LIKE LOSES ITS ARITHMETIC PROTECTION.**
   > While the like's cost was a deficit, an imbalance was **self-announcing** — the
   > conservation check fired on it unconditionally and the only escape was matching
   > the like shape exactly. A balancing marker removes that trigger, so the like's
   > cost is enforced by **shape the validator must be told to look for** rather than
   > by arithmetic it cannot be talked out of. That is why the marker biconditional
   > runs in BOTH directions (step 9's like rules):
   >
   > 1. `likeTarget` present ⟺ exactly one `LikeAccrualBox` output of exactly
   >    `LIKE_KARMA_COST` naming the target post's author;
   > 2. a `LikeAccrualBox` output present ⟺ `likeTarget` present, the marker
   >    naming that target's author.
   >
   > ⚠ **Without (2) the marker is a karma transfer primitive.**
   > `myKarma(K) → myKarma(K−n) + LikeAccrualBox(n, author=Bob)` **balances**, carries no `likeTarget`,
   > and pays Bob at settlement. Karma is non-tradeable (§Karma transition rules' same-owner rule;
   > `ARCHITECTURE` → Invariants), and a marker is by construction a karma-bearing output earmarked
   > for someone else — **the exact shape that rule forbids, arriving as a new exemption.**
   > It would also let karma paid diverge from likes recorded: a marker without a
   > `likeTarget` pays an author with no like-record behind it, and
   > `IdentityRecord.lifetimeLikesReceived` is what settles bonds.

   Karma and credit mint and burn happen only in
   block-application paths (the settlement transaction's outputs, decay),
   never inside a user transaction. The `value` **type** bound (non-negative `bigint` base units
   `< BOX_VALUE_BOUND` — a negative value could otherwise balance the sums while minting
   into a sibling box) is pinned by step 5's schema; conservation owns the
   **sums**. `assertValidBoxValue` remains at the JSON→tx boundary as the
   HTTP-edge early reject of the same rule — an ergonomics twin, not the
   consensus gate. Conservation sums are `bigint` (P0 — see "Values are BigInt")
8. Authorization: the transition's requirement is satisfied (signatures verified
   against tx hash)
9. Legal box transitions (per the transition table below)

Returns `{ valid, error?, computedOutputs?, txId? }`. On success, `computedOutputs`
contains boxes with pre-computed IDs (for use by `applyTx`), and `txId` is the
deterministic transaction ID.

**Used at pool entry** for ideal validation (though currently gated by signing
mismatch — see Known Gaps in SESSION_CONTEXT.md).

### Spend timing (`SPEND_TIMING`)

**When a box of this type may be spent — the third table keyed on `boxType`,
beside `AUTHORIZATION` and the output-shape schema.** Each entry either states
the box's unlock height or declares it always spendable. Typed over every
`boxType`, so a new type fails to compile until its timing is stated — the
obligation `AUTHORIZATION` carries for the signer and the schema for output
shape.

⛔ **It is a table because its members read DIFFERENT fields** —
`credit.lockedUntilBlock` and `vouch_escrow.releaseAtBlock` — so a check keyed
on one field name silently admits the other. The property is *"this type has an
unlock height"*, never *"this field is present"*.

The two entries with a clock:

| Type | Unlock height | Absent means |
|---|---|---|
| `credit` | `lockedUntilBlock` | spendable — most credit boxes carry no lock; only the coinbase's do |
| `vouch_escrow` | `releaseAtBlock` | — (the field is required) |

Every other type is always spendable *at this gate*: most timed boxes
(`bond`, `post_lock`, `emission`, `treasury`, `karma_pool`, `like_accrual`)
are `BLOCK_APPLICATION_ONLY`, so their timing is enforced by no user
transaction being able to name them at all. This table exists for the types
that must be **user-spendable and carry a clock**.

**Checked once per input at `validateTx` step 3**, after liveness (its only
precondition) and before authorization: timing is cheaper than signature
verification and refuses a transaction that cannot succeed either way.

⛔ **A tightening.** A historical block containing a premature spend would be
rejected on resync; testnet and devnet wipe at deploy and mainnet does not
exist, so nothing is stranded — but it is a consensus break, not a refactor.

### Genesis proof boxes are never in a transaction

**A `genesis_proof` box may never appear as a transaction input or an output.**
It is written by genesis seeding and readable forever. Without the output half,
any user sprays unbounded opaque blobs into the UTXO set through an ordinary
transaction; without the input half, the one box that defines a network can be
spent away.

**The rule has two halves and they cannot share a home.**

| Half | Home | Keyed on | Why it can only go there |
|---|---|---|---|
| not an **output** | `validation` (relay gate), and node's twin in `checkOutputShape` | `boxType` | A candidate output is a whole box, so typing it needs no state. Every other field is attacker-supplied and unchecked until after the type is known, so the type is the only trustworthy property at this site. |
| not an **input** | `node`, in the authorization rules | the **transition** | `tx.inputs` are box **id strings**; typing one requires the UTXO set. An input box always comes out of the store, so its type is known by construction. A type is barred from inputs by **no transition admitting it**, which is an absence rather than a rejecting arm. |

✅ **A type barred from inputs needs no edit to be barred.** `genesis_proof`, `emission` and
`treasury` are unspendable because nothing names them as a legal input, and a *new* barred type
inherits that by saying nothing about it. The bar is the default, and admitting a type is the
deliberate act.

> ⛔ **The two halves of a both-positions bar cost differently, and only one is free.** The
> **input** bar is inherited by saying nothing. The **output** bar is not: `OUTPUT_SHAPE` is keyed
> on an `Exclude`, so a new type compiles as *requiring a shape* until it is named in that
> exclusion — which is the deliberate act the `Exclude` exists to force. **One edit, not two, and
> not zero.**

`OUTPUT_SHAPE` is keyed on `Exclude<AnyBox['boxType'], 'genesis_proof'>`, so the
exclusion is a type error to undo rather than an omitted entry indistinguishable
from a forgotten one — while a *new* box type still fails to compile until it is
given a shape. `checkOutputShape` names `genesis_proof` in its own reject arm
ahead of the table lookup: the verdict would be identical either way, but an
assigned tag refused by protocol rule is not an *unknown* one, and a test
asserting rejection must be able to assert which rule rejected.

The `emission`, `treasury` and `karma_pool` types join `genesis_proof` in being
barred from both transaction positions: no transition admits one as an input and
no user transaction may output one. They are created at genesis seeding or as
settlement outputs, and the settlement transaction is the only thing that spends
any of them (`genesis_proof` is never spent at all).

### Output shape — the closed per-boxType schema (field-type pin)

Transaction outputs are attacker-controlled structure (HTTP JSON through
`jsonToTx`, gossip and block-embedded CBOR), and two of their bytes-level
consumers hash **whatever keys the object carries**: `canonicalBoxBytes` (the id
preimage) strips only `id`/`txId`/`index`, and `serializeBox` (the AVL leaf, so
the `stateRoot`) strips only `id`/`boxType`. Nothing between ingress and those
encoders constrained the shape: transition rules filter on `boxType` and
`checkOutputValues` reads `value`.

`validateTx` therefore rejects any output that does not match the **closed
schema for its `boxType`**:

- **Key set is exact.** Required fields present, no key outside the declared
  set (`TYPES_INTERFACE` box definitions are authoritative; declared-optional
  fields — `KarmaBox.nonActivity`, `CreditBox.lockedUntilBlock` — may be present
  or absent, nothing else may vary). A key the schema does not name is a
  reject, not a strip: a stripped key would change the bytes the client signed.
  > **`fee` is user-created and consumable only by block application**, which is
  > the shape `bond` and `post_lock` already have: a user transaction creates the
  > box, and only block application may consume it. The schema below has a row for
  > every boxType a user transaction may emit — `fee` makes seven. `genesis_proof`,
  > `emission` and `treasury` have none, because no transaction may create them.
- **Field types are pinned** (field-type pin). Every present field's runtime
  type matches its `TYPES_INTERFACE` box definition:
  - `bigint`, `0 ≤ v < BOX_VALUE_BOUND` (TYPES_INTERFACE → "Box value domain"):
    `value` (every boxType) **and `originalValue`
    (post_lock — the read-poison field)**. The bound is absorbed from
    `checkOutputValues`, which retired with this pin (one owner per rule;
    `json-to-tx`'s `assertValidBoxValue` stays as the HTTP-edge twin).
  - 32-byte `Uint8Array`: `owner` (karma, credit, post_lock), `inviterId` and
    `inviteePublicKey` (invite, bond), `voucherId`, `targetId` (vouch). The
    empty state went with the commit transition, so `inviteePublicKey`'s length
    is no longer a transition-arm question and `bytes0or32` has no user.
  - Non-negative safe integer, and never `-0`: `lockedUntilBlock`
    (credit, when present). `-0` is called out because it is JSON- and
    CBOR-reachable and breaks byte round-trips: cbor-x encodes it as a float
    where the store's JSON round-trip returns integer `0`.
  - `string`: no box field carries one. `targetPostId` was the only entry and it
    is deleted with the field (TYPES_INTERFACE → PostLockBox) — the circularity,
    not a domain fix. Kept as a row because the *kind* is still part of the
    schema vocabulary.
  - `boolean`: `nonActivity` (karma, when present).
- **Unknown `boxType` is a reject — and the schema lookup is an own-property
  lookup** (`Object.hasOwn` or equivalent), never a bare index into the
  table: `boxType: 'constructor'` must land in the unknown-boxType reject,
  not retrieve `Object.prototype.constructor` and throw downstream. A
  non-object or `null`/absent-`boxType` output entry rejects through the
  same arm. With the check at step 5 this arm is **reachable** and is the
  primary gate — the transition arms' own unknown-type rejections
  (karma/credit totality counts, `outputs.length` pins), which made it
  unreachable while the check ran last, are now the defense-in-depth
  layer behind it.

**Why this is a consensus rule and not input hygiene:** an accepted stray key
produces a stored box whose committed bytes — id preimage and AVL leaf both —
disagree with every later reconstruction of it, because `rowToBox` rebuilds from
the typed row. The store and the tree then permanently disagree about the box's bytes.
That is the unpinned-field class (P2-B found six instances, F1 a seventh, this
is #8), and the divergence surface under journal replay and any future
snapshot sync. Ergo closes the whole class structurally — its wire format is a
closed positional schema with no maps, so a stray field is unrepresentable and
the spending condition *is* content (the ErgoTree itself: hashed = stored = enforced); its
Rust implementation additionally recomputes every box id from re-serialized
bytes at each deserialization boundary and hard-errors on mismatch. This check
is the same move at our one open edge.

Placement: `validateTx`, so pool entry, gossip relay, and block finalization
(which re-validates every embedded tx — step 5) all inherit it from the single
site. A JSON-edge-only check would leave the CBOR paths open.

**Within `validateTx` the check runs at step 5** — before conservation,
authorization, and transitions, as the first consumer of `tx.outputs`. Steps 6–9
dereference output fields under a schema guarantee instead of defending
per-site: the alternative — per-arm guards before every
`Buffer.from(karmaOut.owner)`-shaped read — scatters the totality obligation
across every current and future transition arm, which is precisely the pattern
by which the unpinned-field class keeps producing (an arm added later forgets
its check). One gate, ahead of all semantic rules, is Ergo's
serializer-is-validator shape: parse-time strictness first, semantics after.
Consequence of the move: rejections that previously surfaced arm-specific
errors on *malformed* outputs now surface shape errors; the accepted set for
well-typed outputs is unchanged (the invariance pin — every id- and
root-asserting test passes unmodified).

**Totality.** With the schema at step 5, `validateTx` returns
`{valid: false}` and never throws for **any** contents of `tx.outputs` —
arbitrary decoded CBOR/JSON values, missing fields, wrong types, `null`
entries, unknown or prototype-colliding `boxType`s — provided the tx envelope
itself is structurally well-formed. Four live failure classes on the pre-pin
tree collapse into clean rejections:

1. **Validate-time throws** — transition arms dereference output fields
   (`Buffer.from(karmaOut.owner)` and seven sibling sites across the cancel,
   reveal, karma, vouch, creation, commit, and settlement arms), so a missing
   or non-buffer field TypeErrors out of `validateTx` (HTTP 500; the block
   funnel's totality catch converts to a block rejection).

> **What the funnel's totality catch is FOR** (Phase 1f), stated because it was never written down
> and the omission produced a real disagreement.
>
> The catch converts an unexpected failure during apply into a block rejection, so that **no block a
> peer can construct takes the node down**. Every instance documented in this contract is of that
> kind: a poisoned tx that TypeErrors out of `validateTx`, two byte-identical boxes colliding on a
> primary key, a stored lie that throws at read time. The property is *totality with respect to
> untrusted input*.
>
> **It is not a promise that no condition may halt the node**, and a whole *class* of conditions
> deliberately does. **The allowlist keys on `CorruptChainStateError`, the base class — not on any
> one subclass** — which is the property `corrupt-state.test.ts` pins as *"a third kind must not need
> a boundary edit to be fatal"*. There are now **four** subclasses, and that test's design intent has
> been vindicated twice: the third and fourth cases each needed **zero** boundary edits.
>
> | Subclass | Raised when | Raising site |
> |---|---|---|
> | `UnhashableStoredHeaderError` | a header already in our store cannot be hashed | ⚠ **now dead `src`** — see below |
> | `MissingStoredBlockError` | a block the chain refers to is absent from the store | store |
> | `UnreadableStoredBlockError` | a stored block's bytes will not decode | `store/ordering.ts` → `rowToOrderingBlock` |
> | **`DivergedStateTreeError`** | **the AVL+ tree refuses an operation the UTXO store implies must succeed** | **`state/avl-prover.ts`** |
>
> The class is outside the totality property's scope by construction, and the argument is about
> **provenance, not validation** — but it takes two shapes, and only the first is about bytes.
>
> **Stored bytes: peer bytes are never stored.** The provenance claim is stated once, on
> `createOrderingBlock` in `node/src/store/ordering.ts` — one INSERT, one `src` caller, this node's
> own re-encoding of an already-decoded block — and that statement carries the re-derivation,
> because neither obvious grep reproduces it. An attacker inverting it would have to make our writer
> emit bytes our reader rejects: a bug in us, which is what fail-stop is for.
>
> **Two stores disagreeing: neither arm is reachable from peer input.** `DivergedStateTreeError`
> examines nothing a peer sent — it fires when the AVL+ tree and `utxo_boxes` have drifted apart.
> See AVL+ State Root → "the tree is asked".
>
> **Both arms are enforced by the store**, and the enforcement is what puts the condition outside
> peer reach rather than an argument about the callers.
>
> The **`Insert`** arm: a duplicate box id dies on `utxo_boxes.id`'s primary key inside the applying
> transaction, before the prover feed is built from the journal.
>
> The **`Remove`** arm: `consumeBox`'s `UPDATE` carries `AND spent_at_block IS NULL` and refuses a
> zero row count, so a remove entry follows a spend that really happened. `recordBoxRemove` runs
> downstream of that check and has exactly one caller, which is what makes the primitive the sole
> gate rather than one of several. A consume naming an absent or already-spent id throws
> `BoxNotLiveError` inside the applying transaction, and the funnel's totality catch converts it to a
> block rejection — the same shape the `Insert` arm's constraint failure takes.
>
> ⛔ **A second remove of one id therefore cannot be journalled at all**, which is the property this
> arm rests on. Two mechanisms stop it reaching the store: within one transaction, `validateTx`
> step 1 rejects duplicate inputs; across two, the apply loop's liveness pre-check runs against state
> the loop is itself evolving, so the second transaction defers forever. **The primitive is the
> backstop under both**, and it has to be — `proverFeedFromJournal` cancels insert-then-remove pairs
> but does not dedupe repeated removes, so a second remove reaching the feed would reach the tree.
> A repeated consume costs the block, never the node.
>
> ✅ **The fee-box consume names ids from the block's own outputs**, inserted earlier in the same
> transaction, so it spends a live row like every other site. Its insert+remove pair nets out in
> `proverFeedFromJournal` and neither op reaches the tree: `fee-box-prover-feed.test.ts` proves both
> halves were journalled *and* that neither reaches either feed, the speculative or the applied.
> Change the netting and it goes red.
>
> ⚠ **The store is now a raising site, and that is the point.** An earlier draft of this section
> implied the boundary lives only at apply's callers. **It cannot.** By the time a `ReaderError`
> reaches `applyOrderingBlock`'s catch it is indistinguishable from the one `decodeTx` raises over
> the block's own `utxoTxs`, which are **peer-chosen and an ordinary rejection**. Only the store
> frame knows the bytes are ours. `rowToOrderingBlock` therefore catches **every** throw, not just
> `ReaderError`: the claim is about the bytes' provenance, which holds however the decoder fails, and
> narrowing to a class would leave a `TypeError` from a decoder bug misfiled as an arriving block's
> rejection.
>
> **Reach is the live argument, not the halt.** `getOrderingBlock` has **six** callers and only
> apply's read passes through a catch that could promote anything. `extendsOurTip` runs on the gossip
> path *before* apply and outside `handleOrderingBlock`'s inner try — a bare `ReaderError` there fails
> `failStopIfCorruptChain`'s `instanceof`, is re-thrown from an async handler, and ends the process as
> an **unhandled rejection**: no FATAL line, no site, no height. That is the "right end by the wrong
> mechanism" this file condemns elsewhere. A fix at the funnel would never have touched it.
>
> ✅ **`UnhashableStoredHeaderError` is unreachable from the store as of Phase 3b.** Every value
> `readVlqU` / `readHexN` / `readBytesN` can produce is already inside `verifyHeaderFieldDomains`, so
> **a stored header that decodes is always hashable** and `blockHash` cannot answer `null` on that
> path. The decode boundary subsumes the domain check — *the serializer is the validator*, arriving
> for the header. The type and its allowlist entry are deliberately left in place; removing them needs
> its own enumeration.
>
> **Why halting beats rejecting here.** A corrupt stored `prevBlock` would otherwise reject every
> subsequent block, forever, logged as "unexpected failure during apply". A
> node that stays up while rejecting everything is indistinguishable from a quiet network until
> somebody reads logs. The failure is fail-stop, deliberate, and diagnostic-first — a typed error
> carrying site and height as *fields*, an explicit boundary at every caller, and a log before exit.
> It is **not** an unhandled rejection, which is what it was when first written, and which would have
> silently become a swallow the moment any caller started awaiting.
>
> Adding a new escape from this catch is a consensus-visible decision and needs the same argument:
> show the condition cannot be caused by untrusted input.
2. **Apply-time throws** — fields no arm reads reach `insertBox`, which
   `Buffer.from`s them mid-block-apply (e.g. a numeric `post_lock.owner`).
3. **Read-time throws** — a stored lie poisons the row: `rowToBox` does
   `BigInt(e.originalValue)`, so `originalValue: "x"` crashes **every later
   read of that box**. Measured on the pre-pin tree: the poison block APPLIED
   through the real funnel, and the first like-settlement or prune touching
   the target post then threw mid-apply — caught by the funnel (block
   rejected, node survives), but every node stored the same poison, so the
   post becomes unlikeable and unprunable network-wide, a permanent per-post
   landmine. Restart recovers the process (the startup box scan died with
   P2-B phase 4) but never the row.
4. **Committed-byte lies** — a mistyped field enters the id preimage and the
   AVL leaf but round-trips differently through the store's JSON `extra_data`
   (a string `owner` becomes a char-array becomes zero-bytes;
   `-0` becomes `0`), breaking `computeBoxId(rowToBox(row)) === row.id`.

### Transaction envelope shape (`checkTxEnvelope`)

**Implemented 2026-08-08.** The pre-gate behaviour it replaced, all measured
rather than reasoned: `inputs: null` threw at step 1 (`tx.inputs.length`),
`inputs: 5` at `new Set(5)`, `inputs: [{}]` at the SQLite bind inside `getBox`;
a missing or `null` `signatures` map threw at `tx.signatures[hexKey]`;
`outputs: null` threw inside `checkOutputShape` itself, while a non-array
`outputs` *object* slipped that loop (its `length` is `undefined`) and threw at
conservation's `.reduce`; `likeTarget: null` passed conservation's
`!== undefined` presence test and threw at `h.update(null)` inside
`computeTxId` — which `checkAuthorization` calls on its FIRST line, so the whole
envelope reached the hasher at step 6 — and non-`Uint8Array` `preimages` values
threw there the same way. Every one was an HTTP 500 or, through the block
funnel, a whole-block rejection logged as an unexpected failure.

Two holes this contract had missed before the code was written, both measured
during it: **`protocolVersion` was validated nowhere** in the transaction path
(only block headers checked theirs), so a tx signed with
`protocolVersion: "x"` validated, pooled and applied end-to-end with the string
`String()`-coerced into its own id preimage; and an **unknown envelope key was
free malleability**, invisible to `computeTxId`.

`checkTxEnvelope(tx: unknown): UtxoResult` — **exported** from the engine.
**Total**: returns `{valid: false}` and never throws for any decoded-CBOR
value (error strings quote input via the total `describeValue`, never bare
`String(v)`). The envelope's key set is **closed** — an unknown key rejects.
`computeTxId` hashes only the known fields, so an extra envelope key would
otherwise be free malleability: two distinct CBOR byte strings carrying the
same txId.

The checks:

1. `tx` is a **plain** object: non-null, non-array, and its prototype is
   `Object.prototype` or `null`. The prototype clause is load-bearing and was
   added by the implementation, then ratified here: presence is decided with
   `Object.hasOwn`, while every downstream read (`tx.likeTarget`,
   `tx.signatures[hexKey]`) is a plain property access that walks the chain.
   Pinning the prototype is what makes the two agree — without it an object
   carrying the four required keys but *inheriting* a `likeTarget` passes a
   `hasOwn`-based gate and still drives `computeTxId` and the conservation
   carve-out off the inherited value. Note this does NOT rest on decoder
   behaviour: measured 2026-08-08, cbor-x does not set the prototype from a
   `__proto__` map key — it renames the key to `__proto_`, which lands in the
   closed-key-set rejection below — and `JSON.parse` defines `__proto__` as an
   own key. The clause closes the class structurally rather than trusting
   either decoder's sanitizing to stay as it is.
2. **Closed key set**: `inputs`, `outputs`, `signatures`, `protocolVersion`,
   optionally `likeTarget` and `post`. Any other key rejects.
   > ⛔ **`preimages` LEFT THIS SET, AND THE GATE ACCEPTED IT AFTER `computeTxId` STOPPED HASHING
   > IT. Corrected 2026-08-18.** The field is deleted (TYPES_INTERFACE → Layout — UtxoTransaction).
   > ⚠ **Node was conforming to this row while it was wrong** — the defect was the contract's, and
   > the exposed surface was the HTTP request body and the object `jsonToTx` builds. **The mempool
   > row, the gossip frame and every committed byte were clean**, because the pool stores
   > `encodeTx` output and the field had already left the codec. **Gate integrity, no value at risk.**
   >
   > ⛔ **A REQUIRED key with value `undefined` still rejects. An OPTIONAL one no longer does**, and
   > the reason is that this rule outlived its premise: under `cbor-x`, `undefined` **encoded** while
   > `computeTxId`'s presence test was `!== undefined`, so present-`undefined` hashed as absent —
   > two encodings, one hash, a real malleability. Under the positional codec `opt()` gives absence
   > **exactly one encoding**, so present-`undefined` and absent are indistinguishable on the wire and
   > refusing one refuses nothing the wire can express. ⚠ **The rule was correct when written and
   > nothing about it looked stale.**
3. `inputs`: an array; every entry a 64-char lowercase-hex string (the closed
   live set — `computeBoxId` emits nothing else). Emptiness remains step 1's
   rule ("at least one input"), not the gate's.
4. `outputs`: an array. Entries are NOT typed here — that is step 5's closed
   per-boxType schema. The gate only guarantees the iteration/reduce sites
   are total.
5. `signatures`: a plain object; every key a 64-char lowercase-hex string
   (an Ed25519 public key), every value a `Uint8Array` of length 64. An
   empty map is shape-legal; whether any transition's requirement can be
   satisfied with no signature is the authorization layer's question, not this
   gate's. Extra well-formed keys are shape-legal (authorization only
   looks up, nothing iterates; the like path's exactly-one-signature rule is
   `castLike`/gate-metadata policy, unchanged).
6. ⚠ **`preimages` — RULE DELETED with the field, 2026-08-18.** It required a non-empty object and
   refused present-but-empty, because under `cbor-x` `{}` and absence were two encodings of one
   `TxId`. The field is not in the id preimage, not in the type and not on the wire, so there is
   nothing left to constrain. ⛔ **The name stays reserved** — a future secret-carrying field would
   have to state what reads it, which is precisely what this one never did.
7. `protocolVersion`: an integer strictly equal to `PROTOCOL_VERSION`
   (decided 2026-08-08). Same strict-equality posture as posts and block
   headers — no version-keyed dispatch exists (repo-root warning), and this
   gate does not pretend otherwise. Rider: `jsonToTx`'s `?? 1` default
   becomes `?? PROTOCOL_VERSION`, so the HTTP edge cannot mint
   stale-version txs after a future bump.
8. `likeTarget`: absent, or a 64-char lowercase-hex string.

**Call sites (all of them, or the guarantee is path-dependent):**

- `validateTx` **step 0** — ahead of every other read of `tx`.
- The block funnel, immediately after `decodeTx` (`block-apply.ts`) — the
  funnel computes `computeTxId(tx)` for its id-equality check BEFORE
  `validateTx` runs, so the gate is what keeps that hash total. Its verdict
  there is **block rejection**, under the proof obligation stated at
  "Embedded transactions" below; it is not a per-tx skip.
- HTTP keeps `jsonToTx`'s friendlier per-field `ClientError` 400s; the gate
  backstops the two fields that today pass through on bare type assertions
  (`inputs`, `protocolVersion`) — the field-type pin's "HTTP ingress is
  shielded" claim was overstated.

Gossip needs no separate call: its intake reaches `validateTx`. (Today a
malformed gossiped tx throws into `gossip.ts`'s topic-dispatch catch and is
silently swallowed under a comment attributing it to decode failure; with the
gate it becomes a logged rejection like any other.) `fork-resolution`'s
mempool reinsert decodes CBOR the node itself produced from once-valid txs —
outside the gate's call list, deliberately.

**Consensus scope:** a validation tightening in the same class as the field-type
pin — honest bytes unmoved; txs that previously
applied while carrying envelope garbage (junk `protocolVersion`, stray keys)
become rejections. Covered by the standing fresh-chain gate.

### revalidateTxInContext

```
revalidateTxInContext(deps, tx: UtxoTransaction, currentBlockHeight: number): UtxoResult
```

Lightweight liveness-only re-check (are inputs still unspent?). **Not sufficient
for block application on its own** — a permissionless block producer can embed a
tx that never passed pool entry or relay validation, so authorization, transitions,
and conservation must NOT be assumed. Block finalization fully
re-validates every embedded tx with `validateTx` (see Block finalization step 4).
`revalidateTxInContext` remains available for the mempool's own staleness pruning,
where the tx was already validated on entry — never as the sole gate on applying
an untrusted, block-embedded tx.

### applyTx

```
applyTx(deps, tx: UtxoTransaction, outputsWithIds: AnyBox[], currentBlockHeight: number): void
```

Write-only. Consumes all input boxes and inserts all output boxes inside a
SQLite transaction. Performs no validation — call `validateTx` or
`revalidateTxInContext` first.

### validateAndApplyTx (convenience)

```
validateAndApplyTx(deps, tx: UtxoTransaction, currentBlockHeight: number): UtxoResult
```

Delegates to `validateTx` + `applyTx`. Preserved for backward compatibility.
New code should prefer the split functions.

### Legal box transitions

Every condition in this table is a **consensus rule enforced by the engine** — reachable by
block-embedded transactions, not only by the service layer. Service-layer checks (rate limits, fixed
amounts, pairing at create) are policy on *this node's* mempool entry and are NOT listed here.

⛔ **AUTHORIZATION IS PART OF THE TRANSITION, NOT A PROPERTY OF THE BOX.** A row states what it
requires — *invitee-signed*, *inviter-signed*, *voucher-signed*, *the signing key is the post's
author*, *block application only* — and that statement is the whole authorization rule for that
transition. There is no second pass that consults the box to decide who may spend it.

**Rows that name no signer require the owner's signature** — every karma and credit row above. That
is a requirement of those transitions, stated once here, not a property the box carries.

⛔ **No requirement may name a key that is not already in consensus state.** A rule may demand a
signature by the key at `box.owner`, or by a key the box names (`inviteePublicKey`, `inviterId`,
`voucherId`), or no signature at all. A rule shape that names a key from **configuration** is what
makes a privileged key representable, and `ARCHITECTURE` → Treasury requires the opposite property of
the treasury.

> ✅ **NO RULE VIOLATES THIS, AND THE LAST COUNTER-EXAMPLE IS GONE.** The same-owner karma rule
> carried a faucet exemption gated on `deps.isSystemBox`, which resolved a box id against a
> **configured system keypair** — a consensus rule naming a key from configuration. The faucet is now
> an ordinary account whose secret lives outside the node, so the exemption has nothing left to name:
> `isSystemBox`, the keypair and the exemption are all deleted. **No key reaches consensus from
> outside state, and no second one may be added.**
>
> The like accrual marker is now the **only** exemption from the same-owner karma rule, and
> §Karma transition rules states what pins it.

| Consumed | Created | Condition |
|----------|---------|-----------|
| KarmaBox | KarmaBox | Same owner, balance change (earn/spend) |
| KarmaBox | KarmaBox + LikeAccrualBox | **Like**: `likeTarget` present ⟺ exactly one `LikeAccrualBox` output of exactly `LIKE_KARMA_COST` whose `author` is the target's author from `block_topology` — **and the converse**, a `LikeAccrualBox` output ⟺ `likeTarget` present. Exactly one karma output, same owner as all inputs; target live; `(liker, target)` not recorded. **Value conserved** |
| KarmaBox | KarmaBox + PostLockBox | **Post** (unit 2): `post` present ⟺ exactly one `PostLockBox` output whose value is `POST_LOCK_THREAD_COST` for a post with no `parentRefs` and `POST_LOCK_REPLY_COST` otherwise. Karma outputs same owner; value conserved — a post carries **no** deficit and **no** surplus. The signing key is the post's author |
| KarmaBox | KarmaBox + BondBox | **Invite**: karma outputs same owner, value conserved; `inviteBondMin ≤ bond.value ≤ inviteBondMax` (per-network caps) and the settlement grants **exactly `bond.value`**; `bond.inviterId` = the karma input owner; `inviteePublicKey` holds **no `IdentityRecord`**, and **no other bond in this block names it** |
| KarmaBox | KarmaBox + VouchBox | Vouch cast: karma outputs same owner; `vouch.value == VOUCH_KARMA_AMOUNT`; `vouch.voucherId` == the karma input's owner; the voucher's **summed** karma balance ≥ `VOUCH_MIN_BALANCE`; no unspent escrow names the voucher; `vouch.createdAtBlock` within `[height − VOUCH_CAST_HEIGHT_WINDOW, height]` (the upper bound is step 6's; the window bounds backdating, which would shorten the cooldown the escrow derives from it) |
| VouchBox | VouchEscrowBox | **Unvouch**: exactly one VouchBox input, voucher-signed; exactly one escrow output with `value ==` the consumed box's, `owner == voucherId`, and `releaseAtBlock == vouch.createdAtBlock + vouchCooldownBlocks` — an exact pin, derivable from the consumed box alone. The cooldown runs from the **cast**, so a long-held endorsement costs no extra lockup and no withdrawal pattern returns the stake early. Value conserved |
| VouchEscrowBox | KarmaBox | **Escrow reclaim**: exactly one escrow input, owner-signed; spendable at or after `releaseAtBlock` (§Spend timing); exactly one karma output, same owner. Value conserved. Withdrawal itself is never gated — only the stake's return waits, and it waits in the escrow |
| LikeAccrualBox | — | **Settlement only.** No user transition admits one as an input |
| CreditBox | CreditBox(s) and/or FeeBox | Any owner, value conserved. **At most one FeeBox**, and it may not hold `0` — zero fee means no box. A transaction whose only output is the FeeBox is legal |
| PostLockBox | PostLockBox(+KarmaBox) | Block application only (per-block vesting) — no user transaction can spend a `PostLockBox` |
| BondBox | KarmaBox / — | Block application only: settlement at the probation deadline — **no user transaction can spend a `BondBox`** |
| KarmaPoolBox | KarmaPoolBox + … | **Settlement only** — the pool's sole spender, spent in blocks whose settlement moves karma and left alone otherwise |

⚠ **"Same owner" binds the inputs to each other, not only the outputs to
`inputs[0]`.** Every karma row above requires **all karma inputs to share one
owner** — see "Karma transition rules" below. Consolidating several of your
own karma boxes stays legal; that is the legitimate multi-input case. The like
accrual marker is the **only** exemption from the same-owner karma rule, and
§Karma transition rules states what pins it.

There is **no other legal bond or invite shape**. In particular:

- **A BondBox has no user-transaction shape at all.** It is created as an
  output of invite creation, and every later movement is block application's.
- **A karma surplus or deficit in any user transaction is invalid** —
  §validateTx step 7's exception list is empty.
- **A FeeBox is reachable only from the credit row.** The karma rows admit
  the karma family alone — "Karma transition rules" holds the family's one
  statement — so a fee output on a karma-side transaction is refused by that
  allowlist rather than by a rule naming `fee`. A karma transaction holds no
  credits to pay with, so the shape has nothing to express.

### Post transactions (unit 2)

- **A post is a transaction, and that is the whole of its admission.** It locks
  the author's karma and conserves value; there is no separate post signature,
  no PoW and no challenge. The author is the transaction's signer.
- ⛔ **The relay gate is a cached MEMBERSHIP check, not a balance read.** `net`
  drops a post from an author who holds no karma **at all**, consulting an
  in-memory set rather than the store. The set moves only when an identity first
  receives karma and when it falls to zero — it is not a decay or settlement
  concern, so it is not on any hot path.

  **Measured 2026-08-15:** Ed25519 verify **73.2 µs**, one `blake2b512`
  **2.08 µs**, `Set.has()` **0.023 µs**. The relay path goes 75.3 → 73.8 µs,
  **2 % cheaper** than with PoW, because the signature outweighs the PoW check
  35×. **The cost objection to replacing PoW is answered by measurement.**
  ⚠ Single core, no batching; the *ordering* of those costs is the durable
  result, and the binding constraint on a real node is signature verification —
  above ≈50 Mbit/s CPU binds before bandwidth does.
- **Stateful admission is strictly stronger than PoW was.** PoW proved someone
  burned a millisecond; a post transaction proves its author holds the karma and
  really locked it. That is why the two removals are one unit and not two.

### Bond transition rules

- **A bond is never spent, only settled.** Creation, the probation clock,
  forfeiture and the cancellation return are all block application's, so no
  transition admits a bond into a user transaction and no signature reaches it.
  This is what closes audit F-consensus-1 by construction rather than by a rule: there
  is no shape in which any party — inviter or invitee — can direct a
  bond's value anywhere.
- **The bond's value only ever reaches `bond.inviterId` or the burn.**
  Settlement mints the vested part to the inviter and destroys the rest;
  cancellation returns the whole of it. No path pays a bond to the
  invitee.
- **Settlement happens once, at the deadline, and reads only likes.**
  `IdentityRecord.invitedAtBlock + INVITE_PROBATION_BLOCKS` is the
  height; the vested amount is
  `min(floor(IdentityRecord.lifetimeLikesReceived / INVITE_BOND_VEST_PER_LIKES), bond.value)`,
  and the remainder
  burns regardless of what the invitee did otherwise. No karma balance is
  read, at that height or any other — the earlier spend-time predicate
  measured what an invitee *held*, which the invite's own mint satisfied
  before they had done anything.
- **The probation clock starts at the claim, not at creation.** An invite
  that is never claimed never starts one, so an inviter's bond is locked
  for exactly as long as they leave the invite open. `invitedAtBlock` is
  written by block application when the claim applies, which is the same
  event that mints the karma — one height, recorded once, read by the
  settlement sweep.
- **Forfeiture needs no conservation exception.** A bond is destroyed by
  settlement, which is block application, and the gate governs
  transactions. The `BondBox` zero-output exception this section once
  required is not needed and must not be added.
- **An invite and a bond are paired by `inviteePublicKey`, and nothing
  else is needed.** A key is invited at most once, so it identifies
  exactly one live pair — no box id, no output index, no provenance walk.
  This is what closes audit **F-consensus-5**, whose root cause was that
  the commit transition re-created the bond and broke the `(txId, index)`
  reference; with no commit, a bond is created once and the pairing it
  was born with is the pairing it dies with.
- ⛔ **An invite may only name a key that is not already an account**, and
  *"is an account"* means **holds an `IdentityRecord`** — not "was
  invited before". Invite creation is where this is enforced, rather than
  the claim, so a second inviter's bond is never locked against an invite
  that could not have been claimed.

  **The weaker "never invited" reading drains the pool.** An established
  account that simply had not been invited — every genesis committee
  member — could be named: the settlement grants it the bond's value out
  of the pool, and the bond then vests in full against likes that key had
  *already* earned, so the whole stake returns to the inviter at the
  deadline. The inviter's cost is a probation-length lock and nothing
  else, and the pool is down a grant that bought no new account.

  Record existence is the right test because **every karma receipt writes
  one**, through `insertBox`'s choke point. A key with no record has
  never held karma, so it has never posted and never been liked — which
  is also what makes the claim the record-*creating* event for every
  legal invitee, and `lifetimeLikesReceived` necessarily `0` at that
  point. Being barred costs an uninvited party one key generation, since
  the identity carries nothing.
- **Engine inputs these rules need:** the invite-create arm reads
  `getIdentityRecord` for the uniqueness check, and block application
  gains a settlement sweep keyed on `invitedAtBlock` —
  `getBondsSettlingAt`'s shape. `checkTransitions` needs no karma-sum read
  and no settle height.

### Karma transition rules (P2-B phase 4)

⛔ **The set of box types this arm admits as outputs is the TRANSITION set, and it is not the set
`totalKarma` sums** — see "Three karma sets, and none derives from another" under Status. ⚠ **A
karma-bearing type may belong to neither**, so "which list?" is the wrong question: ask both
independently. A single shared list is what would put a box holding the maximum representable karma
inside the network's reported supply.

- **All karma inputs must share one owner.** The engine pins every karma
  *output* to `inputs[0].owner` and calls the violation "Karma cannot be
  transferred", but never checked that the inputs themselves agree — and
  `validateTx` step 4 only requires a common `boxType`. So
  `[karmaA(10), karmaB(10)] → karmaA(20)` validated: conservation holds,
  every output matches `inputs[0].owner`, and `checkAuthorization` gets the owner
  signature it wants from each of A and B. **B's karma became A's.**
  Consensual, but karma is non-transferable *by rule* — a consensual transfer
  is still a transfer, and it prices off-chain. This is the audit's most
  severe class, and unlike the unlike-path instance it does **not** close when
  P2-D removes unlike.
- Self-consolidation (several of your own karma boxes into one) is the
  legitimate multi-input case and stays legal. The faucet grant is unaffected:
  it is a single input.
- **Credits are deliberately exempt.** They are tradeable, so multi-owner
  credit inputs are an ordinary multi-party payment, not a leak.

> ## ⛔ THE LIKE ACCRUAL MARKER IS AN EXEMPTION FROM THE RULE ABOVE, AND IT MUST NOT BEHAVE LIKE ONE
>
> A `LikeAccrualBox` is a **karma-bearing output earmarked for someone other than the input's owner**
> — precisely the shape *"Karma cannot be transferred"* exists to refuse. It is admitted because a
> like's cost must land somewhere nameable (`ARCHITECTURE` → The conservation axiom), and the marker
> is the only such exemption in the design.
>
> ⛔ **THE PIN IS THE WHOLE OF ITS SAFETY, AND NOTHING ANNOUNCES A VIOLATION FOR FREE.** An
> imbalance is self-announcing — conservation fires on it unconditionally. The marker **balances**,
> so no imbalance ever flags a malformed one, and the shape holds only because a rule states it and
> a test exercises it.
>
> **Both directions are required, and the second has no predecessor:**
>
> 1. `likeTarget` present ⟺ exactly one `LikeAccrualBox` output of exactly `LIKE_KARMA_COST` whose
>    `author` is the target post's author, resolved from `block_topology`;
> 2. **a `LikeAccrualBox` output present ⟺ `likeTarget` present**, and the marker names that target's
>    author.
>
> ⚠ **Without (2) this is the `voucherId` defect above, in a new box.**
> `myKarma(K) → myKarma(K−n) + LikeAccrualBox(n, author=Bob)` **conserves**, carries no `likeTarget`,
> and pays Bob at settlement — *"a karma transfer with no invite — the property the whole invite/bond
> mechanism protects."* Same class, same severity, and it arrives with the type rather than later.
>
> ⛔ **No user transition admits a `LikeAccrualBox` as an INPUT.** Only the settlement transaction
> consumes one, so `author` is attribution and never authorization — the standing `BondBox` and
> `PostLockBox` already have.
>
> ⚠ **The author is resolved from `block_topology`, never `dag_posts.author`** — the rule §Likes
> already states, and the marker inherits it. A placeholder row carries a zeroed author, so a marker
> built from the wrong source would earmark karma to the zero key.

### Vouch transition rules (P2-B phase 2)

- **The voucher's karma balance is at least `VOUCH_MIN_BALANCE` at cast**, summed across their
  karma boxes — not the value of any single one. Enforced at block application like every other
  rule in this list, so it travels with the transaction rather than guarding one node's front
  door. The service layer applies the same threshold before pooling, which is a courtesy: a vouch
  that would be refused at apply is refused earlier, and refusing it earlier changes no verdict.
- **The stake is pinned at cast: `VouchBox.value == VOUCH_KARMA_AMOUNT`.**
  A vouch is one vote and always stakes exactly 1 karma (user decision,
  2026-08-07). Before the pin, value was bounded only by conservation and
  `checkOutputValues` — which permits `0n` — while unvouch escrowed the
  **constant**. Both directions broke: a 0-value vouch matured into 1 karma
  minted from nothing, and a 100-value vouch destroyed 99 (audit
  F-consensus-3).
- **`voucherId` is pinned at cast: it must equal the karma input's owner.**
  A `vouch` input's authorization requires a signature by the box's own
  `voucherId`, so a VouchBox carrying a *foreign* one is authorized by that
  foreign key:
  A stakes their own karma, B unvouches it, and the escrow matures to B.
  That is a karma transfer with no invite — the property the whole
  invite/bond mechanism protects. Not in the audit; found deriving this
  phase. `castVouch` never compared the signer to `voucherId` either, so it
  was reachable through the front door as well as through a block.
- **The escrow records the actual staked value**, never the constant, and the
  reclaim returns exactly that. With the cast pin the two always agree —
  recording the real value is what makes the round trip conservation-
  structural rather than true by coincidence.
- **A vouch cast is invalid while any unspent escrow names the voucher** —
  `hasActiveVouchEscrow`, keyed on the voucher alone because the escrow
  carries no target. This is what rate-limits **re-vouching** even though
  **stopping** is instant: the escrow cannot be reclaimed before
  `releaseAtBlock` and a new cast is barred while it stands, so the cycle
  rate is capped at one vouch per cooldown window however briefly each vouch
  is held. Without the gate a voucher cycles cast → withdraw → cast and
  accumulates escrows at 1 karma each — cheap UTXO-set bloat.
- **The cast height is pinned inside a window.** `createdAtBlock` may not
  exceed the carrying height (step 6, universal) and may not lag it by more
  than `VOUCH_CAST_HEIGHT_WINDOW` (5) blocks. The escrow's release derives
  from this field, so a client free to understate it would shorten its own
  cooldown — **the derivation is only as honest as the field it reads.** A
  window rather than an exact pin keeps a pooled cast valid across a few
  blocks; the shortening it admits is bounded by the window's width.
  ⛔ **`VOUCH_CAST_HEIGHT_WINDOW` is protocol-level, the same on every
  network** — never a `NetworkProfile` field.
- **The cooldown runs from the cast**:
  `releaseAtBlock == vouch.createdAtBlock + vouchCooldownBlocks`, an exact
  pin. Deriving from the unvouch height instead restarts the cooldown at
  withdrawal, so holding an endorsement longer costs more lockup — backwards
  for a mechanic whose value is commitment. Exactness is legal here where the
  cast needs a window, because this derivation reads the consumed box alone
  and never the carrying height — the pin leaves an unvouch valid in every
  block. A vouch held longer than one cooldown yields an escrow born past its
  release height, immediately reclaimable: the commitment was served during
  the endorsement.
- **The escrow is committed state, and nothing node-local remembers
  anything.** It sits in the UTXO set and therefore in the `stateRoot`, so a
  node holds the obligation itself rather than a root it cannot interpret.
  The reclaim is an ordinary owner-signed transaction gated by §Spend timing;
  no block-application step touches a standing escrow, and no settlement leg
  releases one.
- **Self-vouch stays service-layer policy, not consensus.** At consensus a
  self-vouch is a value-neutral round trip of the actor's own karma, and vouch
  *score* is interpretation-layer (the node records; clients rank). Recorded
  so it is not promoted without a reason.
- **An unvouch consumes exactly one VouchBox and produces exactly one
  escrow**, enforced in `checkTransitions` — consuming several stakes in one
  transaction has no meaning in the design, so it is inexpressible rather
  than handled, the same reasoning as the bond settlement's single-input
  bound. The one-vouch-at-a-time rule remains service-layer only; the escrow
  gate above is what bounds a voucher's concurrent stakes at consensus.

### Karma decay (virtual, squared on touch)

Decay is a **valuation over committed state**, applied at every
karma-sufficiency read; face values move only when a block's body touches the
identity, and then only through that block's settlement transaction
(`ARCHITECTURE` → Karma decay is the model's one statement). The derivation
produces the same per-identity leg shape as before — consume the identity's
post-body karma boxes, re-emit effective to the owner and the remainder to the
pool — with the trigger being **touch**, never a per-block walk. See
`decay.ts`.

The clock is the `IdentityRecord` (Store Interface → Identity Records):

```
stale       = (height − lastActivityBlock) >= staleThresholdBlocks
owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
effective   = clamp(faceTotal − owedPeriods · decayAmount)   // never below min(faceTotal, KARMA_MINIMUM)
```

⚠ **The comparison is `>=`, not `>`.** This contract and Spec G §3.4 both said
`>`, and both were wrong by one block. `isIdentityStale` treats a box as recent
when `createdAtBlock > currentHeight − threshold`, so an identity is stale
exactly when *no* box satisfies that — i.e. when
`currentHeight − lastActivityBlock >= threshold`. `>` would delay every
identity's first decay by one block, which is a behaviour change D10 forbids.
Found by the phase D session against the code.

**Staleness is unchanged.** Today's test is "no unspent non-decay-burn karma box
newer than the threshold", and a non-decay karma box is created exactly when the
owner is touched, so `lastActivityBlock` is the max over those heights and the
predicate is the same.

**`owedPeriods` changes, deliberately — one accepted exception to D10.** The old
code measures from the **oldest** non-decay box (falling back to the youngest
when all are decay-burn). The record measures from the **most recent** activity.

Spec G §3.4 claimed these were equivalent, on the premise that forced
consolidation means one karma box per owner so oldest == newest. **That premise
is false:** settlement karma outputs land beside whatever karma the owner
already holds — the settlement does not consolidate — so two unspent non-decay
karma boxes at different heights is ordinary, and the two formulas then
disagree. Measured on the phase D fixture: a burn of 45 under the old rule, 30
under the new.

The new behaviour is the intended one — "time since you were last active" is
what a decay clock means, and measuring from the oldest surviving box is an
artifact of reading box ages rather than a clock. **User-accepted 2026-08-05**,
taken deliberately pre-network rather than discovered later. Pinned by
`test/fixtures/decay-divergence.json`.

The record is populated at the producing paths: `lastActivityBlock` on the
owner's own karma-spending activity — **received value (a like payout, a
vesting return, a settlement re-emit) is not activity and must not reset the
clock** — and `lastDecayBlock` when a squaring fires.

---

## Box Identity and Mint Provenance

Every box id derives from its creating transaction (`TYPES_INTERFACE.md` → BoxId), and almost
every box block application creates is an output of the block's settlement transaction — a real
transaction whose outputs take ordinary transaction-derived ids. **Exactly two producer classes
create boxes with no transaction behind them**, and only they derive a synthetic id per mint
*event*:

- **genesis seeding** (`store/system.ts`) — the store is seeded before any block exists;
- **post-lock vesting** (`transferKarma`, block application) — the one conserving-in-place
  karma path: a `PostLockBox` vests into its own owner's karma and a reduced lock, the pool is
  uninvolved, and so it has no place in the block's one pool spend.

```
mintTxId = blake2b512( MINT_ID_DOMAIN ‖ vlqU(height) ‖ enum8(reason) ‖ lp(subject) )[0:32]
boxId    = blake2b512( BOX_ID_DOMAIN ‖ canonicalBoxBytes(candidate) ‖ utf8(mintTxId) ‖ u32BE(index) )[0:32]
```

Box derivation is then identical to the user-transaction path — one derivation,
not two.

### The subject encoding rule

> **Every per-reason `subject` encoding MUST be fixed-length or
> self-delimiting** — and the reason is the subject's own INTERNAL structure, not
> its boundary. `computeMintTxId` writes `lp(subject)`, so one whole subject can
> never be confused with another; what `lp` cannot do is separate the **parts** of
> a multi-part subject, which it wraps as one opaque run — were any part of one
> variable-width, two different part-tuples could concatenate to the same bytes
> and collide inside one reason. Every subject in the table below is a single
> fixed-width field, so the rule holds by construction today; it binds any future
> multi-part subject.
>
> *Across* reasons uniqueness holds unconditionally, because `enum8(reason)` is a
> single distinguishing byte ahead of the subject. `@dagsocial/types` cannot
> enforce the within-reason half: it takes `subject: Uint8Array` and the caller
> owns the bytes. **This contract is the other half of that guarantee.**

Two byte-form rules, both inherited from `TYPES_INTERFACE.md` → Pinned byte
forms, so a mirror implementation derives the same ids:

- a value typed as a **hex string** (`PostId`, `TxId`) enters as the UTF-8 bytes
  of its hex text, never as decoded bytes;
- a value typed as **`Uint8Array`** (`UserId`, pubkeys) enters as its raw bytes.

### Reason and subject table

| `reason` | Subject | Encoding | Bytes | Site |
|----------|---------|----------|-------|------|
| `postlock-unlock` | `targetPostId` | `utf8(hex)` | 64 | post-lock vesting (block application) → `transferKarma`, the author's unlocked karma |
| `postlock-remainder` | `targetPostId` | `utf8(hex)` | 64 | post-lock vesting (block application) → `transferKarma`, the reduced-`PostLockBox` remainder |
| `genesis` | which genesis box | `u32BE(k)`: `0` = faucet karma stake, `1` = faucet credits, `2` = genesis proof, `3` = emission, `4` = karma pool | 4 | genesis seeding — `ensureSystemKarmaBox` / `ensureFaucetCreditBox` / `ensureGenesisProofBox` / `ensureEmissionBox` / `ensureKarmaPoolBox`. Selectors `0` and `1` exist only where the profile names a faucet identity; `2`–`4` on every network |
| `genesis-committee` | the committee member | raw | 32 | genesis seeding — `seedGenesisCommittee`, one karma box per `genesisCommitteeKeys` entry, drawn out of the pool |

**Four reasons, and the set is closed by the two producer classes.** A settlement output needs
no reason — it has a transaction — so a new reason enters only with a new genesis box or a new
conserving-in-place direct producer. Tags are `@dagsocial/types`' (`MINT_REASON`); this table
deliberately does not repeat them. **Reasons retired before mainnet are deleted outright —
numbers and names both free, no reservation list** (user, 2026-08-19); a **live** tag is never
renumbered (TYPES_INTERFACE → Primitives).

**Why `(height, reason, subject)` cannot repeat, per row.** Post-lock vesting runs at most once
per post per block and both postlock reasons key on the post id, so each `(height, post)` pair
yields at most one unlock and one remainder. Genesis seeding runs once, on an empty store; each
`genesis` selector names exactly one box, and a committee key appears at most once in
`genesisCommitteeKeys`.

⛔ **One `genesis` selector names ONE box.** N boxes under one `k` would derive one synthetic
txId, one `computeBoxId` preimage, and the second insert violates `UNIQUE(tx_id, output_index)`
— which is why committee seeding is keyed on the **member**, the shape any per-recipient mint
takes. A 32-byte subject under `genesis` itself would also be injective (`lp(4)` and `lp(32)`
differ in their first byte) and is still wrong: the row says 4 bytes, and a
correct-but-undescribed encoding fails no test and rots on its own schedule — the defect class
this table exists to prevent.

**No reason increases karma supply.** Supply is fixed at genesis: the `genesis` rows are its
creation, `genesis-committee` grants are drawn out of the pool in the same seeding, and the two
postlock reasons recirculate karma the `PostLockBox` already held. Everything that moves value
after genesis is either a user transaction or the block's settlement transaction
(`ARCHITECTURE` → UTXO conservation), and neither needs a mint reason: their outputs carry
ordinary transaction ids.

⛔ **Value movement is never a call site's discipline.** The two operations that move karma —
the settlement transaction and `transferKarma` — each name source and destination in one
operation and fail closed in both directions (`transferKarma` throws `KarmaNotConservedError`;
a settlement that does not conserve is a rejected block). A path that touches the pool, the
emission box or the treasury is the settlement's; `transferKarma` serves the paths that
conserve inside themselves. **The property is the primitive's, not its callers'** — the same
standing `consumeBox`'s liveness check has.

⚠ **The conservation invariant holds at every height and between every pair of transactions
inside a block:** `sum(every karma-bearing box) + pool` is constant from genesis
(`ARCHITECTURE` → UTXO conservation; `test/services/conservation-axiom.test.ts` asserts it
across an applied chain). ⚠ **It is a DIFFERENT sum from `getTotalKarma`**, which reports
circulation and excludes the pool deliberately; asserting either against the other is an
error.

Three rules about subjects that are decided, not open:

- **Distinct recipients-at-height need distinct `(reason, subject)` pairs.** The live instance:
  `postlock-unlock` and `postlock-remainder` can both mint against the same post at the same
  height with **identical subjects** — the reason tag alone separates them.
- ⛔ **Prefix-freeness of reason strings does not hold, and nothing rests on it.** `genesis` is a
  proper prefix of `genesis-committee`. **The reason reaches the preimage as `enum8(reason)` —
  one byte from a closed table — never as its string**, so cross-reason injectivity is
  structural and the strings carry none of it. The types test pins the loss deliberately, with
  `genesis-committee` as the named witness, beside the distinct-txId assertion that demonstrates
  the tag carrying injectivity.
- **Every "covers every `MintReason`" list is keyed on the type**
  (`Readonly<Record<MintReason, …>>` / `satisfies`), so an omission is a compile error. A list
  of "every X" that is not derived from X's type is a manual copy of a type definition and
  drifts silently — a test *named* for coverage is the most dangerous form, because the name is
  what stops anyone checking. When a contract says a property is pinned "over the whole" of
  something, that is a claim about a *type*; verify the test is keyed on one.

Every encoding above is **fixed-length**, so the rule holds by construction
rather than by inspection.

⚠ **`genesis` deliberately does not use ASCII tags** (`system-karma` and the like). Those are
variable-length and neither self-delimiting nor fixed — merely *prefix-free*, which happens to
suffice for a small set but is not a property the rule can check per encoding. A `u32BE`
selector satisfies the rule outright, and adding a genesis box costs one integer, not a
re-examination of prefix-freeness — which is exactly what the emission box's selector `3` and
the pool's `4` cost.

### `index` is always 0 for mints

Each mint event emits exactly one box, so its `index` is `0`. A vesting that
unlocks karma and leaves a remainder is **two events under two reasons**, not one
two-output transaction; genesis seeding is one event per selector and one per
committee member. The `index` field exists so mint and transaction derivation
share one code path.

### Which producers attach provenance, and which deliberately do not

A box gets provenance **where it is stored**, not where it is first constructed.

- **Mint sites** derive a synthetic txId from their `MintContext` and use
  `index` 0.
- **The apply path** materialises transaction outputs through the single
  `materializeOutput(box, txId, index)` rule — both the mempool path
  (`validateTx`) and the block-embedded path go through it, so there is one
  materialisation rule rather than two chances to place the keys differently.
- **Builders that predict an output's id for the client** — `invites.ts`'s
  `bondBoxId` — materialise through the same helper, because the predicted id is
  acted on by clients and must match what block application later derives.
- **Builders that only hand a transaction to the mempool** — `routes/utxo.ts`,
  and every external client (the demo UI, the faucet package) — attach
  **nothing**. They insert no box; `UtxoTransaction.outputs` is
  `BoxCandidate[]`, which has no provenance keys to carry. Their boxes get
  provenance when block application materialises them.

`u32BE` is **exported from `@dagsocial/types`** (phase G1) and
`mint-provenance.ts` imports it; it previously kept a local mirror, and a silent
divergence between the two would have moved mint txIds — and therefore box ids —
with nothing to catch it, while this contract's own subject table mandates the
encoding. One implementation feeds both derivations. The demo UI cannot import
it and so must still reproduce the sentinel behaviour, and must not throw.

### The demo UI mirror carries the same strip defect (phase E)

`public/index.html`'s client-side `computeBoxId` does `const { id, ...rest } = box`
— the **id-only strip** that phase C0 removed from `@dagsocial/types`. Both of
its call sites hash **client-built** boxes carrying no provenance (the predicted
`inviteBoxId`, and the cached LikeBox id for unlike), so server and client agree
today and phase C does not change that. (P2-D deletes unlike and `LikeBox`
entirely — its UI phase removes that call site, and with it the last flow that
predicts a box id at all.)

It is a latent trap rather than a live defect: the first time the UI hashes a
**server-returned** box — which carries `txId`/`index` from phase C on — it
would hash provenance into a legacy id and silently disagree with the node.
Since both flows depend on the client *predicting* an id the node will later
agree with, that disagreement would surface as a dangling `bond.inviteBoxId` or
an unspendable LikeBox, not as a visible error.

**Phase E obligation**, alongside teaching the mirror the domain tag,
`utf8(txId)` and `u32BE(index)`: fix the strip rule in the same pass. *(Found by
the phase C0 session, which correctly did not touch it — `public/index.html` is
the node package's file.)*

⚠ **The UI had the id-only strip in TWO places, not one — `computeTxId` as well
as `computeBoxId`.** This contract named only the latter. Found and fixed in
phase E1 by extracting a single `canonicalBoxBytes()` helper in the UI and
routing both through it, mirroring how types is structured.

That makes **four** instances of the same defect: `computeTxId` in types (phase
A), `computeBoxId` in types (phase C0), and both UI sites (phase E1). The rule
was always "exactly one strip rule, so tx and box derivation cannot drift", and
it was violated everywhere it could be, in both implementations, because a local
`const { id, ...rest } = box` is the obvious thing to write and is wrong in a way
nothing detects until provenance exists. **When auditing a mirror, assume the
defect is in every site that strips, not the one that was reported.**

#### The mirror test MUST cover every box type

Not a representative one. The UI converts hex-string fields to bytes before
encoding using a hardcoded `binaryFields` name list, which is a hand-maintained
copy of "which box fields are `Uint8Array` in types" — and it **omitted
`VouchBox`'s `voucherId` and `targetId`**. A client-built vouch box would encode
them as CBOR *text* (`7840` + 64 ASCII) where the node writes a *byte string*
(`5820` + 32 raw), giving a different box id. Latent only because the vouch flow
POSTs to `/vouches` and never builds the box client-side.

That gap survived because the mirror covered **karma and credit only** — the other
box types were never encoded through both implementations and compared. So
the enforceable rule is coverage, not documentation: with every box type in the
mirror, a missing `binaryFields` entry fails mechanically instead of waiting for
someone to notice the list is a manual copy of a type definition.

⚠ **This is the second instance of the shape.** Phase C's report §4.2 records the
same thing in a different file — a round-trip test that used only a karma box, so
an in-range record tag at `0x03` could not collide with karma at `0x01` and the
mutation died against the literal assertion instead of the behaviour. **A
"representative" fixture in a test whose whole job is cross-implementation or
cross-kind agreement is not representative of anything.** Enumerate.

*(Having UI builders carry `Uint8Array` directly would remove the list entirely
and is the cleaner end state. It is deliberately **not** done here: it is
consensus-visible surgery across every box-building site, and it stops being
urgent once drift is caught by test.)*

### Phase G checklist — LANDED (phases G1–G3b)

Obligations accumulated across phases B–D and were stated where they were found,
which is right for context and wrong for not missing any. All nine are done;
kept here as the record of what closed, and where the reasoning lives.

**Format tightening**

1. ✅ `computeBoxId` **is** `computeCandidateBoxId(box, box.txId, box.index)`, and
   `TX_ID_DOMAIN` is applied to `computeTxId` — including in the demo UI, in the
   same commit. There is now exactly **one** implementation of each: node's
   `utxo-engine.ts` carried a second `computeTxId` (its own cbor-x `Encoder`,
   the id-only strip in its **sixth** location) which produced the hash
   *signatures were verified against*; applying the domain tag to types alone
   would have left builders signing a tagged id while the engine verified an
   untagged one. Deleted in G3b.
2. ✅ `txId`/`index` required on `BoxBase`; `UtxoTransaction.outputs` is
   `AnyBoxCandidate[]` (`TYPES_INTERFACE.md` → BoxId for why that is not the
   base `BoxCandidate`). `id` stays optional, deliberately — same reference.
3. ✅ `createdAtBlock` and `lastTouchBlock` deleted from the box protocol. The
   `created_at_block` **column** stays; `last_touch_block` was dropped with the
   field, having had no reader anywhere — only the INSERT that wrote it.
4. ✅ `utxo_boxes.tx_id` / `output_index` are `NOT NULL`, in the same commit as
   the box-field deletions. That grouping earned itself twice over: it avoided
   editing ~190 fixtures twice, **and** NOT NULL turned out to be the only thing
   that fails loudly. `TextEncoder` encodes `undefined` as zero bytes and `u32BE`
   maps it to the sentinel, so a box with missing provenance derives a stable
   *wrong* id rather than throwing — invisible in the one phase where every
   golden legitimately moves. `box-provenance.test.ts`'s nullable-pinning cases
   were deleted, not repaired.
4b. ✅ The store schema counter moved 0 → 1. **The counter no longer exists** —
   see § No store schema version, and none is owed.

**Correctness debts that only became enforceable here**

5. ✅ **Canonical key ordering in both encoders**, plus the demo UI's. Retires
   hazards 1b and 1c. `post_lock`'s producer-vs-`rowToBox` divergence is fixed
   **by the sort, not by reordering that site** — a producer can no longer get
   key order wrong because it no longer chooses it.
6. ✅ Attach-provenance-before-deriving-the-id is now testable, and tested:
   `computeBoxId` observes `txId`/`index`, so the two orders are no longer
   byte-identical.
7. ✅ `insertBox` takes the height from the open journal
   (`openBlockJournalHeight()`), never from the box. Deleting the field is what
   proved it: there is nothing else it could read. `0` outside a journal —
   genesis and bootstrap — which is honest rather than a fallback.

**Blockers, both cleared before G3**

8. ✅ `settlePruneUtxo` mint reasons (G2).
9. ✅ `u32BE` exported from `@dagsocial/types` (G1).

### What G3 changed that was NOT on this list

**A bond names no box at all.** A box id in a **content** field is circular under
the provenance derivation: the id derives from the creating `txId`, and a content
field sits inside the bytes `computeTxId` hashes. Measured: no fixed point exists.
Spec G §3.1's "no circularity" argument covers *provenance* fields and does not
reach this.

The pairing needs no reference of either kind. **An address may be invited only
once**, so `inviteePublicKey` — which the invite and the bond both carry, pinned
equal at creation — names exactly one live pair. That is what an id or an index
was for, obtained from a field the boxes need anyway. It also makes a bond that
names *someone else's* invite inexpressible, which the index form achieved
structurally and the original id form did not achieve at all.

**The demo UI predicts no id for invites** — with nothing to reference, there is
nothing to predict. The unlike path still genuinely predicts, and is the only flow
that does.

### A frozen golden cannot defend a property

Found by G3b's mutation battery and general beyond this spec. Dropping
`TX_ID_DOMAIN` was killed only by three frozen-constant assertions. A golden
catches a removal **only because the golden was regenerated after the change**,
so the assertion is "this id equals this number" and the natural response to it
failing is to update the number — which is exactly what a phase that legitimately
moves every golden invites.

**A property needs an assertion that does not depend on the current output.** The
working shape is an *independent recompute*: write the preimage out from the
contract text and compare, rather than calling the function under test. Applied
to the domain tags in `types/test/utxo.test.ts`, alongside distinctness and
prefix-freeness over the tag set.

### Discriminants are semantic, never positional

A mint's identity MUST NOT derive from its position in the journal, the block,
or any iteration order. Position-derived identity would put ordering back into
*identity* — strictly worse than the M-12 ordering bug P2 closed for the AVL
feed, because there the fix was a sort at one boundary, whereas an
order-dependent id is baked into committed state and unrecoverable.

**Adding a mint reason** therefore requires three things in one unit: the ASCII
tag added to `MintReason` in types, a fixed-length or self-delimiting subject
encoding added to the table above, and an argument at the call site that
`(height, reason, subject)` cannot repeat.

---

## Ordering Block Creator Contract

`startBlockCreator()` / `stopBlockCreator()` / `rebuildTemplate()` /
`createOrderingBlock()` / `getCurrentTemplate()` / `clearTemplate()` /
`submitMinedBlock(powNonce, height)`

### The settlement transaction

**One per block, covering both ledgers, and it is the LAST entry in `utxoTxIds`** — that is the
whole of how it is identified (`@dagsocial/validation` refuses a body with no last entry;
what the settlement contains is consensus and is this section's). It is the **only** spender of
the karma pool, the emission box and the treasury box, and the only consumer of fee boxes.

| | |
|---|---|
| **Consumes** | the emission box (when this height releases) · the treasury box (when this block accrues to it) · the karma pool box (when this block draws or returns) · every `FeeBox` the body's transactions created · every marker box the block's like transactions emitted · the carry box of every author the block credits · the `BondBox` of every bond settling at this height · the karma boxes decay charges and the locks a prune entry names |
| **Emits** | the successors of the three protocol boxes · the coinbase's credit outputs · the invite grants · the vested part of each settling bond, back to its inviter · like payouts and carry successors · decay replacements · prune refunds |

⚠ **A `VouchEscrowBox` is deliberately NOT here.** Its owner reclaims it by ordinary
transaction once `releaseAtBlock` passes (`OWNER_SIGNATURE`, `SPEND_TIMING`'s `vouch_escrow`
entry) — no per-block step touches it.

⛔ **`CoinbaseOutput` is not a block-body concept.** Coinbase outputs are outputs of this
transaction; the block body has no `coinbaseOutputs` field and `utxoTxRoot` has no `'coinbase'`
leaf class (TYPES_INTERFACE → OrderingBlock).

⚠ **"Every protocol effect" admits exactly one exception: post-lock vesting.** A `PostLockBox`
vests into its own owner's karma and a reduced lock — the pool is uninvolved, so it runs as a
direct block-application transfer (`transferKarma`) with synthetic mint ids (§Box Identity and
Mint Provenance) rather than as settlement outputs. Every effect that touches the pool, the
emission box, the treasury or a fee box rides the settlement.

#### Why exactly one

The pool's id changes every time it is spent, so two transactions naming it conflict — and unlike an
ordinary contended box **the loser is not deferred but permanently invalid.** One protocol spend per
block gives zero contention. A transaction may carry as many outputs as it needs, so **this bounds
nothing** about how many invites, likes or sweeps a block holds.

#### ⛔ Its marker inputs are DERIVED, not serialized

The rule is *"this transaction consumes every marker box the block's transactions emitted, in
committed transaction order."*

- ✅ **Its serialized size is proportional to distinct AUTHORS, never to LIKES.** An author may
  receive any number of likes in one block, so listing marker ids would put a per-like cost on the
  body a second time.
- ✅ **The enumeration order is already fixed by `utxoTxIds`** and needs no sort and no rule of its
  own — which is what makes the determinism obligation below tractable rather than merely stated.
- ⚠ **The cost: the settlement is not validatable from its own bytes.** A validator reconstructs the
  input set from the rest of the body before checking conservation. That is a field read on a pass it
  already makes, **once per block**.

#### ⛔ Determinism is this mechanism's whole risk — but it is determinism of the VERDICT, not of the bytes

⛔ **"EVERY NODE DERIVES A BYTE-IDENTICAL SETTLEMENT" IS IMPOSSIBLE AND THIS SECTION SAID IT.
Corrected 2026-08-18.** The coinbase payout key comes from `?miner=<hex(32)>` on the template
request (`MINING_INTERFACE` → Mining API) — **it is producer-chosen and reaches the body only as an
output of the settlement itself.** A verifier cannot know which key the producer picked, so it
cannot reconstruct the settlement independently and compare bytes.

⛔ **THE PROPERTY THAT ACTUALLY BINDS: every node reaches the same VERDICT on the settlement the
block carries.** That is what keeps `utxoTxRoot` and `stateRoot` from forking, and it is weaker than
byte-identity in exactly one place and no more.

**So every field of the settlement is one of two things, and the enumeration is the rule:**

| Kind | Obligation |
|---|---|
| **derived** — pool successor value, emission successor, the set of markers consumed, each slice's value, output ordering | **recomputed identically by every verifier.** A mismatch is a rejected block |
| **producer-chosen** — the coinbase payout key | **read from the settlement and constrained by a stated rule.** Never re-derived, because there is nothing to derive it from |

⛔ **NO FIELD MAY BE NEITHER.** A field that is not recomputed and not constrained is a field a
producer may set freely, and the block still validates — which is how a settlement smuggles value
past a gate that looks exhaustive.

⚠ **Construction must still be a pure function of the block's other transactions, the consumed
protocol boxes, and the producer-chosen inputs it names** — no local state, no wall clock, and no
iteration order the block does not already fix. **Adding a producer-chosen field is what needs a
rule; adding a derived one needs only that the derivation be stated.**

##### ⛔ A derived quantity has TWO kinds of input, and the second needs a stated state version

| Input | Agreed how |
|---|---|
| **block content** — the transactions, their outputs, the markers they emit | both sides read the same bytes; no ambiguity is possible |
| **chain state** — karma boxes, identity records, bonds, escrows | ⛔ **only if both sides read the SAME VERSION of it** |

⛔ **EVERY STATE-DERIVED QUANTITY IS DERIVED FROM PRE-BODY STATE — the chain tip the block builds
on, before its own apply loop runs.** The producer must fix the settlement's bytes **before** it can
apply the body, because the settlement is *in* that body. So pre-body state is the only state
producer and verifier can both read and agree on. **A derivation taken after the apply loop is a
different function on the two sides.**

⚠ **It fails on the ordinary case, not an exotic one.** Spending karma bumps `lastActivityBlock`
through `insertBox`, so an identity that is decay-eligible **before** the loop is fresh **after** it.
A producer deriving post-body says "no decay" and a verifier deriving pre-body says "decay" — or the
reverse — and **the block never validates.** The identity does not have to do anything unusual: it
has to transact in the block that decays it.

⚠ **The liveness cost is real, deterministic, and not a fork.** A block whose body spends a karma box
the settlement's plan also names is **invalid** — the settlement lists an already-consumed input.
Every node reaches that verdict identically, so it costs a block rather than splitting the chain, and
a producer's own speculative apply reaches the same verdict and declines to build it. ⛔ **State the
bound wherever this is implemented**: decay fires once per interval per identity, so the exclusion
lasts at most until the decay lands.

⛔ **Any store query feeding a derivation needs a total order, stated.** `getKarmaOwners` had no
`ORDER BY` — SQLite's return order is not a rule, and a derivation that iterates it is a fork with no
compiler signal. **Ascending owner, ascending box id, or the block's committed transaction order.
Nothing else.**

##### ⛔ "HAS AN `ORDER BY`" IS THE WRONG TEST. "IS THE ORDERING KEY UNIQUE" IS THE RIGHT ONE

**A partial order passes every check anyone would run and forks anyway.** It reads as ordered, it
greps as ordered, and it leaves ties resolved by whatever the engine returns.

> ⚠ **Measured 2026-08-18.** `getKarmaBoxes` was `ORDER BY value DESC` — an order, and not a total
> one. **Two karma boxes of equal value for one owner have no defined relative order**, and decay
> lists exactly those ids as settlement inputs, which the `TxId` hashes **in order**. ⛔ **Equal
> values are ordinary, not exotic**: two faucet grants, or a payout that happens to match an existing
> balance.

✅ **The fix appends a unique tiebreaker rather than replacing the semantic order** — `ORDER BY value
DESC, id`. The coin-selection preference survives and the tie is decided. **Replacing a meaningful
order with `id` alone would trade a fork for a behaviour change.**

⚠ **A single-row read needs it too, and for a different reason.** `getPostLockBox` had neither
`ORDER BY` nor `LIMIT`, and `.get()` took whatever came first — it feeds prune settlement and
post-lock vesting. One lock per post is the invariant, so the order changes nothing **while the
invariant holds**. ⛔ **Its job is to bound what happens when the invariant is violated upstream:
with an order, a duplicate yields the same wrong box on every node — a defect. Without one, it yields
different boxes on different nodes — a fork.** Ordering is what keeps someone else's bug from
becoming a chain split.

⚠ **A query that reaches no derivation needs none of this.** Boolean predicates, `COUNT`s, API
listings and mempool reads are unaffected — **the obligation follows the consumer, not the query**,
so this is checked per call site rather than by sweeping for missing `ORDER BY`.

⛔ **A node-local table as the derivation source is exactly what this forbids.** A
block-application effect must be derivable from **block content**; an effect keyed on a local
table is a fork, not a refactor. That is the load-bearing reason marker boxes exist rather than
a tidiness argument.

⚠ **Three ordering sources are permitted and no fourth is**: the block's committed transaction order,
ascending box id, and ascending height. Anything read from a table needs a stated total order or it
is not one.

#### ⛔ It is the LAST entry in `utxoTxIds`, and that is how it is identified

**The settlement is the final transaction of the body. A block whose last transaction is not a
well-formed settlement is invalid, and a block carrying a settlement anywhere else is invalid.**

⛔ **Identity has to be POSITIONAL, because every other answer needs state.** "The transaction that
spends the pool" requires knowing which box is the pool; "the one flagged as settlement" adds a
consensus field a producer could set on two transactions. Position is already committed —
`utxoTxIds` order is normative and `computeUtxoTxRoot` lays its leaves in it — so **structural
validation can find the settlement with no UTXO set at all**, which is what lets `exactly one` be
checked before any state is loaded.

✅ **Last is also the only position it could occupy.** It depends on the block's content, so the
producer builds it after the fill; it consumes markers the other transactions emit, so it must apply
after them. Construction order, apply order and wire position are one fact rather than three that
have to agree.

⚠ **"Exactly one" is a structural claim and belongs to `@dagsocial/validation`; what the settlement
*contains* is consensus and belongs here.** A body with zero settlements, or with a settlement that
is not last, is refused without reading a single box.

#### Construction ordering

1. It depends on the block's **content**, not only on its inputs, so it is built last and validated
   last. The apply loop's existing deferral handles input dependencies; this is a different kind and
   needs its own rule.
2. Only the producer can build it, since only they know the block's contents — the position the
   coinbase already occupies.
3. ⚠ **The producer's byte budget must absorb a body-dependent tail.** The reservation that seeds the
   fill with the largest possible coinbase no longer bounds it. ✅ **The existing trim loop
   generalises** — trimming a transaction shrinks the settlement too, monotonically — **provided the
   settlement is rebuilt on each iteration** rather than measured once.

### Triggers

**Production is difficulty-regulated: a block appears when a miner solves one.** The creator holds a
template rather than scheduling anything, and there is no timer.

- **Startup** — `startBlockCreator()` builds the first template.
- **The tip moved** — `rebuildTemplate()`, after this node's own block finalizes, after a peer's block
  applies, and once after a reorg commits.

⚠ **The rebuild stands down while nested in a transaction** (`!getDb().inTransaction`). `reorg` calls
`applyOrderingBlock` inside its own transaction, where the applied block is not the tip yet and a
template built from it would describe a chain a failed reorg rolls back; `reorg` rebuilds once, after
committing.

⚠ **`rebuildTemplate()` is miner-only, and the guard is `if (!config) return`.** `startBlockCreator` is
the only assignment of the creator's module-level config and runs on a miner node alone, so an
unassigned config *is* a server-role node: it applies blocks and builds no templates.

### Block creation (mempool-based)

1. Purge expired mempool entries (`purgeExpired(currentHeight)`)
2. Get pending entries from mempool (`getPendingEntries(limit)`)
3.–5. *(Retired with sub-blocks: there is no batch linking and nothing to decode
    separately — every pending entry is a standalone `utxo_tx` or `prune`.
    Numbering kept so later step references stay stable.)*
6.–11. *(Retired by P2-D. Standalone-like sidecar attachment (old step 6), like
    collection, like dedup and the epoch-boundary check are gone — likes are ordinary
    mempool UTXO transactions, so they flow through step 7 like any other tx; dedup is
    the like-record's existence, enforced at apply; there is no epoch.)*
7. UTXO entries → `utxoTxIds` (posts and likes included — no sidecar diversion)
8. *(Retired with sub-blocks — folded into step 7.)*
12. Always produce a block, whatever its coinbase comes to. An empty block below
    the emission terminus carries that height's emission; above it
    (`MINING_INTERFACE → Emission Schedule`) an empty block's income is zero, so it
    carries **no coinbase outputs at all** — no output may hold `value === 0`.
    ⚠ **One exception, and only one (P2-B phase 1c): a body its own mutation
    phase rejects.** See step 15b — the creator produces nothing and evicts
    the included mempool entries. Mining over a body the node itself will not
    apply wastes PoW on a block that cannot be accepted anywhere.
13. Track confirmed mempool rowids for cleanup
14. Build coinbase outputs — the **miner's slice only**. The treasury's accrues to the
    `TreasuryBox` and the released emission comes out of the `EmissionBox`; both
    successors are derived here too, and neither rides in the block
15. Adjust difficulty at epoch boundaries (credit epochs, not like epochs)
15b. Compute `stateRoot` — the **post-block** digest (see "Post-block
    stateRoot" below). Never the creator's current (pre-block) digest.
16. Build block template (powNonce=0, empty signature)
17. **Internal mode:** mine PoW, sign the header hash (`blockHash(header)`), finalize
18. **External mode:** store template for `GET /mining/template`,
    return null (block finalized when miner submits via `submitMinedBlock`)

### Block finalization

1. Store block in `block_ordering` table
2. Broadcast ordering block to peers
3. Confirm the block's posts (`confirmPost` with height and committed position, ids from
   its post transactions)
4. Apply UTXO transactions — the settlement, as the last entry in `utxoTxIds`,
   applies here like every other, and its outputs are where the coinbase's
   credits, the protocol-box successors and every pool-touching effect land.
   The decode pass runs first and carries its own rule —
   see "Embedded transactions: a mismatch rejects the block": a tx whose bytes
   cannot be proven to be the id declared beside them rejects the block before
   this step sees a queue. Then, for each embedded UTXO tx, once its inputs are all
   present, **fully re-validate with `validateTx`** (authorization, transitions,
   conservation — not just liveness), then apply (`applyTx`). A block producer is
   untrusted (permissionless PoW), so nothing is assumed verified. **If
   a tx whose inputs are present fails validation, the entire block is rejected**
   and nothing is applied — a valid block must not contain an invalid tx. This runs
   on every apply path (local finalization, gossip receipt, reorg). Input *presence*
   is handled by deferral: a tx whose inputs are not yet present is retried, because
   an earlier tx in the same block may create them (intra-block dependency).
   Idempotent: skips boxes already inserted or spent (survives gossip loopback).

   **A block is invalid if any embedded transaction does not apply.** Deferral ends
   when a pass applies nothing; anything still queued at that point can never apply,
   and **the block is rejected** — the same rule as a failed re-validation, reaching
   the case deferral leaves open. Partial application is not an outcome: a block
   whose `utxoTxIds` names a transaction its own application dropped commits a
   `stateRoot` that does not reflect its own transaction set.

   ⚠ **The rule carries no pass bound, deliberately.** Termination comes from
   "a pass applied nothing", so the pass count is bounded by the block's transaction
   count and never needs stating. **A retry cap would be a consensus parameter** —
   two nodes with different caps would disagree about a block carrying a dependency
   chain longer than the smaller one, and the disagreement would be indistinguishable
   from this rule working. A chain of any depth the block can hold must apply.
5. Remove confirmed entries from mempool (`removeEntry` for each confirmed rowid).
   ⚠ **This runs even when the block was rejected**, and that is deliberate,
   not an oversight: whatever made the body invalid is still pooled, so
   leaving it would rebuild the same rejected block every interval and stall
   the chain — expiry cannot save it, since `purgeExpired` keys on a height
   that stops advancing when production stops. Step 15b's `body rejected`
   outcome applies the same eviction for the same reason.
6. Reset pending counter and template

### Mining modes

| Mode | Block creator | Block finalization | Template endpoint |
|------|--------------|-------------------|-------------------|
| `internal` (default) | Timer + trigger | PoW solved internally | N/A (routes unmounted) |
| `external` | Timer + trigger | Via `submitMinedBlock` | `GET /mining/template` (bearer-authed) |

In external mode, the block creator builds a template with `powNonce=0` and
stores it. External miners poll the template endpoint, solve PoW, and submit
via `POST /mining/submit`. The node verifies PoW, signs, and finalizes.

### Post-block stateRoot (H-6)

`header.stateRoot` commits to the UTXO state **after** this block is applied
(ARCHITECTURE → AVL+ State Root). PoW covers the header, so the producer must
know that digest **before** mining — it cannot be filled in afterwards.

**It is obtained by running this block's own body through the same code the
apply path runs**, never by a second implementation of the state transition:

1. Snapshot the prover digest.
2. In a SQLite transaction that is always rolled back, run the block's
   **mutation phase** (see "Apply funnel: validation and mutation phases")
   at the block's height, then derive the prover feed from the resulting
   journal and compute the digest exactly as apply does.
3. Roll the transaction back and restore the prover to the snapshot
   (`prover.rollback`) — SQLite rollback does not reach the prover's
   in-memory state.
4. Use the computed digest as `header.stateRoot`, then mine.

The speculative run passes **no `DagService`** (its canonical-branch updates
are in-memory and would survive the rollback; they touch no UTXO box, so the
digest is unaffected), and performs no block storage, no `clearTemplate`, no
journal persistence, and no prover checkpoint.

**The speculation has three outcomes, not two** (P2-B phase 1c — the code
returns them as a discriminated union so no caller can conflate them):

| Outcome | Meaning | Creator's obligation |
|---|---|---|
| computed | the post-block digest | mine over it |
| no prover | no prover initialized — test-only | write `EMPTY_STATE_ROOT` and produce |
| **body rejected** | the mutation phase rejected this body | **produce nothing, and evict the included mempool entries** |

A producer with no prover initialized writes `EMPTY_STATE_ROOT`. Production
nodes always initialize one at startup, so this is a test-only path — but a
node running with `VERIFY_STATE_ROOT` enabled will reject such a block, which
is correct.

**Body rejected is fatal to production, and the eviction is not optional.**
Mining over a body this node's own mutation phase refuses produces a block
nothing will accept — the pre-fix code warned "the block cannot be produced"
and then mined it anyway. Producing nothing while *leaving the entries pooled*
is worse still: the creator rebuilds the identical body every interval, and
`MEMPOOL_EXPIRY_BLOCKS` can never rescue it because expiry keys on a chain
height that stops advancing the moment the node stops producing — a permanent
silent stall. Eviction-on-rejection is the same semantics the finalize path
already applies to a rejected block, and it is load-bearing for exactly this
reason. An unexpected throw during speculation counts as **body rejected**,
not as "no prover": the apply funnel's totality doctrine treats the same throw
as a block rejection, so a body that crashes speculation is one no node will
apply.

Residual, recorded rather than hidden: entries that rode into the same body
are evicted with the offending one. Transaction-level drop-and-retry — evict
only the culprit and rebuild — needs the mutation phase to report *which*
transaction failed, and is not built.

**External mining.** The template's `stateRoot` is computed at template-build
time and the block is submitted later. This stays sound because any competing
block that applies at the same height calls `clearTemplate()`, so a template
whose pre-state has moved can no longer be submitted. `submitMinedBlock`
therefore depends on template invalidation for **state-root** correctness, not
merely for height correctness.

### Coinbase emission (Ergo-style linear decay)

```
if height <= CREDIT_FIXED_RATE_BLOCKS (1,051,200):
    reward = CREDIT_INITIAL_REWARD (100)
else:
    epochs = floor((height - CREDIT_FIXED_RATE_BLOCKS - 1) / CREDIT_EPOCH_BLOCKS) + 1
    reward = max(CREDIT_INITIAL_REWARD - epochs * CREDIT_REWARD_REDUCTION, 0)
```

Emission terminates: block 7,401,600 is the last that pays, and the reward is 0 above it.
The schedule and its totals are `MINING_INTERFACE → Emission Schedule`.

Coinbase outputs are locked for `CREDIT_MINER_REWARD_DELAY` (1440) blocks — 24h at 60s.
The coinbase is split per MINING_INTERFACE → Coinbase Application → The slices, and carries
the **miner's slice alone**. The treasury's share and the unearned inclusion bonus accrue to
the `TreasuryBox` — never redirected to the miner, who would otherwise recover their own
forfeit, and never a coinbase output on any network.

**Emission is released from a box, not minted.** Genesis holds the whole schedule in an
`EmissionBox` (TYPES_INTERFACE → EmissionBox) and each block spends it to a successor
`computeBlockReward(height)` smaller, so what remains to be emitted is state an observer
reads. Above the terminus no emission box exists and nothing is released.

> ✅ **The lock is enforced at spend: `SPEND_TIMING`'s `credit` entry** (§Spend timing). A
> transaction naming a locked box as an input is refused at `validateTx` step 3, on every path a
> transaction takes — pool entry, gossip relay, and block finalization's re-validation all inherit
> the one site. Checked against the input box itself, so a node holding the `stateRoot` holds
> everything the refusal reads.
>
> **Each block's coinbase credit is its own box.** It is an output of the block's settlement
> transaction: one box per block, carrying its own lock — the coinbase-keeps-its-own-box shape
> Bitcoin and Ergo use. A miner's successive rewards unlock on their own schedules, so enforcing
> one lock never freezes another block's reward.

### Difficulty schedule

`powTargetBits` is a deterministic function of block height — Phase 1 is a
fixed target (`expectedTarget(height) = ORDERING_BLOCK_POW_TARGET_BITS`),
enforced at apply on every path: a block whose header target differs from the
schedule is rejected. There is **no wall-clock retargeting** — the previous
duration-ratio adjustment was removed because it made the target a function of
local wall time (audit M-2). Normative spec: `MINING_INTERFACE.md`
("Difficulty Schedule").

### Per-block like settlement (P2-D — replaced the epoch tally)

Runs at the end of **every** block's mutation phase, through the block's settlement
transaction. The quantities are **committed, not transported**: the markers ride the block as
outputs of its like transactions, so a producer/verifier disagreement is impossible — the
settlement reads what the block itself carries (compare the retired `EpochTallyResults`, which
had to be carried and compared).

**During embedded-tx application**, each like transaction (the `likeTarget` biconditional
shape, validated by the engine):

1. Re-checks at apply: target confirmed and **live** at this height (likes on pruned
   posts rejected by stated rule); author resolved from **`block_topology`**, never
   `dag_posts.author`; like-record `(liker, targetPostId)` absent — else the tx is
   invalid and the block is rejected
2. Writes the like-record via `insertLikeRecord` (journalled side-record)
3. Applies the transaction's outputs like any other — the `LikeAccrualBox` marker among
   them — and counts the like per author and per post for the end-of-phase steps

**At end of mutation phase, after all embedded txs** (order pinned: embedded txs →
the settlement transaction → lifetime-like counters → post-lock vesting → decay clocks):

4. **Author settlement — outputs of the settlement transaction.** For each author with
   likes this block, in ascending author-hex order, the settlement consumes their `n`
   markers (in committed transaction order) and their carry box holding `r`, and emits:
   ```
   markers×n + carry(r) → authorKarma(+q·(x−1)) + pool(+q) + carry(r′)
       total = n + r,   q = ⌊total / x⌋,   r′ = total mod x,   x = LIKES_PER_KARMA_PAYOUT
   ```
   The likers funded the payout — on this path the pool is a **SINK and never a
   source**; per `x` likes the author receives `x−1` and 1 leaves circulation for good
   (**to the pool, never the treasury** — §Likes settles that, and routing it to the
   treasury would be redistribution wearing deflation's name). **The box is the carry** —
   no counter field exists; a holder cannot distinguish "destroyed" from "returned to a
   pool nothing can spend", and the accounting identity is what conservation checks.
   `IdentityRecord.lifetimeLikesReceived` is bumped in the bookkeeping step after the
   settlement, and only ever adds. All integer arithmetic; a float intermediate is a
   consensus fork.
5. **Post-lock vesting** — for each post with a non-zero per-post counter and a live
   `PostLockBox`, in ascending post-id order:
   ```
   totalLikes      = getLikeRecordCount(postId)          // lifetime, live post
   alreadyUnlocked = originalValue − value
   shouldUnlock    = totalLikes / POST_LOCK_UNLOCK_PER_LIKES   // integer division
   toUnlock        = min(value, shouldUnlock − alreadyUnlocked)
   ```
   If `toUnlock > 0`: `transferKarma` consumes the box, credits `toUnlock` to the lock's
   owner (`postlock-unlock`) and shapes the reduced lock as the remainder
   (`postlock-remainder`) unless fully unlocked — the `PostLockBox` is the source, the
   pool is uninvolved, and the transfer throws rather than create or destroy.

**Determinism:** iteration orders are pinned (author hex, post id), and the settlement's
marker inputs follow committed transaction order — every order is one the block fixes.
All arithmetic `bigint`/integer — a float intermediate is a consensus fork.

**Same-block exclusion:** a block may not carry both a like on post `P` and a prune entry
covering `P`. Prune settlement runs before embedded txs in the mutation order, so the like
finds its target pruned, is invalid, and the whole block is rejected. Producers must not
assemble such a block; the rule makes the outcome deterministic when one does.

**Blocks with no likes** run neither loop — no record writes, no like leg in the
settlement, no vesting. An author's carry box sits unchanged (and in the `stateRoot`,
because every box is) until their next liked block.

---

## Store Interface

Storage backends implement this interface. SQLite is the backend.
Fresh schema — no Phase 1 migration.

### Database lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `initDb(path)` | `(string) => void` | Initialize backend, run migrations, enable WAL |
| `getDb()` | `() => Database` | Return better-sqlite3 handle, throw if not initialized |
| `closeDb()` | `() => void` | Graceful shutdown |

### Posts DAG

| Function | Signature |
|----------|-----------|
| `insertPost(postId, post, rawCbor)` | `(PostId, Post, Uint8Array) => void` — status = pending; the id comes from the creating transaction |
| `getPost(id)` | `(string) => StoredPost \| Stump \| null` |
| `getPostRaw(id)` | `(string) => Uint8Array \| null` — raw CBOR for hash verification |
| `queryPosts({ author?, limit, offset })` | `(QueryOpts) => StoredPost[]` — live only, newest first in committed order; pending above confirmed, by arrival |
| `getPendingPosts(limit)` | `(number) => StoredPost[]` — oldest first, by arrival |
| `confirmPost(postId, blockHeight, blockIndex)` | `(string, number, number) => void` — height and committed position |
| `unconfirmPost(subBlockId)` | `(string) => void` — for fork rollbacks; clears height and position |
| `getParentRefs(postId)` | `(string) => PostId[]` |
| `getAncestors(postId)` | `(string) => StoredPost[]` — walk up parent chain, genesis → parent |
| `getSubtree(postId)` | `(string) => StoredPost[]` — all descendants (recursive CTE) |

> **`StoredPost` is `Post` plus a required `status: PostStatus`**
> (`'pending' | 'confirmed' | 'pruned'`), exported from `store/posts.ts` and re-exported from
> `store/index.ts`. It exists because **`status` is node-local state and must not enter `Post`** —
> `Post` is the consensus type and travels on the wire.
>
> ⚠ **The field is required, not optional, and that is the whole mechanism.** While `postToJson`
> declared `Post & { status?: string }`, a bare `Post` type-checked and `?? 'unknown'` read as a
> verdict rather than an absence — every response served `"unknown"` and nothing complained. A
> required field makes a caller with no status fail to compile instead.
| `pruneSubtree(rootPostId)` | `(string) => void` — mark subtree as pruned |

### Like-records (P2-D — replaces `dag_likes`)

**Table:** `like_records (target_post_id TEXT NOT NULL, liker_id BLOB NOT NULL,
applied_at_block INTEGER NOT NULL, PRIMARY KEY (target_post_id, liker_id))`. Written
**only** at block application (never by an HTTP route — the retired free-like tier's
`dag_likes` rows were route-written, which is what made the old epoch mint a DAG-index
read inside consensus). Content-layer consensus state, the `block_topology` tier:
deterministic by replay, journalled with exact inverses, not in the `stateRoot`. The
`dag_likes` table is **dropped**.

| Function | Signature |
|----------|-----------|
| `insertLikeRecord(targetPostId, likerId, blockHeight)` | `(PostId, UserId, number) => void` — **block application only**; records a `likeRecordInsertions` journal side-record; throws on the primary key — the structural dedup |
| `hasLikeRecord(targetPostId, likerId)` | `(PostId, UserId) => boolean` |
| `getLikeRecordCount(postId)` | `(PostId) => number` — lifetime likes on a live post; feeds post-lock vesting and API `likeCount` |
| `deleteLikeRecordsForPosts(postIds)` | `(PostId[]) => void` — **prune settlement only**; captures every deleted row as a `likeRecordDeletions` journal side-record before deleting |
| `deleteLikeRecord(targetPostId, likerId)` | `(PostId, UserId) => void` — fork-rollback inverse (never records) |
| `restoreLikeRecord(targetPostId, likerId, appliedAtBlock)` | `(PostId, UserId, number) => void` — fork-rollback inverse (never records) |

### UTXO

| Function | Signature |
|----------|-----------|
| `getBox(boxId)` | `(string) => AnyBox \| null` |
| `getUnspentBoxes()` | `() => AnyBox[]` — all unspent boxes (for AVL bootstrapping) |
| `getKarmaBox(owner)` | `(Uint8Array) => KarmaBox \| null` — single box (backward compat) |
| `getKarmaBoxes(owner)` | `(Uint8Array) => KarmaBox[]` — multi-box listing (full boxes, keyed on `id` — the contract previously said `{ boxId, value }[]`, which was never the implementation) |
| `getKarmaValue(owner)` | `(Uint8Array) => bigint` — **summed** value of every unspent karma box. **Consensus input** (the vouch minimum-balance gate), and the single implementation every validation path shares. It must sum, never read one box: `getKarmaBox` is `LIMIT 1` with no `ORDER BY`, so a single-box read makes the verdict a function of SQLite's physical row order — M-12's class. Kept as one store function rather than a closure per deps literal, because a consensus-critical read reproduced at each call site is the mirror pattern that produced `computeTxIdLocal` and the copied `u32BE` |
| `getCreditBox(owner)` | `(Uint8Array) => CreditBox \| null` — single box |
| `getCreditBoxes(owner)` | `(Uint8Array) => CreditBox[]` — multi-box, `ORDER BY value DESC` (the contract previously said `{ boxId, value, lockedUntilBlock? }[]`, which was never the implementation) |
| `getBondFor(inviteePublicKey)` | `(UserId) => BondBox \| null` — the bond naming this key; the settlement path resolves through this |
| `getBondsInvitedAt(invitedAtBlock)` | `(number) => BondBox[]` — bonds whose invitee's record carries exactly this `invitedAtBlock`. The caller subtracts `INVITE_PROBATION_BLOCKS` from the settle height, so the store stays free of network parameters. ⛔ **The query MUST require `invitedAtBlock > 0`**: `0` is every never-invited identity, so at the single height where `settleHeight == INVITE_PROBATION_BLOCKS` the argument is `0` and an unguarded match sweeps the whole table |
| `getBondBoxes(inviterId)` | `(UserId) => BondBox[]` — active bonds |
| `getLikersForPost(postId)` | `(string) => string[]` — hex user IDs who liked; reads `like_records` (P2-D), `ORDER BY liker_id` so the listing is a function of state, not row order (N4a ratification) |
| `getUnspentPostLockBoxes()` | `() => PostLockBox[]` |
| `getPostLockBox(targetPostId)` | `(string) => PostLockBox \| null` |
| `insertBox(box)` | `(AnyBox) => void` — writes the provenance columns; records `{kind:'box', op:'insert', boxId, box}` while a block journal is open |
| `consumeBox(boxId, consumedAtBlock)` | `(string, number) => void` — mark a **live** box spent; records `{kind:'box', op:'remove', boxId}` while a block journal is open. ⛔ **Throws `BoxNotLiveError` when no live row matched.** The `UPDATE` carries `AND spent_at_block IS NULL` and checks the row count, so the journal entry follows a real spend instead of a caller's assumption. ⚠ **Not a `CorruptChainStateError`** — a caller naming a box the store does not hold live is a rejection, not a reason to stop the node |
| `unconsumeBox(boxId)` | `(string) => void` — un-mark spent (fork-rollback inverse; never records) |
| `deleteBox(boxId)` | `(string) => void` — (fork-rollback inverse; never records) |

(P2-D deleted the like-box readers — `getLockedLikeBoxes`, `getUnspentLikeBoxes`,
`getUnprocessedLockedLikeBoxes`, `getPostTotalLikes` — and `markLikeBoxesTallied`, the
epoch's sentinel-spend choke point. Like counts come from `getLikeRecordCount`.)

#### Box provenance columns (Spec G phase B)

`utxo_boxes` carries each box's creating-transaction provenance, because
`BoxBase` does (`TYPES_INTERFACE.md` → BoxId):

| Column | Type | Meaning |
|--------|------|---------|
| `tx_id` | `TEXT` | Creating transaction — real, or synthetic (→ "Box Identity and Mint Provenance") |
| `output_index` | `INTEGER` | u32 position within that transaction's outputs |

`rowToBox` restores both onto every box it reconstructs; `insertBox` writes
them. `id TEXT PRIMARY KEY` stays and **becomes sound at phase G**: two
byte-identical boxes in one block currently collide on it (a plain `INSERT`
throws and the totality catch rejects the whole block), which provenance-derived
ids make structurally impossible. Do not paper over the window with
`INSERT OR REPLACE` — that would silently drop a box.

`UNIQUE(tx_id, output_index)` is required. A `(txId, index)` pair names exactly
one box by construction, so no valid block can trip it; the constraint turns a
derivation bug into a loud failure rather than silent state corruption.

**Migration window (phases B–F):** both columns are nullable, and the unique
index tolerates that because SQLite treats NULLs as distinct — producers do not
set provenance until phase C. **Phase G makes them `NOT NULL`.**

#### `created_at_block` is a store column, never a consensus input

`createdAtBlock` left the box protocol (Spec G D3): it was the only
apply-mutated field, and that is what made box ids dishonest (M-11). The
**column** survives, written at apply from the *settled* height, and is
therefore honest by construction.

> ⚠ **Consensus code MUST NEVER read `created_at_block`.** It is not committed
> in the `stateRoot`, so a node bootstrapping from an AVL snapshot cannot
> reconstruct it. A consensus read would be an undetectable divergence surface:
> two nodes agreeing on every committed byte could still disagree. No assertion
> can enforce this — it is a contract and code-review rule.

Legitimate readers are `getUnspentBoxes` ordering and display.
**`getUnspentBoxes` feeding `bootstrapAvlProver` is not a counterexample:** the
bootstrap sorts by boxId at the prover boundary (M-12), so the SQL order never
reaches the tree. That sort is what makes this column safe to keep.

Consensus reads its heights elsewhere — locks from `lockedUntilBlock`, bond
probation and the decay clock both from the identity record below. During the migration window `createdAtBlock` is
still a *box field* (`TYPES_INTERFACE.md` → Migration window) and `decay.ts`
still reads it, so the column does reach consensus transitively until phase D
moves the clock. Closing that is exactly what phase D is for; phase G then
deletes the field and leaves the column with no consensus reader at all.

### Identity Records (Spec G phase B)

The second committed entity alongside boxes: the per-identity decay clock.
Once boxes carry no height, `decay.ts` has nothing to read from them, so the
clock has to live in committed state (Spec G D4).

```
IdentityRecord {
  lastActivityBlock: number     // u32 — starts at the claim height that creates the record; bumped when a non-decay karma box is created for the owner
  lastDecayBlock: number        // u32 — bumped when decay fires
  invitedAtBlock: number        // u32 — height the invite grant applied; 0 = never invited
  lifetimeLikesReceived: bigint // likes this identity has ever received; never decremented
}
```

⛔ **The outstanding like accrual is deliberately NOT a field here.** The carry sits in a
`LikeAccrualBox` — **the box IS the carry** (ARCHITECTURE → Likes) — and a record field
beside it would be two representations of one quantity, free to disagree. The carry reaches
the `stateRoot` either way, because every box does.

**The record's existence is the invite bar; `invitedAtBlock` is the probation
clock and nothing else.** An invite may only name a key holding no record at all,
so the field decides one thing: the paired bond settles at
`invitedAtBlock + INVITE_PROBATION_BLOCKS`. A bond therefore carries no probation
fields of its own.

⚠ **`0` is a reachable value here, not a safe sentinel.** Every identity that
received karma without being invited carries it — genesis committee members and
faucet recipients — so *"never invited"* and *"invited at block 0"* are not
distinguishable by the value alone. **Any sweep keyed on this field must exclude
`0` explicitly**, and there is exactly one height where it matters: when
`settleHeight == INVITE_PROBATION_BLOCKS`, the target `invitedAtBlock` is `0` and
an unguarded query matches every never-invited identity in the table.

**`lifetimeLikesReceived` is monotonic, and that is the point.** Per-block like
settlement increments it; **nothing decrements it, prune included.** Deriving the
count by joining live posts instead would let a third party burn someone else's
bond: Alice invites Bob, Bob replies in Carol's thread and earns likes, Carol
prunes her thread, and Alice's stake forfeits. That is precisely what *"you may
destroy your own stake, never someone else's"* forbids — the rule that also makes
prune return other authors' post bonds. Likes carry economic weight now, so they
fall under it.

⛔ **Two fields on this record can be silently destroyed by a careless writer.**
The record is a full-row upsert and the type forces every field *present*, so a
writer passing `0` compiles and passes typecheck while erasing a probation clock
or a like history. **Every writer other than the one that owns a field carries the
stored value through unchanged** — `invitedAtBlock` and `lastActivityBlock`'s
**epoch** are owned by the grant path (the claim write initializes the activity
clock to the claim height; advancement stays the store choke point's),
`lifetimeLikesReceived` by the lifetime-counter bookkeeping.

**AVL key** — `blake2b512( IDENTITY_KEY_DOMAIN ‖ identityId )[0:32]`, **never
the raw `identityId`.** Records and boxes share one 32-byte AVL keyspace, and
an `identityId` is 32 *attacker-chosen* bytes (a public key): used raw, someone
could grind a keypair whose pubkey equals a live box id and collide the two
entity kinds in the tree. Hashing under a domain tag makes that infeasible and
is what makes the two kinds provably disjoint.

**Table:** `identity_records (identity_id BLOB PRIMARY KEY, last_activity_block
INTEGER NOT NULL, last_decay_block INTEGER NOT NULL, invited_at_block INTEGER
NOT NULL DEFAULT 0, lifetime_likes_received INTEGER NOT NULL DEFAULT 0)`. The
SQL table keys on the raw 32 bytes; the AVL key is derived. Both are total
functions of the identity, so the two representations cannot drift.

#### Layout — IdentityRecord

> **It lives here rather than in `TYPES_INTERFACE` because `IdentityRecord` is a `node` type
> and `state/serialize-box.ts` is its only encoder** — but it uses the same writer vocabulary,
> and `TYPES_INTERFACE` → Layout — Boxes governs the box arm of the same tree.

| # | Field | Encoding |
|---|---|---|
| 1 | tag | `u8` — **`0x80`**, the record discriminator (see "Two entity kinds") |
| 2 | `lastActivityBlock` | `vlqU` |
| 3 | `lastDecayBlock` | `vlqU` |
| 4 | `invitedAtBlock` | `vlqU` |
| 5 | `lifetimeLikesReceived` | `vlqU64` |

**The tag is part of the layout, not a wrapper around it** — the box arm works the same way, where
`enum8(boxType)` is field 1 of `boxContentBytes` rather than a prefix bolted on outside it. One
encoder, one byte string, no composition step where a caller could disagree about ordering.

**Domains, and where they are established.** `lastActivityBlock`, `lastDecayBlock` and
`invitedAtBlock` are `u32` block
heights; `vlqU` is total *by sentinel*, so an out-of-domain height cannot panic the encoder — it
**collides**, exactly as `createdAt` did in the header before 1f. `lifetimeLikesReceived` is
`vlqU64` and `writeVlqU64OrThrow` **throws** outside `[0, 2⁶⁴)`; the domain belongs upstream of
the encoder — the lifetime-counter bookkeeping is its only writer, it is unbounded by design and
bounded only by the writer's `2⁶⁴`. One like per block for the life of the chain does not
approach that, and the field is a **count**, never an amount — a saturating or wrapping write
here would silently re-price every bond that settles afterwards. **A domain check at the encoder
would be the band-aid; if the field ever gains a second writer, that writer owns the domain.**

> ⚠ **The same encodable-versus-storable gap that narrowed box values applies here, one field over.**
> `lifetimeLikesReceived` is `vlqU64` into a SQLite `INTEGER`, which is **signed**, so its real
> ceiling is `2⁶³ − 1` and not the `2⁶⁴` above (TYPES_INTERFACE → "Box value domain"). **Left
> unnarrowed deliberately**: it is a count bounded by like traffic rather than a value bounded by
> conservation, so the unreachability argument is stronger here than it ever was for box values.
> Recorded because the *reasoning* differs, not because the gap does.

⚠ **Two cbor-era hazards on this record are retired by construction, and the field discipline is
NOT.** Conditional presence and key order were both consensus-visible under cbor-x (§1a, §1b). A
positional layout has no keys and no map header, so neither is expressible. **`invitedAtBlock` and
`lifetimeLikesReceived` must still always be written, zero included** — not because absence would
fork the bytes any more, but because the fields are part of the record and a layout writes every
field. Likewise `bigint` stays `lifetimeLikesReceived`'s type: under `vlqU64` a `number` and a
`bigint` of equal value encode identically, so the type no longer guards the *bytes* — it guards
the `safeIntegers` row boundary against a silent `Number()` coercion, which is a different and
still-live reason.

| Function | Signature |
|----------|-----------|
| `getIdentityRecord(identityId)` | `(UserId) => IdentityRecord \| null` |
| `putIdentityRecord(identityId, record)` | `(UserId, IdentityRecord) => void` — upsert; while a block journal is open, captures the row it replaces and records `{kind:'record', key, record, replaced?}` |
| `deleteIdentityRecord(identityId)` | `(UserId) => void` — fork-rollback inverse only; never records |

**Lifecycle:** created on first karma receipt or on the first like received (the
lifetime-counter write), **never deleted** in normal
operation — only by rollback. Deleting at zero balance would keep the tree
smaller but would require revert to resurrect records with their exact prior
values; unbounded-but-simple is the deliberate choice at this stage.

**Key type is `UserId`. There is no separate identity type, and there should not
be one.** Spec G D5 originally called for a branded `IdentityId` alias over the
same 32 Ed25519 public-key bytes, on the reasoning that it would make future key
rotation a one-definition change rather than a re-keying of committed state.
That does not hold: box `owner`, `likerId`, `inviterId` and `voucherId` are the
same pubkey and all typed `UserId`, so if rotation ever lands, box *ownership*
has to move to the stable identity as well — otherwise karma stays owned by a
retired key. The two types would move together, not diverge, and the seam cannot
be exercised on the decay record alone. Branding buys safety only between things
that are structurally identical but semantically different; these are
semantically the same thing, so it buys nothing and costs a cast at every
boundary. **D5 is withdrawn** (spec corrected 2026-08-05).

`IDENTITY_KEY_DOMAIN` is unaffected — it separates the record's AVL key from the
box keyspace, which is a distinct concern from how the bytes are typed.

#### Populating the record

- **`lastActivityBlock`** — bumped at the **store choke point**, `insertBox`,
  when the inserted box is a karma box with `nonActivity !== true` — the owner's
  own spends bump; settlement outputs and vesting returns carry the flag and do
  not.
- **`lastDecayBlock`** — bumped when decay fires for that owner.
- **`invitedAtBlock`** — written only by block application when an invite grant
  applies (the settlement's grant leg); every other writer carries it through.
- **`lifetimeLikesReceived`** — bumped only by the lifetime-counter bookkeeping
  after the settlement, for every author who received likes in the block; only
  ever adds.

**Two heights meet at `insertBox`, and they answer different questions.**

⛔ **The `created_at_block` COLUMN takes the box's own `createdAtBlock`** — the height its creator
declared and signed, which `canonicalBoxBytes` encodes and the box id covers. The column is a
denormalisation of a committed field, not an independent observation.

⛔ **The ACTIVITY CLOCK takes the open journal's height** — `beginBlockJournal(height)`, the height
this block is settling at. It must not read the box: the clock records *when the chain saw activity*,
and a creator-declared value is not that. **A backdated box would otherwise backdate its owner's
decay clock**, which is the one place the loose creator-declared bound would become exploitable.

The record is only meaningful during block application, which is exactly when a journal is open.

With no journal open (bootstrap, non-block paths) `insertBox` records nothing,
consistent with every other choke-point hook.

**A missing record means maximally stale, never "skip this owner".** The
fallback is `{lastActivityBlock: 0, lastDecayBlock: 0}`. Both total options are
defensible in isolation and they fail in **opposite directions**, which is why
the choice belongs here rather than in whoever writes the code: over-charging an
identity by a fraction of an interval is recoverable and visible, whereas
silently exempting one from decay forever is an unbounded economic hole and
looks like nothing at all. Choose the recoverable failure.

With genesis writing its own record (below), this path should be unreachable —
but "should be unreachable" is exactly the condition under which a silent
exemption would never be noticed.

**Genesis is the one box created with no journal open.** `ensureSystemKarmaBox`
runs at startup, so the system identity gets no record from the choke point. It
must be given one explicitly at `genesisHeight`, **not** left to a
default-to-zero: `genesisHeight` is `1` (`currentHeight > 0 ? currentHeight : 1`),
and a `{0, 0}` default makes the system identity go stale exactly one block
earlier than the old code did. With `threshold = 100`, the old predicate goes
stale at height 101 (`1 > 101 − 100` is false); `lastActivityBlock = 0` goes
stale at 100.

**`bootstrapAvlProver` MUST feed identity records, not only boxes.** It
currently walks `getUnspentBoxes` alone. Records reach the tree through the
journal during block application, so from phase D onward a node that restarts
with empty AVL storage would rebuild a tree containing **no records at all** and
compute a different `stateRoot` than one that stayed up — the same
restart-triggered fork class as 1a and 1c, introduced by populating the record.
Records are fed in the same canonical order as boxes (lexicographic by hex key).
A bootstrapped tree and a live tree must agree once records exist, and that
needs a test.

> ⚠ **SUPERSEDED (2026-08-07) — rebuilding the tree from the UTXO set is unreachable and
> unsound, and the requirement above is retired. Re-verified 2026-08-11.** The requirement
> was the right fix for the tree it described; the mechanism itself does not survive scrutiny.
>
> ⚠ **The code has NOT been deleted.** `bootstrapAvlProver` still exists in
> `node/src/state/avl-prover.ts`, and `store/identity-records.ts` still carries a note naming
> it as a caller. This marker read "is being removed" — a *decision*, stated in the future
> tense, which then never got a follow-up. **Superseded describes the requirement; it does not
> describe the tree.** Deleting the function is open work.
>
> - **Unreachable.** The trigger is `storage.version() === null`, and under
>   `@ergots/avltree` 0.4.0 the `PersistentBatchAVLProver` constructor writes
>   the empty-tree version to empty storage — so the condition is statically
>   false after `createAvlProver()`. Almost certainly a regression from the
>   0.4.0 migration (`7c8fbe5`), unnoticed because nothing exercised the path.
> - **Unsound even if revived.** AVL+ tree *shape* is history-dependent, so a
>   tree rebuilt by re-inserting a set does not generally have the digest of a
>   tree grown incrementally to the same content. Measured: identical 7-box
>   content agreed on the digest in **6 of 10 rounds** (content lookups agreed
>   10/10). A rebuilt node would therefore fork against a node that never
>   restarted — the failure the rebuild exists to prevent.
>
> **The sound restart path is the persisted tree**, which the constructor
> loads and which is what every normal restart already uses. Replay from the
> journal would also be sound and is not built.
>
> **Operational consequence: AVL storage must never be wiped independently of
> the chain.** There is no recovery path that reconstructs a matching tree
> from boxes. Wiping both together is the only supported reset.

### Vouch escrows

**There is no vouch-cooldown store machinery.** An unvouched stake waits in a
`VouchEscrowBox` — an ordinary box in the UTXO set and therefore in the
`stateRoot` — created as the unvouch transaction's output and consumed by the
owner's own reclaim transaction (§Vouch transition rules). The escrow's create
and spend are journalled by `insertBox` / `consumeBox` like any other box;
no bespoke side-records exist.

| Function | Signature |
|----------|-----------|
| `hasActiveVouchEscrow(voucherId)` | `(UserId) => boolean` — true while any unspent `vouch_escrow` box names the voucher as `owner`. **Consensus input**: the cast gate (§Vouch transition rules) |
| `getVouchEscrowsFor(voucherId)` | `(UserId) => VouchEscrowBox[]` — the API's cooldown listing (`GET /vouches?voucher=X&cooldowns=1`) |

⛔ **A block-application effect keyed on node-local SQL that no committed root
covers is a fork waiting to happen** (§the settlement transaction's determinism
obligation). The escrow being a box is what satisfies that here: every rule
that reads it reads committed state.

### Block Topology

| Function | Signature |
|----------|-----------|
| `insertBlockTopology(postId, parentRefs, author, blockHeight)` | `(string, string[], string, number) => void` |
| `getSubtreeTopology(rootPostId)` | `(string) => Set<string>` |
| `getTopologyAuthor(postId)` | `(string) => string \| null` |
| `rollbackBlockTopology(blockHeight)` | `(number) => void` |

`block_topology` rows record `(post_id, parent_refs, author, block_height)` —
all sourced from the confirming block's post transactions (consensus data, never
from local DAG content). `author` is the creating transaction's signer
(audit H-3); `getTopologyAuthor` returns `null` for posts no applied
block has confirmed. Idempotent insert (first block to confirm a postId wins);
`rollbackBlockTopology` removes a reverted height's rows wholesale.

### Mempool

| Function | Signature | Description |
|----------|-----------|-------------|
| `insertUtxoTx(tx, expiresAtHeight)` | `(UtxoTransaction, number) => number` | Queue UTXO tx, returns rowid |
| `insertMempoolPrune(entry, expiresAtHeight)` | `(PruneEntry, number) => number` | Queue prune entry, returns rowid |
| `drainMempoolPrunes(limit)` | `(number) => PruneEntry[]` | Decode and return prune entries in FIFO order |
| `removeMempoolPrunes(entryIds)` | `(string[]) => void` | Remove confirmed prune entries by rowid |
| `getPendingEntries(limit)` | `(number) => PoolEntry[]` | FIFO-ordered pending entries |
| `purgeExpired(currentHeight)` | `(number) => number` | Remove entries past expiry, returns count |
| `hasPendingLike(targetPostId, likerId)` | `(string, string) => boolean` | SQL EXISTS over gate metadata — unbounded (M-8) |
| `countPendingInvites(inviterId)` | `(string) => number` | SQL COUNT over gate metadata — unbounded (M-8) |
| `hasPendingVouch(voucherId)` | `(string) => boolean` | SQL EXISTS over gate metadata (L-4) |
| `removeEntry(rowid)` | `(number) => void` | Remove confirmed entry by rowid |

All insert functions throw a typed `MempoolFullError` at `MAX_MEMPOOL_ENTRIES`
(default 10000). Three callers, three behaviors: routes map it to 503; gossip
relay handlers drop the entry and log; **reorg re-insertion**
(`services/fork-resolution.ts`, returning reverted txs and prunes to the
pool) also drops-and-logs — it runs inside the chain-switch SQLite transaction,
so an escaping error would roll back the reorg and strand the node on the
lighter chain, turning mempool pressure into a consensus-liveness failure.
Full semantics in `MEMPOOL_INTERFACE.md`.

`PoolEntry`:
```
{
  rowid: number
  entryType: "utxo_tx" | "prune"
  utxoTxCbor: Uint8Array | null
  pruneEntryCbor: Uint8Array | null
  expiresAtHeight: number
  createdAt: string
}
```

See `MEMPOOL_INTERFACE.md` for the full mempool contract.

### Ordering blocks

| Function | Signature |
|----------|-----------|
| `createOrderingBlock(block)` | `(OrderingBlock) => void` |
| `getOrderingBlock(height)` | `(number) => OrderingBlock \| null` |
| `getCurrentHeight()` | `() => number` |
| `deleteOrderingBlock(height)` | `(number) => void` — for fork rollback |

### Refused headers

> ⚠ **AHEAD OF CODE on branch `fork-choice-verified-headers`** — landed by the node dispatch, which
> removes this line.

The chain-selection memory (`Fork choice decides on verified headers`, step 12): one row per block
that fork resolution applied under verified headers and the funnel rejected.

```sql
CREATE TABLE refused_headers (
    hash        TEXT PRIMARY KEY,   -- blockHash of the rejected block's header
    height      INTEGER NOT NULL,   -- its height
    refused_at  INTEGER NOT NULL    -- our tip height when it was refused
);
```

| Function | Signature |
|----------|-----------|
| `insertRefusedHeader(hash, height, refusedAt)` | `(string, number, number) => void` — idempotent on `hash` |
| `anyRefusedHeader(hashes)` | `(string[]) => boolean` — true iff any hash is marked |
| `purgeRefusedHeaders(belowHeight)` | `(number) => void` — called beside `purgeOldJournals`, same bound: `height − MAX_REORG_DEPTH` |

**One row suffices for a whole continuation.** A segment starts at a fork point *on our chain* and
the refused block is not on our chain, so if the refused block is an ancestor of a segment's tip it
sits inside that segment at its own height — `anyRefusedHeader` over the verified hashes is complete
for continuations without storing descendants. **The purge is safe for the same reason:** a refused
height below `tip − MAX_REORG_DEPTH` cannot appear in any segment `findForkPoint` can anchor.

**The mark is written outside the reorg transaction**, after it has rolled back — a write inside it
would roll back with it. It persists across restarts and is removed only by the purge; a deploy's
database wipe removes it with everything else.

### Block Journal

The journal is the single source of truth for undoing a block and for feeding
the AVL prover (ARCHITECTURE → "Block application journal"). One CBOR-encoded
row per applied block, purged below `height − MAX_REORG_DEPTH` (20).

**Types are node-owned** (`src/store/journal.ts`); `@dagsocial/types` exports
no journal types.

```
BoxMutation {
  kind: 'box'
  op: 'insert' | 'remove'
  boxId: string                    // hex
  box?: AnyBox                     // full box — present iff op === 'insert'
}

RecordMutation {                   // Spec G phase B — identity records
  kind: 'record'
  key: string                      // hex — H(IDENTITY_KEY_DOMAIN ‖ identityId), the AVL key
  identityId: UserId               // the raw 32 bytes, so rollback can address the SQL row
  record: IdentityRecord           // the value written
  replaced?: IdentityRecord        // prior value — absent iff the key did not exist
}

JournalMutation = BoxMutation | RecordMutation

BlockJournal {
  blockHeight: number
  mutations: JournalMutation[]     // ordered, application order — state rollback + AVL feed
  confirmedSubBlockIds: string[]   // inverse: unconfirmPost; also mempool re-insertion
  appliedUtxoTxs: Array<{ txId: string, txCbor: Uint8Array }>   // mempool re-insertion only
  likeRecordInsertions: Array<{ targetPostId: string, likerId: UserId }>
                                   // inverse: deleteLikeRecord (P2-D)
  likeRecordDeletions: Array<{ targetPostId: string, likerId: UserId,
    appliedAtBlock: number }>      // inverse: restoreLikeRecord — a reverted prune
                                   // restores the subtree's like-records exactly (P2-D)
}
```

**One log, not parallel arrays (Spec G phase B).** `mutations` is a
discriminated union over **every committed entity**, not a box-only log with
sibling arrays. That is deliberate and load-bearing: a committed entity that
never reaches the prover feed is silently absent from the `stateRoot`, and
**no test can catch that** — the producer and the verifier omit it identically,
so they agree on a digest over incomplete state. Making the feed derivation
switch on `kind` turns "a new entity kind was added and nobody updated the
prover feed" into a TypeScript exhaustiveness error. That compile-time check is
the enforcement mechanism; do not replace it with a parallel
`recordMutations: RecordMutation[]` array, which reinstates exactly the
drift-by-omission shape P1 removed.

The typed side-records below (`confirmedSubBlockIds`, `likeRecord*`, …) stay
separate arrays because they are **not** in the `stateRoot` — they are node-local
bookkeeping with an exact inverse. `kind: 'record'` is the first entry that is
both journaled *and* committed, and that is the whole distinction.

**Recording (choke point).** `beginBlockJournal(height)` opens the journal at
the top of block application. While open, the store mutation primitives record
automatically: `insertBox` appends `{kind:'box', op:'insert', boxId, box}`;
`consumeBox` appends `{kind:'box', op:'remove', boxId}`; `putIdentityRecord`
appends `{kind:'record', …}`, capturing the row it replaces;
`insertLikeRecord` and
`deleteLikeRecordsForPosts` append their side-records, capturing the affected row(s)
before writing. Services and call sites MUST NOT maintain parallel mutation
bookkeeping — record-once at the choke point is the drift fix (C-5, H-5, H-7,
and the merge-consume value-loss class). With no journal open, every
primitive behaves as before and records nothing (bootstrap and non-block
paths). The rollback inverses — `deleteBox`, `unconsumeBox`,
`deleteIdentityRecord`, `deleteLikeRecord`, `restoreLikeRecord` — never record.
`beginBlockJournal` while a journal is open throws (the apply funnel's totality
catch turns that into a block rejection).

| Function | Signature |
|----------|-----------|
| `beginBlockJournal(height)` | `(number) => void` — throws if a journal is already open |
| `finishBlockJournal()` | `() => BlockJournal` — returns and closes the open journal; throws if none is open |
| `abortBlockJournal()` | `() => void` — discards the open journal (no-op when none) |
| `insertBlockJournal(journal)` | `(BlockJournal) => void` |
| `getBlockJournal(height)` | `(number) => BlockJournal \| null` |
| `deleteBlockJournal(height)` | `(number) => void` |
| `purgeOldJournals(belowHeight)` | `(number) => void` |

**Rollback (`revertBlock`).** Refuses to run while a block journal is open.
Replays `mutations` in reverse order — `box`/`insert` → `deleteBox(boxId)`,
`box`/`remove` → `unconsumeBox(boxId)`, `record` → `putIdentityRecord` with
`replaced` when present, otherwise `deleteIdentityRecord` — then the
side-record inverses, then
`rollbackBlockTopology`, block + journal deletion, **and the height's AVL
version rows** (`SqliteAvlStorage.deleteVersionAtHeight`). The version rows
are per-block derived state exactly like the block and journal rows: left
behind, `versionAtOrBeforeHeight` resolves rolled-back state (proof endpoint
included), and re-applying a block at the height — a reorg back to a
previously-reverted chain — re-inserts the same content-addressed version
and trips its PRIMARY KEY, permanently rejecting the block.
Apply-then-revert MUST restore the exact pre-block UTXO set and AVL digest
for every mutation class: the settlement transaction's every leg (coinbase
credits, protocol-box successors, invite grants, like markers and carry,
decay replacements, prune refunds, fee-box consumption), post-lock vesting's
transfer, like-record inserts and prune-time deletes (rows restored
exactly), prune settlement, user txs, and **identity records**. Reorg
re-insertion reads `appliedUtxoTxs` (txCbor) and `confirmedSubBlockIds`.

Reverse order is what makes a record written **more than once in one block**
revert correctly (activity bump then decay, at the same height): each inverse
undoes one write, and the last one replayed is the *first* write's `replaced` —
the true pre-block value. Do not "optimise" this into a per-key single restore
that keeps the last `replaced`; that restores an intra-block intermediate.

**Breaking:** this shape replaces the former dual representation
(`consumedBoxIds`/`createdBoxIds` alongside typed arrays). Fresh DB required
(already mandated by P0's box-value change).

### Stumps

| Function | Signature |
|----------|-----------|
| `insertStump(stump)` | `(Stump) => void` — simplified Stump (rootPostHash, authorId, replyCount, upvoteCount, protocolVersion, compactedAtBlockHeight) |
| `getStump(stumpId)` | `(string) => Stump \| null` |

`insertStump`'s only caller is prune settlement in block application — every
row derives from a PruneEntry the funnel verified (see "Pruning" → "Stumps
are derived state"). Because the insert is unconditional at settlement and
every apply path goes through the one funnel, a settled prune without its
stump row cannot arise on a fresh chain; there is no repair or pull path.

⚠ **Known gap (recorded, not fixed here):** stump inserts are not
journalled, so `revertBlock` does not remove them — a reorged-away prune
leaves its stump row (and `getPost` keeps resolving it) until the entry
settles again on the winning branch. Belongs to the journalling work
sequenced with P2-D4.

### AVL+ State Root

The `packages/node/src/state/` module provides an authenticated dictionary over
**committed state** using AVL+ trees — the UTXO set, and from Spec G phase B
also identity records (see "Two entity kinds" below).

- **avl-storage:** Persistent AVL+ tree, stateRoot computed at each block
  application and included in block headers
- **avl-prover:** Generates inclusion/exclusion proofs for any key
- **avl-endpoint:** `GET /api/v1/proof/:boxId?atHeight=N` — serves proofs to
  light clients
- **Config:** `VERIFY_STATE_ROOT` (validate on apply, **default on** — set
  `VERIFY_STATE_ROOT=false` to disable) and `MAX_PROOF_HISTORY` (prune old
  proof versions)
- **Verification:** apply computes the post-mutation digest and rejects the
  block unless it equals `header.stateRoot`. Both sides are post-block (H-6),
  both feeds are canonically ordered (M-12), and the mutation set is
  journal-derived (P1) — so a mismatch means genuine state divergence, not a
  representation difference. A rejected block leaves the prover restored by
  the funnel's single rollback point
- ⛔ **A box block application SPENDS must already be in the tree, and THE TREE IS ASKED.**
  `applyBlockMutations` and `bootstrapAvlProver` read `performOneOperation`'s verdict at every
  operation that can refuse one — `Remove` of an absent key, `Insert` of a present one — and throw
  `DivergedStateTreeError` on a refusal. The first refusal stops the feed. `InsertOrUpdate` is
  total and carries no verdict to read. The genesis boxes satisfy the rule by construction:
  `bootstrapAvlProver` runs over `getUnspentBoxes()` at height 0, before any block — seed a box
  *after* the prover bootstrap and block 1 removes a key that was never inserted.

  ⛔ **A refusal is a FAIL-STOP, not a block rejection, and that is the half a later reader must
  not "correct".** The tree mirrors `utxo_boxes`, so both arms say the mirror has drifted rather
  than that a peer sent something wrong — the two-arm provenance argument is under "The one
  condition this node stops for". A drifted tree refuses the *next* block identically, so
  rejecting would reject forever while staying up.

  ⚠ **A single-node ROOT COMPARISON cannot catch this class.** Producer and verifier are the same
  process, so both compute the same wrong root and it matches. **What is assertable is the throw**;
  a test that seeds a divergence and compares digests passes for the wrong reason.

  ⛔ **A FIXTURE'S SEED ORDERING IS LOAD-BEARING IN BOTH DIRECTIONS, and no count of suites states
  it.** Committed state enters the store first and the tree is built from it second — the order
  `seedGenesisState` runs in, and the one `test/helpers.ts`'s `activateProverOverStore` exists to
  own. A box seeded
  *behind* the bootstrap is absent from the tree, so the first block spending it is refused; a seed
  already *ahead* of it must not be moved back. **The two mistakes are different populations of
  suite and they overlap** — one file can hold both — which is why the rule names the ordering
  rather than a number of files.

  ⚠ **A fixture running the real `seedGenesisState` cannot use that helper and cannot hand-seed a
  box at all.** The seeder does this same ordering itself, and a hand-seeded box fits neither side:
  after it the tree never receives the box; before it the box joins the genesis feed, which is that
  same `getUnspentBoxes()` read, and `assertGenesisRoot` refuses the pinned root inside the seeding
  transaction. Such a fixture mines **coinbase-only** blocks, which still move state off genesis by
  releasing the emission box.
- **Journal-fed:** the per-block mutation set is derived from
  `BlockJournal.mutations` — intra-block insert+remove pairs for the same
  boxId net out; inserted box bytes come from the journal's `box` payload,
  never a store re-fetch (`getBox` returns null for created-then-consumed
  boxes and silently dropped them). The derivation switches on `kind` and
  **must be exhaustive** — see "One log, not parallel arrays" above
- **Canonically ordered (M-12):** `applyBlockMutations` sorts internally —
  all removes, then all inserts, then all record puts, each lexicographically
  by hex key — so every caller inherits the canonical order; callers MUST NOT
  rely on their input order reaching the prover. `bootstrapAvlProver` sorts
  the unspent set by boxId the same way. Same mutation set in any input order
  → same digest. ⚠ **That equivalence is unconditional for boxes but holds for
  records only across *distinct* keys** — see "Where record collapsing happens"
  below. Repeated writes to one record key are order-dependent, and sorting
  cannot recover which was last
- **Rejection-safe:** the apply funnel snapshots the prover digest before any
  mutation and rolls the prover back on **every** rejection path — explicit
  rejection, stateRoot mismatch, and the totality catch (closes the open
  f4a683f remnant). ⚠ **The fail-stop is where restoring stops mattering, and
  the two paths reach that differently.** The funnel's corrupt-state arm
  restores before re-throwing; `computePostBlockStateRoot` calls the boundary
  inside its `catch`, and `process.exit(1)` does not unwind, so its `finally`
  restore never runs. Both are correct — nothing reads the tree after the exit
- **Reorg-abort-safe:** `reorg()` snapshots the prover digest before reverting
  anything; if applying the new chain fails mid-way, the reorg transaction
  rolls the DB (including AVL storage rows) back wholesale, and the reorg's
  catch restores the in-memory prover to the pre-reorg digest — the per-block
  funnel restore only covers the failing block, not the applied prefix
- **A reorg applies exactly the verified chain it scored, or nothing.** `reorg()` reverts above
  `forkHeight` and applies exactly what it is handed, so the caller — the only site that knows what
  the reorg was *for* and which peer to name — admits nothing to it that was not scored: the block
  answer must hold one block per verified header and every block's header must hash to the verified
  hash at its height (`Fork choice decides on verified headers`, below). `net` bounds the response
  count but never *requires* one, and a short or substituted answer is not malformed bytes — nothing
  upstream can tell it from a peer that legitimately has nothing — so the check is the caller's.
  The criterion is **work**, compared over headers that have passed the header-level rules; no height
  comparison stands in for it, so a retarget changes the schedule the verifier is handed and nothing
  about this rule.
  > ⚠ **AHEAD OF CODE on branch `fork-choice-verified-headers`** — landed by the node dispatch,
  > which removes this line.

#### Two entity kinds (Spec G phase B)

The tree holds **boxes** (key = `boxId`) and **identity records**
(key = `H(IDENTITY_KEY_DOMAIN ‖ identityId)`; see Store Interface → Identity
Records). Three things follow, and all three are consensus-critical.

**1. The value bytes must be self-describing.** The first byte is the
discriminator; `deserializeBox` MUST reject a non-box tag rather than mis-decode
it, and a kind-dispatching decoder is what any value-reading caller uses.

⚠ **The box discriminator is `enum8(boxType)` from `TYPES_INTERFACE` →
Layout — Boxes — NOT a second numbering owned by this package. Decided
2026-08-10 (Phase 5).** The record tag stays `0x80`, high bit set, so "box"
versus "not a box" is still a single bit test and the box-type space stays open.

| | Discriminator space |
|---|---|
| Box | `enum8(boxType)`: `0` karma, `1` credit, `2` invite, **`3` genesis_proof**, `4` bond, `5` post_lock, `6` vouch |
| Identity record | `0x80` |

**This replaces a second, disagreeing numbering that this package used to
carry** (`0x01` karma … `0x07` vouch, with `0x03` reserved). The two were
written at different times and nobody had put them side by side. They do not
differ by a constant: the **reserved slot sits in a different position** — AVL
reserved `0x03` between `credit` and `invite`, `enum8` reserves `3` between
`invite` and `bond` — so `invite` was `+2` while every other type was `+1`.

The collision surfaced when the AVL value moved onto `boxRecordBytes`, which
**begins with `enum8(boxType)`**: prefixing the old tag would have written the
box type **twice, in two disagreeing numberings, in adjacent bytes**. Found by
the Phase 5 executor, who was told the tag scheme must not move and correctly
refused to hand-compose around it. **The instruction was wrong** — it protected
a *discipline* ("a retired type's tag is never reused") by pinning specific
*numbers*, and the discipline survives intact on one numbering that already
reserves `3`. Two numberings for one concept was never load-bearing; it was an
artifact of two encoders written months apart.

Safe to renumber because this phase moves the `stateRoot` regardless and the
standing deploy gate mandates a wiped AVL store with a fresh chain — there is no
history whose bytes must still parse. **That is a one-time window, not a
standing licence.** `enum8`'s numbering is the committed one.

⚠ **Tag `3` carries `genesis_proof` and is no longer reserved.** The reassignment
is governed by the three conditions in `TYPES_INTERFACE` → Primitives — no
surviving history carries the tag, every other tag keeps its number, and the
retired *name* `like` stays reserved — not by precedent from this paragraph.
**Renumbering an assigned tag remains forbidden**; reassigning a reserved number
and renumbering an assigned one are different operations, and only the first is
available.

**1a. The AVL value carries provenance, and an absent key is not an
`undefined` key.** `serializeBox` strips only `id` and `boxType` — `txId` and
`index` stay in the value, and must, because "a box id is a total function of
the stored box" is only *checkable from a proof* if the proof's value carries
everything the derivation consumes. The AVL key already commits to them; the
redundancy is what lets a light client verify honesty rather than trust it.

> ⚠ That makes the box object's **exact key set** consensus-critical, and
> cbor-x distinguishes an absent key from a present-but-`undefined` one. A key
> set to `undefined` encodes as `f7` *and* increments the fixed two-byte map
> header — measured: `{value, guard}` → `b90002…`, the same object plus
> `txId: undefined, index: undefined` → `b90004…f7…f7`. So a box reconstructed
> by `rowToBox` with explicit `undefined` provenance serializes to different
> bytes than the same box built by a producer without those keys, and a node
> that **restarts** and re-bootstraps its prover from `getUnspentBoxes` would
> compute a different `stateRoot` than one that stayed up. A restart-triggered
> consensus fork, from nothing but an object shape.
>
> **Provenance keys are therefore assigned conditionally, never as explicit
> `undefined`** — the discipline `rowToBox` already applies to `nonActivity` and
> `lockedUntilBlock`. Box **ids** are not exposed to *this* hazard:
> `canonicalBoxBytes` destructures `id`/`txId`/`index` away, so it is total
> over both shapes. Only the AVL value is.

**1b. Key ORDER is consensus-visible too — and is currently violated.** Found
by the phase B1 session, verified and extended by main. Neither encoder
canonicalises map key order: cbor-x emits keys in JS insertion order, so
`{value, guard, owner}` and `{owner, value, guard}` produce different bytes.
This is **wider than 1a** — it reaches `canonicalBoxBytes`, and therefore box
**ids**, not only the AVL value. The contract already warns that
`canonicalBoxBytes` is not RFC 8949 canonical CBOR; key order is the other half
of what that non-canonicality costs.

The implicit convention is that `rowToBox` mirrors each producer's field order.
It holds for karma, credit, like, invite and bond — checked, including the demo
UI, which builds client-side box types in `rowToBox`'s order. **It does not hold
for `post_lock`:**

| Source | Order after `serializeBox` strips `id`/`boxType` |
|--------|--------------------------------------------------|
| `block-creator.ts` remainder box | `value, originalValue, createdAtBlock, owner, guard` |
| `rowToBox` / demo UI | `value, createdAtBlock, originalValue, owner, guard` |

Measured: identical length, different bytes (`…6d6f726967696e616c56616c7565…` vs
`…6e637265617465644174426c6f636b…`). Two consequences:

- **Latent fork.** A partial post-lock unlock inserts the remainder box in
  producer order; `bootstrapAvlProver` later re-serialises it in `rowToBox`
  order. Bootstrap only runs when AVL storage is empty while the UTXO set is
  populated — which is exactly the documented "wipe the AVL SQLite store"
  deploy step. Wiping the store *without* also wiping the chain silently
  changes the `stateRoot`. Currently unreachable only because the deploy gate
  mandates both.
- **It breaks Spec G's central promise.** `stored.id === computeBoxId(stored)`
  is supposed to become structural at phase G. Under order sensitivity it does
  not: re-deriving an id from a `rowToBox`-reconstructed `post_lock` yields a
  different id than the producer computed. Provenance does not fix this — only
  a canonical field order does.

> **Resolution: canonical key ordering is a phase G obligation.** Both encoders
> must impose an order rather than inherit the caller's — lexicographic key sort
> is the simplest total rule. Phase G is already the one phase where ids
> legitimately move and every id-asserting test updates together, so folding it
> in costs no extra churn; doing it earlier moves ids twice.

> ✅ **RESOLVED — closed in phase G3b 2026-08-06, and closed *harder* since. Re-verified
> 2026-08-11.** The hazard was that a producer chose CBOR map key order, making field order
> consensus-visible. G3b fixed it with a `sortKeys` pass on both encoders.
>
> ⚠ **That description is now stale: `sortKeys` has ZERO call sites.** The positional migration
> superseded it — a positional layout has fixed field order, so the whole class is retired **by
> construction rather than by a sort**, and a stray extra key on a box object is unrepresentable
> because the encoder reads only the fields it declares. `types/src/utxo.ts` states this at
> `canonicalBoxBytes`. **`post_lock`'s producer-vs-`rowToBox` divergence is closed by the
> layout, not by the sort and not by reordering that site.**
>
> This is the second marker in Phase 9 found describing a fix that a later phase replaced with a
> stronger one (see `WIRE_INTERFACE` §VLQ). **A `RESOLVED` records that the hazard is gone; it
> does not promise the named mechanism is still the one holding.**
>
> ⚠ **The paragraph above previously ended with an interim rule that is now actively
> harmful and has been removed:** *"Until then, producers and `rowToBox` MUST agree on
> field order, and `post_lock` is a known outstanding violation."* That mandated a
> hand-maintained coupling between distant call sites which the sort exists to make
> unnecessary — following it would re-introduce exactly what G3b removed. It survived
> because G3b landed **one day after** this section was written, and the phase-G checklist
> elsewhere in this file was ticked while this section was not. **A reader consulting the
> detailed hazard section got "live fork, apply this discipline"; a reader consulting the
> checklist got "done."** Both read as authoritative.
>
> **Header key order is a separate matter and is NOT closed by this** — `encodeHeader` is
> still an unsorted `toBuffer(h)`. It holds today only because the store persists the
> producer's exact bytes and `decodeHeader` preserves their order on the way back. See
> §Ordering Block Creator.

**1c. Key order is attacker-controlled on transaction outputs.** Found by the
phase C3 session, and it is 1b's hazard weaponised rather than accidental.

A transaction's outputs arrive as **client-supplied CBOR**, and `computeTxId`
hashes them through `canonicalBoxBytes`, which strips `id`/`txId`/`index`. A
client may therefore plant `txId` and `index` keys *at arbitrary positions* in
an output's map **without changing the txId it signs** — the signature does not
constrain what the signature does not cover.

If the node then materialised that output by assigning provenance **in place**,
the keys would keep the attacker's chosen positions, while `rowToBox` appends
them last. Different key order, different AVL value bytes, and therefore a
**restart-triggered `stateRoot` fork that an attacker chooses when to trigger**,
for the cost of reordering two keys in a transaction they were sending anyway.

> **Every box materialised from decoded CBOR MUST have provenance stripped and
> re-appended, never overwritten in place.** `materializeOutput` is the single
> materialisation rule for transaction outputs and both the UTXO engine and the
> apply path go through it — two rules would be two chances to get the position
> wrong.

Phase G's canonical key ordering subsumes this: once the encoder imposes an
order, an attacker's key positions cannot survive into the value at all. Until
then, strip-then-append is the guard, and it is the reason `materializeOutput`
exists as a shared function rather than an inlined assignment.

**2. The proof endpoint must not throw on a record, and must say which kind it
served.** `GET /api/v1/proof/:boxId` decodes whatever value the key resolves to;
a record-shaped value would throw under a box-only decoder. Keys are
indistinguishable from outside — both kinds are 32 bytes of hash output — so a
client *can* ask for one. Landed in phase D, alongside populating the record.

The response carries **`kind: 'box' | 'record' | null`**. This is required, not
cosmetic: the proof verifies the value bytes whichever kind they are, so without
an explicit discriminant a light client would verify a valid proof and then read
a record as a box with every field `undefined` — treating committed state as a
malformed box. That is strictly worse than the throw it replaced, because it
fails silently and *with* a valid proof. `null` distinguishes an absent key (a
valid exclusion proof) from "present, and not a box".

*(The route parameter is still named `boxId` while addressing two entity kinds.
Renaming it is a public API change and deliberately not done here.)*

**3. Disjointness must be re-argued, not inherited.** The comment in
`avl-prover.ts` justifying the remove-group/insert-group split argues from
"box ids commit to `createdAtBlock`" — a premise Spec G **deletes**. Rewrite it.
The property survives and strengthens:

- *Removes vs inserts.* A key in the remove group was in the tree before this
  block; a key in the insert group is created by it. Under provenance-derived
  ids a box id is a function of `(candidate, txId, index)`, so two boxes share
  an id only if they share all three — i.e. the same transaction applied at two
  heights. A real tx cannot be: its inputs are consumed on first application.
  **That step depends on every user tx having at least one input**, which the
  UTXO engine enforces by rejecting empty-input txs; a zero-input user tx would
  be replayable and would break this argument, so that rejection is load-bearing
  for identity, not just for value. A synthetic mint tx cannot be either:
  `mintTxId` commits to the height. Intra-block insert+remove pairs for one id
  were already netted out upstream. So the two groups are disjoint, and the
  split can never reorder ops on a single key. This is *stronger* than the old
  argument, which only ruled out same-block recurrence.
- *Boxes vs records.* Disjoint by domain separation, not by luck — box ids and
  record keys are hashes under different domain tags. This is why the record
  key is hashed rather than the raw 32-byte pubkey, which an attacker chooses.

**Record ops use `InsertOrUpdate`.** A record put is a create on first write and
an update afterwards, and the feed does not know which — `InsertOrUpdate`
collapses that distinction so the prover feed needs no existence lookup. Two
puts to the same key in one block collapse to the **last** value (last write
wins, identical final tree); the journal keeps both entries because rollback
needs the first one's `replaced`. Netting is per-kind: boxes cancel
insert+remove pairs, records keep the last write — do not share one code path.

**Where record collapsing happens, and why it is not arbitrary.** The collapse
belongs to **`proverFeedFromJournal`**, not to `applyBlockMutations`. Box
mutations commute: cancel the insert+remove pairs in any order and the surviving
set is the same, which is why `applyBlockMutations` can own box canonicalisation
by sorting. **Record puts do not commute** — two writes to one key differ in
*which came last*, and that is carried by journal application order alone. Once
`applyBlockMutations` sorts by hex key, that information is gone; a sort cannot
recover it, and any behaviour that appeared to work would be relying on sort
stability. So the collapse must happen while journal order is still
authoritative, and `applyBlockMutations` receives **at most one entry per record
key**. The natural reading — "`applyBlockMutations` owns canonical ordering,
therefore it owns this too" — is wrong, and wrong in a way that produces a
silently order-dependent digest. *(Gap found by the phase B session; pinned
here because the contract previously stated both rules without saying which
function owns the collapse.)*

`applyBlockMutations`' `recordPuts` parameter is **optional and defaults to
empty**, so the many existing four-argument call sites keep working. That
default is a convenience for tests only: **every production caller MUST pass the
feed derivation's own `recordPuts`**, never omit it and never assemble one by
hand. Omitting it silently drops records from the digest, and if one of the two
callers omitted it, the producer and the verifier would disagree — the exact
failure H-6 exists to prevent.

**`applyBlockMutations` takes the block height as its second parameter**, ahead
of both feeds and required, because a `DivergedStateTreeError` carries `site`
and `height` as *fields* and the state layer has no other way to know the
height. Second rather than last, because a required parameter cannot follow the
defaulted `recordPuts`.

### dag_meta Table

A key-value metadata table stored alongside post data. Used for schema
versioning, migration sentinels, watermarks, and operational state.

**Schema:**
```sql
CREATE TABLE dag_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
```

**Required keys and their invariants:**

| Key | Value encoding | Invariant |
|-----|---------------|-----------|
| `dag_tip_hash` | 32 bytes | Updated atomically with every canonical DAG advance. |
| `reorg_floor` | u32 LE | Height below which no reorg is accepted. |

> ⚠ **There is no startup rebuild to contract for.** This section required
> `last_validated_sequence` and `last_indexed_sequence`, and a startup line reading them "to
> rebuild the in-memory DAG view". **No such rebuild exists** — `dag-service.ts` queries
> `canonical_branch` per call, every `Map` and `Set` in it is local to a method, and nothing is
> loaded at startup. The two keys were write-only `+1` counters with no reader and no reorg reset,
> and their writer is deleted.
>
> **Same phantom as the `dag_load_started` / `dag_load_complete` events**, which described the same
> rebuild and were removed from `JOURNAL_EVENTS.md` for the same reason.
>
> ⚠ **The two remaining keys are carried forward unverified.** Whether `dag_tip_hash` and
> `reorg_floor` have writers and readers matching these invariants **was not re-derived** when the
> watermarks were removed — do not read their presence here as confirmation.

### No store schema version, and none is owed

**A node does not version its own database and does not refuse to start against an old one.**
There is no `schema_version` key, no counter compiled into the binary, and nothing reads a
store's age to decide whether to run.

⚠ **`store/db.ts` does hold five functions named `migrate*`, and they are not what this section
denies.** They run unconditionally on every `initDb`, in a fixed order, each deciding for itself
whether it has work by inspecting the shape it would change — no version, no sentinel keys, no
ordering contract, nothing to skip and nothing to resume. What does not exist is a **versioned**
migration path: a stored number that selects which passes to run. That is the thing a launched
chain will need and the thing there is no point building before one exists.

The mechanism has no regime in which it is both correct and useful (user, 2026-08-13):

- **Before launch**, a store is wiped whenever a committed encoding moves, which is often. A
  gate that fires only when the wipe was skipped is redundant with a wipe that is happening
  anyway.
- **After launch**, the chain cannot be nuked at all. A node returning from an outage across an
  upgrade needs its store *migrated*, and a version gate would refuse to start it while
  prescribing the one remedy that is unavailable. The gate is not merely useless there — it
  turns a recoverable node into a dead one.

⚠ **This is not a statement that store shape never changes.** It changes freely. What is stated
is that the *node* does not adjudicate it: before launch the operator wipes, and after launch a
migration path is a design problem to be solved when there is a chain worth migrating, not a
counter to be incremented in advance of one.

⚠ **Nothing else stands in for it, deliberately.** A store carrying data an encoding has moved
under produces a `stateRoot` mismatch at the first inbound block — late, and naming two digests
rather than the store. That is the accepted cost of the ruling above, not an oversight.

## Service Layer Architecture

Express route handlers are thin facades with zero business logic. Every
handler: validates input shape → delegates to a service → serializes the
result. An `if` that makes a domain decision belongs in the service, not
the handler.

**Service modules and their responsibilities:**

| Service | Responsibility | Does NOT own |
|---------|---------------|--------------|
| `post-service.ts` | Create, verify (sig, PoW, DAG linkage, content), store | Networking, block assembly |
| `feed-service.ts` | Query posts, paginate, assemble feed/thread views | Post creation |
| `dag-service.ts` | DAG fork resolution, canonical branch, reorg | Post creation, block assembly |
| `verifier.ts` | Post verification (sig, PoW, DAG linkage, content) | Network relay |
| `credits.ts` | Credit transfer validation and execution | UTXO engine internals |
| `invites.ts` | Invite lifecycle (create, commit, claim, cancel) | Bond box internals |
| `faucet-service.ts` | Faucet allocation from system keypair | Credit system design |
| `block-creator.ts` | Block creation, mining, template assembly | Post validation |
| `block-apply.ts` | Block application, UTXO settlement, per-block like settlement | Block creation |
| `utxo-engine.ts` | UTXO transaction validation and application | Block structure |
| `stump-engine.ts` | Verifiable prune execution | DAG content |
| `content-sweep.ts` | Placeholder resolution (missing post content pulled from peers) | Post creation |
| `fork-resolution.ts` | Chain fork detection and reorg | Block creation |
| `genesis-state.ts` | Cold-start seeding of the height-0 state, and the root check over it | Which boxes exist (`store/system.ts`) |

**Validation pipeline (phased, increasing cost):**
1. Signature verification (cheap — Ed25519 verify)
2. PoW verification (cheap — blake2b + difficulty check)
3. DAG linkage / parent-hash integrity (moderate)
4. Content type/size/schema validation (variable, may be I/O-bound)

A post failing Phase N is rejected before Phase N+1 runs.

Queries serve the DAG tip. There is no validated watermark and nothing gates a
read behind one.

### The genesis state root is checked fail-stop, once, where it is built

`seedGenesisState` computes the height-0 AVL+ root over the boxes it seeded and compares it to
the profile's `genesisStateRoot`. Its set is the proof box and the `EmissionBox` on every
network, plus the system karma and faucet credit boxes on the faucet-bearing ones. **A mismatch
throws and the node does not start**
(`assertGenesisRoot`, exported so it is reachable without a boot). Refusal rather than a
warning follows `loadConfig`'s below-floor ordering target: proceeding silently means running a
chain that forks from every honest peer at height 1, discovered later and somewhere else.

**It is a seeding postcondition, not a boot invariant, and the two are not interchangeable.**
Seeding is keyed on the `genesis_committed` flag, so a node that has ever applied a block does
not re-seed and its prover holds the root of the height it stopped at — measured with a mined
block, not argued. A boot-time comparison against the genesis pin would therefore refuse every
node with a chain. The comparison means something only on the path that just built the state it
checks. Ergo checks its `genesisStateDigestHex` in the same place, at initialisation rather
than on every start.

**Inside the seeding transaction, not after it.** The throw rolls back the boxes, the identity
record, the tree rows and the flag together, so a divergent genesis is never committed.
Checked after the commit it would fail exactly once: the next start finds the flag set, skips
seeding, and runs on the divergent state with nothing left to check it.

⚠ **Two things this does NOT cover.** A store whose genesis is already committed is never
re-checked, so flipping `NETWORK_TYPE` against one is caught at the chain link when it meets
peers, not at boot (ARCHITECTURE → "How the network is committed"). And the pin moves whenever
the box bytes move — **C8 re-derives two of the three roots**, caught loudly here rather than
silently.

**`seedGenesisState` claims the committed flag under `BEGIN IMMEDIATE`.** The `genesis_committed`
read that decides whether to seed happens inside the write lock, never outside it. Two processes
opening one database file both observe an unset flag if either reads it before taking the lock, and
both proceed to seed a store only one of them can commit. The read outside the transaction is a
fast path — it keeps every start after the first from taking a write lock — and **no decision may
rest on it**.

**The genesis mint height is `GENESIS_HEIGHT`.** Seeding requires a store at height 0, so there is
no other height a genesis box could commit to; the seeders raise it to 1 for the mint txId, because
0 is not a height a block ever settles at. That clamp is one function (`store/system.ts` →
`genesisMintHeight`) and is shared with the non-genesis callers of `ensureSystemKarmaBox` and
`ensureFaucetCreditBox`, which pass real heights.

**A refused genesis exits in three steps**: the message, then `closeDb()`, then a non-zero exit.
It is the only startup gate in `index.ts` with this shape, and closing the handle before exiting
is what keeps a refusal from leaving a `-wal` beside a store the operator is about to inspect.

**`getGenesisProofBox` orders its `LIMIT 1`.** Exactly one proof box is reachable — `OUTPUT_SHAPE`
excludes `genesis_proof` so no transaction mints one, and `assertEmptyBeforeGenesis` refuses to seed
over an existing one — but that is an argument about the rest of the tree, and an unordered
`LIMIT 1` names no row if it ever expires. **No index on `box_type`**: the function has two callers
and runs once per process, and an index there would tax every `insertBox` on the apply path.

### Fork choice decides on verified headers

> ⚠ **AHEAD OF CODE on branch `fork-choice-verified-headers`** — landed by the node dispatch, which
> removes this line.

**Every rule that decides a reorg lives in `resolveFork`; `reorg` is the mechanism that carries
out a decision already made.** The decision, in order — each step that ends the resolution ends it
with the chain untouched:

1. **Counterparty.** The peer that relayed or served the block, if it is Active; else the head of
   the Active list (NET_INTERFACE → Pull Requests).
2. **Their headers.** `requestHeaders(block.height, MAX_REORG_DEPTH · 2)`, newest-first. No
   headers → no decision, no penalty: "has nothing" is legitimate.
3. **The fork point.** `findForkPoint` — refuse-whole on an unhashable entry, `GENESIS_HEIGHT` when
   the chains share only the genesis state, `null` when the divergence is deeper than
   `MAX_REORG_DEPTH`. `null` → no decision, no penalty: a deep fork is indistinguishable from an
   honest peer.
4. **The anchor and the segment.** Anchor = `{ prevBlockHash, height: f }` where `prevBlockHash` is
   the hash of our block at `f`, or `GENESIS_PREV_BLOCK_HASH` at `f = 0`; segment = their headers
   above `f`, chronological.
5. **Verification.** `verifyHeaderChain(segment, anchor, expectedTarget)` (VALIDATION_INTERFACE →
   verifyHeaderChain). A refusal is classified: `index 0` · `reason 'height'` · `f === 0` is a
   **window miss** — their chain stands more than `MAX_REORG_DEPTH · 2` above a genesis-rooted fork
   and the request, not the answer, was short; no penalty, and the pull path retries from our
   tip + 1. Every other `(index, reason)` is a served chain that is not one: refuse and penalise
   (NET_INTERFACE → Peer Penalty System, `misbehavior`).
6. **Memory.** Any verified hash present in `refused_headers` (Store Interface → Refused headers)
   refuses the segment and penalises (`misbehavior`) — before any work is compared or block
   fetched.
7. **Work.** `verdict.work <= cumulativeWork(ours above f)` → keep ours. Strictly greater wins; a
   tie keeps the incumbent.
8. **Their blocks.** `requestBlocks(f + 1, f + n)` for `n = segment.length` — the range is the
   verified segment's, never a peer-claimed tip height.
9. **Tip re-read.** Our tip moved during the awaits → abort, no penalty.
10. **Identity.** Fewer than `n` blocks → refuse, penalise `transient` (non-delivery). Any block whose
    header hash is not `hashes[i]` → refuse, penalise `misbehavior`. Nothing is reverted before
    this step.
11. **The switch.** `reorg(f, blocks)`, atomic: on a rejected block it throws
    `ReorgBlockRejectedError { height, hash }` after the transaction has rolled back and the prover
    is restored.
12. **The mark.** `resolveFork` catches that error and, **after** the rollback, records the rejected
    block's hash in `refused_headers` in its own write, and penalises `misbehavior`. A mark written
    inside the reorg transaction would roll back with it.

**What is remembered, and what is not.** Header-stage refusals (steps 5, 6, 10) are cheap to
re-check and are remembered nowhere — the peer is penalised and the segment is gone. A body-stage
rejection (step 11) is the expensive case and the one remembered: verified headers over an invalid
body. **The mark records a consensus rejection and nothing else** — a rejection that depends on
local configuration or policy must not mark, because a persisted mark is only as right as the node
that wrote it; the schedule is checked at step 5 precisely so that a wrong-profile node never
reaches step 11.

**Both entries converge.** Gossip receipt and pull-sync both reach `handleOrderingBlock(block,
fromPeerId)`: a block already held (our block at its height hashes to its header) is a **no-op** —
neither applied nor resolved; a block that extends our tip, or arrives at height 0, is applied;
anything else enters `resolveFork` with the delivering peer as counterparty. The pull handler's
return is the batch's **continue** signal — `true` for applied or already held, `false` for rejected
or for a non-extending block — and `net` stops the batch at the first `false` (NET_INTERFACE → Sync
Handler Registration). A pull trigger therefore always sits at our tip + 1, where the
`MAX_REORG_DEPTH · 2` window always reaches an anchor within `MAX_REORG_DEPTH`.

**Concurrency.** Resolutions may overlap — gossip already allows it, and the pull path adds
triggers, not a class. Two resolutions serialise at step 9: `reorg` is synchronous and nothing awaits
between the re-read and the call, so the second always sees the first's height and aborts.

**Apply stays the authority.** `reorg` runs every block through `applyOrderingBlock`, so the
header-level rules run twice — once over the segment, once in the funnel. The funnel is unchanged
and remains the single consensus gate (`Ordering block apply-time authorization`).

### Fork resolution bottoms out at the genesis state

**Reaching height 0 in the ancestor walk IS a common ancestor**, at depth = our height.
`findForkPoint` returns `GENESIS_HEIGHT` (`0`) where it previously returned `null` for chains
that share no block. Heights still start at 1, so height 0 holds no block and no hash — what it
holds is the genesis *state*, which every node on a network shares byte for byte because the
section above makes any other one fail-stop. There is nothing for a peer to lie about: a
height-1 block has its `prevBlockHash` checked against `GENESIS_PREV_BLOCK_HASH` (TYPES_INTERFACE
→ Genesis parent hash) before it can be stored — the same value a fork at 0 hands
`verifyHeaderChain` as its anchor — and that
check is on every path into the store, and what makes "every path" true is stated on
`createOrderingBlock` in `node/src/store/ordering.ts`: one writer, called from `applyBlockBody`
downstream of the chain-link gate in the same function. All four callers of `applyOrderingBlock`
(gossip, sync pull, block creator, `reorg`) go through it.

**`MAX_REORG_DEPTH` does not move.** Height 0 became a reachable *answer*; how far back a reorg
may go is unchanged, and must be — journal retention is the real floor under revert depth, and
`revertBlock` throws without a journal. The walk reaches 0 only when our height is at or below
the bound, which is exactly when every journal down to height 1 is still retained. Deeper than
that the answer is still `null`.

**The genesis fallback sits behind the batch check, deliberately.** A header batch with an
unhashable entry is refused whole and answers `null` — it does not fall through to genesis.
In front, a peer could turn one malformed header into "we fork at genesis" and buy a
full-chain reorg attempt with it, on precisely the short chains where the whole walk is inside
the window.

**Downstream of a `0`,** `reorg` reverts every block, rolls the prover to
`versionAtOrBeforeHeight(0)` — the genesis version, and the genesis one only because seeding
deletes the empty tree's height-0 version before writing its own — and re-applies from a
`currentHeight` of 0, which is the chain-link check's genesis branch. Verified end to end
rather than reasoned about; `test/services/fork-resolution.test.ts` pins the round trip against
the pinned root.

---

## Canonical DAG (Best DAG as a View)

**Design principle:** All posts from all branches are stored permanently.
The canonical DAG is a view derived from cumulative PoW. Switching branches
is a view update — posts are never deleted.

**Tables:**
```sql
CREATE TABLE canonical_branch (
    depth    INTEGER PRIMARY KEY,
    post_id  TEXT NOT NULL
);

CREATE TABLE post_scores (
    post_id           TEXT PRIMARY KEY,
    cumulative_score  INTEGER NOT NULL
);
```

**Fork-choice rule:** Strictly greater cumulative score wins. Equal score
= no reorg (first-seen wins on ties). No timestamps or content hashes
in fork resolution.

**Atomic reorg:** Switching canonical branches updates both the in-memory
DAG view and the `canonical_branch` table in a single transaction. If the
store transaction fails, the in-memory view is rolled back.

**Reorg floor:** If the node started from a snapshot at depth D, reorgs to
depths < D are rejected (`dag_meta` stores the floor depth).

**Reorg event:** Emit `dag_reorg` with `fork_point`, `demoted` count,
`old_tip`, and `new_tip`.

---

## Admin Listener

A second Express server on `127.0.0.1:ADMIN_PORT` (default 3001). Never
binds to a non-loopback address — a non-loopback bind logs a WARN at
startup.

**Endpoints:**

`GET /health` — in-memory metrics only. Never queries the database.
Always returns 200. Response shape:
```json
{
  "status": "ok",
  "dag_tip_height": 12345,
  "validated_height": 12344,
  "indexed_height": 12345,
  "peers_connected": 8,
  "last_post_received_ms_ago": 234,
  "syncing": false,
  "uptime_seconds": 84200,
  "apiVersion": "1.0",
  "journalEventsVersion": "1.0"
}
```

`GET /stats` — cumulative counters with `since` (process start):
```json
{
  "since": 1751400000,
  "statsVersion": "1.0",
  "counters": {
    "posts_created_total": 5432,
    "posts_validated_total": 5430,
    "pow_verifications_total": 6100,
    "pow_verification_failures_total": 2,
    "peer_messages_in_total": 89000,
    "peer_messages_out_total": 92000,
    "peer_bytes_in_total": 125000000,
    "peer_bytes_out_total": 131000000,
    "http_requests_total": 12000,
    "unknown_message_types_total": 0
  }
}
```

---

## Configuration

**`MAX_PROOF_HISTORY` may not sit below `MAX_REORG_DEPTH`, and `loadConfig` refuses at load rather
than clamping.** `checkpointProver` prunes AVL versions below `height - maxProofHistory` while the
fork walk reaches back a fixed `MAX_REORG_DEPTH` and can answer height 0, so a smaller retention
window prunes inside the window the walk still answers within: `reorg` finds no version at its fork
height and aborts with the node still on its own chain. The check is a negated `>=`, so `NaN` —
what `parseInt` answers for a non-numeric env value — is refused rather than admitted.

All config via environment variables with defaults.

**Every variable carries a `Class`. The class is normative, not descriptive.**

| Class | Meaning | Rule |
|---|---|---|
| `consensus` | Changing it diverges committed state or block validity | **MUST NOT be readable from the environment.** Two nodes differing on any one of these partition permanently. These belong in `@dagsocial/types` as constants |
| `consensus-check` | Does not change what is *valid*; disables a node's own verification of it | May be configurable, but the contract must state what stops being checked |
| `advertised` | Reported to clients; the verifier enforces a compile-time constant instead | Changing it changes what the node *claims*, not what it *accepts* |
| `network-identity` | Selects the network — **and with it every consensus parameter, the wire magic, and the genesis** | Not a within-network parameter; nodes on different values are different networks. **Exactly one variable carries this class** |
| `local` | Genuinely a node's own choice — producer behaviour, resource ceilings | Free to vary |
| `operational` | Paths, ports, keys, addresses | Free to vary |

⚠ **Nine of these were undocumented until 2026-08-06, and five of those are `consensus`.** The
convention exists because the absence of one is a live defect class: nothing marked which variables an
operator may safely change, and four consensus parameters were environment-tunable.

> ✅ **RESOLVED — P2-A removed all ten from the environment** (PR #8, `4670ae5`). They did not
> become better-documented environment variables; they stopped being configuration. **Five**
> are now fields of the **network profile** and **five** are plain universal constants in
> `@dagsocial/types`. Verified 2026-08-07, **re-verified 2026-08-11 by testing each of the
> eleven names for a `process.env` read in `packages/node/src`: zero hits.** The rows below are struck through and kept as a record, so an
> operator carrying an old env file can see what happened to each one — **all ten are now
> silently ignored if set.** See `ARCHITECTURE §Network Identity` and
> `TYPES_INTERFACE §Network profiles`.
>
> All ten are now fully closed: `AVL_KEY_LENGTH` was the last half-done one, and it is now a
> `@dagsocial/types` export (TYPES_INTERFACE → State format) that `config.ts` imports.

**Where each consensus value went:**

| Value | Destination | Why |
|---|---|---|
| `ORDERING_BLOCK_POW_TARGET_BITS` | **profile** | Difficulty differs per network |
| `KARMA_DECAY_INTERVAL_BLOCKS` | **profile** | Timescale differs per network |
| `KARMA_STALE_THRESHOLD_BLOCKS` | **profile** | Timescale differs per network |
| `TREASURY_PUBKEY` | **deleted outright** | The treasury is a box no key can spend, so there is no key to place anywhere |
| `KARMA_DECAY_AMOUNT` | universal constant | Economics. Devnet decays *often*, not *harder* |
| `KARMA_MINIMUM` | universal constant | Economics |
| `COINBASE_TREASURY_PCT`, `COINBASE_MINER_FLOOR_PCT`, `COINBASE_BACKER_PCT`, `COINBASE_BONUS_PCT`, `INCLUSION_BONUS_K` | universal constant | Economics — the coinbase split |
| `CREDIT_INITIAL_REWARD` | universal constant | Economics — separately, it is read and never used (A5) |
| `AVL_KEY_LENGTH` | universal constant | Format. No network has a reason to differ |

| Variable | Class | Default | Description |
|----------|-------|---------|-------------|
| `NETWORK_TYPE` | `network-identity` | `testnet` | **The profile selector — `mainnet` \| `testnet` \| `devnet`.** The only environment variable that may change a consensus parameter, and it changes every one of them together. An unrecognised value **throws at startup** rather than defaulting. ⚠ **It no longer gates a faucet** — whether a network seeds a faucet identity is `faucetPublicKey`'s presence in the profile, which reaches `genesisStateRoot`; `isFaucetNetwork` is deleted |
| ~~`AVL_KEY_LENGTH`~~ | **removed** | ~~`32`~~ | AVL tree key length — **sets the shape of every `stateRoot`** (`avl-prover.ts`). Env read deleted by P2-A; now a `@dagsocial/types` export (TYPES_INTERFACE → State format) that `config.ts` imports and plumbs through `Config.avlKeyLength` |
| ~~`KARMA_DECAY_AMOUNT`~~ | **removed** | ~~`5`~~ | → universal constant `KARMA_DECAY_AMOUNT` (`@dagsocial/types`). Devnet decays *often*, not *harder* |
| ~~`KARMA_DECAY_INTERVAL_BLOCKS`~~ | **removed** | ~~`720`~~ | → profile field `karmaDecayIntervalBlocks`. Value corrected to `1440` by P2-A (60s blocks) |
| ~~`KARMA_STALE_THRESHOLD_BLOCKS`~~ | **removed** | ~~`20160`~~ | → profile field `karmaStaleThresholdBlocks`. Value corrected to `40320` by P2-A (60s blocks) |
| ~~`KARMA_MINIMUM`~~ | **removed** | ~~`10`~~ | → universal constant `KARMA_MINIMUM` (`@dagsocial/types`) |
| ~~`ORDERING_BLOCK_POW_TARGET_BITS`~~ | **removed** | ~~`12`~~ | → profile field `orderingBlockPowTargetBits`. Closed MINING invariants 4, 5 and 7 — `expectedTarget(height)` now sources the profile, and its unused `height` parameter is the seam a real retarget will need |
| ~~`CREDIT_TREASURY_PCT`~~ | **removed** | ~~`10`~~ | → universal constant `COINBASE_TREASURY_PCT` (`@dagsocial/types`). The **env key** keeps this name; only the constant renamed, so a rename sweep that rewrites the string here changes what `config.test.ts` guards |
| ~~`TREASURY_PUBKEY`~~ | **removed** | ~~`""`~~ | Gone entirely, with no destination. The treasury's share accrues to a `TreasuryBox` that block application holds no release path for, so no key names it — see MINING_INTERFACE → Coinbase Application |
| ~~`CREDIT_INITIAL_REWARD`~~ | **removed** | ~~`10000000000`~~ | → universal constant `CREDIT_INITIAL_REWARD` (`@dagsocial/types`), which `block-creator.ts` imports directly. The dead `Config.creditInitialReward` field it left behind was pruned 2026-08-07 (audit **A5**, closed) |
| `VERIFY_STATE_ROOT` | `consensus-check` | `true` | Verify `header.stateRoot` at apply (Spec B P3). ⚠ Setting `false` removes the **sole backstop** against the `computeTxId`-collision class, where two distinct block bodies share a header |
| ~~`NETWORK_MODE`~~ | **renamed** | ~~`testnet`~~ | → `NETWORK_TYPE`. The name changes because the meaning does: it selected a faucet flag, it now selects the whole consensus parameter table |
| ~~`MAX_SUB_BLOCKS_PER_BLOCK`~~ | **replaced** | ~~`1000`~~ | → `BLOCK_BODY_BUDGET_BYTES`. A count, named for a structure that no longer exists, capping every entry type at once. Its "CONSENSUS GAP" note is closed by `MAX_BLOCK_BODY_BYTES` (`TYPES_INTERFACE` → Size caps), which is enforced in structure validation |
| `BLOCK_BODY_BUDGET_BYTES` | `local` | `MAX_BLOCK_BODY_BYTES` | Body bytes this node fills blocks **it produces** to. Genuinely local: a miner may publish smaller blocks. **Clamped to `MAX_BLOCK_BODY_BYTES`** — a node cannot raise its own consensus bound, and a value above it would build blocks every peer rejects |
| ~~`ORDERING_BLOCK_MIN_SUB_BLOCKS`~~ | **removed** | ~~`1`~~ | Sub-block arrival no longer triggers production |
| ~~`ORDERING_BLOCK_INTERVAL_MS`~~ | **removed** | ~~`60000`~~ | There is no producer timer. Block cadence is set by the ordering-block PoW target |
| `MAX_MEMPOOL_ENTRIES` | `local` | `10000` | Mempool capacity |
| `MAX_PEERS` | `local` | `50` | Max connected libp2p peers |
| `MAX_PROOF_HISTORY` | `local` | `1440` | AVL versions retained for proof serving |
| `PORT` | `operational` | `3000` | HTTP listen port |
| `ADMIN_PORT` | `operational` | `3001` | Admin listener port |
| `ADMIN_BIND_ADDRESS` | `operational` | `127.0.0.1` | Admin listener bind address. ⚠ The admin listener is **unauthenticated**; binding it off loopback exposes it |
| `DB_PATH` | `operational` | `dagsocial.db` | SQLite database path |
| `NODE_ROLE` | `operational` | `server` | `server` (applies peer blocks) or `miner` (produces blocks) |
| ~~`MINING_MODE`~~ | **removed** | ~~`internal`~~ | The node has no in-process solver. A miner node serves templates; that is the only production model |
| `MINING_SECRET` | `operational` | `""` | Mining auth secret — **required when `NODE_ROLE=miner`**; startup asserts it is set |
| `BOOTSTRAP_PEERS` | `operational` | `[]` | Comma-separated libp2p multiaddrs |
| `LISTEN_ADDRS` | `operational` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `PUBLIC_URL` | `operational` | `/` | Base path where the demo UI is served |

> ⚠ **Every "at 60 seconds" duration annotation is nominal, not guaranteed.** The block time is
> an *emergent* property of `ORDERING_BLOCK_POW_TARGET_BITS` and hashrate — there is no producer
> timer — so the real interval drifts with the participant set until a retarget tracks it, and
> every block-denominated duration drifts with it.

---

## Net Integration

The node creates a `NetNode` from `@dagsocial/net` during startup and registers
Stage 2 handlers for inbound gossip messages. Startup order:

```
1. initDb()
2. Create NetNode with config + validators
3. Register Stage 2 handlers (onOrderingBlock, onTx)
4. Register sync handlers (setBlocksHandler, setHeadersHandler) BEFORE net.start()
5. await net.start()          // connect to bootstrap, subscribe to topics
6. startHttpServer()          // begin accepting API requests
7. startBlockCreator()         // begin producing ordering blocks
```

Net starts before HTTP — the network layer is ready before the API accepts
requests. If bootstrap peers are unreachable, the node still starts (gossip
will connect as peers become available). Sync handlers must be registered
before `net.start()` — otherwise the initial sync burst is silently dropped.

Route handlers call `net.broadcastTx()` — and the block creator
`net.broadcastOrderingBlock()` — after local processing to propagate new objects
to peers. Broadcast calls are fire-and-forget — failures are logged but do
not fail the API request.

### Relay handlers (mempool-based)

- **`onTx(tx)`**: validates (read-only, `validateTx`) → inserts into mempool via
  `insertUtxoTx`
- **`onOrderingBlock(block, fromPeerId)`**: structure / PoW pre-filters (net) →
  `handleOrderingBlock` — already held → no-op; extends our tip or height 0 →
  `applyOrderingBlock` → confirms posts → removes confirmed entries from mempool;
  otherwise → `resolveFork` (AVL+ State Root → "Fork choice decides on verified
  headers"). The pull path reaches the **same** `handleOrderingBlock` through
  `setBlocksHandler`; `reorg` applies directly. The authoritative consensus checks
  — including **validator-signature verification (H-1)** — are enforced *inside*
  `applyOrderingBlock` (see "Ordering block apply-time authorization" below), so
  all three paths end at the same gate.

### Ordering block apply-time authorization

`applyOrderingBlock` is the single funnel every apply path — gossip receipt,
pull-sync, and reorg — passes through, so consensus authorization is enforced
there rather than at any one entry point.

**Structure validation in the apply funnel.** Before any field of the block is
read, `applyOrderingBlock` rejects the block unless
`verifyOrderingBlockStructure(block)` (from `@dagsocial/validation`) returns
valid. Previously this ran *only* in the gossip topic validator
(`net/src/gossip.ts`), so the pull-sync path — which decodes CBOR and calls the
apply handler directly — reached consensus code with fields of arbitrary type.
Enforcing it in the funnel makes the guarantee path-independent, and is the
same relocation already applied to the PoW target (M-2), coinbase maturity
(M-3), and the validator signature (H-1).

> ✅ **RESOLVED — verified 2026-08-10. Closed by Phase 3b's positional codecs, at all three
> layers this marker names.** Everything below the next two paragraphs is kept as the record of a
> real, measured defect and reads in the past tense.
>
> **Why it cannot recur.** `decodeStruct` (`types/src/codec.ts:578-624`) runs a four-part boundary
> check on every struct: schema projection — unknown keys are unrepresentable, a positional layout
> has no names to carry them; `isExhausted`, so trailing bytes reject rather than pad; and a
> **re-encode and byte-compare** against the input. Two distinct byte strings therefore cannot
> decode to one block — whichever is not its own canonical encoding dies at step 3. The measured
> artifact, 891 bytes against 932 both hashing to `161602de…`, is unreachable by construction.
>
> **All three named layers, re-verified 2026-08-11.** *Inbound:* every path decodes —
> `decodeOrderingBlock` in `net/src/gossip.ts` (both the topic validator and the `deliver` arm)
> and the framed sync path. *Persist:* `node/src/store/ordering.ts` re-encodes from the decoded
> value into three BLOBs — peer bytes are never stored. *Re-propagate:* `net/src/gossip.ts`
> re-encodes through `encodeOrderingBlock`. **Phase 9 retired the `AHEAD OF CODE` marker below**;
> its two factual corrections are kept there.
>
> ⚠ **One pin in this list had rotted:** `net/src/sync-codec.ts:358` now lands on a closing brace.
> The sync arms are `lpItemsCodec('legacyBlocksResponse', …)` and `('legacyHeadersResponse', …)`.
> Symbols replace the numbers throughout this paragraph.
>
> ---
>
> **The record — this was VIOLATED, measured end-to-end on the production inbound path
> 2026-08-08, not theorised. The ordering block had no closed key set at any layer, and unknown
> keys were PERSISTED and RE-PROPAGATED.** No `⚠`: it is closed by the `RESOLVED` above, and a
> `⚠` here would read as open work in the middle of a resolution note.
>
> An ordering block carrying arbitrary extra keys (`stumpIds`, `attackerJunk`)
> survives `decodeOrderingBlock`; `verifyOrderingBlockStructure` **accepts** it,
> because it checks the presence and type of *known* fields and never asks
> whether unknown ones exist; and `blockHash` is **byte-identical** to the clean
> block —
> `161602de2304b514a9e3cbc71bb1ce0a604d95c2f26f090def94d085f6a500a3` — while
> the encodings differ, 891 bytes against 932. **Two distinct CBOR byte strings
> carrying one block hash.**
>
> The mechanism: all six codecs in `types/src/serialization.ts` are bare
> `cbor-x` `encode`/`decode` plus a cast — no schema, no key filter — so
> `header`, `subBlockTree`, `utxoTxTree`, `post`, `stump` and `subBlock` all
> round-trip keys they do not declare. `blockHash` covers the **header alone**,
> so body junk rides free beneath the committed Merkle roots. (Header-level junk
> *does* change the hash, and therefore fails PoW and signature checks — the gap
> is the body.)
>
> **It is not confined to transit.** `createOrderingBlock`
> (`node/src/store/ordering.ts:45`) re-encodes from the *parsed struct*, so
> retained junk is written into `subblock_tree_cbor` on disk and re-propagated
> when the block is served. Two honest nodes can therefore hold byte-different
> blobs for the same block at the same height, with no way to tell which is
> canonical, and an attacker can inflate stored bytes with payload that
> validates.
>
> **This is exactly the property the tx envelope gate closed one layer up** —
> see "Transaction envelope shape": the key set is closed *because*
> `computeTxId` hashes only known fields, making an extra key free malleability.
> The block layer has no equivalent gate.
>
> **Scope when fixed: a validation TIGHTENING, not a format break.** Honest
> bytes do not move — no id derivation, no Merkle preimage, no CBOR shape
> changes — so this lands independently and cheaply, exactly as the envelope
> gate did, and does **not** need to ride the P2-C format-break bundle. It gets
> expensive only once a second node exists.
>
> The lineage already solved this and the research is on record (see "Output
> shape — the closed per-boxType schema"): **the serializer is the validator** —
> closed positional formats, no maps anywhere, parse-time strictness, and
> serializer-enforced rules explicitly non-soft-forkable. CBOR maps are open by
> default, which is why this class keeps recurring here and cannot recur there.

> ✅ **RESOLVED — the resolution of the marker above has SHIPPED. Verified 2026-08-11.** This read
> `AHEAD OF CODE` until Phase 9; the positional bundle is merged, so the codecs **are** positional
> (see TYPES_INTERFACE → Serialization) rather than becoming so. It takes the lineage's answer
> literally: closed formats, no maps, parse-time strictness.
>
> **The two corrections below are the point of this note and are kept.** They are factual
> findings about the defect, not predictions, and they outlive the migration that closed it. Both
> measured 2026-08-09:
>
> 1. **Its header claim is wrong.** "Header-level junk *does* change the hash, and therefore fails
>    PoW and signature checks" holds only for tampering in transit. A malicious validator mines and
>    signs *with* the junk present — `computePowHash` spreads the header, so unknown keys survive
>    into the preimage. Measured: header junk moves the hash and the block is still accepted. It is
>    unbounded header bloat, not malleability.
> 2. **It understates the reach.** Junk *inside* a Merkle-committed `subBlockEntry` also rides free,
>    because the `subBlockRoot` leaf preimage is a three-field projection
>    (`{postId, parentRefs, author}`), so committing the entry does not commit the entry object.

**`subBlockRefs` is deleted from the block — done in Phase 3b, verified 2026-08-11 — and the
structure it rode is gone whole.** `OrderingBlock` in `types/src/block.ts` carries `header`,
`utxoTxTree` and `validatorSignature`; the JSON routes derive `postIds` from the block's
post-bearing transactions (`postIdsOf`).

> ⚠ **This sentence read "(AHEAD OF CODE)" in a parenthetical rather than a marker**, so a sweep
> keyed on the `> ⚠ **NAME**` shape could not see it — the second such hiding place found in
> Phase 9, after a table cell in `ARCHITECTURE.md`. It was the only remaining one in `contracts/`.

It was never covered by any
commitment — `computeSubBlockRoot` builds leaves from `subBlockEntries` and `pruneEntries` only —
and the verifier checked its *length* against `subBlockEntries` and nothing else. Measured: a block
whose refs name entirely different post ids is accepted with an unchanged `subBlockRoot` and an
unchanged `blockHash`, and its element types were never checked at all.

That mattered because the field drove state mutation on two paths:

- `removeSubBlockEntries(...)` → `DELETE FROM mempool WHERE entry_type = 'subblock' AND subblock_id
  IN (…)`, unguarded, committing with the accepted block — a mempool-eviction primitive that drops
  unconfirmed sub-blocks network-wide without confirming them.
- the journal's `confirmedSubBlockIds`, replayed on reorg as `unconfirmPost(id)`.

The defect was an **asymmetry**: apply confirmed from the committed entry list while rollback
un-confirmed from `subBlockRefs` (uncommitted) — the inverse keyed on a different list than the
forward operation. Both directions now key on one list: the block's post ids, derived from its
post-bearing transactions (`postIdsOf`) — recorded at apply (`recordConfirmedSubBlocks`) and
replayed on reorg as `unconfirmPost(id)`.

**Embedded transactions: a mismatch rejects the block** (register row C4).

> **The proof obligation.** The block's tx loop must **prove** that every declared `utxoTxId` is the
> id of the bytes carried beside it. An arm that cannot complete that proof rejects the block. This
> is stated as a property, not as a list of arms, because the list has already gone short once: the
> spec enumerated three arms the day after a fourth landed. A guard added to this loop later inherits
> the verdict without needing a ruling of its own.

The arms as of 2026-08-10 — missing CBOR, decode failure, envelope failure, **out-of-domain output**
(the D6 check below, which is an arm of this loop and not a separate rule), and
`computeTxId(tx) !== txId` — therefore no longer `continue`. Skipping was defensible when the
alternative was an accidental throw, but the property it gives up is decisive: a body that does not
match its committed ids **applies different state under the same block hash**.

The envelope arm reaches the same verdict by the obligation rather than by a separate argument: it
runs before `computeTxId`, so a failure there means the proof was never attempted. Folding it in
costs no liveness, and that is measured rather than reasoned — 2026-08-10, 13 envelope-valid
transactions covering all six box types, **all nine `FieldType` values then defined** (`u64` at `0n` and above
2⁵³, `bytes32`, `bytes0or32` at length 0, `hex32`, `heightOrTransfer` at `-1`, `uint`, `u32`,
multibyte `string`, explicit `false`) and empty `signatures`/`inputs`/`outputs`, round-tripped
`encodeTx` → `decodeTx` under cbor-x 1.6.4 with
`computeTxId`, own-key set, prototypes and `instanceof Uint8Array` all unchanged. **The blind spot:
that measurement covers the honest path only**, and it assumes a producer's bytes come from
`encodeTx` — established by grepping the `utxo_tx_cbor` column rather than the function name, which
has exactly one INSERT writer. Bytes an attacker crafts are what the arm is for.

This also closes register row **C2** without touching any root preimage. `utxoTxRoot` commits the
ids; once a mismatch kills the block rather than skipping the tx, the bytes are transitively
committed through `computeTxId`, and "the body is swappable under an unchanged header" stops being
true.

**What the obligation does NOT cover, stated so the asymmetry is not read as an oversight.** A tx
whose inputs never appear is still dropped after the multi-pass loop exhausts `MAX_PASSES`, and the
block still applies. That survives because it is not the same property: the bytes there *do* match
their declared id, every node runs the same bounded loop over the same tx set from the same prior
state, and so every node drops the same txs. A block declaring a tx it never applies is a
producer-quality problem, not a divergence. If input liveness ever stops being decidable from local
state alone, this paragraph is what has to be re-derived.

> ⚠ **Rejection is of BYTES, not of the block hash.** A node that rejects a malformed body MUST
> remain willing to accept a well-formed body for the same block hash from another peer. Caching
> "block `abc…` is invalid" would hand an attacker who races the honest producer a permanent
> per-height censorship primitive against that node.
>
> **Nothing implements this, and that is the point** — measured 2026-08-10, no negative cache keyed
> on a block hash exists anywhere. `applyOrderingBlock` has **four** callers: `index.ts`'s gossip and
> sync handlers discard the boolean, `fork-resolution` throws on it and rolls the savepoint back, and
> `block-creator` assigns it. **None memoizes by hash**, which is the property that matters — an
> earlier draft of this paragraph said "both call sites discard its boolean", reaching the right
> conclusion from a count that was short by two. Net's bans are keyed on peer id or address, and
> `sync-machine`'s `outstanding` is an in-flight request set: a rejected block is never stored, so it
> stays absent from `blockIdIndex()` and is re-requestable. So this is a constraint on code not yet
> written, and a constraint
> with no test is a claim that decays silently. It carries a **regression test** instead: a corrupted
> body under hash `H` rejects, and a well-formed body under that same `H` then applies. The day
> someone adds a cache, that test is what fails.

**The output domain check.** `computeTxId` runs in that same loop behind `checkTxEnvelope` only, and
`checkTxEnvelope` deliberately does not type output entries, so an out-of-domain output field reaches
a throwing writer (TYPES_INTERFACE → Totality, the one stated exception). This call site MUST
therefore establish the output domain before hashing, so a bad value produces a stated rejection
rather than an exception absorbed by the funnel's totality handler.

**It does that by calling `checkOutputShape`, not by growing a second check.** That schema already
pins exactly the domains consensus accepts — `u64` as a bigint in `[0, BOX_VALUE_BOUND)`
(TYPES_INTERFACE → "Box value domain": narrower than the writer's `[0, 2⁶⁴)`, because the store is
signed), `hex32` as 64
lowercase hex, `uint`/`u32` as safe non-negative integers excluding `-0` — and it is already total on
any JS value. A narrower check written for this call site would be a second spelling of one schema,
which is the fork surface this contract rejects everywhere else. **The obligation is the whole
schema, not the `bigint` alone**: the spec names the `value` field because that is where it was
found, and any `hex32` field written by `writeHexNOrThrow` reaches a throwing writer by the
identical route.

⚠ **The example this paragraph used to give — `post_lock.targetPostId` — no longer exists.** The
field was deleted when post ids became provenance-derived, because a lock naming an id derived
from its own creating transaction is unbuildable (→ `TYPES_INTERFACE` → PostLockBox). **The
obligation is unchanged and is not weakened by losing its illustration**; `post.parentRefs`
reaches the same writer by the same route and is the live instance.

**Apply funnel: validation and mutation phases.** `applyBlockBody` is split so
the state transition can be run without the header being final — that is what
lets the block creator compute a post-block `stateRoot` through this same code
instead of a parallel implementation (H-6). The split is structural, not a
mode flag: there is no "skip the checks" parameter on the apply path.

| Phase | Contents | Runs in speculative computation? |
|-------|----------|----------------------------------|
| **Validation** | chain-link, protocol version, PoW target + PoW, validator signature, Merkle roots, coinbase value + maturity, block storage, `clearTemplate` | No — the header does not exist yet |
| **Mutation** | coinbase mint, post confirmation, DAG scores, topology, prune verification + settlement, embedded UTXO txs, per-block like settlement + post-lock vesting, decay, vouch cooldowns | Yes — verbatim, at an explicitly passed height |
| **Commit** | AVL feed + `stateRoot` verification + checkpoint, journal persistence | No — the speculative run reads the digest and rolls back |

The mutation phase takes its height as an argument rather than reading
`header.height`, and rejects a block for body-level reasons (prune
verification, embedded-tx re-validation) on both paths identically. Any check
that depends on the finalized header belongs in the validation phase.

**The funnel is total.** `applyOrderingBlock` MUST NOT propagate an exception
for any input. A block that causes an unexpected throw is a block the node
rejects: the surrounding transaction rolls back, the open block journal is
discarded, the AVL prover is restored to its pre-block digest (the funnel
snapshots the digest before the body runs — SQLite rollback does not reach
the prover's in-memory state), and the function returns `false`, exactly as
for an explicit rejection, with the error logged server-side. This is the
ARCHITECTURE invariant "no method panics on untrusted input" applied at the
consensus boundary, and it is load-bearing rather than
defensive: the gossip callback is `async` and its promise is discarded by the
net layer, so a propagated throw becomes an unhandled rejection, which
terminates the process on Node ≥ 15. Because a rejected block is never stored,
a crashing block is re-fetched on restart and crashes again — a single
cheaply-mined block would otherwise be a permanent, self-reapplying kill for
every node that receives it. Structure validation closes the known instance;
totality bounds every future one.

**Validator signature (H-1).** Before applying any state, the block is rejected
unless `verifyValidatorSignature(block.header, block.validatorSignature)` (from
`@dagsocial/validation`) returns `true`. This binds block-production attribution
(coinbase-output ownership, genesis credit distribution) to the holder of
`validatorId`'s private key: solving the PoW no longer lets a producer forge a
block under another validator's identity. The check is pure and deterministic —
it recomputes `blockHash(block.header)` and verifies the raw Ed25519 signature
against `block.header.validatorId` — so every node reaches the same verdict. It
sits alongside the height-scheduled PoW-target and coinbase-maturity checks
already enforced in this funnel, and precedes any mutation so a bad-signature
block rolls back to a no-op.

**Post authorship + prune authorship (H-3).** A post transaction carries the
**whole post** in `utxoTxs` plus the author's signature over the `TxId`, so
authorship is verified, not claimed (`TYPES_INTERFACE` → the H-3 property);
there is no separate authorship entry for a producer to fill or a node to
cross-check. Enforcement has two legs, both inside the `applyOrderingBlock`
funnel:

1. **Topology recording (confirm-time).** Topology rows are written from the
   block's verified post transactions: `insertBlockTopology(postId, parentRefs,
   author, height)` with `author` the creating transaction's signer and
   `parentRefs` the signed transaction's own. `block_topology.author` is the
   consensus authority for prune authorization, never `dag_posts.author`.
2. **Prune authorship binding (prune-time).** Before the prune entry's
   postId-set and Merkle checks, the block is REJECTED unless
   `getTopologyAuthor(entry.rootPostHash)` returns a non-null author equal to
   `entry.authorId`. The lookup reads only consensus-recorded data, so the
   verdict is identical on every node — including one that synced from
   ordering blocks alone and holds no DAG content. A root no applied block has
   confirmed has no topology author and is therefore not prunable (this also
   forecloses the empty-subtree/unconfirmed-root edge). `PruneEntry.authorId`
   is retained in the wire format and required to equal the topology author;
   the author signature check then proceeds against it as before.

### Sync handlers (pull-path)

- **`setBlocksHandler((block, fromPeerId) => boolean)`**: the sync machine's pull path into
  `handleOrderingBlock` — the same entry gossip uses (Relay handlers, above). The return is the
  batch's **continue** signal: `true` for a block applied or already held, `false` for a block
  rejected or for a non-extending block, which launches `resolveFork` with `fromPeerId` as the
  counterparty; `net` stops the batch at the first `false` (NET_INTERFACE → Sync Handler
  Registration)
- **`setHeadersHandler(getBlock)`**: serves block headers for fork resolution

A block carries its posts whole in `utxoTxs`, so there is no content-sweep and
no per-post serve path. `onPeerActive` is wired to peer-readiness
(`notePeerMet`), not to any sweep.

The node registers no stump handlers in either direction: inbound
`/dagsocial/stump/1` gossip is not consumed, `broadcastStump` is not called,
and stumps are neither requested from peers nor served to them — every node
derives its own rows at prune settlement (see "Pruning" → "Stumps are
derived state"). The net-side stump surface this orphans (topic, codec,
GetStumps/Stumps protocol, handler seams) is deleted in the same unit's net
phase; NET_INTERFACE is authoritative for that side.

---

## Preconditions
- Node.js ≥ 22
- `@dagsocial/types`, `@dagsocial/validation`, and `@dagsocial/net` packages
  built and importable
- `better-sqlite3` native bindings built
- Write access to `DB_PATH` directory
- Port available at `PORT` and libp2p listen address available

## Postconditions
- HTTP server listening on `:PORT`
- Fresh SQLite database created at `DB_PATH` with full schema including
  `mempool` table
- libp2p NetNode running with configured transports and subscribed to gossip
  topics
- Connected to bootstrap peers and meshed on all subscribed topics
- Ordering block creator running (difficulty-regulated production, internal
  or external mining)
- Ordering blocks and UTXO transactions broadcast to peers
  after local creation
- UTXO engine initialized with split validate/revalidate/apply API
- Demo UI served at `/`

## Invariants
- Secret keys never in API responses
- `raw_cbor` is the canonical authority for post content; parsed columns are
  derivative
- `post.id` is computed server-side — client-submitted IDs are ignored
- Content length limit enforced at API boundary
- Protocol version checked at verification
- Consumers call the Store interface, never the backend directly
- UTXO transactions are atomic — all boxes consumed/created in one commit
- Karma decay is virtual — sufficiency reads value through `effectiveKarma`; the
  settlement squares touched identities at block application (`ARCHITECTURE` →
  Karma decay)
- Like deduplication is the like-record's existence at block application —
  `hasLikeRecord` refuses the duplicate (relay admission mirrors it), and the
  `like_records` primary key is the structural backstop
- All state mutations flow through mempool → ordering block inclusion →
  block application. Zero direct `consumeBox`/`insertBox` calls in HTTP routes.
- Mutating routes return `{ status: "pending", txId, expiresAtHeight }` —
  state is not applied until the enclosing ordering block is finalized.
- Every mutation of a **committed entity** during block application — boxes and
  identity records alike — is recorded exactly once, at the store choke point,
  in the block journal; rollback replays inverses in reverse order; the AVL
  feed derives from the same journal (record-once, Spec B P1; Spec G phase B).
- **Consensus code never reads the `created_at_block` column.** It is not in
  the `stateRoot`, so a node bootstrapping from an AVL snapshot cannot
  reconstruct it. Unenforceable by test — contract and review only.
- A box id is a total function of the stored box: `stored.id ===
  computeBoxId(stored)` for every box in the UTXO set (Spec G; holds from
  phase G, when the derivation switches).
