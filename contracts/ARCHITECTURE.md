# DAGsocial Architecture

**Protocol version:** 1
**Last updated:** 2026-08-11

## Status markers — the convention for every contract in this directory

A contract section describes one of several different things, and until 2026-08-06 nothing
distinguished them: text describing running code, text describing intended design, and text
describing a mechanism that was documented and never built all read with identical authority.
A repo-wide audit found **41 `never-true` claims against 25 genuine drift** — the dominant
failure was not documentation falling behind code, it was documentation that was never true.

**Every section that is not plainly describing running code MUST carry one of these**, and each one
**carries the date it was last verified** — `> ⚠ VIOLATED — verified 2026-08-11` — so a reader can
judge the claim's age without `git blame`. **An undated marker is an unverified one.**

| Marker | Meaning |
|---|---|
| `> ⚠ NOT IMPLEMENTED` | Intended design. Not built. **Is** meant to be built |
| `> ⚠ PARTIAL` | Some of it runs. The marker must say which part |
| `> ⚠ NEVER BUILT — NOT PLANNED` | Was documented, never built, and there is no intent to build it. Kept so nobody re-adds it believing it was an oversight |
| `> ⚠ VIOLATED` | The rule is **correct** and the code breaks it. **Never weaken the rule to match the code** |
| `> ⚠ FALSE` | The text **was never true**. It does not state a rule the code should meet. **Correct or delete the text — never change code to satisfy it** |
| `> ⚠ UNENFORCED` | The rule is stated and **nothing checks it**. No violating code path is claimed; if one is, that is `VIOLATED` |
| `> ⚠ QUALIFIED` | The claim survives, but narrower than written. The marker must state the narrowing |
| `> ⚠ SUPERSEDED` | Replaced by a later decision; points at it |
| `> ⚠ AHEAD OF CODE` | The contract deliberately leads the code. **The only marker that asserts nothing about the current tree**, and therefore the only one that does not decay |
| `> ✅ RESOLVED` | A previously-marked defect is closed. Names what closed it and when. Kept so the reasoning survives its own fix |

**The markers are mandatory, not optional.** An optional marker reproduces the exact defect
this convention exists to fix — a reader cannot tell whether its absence means "verified" or
"nobody looked."

**`⚠` means open, `✅` means closed.** A reader skimming for what still needs attention reads the
sigil, not the word.

⚠ **`FALSE` and `VIOLATED` are opposites and must not be swapped.** `VIOLATED` says the rule is right
and the code is wrong, so the reader's job is to fix the code — and this convention forbids the
alternative. Marking a never-true sentence `VIOLATED` therefore instructs the next reader to make the
code satisfy a rule that was always wrong. The preamble above names never-true text as the
*dominant* failure this convention exists for; `FALSE` is the marker for it.

**One name per concept.** `DONE`, `CLOSED`, `LANDED` and `IMPLEMENTED` are all `RESOLVED`;
`PARTLY IMPLEMENTED` is `PARTIAL`; `PREMISE` is `QUALIFIED`; `WRONG` and `WAS FALSE` are `FALSE`.
A second name for a class is invisible to any sweep that greps the first — which is how sixteen
markers survived every contract sweep this project has run.

**Row annotations are not section markers.** `⚠ DELETED`, `⚠ TO BE DELETED` and similar inside a
table row annotate one symbol's lifecycle. They are not one of the markers above and a marker sweep
does not chase them.

⚠ **Markers also hide in table cells.** A sweep keyed on the `> ⚠ **NAME**` shape cannot see a marker
written inside a `|` row — one sat in §Protocol-breaking changes for the whole positional bundle and
survived Phase 9's first pass. **Put status in a marker, not in a parenthetical.**

**Cite code by SYMBOL, not by line number.** `file.ts:NNN` rots silently: nothing recompiles a
contract, so a pin is wrong the moment an unrelated edit shifts the file, and the next reader lands
on unrelated code with no signal. Phase 9 found **4 of 7 pins in this file wrong** — three moved by
one 16-line insertion above them, and one named a file in the wrong package. Name the function, the
constant, or the interface; add a line number only as evidence for a *dated* verdict, where being a
snapshot is the point.

**Why this works:** the one section of this document with no false invariant
(§Block Application Journal) is also the only one written *after* its implementation existed.
The failure mode is timing, not care. These markers make timing visible at read time instead
of requiring `git blame`.

## Overview

DAGsocial is an invite-only decentralized social network built on a dual-ledger
architecture:

| Layer | Purpose | Mutability |
|-------|---------|------------|
| **Posts DAG** | Content, social graph | Author-sovereign (prunable) |
| **UTXO Ledger** | Karma & credits state | Owner-controlled (spendable) |
| **Stumps** | Compact proofs binding DAG → UTXO | Immutable once created |

These layers are interdependent but cryptographically independent: the DAG's
integrity doesn't depend on the UTXO state, and vice versa. Stumps are the
binding layer — they crystallize karma issuance from pruned DAG content.

### Why dual-ledger

- **Content ledger (DAG):** Posts are sovereign to their author. The author can
  delete their entire reply subtree for privacy. Content is additive by default
  but prunable by the root owner.
- **Value ledger (UTXO):** Karma and credits track account state with
  cryptographic lineage. Boxes are consumed and created; history is immutable
  even though current balances change.

A pure-additive DAG can't model deletion or mutable account state. A pure UTXO
system can't model threaded conversation or author-sovereign content spaces.
The hybrid preserves the strengths of both.

### Block architecture: sub-blocks + ordering blocks

See `SUBBLOCK_INTERFACE.md` for the full sub-block contract.

Inspired by Ergo's subblock model (EIP-15):

| Block type | Producer | PoW difficulty | Purpose | Interval |
|------------|----------|----------------|---------|----------|
| **Sub-block** | User (post author) | Post PoW | Fast inclusion: the post | Per post |
| **Ordering block** | Validator | Full PoW | Consensus anchor: batches sub-blocks, orders UTXO transactions, settles per-block like accrual | Configurable |

A user's post PoW solution IS the sub-block proof. A sub-block carries exactly
the post — likes are ordinary UTXO transactions and ride `utxoTxIds` in the
ordering block like every other transaction (P2-D; see §Likes).

Validators produce ordering blocks: full PoW, batch all sub-blocks produced
since the previous ordering block, order the pending UTXO transactions (likes
included), and distribute credit rewards.

---

## Design Principles

### Correct and cheap are separate obligations, and only one is instrumented

A contract that states *what* a component computes can be satisfied completely by
an implementation that computes it as expensively as possible. Types, tests,
review and CI all check correctness; **nothing in this repo measures cost.** A
component that spins a core, allocates without bound, or polls where it could
wait produces correct results, promptly, forever — and every gate stays green.

So where idle behaviour, cadence, or an allocation ceiling is load-bearing, the
contract states it as an obligation with a number, not as an implementation
detail. `NET_INTERFACE → Biased Event Loop` clause 4 is the worked example, and
`MAX_DATA_QUEUE` / `MAX_OUTSTANDING_IDS` are the shape to copy.

> ⚠ **Ported specifications drop exactly what the source runtime guaranteed.**
> Several contracts here were templated from `ergo-node-rust`'s `facts/`. That
> node is Rust on Tokio, where `select!` parks a task until a channel or timer is
> ready — so its documents never had to say "wait when idle." The guarantee lived
> in the primitive, not the prose. Ported to JavaScript, every written clause
> survived and the unwritten one did not: the sync loop consumed 100% of a core,
> permanently, from the day it landed until 2026-08-11.
>
> **Before porting a design across runtimes, enumerate what the source language
> was providing unstated.** A specification is silent about whatever its origin
> made free, and that silence is invisible until it is read somewhere else.

---

### Node as record-keeper, not ranker

The node's job is to faithfully record, validate, and serve data — posts, likes,
vouches, karma state, blocks. **Feed ranking, algorithmic curation, reputation
scores, and any interpretation of on-chain data are the responsibility of client
implementations and indexers.** The node provides the raw, verifiable dataset;
clients decide what to surface and how to weight it.

This means:
- On-chain primitives (likes, vouches) exist to be queried and aggregated, not
  to drive built-in ranking logic
- The built-in feed endpoint (`GET /feed`) is for testing convenience only —
  production feeds come from indexers
- New primitives are designed for what they record, not for how a client might
  interpret them

---

## The Three Layers

### 1. Posts DAG (Content Layer)

Every post is the **root of a sovereign subtree.** The author controls
everything under it — replies, replies to replies, the entire transitive
closure of `parentRefs` that trace back to this root.

#### Post structure

```
Post {
  content: string              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId               // 32 raw bytes — see the representation rule below
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS per post
  challenge: bytes             // Random nonce issued by node (anti-precomputation)
  powNonce: number             // PoW solution — proves work against challenge
  protocolVersion: number
  timestamp: number
  signature: bytes             // Ed25519 over signingHash(post)
}

PostId = blake2b512(POST_ID_DOMAIN ‖ postFieldBytes(post) ‖ vlqU(powNonce))[0:32], hex
```

> **The byte-exact preimage is specified in `TYPES_INTERFACE.md` (Serialization → "Layout —
> Post") and nowhere else.** Every field is length-prefixed and the ref array carries an
> explicit count (audit M-1); the domain tag keeps a post id from ever colliding with the PoW
> hash over the same post. **Do not restate the formula here.** This document previously
> carried it twice, in two different field orders, both in the pre-M-1 unprefixed form — a
> restatement of a byte format is a mirror implementation in prose, and it diverged exactly
> the way mirrors do.
>
> ⚠ **It diverged again, in this very paragraph, and that is the point.** The clause above
> read "an explicit `u32LE` count" until 2026-08-10 — a fragment of the format, restated
> inside the warning against restating the format, left behind when Phase 3b made the count
> `vlqU`. A prohibition does not exempt the text that carries it.

A post's `parentRefs` may reference either live posts or stumps. The hash is
the same either way — the DAG's cryptographic integrity doesn't depend on
content availability.

#### Public-key representation — the rule, and where the boundary is

**`UserId` is `Uint8Array` — 32 raw bytes — everywhere it appears as `UserId`.** This
document previously said `hex(publicKey) — 64 chars`, which was never true of `Post.author`.

A public key is rendered as a **hex `string`** in exactly three places, each explicitly
typed `string` rather than `UserId`: `SubBlockEntry.author`, the `signatures` map keys,
and `proofSource`. That is deliberate, not drift — those structures are JSON-oriented and
JSON has no byte type. `SubBlockEntry` in particular is serialized through
`JSON.stringify` into a consensus Merkle leaf, so a byte array there would encode as
`{"0":1,"1":2,…}`.

**The rule: if the field is typed `UserId`, it is raw bytes. If it is typed `string`, it
is lowercase hex.** The type is the boundary marker; there is no third form. Both
representations are genuinely live, so this is a convention to state and hold, not drift
to eliminate.

#### Post-level PoW (sub-block mechanism)

PoW is a single challenge-response pass, collapsed from the Phase 1 two-phase
model. The post's PoW solution IS the sub-block proof:

1. Author requests a challenge from a node → node returns random nonce
2. Author constructs the post and iterates `powNonce` until `postPowPreimage(post)`
   hashes below the target difficulty — **preimage specified in `TYPES_INTERFACE.md`,
   not here** (see the note above; the formula previously restated at this line
   disagreed with the one four lines earlier on field order)
3. Author submits the completed post → it becomes a sub-block (a sub-block
   carries only the post; likes are ordinary UTXO transactions — P2-D)
4. Validators verify the PoW when anchoring sub-blocks in an ordering block

The challenge prevents precomputation. Requesting a new challenge replaces
any existing one (upsert). Challenge expires after `CHALLENGE_WINDOW_BLOCKS`.

PoW difficulty is a protocol parameter (`POST_POW_TARGET_BITS`). It may
become karma-proportional in the future (high karma → lower difficulty),
but for Phase 2 it is fixed.

#### Subtree pruning (deletion)

The root author may prune their entire subtree at any time. Pruning:

1. Removes the root post and all descendant posts from the indexable DAG
2. Cascades to all replies — a reply exists only in the context of its root
3. Replaces the entire subtree with a **stump** (see §3)
4. Is authorized by a signed prune transaction from the root author's key

The prune is authorized **solely** by the root author's Ed25519 signature
over `(rootPostHash, subtreeMerkleRoot)`. The signature travels in the block
as a PruneEntry. Who "the author" is, is itself consensus data: every
confirmed post's `author` is carried in its block's `SubBlockEntry` and
recorded in `block_topology`, and a PruneEntry is valid only if its
`authorId` equals that recorded author (audit H-3) — so a signature from
anyone else, however valid for its own key, authorizes nothing. No validator
attestation is required — settlement is deterministically computable from the
UTXO state (the subtree's PostLockBoxes) plus the like-records it deletes
(P2-D). Any node can verify the prune independently, with or without the DAG
content.

Pruning is irreversible. Once content is pruned, it cannot be recovered.
What propagates is the PruneEntry inside the ordering block that settles
it — never the original content, and not the stump either: each node
derives its own stump from the verified entry at settlement (§3).

Future stump triggers beyond author deletion (storage pruning for lean nodes)
will use their own authorization paths but produce the same stump data structure.

**Privacy rationale:** Even if only the root post is deleted, replies in the
subtree contain signals (tone, specificity, timing) that can leak what the
root said. Cascade deletion is the only privacy-preserving default.

#### Subtree ownership

- The author of post `P` owns the subtree rooted at `P`
- Ownership means the exclusive right to prune
- Replying to a post grants the root author sovereignty over your reply
- This is a social contract encoded in the protocol: replying is consent

A reply author may delete their own reply individually (it's their subtree
root), but cannot prevent the parent author from pruning the whole tree.

### 2. UTXO Ledger (Value Layer)

The UTXO layer tracks two non-fungible value types:

| Asset | Tradeable | Earned via | Spent via | Decays | Mint/Burn |
|-------|-----------|------------|-----------|--------|-----------|
| **Karma** | No | Likes on posts | Invites, likes | Yes (storage rent) | Mint: like rewards. Burn: invite bond forfeiture |
| **Credits** | Yes | Validator rewards, genesis | Ads, transfers (future) | No | Mint: ordering block rewards |

Both are stored as **boxes** — UTXO entries guarded by cryptographic scripts.
Boxes are consumed and created in transactions; the set of unspent boxes IS
the current state.

Box `value` is a uniform **`bigint`** — credits are 8-decimal integer base units
(10⁻⁸ credit), karma small bigints. No float arithmetic in consensus value math;
`value < 2⁶⁴`. See `TYPES_INTERFACE.md` "Value denomination" and Spec B P0.

#### Karma boxes

```
KarmaBox {
  id: BoxId
  value: bigint                // Karma balance (bigint base units — see value denomination)
  owner: PublicKey             // Ed25519 public key (32 bytes)
  createdAtBlock: number       // Block height when box was created
  guard: "owner_signature"     // Only the owner can spend
  proofSource: PostId | StumpHash | InviteTxId  // Where this karma came from
}
```

Karma can only be transferred via the **invite mechanism** (§4). Normal
transfers between existing accounts are forbidden — this is what makes karma
non-tradeable. An account's karma box can be consumed only to:
- Create invite boxes
- Create like boxes (spending karma to vote)
- Create a new karma box for the same owner (after earning/burning, resetting
  the activity clock)

#### Karma decay (periodic burn)

After 28 days of inactivity, karma is burned periodically at block application
time:

- **Staleness check:** An identity is stale if it has NO unspent karma box
  without `decayBurn` that was created within `KARMA_STALE_THRESHOLD_BLOCKS`
- **Decay execution:** At each ordering block, stale karma boxes have their karma
  boxes consumed and replaced with a single consolidated box with value reduced
  by `KARMA_DECAY_AMOUNT` per `KARMA_DECAY_INTERVAL_BLOCKS` elapsed
- **Floor:** Decay never reduces karma below `KARMA_MINIMUM`
- **Provenance:** Decay-created boxes are marked with `decayBurn: true` so they
  don't reset the staleness clock. Normal user activity (post, like, invite)
  creates boxes without this flag, resetting the clock.
- **Rollback:** Decay burns are journaled and reversed during fork rollback

All four are **consensus parameters** — decay mutates committed state, so two nodes
holding different values compute different `stateRoot`s and partition permanently.
Classes are defined in `NODE_INTERFACE.md → Configuration`.

| Parameter | Class | Default | Description |
|-----------|-------|---------|-------------|
| `KARMA_STALE_THRESHOLD_BLOCKS` | **consensus** | 40320 | Grace period before decay begins (28d at 60s blocks) |
| `KARMA_DECAY_INTERVAL_BLOCKS` | **consensus** | 1440 | Decay period (24h at 60s blocks) |
| `KARMA_DECAY_AMOUNT` | **consensus** | 5 | Karma burned per period |
| `KARMA_MINIMUM` | **consensus** | 10 | Floor — decay never reduces below this |

> ✅ **RESOLVED — closed by P2-A, re-verified 2026-08-11.** None of the four is
> environment-readable. In `node/src/config.ts`, `karmaStaleThresholdBlocks` and
> `karmaDecayIntervalBlocks` are taken from the network profile, and `karmaDecayAmount` /
> `karmaMinimum` from the `@dagsocial/types` constants `KARMA_DECAY_AMOUNT` and `KARMA_MINIMUM`;
> the code states the rule in place. *Historical:* all four were `process.env` reads, and none
> appeared in `NODE_INTERFACE.md`'s Configuration table until 2026-08-06.
>
> ⚠ **All three line pins in this note had rotted, each by exactly 16 lines** — `config.ts:107-108`
> now lands on `miningMode`/`miningSecret`, and `:109-110` on unrelated fields. One insertion above
> them moved every pin at once and nothing signalled it. **Named symbols replace the numbers here**,
> per the Phase 9 rule: a corrected number rots again on the next commit that touches the file.

> ✅ **RESOLVED 2026-08-06 — the target block time is 60 seconds, and the two `*_BLOCKS`
> values are recomputed above. Re-verified 2026-08-11.** `KARMA_STALE_THRESHOLD_BLOCKS` and
> `KARMA_DECAY_INTERVAL_BLOCKS` hold `40320` and `1440` in **`packages/types/src/constants.ts`**.
> (Historical: this sentence once said "the code still holds `20160` / `720`; Phase 2 changes
> `constants.ts`" and was never updated after Phase 2 did.)
>
> ⚠ **The old pin read `constants.ts:43-44` with no package, and a reader following the
> `config.ts` reference beside it would look in `node/` — which has no `constants.ts` at all.**
> The values are in `types/`. Right line numbers, wrong package: the failure mode carried
> register #25 describes, found here independently.
>
> The karma pair were the **only** constants on a 2-minute basis — `CREDIT_MINER_REWARD_DELAY`
> and `MEMPOOL_EXPIRY_BLOCKS` (both `720` = ~12h), `CREDIT_EPOCH_BLOCKS` (`129_600` = ~90d)
> and `CREDIT_FIXED_RATE_BLOCKS` ("at 60s blocks") all agree on 60s. So at the block time
> the node runs, these two delivered **14 days and 12 hours instead of 28 and 24**.
>
> ⚠ **The 28-day figure is separately still open.** The economics design track wants a
> short, days-scale grace window ("e.g. ~5, not 28"), so `40320` is a faithful translation
> of a value that is itself pending the constants-pinning session — not a decided number.

#### Credit boxes

```
CreditBox {
  id: BoxId
  value: bigint                // Credit balance (integer base units of 10⁻⁸ credit)
  owner: PublicKey
  guard: "owner_signature"
  proofSource: BlockId         // Which ordering block minted these credits
}
```

Credits are freely transferable between accounts. They are minted as validator
rewards for producing ordering blocks. Credit sinks (ads, author boosts, tips)
are deferred to future protocol versions. For Phase 2, the credit supply grows
with each ordering block — the reward amount is a protocol parameter.

#### Vouch boxes

```
VouchBox {
  id: BoxId
  value: 1n                   // VOUCH_KARMA_AMOUNT — always 1n (bigint)
  voucherId: UserId           // Who staked the karma
  targetId: UserId            // Who is being vouched for
  createdAtBlock: number      // Block height when vouch was cast
  guard: "owner_signature"    // Only the voucher may spend (unvouch)
}
```

A vouch is a 1-karma endorsement from one identity to another. Casting a vouch
consumes 1 karma from the voucher's KarmaBox and creates a VouchBox. The karma
is escrowed — not burned, not transferred to the target. Unvouching (spending
the VouchBox) triggers a cooldown: the karma is not immediately returned to the
voucher but is held for `VOUCH_COOLDOWN_BLOCKS` before release.

Each identity may vouch for at most one target at a time. The minimum karma
balance to cast a vouch is `VOUCH_MIN_BALANCE` (11).

#### Box lifecycle

All box transitions are atomic — a transaction consuming N boxes and creating M
boxes either fully commits or fully fails. The ledger enforces:

- Total value in = total value out (conservation, except mint/burn)
- Guard scripts evaluate to true for every consumed box
- New boxes are valid under protocol rules

**Canonical bytes are the record; typed views are derived.** A box's identity
(`canonicalBoxBytes` → id) and its state commitment (`serializeBox` → AVL leaf →
`stateRoot`) are both computed from its byte form, so the byte form is the box;
SQLite rows, DTOs and API JSON are views of it. Two obligations follow, one per
direction. **Inbound:** any path admitting client-supplied structure into those
bytes must hold it to a closed schema (`NODE_INTERFACE` → "Output shape") — an
accepted field the schema doesn't pin becomes a committed byte no reconstruction
reproduces. **Outbound:** any path rebuilding a box from a typed view must
reproduce the committed bytes exactly; a read path that "fixes up" a field
(`rowToBox` once fabricated `1n`/`2n` values — both found as divergence
surfaces in P2-B) returns an object that disagrees with its own id. This is
Ergo's storage discipline — the node stores serialized box bytes and derives
views, never the reverse; its Rust implementation recomputes ids from
re-serialized bytes at every deserialization boundary and hard-errors on
mismatch. Notis stores typed rows today, so the whole burden sits on those two
obligations — and journal replay and any future snapshot sync must be designed
over **recorded bytes** (the journal's box records, a transferred tree), never
over views re-typed from storage.

**Both halves run, in all three respects.** The outbound half since P2-B (value
fabrication fixed; `rowToBox` reproduces honest boxes byte-exactly). The inbound
half since the guard-shape pin landed (2026-08-08: closed per-boxType key sets,
canonical-guard equality, pinned by `computeBoxId(rowToBox(row)) === row.id`
discriminator tests — which also caught a live instance: an integration fixture
had carried a lying invite shape since before the check existed). Field **types**
since the field-type pin (2026-08-08, PR #16): `OUTPUT_SHAPE` carries a runtime
type per field — `owner` is `bytes32`, `originalValue` is `u64`, every predicate
total — and `checkOutputShape` moved to `validateTx` **step 4**, ahead of the
transition arms that dereference those fields, which is what closed the totality
gap the same marker used to book as a queued follow-up.

Two corrections that phase produced are worth keeping, because both were
type-versus-domain errors of the kind this section is about: credit
`proofSource` is `heightOrTransfer`, not a plain height, because production
stamps `-1` as the transfer sentinel; and `post_lock.targetPostId` needed a
`hex32` type added in the wire-format bundle, having been admitted as any
`string` while `canonicalBoxBytes` wrote it with a throwing fixed-width writer.

> ✅ **RESOLVED — the inbound obligation is now structural. Verified 2026-08-11.** This read
> `AHEAD OF CODE` until Phase 9; the positional bundle
> (`docs/specs/2026-08-09-positional-wire-format.md`) is merged, so it describes running code and is
> no longer forward-looking. "Any path admitting client-supplied structure into those bytes must hold
> it to a closed schema" is no longer an obligation a check must enforce: it is a property of the
> encoding, because a positional layout has nowhere to put an unknown field and a field's width and
> type are fixed by its writer. The closed-schema check remains as defence-in-depth for JSON-sourced
> input, which does not pass through the codec.
>
> The outbound obligation is **unchanged and still carries its full weight**. A positional codec
> guarantees that bytes *decode* to a well-formed value; it says nothing about whether a typed view
> rebuilt from SQLite reproduces the bytes that were committed. `rowToBox` fabricating a value would
> be exactly as wrong afterwards as before.
>
> Ergo's discipline is adopted one step further here than the paragraph above describes: not only
> "store bytes, derive views", but **re-serialize and byte-compare at every decode boundary** — the
> sigma-rust behaviour cited above, which is only meaningful over a schema-projecting decoder (a
> lossless one round-trips junk to itself and the comparison is vacuous). See TYPES_INTERFACE →
> "The boundary check".

#### AVL+ State Root

The UTXO set is indexed by an AVL+ authenticated dictionary. Every ordering
block header carries a `stateRoot` — the root hash of the AVL+ tree over all
unspent boxes **after this block has been applied**. This enables light clients
to verify box existence or absence without storing the full UTXO set.

- **Post-state, not parent-state (H-6).** `stateRoot` commits to the state the
  block *produces*, following Ergo. The block therefore commits to its own
  effect, and the tip's state is provable as soon as the tip exists. The cost
  is that a producer must know its block's outcome before mining it — see
  `NODE_INTERFACE.md` → "Ordering Block Creator Contract" for how that is
  obtained without a second implementation of the state transition.

- **Module:** `packages/node/src/state/` (avl-storage, avl-prover, avl-endpoint)
- **Proof endpoint:** `GET /api/v1/proof/:boxId?atHeight=N` — returns an
  inclusion or exclusion proof for a box at a given block height
- **Config flags:** `VERIFY_STATE_ROOT` (`consensus-check` — validate stateRoot at
  block apply, **default on** since Spec B P3), `MAX_PROOF_HISTORY` (`local` — prune
  old proof versions). **`AVL_KEY_LENGTH`** is no longer configuration at all — it is a
  `@dagsocial/types` export (TYPES_INTERFACE → State format), imported by `config.ts` and
  plumbed through `Config.avlKeyLength`. It determines the **shape** of every `stateRoot`,
  so two nodes differing on it compute different digests for identical state; P2-A removed
  its environment read and the types export gives a second implementation an authoritative
  definition to read.
- **Deterministic across the same mutation *history*, not across the same
  *content*.** Every node that applies the same blocks in the same order —
  and holds the same `AVL_KEY_LENGTH` — produces the identical stateRoot. Box
  `value` serializes as a `bigint` (CBOR uint64), so the AVL leaf bytes are
  stable across implementations (the demo UI mirrors the encoding).

  > ⚠ **This bullet used to read "every node computing the AVL+ over the same
  > UTXO set … produces the identical stateRoot", and that is false.** An AVL+
  > tree is balanced by insertion order: rotations happen at different moments,
  > so two trees holding *identical content* can have different structures, and
  > the digest commits to structure. Measured 2026-08-07: identical 7-box
  > content, built incrementally versus rebuilt from the sorted set, agreed on
  > the digest in **6 of 10** rounds (content lookups agreed 10/10).
  >
  > **This is a property of the data structure, not a bug in any function.**
  > A Patricia/Merkle trie is canonical — its shape is fixed by the keys alone,
  > which is what lets Ethereum reconstruct a state root from state. AVL+ buys
  > cheap batch proofs and gives that up. The false sentence above is what made
  > rebuilding the tree from `getUnspentBoxes()` look correct, and it shipped
  > such a rebuild (now deleted — see NODE_INTERFACE → the `bootstrapAvlProver`
  > SUPERSEDED note).
  >
  > **Binding rule: no code may reconstruct the state tree from box contents
  > alone.** Consensus guarantees a shared *history*, which is what makes the
  > digest agree; content alone does not. The sound ways to obtain a tree are:
  > **load the persisted one** (every normal restart), **replay the mutations**
  > in order (blocks or the journal — correct by construction, slowest), or
  > **transfer the serialized tree** from a peer, which is what Ergo's UTXO-set
  > snapshot bootstrap does. A future fast-sync must be designed as one of
  > those; "rebuild from the box set" is not available and no amount of care
  > makes it so.
- **Journal-fed:** The per-block mutation set fed to the prover is derived from
  the block journal (see Invariants → Block application journal), with
  intra-block insert+remove pairs for the same boxId netted out
  deterministically. Inserted box bytes come from the journal's recorded box,
  never a store re-fetch
- **Canonically ordered (M-12):** the AVL digest is insertion-order-sensitive,
  so every prover feed is sorted before the operations run: the per-block net
  set applies all removes then all inserts, each sorted lexicographically by
  hex boxId, and the startup bootstrap feeds the unspent set sorted by boxId
  as well. Two nodes holding the same box set — whatever order their rows
  arrived in — always compute the identical digest
- **Rejection-safe:** A rejected block leaves the prover at its pre-block
  digest, whatever stage the rejection happened at — the apply funnel
  snapshots the digest before any mutation and restores it on every rejection
  path, including the totality catch. A failed reorg likewise leaves the
  prover at its pre-reorg digest (SQLite rollback restores the storage rows
  but cannot reach the prover's in-memory state — the reorg restores it
  explicitly)

### 3. Stumps (Binding Layer)

A stump is what remains after a post subtree is pruned: a compact record
that the subtree existed and was settled. The stump itself carries no
signature — authorization lives in the PruneEntry (author-signed, verified
at block application), and a stump is a **local projection of that verified
entry**, derived independently by every node when the prune settles. No
stump is ever accepted from the network: a gossiped stump would be
unverifiable by construction (no signature, no `subtreePostIds` to check),
so the table stumps live in is written by block application alone.

```
Stump {
  rootPostHash: PostId
  authorId: UserId
  replyCount: number
  upvoteCount: number
  trigger: "author" | "storage_prune"
  protocolVersion: number
  compactedAtBlockHeight: number
}
```

#### Prune lifecycle

1. Author's client walks reply subtree locally, builds Merkle root over
   postIds
2. Author signs `blake2b512(rootPostHash || subtreeMerkleRoot).subarray(0,32)`
   with their Ed25519 key
3. Client submits signed PruneIntent to node via `POST /posts/:id/prune`
4. Node verifies signature, subtree completeness, and Merkle root
5. Node enqueues PruneEntry in mempool — included in next ordering block via
   `SubBlockTree.pruneEntries`. Nothing else leaves the node: the prune
   propagates only inside the block that carries it
6. At block application, every node independently verifies: authorship
   binding (`authorId` equals the `block_topology`-recorded author of the
   root; unconfirmed roots are not prunable), Ed25519 signature, postId set
   against block_topology, Merkle root, then settles UTXO deterministically
   (consumes the subtree's PostLockBoxes, mints `prune-refund-author` karma,
   deletes the subtree's like-records — journalled; P2-D)
7. The simplified Stump is inserted, derived from the verified entry —
   unconditionally, so a node holding no DAG content records the same
   stump — then DAG content is pruned when present

No validator attestation is needed — the author's signature authorizes the
prune, and the settlement is deterministically computable from UTXO state.

#### Cryptographic guarantees

- Settlement is deterministic from UTXO state + block's PruneEntry — any node
  can verify independently without DAG content
- The author's signature over `(rootPostHash, subtreeMerkleRoot)` in the block
  is the single point of authorization, and "the author" is pinned by
  consensus: `PruneEntry.authorId` must equal the author recorded for the
  root in `block_topology` (carried by `SubBlockEntry.author`, verified
  against real content by every node that holds it at confirmation time)
- A node that held the full subtree can verify the Merkle root against the
  original content
- Parent hashes remain valid — a reply referencing a pruned post still has a
  valid `parentRefs` entry; the parent is just a stump now

---

## Identity

An account is a cryptographic keypair. There is no separate registration step.

```
UserId = hex(publicKey) — 64 hex chars, raw Ed25519 key bytes
```

An account comes into existence the first time it appears in a committed UTXO
box (via invite claim, genesis committee allocation, or credit receipt). There
is no "account table" — identity is derived from key material and visibility
on the ledger.

### Username claims

> ⚠ **SUPERSEDED (user decision, 2026-08-06) — usernames are NOT claim posts. Verified
> 2026-08-11: no `username` code exists in any `src` tree, so nothing was built against the
> superseded model.**
> The first-claim-wins, post-based, prune-to-release model described below is replaced by a
> **UTXO asset**: a username is **tradeable for credits**, **free to claim while unused**,
> and **burnable by its owner**. Nothing in this section survives that change — the claim
> post, the DAG walk, and prune-to-release are all artefacts of the post-based model.
>
> **Deferred — "way down the line."** Do not build, and do not design it further here; it
> lands in the economics track when it is picked up, since a credit-denominated asset class
> is an economic mechanism rather than a DAG one.
>
> Two consequences worth recording now:
> - **The `Post.type` dependency is void.** A previous version of this marker said username
>   claims required a post discriminator that does not exist. Under a UTXO asset they are
>   not posts at all, so no post-typing change is implied and no post ids move.
> - **`docs/site/architecture` still publishes the old model** ("Usernames and profiles are
>   DAG-native — they're just posts. A username is claimed first-come-first-served and can
>   be released by pruning the claim"). That page is normally authoritative; here it is
>   stale and needs correcting. See the Phase 1 plan's `docs/site/` disclosure item.
> - **Profiles are NOT superseded — they stay DAG-native** (user, 2026-08-06: "a profile
>   would indeed be a *self post*"). Only usernames leave the post model. **The `Post.type`
>   dependency therefore does not disappear, it relocates:** see §Profile root below, which
>   keys on `type: "profile"`.

Usernames are DAG-native objects using a **first-claim-wins** model:

1. An account posts a claim: `{ claim: "username", name: "@alice" }`, signed
   by the account's key
2. The first valid claim for a name string wins — the name is permanently
   associated with that account
3. Changing username: account prunes the old claim post (now a stump), posts
   a new claim. The resolver takes the most recent unpruned claim.
4. A claim is only valid if the account has nonzero karma at claim time

No expiry. No renewal. The name claim is a post like any other — it can be
pruned by its author, and pruning it releases the name.

### Profile root

> ⚠ **NOT IMPLEMENTED — intended design, zero code. Verified 2026-08-11.** Profiles **stay
> DAG-native**: a profile is a *self post* (user, 2026-08-06), unlike usernames, which became a
> UTXO asset.
>
> **Blocking dependency, live here:** the marker post below carries `type: "profile"`, and
> **`Post` has no `type` field** — nor any other discriminator (`types/src/post.ts`, `Post` is
> eight fields: content, author, parentRefs, challenge, powNonce, protocolVersion, timestamp,
> signature). So profiles cannot be built
> until post typing exists, and adding a field to `Post` enters `postFieldBytes`, which
> **moves every post id**. That makes it a protocol-breaking change that should ride with
> another id-moving change rather than go alone.
>
> This dependency was originally recorded against usernames and is void there — a UTXO asset
> is not a post. It applies to profiles instead. **Any alternative discriminator (a reserved
> parent ref, a content convention) would avoid the id move and is worth considering before
> committing to a `type` field.**

An account may post a **profile root** — a special marker post:

```
Post {
  content: ""                  // Empty
  author: UserId
  parentRefs: []               // Genesis — no parents
  type: "profile"              // Profile root marker
  ...
}
```

The profile root acts as an anchor. Child posts (with `parentRefs: [profileRootId]`)
carry profile fields:

- **Bio:** A post with `type: "bio"` and content = bio text
- **Display name:** A post with `type: "display_name"` and content = display name
- **Avatar:** A post with `type: "avatar"` referencing a content hash

The resolver collects the most recent child post of each type under the
profile root. Editing a field = new child post of that type (the old one
remains in the DAG but the resolver takes the newest).

Profile roots and their children are normal posts — they can be pruned by
their author.

### Identity resolution

```
userId → walk DAG for active username claim
       → walk DAG for profile root
       → walk DAG for latest bio/display_name/avatar child posts
       → read karma balance from UTXO set
       → read credit balance from UTXO set
```

---

## Likes

Likes live in the value layer, not the content DAG. **A like costs the liker
`LIKE_KARMA_COST` (1 karma) and it does not come back** — one-way, no unlike, no free tier.
A free like is cheap talk; a like that cost something is a signal.

### The like transaction

A like is an ordinary UTXO transaction that **burns exactly `LIKE_KARMA_COST`**, named by a
tx-level field:

```
inputs:      the liker's karma box(es) — all one owner (the liker signs)
outputs:     exactly one karma box, same owner
deficit:     sum(inputs) − output.value == LIKE_KARMA_COST     (the burn)
likeTarget:  the liked post's id — inside the signed bytes
```

**`likeTarget` and the deficit are biconditional.** `likeTarget` present ⇒ the transaction
must match this shape exactly (no other output types, exactly this deficit); `likeTarget`
absent ⇒ any karma deficit is illegal. This is the **only** karma-burning user transaction
— see §Invariants → UTXO conservation. The field sits inside the `computeTxId` preimage, so
the signature covers the target and a relay cannot re-point a like.

Like transactions ride `utxoTxIds` like every other transaction. There are no sub-block
sidecars and no standalone like pool.

**Apply-time rules** (consensus, not gateway courtesy):

- The target post must be **confirmed and live** at apply height. Likes on pruned posts are
  **rejected by stated rule**, not as an emergent property — without this rule, dropping
  like-records at prune (below) would reopen duplicate likes on stumps.
- The target's author is resolved from **`block_topology`**, never `dag_posts.author`
  (placeholder rows carry a zeroed author).
- `(liker, target)` must not already exist in the like-records — one like per account per
  post, structurally enforced: the key exists or it does not.
- Self-likes are legal and uneconomical by construction: each burns real karma and returns
  at most `(x−1)/x` of it.

Applying the transaction writes the `(liker, target)` **like-record** (journalled) and
increments the target author's like count for this block.

### Per-block accrual and settlement

There is no epoch. At the end of every block's mutation phase, for each author who received
likes in this block (ascending author-hex order):

```
total = record.likeCarry + likesThisBlock
paid  = (total / LIKES_PER_KARMA_PAYOUT) * (LIKES_PER_KARMA_PAYOUT − 1)   // integer, truncating
carry = total % LIKES_PER_KARMA_PAYOUT
```

`paid` (when > 0) is minted to the author — reason `like-payout`, subject = the raw author
key, one mint per author per block. `carry` is written back to the author's committed
`IdentityRecord` (`likeCarry`) **even when `paid` is 0**, and the record is in the
`stateRoot` — two nodes can never disagree on the next payout undetected. All integer
arithmetic; a float intermediate is a consensus fork. Per `x = LIKES_PER_KARMA_PAYOUT`
likes: likers paid `x`, the author receives `x−1`, **1 is burned** — the deflation dial.

The accumulator is **per author, not per post** (design track §1.3.1): outstanding carry is
bounded by `x−1` per identity and deferred rather than lost, and the payout is independent
of arrival pattern — the floor runs over a running total, never over a per-window group.

> **Recorded open question (design track §5.3):** whether outstanding carry counts as live
> supply. Nothing in the code reads a live-supply denominator today; decide before anything
> (decay honesty accounting, governance quorum) does.

> ⚠ **Known karma-econ item, stated rather than hidden:** `lastActivityBlock` bumps on any
> non-decay karma insert, so a `like-payout` mint resets the author's decay clock —
> "receiving karma is activity," which `karmanomics.md` explicitly rejects for likes (an
> activity reset must cost a bond, or a second account resets your clock for 1 karma).
> Redefining the activity trigger is karma-econ scope; P2-D keeps bump-on-mint semantics.

### Like-records

`(liker, targetPostId)` pairs, written only at block application. They are content-layer
consensus state (the `block_topology` tier): deterministic by replay, journalled with exact
inverses, **not** in the `stateRoot`.

- **They die with the post on prune.** Prune settlement deletes the pruned subtree's
  like-records, and the deletions are journalled so a reverted prune restores them exactly.
  History needs no live record — the burn transaction is block history and names the post,
  and the post's identity stays committed via the stump. Dedup needs none either: a pruned
  post cannot be liked (the rejection rule above).
- **They survive withdraw.** A withdrawn post (semi-stump — designed, not built) keeps its
  identity and stays likeable, so its records stay. Records follow the post.
- Growth is bounded by likes on **live** posts, not by every like ever given.

### Post karma locking

Posting still locks a bond — the anti-dodge mechanism (`PostLockBox`, amounts unchanged).
The lock is created exactly as before, by the client-built karma-lock transaction that
accompanies every post (`KarmaBox → KarmaBox + PostLockBox`) — P2-D changes only how it
vests. **Vesting moves to per-block.** At end of block, for every post that received likes
this block and has a live `PostLockBox`:

```
totalLikes      = like-record count for the post    (lifetime, on a live post)
alreadyUnlocked = originalValue − value
shouldUnlock    = totalLikes / POST_LOCK_UNLOCK_PER_LIKES                  // integer, truncating
toUnlock        = min(value, shouldUnlock − alreadyUnlocked)
```

`toUnlock > 0` consumes the box, mints that karma to the author (`postlock-unlock`), and
recreates the reduced box (`postlock-remainder`) unless fully unlocked. The formula is the
retired epoch schedule evaluated per block; posts are processed in ascending post-id order.

The guard is **`block_apply`** (renamed from `epoch_tally` — there is no epoch, and the
meaning was always "consumable only by block application"). No user transaction can spend a
`PostLockBox`.

### Like parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `LIKE_KARMA_COST` | `1n` | Karma burned by the liker per like |
| `LIKES_PER_KARMA_PAYOUT` | `5` | `x`: per `x` likes an author accrues `x−1`; 1 is burned |
| `POST_LOCK_THREAD_COST` | `5n` | Karma locked for new threads |
| `POST_LOCK_REPLY_COST` | `3n` | Karma locked for replies |
| `POST_LOCK_UNLOCK_PER_LIKES` | `10` | Every N lifetime likes unlocks 1 karma |

All universal constants — never per-network (§Network Identity: compress time, never
economics). Values are placeholders until the constants session pins them.

**Retired, do not rebuild — names reserved, never reuse:** `LikeBox` and the boxType string
`'like'` · the `likebox` and `epoch` Merkle leaf domains · the `epoch_tally` guard string ·
the free-like tier (`dag_likes` rows as likes) · unlike and every refund path · the epoch
interval and `EPOCH_BLOCKS` · `LIKE_COST` · `LIKE_THRESHOLD` · `LIKE_MAX_AUTHOR_REWARD` ·
`LIKE_FREE_THRESHOLD`.

---

## Invite System

The network is invite-only. An existing account must vouch for every new
account. Invites are hash-locked karma boxes — the invitee doesn't need a
keypair until they're ready to claim.

### Invite creation

Alice creates an invite for Bob:

1. Alice generates a random secret `s`
2. Alice gives `s` to Bob out of band
3. Alice constructs a UTXO transaction:

```
Consume: Alice's karma box (K karma)

Create:
  1. Alice's remaining karma box:  K - N - D
  2. Invite karma box:             N karma
     Guard: H(s_preimage) == H(s) ∧ recipient_pubkey not already an account
     (Bob claims by revealing s and his pubkey)
  3. Bond box:                     D karma
     Guard: Alice's signature
     Unlock conditions:
       ├── Bob.karma ≥ INVITE_KARMA_THRESHOLD within probation → Alice claims
       ├── Bob.karma < KARMA_POSTING_MINIMUM during probation      → burned
       └── Probation expires (block H + INVITE_PROBATION_BLOCKS)  → Alice claims
```

The invite is a bearer instrument — anyone holding `s` can claim it. Bob can
pass `s` to Carol if he chooses not to join.

The node implements this as a two-phase **commit → claim**: the invitee first
commits, binding their public key to the bond, then claims. The bond-commit
guard requires a **valid signature from the committed public key**, so revealing
the preimage `s` alone does not authorize a commit and a commit cannot bind a
key the committer does not control (audit H-2). This does **not** remove the
bearer front-run: because `s` names no specific invitee, an observer who learns
`s` can commit under their own key. Binding the invite to a specific invitee at
creation — which would close the front-run — is deferred to the karma-econ
emission-model design (the same track that owns bond settlement).

### Invite claim

Bob generates a keypair, then constructs a claim transaction:

```
Consume: Invite karma box (N karma, guarded by H(s))
         (Bob reveals s as preimage, provides his pubkey as recipient)

Create:
  1. Bob's karma box: N karma (Bob's first box — account exists now)
```

### Invite cancellation

Alice may cancel an unclaimed invite at any time:

```
Consume: Invite karma box (N karma, guarded by Alice's signature)

Create:
  1. Alice's karma box: Alice's current karma + N (return)
```

The bond box is also reclaimable by Alice if the invite is canceled (the bond
is tied to the invite — cancelling the invite cancels the bond).

### Bond outcomes

| Scenario | Bond karma | Significance |
|----------|------------|--------------|
| Bob reaches `INVITE_KARMA_THRESHOLD` within probation | Returned to Alice | Alice vetted a good member |
| Bob's karma drops below `KARMA_POSTING_MINIMUM` during probation | Burned | Alice vouched for a bad actor |
| Probation expires without Bob reaching threshold | Returned to Alice | Bob was fine, just didn't cross the threshold |

**Enforcement status (P2-B phase 1).** The two "returned to Alice" rows are
consensus rules in their spend-time form: a committed bond spends only to a
karma box **owned by Alice**, when probation has expired or Bob's current
summed karma meets the threshold (NODE_INTERFACE → "Bond transition rules").
The **burn row is not implemented and has no legal transition** — "dropped
below during probation" is a historical predicate needing per-block bond
scanning, and the karma-econ vesting design (design track §1.2) replaces bond
settlement wholesale, so the scanner would be built for deletion. Until that
lands, a bond is never destroyed; the paragraph below describes the *intended*
economics, not running code.

Burned karma is permanently destroyed — not redistributed. This creates
deflationary pressure on karma supply and makes invite decisions consequential.

### Invite parameters

| Parameter | Description |
|-----------|-------------|
| `MAX_PENDING_INVITES` | Maximum concurrent unclaimed invites per account |
| `INVITE_MIN_KARMA` | Minimum karma transferred in an invite (= `KARMA_POSTING_MINIMUM`) |
| `INVITE_BOND_KARMA` | Karma deposit locked during probation |
| `INVITE_PROBATION_BLOCKS` | Probation window in blocks |
| `INVITE_KARMA_THRESHOLD` | Invitee's karma target for early bond return |

---

## Validators

> ⚠ **NOT IMPLEMENTED as described — 35 lines, 100% original 2026-07-20 text, written
> before any of it existed. Verified 2026-08-11.** Block production works, but the "validator"
> as a *distinct role* with the responsibilities enumerated below is not a thing the code has:
> `NODE_ROLE` is parsed as a config mode in `node/src/config.ts` and gates whether
> `MINING_SECRET` is required — it is a node mode, not a separate class of participant with
> its own lifecycle. Read this as design intent and verify every claim against
> `MINING_INTERFACE.md` and `block-creator.ts` before relying on it.
>
> The one part that is real and load-bearing: the **validator signature** on ordering
> blocks is verified on every apply path (audit H-1, confirmed).

Validators secure the network via Proof of Work. They are distinct from users.

### Responsibilities

1. Produce ordering blocks — batch sub-blocks, order UTXO transactions
   (per-block like settlement runs inside block application, not here)
2. Earn newly minted credits as ordering block rewards
3. Anchor the sub-block chain via Merkle tree digest in each ordering block

Validators do **not** attest to stumps. The prune authorization is the root
author's signature alone.

### Selection

Validator selection is purely PoW-based — no stake, no karma gating. Any node
that solves the ordering block PoW puzzle may produce the next ordering block.
This keeps the consensus layer independent of the social and economic layers.

### Rewards

Validators earn credits for each ordering block produced. Credits are freely
tradeable — validators may sell them to users.

> ⚠ **`ORDERING_BLOCK_REWARD_CREDITS` does not exist, and "a flat protocol parameter" is
> the wrong model.** This document states the emission twice, in two incompatible forms —
> a flat per-block reward here, and Ergo-style linear decay with a treasury split in
> §Implemented (v2). The second is right.
>
> **The reward is `computeBlockReward(height)`** — a fixed-rate period, then linear decay
> per epoch, specified in `MINING_INTERFACE.md`. **Emission terminates** (decision
> 2026-08-06, Ergo shape, decay to zero, no tail); the perpetual security budget comes from
> **fees and storage rent**, which are recycled rather than minted.
>
> ⚠ **The code does not yet terminate** — it floors at `CREDIT_TAIL_REWARD` and mints
> forever. Phase 2. **Every total-supply figure currently in the repo is wrong**, including
> `MINING_INTERFACE.md`'s ~453.9M.

### Separation from users

A validator may also hold a user account (karma, posts) but the roles are
cryptographically and economically independent. A validator's block reward
credit box and their user karma box are separate UTXO entries controlled by
separate keys if desired.

---

## Genesis

> ⚠ **NOT IMPLEMENTED — 22 lines, 100% original 2026-07-20 text, and it ships in a state
> that cannot run. Verified 2026-08-11, every limb.** `GENESIS_COMMITTEE_KEYS` is `[]`
> (`types/src/constants.ts`) and **all three network profiles freeze it empty**
> (`types/src/network.ts` — mainnet, testnet, devnet alike). **Nothing fails loudly if a chain
> starts with an empty committee** — a search for any startup assertion on committee emptiness
> returns nothing — so the two-phase model below silently has no phase one. Committee
> dissolution is likewise unimplemented: `BOOTSTRAP_PERIOD_BLOCKS` and `bootstrapPeriodBlocks`
> appear **only in `types/src`**, with no reader anywhere in `node/src` (carried register #19).
>
> **Genesis is where an unset consensus parameter is least recoverable** — it is baked into
> the first block and every state root after it. Before any launch: decide the committee
> set, decide whether an empty committee is a startup failure, and pin both. This belongs
> with the constants-pinning session, not to be defaulted into.

Bootstrap uses a **two-phase genesis committee** model:

1. The genesis ordering block mints N karma boxes and M credit boxes,
   assigned to a small set of known genesis committee public keys
2. The committee's sole purpose: invite the first cohort of users and
   bootstrap ordering block production
3. After `BOOTSTRAP_PERIOD_BLOCKS`, all remaining genesis committee karma is
   burned and genesis committee credit boxes are distributed to early
   validators (proportional to blocks produced)
4. The committee dissolves — no permanent genesis class

| Parameter | Description |
|-----------|-------------|
| `GENESIS_COMMITTEE_KEYS` | List of public keys in the genesis committee |
| `GENESIS_KARMA_PER_MEMBER` | Initial karma per committee member |
| `GENESIS_CREDITS_PER_MEMBER` | Initial credits per committee member |
| `BOOTSTRAP_PERIOD_BLOCKS` | Blocks before committee dissolution |

---

## Deploy gate — the standing chain-reset requirement

> This section is new as of 2026-08-09. The requirement itself is not: it has been in force for
> months, but was recorded **only** in a gitignored working file that carries its own warning about
> being unreliable. An operational rule whose violation forks the network belongs in a contract.

**A deployed node must start from a fresh chain with a wiped AVL store** whenever any committed byte
has changed since it was deployed. Every one of the following moved committed bytes and is already
outstanding against the live node, which still runs a pre-Spec-B chain:

| Change | What moved |
|---|---|
| P0 | box values (bigint) |
| P1 | journal shape |
| P2 | AVL tree shape |
| P3 | `stateRoot` semantics |
| Spec G | box ids (provenance-derived) |
| P2-D | sub-block and block-body CBOR shape, post-lock box ids |
| **positional wire format** (Phases 0–8, shipped 2026-08-11) | **every committed byte** |

> ⚠ **Wiping the AVL store alone is a fork trigger. Wipe chain and AVL store together, always.**
>
> The reasoning was corrected on 2026-08-07 and the correction matters. This used to be justified by
> a rebuild path (`bootstrapAvlProver`) that reconstructed the tree from state the headers no longer
> commit to. That path is **dead** under `@ergots/avltree` 0.4.0 — the prover constructor writes the
> empty-tree version to empty storage, so its `storage.version() === null` trigger is statically
> false, and a lone wipe leaves the node running on an **empty tree**. It is also **unsound in
> principle**: AVL+ shape is history-dependent, so a re-inserted set matched a live tree's digest in
> only 6 of 10 measured rounds. The persisted tree (an ordinary restart) is the only sound resume;
> journal replay is the only other sound option and is unbuilt.

**A fresh `MINING_SECRET` is also required** — the previous value is burned in public git history.

Nodes are cheap to reset today because there is one. **Every item in this table becomes a hard fork
the moment a second node exists**, which is the reason format-breaking work is sequenced to land
before multi-node operation rather than after it.

---

## Data Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────────┐
│   web    │────►│   node   │────►│   net    │     │  types   │◄────│  validation  │
│ (client) │     │ (server) │     │ (gossip) │     │ (shared) │     │  (pure fns)  │
└──────────┘     └────┬─────┘     └────┬─────┘     └──────────┘     └──────────────┘
                      │               │
                      │               ▼
                      │          ┌──────────┐
                      │          │   wire   │
                      │          │ (codec)  │
                      │          └──────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌─────────┐ ┌──────────┐
     │  Posts  │ │  UTXO   │ │  Mempool │
     │   DAG   │ │ Ledger  │ │ (pending)│
     └────┬────┘ └────┬────┘ └────┬─────┘
          │           │           │
          └─────┬─────┘           │
                ▼                 ▼
          ┌──────────┐     ┌──────────┐
          │  Stumps  │     │ Ordering │
          └──────────┘     │  Blocks  │
                           └──────────┘
```

1. **Genesis:** Committee mints initial karma/credit boxes
2. **Invite:** Committee invites first users via hash-locked invite boxes
3. **Account creation:** Invitee claims invite with keypair → karma box exists
4. **Posting:** User requests challenge from node, constructs post, solves
   PoW → sub-block + karma-lock UTXO tx → mempool (batch-linked by postId)
5. **Liking:** User spends karma → like box UTXO tx → mempool (standalone)
6. **Ordering:** Block creator pulls from mempool (FIFO), assembles block with
   sub-blocks + UTXO txs (likes included), mines PoW, finalizes → state
   applied atomically
7. **Like settlement:** Every block, at the end of the mutation phase — like
   burns recorded, per-author accrual settled against `IdentityRecord.likeCarry`
   (`like-payout` mints), post-lock vesting evaluated (§Likes)
8. **Pruning:** Author signs prune intent → stump constructed with deterministic
   karma deltas → committed in ordering block → DAG compacted
9. **Vouch cooldown:** Every block, matured vouch cooldowns release escrowed karma
   back to the voucher via mintKarma
10. **Net:** libp2p gossips sub-blocks, ordering blocks, and UTXO transactions.
   Stage 1 (stateless) validation via `@dagsocial/validation` runs before
   forwarding. Stage 2 (stateful) validation runs in the node after receipt.
   Relay handlers insert into mempool — state applied at block application.

---

### Wire Format

Stream messages are framed: `[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]`. Gossip
bodies are positional for sub-blocks and ordering blocks, and CBOR for UTXO transactions and stumps —
see the marker below. The normative per-struct layouts live in `TYPES_INTERFACE.md` → Serialization,
not here. Wire-codec types (ByteReader, ByteWriter, VLQ) live in `@dagsocial/wire`.

> ⚠ **PARTIAL — the migration this marker predicted has SHIPPED except for two encoders.
> Re-verified 2026-08-11.** It read `AHEAD OF CODE` until Phase 9; the positional bundle
> (Phases 0–8) is merged, so the forward-looking framing was stale.
>
> **Positional today:** gossip decodes sub-blocks and ordering blocks through `decodeSubBlock` and
> `decodeOrderingBlock` (`net/src/gossip.ts:78`, `:97`), which are the positional decoders.
> **Still CBOR:** `encodeTx`/`decodeTx` (`types/src/serialization.ts:522-528`) and
> `encodeStump`/`decodeStump` (`:164-170`) are bare `cbor-x`, so the gossip UTXO-transaction path
> (`gossip.ts:136`) and every stump still travel as CBOR. **No phase claims these two** — carried
> register #6.
>
> ⚠ **The old headline said "gossip stops being CBOR" while its own body said CBOR survives in
> net's transport framing.** Both halves were written at once and contradicted each other; the
> resolution is the split above — per *message type*, not per *layer*.
>
> Per `docs/specs/2026-08-09-positional-wire-format.md`.
>
> **Every consensus preimage becomes a positional byte layout** built on `@dagsocial/wire` — the
> normative per-struct tables live in `TYPES_INTERFACE.md` → Serialization. CBOR is retired from
> every committed byte. It survives only where nothing is committed: local storage (the journal,
> mempool blobs) and P2P transport framing in `net`, both explicitly out of scope.
>
> **The principle, and why CBOR could not satisfy it: the serializer is the validator.** A CBOR map
> is open by default — unknown keys, key reordering, duplicate keys, indefinite-length forms and
> non-minimal integers all decode to one struct from different bytes. Measured on the pre-migration
> tree: an ordering block carrying arbitrary extra keys produced a byte-identical `blockHash` while
> the encoding differed by 395 bytes. A positional format makes unknown keys *unrepresentable* and
> gives key order no existence, which is a structural guarantee rather than a check somebody has to
> remember to run.
>
> **Determinism gains a definition it did not have.** The invariant "the same value always produces
> the same bytes" was true only of a particular library build: `cbor-x` emits non-canonical CBOR
> (uint16 map counts where the shortest form is immediate), so the consensus format was *"whatever
> `cbor-x` 1.6.4 emits"* — unwritable as a specification, and already reverse-engineered by hand once
> in the demo UI. After this, the format is a byte layout an independent implementation can be
> written against, which is the precondition for the light-client and browser-extension tracks.
>
> **Layering — done, verified 2026-08-11.** `@dagsocial/types` depends on `@dagsocial/wire`
> (`packages/types/package.json:21`), so wire is no longer net-only: it is the base codec layer, and
> its writers produce box ids, tx ids, post ids, Merkle roots and the `stateRoot`. It keeps zero
> dependencies. See `WIRE_INTERFACE.md`.
>
> ⚠ **`@dagsocial/wire` is still described as "stream framing" outside this file** — `CLAUDE.md:26`
> and `README.md:318`. That description predates the layering change and now understates the package.
> Both are root-level files, not contracts. (`NET_INTERFACE.md:14` also says "stream framing", but
> correctly: it describes what *net* uses wire for, not what wire is.)

---

## Network Identity

> ✅ **RESOLVED — the reason changed three times and the last one has now closed too. Verified
> 2026-08-11.** It read `PARTIAL` until Phase 9.
>
> The history, because each step retired a different justification: (1) "one of the three
> commitment layers remains" — that layer was **withdrawn by decision**, so the commitment table
> is complete at two layers. (2) The *selection* half then held it open on the grounds that
> **nine consensus parameters were still independently environment-readable** — false since P2-A
> (PR #8, `4670ae5`) removed all ten, verified 2026-08-07 (`NODE_INTERFACE §Configuration`).
> (3) It was then held open by a **bypass** — profile fields read as module constants instead of
> from the profile. **That is now closed as well.**
>
> **Method, so this is refutable:** every `readonly` field name was extracted from
> `types/src/network.ts` and each tested for a `profile.<field>` read in `node/src/config.ts`.
> Every real field is read from the profile except four — `bootstrapPeriodBlocks`,
> `genesisCommitteeKeys`, `genesisKarmaPerMember`, `genesisCreditsPerMember` — which have **no
> reader anywhere in `node/src` at all**. That is *unbuilt*, not *bypassed*: they serve the
> committee machinery §Genesis marks `NOT IMPLEMENTED`. A field nothing reads cannot diverge
> from the profile; it equally cannot be relied on. Carried register #19 tracks them, and this
> pass reproduced its four independently.
>
> **Built.** `NETWORK_TYPE` selects a `NetworkProfile` that carries the wire magic and every
> consensus parameter together; an unrecognised value throws at startup. `NetConfig.magic` is
> **required**, and the ten `?? MAGIC_MAINNET` fallbacks (nine in `node.ts`, one in
> `sync-machine.ts`) are deleted, so a missing magic is a compile error at the single
> construction site. Ten consensus parameters stopped being environment-readable. The
> transport layer of the commitment table below therefore works: networks no longer assemble
> each other's frames.
>
> **The defect this marker originally described was worse than it recorded.** `NETWORK_MODE`
> did not merely fail to reach `net` — **every node framed as mainnet on every network,
> unconditionally**, because the contract said `magic: number` while the code said `magic?:
> number` and node never passed it. A second, undocumented selector (`NETWORK_MAGIC`,
> defaulting to *testnet*) existed in dead code. Both are gone.
>
> ✅ **The third layer was withdrawn, not deferred — 2026-08-10.** This marker used to read
> "not built: the block layer", pending a `networkType` header field in P2-C. **That field is
> rejected** (`TYPES_INTERFACE` → Block header). A cross-network block is rejected by the
> transport and chain layers, and those two were shown to cover every case the third would
> have — so there are **two commitment layers by decision**, and this section is complete
> rather than partial on that axis.

A network is the pairing of a **parameter profile** with a **genesis block**. Three exist:

| Network | Purpose | Wiped on |
|---|---|---|
| `mainnet` | The real chain | Never |
| `testnet` | Public, used, non-breaking changes | Deliberate relaunch only |
| `devnet` | Local and disposable; protocol-breaking changes | Freely |

The taxonomy and the purpose split are Ergo's (`ergo.networkType`, with testnet for
non-breaking and devnet for protocol-breaking testing). The third network is **not** called
`regtest` — that is Bitcoin's word for a different thing.

### Selection

One setting, `NETWORK_TYPE`, class `network-identity`, names the whole profile. It is the
only environment variable that may change a consensus parameter, and it does so by selecting
a table rather than by setting a value. **Two operators who differ on it are on different
networks; two operators who agree on it cannot differ on anything below it.** That is the
property the class exists to guarantee, and it is why individual consensus parameters must
not be independently readable.

> ✅ **The count that stood here — "nine of them are today" — was stale; corrected 2026-08-10.
> It is zero.** P2-A removed all ten consensus values from the environment (PR #8, `4670ae5`),
> five to the profile and five to universal constants, verified 2026-08-07 that none is read
> anywhere in `packages/node/src` (`NODE_INTERFACE §Configuration`). The guarantee is still
> broken, but by a **bypass rather than a read** — see the note under §Network identity.

### What varies per network, and what must not

**Per-network — the timescale, difficulty and genesis axes:**
`ORDERING_BLOCK_POW_TARGET_BITS` · `POST_POW_TARGET_BITS` · `KARMA_DECAY_INTERVAL_BLOCKS` ·
`KARMA_STALE_THRESHOLD_BLOCKS` · `VOUCH_COOLDOWN_BLOCKS` · `INVITE_PROBATION_BLOCKS` ·
`CREDIT_MINER_REWARD_DELAY` · `BOOTSTRAP_PERIOD_BLOCKS` · `CREDIT_FIXED_RATE_BLOCKS` ·
`CREDIT_EPOCH_BLOCKS` · `GENESIS_COMMITTEE_KEYS` · `GENESIS_KARMA_PER_MEMBER` ·
`GENESIS_CREDITS_PER_MEMBER` · `TREASURY_PUBKEY`

**Universal — every other constant, including consensus ones:** the format limits
(`MAX_CONTENT_BYTES`, `MAX_PARENT_REFS`, `PROTOCOL_VERSION`, `AVL_KEY_LENGTH`) and **every
karma and credit cost** (`LIKE_KARMA_COST`, `LIKES_PER_KARMA_PAYOUT`, `POST_LOCK_*`,
`VOUCH_KARMA_AMOUNT`, `INVITE_*`, `KARMA_MINIMUM`, `KARMA_DECAY_AMOUNT`,
`CREDIT_TREASURY_PCT`, `CREDIT_INITIAL_REWARD`).

**The split is normative: compress time, never economics.** Every per-network parameter is a
place where devnet and mainnet behave differently, which is precisely where a defect hides
from the test written to catch it. A test chain needs a 3-block decay interval; it does not
need cheaper likes. **Adding a parameter to the per-network set weakens every test that runs
on devnet** — the burden is on the addition, not on keeping the set small.

### How the network is committed

**Two** mechanisms, which fail differently and are listed in the order a foreign object meets
them. A third — a `networkType` field in the block header — was specified here and **rejected
2026-08-10**; the note after this table records why, because it has been proposed twice.

| Layer | Mechanism | What a cross-network object does |
|---|---|---|
| **Transport** | Wire magic selected by the profile | Never assembles as a frame; peers do not connect |
| **Chain** | Distinct genesis per network | Cannot link; its input boxes do not exist here |

**The chain layer is what makes the networks genuinely separate**, and it is doing more work
than it appears to. A transaction's inputs are boxes whose id chains root at genesis, so a
mainnet transaction replayed against testnet names inputs that **do not exist** — replay
fails on the UTXO graph, without any network check. The magic is the early rejection; genesis
is the one that cannot be circumvented.

> **Id derivation is deliberately NOT network-scoped.** An earlier draft of this section
> scoped the five domain tags (`BOX_ID_DOMAIN`, `TX_ID_DOMAIN`, `MINT_ID_DOMAIN`,
> `IDENTITY_KEY_DOMAIN`, `POST_ID_DOMAIN`) by network. **Dropped 2026-08-06**, for two
> reasons.
>
> **It conflicts with a load-bearing invariant.** `@dagsocial/types` is contractually pure —
> "no side effects, no module-level state" — and five packages derive consensus bytes from
> it. Network-scoped tags force either module-level state in that package or a network
> argument on every derivation. Module-level state is the config-read-at-a-distance defect
> this whole section exists to remove, wearing a different hat.
>
> **The analogy that motivated it was wrong.** It was argued as the structural equivalent of
> **Ergo's address prefix** (`0x00` mainnet, `0x10` testnet). It is not: an address prefix is
> a *serialization* concern — how a pubkey is rendered and parsed by a wallet — and **Ergo's
> own box ids and transaction ids are network-agnostic content hashes.** Scoping id
> derivation would have gone beyond Ergo, not matched it.
>
> **What this concedes:** cross-network **post** replay. Posts are DAG objects, so a mainnet
> post carries a valid signature and valid PoW onto devnet unchanged. Transaction replay is
> already impossible via the chain layer above; the accompanying karma-lock transaction fails
> regardless. This is a spam and confusion vector, not a value defect, and it is accepted.

> ⛔ **A `networkType` header field was proposed twice and is REJECTED — 2026-08-10,
> reversing 2026-08-06.** It was never implemented, so nothing was removed from code. The
> full record is at `TYPES_INTERFACE` → Block header; the short form:
>
> **An attacker fills the field in correctly, for free**, so it never catches an adversary.
> Its entire population is honest misconfiguration, and both surviving layers already catch
> every member of it — p2p is gated by the magic at frame assembly, no HTTP route accepts a
> block, and an operator who flips `NETWORK_TYPE` against an existing store fails at the
> chain link because the stored genesis is the old network's. That left the field's marginal
> value as the wording of an error message, bought with a byte in every header forever.
>
> **Its stated enforcement point did not exist.** Both this section and `VALIDATION_INTERFACE`
> put the profile match "at the structure gate" — but `verifyOrderingBlockStructure` lives in
> `@dagsocial/validation`, which is contractually pure and stateless and cannot read the
> node's profile. The rule was homeless in three contracts at once, which is why nobody
> noticed it was never going to run.
>
> **This restores agreement with Ergo**, whose header also carries no network field:
> `version`, `parentId`, `ADProofsRoot`, `stateRoot`, `transactionsRoot`, `timestamp`,
> `nBits`, `height`, `extensionRoot`, `powSolution`, `votes`. The previous note recorded
> Notis's extra field as a deliberate divergence so it would not be "corrected" by someone
> checking Ergo — that concern is retired along with the field.
>
> **What would reopen it:** a consumer that must reject a foreign header *without* the chain.
> Light clients and NiPoPoW proofs both anchor at genesis by construction, so neither
> qualifies. A third proposal needs a consumer that genuinely does.

### Sequencing

**Nothing in this section is format-breaking any more.** This paragraph used to sequence the
`networkType` header field into the P2-C consensus-format break bundle, because adding a header
field changes `blockHash` and the PoW preimage. With that field rejected (see above), the profile
table, the environment reads and the magic selection are all that remain here — none of them touch
a committed byte, and none of them need to wait for a break bundle.

---

## Protocol Versioning

Every post, stump, ordering block, sub-block, and UTXO transaction carries a
`protocolVersion` field. Validation rules are keyed to this version:

- **Version 1 (current):** Dual-ledger architecture, sovereign subtrees, stumps,
  UTXO karma/credits, likes, invite system, sub-blocks + ordering blocks, PoW
  validators, libp2p networking, two-stage validation (`@dagsocial/validation`
  + `@dagsocial/net`), unified mempool.
- **Future versions:** Credit sinks, reply earning, karma-proportional PoW,
  storage pruning, view keys.

An object with an old version is validated against that version's rules
forever. A node rejects objects with an unsupported protocol version.

> ⚠ **NOT IMPLEMENTED — the second sentence is true, the first is not. Verified 2026-08-11.**
> There is **no version-keyed rule table and no dispatch**. Validation is a **strict equality
> check against `PROTOCOL_VERSION`** at all four sites that test it — `verifier.ts:142` and
> `:244` (posts), `utxo-engine.ts:987` (transactions), `block-apply.ts:268` (block headers),
> every one of them `!== PROTOCOL_VERSION`. So rejecting unsupported versions works, while
> "validated against that version's rules forever" describes a mechanism that was never built.
>
> **The consequence is worse than a missing feature: the first version bump makes existing
> history un-resyncable.** Under strict equality a v2 node rejects every v1 object,
> including the chain it already has — so the migration path the versioning scheme exists
> to provide is exactly what it cannot do. This must be built **before** the first bump,
> not during it.
>
> The design stands and is published as how the protocol evolves. **This claim appears in
> four places** — here, `CLAUDE.md` (auto-loaded into every session), `docs/site/architecture`
> (published), and `VALIDATION_INTERFACE.md`. Only `VALIDATION_INTERFACE.md` describes what
> the code does. **If this is built, all four change together.**

---

## Invariants

> ⚠ **Every invariant below was verified individually against the code on 2026-08-06.**
> **48 invariants: 21 true · 15 false · 4 unenforced · 5 qualified · 1 never built.**
> A false invariant is marked in place — **none has been weakened to match the code**,
> because the rule is what Phase 2 has to build. An unmarked invariant is verified true.
>
> The distribution is not random and is worth knowing before trusting any of them: of the
> 21 true, **six are the Block Application Journal block** (written 2026-08-04, *after* its
> implementation) and five are the bigint/value-denomination and guard/decay rules Specs B
> and G touched. Of the 15 false, **ten are July text**, and **all ten Ergo-Adopted bullets
> are July text** — six false, three unenforced or qualified, one true.
>
> Full per-invariant verdicts with sources: `prompts/audit-architecture.report.md` §3a.

### Cross-layer

- Karma is non-tradeable — only moves via invites, likes, earning, decay, or burn
  > **Holds since P2-D** (previously the most load-bearing false invariant in the
  > document — five transfer routes existed). The rule is the premise the karma↔credit
  > firewall rests on, asserted in four places here and on two published pages. The fifth
  > and final route (like-then-unlike moved karma to an arbitrary recipient) closed by
  > feature removal: unlike is not a feature and `LikeBox` no longer exists.
  >
  > **Closed by P2-B (4):** the committed invitee spending the BondBox to their own karma box
  > (phase 1 — settlement now pays only `bond.inviterId`, under a spend-time unlock, and no
  > burn shape exists); unvouch re-minting a constant instead of releasing the stake (phase 2);
  > a vouch cast carrying a **foreign `voucherId`**, which produces a box guarded by that
  > foreign key — `checkGuards` resolves a signer as `owner ?? voucherId` — so A stakes and B
  > collects (phase 2); and **karma inputs never being checked for a shared owner**, so
  > `[karmaA, karmaB] → karmaA` moved karma between accounts whenever both co-signed
  > (phase 4).
  >
  > ⚠ **The last two were not in the audit, and neither closes with P2-D.** This entry
  > previously said the violation was three routes with the most severe "entirely in the
  > unlike path" — that framing was wrong and cost nothing only because the extra routes were
  > found by accident while implementing. **Do not read "closes by feature removal" as "the
  > class is handled."**
- Credits are freely tradeable
  > ✅ **RESOLVED — closed by P2-B phase 3, re-verified 2026-08-11.** `sendCredits`
  > (`node/src/services/credits.ts`) validates the client's transaction and then calls
  > `insertUtxoTx`, which is `INSERT INTO mempool … VALUES ('utxo_tx', …)` in
  > `node/src/store/mempool.ts`;
  > it returns `status: 'pending'` and the route broadcasts. Every remaining `consumeBox` /
  > `insertBox` caller is block application, revert, or genesis bootstrap — none is reachable
  > from a route. *Historical:* it mutated the UTXO set **outside block application** — no
  > block, no journal entry, no AVL feed — so a transfer lived on one node's disk, invisible
  > to consensus and lost on any rebuild from committed state.
- A post's cryptographic identity (hash) survives pruning — parent refs remain valid
- The DAG's merkle integrity is independent of content availability
- The UTXO ledger's correctness is independent of the DAG's index state
  > **Holds since P2-D** (was FALSE AS DESIGNED: the epoch tally's author reward read a
  > `dag_likes` row count — a DAG index read inside a consensus mutation). Settlement now
  > reads the per-identity `likeCarry` in the `stateRoot` and `like_records` — consensus
  > state written only at block application (`block_topology` tier), never by a route.
- Stumps are the sole bridge: DAG compaction → karma issuance
- A like is a burn transaction plus a `(liker, post)` like-record — no box, no held
  value. Like-records are content-layer consensus state (`block_topology` tier):
  deterministic by replay, journalled with exact inverses, deleted with the post at
  prune, not in the `stateRoot`. (`LikeBox` and the free-like tier are retired — P2-D.)

### Cryptographic

- Hashing: `blake2b512` truncated to 32 bytes for all 32-byte outputs
- Signatures: raw Ed25519 (64 bytes). **On the wire the encoding depends on the
  carrier, and "base64" — as this line previously read — is the rarest of the three:**
  raw bytes inside CBOR (all consensus structures), **lowercase hex** at the HTTP
  boundary (`json-to-tx.ts`) and in the demo UI, and base64 at exactly one endpoint
  (`routes/utxo.ts`). Verification is `crypto.verify(null, …)` with a KeyObject in
  every case
  > ⚠ **Non-malleability is relied upon and stated nowhere.** Measured on node v22.19.0 /
  > openssl 3.0.17: `crypto.verify` rejects the classic `S + L` malleation and the
  > high-bit variant, enforcing RFC 8032's `0 ≤ S < L`. This matters because
  > `serializePruneEntry` puts `authorSignature` **inside** the `prune` Merkle leaf, hence
  > inside `subBlockRoot` — every other signature in the system is excluded from every
  > preimage. A second verifier (light client, a pure-JS Ed25519 library) that is
  > cofactored or skips the range check would accept a second valid signature, and there
  > it would mean two valid *blocks*. **Any mirror implementation MUST enforce
  > `0 ≤ S < L`.** Untested: non-canonical `R` encodings, small-order points,
  > cofactored-vs-cofactorless verification
- Public keys: 32 raw bytes, hex-encoded on wire
- Secret keys never in API responses, DTOs, or committed data structures
- Post PoW acts as sub-block proof — verified by validators at ordering time


### Content sovereignty

- Post author owns the entire reply subtree under their post
- Pruning cascades to all descendants — replying is consent to this
- Pruning requires root author's signature (sole authorization)
- Pruning is irreversible
- Future prune triggers (storage pruning) use their own auth paths

### Identity

- An account comes into existence via first UTXO box appearance
- Invite secrets are hash-locked, portable bearer instruments
- An invite can be cancelled by the inviter (before claim) or claimed by the
  preimage holder
  > ⚠ **QUALIFIED — "bearer instrument" is no longer the whole story. Verified 2026-08-11.**
  > §Invite System records that a commit now requires a signature from the committed key
  > (audit H-2), so the preimage alone is not sufficient. This bullet was not updated when that
  > landed 200 lines above it.
- Invite bonds are lost if the invitee's karma drops below the posting minimum
  during probation
  > ⚠ **VIOLATED — narrowed 2026-08-10, re-verified 2026-08-11. The failure this marker
  > described is closed; a different one remains, and it is the rule itself.** All three checks
  > it called missing exist, in `node/src/services/utxo-engine.ts`'s bond-settlement arm: the
  > settlement karma output must be owned by the **inviter** (which closes "the bond can be
  > taken by the invitee" outright), `probationExpired` requires probation to have elapsed, and
  > `thresholdMet` requires the invitee's karma to reach `INVITE_KARMA_THRESHOLD`. **All three
  > line pins here still resolved correctly** — unlike the three in §Karma decay, which had all
  > rotted.
  >
  > **What remains unimplemented is forfeiture — there is no such path at all.** Nothing burns
  > the bond when the invitee's karma drops below the posting minimum during probation.
  > Settlement returns it to the inviter once probation expires *or* the threshold is met, so
  > an invitee who never engages costs the inviter a wait rather than the bond. The rule is
  > right and stays.
- ~~Usernames: first-claim-wins, DAG-native, prunable by holder~~
  > ⚠ **SUPERSEDED (2026-08-06). Verified 2026-08-11 — no `username` code in any `src` tree.**
  > Usernames become a **UTXO asset**: tradeable for
  > credits, free to claim while unused, burnable by the owner. Not a claim post, so
  > "DAG-native" and "prunable by holder" no longer apply. Deferred — see §Username claims
  > and design track §5.9. **Profiles are unaffected and stay DAG-native as self-posts.**

### UTXO conservation

- Karma supply changes only via the mint reasons (NODE_INTERFACE's mint-reason table is
  the **authoritative enumeration** — derive from it, never maintain a parallel list here;
  a hand-kept mirror of it had already diverged once) and exactly two burns: **decay**, and
  **the like burn** — `LIKE_KARMA_COST` leaves the liker per like, `x−1` per `x` returns
  via `like-payout`, net 1 burned per `LIKES_PER_KARMA_PAYOUT` likes.
- Total credit supply = genesis + ordering block rewards - future sinks
  > ⚠ **QUALIFIED — true in shape, but "total" is currently unbounded. Verified 2026-08-11.**
  > The reward function has **no terminus**: `block-creator.ts` floors it at
  > `CREDIT_TAIL_REWARD` (`2n * 10n ** 8n`, i.e. 2 credits) and mints that per block forever,
  > while `MINING_INTERFACE.md` states a fixed ~453.9M total. Emission is
  > decided to **terminate** (Ergo shape, decay to zero, no tail — design track §5.7), and
  > every current total-supply figure in the repo is wrong until that lands.
- Every UTXO transaction conserves value, with exactly **one stated exception: the like
  transaction burns `LIKE_KARMA_COST`** — `likeTarget` present ⟺ that exact deficit (the
  biconditional; NODE_INTERFACE → legal transitions). All other mints and burns happen
  only in block-application paths, never inside a user transaction.
  > Conservation is **enforced** since P2-B (`checkValueConservation` per transaction,
  > full re-validation at apply; the unvouch and `sendCredits` violations closed in its
  > phases 2–3) — this entry's previous `⚠ UNENFORCED` marker had outlived its defect.
  > The like carve-out is enforced since P2-D N1 (the biconditional lives in the engine's
  > like arm). P2-B landing first is what made it safe to add — a deficit rule only means
  > something once conservation is otherwise enforced.
- Box `value` and all value/amount arithmetic are `bigint` integer base units
  (`value < 2⁶⁴`); **no float math in any consensus value path** — floats are
  non-deterministic across platforms and credit sums exceed 2⁵³ (Spec B P0)
- A box can only be consumed if its guard script evaluates to true
- Karma decay applied periodically at block application time (not at spend time)

### Block application journal (Spec B P1)

- **One record-once mutation log.** Block application maintains a single
  ordered journal of primitive box mutations —
  `{ op: 'insert' | 'remove', boxId, box? }` — recorded automatically at the
  store choke point (`insertBox`, `consumeBox`) while a block journal is open.
  Call sites never maintain parallel mutation bookkeeping; every box mutation
  a block makes appears in the log exactly once, in application order.
  (P2-D deleted the third choke point, `markLikeBoxesTallied`, together with
  the epoch; the like-record side-records journal through their own hooks,
  with exact inverses.)
- **Accounting-agnostic.** The log carries no per-mutation-class fields.
  Future mutation classes (invite/post bonds, one-way like accounting,
  storage rent, coinbase splits) journal through the same log unchanged.
- **Rollback replays inverses.** Reverting a block walks the log in reverse:
  `insert` → delete the box, `remove` → un-spend it. Non-box side effects
  (post confirmations, like-records, vouch-cooldown rows,
  mempool re-insertion payloads) travel as typed side-records, each with an
  exact inverse. Apply-then-revert restores the identical UTXO set and AVL
  digest for every mutation class.
- **Sole replay basis.** UTXO boxes + the journal are a complete replay
  source. No mutation or rollback may read pruned DAG content.
- **AVL feed derives from the journal.** The prover's per-block mutation set
  is computed from the journal — never from hand-maintained consumed/created
  lists (the drift source behind audit C-5/H-5/H-7).
- **Prover restored on rejection.** A rejected block leaves the AVL prover at
  its pre-block digest regardless of which stage rejected it.

### Sub-blocks and ordering

See `SUBBLOCK_INTERFACE.md` for the full contract.

- Sub-blocks are user-produced; ordering blocks are validator-produced
- Sub-blocks carry exactly one post and nothing else
- Ordering blocks anchor sub-blocks via Merkle digest
- Like dedup is structural: the `(liker, post)` like-record exists or it does not
- Like accrual and settlement happen every block — there is no epoch (P2-D)

### Network identity

> ⚠ **PARTIAL — corrected 2026-08-10, re-verified 2026-08-11. These four are NOT part of the 48 verified
> above and carry no audit verdict.** Bullets 2, 3 and 4 hold today; bullet 1 does not, and
> carries its own note.
>
> **How the text under this marker went stale is the lesson, not the staleness.** The marker
> read "nothing they describe exists yet" — so when P2-A landed the profile and PR #26 rejected
> the header field, nobody re-read the bullets. A disclaimer that tells readers the text beneath
> it is inert creates an **unreviewed region**, and unrelated changes land without propagating
> in. Bullet 2 named the rejected header field as a live separation mechanism for four days.

- **`NETWORK_TYPE` is the only environment variable that may change a consensus parameter,
  and it changes all of them together.** No individual consensus parameter is
  environment-readable. Two nodes agreeing on `NETWORK_TYPE` cannot differ on any value it
  selects.

  > ✅ **RESOLVED 2026-08-10 — satisfied for every value anything reads. Re-verified 2026-08-11
  > by re-deriving every `NetworkProfile` field and testing each for a `profile.<field>` read in
  > `node/src/config.ts`; this note's four residue fields came back exactly.** Two distinct
  > violations closed in sequence. **Environment-readability**: P2-A removed all ten consensus values from the
  > environment (PR #8, verified 2026-08-07 — `NODE_INTERFACE §Configuration`). **Bypass**: five
  > profile fields were read as module constants, so `NETWORK_TYPE` did not select them at all and
  > a devnet node ran mainnet emission, maturity, vouch-cooldown and probation timing. All five now
  > resolve through `Config` from the profile.
  >
  > ⚠ **This note was correct while §Network Identity's marker, which pointed AT it, was not.**
  > That marker held itself open on the bypass — the very thing this note records as closed —
  > and cited "the note under §Network identity" in the same sentence. **A cross-reference is not
  > a read**: the citation was carried forward while the cited text moved underneath it. Both are
  > now `RESOLVED`.
  >
  > **Residue, and it is a different class.** Four profile fields have no reader anywhere in
  > `packages/node`: `bootstrapPeriodBlocks`, `genesisCommitteeKeys`, `genesisKarmaPerMember`,
  > `genesisCreditsPerMember`. `GENESIS_COMMITTEE_KEYS` is empty on all three profiles, so the
  > committee machinery the other three serve is **unbuilt** rather than bypassed — see §Genesis.
  > A field nothing reads cannot diverge; it equally cannot be relied on.
  >
  > ⚠ **The lesson outlives the defect, so it stays: the count here read "three" for several
  > hours.** It was derived from `MINING_INTERFACE`'s configuration table, which holds *mining*
  > values — so `vouchCooldownBlocks` and `inviteProbationBlocks` could never appear in it, and
  > nothing signalled the omission. Enumerating `NetworkProfile` **itself** found all five.
  > **Never enumerate a type's fields from prose that groups them by purpose.**
- **Id derivation is network-agnostic.** No domain tag, box id, transaction id, post id or
  identity record key carries the network. `@dagsocial/types` stays pure — no module-level
  state, no network argument on a derivation function. Network separation is carried by
  genesis and the wire magic instead — **not** a header field: `networkType` was proposed
  2026-08-09 and rejected 2026-08-10 (PR #26), and `BlockHeader` has ten fields.
- **The per-network parameter set covers timescale, difficulty and genesis only.** Costs and
  format limits are universal across networks. Adding a parameter to the per-network set
  requires justifying why devnet may behave differently from mainnet in that respect.
- **The wire magic is a function of the network profile**, not a per-call-site default. A
  node cannot frame for one network while validating for another.

---

## Ergo-Adopted Invariants

These invariants are adopted from production-grade Ergo Rust node practices:

> ⚠ **This whole section is 100% original 2026-07-26 text and it is the worst-performing
> block in the document: of its ten bullets, six are false, three are unenforced or
> qualified, and one is true.**
>
> **Check the premise before adopting anything else from Ergo.** One analogy is already
> recorded as not having transferred: Ergo can leave `creationHeight` client-declared
> because nothing consensus-critical reads it, whereas here `createdAtBlock` **was** the
> decay clock, so the field had to leave the box protocol entirely and the clock moved into
> committed state. An invariant that is correct for Ergo and wrong here, kept because the
> analogy sounded right, is this section's characteristic failure — and one bullet below is
> transliterated Rust naming a hazard TypeScript does not have.

### Validation boundaries
- **No method panics on untrusted input** — every deserialization and
  signature-verification function returns a `Result<T, Error>` equivalent.
  No `unwrap()`, no `as` casts that truncate, no OOM on adversarial input.
  > ⚠ **FALSE on the `as`-cast clause only — the OOM and cast limbs are CLOSED. Verified
  > 2026-08-11.** This marker said "FALSE on all three limbs"; two have since been fixed.
  > - *OOM — closed.* `readArray` bounds on `MAX_ARRAY_LENGTH` **and** on bytes remaining
  >   before allocating (`wire/src/reader.ts:3`, `:149`, `:153-157`), and `cumulativeWork`
  >   skips any `powTargetBits` that is not a safe integer within
  >   `[0, MAX_SATISFIABLE_TARGET_BITS]` (`types/src/block.ts:205`). Neither allocates on
  >   attacker-chosen input.
  > - *Casts — closed.* The sync decode boundary shape-checks every field and never throws;
  >   malformed CBOR collapses to `null` and the returned object is rebuilt from checked
  >   fields only (`net/src/sync-codec.ts:55-74`).
  > - *Panics — **not re-verified**.* The original claim named "an unguarded throwing step
  >   between the Stage-1 pipeline's documented calls" without pinning a file or line, and it
  >   could not be relocated from that description. **Unknown, not holding** — re-derive it
  >   before relying on either answer.
  >
  > **The `as`-cast clause is why this marker stays, and it was never true rather than having
  > gone stale.** A TypeScript `as` cast does not truncate — it erases at compile time and
  > asserts a type that was never checked. That is a *different and larger* hazard than Rust's
  > truncating numeric cast: it produces no runtime error at all. The clause reads as
  > transliterated Rust and should name the real risk — unvalidated `as` on decoded input.
- **Validate, don't trust** — independently recompute every self-reported
  claim. A post's parent hash, PoW solution, and signature MUST be verified
  by the local node before the post enters the store.
  > ⚠ **FALSE — two paths write before verifying. Verified 2026-08-11.**
  > `insertPostPlaceholder` writes a confirmed row before anything verifies it; and a post is
  > written to `dag_posts` before its karma-lock transaction validates, with no rollback.
  > (A third path — `onStump` storing unauthenticated gossip stumps — was closed by P2-F F1:
  > no network path writes `dag_stumps` anymore; see §3.)
  >
  > ⚠ **The PoW sentence this marker used to carry was wrong and is corrected here.** It said
  > *"`verifyPoW` has two call sites, both in the verifier"*. There are **three**, and one is
  > not in the verifier: `net/src/gossip.ts:255` (gossip relay validation),
  > `verifier.ts:165` (inside `verifyPost`) and `verifier.ts:253` (inside
  > `verifyPostForRelay`). There is also a **re-export** at `node/src/services/pow.ts:3`,
  > which is a second entry point under a different module path and is invisible to a search
  > for callers of the original.
  >
  > **What was re-verified:** the call sites and that node's `verifyPost` is reached from
  > `post-service.ts:145`, the submission path. **What was not:** exhaustive unreachability
  > from block application. The original "neither reachable from block application" is
  > therefore neither confirmed nor refuted here — it rests on a search this pass did not run.
- **Never add checks the reference lacks** — extra validation rules beyond
  the protocol spec create fork surfaces. Every rule is either
  protocol-spec or explicitly local-policy-only.
  > ⚠ **UNENFORCED, and the premise has no referent. Verified 2026-08-11.** There **is** no
  > reference implementation — this node is the only one — so "the reference" names nothing.
  > The gap the parameter-class convention fills for configuration remains open for
  > validation rules: there is no repo-wide register saying which post-validity rules are
  > protocol and which are local policy.
  >
  > ⚠ **This marker's example is stale and is corrected here.** It named
  > `verifyContentCharacters` as "neither declared protocol nor declared local". It is now
  > **declared**, at its own definition: `validation/src/content-charset.ts:5` states it is
  > *"a **consensus Stage-1 check**: every node must reach the same verdict for the same
  > bytes"*, and derives the pinned-codepoint implementation from that. The declaration lives
  > in source rather than in a register, which is why a contract-side search did not see it —
  > and that is the actual shape of the gap: **the knowledge exists per-rule and is nowhere
  > aggregated.**

### Storage guarantees
- **Single-transaction atomic writes** — every post insertion that touches
  multiple tables (posts, dag_edges, indexes, scores) MUST happen in a
  single SQLite transaction. No partial writes.
- **Best DAG is a view, not structural** — all alternative-branch posts are
  stored permanently. Switching branches is a view update — posts are never deleted.
  **Canonical ordering is `max(parentScores) + 1` — uniform weight per post, not
  PoW-weighted.**
  > **Corrected 2026-08-06 (decision, not drift).** This bullet previously said "derived
  > from cumulative PoW"; the live rule weights every post at 1. That is deliberate:
  > **post difficulty is static, so weighting by actual PoW is numerically identical to
  > weighting by 1** and the count buys no information. A second, independent reason to
  > prefer it: PoW-weighting would let **hashpower buy canonical prominence**, which
  > contradicts *the node records, it doesn't rank*.
  >
  > ⚠ **QUALIFIED — re-argue this before making post difficulty dynamic. Verified 2026-08-11.**
  > The equivalence
  > holds **only while post PoW difficulty is static.** If a retarget or user-chosen
  > difficulty is introduced, uniform weight stops equalling cumulative work and this must
  > be decided again — at which point the second reason becomes load-bearing rather than
  > corroborating. *(Chain selection is unaffected and does use genuine cumulative PoW;
  > these are two different mechanisms and this bullet is about the DAG.)*
- **Sort-order determinism** — any operation feeding a Merkle tree or
  content hash MUST have a documented, identical sort order across all
  implementations.
  > ✅ **RESOLVED — closed by Phase 4, 2026-08-10, re-verified 2026-08-11. The record below is
  > kept because the reasoning
  > generalises, and because "replace, do not specify" is the decision that produced the whole
  > positional-format bundle.** Both leaves now hash the committed struct's own wire bytes
  > (`subBlockEntryBytes`, `coinbaseOutputBytes`), stated once in `@dagsocial/types`. All five
  > leaf types — `subblock`, `prune`, `coinbase`, `utxotx`, `stump` — speak one dialect.
  >
  > **The record — this text was FALSE on "documented", and the fix was to change the format
  > rather than to document it.** No `⚠`: the defect is closed by the `RESOLVED` above, and a
  > `⚠` here would read as open work.
  > Two consensus Merkle leaf preimages (`subblock`, `coinbase`) were `JSON.stringify` output
  > feeding `subBlockRoot` and `utxoTxRoot` under PoW. Documenting them would commit every
  > future implementation to replicating **ECMAScript JSON semantics** — key order equal to
  > object-literal insertion order, ES2019 escaping, `Array.from` on byte arrays (else
  > `{"0":1,…}`), bigint pre-rendered as decimal because `JSON.stringify` throws on it. A
  > non-JS light client would have to reimplement V8 string escaping to compute a block root.
  >
  > **Decision 2026-08-06: replace, do not specify.** Move to a length-prefixed canonical
  > encoding — the pattern `postFieldBytes` already uses, which is the M-1 fix and is
  > verified injective. Two supporting reasons: the format is **already straining**
  > (`canonicalEpochTallyJson` existed precisely because JSON insertion order was not
  > deterministic enough for one leaf — retired with the epoch, P2-D), and it is
  > protocol-breaking either way, so it costs
  > nothing extra folded into the id-moving bundle (`computeTxId` length-prefixing, post
  > typing) rather than as a second coordinated break later.
  >
  > `stump`, `prune` and `utxotx` are simple byte forms and are unaffected — they get written
  > specs as-is. `epoch` and `likebox` are deleted by P2-D, their domain strings **reserved,
  > never reused** (§Likes).

### Package boundaries
- **No dependencies above the package's abstraction level** — the storage
  layer depends only on DB bindings and hashing. It MUST NOT import post
  content types, networking code, or UI code.
  > ⚠ **FALSE in the positive clause; the prohibition holds. Verified 2026-08-11.** `store/`
  > value-imports serializers — `decodeTx` (`store/faucet-grants.ts:1`), `encodeTx`
  > (`store/mempool.ts:9`), `encodeStump` (`store/stumps.ts:2`) — and `store/mempool.ts:2`
  > imports `../config.js`: **the application layer, imported by the storage layer, and
  > load-bearing** (it carries the mempool cap into the capacity check at `:65`). The
  > *prohibitions* are respected: post content types are `import type` only, and there is no
  > networking or UI import.
  >
  > **Two details in the old wording were stale and are corrected here:** `serializePruneEntry`
  > is **no longer** among store's imports — `mempool.ts` takes `computePruneEntryId` instead —
  > and the capacity constant is now read as `config.maxMempoolEntries`, not the bare
  > `MAX_MEMPOOL_ENTRIES` the marker named.
- **"Does NOT own" on every package** — each package explicitly lists what
  it is NOT responsible for. Prevents scope creep.
  > **True — all five packages carry it.** Note it lives in `packages/*/CLAUDE.md`, not in
  > `contracts/`, so it is a session-context convention rather than a contract one.

### Data integrity
- **Timestamps are untrusted** — timing-sensitive logic uses DAG depth or
  local wall clock, never a remote post's self-reported timestamp.
  > ⚠ **FALSE — and the invariant's own escape clause is the deeper problem. Verified
  > 2026-08-11.** Live violations: `store/posts.ts:242` orders feeds by
  > `ORDER BY timestamp DESC` on the self-reported value; `getPendingPosts` (`posts.ts:256`)
  > orders on the same untrusted column — **`ASC`, not `DESC` as this marker previously
  > said**; `sqlite-store.ts:37` writes `Date.now()` into the column that is **inside
  > `computePostId`**; the demo UI ranks its feed by `post.timestamp`.
  > **"or local wall clock" contradicts the project's own rule that on-chain time is block
  > height.** A *local* wall clock is precisely what makes two nodes disagree. That clause
  > should be struck, not merely qualified — it licenses the failure mode it exists to
  > prevent.
- **Precondition/postcondition documentation** on every public function in
  the store and service layers.
  > ⚠ **FALSE — 172 exported functions across `store/` and `services/`, and exactly one
  > file in `packages/node/src` contains the word "Precondition". Re-counted 2026-08-11.**
  > Either the invariant is adopted for real or it should be dropped; as written it is
  > aspiration in the present indicative, which is the failure mode the status markers exist
  > to prevent.
  >
  > ⚠ **The count was 174 when this marker was written and nothing re-derived it.** It is a
  > worked example of why every marker here now carries a verification date: the *substance*
  > held — one file, out of 172 — while the number quietly went wrong. A reader who spot-checks
  > the number and finds it off has no way to tell whether the argument moved with it.

---

## Build and test resolution

Every package is ESM and builds with `tsup src/index.ts --format esm --dts` to a single bundled
`dist/index.js`. The four library packages (`types`, `wire`, `validation`, `net`) each declare
exactly one export condition — `"."` — and there are no subpath exports anywhere. **`node` has no
`exports` field at all**, only `main`; it is the application package and nothing depends on it, so
bare-specifier resolution there goes through `main`. The practical effect is identical, but `node`
is not subject to the subpath restriction the other four get from `exports`.

**Test code resolves `@dagsocial/*` to the package's `src/index.ts`, never to `dist/`.** A vitest
`resolve.alias` maps each workspace package name to `packages/<pkg>/src/index.ts`, declared once at
the repo root and merged into every package's vitest config.

Six rules govern it:

1. **Uniform across all five packages.** Aliasing some and not others puts two copies of the same
   module in one process — one transpiled from `src`, one bundled inside `dist`. `instanceof` fails
   across that boundary and every module-level singleton exists twice.
2. **The alias target is `src/index.ts`, not `src/`.** The barrel stays the surface under test, so a
   symbol exported from a module but missing from `index.ts` still fails at import.
3. **`pnpm test` no longer proves a package builds.** Nothing in the unit-test path executes `tsup`,
   so a bundling or externalisation break passes the suite. `pnpm -r build && pnpm -r typecheck &&
   pnpm -r test` is the gate before any commit or PR — **the build is a separate obligation, not a
   side effect of testing.**
4. **Spawned processes are exempt and still need a real build.** A vitest alias exists only inside
   the vitest process. `packages/node/test/e2e/*` spawns `dist/index.js` as a child process, so any
   run including that suite requires a genuine build first. Node's `globalSetup` build therefore
   stays, **gated on the resolved exclude list**: it skips while `'test/e2e/**'` sits in
   `config.exclude`, and re-arms by itself when the post-P2-D rewrite removes that exclusion. The
   gate fails safe — an exclude string it does not recognise builds rather than skips.
5. **Test trees are typechecked — all five packages, at zero.** Each `typecheck` script runs
   `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`, so `pnpm -r typecheck` compiles every
   test tree in the workspace. Node was the last to land: 409 errors → 0, in one unit, with **zero
   `src` edits**. The debt did not come apart mechanically — a bulk retype of all missing-provenance
   box literals to `CandidateOf<>` drove the count UP (409 → 424), because node's fixtures are
   stored boxes and transaction candidates wearing one shape, told apart only per site by asking
   what reads the value.
   **`packages/node/test/e2e/**` is the one piece of code in the repo that is NOT typechecked, and
   that is a choice rather than an oversight.** It is excluded in both `tsconfig.test.json` and
   `vitest.config.ts`, for the same reason in both: the suite is parked until its post-P2-D rewrite
   (rule 4), so paying down type debt there would be paying it against code slated to be replaced.
   When that rewrite lands, both exclusions come off together.
   What the wired trees caught immediately, none of it visible before: a mock summing karma as a JS
   number behind a `bigint` interface whose value the route renders with `.toString()` (wrong output
   past 2^53); fixtures seeding boxes whose `stored.id !== computeBoxId(stored)`, violating the
   invariant `computeBoxId` calls true by construction (`types/src/utxo.ts`, at the
   `stored.id === computeBoxId(stored)` note above the function — **not `:210-212`, which the old
   pin named and which is an unrelated comment about `BOX_TYPE.read`**); and two fixtures carrying
   retired guard strings, which are box CONTENT inside the id preimage and therefore described boxes
   that cannot exist. Each package
   carries a `tsconfig.test.json` (`include: ["src", "test"]`) wired into its `typecheck` script, so
   `pnpm -r typecheck` covers what the suites actually execute — an unchecked test tree is exactly
   where a new *required* field (e.g. `UtxoDeps.networkType`) hides as a runtime surprise, and where
   mocks of deleted fields rot silently (`headers.test.ts` mocked `SubBlockTree.stumpIds` units after
   it died). Three constraints, all measured 2026-08-08: the config extends `tsconfig.base.json`
   **directly**, not the package `tsconfig.json` — `extends` cannot *unset* the inherited
   `rootDir: "src"`, and the cross-package `paths` files below then violate it (TS6059); it declares
   `paths` mapping `@dagsocial/*` to `../<pkg>/src/index.ts`, mirroring the vitest alias above —
   without it `tsc` follows `exports` to `dist` types and re-opens the stale-`dist` class this
   section exists to kill; and node's parked `test/e2e/**` stays excluded until its post-P2-D
   rewrite. Baseline debt when this rule was written: **455 errors** (types 18 · wire 1 ·
   validation 6 · net 21 · node 409), **all now zero**.
   **No `types: ["vitest/globals"]` entry is needed** — but not for the reason first recorded
   here. The original claim, "no test file uses bare vitest globals", is **false**:
   `node/test/config.test.ts:44` calls `vi.resetModules()` while importing only
   `{describe, it, expect, beforeEach}`, and `tsc` reports exactly one
   `TS2304: Cannot find name 'vi'` for it. Every other file in every package imports what it
   uses. The remedy is therefore to fix that one import, **not** to admit an ambient global —
   which would silently license the drift the explicit-import convention prevents. Right
   conclusion, wrong premise: the same shape as a fixture agreeing with its own assertion,
   and caught only because node's tree was finally compiled.
6. **Every package declares `@types/node` itself.** Not inherited, not assumed: TypeScript resolves
   ambient node typings by walking `node_modules` *upward without a repo boundary*, so a package that
   omits the dependency silently typechecks against whatever copy exists further up the filesystem —
   including one in the developer's home directory. Measured 2026-08-08: `net` and `wire` declared
   none and were resolving `@types/node@12.20.55` (Node 12, 2021) from `/home/<user>/node_modules`,
   231 times in a single `--traceResolution` run, while the repo pins Node ≥ 22. Consequences, both
   real: **net's typecheck was not reproducible** on another machine or in CI — it depended on a file
   outside the repo — and the stale typings *invented* two errors in `validation/src/verify.ts`
   (Node 12 typed `crypto.verify` as returning `Buffer`; Node 22 returns `boolean`), which surfaced
   as soon as rule 5's `paths` pulled sibling `src` into net's program. Both packages now declare
   `^22.0.0` like the other three, and the two phantom errors vanished. A cross-package type error
   is worth suspecting as a resolution artifact before it is treated as a defect.

**Cost, measured 2026-08-07.** Node's suite went **11.7 s → 25.1 s**: transforming three sibling
packages' `src` per file costs more than the `tsup` build it replaced. This is a known, accepted
trade — the alias buys correctness and removes `dist`-write contention, **not** speed. Do not
"optimise" it away expecting the suite to get faster.

**Why this rule exists.** Before it, 12 test files imported their own package by name — all 5 in
`wire`, 7 of 20 in `net` — and neither package had a rebuild hook, so a source edit was invisible to
its own tests. That produced false-green mutation runs twice, a completeness grep that hit stale
`dist` and read as a genuine failure, and a "mutation survived" conclusion that was really a stale
binary. The alternative — a build hook in every package — was **rejected**: the recorded failure mode
is two sessions racing the same `dist` (a build in one window swapped `net/dist` under a suite
running in another), and four more build-on-test-start hooks makes that worse rather than better.
Taking `dist` out of the unit-test path dissolves the race instead of tightening the discipline
around it.

---

## Store Architecture

> ⚠ **The namespacing below does not match the schema.** 17 of 18 lines are original
> 2026-07-20 text and predate the actual tables by weeks. **`sub_*` has no tables at all**
> — sub-block state lives in the mempool and in `block_topology`. Ordering blocks are
> outside the `block_*` prefix. The audit also found the store contract naming tables and
> columns that do not exist, and `routes/status.ts` querying three (`blocks`, `posts`,
> `identities`) that were never created — **that file was deleted 2026-08-07**, so the
> remaining instances of this defect are in the contract text below, not in code.
>
> **`NODE_INTERFACE.md → Store Interface` is authoritative for the schema; this section is
> a sketch of an organising principle that was not followed.** Do not derive table names
> from it.

Phase 2 uses a fresh SQLite database with namespaced tables:

| Prefix | Content |
|--------|---------|
| `dag_*` | Posts, parent refs, stumps |
| `utxo_*` | Karma boxes, credit boxes, like boxes, invite boxes, bond boxes |
| `sub_*` | Sub-blocks, sub-block-to-post mapping |
| `block_*` | Ordering blocks, block-to-sub-block mapping |
| `peers` | Discovered peer addresses (unprefixed — it belongs to none of the four ledgers; it backs `@dagsocial/net`'s PeerDb across restarts) |

Single WAL, single connection. Phase 1 schema is not migrated — Phase 2 starts
fresh. Namespacing keeps the option open to split into separate stores later
(e.g., UTXO moves to an authenticated state trie for light client proofs).

---

## Implemented (v2)

> ⚠ **This list is 88% pre-August and overstates what runs. Five entries are not
> implemented as described** — marked inline below. "Implemented" is the strongest claim a
> heading can make, so a wrong entry here is more misleading than the same error anywhere
> else in the document.

- Sovereign subtrees with author-controlled pruning
- UTXO ledger: karma (non-tradeable) + credits (tradeable)
  > Both halves hold: the karma-transfer routes closed across P2-B (vouch/co-sign) and
  > P2-D (unlike, by feature removal), and `sendCredits` rides block application since
  > P2-B phase 3. See §Invariants → Cross-layer.
- ~~Like system: locked likes (karma staking) + free likes (post-50), epoch tally~~
  > ⚠ **SUPERSEDED. Verified 2026-08-11.** Likes are one-way at 1 karma with no refund, no free
  > tier and no epoch — `node/src/services/likes.ts` states the rule at its head ("no free tier,
  > no refund"). The **free-like tier has no producer anywhere in the node** — correctly never
  > built rather than a gap. See §Likes.
- Invite system: hash-locked bearer invites, bond/probation, cancel
  > ⚠ **PARTIAL. Verified 2026-08-11.** A commit now requires a signature from the committed key
  > (H-2), so "bearer" is qualified; and **bond forfeiture on probation failure is not enforced** —
  > the invitee can take the bond. `node/src/services/utxo-engine.ts` states this at its bond
  > section: *"Forfeiture is not implemented"*, and records that the economics design owns it.
- ~~Post karma locking with gradual unlock at epoch boundaries~~
  > ⚠ **PARTIAL. Verified 2026-08-11** — `PostLockBox` is a live interface in
  > `types/src/utxo.ts` and a member of the `AnyBox` union. The post bond is real and stays — it is
  > the anti-dodge
  > mechanism. But **"at epoch boundaries" is superseded**: vesting moves to per-block with
  > the epoch's removal, and the `epoch_tally` guard becomes "consumable only by block
  > application."
- Sub-blocks + ordering blocks with PoW (user PoW + validator PoW)
- Verifiable prune: block-level PruneEntry, Ed25519-signed, UTXO-deterministic
  settlement (consumes PostLockBoxes and LikeBoxes, mints refund karma)
- AVL+ state root: authenticated dictionary over UTXO set, stateRoot in block
  headers, `GET /api/v1/proof/:boxId` for light-client proofs
- block_topology table (post_id, parent_refs, author, block_height — all
  consensus-sourced) for subtree topology and prune-authorship lookups
- libp2p networking with two-stage validation (stateless + stateful)
- Credit emission: Ergo-style linear decay, treasury split, miner reward delay
- Height-deterministic difficulty schedule for ordering block PoW (no wall clock)
- Internal + external mining modes
- Unified mempool: all state mutations queued, applied atomically at block
  finalization
- Framed p2p stream protocol with magic bytes, VLQ length prefixing, and a **4-byte**
  checksum (the first 4 bytes of a blake2b digest — the frame layout at the top of this
  document says `[checksum:4]`, and `WIRE_INTERFACE.md` agrees; "32-byte" here was wrong)
- Header-first historical sync with SyncInfo/Inv/Modifier protocol
- Peer discovery via GetPeers/Peers gossip + PeerDb

## Deferred to future protocol versions

- **Credit sinks:** Ads, author boosts, reader tips
- **Reply earning:** Proportion of downstream likes flowing to upstream
  contributors
- **Karma-proportional PoW:** High-karma accounts do less work
- **Storage pruning:** Automatic compaction for lean nodes (archive nodes
  retain full content)
- **View keys / private content:** Reader spending credits to unlock content
- **Parameter governance:** Karma decay, like thresholds, emission schedule
  adjustable by future governance
- **Fee market:** Replacement semantics, priority fees, fee-based eviction
  (a flat reject-at-cap mempool bound ships already — audit M-8)
