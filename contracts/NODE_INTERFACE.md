# NODE Interface Contract

**Component:** `@dagsocial/node`
**Protocol version:** 1
**Last updated:** 2026-08-24

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
  either — see `TYPES_INTERFACE` → Layout — Merkle leaf preimages are the struct's own wire bytes.
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
| `POST` | `/posts` | `{ tx: UtxoTransaction, content: string }` — client-built, client-signed post tx with `tx.post` (the `PostCommit`) set, and the body beside it ("Post transactions" below) | `{ postId, status: "pending", expiresAtHeight, txId }` (200) | 400 if `tx`, `tx.post` or `content` is missing or malformed, `content` fails `verifyPostBody` against `tx.post.contentHash` (reason named), the commit fails verification, the transaction fails `validateTx`, or the first input is not a karma box owned by `post.author` |
| `GET` | `/posts/:id` | `?viewer=hex` — optional ("`viewer` names the identity a read is for" below) | `PostJson`, `StumpJson` or `PrunedJson` (all below), **plus `confirmedAuthor`** | 404 only for an id the node has never heard of ("Resolution order for a post id"); 400 if a present `viewer` is not 64 hex chars |
| `GET` | `/posts/:id/thread` | `?viewer=hex&limit=50&after=<blockHeight>:<blockIndex>` — `viewer` optional; `limit` and `after` page the descendants ("Every list a view returns is a page" below) | `{ post, ancestors, ancestorCount, descendants, descendantCount, next, pending, pendingCount }` — `post` is `PostJson`, `StumpJson`, `PrunedJson` or `WithdrawnJson`; `ancestors` the nearest `limit` ancestors, oldest first (`after` does not apply — the context above the topmost one is that post's own thread); `descendants` one page of the subtree's **committed** rows in committed order, `(blockHeight, blockIndex)` ascending, strictly after `after`, with `next` the key to continue from; `pending` the subtree's pending posts, newest arrival first, cut to `limit`, with `pendingCount` over all of them; `ancestorCount` and `descendantCount` are over the whole chain and the whole subtree, pending included. On a stump, a tombstone or a withdrawn subject every list is empty, every count 0 and `next` null | 404 as above; 400 as `/posts` |
| `GET` | `/posts` | `?author=hex&viewer=hex&limit=50&after=<blockHeight>:<blockIndex>` — `author` and `viewer` optional; `limit` and `after` page the committed rows ("Every list a view returns is a page" below) | `{ posts: PostJson[], next, pending: PostJson[], pendingCount }` — `posts` one page of the live committed rows, newest first in committed order (placeholders included, no stumps, no tombstones; ordering below), `next` the key to continue from; `pending` the live pending rows — the author's when `author` is present — newest arrival first, cut to `limit`, `pendingCount` over all of them | 400 if a present `limit` or `after` does not parse ("Every list a view returns is a page"), or a present `viewer` is not 64 hex chars |

**Every list a view returns is a page.** `limit` defaults to `PAGE_LIMIT_DEFAULT` (50) and clamps
to `PAGE_LIMIT_MAX` (100); a present `limit` that does not parse as a positive safe integer is a
400. `after` names the key of the last row the client holds, spelled as the list's stated total
order in the API's own conventions — `<blockHeight>:<blockIndex>` for posts, `<value>:<boxId>` for
karma and credit boxes (`value` a decimal integer in the box value domain, `TYPES_INTERFACE → Box
value domain`), `<boxId>` for bonds and vouches; hex is accepted in either case and compared in
lower case, and a present `after` that does not parse is a 400. One parser, `routes/page.ts`,
serves every paged route in both directions — it reads `limit` and `after` and spells `next` — and
the two numbers live there (`CONSTANTS → HTTP view bounds`). **A page is the first `limit` rows of
a stated total order strictly after the key**, from the head when `after` is absent; the order is a
function of state, never of row order, and **the key need not name a row** — a row spent, pruned
or withdrawn since the client read it still bounds the page, which is what makes a page continue
correctly across the inserts, spends and prunes between two requests
(`MEMPOOL_INTERFACE → "afterRowid is a keyset cursor, not an offset"` is the same rule on the
pool). **Every paged response carries `next`**: the key of its last row when a row follows it,
`null` when none does — the read peeks one row past `limit`, so a client tells a complete list
from a first page by `next` alone; the counts beside a page (`descendantCount`, `boxCount`,
`bondCount`, `count`) are over the whole set and informational. There is no `offset`; a present one
is ignored like any unknown parameter. **Pending posts have no committed position**, so the cursor
walks committed rows only, and every page of `GET /posts` and of the thread carries `pending` —
that list's pending rows, newest arrival first, cut to `limit` — beside `pendingCount` over all of
them. The paged lists: `GET /posts`, the thread's `descendants`, `/vouches?target=`,
`/vouches?voucher=` and its cooldown arm, and the `boxes` and `bonds` of `/karma/:userId`,
`/credits/:userId` and `/invites/:userId` (→ UTXO queries). The thread's `ancestors` is not paged
— the nearest `limit`, oldest first. Every other list a view returns is bounded by rule: a block's
body by its caps.

**`viewer` names the identity a read is for.** Optional on `GET /posts`, `GET /posts/:id` and
`GET /posts/:id/thread`, 64 hex chars (400 otherwise). When it is present, every `PostJson` in the
response answers `likedByViewer` — whether that identity holds a like-record on the post
(`hasLikeRecord`, one keyed read per post) — and when it is absent the field is `null`. **The node
serves no list of who liked a post.** `likeCount` is the count, `likedByViewer` is the one
per-identity question a client has, and the records themselves are consensus state an indexer
derives from the blocks.

**PostJson shape.** The post's own fields, hex where they are bytes, plus what the node knows
about it:

```
PostJson = {
  id: postId,                  // 64-hex
  content: string | null,      // null = placeholder: structure known from the transaction, body not yet held
  contentHash: hex,            // the commit's 32-byte content commitment — an indexer verifies a body it holds elsewhere against it
  author: hex(authorId),       // 32-byte Ed25519 key as hex
  parentRefs: postId[],
  protocolVersion: number,
  type: PostType,              // TYPES_INTERFACE → Layout — PostCommit
  status: PostStatus,          // 'pending' | 'confirmed' — Store Interface → Posts DAG; a pruned post has no row and no PostJson
  blockHeight: number | null,  // the three node-local columns — "PostJson time and order" below
  blockIndex: number | null,
  blockCreatedAt: number | null,
  likeCount: number,
  likedByViewer: boolean | null // with ?viewer=: does that identity hold a like-record on this post; without: null
}
```

**`GET /posts/:id` adds `confirmedAuthor`** to whichever shape it returns: the consensus-recorded
author from `block_topology`, hex, or `null` until an applied block confirms the post. It is a
distinct field from `author` on purpose — `author` is the DAG's, content a node may hold, may have
pruned, or may never have received, while `confirmedAuthor` is derived from block data alone and
is identical on every node — and it is **the only key a like may earmark karma to** ("Karma
transition rules"). A stump carries it too, and so does the tombstone: topology survives pruning.
`GET /posts/:id/thread` and the listing do not carry it.

**PostJson time and order.** Decided 2026-08-20. A post has no timestamp
(TYPES_INTERFACE → Layout — PostCommit). `PostJson` carries the post's `type` with the rest of its
fields, plus three node-local columns: `blockHeight` and `blockIndex` — the confirming block
and the post's committed position in it — and `blockCreatedAt`, the confirming block
**header's** `createdAt`, joined from the store (`ordering_blocks.created_at` holds exactly
that value). All three are `null` while the post is pending; clients render the pending
state, not a time. Feed order: `posts` is confirmed posts by `(blockHeight, blockIndex)` — the
committed order, newest first — and `pending` is the pending posts beside them, newest arrival
first ("Every list a view returns is a page").

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
`{ post: StumpJson, ancestors: [], ancestorCount: 0, descendants: [], descendantCount: 0 }`. The feed listing
(`GET /posts`) remains live-posts-only — no stumps, unchanged.

**PrunedJson shape — the tombstone (decided 2026-08-22).** A pruned **descendant** has no DAG
row, but the node still knows it: `block_topology` keeps every confirmed post's id, parent
refs and author (a reverted-and-reapplied prune re-verifies the entry's id set against it),
and its prune marks name the stump and date the prune. So a descendant's id answers a positive
statement an indexer can overwrite with, never an absence:

```
PrunedJson = {
  kind: 'pruned',
  id: postId,                       // the descendant's own id (64-hex)
  author: hex(authorId),            // from block_topology — the consensus-recorded author
  rootPostHash: postId,             // the one stump above this id — an outer prune absorbs
                                    // the inner stumps, so exactly one stands
  compactedAtBlockHeight: number    // that stump's
}
```

`GET /posts/:id/thread` on a tombstone returns `{ post: PrunedJson, ancestors: [],
ancestorCount: 0, descendants: [], descendantCount: 0 }`, the stump's form. Clients discriminate the three shapes on `kind`: absent →
`PostJson`, `'stump'`, `'pruned'`.

#### Resolution order for a post id

`getPost` — and through it every read route — resolves an id in this order, and the order is
the rule:

1. a `dag_posts` row → `StoredPost` — `content` a string (held) or `null` (**placeholder**:
   the transaction applied, the body has not arrived — Store Interface → Posts DAG, "Backfill
   after sync")
2. else a `dag_stumps` row by id → `Stump` (a pruned root)
3. else a `block_topology` row carrying the prune marks — `pruned_root` names the stump,
   `pruned_at_height` its compaction height — → the `PrunedTombstone` above (a pruned
   descendant). One row read; the marks are the tombstone's source (Prune transactions), and
   an outer prune re-marks the rows it absorbs, so the row always names the one stump standing
4. else `null` → 404: an id the node has never heard of

**A placeholder is a live post.** It is confirmed structure: a like credits its topology author,
a reply resolves it as a parent, the listing and threads show it with `content: null`. Clients
render "not yet available", not an error. **Liveness is the typed guard `isLivePost` (a
`dag_posts` row, body or not), never `'content' in x`** — a placeholder has the key and a
`null`; every site that must distinguish a post from a stump or tombstone narrows through the
guard (Post transactions → the placeholder rules).

⛔ **A WITHDRAWN POST IS ARM 1 AND IS NOT LIVE, AND THOSE ARE TWO QUESTIONS.** It keeps its
`dag_posts` row — no fourth arm — with `content` `null` and `withdrawn_at_height` set. The
guards split accordingly:

- **`isStoredPost`** — structural: a `dag_posts` row rather than a stump or a tombstone.
- **`isLivePost`** = `isStoredPost(x) && x.withdrawnAtHeight === null` — the liveness question,
  and the one the like arm asks at block application.

⚠ **`content: null` alone cannot tell a placeholder from a withdrawal**, and the difference is
the whole of the guard: a placeholder is *waiting for* its body and a withdrawn post must never
receive one. Every read that distinguishes them reads the **marker**, never the null.

**The JSON projection has a fourth arm where the store has three.** `feedService` answers
`WithdrawnJson { kind: 'withdrawn', id, author, withdrawnAtHeight }` — carrying **no content
field** — for the subject of a thread, for its ancestors and descendants, and in the feed.
A withdrawn post that answered `404` would be indistinguishable from an id the node never heard
of, and one projected as a live post with `content: null` would render as a body still loading.

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
2. Verify the target post exists and is live (not pruned; a placeholder is live — `isLivePost`)
3. Verify not already liked: like-record `(liker, targetPostId)` absent AND
   `hasPendingLike` over the mempool gate metadata
4. `validateTx` — the engine enforces the biconditional like shape **both ways** (§validateTx
   step 7): karma inputs one owner, at most one karma output same owner (omitted when the change
   would be zero), plus exactly one `LikeAccrualBox` output of exactly `LIKE_KARMA_COST` whose
   `author` is the target's author — and the transaction **conserves**. There is no deficit.
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
| `POST` | `/invites` | `{ tx: UtxoTransaction }` — inviter-signed create tx naming the invitee's public key | `{ status: "pending", txId, expiresAtHeight, bondBoxId }` | 400 if insufficient karma, 400 if that key is already an account, 400 if the inviter is neither a root nor a member with an invite available |

**There is one step, and no secret in it** (`ARCHITECTURE` → Invite System). The
invitee shares their public key out of band; the inviter submits one transaction,
and the block's settlement grants the invitee the bond's value from the pool.

**Create flow:**

0. Verify the inviter is a root, or a member with `invitesAvailable ≥ 1` —
   `⌊memberVouches / D(N)⌋ − invitesUsed`, `D` from the network record (`ARCHITECTURE → The
   invite budget`). A courtesy ahead of the engine's rule (→ Bond transition rules), like every
   check below: the refusal names the reason, and the verdict is the arm's
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
any further invite naming it; and the inviter's `invitesUsed` is incremented when the bond is
created, never decremented. The bond settles `INVITE_PROBATION_BLOCKS` after
creation, so nothing stays open. `expiresAtHeight` on the response is the
**mempool** entry's expiry.

### Vouches

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| `POST` | `/vouches` | `castVouch` | Signed UTXO tx (KarmaBox to KarmaBox + VouchBox) |
| `DELETE` | `/vouches/:targetId` | `initiateUnvouch` | Signed UTXO tx (VouchBox to none) |
| `GET` | `/vouches?target=X&limit=50&after=<boxId>` | `getVouchesForTargetPage` | `{ vouches: [{ voucherId, targetId }], count, next }` — one page of the identity's vouchers, ascending box id, strictly after `after`; `count` over the whole set, `next` the key to continue from (HTTP API → "Every list a view returns is a page") |
| `GET` | `/vouches?voucher=X&limit=50&after=<boxId>` | `getVouchesForVoucherPage` | `{ vouches: [{ boxId, value, voucherId, targetId, createdAtBlock }], count, next }` — one page of the identity's live vouches, ascending box id strictly after `after`; `count` over the whole set, `next` the key to continue from. The one arm carrying `boxId`: the unvouch builder names the box it spends |
| `GET` | `/vouches?voucher=X&cooldowns=1&limit=50&after=<boxId>` | `getVouchCooldownsPage` | `{ cooldowns: [{ boxId, value, releaseAtBlock }], count, next }` — one page of the identity's unspent escrows, ascending box id strictly after `after` |

**Members vouch, without a cap.** `castVouch` refuses with a named `400`, ahead of the engine and
changing no verdict: a voucher who is not a member (`ARCHITECTURE → Membership`); a target that
holds no `IdentityRecord`; a self-vouch; a live vouch for the same `(voucher, target)` pair — in
the UTXO set, or pending in this node's pool (`hasPendingVouch(voucherId, targetId)`, the
pair-scoped mirror). Each is a consensus rule of the cast arm (→ Vouch transition rules); the
escrow gate — no cast while an unspent escrow names the voucher — is also the arm's, mirrored
here the same way. There is no one-vouch-at-a-time rule and no voucher-scoped pending check: a
member holds as many live vouches as they have karma to stake.

> ✅ **The demo UI builds and signs both transactions.** `buildVouchTx` and `buildUnvouchTx` in
> `node/public/index.html` construct them, `signTxId` signs, and both handlers POST `{ tx }`.
> Unvouch resolves the VouchBox id from `GET /vouches?voucher=` — the only arm carrying `boxId` —
> **at click time**, since a box can be spent between opening a profile and pressing the button.
> The profile shows the identity's standing — resident, member or root — and a member's invites
> available, read from `GET /karma/:userId`; the vouch button does not refuse a second target.
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
invites, vouches, credits, prune).

### Pruning

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/posts/:id/prune` | `{ tx }` — a prune transaction, JSON-encoded like every other route's (`jsonToTx`) | `{ status: "submitted", txId: hex, postId: hex }` (201) — no `replyCount`: the count is a property of apply, read off the stump | 400 if the payload is absent, the root is unconfirmed or confirmed at or above the block the prune is judged for (`tip + 1` at admission, → validateTx), or `validateTx` refuses it; 404 if the post is unknown; 409 on a pending-spend conflict; 503 if the pool is full |
| `POST` | `/posts/:id/withdraw` | `{ tx }` — a withdrawal transaction, JSON-encoded like every other route's (`jsonToTx`) | `{ status: "submitted", txId: hex, postId: hex }` (201) | 400 if the payload is absent, the post is unconfirmed or confirmed at or above the block the withdrawal is judged for (`tip + 1` at admission, → validateTx), the signer is not its author, the post is already withdrawn, or `validateTx` refuses it; 404 if the post is unknown; 409 on a pending-spend conflict; 503 if the pool is full |

**Prune flow:**

1. The client builds a **prune transaction** — a karma self-transfer carrying a `PruneCommit`
   (→ Prune transactions) — and signs its `txId`. There is no separate prune signature: the
   transaction's own covers the payload.
2. ⛔ **The route answers `submitted`, never `deleted`.** It reports that the transaction
   entered the pool, which is what happened; the outcome it does **not** promise is that a
   block carries it. karma-econ §1.4.2 rules the word out besides — a prune is not a deletion
   for anyone who archived the content.
3. The route runs the prune-specific check — the root confirmed in an **earlier** block, read
   from `block_topology` — then `validateTx`, then `admitTx`, then `net.broadcastTx`. **The same
   order every sibling route uses**, and the broadcast is what makes a prune submitted to a
   non-mining node reach consensus. The response is `{ status: "submitted", txId, postId }` —
   no `replyCount`, which is a property of apply and is read off the stump.
   > ⚠ **The route checks topology, not the DAG.** A pending post has a `dag_posts` row and no
   > topology row, so a DAG-based read would admit a prune that consensus must reject.
4. At block application (§8c): the transaction's own validation has already bound authorship
   (`inputKarma.owner` against the root's topology author) and covered the payload by
   signature. What remains is the **maturity bind**, the derived set, the vest of this block's
   own likes on the subtree, the deletion of the subtree's like-records (journalled, so a
   reverted prune restores them), the insert of the Stump derived from that set
   (**unconditional** — a node holding no DAG content records the same stump; the insert is
   journalled, so a reverted prune removes it), the **deletion** of the subtree's `dag_posts`
   and `dag_parent_refs` rows **by the derived set** — never by a local DAG walk; ids with no
   local row are simply absent — and the **marking** of the set's `block_topology` rows, the
   tombstone's source (→ Prune transactions). Every deleted row (skeleton, body,
   status, height, index, parent refs) is captured into the block's journal as a side-record
   **before** deletion (Block Journal → `deletedPosts`), so a reverted prune restores it exactly;
   below the reorg horizon (`maxReorgDepth`, TYPES_INTERFACE → Chain reorganisation) the journal is
   dropped and the node holds no byte of the subtree's
   content anywhere (ARCHITECTURE → Subtree pruning).

   **The stump's `upvoteCount` is the like tally of the pruned subtree**: the
   count of like-records the deletion removed, the root's likes included
   (`replyCount` counts replies, so it excludes the root). Like-records derive
   from applied blocks, so the count is the same on every synced node, and a
   reverted prune restores the exact rows — a re-apply recounts the identical
   set

**Stumps are derived state.** A `dag_stumps` row is a local projection of an
applied prune transaction — never information in its own
right. `insertStump` has two callers, both block-application paths: the prune
phase, and `revertBlock` restoring the stumps an outer prune absorbed. The stump's `protocolVersion` is the era at its `compactedAtBlockHeight`, stamped by that
caller and checked by nothing — a stump is never on the wire (`ARCHITECTURE → Protocol Versioning`).
No network input writes the table. Inbound stump gossip is not
consumed, and no stump pull protocol exists: a gossiped stump is unverifiable
by construction (it carries no signature and names no set, so a receiver has
nothing to check it against), while the
table it would write is trusted by both the read API (`getPost` resolves
stumps) and the relay verifier (parent-existence, step 8) — which is why
nothing unverified may reach it (audit F-api-20, and the sweep-response
variant found alongside it: a peer answering a stump pull could return
entries that were never requested, each stored and its prune replayed
against live content).

### UTXO queries

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/karma/:userId?limit=50&after=<value>:<boxId>` | `{ userId: hex, total, effective, boxes: [{ boxId, value }], boxCount, next, lastActivityBlock, lastDecayBlock, lifetimeLikesReceived, memberSinceBlock, memberBar, memberVouches, memberLikes, invitesUsed, member, invitesAvailable, height }` — `total` the face sum over every unspent karma box (`getKarmaTotal`, the view's `SUM` over the set `getKarmaValue` sums), `effective` that sum after virtual decay (`effectiveKarma`, the call every karma-sufficiency check on the node makes), `boxes` one page in `value DESC, id` strictly after `after`, `boxCount` over the whole set, `next` the key to continue from. **An identity with no unspent karma box answers the empty page** — `boxes: []`, `boxCount 0`, `total "0"`, `effective "0"`, `next null`, its clocks, `lifetimeLikesReceived` and `memberLikes` (decimal strings, the record's counters — `"0"` where none) and the membership fields from the record, `height` — an exact spend leaves a live identity holding no box, and a page of zero is a page ("Every list a view returns is a page") | 400 if `userId` is not 64 chars or a present `limit`/`after` does not parse |
| `GET` | `/credits/:userId?limit=50&after=<value>:<boxId>` | `{ userId: hex, total, boxes: [{ boxId, value, lockedUntilBlock? }], boxCount, next }` — `total` over every unspent credit box (`getCreditValue`), `boxes` one page in `value DESC, id` strictly after `after`, `boxCount` over the whole set, `next` the key to continue from; an identity with no unspent credit box answers the empty page — `boxes: []`, `boxCount 0`, `total "0"`, `next null` | 400 if `userId` is not 64 chars or a present `limit`/`after` does not parse |
| `GET` | `/invites/:userId?limit=50&after=<boxId>` | `{ bonds: [{ id, value, inviterId, inviteePublicKey }], bondCount, next }` — the inviter's **unspent** bonds, one page ascending box id strictly after `after`, `bondCount` over the whole set, `next` the key to continue from; a bond IS the open invite, so a settled one is not listed and there is no second list | 400 if `userId` is not 64 chars or a present `limit`/`after` does not parse; an inviter holding no live bond answers `{ bonds: [], bondCount: 0, next: null }` |

Multi-box UTXO model — identities can hold multiple karma/credit boxes.
`total` is the sum across all boxes, and `boxes` is a page of them in the order coin selection
reads — largest first — so a client covering an amount takes boxes from the front of the page and
never needs the whole set to know its balance. **`value`, `total` and `effective` are decimal
strings** in the JSON (box values are `bigint`; JSON cannot carry one) — clients parse them with
`BigInt(...)`. Applies to every response carrying a `value`/`total` (`/karma`,
`/credits`, `/status` totals, mining template, etc.). See "Values are BigInt (P0)".

**`/karma/:userId` answers the balance twice, and a client spends against `effective`.** `total`
is the face sum; `effective` is the same sum after virtual decay, computed by the one
`effectiveKarma` every karma-sufficiency check on the node reads ("Karma decay (virtual, squared
on touch)") — a client that derives it from the clocks holds a second implementation of a
consensus valuation, which is the mirror class. The three plain numbers beside them —
`lastActivityBlock` and `lastDecayBlock`, the owner's identity-record clocks (`0` where no record
exists), and `height`, the chain height at the time of the response — are that valuation's inputs,
served so a client can show when the next period falls.

**`/karma/:userId` answers standing, and the client evaluates nothing.** `memberSinceBlock`,
`memberBar`, `memberVouches` and `invitesUsed` are the record's plain numbers, `memberLikes` its
second counter as a decimal string (`0` and `"0"` where no record exists); `member` is the derived
predicate `memberSinceBlock > 0 ∧ memberVouches ≥ memberBar` evaluated by the node (`ARCHITECTURE
→ Membership`), and `invitesAvailable` is `⌊memberVouches / D(N)⌋ − invitesUsed` for a member, clamped at `0`
(a bar that rose after invites were spent can put the difference below zero), `0` for a resident —
a lapsed member included — and **`null` for a root** — unbounded, not zero. A client deriving either from the
five fields holds a second implementation of a consensus predicate, the mirror class.

### Credits

| Method | Path | Request | Response | Errors |
|--------|------|---------|----------|--------|
| `POST` | `/credits/transfer` | `{ tx: UtxoTransaction }` — client-built, client-signed | `{ status: "pending", txId, expiresAtHeight }` | 400 on invalid tx or signature |

**A credit transfer is a transaction, and it settles when it is mined.**
The client builds and signs it; the node decodes it with
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
| `GET` | `/blocks/:height` | OrderingBlock object (JSON with hex fields) | 400 unless `:height` parses as a non-negative safe integer, 404 |
| `GET` | `/blocks/current` | `{ height, hash }` — **`hash` is nullable** | — |

The `header` object in `/blocks/:height`'s response carries all ten header fields, `interlinkRoot`
included (`TYPES_INTERFACE` → Layout — Block) — the field a client that recomputes the interlink
vector from served headers checks.

**`hash` is `string | null`.** It is `blockHash` of the stored tip
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

⚠ **The demo UI's faucet buttons therefore depend on a proxy, not on the node.** They post to
`/testnet/faucet/karma` and `/testnet/faucet/credits`, which the deployment maps to the faucet
service's own port; the node's own origin has nothing to answer them with. A node served without
that mapping renders the buttons and 404s them.

**The service's edge, for any client that calls it.** `POST <faucet>/karma { pubkey }` answers
`202 { txId, status: "pending", expiresAtHeight }` once the invite is in the node's pool —
`expiresAtHeight` the node's own mempool expiry for that invite (→ Invites), relayed so a client can
bound its wait rather than guess a bound; `400 { error }` relays the node's refusal (a key that already
holds a record — the once-per-identity rule) or names a malformed key; `429 { error }` is the service's
own rate limit; `503 { error }` is a drained faucet. `POST <faucet>/credits { pubkey }` answers
`202 { txId, status }` and repeats.

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

**The faucet identity is a root** (`ARCHITECTURE → Membership`): its record is seeded with
`memberBar = 0`, so it vouches and invites with no budget check and never lapses — which is how a
chain whose committee is empty admits its first member.

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
### Nipopow

| Method | Path | Response | Errors |
|--------|------|----------|--------|
| `GET` | `/nipopow/proof/:m/:k` | `{ proof: hex }` — `encodeNipopowProof` bytes (`NIPOPOW_INTERFACE` → NipopowProof) | 400 unless `:m` and `:k` parse as integers in `[1, MAX_NIPOPOW_PARAM]`; 404 `{ error: 'chain too short' }` while the chain height is below `m + k` |

Unauthenticated, on every role. The bytes are the proof's positional encoding, hex in JSON like
every byte-valued field. The by-header variant (`/:m/:k/:headerId`, proving a named header is in
the chain) is not served. The prover behind it is `Nipopow prover` below.

### Status

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/status` | `{ networkType, blockHeight, protocolVersion, postCount, pendingPosts, totalKarma, liquidKarma, totalCredits, inviteProbationBlocks, vouchCooldownBlocks, inviteBondMin, inviteBondMax, membership: { memberCount, memberBar, memberLikesBar } }` |

> ⚠ **`totalKarma` is karma in existence; `liquidKarma` is karma its owner can spend now.**
> `totalKarma` sums the karma-bearing types; `liquidKarma` sums `karma` alone. `credit` is the
> other ledger and `genesis_proof` holds no value on either.

> `vouchCooldownBlocks` is served because a client must **reproduce** it: an unvouch outputs a
> `VouchEscrowBox` whose `releaseAtBlock` the engine pins as `vouch.createdAtBlock +
> vouchCooldownBlocks` ("Vouch transition rules"). `inviteProbationBlocks` is the probation window
> the settlement dates from `IdentityRecord.invitedAtBlock` ("Bond transition rules"). Both are
> per-network values, plain numbers, served rather than held as client constants. `inviteBondMin`
> and `inviteBondMax` are served for the same reason — the range the invite-create arm admits a bond
> in (→ Legal box transitions) is per-network, so a client building an invite reads the floor here
> rather than holding one network's constant — as decimal strings, being `bigint` amounts.
>

> `membership` is the network record read once: `memberCount` is `N`, `memberBar` is `D(N)` and
> `memberLikesBar` is `Y(N)` (`ARCHITECTURE → Membership`) — the bar a newcomer faces and the
> divisor of every member's invite budget, served so a client shows them rather than reproducing
> `icbrt` and the profile's multiplier.
>

#### Three karma sets, and none derives from another

**Each is a different question, and a box type may answer them differently:**

| Set | Answers | Read by |
|---|---|---|
| the **transition** set | may a karma spend create this box type? | `utxo-engine.ts`'s karma transition arm |
| the **supply** set | does this box type's value count as karma that **exists**? | `getTotalKarma` |
| the **conservation** set | does this box type participate in the total that **never changes**? | `conservation-axiom.test.ts`'s classification, which asserts the axiom's sum over an applied chain (ARCHITECTURE → The conservation axiom) |

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

⛔ **NO SET MAY BE DEFINED AS ANOTHER, OR DERIVED FROM IT.** Two types already answer the three
questions differently — `karma_pool` (transition **no** · supply **no** · conservation **yes**) and
`vouch_escrow` (**no** · **yes** · **yes**: it is created by spending a `VouchBox`, never a karma
box) — and where two sets do share a member they share it **for different reasons**. A shared
constant would encode the overlap as though it were a rule.

⛔ **A KARMA-BEARING TYPE CAN BELONG TO NEITHER SET, AND `karma_pool` IS ONE.** The karma supply
pool holds the karma not in circulation and is spent **only by the block's settlement
transaction** — it never reaches `validateTx`. So it joins `genesis_proof`, `emission` and
`treasury` in being **barred from both transaction positions**, which puts it outside the
transition set; and its value must **never** reach `totalKarma`, which reports circulation and
would otherwise overstate it by the entire uncirculated supply — that puts it outside the supply
set.

⚠ **Membership is therefore three-way, not two.** "Which list?" is the wrong question to ask of a
new box type. The right one is asked three times, independently: *may a karma spend create it?*,
*does its value count as karma that exists?* and *does it belong to the total that never changes?*
— and **every answer may be no.** That is exactly what a single shared list could not express.

⛔ **EACH SET IS A TOTAL VERDICT TABLE, NEVER A BARE LIST.** A set is stated as
`Record<AnyBox['boxType'], boolean>` — one row per box type, every row written by hand — and the
array its readers consume (the karma arm's allow-list, `getTotalKarma`'s `IN` list) is **derived
from the rows that answer yes**, in declaration order. So a new box type is a **compile error at
every set** until each has been given its verdict, instead of a silent omission: an array of the
union is satisfied by any subset of it and tracks the set only by hand. The tables answer different
questions, so deriving each array from its own table is not a derivation of one set from another.
The general form of the rule — every enumeration over box types, in every package — is
`TYPES_INTERFACE → What a new box type costs`.

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
> `node/src/config.ts`, wires it into the blocks router from `node/src/server.ts`, and serves it
> on `GET /status` (`node/src/routes/blocks.ts`). **No client reads it today** — the demo UI,
> `tools/e2e` and `tools/faucet` hold neither a reader nor a probation constant; the node's own
> reader is `block-creator`'s `getBondsSettlingAt`, which dates a settling bond's `invitedAt` as
> `height − inviteProbationBlocks`, and no engine check compares it (`checkTransitions` is
> height-free). Confirmed against the running node as well — `notis.fun/testnet/api/status`
> returns `inviteProbationBlocks`. A plain `number`, not a decimal string: unlike `totalKarma` /
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
> because the rejection arrives as a generic invalid-transition error. A client that comes to read
> it takes the served value with a default in the safe-failure direction, as the UI's existing
> `networkType || 'mainnet'` does.

> ✅ **`networkMode` → `networkType` landed in P2-A phase 4**, in the same commit as the demo
> UI change because renaming a response field is a breaking API change. `totalKarma` and
> `totalCredits` are **decimal strings**, not numbers — they are `bigint` server-side and
> JSON has no such type.
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
1. **Parent refs count** — at most `MAX_PARENT_REFS`
2. **Protocol version** — the commit's equals the era at `tip + 1` (VALIDATION_INTERFACE → Protocol
   Version); the early rejection — the envelope's `verifyTxProtocolVersion` is the consensus check
3. **Karma** — the author's **summed** karma must cover the price: threads (no
   parentRefs) ≥ `POST_PRICE_THREAD`, replies ≥ `POST_PRICE_REPLY`.
   ⚠ An early, friendlier rejection, NOT the enforcement point — the engine's
   post biconditional is what a block re-validates
4. **Parent refs existence** — every referenced id resolves to a post or stump

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

**`currentBlockHeight` is the height of the block the transaction is judged for** — at admission
`tip + 1`, the block that would carry it; at block application the block's own height. Every rule keyed
on it (step 3's unlock floor, step 6's creation bound, step 7's era) reads that height, so a transaction
admitted at the tip is judged exactly as the next block judges it.

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
   `createdAtBlock <= currentBlockHeight` for every output. **And no output is
   older than the oldest input** — `output.createdAtBlock >= max(input.createdAtBlock)`,
   on every box type (TYPES_INTERFACE → Monotonic creation height).


   ⛔ **The two halves answer different attackers and neither replaces the
   other.** The upper bound stops a box claiming the future, which is the
   creator lying about their own box. The monotonic bound stops a box being
   handed to someone else already aged — a credit output's height is the
   **sender's** choice, not the recipient's, so without it one party can make
   another's box rent-collectible at once. ⚠ **A rule deriving from
   `createdAtBlock` still owes its own check where it needs one tighter than
   this**: the vouch cast window under "Vouch transition rules" is one, and it
   stands beside the monotonic bound rather than being replaced by it.
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

⛔ **It is a table, keyed on the type, because the property is *"this type has
an unlock height"* and never *"this field is present"*** — a check keyed on one
field name silently admits a type whose clock lives under another. The entry
with a clock today:

| Type | Unlock height | Absent means |
|---|---|---|
| `credit` | `lockedUntilBlock` | spendable — most credit boxes carry no lock; only the coinbase's do |

Every other type is always spendable *at this gate*: the timed boxes
(`bond`, `karma_price`, `emission`, `treasury`, `karma_pool`, `like_accrual`,
`vouch_escrow`) are `BLOCK_APPLICATION_ONLY`, so their timing is enforced by no
user transaction being able to name them at all — `vouch_escrow.releaseAtBlock`
is read by the settlement leg that returns it, not by this gate. This table
exists for the types that must be **user-spendable and carry a clock**.

**Checked once per input at `validateTx` step 3**, after liveness (its only
precondition) and before authorization: timing is cheaper than signature
verification and refuses a transaction that cannot succeed either way. The height compared is
`currentBlockHeight` as `validateTx` defines it — the carrying block's — so an input unlocking at `L`
is admitted at tip `L − 1`, the block that will spend it being `L`.

⛔ **A tightening.** A historical block containing a premature spend would be
rejected on resync; testnet and devnet wipe at deploy and mainnet does not
exist, so nothing is stranded — but it is a consensus break, not a refactor.

### Validity ceiling (`ceilingOf`)

**The highest block height at which a transaction can still validate — the dual of `SPEND_TIMING`.**
Spend timing is a floor on height and refuses an input spent too *early*; a validity ceiling is a
ceiling on the same axis and marks a transaction that can no longer be included at all. `null` means
the transaction has no ceiling, which is the ordinary case.

⛔ **A ceiling is DERIVED, never decided.** A node does not choose it; it reads it off the consensus
rules a transaction must already satisfy. Two nodes therefore always agree on it, and an operator
cannot tune it — unlike the fee floor, which is local policy (MEMPOOL_INTERFACE → Fee floor). Both
nonetheless sit **above** the store rather than inside it, for different reasons: the floor because
the store cannot tell a submitter from the reorg caller, the ceiling because the only caller that can
present a past-ceiling transaction is the reorg caller, and it is the only one holding the height to
judge it against.

⛔ **It is NOT a table keyed on `boxType`, and that is a limitation rather than a choice.**
`AUTHORIZATION`, the output-shape schema and `SPEND_TIMING` are all keyed on the input's type and get
a compile-time obligation from it. A ceiling is a property of the *transition*, which has no name in
this codebase — `checkTransitions` discriminates by a `switch` on input type with nested output-shape
arms — and the input's type is a fact about the input *boxes*, which is state. A ceiling must be
readable from the transaction's bytes alone (below), so it cannot key on that. **`ceilingOf` is a
function, and the obligation it cannot get from the type system is carried by a test instead**
(below).

⛔ **A ceiling is a function of the transaction's own bytes and resolves nothing** — the standing the
pool's fee and class metadata already have (MEMPOOL_INTERFACE → Fee floor). A node computes it whether
or not it has ever seen the inputs, which is what lets the pool store it on the row at insert.

The ceilings that exist:

| Transaction, read from its bytes | Ceiling | The rule it mirrors |
|---|---|---|
| A rent collection that outputs a successor | the credit outputs' declared `createdAtBlock` | the successor is created at the collecting height, and at no other |
| A rent collection with no successor | none | a box that cannot cover its charge is taken entire, so no successor is required of it |
| A vouch cast | the vouch output's `createdAtBlock` + `VOUCH_CAST_HEIGHT_WINDOW` | a cast may not lag its carrying block by more than the window |
| Everything else | none | |

⛔ **A ceiling recognises a rent collection by SHAPE, not by the biconditional.** Admission tests
signature-absence alone, and that is sound only because every caller of `admitTx` has already run
`validateTx` — an unsigned transaction that passed authorization *is* a rent collection
(NODE_INTERFACE → Storage rent is a transition requiring no signature). **`ceilingOf` has no such
guarantee**: it runs inside `insertUtxoTx`, which fork resolution reaches directly, so it sees
transactions no validation has vouched for. It therefore uses the stronger test the block creator uses
when it splits a body — credit-side *and* unsigned — which reads the outputs and the signature map and
needs nothing else.

**Where it is enforced: the pool reclaims, the reorg caller screens, and consensus does nothing.** No
block is ever rejected for a ceiling — a block carrying a past-ceiling transaction is already refused
by the rule the ceiling mirrors, at `validateTx`. The ceiling exists so an entry that can never be
included stops occupying a slot and stops being reconsidered on every build
(MEMPOOL_INTERFACE → Validity ceiling).

⛔ **Only re-insertion after a reorg can present a past-ceiling transaction.** Every submission path
runs `validateTx` before admission, so a stale vouch dies at its window check and a rent collection at
the rent refusal (MEMPOOL_INTERFACE → Storage rent is refused at admission). Fork resolution alone
returns transactions to the pool without validating them, which is why the screen belongs there and
nowhere else.

**Re-insertion screens the ceiling and not the floor.** A reverted transaction whose input is immature
or locked at the new tip (`validateTx` step 3 — the spend-timing floor) is re-inserted all the same and
sits in the pool until the creator's rebuild evicts it: one wasted build per reorg over such an entry
(`MINING_INTERFACE → Template and submit`, the rejected-body loop's bound), no fork, no stall. A reorg
onto a shorter, heavier branch lowers the tip by up to `maxReorgDepth` blocks, so the case is ordinary,
and it is bounded rather than screened.

⚠ **A new height cap owes a ceiling arm.** Any rule inside `checkTransitions` that bounds
`currentBlockHeight` from above makes some transaction permanently unincludable once the chain passes
it, and a rule that does so without a matching arm leaves those entries in the pool until expiry.
Because the type system cannot demand this, **a test enumerates every `currentBlockHeight` comparison
in `checkTransitions` against an inventory declared beside it**, and a new comparison fails that test
until its author records whether it caps height.

⚠ **Two ceilings are known and both were found by hand**, one of them only because storage rent
landed. The test is what makes the third one fail loudly instead of surfacing as a pool that quietly
carries dead rows.


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
`jsonToTx`, gossip and block-embedded positional decodes), and their bytes-level
consumers assume the per-type field domains: `canonicalBoxBytes` (the id
preimage) and `serializeBox` (the AVL leaf, so the `stateRoot`) write the
declared field set for the output's `boxType`, where an out-of-domain value
throws (`b32`, `vlqU64OrThrow`) or **collides on the sentinel** (`vlqU` —
TYPES_INTERFACE → Totality), and the transition arms' `Buffer.from`/hash reads
throw on a wrong type. Transition rules filter on `boxType` and
`checkOutputValues` reads `value`; the schema is what stands between ingress
and all of them.

`validateTx` therefore rejects any output that does not match the **closed
schema for its `boxType`**:

- **Key set is exact.** Required fields present, no key outside the declared
  set (`TYPES_INTERFACE` box definitions are authoritative; the declared-optional
  field — `CreditBox.lockedUntilBlock` — may be present
  or absent, nothing else may vary). A key the schema does not name is a
  reject, not a strip: a stripped key would change the bytes the client signed.
  > **`fee` is user-created and consumable only by block application**, which is
  > the shape `bond`, `like_accrual` and `karma_price` have: a user transaction creates the
  > box, and only block application may consume it. The schema below has a row for
  > every boxType a user transaction may emit. `genesis_proof`,
  > `emission`, `treasury` and `karma_pool` have none, because no transaction may create them.
- **Field types are pinned** (field-type pin). Every present field's runtime
  type matches its `TYPES_INTERFACE` box definition:
  - `bigint`, `0 ≤ v < BOX_VALUE_BOUND` (TYPES_INTERFACE → "Box value domain"):
    `value` (every boxType). The bound is absorbed from
    `checkOutputValues`, which retired with this pin (one owner per rule;
    `json-to-tx`'s `assertValidBoxValue` stays as the HTTP-edge twin).
  - 32-byte `Uint8Array`: `owner` (karma, credit), `inviterId` and
    `inviteePublicKey` (invite, bond), `voucherId`, `targetId` (vouch). The
    empty state went with the commit transition, so `inviteePublicKey`'s length
    is no longer a transition-arm question and `bytes0or32` has no user.
  - Non-negative safe integer, and never `-0`: `lockedUntilBlock`
    (credit, when present). `-0` is called out because it is JSON-reachable
    and breaks value round-trips: the positional writer encodes it as `0`, so
    a re-decode returns integer `0` — two values, one byte string.
  - `string`: no box field carries one. `targetPostId` was the only entry and it
    is deleted with the field (TYPES_INTERFACE → PostLockBox) — the circularity,
    not a domain fix. Kept as a row because the *kind* is still part of the
    schema vocabulary.
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
site. A JSON-edge-only check would leave the gossip and block paths open.

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
arbitrary decoded or JSON values, missing fields, wrong types, `null`
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
> a boundary edit to be fatal"*. Six subclasses, and every boundary is fatal for all of them with no
> boundary edit.
>
> | Subclass | Raised when | Raising site |
> |---|---|---|
> | `UnhashableStoredHeaderError` | a header already in our store cannot be hashed | ⚠ **now dead `src`** — see below |
> | `MissingStoredBlockError` | a block the chain refers to is absent from the store | `services/block-apply.ts`, `services/fork-resolution.ts`, `services/block-creator.ts` |
> | `UnreadableStoredBlockError` | a stored block's bytes will not decode | `store/ordering.ts` → `rowToOrderingBlock` |
> | `DivergedStateTreeError` | the AVL+ tree refuses an operation the UTXO store implies must succeed | `state/avl-prover.ts` |
> | `MissingJournalError` | a block journal inside retention is absent. Every height `revertBlock` can be asked for lies inside what `purgeOldJournals` keeps: deletion is strictly below `tip − maxReorgDepth`, the fork walk's lowest non-genesis answer is `tip − maxReorgDepth + 1` and the revert starts one above it, and its genesis answer is reachable only while `tip ≤ maxReorgDepth` | `services/fork-resolution.ts` → `revertBlock` |
> | `MissingStateVersionError` | no AVL version at or before a fork height the walk answers within. `MAX_PROOF_HISTORY < maxReorgDepth` is refused at load (Configuration), so a missing version is a row the store lost | `services/fork-resolution.ts` → `reorg` |
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
> **Reach is the live argument, not the halt.** `rowToOrderingBlock` is the one decoder of
> `ordering_blocks`, and its callers are every consumer of the chain: both block entries
> (`handleOrderingBlock`'s held check and `extendsOurTip`, then `applyOrderingBlock`'s chain-link
> read), fork resolution (`revertBlock`, `resolveFork`'s anchor and its read of our headers above the fork), the
> block creator's tip read, the two `/blocks` routes, and the provider handed to
> `net.setHeadersHandler`, through which every served chain query and every block a
> `ModifierResponse` serves decodes stored rows — a handshake decodes none: its `chainHeight` is the
> `setChainHeightProvider` read, `MAX(height)`; a `SyncInfo` decodes none: it carries the tip height
> alone, the fork walk compares a peer's headers against the stored `block_hash` column by point read,
> and an inbound `Inv` or `ModifierRequest` resolves its ids through `setHeightByBlockIdProvider`
> point lookups the same way — only the blocks actually served decode. Only apply's read passes through a catch that could promote anything;
> the store frame names the fault so that all of them raise one class — and **every outer frame is a
> boundary**: the gossip and the pull registrations of `handleOrderingBlock` both wrap it in
> `failStopIfCorruptChain` (Relay handlers; Sync handlers); the launched `resolveFork` promise carries
> `.catch(failStopIfCorruptChain)`; `finalizeBlock` wraps the mined-block apply; `createOrderingBlock`
> calls the boundary directly; and the provider handed to `setHeadersHandler` and the
> `getOrderingBlock` the blocks routes are given wrap the store read, so a corrupt row met while
> serving stops the node instead of failing every `SyncInfo` and query as a peer's fault. A frame that
> merely contains — net's dispatch catches, Express's default 500 — is never the outer frame of a
> store read.
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
   `Buffer.from`s them mid-block-apply (e.g. a numeric `vouch.targetId`).
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
**Total**: returns `{valid: false}` and never throws for any decoded
value (error strings quote input via the total `describeValue`, never bare
`String(v)`). The envelope's key set is **closed** — an unknown key rejects.
`computeTxId` hashes only the known fields, so an extra envelope key would
otherwise be free malleability: two distinct transaction objects carrying the
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
   optionally `likeTarget`, `post`, `prune` and `postWithdraw`. Any other key
   rejects.
   ⛔ **AT MOST ONE PAYLOAD FIELD.** `likeTarget`, `post`, `prune` and `postWithdraw` are
   mutually exclusive — a transaction carrying two of them rejects here, before any transition arm
   runs, and the rejection names both fields. The arms recognise a transaction's kind by payload
   presence and each pins its own shape and nothing else's, so a second payload would ride through
   the first's arm unexamined: `postsOf` confirms every `tx.post` whatever arm validated the
   transaction, and the post arm is the only place a commit's `author` is bound to the karma's owner
   — a like carrying a `PostCommit` would confirm the post, under any author the commit names, for
   the price of the like. The rule is the envelope's because it is structural: no state is read to
   decide it.
   > ⛔ **A NEW PAYLOAD FIELD IS TWO ENTRIES HERE, NOT ONE.** `decodeTx` writes
   > every field unconditionally, holding `undefined` where the tag said absent,
   > so a field must also join the set of keys **permitted to hold `undefined`**.
   > The allowed set alone still rejects every transaction that is *not* of the
   > new kind — which is the whole embedded path — and the failure names the new
   > key, not the missing exemption.
   > **`prune`'s domain is `verifyPruneCommitDomains`'s** (VALIDATION_INTERFACE →
   > `verifyPruneCommitDomains`), the same obligation `post` carries: `txIdBytes` writes the
   > payload through `pruneFieldBytes`, whose fixed-width writers throw outside their domain, so
   > the envelope check is where a malformed payload is refused rather than hashed.
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
7. `protocolVersion`: equals the era at the judged-for height —
   `verifyTxProtocolVersion(tx, currentBlockHeight, schedule)` (VALIDATION_INTERFACE → Protocol
   Version), which holds `tx.post.protocolVersion` to the same era when a commit is present; the
   schedule rides on `deps`. Rider: `jsonToTx`'s default is `?? protocolVersionAt(schedule, tip + 1)`,
   so the HTTP edge cannot mint a foreign-era transaction; a signing client learns the era first
   (`/status` → `protocolVersion`, the era at `blockHeight + 1` — served, never known, like every
   per-network value on that route), the field being in the id preimage.
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
mempool reinsert decodes `encodeTx` bytes the node itself produced from
once-valid txs — outside the gate's call list, deliberately.

**Consensus scope:** a validation tightening in the same class as the field-type
pin — honest bytes unmoved; txs that previously
applied while carrying envelope garbage (junk `protocolVersion`, stray keys)
become rejections. Covered by the standing fresh-chain gate.

### applyTx

```
applyTx(deps, tx: UtxoTransaction, outputsWithIds: AnyBox[], currentBlockHeight: number): void
```

Write-only. Consumes all input boxes and inserts all output boxes inside a
SQLite transaction. Performs no validation — call `validateTx` first.

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

#### Storage rent is a transition requiring no signature


⛔ **A `credit` box past its rent period is spendable with NO owner signature.** Eligibility is the
whole authorization rule:

```
currentBlockHeight - box.createdAtBlock > profile.storageRentPeriodBlocks
```

**It names no key**, so it satisfies the rule above rather than excepting it: the requirement is *no
signature at all*, which this table already admits as a shape.

⛔ **RENT IS AN ORDINARY BODY TRANSACTION, NOT A SETTLEMENT LEG, AND THE CHOICE IS LOAD-BEARING.**
The settlement's input list is **derived whole** and a verifier recomputes it position by position
(→ "The two orders are consensus"). Producer-chosen inputs inside it would end that guarantee for
every settlement, to buy a mechanism that does not need it. A rent transaction rides the body like
any other, `validateTx` governs it, and **the settlement's derivation is untouched**.

✅ **Its income reaches the coinbase by the path a fee takes, but as a SEPARATE total.** The
settlement already accumulates `fees` from the body's transactions; rent accumulates the same way and
into its own term. ⛔ **Not into `fees`** — the treasury takes 5% of fees and none of rent, so folding
the two would tax rent by arithmetic no rule states. The settlement classifies each body transaction
and sums both (MINING_INTERFACE → Coinbase Application).

✅ **This is where a guarding script would sit on Ergo, and the absence of scripting makes it
simpler, not harder.** Ergo's rent works by the protocol **overriding** a box's script so a miner may
spend it. Nothing here holds a script to override, so the eligibility predicate is the entire
mechanism.

⛔ **Which eligible boxes are collected is nobody's rule.** A producer includes the rent transactions
it chooses, exactly as it chooses which transactions to include at all; a verifier checks eligibility
and the charge and nothing else. **Two honest producers building different blocks from one state is
not a divergence.**

⛔ **A rent transaction is REFUSED AT MEMPOOL ADMISSION, and that is what makes collection the
producer's.** `admitTx` rejects one outright — the same seam the fee floor occupies and for the same
reason: **policy, not consensus.** A block carrying a rent transaction is valid whoever built it, and
apply re-validates without reference to authorship.

⚠ **This is the normal case, not a guarantee, and the difference is worth stating.** A transaction
carries no author, so consensus has no key to test a producer restriction against — the producer's
identity exists only at settlement, as the coinbase payout key. Refusal at admission removes the only
path a non-producer has into a block **on nodes that apply it**; an operator who relayed them anyway
would be within their rights, exactly as one who sets a different fee floor is.

⚠ **What the refusal is protecting is the consume-whole branch.** A box that cannot cover its charge
is taken entire, so open submission would let anyone race for under-funded boxes rather than only
whoever wins a block. The amounts are sub-minimum credits and carry no tokens, so the exposure is far
below Ergo's equivalent — but the collection is the block producer's by design, and admission is where
that is expressed.

**The charge is `STORAGE_RENT_PER_BYTE × byteLength(boxRecordBytes(box))`, exactly.** Where the box
covers it, exactly one successor `credit` box carries `value − charge` to the **same owner** at the
current height, which resets the clock. Where it does not, the box is **consumed whole and no
successor exists**. ⚠ **A box at the credit minimum cannot cover one period** — the rent-to-floor
ratio is 3,889× (TYPES_INTERFACE → Box value domain) — so the minimum is a spam bound and never a
survival guarantee.

⚠ **Rent is a third coinbase income term, and the treasury takes none of it** (MINING_INTERFACE →
Coinbase Application).

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
| KarmaBox | KarmaBox + LikeAccrualBox | **Like**: `likeTarget` present ⟺ exactly one `LikeAccrualBox` output of exactly `LIKE_KARMA_COST` whose `author` is the target's author from `block_topology` — **and the converse**, a `LikeAccrualBox` output ⟺ exactly one of `likeTarget` present or `post` present with a parent (the Reply row). At most one karma output, same owner as all inputs — omitted when the change would be zero; target live; `(liker, target)` not recorded. **Value conserved** |
| KarmaBox | KarmaBox + KarmaPriceBox | **Thread**: `post` present with no `parentRefs` ⟺ exactly one `KarmaPriceBox` output of exactly `POST_PRICE_THREAD` and no `LikeAccrualBox`. At most one karma output, same owner as all inputs — omitted when the change would be zero; the signing key is the post's author. **Value conserved** — a post carries **no** deficit and **no** surplus |
| KarmaBox | KarmaBox + KarmaPriceBox + LikeAccrualBox | **Reply**: `post` present with one parent ⟺ exactly one `KarmaPriceBox` output of exactly `POST_PRICE_REPLY − REPLY_AUTHOR_SHARE` **and** exactly one `LikeAccrualBox` output of exactly `REPLY_AUTHOR_SHARE` whose `author` is the parent's author from `block_topology`. The karma output as above; the signing key is the post's author. **Value conserved** |
| KarmaBox | KarmaBox | **Prune** (→ Prune transactions): `prune` present ⟹ all-karma inputs sharing one owner, exactly one karma output, **total output equal to total input**, `inputKarma.owner` is the root's `block_topology` author, and `verifyPruneCommitDomains(tx.prune)` passes. ⛔ **An IMPLICATION, not a biconditional** — the converse would forbid the bare self-consolidation the row above admits, so recognition is by payload presence and never by shape |
| KarmaBox | KarmaBox + BondBox | **Invite**: karma outputs same owner, value conserved; `inviteBondMin ≤ bond.value ≤ inviteBondMax` (per-network caps) and the settlement grants **exactly `bond.value`**; `bond.inviterId` = the karma input owner; `inviteePublicKey` holds **no `IdentityRecord`**, and **no other bond in this block names it**; `bond.inviterId` is a root, or a member with `⌊memberVouches / D(N)⌋ − invitesUsed ≥ 1` on its record at apply, `N` from pre-body state (→ Bond transition rules, → Membership pass) |
| KarmaBox | KarmaBox + VouchBox | Vouch cast: karma outputs same owner; `vouch.value == VOUCH_KARMA_AMOUNT`; `vouch.voucherId` == the karma input's owner; the voucher is a member — `member(voucher)` on its record at apply (→ Membership pass); `vouch.targetId ≠ vouch.voucherId`; the target holds an `IdentityRecord`; no unspent `vouch` box carries the same `(voucherId, targetId)`; the voucher's **summed** karma balance ≥ `VOUCH_MIN_BALANCE`; no unspent escrow names the voucher; `vouch.createdAtBlock` within `[height − VOUCH_CAST_HEIGHT_WINDOW, height]` (the upper bound is step 6's; the window bounds backdating, which would shorten the cooldown the escrow derives from it) |
| VouchBox | VouchEscrowBox | **Unvouch**: exactly one VouchBox input, voucher-signed; exactly one escrow output with `value ==` the consumed box's, `owner == voucherId`, and `releaseAtBlock == vouch.createdAtBlock + vouchCooldownBlocks` — an exact pin, derivable from the consumed box alone. The cooldown runs from the **cast**, so a long-held endorsement costs no extra lockup and no withdrawal pattern returns the stake early. Value conserved |
| VouchEscrowBox | KarmaBox | **Block application only**: the settlement of the first block at or past `releaseAtBlock` consumes the escrow and returns its value to `owner` as karma (§The settlement transaction) — **no user transaction can spend a `VouchEscrowBox`**. Withdrawal itself is never gated — only the stake's return waits, and it waits in the escrow |
| LikeAccrualBox | — | **Settlement only.** No user transition admits one as an input |
| CreditBox | CreditBox(s) and/or FeeBox | Any owner, value conserved. **At most one FeeBox**, and it may not hold `0` — zero fee means no box. A transaction whose only output is the FeeBox is legal |
| KarmaPriceBox | — | **Settlement only.** No user transition admits one as an input; the settlement of the block that created it consumes it and returns its value to the pool |
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

- **A post is a transaction, and that is the whole of its admission.** It pays
  the post's price and conserves value; there is no separate post signature,
  no PoW and no challenge. The author is the transaction's signer.
- **A post pays its price into a `KarmaPriceBox`**, and a reply pays `REPLY_AUTHOR_SHARE` of it
  to the parent's author through a `LikeAccrualBox` — the Thread and Reply rows under Legal box
  transitions state the shapes, `ARCHITECTURE → The post price` the rule. The parent's author is
  resolved from `block_topology`, exactly as a like's target author is, and a reply to a stump or
  a withdrawn post pays that row's author. ⛔ **The reply's marker moves no like counter**:
  `lifetimeLikesReceived` is bumped from like transactions and from nothing else.
- **A reply's parent may still be pending at admission.** The marker names the parent's author, and
  `validateTx` resolves it from `block_topology` — and, where the parent has no row yet because it
  is in this node's pool, from the parent's own pending row, whose `author` is the commit its
  transaction carries and which that transaction's post arm binds to its signer. **At apply only
  `block_topology` is read**: a parent confirmed in the applying block has its row before the loop
  (§8 populates topology from the block's own posts), an earlier one has it already, and a parent
  in neither refuses the reply (*"names no author"*). The fallback is the reply's alone — a like's
  target, a prune's root and a withdrawal's post must be confirmed at admission exactly as before.
  This is what keeps a reply able to spend its own thread's change with no block between the two
  (`TYPES_INTERFACE → Monotonic creation height`, the chaining a block interval must allow).
- ⛔ **The relay gate is a cached MEMBERSHIP check, not a balance read.** `net`
  drops a post from an author who holds no karma **at all**, consulting an
  in-memory set rather than the store. The set moves only when an identity first
  receives karma and when it falls to zero — it is not a decay or settlement
  concern, so it is not on any hot path.

  > ✅ **RESOLVED 2026-08-22 — closed by PR #119 (`9945682`).** `index.ts` seeds
  > the set at startup with `getKarmaOwners()` (every identity holding an unspent karma box) and
  > registers a store hook (`registerKarmaMembershipHook`) that `insertBox` / `consumeBox` /
  > `deleteBox` / `unconsumeBox` fire on exactly the two transitions — an owner's first unspent
  > karma box and its last — so apply and revert move the set alike.
  >
  > **The record — this was VIOLATED, verified 2026-08-22:** node owned the set and never wrote it;
  > no caller of net's `setKarmaMembers` / `addKarmaMember` / `removeKarmaMember` existed in
  > `packages/node/src`, so the set was empty from the day the gate landed and every relayed post was
  > rejected at the topic validator — posts reached other nodes only inside blocks. Found by the e2e
  > packet chapter, the first test that needed a relayed post's body.

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
- **The transaction carries the commit; the body travels beside it; the packet is the unit.**
  `tx.post` is a `PostCommit` — `contentHash`, `author`, `parentRefs`, `protocolVersion`,
  `type` (TYPES_INTERFACE → Layout — PostCommit); the body reaches a node only in the same
  message as its transaction: `POST /posts { tx, content }` locally, the gossip packet from a
  peer (NET_INTERFACE → Gossip Topics). Both are validated together (`verifyPostBody(content,
  tx.post.contentHash)`, then the commit and the transaction) and **admitted together in one
  store transaction — the mempool entry and the DAG's pending row with the body — or refused
  together.** A producer therefore holds every body it mines by construction: a bodiless post
  transaction never enters a pool. A relayed post is visible on the receiving node as a pending
  row from admission, as it is on its origin node.
- **The pending row is the mempool entry's DAG shadow — it exists iff the transaction is in the
  pool, or the post is confirmed.** `purgeExpired` and eviction of an unconfirmed post entry
  delete its pending row; `removeUtxoTxEntry` at confirmation does not (apply confirms the row);
  a reverted block's re-inserted transactions find their rows returned to pending by
  `unconfirmPost`, body intact.
- **A post applied without its packet is a placeholder.** Block application inserts a row from
  the commit with `content = NULL` when none exists, confirms it, and the body is backfilled by
  id (Store Interface → Posts DAG, "Backfill after sync"). The placeholder rules: a like on it
  is valid and credits the topology author; a reply to it is valid; `executePrune` on the root
  of a subtree holding placeholders proceeds — prune needs topology, not bodies. `isLivePost`
  is the guard at every site that distinguishes a post from a stump or tombstone ("Resolution
  order for a post id"); a tombstone parent is `Parent post not found`, as the null is today;
  a reply to a stump stays valid (ARCHITECTURE → Post structure: refs may name stumps).

### Prune transactions

- **A prune is a transaction, and that is the whole of its carriage.** It is a
  karma **self-transfer** — all-karma inputs sharing one owner, exactly one karma
  output, total output equal to total input — carrying a `PruneCommit` payload
  (`rootPostHash`; TYPES_INTERFACE → Layout — PruneCommit). It rides `utxoTxIds`
  with every other transaction; the block body has no prune section.
- ⛔ **The subtree is derived, never carried.** At §8c the set is
  `getSubtreeTopology(rootPostHash)` — every `block_topology` row reachable from
  the root through its parent edges, the root included, **as the table stands after
  §8 populated it from this block's own posts** — so a reply confirmed in the
  prune's block is in the set, and a reply confirmed between the prune's signing
  and its inclusion invalidates nothing. Every node derives the same set from
  committed state; a node holding no DAG content reaches the same verdict.
- ⛔ **The prune's block deletes and marks, and settles nothing.** §8c, per prune
  in committed order: the maturity bind; the root-prunes-once check; the like-records
  are deleted and tallied; **every stump inside the set is absorbed** — an earlier
  prune's, never the root's own — its `upvoteCount` added to the tally, its row deleted
  and journalled (→ Block Journal, `absorbedStumps`), so a thread carries one stump, the
  outermost, and a pruned descendant's tombstone names it; the stump is inserted
  (`replyCount` = set size − 1, `upvoteCount` = the tally, absorbed counts included) —
  a plain `INSERT`, because the check above refuses a second prune of the root before
  it runs, so a conflict here is local corruption and the apply funnel's totality catch
  rejects the block; `dag_posts` and `dag_parent_refs` rows are deleted
  by the set; and **every `block_topology` row in the set is marked**
  `pruned_at_height = h`, `pruned_root = rootPostHash`. The marks are the
  tombstone's source and are journalled (→ Block Journal): a row an earlier prune already
  marked is re-marked with this root, and the marks it held ride the journal, so a revert
  hands them back exactly. Nothing is refunded and
  nothing further is burned — every post in the set paid its price at posting
  (ARCHITECTURE → The post price) — so a subtree of any size prunes in one block.
- ⛔ **`prune` is an IMPLICATION, never a biconditional.** `prune` present ⟹ the
  shape above **and** `inputKarma.owner` is the root's `block_topology` author
  **and** `verifyPruneCommitDomains(tx.prune)` passes. **The reverse must never
  be written**: a conserving karma self-transfer is legal on its own — it is
  self-consolidation, the legitimate multi-input case — so a reverse implication
  would forbid it. ✅ **Recognition is by payload presence, never by shape**, so
  the missing reverse is safe: nothing else can be mistaken for a prune. This is
  why `likeTarget`'s and `post`'s biconditional pattern deliberately does **not**
  transfer — each of those pairs with an observable output, and a prune emits none.
- **Authorship is the transaction's own.** The payload sits inside the
  `computeTxId` preimage, so the signer's signature covers it and no separate
  `authorId` or `authorSignature` exists. `block_topology` is the authority for
  who may prune a root, so a node holding no DAG content reaches the same verdict.
- ⛔ **The maturity bind: a root confirmed in the applying block is NOT prunable.**
  `block_topology.block_height` must be **strictly less** than the applying
  height. Producer-independent and decidable from committed state alone, and it
  forbids nothing legitimate — an author who changes their mind waits one block
  and prunes properly. Reachable through the ordinary API, so
  the intent route enforces the same rule at submit. **The same bind governs
  withdrawal.**
- ⛔ **A root prunes once.** The root must resolve to a `dag_posts` row — `isStoredPost`,
  live or withdrawn — never a stump and never a tombstone. `block_topology` keeps a pruned
  root's row (the marks are set, the row survives), so the authorship binding and the
  maturity bind both hold for a root already pruned, and this read is what refuses it.
  Enforced at both ends the way withdrawal's liveness is: the intent route refuses the
  submission (`Post is already pruned or unknown`), and §8c rejects the block. The root is
  judged as `dag_posts` stands when its prune applies — after this block's withdrawals and
  after every prune earlier in committed order — so a block carrying a prune of a root that
  an earlier prune in the same block removed is rejected, and a producer's own speculation
  refuses that body (→ "The speculation has three outcomes, not two"). A withdrawn root stays
  prunable: withdrawal empties the row and keeps it.
- **`verifyPruneCommitDomains` is the single statement of the payload's
  structural domain** — `rootPostHash` hex-32, and nothing else. It lives in
  `@dagsocial/validation` and both the envelope check and the transition arm
  call it; two implementations of one domain drift. The precedent is
  `verifyPostCommitDomains`.
- **The route submits, validates and broadcasts like every sibling.** The intent
  route runs the prune-specific checks, then `validateTx`, then `admitTx`, then
  `net.broadcastTx` — so a prune gossips to every peer's pool and any miner may
  include it. **A prune submitted to a node that never mines reaches consensus.**


### Withdrawal transactions

- **A withdrawal empties one post and leaves its subtree intact.** It is a karma
  **self-transfer** — all-karma inputs sharing one owner, exactly one karma
  output, total output equal to total input — carrying a `PostWithdrawCommit`
  payload (`postId`; TYPES_INTERFACE → Layout — PostWithdrawCommit). It rides
  `utxoTxIds` with every other transaction.
- ⛔ **This is not deletion and is never described as one.** The `postId`, the
  `parentRefs` and the `block_topology` row all survive, so every descendant
  keeps its anchor. Any peer that archived the content before withdrawal can
  republish it; what the protocol guarantees is that honest nodes drop the bytes,
  that they stop propagating, and that the author's intent is attributable.
  **User-facing wording is "withdrawn by author", never "deleted".**
- ⛔ **`postWithdraw` is an IMPLICATION, never a biconditional**, for prune's
  reason: a withdrawal emits no observable output, so its right side is an
  ordinary conserving self-transfer which must stay legal. `postWithdraw` present
  ⟹ the shape above **and** `inputKarma.owner` is the post's `block_topology`
  author **and** `verifyPostWithdrawCommitDomains(tx.postWithdraw)` passes.
- **Authorship is the transaction's own** — the payload sits inside the
  `computeTxId` preimage, so no separate `authorId` or signature exists.
- ⛔ **A withdrawn post cannot be liked.** `isLivePost` is
  `isStoredPost(x) && x.withdrawnAtHeight === null`, and every consumer narrows
  through it — including the like arm at block application, which is a consensus
  path. `isStoredPost` answers the separate, purely structural question.
- ⛔ **A post may be withdrawn once.** The marker already being set, or a second
  withdrawal of the same post earlier in the same block, rejects the block. The
  state that would refuse the second is written by the settlement, which runs
  after, so an in-block set is required.
- **The store keeps the row and empties it**: `content` to `NULL`,
  `withdrawn_at_height` to the applying height. ⚠ **`content IS NULL` alone means
  *placeholder*** — a body not yet backfilled — so the marker is what the three
  body queries (`getMissingBodies`, `getPlaceholdersAt`, `setPostBody`) read to
  tell the two apart. Without it a withdrawn post re-enters the backfill queue and
  a peer still holding the bytes refills it.
- **The route submits, validates and broadcasts like every sibling** —
  `POST /posts/:id/withdraw`, then `validateTx`, `admitTx`, `net.broadcastTx`.
  **A withdrawal submitted to a node that never mines reaches consensus.**

### The prune and withdrawal phase

- **One phase applies every prune's and withdrawal's DAG effect a block carries**, after the
  transaction apply loop and before the settlement transaction is built. It moves no value: a
  post's price was paid by the post transaction (ARCHITECTURE → The post price), and there is
  no lock to settle.
- ⛔ **It runs AFTER the loop, and that is load-bearing.** The like arm rejects a
  like on a stumped or withdrawn post, so a phase running before the loop would make a block
  carrying like(P) and prune(P) invalid — two unrelated users' individually valid
  transactions that no producer could combine into one block. After the loop the
  like arm sees a live post and the pair is valid, with no producer-side filter.
- **Withdrawals first, then prunes, each in committed transaction order.** A reply
  withdrawn by its own author in the block its thread is pruned is emptied and then
  deleted with the subtree; the order is kept for the phase's legibility, not for the
  outcome — neither pass refunds or burns anything.
- **What each pass does is stated where its transaction is**: Withdrawal transactions (the
  row emptied, `withdrawn_at_height` set), Prune transactions (the set derived, like-records
  deleted and tallied, the stump inserted, rows deleted, topology marked).

### Bond transition rules

- **A bond is never spent, only settled.** Creation, the probation clock and
  forfeiture are all block application's, so no
  transition admits a bond into a user transaction and no signature reaches it.
  This is what closes audit F-consensus-1 by construction rather than by a rule: there
  is no shape in which any party — inviter or invitee — can direct a
  bond's value anywhere.
- **The bond's value only ever reaches `bond.inviterId` or the pool.**
  Settlement returns the vested part to the inviter and the remainder to the
  pool. No path pays a bond to the invitee.
- **Settlement happens once, at or past the deadline, and reads only likes.**
  `IdentityRecord.invitedAtBlock + INVITE_PROBATION_BLOCKS` is the height a
  bond becomes eligible; the settlement takes at most
  `MAX_BOND_SETTLEMENTS_PER_BLOCK` eligible bonds per block, ascending
  `(invitedAtBlock, box id)`, and a bond still waiting settles against the
  counter as it stands in the block that takes it (`TYPES_INTERFACE` →
  Settlement caps). The vested amount is
  `min(floor(IdentityRecord.lifetimeLikesReceived / INVITE_BOND_VEST_PER_LIKES), bond.value)`,
  and the remainder
  burns regardless of what the invitee did otherwise. No karma balance is
  read, at that height or any other — the earlier spend-time predicate
  measured what an invitee *held*, which the invite's own mint satisfied
  before they had done anything.
- **The probation clock starts at the grant.** `invitedAtBlock` is written by
  block application when the settlement grants the invitee, which is the same
  event that creates the record — one height, recorded once, read by the
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

  Record existence is the right test because **every path that puts karma in a
  key's hands writes one** — the invite grant creates the record at the claim, and
  genesis writes the system identity's explicitly (§Populating the record). A key
  with no record has never held karma, so it has never posted and never been liked — which
  is also what makes the claim the record-*creating* event for every
  legal invitee, and `lifetimeLikesReceived` necessarily `0` at that
  point. Being barred costs an uninvited party one key generation, since
  the identity carries nothing.
- ⛔ **Only a root or a member creates a bond, and a member's invites are a budget.** The
  invite-create arm reads the inviter's record at apply: a root (`memberSinceBlock > 0`,
  `memberBar = 0`) passes unconditionally; a member passes iff
  `⌊memberVouches / D(N)⌋ − invitesUsed ≥ 1`, with `D(N)` from the network record of pre-body
  state (→ Membership pass); a resident is refused. Applying the transaction increments
  `invitesUsed` on the inviter's record, carrying every other field through, and nothing ever
  decrements it — a spent invite is never revoked (`ARCHITECTURE → The invite budget`). Two
  invites by one member in one block read the record as the first left it, so the second needs
  the second slot.
- **Engine inputs these rules need:** the invite-create arm reads
  `getIdentityRecord` for the uniqueness check and for the inviter's standing, and the network
  record for `D`; block application
  gains a settlement sweep keyed on `invitedAtBlock` —
  `getBondsSettlingAt`'s shape. `checkTransitions` needs no karma-sum read
  and no settle height.

### Karma transition rules

⛔ **The set of box types this arm admits as outputs is the TRANSITION set, and it is not the set
`totalKarma` sums** — see "Three karma sets, and none derives from another" under Status.
`karma_price` is in it — a post's price is a karma output of the post transaction — and in the
conservation set, and **not** in the supply set: it is karma on its way out of circulation. ⚠ **A
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
  legitimate multi-input case and stays legal. The faucet's invite (`tools/faucet`,
  `karma → karma + bond`) is unaffected: every karma input it spends is its own.
- **Credits are deliberately exempt.** They are tradeable, so multi-owner
  credit inputs are an ordinary multi-party payment, not a leak.
- ⛔ **A karma output carries at least `1n`, and the change output is optional**
  (`TYPES_INTERFACE` → Box value domain: zero means no box). A spend whose karma
  inputs total exactly its cost — a like from a single 1-karma box, a thread from
  a 5-karma box, an invite or a vouch that empties the wallet — emits no karma
  output at all, and the like shape is then the marker alone. No pin needs a
  karma output to name the owner: `bond.inviterId`, `vouch.voucherId` and the
  lock's `owner` bind to the karma **input's** owner, and the signature is that
  owner's. Prune and withdraw keep their single karma output — their inputs are
  at least `1n`, so it is.

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
>    `author` is the target post's author, resolved from `block_topology`; and `post` present with a
>    parent ⟺ exactly one of exactly `REPLY_AUTHOR_SHARE` whose `author` is the parent's, resolved
>    the same way (→ Post transactions);
> 2. **a `LikeAccrualBox` output present ⟺ exactly one of `likeTarget` present or `post` present with
>    a parent**, and the marker names the author that transaction pays, at that transaction's amount.
>
> ⚠ **Without (2) this is the `voucherId` defect above, in a new box.**
> `myKarma(K) → myKarma(K−n) + LikeAccrualBox(n, author=Bob)` **conserves**, carries no `likeTarget`,
> and pays Bob at settlement — *"a karma transfer with no invite — the property the whole invite/bond
> mechanism protects."* Same class, same severity, and it arrives with the type rather than later.
>
> ⛔ **No user transition admits a `LikeAccrualBox` as an INPUT.** Only the settlement transaction
> consumes one, so `author` is attribution and never authorization — the standing `BondBox` and
> `KarmaPriceBox` already have.
>
> ⚠ **The author is resolved from `block_topology`, never `dag_posts.author`** — the rule §Likes
> already states, and the marker inherits it. A placeholder row carries a zeroed author, so a marker
> built from the wrong source would earmark karma to the zero key.

### Vouch transition rules

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
  settlement returns exactly that. With the cast pin the two always agree —
  recording the real value is what makes the round trip conservation-
  structural rather than true by coincidence.
- **A vouch cast is invalid while any unspent escrow names the voucher** —
  `hasActiveVouchEscrow`, keyed on the voucher alone because the escrow
  carries no target. This is what rate-limits **re-vouching** even though
  **stopping** is instant: the escrow stands until the settlement at
  `releaseAtBlock` spends it, and a new cast is barred while it stands, so the
  cycle rate is capped at one vouch per cooldown window however briefly each
  vouch is held — and the gate clears on its own, the settlement's spend being
  what `hasActiveVouchEscrow` stops seeing. Without the gate a voucher cycles
  cast → withdraw → cast and accumulates escrows at 1 karma each — cheap
  UTXO-set bloat.
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
  release height; the next block's settlement returns it — the commitment was
  served during the endorsement.
- **The escrow is committed state, and nothing node-local remembers
  anything.** It sits in the UTXO set and therefore in the `stateRoot`, so a
  node holds the obligation itself rather than a root it cannot interpret.
  The return is a settlement leg (§The settlement transaction): every unspent
  escrow with `releaseAtBlock <= height`, read from pre-body state in ascending
  box id, is an input of the block's settlement and its value a karma output to
  `owner`. No user transaction spends an escrow — `vouch_escrow` is block
  application's, like `bond`.
- ⛔ **Only a member casts.** The arm evaluates `member(voucher)` on the voucher's record as it
  stands at apply (→ Membership pass); a resident's cast is refused. A resident's endorsement of
  anyone is their likes.
- ⛔ **The target holds an `IdentityRecord`.** The `+1` below is a record write, and a record is
  the invite bar (→ Bond transition rules): a vouch naming an uninvited key would create its
  record and bar that key from ever being invited — one stranger's 1-karma stake locking anyone
  out. The arm admits no bare 32 bytes as a target.
- ⛔ **No self-vouch, at consensus.** A vouch toward oneself would be one counted endorsement
  toward the voucher's own bar and invite budget, so `vouch.targetId ≠ vouch.voucherId` is the
  arm's rule.
- ⛔ **One live vouch per `(voucher, target)` pair.** Distinct endorsers are the whole point of
  the bar, and a duplicate would count one twice; a cast is refused while an unspent `vouch` box
  carries the same pair. The pair-scoped cooldown — no re-vouch of the same target while its
  escrow stands — is the escrow gate above and stands beside this.
- ⛔ **The counter has two writers and one predicate.** `IdentityRecord.memberVouches` on the
  target counts the live vouches naming it that are *counted* — `counted(v → m) ⟺
  m.memberSinceBlock = 0 ∨ v.memberSinceBlock < m.memberSinceBlock`, two immutable ages
  (`ARCHITECTURE → Membership`). The cast's apply adds one iff counted; the consumption of a
  `vouch` box subtracts one iff counted — whichever transaction consumes it, the user's unvouch
  or the settlement's lapse leg — through one function that every consuming path calls. Fork
  rollback restores the record through the journal's `replaced` value, never by a second
  arithmetic step. Because the target's age is written only by the membership pass, after the
  transaction loop, and a voucher's age is strictly below any block it casts in, the predicate
  gives one answer for a box's whole life.
- **An unvouch consumes exactly one VouchBox and produces exactly one
  escrow**, enforced in `checkTransitions` — consuming several stakes in one
  transaction has no meaning in the design, so it is inexpressible rather
  than handled, the same reasoning as the bond settlement's single-input
  bound. There is no cap on a voucher's live vouches; the escrow gate above is
  what rate-limits re-vouching after any withdrawal.

### Membership pass

Membership is a predicate on the identity record — `member(m) ⟺ memberSinceBlock > 0 ∧
memberVouches ≥ memberBar` (`ARCHITECTURE → Membership`) — and the pass is the bookkeeping that
sets the two immutable fields and keeps the network record's `N` equal to the number of
identities the predicate holds for. **It moves no value.**

**Where it runs.** Block application's end-of-block order is pinned: the transaction loop → the
settlement transaction → the like counters → **the membership pass** → the decay clocks (→
Per-block like settlement). The pass therefore sees every `memberVouches` write of the block —
casts in the loop, consumptions in the loop and in the settlement's lapse leg — and every
`memberLikes` write.

**What it reads.** `N`, `D(N) = max(1, icbrt(k · N))` and `Y(N) = MEMBER_LIKES_MULTIPLIER · D(N)`
from the network record of **pre-body** state — one read, so two crossings in one block face the
same bar, and the same on both sides (→ "Every state-derived quantity is derived from pre-body
state"). `k` is the profile's `membershipBarMultiplier`; `icbrt` and `membershipBar` are
`@dagsocial/types` exports (TYPES_INTERFACE → Membership), the one implementation every reader of
`D` calls.

**Over whom.** The identities the block touched — every vouch target whose box was cast or
consumed this block, every author whose `memberLikes` rose — in ascending identity hex. For each,
`member(m)` is evaluated on the record as it stood before the block's writes and as it stands
after them:

1. `memberSinceBlock = 0`, and now `memberVouches ≥ D(N)` and `memberLikes ≥ Y(N)` → **set**:
   `memberSinceBlock = height`, `memberBar = D(N)`, every other field carried through; `N + 1`.
2. `memberSinceBlock > 0`, a member before the block and not after → **lapse**: `N − 1`, and
   nothing else is written — the predicate is the state, and it turned false at the consuming
   transaction's apply.
3. `memberSinceBlock > 0`, not a member before and a member after → **re-qualified**: `N + 1`.
   The age and the bar are untouched.

`N` is written once, at the end, through `putNetworkRecord`; every record write goes through
`putIdentityRecord`. Both are journalled, so a reverted block restores every record and the
network record exactly (→ Block Journal).

**The same-block cases, stated.** A cast and its target's set in one block: the cast applies in
the loop with `m.memberSinceBlock = 0`, so it is counted, and the set writes an age strictly
above the voucher's — a voucher was a member at apply, so its own age is at most `height − 1`,
or the genesis mint height for a root — so `counted` is unchanged after the set. A voucher's own
set and its cast in one block cannot occur: the cast requires `member(voucher)` at apply, before
the pass. Two sets in one block take the same age and do not count for each other from then on,
and neither has ever counted toward the other: a non-member cannot cast. A root's age is the
genesis mint height; a non-root's record is first written by a settlement grant at that height
or later and can be vouched only from the following block's body, so every set height is strictly
above every root's age.

**The cascade is one generation per block, and the pass is why.** A lapse in this block's pass
makes the lapsed member's vouches eligible for the lapse leg of the **next** block's settlement
(→ The settlement transaction), which consumes them and lowers younger members' counts, whose
lapse that block's pass records; the following settlement withdraws theirs. A counted vouch
always runs old → young, so the cascade terminates and never reaches a root.

### Karma decay (virtual, squared on touch)

Decay is a **valuation over committed state**, applied at every
karma-sufficiency read; face values move only when a block's body touches the
identity, and then only through that block's settlement transaction
(`ARCHITECTURE` → Karma decay is the model's one statement). The derivation
produces the same per-identity leg shape as before — consume the identity's
post-body karma boxes, re-emit effective to the owner and the remainder to the
pool — with the trigger being **touch**, never a per-block walk. See
`decay.ts`. The read API reports the same valuation: `GET /karma/:userId` carries it as
`effective` (→ UTXO queries).

The clock is the `IdentityRecord` (Store Interface → Identity Records):

```
stale       = (height − lastActivityBlock) >= staleThresholdBlocks
owedPeriods = floor( (height − max(lastActivityBlock, lastDecayBlock)) / interval )
effective   = clamp(faceTotal − owedPeriods · decayAmount)   // never below min(faceTotal, KARMA_MINIMUM)
```

⚠ **The comparison is `>=`, not `>`.** This contract said `>`,
and was wrong by one block. `isIdentityStale` treats a box as recent
when `createdAtBlock > currentHeight − threshold`, so an identity is stale
exactly when *no* box satisfies that — i.e. when
`currentHeight − lastActivityBlock >= threshold`. `>` would delay every
identity's first decay by one block, which is a behaviour change D10 forbids.
Found by reading the code.

**Staleness reads the record.** `lastActivityBlock` is the height of the owner's
most recent karma-spending transaction (§Populating the record), so the predicate
is "no spend within the threshold window".

**`owedPeriods` changes, deliberately — one accepted exception to D10.** The old
code measures from the **oldest** non-decay box (falling back to the youngest
when all are decay-burn). The record measures from the **most recent** activity.

The two were held equivalent on the premise that forced
consolidation means one karma box per owner so oldest == newest. **That premise
is false:** settlement karma outputs land beside whatever karma the owner
already holds — the settlement does not consolidate — so two unspent non-decay
karma boxes at different heights is ordinary, and the two formulas then
disagree. Measured: a burn of 45 under the old rule, 30
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
transaction whose outputs take ordinary transaction-derived ids. **Exactly one producer class
creates boxes with no transaction behind them**, and only it derives a synthetic id per mint
*event*:

- **genesis seeding** (`store/system.ts`) — the store is seeded before any block exists.

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
| `genesis` | which genesis box | `u32BE(k)`: `0` = faucet karma stake, `1` = faucet credits, `2` = genesis proof, `3` = emission, `4` = karma pool | 4 | genesis seeding — `ensureSystemKarmaBox` / `ensureFaucetCreditBox` / `ensureGenesisProofBox` / `ensureEmissionBox` / `ensureKarmaPoolBox`. Selectors `0` and `1` exist only where the profile names a faucet identity; `2`–`4` on every network |
| `genesis-committee` | the committee member | raw | 32 | genesis seeding — `seedGenesisCommittee`, one karma box per `genesisCommitteeKeys` entry, drawn out of the pool |

**Two reasons, and the set is closed by the one producer class.** A settlement output needs
no reason — it has a transaction — so a new reason enters only with a new genesis box or a new
conserving-in-place direct producer, of which there are none. Tags are `@dagsocial/types`' (`MINT_REASON`); this table
deliberately does not repeat them. **Reasons retired before mainnet are deleted outright —
numbers and names both free, no reservation list** (user, 2026-08-19); a **live** tag is never
renumbered (TYPES_INTERFACE → Primitives).

**Why `(height, reason, subject)` cannot repeat, per row.** Genesis seeding runs once, on an empty store; each
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
creation and `genesis-committee` grants are drawn out of the pool in the same seeding. Everything that moves value
after genesis is either a user transaction or the block's settlement transaction
(`ARCHITECTURE` → UTXO conservation), and neither needs a mint reason: their outputs carry
ordinary transaction ids.

⛔ **Value movement is never a call site's discipline.** The one operation that moves karma —
the settlement transaction — names source and destination in one operation and fails closed:
a settlement that does not conserve is a rejected block. Every path that touches the pool, the
emission box or the treasury is the settlement's, and no path conserves inside itself outside
it. **The property is the primitive's, not its callers'** — the same standing `consumeBox`'s
liveness check has.

⚠ **The conservation invariant holds at every height and between every pair of transactions
inside a block:** `sum(every karma-bearing box) + pool` is constant from genesis
(`ARCHITECTURE` → UTXO conservation; `test/services/conservation-axiom.test.ts` asserts it
across an applied chain). ⚠ **It is a DIFFERENT sum from `getTotalKarma`**, which reports
circulation and excludes the pool deliberately; asserting either against the other is an
error.

Three rules about subjects that are decided, not open:

- **Distinct recipients-at-height need distinct `(reason, subject)` pairs.** No live instance
  shares a height and a subject across two reasons; the rule binds the next producer class.
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

Each mint event emits exactly one box, so its `index` is `0`. Genesis seeding is one event
per selector and one per committee member. The `index` field exists so mint and transaction derivation
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

### The demo UI mirror carries the same strip defect

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

Not a representative one. The cbor-era UI converted hex-string fields to bytes
before encoding using a hardcoded `binaryFields` name list — a hand-maintained
copy of "which box fields are `Uint8Array` in types" — and it **omitted
`VouchBox`'s `voucherId` and `targetId`**: a client-built vouch box encoded
them as CBOR *text* (`7840` + 64 ASCII) where the node wrote a *byte string*
(`5820` + 32 raw), giving a different box id. Latent only because the vouch flow
POSTs to `/vouches` and never builds the box client-side.

That gap survived because the mirror covered **karma and credit only** — the other
box types were never encoded through both implementations and compared. So
the enforceable rule is coverage, not documentation: with every box type in the
mirror, a missing `binaryFields` entry fails mechanically instead of waiting for
someone to notice the list is a manual copy of a type definition.

⚠ **This is the second instance of the shape** — a round-trip test that used only a karma box, so
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
3. ✅ Phase G deleted `createdAtBlock` and `lastTouchBlock` from the box protocol.
   `lastTouchBlock` and its `last_touch_block` column are gone for good: no reader
   anywhere, only the INSERT that wrote it. ⚠ **`createdAtBlock` RETURNED, and only
   its deletion was reversed.** It is a box field again — creator-declared content in
   the shared prefix, restored once the decay clock stopped reading it, which is what
   made a client-declared height untenable in the first place (`ARCHITECTURE` →
   Ergo-Adopted Invariants carries the reversal and its premise; `TYPES_INTERFACE` →
   "createdAtBlock is a box field, and it is CREATOR-DECLARED" carries the rule, and
   the obligation every deriving rule owes). The `created_at_block` **column** stays,
   filled from the box's own field.
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
7. ✅ `insertBox` fills the `created_at_block` **column** from the box's own
   `createdAtBlock`; the **activity clock** is block application's, taking the
   open journal's height when a karma-spending user transaction applies — two
   heights answering two questions (§Populating the record). Outside a journal —
   genesis and bootstrap — there is no clock to advance.

**Blockers, both cleared before G3**

8. ✅ `settlePruneUtxo` mint reasons (G2).
9. ✅ `u32BE` exported from `@dagsocial/types` (G1).

### What G3 changed that was NOT on this list

**A bond names no box at all.** A box id in a **content** field is circular under
the provenance derivation: the id derives from the creating `txId`, and a content
field sits inside the bytes `computeTxId` hashes. Measured: no fixed point exists.
The no-circularity argument for provenance-derived ids covers *provenance* fields —
they sit outside the bytes `computeTxId` hashes — and does not reach a content field.

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
| **Consumes, in this order** | the emission box (when this height releases) · the treasury box (when this block accrues to it) · every `LikeAccrualBox` marker the block's like and reply transactions emitted, in committed transaction order · every `KarmaPriceBox` the block's post transactions created, in committed transaction order · the carry box of every author the block credits, ascending author hex · **at most `MAX_BOND_SETTLEMENTS_PER_BLOCK`** `BondBox`es whose invitee's `invitedAtBlock` is at or before `height − inviteProbationBlocks` in pre-body state, ascending `(invitedAtBlock, box id)` · **at most `MAX_ESCROW_RETURNS_PER_BLOCK`** `VouchEscrowBox`es at or past their `releaseAtBlock` in pre-body state, ascending `(releaseAtBlock, box id)` · **at most `MAX_LAPSE_WITHDRAWALS_PER_BLOCK`** `VouchBox`es whose `voucherId` is not a member in pre-body state, ascending box id · the karma boxes decay charges · the karma pool box (when this block draws or returns) · every `FeeBox` the body's transactions created, in committed transaction order |
| **Emits, in this order** | the successors of the three protocol boxes — emission, treasury, karma pool · the invite grants · like payouts and carry successors · the vested part of each settling bond, back to its inviter · each released escrow's value, back to its owner · one `VouchEscrowBox` per lapse withdrawal — the vouch's value, `owner` its voucher, `releaseAtBlock = vouch.createdAtBlock + vouchCooldownBlocks` · decay replacements · the coinbase's credit outputs |

⛔ **A leg the body does not drive is capped, and the remainder waits.** Bonds, escrows and
lapsed vouches are read from chain state, so no producer can shrink them by selecting a
smaller body; each takes at most its cap per block in the stated total order — the order key is
unique, so every verifier takes the same items — and a candidate stays eligible **at or past** its
height until a block consumes it. A consumed candidate leaves the queue by being spent — there
is no cursor to store. ⚠ **The three caps and the empty-body settlement are the liveness
relation** (`TYPES_INTERFACE` → Size caps): whatever the chain state holds, the settlement of an
empty body fits `MAX_SETTLEMENT_BYTES`, so a block exists at every height.

⛔ **The two orders are consensus.** `derive()` builds the input list and the output list leg by leg in exactly these sequences, and a verifier recomputes both and compares the block's settlement to them position by position — the input list whole, the derived outputs element-wise; the coinbase is constrained, never derived (→ "Determinism is this mechanism's whole risk", the derived / producer-chosen table, where output ordering is a derived field). A leg moved is every settlement's bytes moved, on both sides identically. `node/test/services/settlement-leg-order.test.ts` pins both sequences with one fixture that fires every leg at once.

**The settlement declares the block's era.** `derive()` stamps `protocolVersion:
protocolVersionAt(schedule, height)`, and the verifier refuses a settlement declaring any other — the
envelope check every embedded transaction passes at the block's height (`verifyTxProtocolVersion`), and
the settlement's own comparison. The byte probe that prices a settlement stamps the same era, so a version
wide enough to widen the VLQ is measured rather than assumed.

⚠ **The escrow leg reads PRE-BODY state, and returns at or past `releaseAtBlock`, not at it.**
The settlement of height `h` consumes **at most `MAX_ESCROW_RETURNS_PER_BLOCK`** of the unspent
`VouchEscrowBox`es with `releaseAtBlock <= h` that exist in the state the block builds on, ascending
`(releaseAtBlock, box id)` — the rest stay eligible (`TYPES_INTERFACE` → Settlement caps) — and emits
each one's value to its `owner`
as karma — emitting nothing for a value of zero, like every karma leg, so a
zero-value escrow is consumed without an output (unreachable on a valid chain: the cast pins every
stake at `VOUCH_KARMA_AMOUNT`). The body can *create* an escrow — an unvouch of a vouch held longer
than one cooldown yields one already past release — and that escrow is not in pre-body state, so it
returns at `h + 1`; `<=` is what makes the leg total rather than height-exact. The list is captured
before the apply loop on both sides, like decay (below), and handed to the derivation — a store read
taken at the check, after the body applied, would see the body's own escrow on one side only. No
user transaction spends an escrow (`BLOCK_APPLICATION_ONLY`).

⚠ **The lapse leg reads PRE-BODY state too, and its predicate is the record's.** The settlement
of height `h` consumes **at most `MAX_LAPSE_WITHDRAWALS_PER_BLOCK`** of the unspent `vouch` boxes
whose `voucherId` fails `member(voucher)` — `memberSinceBlock > 0 ∧ memberVouches ≥ memberBar` on
the identity record — in the state the block builds on, ascending box id, and emits for each one
a `VouchEscrowBox` of the vouch's value to the voucher with `releaseAtBlock =
vouch.createdAtBlock + vouchCooldownBlocks`: the unvouch shape exactly (→ Vouch transition
rules), so the stake returns by the escrow leg and the escrow bars a recast as the voucher's own
withdrawal would. A member who lapses in this block's body is withdrawn from `h + 1` on; a voucher
who re-qualifies before the leg reaches a box keeps it; a candidate stays eligible until a block
consumes it or its voucher re-qualifies, and the predicate is derivable from state, so no cursor
is stored. Each consumption subtracts one from the target's `memberVouches` iff counted, through
the same function the unvouch uses, and the membership pass of the same block records the lapses
that follow (→ Membership pass). The list is captured before the apply loop on both sides, like
the escrows and decay.

⛔ **`CoinbaseOutput` is not a block-body concept.** Coinbase outputs are outputs of this
transaction; the block body has no `coinbaseOutputs` field and `utxoTxRoot` has no `'coinbase'`
leaf class (TYPES_INTERFACE → Ordering block).

✅ **"Every protocol effect" admits no exception.** Every box block application creates is an
output of the settlement transaction; no direct block-application transfer exists.

#### Why exactly one

The pool's id changes every time it is spent, so two transactions naming it conflict — and unlike an
ordinary contended box **the loser is not deferred but permanently invalid.** One protocol spend per
block gives zero contention. A transaction may carry as many outputs as it needs, so **the one-spend
rule bounds nothing** about how many invites, likes or sweeps a block holds. **What does bound them
is the settlement's own size**: `MAX_SETTLEMENT_BYTES` (`TYPES_INTERFACE` → Size caps) weighs the
whole transaction, so a block carries as many likes as their marker inputs fit beside its other
legs — the producer keeps the body-driven legs inside it by selection (`MEMPOOL_INTERFACE` → The
fill budget is bytes; `getPendingEntries` is a count), and the three capped legs above keep the
state-driven ones inside it whatever the producer selects.

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

⚠ **It fails on the ordinary case, not an exotic one.** Spending karma advances `lastActivityBlock`
when the transaction applies, so an identity that is decay-eligible **before** the loop is fresh **after** it.
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

⚠ **A single-row read needs it too, and for a different reason.** A `.get()` with neither
`ORDER BY` nor `LIMIT` takes whatever comes first; where one row per key is the invariant, the
order changes nothing **while the invariant holds**. ⛔ **Its job is to bound what happens when the invariant is violated upstream:
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
2. Read the pool — every entry through `iteratePendingEntries`, karma class first
   (MEMPOOL_INTERFACE → Ordering); the read removes nothing. **A prune is one of those
   entries**, selected like any other transaction and competing for the same body budget
3.–5. *(Retired with sub-blocks: there is no batch linking and nothing to decode
    separately — every pending entry is a standalone `utxo_tx`.
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
    ⚠ **One exception, and only one: a body its own mutation
    phase rejects.** See step 15b — the creator evicts every row the body
    carried and builds again from what remains, until it holds a template or a
    body carrying no row is rejected (`MINING_INTERFACE → Template and submit`).
    Mining over a body the node itself will not apply wastes PoW on a block
    that cannot be accepted anywhere.
13. Track the rowids the template carries — transaction and prune rows — for cleanup
14. Build coinbase outputs — the **miner's slice only**. The treasury's accrues to the
    `TreasuryBox` and the released emission comes out of the `EmissionBox`; both
    successors are derived here too, and neither rides in the block
15. Set the template's `powTargetBits` to the schedule over the tip header and its `createdAt` to
    `max(now, tip.createdAt + 1)` (`MINING_INTERFACE → Difficulty Schedule`, `→ Header timestamp
    rules`); a height-1 template carries the anchor's bits
15b. Compute `stateRoot` — the **post-block** digest (see "Post-block
    stateRoot" below). Never the creator's current (pre-block) digest. A
    `body-rejected` speculation evicts the body's rows (step 13) and returns to
    step 1; a rejected body that carried no row is terminal, and the build ends
    holding no template (`MINING_INTERFACE → Template and submit`).
16. Build block template (powNonce=0, empty signature)
17. **Internal mode:** mine PoW, sign the header hash (`blockHash(header)`), finalize
18. **External mode:** store template for `GET /mining/template`,
    return null (block finalized when miner submits via `submitMinedBlock`)

### Block finalization

1. Store block in `block_ordering` table
2. Broadcast ordering block to peers
3. Confirm the block's posts (`confirmPost` with height and committed position, ids from
   its post transactions); a post with no row — its packet never reached this node — is
   first inserted from its commit as a placeholder (`insertPost(postId, commit, null)`), and
   its body is backfilled by id (Store Interface → Posts DAG, "Backfill after sync")
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

The speculative run performs no block storage, no `clearTemplate`, no journal
persistence, and no prover checkpoint.

**The speculation has three outcomes, not two** (the code
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
the **miner's slice alone**. The treasury's share accrues to the `TreasuryBox` and the unearned
inclusion bonus stays in the `EmissionBox` — neither is redirected to the miner, who would
otherwise recover their own forfeit, and neither is a coinbase output on any network.

**Emission is released from a box, not minted.** Genesis holds a carried total in an
`EmissionBox` (TYPES_INTERFACE → EmissionBox) and each block spends it to a successor holding
`value − min(computeBlockReward(height), value) + unearned`, so what remains to be emitted is state
an observer reads. **The box exists at every height whatever its value**, because a forfeited bonus
must always have somewhere to land; above exhaustion it releases nothing until one arrives.

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

`powTargetBits` is the ASERT schedule over the chain's own headers (`MINING_INTERFACE → Difficulty
Schedule`, the normative rule), enforced at apply on every path: the funnel evaluates
`asertTargetBits` over the **stored parent** it already fetched for the chain-link check and rejects a
block whose header target differs; a height-1 block's bits must equal the anchor's. Beside it the
funnel applies the two header timestamp rules (`MINING_INTERFACE → Header timestamp rules`): the order
rule against the stored parent, and the future bound against this node's clock, read through a seam a
test can set. **A future-bound refusal is an acceptance verdict, not a consensus one** — the block is
neither penalised nor marked in `refused_headers`, and the sync path re-delivers it inside the bound.
The schedule's parameters come from the profile through `Config` (→ Configuration); block 1's stamp,
`t_a`, is the stored `ordering_blocks.created_at` at height 1 — nothing new is stored, and a reorg
needs no undo entry, because a target is a function of headers a reverted chain no longer has. There
is **no wall-clock retargeting**: no node reads a clock to compute a target.

### Per-block like settlement

Runs at the end of **every** block's mutation phase, through the block's settlement
transaction. The quantities are **committed, not transported**: the markers ride the block as
outputs of its like transactions, so a producer/verifier disagreement is impossible — the
settlement reads what the block itself carries (compare the retired `EpochTallyResults`, which
had to be carried and compared).

**During embedded-tx application**, each like transaction (the `likeTarget` biconditional
shape, validated by the engine):

1. Re-checks at apply: target confirmed and **live** at this height (likes on pruned
   posts rejected by stated rule; a placeholder — body not held — **is** live, `isLivePost`
   decides); author resolved from **`block_topology`**, never
   `dag_posts.author`; like-record `(liker, targetPostId)` absent — else the tx is
   invalid and the block is rejected
2. Writes the like-record via `insertLikeRecord` (journalled side-record)
3. Applies the transaction's outputs like any other — the `LikeAccrualBox` marker among
   them — and counts the like per author for the end-of-phase steps, and, where the liker
   satisfies `member(liker)` on the liker's record as it stands at apply (→ Membership pass),
   per author for the member-like count as well

**At end of mutation phase, after all embedded txs** (order pinned: embedded txs →
the settlement transaction → the like counters → the membership pass → decay clocks):

4. **Author settlement — outputs of the settlement transaction.** For each author with
   likes this block, in ascending author-hex order, the settlement consumes their `n`
   markers — likes received and replies to their posts alike, in committed transaction order —
   and their carry box holding `r`, and emits:
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
   settlement, and only ever adds; `memberLikes` is bumped beside it by the member-like count,
   and only ever adds. All integer arithmetic; a float intermediate is a
   consensus fork.
**Determinism:** iteration orders are pinned (author hex, post id), and the settlement's
marker inputs follow committed transaction order — every order is one the block fixes.
All arithmetic `bigint`/integer — a float intermediate is a consensus fork.

**A like and a settlement of the same post SHARE a block.** A block may carry a like on post `P`
together with a prune covering `P` or a withdrawal of `P`. The prune and withdrawal phase runs
**after** the transaction loop, so the like arm finds `P` live, the like applies and counts, and
the phase then stumps or empties it. ⛔ **The two transactions come from two unrelated users and
each is independently valid**, so any rule rejecting the pair would make a block a producer
cannot assemble out of transactions it was handed. **The outcome does not depend on how the
producer orders them in the body** — the DAG effect is a phase, not a per-transaction step.

⚠ **A like on a post settled in an EARLIER block still rejects the block.** `isLivePost` is
false for a stump, a tombstone and a withdrawn post alike, and that rule is unchanged: it is
what stops a dropped like-record reopening duplicate likes (ARCHITECTURE → Likes).

**Blocks with no likes** run neither loop — no record writes, no like leg in the
settlement. An author's carry box sits unchanged (and in the `stateRoot`,
because every box is) until their next liked block.

---

## Store Interface

Storage backends implement this interface. SQLite is the backend.
Fresh schema — no migration.

### Database lifecycle

| Function | Signature | Description |
|----------|-----------|-------------|
| `initDb(path)` | `(string) => void` | Initialize backend, run migrations, enable WAL |
| `getDb()` | `() => Database` | Return better-sqlite3 handle, throw if not initialized |
| `closeDb()` | `() => void` | Graceful shutdown |

### Posts DAG

| Function | Signature |
|----------|-----------|
| `insertPost(postId, commit, content)` | `(PostId, PostCommit, string \| null) => void` — status = pending when admitted with its packet, the body present; `null` when block application inserts a placeholder from the commit; the id comes from the creating transaction |
| `setPostBody(postId, content)` | `(string, string) => boolean` — fills a placeholder's body after the caller verified it against the row's `content_hash` (`verifyPostBody`); `false` if no row or the body is already held (no-op) |
| `getPost(id)` | `(string) => StoredPost \| Stump \| PrunedTombstone \| null` — "Resolution order for a post id" |
| `getMissingBodies(limit)` | `(number) => { id, contentHash }[]` — rows with `content IS NULL`, newest first (`block_height` desc, `block_index` desc); the backfill list |
| `queryPostsPage({ author?, limit, after? })` | `({ author?: Uint8Array } & Page<PostKey>) => { rows: StoredPost[], next: PostKey \| null, pending: StoredPost[], pendingCount: number }` — `rows` one page of the live committed rows (placeholders included), newest first in committed order, strictly after `after`; `pending` the live pending rows, the author's when `author` is given, newest arrival first (`rowid` descending), cut to `limit`; `pendingCount` over all of them |
| `confirmPost(postId, blockHeight, blockIndex)` | `(string, number, number) => void` — height and committed position |
| `unconfirmPost(postId)` | `(string) => void` — for fork rollbacks; clears height and position, keeps the body |
| `deletePendingPost(postId)` | `(string) => void` — the pending row of a post transaction that left the pool unconfirmed (Post transactions → the pending-row rule) |
| `deletePostRows(ids)` | `(string[]) => DeletedPostRow[]` — prune settlement: deletes the `dag_posts` and `dag_parent_refs` rows for the given ids and returns every deleted row for the journal; ids with no row are skipped |
| `restorePostRows(rows)` | `(DeletedPostRow[]) => void` — the inverse, from the journal |
| `getPrunedTombstone(id)` | `(string) => PrunedTombstone \| null` — step 3 of the resolution order: the `block_topology` row's prune marks, one read; `null` for an unmarked row |
| `getParentRefs(postId)` | `(string) => PostId[]` |
| `getAncestorsNearest(postId, limit)` | `(string, number) => { rows: StoredPost[], count: number }` — the nearest `limit` ancestors, oldest first, walking the parent chain upward from the post; `count` is the chain's whole depth. **The chain ends at the first ancestor with no `dag_posts` row** — a stump — so `count` never exceeds what `rows` can carry; one recursive CTE over `dag_parent_refs`, one lookup per level |
| `getSubtreePage(postId, page)` | `(string, Page<PostKey>) => { rows: StoredPost[], next: PostKey \| null, count: number, pending: StoredPost[], pendingCount: number }` — `rows` one page of the subtree's committed rows (the recursive CTE, stated once) in committed order, `(block_height, block_index)` ascending, strictly after `after`; `count` over the whole subtree, pending included; `pending` the subtree's pending rows, newest arrival first, cut to `limit`; `pendingCount` over all of them. The CTE enumerates the subtree — O(subtree) on the `dag_parent_refs (parent_id)` index — and the page is `limit + 1` rows of that enumeration: the one page read whose cost is the set's, not the page's |

> **`StoredPost` is the DAG `Post` with `content: string | null`, `contentHash`, and a required
> `status: PostStatus`** (`'pending' | 'confirmed'` — a pruned post has no row), exported from
> `store/posts.ts` and re-exported from `store/index.ts`. It exists because **`status` is
> node-local state and must not enter `Post`** — `Post` is the DAG type, `PostCommit` the
> consensus type that travels on the wire.
>
> ⚠ **The field is required, not optional, and that is the whole mechanism.** While `postToJson`
> declared `Post & { status?: string }`, a bare `Post` type-checked and `?? 'unknown'` read as a
> verdict rather than an absence — every response served `"unknown"` and nothing complained. A
> required field makes a caller with no status fail to compile instead.

> **`Page<K>` is `{ limit: number, after?: K }`**, already clamped and parsed by the route (HTTP
> API → "Every list a view returns is a page"); `K` is the list's key — `PostKey = { blockHeight,
> blockIndex }` for the post lists, `BoxKey = { value: bigint, id: string }` for karma and credit
> boxes, the box id for bonds and vouches. A page read returns `{ rows, next, count }` — `rows` the
> first `limit` rows of the list's total order strictly after `after`, `next` the last row's key iff
> a row follows it (the statement runs `LIMIT limit + 1`), `count` over the whole set — and its
> predicate is the whole-set read's, stated once as a fragment the `SUM`, the `COUNT` and the page
> share: a second `WHERE` naming the same set is the mirror class the `getKarmaValue` row names.
>
> **A page read touches `limit + 1` entries of one index that serves both its predicate and its
> order.** The post lists range on a row-value comparison — `(block_height, block_index) < (?, ?)`
> on the feed, `>` on a subtree — over `dag_posts (block_height, block_index) WHERE status =
> 'confirmed'`, the author-filtered feed over its `author`-led twin; the karma and credit pages
> mix directions (`value DESC, id`), so with `after` they are two ranges of
> `utxo_boxes (owner, box_type, value DESC, id) WHERE spent_at_block IS NULL` — the equal-value
> tail and the lesser values — concatenated in list order, **at most `2 · (limit + 1)` entries**;
> the bond and vouch pages range by `id` on the partial expression indexes keyed by the bond's
> `inviterId` and the vouch's `targetId` (`json_extract(extra_data, …)`). The `SUM` and `COUNT`
> behind a view are scans of the owner's entries in the owner index. `getSubtreePage` is the
> stated exception: its CTE enumerates the subtree on `dag_parent_refs (parent_id)`. Nothing else
> in the repo measures cost (`ARCHITECTURE → Design Principles`), so one test per read pins its
> plan to its index and its range.

**`dag_posts` columns:** `id`, `content_hash` (hex, NOT NULL), `content` (**nullable** — `NULL` is
the placeholder), `author`, `parent_refs`, `protocol_version`, `type`, `status`, `block_height`,
`block_index`. There is no `raw_cbor`: a body is stored only after `verifyPostBody` accepted it
against `content_hash`, so the column is the authority and nothing re-verifies it. There is no
`getPostRaw` and no `pruneSubtree`: a body is read through `getPost`, a prune deletes through
`deletePostRows`.

**Backfill after sync.** A placeholder's body is pulled by id (NET_INTERFACE → Sync State
Machine, `requestPostBodies`): in the `backfill` phase net drives it from `getMissingBodies`;
once `synced`, the node drives it from its block-applied hook for every placeholder it creates
— the block's relaying peer first, then other connected peers — on a per-id schedule **in
block height: the first request at creation, retries after 1, 2, 4, … blocks, capped at 256**,
so an unserved body costs a bounded trickle and never a loop. A received body is verified and
stored through `setPostBody`; `emitPostReceived(postId, peerId, via: 'pull')`.

### Like-records

**Table:** `like_records (target_post_id TEXT NOT NULL, liker_id BLOB NOT NULL,
applied_at_block INTEGER NOT NULL, PRIMARY KEY (target_post_id, liker_id))`. Written
**only** at block application (never by an HTTP route — the retired free-like tier's
`dag_likes` rows were route-written, which is what made the old epoch mint a DAG-index
read inside consensus). Content-layer consensus state, the `block_topology` tier:
deterministic by replay, journalled with exact inverses, not in the `stateRoot`. The
`dag_likes` table is **dropped**.

**The topology's parent edges are a table of their own.** `block_topology_parents
(parent_id, post_id, PRIMARY KEY (parent_id, post_id))` holds one row per entry of a
topology row's `parent_refs`, written by `insertBlockTopology` with the row and deleted by
`rollbackBlockTopology` with it — the column stays the record, the table is its index. The
subtree walk (`getSubtreeTopology`, → Prune transactions) recurses on `parent_id = ?`, one
index lookup per row of the set, so a prune's derived set costs the set and not the table.

| Function | Signature |
|----------|-----------|
| `insertLikeRecord(targetPostId, likerId, blockHeight)` | `(PostId, UserId, number) => void` — **block application only**; records a `likeRecordInsertions` journal side-record; throws on the primary key — the structural dedup |
| `hasLikeRecord(targetPostId, likerId)` | `(PostId, UserId) => boolean` |
| `getLikeRecordCount(postId)` | `(PostId) => number` — lifetime likes on a live post; feeds API `likeCount` |
| `deleteLikeRecordsForPosts(postIds)` | `(PostId[]) => void` — **prune settlement only**; captures every deleted row as a `likeRecordDeletions` journal side-record before deleting |
| `deleteLikeRecord(targetPostId, likerId)` | `(PostId, UserId) => void` — fork-rollback inverse (never records) |
| `restoreLikeRecord(targetPostId, likerId, appliedAtBlock)` | `(PostId, UserId, number) => void` — fork-rollback inverse (never records) |

### UTXO

| Function | Signature |
|----------|-----------|
| `getBox(boxId)` | `(string) => AnyBox \| null` |
| `getUnspentBoxes()` | `() => AnyBox[]` — all unspent boxes (for AVL bootstrapping), `ORDER BY created_at_block` with ties in no stated order; `bootstrapAvlProver` sorts them canonically, so no reader depends on the tie order |
| `getKarmaBox(owner)` | `(Uint8Array) => KarmaBox \| null` — single box (backward compat) |
| `getKarmaBoxes(owner)` | `(Uint8Array) => KarmaBox[]` — multi-box listing: full boxes, keyed on `id` |
| `getKarmaBoxesPage(owner, page)` | `(Uint8Array, Page<BoxKey>) => { rows: KarmaBox[], next: BoxKey \| null, count: number }` — the view's page of the set `getKarmaBoxes` reads, `ORDER BY value DESC, id` strictly after `after` (two index ranges — `value = ? AND id > ?`, then `value < ?` — concatenated in that order), over the same `KARMA_UNSPENT_WHERE` fragment; never a consensus input — every balance check reads the whole set through `getKarmaBoxes` / `getKarmaValue` |
| `getKarmaValue(owner)` | `(Uint8Array) => bigint` — **summed** value of every unspent karma box. **Consensus input** (the vouch minimum-balance gate), and the single implementation every validation path shares. It must sum, never read one box: `getKarmaBox` is `LIMIT 1` with no `ORDER BY`, so a single-box read makes the verdict a function of SQLite's physical row order — M-12's class. Kept as one store function rather than a closure per deps literal, because a consensus-critical read reproduced at each call site is the mirror pattern that produced `computeTxIdLocal` and the copied `u32BE`. The predicate is the `KARMA_UNSPENT_WHERE` fragment that `getKarmaTotal`, the `COUNT` and the page share — the set is named once; the sum is computed here, in process |
| `getKarmaTotal(owner)` | `(Uint8Array) => bigint` — the view's total: `COALESCE(SUM(value), 0)` over `KARMA_UNSPENT_WHERE`, an index scan of the owner's unspent entries; `/karma/:userId`'s `total`. Never a consensus input, and equal to `getKarmaValue` on every owner (a test pins it) |
| `getCreditBoxes(owner)` | `(Uint8Array) => CreditBox[]` — multi-box, `ORDER BY value DESC, id` — a total order, so element `[0]` is a deterministic read; there is deliberately **no single-box credit accessor** (an unordered `LIMIT 1` names an arbitrary row — M-12's class) |
| `getCreditBoxesPage(owner, page)` | `(Uint8Array, Page<BoxKey>) => { rows: CreditBox[], next: BoxKey \| null, count: number }` — the view's page of the set `getCreditBoxes` reads, the same order and clause, over the `CREDIT_UNSPENT_WHERE` fragment |
| `getCreditValue(owner)` | `(Uint8Array) => bigint` — summed value of every unspent credit box: `COALESCE(SUM(value), 0)` over `CREDIT_UNSPENT_WHERE`, the fragment `getCreditBoxes` and the page share; a view read (`/credits/:userId`'s `total`), not a consensus input |
| `getBondFor(inviteePublicKey)` | `(UserId) => BondBox \| null` — the bond naming this key; the settlement path resolves through this |
| `getBondsInvitedAt(maxInvitedAt, limit)` | `(number, number) => BondBox[]` — bonds whose invitee's record carries `invitedAtBlock` **at or before** `maxInvitedAt`, **ascending `(invitedAtBlock, box id)`**, capped at `limit` — the settlement's carry-forward bond leg. The caller subtracts `INVITE_PROBATION_BLOCKS` from the settle height, so the store stays free of network parameters. ⛔ **The query MUST require `invitedAtBlock > 0`**: `0` is every never-invited identity, so at the single height where `settleHeight == INVITE_PROBATION_BLOCKS` the argument is `0` and an unguarded match sweeps the whole table |
| `getBondBoxesPage(inviterId, page)` | `(UserId, Page<string>) => { rows: BondBox[], next: string \| null, count: number }` — the inviter's **unspent** bonds (`spent_at_block IS NULL`), ascending `id` strictly after `after` (`id > ?`); `count` over the whole set |
| `getVouchesForTargetPage(targetId, page)` | `(UserId, Page<string>) => { rows: VouchBox[], next: string \| null, count: number }` — the identity's unspent vouch boxes (`store/vouch-queries.ts`), ascending `id` strictly after `after`, the rows selected in the page statement; `count` over the whole set |
| `insertBox(box)` | `(AnyBox) => void` — writes the provenance columns; records `{kind:'box', op:'insert', boxId, box}` while a block journal is open |
| `consumeBox(boxId, consumedAtBlock)` | `(string, number) => void` — mark a **live** box spent; records `{kind:'box', op:'remove', boxId}` while a block journal is open. ⛔ **Throws `BoxNotLiveError` when no live row matched.** The `UPDATE` carries `AND spent_at_block IS NULL` and checks the row count, so the journal entry follows a real spend instead of a caller's assumption. ⚠ **Not a `CorruptChainStateError`** — a caller naming a box the store does not hold live is a rejection, not a reason to stop the node |
| `unconsumeBox(boxId)` | `(string) => void` — un-mark spent (fork-rollback inverse; never records) |
| `deleteBox(boxId)` | `(string) => void` — (fork-rollback inverse; never records) |

(P2-D deleted the like-box readers — `getLockedLikeBoxes`, `getUnspentLikeBoxes`,
`getUnprocessedLockedLikeBoxes`, `getPostTotalLikes` — and `markLikeBoxesTallied`, the
epoch's sentinel-spend choke point. Like counts come from `getLikeRecordCount`.)

#### Box provenance columns

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

The **column** is a denormalisation of the box's own `createdAtBlock`, written at
insert from the field the creator declared and signed (§Populating the record).
It is honest because the field it copies is committed — not because the store
observed anything.

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
probation and the decay clock both from the identity record below, and a creation
height from the **box field** (`TYPES_INTERFACE` → "createdAtBlock is a box field,
and it is CREATOR-DECLARED"), which the `stateRoot` commits and this column only
mirrors.

### Identity Records

The second committed entity alongside boxes: the per-identity decay clock. It may
read neither height that meets `insertBox` — a box's `createdAtBlock` is
creator-declared, so a backdated box would backdate its owner's clock, and the
`created_at_block` column is uncommitted. So the clock lives in committed state.

```
IdentityRecord {
  lastActivityBlock: number     // u32 — starts at the claim height that creates the record; advanced when block application applies a user transaction spending the owner's karma
  lastDecayBlock: number        // u32 — bumped when decay fires
  invitedAtBlock: number        // u32 — height the invite grant applied; 0 = never invited
  lifetimeLikesReceived: bigint // likes this identity has ever received; never decremented
  memberSinceBlock: number      // u32 — 0 = never a member; else the height the bar was first met — the AGE, never reset; a root's is the genesis mint height
  memberBar: number             // u32 — D(N) at first set, never reset; 0 on a root
  memberVouches: number         // u32 — live counted vouches naming this identity
  memberLikes: bigint           // likes received from members; never decremented
  invitesUsed: number           // u32 — bonds this identity has created; never decremented
}
member(m) ⟺ memberSinceBlock > 0 ∧ memberVouches ≥ memberBar        — derived, stored nowhere
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

**Five fields hold standing** (`ARCHITECTURE → Membership`): `memberSinceBlock` is the age — `0`
never a member, else the height the bar was first met, written once and never reset;
`memberBar` is `D(N)` at that moment, `0` on a root; `memberVouches` counts the live counted
vouches naming the identity; `memberLikes` counts likes received from members; `invitesUsed`
counts the bonds the identity has created. `member(m)` is evaluated from them and stored nowhere.

⛔ **Seven fields on this record can be silently destroyed by a careless writer.**
The record is a full-row upsert and the type forces every field *present*, so a
writer passing `0` compiles and passes typecheck while erasing a probation clock,
a like history or a membership. **Every writer other than the one that owns a field carries the
stored value through unchanged** — `invitedAtBlock` and `lastActivityBlock`'s
**epoch** are owned by the grant path (the grant write initializes the activity
clock to the grant height; advancement is block application's — §Populating the record),
`lifetimeLikesReceived` by the lifetime-counter bookkeeping, `memberSinceBlock` and `memberBar`
by the membership pass — once, at first set, never again — `memberVouches` by the vouch counter's
one function (cast `+1`, consumption `−1`, each iff counted — → Vouch transition rules),
`memberLikes` by the like counters beside `lifetimeLikesReceived`, `invitesUsed` by the
invite-create apply.

**AVL key** — `blake2b512( IDENTITY_KEY_DOMAIN ‖ identityId )[0:32]`, **never
the raw `identityId`.** Records and boxes share one 32-byte AVL keyspace, and
an `identityId` is 32 *attacker-chosen* bytes (a public key): used raw, someone
could grind a keypair whose pubkey equals a live box id and collide the two
entity kinds in the tree. Hashing under a domain tag makes that infeasible and
is what makes the two kinds provably disjoint.

**Table:** `identity_records (identity_id BLOB PRIMARY KEY, last_activity_block
INTEGER NOT NULL, last_decay_block INTEGER NOT NULL, invited_at_block INTEGER
NOT NULL DEFAULT 0, lifetime_likes_received INTEGER NOT NULL DEFAULT 0,
member_since_block INTEGER NOT NULL DEFAULT 0, member_bar INTEGER NOT NULL DEFAULT 0,
member_vouches INTEGER NOT NULL DEFAULT 0, member_likes INTEGER NOT NULL DEFAULT 0,
invites_used INTEGER NOT NULL DEFAULT 0)`. The
SQL table keys on the raw 32 bytes; the AVL key is derived. Both are total
functions of the identity, so the two representations cannot drift.

#### Layout — IdentityRecord

> **It lives here rather than in `TYPES_INTERFACE` because `IdentityRecord` is a `node` type
> and `state/serialize-box.ts` is its only encoder** — but it uses the same writer vocabulary,
> and `TYPES_INTERFACE` → Layout — Boxes governs the box arm of the same tree.

| # | Field | Encoding |
|---|---|---|
| 1 | tag | `u8` — **`0x80`**, the record discriminator (see "Three entity kinds") |
| 2 | `lastActivityBlock` | `vlqU` |
| 3 | `lastDecayBlock` | `vlqU` |
| 4 | `invitedAtBlock` | `vlqU` |
| 5 | `lifetimeLikesReceived` | `vlqU64` |
| 6 | `memberSinceBlock` | `vlqU` |
| 7 | `memberBar` | `vlqU` |
| 8 | `memberVouches` | `vlqU` |
| 9 | `memberLikes` | `vlqU64` |
| 10 | `invitesUsed` | `vlqU` |

**The tag is part of the layout, not a wrapper around it** — the box arm works the same way, where
`enum8(boxType)` is field 1 of `boxContentBytes` rather than a prefix bolted on outside it. One
encoder, one byte string, no composition step where a caller could disagree about ordering.

**Domains, and where they are established.** `lastActivityBlock`, `lastDecayBlock`,
`invitedAtBlock` and `memberSinceBlock` are `u32` block heights, `memberBar`, `memberVouches` and
`invitesUsed` are `u32` counts; `vlqU` is total *by sentinel*, so an out-of-domain value cannot
panic the encoder — it **collides**, exactly as `createdAt` did in the header before 1f.
`lifetimeLikesReceived` and `memberLikes` are `vlqU64` and `writeVlqU64OrThrow` **throws**
outside `[0, 2⁶⁴)`; the domain belongs upstream of the encoder — the like counters are their only
writers, they are unbounded by design and bounded only by the writer's `2⁶⁴`. One like per block for the life of the chain does not
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
positional layout has no keys and no map header, so neither is expressible. **Every field from
`invitedAtBlock` on must still always be written, zero included** — not because absence would
fork the bytes any more, but because the fields are part of the record and a layout writes every
field. Likewise `bigint` stays the type of `lifetimeLikesReceived` and `memberLikes`: under
`vlqU64` a `number` and a
`bigint` of equal value encode identically, so the type no longer guards the *bytes* — it guards
the `safeIntegers` row boundary against a silent `Number()` coercion, which is a different and
still-live reason.

| Function | Signature |
|----------|-----------|
| `getIdentityRecord(identityId)` | `(UserId) => IdentityRecord \| null` |
| `putIdentityRecord(identityId, record)` | `(UserId, IdentityRecord) => void` — upsert; while a block journal is open, captures the row it replaces and records `{kind:'record', key, record, replaced?}` |
| `deleteIdentityRecord(identityId)` | `(UserId) => void` — fork-rollback inverse only; never records |

**Lifecycle:** created on first karma receipt, on the first like received (the
lifetime-counter write), or at genesis seeding for a root; **never deleted** in normal
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

- **`lastActivityBlock`** — advanced by **block application**, to the block's
  height, when a user transaction whose inputs are karma boxes applies: the
  inputs share one owner (→ Karma transition rules), and that owner's record is
  written through `putIdentityRecord` after the transaction's box writes, so
  reverse replay restores it before the boxes it followed. **Whether or not the
  transaction leaves a karma output** — an exact spend is activity. The
  settlement's consumption of karma boxes (the decay leg) and every settlement
  output — grants, payouts, vests, returns, refunds, decay re-emits — leave it
  untouched: they apply outside the user-transaction loop. Unvouch and credit
  transactions spend no karma and advance nothing.
- **`lastDecayBlock`** — bumped when decay fires for that owner.
- **`invitedAtBlock`** — written only by block application when an invite grant
  applies (the settlement's grant leg); every other writer carries it through.
- **`lifetimeLikesReceived`** — bumped only by the lifetime-counter bookkeeping
  after the settlement, for every author who received likes in the block; only
  ever adds.
- **`memberSinceBlock`, `memberBar`** — written by the membership pass at first set, once, and
  never again (→ Membership pass); a root's at genesis seeding.
- **`memberVouches`** — the vouch counter's one function: `+1` at a counted cast's apply, `−1` at
  a counted vouch box's consumption, by the unvouch or the settlement's lapse leg (→ Vouch
  transition rules).
- **`memberLikes`** — bumped beside `lifetimeLikesReceived` by the like counters, by the likes
  whose liker was a member at apply; only ever adds.
- **`invitesUsed`** — `+1` at the invite-create arm's apply; only ever adds.

**Two heights meet at `insertBox`, and they answer different questions.**

⛔ **The `created_at_block` COLUMN takes the box's own `createdAtBlock`** — the height its creator
declared and signed, which `canonicalBoxBytes` encodes and the box id covers. The column is a
denormalisation of a committed field, not an independent observation.

⛔ **The ACTIVITY CLOCK takes the open journal's height** — `beginBlockJournal(height)`, the height
this block is settling at. It must not read any box's `createdAtBlock`: the clock records *when the chain saw activity*,
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
runs at startup and outside block application, so nothing writes the system
identity's record. It
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
> ⚠ **The function is retained, not deleted.** `bootstrapAvlProver` lives in
> `node/src/state/avl-prover.ts` with exactly one production caller, `seedGenesisState`, which feeds
> the fixed genesis set — boxes and identity records, via `getAllIdentityRecords` — into the EMPTY
> tree: the one full-set feed with no history to lose (AVL+ State Root → "AVL+ tree shape is
> history-dependent"). `src/index.ts` has no rebuild-from-UTXO-set path. This marker read "is being
> removed" — a *decision*, stated in the future tense, which then never got a follow-up.
> **Superseded describes the requirement; it does not describe the tree.**
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

### Network record

The third committed entity: one record holding the member count `N` (`ARCHITECTURE →
Membership`), which feeds `D(N)` and therefore validity, so it must be committed and O(1) to read.

```
NetworkRecord {
  memberCount: number           // u32 — the number of identities for which member(m) holds
}
```

**AVL key** — `blake2b512( NETWORK_KEY_DOMAIN )[0:32]`: the domain tag alone is the preimage, the
identity key's hashing rule with nothing after the tag, so the three kinds are disjoint by domain
separation (TYPES_INTERFACE → Domain tags). **Value** — `u8` **`0x81`** ‖ `vlqU(memberCount)`:
the high bit says "not a box", as `0x80` does (→ Three entity kinds), and the layout is positional
like the record's (→ Layout — IdentityRecord). `deserializeBox` refuses the tag as it refuses
`0x80`; the kind-dispatching decoder gains an arm; the proof endpoint serves it as
`kind: 'network'`.

**Written** by the membership pass alone, once per block that changes `N`, through
`putNetworkRecord` — journalled on `putIdentityRecord`'s pattern (→ Block Journal): the value it
replaces is captured, the put recorded, rollback exact. **Seeded** at genesis with the root count,
inside the seeding transaction, and fed to the empty tree with the boxes and the identity records
(→ The genesis state root is checked fail-stop); every `genesisStateRoot` covers it.

**Table:** `network_record (id INTEGER PRIMARY KEY CHECK (id = 1), member_count INTEGER NOT
NULL)` — one row, present from seeding on.

| Function | Signature |
|----------|-----------|
| `getNetworkRecord()` | `() => NetworkRecord` — the one row; throws where none exists, which is a store that was never seeded |
| `putNetworkRecord(record)` | `(NetworkRecord) => void` — while a block journal is open, captures the row it replaces and records `{kind:'network', memberCount, replaced}` |

*Alternative considered:* a `memberCount` field on the karma pool box. Rejected — the pool box
is "no owner, no trailing fields" by contract and a population count is not a value.

### Vouch escrows

**There is no vouch-cooldown store machinery.** An unvouched stake waits in a
`VouchEscrowBox` — an ordinary box in the UTXO set and therefore in the
`stateRoot` — created as the unvouch transaction's output and consumed by the
settlement of the first block at or past `releaseAtBlock` (§The settlement
transaction). The escrow's create and spend are journalled by `insertBox` /
`consumeBox` like any other box; no bespoke side-records exist.

| Function | Signature |
|----------|-----------|
| `hasActiveVouchEscrow(voucherId)` | `(UserId) => boolean` — true while any unspent `vouch_escrow` box names the voucher as `owner`. **Consensus input**: the cast gate (§Vouch transition rules) |
| `getVouchEscrowsFor(voucherId)` | `(UserId) => VouchEscrowBox[]` — the API's cooldown listing (`GET /vouches?voucher=X&cooldowns=1`) |
| `getVouchEscrowsReleasableAt(height, limit)` | `(number, number) => VouchEscrowBox[]` — every unspent `vouch_escrow` with `releaseAtBlock <= height`, **ascending `(releaseAtBlock, box id)`**, capped at `limit`. **Consensus input**: the settlement's escrow leg; read from pre-body state on both sides (§The settlement transaction), never at the check |
| `getLapsedVouches(limit)` | `(number) => VouchBox[]` — the unspent `vouch` boxes whose `voucherId`'s identity record fails `member(voucher)`, **ascending box id**, at most `limit`. **Consensus input**: the settlement's lapse leg; read from pre-body state on both sides (§The settlement transaction), never at the check |

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
| `getPendingEntries(limit)` | `(number) => PoolEntry[]` | FIFO-ordered pending entries |
| `purgeExpired(currentHeight)` | `(number) => number` | Remove entries past expiry, returns count |
| `hasPendingLike(targetPostId, likerId)` | `(string, string) => boolean` | SQL EXISTS over gate metadata — unbounded (M-8) |
| `countPendingInvites(inviterId)` | `(string) => number` | SQL COUNT over gate metadata — unbounded (M-8) |
| `hasPendingVouch(voucherId, targetId)` | `(string, string) => boolean` | SQL EXISTS over gate metadata — the pending mirror of one live vouch per `(voucher, target)` pair (§Vouches) |
| `removeEntry(rowid)` | `(number) => void` | Remove confirmed entry by rowid |
| `setMempoolCap(n)` | `(number) => void` | Set the pool bound; `index.ts` calls it once at startup with `config.maxMempoolEntries` (`MEMPOOL_INTERFACE → setMempoolCap`) |

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
  entryType: "utxo_tx"
  utxoTxBytes: Uint8Array | null
  expiresAtHeight: number
  createdAt: string
}
```

See `MEMPOOL_INTERFACE.md` for the full mempool contract.

### Ordering blocks

| Function | Signature |
|----------|-----------|
| `createOrderingBlock(block, interlinks)` | `(OrderingBlock, string[]) => void` — `interlinks` is the vector the header committed to, stored `encodeInterlinks`'d in the `interlinks` column |
| `getOrderingBlock(height)` | `(number) => OrderingBlock \| null` |
| `getCurrentHeight()` | `() => number` |
| `getOrderingBlockHash(height)` | `(number) => string \| null` — the stored `block_hash` column, no row decode |
| `getHeightByBlockHash(hash)` | `(string) => number \| null` — indexed point lookup on the same column |
| `getInterlinks(height)` | `(number) => string[] \| null` — the stored vector, decoded; `null` for no row |
| `getHeadersAbove(height, n)` | `(number, number) => BlockHeader[]` — `WHERE height > ? ORDER BY height ASC LIMIT n`, `header_bytes` decoded and nothing else; **the caller bounds `n`** — fork choice passes `ourTip − f ≤ maxReorgDepth` (Fork choice decides on verified headers, step 4). Not the NiPoPoW reader: `getHeadersAfter` is capped at `MAX_NIPOPOW_PARAM` for the prover and answers at most 128 rows, which a work comparison over a horizon must never read through |
| `deleteOrderingBlock(height)` | `(number) => void` — for fork rollback |

**Who reads the `block_hash` column, and who deliberately does not.**
`getOrderingBlockHash` is the read behind net's providers, serving
(`GET /blocks/current`) and the gossip dedup in `handleOrderingBlock` — each
wants the insert-time hash and none needs the row decoded. The apply path's
chain-link check and the block creator's previous-block hash **recompute from
the decoded header instead, and must keep doing so**: the recompute is the
corrupt-header tripwire (`UnhashableStoredHeaderError` — a column read returns
the insert-time hash over a header row that has since rotted), and
`verifyBlockChainLink` recomputes internally in any case.

**The `interlinks` column is a cache of the header chain, never journaled.** `I(h)` is a function of
the headers below `h` (`TYPES_INTERFACE` → Interlink vector), so the column can always be rebuilt from
`header_bytes`. It is written by `createOrderingBlock` with the vector the funnel verified, read by the
funnel for the next block's check, by the block creator for the template, and by fork resolution for
the anchor; `deleteOrderingBlock` drops it with the row, so a reorg needs no undo entry for it.
Declared in the base `CREATE TABLE`, not the ALTER pass — no store predates it.

### Refused headers

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
| `purgeRefusedHeaders(belowHeight)` | `(number) => void` — called beside `purgeOldJournals`, same bound: `height − maxReorgDepth` |

**One row suffices for a whole continuation.** A segment starts at a fork point *on our chain* and
the refused block is not on our chain, so if the refused block is an ancestor of a segment's tip it
sits inside that segment at its own height — `anyRefusedHeader` over the verified hashes is complete
for continuations without storing descendants. **The purge is safe for the same reason:** a refused
height below `tip − maxReorgDepth` cannot appear in any segment the fork walk can anchor.

**The mark is written outside the reorg transaction**, after it has rolled back — a write inside it
would roll back with it. It persists across restarts and is removed only by the purge; a deploy's
database wipe removes it with everything else.

### Nipopow reader

The four reads `@dagsocial/nipopow`'s `PopowHeaderReader` is implemented over
(`NIPOPOW_INTERFACE` → proveWithReader), all on the canonical chain — a proof is a function of it,
and no header tree is involved:

| Function | Signature |
|----------|-----------|
| `getPopowHeaderByHash(hash)` | `(string) => PoPowHeader \| null` — the `block_hash` point lookup, then the row's `header_bytes` and `interlinks` decoded |
| `getPopowHeaderAtHeight(height)` | `(number) => PoPowHeader \| null` — the same row by height |
| `getLastHeaders(n)` | `(number) => BlockHeader[]` — `ORDER BY height DESC LIMIT n`, returned ascending; `n ≤ MAX_NIPOPOW_PARAM` |
| `getHeadersAfter(height, n)` | `(number, number) => BlockHeader[]` — `WHERE height > ? ORDER BY height ASC LIMIT n`; `n ≤ MAX_NIPOPOW_PARAM` |

Every list read carries its `LIMIT`, and the limit is the caller's bounded `k`. Each read decodes
through the guarded read the sync serve uses: a stored row that will not decode is local corruption
and fail-stops (`failStopIfCorruptChain`), never a refusal the requester is blamed for.

### Block Journal

The journal is the single source of truth for undoing a block and for feeding
the AVL prover (ARCHITECTURE → "Block application journal"). One CBOR-encoded
row per applied block, purged below `height − maxReorgDepth` (the profile's reorg horizon —
TYPES_INTERFACE → Chain reorganisation).

**Types are node-owned** (`src/store/journal.ts`); `@dagsocial/types` exports
no journal types.

```
BoxMutation {
  kind: 'box'
  op: 'insert' | 'remove'
  boxId: string                    // hex
  box?: AnyBox                     // full box — present iff op === 'insert'
}

RecordMutation {                   // identity records
  kind: 'record'
  key: string                      // hex — H(IDENTITY_KEY_DOMAIN ‖ identityId), the AVL key
  identityId: UserId               // the raw 32 bytes, so rollback can address the SQL row
  record: IdentityRecord           // the value written
  replaced?: IdentityRecord        // prior value — absent iff the key did not exist
}

NetworkMutation {                  // the network record — the member count
  kind: 'network'
  memberCount: number              // the value written
  replaced: NetworkRecord          // the prior value — always present: the record exists from seeding on
}

JournalMutation = BoxMutation | RecordMutation | NetworkMutation

BlockJournal {
  blockHeight: number
  mutations: JournalMutation[]     // ordered, application order — state rollback + AVL feed
  confirmedPostIds: string[]       // inverse: unconfirmPost — not a mempool key
  appliedUtxoTxs: Array<{ txId: string, txBytes: Uint8Array }>  // mempool re-insertion only
  likeRecordInsertions: Array<{ targetPostId: string, likerId: UserId }>
                                   // inverse: deleteLikeRecord
  likeRecordDeletions: Array<{ targetPostId: string, likerId: UserId,
    appliedAtBlock: number }>      // inverse: restoreLikeRecord — a reverted prune
                                   // restores the subtree's like-records exactly
  deletedPosts: DeletedPostRow[]   // prune settlement's deleted dag_posts rows, bodies and
                                   // parent refs included — inverse: restorePostRows; the
                                   // only place a pruned body survives, and only until this
                                   // journal is purged (ARCHITECTURE → Subtree pruning)
  insertedStumps: Stump[]          // the prune phase's stump rows — inverse: deleteStump
  absorbedStumps: Stump[]          // the stumps an outer prune absorbed, exactly as they stood —
                                   // inverse: insertStump
  withdrawnPosts: Array<{ id: string, content: string | null }>
                                   // withdrawal's emptied dag_posts rows — inverse: restore the
                                   // content and clear withdrawn_at_height. ⛔ `content` is
                                   // `string | null` because a post may be withdrawn while it is
                                   // still a PLACEHOLDER, and the inverse of that is a row with
                                   // null content AND a clear marker. A withdrawal MUTATES a row
                                   // rather than deleting it, so `deletedPosts` cannot carry it
  prunedTopologyRows: Array<{ postId: string, prunedAtHeight: number | null,
    prunedRoot: string | null }>   // one entry per block_topology row §8c marked, carrying the
                                   // marks the row held BEFORE this block wrote it — null/null
                                   // for a first prune; the inner prune's height and root for a
                                   // row an outer prune re-marks. Inverse: restorePrunedTopology
                                   // writes them back exactly. The rows themselves survive a
                                   // prune; only the marks are this block's
}
```
The field names are the `journal_cbor` keys: the journal is the node's local format, with no
migration path — a store written under a different key set is a different store.


**One log, not parallel arrays.** `mutations` is a
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

The typed side-records below (`confirmedPostIds`, `likeRecord*`, …) stay
separate arrays because they are **not** in the `stateRoot` — they are node-local
bookkeeping with an exact inverse. `kind: 'record'` is the first entry that is
both journaled *and* committed, and that is the whole distinction.

**Recording (choke point).** `beginBlockJournal(height)` opens the journal at
the top of block application. While open, the store mutation primitives record
automatically: `insertBox` appends `{kind:'box', op:'insert', boxId, box}`;
`consumeBox` appends `{kind:'box', op:'remove', boxId}`; `putIdentityRecord`
appends `{kind:'record', …}`, capturing the row it replaces; `putNetworkRecord` appends
`{kind:'network', …}` the same way;
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

**Rollback (`revertBlock`).** Refuses to run while a block journal is open. A
journal absent for a height inside retention is `MissingJournalError` —
fail-stop, never a refused reorg ("What the funnel's totality catch is FOR").
Replays `mutations` in reverse order — `box`/`insert` → `deleteBox(boxId)`,
`box`/`remove` → `unconsumeBox(boxId)`, `record` → `putIdentityRecord` with
`replaced` when present, otherwise `deleteIdentityRecord`, `network` →
`putNetworkRecord(replaced)` — then the
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
decay replacements, fee-box consumption), like-record inserts and prune-time deletes (rows restored
exactly), prune settlement, user txs, **identity records** and the network record. Reorg
re-insertion reads `appliedUtxoTxs` (txBytes) alone — **a prune is one of those
transactions**, so it needs no second channel; `confirmedPostIds` is not a mempool key.

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
row derives from a prune transaction the funnel verified (see "Pruning" → "Stumps
are derived state"). Because the insert is unconditional at settlement and
every apply path goes through the one funnel, a settled prune without its
stump row cannot arise on a fresh chain; there is no repair or pull path.

**The insert is journalled** (Block Journal → `insertedStumps`), so `revertBlock` removes the
stump of a reorged-away prune with the rows it restores; the entry re-enters the mempool and
writes the stump again when it re-settles.

### AVL+ State Root

The `packages/node/src/state/` module provides an authenticated dictionary over
**committed state** using AVL+ trees — the UTXO set, identity records and
the network record (see "Three entity kinds" below).

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
- ⛔ **AVL+ tree shape is history-dependent.** A tree rebuilt by re-inserting a full state set
  forks against one grown incrementally to the same content, so AVL storage is never wiped
  independently of the chain and a startup rebuild is not a recovery path. `bootstrapAvlProver`
  has exactly one production caller, `seedGenesisState`, over the empty genesis tree — the one
  case with no history to lose
- ⛔ **AVL storage shares nodes across versions; a row is a node's lifetime.** A node's label is the
  hash of its content and its children's labels, so an unchanged subtree carries the same label in
  every version and is stored **once per lifetime**: `avl_tree_nodes` is
  `label, node_data, first_seen_height, orphaned_at_height NULL` with `(label, first_seen_height)`
  the primary key, and `avl_tree_versions` one row per applied block, the version being the digest
  (root label ‖ tree height). **`update` at height `h` first orphans the previous cycle's nodes the
  tree no longer holds** — the prover reports them (`removedNodes()`, valid inside `update` because
  `generateProofAndUpdateStorage` runs update before the proof; a reported label with no live row is
  tolerated) — setting `orphaned_at_height = h` on the label's live row; **then it walks the new tree
  from the root, stops at any label that has a live row (that subtree is shared), and writes every
  other node as a new lifetime** (`first_seen_height = h`). A live ancestor therefore has live
  descendants, and a subtree that recurs after its rows were orphaned gets fresh rows rather than a
  revived one. The cost is the changed paths, never the tree. **`rollback(version)` resolves the tree
  from the version's root label**, reading for each label the row alive at the version's height —
  `first_seen_height <= H` and `orphaned_at_height` NULL or `> H` — and a label with no such row is
  local corruption that fails closed. **`pruneVersionsBefore(cutoff)`** deletes the version rows below
  the cutoff and every row with `orphaned_at_height <= cutoff`: such a row was referenced by versions
  below its orphan height only, all of them gone. **`deleteVersionAtHeight(h)`** (a fork revert)
  deletes the rows with `first_seen_height = h` and clears `orphaned_at_height` where it equals `h`,
  so the version below reads exactly as it did. The store's steady size is the live tree plus the
  rows the retained versions replaced — proportional to changed paths per block times
  `MAX_PROOF_HISTORY`, not to the tree times the history.
  **A store carrying the per-version layout** (`avl_tree_nodes` keyed by `(version, label)`, every
  node copied into every version) **is converted in place at `initDb`, once**: one row per label
  keeps the node bytes unchanged, `first_seen_height` is the lowest height whose version holds the
  label and `orphaned_at_height` the height after the highest, NULL when the newest version holds
  it; the retained versions must be contiguous heights or the conversion refuses. A label absent
  from heights in between resolves the same, because resolution starts from each version's root. No
  node byte and no label changes, so every version's root is exactly what it was and nothing is
  rebuilt (→ "AVL+ tree shape is history-dependent").
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
  by hex key, then the network record's put — so every caller inherits the canonical order; callers MUST NOT
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

#### Three entity kinds

The tree holds **boxes** (key = `boxId`), **identity records**
(key = `H(IDENTITY_KEY_DOMAIN ‖ identityId)`; see Store Interface → Identity
Records) and **the network record** (key = `H(NETWORK_KEY_DOMAIN)`; see Store Interface →
Network record). Three things follow, and all three are consensus-critical.

**1. The value bytes must be self-describing.** The first byte is the
discriminator; `deserializeBox` MUST reject a non-box tag rather than mis-decode
it, and a kind-dispatching decoder is what any value-reading caller uses.

⚠ **The box discriminator is `enum8(boxType)` from `TYPES_INTERFACE` →
Layout — Boxes — NOT a second numbering owned by this package. Decided
2026-08-10.** The record tag stays `0x80`, high bit set, and the network record's `0x81` sits beside it, so
"box" versus "not a box" is still a single bit test and the box-type space stays open.

| | Discriminator space |
|---|---|
| Box | `enum8(boxType)` — the numbering `BOX_TYPE_TAGS` exports (`TYPES_INTERFACE` → Layout — Boxes) |
| Identity record | `0x80` |
| Network record | `0x81` |

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
`undefined` key.** `serializeBox` **is** `boxRecordBytes` — the content bytes
(`enum8(boxType)` first) with `txId` and `index` appended (TYPES_INTERFACE →
Layout — Boxes). The provenance stays in the value, and must, because "a box id
is a total function of the stored box" is only *checkable from a proof* if the
proof's value carries everything the derivation consumes. The AVL key already
commits to them; the redundancy is what lets a light client verify honesty
rather than trust it.

> ✅ **The exact-key-set hazard is retired by the positional layout.** The
> writer reads only the fields it declares — a present-but-`undefined` key is
> unrepresentable, and `writeOpt` gives an absent optional exactly one encoding
> (`serialize-box.ts` states this at `serializeBox`). The record of the
> cbor-era hazard it replaces: cbor-x distinguished an absent key from a
> present-but-`undefined` one — a key set to `undefined` encoded as `f7` *and*
> incremented the fixed two-byte map header (measured: `{value, guard}` →
> `b90002…`, the same object plus `txId: undefined, index: undefined` →
> `b90004…f7…f7`) — so a box reconstructed by `rowToBox` with explicit
> `undefined` provenance serialized to different bytes than the same box built
> by a producer without those keys, and a node that **restarted** and
> re-bootstrapped its prover from `getUnspentBoxes` would have computed a
> different `stateRoot` than one that stayed up: a restart-triggered consensus
> fork, from nothing but an object shape. Box **ids** were never exposed to the
> hazard — `canonicalBoxBytes` reads no `id`, `txId` or `index` at all.

**1b. Key ORDER is consensus-visible too — and was violated when found.** Found
by the phase B1 session, verified and extended by main; ✅ **resolved below**.
Neither encoder then canonicalised map key order: cbor-x emitted keys in JS
insertion order, so `{value, guard, owner}` and `{owner, value, guard}`
produced different bytes. This was **wider than 1a** — it reached
`canonicalBoxBytes`, and therefore box **ids**, not only the AVL value; key
order was the other half of what cbor-x framing's non-canonicality cost.

The implicit convention was that `rowToBox` mirrors each producer's field
order. It held for karma, credit, like, invite and bond — checked, including
the demo UI, which built client-side box types in `rowToBox`'s order. **It did
not hold for `post_lock`:**

| Source | Order after `serializeBox` stripped `id`/`boxType` (cbor-era) |
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
phase C3 session — 1b's hazard weaponised rather than accidental.

> ✅ **Retired by the positional layout, like 1b.** An output's key positions do
> not exist on the wire or in any preimage: `canonicalBoxBytes` writes the
> declared field table in its own order and reads no `id`/`txId`/`index`, so
> there is no position for an attacker's planted key to survive into. The
> record of the cbor-era hazard: outputs arrived as client-supplied CBOR maps,
> a client could plant `txId` and `index` keys *at arbitrary positions*
> **without changing the txId it signed** (the signature does not constrain
> what it does not cover), and a node that materialised the output by assigning
> provenance **in place** kept the attacker's positions where `rowToBox`
> appends them last — different key order, different AVL value bytes, a
> **restart-triggered `stateRoot` fork the attacker chose when to trigger**,
> for the cost of reordering two keys in a transaction they were sending
> anyway.

**`materializeOutput` remains the single materialisation rule for transaction
outputs** — strip `id`/`txId`/`index`, then append the real provenance — and
both the UTXO engine and the apply path go through it: the shape discipline
keeps every materialised box one object shape regardless of what a decoded
value carried, and one rule rather than two is one chance rather than two to
get it wrong.

**2. The proof endpoint must not throw on a record, and must say which kind it
served.** `GET /api/v1/proof/:boxId` decodes whatever value the key resolves to;
a record-shaped value would throw under a box-only decoder. Keys are
indistinguishable from outside — both kinds are 32 bytes of hash output — so a
client *can* ask for one. Landed in phase D, alongside populating the record.

The response carries **`kind: 'box' | 'record' | 'network' | null`**. This is required, not
cosmetic: the proof verifies the value bytes whichever kind they are, so without
an explicit discriminant a light client would verify a valid proof and then read
a record as a box with every field `undefined` — treating committed state as a
malformed box. That is strictly worse than the throw it replaced, because it
fails silently and *with* a valid proof. `null` distinguishes an absent key (a
valid exclusion proof) from "present, and not a box".

**The historical window restores under `finally`.** Serving `atHeight` rolls
the **shared** prover to a checkpoint (`rollback(version)`), performs the
lookup, generates the proof, and rolls back to the live digest — and the
restore is the part that must survive a throw: the prover is the one block
application uses, so an unrestored historical digest makes the node reject
every later block until restart. The lookup-and-proof window therefore runs in
a `try` whose `finally` restores the live version; the `catch`'s 500 is the
response, never the state.

*(The route parameter is still named `boxId` while addressing three entity kinds.
Renaming it is a public API change and deliberately not done here.)*

**3. Disjointness rests on provenance, not on height.** That box ids commit to
`createdAtBlock` does not establish it: two boxes built at one height with one
content would still collide. `avl-prover.ts` justifies the remove-group /
insert-group split from `(candidate, txId, index)`, and that argument is what
holds:

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
- *Boxes, records and the network record.* Disjoint by domain separation, not by luck — box
  ids, record keys and the network key are hashes under three domain tags. This is why the record
  key is hashed rather than the raw 32-byte pubkey, which an attacker chooses.

**Record ops use `InsertOrUpdate`**, the network record's among them. A record put is a create
on first write and an update afterwards, and the feed does not know which — `InsertOrUpdate`
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

### No store schema version, and none is owed

**A node does not version its own database and does not refuse to start against an old one.**
There is no `schema_version` key, no counter compiled into the binary, and nothing reads a
store's age to decide whether to run.

⚠ **`store/db.ts` does hold four functions named `migrate*`, and they are not what this section
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
| `verifier.ts` | Post verification (domains, parent refs, protocol, karma) | Network relay |
| `credits.ts` | Credit transfer validation and execution | UTXO engine internals |
| `invites.ts` | Invite lifecycle (create, commit, claim, cancel) | Bond box internals |
| `block-creator.ts` | Block creation, mining, template assembly | Post validation |
| `block-apply.ts` | Block application, UTXO settlement, per-block like settlement | Block creation |
| `utxo-engine.ts` | UTXO transaction validation and application | Block structure |
| `stump-engine.ts` | Verifiable prune execution | DAG content |
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
network, plus the system karma and faucet credit boxes on the faucet-bearing ones, the
committee's karma boxes, every root's identity record and the network record. **A mismatch
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
records, the network record, the tree rows and the flag together, so a divergent genesis is never
committed. Checked after the commit it would fail exactly once: the next start finds the flag set,
skips seeding, and runs on the divergent state with nothing left to check it.

**The root count is checked after the pin, and outside the seeding transaction.** Seeding writes
a root record per committee key and for the faucet identity where one is seeded, and the network
record with their count (`ARCHITECTURE → Membership`); the genesis root is derived over all of it
and compared to the pin as above. **Then**, on the boot path, a node whose network record holds
`memberCount = 0` refuses to serve, with the three-step exit below — a chain with no root can
never set a member. The order is what keeps mainnet's `genesisStateRoot` derivable and pinnable
while its committee is still empty: the pin test seeds and reads the root; only a running node
trips.

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

**Every rule that decides a reorg lives in `resolveFork`; `reorg` is the mechanism that carries
out a decision already made.** The decision, in order — each step that ends the resolution ends it
with the chain untouched:

1. **Counterparty.** The peer that relayed or served the block, if it is Active; else the head of
   the Active list (NET_INTERFACE → Pull Requests).
2. **The memo.** `net.peerTipHeight(peer)` equals the tip this peer's branch was last scored lighter
   at → return: nothing to re-score ("Re-scoring is memoised", below).
3. **The fork walk.** Their headers paged **down from our tip** — `requestHeaders(ourTip, 400)`, then
   from the lowest height seen − 1 — each compared to our `block_hash` at its height, a point read;
   the highest match is `f`. Heights examined: `ourTip … max(ourTip − maxReorgDepth + 1, 1)`. No
   match: `f = GENESIS_HEIGHT` when `ourTip ≤ maxReorgDepth` (the chains share only the genesis
   state), else `null` → no decision, no penalty: a fork past the horizon is indistinguishable from an
   honest peer. No headers at all → no decision, no penalty: "has nothing" is legitimate. An
   **unhashable** header in a page refuses the page whole and penalises `misbehavior` — `'domain'`,
   one step early — and never falls through to genesis.
4. **The anchor and our work.** Anchor = `{ prevBlockHash, height: f, interlinks, createdAt }`
   where `prevBlockHash` is the hash of our block at `f`, or `GENESIS_PREV_BLOCK_HASH` at `f = 0`;
   `interlinks` is the vector the block at `f + 1` must commit to — `updateInterlinks(getInterlinks(f),
   hash(f), level(our header at f, anchorBits))`, or `[]` at `f = 0`; `createdAt` is our block at `f`'s
   stamp, or `null` at `f = 0`. Beside the anchor: the profile's `RetargetParams`, block 1's stored
   stamp `t_a` (or `null` at `f = 0`, where the branch's own first header supplies it), and this
   node's clock. `ourWork = cumulativeWork(our headers f + 1 … ourTip)`, read once through
   `getHeadersAbove(f, ourTip − f)` (Store Interface → Ordering blocks) — a header-only read of at most
   `maxReorgDepth` rows, never the NiPoPoW reader's capped `getHeadersAfter`.
5. **The scoring walk.** Their branch above `f`, **upward in pages**: the fork walk's pages already
   hold `f + 1 … min(ourTip, theirTip)`; above that `requestHeaders(top + 400, 400)` trimmed to the
   heights not yet verified — the serve arm clamps to the peer's tip, so a page whose top sits below
   the request is their tip, and an empty trimmed page ends the branch. Each page, chronological, goes
   through `verifyHeaderChain(page, anchor, params, t_a, now, schedule)` (VALIDATION_INTERFACE →
   verifyHeaderChain) with the anchor the previous page's verdict returned (`next`). A refusal is
   classified: **`reason 'clock'` at any index is a future-bound refusal** — a verdict of this node's
   clock, not on the chain: no penalty, no mark, no memo, and the sync path re-delivers the branch
   inside the bound (`MINING_INTERFACE → Header timestamp rules`). **`reason 'version'` is a
   compatibility refusal** — a peer serving a chain of another era: refuse and penalise `transient`,
   no mark, no memo (NET_INTERFACE → Peer Penalty System). Every other `(index, reason)` —
   `'time'`, a hole (`'height'`), a header off its own chain (`'link'`) included — is a served chain
   that is not one: refuse and penalise (NET_INTERFACE → Peer Penalty System, `misbehavior`).
6. **Memory.** Any verified hash in a page present in `refused_headers` (Store Interface → Refused
   headers) refuses the branch and penalises (`misbehavior`) — before any further page, before any
   block is fetched.
7. **Work — the stop rules**, after every page: accumulated `work > ourWork` (strictly greater; a tie
   keeps the incumbent) → the headers verified so far are the target, `n` their count — **page-aligned,
   at most 399 blocks past the shortest heavier prefix**; their tip reached with `work ≤ ourWork` →
   keep ours, no penalty, the memo written; our tip moved between pages → abort, no penalty. **The walk
   needs no cap**: every verified header passed `'target'`, so it carries at least the floor's work and
   the sum exceeds ours within `⌈ourWork / floorWork⌉ + 1` headers — a branch longer than that is
   heavier by then, and a branch is bounded by its own length, which cost its author real PoW.
8. **Their blocks.** `requestBlocks(f + 1, f + n)` in pages: each page is checked as it lands — one
   or more blocks, heights consecutive from the first still missing, every `blockHash(header)` equal
   to the verified hash at its height — then the next page from the first height still missing. A page
   adding nothing → refuse, penalise `transient` (non-delivery), chain untouched. A wrong hash or
   height → refuse, penalise `misbehavior`, nothing reverted. The range is the verified branch's,
   never a peer-claimed tip height.
9. **Tip re-read.** Our tip moved during the awaits → abort, no penalty.
10. **The switch.** `reorg(f, blocks)`, atomic: on a rejected block it throws
    `ReorgBlockRejectedError { height, hash }` after the transaction has rolled back and the prover
    is restored.
11. **The mark.** `resolveFork` catches that error and, **after** the rollback, records the rejected
    block's hash in `refused_headers` in its own write, and penalises `misbehavior`. A mark written
    inside the reorg transaction would roll back with it.

**The horizon's price is memory.** All `n` blocks are held before the switch — the transaction is
synchronous and cannot await a page — so a reorg holds up to `n × MAX_BLOCK_BODY_BYTES`, with `n ≤
⌈ourWork / floorWork⌉ + 400`: on testnet (`maxReorgDepth` 240, the floor about ten times easier than
the anchor) up to ~2 900 blocks, kilobytes each in practice, 2 MB each at the cap. **`n` is not
capped**: a cap below the shortest heavier prefix would strand the node exactly where the horizon is
meant to reach.

**Re-scoring is memoised.** A node beside a taller-but-lighter peer is handed the same non-extending
block every sync round — the machine re-announces what we refused (NET_INTERFACE → Sync Integrity) —
and a walk costs up to seven pages. `resolveFork` keeps `{ peer → the tip it was scored lighter at }`,
read against `net.peerTipHeight(peer)` at step 2, **cleared whenever our own tip moves** (every
verdict's baseline is gone), written only by step 7's "keep ours" — never by a `'clock'` refusal or an
abort — and keyed on the peer because the walk asks the *relayer* for headers: the branch scored is the
relayer's, whatever block it relayed. A future-bound refusal never reaches this function (an extending
block goes to apply), so its re-delivery path is untouched.

**What is remembered, and what is not.** Header-stage refusals (steps 3, 5, 6, 8) are cheap to
re-check and are remembered nowhere — the peer is penalised and the pages are gone; a `'clock'`
refusal is not even penalised, being a verdict of this node's clock, and the paragraph's rule below is
why it must never mark. A body-stage
rejection (step 10) is the expensive case and the one remembered: verified headers over an invalid
body. **The mark records a consensus rejection and nothing else** — a rejection that depends on
local configuration or policy must not mark, because a persisted mark is only as right as the node
that wrote it; the schedule is checked at step 5 precisely so that a wrong-profile node never
reaches step 10. "Depends on" is about the verdict, not about enforcement: the funnel's one
configuration-gated check — `stateRoot` under `VERIFY_STATE_ROOT` — switches whether *this* node
enforces a consensus rule, not what the rule says, so a node that enforces it marks a chain whose
root is wrong for every node, and a node that does not never reaches the mark. Every other
rejection in the funnel is consensus-determined outright.

**Both entries converge.** Gossip receipt and pull-sync both reach `handleOrderingBlock(block,
fromPeerId)`: a block already held (our block at its height hashes to its header) is a **no-op** —
neither applied nor resolved; a block that extends our tip, or arrives at height 0, is applied;
anything else enters `resolveFork` with the delivering peer as counterparty. The pull handler's
return is the batch's **continue** signal — `true` for applied or already held, `false` for rejected
or for a non-extending block — and `net` stops the batch at the first `false` (NET_INTERFACE → Sync
Handler Registration). The trigger's own height decides nothing: the fork walk starts at **our** tip
whatever height the block arrived at, so a gossiped block far above us and a pull trigger at our
tip + 1 cost the same walk.

**Concurrency.** Resolutions may overlap — gossip already allows it, and the pull path adds
triggers, not a class. Two resolutions serialise at step 9: `reorg` is synchronous and nothing awaits
between the re-read and the call, so the second always sees the first's height and aborts.

**Apply stays the authority.** `reorg` runs every block through `applyOrderingBlock`, so the
header-level rules run twice — once over the pages, once in the funnel. The funnel is unchanged
and remains the single consensus gate (`Ordering block apply-time authorization`).

### Fork resolution bottoms out at the genesis state

**Reaching height 0 in the ancestor walk IS a common ancestor**, at depth = our height.
The fork walk answers `GENESIS_HEIGHT` (`0`) for chains that share no block. Heights still start at 1, so height 0 holds no block and no hash — what it
holds is the genesis *state*, which every node on a network shares byte for byte because the
section above makes any other one fail-stop. There is nothing for a peer to lie about: a
height-1 block has its `prevBlockHash` checked against `GENESIS_PREV_BLOCK_HASH` (TYPES_INTERFACE
→ Genesis parent hash), and its hash against `genesisId` where the profile pins one, before it can be
stored — the sentinel is the same value a fork at 0 hands `verifyHeaderChain` as its anchor — and
both checks are on every path into the store, and what makes "every path" true is stated on
`createOrderingBlock` in `node/src/store/ordering.ts`: one writer, called from `applyBlockBody`
downstream of the chain-link gate in the same function. All four callers of `applyOrderingBlock`
(gossip, sync pull, block creator, `reorg`) go through it.

**The horizon is the profile's `maxReorgDepth`** (TYPES_INTERFACE → Chain reorganisation), and how far
back a reorg may go is bounded by it because journal retention is the real floor under revert depth —
`revertBlock` throws without a journal. The walk reaches 0 only when our height is at or below the
horizon, which is exactly when every journal down to height 1 is still retained. Deeper than that the
answer is still `null`.

**The genesis fallback sits behind the page check, deliberately.** A page with an unhashable entry is
refused whole (`misbehavior`) — it does not fall through to genesis. In front, a peer could turn one
malformed header into "we fork at genesis" and buy a full-chain reorg attempt with it, on precisely the
short chains where the whole walk is inside the horizon.

**Downstream of a `0`,** `reorg` reverts every block, rolls the prover to
`versionAtOrBeforeHeight(0)` — the genesis version, and the genesis one only because seeding
deletes the empty tree's height-0 version before writing its own — and re-applies from a
`currentHeight` of 0, which is the chain-link check's genesis branch. Verified end to end
rather than reasoned about; `test/services/fork-resolution.test.ts` pins the round trip against
the pinned root.

---

## Nipopow prover

`GET /nipopow/proof/:m/:k` (HTTP API → Nipopow) answers `proveWithReader(reader, { m, k })`
(`NIPOPOW_INTERFACE` → proveWithReader) with `reader` the four store reads above (Store Interface →
Nipopow reader). The route parses and bounds `m` and `k` (400), maps `chain-too-short` to 404, and
serves the encoded proof; `missing-popow-header` cannot occur on a canonical chain the funnel wrote
— it is a store that has lost a row the walk needs, and it reaches the fail-stop boundary like any
other corrupt-chain read.

**Cost, so the exposure is a number:** a proof is O(m · M + k) point reads, `M` the height of the
tip's vector (~log₂ of the chain height): at `m = k = 6` on a million-block chain ~250 reads and a
~200 KB response; at the caps (`m = k = 128`) ~8 500 reads and ~7 MB. No cache and no O(N) walk
exist in the path. This is the node's second unauthenticated read that does real work per call
(`GET /api/v1/proof/:boxId` is the first); the node has no rate limiting anywhere, and this route
adds none — a single call is bounded by `MAX_NIPOPOW_PARAM`, and a limiter is a decision across
every route, not this one's.

**What a served proof proves, and what the client trusts it for,** is `NIPOPOW_INTERFACE` → The
trust model. The client checks the node's box proofs (`GET /api/v1/proof/:boxId?atHeight`) against
the `stateRoot` of the proof's `suffixHead` — a header under the client's own verified PoW — so the
two proof systems compose without the client trusting the node for either.

## Admin Listener

A second Express server on `127.0.0.1:ADMIN_PORT` (default 3001). Never
binds to a non-loopback address — a non-loopback bind logs a WARN at
startup.

**Every value is in-memory; `/health` and `/stats` never query the database.** The admin router is a
reader of two things: the node's **metrics** (`node/src/metrics.ts` — one module, written at four seams,
below) and two `NetNode` reads (`getConnectedPeers()`, `syncPhase()` — NET_INTERFACE → API).

**Endpoints:**

`GET /health` — always 200. Response shape:
```json
{
  "status": "ok",
  "dag_tip_height": 12345,
  "peers_connected": 8,
  "last_post_received_ms_ago": 234,
  "syncing": false,
  "sync_phase": "synced",
  "uptime_seconds": 84200,
  "protocol_version": 1,
  "protocol_version_schedule": [{ "version": 1, "from_height": 0 }],
  "apiVersion": "1.0",
  "journalEventsVersion": "1.0"
}
```

| Field | Is | Written |
|---|---|---|
| `dag_tip_height` | the applied chain tip — the height of the last block `applyOrderingBlock` applied, or the tip a reorg left | pushed at every successful apply and at the end of a reorg (`noteTip(height)`), and `net.tipApplied(height)` is called at the same seam (NET_INTERFACE → API); `0` before the first |
| `peers_connected` | `net.getConnectedPeers().length` — Active peers | read at request time |
| `last_post_received_ms_ago` | milliseconds since the last `post_received` journal event, any source; **`null`** until the first | the `emitPostReceived` wrapper stamps the time |
| `syncing` | `net.syncPhase()` is `'syncing'` or `'backfill'` — the chain is not yet usable as current | read at request time |
| `sync_phase` | `net.syncPhase()` verbatim — `'idle' \| 'syncing' \| 'backfill' \| 'synced'` (NET_INTERFACE → Sync State Machine). | read at request time |
| `uptime_seconds` | seconds since process start | — |
| `protocol_version` | the era at `dag_tip_height + 1` — `protocolVersionAt(schedule, tip + 1)`, the version a client must sign (`ARCHITECTURE → Protocol Versioning`) | read at request time |
| `protocol_version_schedule` | the profile's `protocolVersionSchedule`, each era as `{ version, from_height }` | static |
| `apiVersion`, `journalEventsVersion` | `"1.0"` | static |

`GET /stats` — cumulative counters since process start (`since`, epoch seconds):
```json
{
  "since": 1751400000,
  "statsVersion": "1.0",
  "counters": {
    "posts_received_total": 5432,
    "posts_validated_total": 5430,
    "post_bodies_pulled_total": 17,
    "pow_verifications_total": 6100,
    "pow_verification_failures_total": 2,
    "http_requests_total": 12000
  }
}
```

| Counter | Counts |
|---|---|
| `posts_received_total` | `post_received` journal events, any source (JOURNAL_EVENTS → post_received) |
| `posts_validated_total` | `post_validated` journal events |
| `post_bodies_pulled_total` | `post_received` journal events whose `via` is `"pull"` — bodies backfilled by id (JOURNAL_EVENTS → post_received). |
| `pow_verifications_total` | every `verifyOrderingBlockPoW` the node runs on **received** work — net's relay check (through the validators object node supplies to `NetNode`) and block application's — never the miner's check of its own template |
| `pow_verification_failures_total` | those of the above that returned `false` |
| `http_requests_total` | every request the **public** app receives (an express middleware ahead of the routes); the admin app's own requests are not counted |

**The seam.** Counters count journal events where an event exists — the `journal.ts` wrapper is the one
place an event is emitted (JOURNAL_EVENTS), so it is the one place its counter moves; the tip, the PoW
outcomes and the HTTP requests have no event and are noted at their single sites. Counters are
process-lifetime, never persisted: a restart resets them and `since`.

**Not served, by ruling (user, 2026-08-22):** `validated_height` and `indexed_height` — the node owns one
height, the applied tip — and `peer_messages_in_total`, `peer_messages_out_total`, `peer_bytes_in_total`,
`peer_bytes_out_total`, `unknown_message_types_total` — `@dagsocial/net` keeps no traffic accounting, and
none is added.

---

## Configuration

**`MAX_PROOF_HISTORY` may not sit below the profile's `maxReorgDepth`, and `loadConfig` refuses at load
rather than clamping.** `checkpointProver` prunes AVL versions below `height - maxProofHistory` while
the fork walk reaches back `maxReorgDepth` and can answer height 0, so a smaller retention window would
prune inside the horizon the walk still answers within. The profile's own `maxReorgDepth` must be a
positive safe integer — refused at load, never clamped. The check is a negated `>=`, so
`NaN` — what `parseInt` answers for a non-numeric env value — is refused rather than admitted. With
the floor held at load, `reorg` finding no version at or before a fork height the walk answers within
is `MissingStateVersionError` — a row the store lost, fail-stop ("What the funnel's totality catch is
FOR"), never a quiet abort that leaves the node on the lighter chain.

**The difficulty band is refused at load too, never clamped.** `loadConfig` refuses a profile whose
`orderingBlockPowTargetFloorBits` sits below `ORDERING_BLOCK_POW_TARGET_FLOOR`, whose anchor
`orderingBlockPowTargetBits` lies outside `[floor, ceiling]`, whose ceiling exceeds 65536, or whose
`orderingBlockIdealMs` is not positive (`TYPES_INTERFACE → Network profiles`). `Config` carries the
four as the schedule's `RetargetParams` — `halflifeMs = RETARGET_HALFLIFE_BLOCKS · orderingBlockIdealMs`
derived here — for the funnel, the creator and fork resolution (→ Difficulty schedule).

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

⚠ **An unclassed variable is the defect this convention exists for.** Nothing else in the tree states
which variables an operator may safely change, so one left unclassed reads as freely tunable whatever
its actual reach.

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
| ~~`ORDERING_BLOCK_POW_TARGET_BITS`~~ | **removed** | ~~`12`~~ | → profile field `orderingBlockPowTargetBits`, the ASERT schedule's anchor; the schedule itself is universal (`MINING_INTERFACE → Difficulty Schedule`) |
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
| `MIN_FEE_RATE_PER_BYTE` | `local` | `MIN_FEE_RATE_PER_BYTE` (`0n`) | Relay fee floor in base units per in-block byte — admission policy, not consensus (MEMPOOL_INTERFACE → Fee floor) |
| `MAX_PEERS` | `local` | `50` | Max connected libp2p peers |
| `MIN_PEERS` | `local` | `3` | Outbound fill floor — semantics `NET_INTERFACE → Config` |
| `PEER_DB_CAP` | `local` | `1000` | Soft cap on PeerDb entries — semantics `NET_INTERFACE → Config` |
| `OUTBOUND_REDIAL_COOLDOWN_MS` | `local` | `60000` | Redial cooldown per failed outbound target — semantics `NET_INTERFACE → Config` |
| `PENALTY_SCORE_THRESHOLD` | `local` | `500` | Accrued-penalty score that trips a temporal ban — semantics `NET_INTERFACE → Peer Penalty System` |
| `TEMPORAL_BAN_DURATION_MS` | `local` | `3600000` | Temporal ban length — semantics `NET_INTERFACE → Peer Penalty System` |
| `PENALTY_SAFE_INTERVAL_MS` | `local` | `120000` | Quiet interval after which accrued penalty decays — semantics `NET_INTERFACE → Peer Penalty System` |
| `SYNC_REQUEST_TIMEOUT_MS` | `local` | `10000` | Abort timeout on one sync request — semantics `NET_INTERFACE → Config` |
| `MAX_PROOF_HISTORY` | `local` | `1440` | AVL versions retained for proof serving |
| `PORT` | `operational` | `3000` | HTTP listen port |
| `ADMIN_PORT` | `operational` | `3001` | Admin listener port |
| `ADMIN_BIND_ADDRESS` | `operational` | `127.0.0.1` | Admin listener bind address. ⚠ The admin listener is **unauthenticated**; binding it off loopback exposes it |
| `DB_PATH` | `operational` | `dagsocial.db` | SQLite database path |
| `NODE_ROLE` | `operational` | `server` | `server` (applies peer blocks) or `miner` (produces blocks) |
| ~~`MINING_MODE`~~ | **removed** | ~~`internal`~~ | The node has no in-process solver. A miner node serves templates; that is the only production model |
| `MINING_SECRET` | `operational` | `""` | Mining auth secret — **required when `NODE_ROLE=miner`**; startup asserts it is set |
| `BOOTSTRAP_PEERS` | `operational` | the profile's `bootstrapPeers` — testnet `/dns4/notis.fun/tcp/9733`, mainnet and devnet none (`TYPES_INTERFACE → Network profiles`) | Comma-separated libp2p multiaddrs; a set variable **replaces** the profile's list, it does not add to it |
| `LISTEN_ADDRS` | `operational` | `/ip4/0.0.0.0/tcp/0` | libp2p listen addresses |
| `PUBLIC_URL` | `operational` | `/` | Base path where the demo UI is served |

> ⚠ **Every "at 60 seconds" duration annotation is nominal in the short run and exact in the long
> run.** The block time is an *emergent* property of the target and hashrate — there is no producer
> timer — and the ASERT schedule tracks it toward `orderingBlockIdealMs` with an absolute anchor, so
> the interval wanders within a halflife's response and never accumulates drift; a block-denominated
> duration is therefore right on average and approximate over any short window
> (`MINING_INTERFACE → Difficulty Schedule`).

---

## Net Integration

The node creates a `NetNode` from `@dagsocial/net` during startup and registers
Stage 2 handlers for inbound gossip messages. Startup order:

```
1. initDb()
2. Create NetNode with config + validators
3. Register Stage 2 handlers (onOrderingBlock, onTx)
4. Register sync handlers (setBlocksHandler, setHeadersHandler, setChainHeightProvider, setBlockIdProvider, setHeightByBlockIdProvider) BEFORE net.start()
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

- **`onTx(tx, content, fromPeerId)`**: validates (read-only, `validateTx`) → inserts into
  mempool via `admitTx`; for a post transaction the packet's body — already verified against
  `tx.post.contentHash` by net's topic validator — is stored as the pending row in the same
  store transaction as the admission (Post transactions → the packet is the unit), and
  `emitPostReceived(postId, fromPeerId, via: 'packet')` fires.
- **`onOrderingBlock(block, fromPeerId)`**: structure / PoW pre-filters (net) →
  `handleOrderingBlock` — already held → no-op; extends our tip or height 0 →
  `applyOrderingBlock` → confirms posts → removes confirmed entries from mempool;
  otherwise → `resolveFork` (AVL+ State Root → "Fork choice decides on verified
  headers"). The pull path reaches the **same** `handleOrderingBlock` through
  `setBlocksHandler`; `reorg` applies directly. The authoritative consensus checks
  — including **validator-signature verification (H-1)** — are enforced *inside*
  `applyOrderingBlock` (see "Ordering block apply-time authorization" below), so
  all three paths end at the same gate. Both registrations — this one and
  `setBlocksHandler`'s — wrap the call in `failStopIfCorruptChain`: the apply
  funnel re-throws `CorruptChainStateError`, and the registration is its outer
  frame ("What the funnel's totality catch is FOR").

### Ordering block apply-time authorization

`applyOrderingBlock` is the single funnel every apply path — gossip receipt,
pull-sync, and reorg — passes through, so consensus authorization is enforced
there rather than at any one entry point.

**Structure validation in the apply funnel.** Before any field of the block is
read, `applyOrderingBlock` rejects the block unless
`verifyOrderingBlockStructure(block)` (from `@dagsocial/validation`) returns
valid. Previously this ran *only* in the gossip topic validator
(`net/src/gossip.ts`), so the pull-sync path — which decodes wire bytes and
calls the apply handler directly — reached consensus code with fields of
arbitrary type.
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
> **It is not confined to transit.** `createOrderingBlock` (then at
> `node/src/store/ordering.ts:45`) re-encodes from the *parsed struct*, so
> retained junk is written into `subblock_tree_cbor` — a column the table then
> carried — on disk and re-propagated when the block is served. Two honest
> nodes can therefore hold byte-different blobs for the same block at the same
> height, with no way to tell which is canonical, and an attacker can inflate
> stored bytes with payload that validates.
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
- the journal's `confirmedPostIds`, replayed on reorg as `unconfirmPost(id)`.

The defect was an **asymmetry**: apply confirmed from the committed entry list while rollback
un-confirmed from `subBlockRefs` (uncommitted) — the inverse keyed on a different list than the
forward operation. Both directions now key on one list: the block's post ids, derived from its
post-bearing transactions (`postIdsOf`) — recorded at apply (`recordConfirmedPosts`) and
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
`encodeTx` — established by grepping the `utxo_tx_cbor` column (its name then; `utxo_tx_bytes` today) rather than the function name, which
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
signed), `uint`/`u32` as safe non-negative integers excluding `-0` — and it is already total on
any JS value. A narrower check written for this call site would be a second spelling of one schema,
which is the fork surface this contract rejects everywhere else. **The obligation is the whole
schema, not the `bigint` alone**: the spec names the `value` field because that is where it was
found, and any 64-hex field written by `writeHexNOrThrow` reaches a throwing writer by the
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
| **Validation** | chain-link, protocol version, PoW target + PoW, interlink root, validator signature, Merkle roots, coinbase value + maturity, block storage, `clearTemplate` | No — the header does not exist yet |
| **Mutation** | coinbase mint, post confirmation, DAG scores, topology, prune verification + settlement, embedded UTXO txs, per-block like settlement, decay, vouch cooldowns | Yes — verbatim, at an explicitly passed height |
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
sits alongside the scheduled PoW-target, timestamp and coinbase-maturity checks
already enforced in this funnel, and precedes any mutation so a bad-signature
block rolls back to a no-op.

**Interlink root.** The block is rejected unless `header.interlinkRoot ===
interlinkRoot(updateInterlinks(I(parent), parentHash, level(parent, anchorBits)))` — `I(parent)` from
the store's `interlinks` column (Store Interface → Ordering blocks), `parentHash` the recomputed
`blockHash` of the stored parent header (the corrupt-header tripwire, not the column read),
`level(parent, anchorBits)` from `@dagsocial/validation` measured against the profile's anchor target
(`VALIDATION_INTERFACE → level`) — a parent with no level leaves the vector unchanged; at height 1 the
expected vector is `[]`. Pure and deterministic, so every node
reaches the same verdict, and the vector it verified is what `createOrderingBlock` stores. The same
rule runs over a peer's segment in `verifyHeaderChain` before fork choice scores it (`TYPES_INTERFACE`
→ Interlink vector).

**Genesis pin.** When the profile's `genesisId` is non-empty, the height-1 chain-link also requires
`blockHash(header) === genesisId` — a block 1 that builds on `GENESIS_PREV_BLOCK_HASH` but is not the
pinned one is rejected like any chain-link failure. An empty `genesisId` (devnet always; mainnet until
its block 1 exists — testnet's is pinned, `TYPES_INTERFACE → Network profiles`) leaves the height-1 check
as the sentinel compare alone
(`TYPES_INTERFACE` → Network profiles).

**Post authorship + prune authorship (H-3).** A post transaction carries the
**whole post** in `utxoTxs` plus the author's signature over the `TxId`, so
authorship is verified, not claimed (`TYPES_INTERFACE` → "The H-3 property");
there is no separate authorship entry for a producer to fill or a node to
cross-check. Enforcement has two legs, both inside the `applyOrderingBlock`
funnel:

1. **Topology recording (confirm-time).** Topology rows are written from the
   block's verified post transactions: `insertBlockTopology(postId, parentRefs,
   author, height)` with `author` the creating transaction's signer and
   `parentRefs` the signed transaction's own. `block_topology.author` is the
   consensus authority for prune authorization, never `dag_posts.author`.
2. **Prune authorship binding (transaction-time).** The prune transition arm REJECTS the
   transaction unless `getTopologyAuthor(prune.rootPostHash)` returns a non-null author equal
   to `inputKarma.owner`, so a block carrying it is rejected with it. The lookup reads only consensus-recorded data, so the
   verdict is identical on every node — including one that synced from
   ordering blocks alone and holds no DAG content. A root no applied block has
   confirmed has no topology author and is therefore not prunable (this also
   forecloses the empty-subtree/unconfirmed-root edge). ⛔ **The payload carries no `authorId`
   and no signature of its own** — the transaction's signature over `txId` covers it and the
   karma input's owner is the author, so there is one authority and nothing to reconcile.

### Sync handlers (pull-path)

- **`setBlocksHandler((block, fromPeerId) => boolean)`**: the sync machine's pull path into
  `handleOrderingBlock` — the same entry gossip uses (Relay handlers, above). The return is the
  batch's **continue** signal: `true` for a block applied or already held, `false` for a block
  rejected or for a non-extending block, which launches `resolveFork` with `fromPeerId` as the
  counterparty; `net` stops the batch at the first `false` (NET_INTERFACE → Sync Handler
  Registration). The registration wraps the call in `failStopIfCorruptChain`, exactly as the
  gossip registration does — `net` contains a handler throw to one logged message, and that frame
  must never be the outer one for a corrupt-state error
- **`setHeadersHandler(getBlock)`**: the provider `net` reads stored blocks through — headers for
  fork resolution, bodies for served chain queries, the blocks a `ModifierResponse` serves. The
  provider node hands over wraps the store read in `failStopIfCorruptChain`: a stored row that will
  not decode stops the node ("What the funnel's totality catch is FOR") rather than failing every
  served query and response as the peer's fault inside `net`'s contained catches. `GET /blocks/:height`
  is given the same wrapped read; `GET /blocks/current` reads the `block_hash` column instead and
  answers over a rotted row rather than halting ("Who reads the block_hash column, and who
  deliberately does not")
- **`setChainHeightProvider(getCurrentHeight)`**: the tip height `net` advertises and compares — the
  store's `MAX(height)`, the same read the block creator and fork resolution take, handed over
  unwrapped: it decodes no row, so there is nothing for `failStopIfCorruptChain` to promote. `net`
  reads it once per handshake, `SyncInfo` and served chain query in place of a walk through the
  headers provider (NET_INTERFACE → Sync Handler Registration)
- **`tipApplied(height)`**: called beside `noteTip` at every successful apply and at the end of a
  reorg — the seam net's boundary sweep runs off (NET_INTERFACE → API). `NetConfig` receives the
  profile's `protocolVersionSchedule` the way it receives `magic`
- **`setBlockIdProvider(getOrderingBlockHash)`**: the block id at a height — the store's
  `block_hash` column, written by `createOrderingBlock` from the node's own decoded header at the
  table's single INSERT — behind every Inv continuation.
  Handed over unwrapped: a column read decodes no row, so there is nothing for
  `failStopIfCorruptChain` to promote
- **`setHeightByBlockIdProvider(getHeightByBlockHash)`**: the height holding a block id — an indexed
  point lookup on the same column — behind the inbound `Inv` filter and `ModifierRequest` resolution
  (NET_INTERFACE → Sync Handler Registration). Unwrapped for the same reason

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
- A body is stored only after `verifyPostBody` accepted it against the row's `content_hash`;
  `content` is the authority and `NULL` is the placeholder — there is no second copy of a body
  anywhere in the store
- `post.id` is computed server-side — client-submitted IDs are ignored
- Content rules (`verifyPostBody`) are enforced at every body entry — packet, pull response,
  `POST /posts` — and in no transaction check
- A pending row exists iff its transaction is in the pool, or the post is confirmed
- Once a prune block's journal is dropped below the reorg horizon (`maxReorgDepth`), no `dag_posts` row and no
  journal row holds the subtree's content (ARCHITECTURE → Subtree pruning)
- Protocol version checked at verification, against the era scheduled at the object's height
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
