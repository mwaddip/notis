# TYPES Interface Contract

**Component:** `@dagsocial/types`
**Protocol version:** 1
**Last updated:** 2026-08-13

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
In CBOR it stays raw bytes. There is no `getUserId` hash function — the public
key IS the identity.

---

## Core Types (`post.ts`)

### Post

```
Post {
  content: string              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId               // 32-byte Ed25519 public key (Uint8Array)
  parentRefs: PostId[]         // 0–MAX_PARENT_REFS
  protocolVersion: number      // 1
  timestamp: number            // Unix ms
}

PostId = blake2b512(POST_ID_DOMAIN || utf8(txId) || u32BE(index))
         .subarray(0, 32).toString('hex')
```

`PostId` is a hex string. `author` is binary (Uint8Array) — hex on the HTTP
wire, raw bytes in CBOR.

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

**The normative byte layout is Serialization → "Layout — Post".** This section states the
properties that layout must have and does not restate it. `POST_ID_DOMAIN` is
`utf8("dagsocial/post-id/1")`.

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

⚠ **No surviving field takes an out-of-domain sentinel that consensus then reads.** `vlqU`'s
sentinel behaviour is unchanged for `timestamp` and `protocolVersion`; neither is a consensus
input.

`computePostId` prefixes `POST_ID_DOMAIN` so a post id can never collide with a box id or a
tx id derived from the same provenance — the domain tag is the whole of that separation, and
it is the same discipline `computeBoxId` and `computeMintTxId` already follow.

**This encoding is protocol-breaking and unversioned.** It changes every post
hash and must be byte-identical in `@dagsocial/types` **and** the demo-UI JS
(`packages/node/public/index.html`). `PROTOCOL_VERSION` stays `1`; both devnet
DBs are wiped on deploy — no legacy-post path. A **golden test vector** is frozen in the types tests
and reproduced by the UI mirror; it is the cross-implementation anchor.

### Profile posts

Special `type` field for posts that carry identity metadata. The type
discriminator is embedded in `content` as a JSON object:

```
ProfileRoot = Post with content { type: "profile" }
BioPost     = Post with content { type: "bio", ... }
NamePost    = Post with content { type: "display_name", ... }
AvatarPost  = Post with content { type: "avatar", ... }
UsernameClaim = Post with content { type: "username_claim", claim: "@alice" }
```

### Hashing functions

| Export | Signature | Description |
|--------|-----------|-------------|
| Export | Signature | Description |
|--------|-----------|-------------|
| `postFieldBytes(post)` | `(Post) => Uint8Array` | The canonical length-prefixed encoding (see above). The post's **payload inside its creating transaction**, so it enters that transaction's `TxId`. |
| `computePostId(txId, index)` | `(TxId, number) => PostId` | `blake2b512(POST_ID_DOMAIN \|\| utf8(txId) \|\| u32BE(index)).subarray(0,32).toString('hex')` — **provenance-derived**, taking no `Post` at all |
| `getPostDiscriminator(content)` | `(string) => string \| null` | Parse JSON content and extract `type` field, or null |
| `buildProfileContent(type, extra)` | `(string, Record?) => string` | Build JSON content string with type discriminator |

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
bytes of its hex text — as the `postlock-*` mint subjects do. The
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
`computeTxId`, the payload is inside that preimage, and the signer is the author.

Three consequences, each of which reads as a loss only if this rule is not stated:

- **A post-taking id verifier — any `(post, expectedId)` signature — cannot exist.** Not
  "was removed" — it has no possible implementation.
- **Parent refs are checked for EXISTENCE, not by hash recomputation.** A `verifyParentHash`
  that decoded the parent and re-derived its id was checking a claim the parent's own bytes
  can no longer make.
- **A bare-post-by-id fetch has no verifiable answer**, which is why no such wire message
  exists (`NET_INTERFACE` → Gossip Topics; codes 10/11 reserved). Anything that returns a
  post must return the transaction that created it.

**`StoredPost.id` is the store's statement of the binding.** It is written when the creating
transaction applies and carried on every read; a reader takes it rather than deriving it,
because deriving it is the thing that cannot be done.

### Merkle primitives (`merkle.ts`)

| Export | Description |
|--------|-------------|
| `leafHash(domain, data)` | `blake2b512(utf8(domain ‖ "\0") ‖ data)[:32]` — domain-separated leaf so a leaf in one tree can't collide with a leaf in another. |
| `nodeHash(left, right)` | `blake2b512(NODE_TAG ‖ left ‖ right)[:32]` — internal-node hash of two children. |
| `buildMerkleRoot(leaves)` | Binary Merkle root over ordered leaf hashes. Empty → 32 zero bytes; single leaf → that leaf. **Odd levels PROMOTE the unpaired last node unchanged — they do NOT duplicate it** (see below). |

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
> leaf preimage can ever begin with `0x00`. The **three** live domains are `stump`, `prune`,
> `utxotx` — all printable, none a prefix of another, so the NUL delimiter suffices.
> **Two retired domain strings are tracked reservations** (→ Tracked reservations, below the
> boxType tag table): `subblock` and `coinbase`. Both are remnant-bounded, and `coinbase`'s
> remnant is the live coinbase concept itself, so it holds while that concept does.
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
boxId = blake2b512( BOX_ID_DOMAIN ‖ canonicalCbor(candidate) ‖ txId ‖ u32BE(index) )[0:32]
```

Box identity derives from **creating-transaction provenance**, not from content alone
(Spec G). A pure content hash cannot be
simultaneously *honest* (matching an apply-mutated box) and *predictable* (known at signing
time); provenance gives both, and makes collisions structurally impossible.

Two shapes, not one:

```
interface BoxCandidate {              // the shared BASE — no per-type fields
  boxType: "karma" | "credit" | "invite" | "genesis_proof" | "bond" | "post_lock" | "vouch"
         | "emission" | "treasury" | "fee"
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

#### Mint identity

Boxes created by block application rather than by a user transaction (coinbase, karma mints,
decay, post-lock vesting, genesis) derive a **synthetic transaction id**, so there is exactly
one derivation path:

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
    64-character hex text.** This covers `computePostId`'s `txId` and the `postlock-unlock`
    and `postlock-remainder` mint subjects. **`reason` does NOT enter
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

Box ids, tx ids and identity-record keys share one 32-byte keyspace and the AVL tree now holds
two entity kinds, so the separation must be in the preimage. (`computePostId` already works
this way via `POST_ID_DOMAIN`; box ids previously had no tag.)

#### Canonical encoding

Exactly one encoder defines `canonicalCbor` for identity: the `cbor-x` `Encoder` in `utxo.ts`
(`{ tagUint8Array: false, useRecords: false, mapsAsObjects: true }`), exported as
`canonicalBoxBytes(candidate)` so tests and mirror implementations assert against the encoder
that actually computes ids. Node's AVL value encoder (`state/serialize-box.ts`) is a
**separate, tagged** encoding for tree values and is not interchangeable with it.
`serialization.ts` must not export a third — it previously did, using cbor-x's *default*
`encode`, which is neither. `computeTxId` hashes its outputs through `canonicalBoxBytes` for
the same reason: one strip rule, so tx and box derivation cannot drift.

⚠ **`canonicalBoxBytes` is cbor-x framing, NOT RFC 8949 canonical CBOR.** It emits the fixed
two-byte map header (`b9 00NN`), not the minimal-length form (`a7`). The name invites the wrong
assumption — a mirror written to the CBOR canonicalisation rules computes different ids. The
demo UI already encodes this way; full bytes are pinned as golden vectors in
`test/utxo.test.ts`.

#### Key ordering is canonical (Spec G phase G3b)

`canonicalBoxBytes` **imposes** a total key order — a lexicographic sort of the candidate's own
keys — rather than inheriting the caller's insertion order. Node's `serializeBox` and the demo
UI's mirror apply the identical rule.

This retires contract hazards **1b and 1c** in `NODE_INTERFACE.md`. cbor-x emits map keys in JS
insertion order, so before this a producer's field order was consensus-visible: the same box
built two ways hashed to two ids, and `post_lock` genuinely diverged between its producer and
`rowToBox`. The fix is at the single encode site, **not** at the diverging producer — a producer
can no longer get key order wrong because it no longer chooses it, and the "make every producer
match `rowToBox`" discipline is retired with it.

`Array.prototype.sort` with no comparator compares UTF-16 code units and is **not** locale-aware
(that is `localeCompare`), so it is deterministic across platforms. Every box field name is
ASCII, so the order is plain byte order. The sort is **shallow**: box fields are primitives,
strings and `Uint8Array`s, and a nested object added later would need it applied recursively.

> A mirror implementation that sorts differently — or not at all — computes different ids for
> every box. This sits alongside the cbor-x-framing warning above as the second thing a mirror
> must get right.

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

**The cbor-x argument still holds and is now incidental:** a bigint `< 2⁶⁴` encodes as a CBOR uint64
(`0x1b` + 8 bytes); at or above it escalates to a tag-2 bignum, a different layout. `2⁶³` is inside
that, so the uniform `0x1b` form is preserved by a bound chosen for a different reason.

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
  nonActivity?: boolean        // Set on any karma output that must not bump the owner's activity clock — settlement outputs and vesting returns; absent on a user transaction's own outputs
}
```

Karma boxes are non-tradeable. They can only be consumed by the owner to:
- Create a bond box (inviting — ARCHITECTURE → Invite System)
- Fund a like — the `LIKE_KARMA_COST` rides the transaction's own `LikeAccrualBox` marker
- Create a new karma box for the same owner (balance change)
- Create a post lock box (when posting)
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

**There is no `originalValue`,** and the contrast with `PostLockBox` below is the
reason. A post lock vests per block, so its current and initial values differ and
both have to be carried. A bond settles **once**, for
`min(floor(IdentityRecord.lifetimeLikesReceived / INVITE_BOND_VEST_PER_LIKES), value)`
— a pure function of a monotonic counter, which makes a single evaluation
arithmetically identical to accumulated instalments. No partial state exists to
record.

**Nothing spends a bond.** Creation and settlement both move it through block
application — the create transaction outputs it, the settlement transaction
consumes it at the probation deadline — so no transition admits it into a user
transaction, the same standing `PostLockBox` has. `inviteePublicKey` is also
what the settlement reads to address the grant, and the probation window runs
from the invite's own height (`IdentityRecord.invitedAtBlock`) — recorded on the
identity record, so carrying it here would be a second copy of committed state.

### PostLockBox

```
PostLockBox extends BoxBase {
  boxType: "post_lock"
  value: bigint                // Current locked karma (decreases per block as likes accumulate)
  originalValue: bigint        // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array            // 32 raw bytes — post author's Ed25519 public key
}
```

⛔ **There is no `targetPostId`, and the reason is CIRCULARITY.** A post's id comes
from the transaction that creates it (`computePostId(txId, index)`). The lock is an
**output of that same transaction**, and `canonicalBoxBytes` is inside the `TxId`
preimage — so the field would have to be known before the `TxId` that produces it.
**The transaction would be unbuildable.** This is the same circularity that makes
`outputs` carry *candidates*: a transaction cannot name its own outputs' ids, so ids
are derived once `TxId` is known.

It would also be a **second copy of committed state**: a lock's target is recomputable
from the transaction that created it, so carrying it adds a field that can disagree
with the thing it describes and buys nothing.

⚠ **Do not re-add it.** The field looks obviously useful and is unbuildable. Node holds
the lock→post mapping as **derived state**, written at apply by every node identically
— the shape P2-D already blesses ("derived state computed identically by every node at
apply — nothing to carry in the block").

⛔ **TWO derivation routes, and one does not cover the other.**

| lock | provenance names | target derived from |
|---|---|---|
| the original lock | the **post's own transaction** | `computePostId(box.txId, 0)` |
| a `postlock-remainder` lock | a **synthetic mint** (`computeMintTxId`) | the mint **subject**, which carries the post id |

A remainder lock's provenance names the mint, **not** the post, so route 1 derives a
wrong id from it. Node's `insertBox` states both routes adjacently and refuses a
`post_lock` that supplies neither.

Post lock karma vests **per block** (P2-D — there is no epoch): every
`POST_LOCK_UNLOCK_PER_LIKES` (10) lifetime likes on the target post unlocks
1 karma back to the author, evaluated at the end of any block in which the
post received likes (`ARCHITECTURE §Likes → Post karma locking`).

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
outputs it; the voucher reclaims it by their own signed transaction at or after
`releaseAtBlock` (NODE_INTERFACE → Vouch transition rules, §Spend timing).

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

⚠ **`releaseAtBlock` is committed state, and that is the point.** A node holding the `stateRoot`
holds the obligation, rather than a root it cannot interpret without replaying every block.

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

⛔ **`author` IS ATTRIBUTION, NOT AUTHORIZATION** — the same distinction `BondBox.inviterId` and
`PostLockBox.owner` carry. **No signature by `author` unlocks this box.** Only the settlement
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
difference: its value is that profile's emission total, derived from `creditFixedRateBlocks` and
`creditEpochBlocks`, and devnet's compressed schedule gives it a smaller one. Two networks now
differ in two boxes, not one. Corrected 2026-08-16, when unit 4b made it false.

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

The rejection is a `ReaderError` with code `invalid-tag`. `ReaderErrorCode` is `@dagsocial/wire`'s
and has no member for a domain refusal; `readLpUtf8` already uses `invalid-tag` for the same shape —
a length-prefixed field whose *contents* are out of domain — and `CodecError` states the general
argument for the choice.

### EmissionBox

```
EmissionBox extends BoxBase {
  boxType: "emission"
  value: bigint                // Credits not yet released, in base units
}
```

**The whole of a network's credit emission, held as state from height 0.** Genesis creates one on
every network holding that profile's entire emission total; each block spends it to a successor
holding `value − computeBlockReward(height)`. No other rule reduces it and none increases it, so
what remains to be emitted is a value an observer reads rather than a schedule they trust — which is
what `ARCHITECTURE` → UTXO conservation rests its bound on.

**No owner, and therefore no per-type trailing fields.** The box names no spender because block
application is the only one. Its content encoding is the shared prefix alone — one of three box
types with an empty tail (§Layout — Boxes).

⛔ **A successor whose value would be `0` is not created.** The total equals the schedule's sum
exactly, so the last emitting block consumes the box and leaves none; above the terminus no emission
box exists and nothing is spent. This is the box form of the rule the coinbase already carries —
one block, one encoding — and without it a zero-value box is removed and reinserted on every block
forever.

⚠ **The genesis value is derived from the profile's schedule, not written into the profile.** A
hardcoded total that disagrees with `computeBlockReward` either starves the box before the terminus,
making every block from that height unproducible, or strands a residue no rule can release.

### TreasuryBox

```
TreasuryBox extends BoxBase {
  boxType: "treasury"
  value: bigint                // Credits accrued, in base units
}
```

**Where the coinbase's treasury slice and the forfeited inclusion bonus land.** Block application
spends it to a successor holding `value + split.treasury`; there is no rule that reduces it.
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
> with unit B (**#87**); the block settlement transaction spends the pool — its sole spender,
> once per block — and re-emits its successor, so every karma mint draws from a named source and
> every burn returns to one (`NODE_INTERFACE` → Legal box transitions; `ARCHITECTURE` → The
> conservation axiom).

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

> ⛔ **A zero-value successor IS created, and this is the one place the `EmissionBox` rule inverts.**
> §EmissionBox refuses a zero successor because emission **terminates** — above the terminus no box
> exists and nothing is spent. The pool never terminates: burns must always have somewhere to return,
> so the box exists at every height whatever its value. **A reader who pattern-matches to the
> emission rule here gets it exactly backwards.**

### UtxoTransaction

```
UtxoTransaction {
  inputs: BoxId[]                          // Boxes consumed
  outputs: BoxCandidate[]                  // Boxes created — candidates: no id, no txId, no index
  signatures: Record<string, Uint8Array>   // publicKey (hex) → Ed25519 sig (64 bytes) over TxId
  preimages?: Record<string, Uint8Array>   // boxId → hash preimage — encoded and hashed, read by nothing
  protocolVersion: number                  // 1
  likeTarget?: PostId                      // Present ⟺ this tx is a like (P2-D) — see below
  post?: Post                              // Present ⟺ this tx creates a post — see below
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

**`post`** carries the post's payload inside the transaction that creates it, on
the same pattern `likeTarget` set: an optional field whose presence is
biconditional with a rule. It takes `opt()`'s presence tag followed by
`postFieldBytes(post)`, appended **only when present**, after `likeTarget`'s
contribution. **The two are mutually exclusive in practice** — a transaction is a
like or a post, never both — but the encoding does not rely on that: each carries
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

The consensus rule — `post` present ⟺ the transaction locks
`POST_LOCK_{THREAD,REPLY}_COST` into a `PostLockBox` and conserves value — lives
in `NODE_INTERFACE.md`, as the like biconditional does.

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

---

## Stump Types (`stump.ts`)

```
PruneIntent {
  rootPostHash: PostId
  authorId: UserId
  subtreeMerkleRoot: Uint8Array(32)  // Merkle root over subtree postIds
  subtreePostIds: PostId[]           // All postIds in the subtree
  signature: Uint8Array(64)           // Ed25519 over blake2b512(rootPostHash || subtreeMerkleRoot)
  trigger?: "author" | "storage_prune"
}

PruneEntry {
  rootPostHash: PostId
  authorId: UserId
  subtreeMerkleRoot: Uint8Array(32)  // Merkle root over subtree postIds
  subtreePostIds: PostId[]           // All postIds in the subtree
  signature: Uint8Array(64)           // Ed25519 over blake2b512(rootPostHash || subtreeMerkleRoot)
  trigger: "author" | "storage_prune"
  protocolVersion: number
}

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

| Export | Signature | Description |
|--------|-----------|-------------|
| `computePruneEntryId(entry)` | `(PruneEntry) => string` | Deterministic PruneEntry ID |
| `serializePruneEntry(entry)` | `(PruneEntry) => Uint8Array` | Canonical CBOR encoding |

---

## Block Types (`block.ts`)

### Block header

```
BlockHeader {
  protocolVersion: number        // 1
  height: number                 // Monotonically increasing, starting from 1
  prevBlockHash: string          // hex(32) — hash of the previous block's header
  utxoTxRoot: string             // hex(32) — Merkle root over the block body (txs + prune entries)
  stateRoot: string              // hex(33) — AVL+ digest (EMPTY_STATE_ROOT until enabled)
  validatorId: UserId            // Block producer's 32-byte public key
  powNonce: number               // PoW solution
  powTargetBits: number          // Difficulty target for this block
  createdAt: number              // Unix ms — stamped at TEMPLATE BUILD, not at solve
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
> code. **The header is nine fields.** Read this before proposing it a third time.
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
bound into the header transitively through `utxoTxRoot` / `stateRoot`,
so the header alone commits to the whole block.

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
  utxoTxs: Uint8Array[]              // CBOR-encoded UtxoTransactions, aligned with utxoTxIds
  pruneEntries: PruneEntry[]         // prune entries committed in this block
}
```

⛔ **One committed list, not two.** A post is a transaction, so it rides `utxoTxIds`
alongside likes and every other transaction; there is no second tree. `pruneEntries`
lives here rather than keeping a section of its own —
`utxoTxRoot` commits both, and the leaf domains (`leafHash`'s first argument) are what
keep a prune leaf from colliding with a transaction leaf.

Every block carries **one settlement transaction**, riding `utxoTxIds` / `utxoTxs` like any
other (`ARCHITECTURE` → Block architecture, `NODE_INTERFACE` → the settlement transaction);
coinbase outputs are **its outputs**, so no block-body field carries the reward. The
`'coinbase'` and `'subblock'` leaf domains are retired — **§Merkle primitives holds the one
live/retired list.**

⚠ **The body layout is positional** (`arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)` ‖
`arr(pruneEntries)`), and `utxoTxTreeByteLength` computes the same length a second way and
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
derived from `powTarget`, and the dependency runs `validation → types`, so it cannot be computed in
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
> ⚠ **Two encoders are still CBOR and are not covered by that statement.** `encodeTx` /
> `decodeTx` and `encodeStump` / `decodeStump` in `types/src/serialization.ts` are bare
> `cbor-x`, so the gossip UTXO-transaction path and every stump still travel as CBOR. **No
> phase claims them** — carried register #6. Everything under a committed root is positional;
> these two are not under one.
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
| `enum8`, `bool` | one byte | closed tag set / `{0,1}` | ✅ sentinel `0xff` |
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
> inspect the interior, and the sync path stays on `cbor-x` permanently, so **no codec phase would
> ever have closed it.**
>
> **This is not merely tightening the already-unusable.** A post with a 64-character *non-hex*
> `parentRef` passes the complete Stage-1 pipeline today, signature and PoW included, because the ref
> is hashed as UTF-8 text and the signature covers those bytes. One third of the pin is a real
> behavioural change.

### Layout — Post

The struct is five fields; there is no `powNonce`, `challenge` or `signature` in it at all
(§Post identity — identity is provenance-derived, authentication is the creating
transaction's signature).

| # | Field | Encoding |
|---|---|---|
| 1 | `content` | `lpUtf8` |
| 2 | `author` | `b32` (bytes writer) |
| 3 | `parentRefs` | `arr(refs, b32)` (hex writer) |
| 4 | `protocolVersion` | `vlqU` |
| 5 | `timestamp` | `vlqU` |

- `postFieldBytes` is these five fields in this order, and is the post's **payload inside its
  creating transaction** — it enters that transaction's `TxId` (§Canonical field encoding).
- Wire codec `encodePost` **delegates**: `write` is one `writeBytes(postFieldBytes(p))` and
  `read` is the adjacent `readPostFields`, so the standalone wire form and the in-transaction
  payload are the same bytes with one statement of the layout.

The encoding is positional and injective (audit M-1); the frozen golden vectors are the
cross-implementation anchor, reproduced by the demo-UI mirror.

### Layout — Stump / PruneEntry

`trigger` tags: `0 = author`, `1 = storage_prune`.

**Stump:** `b32(rootPostHash)` ‖ `b32(authorId)` ‖ `vlqU(replyCount)` ‖ `vlqU(upvoteCount)` ‖
`enum8(trigger)` ‖ `vlqU(protocolVersion)` ‖ `vlqU(compactedAtBlockHeight)`

**PruneEntry** (`serializePruneEntry`): `b32(rootPostHash)` ‖ `arr(subtreePostIds, b32)` ‖
`b32(subtreeMerkleRoot)` ‖ `b32(authorId)` ‖ `b64(authorSignature)` ‖ `enum8(trigger)`

Field order matches the current object literal, so the change is dialect-only.

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
than a copy.

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
width.** This cell and the `post_lock.originalValue` cell below both said `vlqU` while the code has
always called `writeVlqU64OrThrow` (`utxo.ts:128`, `:167`); both fields are `bigint`. **The bytes are
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
| 5 | `post_lock` |
| 6 | `vouch` |
| 7 | `emission` |
| 8 | `treasury` |
| 9 | `fee` |
| 10 | `karma_pool` |
| 11 | `like_accrual` |
| 12 | `vouch_escrow` |
| **255** | ⛔ **PERMANENTLY UNASSIGNED — the probe value. Never give it a type.** |

> ## Tracked reservations (remnant-bounded — tag rules, condition 3)
>
> Reserved while the named remnants stand; the row leaves this table when they go.
>
> | Reserved | Held by |
> |---|---|
> | tag `2` + boxType `'invite'` | §InviteBox record and its in-code citations; the tag-2 reject vectors; `node/store/db.ts`'s tag-order comment |
> | boxType `'like'` | the live illegal-transition rule (`utxo-engine`'s like clause) and its reject vectors |
> | leaf domain `'subblock'` | node's live-legacy identifiers (`confirmedSubBlockIds`, `recordConfirmedSubBlocks`, `unconfirmPost(subBlockId)`) |
> | leaf domain `'coinbase'` | the live coinbase concept (`coinbase-split.ts`, `COINBASE_*` constants) — the string is permanently collision-prone while the concept lives |

> ## ⛔ TAG 2 IS A TRACKED HOLE
>
> `invite` is deleted (§InviteBox) and its number is reserved **while the tracked-reservations
> row above holds** — the lowest-free-tag rule then governs it like any hole. A hole **inside**
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
| `karma` | `b32(owner)` ‖ `opt(nonActivity, u8)` |
| `credit` | `b32(owner)` ‖ `opt(lockedUntilBlock, vlqU)` |
| `invite` | `b32(inviterId)` ‖ `b32(inviteePublicKey)` |
| `genesis_proof` | `lp(payload)` |
| `bond` | `b32(inviterId)` ‖ **`b32(inviteePublicKey)`** |
| `post_lock` | **`vlqU64(originalValue)`** ‖ `b32(owner)` |
| `vouch` | `b32(voucherId)` ‖ `b32(targetId)` |
| `emission` | *(none)* |
| `treasury` | *(none)* |
| `fee` | *(none)* |
| `karma_pool` | *(none)* |
| `like_accrual` | `b32(author)` |
| `vouch_escrow` | `b32(owner)` ‖ `vlqU(releaseAtBlock)` |

> ## ⛔ WHAT A NEW BOX TYPE COSTS, AND WHY A GREP FOR THE TYPE MISSES THE WORST SITE
>
> A box type is enumerated in hand-kept places across three packages and **the compiler links none
> of them.** Measured 2026-08-18 for `like_accrual` and `vouch_escrow`:
>
> | | |
> |---|---|
> | `types/src/utxo.ts` | the interface, `BOX_TYPE_TAGS`, the codec arm |
> | `types/test/golden/structs.ts` | the corpus's **deliberately independent** reverse table |
> | `node/src/services/utxo-engine.ts` | the output shape schema and the transition sets |
> | `node/src/store/utxo.ts` | the row mapping |
> | `node/src/karma-supply.ts` | ⚠ **three karma sets, and none derives from another** |
> | `node/public/index.html` | `BOX_TYPE_TAGS` **and** the `boxTypeFields` arm — ⛔ **no gate reaches this file** |
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

⚠ **`emission`, `treasury`, `fee` and `karma_pool` have an empty tail, and an empty cell in this
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
standing for "unlocked" would give an unlocked box and a box locked until block 0 one id. The
same holds for `nonActivity`, which is the field the activity clock reads.

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
| `karma.owner`, `credit.owner`, `invite.inviterId`, `invite.inviteePublicKey`, `bond.inviterId`, `bond.inviteePublicKey`, `post_lock.owner`, `vouch.voucherId`, `vouch.targetId` | `writeBytesNOrThrow(…, 32)` | `bytes32` | ✓ |
| `post_lock.originalValue` | `writeVlqU64OrThrow` | `u64` | ✓ |
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
`opt(likeTarget, b32)` ‖ `opt(post, postFieldBytes)`

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

`post` needs no length prefix inside its `opt`: `postFieldBytes` is self-delimiting (every
field is fixed-width, length-prefixed or a VLQ) and it is last, so nothing follows it to be
ambiguous against.

Order preserves today's sequence. This satisfies **C1 structurally**: the prior preimage used
`String(protocolVersion)` (the M-1 pattern) and concatenated inputs and variable-length outputs with
no counts or length prefixes. `preimages` already sorted by key, so the normative sort **ratifies**
existing behaviour there; for `signatures` it is new, because they were never hashed.

**Wire codec** (`encodeTx`): `txIdBytes` ‖ `arr(signatures sorted, b32(pubkey) ‖ b64(sig))`.

> ## ✅ RESOLVED — the layout is implemented. Closed 2026-08-17.
>
> **`encodeTx` is positional and reaches `writeTxIdFields`**, so the wire form and the `TxId`
> preimage share one writer rather than agreeing by inspection. This banner read `⚠ UNENFORCED`
> against a `cbor-x` implementation; the gap `serialization.ts` recorded in its own words is closed
> on the `encodeTx` half and **still open on `Stump`**.
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

⛔ **Nine fields, and a positional layout with no keys — removing a field is never a
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
to the P2-C register undone; re-derive it when there is a design to commit to.

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
is **four throwing rows and five `vlqU`** — but ⚠ **`b32` is TWO different writers and this note
first grouped them as one, which is the `bond.inviteePublicKey` failure committed inside the note
warning about it:**

| Rows | In-memory type | Writer |
|---|---|---|
| `prevBlockHash`, `utxoTxRoot` | `string` (hex) | `writeHexNOrThrow(…, 32)` |
| **`validatorId`** | **`Uint8Array`** (`UserId`) | **`writeBytesNOrThrow(…, 32)`** |
| `stateRoot` | `string` (hex) | `writeHexNOrThrow(…, 33)` |

**`validatorId` written off its table-neighbours throws on EVERY block.** **`b32` in a
layout table names a width, not an input type.** Found by the 3b executor, 2026-08-10.

The five `vlqU` rows are total *by sentinel* and therefore **collide rather than throw** —
the reason a panic-shaped search is not sufficient here.

`blockHash` = `blake2b512(headerBytes)[0..32]`; `computePowHash` is the same with `powNonce = 0`.

**UtxoTxTree:** `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)` ‖ `arr(pruneEntries)`

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
| `serializePruneEntry` | `(PruneEntry) => Uint8Array` | see Layout — Stump / PruneEntry |

`writePruneEntry` **delegates** to it rather than restating the layout, so the tree codec and the
Merkle leaf cannot drift apart.

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
bytes; two statements of one layout is the drift class this format exists to close.* The `'prune'`
leaf delegates through `serializePruneEntry`. A `'utxotx'` leaf's preimage is
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
and are free to drift — the `boxRecordBytes` / node-`deserializeBox` split. `readPruneEntry`
lives beside `writePruneEntry` in `serialization.ts`, and the tree round-trip exercises the pair.
Nothing crosses a package boundary unpaired.

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
`boxRecordBytes`). `serializePruneEntry` keeps its pre-migration name; renaming it is not in scope.

**The delegation is byte-identical by construction** — same writers, same order — so it is not
itself a consensus change. The consensus change is node's: the two leaf preimages stop being JSON.
See `NODE_INTERFACE` → C7.

### Sizing without encoding

`utxoTxTreeByteLength(t)` returns the byte length `encodeUtxoTxTree(t)` produces, computed from the
structure and allocating nothing. It is the measure `MAX_BLOCK_BODY_BYTES` is checked against.

**It is arithmetic rather than a call to the encoder because both consumers are on paths where
allocating the body is the wrong cost.** `verifyOrderingBlockStructure` runs on the gossip relay path
and would allocate a whole body per arriving block; node's block creator needs a per-entry delta while
filling, and re-encoding the candidate after each addition is quadratic. The terms are all knowable:
the tree is `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)` ‖ `arr(pruneEntries)`,
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
> ⚠ **The rows below were "left describing CBOR" and that wording is now the hazard.** Any row
> still describing a CBOR encode is describing the old format, **except** the `Stump` rows,
> where CBOR is still correct (carried register #6). Read a CBOR mention here as stale unless
> it names `Stump`.
>
> ⛔ **The exception used to name `Tx` as well, and it stopped being true when `encodeTx` went
> positional (2026-08-17).** `encodeTx` / `decodeTx` are `txIdBytes ‖ arr(signatures)` — see
> Layout — UtxoTransaction — and the rows below still say "CBOR encode"/"CBOR decode".
> ⚠ **An exception list is the worst place for a stale entry**: every other stale CBOR mention
> is caught by the disclaimer, and the ones it exempts are caught by nothing.

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
| `encodePost(post)` | `(Post) => Uint8Array` | CBOR encode |
| `decodePost(bytes)` | `(Uint8Array) => Post` | CBOR decode |
| `encodeStump(stump)` | `(Stump) => Uint8Array` | CBOR encode |
| `decodeStump(bytes)` | `(Uint8Array) => Stump` | CBOR decode |
| `encodeHeader(h)` | `(BlockHeader) => Uint8Array` | CBOR encode — the input to `blockHash` / `computePowHash` |
| `decodeHeader(bytes)` | `(Uint8Array) => BlockHeader` | CBOR decode |
| `encodeUtxoTxTree(t)` | `(UtxoTxTree) => Uint8Array` | CBOR encode (body section) |
| `decodeUtxoTxTree(bytes)` | `(Uint8Array) => UtxoTxTree` | CBOR decode |
| `utxoTxTreeByteLength(t)` | `(UtxoTxTree) => number` | The body's encoded length, computed from the structure without encoding it. Equal to `encodeUtxoTxTree(t).length` by pinned test — see Sizing without encoding |
| `serializePruneEntry(e)` | `(PruneEntry) => Uint8Array` | One entry's positional bytes. Both the tree codec's element writer and the `'prune'` Merkle leaf preimage — see Layout — Merkle leaf preimages |
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

How far back a reorg reaches. Universal, not per-network. Its consumers are all in
`@dagsocial/node`: the fork-walk bound, the block-journal retention window, and the load-time
refusal of a `MAX_PROOF_HISTORY` beneath it. **Journal retention is the hard bound on how deep a
reorg can physically go; the fork walk is policy**, and nothing requires the two to stay equal.

⚠ **`net`'s `msg-guards.ts` is not a consumer**, though it reads like one. It mentions
`MAX_REORG_DEPTH * 2` as *what fork resolution asks for*; the cap it actually enforces is
`MAX_CHAIN_RESPONSE_ITEMS = 400`. The two differ by 10×, and reading the prose as the limit
conflates a caller's request size with the bound applied to it.

**It lives here because node's `config.ts` cannot reach it anywhere else.**
`services/fork-resolution.ts` imports `config` itself, so a constant declared there is unreachable
from config load without a cycle. A load-time rule keyed on this value is only expressible with the
constant in this package.

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
  readonly bootstrapPeriodBlocks: number;

  // Emission schedule
  readonly creditFixedRateBlocks: number;
  readonly creditEpochBlocks: number;

  // Genesis
  readonly genesisCommitteeKeys: readonly string[];
  readonly genesisKarmaPerMember: bigint;
  readonly genesisCreditsPerMember: bigint;
  readonly genesisProofPayload: string;   // hex — the GenesisProofBox payload, distinct per network
  readonly genesisStateRoot: string;      // hex, 66 chars — the pinned height-0 AVL+ root
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
a local literal until phase 3a. A magic missing from the set is classified as not-a-frame,
falls through to the legacy raw-CBOR path, decodes as malformed, and **permanently bans the
peer** — so a stale copy turns a routine cross-network misconnection into a ban. Note the set
is consulted *only* for frames that fail the own-magic compare, so a stale copy does not
break same-network peering; the damage is entirely cross-network.

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

⚠ **Values are not pinned here.** `devnet`'s compressed timings and both public networks'
difficulty belong to the constants-pinning session. **Do not read any number in this
contract as decided** — with one exception: `KARMA_STALE_THRESHOLD_BLOCKS`'s duration is
ruled (user, 2026-08-19): **28 days**, 40320 at the nominal 60-second block.

### Domain tags are network-agnostic — deliberately

The five id-derivation domain tags — `BOX_ID_DOMAIN`, `TX_ID_DOMAIN`, `MINT_ID_DOMAIN`,
`IDENTITY_KEY_DOMAIN`, `POST_ID_DOMAIN` — **do not carry the network, and must not be
changed to.** No derivation function takes a network argument, and this package holds no
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
  `CREDIT_INITIAL_REWARD`, `CREDIT_REWARD_REDUCTION`,
  `GENESIS_CREDITS_PER_MEMBER`, and the node/UI faucet credit amounts.
- **Karma amounts → `bigint` literals, NOT rescaled** (karma is indivisible):
  `KARMA_POSTING_MINIMUM`, `KARMA_DECAY_AMOUNT`, `KARMA_MINIMUM`,
  `POST_LOCK_THREAD_COST`, `POST_LOCK_REPLY_COST`, `LIKE_KARMA_COST`,
  `INVITE_MIN_KARMA`, `INVITE_BOND_MIN`, `INVITE_BOND_MAX`,
  `VOUCH_KARMA_AMOUNT`, `VOUCH_MIN_BALANCE`,
  `GENESIS_KARMA_PER_MEMBER`.
- **Stay `number`:** all `*_BLOCKS`, `*_TARGET_BITS`/`*_FLOOR`,
  `LIKES_PER_KARMA_PAYOUT` (a count), `POST_LOCK_UNLOCK_PER_LIKES`, `MAX_*`,
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
export const MAX_TX_BYTES = 10_000;              // consensus — encoded UtxoTransaction
```

Consensus bounds on **weight**, checked in `@dagsocial/validation` — the body by
`verifyOrderingBlockStructure`, the transaction by `verifyTxStructure` — so an oversized object is
refused before relay rather than after storage. Distinct in kind from `### Content limits` above,
which are format bounds a codec enforces on one field; these bound whole structures and no codec
consults them.

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
> ⚠ **Separately, 28 days is itself probably the wrong duration.** The economics design
> track calls for a **short, days-scale window — "e.g. ~5, not 28"** — so this correction
> fixes the *unit* while leaving the *value* open. Do not read `40320` as a decided number;
> it is the faithful translation of a figure that is itself pending the constants-pinning
> session. **Two independent problems, and only one is fixed here.**

### Post lock

```typescript
export const POST_LOCK_THREAD_COST = 5;           // Karma locked for new threads
export const POST_LOCK_REPLY_COST = 3;            // Karma locked for replies
export const POST_LOCK_UNLOCK_PER_LIKES = 10;     // Every N likes unlocks 1 karma
```

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
```

### Genesis

```typescript
export const GENESIS_COMMITTEE_KEYS: string[] = [];        // consensus — TBD at genesis
export const GENESIS_KARMA_PER_MEMBER = 1000n;             // consensus
export const GENESIS_CREDITS_PER_MEMBER = 10000n * 10n ** 8n;  // consensus — 10000 credits in base units
export const BOOTSTRAP_PERIOD_BLOCKS = 10000;              // consensus — blocks before committee dissolution
```

### Mempool and encoding

```typescript
export const MEMPOOL_EXPIRY_BLOCKS = 720;          // local — blocks before mempool entries expire (~12h)
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';  // SPKI wrapper stripped from raw keys
```

### Credit emission (Ergo-style linear decay)

```typescript
export const CREDIT_FIXED_RATE_BLOCKS = 1_051_200;     // consensus — ~2 years at 60s blocks
export const CREDIT_INITIAL_REWARD = 100n * 10n ** 8n; // consensus — 100 credits/block, base units
export const CREDIT_EPOCH_BLOCKS = 129_600;            // consensus — ~90 days, reduction interval
export const CREDIT_REWARD_REDUCTION = 2n * 10n ** 8n; // consensus — 2 credits reduced per epoch
export const CREDIT_MINER_REWARD_DELAY = 1440;         // consensus — blocks before coinbase spendable (24h at 60s blocks)
export const COINBASE_TREASURY_PCT = 5;      // consensus — per income TERM: of emission and of fees, never of rent
export const COINBASE_MINER_FLOOR_PCT = 35;  // consensus — guaranteed, and takes every remainder
export const COINBASE_BACKER_PCT = 35;       // consensus — AHEAD OF CODE, falls to the miner floor
export const COINBASE_BONUS_PCT = 25;        // consensus — the inclusion bonus pool
export const INCLUSION_BONUS_K = 5n;         // consensus — the bonus curve's knee
export const MEMPOOL_CREDIT_SHARE_PCT = 50;  // policy — credit share of the pool
export const MIN_FEE_RATE_PER_BYTE = 0n;     // policy — relay floor, base units per IN-BLOCK byte
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

---

## Journal Event Types

`JournalEvent`:
```
{
  event: string,        // stable marker identifier
  level: "INFO" | "WARN" | "ERROR",
  timestamp: string,    // ISO 8601
  ...fields             // event-specific fields per JOURNAL_EVENTS.md
}
```

## DAG Structural Types

`CanonicalBranchEntry`:
```
{
  depth: uint32,
  postId: bytes[32]
}
```

`PostScore`:
```
{
  postId: bytes[32],
  cumulativeScore: uint64
}
```

---

## Preconditions
- Node.js ≥ 22
- `cbor-x` installed
- No other DAGsocial packages needed at build time

## Postconditions
- Build produces `dist/index.js` (ESM) + `dist/index.d.ts`
- All functions are pure — no side effects, no module-level state
- Types are importable by consumers without runtime cost (type-only imports)

## Invariants
- Must not import from `@dagsocial/node`, `@dagsocial/net`, or `@dagsocial/web`
- Hash algorithm: `blake2b512` with `.subarray(0, 32)` for all 32-byte outputs
- Base58 alphabet: Bitcoin-style (no `0OIl`)
- CBOR is the canonical wire format; JSON for HTTP API
- `protocolVersion` field present on all wire types
- Secret keys never in any exported type or serialized output
- Box identity is deterministic **and provenance-derived**:
  `blake2b512(BOX_ID_DOMAIN ‖ canonicalCbor(candidate) ‖ txId ‖ u32BE(index)).subarray(0,32)`
- `computeBoxId` takes **one argument**. Any need for a second means the box is missing
  provenance, which the `BoxCandidate`/`BoxBase` split is there to prevent
- `stored.id === computeBoxId(stored)` for every box in the UTXO set — no exceptions, no
  apply-time field mutation that the id does not cover
- Every id preimage carries a domain tag; box ids, tx ids and identity-record keys share one
  32-byte keyspace and must not be forgeable across it
- A box carries **no block height**. Consensus-relevant time lives in explicit named fields
  (`lockedUntilBlock`) or in committed per-identity state (`IdentityRecord.invitedAtBlock`,
  which is what dates a bond's probation) — never in an implicit creation stamp
- Box `value` is `bigint` integer base units (uniform across box types), `< BOX_VALUE_BOUND`
  so it CBOR-encodes as a uint64 (`0x1b`); no float math anywhere in consensus
  value arithmetic
- Post identity includes PoW nonce; signing hash excludes it
- `UserId` IS the 32-byte Ed25519 public key — no hashing, no separate account concept
