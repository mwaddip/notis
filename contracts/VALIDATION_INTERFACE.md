# VALIDATION Interface Contract

**Component:** `@dagsocial/validation`
**Protocol version:** 1
**Last updated:** 2026-07-24

## Scope

Stateless validation functions for DAGsocial. Pure functions — no I/O, no
database access, no side effects. Shared by `@dagsocial/net` (Stage 1 checks
before gossip forwarding) and `@dagsocial/node` (Stage 2 verification for
both local and relayed objects). Depends only on `@dagsocial/types`.

Exports from `packages/validation/src/index.ts`.

---

## PoW Verification

### verifyPoW

```
verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean
```

Encodes `nonce` as an 8-byte little-endian unsigned integer, concatenates
`input || nonceBytes`, hashes with blake2b512, takes first 32 bytes, checks
that the result has at least `targetBits` leading zero bits.

Used for post PoW verification in both Stage 1 (gossip) and Stage 2 (node).

### verifyOrderingBlockPoW

```
verifyOrderingBlockPoW(header: BlockHeader): boolean
```

Computes the PoW preimage via `computePowHash(header)`, encodes `header.powNonce`
as u64 LE, hashes `preimage || nonceBytes` with blake2b512, takes the first 32
bytes, and checks that the result has at least `header.powTargetBits` leading zero
bits. Guards its inputs (M-5 / M-6): returns `false` — never throws — if the
header is not CBOR-encodable, or if `powNonce` / `powTargetBits` is not a
non-negative safe integer.

Checks the solution against the header's **own** `powTargetBits` only. It does
**not** enforce a floor or the height-scheduled target: the
`ORDERING_BLOCK_POW_TARGET_FLOOR` lower bound is a gossip pre-filter inside
`verifyOrderingBlockStructure`, and the authoritative height-scheduled target is
enforced at block apply (`@dagsocial/node`, audit M-2 — see NODE_INTERFACE
"Ordering block apply-time authorization"). A producer that writes a low target
into its own header still passes this function; the apply-time check is what
rejects it.

Used by nodes to verify ordering-block PoW before applying a relayed block, and by
the block creator to verify externally-submitted mining solutions.

### computePowHash

```
computePowHash(header: BlockHeader): Buffer | null
```

**This function establishes its own domain** (Phase 1f). It returns `null` on exactly the inputs
`verifyHeaderFieldDomains` rejects and the 32-byte preimage otherwise — see `blockHash` below for the
full reasoning, which applies identically here.

Computes the preimage the PoW nonce hashes against: takes the header with
`powNonce` set to `0`, CBOR-encodes it (`encodeHeader`), and returns
`blake2b512(encoded).subarray(0, 32)`. The preimage is over the **header**, not a
separate "block body" — it covers `protocolVersion`, `height`, `prevBlockHash`,
`subBlockRoot`, `utxoTxRoot`, `stateRoot`, `validatorId`, `powTargetBits`, and
`createdAt`, with `powNonce` zeroed. The block *body* (sub-blocks, UTXO txs,
coinbase outputs) is committed **transitively**: `subBlockRoot` / `utxoTxRoot` are
Merkle roots over it and `stateRoot` is the AVL+ digest, so any body change alters
a root and therefore the preimage. `validatorSignature` is not a header field, so
it never enters the preimage. Exposed to external miners (hex) at
`GET /mining/template` as `powPreimage`.

### blockHash

```
blockHash(header: BlockHeader): string | null
```

The canonical block hash: `blake2b512(encodeHeader(header)).subarray(0, 32)` as a
64-char hex string — the header with its **solved** `powNonce` (unlike the PoW
preimage, which zeroes it). Used as the next block's `prevBlockHash` chain link,
and as the message the validator signs — `verifyValidatorSignature` recomputes it.
Because `validatorSignature` lives on the block and not in the header, `blockHash`
is stable before and after signing.

**This function establishes its own domain** (Phase 1f). It returns `null` exactly when
`verifyHeaderFieldDomains` rejects the header and the 64-char hex hash otherwise. Before Phase 1f it
returned `string` and performed **no input check at all**, handing `header` straight to `encodeHeader`.

> **Why the guard went inside rather than being required of callers.** `blockHash` had an
> unenforced precondition and 13 `src` call sites, each independently responsible for remembering it.
> `isEncodableHeader` was that precondition written down — and applied at three of them. The
> enumeration behind Phase 1f (spec §6.2) found a caller that reaches this function with peer-supplied
> data that has passed no check whatsoever: `net`'s `requestHeaders` returns
> `decode(response) as BlockHeader[]` — a raw cbor decode with a cast, not even an `Array.isArray` —
> and node's fork resolution hands those bare headers straight here.
> `verifyOrderingBlockStructure` **cannot** cover that path: it takes an `OrderingBlock` and the path
> carries bare headers. A check the caller must remember to invoke is the shape the spec blames for
> this whole defect class (§2.1), and Phase 1d had already ruled the same way for
> `verifyPostFieldDomains`.
>
> **Two distinct failures this closed, and only one of them is a panic.** After Phase 3 the
> fixed-width header fields become `b32`/`b33` writers, which throw — that is the visible half. The
> half a panic-shaped search cannot see is `createdAt`: it has **no domain check anywhere in the
> repo**, and its writer is `vlqU`, which is total *by sentinel*. So it does not throw — it
> **collides**. `NaN`, `-1`, `1.5` and `2^60` all encode to `VLQ_SENTINEL`, giving distinct headers
> one `blockHash`, one PoW preimage and one signature verdict. `cbor-x` distinguishes those values
> today, so Phase 3 would *introduce* that malleability rather than inherit it.
>
> **Consumers absorb an absence, not a rule.** No caller learns the header domain or decides what
> well-formed means; that knowledge stays in this package. `net` gains no validation logic at all.

---

## Signature Verification

### verifyPostSignature

```
verifyPostSignature(post: Post, publicKey: Uint8Array): boolean
```

Wraps the 32 raw Ed25519 public key bytes in an SPKI DER envelope
(`302a300506032b6570032100` prefix), creates a `KeyObject` via
`crypto.createPublicKey`, and calls `crypto.verify(null, signingHash(post),
keyObj, signature)`. Returns `true` iff the signature is valid.

The caller is responsible for looking up the author's public key — this
function receives it as a parameter and performs no I/O.

### verifyValidatorSignature

```
verifyValidatorSignature(header: BlockHeader, signature: Uint8Array): boolean
```

Verifies that `signature` is a valid raw Ed25519 signature over the block hash,
made by the key declared in `header.validatorId`. Recomputes the signed message
as `Buffer.from(blockHash(header), 'hex')` — the 32 raw bytes of
`blake2b512(encodeHeader(header))[:32]`, the exact value the block creator signs
(`crypto.sign(null, Buffer.from(blockHash(header), 'hex'), validatorPrivKey)`).
Wraps the 32-byte `header.validatorId` in an SPKI DER envelope, builds a
`KeyObject`, and calls `crypto.verify(null, message, keyObj, signature)`. Returns
`true` iff the signature verifies.

`validatorSignature` lives on the block, **not** in the header, so
`blockHash(header)` is stable before and after signing — verification recomputes
it from the received header and checks the signature against `header.validatorId`.
A block whose `validatorId` names a key the producer does not hold (a forged
authorship) fails this check. Mirrors `verifyPostSignature`; like it, the caller
supplies the public key (here the header's own `validatorId`) and the function
performs no I/O.

**No-panic (M-5).** Returns `false` — never throws — on malformed input: a
`signature` that is not a byte view, or any header outside the domain, which
since Phase 1f is **one** guard rather than two. `blockHash` returns `null` on
exactly the headers `verifyHeaderFieldDomains` rejects, and its non-null return
*proves* `validatorId` is exactly 32 bytes — which is what keeps the SPKI wrap and
`createPublicKey` ("Failed to read asymmetric key") out of reach without a
separate length check here. A wrong-*length* signature is left to `crypto.verify`,
which rejects it cleanly, matching `verifyPostSignature`.

---

## Protocol Version

### verifyProtocolVersion

```
verifyProtocolVersion(version: number): boolean
```

Returns `true` iff `version === PROTOCOL_VERSION` (currently `1`).
Rejects all other versions.

---

## Content Limits

### verifyContentLimits

```
verifyContentLimits(content: string): { valid: boolean; error?: string }
```

Rejects empty content and content exceeding `MAX_CONTENT_BYTES` (300)
in UTF-8 byte length. Accepts 1–300 bytes inclusive.

### verifyParentRefsCount

```
verifyParentRefsCount(refs: string[]): { valid: boolean; error?: string }
```

Rejects if `refs.length > MAX_PARENT_REFS` (**1**). Accepts 0 or 1 refs.

### verifyContentCharacters

```
verifyContentCharacters(content: string): { valid: boolean; error?: string }
```

Rejects content containing any character in Unicode categories `Cc` (control),
`Cf` (format), `Cs` (surrogate), or `Co` (private use), with the single
exception of `\n` (U+000A, line feed). This blocks zero-width characters
(ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D), bidi controls (U+200E–200F,
U+202A–202E, U+2060–2064, U+2066–206F), tag characters (U+E0000–E007F),
BOM/interlinear/soft-hyphen and other format codepoints, control characters
(null, backspace, `\r`, `\t`, escape sequences), surrogates, and private-use
codepoints. Allows all letters, marks, numbers, punctuation, symbols,
separators, emoji, unassigned codepoints, and `\n`.

**Version-independence (M-4).** This is a **consensus Stage-1 check**, so every
node must reach the same verdict for the same bytes. It therefore may **not** be
implemented with runtime Unicode general-category escapes (`\p{C}` / `\P{C}`):
`\P{C}` excludes `\p{Cn}` (unassigned), whose membership shifts as each Node/V8
build ships a newer Unicode data version, so two nodes on different builds would
diverge on any codepoint that has since been assigned. Instead the check is a
table of **explicit numeric codepoint ranges** — the union of `Cc`/`Cf`/`Cs`/`Co`
enumerated at one **pinned Unicode version** (documented in code), minus U+000A.
`Cn` (unassigned) is deliberately **not** rejected; allowing it is what removes
the version dependence. The verdict is then identical on every runtime regardless
of its Unicode data version. Pure stateless check, applied unconditionally to all
post content; covered by a test asserting the ranges match the pinned version and
that the verdict does not consult runtime category data.

---

## Structural Validation

### verifyPostFieldDomains

```
verifyPostFieldDomains(post: unknown): { valid: boolean; error?: string }
```

The **fixed-width domain pin** (Phase 1c, `5c0bf71`). Carries the type checks
`isSignablePost` has always made, and adds three width rules:

- `author` is a `Uint8Array` of **exactly 32 bytes**
- `challenge` is a `Uint8Array` of **exactly 32 bytes**
- every `parentRefs` entry matches `/^[0-9a-f]{64}$/` — 64 **lowercase** hex

**Why lowercase is load-bearing, not stylistic.** `'AB…'` and `'ab…'` hex-decode
to the same 32 bytes. Accepting both would make the hex→bytes conversion at the
codec boundary non-injective: two distinct in-memory posts, one preimage, one
id. That is precisely the malleability the M-1 field encoding exists to close,
arriving from the codec side instead of the concatenation side.

**Why it exists.** The positional wire format encodes these three fields
fixed-width, and fixed-width writers cannot carry a sentinel, so they throw (see
`TYPES_INTERFACE.md` → Totality). `signingHash` is reached with malformed posts
by design, so without this pin the migration would put a throw in a path this
contract requires never to throw — the M-5/M-6 regression.

**This is not only tightening the already-unusable.** A post with a
64-character *non-hex* `parentRef` passes the entire Stage-1 pipeline today —
content, characters, ref count, version, PoW *and signature* — because the ref
is hashed as UTF-8 text and the signature covers those same bytes. Rejecting it
is a real behavioural change. `author` and `challenge` widths, by contrast, were
already fatal two steps later at `verifyPostSignature`.

Total on adversarial input, like every function here.

### verifyHeaderFieldDomains

```
verifyHeaderFieldDomains(header: unknown): { valid: boolean; error?: string }
```

Added by Phase 1f. It **replaced** the private `isEncodableHeader`, which is deleted, and is the
single source of the header's encodable domain.

The header's counterpart to `verifyPostFieldDomains`, and the reason it is one function rather than
two: **the header domain used to be written down twice.** `isEncodableHeader` stated it as types
only — `typeof prevBlockHash === 'string'` with no width and no alphabet, a bare `isBytes(validatorId)`
with no length. `verifyOrderingBlockStructure` stated it again with widths and alphabets (Phase 1e).
Two implementations of one domain drift; that is the class the positional format exists to close, so
1f collapsed them and both callers use this.

The domain, by field:

| Field | Domain | Writer it feeds |
|---|---|---|
| `protocolVersion` | non-negative safe integer | `vlqU` |
| `height` | non-negative safe integer | `vlqU` |
| `prevBlockHash` | `/^[0-9a-f]{64}$/` | `b32` |
| `subBlockRoot` | `/^[0-9a-f]{64}$/` | `b32` |
| `utxoTxRoot` | `/^[0-9a-f]{64}$/` | `b32` |
| `stateRoot` | `/^[0-9a-f]{66}$/` — **66, not 64** (`hex(33)`) | `b33` |
| `validatorId` | `Uint8Array`, exactly 32 bytes | `b32` |
| `powNonce` | non-negative safe integer | `vlqU` |
| `powTargetBits` | non-negative safe integer | `vlqU` |
| **`createdAt`** | **non-negative safe integer** — new in 1f | `vlqU` |

⛔ **The table used to carry a `networkType` row, marked AHEAD OF CODE for Phase 3. That header field
is REJECTED (2026-08-10)** — see `TYPES_INTERFACE` → Block header and `ARCHITECTURE §How the network
is committed`. The row is deleted rather than deferred; there is no header field for it to describe.

**This package's part in why it failed is worth keeping.** The note here used to say the profile
match — whether a block's network is *ours* — "is a separate check and belongs at the structure
gate", on the sound reasoning that a block for another chain is well-formed, just not ours, and that
folding the match into this function would make an encodable header report as unencodable. That
reasoning was right; the destination was not. **`verifyOrderingBlockStructure` is in this package,
which is contractually pure and stateless and cannot read the node's profile**, so the check had
nowhere to live. Two other contracts pointed at the same non-existent home. **A rule routed to a
package that structurally cannot run it reads as scheduled work and is actually a dead end** — worth
checking for directly, because nothing about the wording distinguishes the two.

**Every remaining field's domain is a shape, not a closed set**, so this function is uniformly a
well-formedness check with no membership tests left in it.

**`createdAt` is the field nothing checked.** One occurrence in the whole package before 1f
(`isEncodableHeader`, `typeof === 'number'`, which admits `NaN`, `±Infinity`, `-1` and `1.5`), none
in `net`, and `verifyOrderingBlockStructure` never touched it. Every other `vlqU` header field is
pinned on both the gossip and apply paths; this one was pinned on neither.

**It is a domain pin, not a clock policy.** `createdAt` is a producer-set wall-clock value that no
node validates against anything, exactly as in every chain in the lineage, where it exists as a
record for explorers. 1f constrains it *only* to what `vlqU` can encode faithfully. It deliberately
adds **no monotonicity rule and no skew window** — those are consensus rule additions, not encoding
constraints, and this contract's "never add checks the reference lacks" applies. Note also that the
reason Bitcoin and Ergo *do* bound their timestamps — difficulty adjustment, and the timewarp class —
has no analogue here. ⚠ **Corrected 2026-08-09: this previously said "node derives the target from
height, not time", which is not what the code does.** `expectedTarget(_height)`
(`node/src/services/difficulty.ts`) **ignores its argument** and returns
`config.orderingBlockPowTargetBits` — a constant, sourced from the network profile, with the height
parameter reserved as the seam a real retarget will need. The conclusion is unchanged and in fact
stronger: a constant target has no adjustment algorithm for a timestamp to attack. **Revisit this
paragraph if a retarget is ever designed**, because that is the change that makes `createdAt` a
consensus input rather than a record.

**Byte fields are checked with `isBytes`, never a bare `.length`.** Phase 1e found `validatorId`,
coinbase `owner` and `validatorSignature` checked by character count, so a *string* of the right
length satisfied a check whose purpose was establishing bytes. A 64-character string, `{length: 64}`
and a 64-element `Array` all pass a length check and none of them encode.

**Returns a reason, not a boolean.** `verifyOrderingBlockStructure` must keep emitting its existing
error labels unchanged — Phase 1c established that a rejection's *diagnosis* is not subsumed by the
rejection, and Phase 1e's teeth demonstration asserts exact labels.

Total on adversarial input, like every function here.

### verifySubBlockStructure

```
verifySubBlockStructure(sb: SubBlock): { valid: boolean; error?: string }
```

Checks: `post` present, `subBlockId` present, `protocolVersion` is a number,
`producerId` present, **and `verifyPostFieldDomains(sb.post)`**. Returns
`{ valid, error }`. (The `likeBoxes` array check died with the sidecar field —
P2-D.)

The domain check is here rather than only in `isSignablePost` because this is
the shared gate the relay path already passes through: `net`'s
`runStage1SubBlock` calls it at `gossip.ts:201`, before `:222` builds the PoW
preimage. Placing it here closes that path **without any edit to
`@dagsocial/net`**.

> ⚠ **It does NOT yet close the node's two verifier functions or the content
> sweep.** `verifyPost`, `verifyPostForRelay` and `content-sweep.ts:92` reach
> the preimage without passing through either entry point — booked to Phase 1d.
> See `TYPES_INTERFACE.md` → Totality, obligation 2.

### verifyTxStructure

```
verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string }
```

Checks: `tx` is an object, `inputs` is a non-empty array, `outputs` is a
non-empty array, no duplicate inputs, and `protocolVersion` is a number. That is
the whole list.

**It does not check `likeTarget`**, and this contract wrongly said it did until
2026-08-09 — see the correction under `verifyOrderingBlockStructure` below. The
field *is* domain-pinned, just not here: node's `checkTxEnvelope` requires it to
be 64 lowercase hex when present (`utxo-engine.ts`, `validateTx` step 0), which
is what establishes the domain for the `opt(b32)` writer in `txIdBytes`. The
claim was misplaced, not a missing check — but a contract that names the wrong
layer is how a later reader deletes the real check as redundant.

Also does NOT check UTXO conservation, guard satisfaction, or the like
biconditional (`likeTarget` ⟺ deficit) — those are Stage 2 (stateful) checks.

### verifyOrderingBlockStructure

```
verifyOrderingBlockStructure(block: OrderingBlock): { valid: boolean; error?: string }
```

Checks: `prevBlockHash` present and non-empty, `subBlockRefs` is an array,
`subBlockEntries` is an array aligned 1:1 with `subBlockRefs` where every entry
has a 64-char `postId`, a `parentRefs` array of ≤ `MAX_PARENT_REFS` 64-char strings, and a
64-char `author` (the consensus-carried authorship claim, audit H-3),
`validatorSignature` is 64 bytes, `height` ≥ 1, `protocolVersion` is a number,
`powNonce` is a non-negative number,
`powTargetBits` ≥ `ORDERING_BLOCK_POW_TARGET_FLOOR` (4), `coinbaseOutputs` is
an array with each output having a 32-byte `owner` and a non-negative `bigint`
`value` (P0; box/coinbase values are `bigint` — this is the loose structural
pre-filter, the authoritative `< 2⁶⁴` bound lives in node's apply-time
`checkOutputValues`, matching the existing loose-structural / tight-apply split)
and `lockedUntilBlock` ≥ `block.height`.

Also checks **`pruneEntries`**: an array, each entry an object with a 64-char
`rootPostHash`, a `subtreePostIds` array of 64-char strings, a 32-byte
`subtreeMerkleRoot`, a 32-byte `authorId`, a 64-byte `authorSignature`, and a
`trigger` of exactly `"author"` or `"storage_prune"`. Byte-length fields must
be `Uint8Array`, not merely length-bearing — a CBOR payload can put any type
in any field, and the consumers of these fields call `Buffer.from(...)` and
`createHash().update(...)`, which throw on a number or object. Structure
validation is the layer that guarantees they never see one.

Structure-only: `author` is checked for shape here, not truth — binding it to
the real post (when content is locally present) and to prune authorization is
stateful and lives in `@dagsocial/node` (see `NODE_INTERFACE.md`).

Every check is total: adversarial input yields `{ valid: false }`, never a
throw. That is what lets the block-apply funnel treat this function as its
gate (see `NODE_INTERFACE.md`, "Structure validation in the apply funnel").

**Correction, 2026-08-09.** This description previously listed *"`hash` present and non-empty"*.
There is no `hash` field on `BlockHeader` or `OrderingBlock` and this function has never checked
one — grep-verified against the types and the implementation. Removed rather than implemented: the
block hash is *derived* from the header by `blockHash`, never carried in it, and a self-reported
hash field would be exactly the "trust the object's own claim" pattern this package exists to
refuse. Recorded because it is the second contract-vs-code divergence found in this file during the
wire-format bundle; the first (`verifyTxStructure` documented as checking `likeTarget`, which it does
not) was **closed 2026-08-09** — see that function above. Both were found by reading the code beside
the claim rather than by any sweep, which is the argument for the standing contract-vs-code audit.

**The header-field checks in this function** (`prevBlockHash`, `subBlockRoot`, `utxoTxRoot`,
`stateRoot`, `validatorId`, `height`, `protocolVersion`, `powNonce`, `powTargetBits`) are
**delegated to `verifyHeaderFieldDomains`** (Phase 1f), which is the single statement of that
domain. The error labels this function emits did not change — that is why the predicate returns a
reason rather than a boolean, and Phase 1e's teeth demonstration asserts those strings exactly. The
block-level checks (entry alignment, `pruneEntries`, `utxoTxIds`, `utxoTxs`, `coinbaseOutputs`,
`validatorSignature`) stay here: they are not header fields and no header predicate can see them.

> ⚠ **AHEAD OF CODE — this function shrinks to its semantic residue.** Under the positional wire
> format (`docs/specs/2026-08-09-positional-wire-format.md`), *structure* is guaranteed by the
> decoder: a block that decodes has every declared field, at its declared type and length, with no
> unknown keys. Field-presence checks, `typeof` checks, 64-char hex checks, `isBytes` checks and the
> `trigger` enum check all become dead code and are deleted with it.
>
> **What survives, because a codec cannot know it:**
>
> | Check | Why the codec can't |
> |---|---|
> | `parentRefs.length ≤ MAX_PARENT_REFS` | it is a protocol rule, not a shape |
> | `height ≥ 1` | genesis is a semantic floor |
> | `powTargetBits ≥ ORDERING_BLOCK_POW_TARGET_FLOOR` | a policy floor |
> | `lockedUntilBlock ≥ block.height` | cross-field, needs the header |
> | `utxoTxIds.length === utxoTxs.length` | two independently-counted arrays |
> | **`Number.isSafeInteger(height)`** | see below — this one gets *more* important |
>
> **The safe-integer check must not be deleted as redundant.** Today it lives in net's gossip
> validator as an add-on (audit M-6) because the structural bound `height ≥ 1` admits NaN and floats.
> Under VLQ the hazard changes shape but grows: `vlqU` decodes the full u64 range, so a height above
> 2^53 is *well-formed* at the codec layer and silently loses precision the moment it becomes a JS
> `number`. Every VLQ-sourced value that reaches `number` needs this bound, and it belongs here
> rather than only in net — the sync path does not pass through the gossip validator.
>
> Checks that die because the codec subsumes them: non-negative `value` and `powNonce` (`vlqU` is
> unsigned by construction), `protocolVersion is a number`, every byte-length assertion, and the
> `subBlockRefs`/`subBlockEntries` alignment — the latter because `subBlockRefs` no longer exists
> (see `NODE_INTERFACE.md`).
>
> **Deleting checks needs the care of adding them.** Use the established deletion proof: exhaustive
> grep-to-zero plus diff purity, mutation only where behaviour changes.
>
> ⚠ **Phase 8 must ADD as well as shrink, and the plan does not currently say so.** Flagged by Phase
> 1c. This function checks `postId`, each `parentRefs` entry, and `author` with `.length !== 64` and
> **no hex-alphabet check** (`verify.ts:361-377`). Under the new layout those strings become
> hex→bytes inputs at the codec boundary, so a 64-character *non-hex* `postId` throws exactly the
> way a post's `parentRef` would — the defect Phase 1c just closed for posts, reappearing on the
> ordering-block path.
>
> A pure shrink phase would therefore *acquire* it. The alphabet checks must land before, or with,
> the codec migration of the block structs — not after. Same reasoning as
> `TYPES_INTERFACE.md` → Totality, obligation 2; same failure mode; different entry path.

### verifyBlockChainLink

> ⚠ **NEVER BUILT as described, and it has no production caller.** The function exists but
> nothing in `packages/node/src` calls it — the chain-link check on the live path is done
> elsewhere. It also documents fields that **stopped existing on 2026-07-24**, and the same
> refactor left a phantom `hash` check in the structure list below. Kept so it is not
> re-adopted on the assumption that it is the sanctioned chain-link check; **verify what
> the apply path actually does before relying on this signature.**

```
verifyBlockChainLink(block: OrderingBlock, prevBlock: OrderingBlock): boolean
```

Returns `true` iff `block.prevBlockHash === prevBlock.hash` and
`block.height === prevBlock.height + 1`. Pure chain-link check — does
not verify PoW, signatures, or UTXO state transitions.

---

## Phased Validation Pipeline

Validation runs in order of increasing cost. A post failing phase N is
rejected before phase N+1 executes.

**Phase 1 — Structural (cheapest):**
- Post deserializes without error
- All required fields present
- `protocolVersion` is supported
- `content.length` within [1, MAX_CONTENT_BYTES]
- `parentRefs.length` within [0, MAX_PARENT_REFS]

**Phase 2 — Cryptographic (cheap):**
- `verifyPostSignature(post)` passes
- `verifyPoW(post, targetBits)` passes

**Phase 3 — DAG integrity (moderate):**
- Every `parentRefs[i]` exists in local DAG or unconfirmed pool
- Parent linkage consistent with canonical branch at that depth
- No duplicate post in local DAG (idempotent — treated as no-op, not error)

**Phase 4 — Content (variable cost, deferrable):**
- `verifyContentCharacters(content)` passes (no Unicode category C except \n)
- Content-specific validation (future: homoglyph detection, media checks)

**Watermarks:**
- `post_indexed_height`: advanced after Phase 3
- `post_validated_height`: advanced after Phase 4

Invariant: `post_validated_height <= post_indexed_height <= dag_tip_height`.
External queries serve only up to `post_validated_height`.

> ⚠ **NEVER BUILT — NOT PLANNED.** Neither identifier exists anywhere in `packages/`.
> The invariant has nothing to hold between, and **"External queries serve only up to
> `post_validated_height`" is false — every query serves the DAG tip.** The two
> similarly-named values that do exist in `dag_meta` are **write-only `+1` counters**:
> nothing reads them, nothing resets them on reorg, and they are not heights.
>
> Kept rather than deleted so this is not re-added as an apparent oversight. The same
> claim also appears in `NODE_INTERFACE.md → Service Layer Architecture` — **if this is
> ever built, both must change together.**

**Protocol vs. local-policy rules:**
- Phases 1-3 are protocol rules — all nodes must enforce identically
- Phase 4 may include local-policy rules — configurable, non-consensus
- Local-policy rules are explicitly documented as such

---

## Usage in the Validation Pipeline

```
Stage 1 (@dagsocial/net — topic validators, before mesh forwarding)
  ├── verifySubBlockStructure
  ├── verifyContentLimits
  ├── verifyContentCharacters
  ├── verifyParentRefsCount
  ├── verifyProtocolVersion
  ├── verifyPoW
  └── (signature deferred to Stage 2 — requires DB lookup for public key)

Stage 2 (@dagsocial/node — on* callbacks, after gossip receipt)
  ├── All Stage 1 checks re-run (defense in depth)   [⚠ FALSE — see below]
  ├── verifyPostSignature (now with public key from identity store)
  ├── Parent ref existence (DB lookup)
  └── Karma sufficiency (UTXO state)
```

> ⚠ **"All Stage 1 checks re-run" is FALSE, and the way it is false is the dangerous part.**
> Stage 2 does not call the Stage 1 functions. It **reimplements three of the six inline**,
> at inconsistent strictness — including a content-length check measured in **UTF-16 code
> units against a byte constant** (`MAX_CONTENT_BYTES` is 300 **UTF-8 bytes**), so any
> non-ASCII post is measured wrongly at the API boundary.
>
> The defect is not the missing re-run — it is that a reimplementation looks like defence in
> depth while being a **second implementation of a validity rule**, i.e. a mirror. Two
> copies of a rule diverge; that is what mirrors do. **Stage 2 must call the same exported
> functions Stage 1 calls**, so there is one implementation of each check.
>
> Related and unresolved: every numeric bound in `verifyOrderingBlockStructure` is
> `typeof === 'number'` plus a comparison, so `NaN`, `±Infinity` and floats pass the
> structure gate. `@dagsocial/net` already compensates for this **at its call site rather
> than at the gate**, and neither contract records that arrangement — so "fixing" either
> side in isolation breaks the other.

```

Block receipt (@dagsocial/node)
  ├── verifyOrderingBlockStructure
  ├── verifyBlockChainLink (against previous block)
  ├── verifyOrderingBlockPoW
  ├── verifyValidatorSignature (blockHash(header) signed with validatorId's key)
  │     — enforced inside applyOrderingBlock, the funnel every apply path
  │       (gossip, sync, reorg) passes through, so no path can skip it
  └── State application (UTXO, sub-block confirmation, mempool cleanup)
```

PoW is verified in both stages for posts — Stage 1 blocks invalid-PoW spam from
propagating; Stage 2 re-verifies for defense in depth. Ordering block PoW is
verified at receipt time only.

---

## Preconditions
- Node.js ≥ 22 (blake2b512 via `crypto.createHash`)
- `@dagsocial/types` package built and importable
- `crypto.createPublicKey` and `crypto.verify` available for Ed25519

## Postconditions
- All exported functions are pure: same inputs → same outputs, no side effects
- No I/O, no DB access, no network calls
- Callable from any context (gossip event handler, HTTP route handler, test)
- **No-panic (M-5).** No exported verify function throws on malformed or
  adversarial input — each returns `false` / `{ valid: false }` instead. Inputs
  arrive straight off the wire and may be wrongly typed or out of range
  (non-string `content`, non-array `parentRefs`, a public key or `validatorId`
  that is not 32 bytes, a block header that is not CBOR-encodable, a nonce that
  is negative / `NaN` / float / beyond `u64`). Every such case is a clean
  rejection, never an exception. Guard the throwing operations
  (`Buffer.byteLength`, `createPublicKey`, `encodeHeader`,
  `BigInt`/`writeBigUInt64LE`, `.length`) with type/shape checks first.

  **Phase 1f extended this rule past the `verify*` functions.** "No exported verify function
  throws" left `blockHash` and `computePowHash` outside the guarantee, because they are not
  verifiers — and they are the two that call `encodeHeader` directly, with no check at all. The rule
  is therefore **no exported function throws on adversarial input**, and a function with no `false`
  to return says so with `null`. This was not a new principle; it is the existing one applied where
  the naming convention had quietly exempted it.

## Invariants
- All hashing uses `blake2b512.digest().subarray(0, 32)` — Node.js v22
  lacks blake2b256
- Signatures verified with `crypto.verify(null, signingHash, keyObj, sig)`
  using a `KeyObject` created via `crypto.createPublicKey`
- SPKI DER prefix for Ed25519: `302a300506032b6570032100`
- PoW nonce encoded as 8-byte little-endian unsigned integer, after an
  integer-range guard (M-6): a nonce or `targetBits` that is not a non-negative
  safe integer within `u64` yields `false`, never a thrown `RangeError` from
  `BigInt` / `writeBigUInt64LE`. Validate with `Number.isInteger` (not a loose
  `typeof === 'number'`, which admits `NaN` and floats)
- Content limits measured in UTF-8 bytes, not characters
- All functions are synchronous — no Promises, no callbacks
- Protocol version `PROTOCOL_VERSION` from `@dagsocial/types`
- Ordering-block hashing is over the **header**. The PoW preimage
  (`computePowHash`) is the encoded header with `powNonce` zeroed; the canonical
  `blockHash` is the encoded header with the solved `powNonce`. Neither includes
  `validatorSignature` — it is not a header field. The body binds via the header's
  `subBlockRoot` / `utxoTxRoot` / `stateRoot`.
