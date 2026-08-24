# DAGsocial Architecture

**Protocol version:** 1
**Last updated:** 2026-08-23

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

### Block architecture: ordering blocks

One block type. Validators produce **ordering blocks**: full PoW, one committed body
(`utxoTxIds` + `pruneEntries`), a configurable interval. Every post and like is an
ordinary UTXO transaction riding `utxoTxIds` with everything else, and each block
carries the settlement transaction stated below.

**There are no sub-blocks and no per-post PoW** (§Blocks and ordering). A post's
admission is its transaction's: priced by the karma post-lock, authenticated by the
transaction's signature, ordered by the block that includes it.

> ## Every block carries ONE SETTLEMENT TRANSACTION, and it is where protocol effects live
>
> **One per block, covering both ledgers**, built by the producer and validated by rule. It spends the
> karma pool and the emission box, consumes the markers the block's user transactions emitted, and
> emits every box the block's protocol effects create. ⛔ **`CoinbaseOutput` is not a block-body
> concept** — coinbase outputs are outputs of this transaction; no body field and no
> `utxoTxRoot` leaf class carries the reward (TYPES_INTERFACE → Ordering block).
>
> **Why exactly one.** The pool's id changes every time it is spent, so two transactions naming it
> conflict — and unlike an ordinary contended box **the loser is not deferred but permanently
> invalid.** One protocol spend per block gives zero contention. A transaction may have as many
> outputs as it needs, so **this bounds nothing** about how many invites, likes or sweeps a block can
> carry.
>
> ⛔ **ITS INPUTS ARE DERIVED, NOT LISTED.** The rule is *"this transaction consumes every marker box
> the block's transactions emitted, in committed transaction order"* — so its serialized size is
> proportional to the number of distinct **authors**, never to the number of **likes**, and the
> enumeration order is already fixed by `utxoTxIds` rather than needing a rule of its own.
>
> ⚠ **The cost, stated rather than discovered: the settlement is not validatable from its own bytes.**
> A validator reconstructs its input set from the rest of the body before checking conservation. That
> reconstruction is a field read on a pass the validator already makes, and it runs **once per block**.
>
> ⛔ **DETERMINISM IS THIS MECHANISM'S WHOLE RISK — of the VERDICT, not of the bytes.** The
> coinbase payout key is producer-chosen, so a verifier cannot rebuild a byte-identical
> settlement; what must hold is that every node reaches the same **verdict** on the settlement
> the block carries. Every field is either **derived** (recomputed identically by every
> verifier; a mismatch rejects the block) or **producer-chosen and constrained by a stated
> rule** — no field may be neither. Construction is a pure function of the block's other
> transactions, the consumed protocol boxes and the producer-chosen inputs it names — no local
> state, no clock, no iteration order the block does not already fix. `NODE_INTERFACE` states
> the construction.

---

## ⛔ THE CONSERVATION AXIOM — NOTHING IS EVER CREATED OR DESTROYED AFTER GENESIS

> **NOWHERE IN THE CODE SHALL EXIST A FUNCTION THAT MINTS OR BURNS ANY SUPPLY OF ANY ASSET, EVER.
> THE CREATION OF THE GENESIS BOXES CARRYING THE CREDIT SUPPLY AND THE KARMA SUPPLY IS THE ONLY TIME,
> IN ALL ETERNITY, THAT ASSETS ARE CREATED. NOTHING IS EVER BURNED OR DISAPPEARS FROM SUPPLY —
> NOT EVEN AS AN INTERMEDIARY STEP.**
>
> — user, 2026-08-17. **This outranks every other rule in this directory.** Where any other section
> conflicts with it, that section is wrong.

**Every operation is a TRANSFER.** A unit of karma or credit moves between boxes and is never called
into being or ended. Genesis fixes both totals; from height 1 onward the ledger only rearranges them.

### The vocabulary, fixed — "burn" and "mint" are directions, not events

⛔ **This has been settled several times in conversation and never written down, which is why it kept
being re-settled** (user, 2026-08-17). It is now written down.

| Word | Means, and means only |
|---|---|
| **burn** | **move back to the supply pool.** Nothing is destroyed. |
| **mint** | **spend out of the supply pool.** Nothing is created. |

⛔ **A LITERAL BURN DOES NOT EXIST AND CANNOT BE ADDED.** Where existing prose, a function name or a
comment says "burned", it means *returned to the pool* — and where the **code** actually destroys
value, that code is a defect against this section, not a definition of the word.

⚠ **Read every "burn" in this directory under this definition.** The like deficit, decay, bond
forfeiture and a pruner's own locks are all named as burns elsewhere; **all four are transfers to the
pool.** The naming survives because it is what a holder experiences — the karma leaves them and does
not come back.

⛔ **"Not even as an intermediary step" is the demanding clause, and it rules out the obvious
implementations:**

- **A net-delta reconciliation is NOT conservation.** Removing value at one point and restoring the
  same amount later — within a block, within a transaction, anywhere — means there was an instant at
  which the unit did not exist. **Per-block settlement of a net figure is accounting for burns, not
  an absence of them.**
- **A marker box standing in for value MUST CARRY THAT VALUE.** A zero-value marker means the units
  it represents ceased to exist between the transaction and the settlement.
- **The pool is therefore NAMEABLE.** Value leaving circulation has to go *somewhere* nameable in the
  same operation that removes it, and value entering has to come from somewhere nameable. A rule that
  forbids every transaction from naming the supply box forces a burn.

⛔ **A MINT FUNCTION IS BARRED FROM EXISTING, NOT MERELY FROM MIS-SUMMING.** A primitive that
takes an amount and no source cannot fail, because there is nothing for it to check against —
and an operation decrementing the emission box elsewhere would not save it: the axiom bars the
*function*, not merely the aggregate from drifting. The tree satisfies this: no mint or burn
function exists. Value moves through exactly two operations, each naming source and destination
in one call — the block's settlement transaction (every pool-, emission- and treasury-touching
effect; NODE_INTERFACE → The settlement transaction) and `transferKarma` (the
conserving-in-place paths) — and `test/services/conservation-axiom.test.ts` asserts the sum
across an applied chain.

### How a source and a sink get named — the three shapes, and there are only three

⛔ **Most paths conserve inside themselves and need no shape at all.** A bond's vested
part, post-lock vesting, a prune refund and the coinbase all take their value from a box being
consumed in the same operation that pays it out.

For the paths where value genuinely enters or leaves circulation, exactly three shapes are available:

| Shape | When it applies | Example |
|---|---|---|
| **the value is already in a box** the transaction consumes | the party holds it | bond return, escrow return, post-lock vesting, unvouch escrow |
| **block application spends the pool** | no user transaction is involved | decay, bond forfeiture, the invite grant |
| **a marker box** the user's transaction outputs, carrying the value | a user transaction moves value to a party it cannot name a box for | the like accrual — **and nothing else** |

⛔ **A MARKER MUST CARRY ITS VALUE.** A zero-value marker means the units it stands for ceased to
exist between the transaction and the settlement, which is exactly what *"not even as an intermediary
step"* forbids. This is why the like needs a marker and the invite does not: the invite's bond is
already a box the transaction creates, so the settlement reads it and no marker is invented.

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
PostCommit {                   // rides the creating transaction — consensus
  contentHash: Uint8Array(32)  // blake2b512(POST_CONTENT_DOMAIN ‖ utf8(content))[0:32]
  author: UserId               // 32 raw bytes — see the representation rule below
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS per post
  protocolVersion: number
  type: PostType               // 'regular' | 'profile' — TYPES_INTERFACE → Post typing
}

Post {                         // lives in the DAG — never in a block
  content: string              // 1–MAX_CONTENT_BYTES UTF-8; hashes to the commit's contentHash
  author, parentRefs, protocolVersion, type — the commit's four, verbatim
}

PostId = computePostId(txId, index) — provenance-derived from the creating
transaction; neither struct's fields enter its id (TYPES_INTERFACE →
Post identity). There is no post signature and no post PoW — authorship is
the creating transaction's signature, and a body is bound to its post by the
commitment alone.
```

**A block commits a post's structure and its content commitment, never its content.** The
transaction carries the `PostCommit`; the body travels beside it as a packet on gossip and by
id on pull (NET_INTERFACE → Gossip Topics, Sync State Machine), and lives only in the DAG. A
node that applies a post transaction without having seen its packet holds a **placeholder** —
structure, no body — until backfill fills it (NODE_INTERFACE → Store Interface → Posts DAG).

> **The byte-exact layout is specified in `TYPES_INTERFACE.md` (Serialization → "Layout —
> PostCommit" and "Layout — Post body") and nowhere else.** Every field is length-prefixed and the ref array carries an
> explicit count (audit M-1); the id's domain tag keeps a post id from ever colliding with a
> box or tx id derived from the same provenance. **Do not restate the formula here.** This document previously
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

A public key is rendered as a **hex `string`** in exactly one place, explicitly
typed `string` rather than `UserId`: the `signatures` map keys. That is deliberate,
not drift — the map encodes as an array sorted by key, and lowercase hex keys make
the string order and the decoded-byte order agree (TYPES_INTERFACE → Layout —
UtxoTransaction).

**The rule: if the field is typed `UserId`, it is raw bytes. If it is typed `string`, it
is lowercase hex.** The type is the boundary marker; there is no third form. Both
representations are genuinely live, so this is a convention to state and hold, not drift
to eliminate.

#### Post admission — there is no post-level PoW

Post PoW, its challenge handshake, and the sub-block mechanism are retired. A post is
created by a transaction: admission is priced by the karma post-lock, authenticated by
the transaction's signature, and ordered by the block that includes it.

#### Subtree pruning (deletion)

The root author may prune their entire subtree at any time. Pruning:

1. **Deletes** the root post and all descendant posts from the DAG — rows and bodies, by the
   entry's `subtreePostIds`; not a status flip, not a read filter
2. Cascades to all replies — a reply exists only in the context of its root
3. Replaces the entire subtree with a **stump** (see §3): the root's id lives on as the stump;
   a descendant's id answers only a tombstone derived from `block_topology` and that stump
   (NODE_INTERFACE → Resolution order for a post id)
4. Is authorized by a signed prune transaction from the root author's key

The prune is authorized **solely** by the root author's Ed25519 signature
over `(rootPostHash, subtreeMerkleRoot)`. The signature travels in the block
as a PruneEntry. Who "the author" is, is itself consensus data: every
confirmed post's `author` is the signer of its creating transaction,
recorded at confirmation in `block_topology`, and a PruneEntry is valid only
if its `authorId` equals that recorded author (audit H-3) — so a signature from
anyone else, however valid for its own key, authorizes nothing. No validator
attestation is required — settlement is deterministically computable from the
UTXO state (the subtree's PostLockBoxes) plus the like-records it deletes
(P2-D). Any node can verify the prune independently, with or without the DAG
content.

Pruning is irreversible. Once content is pruned, it cannot be recovered.
What propagates is the PruneEntry inside the ordering block that settles
it — never the original content, and not the stump either: each node
derives its own stump from the verified entry at settlement (§3). Within
`MAX_REORG_DEPTH` the deleted rows exist only as undo records in the prune
block's journal — never served, never relayed — so a reverted prune restores
them exactly; once that journal is dropped, **a node holds no byte of the
subtree's content anywhere**: no DAG row, no journal row, and the blocks
carry only content commitments (§Invariants → Content sovereignty).

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

Both are stored as **boxes** — UTXO entries a transition must be authorized to
spend. Boxes are consumed and created in transactions; the set of unspent boxes
IS the current state.

Box `value` is a uniform **`bigint`** — credits are 8-decimal integer base units
(10⁻⁸ credit), karma small bigints. No float arithmetic in consensus value math;
`value < BOX_VALUE_BOUND`. See `TYPES_INTERFACE.md` → "Box value domain" and Spec B P0.

#### Karma boxes

```
KarmaBox {
  id: BoxId
  value: bigint                // Karma balance (bigint base units — see value denomination)
  owner: PublicKey             // Ed25519 public key (32 bytes)
  createdAtBlock: number       // Block height when box was created
}
```

Provenance is `txId`/`index`, not a field on the box. A mint's `txId` is
`computeMintTxId(height, reason, subject)`, whose `reason` tag names why the karma
was created; a user-path box carries the transaction that made it. Both are inside
the id preimage, so provenance is committed rather than asserted.

Karma can only be transferred via the **invite mechanism** (§4). Normal
transfers between existing accounts are forbidden — this is what makes karma
non-tradeable. An account's karma box can be consumed only to:
- Create invite boxes
- Create like boxes (spending karma to vote)
- Create a new karma box for the same owner (after earning/burning, resetting
  the activity clock)

#### Karma decay (virtual, squared on touch)

Decay is a **valuation, not a per-block mutation**. After 28 days of
inactivity an identity's karma decays *virtually*: every karma-sufficiency
read computes the **effective** value from committed state, and the face
values in boxes move only when a transaction touches the identity.

- **Staleness:** `(height − lastActivityBlock) >= KARMA_STALE_THRESHOLD_BLOCKS`,
  read from the identity record — the committed clock, not box heights.
- **Effective value:** `faceTotal − owedPeriods · KARMA_DECAY_AMOUNT`, clamped
  so it never drops below `min(faceTotal, KARMA_MINIMUM)`, where
  `owedPeriods = floor((height − max(lastActivityBlock, lastDecayBlock)) / KARMA_DECAY_INTERVAL_BLOCKS)`.
  **One implementation** — the engine, the verifier and the demo UI call the
  same exported valuation function (`VALIDATION_INTERFACE` → "One
  implementation per rule").
- **Sufficiency reads effective; conservation stays face.** A transaction's
  value-conservation equality is over face values, unconditionally; whether an
  identity *may* spend is judged against effective.
- **Squaring, per identity, on touch:** when a block's body consumes any of an
  identity's karma boxes, that block's settlement squares the identity — it
  consumes their post-body karma boxes and re-emits the effective value to the
  owner and the owed remainder to the karma pool. The touching transaction
  itself conserves at face, unchanged.
- **No periodic pass.** There is no per-block walk over karma owners and no
  background sweep. An identity nothing touches keeps its face values and its
  virtual decay indefinitely; its effective value still dissolves, and the
  pool — seeded with the supply total — does not depend on decay inflow.
- **Clocks:** the touching spend is activity (`lastActivityBlock` advances at
  the store choke point); squaring advances `lastDecayBlock`. Received value
  — a like payout, a vesting return, a settlement re-emit — is **not**
  activity and must not reset the clock.
- **The clock starts at onboarding.** A never-onboarded identity is neither
  active nor inactive — inactivity presupposes activity — and the invite is
  the one onboarding path, so the claim that creates the identity record
  initializes `lastActivityBlock` to the claim height. The grant output stays
  `nonActivity`: the epoch is the record write's, not a box bump's, and an
  invitee has no earlier clock for the `nonActivity` rule to protect.
- **Rollback:** squarings ride the settlement and the identity-record journal;
  reverse replay restores both.

All four constants are **consensus parameters** — the valuation feeds
validation verdicts and the squaring feeds committed state, so two nodes
holding different values diverge. Classes are defined in
`NODE_INTERFACE.md → Configuration`.

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
> ⚠ **All three line pins in this note had rotted, each by exactly 16 lines** — measured 2026-08-11,
> when `config.ts:107-108` landed on `miningMode`/`miningSecret` and `:109-110` on unrelated fields.
> One insertion above them moved every pin at once and nothing signalled it. **Named symbols replace
> the numbers here**: a corrected number rots again on the next commit that touches the file.
>
> ⚠ **And the correction rotted too — `miningMode` no longer exists**, so even the description of
> where the pins landed is now a claim about a deleted field. **That is the argument, not a footnote
> to it:** a dated measurement stays true as a measurement, which is why this sentence carries its
> date, and why the numbers themselves were replaced rather than refreshed.

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
> The karma pair were the **only** constants on a 2-minute basis — `MEMPOOL_EXPIRY_BLOCKS`
> (`720` = ~12h), `CREDIT_EPOCH_BLOCKS` (`129_600` = ~90d) and `CREDIT_FIXED_RATE_BLOCKS`
> ("at 60s blocks") all agree on 60s. So at the block time the node runs, these two delivered
> **14 days and 12 hours instead of 28 and 24**.
>
> ⛔ **That sweep checked each annotation against its own arithmetic, and nothing more.** A ✓
> beside a constant means its comment and its value agree at 60 seconds; it is **not** evidence
> that the duration was chosen. `CREDIT_MINER_REWARD_DELAY` was cited here as a second
> `720`-for-12h control and passed on exactly that basis — its duration had never been decided,
> and it is now **1440 for 24h** (TYPES_INTERFACE → Credit emission). **Do not read a passing
> unit check as a settled value.**
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
  lockedUntilBlock?: number    // Coinbase rewards cannot be spent before this height
}
```

Credits are freely transferable between accounts. Validator rewards are
released from the genesis `EmissionBox` as settlement outputs, never minted
(§The conservation axiom). Credit sinks (ads, author boosts, tips) are deferred
to future protocol versions. Circulating credits grow with each ordering block
until the emission terminus — the reward amount is a protocol parameter.

#### Vouch boxes

```
VouchBox {
  id: BoxId
  value: 1n                   // VOUCH_KARMA_AMOUNT — always 1n (bigint)
  voucherId: UserId           // Who staked the karma
  targetId: UserId            // Who is being vouched for
  createdAtBlock: number      // Block height when vouch was cast
}
```

A vouch is a 1-karma endorsement from one identity to another. Casting a vouch
consumes 1 karma from the voucher's KarmaBox and creates a VouchBox. The karma
is escrowed — not burned, not transferred to the target.

**Withdrawal is instant, and that is a requirement rather than a side effect.**
A voucher who concludes their target is untrustworthy stops endorsing at once:
the vouch stops counting the moment the `VouchBox` is spent. Only the stake's
return waits — the unvouch outputs a `VouchEscrowBox`, and the block settlement
returns it to the voucher at the first height at or past `releaseAtBlock`. No
client action claims it.

**The cooldown runs from the cast.**
`releaseAtBlock == vouch.createdAtBlock + vouchCooldownBlocks`, an exact pin
derived from the consumed box alone (NODE_INTERFACE → Vouch transition rules).
The stake is committed for one cooldown from **casting**, so no withdrawal
pattern returns it sooner and holding an endorsement longer costs no extra
lockup. A vouch held past one cooldown yields an escrow born past its release
height — the next block's settlement returns it, the commitment having been
served during the endorsement.

**The escrow is what rate-limits re-vouching.** A cast is invalid while any
unspent escrow names the voucher, and the escrow stands until the settlement at
`releaseAtBlock` spends it, so the vouch/unvouch cycle is capped at one per
cooldown window however briefly each vouch is held — the anti-spam property,
priced identically for a rapid cycler and a long-term voucher.

Each identity may vouch for at most one target at a time. The minimum karma
balance to cast a vouch is `VOUCH_MIN_BALANCE` (11) — **a balance, summed across
the voucher's karma boxes, not the value of any single one.** Both halves hold
in the engine: the cast arm reads the summed `getKarmaValue` at apply, so the
rule travels with the transaction, and the service gate reads the same
function.

```
VouchEscrowBox {
  id: BoxId
  value: bigint               // exactly what the VouchBox held — never the constant
  owner: UserId               // the voucher; where the karma returns
  releaseAtBlock: number      // vouch.createdAtBlock + vouchCooldownBlocks
}

unvouch tx    VouchBox(V) → VouchEscrowBox(V, owner = voucherId,
                                           releaseAtBlock = vouch.createdAtBlock + cooldown)
settlement    VouchEscrowBox(V) → KarmaBox(V, owner)    block application, at the first
                                                        height ≥ releaseAtBlock; no signature
```

✅ **The value never leaves a box**, so the pool is not involved on this path at
all and no marker is needed — the escrow is an ordinary output of the voucher's
own transaction, and the settlement's return conserves the same way, the escrow
its input and the karma its output.

✅ **The obligation is committed state.** An escrow box is in the UTXO set and
therefore in the `stateRoot`, so a node that synced without replaying every
block holds the obligation itself rather than a root it cannot interpret. No
node-local table remembers anything: the settlement leg that returns it reads
the escrow boxes of pre-body state and nothing else (NODE_INTERFACE → The
settlement transaction).

⛔ **The value is the BOX'S, never `VOUCH_KARMA_AMOUNT`.** The round trip is
conservation-structural, not true by coincidence, and it must not depend on the
cast's pin holding for the box in hand.

#### Box lifecycle

All box transitions are atomic — a transaction consuming N boxes and creating M
boxes either fully commits or fully fails. The ledger enforces:

- Total value in = total value out — conservation, with no exceptions (§The conservation axiom)
- Every consumed box is consumed by a transition whose requirements are satisfied
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
half since the output-shape schema closed the per-boxType key sets, pinned by
`computeBoxId(rowToBox(row)) === row.id` discriminator tests. Field **types**
since the field-type pin (2026-08-08, PR #16): `OUTPUT_SHAPE` carries a runtime
type per field — `owner` is `bytes32`, `originalValue` is `u64`, every predicate
total — and `checkOutputShape` moved to `validateTx` **step 4**, ahead of the
transition arms that dereference those fields, which is what closed the totality
gap the same marker used to book as a queued follow-up.

One correction that phase produced is worth keeping, because it was a
type-versus-domain error of the kind this section is about: a `hex32` field
admitted as any `string` while a fixed-width writer throws on it.

⚠ **The instance this named — `post_lock.targetPostId` — is gone**, deleted when
post ids became provenance-derived. The error class is not: `post.parentRefs`
reaches `writeHexNOrThrow` by the identical route and carries the same
obligation.

> ✅ **RESOLVED — the inbound obligation is now structural. Verified 2026-08-11.** This read
> `AHEAD OF CODE` until Phase 9; the positional bundle is merged, so it describes running code and is
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
  `value` serializes through `vlqU64` in `boxRecordBytes`, so the AVL leaf bytes are
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
  > such a rebuild (now deleted — see NODE_INTERFACE → "AVL+ tree shape is
  > history-dependent").
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
   `utxoTxTree.pruneEntries`. Nothing else leaves the node: the prune
   propagates only inside the block that carries it
6. At block application, every node independently verifies: authorship
   binding (`authorId` equals the `block_topology`-recorded author of the
   root; unconfirmed roots are not prunable), Ed25519 signature, postId set
   against block_topology, Merkle root, then settles UTXO deterministically
   — the settlement transaction consumes the subtree's PostLockBoxes and
   refunds **every lock owner except the pruning author**, whose own locks
   go to the pool; the subtree's like-records are deleted (journalled)
7. The simplified Stump is inserted, derived from the verified entry —
   unconditionally, so a node holding no DAG content records the same
   stump — then the subtree's DAG rows, bodies included, are deleted by the
   entry's `subtreePostIds`, each captured into the block's journal first so
   a reverted prune restores them exactly (NODE_INTERFACE → Pruning)

No validator attestation is needed — the author's signature authorizes the
prune, and the settlement is deterministically computable from UTXO state.

**Destroying your own post costs you its bond; destroying someone else's reply
returns theirs.** `PostLockBox.owner` against the entry's `authorId` decides
which, from committed state alone — no `block_topology` read. Refunding the
pruner made post → prune → repost a free loop that recycled the same karma
forever, and the same rule sets **withdrawal's** price: a withdrawn post's
remaining lock goes to the pool and nothing is refunded.

⚠ **The descendant-count price is NOT part of this rule.** Charging the pruner
for the replies they destroy is a separate consensus transition and is not
specified here.

#### Cryptographic guarantees

- Settlement is deterministic from UTXO state + block's PruneEntry — any node
  can verify independently without DAG content
- The author's signature over `(rootPostHash, subtreeMerkleRoot)` in the block
  is the single point of authorization, and "the author" is pinned by
  consensus: `PruneEntry.authorId` must equal the author recorded for the
  root in `block_topology` (the signer of the root's creating transaction,
  verified against real content by every node that holds it at confirmation time)
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
>   would indeed be a *self post*"). Only usernames leave the post model. **`Post.type`
>   exists and profiles key on it:** see §Profiles below.

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

### Profiles

A profile is a **single post bound to its author**: `type: 'profile'` (TYPES_INTERFACE →
Post typing and profiles), whose `content` is a structured document (≤ `MAX_CONTENT_BYTES`)
that clients interpret. Consensus records it and never parses it.

The profile of identity X is the **latest confirmed `profile` post authored by X** — latest
in committed order (block height, then position in block). Editing a profile is posting a
new one; latest-wins supersedes the old, and pruning it is optional hygiene. Profile posts
are ordinary DAG posts: carried by ordinary post transactions, prunable by their author,
recorded like any post.

There is no profile-root anchor, no typed child posts and no DAG walk. `display_name` is a
profile-document field or the username's concern; avatars are not a post type.

> **AHEAD OF CODE — a per-identity profile route/index is follow-on work.** The node serves
> profile posts as ordinary posts; the latest-wins resolution above is a client/indexer
> rule, and nothing in consensus depends on it.

### Identity resolution

```
userId → latest confirmed `profile` post by this author (client rule — §Profiles)
       → username (§Usernames)
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

There is no epoch. **A like moves its `LIKE_KARMA_COST` into a box earmarked for the author** —
the like transaction outputs a `LikeAccrualBox` marker — and the block's settlement transaction
settles every accrual at the end of the mutation phase. Every step names a source and a sink,
so nothing is created and nothing destroyed: the liker's karma goes to the accrual box, the
accrual box goes to the author and the pool.

**THE CARRIER IS TWO OBJECTS, NOT ONE** (user, 2026-08-17). They have different lifetimes and
neither substitutes for the other:

| | Lifetime | Count |
|---|---|---|
| **accrual marker** | created and consumed inside one block | one per like |
| **carry box** | persists across blocks | one per author, holding `r < LIKES_PER_KARMA_PAYOUT` |

⛔ **A LIKE MUST NOT NAME A SHARED BOX.** If the liker's transaction consumed the author's carry
box, two likers of the same author in the same block would name the same box id and the second
would be **permanently invalid, not deferred** — a popular author becomes unlikeable. The like
therefore emits a **fresh marker per like**, and only the settlement touches the carry box.

⚠ **The marker count is bounded per BLOCK, not per author.** An author may receive any number of
likes in one block, so `LIKES_PER_KARMA_PAYOUT` bounds the *carry*, never the markers. What keeps
that off the block is that the settlement **derives** its marker inputs rather than listing them.

For an author with `n` markers this block and a carry box holding `r`, in ascending author-hex
order, where `x = LIKES_PER_KARMA_PAYOUT`:

```
settlement   markers×n + carry(r) → authorKarma(+q·(x−1)) + pool(+q) + carry(r′)
             total = n + r,   q = ⌊total / x⌋,   r′ = total mod x
```

✅ **The payout draws from the accrual, never from the pool.** The likers funded it; on this path
the pool is a **sink** and never a source. Per `x` likes: likers paid `x`, the author receives
`x−1`, **1 returns to the pool** — the deflation dial. All integer arithmetic; a float
intermediate is a consensus fork.

✅ **THE REMAINDER GOES TO THE POOL, NOT THE TREASURY** (user, 2026-08-17). ⛔ **Those are
different economies and the choice is settled, not incidental**: to the pool it leaves
circulation for good and the dial stays **deflationary**; to the treasury it becomes spendable
by something later, which is **redistribution wearing deflation's name**. A holder cannot
distinguish "destroyed" from "returned to a pool nothing can spend"; only the accounting
identity differs.

⛔ **THE BOX IS THE CARRY.** There is no counter field — `IdentityRecord` carries no accrual — 
because a counter beside the box would be two representations of one quantity, free to
disagree. The carry is live supply by construction: it is karma, in the UTXO set, and in the
`stateRoot` because every box is.

The accumulator is **per author, not per post** (design track §1.3.1): outstanding carry is
bounded by `x−1` per identity and deferred rather than lost, and the payout is independent
of arrival pattern — the floor runs over a running total, never over a per-window group.

> ⚠ **Known karma-econ item, stated rather than hidden:** `lastActivityBlock` bumps on any
> non-decay karma insert, so a settlement like payout resets the author's decay clock —
> "receiving karma is activity," which `karmanomics.md` explicitly rejects for likes (an
> activity reset must cost a bond, or a second account resets your clock for 1 karma).
> Redefining the activity trigger is karma-econ scope; the bump-on-insert semantics stand.

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

`toUnlock > 0` runs `transferKarma`: the `PostLockBox` is consumed as the source, `toUnlock`
lands in the author's karma (`postlock-unlock`), and the reduced box is the remainder
(`postlock-remainder`) unless fully unlocked — a transfer that names both ends and refuses to
create or destroy (§The conservation axiom). The formula is the retired epoch schedule
evaluated per block; posts are processed in ascending post-id order. **This is the one karma
path outside the settlement transaction, and it belongs outside**: the lock vests into its own
owner's karma, so the pool is uninvolved.

No user transaction can spend a `PostLockBox` — block application is its only spender.

### Like parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `LIKE_KARMA_COST` | `1n` | Karma burned by the liker per like |
| `LIKES_PER_KARMA_PAYOUT` | `5` | `x`: per `x` likes an author accrues `x−1`; 1 is burned |
| `POST_LOCK_THREAD_COST` | `5n` | Karma locked for new threads |
| `POST_LOCK_REPLY_COST` | `3n` | Karma locked for replies |
| `POST_LOCK_UNLOCK_PER_LIKES` | `10` | Every N lifetime likes unlocks 1 karma |

All universal constants — never per-network (§Network Identity: compress time, never
economics). Values are placeholders until the constants session pins them — with one
pinned exception: `KARMA_STALE_THRESHOLD_BLOCKS`'s duration is ruled at 28 days
(user, 2026-08-19; `TYPES_INTERFACE` states the same at the profile passage).

**Retired, do not rebuild:** the like box · the free-like tier (`dag_likes` rows as
likes) · unlike and every refund path · the epoch interval. The boxType string `'like'`
is a tracked reservation (`TYPES_INTERFACE` → Tracked reservations).

---

## Invite System

The network is invite-only. An existing account must stake for every new
account, and the invite is the only path by which a new key receives karma — a
**pool spend**, never a creation (§The conservation axiom). *"The network's only
source of karma"* survives only as a statement about **circulation**; genesis is
the only source of supply.

An invite names its invitee. Bob gives Alice his public key out of band; from
there each of them acts under their own signature and no secret exists anywhere
in the flow.

### The invite is ONE transaction

```
invite tx    aliceKarma(K) → BondBox(B, inviterId=Alice, inviteePublicKey=Bob) + aliceKarma(K−B)
settlement   pool(S) → pool(S−B) + bobKarma(B)
```

**Alice pays only the bond**, and creation conserves value like any other
transaction. No user transaction can spend the bond. There is no `InviteBox`, no
claim transaction and no cancellation transaction — `TYPES_INTERFACE → InviteBox`
governs the retired names.

⛔ **THE BOND IS THE REQUEST.** The settlement emits **the bond's own value** to
the `inviteePublicKey` of every `BondBox` the block creates. Pairing is
**structural** — one bond, one grant — so no rule compares two lists and no box
is invented to carry the pairing. This is why the invite needs no marker box
while a like does: the bond is already a box the transaction creates and the
settlement can read.

⛔ **Bob's key must not already be an account** — meaning it holds no identity
record, which every karma receipt writes. Checked at creation. The weaker test,
*"has not been invited before"*, hands out pool karma against value already
earned: an established account that had simply never been invited could be
named, the settlement would grant it the bond's value, and the bond would vest
in full against likes that key had already earned — returning Alice's whole
stake for the price of a probation-length lock. **Record existence is the test
that closes it**, and it also means a legal invitee has never posted and never
been liked, so the grant is always the record-*creating* event. ⛔ **The test is
IDENTITY-RECORD existence, never karma-box existence** — a karma-box test
carries the same hole in different clothes: an account that spent down to
nothing.

Being barred costs an uninvited party nothing: with no karma they have never
posted, so the identity carries nothing and a new keypair costs a keygen.

### What the grant carries, and what it does not

**Bob's signature is not part of the flow, and it was never the sybil defence.**
The bond is, and Bob's key could always have been Alice's second key. Consent is
already out of band: Bob gives Alice his public key.

⚠ **The cost, stated rather than hidden:** Alice may name 32 bytes nobody holds,
and the grant lands in a box no one can ever spend. It is **parked, not
destroyed** — the axiom holds — and her bond forfeits at probation's end against
a key that never engages, so stranding a grant costs Alice her full stake and
there is no arbitrage.

**The probation clock:** `IdentityRecord.invitedAtBlock` is the invite's own
height — the grant is the record-creating event, which both dates the probation
and bars the key from any further invite.

**Cancellation does not exist — dropped as UNRELIABLE, not as unimportant**
(user, 2026-08-17). Under the claim flow Bob could always claim faster than
Alice could regret, so cancelling was a race she might lose rather than a
guarantee she held.

**The rate limit is `K / B` invites per `INVITE_PROBATION_BLOCKS`** — the bond
locks for probation and resolves by outcome (below). ✅ **Nothing locks
forever.**

⛔ **Two inviters naming the same key in one block must not both grant.**
Apply-time refuses the second — and a block whose embedded transactions do not
all apply is refused whole, so a producer must not pack both. **A stated rule,
not an emergent property.**

### Bond outcomes

The bond settles **once**, at `IdentityRecord.invitedAtBlock +
INVITE_PROBATION_BLOCKS`, and reads one thing:
`IdentityRecord.lifetimeLikesReceived`.

| Scenario | Bond karma | Significance |
|----------|------------|--------------|
| Bob's counter reached `INVITE_BOND_VEST_PER_LIKES · B` | Returned to Alice in full | Alice vouched for someone the network valued |
| Bob's counter is lower | `floor(counter / INVITE_BOND_VEST_PER_LIKES)` returned, **the rest burned** | Alice's stake was partly forfeit |
| Bob never engaged | Burned entirely | Alice vouched for nobody |

**Which count settles the bond is the whole of the rule**, so the contract names
the field rather than saying "likes received". It is the identity record's
monotonic counter: incremented by per-block like settlement, **decremented by
nothing, prune included**. A count derived from live posts instead would let a
third party burn Alice's stake — Bob replies in Carol's thread, Carol prunes it,
Alice forfeits — which *"you may destroy your own stake, never someone else's"*
forbids.

Nothing else is consulted: not Bob's balance, not whether he is still active, not
when the likes arrived. **A single evaluation at the deadline is arithmetically
identical to accruing instalments**, because the vested amount is a pure function
of a monotonic count, which is why no per-block bond pass exists and a `BondBox`
is byte-identical from creation to the block that consumes it.

> ⚠ **SUPERSEDED by §The conservation axiom — "permanently destroyed" is the one wording it forbids.**
> This paragraph read *"Burned karma is permanently destroyed — not redistributed. Against the invite
> mint on the other side, a failed invite is a net loss of karma to the network and a fully successful
> one is a net gain."*
>
> ✅ **A forfeit bond RETURNS TO THE POOL.** Under the fixed vocabulary "burn" is a direction, so the
> table above reads correctly as written — the karma leaves Alice and does not come back, which is
> what a holder experiences. What was wrong was the mechanism, not the word.
>
> ⛔ **"Net loss to the network" and "net gain" are claims about CIRCULATION, and only about
> circulation.** Supply is fixed at genesis and neither a failed invite nor a successful one moves it.
> **Keep the two words apart**: a figure meant as circulating karma excludes the pool, and a figure
> meant as supply includes it. They were the same number until the pool existed, which is why the
> distinction reads as pedantry and is not.
>
> ✅ **Not redistributed still holds, and it is the load-bearing half.** The pool is not spendable by
> anything but a stated rule, so a forfeit enriches nobody. Routing it to the treasury instead would
> be redistribution wearing deflation's name — the same choice §Likes settles for the like remainder,
> settled the same way.

### Invite parameters

| Parameter | Description |
|-----------|-------------|
| `INVITE_MIN_KARMA` | Minimum karma an account must hold to invite (= `KARMA_POSTING_MINIMUM`) |
| `inviteBondMin` / `inviteBondMax` | The inclusive range the inviter's bond may take (`B`), **per network** |
| `INVITE_BOND_VEST_PER_LIKES` | Likes the invitee must receive per karma of bond returned (`V`) |
| `INVITE_PROBATION_BLOCKS` | Blocks from invite creation to bond settlement |

> ⛔ **`B = G` — THE GRANT IS THE BOND, so the bound cannot drift.** The inviter chooses `B` inside the
> network's range and the settlement grants exactly that out of the pool. A grant to a key nobody
> holds costs precisely what it strands, and there is no longer a second number free to fall below the
> first. The caps vary per network; the equality does not.
>
> ⛔ **`V` IS A SUPPLY DIAL, NEVER A SYBIL DEFENCE.** With `L = LIKES_PER_KARMA_PAYOUT`, vesting a bond
> `B` needs `V·B` likes and each like leaks `1/L` to the pool, so a completed invite moves
> **`B · (1 − V/L)`** into circulation — `+0.4·B` at `V = 3`, `L = 5`, and **exactly zero at `V = L`**,
> where the network cannot inflate at all. **A sybil circle nets the same figure honest growth does**,
> so tuning `V` favours neither. What bounds a sock-master is the `V·B` of their own liquid karma the
> likes cost, and that what lands on the sock is non-transferable and can never return.

---

## Validators

> ✅ **The role framing is stated below as what the code has.** "Validator" is a mode a node
> runs in, not a separate class of participant with its own lifecycle: `NODE_ROLE` is parsed
> in `node/src/config.ts`, gates whether `MINING_SECRET` is required, and selects the mining
> wiring (`index.ts` and `server.ts` branch on `config.nodeRole === 'miner'`). The **validator
> signature** on ordering blocks is real and load-bearing — verified on every apply path
> (audit H-1).
>
> ✅ **The remainder of this section is verified against the code, 2026-08-20.** Responsibilities,
> Validator selection, Rewards and Separation match `block-creator.ts`, `settlement.ts` and
> `MINING_INTERFACE → Emission Schedule`: the body is UTXO transactions and prune entries, the
> reward is the settlement transaction's output from the emission box, selection is PoW alone, and
> prune authorisation is the root author's signature.

A validator is a node producing ordering blocks by solving their Proof of Work.
It is a role a node plays, not a separate class of participant — the same key
material may also hold karma and author posts.

### Responsibilities

1. Produce ordering blocks — order UTXO transactions and prune entries into one
   committed body (per-block like settlement runs inside block application, not here)
2. Earn credit rewards as outputs of the block's settlement transaction, spent
   from the emission box

Validators do **not** attest to stumps. The prune authorization is the root
author's signature alone.

### Validator selection

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
> **fees and storage rent**, which are recycled rather than minted. The schedule, its end
> height and its emission total are `MINING_INTERFACE → Emission Schedule`.

### Separation from users

A validator may also hold a user account (karma, posts) but the roles are
cryptographically and economically independent. A validator's block reward
credit box and their user karma box are separate UTXO entries controlled by
separate keys if desired.

---

## Genesis

> ⚠ **PARTLY IMPLEMENTED — the karma seeding runs; the committee's purpose is a statement, not a
> mechanism.** `seedGenesisCommittee` creates one karma box per `genesisCommitteeKeys` entry,
> **drawn out of the pool** (`genesis-committee` mints, store seeding — there is no genesis
> ordering block). All three network profiles carry an **empty** committee today, so the grant
> loop runs zero times, and **nothing fails loudly if a chain starts with an empty committee**.
>
> **Genesis is where an unset consensus parameter is least recoverable** — it is baked into
> the first block and every state root after it. Before any launch: decide the committee
> set, decide whether an empty committee is a startup failure, and pin both. This belongs
> with the constants-pinning session, not to be defaulted into.

Bootstrap uses a **genesis committee**: genesis seeding creates one karma box per genesis
committee key, **drawn out of the pool**, and the committee's sole purpose is to invite the first
cohort of users and bootstrap ordering block production.

**A committee credit grant and a committee dissolution period are not part of the design as it
stands.** Their parameters — `GENESIS_CREDITS_PER_MEMBER` / `genesisCreditsPerMember` and
`BOOTSTRAP_PERIOD_BLOCKS` / `bootstrapPeriodBlocks` — were removed 2026-08-21 (user ruling): no
seeder read the one and no dissolution read the other, and a parameter nothing reads cannot be
relied on. A mechanism that needs either brings its own parameter with its own reader.

| Parameter | Description |
|-----------|-------------|
| `GENESIS_COMMITTEE_KEYS` | List of public keys in the genesis committee |
| `GENESIS_KARMA_PER_MEMBER` | Initial karma per committee member |

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

1. **Genesis:** The genesis state seeds the system boxes (karma pool, emission,
   faucet — no treasury box: it would hold 0, and it is created at the first
   nonzero split, `genesis-state.ts`) and the genesis identity
2. **Invite:** An inviter bonds karma naming the invitee's public key; the block's
   settlement grants the invitee's starting karma from the pool (§Invite System)
3. **Account creation:** The granted karma box and the invitee's identity record
   are the account — there is no claim transaction
4. **Posting:** User builds a post packet — the transaction carries the `PostCommit`
   (structure and content commitment) and the karma post-lock prices it; the body
   rides beside it, outside every id → mempool (`utxo_tx`) and the DAG's pending row,
   admitted together or refused together
5. **Liking:** User spends karma → like transaction → mempool (standalone)
6. **Ordering:** Block creator pulls from mempool (FIFO), assembles the body
   (UTXO txs + prune entries), appends the settlement transaction, mines PoW,
   finalizes → state applied atomically
7. **Like settlement:** Every block, at the end of the mutation phase — the
   settlement transaction consumes the block's markers and each credited
   author's carry box, pays authors and the pool, and emits carry successors;
   post-lock vesting evaluated (§Likes)
8. **Pruning:** Author signs prune intent → stump constructed with deterministic
   karma deltas → committed in ordering block → the subtree's DAG rows deleted
   (journalled), the stump written
9. **Vouch escrow:** An unvouched stake waits in a `VouchEscrowBox`; the first
   block at or past `releaseAtBlock` returns it to the voucher through its
   settlement transaction — no client action claims it
10. **Net:** libp2p gossips ordering blocks and transaction packets (transaction +
   body). Stage 1 (stateless) validation via `@dagsocial/validation` runs before
   forwarding — for a post packet that includes the body against its commitment.
   Stage 2 (stateful) validation runs in the node after receipt. Relay handlers
   insert into mempool, a post's body into the DAG as a pending row — state
   applied at block application.
11. **Backfill:** a node that applies a post transaction without having seen its
   packet holds a placeholder — structure, no body — and pulls the body by id:
   from its sync peer in the `backfill` phase, from the relaying peer afterwards
   (NET_INTERFACE → Sync State Machine)

---

### Wire Format

Stream messages are framed: `[magic:4][version:1][code:VLQ][length:VLQ][checksum:4][body]`. Gossip
bodies are positional — ordering blocks through `decodeOrderingBlock`, transaction packets through
`decodeTxPacket` (`net/src/gossip.ts`): the transaction's own bytes, then the post body as an `opt`
that is present ⟺ the transaction carries a `PostCommit` (NET_INTERFACE → Gossip Topics). A stump
never travels: it is a local projection with no wire
form (`NODE_INTERFACE` → "Stumps are derived state"; `TYPES_INTERFACE` → Layout — Stump /
PruneEntry). The normative per-struct layouts live in `TYPES_INTERFACE.md` → Serialization,
not here. Wire-codec types (ByteReader, ByteWriter, VLQ) live in `@dagsocial/wire`.

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
> Every field is read from the profile — `genesisCommitteeKeys` and `genesisKarmaPerMember` by
> `services/genesis-state.ts` rather than `config.ts`, to seed the committee out of the pool —
> since the two fields nothing read (`bootstrapPeriodBlocks`, `genesisCreditsPerMember`) were
> removed 2026-08-21 (§Genesis). A field nothing reads cannot diverge from the profile; it
> equally cannot be relied on, which is why those two went.
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

A network is the pairing of a **parameter profile** with a **genesis state**. Three exist:

| Network | Purpose | Wiped on |
|---|---|---|
| `mainnet` | The real chain | Never |
| `testnet` | Public, used, non-breaking changes | Deliberate relaunch only |
| `devnet` | Local and disposable; protocol-breaking changes | Freely |

The taxonomy and the purpose split are Ergo's (`ergo.networkType`, with testnet for
non-breaking and devnet for protocol-breaking testing). The third network is **not** called
`regtest` — that is Bitcoin's word for a different thing.

> ✅ **"genesis state", not "genesis block" — resolved 2026-08-13 in favour of the code.** This
> sentence said *block* while `node/src/store/system.ts` said *"genesis is not a block"*, and the
> code is right: **there is no height-0 block anywhere in this protocol.** Ergo's shape, verified in
> source — cold start seeds a box set into the AVL+ tree behind a committed flag, and height **1** is
> the first *mined* block.
>
> What a network commits to is therefore a **33-byte digest**, not a header: `NetworkProfile
> .genesisStateRoot`, the height-0 AVL+ root, pinned per network and checked against the seeded state
> at boot. `types/src/network.ts` carried the same sentence in code and moves with it.

### Profile selection

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
> broken, but by a **bypass rather than a read** — see the note under §Network identity invariants.

### What varies per network, and what must not

**Per-network — the timescale, difficulty, genesis and cap axes:**
`ORDERING_BLOCK_POW_TARGET_BITS` · `KARMA_DECAY_INTERVAL_BLOCKS` ·
`KARMA_STALE_THRESHOLD_BLOCKS` · `VOUCH_COOLDOWN_BLOCKS` · `INVITE_PROBATION_BLOCKS` ·
`CREDIT_MINER_REWARD_DELAY` · `CREDIT_FIXED_RATE_BLOCKS` ·
`CREDIT_EPOCH_BLOCKS` · `GENESIS_COMMITTEE_KEYS` · `GENESIS_KARMA_PER_MEMBER` ·
`genesisProofPayload` · `genesisStateRoot` ·
`inviteBondMin` · `inviteBondMax` · `faucetPublicKey`

The last two are spelled as `NetworkProfile` fields because that is their **only** definition: every
other name in the list is either a `constants.ts` export or a retired environment variable, and these
two are neither. They are one fact stated twice — `genesisProofPayload` is the sole per-network input
to the genesis box set, and `genesisStateRoot` is the height-0 AVL+ root over it. Both belong to the
genesis axis this section already declares, so they add fields to a declared axis rather than opening
a fourth.

**Universal — every other constant, including consensus ones:** the format limits
(`MAX_CONTENT_BYTES`, `MAX_PARENT_REFS`, `PROTOCOL_VERSION`, `AVL_KEY_LENGTH`) and **every
karma and credit cost** (`LIKE_KARMA_COST`, `LIKES_PER_KARMA_PAYOUT`, `POST_LOCK_*`,
`VOUCH_KARMA_AMOUNT`, `INVITE_BOND_VEST_PER_LIKES`, `KARMA_MINIMUM`, `KARMA_DECAY_AMOUNT`,
`COINBASE_TREASURY_PCT` and the other coinbase slice percentages,
`CREDIT_INITIAL_REWARD`).

**The split is normative: mechanics are universal, caps may vary.** A defect lives in a formula,
a ratio or a mechanism — never in the size of a limit. A network running a larger `inviteBondMax`
catches every bug a smaller one would; a network running a different vesting formula catches none
of them. **Every per-network parameter states which of the two it is**, and a mechanic still carries
the old burden: adding one is a place where devnet and mainnet behave differently, which is precisely
where a defect hides from the test written to catch it. A test chain needs a 3-block decay interval;
it does not need cheaper likes.

⚠ **`INVITE_BOND_VEST_PER_LIKES` is the boundary case, and it sits on the universal side.** It is a
**ratio** — with `LIKES_PER_KARMA_PAYOUT` it fixes how much of a grant survives as circulating supply
(§Invite System) — so a network that moved it would run different economics rather than looser ones.
The bond *bounds* around it are caps and vary freely.

### What each network is

- **devnet — debug mode.** Tests, fast blocks, shortened timers, and relaxed constraints where a
  specific test asks for one. **It carries no obligation to mirror mainnet.**
- **testnet — the public playground.** Mainnet's **mechanics**, **relaxed caps**. It is where humans
  exercise the platform, not where invite or vesting mechanics are verified — devnet is that.
- **mainnet — not yet launched.** Its weights are placeholders that hold the shape until testnet
  produces the evidence to set them from, and it may appear as **pre-mainnet** before making the jump.
  ⚠ **A mainnet number in this repo is not a decision**; treat it as unset unless it says otherwise.

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

**The mechanism this row names is `genesisStateRoot`, and the node refuses to run without
it.** Each profile pins the height-0 AVL+ root over its own genesis box set, cold-start
seeding computes that root and compares, and a mismatch is fail-stop rather than a warning —
`assertGenesisRoot` in `node/src/services/genesis-state.ts`, checked inside the seeding
transaction so a divergent genesis is never committed. The per-network input is the
`genesis_proof` box's payload: the system karma and faucet credit boxes are byte-identical on
testnet and devnet, so the proof box is the whole of what separates those two roots.

⚠ **Dated, because the row above read as a live mechanism before one existed.** Genesis was
per-network in this contract from the start and was not per-network in the tree: until
2026-08-13 the seeded boxes never reached the AVL+ tree at all, so all three networks shared
the empty-tree digest and nothing pinned a root to compare against. The row is true as of that
date; statements resting on it that predate it were aspirational, and the `networkType`
rejection note below is the instance worth naming.

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
> ⚠ **The `NETWORK_TYPE` half of that sentence was false when it was written and is true from
> 2026-08-13.** Rejecting the field was argued partly on a chain link that did not exist: with
> no per-network genesis, flipping `NETWORK_TYPE` against an existing store changed the
> profile and nothing else, and the store carried on. The rejection stands on its other
> grounds either way — an attacker fills the field in correctly, and the rule's stated
> enforcement point was homeless in three contracts. What changed is that the argument now
> holds: an operator who flips `NETWORK_TYPE` and starts against a store carrying the old
> network's genesis is on a chain that forks from every peer at height 1, which is the failure
> the sentence claims. ⚠ **It is not caught at boot, and the sentence does not claim it is.**
> Seeding is keyed on the committed flag, so `assertGenesisRoot` does not re-run against a
> store that already has a genesis; refusing there would need a stored network stamp, which
> nothing writes.
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

Every post, stump, ordering block, and UTXO transaction carries a
`protocolVersion` field. Validation rules are keyed to this version:

- **Version 1 (current):** Dual-ledger architecture, sovereign subtrees, stumps,
  UTXO karma/credits, likes, invite system, ordering blocks, PoW
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
> implementation) and five are the bigint/value-denomination and authorization/decay rules Specs B
> and G touched. Of the 15 false, **ten are July text**, and **all ten Ergo-Adopted bullets
> are July text** — six false, three unenforced or qualified, one true.

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
  > a vouch cast carrying a **foreign `voucherId`**, which produces a box naming that
  > foreign key — a `vouch` input's authorization requires the box's own `voucherId` — so A stakes and B
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
  > reads the block's own `LikeAccrualBox` markers, the carry boxes and `like_records` —
  > consensus state written only at block application (`block_topology` tier), never by a
  > route.
- Stumps are the sole bridge: DAG compaction → karma issuance
- A like is a burn transaction plus a `(liker, post)` like-record — no box, no held
  value. Like-records are content-layer consensus state (`block_topology` tier):
  deterministic by replay, journalled with exact inverses, deleted with the post at
  prune, not in the `stateRoot`. (`LikeBox` and the free-like tier are retired — P2-D.)

### Cryptographic

- Hashing: `blake2b512` truncated to 32 bytes for all 32-byte outputs
- Signatures: raw Ed25519 (64 bytes). **On the wire the encoding depends on the
  carrier, and "base64" — as this line previously read — is the rarest of the three:**
  raw bytes in the positional encodings (all consensus structures), **lowercase hex** at the HTTP
  boundary (`json-to-tx.ts`) and in the demo UI, and base64 at exactly one endpoint
  (`routes/utxo.ts`). Verification is `crypto.verify(null, …)` with a KeyObject in
  every case
  > ⚠ **Non-malleability is relied upon and stated nowhere.** Measured on node v22.19.0 /
  > openssl 3.0.17: `crypto.verify` rejects the classic `S + L` malleation and the
  > high-bit variant, enforcing RFC 8032's `0 ≤ S < L`. This matters because
  > `serializePruneEntry` puts `authorSignature` **inside** the `prune` Merkle leaf, hence
  > inside `utxoTxRoot` — every other signature in the system is excluded from every
  > preimage. A second verifier (light client, a pure-JS Ed25519 library) that is
  > cofactored or skips the range check would accept a second valid signature, and there
  > it would mean two valid *blocks*. **Any mirror implementation MUST enforce
  > `0 ≤ S < L`.** Untested: non-canonical `R` encodings, small-order points,
  > cofactored-vs-cofactorless verification
- Public keys: 32 raw bytes, hex-encoded on wire
- Secret keys never in API responses, DTOs, or committed data structures


### Content sovereignty

- Post author owns the entire reply subtree under their post
- Pruning cascades to all descendants — replying is consent to this
- Pruning requires root author's signature (sole authorization)
- Pruning is irreversible
- The author's signature is the only prune authorization there is — a prune
  has no `trigger` field and no other cause (ruled 2026-08-19)
- A block commits a post's structure (`PostCommit`) and its content commitment, never its
  content; the body lives only in the DAG
- Pruning deletes: once the prune block's journal is dropped below `MAX_REORG_DEPTH`, a node
  holds no byte of the subtree's content — no DAG row, no journal row; within that depth the
  rows exist only as undo records, never served

### Identity invariants

- An account comes into existence via first UTXO box appearance
- An invite names one public key and is claimable only by it. There is no secret,
  no preimage and no bearer form
- An invite can be cancelled by its inviter until it is claimed, and never expires
  otherwise
- An invite may only name a key that is **not already an account**, so a key is
  invited at most once ever
- Invite bonds vest against the invitee's lifetime likes and the unvested part is
  **burned** at the probation deadline
- ~~Usernames: first-claim-wins, DAG-native, prunable by holder~~
  > ⚠ **SUPERSEDED (2026-08-06). Verified 2026-08-11 — no `username` code in any `src` tree.**
  > Usernames become a **UTXO asset**: tradeable for
  > credits, free to claim while unused, burnable by the owner. Not a claim post, so
  > "DAG-native" and "prunable by holder" no longer apply. Deferred — see §Username claims
  > and design track §5.9. **Profiles are unaffected and stay DAG-native as self-posts.**

### UTXO conservation

- **Karma supply is fixed at genesis and never changes** — nothing is created or destroyed
  after the genesis seeding (§The conservation axiom). What moves is **circulation**: the
  settlement transaction spends the pool and receives into it, and it is the pool's **only**
  spender — one settlement per block, so two spends never contend (NODE_INTERFACE → The
  settlement transaction). Exactly three transfers return karma to the pool — **decay**,
  **the like remainder** (per `x = LIKES_PER_KARMA_PAYOUT` likes, `x−1` recirculates to the
  author and 1 goes to the pool) and **bond forfeiture** (the unvested remainder at a bond's
  settlement, the pruner's own locks riding the same rule) — and the **invite grant** draws
  from it: `G` enters circulation when a bond is created, and the unvested part leaves when
  it settles. Circulation grows only as fast as the network admits members who earn likes,
  and shrinks when it admits members who do not — on top of decay and the like remainder,
  which run against everyone.
  > ⛔ **"Supply" and "circulation" are different quantities and the words are not
  > interchangeable.** Supply is fixed; circulation is what invites and transfers to the pool
  > move — *"the invite is the network's only source of karma"* is a statement about
  > circulation. The checkable invariant: **`sum(every karma-bearing box) + pool` is constant
  > from genesis at every height** (`node`'s `conservation-axiom.test.ts` asserts it). ⚠ **It
  > is a DIFFERENT sum from `getTotalKarma`**, which reports circulation and deliberately
  > excludes the pool; asserting either against the other is the error this note exists to
  > prevent.
- Total credit supply = genesis + ordering block rewards - future sinks
  > The reward term is bounded: emission terminates, totalling 422,640,000 credits
  > (`MINING_INTERFACE → Emission Schedule`). Genesis credits sit on top of that and sinks
  > pull the other way, so the supply is bounded above by `genesis + 422,640,000` and is not
  > equal to it.
  >
  > **The bound is held as state, not only as a rule.** Genesis creates an `EmissionBox`
  > holding the whole total, and every block releases from it rather than minting
  > (TYPES_INTERFACE → EmissionBox). An observer reads how much may still be emitted
  > instead of trusting that a schedule will be honoured — which is what makes the
  > fair-launch claim checkable on day one rather than a promise about future code.
- **Every UTXO transaction conserves value, unconditionally — the exception list is empty.**
  **NODE_INTERFACE's `validateTx` step 7 is the authoritative statement** — derive from it,
  never maintain a parallel list here. Each cost lands in a box the transaction itself
  outputs, so every user transaction balances on its own; all other value movement happens
  only in block-application paths — the settlement transaction and post-lock vesting — never
  inside a user transaction.
  > **Credits and karma both conserve strictly, and there are no deficits.** A fee is a
  > `FeeBox` output the transaction names (TYPES_INTERFACE → FeeBox), so what the miner
  > takes is inside the output sum rather than a gap between two sums; a like's cost rides
  > its `LikeAccrualBox` marker the same way. The like rule is a statement about **shape**,
  > enforced both ways in the engine's like arm: `likeTarget` present ⟺ exactly one accrual
  > marker of `LIKE_KARMA_COST` naming the target's author — and the pin must be tested,
  > because a balanced marker announces nothing by itself (NODE_INTERFACE → The like accrual
  > marker is an exemption from the rule above). Conservation is **enforced**:
  > `checkValueConservation` per transaction, full
  > re-validation at apply.
- Box `value` and all value/amount arithmetic are `bigint` integer base units
  (`value < BOX_VALUE_BOUND`, TYPES_INTERFACE → "Box value domain"); **no float math in any consensus value path** — floats are
  non-deterministic across platforms and credit sums exceed 2⁵³ (Spec B P0)
- A box can only be consumed by a transition whose authorization requirement is satisfied
- Karma decay is virtual — effective value at every sufficiency read — and is
  squared into committed state by the settlement of the block whose body
  touches the identity (§Karma decay)

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
  Every mutation class — settlement legs, bonds, like accounting, coinbase
  splits, and future ones like storage rent — journals through the same log
  unchanged.
- **Rollback replays inverses.** Reverting a block walks the log in reverse:
  `insert` → delete the box, `remove` → un-spend it. Non-box side effects
  (post confirmations, like-records,
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

### Blocks and ordering

- **There are no sub-blocks.** A post is a transaction, so it rides `utxoTxIds`
  with every other transaction and the block commits one body, not two.
  `SUBBLOCK_INTERFACE.md` is **deleted** — it described a structure that no
  longer exists, and the rules that survived it are in `TYPES_INTERFACE` →
  UtxoTransaction / OrderingBlock and `NODE_INTERFACE` → Post transactions.
- Ordering blocks are validator-produced; consensus is **single-phase PoW**,
  which is what it always effectively was
- Like dedup is structural: the `(liker, post)` like-record exists or it does not
- Like accrual and settlement happen every block — there is no epoch (P2-D)
- **A block body is bounded in bytes, and a valid block is always servable.**
  `MAX_BLOCK_BODY_BYTES` < `MAX_SERVE_BODY_BYTES` < `MAX_STREAM_BYTES`
  (`TYPES_INTERFACE` → Size caps). The bound is checked in structure validation,
  which is what runs **before relay**, so an oversized block is refused rather
  than forwarded and then refused. ⚠ **The ordering is the invariant, not the
  three numbers** — inverting any pair produces a block that consensus accepts
  and no syncing peer can fetch.
- **Weight is bounded in bytes, never in transactions**, and the two do not
  coincide: a transaction's encoded size is a property of the codec, which
  `TYPES_INTERFACE` → Layout — UtxoTransaction is already specified to change.
  A byte bound survives that change as a capacity gain; a count bound would have
  had to be re-derived, and the storage guarantee it was chosen for would move
  with it.

### Network identity invariants

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
  > **Residue, and it is a different class.** `genesisCommitteeKeys` and `genesisKarmaPerMember`
  > are read by `services/genesis-state.ts` to seed the committee; `GENESIS_COMMITTEE_KEYS` is
  > empty on all three profiles, so that loop runs zero times — see §Genesis. The two profile
  > fields nothing read (`bootstrapPeriodBlocks`, `genesisCreditsPerMember`) were removed
  > 2026-08-21. A field nothing reads cannot diverge; it equally cannot be relied on.
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

### Treasury

A slice of every coinbase and of every fee accrues to the treasury, from genesis onward, and
**never a slice of storage rent** — rent is the security tail, and it belongs to miners. The
forfeited part of the inclusion bonus accrues there too, which is what makes the bonus a cost
to a miner who excludes rather than a delay.

**Unspendable by absent rule.** No protocol rule permits a treasury spend. This is not a
withheld key: it is a `TreasuryBox` (TYPES_INTERFACE → TreasuryBox) that only block application
may spend, and block application carries no path that releases from it. Inviolable by
everyone, the project included, because there is nothing to hold.

**A key would be a weaker claim, not a simpler one.** A box paid to a key nobody admits to
holding is spendable the moment that assertion turns out to be wrong, and it cannot be checked
from outside. It also pre-empts the intended governance: a future protocol version puts treasury
spending to a karma vote, and a keyholder able to spend regardless would make that vote
advisory.

**Growth is intended.** Credits held there are out of circulation, so the treasury is mildly
deflationary and grows without bound until a spend gate exists — the second term of the credit
supply's upper bound, not an addition to it.

---

## Ergo-Adopted Invariants

These invariants are adopted from production-grade Ergo Rust node practices:

> ⚠ **This whole section is 100% original 2026-07-26 text and it is the worst-performing
> block in the document: of its ten bullets, six are false, three are unenforced or
> qualified, and one is true.**
>
> **Check the premise before adopting anything else from Ergo.** One analogy failed on its
> first form and transferred on its second: while `createdAtBlock` was the decay clock, a
> client-declared height was untenable and the field left the box protocol, the clock moving
> into committed state. It returned as creator-declared content once the decay clock stopped
> reading it (TYPES_INTERFACE → "BoxCandidate is the base, CandidateOf<B> is the per-type
> candidate") — Ergo's shape, with the obligation stated
> rather than assumed: **every rule that derives from the field owes its own exact check**,
> and the vouch cast window (NODE_INTERFACE → Vouch transition rules) is the first.
> An invariant that is correct for Ergo and wrong here, kept because the
> analogy sounded right, is this section's characteristic failure. **The transliteration risk
> is not hypothetical here**: this section's first bullet had to be restated because a rule
> against *truncating* casts, correct in Rust, names nothing TypeScript does — and misses the
> larger hazard `as` actually carries.

### Validation boundaries
- **Untrusted input reaches no unhandled throw** — every deserialization and
  signature-verification function answers with a value or a typed error. A decoded
  value entering a typed field is **range-checked, never `as`-cast**, and nothing
  allocates on an attacker-chosen length.
  > ✅ **All three limbs hold — the third measured 2026-08-23.**
  > - *Allocation.* `readArray` bounds on `MAX_ARRAY_LENGTH` **and** on the bytes remaining
  >   before allocating (`wire/src/reader.ts`), and `cumulativeWork` skips any `powTargetBits`
  >   outside `orderingPowTarget`'s domain (`VALIDATION_INTERFACE → blockWork / cumulativeWork`).
  >   Neither allocates on attacker-chosen input.
  > - *Casts.* The sync decode boundary runs every body through its positional codec and never
  >   throws; malformed bytes collapse to `null` and nothing unvalidated escapes the codec
  >   (`net/src/sync-codec.ts`).
  > - ✅ *Throws — measured 2026-08-23.* The claim behind this limb named "an unguarded throwing
  >   step between the Stage-1 pipeline's documented calls": the gossip topic validators
  >   (`NET_INTERFACE → Stage 1 (net package, stateless)`, `net/src/gossip.ts`). Each validator
  >   runs its whole sequence — decode, structure, protocol version, then PoW for an ordering
  >   block or the packet rule, body and membership for a transaction — inside one `try`; a throw
  >   anywhere is caught, penalised as `ProtocolViolation` and the message Rejected, and the
  >   deliver arm catches the re-decode and the handler separately. No step between the
  >   documented calls throws unguarded. This measures the pipeline the claim named; the sync
  >   decode boundary is the *Casts* limb's.
  >
  > **The clause says `as`-cast rather than "truncating cast", and the difference is the
  > whole point.** A TypeScript `as` does not truncate: it erases at compile time and asserts a
  > type nothing checked, producing no runtime error at all. That is a *larger* hazard than a
  > truncating numeric cast, and a rule phrased against truncation does not catch it.
  >
  > **"Untrusted" is load-bearing.** The fail-stop family deliberately ends the process, but
  > only on this node's own state — its stored bytes, or two of its own stores disagreeing. See
  > `NODE_INTERFACE` and `node/src/services/corrupt-state.ts`. That is not an exception to this
  > bullet; it is a different subject.
- **Validate, don't trust** — independently recompute every self-reported
  claim. A post's parent refs and its creating transaction's signature MUST be
  verified by the local node before the post enters the store.
  > ✅ **RESOLVED BY STRUCTURE on both write paths.** `dag_posts` has one production
  > writer — `insertPost` — with two production callers.
  > - `post-service.ts` cannot store ahead of validation, by naming: `createPost`
  >   derives the post id from the `TxId` that `validateTx` returns
  >   (`computePostId` takes no `Post`), so the store write has nothing to name
  >   until the creating transaction has passed.
  > - Block application holds the content itself: a post is a transaction, the
  >   placeholder path is deleted, and the F6 unsigned-refs route with it. It
  >   stores and confirms posts ahead of the embedded-transaction re-validation,
  >   inside one synchronous SQLite transaction — every rejection path rolls the
  >   whole phase back, so a post stored by a rejected block is never readable.
  >
  > (A third path — `onStump` storing unauthenticated gossip stumps — is closed: no network
  > path writes `dag_stumps`; see §3.)
  >
  > ⚠ **`verifyPoW` has three call sites and a re-export, and one site is outside the
  > verifier** — `net/src/gossip.ts` (gossip relay validation), and `verifier.ts` inside both
  > `verifyPost` and `verifyPostForRelay`. The re-export at `node/src/services/pow.ts` is a
  > second entry point under a different module path, invisible to a search for callers of the
  > original. **Unreachability from block application is unverified** — it rests on a search
  > nobody has run, so treat it as open rather than as either answer.
- **Every validation rule declares itself protocol or local policy** — a rule
  every node must reach the same verdict on is protocol and changing it forks the
  network; a rule this node applies alone is local policy and may change freely.
  The declaration goes at the rule's own definition.
  > ✅ **This replaces "never add checks the reference lacks", which had no referent.** There
  > is no reference implementation — this node is the only one — so that form named nothing,
  > and a rule keyed on a document nobody can open cannot be applied. What it was reaching for
  > is the fork surface, which the form above states directly.
  >
  > ⚠ **The knowledge exists per-rule and is nowhere aggregated.** `verifyContentCharacters`
  > declares itself at its own definition (`validation/src/content-charset.ts`) as *"a
  > **consensus Stage-1 check**: every node must reach the same verdict for the same bytes"*,
  > and derives its pinned-codepoint implementation from that. There is no repo-wide register,
  > so a contract-side search cannot answer "which rules are protocol?" — **whether to derive
  > that register or keep pointing at the definitions is open**, and it is the same question
  > as the consumer-list one.

### Storage guarantees
- **Chain growth is bounded by consensus, at ~1.05 TB/yr.** `MAX_BLOCK_BODY_BYTES`
  of 2,000,000 across 525,960 blocks a year (60 s target) is the ceiling an
  archival node plans against. ⚠ **It is a worst case, not a steady state**: it
  assumes every block full and nothing pruned, while prunable content and stumps
  mean a pruning node grows more slowly. It is not the figure a light client
  stores.
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
  > positional-format bundle.** Every leaf hashes the committed struct's own wire bytes, stated
  > once in `@dagsocial/types`. ⚠ **Three leaf types remain** — `prune`, `utxotx`, `stump` — and
  > they speak one dialect. `subblock` and `coinbase` are retired with their encoders
  > (`subBlockEntryBytes`, `coinbaseOutputBytes`), which this sentence named as live and which
  > have no definition anywhere; **TYPES_INTERFACE → Merkle primitives holds the one live/retired
  > list** and this line must not restate it.
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
  > specs as-is. `epoch` and `likebox` are deleted by P2-D.

### Package boundaries
- **No dependencies above the package's abstraction level** — the storage
  layer MUST NOT import the node's configuration, networking code, UI code, or
  post content types as values (`import type` only). Beyond DB bindings and
  hashing it imports the `@dagsocial/types` codecs it stores through
  (`encodeTx` / `decodeTx`, `computeTxId`, `computePruneEntryId`) and node-local
  pure helpers and error classes from `journal`, `karma-supply`,
  `mint-provenance` and `services/` — functions and classes that carry no
  configuration, I/O or state. Anything that does — a local setting, the net, an
  engine — reaches a store module through a setter `index.ts` calls at startup,
  as the mempool cap does (`MEMPOOL_INTERFACE → Size cap — reject, never evict`),
  the way `index.ts` wires the node's other seams (`setNet`, the
  karma-membership hook, `setMempoolCap`).
- **"Does NOT own" on every package** — each package explicitly lists what
  it is NOT responsible for. Prevents scope creep.
  > **True — all five packages carry it.** Note it lives in `packages/*/CLAUDE.md`, not in
  > `contracts/`, so it is a session-context convention rather than a contract one.

### Data integrity
- **A post carries no timestamp; on-chain time is block height.** Confirmed posts order by
  the committed order — `(block height, position in block)`; a pending post orders by local
  arrival, a stated node-local convenience (NODE_INTERFACE → Posts). The one wall-clock
  field in consensus is the block header's `createdAt`: producer-set, domain-checked, read
  by no rule — a client wanting a display time reads the post's confirming block's
  `createdAt`.
- **Preconditions documented where violating one is unrecoverable** — a function
  that can fail-stop the process, or that is the sole writer of consensus state,
  states what it assumes of its caller. Elsewhere the types are the contract.
  > ✅ **Deliberately narrow, and the broad form is not what this asks for.** A precondition
  > block on every public function in `store/` and `services/` is not enforced and would not
  > be: there are 195 `export function`s across those two directories (measured 2026-08-20), and no
  > file in `packages/node/src` contains the word "Precondition". A mandate nothing meets reads as
  > satisfied because nobody checks it.
  >
  > The narrow form is checkable by reading the fail-stop sites, and it is met today by the
  > `CorruptChainStateError` family (`node/src/services/corrupt-state.ts`) and by
  > `createOrderingBlock` (`node/src/store/ordering.ts`), which states the provenance every
  > argument against a peer-caused fail-stop rests on.

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
   the vitest process. A suite that spawns `dist/index.js` as a child process runs the built
   artefact, so it needs a genuine build first and no alias reaches it. **One suite does:
   `tools/e2e` (`@dagsocial/e2e`) spawns `packages/node/dist/index.js` for every node of its mesh,
   and that process loads `types`, `wire`, `validation` and `net` from their `dist` in turn** (the
   node bundle externalises its workspace dependencies). It refuses to run when any of those five
   `dist/index.js` is missing or older than the newest file under that package's `src/`, naming the
   package — a stale build is a refusal, never a run against old code that reports green. The gate
   order in rule 3 is what keeps the refusal from firing: build first. Being under `tools/*`, the
   suite is in `pnpm -r test` by the workspace glob; nothing has to remember to run it.
5. **Test trees are typechecked — all five packages, at zero.** Each `typecheck` script runs
   `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`, so `pnpm -r typecheck` compiles every
   test tree in the workspace. Node was the last to land: 409 errors → 0, in one unit, with **zero
   `src` edits**. The debt did not come apart mechanically — a bulk retype of all missing-provenance
   box literals to `CandidateOf<>` drove the count UP (409 → 424), because node's fixtures are
   stored boxes and transaction candidates wearing one shape, told apart only per site by asking
   what reads the value.
   What the wired trees caught immediately, none of it visible before: a mock summing karma as a JS
   number behind a `bigint` interface whose value the route renders with `.toString()` (wrong output
   past 2^53); fixtures seeding boxes whose `stored.id !== computeBoxId(stored)`, violating the
   invariant `computeBoxId` calls true by construction (`types/src/utxo.ts`, at the
   `stored.id === computeBoxId(stored)` note above the function — **not `:210-212`, which the old
   pin named and which is an unrelated comment about `BOX_TYPE.read`**). Each package
   carries a `tsconfig.test.json` (`include: ["src", "test"]`) wired into its `typecheck` script, so
   `pnpm -r typecheck` covers what the suites actually execute — an unchecked test tree is exactly
   where a new *required* field (e.g. `UtxoDeps.networkType`) hides as a runtime surprise, and where
   mocks of deleted fields rot silently (a header test once mocked a deleted struct's field for
   units after the struct died). Two constraints, both measured 2026-08-08: the config extends `tsconfig.base.json`
   **directly**, not the package `tsconfig.json` — `extends` cannot *unset* the inherited
   `rootDir: "src"`, and the cross-package `paths` files below then violate it (TS6059); it declares
   `paths` mapping `@dagsocial/*` to `../<pkg>/src/index.ts`, mirroring the vitest alias above —
   without it `tsc` follows `exports` to `dist` types and re-opens the stale-`dist` class this
   section exists to kill. Baseline debt when this rule was written: **455 errors** (types 18 · wire 1 ·
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

**`NODE_INTERFACE.md → Store Interface` is authoritative for the schema — do not derive
table names from this section.** Single SQLite database, single WAL, single connection.
Post topology lives in `block_topology`; there are no sub-block tables and no sub-block
mempool rows. `peers` backs `@dagsocial/net`'s PeerDb across restarts. `dag_posts` is the
DAG: structure from the transaction, `content` nullable — `NULL` is a placeholder awaiting
backfill — and a pruned post has no row (NODE_INTERFACE → Store Interface → Posts DAG).

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
- Invite system: karma-bonded invites naming the invitee's key; the block's
  settlement grants the starting karma (§Invite System)
- ~~Post karma locking with gradual unlock at epoch boundaries~~
  > ⚠ **PARTIAL. Verified 2026-08-11** — `PostLockBox` is a live interface in
  > `types/src/utxo.ts` and a member of the `AnyBox` union. The post bond is real and stays — it is
  > the anti-dodge
  > mechanism. But **"at epoch boundaries" is superseded**: vesting moves to per-block with
  > the epoch's removal, and block application is the box's only spender.
- Ordering blocks with validator PoW; posts and likes ride them as ordinary
  transactions
- Verifiable prune: block-level PruneEntry, Ed25519-signed, UTXO-deterministic
  settlement (the settlement transaction consumes PostLockBoxes and refunds
  lock owners other than the pruner; like-records deleted)
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
- **Replacement semantics (RBF):** superseding a pooled entry with a higher-paying
  one. Priority fees and fee-based eviction **ship** (MEMPOOL_INTERFACE → Eviction,
  inside the credit class only); replacement does not — a pooled entry is still
  never replaced or updated
