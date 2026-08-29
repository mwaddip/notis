# TYPES Interface Contract

**Component:** `@dagsocial/types`
**Protocol version:** 1
**Last updated:** 2026-08-23

## Scope

Shared data structures, serialization, base58 encoding, hash functions, and
protocol constants. Pure functions only — no side effects, no I/O, no imports
from other DAGsocial packages.

Exports from `packages/types/src/index.ts`. All types are importable by
consumers; functions are pure and synchronous.

---

## Identity (`identity.ts`)

An account IS its Ed25519 public key. There is no separate "account" concept,
no username table, no registration step. A user exists on the ledger the first
time a UTXO box references their public key.

| Export | Signature | Description |
|--------|-----------|-------------|
| `KeyPair` | `{ publicKey: Uint8Array(32), secretKey: Uint8Array }` | Ed25519 keypair (public: 32 raw bytes, secret: PKCS8 DER) |
| `UserId` | `Uint8Array` | 32 raw bytes — the Ed25519 public key |
| `generateKeyPair()` | `() => KeyPair` | Node `crypto.generateKeyPairSync('ed25519')`, strips SPKI DER wrapper to extract raw 32 key bytes |

`UserId` is binary. On the HTTP API wire it is hex-encoded (64 hex chars).
In the positional codecs it stays raw bytes. There is no `getUserId` hash function — the public
key IS the identity.

---

## Core Types (`post.ts`)

### Post

```
PostCommit {                   // rides the creating transaction (tx.post) — consensus
  contentHash: Uint8Array(32)  // blake2b512(POST_CONTENT_DOMAIN || utf8(content)).subarray(0, 32)
  author: UserId               // 32-byte Ed25519 public key (Uint8Array)
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS
  protocolVersion: number      // 1
  type: PostType               // 'regular' | 'profile' — enum8 on the wire
}

Post {                         // the DAG's object — never in a block
  content: string              // 1–MAX_CONTENT_BYTES UTF-8; computeContentHash(content) == commit.contentHash
  author: UserId               // the commit's four, verbatim
  parentRefs: PostId[]
  protocolVersion: number
  type: PostType
}

PostId = blake2b512(POST_ID_DOMAIN || utf8(txId) || u32BE(index))
         .subarray(0, 32).toString('hex')
```

`PostId` is a hex string. `author` is binary (Uint8Array) — hex on the HTTP
wire, raw bytes in the positional codecs.

**A block commits the `PostCommit` — structure and content hash — never the body.** The body
travels beside its transaction as a packet (→ Layout — UtxoTransaction, the packet codec) and
by id on pull, and lives only in the DAG; `contentHash` is the one binding between them.

#### Post identity

⛔ **A post's identity is PROVENANCE-DERIVED, exactly as a box's is.** A post is
created by a transaction (→ "Post transactions" below), and no two posts can share
one — the creating transaction spends the author's karma box, so its inputs differ.
`(txId, index)` therefore names a post uniquely **by construction**, and the post's
own fields do not enter its id at all.

**This replaces a content-derived id whose uniqueness rested on PoW.** The old
preimage ended `‖ b32(challenge) ‖ vlqU(powNonce)`, and those two fields — a
node-issued random challenge and the miner's search variable — were the only
things making two otherwise-identical posts distinct. Both die with post PoW, and
deriving from provenance is what replaces them rather than inventing a new random
field. **It is the same move Spec G made for boxes**, for the same reason and with
the same consequence: an author cannot grind their own id, because they do not
choose their inputs' ids.

⚠ **`signature` is gone from the struct, and the post is still authenticated.**
The creating transaction is signed over its `TxId`, and the signing key is the
author — so a post's authorship is the transaction's authorship. **There is no
separate post signature to verify**, and no path should reintroduce one.

⚠ **The demo UI must build the transaction before it can name the post.** It
already computes `TxId` locally, so optimistic display still works — but the
ordering inverts, and `public/index.html`'s mirror has to change with it.

### Canonical field encoding (M-1 — injective, protocol-breaking)

**The normative byte layout is Serialization → "Layout — PostCommit".** This section states the
properties that layout must have and does not restate it. `POST_ID_DOMAIN` is
`utf8("dagsocial/post-id/1")`; `POST_CONTENT_DOMAIN` is `utf8("dagsocial/post-content/1")`.

`postFieldBytes` is **injective**: every variable-length field is length-prefixed and the
ref array carries an explicit count, so no two distinct posts share a `postFieldBytes`.
Numeric fields are encoded, never stringified — an undelimited `String(n)` concatenation
collides, since `(a=5, b=23)` and `(52, 3)` both yield `…"5""23"…`. That is
the defect M-1 closed, and injectivity is the property every later dialect change has had to
preserve.

⛔ **Injectivity is still required, and it no longer carries post identity.** These bytes are
the post's payload inside its creating transaction, so they enter that transaction's `TxId`
— which is where two distinct posts are kept apart. **Do not weaken the encoding on the
grounds that the id no longer reads it**: a non-injective payload would collide two
transactions, which is strictly worse.

The numeric writers are **total**: a field outside the encodable domain (non-negative safe
integers ≤ 2⁵³−1) encodes to a sentinel rather than throwing. This keeps the encoder
panic-free on malformed input (the `@dagsocial/validation` no-panic contract, M-5/M-6). A
mirror implementation must reproduce this, not reintroduce a throw.

⚠ **No field takes an out-of-domain sentinel that consensus then reads.** `vlqU`'s sentinel
guards `protocolVersion`, and an out-of-domain version encodes to a value the
strict-equality version check refuses — the sentinel never reaches a rule as a meaning.
`type`'s writer (`enum8`, → Layout — Post) is **total the same way, at byte width**: an
off-table value takes the reserved `0xff` sentinel, which no table may claim and which the
decode boundary refuses as `invalid-tag`. `verifyPostFieldDomains`' membership rule keeps
that sentinel path unreachable from validated input — without it, two distinct malformed
posts would share one encoding, the collision class the `isU64Safe` pins close for the
numerics.

`computePostId` prefixes `POST_ID_DOMAIN` so a post id can never collide with a box id or a
tx id derived from the same provenance — the domain tag is the whole of that separation, and
it is the same discipline `computeBoxId` and `computeMintTxId` already follow.

**This encoding is protocol-breaking and unversioned.** It changes every post
hash and must be byte-identical in `@dagsocial/types` **and** the demo-UI JS
(`packages/node/public/index.html`). `PROTOCOL_VERSION` stays `1`; both devnet
DBs are wiped on deploy — no legacy-post path. A **golden test vector** is frozen in the types tests
and reproduced by the UI mirror; it is the cross-implementation anchor.

### Post typing and profiles

`PostCommit.type` (and the DAG `Post` it names) is the discriminator: `PostType = 'regular' |
'profile'`, an `enum8` over the closed table `POST_TYPE = { regular: 0, profile: 1 }` (→ Layout
— PostCommit). The closed set is the point — every future post kind is a deliberate protocol
decision, never a client convention. Consensus checks membership (`verifyPostCommitDomains`)
and reads nothing else from it; there is no content sniffing anywhere.

**A profile is one post, bound to its author.** A `type: 'profile'` post's `content`
(≤ `MAX_CONTENT_BYTES`) is a structured document clients interpret — consensus records it
and never parses it. The profile of an identity is the **latest confirmed `profile` post by
that author** in committed order; editing is posting a new one (latest-wins supersedes), and
pruning the old is optional hygiene. The type field is what keeps structured content
unambiguous: a `regular` post whose text looks like a profile document is just text.

Usernames are not a post type — they leave the post model for the UTXO ledger
(ARCHITECTURE → Username claims) — and `display_name` is a profile-document field or the
username's concern; avatars and polls are not post types.

### Hashing functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `computeContentHash(content)` | `(string) => Uint8Array(32)` | `blake2b512(POST_CONTENT_DOMAIN ‖ utf8(content)).subarray(0,32)` — the body's commitment, `PostCommit.contentHash`. Hash-side tag, never on the wire. |
| `postFieldBytes(commit)` | `(PostCommit) => Uint8Array` | The canonical length-prefixed encoding (see above). The commit is the post's **payload inside its creating transaction**, so it enters that transaction's `TxId`; the body never does. |
| `computePostId(txId, index)` | `(TxId, number) => PostId` | `blake2b512(POST_ID_DOMAIN \|\| utf8(txId) \|\| u32BE(index)).subarray(0,32).toString('hex')` — **provenance-derived**, taking no `Post` at all |

⛔ **`computePostId` takes two arguments and neither is a `Post`.** That is the point, and it
is the shape `computeBoxId` already has: *"Any need for a second argument means the box is
missing provenance"* applies in reverse here — a post **has** provenance, so its identity
needs nothing from its content. A signature of `(Post) => PostId` is what the old
content-derived id required, and reintroducing it would reintroduce the uniqueness problem
PoW was carrying.

A post-taking id verifier cannot exist: once the id is not a function of the post,
there is nothing a `(post, expectedId)` signature could check.

⚠ **`utf8(txId)`, not decoded bytes.** `TxId` is typed as a hex string, and this contract's
standing rule (→ Pinned byte forms) is that a **standalone derivation** takes it as the UTF-8
bytes of its hex text — as a hex-text mint subject would. The
decoded-bytes form belongs to the positional struct encoders, which establish their domain
upstream; this function has no upstream and must stay total on an attacker-supplied `txId`.

#### ⛔ What "verify a post" means now

**A post id is not recomputable from the post, and the creating transaction is the only
binding.** A node handed a bare `Post` and an id **cannot check that they belong together** —
there is no function that takes the post and answers the id, and there must not be.

**This is not a weakening; it is exactly the standing of a box.** A box id has needed
provenance since Spec G, and nobody reads that as a box being less verifiable — the binding
moved from the content to the transaction, where it is *stronger*, because the transaction is
signed and its inputs cannot be reused. A post is now in that same position. What verifies a
post is the transaction that created it: its `TxId` is checked byte-for-byte against
`computeTxId`, the commit — structure and `contentHash` — is inside that preimage, and the
signer is the author. The body is verified against the commit by `computeContentHash`, by
whoever holds the transaction.

Three consequences, each of which reads as a loss only if this rule is not stated:

- **A post-taking id verifier — any `(post, expectedId)` signature — cannot exist.** Not
  "was removed" — it has no possible implementation.
- **Parent refs are checked for EXISTENCE, not by hash recomputation.** A `verifyParentHash`
  that decoded the parent and re-derived its id was checking a claim the parent's own bytes
  can no longer make.
- **A bare-post-by-id fetch is verifiable only by a node that already holds the creating
  transaction** — the commitment is in it — and that is the only node that asks: the body
  pull (`NET_INTERFACE` → ModifierRequest, `MODIFIER_POST_BODY`) is made for placeholder rows,
  which exist only once the transaction applied. A node holding no transaction for an id has
  nothing to check a body against and does not ask. Codes 10/11 stay retired: they returned
  posts as objects in their own right, which is what cannot be verified.

**`StoredPost.id` is the store's statement of the binding.** It is written when the creating
transaction applies and carried on every read; a reader takes it rather than deriving it,
because deriving it is the thing that cannot be done.

### Merkle primitives (`merkle.ts`)

| Export | Description |
|--------|-------------|
| `leafHash(domain, data)` | `blake2b512(utf8(domain ‖ "\0") ‖ data)[:32]` — domain-separated leaf so a leaf in one tree can't collide with a leaf in another. |
| `nodeHash(left, right)` | `blake2b512(NODE_TAG ‖ left ‖ right)[:32]` — internal-node hash of two children. |
| `buildMerkleRoot(leaves)` | Binary Merkle root over ordered leaf hashes. Empty → 32 zero bytes; single leaf → that leaf. **Odd levels PROMOTE the unpaired last node unchanged — they do NOT duplicate it** (see below). |
| `hexToBuf(hex)` | `(string) => Buffer` — throws on odd length; an even-length string is decoded by `Buffer.from(hex, 'hex')`, which **stops at the first non-hex character**, so the output can be shorter than `hex.length / 2`. Not an alphabet check: the apply-path callers that feed leaf builds get their alphabet pinned upstream, by `verifyOrderingBlockStructure`'s per-element hex checks. |

**Odd-level rule — NORMATIVE, and it is not the Bitcoin default.** When a level has an
odd number of nodes the unpaired last node is **promoted to the next level unchanged**;
it is **not** duplicated and paired with itself. This is why the tree is not vulnerable
to CVE-2012-2459: under promotion `[A,B,C]` → `H(0x00‖H(0x00‖A‖B)‖C)` while `[A,B,C,C]`
→ `H(0x00‖H(0x00‖A‖B)‖H(0x00‖C‖C))`, which are distinct. **Duplicate-last-node is what an
independent implementer reaches for first, and it yields a different root for every
odd-sized level — roughly half of all blocks.**

**`NODE_TAG` is `0x00`. Exactly that byte — this is a pinned constant, not an example.**
A mirror choosing a different reserved byte computes different roots everywhere.

**Leaf/node domain separation (L-9).** `nodeHash` carries `NODE_TAG` (a reserved byte that
is not a valid `leafHash` domain prefix — leaves begin
with a domain string) so an internal node can never be
reinterpreted as a leaf, and vice versa. Without it, a 64-byte leaf preimage
could be presented as `nodeHash(left,right)` for a forged inclusion proof
(second-preimage).

> **Forward constraint — this is a consensus rule with no test behind it.** The scheme is
> sound only while **every** leaf domain is a non-empty printable ASCII string, so that no
> leaf preimage can ever begin with `0x00`. The **one** live domain is `utxotx` — printable, so
> the NUL delimiter suffices. **Three retired domain strings are tracked reservations**
> (→ Tracked reservations, below the boxType tag table): `coinbase`, `prune` and `stump` — each
> remnant-bounded by the live concept that carries the word, so each holds while that concept does.
> `subblock` is retired and free: no live identifier carries the word.
>
> ⛔ **A live/retired list restated in two places is the drift class this file names
> everywhere else; there is one list and it is here.**
> **Adding a leaf domain that begins with a non-printable byte silently reopens
> leaf/internal-node confusion.** No test enforces
> this; it is a contract and review rule, recorded here because it previously existed only
> as a comment in `merkle.ts`.

This is **protocol-breaking** — it changes every Merkle root
(`utxoTxRoot` included), unversioned, devnet DBs wiped on deploy. No demo-UI
mirror (the UI computes no roots). Node re-derives all roots through `types`, so
producer and verifier stay consistent automatically.

---

## UTXO Types (`utxo.ts`)

### BoxId

```
BoxId = string  // hex, 32 bytes
boxId = blake2b512( BOX_ID_DOMAIN ‖ boxRecordBytes(candidate, txId, index) )[0:32]
boxRecordBytes = canonicalBoxBytes(candidate) ‖ b32(txId) ‖ vlqU(index)   // → Layout — Boxes
```

Box identity derives from **creating-transaction provenance**, not from content alone
(Spec G). A pure content hash cannot be
simultaneously *honest* (matching an apply-mutated box) and *predictable* (known at signing
time); provenance gives both, and makes collisions structurally impossible.

Two shapes, not one:

```
interface BoxCandidate {              // the shared BASE — no per-type fields
  boxType: "karma" | "credit" | "invite" | "genesis_proof" | "bond" | "vouch"
         | "emission" | "treasury" | "fee" | "karma_pool" | "like_accrual" | "vouch_escrow"
         | "karma_price"
  value: bigint                // integer base units — uniform bigint (see "Value denomination")
}

interface BoxBase extends BoxCandidate {
  id?: BoxId                   // blake2b512 over candidate ‖ provenance — see the note below
  txId: TxId                   // creating transaction — real or synthetic (see Mint identity)
  index: number                // u32, position within that transaction's outputs
}

type CandidateOf<B extends BoxBase> = Omit<B, "id" | "txId" | "index">
type AnyBoxCandidate = CandidateOf<KarmaBox> | CandidateOf<CreditBox> | …   // all nine
```

**`BoxCandidate` is the base, `CandidateOf<B>` is the per-type candidate.** An earlier draft of
this block wrote `BoxCandidate` with a `…per-type fields` placeholder, which read as though one
name covered both; it does not, and typing `UtxoTransaction.outputs` as the base would erase
`owner`, `originalValue` and force a cast at every consumer. `Omit` is applied **per union
member** — omitting from a union collapses it to the common keys. `UtxoTransaction.outputs` is
`AnyBoxCandidate[]`.

A candidate is what a creator builds and what `computeTxId` hashes. A `BoxBase` is what exists
in the ledger, the store, and the AVL value. The split makes "has provenance-free identity" —
the M-11 state — unrepresentable.

> **`id` is optional, and deliberately.** A producer builds the candidate-plus-provenance object
> and hashes *it* to obtain the id, so the value is genuinely absent for exactly one expression,
> and `computeBoxId` takes `Omit<BoxBase, "id">`. Requiring it would mean a second "box without
> an id yet" type at every producer, for no safety the invariant below does not already give.
> **Every box in the ledger, the store and the AVL value has one** — that is an invariant, not a
> type-level guarantee.

`computeBoxId` is a **total function of a stored box**: drop `id`/`txId`/`index` to recover
candidate bytes, then re-derive. So `stored.id === computeBoxId(stored)` holds by construction
for every box in the UTXO set, and a light client, indexer, or AVL prover derives the same id
the node did.

**`createdAtBlock` is a box field, and it is CREATOR-DECLARED.** It sits in the shared prefix
beside `boxType` and `value`, so it is candidate content: it rides the transaction,
`canonicalBoxBytes` encodes it, and `computeTxId` covers the creator's signature over it.

⛔ **What made the id dishonest was APPLY-MUTATION, not the field.** The field was once written
by block application after its box existed, so a stored box stopped matching its own id — audit
M-11. A value the creator declares and signs is fixed before the id is computed, so the
invariant above holds unchanged. **The objection was to the writer, never to the field.**

⚠ **The node's `created_at_block` store column holds the same number**, written from the box's
own field at insert. It is a denormalisation for querying, **not a second source**: consensus
reads the box, and a rule that consulted the column instead would be reading something the
`stateRoot` does not commit. The decay clock reads a committed per-identity record — see
`NODE_INTERFACE.md`.

⚠ **A box may not claim a height ahead of the chain**, and backdating is bounded only by the
rules that read the value. **Every rule deriving from `createdAtBlock` owes its own exact
check**; the general bound is one-directional on purpose.

#### Monotonic creation height


⛔ **A transaction's outputs may not be older than its oldest input**, on **every** box type:

```
highestInputHeight = max(input.createdAtBlock for input in inputs)
every output: output.createdAtBlock >= highestInputHeight
```

**This is storage rent's discharge of the obligation above, and it is Ergo's EIP-39.** Rent reads
`createdAtBlock` to decide eligibility, so it owes a check; this is that check, stated once for every
type rather than as a rent-only clause.

✅ **It is a pure function of the transaction.** No current height is read, so admission and block
application run the identical predicate and cannot disagree.

✅ **It leaves the height CREATOR-DECLARED, which is what keeps a box id derivable before
inclusion.** That property is load-bearing: node's pending view materialises each output and compares
ids to admit a chained transaction, and multiple social actions inside one block interval are
ordinary. A protocol-stamped height would move the field to provenance and take that away.

⚠ **It bounds rather than fixes.** An output may still be as old as the oldest input, so a sender
spending a near-eligible box passes that age on. What it removes is the unbounded case: **an age can
never move backwards through a chain of spends**, so a height of `0` is unreachable for anything
descending from a fresh box. Without it, the height a box carries is chosen by whoever **built** it —
a credit output's height is the sender's choice, not the recipient's — so an unchecked declaration
lets one party make another's box collectible at once.

#### Mint identity

Boxes created with no user transaction behind them (genesis seeding) derive a **synthetic
transaction id**, so there is exactly one derivation path:

```
mintTxId = blake2b512( MINT_ID_DOMAIN ‖ vlqU(height) ‖ enum8(reason) ‖ lp(subject) )[0:32]
```

`reason` is a tag from a closed set, written into the preimage as a single `enum8` byte; `subject`
is a canonical byte encoding defined per reason. The discriminant is **semantic, never positional** —
deriving it from journal position would make identity order-dependent, the failure class M-12 closed
for the AVL feed. Full reason/subject table in `NODE_INTERFACE.md`.

> **Injectivity is only half-guaranteed here, and the other half is `NODE_INTERFACE.md`'s.**
> *Across* reasons it holds unconditionally, because `enum8(reason)` is a single distinguishing
> byte ahead of the subject. *Within* one reason, `lp(subject)` separates any two whole subjects —
> what it cannot separate is the **parts** of a multi-part subject, which it wraps as one opaque
> run. Every per-reason subject encoding MUST therefore be **fixed-length or self-delimiting** in
> its parts. This package cannot enforce it — the caller owns the bytes.
>
> ⚠ **Corrected 2026-08-16.** This read *"`subject` carries no length prefix"* and justified
> across-reason uniqueness by ASCII prefix-freeness. `computeMintTxId` writes
> `vlqU(height) ‖ enum8(reason) ‖ lp(subject)`; neither premise held.

#### Pinned byte forms

Protocol-visible: a mirror implementation (demo UI, light client) that chooses differently
computes different ids.

- **A hex-typed id has TWO encodings in this repo, and which one applies is decided by
  whether it is a declared field in a positional layout.**

  - **A `b32` field inside a positional layout enters as the 32 DECODED bytes.** `b32` is
    written by `writeHexNOrThrow`, which decodes. This covers `computeTxId`'s `inputs`
    (via `txIdBytes`), `postFieldBytes`' `parentRefs`, and `boxRecordBytes`' `txId`.
  - **A free byte string concatenated into a hash enters as the UTF-8 bytes of its
    64-character hex text.** This covers `computePostId`'s `txId`; the live mint subjects are
    fixed-width selectors and raw keys, not hex text. **`reason` does NOT enter
    this way** — it is an `enum8` tag byte, not ASCII text (corrected 2026-08-16).

  ⛔ **The dividing line is a FIXED WIDTH, and that is why it is principled rather than
  historical.** A positional reader finds every later field by offset, so a `b32` row must
  be exactly 32 bytes — hex text would be 64 and break the layout's own arithmetic. A hash
  preimage has no reader and therefore no width constraint, so the choice there is settled
  by the two properties that are otherwise free: derivation stays **total** on untrusted
  input, since a hex decode throws on a malformed id and light clients derive ids from
  attacker-supplied fields; and it is strictly more **injective**, since decoding would
  collapse `AB…` and `ab…` onto one id. Inside a layout those two are bought differently —
  the domain is established upstream (→ Totality) and `b32` accepts lowercase only.

  ⚠ **"Derivation" is not the discriminator, and reading it as one gets `computeTxId`
  backwards.** `computeTxId` and `computeMintTxId` are both derivations that hash a
  positional encoding; a mint `subject` is text only because it is *opaque `lp` bytes the
  caller encodes*, not a typed field. State the form per preimage, and check which side of
  the line it falls on rather than inferring from a neighbouring function's name.
- **`u32BE` is total, never throwing.** Input outside `[0, 2³²−1)` writes the all-ones
  sentinel, following `post.ts`'s numeric-writer discipline for the M-5 no-panic contract. The
  encodable domain excludes the sentinel, so a well-formed index or height never collides with
  a malformed one. A mirror that throws instead would diverge.

#### Domain tags

| Constant | Preimage it separates |
|---|---|
| `BOX_ID_DOMAIN` | box id |
| `TX_ID_DOMAIN` | transaction id |
| `MINT_ID_DOMAIN` | synthetic mint transaction id |
| `IDENTITY_KEY_DOMAIN` | per-identity record key in the AVL tree |
| `INTERLINK_DOMAIN` | the interlink vector's commitment in a block header (→ Interlink vector) |

Box ids, tx ids and identity-record keys share one 32-byte keyspace and the AVL tree now holds
two entity kinds, so the separation must be in the preimage. (`computePostId` already works
this way via `POST_ID_DOMAIN`; box ids previously had no tag.)

#### Canonical encoding

Exactly one encoder defines the content bytes for identity: `canonicalBoxBytes(candidate)` in
`utxo.ts` — the positional writer for the layout's `boxContentBytes` (→ Layout — Boxes): the
shared prefix `enum8(boxType) ‖ vlqU64(value) ‖ vlqU(createdAtBlock)`, then the per-type tail
(`writeBoxTypeFields`, whose field order is normative). Tests and mirror implementations assert
against the encoder that actually computes ids. Node's AVL value (`state/serialize-box.ts`) is
`boxRecordBytes` — the same content bytes with provenance appended — so the two encodings share
the one content writer and cannot drift. `serialization.ts` exports no second box encoder;
`computeTxId` hashes its outputs through `canonicalBoxBytes` for the same reason: one writer, so
tx and box derivation cannot drift.

⚠ **`canonicalBoxBytes` is a positional layout, not a self-describing format.** There are no
keys, no map framing, and nothing to sort — a mirror reproduces the field table byte-for-byte.
The demo UI already encodes this way; full bytes are pinned as golden vectors in
`test/utxo.test.ts`.

#### Key ordering is canonical (Spec G phase G3b)

The positional layout is what enforces this now: **field order is fixed by the writer**
(`canonicalBoxBytes`' shared prefix, then `writeBoxTypeFields`' per-type table), a producer's
object never chooses it, and an extra key is unrepresentable because the encoder reads only the
fields it declares. Node's `serializeBox` and the demo UI's mirror reproduce the identical
layout.

This retires contract hazards **1b and 1c** in `NODE_INTERFACE.md` **by construction**: under
cbor-x a producer's field order was consensus-visible (the same box built two ways hashed to two
ids, and `post_lock` genuinely diverged between its producer and `rowToBox`); G3b first closed
that with a `sortKeys` pass on both encoders, and the positional migration superseded the sort —
a fixed layout has no key order to canonicalise, so `sortKeys` has no call site left. The
guarantee sits at the single encode site, **not** at any producer.

> A mirror implementation that walks the fields in any other order computes different ids for
> every box. This sits alongside the positional-layout warning above as the second thing a
> mirror must get right.

#### Value denomination (P0 — Spec B, 8-decimal BigInt)

`value` is a **`bigint`** on every box type — **uniform**, one serialization
path (karma/like/vouch hold small bigints; credits are integer base units of
10⁻⁸ credit). Float math is non-deterministic across platforms, and credit sums
exceed `Number.MAX_SAFE_INTEGER` (2⁵³) once scaled ×10⁸ — both break consensus.

### Box value domain — `[0, 2⁶³)`, stated here and cited everywhere else

⛔ **`BOX_VALUE_BOUND = 1n << 63n`, exported from `@dagsocial/types`. A box value is a `bigint` in
`[0, BOX_VALUE_BOUND)`. This is the ONLY statement of that domain; every other document and package
cites it rather than restating the number.**

⛔ **THE ENCODABLE DOMAIN AND THE ACCEPTED DOMAIN ARE DIFFERENT, AND CONFLATING THEM IS THE DEFECT
THIS RULE FIXES.**

| | Domain | Owner |
|---|---|---|
| **encodable** — what `vlqU64` / `canonicalBoxBytes` will write | `[0, 2⁶⁴)` | the writer; **unchanged** |
| **accepted** — what consensus admits as a box value | `[0, 2⁶³)` | this rule |


⛔ **A `credit` output carries a per-byte MINIMUM, and no other box type does.**

```
MIN_BOX_VALUE_PER_BYTE = 156n        // base units per byte of the box's record
every credit output: value >= MIN_BOX_VALUE_PER_BYTE * byteLength(boxRecordBytes(box))
```

**Why `credit` alone.** `GenesisProofBox`'s value is structurally `0n` — it holds neither karma nor
credits and never enters supply accounting — and the karma pool's zero-value successor is created
deliberately, the one place the no-zero-box rule inverts. A blanket floor makes both unencodable.
**Karma is excluded from the per-byte floor by ruling** — non-tradeable, and it decays — and gets
the zero rule below instead.

⛔ **A `karma` output of a user transaction carries at least `1n` — zero means no box.** The change
output is omitted when it would be zero, exactly as every settlement karma leg emits nothing for a
value of zero and a zero fee means no `FeeBox`: a karma spend whose inputs total its cost leaves no
karma output, and every pin the shape needs binds through the input (`NODE_INTERFACE` → Karma
transition rules). The two structural zeros above are block-application outputs — no user
transaction emits either type.

**What it closes.** `credit(X) → credit(0) + fee(X)` conserves and is legal without it, leaving a box
storage rent can never charge and never clear — rent takes value from a box, and that one has none to
take. The floor makes the output inexpressible.

✅ **It does NOT bound the fee from above.** The whole-input fee is `credit(X) → fee(X)`, which carries
no `credit` output at all, so the floor never binds it — see NODE_INTERFACE → "A whole-input fee is
expressible, and the encoding is worth knowing", which stands unchanged.

⚠ **And it does NOT protect a box from rent.** Rent per period is `605,378` base units per byte
against a floor of `156` — **3,889×** — so a box sitting at the minimum is consumed at its first
collection. The floor prevents spam *creation*; surviving rent needs a deliberate buffer.

**Why the accepted domain is narrower: the ledger is SQLite, and `INTEGER` is a SIGNED 64-bit
integer.** A value in `[2⁶³, 2⁶⁴)` encodes cleanly, derives a box id, passes a `u64` check — and
**cannot be stored**: `better-sqlite3` refuses the bind, and `SUM()` over the signed ceiling raises
`integer overflow`. A validation domain wider than its storage domain means a validly-encoded box
crashes block application instead of being rejected.

✅ **Narrowing is a validation TIGHTENING, not a format break.** `vlqU64` writes identical bytes for
every value that was ever storable, so no box id and no `stateRoot` moves. Values in `[2⁶³, 2⁶⁴)`
become invalid — none exists, and conservation makes none reachable, since karma and credits are
minted rather than conjured.

⚠ **The golden corpus keeps its `2⁶⁴ − 1` vectors and they keep their meaning.** They pin the
**encodable** domain, which is the writer's, and the corpus deliberately carries out-of-domain
vectors. A vector proving a value encodes is not a claim that consensus accepts it.

⚠ **`2⁶³ − 1` is 9.2 × 10¹⁸ against supplies measured in thousands.** The ceiling is not an economic
constraint and must not be described as one.
- **Box ids and the AVL `stateRoot` change** vs. the old `number` encoding
  (measured: number `5` → `05`; bigint `5n` → `1b0000000000000005`). Hard,
  unversioned format break ⇒ **fresh chain / DB reset, coordinated all-node
  cutover.** No in-place migration.
- **The demo UI encodes a box positionally**, mirroring `canonicalBoxBytes` field
  for field — shared prefix `enum8(boxType) ‖ vlqU64(value) ‖ vlqU(createdAtBlock)`
  and then the per-type tail. ⛔ **The mirror must produce bytes identical to the
  node's**: it feeds `computeTxId`, so a prefix field missing or differently
  encoded breaks the signature on **every box type at once**, and no gate in this
  repo reaches that file.

### KarmaBox

```
KarmaBox extends BoxBase {
  boxType: "karma"
  owner: Uint8Array            // 32 raw bytes — Ed25519 public key
}
```

Karma boxes are non-tradeable. They can only be consumed by the owner to:
- Create a bond box (inviting — ARCHITECTURE → Invite System)
- Fund a like — the `LIKE_KARMA_COST` rides the transaction's own `LikeAccrualBox` marker
- Create a new karma box for the same owner (balance change)
- Pay a post's price into a `KarmaPriceBox` — and a reply's `REPLY_AUTHOR_SHARE` into a
  `LikeAccrualBox` for the parent's author (ARCHITECTURE → The post price)
- Create a vouch box (staking for another member)

`lastTouchBlock` was removed by Spec G — it had no reader anywhere in `src`, and the activity
clock it nominally represented now lives in the committed per-identity record
(`NODE_INTERFACE.md`), not on a box.

**A karma box carries no provenance field.** Provenance is `txId`/`index`, both inside the id
preimage. A mint's `txId` is `computeMintTxId(height, reason, subject)`, whose `reason` tag
names why the karma was created; a user-path box carries the transaction that made it.

⚠ **`transferKarma` (node) consolidates its credits** — a credited owner's existing karma
boxes are consumed and one box holding the total is inserted — and `getKarmaBoxes` orders by
value with no tie-break. That is identity-harmless, because nothing the merge chooses between
reaches the id preimage. Settlement karma outputs do **not** consolidate: they land beside
whatever karma the owner already holds.

### CreditBox

```
CreditBox extends BoxBase {
  boxType: "credit"
  owner: Uint8Array            // 32 raw bytes
  lockedUntilBlock?: number    // Block height before which credits cannot be spent
}
```

**A credit box carries no minting-height field.** Which block minted a credit box is
`txId`/`index`, inside the id preimage; the box asserts nothing about its own origin.

`lockedUntilBlock` is an **option**, and the tag is what keeps absence from being a value:
an unlocked box writes a bare `u8(0)` and `lockedUntilBlock: 0` writes `u8(1) ‖ vlqU(0)`.
A raw `vlqU` with `0` meaning "unlocked" would give the two one id.

Credits are freely transferable between any accounts. Locked credits (from
coinbase) cannot be spent until `lockedUntilBlock` passes.

### ~~LikeBox~~ — DELETED (P2-D)

**There is no like box.** A like burns its karma at cast, so there is no held value and
nothing for a box to carry — a like is a **transaction** (`UtxoTransaction.likeTarget`,
below) plus a node-side `(liker, post)` record. The boxType string **`'like'` is a tracked
reservation** (→ Tracked reservations): reserved while its remnants — the live
illegal-transition rule and the reject vectors that wear it — remain in the tree.

### InviteBox

```
InviteBox extends BoxBase {
  boxType: "invite"
  value: bigint                       // Always 0 — a claim ticket, not a container
  inviterId: UserId                   // May cancel
  inviteePublicKey: Uint8Array(32)    // May claim — the key INVITE_KARMA_AMOUNT mints to
}
```

**The box carries no value because the karma does not exist yet.** An invite is a
named right to mint, held open until one of the two parties acts: the invitee
spends it into a `KarmaBox` of `INVITE_KARMA_AMOUNT`, which is where the mint
happens, or the inviter spends it to nothing and takes their bond back. There is
no secret and no preimage — each party proves who they are with an ordinary
Ed25519 signature over the transaction.

**An invite never expires.** With no deadline there is no sweep and no
`expiryBlock` field; an unclaimed invite stays claimable until the inviter
cancels it, and their bond stays locked for exactly as long. Their `K /
INVITE_BOND_KARMA` capacity absorbs the cost, which is what makes the rate limit
self-enforcing without a rule.

> ## ⛔ RETIRED — the type, its transitions and its constants are all gone
>
> ✅ **Fully landed.** The interface is deleted and tag **2** is unassigned; the claim and cancel
> transitions and their two HTTP endpoints are deleted from `node`; the settlement that replaces
> them ships. `INVITE_KARMA_AMOUNT` and `INVITE_BOND_KARMA`, named in the prose above, are deleted
> too — **the section describes a retired shape, and every symbol in it is historical.**
>
> ⚠ **The prose above is kept as the retired shape's record, not as a description of the tree.**
> Nothing may be built against it.
>
> ⛔ **The whole type exists to hold a right to mint, and there is no mint.** Under
> `ARCHITECTURE → The conservation axiom` the invitee's karma is **spent from the pool** by the
> block's settlement transaction, so there is nothing for a ticket to represent and no second
> transaction for it to be spent by.
>
> ```
> invite tx    aliceKarma(K) → BondBox(B, inviterId=Alice, inviteePublicKey=Bob) + aliceKarma(K−B)
> settlement   pool(S) → pool(S−G) + bobKarma(G)
> ```
>
> ⛔ **`BondBox` IS THE REQUEST — that is what removes the need for a marker here.** The settlement
> emits **the bond's own value** to the `inviteePublicKey` of every `BondBox` the block creates, so the
> pairing is structural: one bond, one grant. A like needs a marker because its value goes to a party
> holding no box in the transaction; an invite already creates one.
>
> ⛔ **The boxType string `'invite'` is a tracked reservation** (→ Tracked reservations) — the
> same remnant-bounded rule `~~LikeBox~~` states above. ⚠ **`KARMA_BOX_TYPES` loses `'invite'` and gains the vouch
> escrow**; anything quoting that list must re-derive it rather than editing a remembered copy.

### BondBox

```
BondBox extends BoxBase {
  boxType: "bond"
  value: bigint                       // B karma deposited by the inviter
  inviterId: UserId                   // Owner — the inviter
  inviteePublicKey: Uint8Array(32)    // Set at creation — the key the paired invite names
}
```

**A `BondBox` is byte-identical from creation to the block that consumes it**, and
the field list is what makes that true. `inviteOutputIndex` goes with the pairing
it expressed: a key is invited at most once, so `inviteePublicKey` names the
paired invite by itself and no output index is needed. Both probation fields go
too — the window runs from the **claim**, not the creation, and the claim height
is already recorded as `IdentityRecord.invitedAtBlock` (`NODE_INTERFACE` →
Identity Records), so carrying it here would be a second copy of committed state.

**There is no `originalValue`.** A bond settles **once**, for
`min(floor(IdentityRecord.lifetimeLikesReceived / INVITE_BOND_VEST_PER_LIKES), value)`
— a pure function of a monotonic counter, which makes a single evaluation
arithmetically identical to accumulated instalments. No partial state exists to
record.

**Nothing spends a bond.** Creation and settlement both move it through block
application — the create transaction outputs it, the settlement transaction
consumes it at the probation deadline — so no transition admits it into a user
transaction, the same standing `KarmaPriceBox` has. `inviteePublicKey` is also
what the settlement reads to address the grant, and the probation window runs
from the invite's own height (`IdentityRecord.invitedAtBlock`) — recorded on the
identity record, so carrying it here would be a second copy of committed state.

### PostLockBox — RETIRED (2026-08-29)

**There is no post lock.** A post pays a price rather than locking a bond (→ KarmaPriceBox;
`ARCHITECTURE → The post price`), so no box holds an author's karma against their post, nothing
vests per block and nothing is released at a prune. The boxType string **`'post_lock'` and tag `5`
are a tracked reservation** (→ Tracked reservations), reserved while this record and its in-code
citations stand.

**The lesson the type carried survives it.** A lock could not name its target post: a post's id
derives from the transaction that creates it (`computePostId(txId, index)`), the lock was an output
of that same transaction, and `canonicalBoxBytes` is inside the `TxId` preimage — so the field would
have had to be known before the id that produces it. ⛔ **No box may name an output of its own
transaction; a mapping of that shape is derived state, written at apply by every node identically.**
That rule is what this heading is cited for.

> ⚠ **AHEAD OF CODE — 2026-08-29.** `PostLockBox` is a live interface in `types/src/utxo.ts` and a member
> of `AnyBox`; PR A's types unit retires it with its golden vectors and its codec arm, and node's
> unit deletes every reader.

### KarmaPriceBox

```
KarmaPriceBox extends BoxBase {
  boxType: "karma_price"
  value: bigint                // ≥ 1n — what the transaction pays to the pool
}
```

The karma-side twin of `FeeBox`: what a karma action pays, named as an output so the transaction
conserves (`ARCHITECTURE → How a source and a sink get named`, third shape — a marker to a party the
transaction cannot name a box for; here the pool). **No owner, and therefore no trailing fields** —
block application is its only spender, and where the value goes is already decided: the settlement
of the block that created it consumes every price box the body's post transactions emitted and
returns their sum to the pool (`NODE_INTERFACE → The settlement transaction`).

- **A post transaction carries exactly one**, holding `POST_PRICE_THREAD` for a thread and
  `POST_PRICE_REPLY − REPLY_AUTHOR_SHARE` for a reply — the share rides a `LikeAccrualBox`. The
  shape rule is consensus and lives in `NODE_INTERFACE` (Legal box transitions).
- ⛔ **A zero-value price box is not created**: zero means no box (→ Box value domain), and no
  price is zero.
- **No user transition admits one as an input.** Like the accrual marker, it is block
  application's alone.
- **Sets** (`NODE_INTERFACE → Three karma sets, and none derives from another`): transition
  **yes** — a karma spend creates it; supply **no** — it is karma on its way out of circulation;
  conservation **yes** — it holds karma until the settlement returns it.
- **It is the transition any later karma price takes** — the prune's descendant charge, when it
  lands, is a `KarmaPriceBox` on the prune transaction.

> ⚠ **AHEAD OF CODE — 2026-08-29.** Nothing in the tree carries this type. PR A's types unit adds the
> interface, tag `13` in `BOX_TYPE_TAGS`, the codec arm and a golden vector; node's unit adds the
> schema row, the three set verdicts, the transition and the settlement leg; the demo UI's mirror
> gains the case.

### VouchBox

```
VouchBox extends BoxBase {
  boxType: "vouch"
  value: 1n                    // VOUCH_KARMA_AMOUNT — always 1n (bigint)
  voucherId: UserId            // 32 raw bytes — who staked the karma
  targetId: UserId             // 32 raw bytes — who is being vouched for
}
```

### VouchEscrowBox

Where an unvouched stake waits out its cooldown. The unvouch transaction
outputs it; the settlement of the first block at or past `releaseAtBlock`
returns its value to `owner` as karma — block application is its only spender
(NODE_INTERFACE → Vouch transition rules, The settlement transaction).

```
VouchEscrowBox extends BoxBase {
  boxType: "vouch_escrow"
  value: bigint                // Exactly what the consumed VouchBox held
  owner: Uint8Array            // 32 raw bytes — the voucher; where the karma returns
  releaseAtBlock: number       // vouch.createdAtBlock + vouchCooldownBlocks — the
                               // cooldown runs from the CAST, an exact pin
}
```

⛔ **`value` IS THE CONSUMED BOX'S, NEVER `VOUCH_KARMA_AMOUNT`.** The round trip has to be
conservation-**structural** rather than true by coincidence, so it must not depend on the cast's pin
holding for the box in hand.

⛔ **This is what makes an unvouch conserve.** The stake moves from a box the voucher's own
transaction consumes into one it creates, so both ends are named inside one transaction, the value
is located at every instant, and the pool is uninvolved — `ARCHITECTURE → How a source and a sink
get named`, first shape.

⚠ **`releaseAtBlock` is committed state, and that is the point.** A node holding the `stateRoot`
holds the obligation itself rather than a root it cannot interpret without replaying every block.

✅ **The pool is not involved, and no marker is needed.** The value moves from one box the voucher's
own transaction consumes into another it creates, so both ends are named inside one transaction.

### LikeAccrualBox

**The only marker box in the design** (`ARCHITECTURE` → The conservation axiom, "the three
shapes"): the like transaction emits one per like, the block's settlement transaction consumes
them with the author's carry box, and the carry has no counter representation anywhere — the
box is the carry.

```
LikeAccrualBox extends BoxBase {
  boxType: "like_accrual"
  value: bigint                // LIKE_KARMA_COST on a marker; the running carry on a carry box
  author: Uint8Array           // 32 raw bytes — the key the accrual is earmarked for
}
```

⛔ **ONE TYPE, TWO LIFETIMES, AND THEY MUST NOT BE CONFLATED.** The settlement consumes both in the
same step, which is why they share a type rather than being told apart by one:

| Role | Created by | Lives | Count |
|---|---|---|---|
| **marker** | the like transaction, as an output | consumed by the same block's settlement | one per like |
| **carry box** | the settlement | across blocks, until a payout consumes it | one per author, `value < LIKES_PER_KARMA_PAYOUT` |

⛔ **`author` IS ATTRIBUTION, NOT AUTHORIZATION** — the same distinction `BondBox.inviterId`
carries. **No signature by `author` unlocks this box.** Only the settlement
transaction consumes it, so no user transition admits one as an input.

⛔ **A LIKE MUST NOT NAME A SHARED BOX.** Two likers of the same author in one block would name the
same carry-box id and **the second would be permanently invalid, not deferred** — a popular author
becomes unlikeable. Hence a fresh marker per like, and a carry box only the settlement touches.

⛔ **THE MARKER MUST BE PINNED BY SHAPE AS TIGHTLY AS THE DEFICIT IT REPLACES.** A marker is a
karma-bearing output earmarked for **someone else**, which is the exact shape the same-owner karma
rule forbids (`NODE_INTERFACE` → Karma transition rules). Unpinned,
`myKarma(K) → myKarma(K−n) + LikeAccrualBox(n, author=Bob)` is a **balanced** transaction that
transfers karma, and karma is non-tradeable. **The biconditional therefore runs both ways**:
`likeTarget` present ⟺ exactly one marker of `LIKE_KARMA_COST` naming that target's author.
⚠ **The reverse direction has no predecessor** — the old rule was triggered by arithmetic the
validator could not be talked out of; this one is triggered by shape it must be told to look for.

### GenesisProofBox

```
GenesisProofBox extends BoxBase {
  boxType: "genesis_proof"
  value: 0n                    // Neither karma nor credits — never enters supply accounting
  payload: Uint8Array          // Opaque bytes; lp on the wire, hex in the profile
}
```

One of the boxes seeded at cold start, beside system karma, faucet credits and the emission box.
`NetworkProfile.genesisProofPayload` carries its per-network value as hex (§Network profiles).

⚠ **It is NO LONGER the whole of network identity at height 0, and this line said it was.** The
karma and credit boxes are byte-identical across networks, so the payload used to be the only thing
separating testnet's genesis root from devnet's. The `EmissionBox` is now a **second** per-network
difference: its value is that profile's carried emission total (§Network profiles), and devnet's is
smaller. Two networks now differ in two boxes, not one. Corrected 2026-08-16, when unit 4b made it
false.

`value` is `0n` for the same reason `VouchBox.value` is `1n`: the type has exactly one legal value,
so the literal makes any other unrepresentable rather than merely invalid.

The type is barred from both transaction positions, and **the two halves have different owners
because only one of them can be checked without state**:

| Half | Owner | Why it can only go there |
|---|---|---|
| not a transaction **output** | `VALIDATION_INTERFACE` | A candidate output is a whole box; typing it reads nothing |
| not a transaction **input** | `NODE_INTERFACE` | `tx.inputs` are box **id strings**; typing one requires the UTXO set |

⚠ **This corrects a line that routed both halves to `VALIDATION_INTERFACE`.** That package holds no
box-type machinery at all until the output rule lands, and it structurally cannot type an input —
so half the rule was routed to a package that could never run it. `VALIDATION_INTERFACE`
§`verifyHeaderFieldDomains` already names this failure: *"A rule routed to a package that
structurally cannot run it reads as scheduled work and is actually a dead end."*

`payload` is bounded at `MAX_GENESIS_PROOF_PAYLOAD_BYTES`, and **the bound is a decode rule**: the
`genesis_proof` arm of `readBoxContentFields` refuses an oversized payload, so such bytes have **no
decoding** — the same standing the corpus gives an unassigned tag. It is per-type and binds no other
`lp` field; in particular it is **not** in `readLp`, which every length-prefixed field shares.

This is a domain rule and not a memory-safety one. `ByteReader.readBytes` already refuses
`remaining < n` and throws before touching memory, so no length prefix can provoke an allocation —
the bound exists to make the field's domain checkable, not to protect the reader.

**The refusal is one-way, and that is the same asymmetry the tag sentinel has.** `writeLp` stays
total, so an over-bound payload still *encodes* and `computeBoxId` still answers for it; what it has
is **no decoding**. Reading the bound as an encode rule as well would make `canonicalBoxBytes`
partial in a new field, which §Totality permits only where a sentinel would collide with a
well-formed value — and here it would not, because nothing decodes the bytes back.

The rejection is a `ReaderError` with code `out-of-domain` (WIRE_INTERFACE → ReaderError codes): the
bytes are well formed and the value is outside the field's domain — the code `readLpUtf8` gives a
length-prefixed field whose contents are not UTF-8, and the one `@dagsocial/net` gives a height
outside the advertisable range.

### EmissionBox

```
EmissionBox extends BoxBase {
  boxType: "emission"
  value: bigint                // Credits not yet released, in base units
}
```

**The whole of a network's credit emission, held as state from height 0.** Genesis creates one on
every network holding that profile's **carried** emission total; each block spends it to a successor
holding `value − min(computeBlockReward(height), value) + unearned` — the scheduled release capped by
what the box actually holds, less the inclusion bonus the block forfeited (MINING_INTERFACE → "On
block receipt" step 3). No other rule touches it, so what remains to be emitted is a value an observer
reads rather than a schedule they trust — which is what `ARCHITECTURE` → UTXO conservation rests its
bound on.

⛔ **The value does not decrease monotonically, and this line once said it did.** The forfeited bonus
is added straight back, so a block with large fees and thin karma-side inclusion returns more than it
releases and the successor is **larger** than its predecessor. The bound survives regardless: what
returns is fee value already in supply, consumed by the very block that returns it, so the box defers
that value rather than minting it.

**No owner, and therefore no per-type trailing fields.** The box names no spender because block
application is the only one. Its content encoding is the shared prefix alone — one of three box
types with an empty tail (§Layout — Boxes).

⛔ **THE BOX EXISTS AT EVERY HEIGHT, WHATEVER ITS VALUE — `0` INCLUDED.** A forfeited inclusion bonus
is returned to it (MINING_INTERFACE → "The slices"), and a return must always have somewhere to land.
Above exhaustion `computeBlockReward` may still be positive while the box is empty, and fees are never
zero, so the pool is `COINBASE_BONUS_PCT × fees` and its unearned share is still real. **A box
destroyed at exhaustion would leave that share with no destination**, and the runway rests on it
having one. §KarmaPoolBox already carries this shape for the same reason — burns must always be able
to return — and the emission box now joins it rather than standing against it.

⚠ **This retires the zero-successor rule for THIS box, and accepts the cost that rule named**: a
zero-value box is removed and reinserted on every block above exhaustion. The coinbase's "one block,
one encoding" rule is untouched — that one binds transaction **outputs**, and this box is not one.

> ⚠ **QUALIFIED — 2026-08-26. The forfeit's price degrades above exhaustion.** While the box is deep
> a returned share is paid out decades away, so the forfeiting miner's expected recovery is
> approximately zero — which is the whole of why the bonus is a cost rather than a delay
> (MINING_INTERFACE → The slices). **Once the box is empty it is a one-block pass-through**: a return
> lands, the next block releases it, and a miner holding hashrate share `h` recovers `h` of its own
> forfeit immediately. The bonus is keyed to income rather than to emission because the pressure to
> exclude peaks in exactly that regime (MINING_INTERFACE → Coinbase Application), so the defence
> weakens where it is most needed. **The narrowing: "no miner recovers their own forfeit" holds while
> the box is deep, and is a one-block deferral after exhaustion.** Recorded, not queued.

⛔ **The genesis value IS written into the profile, and the guard is the opposite one.** A bound deliberately
below the curve's sum cannot be a function of the schedule's parameters, so each profile carries its
own (§Network profiles). Of the two failures the derivation prevented, the first — a total too small,
starving the box before the terminus — is now taken on purpose and closed by partial payment
(MINING_INTERFACE → Emission Schedule). The second is what a guard can still catch: a carried total
must be **strictly below** the curve's own sum, because the unpaid tail is what a returned bonus
drains through.

### TreasuryBox

```
TreasuryBox extends BoxBase {
  boxType: "treasury"
  value: bigint                // Credits accrued, in base units
}
```

**Where the coinbase's treasury slice lands.** Block application spends it to a successor holding
`value + split.treasury`; there is no rule that reduces it. ⛔ **The forfeited inclusion bonus does
NOT land here.** It is never minted at all — it stays in the `EmissionBox` (MINING_INTERFACE → "The
slices"), so a reader carrying the older rule over will look for it in the wrong box.
`ARCHITECTURE` → Treasury requires the treasury be unspendable **by absent rule** rather than by a
withheld key, and this is that rule's shape: no key exists, and block application carries no release
path to write one out.

Genesis creates none — it would hold `0`, which §EmissionBox's rule refuses. The first block whose
`split.treasury` is nonzero creates it.

**Separate from the emission box, structurally.** A future protocol version gives the treasury a
spend gate. Held in one box with the emission remainder, that gate's ceiling would be the computable
`value − remainingEmission(height)` — which works, and makes the ceiling depend on a schedule sum
staying consistent with `computeBlockReward` forever. Two boxes mean no rule lets a treasury spend
reach unreleased emission, rather than a rule computing how much of one box it may reach.

### FeeBox

```
FeeBox extends BoxBase {
  boxType: "fee"
  value: bigint                // Credits paid to the block's miner, in base units
}
```

**What a credit transaction pays for its inclusion, named as an output so the transaction balances
exactly.** A credit-side transaction carries zero or one; block application sums the block's fee
boxes into the coinbase's income term and consumes them in the same block
(`MINING_INTERFACE` → Coinbase Application).

**No owner, and therefore no per-type trailing fields.** Block application is the only spender, and
which key the fee reaches is already decided — the coinbase pays `split.miner`. A field naming the
recipient would be a second statement of that, free for a producer to set and never read.

⛔ **A zero-value fee box is not created: zero fee means no box.** Both encodings would express one
economic fact with different `utxoTxRoot`, which is the rule §EmissionBox states for the zero-value
successor and the coinbase states for its own outputs. **A transaction carrying no fee box is valid
consensus** — no amount is checked anywhere, because the price of inclusion is relay policy and block
assembly rather than validity (`MEMPOOL_INTERFACE` → Fee floor).

**At most one per transaction**, for the same one-block-one-encoding reason: a second carries no
information a producer could not put in the first.

**A transaction whose only output is a fee box is legal.** It conserves, and it is a donation to the
miner. Nothing in the design gives that shape a meaning worth forbidding.

⚠ **`fee` is not a member of the karma family**, so a fee output on a karma-side transaction is
rejected by the karma transition arm rather than by a rule of its own
(`NODE_INTERFACE` → the karma transition rules).

### KarmaPoolBox

> ✅ **Live end to end.** The interface, tag **10**, the wire layout and the genesis seed landed
> with unit B (**#87**); the block settlement transaction is the pool's sole spender — spending
> it in blocks whose settlement moves karma and re-emitting its successor — so every karma mint
> draws from a named source and every burn returns to one (`NODE_INTERFACE` → Legal box
> transitions; `ARCHITECTURE` → The conservation axiom).

```
KarmaPoolBox extends BoxBase {
  boxType: "karma_pool"
  value: bigint                // Karma not in circulation. Genesis: 2⁶³ − 1
}
```

**The whole of a network's karma supply, held as state from height 0.** Genesis creates exactly one,
holding the **maximum STORABLE karma**, `BOX_VALUE_BOUND − 1` (§Box value domain — the ledger is
SQLite and `INTEGER` is signed, so the ceiling is `2⁶³ − 1`, not `2⁶⁴ − 1`). Every mint draws from it and every burn returns to it,
so the supply is fixed at the type's ceiling from the first block and **no rule anywhere can inflate
it**. That is the point: karma is not scarce by policy, it is non-inflatable by construction.

⛔ **`pool.value + circulating karma == BOX_VALUE_BOUND − 1`, at every height, forever.** This is the invariant
the type exists to make checkable, and it is what makes overflow structurally impossible: a burn can
only return what a mint drew, so the pool can never exceed its genesis value and `vlqU64` can never
be handed one it would throw on.

⛔ **Genesis committee grants come OUT of the pool, not alongside it.** `genesisCommitteeKeys` ×
`genesisKarmaPerMember` is minted by drawing the total down, so the invariant holds from height 0.
Minting them beside a full pool would put total supply above the bound **at genesis**, which
`writeVlqU64OrThrow` refuses outright — the invariant is not merely violated, the state is
unencodable.

**No owner, and therefore no per-type trailing fields.** Block application is its only spender and
its only producer; its content encoding is the shared prefix alone (§Layout — Boxes).

⛔ **It is NOT a karma box, and the distinction is not cosmetic.** A karma box is something an
identity holds and `getKarmaBoxes` returns. Giving the pool the `karma` type would put the maximum
supply inside every balance query and every conservation sum in the tree.

⛔ **It is in the CONSERVATION set and in neither of the other two** — not the transition set, not
the supply set (`NODE_INTERFACE` → "Three karma sets, and none derives from another"). It is barred
from both transaction positions, joining `genesis_proof`, `emission` and `treasury`.

⚠ **That combination is why the third set exists.** The pool is not karma anyone holds, so it is not
supply; it is karma that exists, so it is conservation. **A list serving both questions would have to
choose, and either choice is wrong.**

> ⛔ **A zero-value successor IS created.** Burns must always have somewhere to return, so the box
> exists at every height whatever its value. **§EmissionBox now carries the same rule for the same
> shape of reason** — a forfeited inclusion bonus must always have somewhere to land — so the two
> boxes agree rather than invert. What still differs is *why* each never terminates: the pool because
> karma circulates forever, the emission box because a forfeit can arrive after the schedule has
> stopped paying.

### UtxoTransaction

```
UtxoTransaction {
  inputs: BoxId[]                          // Boxes consumed
  outputs: BoxCandidate[]                  // Boxes created — candidates: no id, no txId, no index
  signatures: Record<string, Uint8Array>   // publicKey (hex) → Ed25519 sig (64 bytes) over TxId
  preimages?: Record<string, Uint8Array>   // boxId → hash preimage — encoded and hashed, read by nothing
  protocolVersion: number                  // 1
  likeTarget?: PostId                      // Present ⟺ this tx is a like (P2-D) — see below
  post?: PostCommit                        // Present ⟺ this tx creates a post — see below; the body rides the PACKET, not the tx
}

TxId = blake2b512( TX_ID_DOMAIN ‖ txIdBytes )[0:32]

txIdBytes = arr(inputs, b32) ‖ arr(outputs, canonicalBoxBytes)
            ‖ opt(arr(preimages sorted, b32(boxId) ‖ lp(preimage)))
            ‖ vlqU(protocolVersion)
            ‖ opt(likeTarget, b32)
            ‖ opt(post, postFieldBytes)
```

⚠ **Where this section and "Layout — UtxoTransaction" disagree, the LAYOUT TABLE
is normative** — it always was, and this formula has been restated here to stop
saying otherwise. Both optional fields carry `opt()`'s **0/1 presence tag**, not
an in-band ASCII marker; the `like:` / `post:` marker scheme this section used to
describe was never implemented for either field.

**`post`** carries the post's **commit** — structure and `contentHash`, never the body —
inside the transaction that creates it, on the same pattern `likeTarget` set: an optional
field whose presence is biconditional with a rule. It takes `opt()`'s presence tag followed
by `postFieldBytes(commit)`, appended **only when present**, after `likeTarget`'s
contribution. The body is bound to the transaction by `contentHash` alone; on gossip it rides
beside the transaction's bytes as the packet's trailing `opt` (→ Layout — UtxoTransaction,
the packet codec), outside `txIdBytes` and outside every id. **The payload fields are mutually exclusive by rule** — a transaction is a like, a post, a
prune or a withdrawal, never two of them (`NODE_INTERFACE → Transaction envelope shape`) — and the
encoding does not rely on it either: each carries
its own tag, so the tail stays unambiguous however the fields combine.

⛔ **A presence tag is unambiguous by construction; an in-band marker is
unambiguous only by argument** — and the argument has to be remade every time a
neighbouring field changes. That is why `opt()` is the form for every optional
field in this layout, and why a marker scheme must not be reintroduced for one.

⚠ **The tag costs ONE BYTE on EVERY transaction preimage, including transactions
that carry no post — and that is the accepted price, not an oversight.** An
in-band marker appends nothing when the field is absent; an `opt()` tag always
appends its `0`. Adding `post` therefore moved **every** `TxId` in existence, and
through them every box id derived from one, which is why the golden vectors
churned far beyond the post path. **A marker was considered and rejected on the
ambiguity argument above.** Do not read that churn as a defect and "optimise" the
tag back into a marker.

⛔ **This is what makes the post id derivable.** `postFieldBytes` is inside the
`TxId` preimage, so a transaction carrying a distinct post has a distinct id, and
`computePostId(txId, index)` inherits that uniqueness. **The `index` is the post's
position among the transaction's post-bearing outputs**; today exactly one post
rides one transaction, so it is `0` — the parameter exists so that stays a stated
rule rather than an assumption baked into a call site.

The consensus rule — `post` present ⟺ the transaction pays `POST_PRICE_THREAD` (a thread)
or `POST_PRICE_REPLY` (a reply, `REPLY_AUTHOR_SHARE` of it into a `LikeAccrualBox` for the
parent's author) into a `KarmaPriceBox` and conserves value — lives in `NODE_INTERFACE.md`,
as the like biconditional does.

**`likeTarget`** names the liked post from inside the signed bytes — a relay cannot
re-point a like. Its preimage contribution is `opt()`'s presence tag followed by `b32` —
the 32 **decoded** bytes, per Pinned byte forms — appended after `protocolVersion` **only
when the field is present**; absence appends the tag alone. The tag also preserves the
`!== undefined` distinction, so an empty-string target hashes differently from absence.
This package defines only the
field and its encoding; the **biconditional rule** — `likeTarget` present ⟺ the
transaction burns exactly `LIKE_KARMA_COST`, the only legal karma deficit in any user
transaction — is consensus validation and lives in `NODE_INTERFACE.md` (UTXO engine).
P2-C's C1 (length-prefixed preimage rework) absorbs this field when it lands.

`outputs` carries **candidates**, not boxes. A transaction cannot name its own outputs' ids
without circularity, so ids are derived once `TxId` is known; the ledger materializes candidate
`i` into a `BoxBase` with `txId` and `index: i` at apply. (Pre-Spec-G this was `AnyBox[]` whose
per-output `id` was excluded from the hash — the same exclusion, now expressed in the type.)

⛔ **`preimages` has no consumer.** No transition requires knowledge of a secret,
so nothing reads the map — but it stays field 3 of the encoding, sorted by key and
hashed into every `TxId`, so it is a consensus surface that carries no meaning.
**Removing it changes every transaction id**, which is why it goes with the
transaction-representation work rather than here. Until then it is encoded,
validated for envelope shape, and never consulted.

Transaction signatures are over the transaction hash (`computeTxId`), not over
domain messages. The signer signs `TxId` with their Ed25519 key; verifiers
recompute the hash and check the signature.

### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `computeBoxId(box)` | `(BoxBase) => BoxId` | Box id from `candidate ‖ txId ‖ index`. Total function of a stored box — no second argument, so `stored.id === computeBoxId(stored)` is checkable anywhere |
| `computeCandidateBoxId(candidate, txId, index)` | `(BoxCandidate, TxId, number) => BoxId` | Same derivation, for a candidate not yet materialized. Used by creators and by clients predicting an id at signing time |
| `computeTxId(tx)` | `(UtxoTransaction) => TxId` | Transaction id over candidates |
| `computeMintTxId(height, reason, subject)` | `(number, MintReason, Uint8Array) => TxId` | Synthetic transaction id for boxes with no creating transaction — genesis seeding and post-lock vesting; everything else is a settlement output with an ordinary id. `subject` encoding is defined per reason — see `NODE_INTERFACE.md` |
| `canonicalBoxBytes(candidate)` | `(BoxCandidate) => Uint8Array` | The single canonical identity encoding. Exported so tests and mirror implementations (demo UI, light client) assert against the encoder that computes ids, not a lookalike |
| `selectBoxes(boxes, requiredAmount)` | `(T[], bigint) => T[]` where `T extends { value: bigint }` | Largest-first UTXO selection — a greedy prefix of the **given** order until `requiredAmount` is covered; throws when the boxes' total falls short. **Precondition: the caller supplies boxes sorted by value descending** — the function imposes no order of its own, so its determinism is exactly its caller's. A transaction-builder helper (the faucet's invite and transfer builders are the consumers); no block-application path calls it |

---

## Stump Types (`stump.ts`)

```
PruneCommit {
  rootPostHash: PostId               // the subtree is derived from block_topology at apply — Layout — PruneCommit
}

Stump {
  rootPostHash: PostId
  authorId: UserId
  replyCount: number
  upvoteCount: number
  protocolVersion: number
  compactedAtBlockHeight: number
}
```

| Export | Signature | Description |
|--------|-----------|-------------|
| `pruneFieldBytes(prune)` | `(PruneCommit) => Uint8Array` | Positional canonical bytes — `txIdBytes` field 6 — see Layout — PruneCommit |

---

## Block Types (`block.ts`)

### Block header

```
BlockHeader {
  protocolVersion: number        // 1
  height: number                 // Monotonically increasing, starting from 1
  prevBlockHash: string          // hex(32) — hash of the previous block's header
  utxoTxRoot: string             // hex(32) — Merkle root over the body's transactions (→ Ordering block; a prune is a transaction)
  stateRoot: string              // hex(33) — the AVL+ digest after this block is applied (NODE_INTERFACE → Post-block stateRoot)
  validatorId: UserId            // Block producer's 32-byte public key
  powNonce: number               // PoW solution
  powTargetBits: number          // Difficulty target for this block
  createdAt: number              // Unix ms — stamped at TEMPLATE BUILD, not at solve
  interlinkRoot: string          // hex(32) — commitment to the interlink vector (→ Interlink vector)
}
```

⚠ **`createdAt` records when mining on this block started, not when it was found.** The node stamps it
while building the template, and a template is built when the previous block was applied — so
`createdAt(N)` is the moment block `N−1` entered this node's chain. **It is node-set, never
miner-supplied**: `POST /mining/submit` carries a nonce and a height and nothing else, which is what
keeps attacker-chosen timestamps off the honest path entirely.

**The consequence for anything reading it as a clock:** the difference between consecutive stamps is
exactly the interarrival time of the block *between* them, one height out of phase. The **rate** is
right; the **phase** lags by one block, and a schedule consuming this field must account for that
offset rather than discover it. The field is domain-pinned as `isU64Safe` and validated against nothing
— it is not a consensus input.

> ⛔ **`networkType` was proposed as a header field twice and is REJECTED — decided
> 2026-08-10, reversing 2026-08-06.** It was never implemented; nothing is being removed from
> code. **The header is ten fields**, `interlinkRoot` the tenth (→ Interlink vector). Read this
> before proposing it a third time.
>
> The argument for it was legibility: id derivation is network-agnostic by decision (§Domain
> tags are network-agnostic), so a header field would be the only consensus-visible network
> commitment short of genesis, and without it a wrong-network block is rejected as a
> chain-link failure — true, but opaque.
>
> **What sank it is that an attacker fills the field in correctly, for free.** Writing
> `networkType: 'mainnet'` on a forged mainnet block costs nothing, so the field never
> catches an adversary. Its entire population is honest misconfiguration — and every member
> of that population is already caught earlier, by the two mechanisms `ARCHITECTURE §How the
> network is committed` lists beside it:
>
> - **p2p** — the wire magic gates frame assembly; foreign-network peers do not connect.
> - **HTTP** — no route accepts a block. `blocks.ts` is three `GET`s, and `/mining/submit`
>   takes a nonce and a height against the node's *own* template, so the header is
>   self-supplied.
> - **operator flips `NETWORK_TYPE` against an existing store** — the stored genesis is the
>   old network's, so it fails at the chain link.
>
> That left the field's whole marginal value as the *wording of an error message*, bought
> with a byte in every header forever. **`extensionDigest` was deleted from the same header for
> committing to nothing** (§Layout — Block below; spec §5.1), and that spec's third point
> retires the "add it now
> while header breaks are free" defence: the cost of a later header change is a second fresh
> chain, which stays cheap until a live multi-node network exists.
>
> **The rule had no home, which is how the gap survived into three contracts.** Both this
> section and `VALIDATION_INTERFACE` said the profile match belongs "at the structure gate" —
> but `verifyOrderingBlockStructure` lives in `@dagsocial/validation`, which is contractually
> pure and stateless and cannot read the node's profile. A field whose enforcement point does
> not exist is inert regardless of its merits.
>
> **This restores agreement with Ergo**, whose header also carries no network field, so the
> divergence note this block used to carry is retired with it. **What would reopen the
> question:** a consumer that must reject a foreign header *without* the chain. Light clients
> and NiPoPoW proofs both anchor at genesis by construction, so neither is one — a new
> argument needs a consumer that genuinely is.

The header is what gets hashed. `blockHash(header) = blake2b512(encodeHeader(header))[:32]`
(hex) is both the block's canonical hash — the next block's `prevBlockHash` — and the
message the validator signs. The PoW preimage is the same encoding with `powNonce`
zeroed (`computePowHash`). Both functions live in `@dagsocial/validation`. The body is
bound into the header transitively through `utxoTxRoot` / `stateRoot`, and the chain's
superblock structure through `interlinkRoot` (→ Interlink vector), so the header alone
commits to the whole block.

### Interlink vector

Every block commits, through `interlinkRoot`, to the **interlink vector** `I(h)` — the superblock
back-pointers a NiPoPoW proof walks. This section is the vector's contract, because every full node
maintains and verifies it whether or not it ever serves a proof.

**Definition.** `I(1) = []`. For `h ≥ 2`, `I(h) = [id(1), p₁, …, p_M]` — `id(1)` the height-1
block's hash; `p_i` the hash of the most recent block among heights `2..h−1` whose level is at
least `i`; `M` the highest level among them. The vector is dense by construction: `I(2) = [id(1)]`,
and a chain of level-0 blocks keeps `[id(1)]`. A block's **level** is `VALIDATION_INTERFACE →
level` — ∞ at height 1, otherwise the largest `μ ≥ 0` with `powHit · 2^μ ≤ target`, an integer
computed from the header's own PoW and capped at `LEVEL_CAP`.

**Update rule** — the vector is a function of the parent alone:

```
updateInterlinks(prev: string[], prevHash: string, prevLevel: number): string[]
```

`prev` is the parent's vector `I(h−1)`, `prevHash` its `blockHash`, `prevLevel` its level. When the
parent is height 1 (`prevLevel === Infinity`) the result is `[prevHash]`. Otherwise, with
`L = prevLevel`, positions `1..L` become `prevHash`, positions above `L` are kept, and the length
grows to `L + 1` when `L ≥ prev.length`. Pure; returns a fresh array; never mutates `prev`.

**Bound.** `MAX_INTERLINKS = 257` — `LEVEL_CAP + 1`, the level cap plus the genesis entry, argued
from the maximum: the expectation is ~log₂ N entries, and the bound is not the expectation. The
codec refuses a longer vector before reading its first element.

**Encoding — one form for the wire, the store and the commitment's preimage:**

```
encodeInterlinks(vector) = vlqU(n) ‖ b32 × n           n ≤ MAX_INTERLINKS
decodeInterlinks(bytes)  = its inverse; the count is refused before the first element
interlinkRoot(vector)    = hex( blake2b512( INTERLINK_DOMAIN ‖ encodeInterlinks(vector) )[:32] )
```

`INTERLINK_DOMAIN = 'dagsocial/interlinks/1'` (→ Domain tags). Height 1 commits to the empty
vector — `interlinkRoot([])`, a real digest under the same rule, not a sentinel. There is no
run-length form: the bytes a proof carries are the bytes the header committed to.

**Who verifies.** Every full node checks `header.interlinkRoot === interlinkRoot(updateInterlinks(
I(parent), parentHash, level(parent)))` in the apply funnel (`NODE_INTERFACE` → Ordering block
apply-time authorization) and over a peer's segment before any of its work counts
(`VALIDATION_INTERFACE` → verifyHeaderChain, step 7); the block creator derives the template's root
the same way from the tip. The vector is stored beside each block as a cache derivable from headers
(`NODE_INTERFACE` → Ordering blocks).

**Genesis anchoring.** `I[0]` is the height-1 block's hash for every block above it. A profile that
pins `genesisId` (→ Network profiles) fixes which block 1 that can be; an unpinned profile accepts
any PoW-valid block 1, and two chains with different ones share no block.

⚠ **A retarget changes this section.** The level is defined against a target that is a constant
per profile at every height (`MINING_INTERFACE` → Difficulty Schedule). A difficulty adjustment, if
one is ever designed, makes a proof carry the headers a verifier needs to recompute the schedule —
Ergo's continuous mode — and is a `PROTOCOL_VERSION` bump with a new proof layout. Nothing here
reserves for it.

### Ordering block

Validator-produced, and a **nested** structure — a header plus one body tree and a
signature. There is no flat `hash` field (the hash is derived on demand via
`blockHash(header)`), and `height` / `powNonce` / `validatorId` / `prevBlockHash` live
on `header`, not on the block.

```
OrderingBlock {
  header: BlockHeader
  utxoTxTree: UtxoTxTree
  validatorSignature: Uint8Array(64)  // raw Ed25519 over blockHash(header)
}

UtxoTxTree {
  utxoTxIds: TxId[]                  // UTXO transaction IDs (likes and POSTS included)
  utxoTxs: Uint8Array[]              // encodeTx bytes (positional), aligned with utxoTxIds
}
```

⛔ **ONE COMMITTED LIST, AND ONE LEAF CLASS.** Posts, likes, prunes and the settlement are all
transactions, so they ride `utxoTxIds` together and the body has no second section.
`computeUtxoTxRoot` therefore builds every leaf as `leafHash('utxotx', id)` — one domain, one
preimage shape, and the only live one: `'stump'`, `'prune'` and `'coinbase'` are tracked
reservations (→ Tracked reservations; `'stump'` joins them with D5, whose prune payload carries no
subtree proof — Layout — PruneCommit).

Every block carries **one settlement transaction**, riding `utxoTxIds` / `utxoTxs` like any
other (`ARCHITECTURE` → Block architecture, `NODE_INTERFACE` → the settlement transaction);
coinbase outputs are **its outputs**, so no block-body field carries the reward. The
`'coinbase'` and `'subblock'` leaf domains are retired (`'coinbase'` reserved, `'subblock'` free) —
**§Merkle primitives holds the one live/retired list.**

⚠ **The body layout is positional** (`arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)`), and
`utxoTxTreeByteLength` computes the same length a second way and
gates `MAX_BLOCK_BODY_BYTES` — a body-layout change edits both computations or neither, and
`serialization.ts` states the pairing at both sites.

**The H-3 property — prune authorship checkable without DAG content — holds through the
body itself.** A post transaction carries the **whole post** in `utxoTxs` plus the
author's signature over the `TxId`, so a node syncing from ordering blocks alone holds
the thing an authorship claim would be about, and verifies it rather than trusts it.

⚠ **That guarantee rests on `utxoTxs` reaching every syncing node.** `utxoTxIds` alone
is not enough — the ids do not contain the post. **Any sync path that delivers ids
without bodies regresses H-3.**


`likeBoxIds` and `epochTallyResults` were deleted by P2-D: likes ride `utxoTxIds` like
every other transaction, and per-block settlement is **derived state** computed identically
by every node at apply — nothing to carry in the block. (The `EpochTally` structure, its
`epoch` Merkle leaf and `canonicalEpochTallyJson` died with it; audit C-6's
key-order-divergence problem is closed by not existing.)

**Authorship is the transaction's signer**, and every node holding the block body holds
it. A post transaction is signed over its `TxId` by the author's key, so the
`signatures` map names the author directly — there is no separate authorship claim to
contradict, and therefore no apply-time reconciliation between a claim and the content.
This is what makes prune authorship (audit H-3) checkable deterministically, and it
replaces a rule that required nodes holding the post to reject a block whose entry
disagreed with it.

### ~~Coinbase output~~ — DELETED (C1)

The struct has left the block body, `isTreasury` and all: coinbase outputs are credit outputs
of the block's **settlement transaction** (`NODE_INTERFACE` → the settlement transaction),
`coinbaseOutputBytes` is no Merkle leaf preimage, and the `'coinbase'` leaf domain is retired
and reserved. The treasury's slice accrues to a `TreasuryBox` and is never a credit output
(MINING_INTERFACE → Coinbase Application).

### ~~Epoch tally~~ — DELETED (P2-D)

`EpochTally` and `LikeReward` are gone with the epoch. Settlement is per-block and derived
— see `ARCHITECTURE §Likes` for the accrual arithmetic and `NODE_INTERFACE.md` for the
apply-time algorithm. Nothing epoch-shaped may return to the block structure.

### cumulativeWork — not this package's

`cumulativeWork` and `MAX_SATISFIABLE_TARGET_BITS` are **no longer exported here.** Work accounting is
derived from `orderingPowTarget`, and the dependency runs `validation → types`, so it cannot be computed in
this package at all.

**`VALIDATION_INTERFACE → blockWork / cumulativeWork` is the rule.** This section deliberately states
no property of it — not the formula, not the domain, not the totality guarantee. A restatement here
would be a claim about another package's internals that `types` has no way to see change, which is the
shape that decayed across six sites in PR #52.

The BigInt arithmetic measurement that shaped the bound, and the claimed-versus-verified-work defect
it contains, move with the function — `VALIDATION_INTERFACE → blockWork / cumulativeWork`.

---

## Serialization (`serialization.ts`)

> ✅ **RESOLVED — this section describes the code. Verified 2026-08-11.** It read
> `AHEAD OF CODE` until Phase 9, with the disclaimer *"The code is still `cbor-x`. Do not read
> this section as a description of current behaviour."* The positional bundle (Phases 0–8)
> is merged, so **everything from here to the Export table is now a description of running
> code** and should be read as one.
>
> ⚠ **This marker disclaimed roughly 500 lines, which is why retiring it matters more than the
> count suggests.** A marker saying "do not read this as current" creates an **unreviewed
> region**: for as long as it stood, no reader had reason to check any claim beneath it against
> the code. Anything that drifted in that span drifted unobserved.

All wire format is a **positional byte layout** built on `@dagsocial/wire` (`ByteReader` /
`ByteWriter` / VLQ — in-repo, zero dependencies, browser-clean). HTTP API is JSON. Signatures and
public keys are hex-encoded on the HTTP wire; raw bytes in the binary format.

`types` therefore depends on `wire`, promoting it from the transport-framing package to the base
codec layer. No cycle: `wire` has no dependencies. `wire`'s VLQ gains a **bigint** path in the same
work — its `number`-based one caps at 2⁵³ (an invariant stated in `WIRE_INTERFACE.md`) while
`value: bigint` spans the full u64.

**Why positional rather than CBOR.** CBOR maps are open by default: unknown keys, key reordering,
duplicate keys, indefinite-length forms and non-minimal integers all decode to an identical struct
from different bytes. Measured on the pre-migration tree, an ordering block carrying arbitrary extra
keys produced a **byte-identical `blockHash`** while the encoding differed by 395 bytes. Worse,
`cbor-x`'s own output is not canonical CBOR (it emits `b9` + uint16 map counts where the shortest
form is `a1`), which made the consensus format "whatever `cbor-x` 1.6.4 emits" — a specification no
independent implementation can be written against, and one the demo UI already had to reverse-engineer
by hand. See spec §1.

### The boundary check

Every `decode` performs four steps, in one entry point. A separate "assert canonical" step that
callers must remember to invoke is the shape that produced this defect class in the first place.

1. **Project onto the schema** — read declared fields in normative order. Unknown keys are
   unrepresentable; key order does not exist.
2. **Assert `isExhausted`** — trailing bytes are a rejection, not slack.
3. **Re-encode and byte-compare against the input.** Not redundant: VLQ accepts non-minimal
   encodings (up to 10 bytes of padding per integer field), and only the compare catches them.
4. **Callers convert `ReaderError` into a verdict.** The codec signals by throwing; the no-panic
   invariant is discharged at each boundary. Node's apply funnel catches explicitly and returns
   `false` rather than relying on its outer totality handler.

**The rejection is a `CodecError`** — a `ReaderError` whose `code` is `non-canonical` (WIRE_INTERFACE →
ReaderError codes) and whose `failure` names the step: `reader-fault` (step 1 — the per-struct reader
failed in a way that is not a `ReaderError`), `trailing-bytes` (step 2), `unencodable` and
`non-canonical` (step 3). A `ReaderError` the per-struct reader raises itself — a short read, a tag
outside its table, a well-formed value outside the field's domain (`out-of-domain`) — passes through
unwrapped. The class separates "not a canonical encoding" from "the reader refused"; the code
separates both from wire's own refusals, so a caller switching on `code` never has to know the class.

### Primitives

| Notation | Encoding |
|---|---|
| `u8(x)` | one byte |
| `vlqU(x)` | unsigned VLQ, u64 domain |
| `vlqS(x)` | ZigZag VLQ, signed i64 domain |
| `b32` / `b33` / `b64` | fixed-length raw bytes, **no length prefix** |
| `lp(x)` | `vlqU(byteLength) ‖ bytes` |
| `lpUtf8(s)` | `vlqU(utf8ByteLength) ‖ utf8Bytes` |
| `arr(xs, f)` | `vlqU(count) ‖ f(x)…` |
| `opt(x, f)` | `u8(0)` absent, `u8(1) ‖ f(x)` present |
| `enum8(x)` | `u8` from a reserved tag table |

**Normative rules.**

- **Field order IS the specification.** Reordering a struct is a consensus change with no compiler
  signal.
- **Ids are `b32` on the wire, hex `string` in memory.** The conversion lives in the codec layer and
  nowhere else — a conversion at any other site is a double-hexing defect.
- **Enum tags are never renumbered.** A renumber silently moves every id and `stateRoot` that covers
  the tag (the T2b `0x03` lesson, now applying inside the id preimage).
- **A retired tag's *number* may be reassigned to a new type — under all three of the following, and
  otherwise not at all.** Reassignment is not a renumber and the argument above does not reach it: a
  renumber moves ids that exist, while this one assigns a meaning to a number nothing has used. It is
  admissible only when
  1. **no surviving history carries the tag** — nothing has ever been encoded under it, or the same
     unit forces a fresh chain, so there is no id for the new meaning to collide with;
  2. **every other tag keeps its number**, which is what makes "no existing id moves" checkable
     rather than asserted — the ids that move are exactly the ones that do not exist; and
  3. **the retired *name* stays reserved while remnants of the retired type remain in the
     codebase** (user, 2026-08-19). A new type wearing a name the tree still mentions makes
     old-vs-new greps and debugging ambiguous against those mentions. When the last remnant
     goes, the reservation expires with it — a name with zero occurrences cannot be ambiguous
     with anything. **Surviving reservations are tracked in the allocator table they guard**
     (the tracked-reservations block below the tag table), each row naming the remnant class
     that holds it; a deletion-proof guard test is itself a remnant, so freeing a name
     includes deleting its guard. **A mention inside a dated record block is not a remnant** —
     a record is timestamped and cannot be confused with a live meaning.

  Fail condition 1 or 2 and the number stays reserved — left out of the table, never reused.

  > ## ⛔ AND WHEN ALL THREE HOLD, REUSE IS NOT OPTIONAL (user, 2026-08-17)
  >
  > **A new type takes the lowest free tag that satisfies the three conditions above. It does not
  > take the next number above the table.** This turns the clause from a permission into a rule, and
  > the permission alone is what produces a sparse table: every retirement leaves a hole nobody is
  > obliged to fill, so the range grows with the *history* of types rather than with their count.
  >
  > ⚠ **This is a live defect, not a hypothetical.** Tag 2 was free and admissible when
  > `like_accrual` and `vouch_escrow` were assigned **11** and **12** — the reservation prose said
  > "never to be reused" and the executor followed it. ⛔ **The hole stands** (user, 2026-08-17): the
  > rule governs types created from here on, and re-cutting a landed assignment buys density in a
  > table nothing reads by number.
  >
  > ✅ **The cleanup is forced rather than remembered.** A number cannot be claimed without editing
  > the text that reserved it, so the remnants of the retired type surface at exactly the moment
  > someone is already in that table. **Report them; do not sweep them silently** — what else still
  > references the retired type is the user's call, not the claimer's.
  >
  > ⚠ **Condition 2 binds harder than a fresh chain requires, and that is deliberate.** Under a wipe
  > no id exists to move, so *renumbering survivors* would also be safe — but "every other tag keeps
  > its number" is what makes "no existing id moves" checkable by inspection instead of argued from
  > the deploy gate holding. **Filling holes needs no such argument; compaction does.**
- **Maps encode as arrays sorted by raw key bytes ascending.** A positional format has no maps, and
  without a normative sort one transaction has two encodings — reopening the malleability being closed.
- **Encoders are total** (sentinel discipline, per audits M-5/M-6), with one stated exception: see
  "Totality" below.

### Totality

Integer writers are **total**: a value outside the encodable domain writes an all-ones sentinel
rather than throwing. This is load-bearing — `postFieldBytes` is reached with malformed posts, and a
throwing writer turns a malformed post into a panic, breaking the no-panic contract
`@dagsocial/validation` asserts.

The sentinel works only where the encodable domain is **narrower** than the wire domain. Applied
honestly that yields **four** non-total writers, not one — an earlier draft of this section said one,
and Phase 1b corrected it:

| Writer | Wire domain | Encodable domain | Total? |
|---|---|---|---|
| `vlqU` / `vlqS` (number) | u64 | non-negative safe integers | ✅ sentinel — ten bytes, unreachable from a value needing at most eight |
| `lp` / `lpUtf8` | u64 length | safe-integer length | ✅ sentinel on the length prefix |
| `enum8` | one byte | closed tag set | ✅ sentinel `0xff` |
| **`vlqU64` (bigint)** | u64 | u64 | ❌ **throws** |
| **`b32` / `b33` / `b64`** | every value of that width | ditto | ❌ **throws** |
| **`u8` (bare)** | one byte | one byte | ❌ **throws** |

A fixed-width field has no unreachable sentinel for exactly the reason `bigint` has none: its wire
domain is everything representable. Padding or truncating a malformed id to 32 bytes would map it
onto a **well-formed id's encoding** — a consensus-level id collision, strictly worse than the panic
it avoids. Throwing writers are named `…OrThrow` so the exception is visible at every call site.

> ⚠ **Every throwing writer needs its domain established upstream, and two obligations are
> outstanding.**
>
> **1. `bigint` at `block-apply.ts:867`** — `computeTxId` runs there behind `checkTxEnvelope` only,
> which deliberately does not type output entries (`utxo-engine.ts:908`); the `u64` pin is
> `checkOutputShape` at `validateTx` step 4, later. Booked to Phase 6.
>
> **2. `b32` on the post path — PARTIAL, and it inverted the migration order.**
> Under the new layout `author` and `challenge` were `b32` and `parentRefs` `arr(refs, b32)` —
> three of `postFieldBytes`' then-six fields. Under the old dialect this could not bite: everything
> was length-prefixed, so any width encoded faithfully and injectively.
>
> **The enumeration was `postFieldBytes`' four then-entry points — `signingHash`,
> `postPowPreimage`, the content-derived `computePostId` and `verifyPostId` (all four
> deleted; the `computePostId` NAME was later reused for the live provenance-derived
> `(txId, index)` form, a different function) — reaching it from 15 production call sites.** (An earlier
> draft of this block said "eight further sites"; that was main's count, and it was wrong. It also
> missed `verifyPostId` as an entry point altogether, and `store/posts.ts:82` `insertPost`, which is
> the store-admission write that the whole downstream classification depends on.)
>
> **No site is independently structurally guaranteed.** The tail is safe only if everything written
> to the store passed a domain check — and the store-admission write is itself one of the call
> sites. The chain is non-circular only because three gates sit upstream of it.
>
> **Closed by Phase 1c** (`5c0bf71`): `verifyPostFieldDomains` in `@dagsocial/validation` pins
> `author` at 32 bytes and every `parentRefs` entry at 64 **lowercase** hex. Lowercase is
> load-bearing — `'AB…'` and `'ab…'` hex-decode to identical bytes, so accepting both would make the
> codec boundary non-injective. It is reached from `isSignablePost` and from
> `verifyTxStructure`.
>
> ⚠ **The gossip-relay justification that stood here was one phase stale — corrected 2026-08-10,
> the same correction `VALIDATION_INTERFACE §verifySubBlockStructure` already carried.** It said
> `verifySubBlockStructure` closes the relay path with no `net` edit, `gossip.ts:201` running before
> the preimage is built. Since Phase 3b the positional decoder runs **first** and establishes those
> domains itself, so nothing out of domain reaches the check on that path. **Two contracts stated
> one claim, and only the one that was refuted got corrected** — a stale pointer is inherited by
> every document that repeats it, not only by the one that owns it.
>
> ✅ **Phase 1d's three gates are closed — verified 2026-08-10.** All three call
> `verifyPostFieldDomains`: `verifier.ts`'s `verifyPost` and `verifyPostForRelay`, and
> `content-sweep.ts`. The line numbers that stood here (`:148`, `:230`, `:92`) had every one moved,
> which is why this paragraph names symbols instead. `content-sweep` was the sharpest site in the
> tree — `verifyPostId` cold, zero prior checks, on a post whose decoder explicitly declines to
> inspect the interior, and the sync path stayed on `cbor-x` through every codec phase, so **no
> codec phase would ever have closed it.**
>
> **This is not merely tightening the already-unusable.** A post with a 64-character *non-hex*
> `parentRef` passes the complete Stage-1 pipeline today, signature and PoW included, because the ref
> is hashed as UTF-8 text and the signature covers those bytes. One third of the pin is a real
> behavioural change.

### Layout — PostCommit

The struct is five fields; there is no `powNonce`, `challenge`, `signature` or `timestamp`
in it at all (§Post identity — identity is provenance-derived, authentication is the
creating transaction's signature; on-chain time is block height, and a post's display time
is its confirming block's `createdAt`, NODE_INTERFACE → Posts) — and there is no `content`:
the commit carries the body's hash, the body itself travels and is stored apart (→ Layout —
Post body).

| # | Field | Encoding |
|---|---|---|
| 1 | `contentHash` | `b32` (bytes writer) — `computeContentHash(content)` |
| 2 | `author` | `b32` (bytes writer) |
| 3 | `parentRefs` | `arr(refs, b32)` (hex writer) |
| 4 | `protocolVersion` | `vlqU` |
| 5 | `type` | `enum8` — the `POST_TYPE` table, `{ regular: 0, profile: 1 }` |

- `postFieldBytes` is these five fields in this order, and is the post's **payload inside its
  creating transaction** — it enters that transaction's `TxId` (§Canonical field encoding).
  Slot 1 is fixed-width, so the layout stays self-delimiting and injective.
- Wire codec `encodePostCommit` **delegates**: `write` is one `writeBytes(postFieldBytes(c))`
  and `read` is the adjacent `readPostCommitFields`, so the standalone wire form and the
  in-transaction payload are the same bytes with one statement of the layout.

### Layout — Post body

The body's standalone wire form — a pull response's element, and the packet's trailing field:

| # | Field | Encoding |
|---|---|---|
| 1 | `content` | `lpUtf8` — 1–`MAX_CONTENT_BYTES` UTF-8 bytes |

- Wire codec `encodePostBody(content)` / `decodePostBody(bytes)`. Keyed by the post id wherever
  it travels (the packet's transaction, the pull request's id list); **never hashed into
  anything** — the only binding is `computeContentHash(content) == commit.contentHash`, checked
  by `verifyPostBody` at every entry (VALIDATION_INTERFACE → verifyPostBody).
- There is no `encodePost` / `decodePost`: nothing stores or ships a `Post` as one struct — the
  commit has its codec, the body has its own.

The encodings are positional and injective (audit M-1); the frozen golden vectors are the
cross-implementation anchor, reproduced by the demo-UI mirror.

### Layout — Stump

**A `Stump` has no wire form.** It is a local projection of an applied prune — derived at
settlement, never transmitted, never re-read as bytes (`NODE_INTERFACE` → "Stumps are derived
state"). Its id is its `rootPostHash`, not a hash of any encoding.

**A prune has no `trigger` field.** Every prune is the author's act — the author signs the
transaction and the author's locks pay for it — so the cause is a constant and carries no field
anywhere: not in `PruneCommit` or `Stump`.

### Layout — PruneCommit

**The prune payload carried by a karma transaction** (`UtxoTransaction.prune`), written into
`txIdBytes` field 6 through `pruneFieldBytes`:

```
b32(rootPostHash)
```

**One field, and the set is the node's to derive.** The subtree a prune removes is
`block_topology`'s answer for the root at the applying height, same-block replies included, and
every node derives it identically (NODE_INTERFACE → Prune transactions). **The payload does not
carry the set, and that is a rule with two reasons**: a carried set pins the author to a snapshot,
so a reply confirmed between signing and inclusion is a block-invalidating mismatch that two
unrelated users can hand a producer; and a carried set puts the transaction's byte bound on the
subtrees an author can prune at all. The author signs "this thread", which is exactly what subtree
ownership grants (ARCHITECTURE → Subtree ownership).

`authorId` and `authorSignature` do not appear: the payload sits inside the `computeTxId` preimage,
so the transaction's own signature covers it and the author is `inputKarma.owner`. The layout is
the shape `PostWithdrawCommit` has.

**Fixed-width, so the writer throws outside its domain** (→ Totality) and the encoding is
self-delimiting. `verifyPruneCommitDomains` (`@dagsocial/validation`) is the single statement of
the domain that writer assumes.

⛔ **A `PruneCommit` has no id of its own, and needs none.** A prune is a transaction: its `TxId`
identifies it and its spent inputs are its dedup, since a pooled prune cannot be duplicated once
its boxes are gone.


### Layout — PostWithdrawCommit

**The withdrawal payload carried by a karma transaction** (`UtxoTransaction.postWithdraw`),
written into `txIdBytes` field 7 through `postWithdrawFieldBytes`:

```
b32(postId)
```

**One field, and one is the whole payload.** A prune's effect spans a subtree that has to be
pinned against topology; a withdrawal's effect is one post. Authorship is `inputKarma.owner`
against that post's `block_topology` author, and the payload sits inside the `computeTxId`
preimage, so there is no separate preimage to domain-tag and no `authorId` or signature of its
own (NODE_INTERFACE → Withdrawal transactions).

**Fixed-width, so the writer throws outside its domain** (→ Totality) and the encoding is
self-delimiting. `verifyPostWithdrawCommitDomains` (`@dagsocial/validation`) is the single
statement of the domain that writer assumes.

⛔ **A `PostWithdrawCommit` has no id of its own, and needs none** — the transaction's `TxId`
identifies it and its spent inputs are its dedup.
### Layout — Boxes

Two encodings, named separately so that "provenance is not in the id" is structural rather than a
runtime strip somebody must remember:

- **`boxContentBytes`** — candidate fields only. What `computeBoxId` and `computeTxId` hash.
- **`boxRecordBytes`** — `boxContentBytes ‖ b32(txId) ‖ vlqU(index)`. What the AVL value and the
  store hold. The `id` is never encoded: it *is* the hash.

**`BOX_TYPE_TAGS` is the single source of the box-type numbering.** It is exported from
`@dagsocial/types` and consumed inside the package by `enum8`; node's AVL tag tests import it to
**derive** the first unassigned tag rather than writing a number down. No other package may declare
it. **The demo UI is the one permitted copy**, being browser JS with no module graph and a mirror by
construction; the golden corpus's reverse tag table is a deliberate independent restatement rather
than a copy. **Independent in its numbers, not in its coverage**: the corpus restates every tag by
hand and imports neither `BOX_TYPE_TAGS` nor the codec, but its type-to-tag table is
`satisfies Record<BoxContent['boxType'], number>`, its own `BoxContent['boxType']` union is asserted
equal to `BoxCandidate['boxType']` at the type level, and `golden.test.ts` asserts that `boxes.json`
carries at least one vector per box type. A box type added to `utxo.ts` without a corpus arm, a tag
row or a vector is therefore a compile or test failure, not a corpus that silently cannot read it.

A wrong tag moves every box id and every `stateRoot` covering it — loudly, and everywhere.
`BOX_TYPE_TAGS` gets no compile-time check for **uniqueness** — a duplicate tag is an `enum8`
construction throw, not a type error.

> ⚠ **"What the AVL value holds" means the AVL value IS `boxRecordBytes` — no wrapper, no extra
> discriminator byte. Stated explicitly 2026-08-10 because the implicit reading cost a phase.**
>
> `boxRecordBytes` **begins with `enum8(boxType)`**, so it is already self-describing. Node's
> `state/serialize-box.ts` separately carried its own one-byte box-type tag from an earlier design,
> and composing the two — `avlTag ‖ boxRecordBytes` — writes the box type **twice, in two
> disagreeing numberings, in adjacent bytes**. The two numberings put the retired-`like` reservation
> in *different positions* (`enum8` held `3` between `invite` and `bond` — since reassigned to
> `genesis_proof`; the AVL tag reserved `0x03` between `credit` and `invite`), so they did not even
> differ by a constant. **`enum8`'s
> numbering wins**; see `NODE_INTERFACE` → "Two entity kinds" for the full record and why renumbering
> is safe exactly once.
>
> **This makes an existing contractual claim exact rather than approximate.** `NODE_INTERFACE` §1a
> argues the AVL value must carry everything the id derivation consumes, so that *"a box id is a
> total function of the stored box"* is checkable **from a proof** rather than trusted. With the
> value equal to `boxRecordBytes`, that becomes literal: **`boxId = blake2b512(BOX_ID_DOMAIN ‖
> avlValue)[0:32]`**, so a light client recomputes the key from the value it was served.

> ⚠ **`boxRecordBytes` is paired with `boxRecordFromBytes(bytes) → { candidate, txId, index }`, and
> BOTH live in this package. Decided 2026-08-10.**
>
> The writer was specified without a reader, and node's `deserializeBox` has to parse those bytes
> back — so without this, the per-type box field order would have **two definitions in two packages**,
> writer here and reader in `node`, free to drift. That is the same defect the discriminator note
> above retires, in the same tree, found the same day: *two encoders written months apart that nobody
> had put side by side.*
>
> **Every other wire struct in this repo is already paired here** — `serialization.ts` holds eight
> encoder/decoder pairs and there is no unpaired wire struct anywhere. A writer-only `boxRecordBytes`
> would have been the first, and the asymmetry is what made the gap invisible: nothing was *missing*
> from any list, because no list of readers existed to be short.
>
> `boxRecordFromBytes` carries the four-part boundary check like every other decoder. **The proof
> obligation is a round-trip over all nine box types**, which is strictly stronger than a frozen
> vector: a frozen vector can pass while writer and reader disagree, a round-trip cannot.
>
> Found by the Phase 5 executor, who identified it as a types change and declined to write the reader
> in `node` even as a stopgap.

Shared prefix: `enum8(boxType)` ‖ **`vlqU64(value)`**.

⚠ **`value` is `vlqU64`, not `vlqU` — corrected 2026-08-10, and the distinction is a domain, not a
width.** This cell said `vlqU` while the code has always called `writeVlqU64OrThrow`; the
field is `bigint`. **The bytes are
identical over the overlapping range, so nothing was broken** — which is exactly why it survived. But
`vlqU` is total by sentinel and collapses anything past `MAX_SAFE_INTEGER`, while `vlqU64` **throws**
outside `[0, 2⁶⁴)`, and spec §2.5 names the `OrThrow` writers precisely so that a totality exception
is visible at the call site. A contract that writes `vlqU` where the code throws hides the one thing
the naming convention exists to show. Found by the Phase 5 executor while hand-deriving golden bytes
from this table — a use that reads every cell as an instruction rather than as prose.

| Tag | Type |
|---|---|
| 0 | `karma` |
| 1 | `credit` |
| 2 | `invite` |
| 3 | `genesis_proof` |
| 4 | `bond` |
| 5 | ⛔ **reserved** — `'post_lock'` (→ Tracked reservations) |
| 6 | `vouch` |
| 7 | `emission` |
| 8 | `treasury` |
| 9 | `fee` |
| 10 | `karma_pool` |
| 11 | `like_accrual` |
| 12 | `vouch_escrow` |
| 13 | `karma_price` |
| **255** | ⛔ **PERMANENTLY UNASSIGNED — the probe value. Never give it a type.** |

> ## Tracked reservations (remnant-bounded — tag rules, condition 3)
>
> Reserved while the named remnants stand; the row leaves this table when they go.
>
> | Reserved | Held by |
> |---|---|
> | tag `2` + boxType `'invite'` | §InviteBox record and its in-code citations; the tag-2 reject vectors; `node/store/db.ts`'s tag-order comment |
> | tag `5` + boxType `'post_lock'` | §PostLockBox's retired record and its in-code citations; the tag-5 reject vector |
> | boxType `'like'` | the live illegal-transition rule (`utxo-engine`'s like clause) and its reject vectors |
> | leaf domain `'coinbase'` | the live coinbase concept (`coinbase-split.ts`, `COINBASE_*` constants) — the string is permanently collision-prone while the concept lives |
> | leaf domain `'prune'` | the live prune concept (`PruneCommit`, `pruneFieldBytes`, `PrunedTombstone`, `executePrune`, `prunesOf`, `routes/prune-withdraw.ts`) — a prune is a transaction, not a Merkle leaf, and the string stays collision-prone while the concept lives |
> | leaf domain `'stump'` | the live stump concept (`Stump`, `dag_stumps`, `insertStump`, `stump-engine.ts`, the `'stump'` resolution shape) — a stump is derived state with no Merkle leaf, and the string stays collision-prone while the concept lives |

> ## ⛔ TAG 2 IS A TRACKED HOLE
>
> `invite` is deleted (§InviteBox) and its number is reserved **while the tracked-reservations
> row above holds** — as is `post_lock`'s tag `5` (§PostLockBox) — the lowest-free-tag rule then governs it like any hole. A hole **inside**
> the assigned range is a distinct decode case from a tag past the end, and both need a reject
> vector.
>
> ## ⛔ A REJECT VECTOR MUST NOT BE PINNED TO "THE NEXT FREE TAG"
>
> **255 exists so that an unassigned-tag probe never has to move.** A vector pinned at the first
> unassigned number is invalidated by the **next** box type added, silently — it stops testing what
> it was written to test the moment its number is assigned, and the failure surfaces as a golden
> vector that mysteriously needs re-pinning.
>
> ⚠ **This already bit.** A golden reject vector was pinned at literal **11**, and the like accrual
> marker took 11. Re-pinning it to 13 reproduces the defect one addition later.
>
> ✅ **`enum8` is a table lookup over `u8`, so 255 and "first unassigned" exercise the same path.**
> Nothing is lost by choosing the stable one. ⛔ **Verified 2026-08-17, not assumed**: `enum8.read`
> is `reverse.get(tag)` over a `Map` with **no range comparison**. Had it been a range check, an
> unassigned tag *below* the maximum and one *above* it would be different paths and folding the two
> probes into one would have been wrong — **which is why this was checked rather than reasoned.**
>
> ⚠ **The corpus must still not import `BOX_TYPE_TAGS`.** Deriving the probe from the writer's own
> table would make the reader circular, which §Layout — Boxes forbids by construction. **255 is a
> literal that stays independent AND stays stable** — that is the whole reason to reserve one rather
> than to derive. ✅ **Node's AVL tag tests deriving the first unassigned tag is a different case and
> stays right**: they are not the independent reader.

| Type | Trailing fields |
|---|---|
| `karma` | `b32(owner)` |
| `credit` | `b32(owner)` ‖ `opt(lockedUntilBlock, vlqU)` |
| `invite` | `b32(inviterId)` ‖ `b32(inviteePublicKey)` |
| `genesis_proof` | `lp(payload)` |
| `bond` | `b32(inviterId)` ‖ **`b32(inviteePublicKey)`** |
| `vouch` | `b32(voucherId)` ‖ `b32(targetId)` |
| `emission` | *(none)* |
| `treasury` | *(none)* |
| `fee` | *(none)* |
| `karma_pool` | *(none)* |
| `like_accrual` | `b32(author)` |
| `vouch_escrow` | `b32(owner)` ‖ `vlqU(releaseAtBlock)` |
| `karma_price` | *(none)* |

> ## ⛔ WHAT A NEW BOX TYPE COSTS, AND WHY A GREP FOR THE TYPE MISSES THE WORST SITE
>
> A box type is enumerated in hand-kept places across three packages, and **the compiler links them
> only where the enumeration is keyed on the union.** Measured 2026-08-18 for `like_accrual` and
> `vouch_escrow`; the gate column re-measured 2026-08-20:
>
> | | | Gate |
> |---|---|---|
> | `types/src/utxo.ts` | the interface, `BOX_TYPE_TAGS`, the codec arm | `satisfies Record<BoxCandidate['boxType'], number>`; the codec `switch` returns on every arm |
> | `types/test/golden/structs.ts` | the corpus's **deliberately independent** reverse table | coverage-gated — §Layout — Boxes, "independent in its numbers, not in its coverage" |
> | `node/src/services/utxo-engine.ts` | the output shape schema, `SPEND_TIMING`, `AUTHORIZATION`, the transition set, the protocol-output set | the first three are `Record<…['boxType'], …>`; the two sets are verdict tables (NODE_INTERFACE → Three karma sets, and none derives from another) |
> | `node/src/store/utxo.ts` | the row mapping | the write `switch` is exhaustive by a `never` default; the read `switch` is over a string column and is covered by the provenance round-trip's total table instead |
> | `node/src/karma-supply.ts` | the supply set | a verdict table (NODE_INTERFACE → Three karma sets, and none derives from another) |
> | `node/public/index.html` | `BOX_TYPE_TAGS` **and** the `boxTypeFields` arm — ⛔ **no gate reaches this file directly** | `ui-crypto-mirror.test.ts` pins both against the package, keyed on the union |
>
> ⛔ **THE RULE, FOR EVERY PACKAGE: AN ENUMERATION OVER BOX TYPES IS KEYED ON THE UNION, NEVER
> WRITTEN AS AN ARRAY.** `Record<AnyBox['boxType'], …>` for a total table; an `Exclude<…>`-typed key
> set where an exclusion is deliberate, so the exclusion is in the type rather than an omitted row;
> the array a reader needs derived from the table's keys. **A test whose title or comment claims to
> cover every box type enumerates the same way** — an array of the union is satisfied by any subset
> of it, so such a test stays green while its title is false. The two enumerations that cannot be
> typed — the demo UI's browser JS and the store's read `switch` over a string column — are each
> covered by a keyed test instead, as the table says.
>
> ⛔ **AND ONE MORE THAT A SEARCH FOR THE TYPE CANNOT FIND.** `node/src/routes/json-to-tx.ts`'s
> `BINARY_BOX_FIELDS` is keyed on the **field name**, not the box type — so `grep like_accrual`
> returns the six sites above and **not** the one that decides whether the box can be expressed over
> HTTP at all.
>
> ⚠ **It failed exactly that way.** `author` was missing, so a `LikeAccrualBox` arriving as JSON kept
> its hex string and died at `validateTx`'s step-4 schema — **the whole like path was unreachable
> over HTTP while every service-level test stayed green**, because those tests pass raw `Uint8Array`
> objects and never cross that edge. ⛔ **The file's own comment predicted this defect in the
> abstract, two lines above the list it was missing from.** A hazard documented at the site does not
> fire; only a test at the right layer does.
>
> ✅ **So the check is a ROUTE-level test for any box type with a binary field**, and the enumeration
> to run is **by field name as well as by type**.

> ⚠ **`releaseAtBlock` is `vlqU`, NOT `vlqU64`, and NOT `opt`.** It is a block height, so it takes
> the same writer as `credit.lockedUntilBlock` — and unlike that field it is **always present**, since
> an escrow with no release height is not a state the type admits. ⛔ **Read the `vlqU` / `vlqU64`
> correction above before copying either cell**: the distinction is a **domain**, not a width. `vlqU`
> is total by sentinel and collapses anything past `MAX_SAFE_INTEGER`; `vlqU64` throws outside
> `[0, 2⁶⁴)`. Heights take `vlqU`; `bigint` values take `vlqU64`.
>
> ⚠ **`like_accrual` carries no `owner`, deliberately.** `author` is **attribution, not
> authorization** (§LikeAccrualBox) — no signature by it unlocks the box, and only the settlement
> transaction consumes one. Naming the field `owner` would invite exactly the reading the type exists
> to refuse.

⚠ **`emission`, `treasury`, `fee`, `karma_pool` and `karma_price` have an empty tail, and an empty cell in this
table is a layout, not an omission.** Their content encoding is the shared prefix alone —
`enum8(boxType)` ‖ `vlqU64(value)` — because none of them names an owner. The `enum8` tag is the
whole of what separates them from each other, exactly as it separates `invite` from `bond`, and
their ids differ from one another and across heights through the provenance `computeBoxId` appends.

> ⛔ **Assigning tag 10 MOVES A GOLDEN VECTOR, and that is the design working.** The corpus carries
> `box/unassigned-tag-10` with the number written as a **literal**, deliberately not derived, beside
> `utxo.test.ts` deriving the same number from `BOX_TYPE_TAGS` — *"one side follows the table, one
> side pins it."* The derived side moves on its own; **the literal must be re-pinned by hand to the
> next unassigned tag**, and that re-pin is the act that proves the assignment was intended rather
> than accidental. The corpus says so itself: *"assigning it is what moves this vector."*

`genesis_proof.payload` is `lp`, **not** `lpUtf8`: the bytes are opaque to consensus. Whether they
decode as text is a client's question, and a UTF-8 writer would put a validity rule inside an encoder
that does not own one. The length prefix is the whole of the field's injectivity — appended raw, an
empty payload would be indistinguishable from the end of the box. It is the only arm whose entire
tail is one field; at `enum8(3) ‖ vlqU64(0) ‖ vlqU(0) ‖ u8(0)` it is four bytes, and the **smallest
legal box of any type is `emission`, `treasury` or `fee` at three** — the shared prefix with nothing
after it. ⚠ **Both counts are measured, not derived**: `fee` at zero encodes `090000` and an empty
`genesis_proof` encodes `03000000`.

⚠ **`genesis_proof.payload` carries the one per-type domain rule in this table**: the reader refuses
a payload over `MAX_GENESIS_PROOF_PAYLOAD_BYTES` (§GenesisProofBox, §Content limits). It binds this
row and no other — a second implementation that took the bound from `lp` itself would refuse
`tx.preimages`, `utxoTxs` and the block's three sections, all of which use the same primitive
unbounded. Every other refusal these rows make belongs to the primitive named in the cell.

**`genesis_proof.payload` is the only place inside a box where a length prefix can change width** —
every other field in the table is fixed-width or a `vlqU`/`vlqU64` whose width follows its value.
`karma` and `credit` are the pair this matters most for: both are a fixed 32-byte owner and one
option, and the `enum8` tag is the whole of what separates them at equal `value`. `emission` and
`treasury` stand in the same relation to each other with no fields at all.

⚠ **The option tag is what keeps absence from being a value.** An absent `lockedUntilBlock`
writes a bare `u8(0)`; `lockedUntilBlock: 0` writes `u8(1) ‖ vlqU(0)`. A raw `vlqU` with `0`
standing for "unlocked" would give an unlocked box and a box locked until block 0 one id.

**`bond.inviteePublicKey` is `b32`.** The field is exactly 32 bytes at every point
in a bond's life: invite creation sets it (BondBox above) and no later transition
clears or widens it, so there is no absence for an option tag to distinguish from a
value. **`bytes0or32` loses its only user with this row** — `utxo-engine.ts:1065`
is the sole site in the output-shape schema that names it.

`invite` and `bond` carry **identical trailing fields**, so their leaves differ only
by the `enum8` tag and by `value` — the same standing that `karma` and `credit`
have two rows above. The tag is what makes the encoding injective; `value` happens
to differ too (an invite is always `0`), but nothing may rely on that.

**The standing rule, for every layout row:** a `b32` row is a claim about the
field's **domain**, not its TypeScript type — `Uint8Array` is equally the type of a
fixed-32 field and a 0-or-32 one, so the type cannot settle the width. **Check the
producers before pinning a width.** The cost of over-pinning is not a fixture
problem: `writeBytesNOrThrow` throws on zero-length input, and `computeTxId` runs
inside `validateTx`, so an over-pinned row is a live throw on every producer of
that box.

⚠ **A search for `bytes0or32` cannot find every instance of this defect**, and the
reason generalises: that searches a **name**, where the property is *a throwing
writer whose schema type does not pin its domain*. `post_lock.targetPostId` was a
hex **string**, so it was not a byte-kind entry at all and no pass over that list
could surface it — it was the `✗` row in the table below.

**The correct search, and the one to reuse: cross-check every throwing writer in the layout against
the schema type of the field it writes.** Run over the box arms 2026-08-09:

| Field | Writer | Schema type | |
|---|---|---|---|
| `karma.owner`, `credit.owner`, `invite.inviterId`, `invite.inviteePublicKey`, `bond.inviterId`, `bond.inviteePublicKey`, `vouch.voucherId`, `vouch.targetId` | `writeBytesNOrThrow(…, 32)` | `bytes32` | ✓ |
**The `✗` row was `post_lock.targetPostId`, and it is closed by DELETION rather than by a
domain pin.** The field is gone (→ PostLockBox): it was unbuildable under provenance-derived
post ids, so the throwing writer it fed has no input left to be adversarial about. There is no
throwing writer in the box arms whose schema type fails to pin its domain.

⚠ **Deletion is a legitimate close and a misleading one to leave unrecorded.** The method the
row exists to teach — cross-check every throwing writer against the schema type of the field it
writes — is unaffected, and is still the search to reuse. What changed is the instance, not the
class: a future box field can reintroduce the shape, and the table above is how it gets found.

**Phase 3 must run the table above against the block structs before pinning any width**, and must run
it in that shape: writer versus schema type, field by field. Two rows in this contract were wrong,
and both were found by someone searching from a direction the previous searcher had not.

### Layout — UtxoTransaction

**Id preimage** (`txIdBytes`) — signatures are Ed25519 *over* the txId and are correctly absent:

`arr(inputs, b32)` ‖ `arr(outputs, boxContentBytes)` ‖ `vlqU(protocolVersion)` ‖
`opt(likeTarget, b32)` ‖ `opt(post, postFieldBytes)` ‖ `opt(prune, pruneFieldBytes)` ‖
`opt(postWithdraw, postWithdrawFieldBytes)`

> ⛔ **`TX_ID_DOMAIN` IS NOT IN `txIdBytes`. Corrected 2026-08-17.** This line listed it first while
> §UtxoTransaction's formula applies it outside — `TxId = blake2b512(TX_ID_DOMAIN ‖ txIdBytes)[0:32]`
> — so one contract stated the preimage two ways. **The code has always applied it outside**, and the
> wire codec row below depends on which is meant: `encodeTx` is `txIdBytes ‖ arr(signatures)`, and a
> 17-byte domain tag riding the wire would be a different format from the one measured at 236 bytes
> per like.
>
> ⚠ **A domain tag belongs to the HASH, not to the bytes.** It exists so two different structs
> cannot collide in one hash function; putting it inside the serialized form would also ship it to
> every peer, which is the opposite of what it is for.
>
> ⚠ **`preimages` is gone from this line** (2026-08-17) — it was `opt(arr(preimages sorted,
> b32(boxId) ‖ lp(preimage)))` between the outputs and `protocolVersion`. ⛔ **Removing it moved
> every `TxId` in existence**, because `opt` spends a one-byte absence marker even on a transaction
> that never carried one. See "Re-pinning a frozen vector when a preimage changes".

No payload needs a length prefix inside its `opt`: `postFieldBytes`, `pruneFieldBytes` and
`postWithdrawFieldBytes` are each **self-delimiting** — every field within them is fixed-width,
length-prefixed or a VLQ — so each one's end is decidable from its own bytes wherever it sits.

⚠ **Self-delimiting is the whole of the argument, and finality is no part of it.** *"It is
last, so nothing follows it"* is not a reason to reach for here: **a property that depends on a
field's position expires the next time the layout grows**, and it expires quietly, in the
paragraph next to the field that was appended. The property stated above holds wherever a
payload sits.

⛔ **SEVEN FIELDS, and an absent `opt` still spends its tag byte.** Appending field 7 moved every
`TxId` in existence and every box id derived from one, exactly as appending field 6 and removing
`preimages` did — see "Re-pinning a frozen vector when a preimage changes". A reader that keeps
six offsets reads
`prune`'s tag as the end of the struct; the count is load-bearing, and the demo UI's mirror
(`public/index.html`) states it too.

Order preserves today's sequence. This satisfies **C1 structurally**: the prior preimage used
`String(protocolVersion)` (the M-1 pattern) and concatenated inputs and variable-length outputs with
no counts or length prefixes. `preimages` already sorted by key, so the normative sort **ratifies**
existing behaviour there; for `signatures` it is new, because they were never hashed.

**Wire codec** (`encodeTx`): `txIdBytes` ‖ `arr(signatures sorted, b32(pubkey) ‖ b64(sig))`.

**Packet codec** (`encodeTxPacket(tx, content?)`): `encodeTx(tx)` ‖ `opt(lpUtf8(content))` —
the gossip payload of `/dagsocial/tx/1` for **every** transaction (NET_INTERFACE → Gossip
Topics). The body is outside `txIdBytes`, outside every id and every Merkle leaf; a
transaction that carries no post pays the `opt` absence tag, one byte, on the wire only.
`decodeTxPacket(bytes) → { tx, content? }`. **`tx.post` present ⟺ `content` present** — the
rule is stated and enforced where packets enter (NET_INTERFACE → Gossip Topics,
NODE_INTERFACE → Post transactions); the codec itself encodes whatever it is given, so the
biconditional is a check, not a property of the bytes.

> ## ✅ RESOLVED — the layout is implemented. Closed 2026-08-17.
>
> **`encodeTx` is positional and reaches `writeTxIdFields`**, so the wire form and the `TxId`
> preimage share one writer rather than agreeing by inspection. This banner read `⚠ UNENFORCED`
> against a `cbor-x` implementation; the gap `serialization.ts` recorded in its own words is closed
> on both halves — `encodeTx` is positional, and the `Stump` codec is deleted rather than
> converted: a stump has no wire form (Layout — Stump).
>
> **What the gap cost, measured against `packages/types/dist` on 2026-08-17** — a like transaction
> with one karma input, one karma output, one signature and a `likeTarget`:
>
> | | Bytes | |
> |---|---|---|
> | ids and keys as **hex strings** | **124** | `BoxId`, `PostId` and the signature-map key are 64 ASCII characters each to carry 32 bytes |
> | CBOR **field names** | **81** | respelled in full in every transaction |
> | `boxType` as the string `'karma'` | **5** | this layout already defines a 1-byte tag |
> | payload | 192 | |
> | **`encodeTx` today** | **402** | + 32 for the `utxoTxIds` entry + 2 for the length prefix = **436 per like** |
>
> ✅ **MEASURED AGAINST THE IMPLEMENTATION, 2026-08-17:** the layout above costs **236 bytes per
> like** including the `utxoTxIds` entry and the length prefix, against **436** for `cbor-x` — an
> **85%** gain, or **8,474 likes per 2 MB body** against 4,587.
>
> ⚠ **A hand-derivation from this table said 226 and 93%, and it was optimistic by 4%.** The estimate
> is superseded, not merely refined; quote the measured figure. ⛔ **The direction of the error is the
> lesson**: a layout read off a table omits what an implementation cannot — so treat any
> hand-derived encoding size as a **lower bound on cost**, never as a budget.
>
> ### ⛔ TWO CHANGES RIDE HERE AND THEY BREAK DIFFERENT THINGS — DO NOT CONFLATE THEM
>
> | Change | Breaks |
> |---|---|
> | `encodeTx` cbor-x → the layout above | **The wire only.** `computeTxId` is already positional and `computeUtxoTxRoot`'s leaves are **ids**, so every box id, transaction id, `utxoTxRoot` and `stateRoot` is byte-identical across it |
> | dropping `preimages` from `txIdBytes` | **Consensus.** It is inside the id preimage, so **every `TxId` in existence changes** |
>
> ⚠ **The first is reversible against history and the second is not.** They land in one dispatch
> because they touch one file, **not because they are one kind of change.**
>
> ✅ **`preimages` has no consumer** — no transition requires knowledge of a secret, so nothing reads
> the map. It is encoded, validated for envelope shape, and never consulted.
>
> ✅ **New box types need no change here.** `arr(outputs, boxContentBytes)` reaches them through
> `boxContentBytes`, so the like accrual marker and the vouch escrow cost this layout one tag each
> and nothing else.

### Layout — Block

| # | Field | Encoding |
|---|---|---|
| 1 | `protocolVersion` | `vlqU` — **first, so it is readable before any version dispatch** |
| 2 | `height` | `vlqU` |
| 3 | `prevBlockHash` | `b32` |
| 4 | `utxoTxRoot` | `b32` |
| 5 | `stateRoot` | **`b33`** — the AVL+ digest is 33 bytes, not 32 |
| 6 | `validatorId` | `b32` |
| 7 | `powNonce` | `vlqU` |
| 8 | `powTargetBits` | `vlqU` |
| 9 | `createdAt` | `vlqU` |
| 10 | `interlinkRoot` | `b32` — the interlink vector's commitment (→ Interlink vector); **last, so no earlier field's number depends on it** |

⛔ **Ten fields, and a positional layout with no keys — removing a field is never a
deletion in place; it renumbers everything after it.** (`subBlockRoot`'s removal renumbered
`utxoTxRoot` through `createdAt`: a reader keeping the old offsets decodes `stateRoot` out
of `utxoTxRoot`'s bytes and every later field one slot late — a silent wrong `blockHash`,
not a decode error.) **The count and the numbering must move together in this table, in the
BlockHeader definition above, and in the codec.**

**⚠ This table was wrong in both directions, and the second correction was itself reversed.** Read
all three notes together — the method lesson in the middle one is the durable part and it survives
its own example being withdrawn.

**`extensionDigest` is removed.** It was C11's committed extension-section seam, and it committed to
nothing: no section layout, no digest preimage, no value for an honest block with no extension, and
no validation rule — anywhere. The `OrderingBlock` framing below has no extension section for the
header to commit to. Its stated justification was that NiPoPoW interlinks must be committed from
genesis or retrofit is a hard fork, but an always-empty digest produces exactly the history a missing
field produces, so it captured nothing of that window. The shape it copied is also not what Ergo's
own verifier anchors to — `@ergots/nipopow`'s `checkInterlinksProof` verifies against an
interlinks-only root, explicitly *not* `header.extensionRoot`. **A field that commits to nothing is
the mirror image of `subBlockRefs`, deleted for being uncommitted.** C11 returns
to the P2-C register undone; re-derive it when there is a design to commit to. **Re-derived: field
10, `interlinkRoot`, commits to a vector every full node maintains and verifies (→ Interlink
vector) — the content `extensionDigest` lacked.**

**`networkType` was added 2026-08-09 and REJECTED 2026-08-10 — see the BlockHeader definition above
for why the field itself does not survive.** What follows is about how its *absence from this table*
went unnoticed, which is a separate finding and still stands.

Its absence was the `bond.inviteePublicKey` class again. The BlockHeader definition above listed it —
decided 2026-08-06, marked NOT IMPLEMENTED, and explicitly part of this break bundle — while this
table one section down omitted it. **Both sections said eleven fields**, so a count check passed
straight over a membership mismatch.

**The root cause is a gate that was right and one-directional.** Phase 0's plan required every layout
table to be cross-checked against `types/src` and said *"no table may be written from
`TYPES_INTERFACE.md` alone"* — sound, and for a real reason: a bullet drafted from a contract is a
hypothesis until the producers are grepped, which is the field-type unit's lesson and the same one
that later corrected `karma.proofSource`. But the gate said nothing about the opposite direction, and
a field the contract has **decided** while the code has **not yet implemented** it is invisible to a
code-first draft *by construction*. `networkType` is the only such field in the header; it was
dropped that way and rode the draft into committed contract text.

**Both directions are now required** (plan, Phase 0 gate): draft from `types/src`, then diff the
finished table against the contract's own type definition, and resolve every field present in one and
absent from the other explicitly — addition, deletion, or stated deferral. Neither artifact is the
authority alone.

⚠ **Every remaining header row is either a throwing writer or total-by-sentinel, and the
throwing-writer obligation is now larger in proportion, not smaller.** The withdrawn `networkType`
row was the header's only `enum8` — a **total** writer whose presence was explicitly argued to add
nothing to that obligation. Removing it removes the one row that was already discharged. What is left
is **five throwing rows and five `vlqU`** — but ⚠ **`b32` is TWO different writers and this note
first grouped them as one, which is the `bond.inviteePublicKey` failure committed inside the note
warning about it:**

| Rows | In-memory type | Writer |
|---|---|---|
| `prevBlockHash`, `utxoTxRoot`, `interlinkRoot` | `string` (hex) | `writeHexNOrThrow(…, 32)` |
| **`validatorId`** | **`Uint8Array`** (`UserId`) | **`writeBytesNOrThrow(…, 32)`** |
| `stateRoot` | `string` (hex) | `writeHexNOrThrow(…, 33)` |

**`validatorId` written off its table-neighbours throws on EVERY block.** **`b32` in a
layout table names a width, not an input type.** Found by the 3b executor, 2026-08-10.

The five `vlqU` rows are total *by sentinel* and therefore **collide rather than throw** —
the reason a panic-shaped search is not sufficient here.

`blockHash` = `blake2b512(headerBytes)[0..32]`; `computePowHash` is the same with `powNonce = 0`.

**UtxoTxTree:** `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)`

> ⚠ The normative statement is §Ordering block; **this is a restatement, and a
> restatement is what decays while the thing it restates stays right.**
**OrderingBlock:** `lp(header)` ‖ `lp(utxoTxTree)` ‖ `b64(validatorSignature)`

The ordering-block framing replaces `u32BE` length prefixes with `vlqU`. The boundary check runs at
the outer level and at each nested `lp` section.

### Layout — Merkle leaf preimages are the struct's own wire bytes

**Decided 2026-08-10, ahead of Phase 4.** `utxoTxRoot` commits leaves whose preimages are exactly
the committed struct's own wire bytes, and this package is the one place that says what those bytes
are.

| Export | Signature | Bytes |
|---|---|---|
| `pruneFieldBytes` | `(PruneCommit) => Uint8Array` | see Layout — PruneCommit |

`txIdBytes` **delegates** to it rather than restating the layout, so the transaction id and any
reader of the payload cannot drift apart.

> ⚠ **A stale EXPORT row is worse than stale prose:** a reader following `src/index.ts`'s
> pointer here finds signatures to call, not claims to judge. **Prose invites judgement; a
> signature invites a call.** (§How a dispatch decays this contract, below.)

> ⚠ **`parentRefs` carries 0–`MAX_PARENT_REFS` (currently 1) entries at validation; the writer is
> uncapped by design.** The domain sits upstream of the encoder (spec §2.5), never inside it —
> `arr(parentRefs, b32)` writes whatever length it is handed. **So a golden vector may legitimately
> encode a count above the cap, and must say so in its note.** The corpus pins the *encodable*
> domain, not the consensus-valid one, and already carries deliberately out-of-domain vectors for
> exactly this reason.
>
> `test/golden/README.md` carries the same sentence, so the two cannot drift.

**The rule the section states:** *an entry's wire form and its committed form must be the same
bytes; two statements of one layout is the drift class this format exists to close.* A `'utxotx'`
leaf's preimage is
`leafHash('utxotx', id)` — **the id, never the transaction encoding**, the same 32 bytes the
body's `utxoTxIds` entry carries — which is what keeps `utxoTxRoot` byte-identical across
wire-codec changes (`serialization.ts` states the pair beside the codec). The alternative —
`node` writing its own `ByteWriter` calls in `block-creator.ts` — puts a second statement of a
layout in a second package, with **no compiler signal on divergence and no round-trip able to see
it**: a consistent transposition round-trips perfectly (Phase 5 measured this), so only a golden
comparing the two byte strings across the package boundary would ever catch it.

⚠ **The `leafHash` domain tag stays outside the preimage.** `leafHash('prune' | 'utxotx', bytes)`
supplies the tag; the preimage is the entry's own bytes alone. That is what makes the prune leaf's
wire form and preimage byte-identical rather than merely parallel.

⚠ **No `...FromBytes` pair is added, and that does not breach the pairing rule under Layout —
Boxes.** What that rule forbids is one layout whose writer and reader live in **different packages**
and are free to drift — the `boxRecordBytes` / node-`deserializeBox` split. `pruneFieldBytes`
and the reader that recovers a `PruneCommit` from `txIdBytes` both live in this package, and the
transaction round-trip exercises the pair. Nothing crosses a package boundary unpaired.

### Re-pinning a frozen vector when a preimage changes

⛔ **A CHANGE THAT MOVES A FROZEN ID DESTROYS THE EVIDENCE THAT USUALLY GUARDS IT, AND THE OBVIOUS
SUBSTITUTE PROVES NOTHING.** When a field leaves an id preimage, every frozen id must move — so
*"unchanged text"* stops being available, and the reflex is to regenerate the pin from the encoder.
**A pin regenerated from the code it pins holds equally over a transposed layout.** That is the same
failure this section already names one paragraph up: a consistent transposition round-trips
perfectly, so nothing internal to the writer can see it.

**The method that works, in order:**

1. **Hand-assemble the preimage** from the layout table in this contract, using the corpus's frozen
   byte **literals** — not values the encoder produces.
2. ⛔ **VALIDATE THE MIRROR AGAINST THE OLD FROZEN VALUE FIRST.** Reproduce the *previous* id by
   restoring the removed bytes. A hand-derivation that cannot reproduce the known-good output is
   wrong, and this is the only step that can tell you so **before** you trust it.
3. Only then take the new id from the validated mirror.
4. ⛔ **Keep step 2 as a test.** A derivation described in a commit message is a claim; a derivation
   in the tree is auditable. Without it the next reader cannot distinguish this method from the
   regeneration it replaces — **the two produce identical-looking diffs.**

> ✅ **Worked, 2026-08-17, removing `preimages` from `txIdBytes`.** `writeOpt` emits `writeU8(0)` for
> an absent value — **one byte, never zero-width** — so every `TxId` moved with **zero survivors**,
> and a surviving id would have meant the field was not in the preimage this contract says it is.
> **The survivor count is itself a check** and costs nothing to state.

⛔ **A VECTOR BUILDING AN ID FROM A LITERAL `txId` STAYS GREEN WHILE CLAIMING FALSE PROVENANCE.** The
corpus constructs its frozen box ids from a **literal** `txId` string rather than a derived one, so
they do **not** move when a transaction's id moves. Left alone they keep passing while asserting
provenance from a transaction whose id has changed — internally consistent, externally false, and
**invisible to every gate**. ⚠ **When a `TxId` moves, every literal copy of it moves with it**, and
the occurrence count belongs in the diff.

#### ⛔ A MIRROR TEST'S GOLDEN MUST BE PINNED TO THE AUTHORITY, NEVER TO THE MIRROR

**A mirror test asserts that a second implementation agrees with this package.** If its frozen
constant is taken from the **mirror**, the test asserts the mirror agrees with itself, and **both
sides drift together while it stays green.**

> ⚠ **Measured 2026-08-18.** `node`'s UI-mirror golden held `0d72f282…` — the value the demo UI's
> `computeTxId` produces, which still carries the retired `preimages` clause — while
> `@dagsocial/types` had moved to `14cea374…`. **The fixture and its subject were stale in the same
> direction**, so the constant could not see the divergence it existed to catch.
>
> ⛔ **TWO TEST STYLES IN ONE FILE HAD OPPOSITE VISIBILITY.** The **live-comparison** cases — run
> both implementations, compare outputs — saw the drift immediately. The **frozen-constant** cases
> could not see it at all. ⚠ **The frozen constant is the one that reads as authoritative**, which is
> why the file's own note could say no test caught it while a test in that same file did.

**The rule: a mirror's golden is derived from the package under contract, and the mirror is never
consulted to produce it.** A mirror that disagrees is the finding; a mirror that agrees with a
constant taken from itself is not evidence of anything.

#### ⛔ A RETIRED SHAPE THAT IS AN ASSERTION'S SUBJECT IS NOT NARRATION

**"Never narrate replaced code" forbids describing a retired shape as CONTEXT. It does not forbid
using one as an OPERAND**, and read literally it would delete the strongest kind of fixture this
format has.

✅ **The test is one question: delete the sentence, and does an ASSERTION lose an input, or does a
paragraph lose a sentence?** A hand-written vector for a retired layout is the input that makes a
delta claim checkable — the assertion says *this change moves exactly these bytes and no others*,
and the retired vector is the only thing the current encoder **cannot** produce. Removing its
explanation leaves a magic constant nobody can re-derive.

⚠ **A retired shape mentioned to explain how things used to work is narration and goes.** The same
words can be either, and the difference is whether an assertion consumes them.

#### ⚠ A regenerated pin's INPUT is unchecked, so state it

Step 2 above validates the **derivation**. It does not validate what was fed into it. ⛔ **A pin
regenerated from the correct code and the wrong input is byte-perfect and wrong**, and the mirror
check passes because the mirror is fine.

> ⚠ **Measured in the same pass.** A sentinel id was regenerated from index `2**32` — a value the
> test's own prose names as **valid**, not as the sentinel. Nothing mechanical caught it; **the
> surviving comment beside the constant did.**

**So a regenerated pin says what produced it** — which input, and why that input and not a
neighbouring one. A constant with no stated input cannot be re-checked without redoing the analysis
that produced it, which is the analysis nobody repeats.

Naming follows the positional format's `...Bytes` family (`txIdBytes`, `boxContentBytes`,
`boxRecordBytes`), which `pruneFieldBytes` follows.

**The delegation is byte-identical by construction** — same writers, same order — so it is not
itself a consensus change. The consensus change is node's: the leaf preimage stops being JSON.

### Sizing without encoding

`utxoTxTreeByteLength(t)` returns the byte length `encodeUtxoTxTree(t)` produces, computed from the
structure and allocating nothing. It is the measure `MAX_BLOCK_BODY_BYTES` is checked against.

**It is arithmetic rather than a call to the encoder because both consumers are on paths where
allocating the body is the wrong cost.** `verifyOrderingBlockStructure` runs on the gossip relay path
and would allocate a whole body per arriving block; node's block creator needs a per-entry delta while
filling, and re-encoding the candidate after each addition is quadratic. The terms are all knowable:
the tree is `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)`,
and `utxoTxs` are opaque byte arrays, so nothing here depends on the transaction codec.

⛔ **The equivalence is the contract, not an implementation detail** — a test pins
`utxoTxTreeByteLength(t) === encodeUtxoTxTree(t).length`. Two ways of computing one number diverge
silently otherwise, and the direction that matters is the one where the sizer under-reports: a block
that measures legal here and encodes larger is a block this node relays and its peers reject.

**Its domain is the encoder's success domain, and that domain includes the sentinel branches.**
`writeArr` and `writeLp` are total by sentinel (`### Totality`) — handed a non-array section or a
non-byte-view element they write a sentinel prefix and continue — so those trees *do* encode, do have
a length, and are owed equality. **They are also the only inputs on which under-reporting is
possible**, because a sizer that reads such a field at face value sees a smaller number than the
sentinel the encoder writes. Where a field reaches a *throwing* writer instead, the tree has no
encoding at all: there is no length to agree on, and the sizer does not mirror the throw — mirroring
would buy symmetry and hand every caller a panic source, including the one on the relay path.

⚠ **The empty tree is not the interesting case and should not be cited as one.** It is four `vlqU(0)`
counts, so a sizer that assumes every count prefix is one byte wide passes it. The cases that
discriminate are the VLQ width boundaries and the sentinel branches above.

### Export table

> ✅ **RESOLVED — the code has moved. Verified 2026-08-11.** This read `AHEAD OF CODE` until
> Phase 9 and ended *"the rows are left describing CBOR until the code moves."* The signatures
> are indeed unchanged — every `encodeX`/`decodeX` kept its name and type — and what changed is
> the bytes they produce and the guarantees they carry: the positional layout above, plus the
> four-step boundary check on every `decodeX`.
>
> Nothing in this package encodes CBOR. Every row below describes the positional codec it names;
> `Stump` has no codec and no row — a stump has no wire form (Layout — Stump).

`serializeBox` was removed here by Spec G phase 0. No `src` caller existed — box serialization
goes through node's tagged `state/serialize-box.ts` (AVL values) or the identity encoder in
`utxo.ts` (ids) — but **two test files did call it, and it was the wrong encoder for what they
asserted**: `serialization.ts` used cbor-x's default `encode`, not the configured `hashEncoder`
that computes identity, so the P0 golden test pinning the `0x1b` uint64 value form was pinning
bytes no production path produces. Those assertions were re-pointed at the identity encoder,
which is now exported as `canonicalBoxBytes` — see "Canonical encoding" under BoxId.

| Export | Signature | Description |
|--------|-----------|-------------|
| ~~`serializeTx(tx)`~~ | — | ⚠ **DELETED (G3b) — and the description was never true.** It was built on cbor-x's default `encode`, which is neither of the two encoders that matter, so its bytes were consumed by no identity path. Transaction identity comes from `computeTxId`. Doubly wrong: the function is gone *and* "canonical CBOR encode for tx identity" never described it |
| `encodePostCommit(commit)` | `(PostCommit) => Uint8Array` | Positional — see Layout — PostCommit |
| `decodePostCommit(bytes)` | `(Uint8Array) => PostCommit` | Inverse of `encodePostCommit` |
| `encodePostBody(content)` | `(string) => Uint8Array` | `lpUtf8(content)` — see Layout — Post body. |
| `decodePostBody(bytes)` | `(Uint8Array) => string` | Inverse of `encodePostBody` |
| `encodeTxPacket(tx, content?)` | `(UtxoTransaction, string?) => Uint8Array` | `encodeTx(tx)` ‖ `opt(lpUtf8(content))` — the gossip payload; see Layout — UtxoTransaction, the packet codec. |
| `decodeTxPacket(bytes)` | `(Uint8Array) => { tx: UtxoTransaction; content?: string }` | Inverse of `encodeTxPacket` |
| `encodeHeader(h)` | `(BlockHeader) => Uint8Array` | Positional — the input to `blockHash` / `computePowHash`. See Layout — Block |
| `decodeHeader(bytes)` | `(Uint8Array) => BlockHeader` | Inverse of `encodeHeader` |
| `encodeInterlinks(v)` | `(string[]) => Uint8Array` | `vlqU(n)` ‖ `b32 × n`, `n ≤ MAX_INTERLINKS` — the vector's one form: wire, store, and the preimage of `interlinkRoot`. See Interlink vector |
| `decodeInterlinks(bytes)` | `(Uint8Array) => string[]` | Inverse of `encodeInterlinks`; the count is refused before the first element |
| `interlinkRoot(v)` | `(string[]) => string` | `hex(blake2b512(INTERLINK_DOMAIN ‖ encodeInterlinks(v))[:32])` — header field 10. See Interlink vector |
| `updateInterlinks(prev, prevHash, prevLevel)` | `(string[], string, number) => string[]` | The vector the block after `prev`'s block commits to. See Interlink vector |
| `encodeUtxoTxTree(t)` | `(UtxoTxTree) => Uint8Array` | Positional (body section) — see Layout — Block |
| `decodeUtxoTxTree(bytes)` | `(Uint8Array) => UtxoTxTree` | Inverse of `encodeUtxoTxTree` |
| `utxoTxTreeByteLength(t)` | `(UtxoTxTree) => number` | The body's encoded length, computed from the structure without encoding it. Equal to `encodeUtxoTxTree(t).length` by pinned test — see Sizing without encoding |
| `encodeOrderingBlock(b)` | `(OrderingBlock) => Uint8Array` | Positional wire framing: `lp(header)` ‖ `lp(utxoTxTree)` ‖ `b64(validatorSignature)` — see Layout — Block |
| `decodeOrderingBlock(bytes)` | `(Uint8Array) => OrderingBlock` | Inverse of `encodeOrderingBlock` |
| `encodeTx(tx)` | `(UtxoTransaction) => Uint8Array` | **Positional** — `txIdBytes` ‖ `arr(signatures sorted)`. See Layout — UtxoTransaction |
| `decodeTx(bytes)` | `(Uint8Array) => UtxoTransaction` | Inverse of `encodeTx` |


### How a dispatch decays this contract, and why nothing catches it

⛔ **DECAY RUNS IN BOTH DIRECTIONS AND ONLY ONE OF THEM HAS AN OWNER.**

| Direction | Who caused it | Who can fix it |
|---|---|---|
| A contract edit falsifies a **comment** a dispatch wrote | the contract author | ✅ the executor — same package, same session |
| A dispatch deletes a symbol and falsifies a **contract row** | the executor | ⛔ **nobody in that session.** `contracts/` is outside their boundary |

**The second is structurally orphaned.** An executor may not edit `contracts/`, so the most they can
do is report it — and a report is read once, by one person, who is not editing this file at the time.
✅ **Both instances of this pair happened in one dispatch on 2026-08-17**, which is what makes the
asymmetry a measurement rather than a worry.

⛔ **THE TRIGGER IS DELETION OF AN EXPORTED SYMBOL, AND IT IS CHECKABLE.** After any dispatch that
removes one, grep `contracts/` for **every removed name** — not for the feature, not for the concept.
A name-keyed search is the wrong instrument for finding behaviour and the **right** one here, because
what rots is the name itself, spelled exactly.

⚠ **Reading the contract does not find these.** Four dead rows sat in two tables through a session
that edited this file five times, because a table row is read as inventory rather than as a claim.
**Grep the symbol; do not re-read the section.**

⛔ **THERE IS A SECOND TRIGGER AND DELETION-GREP CANNOT SEE IT: A DISPATCH THAT *IMPLEMENTS* WHAT A
MARKER DISCLAIMS.** Nothing is removed, so no name goes stale — the marker itself becomes the false
claim. `Layout — UtxoTransaction` carried `⚠ UNENFORCED — the code does not implement it` **dated the
same day the code implemented it**, and a comment in another package cited that section, so a reader
following the pointer landed on a banner contradicting the sentence that sent them.

✅ **This one IS greppable, and by an easier search than the first.** The marker vocabulary is closed
and stated at the top of `ARCHITECTURE.md` — `NOT IMPLEMENTED`, `PARTIAL`, `UNENFORCED`, `VIOLATED`,
`AHEAD OF CODE`. **After any dispatch, re-read every marker whose subject that dispatch touched.**

⚠ **The two triggers have opposite shapes and both are needed:** deletion strands a **name** while
the claim around it still reads true; implementation strands a **claim** while every name in it
still resolves. ⛔ **A marker is the one contract element whose whole purpose is to be falsified**,
and nothing in this repo watches for the moment it happens.

### A fifth, and the only one that is a PASSING ASSERTION: a defect WITNESS survives its own fix

⛔ **A test written to document a known defect asserts that the defect EXISTS. When the defect is
closed the test becomes false — and it stays GREEN**, because a witness usually drives the
primitives directly to demonstrate the raw behaviour, so the fix lands at a layer the test does not
reach.

> ⚠ **Measured 2026-08-18.** Three cases titled *"VIOLATION: a like burn destroys `LIKE_KARMA_COST`
> and names no sink"*, *"a bond forfeit ends karma and names no sink"*, *"an unvouch moves the stake
> to a sink no box names"*. **All three defects were closed; all three still passed**, because they
> call `insertBox`/`consumeBox` with no engine and no settlement between them. One even named the
> unit that would close it — *"until then this witness stands"* — and named a function that had been
> deleted.

⛔ **The titles are PRESENT TENSE and assert a live violation**, so no tense-word sweep reaches them
except by accident. **It is the inverse of every other rot in this file: it goes stale when the code
gets BETTER, and nothing about it looks wrong.**

✅ **Naming the closing unit is necessary and is not sufficient** — one of these did, and nothing
connected the unit landing to the witness. **So closing a unit includes grepping the test tree for
its own name.** A witness is a claim with an expiry, and it is the only kind whose expiry is an
improvement.

### A fourth: a PROSE RESTATEMENT decays while the assertion beside it stays green

⛔ **A fact with a test asserting it can still be wrong everywhere it is described.** The assertion
holds, the suite is green, and every prose copy rots independently — so **nothing ever fails**, and
the green suite is what supplies the false assurance.

> ⚠ **Measured 2026-08-18.** The genesis box set is asserted once —
> `['emission', 'genesis_proof', 'karma_pool']`, three boxes — and restated in prose **three** times,
> **each wrong, and each wrong differently**: *"the proof box alone"* (one), *"over TWO leaves"*
> (two), and *"seed FIVE leaves"* (five, for a set of six). ⛔ **They disagree with the assertion and
> with each other**, because each was written at a different time as the set grew, and none was
> re-read when it grew again.

⚠ **The count of wrong copies grows with the number of times the fact changed**, not with the number
of files — a fact that moved three times leaves three differently-stale restatements wherever it is
described.

✅ **The check is cheap and it is not a grep for staleness.** When a fact has an assertion, find the
prose that restates it and **compare each restatement to the assertion**. The assertion is the
authority; a restatement is a claim that has to earn agreement.

⛔ **AND A STALE COUNT RARELY TRAVELS ALONE.** One of these was reported to main, propagated into a
dispatch brief verbatim, and its **neighbour in the same sentence** was still wrong — because the
change that invalidated one invalidated the other. **When a comment is found stale in one number,
re-read every number in it.**

### A third failure is born wrong rather than decaying: an INVENTED prose name

⛔ **A citation of the form `FILE → prose name` can point at a heading that does not exist, while
every symbol in it resolves and the sentence around it is true.** Nothing decayed; the pointer was
never good. ⚠ **A plausible prose name reads exactly like a real one**, and no search over the
*claim* distinguishes them — the sentence is correct, so re-reading it finds nothing.

⚠ **Measured 2026-08-18:** one invented name reached **six files** in a single dispatch before its
author caught it, because it was written once and copied. **Invented pointers propagate at
copy-paste speed**, which the two decay classes do not.

✅ **This one is the cheapest of the three to check, and it is mechanical:** take every
`FILE → prose name` a diff **adds**, and grep the cited text **against the file**. A prefix of a real
name is fine — it still resolves — but text that matches nothing is a dangling pointer regardless of
how true the sentence is.

⛔ **GREP THE FILE, NOT ITS `#` HEADINGS**, and this correction comes from the check producing a
false positive on a correct citation. **These contracts name sections in two ways**: `#` headings,
and **bolded passages inside a blockquote** — `> **What the funnel's totality catch is FOR**` is a
real, unique, greppable section name with no `#` anywhere near it. ⚠ **A heading-only check reports
it as invented and invites someone to "fix" a pointer that resolves.** The test is whether the cited
text is **findable and unique in the file**, not what markup carries it.

⚠ **Re-check against `HEAD`, not against the contract as it stood when the citation was written.**
A section's line range moves when anything above it grows, so a citation can stay correct while the
rule it points at leaves the section — confirm the cited section still **contains** the claim, not
merely that the heading still exists.

---

## Base58 (`base58.ts`)

> ⚠ **No consumer anywhere in the repo, and the round-trip is broken for zero-valued input.**
> Nothing in node, net, validation, wire or the demo UI imports either function — the only
> references are the barrel export and its own test. Meanwhile `base58Encode(Uint8Array([0]))`
> → `"11"` and `base58Decode("11")` → `[0,0,0]`; a 32-byte zero buffer encodes to 33 `'1'`s
> and decodes to 34 bytes. Empty input is asymmetric too (`""` encodes from empty, decodes to
> one zero byte). Non-zero inputs, including those with leading zero bytes, round-trip fine —
> the defect is confined to buffers whose numeric value is zero, which the existing test does
> not cover.
>
> Inert today because nothing calls it. **It becomes real the moment base58 is adopted for
> what it exists for — rendering a key or an address — where an all-zero value is exactly
> the case a fuzzer reaches first.** Fix the round-trip before adopting, or delete the
> module.

| Export | Signature | Description |
|--------|-----------|-------------|
| `base58Encode(buf)` | `(Uint8Array) => string` | Bitcoin-style base58 (alphabet: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`) |
| `base58Decode(str)` | `(string) => Uint8Array` | Throws on invalid characters |

---

## Protocol Constants (`constants.ts`)

### Chain reorganisation

```typescript
export const MAX_REORG_DEPTH = 20;
```

How far back a reorg reaches. Universal, not per-network. Its load-bearing consumers are all in
`@dagsocial/node`: the fork-walk bound (`findForkPoint`), the header request size fork resolution
makes of the competing peer (`MAX_REORG_DEPTH · 2`), the block-journal retention window
(`purgeOldJournals`), the refused-headers purge bound (`purgeRefusedHeaders`, NODE_INTERFACE → Store
Interface → Refused headers), and the load-time refusal of a `MAX_PROOF_HISTORY` beneath it
(`config.ts`). **Journal retention is the hard bound on how deep a reorg can physically go; the
fork walk is policy**, and nothing requires the two to stay equal.

⚠ **`net`'s `msg-guards.ts` is not a consumer**, though it reads like one. It mentions
`MAX_REORG_DEPTH * 2` as *what fork resolution asks for*; the cap it actually enforces is
`MAX_CHAIN_RESPONSE_ITEMS = 400`. The two differ by 10×, and reading the prose as the limit
conflates a caller's request size with the bound applied to it.

**It lives here because node's `config.ts` cannot reach it anywhere else.**
`services/fork-resolution.ts` imports `config` itself, so a constant declared there is unreachable
from config load without a cycle. A load-time rule keyed on this value is only expressible with the
constant in this package.

### Genesis parent hash

```typescript
export const GENESIS_PREV_BLOCK_HASH = '00'.repeat(32);
```

The `prevBlockHash` a height-1 block carries: 32 zero bytes as 64 hex characters. Three consumers,
one meaning — the apply funnel's genesis branch compares a height-1 block's `prevBlockHash` against
it (NODE_INTERFACE → Ordering block apply-time authorization), the block creator writes it into a
height-1 template (MINING_INTERFACE → GET /mining/template), and fork resolution hands it to
`verifyHeaderChain` as the anchor for a fork at `GENESIS_HEIGHT` (NODE_INTERFACE → Fork choice
decides on verified headers). Heights start at 1, so no header is ever hashed to this value; it is a
sentinel by construction, not a digest. When the profile pins `genesisId` (→ Network profiles), a
height-1 block must also **hash to it** — the sentinel says what block 1 builds on, the pin says which
block 1 it is. ⚠ `store/mempool.ts`'s `PROBE_TX_ID` is the same bytes with
a different meaning and is **not** this constant.

### Network profiles

> ✅ **RESOLVED — the `NOT IMPLEMENTED` marker here was stale, corrected 2026-08-10,
> re-verified 2026-08-11.** It read "No profile type, table or selector exists"; all three do —
> `NetworkType`, `NETWORK_PROFILES` and `profileFor` in `types/src/network.ts` — and the node
> resolves the profile once at startup from `NETWORK_TYPE`, freezing it into `Config`: the
> `profileFor(process.env['NETWORK_TYPE'] ?? 'testnet')` call in `node/src/config.ts`, which is
> the resolution rule stated at the end of this section.
>
> ⚠ **The pin here read `node/src/config.ts:63`, which is now `bootstrapPeers`.** Named symbol
> replaces it. **The same stale pin is cited by carried register #12**, whose open item is that
> `types/src/network.ts` still calls the table "purely additive — nothing consumes it yet"
> while node's config does consume it. That item is real; its line number is not. **Types' file,
> so a types session's edit** — main records it here rather than reaching across.
> Consensus constants are no longer environment-readable either — `NODE_INTERFACE §Configuration`
> records P2-A removing all ten (PR #8, verified 2026-08-07). See `ARCHITECTURE §Network Identity`
> for the mechanism and the reasoning.

```typescript
export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface NetworkProfile {
  readonly networkType: NetworkType;
  readonly magic: number;              // wire frame magic — one per network

  // Difficulty
  readonly orderingBlockPowTargetBits: number;

  // Block-denominated durations
  readonly karmaDecayIntervalBlocks: number;
  readonly karmaStaleThresholdBlocks: number;
  readonly vouchCooldownBlocks: number;
  readonly inviteProbationBlocks: number;
  readonly creditMinerRewardDelay: number;

  // Emission schedule. `creditEmissionTotal` is the EmissionBox's genesis value and is
  // CARRIED, never derived (§EmissionBox); it must be STRICTLY below the curve's own sum
  // for this profile's F and E at the universal R and d.
  readonly creditFixedRateBlocks: number;
  readonly creditEpochBlocks: number;
  readonly creditEmissionTotal: bigint;

  // Storage rent — the PERIOD is per-network; the rate is a universal constant
  readonly storageRentPeriodBlocks: number;

  // Genesis
  readonly genesisCommitteeKeys: readonly string[];
  readonly genesisKarmaPerMember: bigint;
  readonly genesisProofPayload: string;   // hex — the GenesisProofBox payload, distinct per network
  readonly genesisStateRoot: string;      // hex, 66 chars — the pinned height-0 AVL+ root
  readonly genesisId: string;             // hex(32) or '' — the pinned height-1 block hash; '' = unpinned
}

export const NETWORK_PROFILES: Readonly<Record<NetworkType, NetworkProfile>>;
export function profileFor(network: NetworkType): NetworkProfile;

// The network magics live here, not in @dagsocial/wire — see below
export const MAGIC_MAINNET = 0x4D444147;  // "MDAG"
export const MAGIC_TESTNET = 0x54444147;  // "TDAG"
export const MAGIC_DEVNET  = 0x44444147;  // "DDAG"
/** The canonical set. `net` must derive its frame-magic check from this, never a local literal. */
export const KNOWN_FRAME_MAGICS: readonly number[];
```

**This is the sole definition of the network magics.** `@dagsocial/wire` exported duplicates
until P2-A phase 5 deleted them. They live here rather than `NetworkType` living in wire
because **wire has zero runtime dependencies and keeps them**: `@dagsocial/types` cannot
import from wire, and wire must not import from types. Wire's `encodeFrame` / `decodeFrame`
take `magic` as a parameter and read no magic constant — the codec is magic-agnostic by
construction and does not own network identity.

⚠ **`KNOWN_FRAME_MAGICS` must be imported, never re-declared.** `net/src/node.ts` held it as
a local literal until phase 3a. A magic missing from the set is classified as `not-a-frame`
instead of `wrong-magic` — both are frame-tier rejects (stream closed, no penalty,
NET_INTERFACE → "Ban policy"), so a stale copy costs the classification, not a ban: a routine
cross-network misconnection stops being recognisable as one. Note the set is consulted *only*
for frames that fail the own-magic compare, so a stale copy does not break same-network
peering; the damage is entirely cross-network.

**`genesisProofPayload` is hex `string`, not `Uint8Array`, and the reason is immutability rather
than style.** Every profile is an `Object.freeze`d literal, and freezing does not reach a typed
array's contents — a profile holding one would be mutable in exactly the field that defines the
network. `genesisStateRoot` and `genesisCommitteeKeys` are hex for the same reason, so this follows
the file rather than adding a convention.

**What must hold is that the three payloads DIFFER; what is inside them need not be anything.**
They are mock content (user, 2026-08-13). Substituting real no-premine evidence later is a value
change on a network that has not launched, not a format change — and it is caught loudly either way,
since the payload moves the genesis state root. This is a fourth entry in the per-network set, whose
burden §Network Identity puts on the addition; it is discharged by genesis already being a declared
per-network axis rather than a new one.

**`genesisStateRoot` is 66 hex characters, not 64.** The AVL+ digest is a 32-byte root label followed
by a one-byte tree height — Ergo's 33-byte `genesisStateDigestHex` shape, and the same width
`EMPTY_STATE_ROOT` and the block header's `stateRoot` already carry. A 64-character pin fails on all
three values, and truncating one to fit silently discards the height byte.

**It is derived, not chosen.** The value is the digest a node computes after seeding its genesis box
set, and `genesisProofPayload` is the only input to it that differs per network — the system karma
and faucet credit boxes are byte-identical everywhere they are seeded at all. So the two fields are
one fact stated twice, and a pin that disagrees with the seeding is a node running a chain that forks
from every honest peer at height 1. `NODE_INTERFACE` owns the comparison; this package can only hold
the constant, since neither the serializer nor the prover that produce it live here.

⚠ **Re-pin whenever anything a genesis box id derives from moves.** These are digests over box ids,
so a change to the box encoding moves them with nothing here changing — the mismatch surfaces at
node's boot check rather than in this file.

**Both fields belong to the two networks' spread, not to mainnet alone.** `TESTNET_PROFILE` is
`{ ...MAINNET_PROFILE, … }`, so a value written only into mainnet is inherited silently by testnet
with no type error, collapsing the one field whose whole job is keeping the networks apart. Each is
overridden explicitly and `network.test.ts` asserts the override rather than the spread.

**`genesisId` pins block 1, and is empty until a network has one.** Hex(32) of the height-1 block's
`blockHash`, or `''`. When set, the height-1 chain-link refuses any other block 1 (`NODE_INTERFACE` →
Ordering block apply-time authorization, genesis pin) and a NiPoPoW proof must anchor on it
(→ Interlink vector). Devnet is always `''` — every run mines its own block 1. Testnet and mainnet are
`''` until their block 1 exists and are pinned in the release after: a value, not a format, so
pinning it moves no bytes. Field-only and per-network like the other genesis fields; `network.test.ts`
asserts each profile's own value rather than the spread.

**Every constant not listed in `NetworkProfile` is universal across networks**, including
consensus ones — the format limits (`MAX_CONTENT_BYTES`, `MAX_PARENT_REFS`,
`PROTOCOL_VERSION`, `AVL_KEY_LENGTH`) and every karma and credit cost. The split is
normative and stated in `ARCHITECTURE §Network Identity`: **compress time, never
economics.** A constant moved into `NetworkProfile` is a place devnet may behave unlike
mainnet, which is where a defect hides from the test meant to catch it.

The profile is resolved **once at startup** from `NETWORK_TYPE` and frozen. Nothing
downstream re-reads the environment, and no function takes a profile override argument —
an override parameter is the same defect as the environment read, reached by a different
door.

⚠ **Values are not pinned here.** This contract states the rules the numbers serve; which
numbers are ruled, derived, provisional or merely chosen is the register's to say —
`CONSTANTS → Per-network values` for the three profiles, `CONSTANTS → Universal constants` for
the rest. **Do not read any number in this contract as decided** — with one exception, stated
here because this is where it is cited from: `KARMA_STALE_THRESHOLD_BLOCKS`'s duration is ruled
(user, 2026-08-19): **28 days**, 40320 at the nominal 60-second block.

### Domain tags are network-agnostic — deliberately

The six derivation domain tags — `BOX_ID_DOMAIN`, `TX_ID_DOMAIN`, `MINT_ID_DOMAIN`,
`IDENTITY_KEY_DOMAIN`, `POST_ID_DOMAIN`, `POST_CONTENT_DOMAIN` — **do
not carry the network, and must not be changed to.** No derivation function takes a network argument, and this package holds no
module-level network state.

This was proposed and **rejected on 2026-08-06**. Recorded here because the proposal is
attractive and will recur:

- **It breaks this contract's own Postcondition** — *"All functions are pure — no side
  effects, no module-level state"* — and its `computeBoxId` one-argument invariant. Five
  packages derive consensus bytes from these functions; a module-level network resolved at
  import time is the config-read-at-a-distance defect that `ARCHITECTURE §Network Identity`
  exists to remove.
- **The motivating analogy was false.** It was argued as the equivalent of Ergo's address
  prefix. An address prefix is a *serialization* concern, and **Ergo's own box and
  transaction ids are network-agnostic content hashes.** Scoping derivation would exceed
  Ergo, not match it.
- **It buys little.** Cross-network transaction replay is already impossible: input box id
  chains root at a genesis that differs per network, so a foreign transaction names inputs
  that do not exist. The only gap left open is cross-network **post** replay, accepted as a
  spam vector rather than a value defect.

Network separation lives in **genesis and the wire magic** — two layers, not three. The proposed
header `networkType` field was rejected 2026-08-10 (see the Block header section above). See
`ARCHITECTURE §Network Identity → How the network is committed`.

### Denomination (P0 — Spec B)

Constants split by kind: **amount** constants are `bigint`; **count / block /
threshold / percentage / bits** constants stay `number`.
- **Credit amounts → `bigint`, rescaled ×10⁸** (base units of 10⁻⁸ credit):
  `CREDIT_INITIAL_REWARD`, `CREDIT_REWARD_REDUCTION`, and the node/UI faucet credit amounts.
- **Karma amounts → `bigint` literals, NOT rescaled** (karma is indivisible):
  `KARMA_POSTING_MINIMUM`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM`,
  `POST_PRICE_THREAD`, `POST_PRICE_REPLY`, `REPLY_AUTHOR_SHARE`, `LIKE_KARMA_COST`,
  `INVITE_MIN_KARMA`, `INVITE_BOND_MIN`, `INVITE_BOND_MAX`,
  `VOUCH_KARMA_AMOUNT`, `VOUCH_MIN_BALANCE`,
  `GENESIS_KARMA_PER_MEMBER`.
- **Stay `number`:** all `*_BLOCKS`, `*_TARGET_BITS`/`*_FLOOR`,
  `LIKES_PER_KARMA_PAYOUT` (a count), `MAX_*`,
  `CREDIT_MINER_REWARD_DELAY` (a block count, NOT an amount), and every coinbase
  percentage — `COINBASE_TREASURY_PCT`, `COINBASE_MINER_FLOOR_PCT`,
  `COINBASE_BACKER_PCT`, `COINBASE_BONUS_PCT`, `MEMPOOL_CREDIT_SHARE_PCT`.
  **`INCLUSION_BONUS_K` is the exception and is `bigint`**: it is a denominator in
  the bonus curve, which computes in base units. The exhaustive per-constant classification rides in the dispatch prompt.

### Version

```typescript
export const PROTOCOL_VERSION = 1;
```

### Content limits

```typescript
export const MAX_CONTENT_BYTES = 300;
export const MAX_PARENT_REFS = 1;
export const MAX_GENESIS_PROOF_PAYLOAD_BYTES = 512;
```

The third bounds a **box** field rather than a post one, and it sits here because this section groups
bounds by what kind of rule they are — a maximum byte length enforced at a codec boundary — not by
which structure carries them. The `### Genesis` block below holds the genesis *economics*, none of
which is a format bound.

⚠ **512 is provisional and derived from no measurement** — roughly Ergo's five-register no-premine
payload plus headroom. Its *home* is not provisional. The three profile payloads are ~35 bytes, so
nothing approaches it; `network.test.ts` is what checks them, because they are compile-time constants
and the seeder that writes one deliberately does not measure it.

### Size caps

```typescript
export const MAX_BLOCK_BODY_BYTES = 2_000_000;   // consensus — encoded UtxoTxTree
export const MAX_TX_BYTES = 10_000;              // consensus — encoded UtxoTransaction; every body element but the last
export const MAX_SETTLEMENT_BYTES = 100_000;     // consensus — the encoded settlement transaction, the body's last element
```

Consensus bounds on **weight**, checked in `@dagsocial/validation` — the body by
`verifyOrderingBlockStructure`; a user transaction by `verifyTxStructure` on the relay path and
again per body element; **the settlement transaction by `MAX_SETTLEMENT_BYTES`**, positional
identity naming it as the last element — so an oversized object is refused before relay rather than
after storage. Distinct in kind from `### Content limits` above, which are format bounds a codec
enforces on one field; these bound whole structures and no codec consults them.

**The settlement has its own bound because it is derived.** `MAX_TX_BYTES` exists so a transaction
cannot be valid, poolable and unminable at once (below); a settlement is never pooled, and its size
is a function of the body and of chain state — one 32-byte input per like marker, per fee box, per
settling bond, per releasable escrow, per price box; one karma output per paid author or
owner (measured: 70 bytes with the four protocol outputs and nothing else, +32 per input, +38 per
karma output). **The settlement, not the encoding, sets the per-block ceiling on likes**: the bound
divided by the marker input's 32 bytes, less what the block's other legs take.

**Two relations are the rule; the numbers are provisional** (`CONSTANTS → Size caps`).

| Relation | What it guarantees |
|---|---|
| `MAX_SETTLEMENT_BYTES` + its framing < `MAX_BLOCK_BODY_BYTES` | availability — a legal settlement fits a legal body |
| an **empty-body** settlement with every state-driven leg at its cap (→ Settlement caps) encodes ≤ `MAX_SETTLEMENT_BYTES` | **liveness** — a valid block exists at every height, whatever the chain state holds |

The second is pinned by a test that **builds** that settlement through the node's own derivation and
encodes it — never by a hand-derived sum, which is a lower bound on cost, not a budget (→ Layout —
UtxoTransaction). The producer keeps every body-driven leg inside the bound by selection
(`MEMPOOL_INTERFACE` → The fill budget is bytes; `getPendingEntries` is a count); the caps keep the
state-driven legs inside it whatever the producer selects.

**The block bound is what makes validity and availability agree.** Three limits stand in a fixed
order, and the *relation* is the rule rather than any individual number:

```
MAX_BLOCK_BODY_BYTES (2,000,000)  <  MAX_SERVE_BODY_BYTES (4 MiB)  <  MAX_STREAM_BYTES (8 MiB)
```

The upper two are net's (`NET_INTERFACE` → Validation (and untrusted-input safety)). A single legal
block always fits in a
response the requester will accept, and a multi-block response truncates rather than overflowing.
Invert any pair and a block becomes valid but unservable — accepted by consensus, unreachable by a
peer syncing from history.

⛔ **Both are denominated in bytes, and neither is retuned when the transaction encoding changes.**
`### Layout — UtxoTransaction` specifies a positional form the codec does not implement; under it a
max-size post transaction is 639 bytes rather than 953 (measured 2026-08-15), so the same 2,000,000
carries about 47 % more posts. That is a bound on the resource behaving as intended — capacity
improves and the storage guarantee does not move. A transaction *count* would have had to be revised;
this does not.

`MAX_BLOCK_BODY_BYTES` is 1.05 TB/yr of archival growth at 60 s blocks, or about 2,026 max-size post
transactions per block. **A transaction costs `32 + vlqU(len) + len` in the body** — the fixed-width
`utxoTxIds` entry plus the `lp` prefix `arr(utxoTxs, lp)` writes before each one, so 34 bytes of
framing at present transaction sizes, not 32. `MAX_TX_BYTES` admits roughly 148 credit inputs at the current encoding and
288 under the positional one — far past any single consolidation a wallet builds. Its job is to keep
a transaction from being valid, poolable and unminable at once: without it, one larger than the block
budget occupies a mempool slot that no block can ever drain.

### Settlement caps

```typescript
export const MAX_BOND_SETTLEMENTS_PER_BLOCK = 64;     // consensus — bonds settled per block, at or past their deadline
export const MAX_ESCROW_RETURNS_PER_BLOCK = 64;       // consensus — vouch escrows returned per block, at or past release
```

**A settlement leg the body does not drive is capped, and carries forward.** Two legs read chain
state rather than the block's transactions — bonds whose probation has ended and escrows whose
cooldown has ended — so no producer can trim them by selecting a smaller body. Each consumes at
most its cap per block, in a total order, and leaves the rest for the next block; a candidate is
eligible **at or past** its height, never only at it, so nothing is skipped by waiting
(`NODE_INTERFACE` → The settlement transaction). The two caps are what make the liveness relation
under → Size caps a constant rather than a hope: their sum, at the measured per-item cost, is the
largest settlement an empty body can carry.

**Bounded delay, stated.** Under a backlog of `n` candidates a leg drains in ⌈`n` / cap⌉ blocks; a
bond may vest more in the meantime (`ARCHITECTURE` → Bond outcomes), a cooling voucher waits that
long to recast (`ARCHITECTURE` → Vouch boxes). Neither moves value it does not owe.

> ⚠ **AHEAD OF CODE — 2026-08-29.** `constants.ts` exports `MAX_POST_LOCK_RELEASES_PER_BLOCK` and the
> settlement carries the release leg it caps; PR A retires both.

### State format

```typescript
export const AVL_KEY_LENGTH = 32;   // bytes
```

The AVL+ tree's key width. It **sets the shape of every `stateRoot`**
(`packages/node/src/state/avl-prover.ts`), so two nodes holding different values compute
different digests for identical state — which makes it a consensus constant, not a tuning
knob. It is universal rather than per-network: a network has no reason to differ on a
format width, so it does **not** belong in `NetworkProfile`.

`packages/node/src/config.ts` imports it and plumbs it through `Config.avlKeyLength`, which
`state/avl-prover.ts` reads. That plumbing field is permitted, but its value originates here —
`node/test/config.test.ts` §8 compares the plumbed field against this export, which goes red if
node ever regrows a divergent local definition. A value pin alone cannot catch that: if this
constant moves while a stale local pin holds node at the old number, both remain self-consistent
and only the origination comparison fails.

### PoW

Ordering-block PoW is the consensus PoW; its constants are
`ORDERING_BLOCK_POW_TARGET_BITS` and `ORDERING_BLOCK_POW_TARGET_FLOOR` (§Consensus). A post
carries no PoW of its own.

### Karma

```typescript
export const KARMA_POSTING_MINIMUM = 1n;             // consensus — minimum karma to post
export const KARMA_STALE_THRESHOLD_BLOCKS = 40320;   // consensus — 28d grace at 60s blocks
export const KARMA_DECAY_INTERVAL_BLOCKS = 1440;     // consensus — 24h decay period at 60s blocks
export const KARMA_DECAY_AMOUNT = 5n;                // consensus — karma burned per interval
export const KARMA_MINIMUM = 10n;                    // consensus — floor, decay never reduces below
```

> ⚠ **The two `*_BLOCKS` values above were CORRECTED on 2026-08-06 from a 2-minute basis.**
> **The target block time is 60 seconds.**
>
> **This was a unit error, not a tuning question.** The constants were annotated "28 days"
> and "24 hours" while the target block time is 60 seconds and every other time-derived
> constant is 60s-based — `MEMPOOL_EXPIRY_BLOCKS` is `720` for "~12h" (720 minutes ✓),
> `CREDIT_EPOCH_BLOCKS` is `129_600` for "~90 days" ✓, and `CREDIT_FIXED_RATE_BLOCKS` says
> "at 60s blocks" outright. **The karma pair were the only constants on a 2-minute basis**,
> so at the block time the node actually runs they delivered **14 days and 12 hours — half
> their stated durations.** Decay bit twice as fast and twice as often as documented.
>
> ⛔ **What that sweep checked was each annotation against its own arithmetic, and nothing
> more.** A ✓ beside a constant means its comment and its value agree at 60 seconds. It is
> **not** evidence that the duration was chosen. `CREDIT_MINER_REWARD_DELAY` was cited here
> as a `720`-for-12h control and passed on exactly that basis; its duration had never been
> decided, and it is now **1440 for 24h** (§Credit emission). **Do not read a passing unit
> check as a settled value.**
>
> ⚠ **The duration is a separate question from the unit, and it is ruled: 28 days (user,
> 2026-08-19).** This correction is about the unit alone; the ruling is stated at → Network
> profiles, and `CONSTANTS → Karma` records the standing of every value in this block.

### Post price

```typescript
export const POST_PRICE_THREAD = 5n;             // consensus — karma a thread pays to the pool
export const POST_PRICE_REPLY = 3n;              // consensus — karma a reply pays
export const REPLY_AUTHOR_SHARE = 1n;            // consensus — the part of a reply's price the parent's author accrues
```

`REPLY_AUTHOR_SHARE < POST_PRICE_REPLY`, so a reply always returns something to the pool — the
relation is the rule, the numbers are `CONSTANTS → Post price and likes`. `KARMA_POSTING_MINIMUM`
(→ Karma) no longer states the minimum to post — the price does, by conservation — and survives
only as `INVITE_MIN_KARMA`'s alias.

> ⚠ **AHEAD OF CODE — 2026-08-29.** `constants.ts` exports `POST_LOCK_THREAD_COST`, `POST_LOCK_REPLY_COST`
> and `POST_LOCK_UNLOCK_PER_LIKES`; PR A's types unit replaces them with the three above.

### Likes

```typescript
export const LIKE_KARMA_COST = 1n;             // Karma burned by the liker per like (bigint)
export const LIKES_PER_KARMA_PAYOUT = 5;       // x: per x likes an author accrues x−1; 1 burned
```


### Invites

```typescript
export const INVITE_MIN_KARMA = KARMA_POSTING_MINIMUM;  // consensus
export const INVITE_BOND_MIN = 25n;                // consensus → profile: inviteBondMin
export const INVITE_BOND_MAX = 250n;               // consensus → profile: inviteBondMax
export const INVITE_PROBATION_BLOCKS = 43200;      // consensus — 30 days at 60s → profile: inviteProbationBlocks
export const INVITE_BOND_VEST_PER_LIKES = 3;       // consensus — likes the invitee must receive per 1 karma vested
```

⛔ **THE GRANT IS THE BOND, so there is no separate grant constant.** The inviter picks a
bond inside `[INVITE_BOND_MIN, INVITE_BOND_MAX]` — both **per-network caps** — and the
settlement grants exactly that value out of the pool. The bound `B ≥ G` used to be a
relationship between two numbers that could drift; equality removes the second number
rather than restating the rule.

⛔ **`INVITE_BOND_VEST_PER_LIKES` is not `LIKES_PER_KARMA_PAYOUT`, and the two must
not be collapsed.** They answer different questions — *how many likes vest one karma of an
inviter's stake* versus *how many likes an author is paid for before one is burned* — and
each moves without the other. **Their ratio is the supply dial**: a completed invite moves
`B · (1 − V/L)` into circulation, so `V = L` would mean the network cannot inflate at all.
They are 3 and 5; a single constant serving both would re-price one silently.

The pending-invite cap needs no successor because the balance is one. An inviter
locks their chosen bond per invite out of their own karma, so `K /
INVITE_BOND_MIN` bounds their concurrent invites without a rule — the floor, since
that is the cheapest invite they can build. The threshold
goes with the early-unlock leg it served: a bond settles **once**, at
`IdentityRecord.invitedAtBlock + INVITE_PROBATION_BLOCKS`, and nothing reads a
karma balance to decide it.

### Vouch

```typescript
export const VOUCH_KARMA_AMOUNT = 1n;              // consensus — karma escrowed per vouch
export const VOUCH_MIN_BALANCE = 11n;              // consensus — minimum balance to cast a vouch
export const VOUCH_COOLDOWN_BLOCKS = 60;           // consensus — blocks before escrow is released
export const VOUCH_CAST_HEIGHT_WINDOW = 5;         // consensus — a cast's createdAtBlock may lag its carrying block by at most this many blocks
```

### Genesis

```typescript
export const GENESIS_KARMA_PER_MEMBER = 1000n;             // consensus
export const SYSTEM_KARMA_INITIAL = 1_000_000n;            // consensus — the faucet identity's karma at genesis
export const FAUCET_CREDITS_INITIAL = 100_000n * 10n ** 8n; // consensus — 100 000 credits in base units
```

**The faucet identity's two seeds are universal constants, not profile fields.** The boxes are
byte-identical everywhere they are seeded at all (→ Network profiles); whether they are seeded is
`faucetPublicKey`'s presence (`NODE_INTERFACE → Faucet`). A per-network value would be a place devnet
may behave unlike mainnet, with nothing to gain (`ARCHITECTURE → What varies per network`).

**The genesis committee is a `NetworkProfile` field and nothing else.** `genesisCommitteeKeys` is read
by `services/genesis-state.ts`, which seeds one karma box per entry out of the pool, and all three
profiles carry it. No `constants.ts` export stands beside it: one constant serves one value, and three
networks name three committees. Every profile's array is empty and the value is TBD at genesis.

A committee credit grant and a committee dissolution period have no constant and no profile field:
nothing read `GENESIS_CREDITS_PER_MEMBER` / `genesisCreditsPerMember` or `BOOTSTRAP_PERIOD_BLOCKS` /
`bootstrapPeriodBlocks`, and a parameter nothing reads cannot be relied on (ARCHITECTURE → Genesis).
A mechanism that needs either brings its own parameter with its own reader.

### Mempool and encoding

```typescript
export const MEMPOOL_EXPIRY_BLOCKS = 720;          // local — blocks before mempool entries expire (~12h)
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';  // SPKI wrapper stripped from raw keys
```

### Credit emission (Ergo-style linear decay)

```typescript
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;     // consensus — ~2 years at 60s blocks
export const CREDIT_INITIAL_REWARD = 42n * 10n ** 8n;  // consensus — 42 credits/block, base units
export const CREDIT_EPOCH_BLOCKS = 470_000;            // consensus — ~326 days, reduction interval
export const CREDIT_REWARD_REDUCTION = 1n * 10n ** 8n; // consensus — 1 credit reduced per epoch
export const CREDIT_MINER_REWARD_DELAY = 1440;         // consensus — blocks before coinbase spendable (24h at 60s blocks)
export const COINBASE_TREASURY_PCT = 5;      // consensus — per income TERM: of emission and of fees, never of rent
export const COINBASE_MINER_FLOOR_PCT = 35;  // consensus — guaranteed, and takes every remainder
export const COINBASE_BACKER_PCT = 35;       // consensus — AHEAD OF CODE, falls to the miner floor
export const COINBASE_BONUS_PCT = 25;        // consensus — the inclusion bonus pool
export const INCLUSION_BONUS_K = 5n;         // consensus — the bonus curve's knee
export const MEMPOOL_CREDIT_SHARE_PCT = 50;  // policy — credit share of the pool
export const MIN_FEE_RATE_PER_BYTE = 0n;     // policy — relay floor, base units per IN-BLOCK byte

// Storage rent and the credit floor. Both are CONSENSUS and both are
// per byte of the box's own record. Derived from Ergo's, scaled by the supply ratio (Ergo's
// 97,739,924 ERG max against this network's 422,640,000 credit emission), so Ergo's 3,889x ratio
// between the two is preserved rather than chosen twice. The PERIOD is a profile field, not here.
export const MIN_BOX_VALUE_PER_BYTE = 156n;        // consensus — credit outputs only
export const STORAGE_RENT_PER_BYTE = 605_378n;     // consensus — charged once per period
```

> The four `COINBASE_*_PCT` values **must sum to 100** — four independent `export const`s
> carry no relationship the compiler can see, so the sum is asserted in the types suite.

> ⚠ **Every value in this block was shown pre-P0 until 2026-08-06.** The BigInt rescale
> updated the Denomination prose above and left these literals at their unscaled values
> (`100`, `2`) — and the literals are what people copy. Same defect in the Invite,
> Vouch and Genesis blocks, now corrected.

> **The curve reaches zero, and there is no constant holding it up.** `computeBlockReward`
> ends `return max(reward, 0)`, so the decay's last step is to nothing rather than to a
> floor. There is no tail rate: the schedule and its end height are
> `MINING_INTERFACE → Emission Schedule`.

### Ordering block PoW

```typescript
export const ORDERING_BLOCK_POW_TARGET_BITS = 5984;     // 23.375 bits — a 60s solve
export const ORDERING_BLOCK_POW_TARGET_FLOOR = 2304;    // 9 whole bits
```

**The derivation, so it reproduces:** 60 s × 181,262 H/s = 10,875,720 hashes; `log2` of that is
**23.37461** bits; ×256 = **5983.90**, which rounds to **5984** — exactly 23.375 bits, or 23 + 3/8, a
value the 1/256 representation carries without rounding. ⚠ **Provisional**: one machine, one thread,
while the target is set by the network's total.

⚠ **`ORDERING_BLOCK_POW_TARGET_BITS` is mainnet's and testnet's. Devnet sets its own
`orderingBlockPowTargetBits` and it is deliberately lower** — the node test suite mines real PoW, and
`expectedTarget()` reads the process config singleton, so an injected `Config` cannot lower it. Devnet is
the profile the suite resolves; a raised value there costs the suite hours. **This is the one parameter
on which devnet does not follow the constant**, and the divergence is load-bearing rather than
incidental.

⚠ **Both are in units of 1/256 of a bit** — `VALIDATION_INTERFACE → orderingPowTarget`. Divide by 256
to read them as whole bits.

**The floor is nine bits rather than the four it was, and that is not a rescale.** `blockWork` stops
resolving below 2180 — a 1/256-bit step there buys zero additional work — so a chain admitted beneath
that line retargets without moving the quantity fork choice selects on. 2304 is the first whole bit
above it.

### Interlinks

```typescript
export const LEVEL_CAP = 256;        // consensus — the level of a header whose PoW hit is 0; no level exceeds it
export const MAX_INTERLINKS = 257;   // consensus — LEVEL_CAP + 1: the interlink vector's longest form
export const INTERLINK_DOMAIN = encoder.encode('dagsocial/interlinks/1');   // → Domain tags
```

Both bounds are argued from the maximum (→ Interlink vector): a non-zero hit's level is below the
target's bit length, which is at most 256 for every target `orderingPowTarget` can expand, and a zero
hit is defined as `LEVEL_CAP`; the vector holds one entry per level plus genesis. Neither is
provisional, and neither is a profile field.

---

## Preconditions
- Node.js ≥ 22
- `@dagsocial/wire` is the only dependency — this package has no runtime dependency outside
  the workspace; in particular it does not depend on `cbor-x`

## Postconditions
- Build produces `dist/index.js` (ESM) + `dist/index.d.ts`
- All functions are pure — no side effects, no module-level state
- Types are importable by consumers without runtime cost (type-only imports)

## Invariants
- Must not import from `@dagsocial/node`, `@dagsocial/net`, or `@dagsocial/web`
- Hash algorithm: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Base58 alphabet: Bitcoin-style (no `0OIl`)
- Positional binary is the canonical wire format; JSON for HTTP API
- `protocolVersion` field present on all wire types
- Secret keys never in any exported type or serialized output
- Box identity is deterministic **and provenance-derived**:
  `blake2b512(BOX_ID_DOMAIN ‖ boxRecordBytes(candidate, txId, index)).subarray(0,32)`
- `computeBoxId` takes **one argument**. Any need for a second means the box is missing
  provenance, which the `BoxCandidate`/`BoxBase` split is there to prevent
- `stored.id === computeBoxId(stored)` for every box in the UTXO set — no exceptions, no
  apply-time field mutation that the id does not cover
- Every id preimage carries a domain tag; box ids, tx ids and identity-record keys share one
  32-byte keyspace and must not be forgeable across it
- A box's block height is **creator-declared**: `createdAtBlock` sits in the shared prefix, so the
  creator signs it and the box id covers it. The general bound is one-directional
  (`createdAtBlock <= currentBlockHeight`); **every rule deriving from it owes its own exact
  check**, and backdating is bounded by nothing else. Consensus time otherwise lives in explicit
  named fields (`lockedUntilBlock`) or in committed per-identity state
  (`IdentityRecord.invitedAtBlock`, which is what dates a bond's probation)
- Box `value` is `bigint` integer base units (uniform across box types), `< BOX_VALUE_BOUND`
  (§Box value domain); no float math anywhere in consensus
  value arithmetic
- Post identity is provenance-derived — `computePostId(txId, index)`; the body enters consensus
  only as `PostCommit.contentHash` inside the creating transaction's preimage, and a body is
  verified against that commitment, never against the id
  > ✅ **RESOLVED 2026-08-22** — this line read "Post identity includes PoW nonce; signing hash
  > excludes it", a pre-08-15 claim: there is no post PoW and no signing hash (§Post identity)
- `UserId` IS the 32-byte Ed25519 public key — no hashing, no separate account concept
