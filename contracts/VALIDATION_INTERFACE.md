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

### powTarget / meetsPowTarget

```
powTarget(targetBits: number): Uint8Array | null
meetsPowTarget(hash: Uint8Array, target: Uint8Array): boolean
```

The single PoW admission rule. `powTarget` expands a target-bits count into the **inclusive** 32-byte
maximum acceptable digest; `meetsPowTarget` answers `hash <= target`, both read big-endian. Every PoW
question in the repo — the verifier's and every solver's — is this pair and nothing else.

A *solver* that holds no predicate and asks the verifier instead — `node/test/helpers.ts`'s
`solveHeaderPow` is the example — inherits this rule with no edit and is the shape to prefer. **"PoW
solvers" and "PoW predicates" are different enumerations**; only the second should ever be counted
when asking how many places implement this rule.

`powTarget` returns `null` for a `targetBits` that is not a safe integer in `[0, 256]`. A caller reads
`null` as "no digest can satisfy this" and answers `false`. Neither function throws, on any input.

**Inclusive, not exclusive.** The exclusive threshold `2^(256 − targetBits)` is `2^256` at
`targetBits = 0` and is not representable in 32 bytes. The inclusive `2^(256 − targetBits) − 1` is
`0xff × 32` at one end and `0x00 × 32` at the other, so both extremes are ordinary values and the
domain needs no special case.

**Why a pair rather than one function.** The expansion is the half that changes when difficulty stops
being a whole number of bits; the comparison never does. Splitting them is what lets a retarget replace
the schedule without touching the admission rule — difficulty-retarget spec, Unit 2. `meetsPowTarget`
is unchanged by that retarget and is shared by both expansions; `orderingPowTarget` below is the
half that moved.

> ⚠ **AHEAD OF CODE.** Once `orderingPowTarget` lands, **this function serves post PoW alone** — fixed
> difficulty, never retargeted (user, 2026-08-12) — and keeps whole bits over `[0, 256]`. Ordering-block
> headers stop using it. The two are not interchangeable and share a type: passing a 1/256-bit value
> here is refused only because it exceeds 256.

**Solvers hoist the expansion.** `powTarget` depends only on `targetBits`, so a solver derives it once
per template and calls `meetsPowTarget` per nonce. Deriving it inside the loop allocates once per hash.

**Two consumers cannot import this package and mirror it instead** — `public/index.html` (served
statically, no bundler) and `scripts/miner.mjs` (standalone by decision: it depends on `node:crypto`
alone and runs on a machine that does not build the workspace). Each is held by a test that extracts
the declaration **by name** and cross-checks it against this package. A mirror that stops finding its
declaration fails, which is the property it exists for.

### orderingPowTarget

> ⚠ **AHEAD OF CODE.** This section states the rule; the function does not exist yet. It lands on this
> branch. Until it does, `verifyOrderingBlockPoW` and `blockWork` read `powTargetBits` as whole bits.

```
orderingPowTarget(scaledBits: number): Uint8Array | null
```

Ordering-block difficulty in units of **1/256 of a bit**, so a target between two whole bits is
expressible. Post PoW is **not** in these units and never retargets — it keeps `powTarget` above.

**The rule is a triple, and all three clauses are consensus.** The predicate pins the target's *value*
and pins neither its domain nor its width; an implementation can satisfy it exactly and still fork.

1. **Domain.** `scaledBits` is an integer in `[0, 65536]`. Outside it the answer is `null`, and the
   refusal is normative rather than input hygiene: at `65537` an implementation computing in rationals
   finds `R = 0` and a target of `−1`, which renders as `0xff × 32` and admits every digest.
2. **Predicate.** The target is `R − 1`, where `R` is the unique integer with
   `R^256 ≤ 2^(65536 − scaledBits) < (R+1)^256`. Uniqueness holds because `x ↦ x^256` is strictly
   increasing on the non-negative integers.
3. **Rendering.** Exactly **32 bytes, big-endian, left-zero-padded.** `meetsPowTarget` iterates
   `target.length`, so the width is part of the admission rule and **it cannot detect a wrong one**: at
   `scaledBits = 63358` the target is 363, and a minimal-width rendering — what
   `BigInt.prototype.toString(16)` produces — yields two bytes that admit a `2^248` digest the correct
   target refuses.

⚠ **The root is irrational** whenever `scaledBits` is not a multiple of 256. What is exact is its
*floor*, and the predicate is what pins that. "The target is an exact integer root" is a paraphrase
that misleads whoever implements this.

**Inclusive, as `powTarget` is**, and for the same reason plus one more: `target + 1` is exactly `R`,
which is what keeps the work quotient below exact at every whole bit.

**At every whole bit the two functions agree byte for byte** — `orderingPowTarget(256n)` equals
`powTarget(n)` for all `n` in `[0, 256]`, because `2^(65536 − 256n)` is a perfect 256th power and the
fractional machinery contributes nothing. This is a theorem, and it is also the regression that detects
a wrong scale before anything else is evaluated.

**`R(256n + f) = R(f) >> n`.** The function is 256 base values and a shift, by
`⌊⌊y⌋/m⌋ = ⌊y/m⌋`. This is what makes an exhaustive check affordable: verifying the 256 base values
against the predicate settles all 65537 inputs.

#### What is not consensus

**The approximation.** Any implementation producing an `R` that satisfies clause 2 agrees with every
other on every input, so the fixed-point factors and their precision are an implementation choice and
may be replaced wholesale without a fork.

⚠ **That is true only while clauses 1 and 3 are also stated.** Compress this rule back to the predicate
alone and the sentence above becomes false — the domain and the rendering are where two conforming
implementations would otherwise diverge.

⚠ **A test that the implementation factors as base-and-shift is a precondition, not evidence.** For a
fixed-point implementation both sides reduce to the same floor expression, so it passes with corrupted
factors. It pins the factoring for an implementation that might lack it and says nothing about the
constants; only the predicate does that.

**Under-precision is safe, and one-sided.** Every step of a fixed-point expansion floors, so it
under-estimates and never over-estimates. A node running too little precision computes a *smaller* —
stricter — target: it rejects blocks a conforming node accepts and can never accept one a conforming
node rejects, so the bug forks that node off by itself rather than admitting an invalid block.

#### Both ends lose resolution, and only one end is reachable

**The target stops resolving above `scaledBits = 63358`** (target 363): a 1/256-bit step no longer moves
it. **Measured, not derived** — the closed-form bound `R ≤ 368` brackets it at 63353 and does not pin
it. Far outside any reachable difficulty.

**Work stops resolving below `scaledBits = 2180`**, and that end *is* reachable. See
`blockWork / cumulativeWork`; it is why `ORDERING_BLOCK_POW_TARGET_FLOOR` is **2304** — nine whole bits,
the first above that line — rather than the ×256 rescale of the old floor.

⚠ **Work resolves on a band, not a half-line.** Every step on `[2305, 63357]` moves it and no step at
either end does: 1816 blind steps below, and 1816 above 63358 where work stops because the target does
(`R(65535) = R(65536) = 1`). So the floor's justification is *every **reachable** difficulty resolves* —
the unqualified form is false above 63358, which is 247 bits against a measured operating point of 23.

#### Mirrors

The split runs through callers, not packages. **`scripts/miner.mjs` mirrors this function**, since it
expands `header.powTargetBits` off a mining template; **`public/index.html` keeps mirroring
`powTarget`**, because the page performs post PoW only and no header PoW. After this lands the package
exports two functions of type `(number) => Uint8Array | null` that mean different things, and
`powTarget` refusing anything above 256 is the only place the denominations distinguish themselves.

### blockWork / cumulativeWork

```
blockWork(targetBits: number): bigint | null
cumulativeWork(headers: BlockHeader[]): bigint
```

How much work a header claims, and how much a sequence of them claims together. `blockWork` is
**`2^256 / (target + 1)`**, where `target` is the expansion of the header's `powTargetBits`.

> ⚠ **AHEAD OF CODE.** `targetBits` here is `orderingPowTarget`'s **1/256-bit** unit and the domain is
> `[0, 65536]`; the code still reads whole bits over `[0, 256]`. Both land on this branch.

**The identity is exact at every whole-bit target, and inclusivity is what makes it so.** `target + 1`
is precisely `R`, which at `scaledBits = 256n` is `2^(256 − n)`, so the quotient is `2^n` with no
remainder. An *exclusive* target would floor to one less at every integer target — which is detectable,
and the regression that detects it is the agreement check against `1n << bits` across the whole domain.

⚠ **`blockWork` is the one part of this change that fails SILENTLY, and it is the opposite of every
other part.** Its signature does not change and its domain *widens*, so every old-denomination value
stays legal rather than becoming `null`: `blockWork(12)` goes from `4096` to `1`. No throw, no `null`,
no type error — just a plausible number and a chain whose cumulative work is ~1 per block. Contrast
`scripts/miner.mjs`, which throws on an unmigrated template because `powTarget` refuses anything above
256. **Every caller must move in the same change**, and nothing in the type system will say otherwise.

⚠ **Work resolves only on `[2305, 63357]`** — every step inside that band moves it, and 1816 steps at
each end do not. Beneath 2180 a 1/256-bit step can buy zero additional work, so a chain running there
**retargets without moving the quantity fork choice selects on**; above 63358 work stops because the
target does, at a difficulty nothing reaches. The flooring is also one-sided, so `cumulativeWork`
under-counts; at `scaledBits = 255` the true expected-trial count is 1.9945 and `blockWork` answers 1.
Neither is a consensus break, since every node floors identically. It is why
`ORDERING_BLOCK_POW_TARGET_FLOOR` sits above the line and why devnet is not seeded beneath it: the
profile built to exercise a retarget must be able to see one.

`blockWork` returns `null` for exactly the inputs the expansion refuses, so the domain is stated once
rather than re-derived. `cumulativeWork` **skips** such a header rather than throwing: the array
reaches it from the wire, where `powTargetBits` is any `number`, and refusing a whole comparison over
one bad member would hand a peer a way to void a fork-choice decision.

**This lives here and not in `@dagsocial/types` because it depends on `powTarget`**, and the
dependency runs `validation → types`. Work accounting is a PoW question, which is this package's
remit; its former home next to `BlockHeader` was proximity, not ownership.

**The arithmetic wall that shaped the bound.** Measured 2026-08-09 (node v22.19.0):

| Input | Result |
|---|---|
| `1n << BigInt(2³⁰ − 1)` | allocates **128 MiB** |
| `1n << BigInt(2³⁰)` | throws `RangeError` |
| `(1n << BigInt(2³⁰−2)) + (1n << BigInt(2³⁰−2))` | throws — **the accumulator overflows independently of any single term** |

The wall is exactly 2³⁰ and one integer wide. **A per-term bound is not sufficient on its own** — two
terms each below the wall sum past it — which is why the bound is the digest width rather than anything
near the arithmetic limit. A peer controls roughly **18,900** terms, not the `MAX_REORG_DEPTH * 2` the
caller asks for: `requestHeaders`' `maxCount` is not enforced on the response, only `MAX_STREAM_BYTES` is.

⚠ **No `src` shifts by a variable BigInt any more** — `blockWork` shifts by the constant `256n` and
divides. The measurement therefore constrains future code rather than justifying present code, which is
why it is stated with its date and its runtime.

> ⚠ **The domain CONTAINS the claimed-work defect; it does not close it.** A peer claiming
> `powTargetBits: 200` sits inside `[0, 256]`, allocates nothing and throws nothing, and still outweighs
> an honest 12-bit chain by 2¹⁸⁸ — buying a reorg *attempt* on every comparison. Those blocks are
> rejected at apply, which enforces `expectedTarget(height)`, so the chain does not move; the cost is
> wasted work, not a consensus break. **The root is comparing *claimed* work rather than verified work,
> and it belongs to `@dagsocial/node`'s fork choice.** Recorded so it is not mistaken for closed.
>
> ⚠ **A second instance was live outside that domain until 2026-08-12.** `net`'s store walk shifted
> without consulting the domain at all, so a stored header claiming **257** bits contributed `2^257` and
> was published to peers as `SyncInfo.tipCumulativeWork`. Summing `blockWork` closes that one. Whether
> such a header can reach the store is a `node` question — `verifyHeaderFieldDomains` pins
> `powTargetBits` as `isU64Safe` only, with no upper bound.

**A chain's work and a header sequence's work are different questions.** `net`'s
`LazySyncStore.cumulativeWork()` walks its own store and answers the first; this function is handed
headers and answers the second. They share only `blockWork`, and neither is a copy of the other — an
enumeration of "what computes work" that greps this function's callers will not reach `net`.

**Totality is arithmetic, not a validity rule.** Past 256 bits `powTarget` returns `null`, so no digest
can satisfy such a target and no work can have been done on that header — zero *is* its expected-hash
count. Nothing rejects a block for exceeding the bound; the consensus minimum is
`ORDERING_BLOCK_POW_TARGET_FLOOR`, checked at apply.

**Totality is required, not convenient.** The headers reach fork choice from `net`'s `requestHeaders`
as a decode plus a cast, and the encodable domain is `isU64Safe` — so `powTargetBits` arrives anywhere
in `[0, 2^53)`. A header outside the domain is a routine input on that path, not an anomaly, and
refusing the whole segment over one would hand a peer a way to void the comparison.

**`blockWork`'s `null` is what bounds a claimed target, and the bound is consensus-visible.** The store
walk publishes its total as `SyncInfo.tipCumulativeWork`, which peers compare. A header claiming more
than 256 target bits is arithmetically shiftable — `1n << 257n` is an ordinary BigInt — so a sum that
shifts without consulting this domain counts `2^257` from a single header and outweighs any honest
chain. Refusing out of domain is the bound; there is no separate range check to keep in step with it.

### verifyPoW

```
verifyPoW(input: Uint8Array, nonce: number, targetBits: number): boolean
```

Appends the nonce using **`powNonceBytes` from `@dagsocial/types`** — `vlqU(nonce)`, the same
tail `computePostId` appends — concatenates `input ‖ powNonceBytes(nonce)`, hashes with
blake2b512, takes the first 32 bytes, and answers `meetsPowTarget(hash, powTarget(targetBits))` —
`false` when `powTarget` returns `null`.

**It does not encode the nonce itself.** That layout belongs to `TYPES_INTERFACE.md` →
Serialization → "Layout — Post". A local copy here is exactly what let this function and
`computePostId` disagree for the whole of the positional migration while every test stayed
green (Phase 8). One writer, one layout owner.

> ⚠ **`isU64Safe(nonce)` is load-bearing and is NOT redundant with the writer.** `vlqU` is
> total by sentinel, so it cannot throw — but every out-of-domain nonce (`NaN`, `-1`, `1.5`,
> `2⁶⁰`) takes `VLQ_SENTINEL` and therefore **one shared hash**. Under the previous
> fixed-width tail this guard existed to stop `BigInt` / `writeBigUInt64LE` throwing; under
> `vlqU` its purpose is collision-prevention instead. Same check, different reason — do not
> delete it on the grounds that the writer no longer throws.

Post PoW only, in both Stage 1 (gossip) and Stage 2 (node). Ordering-block PoW is
`verifyOrderingBlockPoW` below, which appends `encodeLE64` and shares no code with this
function — two encodings, each specified.

### verifyOrderingBlockPoW

```
verifyOrderingBlockPoW(header: BlockHeader): boolean
```

Computes the PoW preimage via `computePowHash(header)`, encodes `header.powNonce`
as u64 LE, hashes `preimage || nonceBytes` with blake2b512, takes the first 32
bytes, and answers `meetsPowTarget(hash, powTarget(header.powTargetBits))` —
`false` when `powTarget` returns `null`.
Guards its inputs (M-5 / M-6): returns `false` — never throws — if the
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

Checks: `post` present, **`subBlockId` is 64 lowercase hex**, **`protocolVersion`
is `isU64Safe`**, **`producerId` is exactly 32 bytes**, and
**`verifyPostFieldDomains(sb.post)`**. Returns `{ valid, error }`. (The
`likeBoxes` array check died with the sidecar field — P2-D.)

> ✅ **RESOLVED — the three `SubBlock` domain pins have LANDED. Verified 2026-08-11.** This read
> `AHEAD OF CODE` until Phase 9, and the code has since caught up: `verifySubBlockStructure`
> now checks `isHex32(sb.subBlockId)`, `isU64Safe(sb.protocolVersion)` and
> `isBytesOfLength(sb.producerId, 32)` — exactly the three declared wire domains, in that order,
> each with a comment naming the writer it feeds.
>
> **The record of what it was.** The function checked `subBlockId` and `producerId` for
> **truthiness** and `protocolVersion` for `typeof === 'number'`, while all three fed throwing
> fixed-width writers in the `SUB_BLOCK` codec — `writeHexNOrThrow(subBlockId, 32)`,
> `writeBytesNOrThrow(producerId, 32)`, `writeVlqU(protocolVersion)`. So `subBlockId: 'x'`
> passed every check and threw in the writer, and so did `protocolVersion: 1.5`.
>
> Same rule Phase 1c established for the header and 1e for the ordering block, applied to the
> struct **both phases skipped**. The LEDGER's Gate B recorded the unpinned rows clustering in
> `CoinbaseOutput` and `SubBlock`, "the two structs 1e and 1f never covered". The
> `CoinbaseOutput` four were closed by **#32**; **these three are now closed too**, which
> retires that Gate B cluster entirely and closes the `SubBlock` half of carried register #1.
>
> ⚠ **`Post.powNonce` and `Post.signature` are a different question and are NOT
> part of this obligation.** Neither appears in `verifyPostFieldDomains`, yet
> `POST.write` ends `writeVlqU(p.powNonce)` and
> `writeBytesNOrThrow(p.signature, 64)`. Both domains are established only
> *downstream* — `verifyPoW` checks `isU64Safe(nonce)` internally, and
> `verifyPostSignature` deliberately leaves a wrong-**length** signature to
> `crypto.verify` (`:367-369`, and that is the right call for verification). So
> the open question is **reachability, not absence**: is there any path that
> encodes a post before the downstream check runs? That is the §2.5 shape, and it
> must be answered by tracing rather than assumed either way.

> ⚠ **The justification that stood here was one phase out of date — corrected
> 2026-08-10.** It read: the domain check is here because this is the shared gate
> the relay path passes through, `runStage1SubBlock` before the PoW preimage.
> **That was written when `decodeSubBlock` was `decode(bytes) as SubBlock`.**
> Since Phase 3b, `gossip.ts:78` decodes through `decodeStruct` *before*
> `runStage1SubBlock` runs, and the positional reader establishes every domain on
> the way in — `readHexN` yields lowercase hex, `readBytesN` yields exactly 32
> bytes or throws, `readVlqU` yields a non-negative safe integer or throws. **No
> out-of-domain sub-block can arrive over gossip at all**; it dies in the decoder.
> These checks reject nothing on that path.
>
> **That relocates their teeth rather than removing them.** They are the stated
> rejection for any path that builds a `SubBlock` *without* the decoder.
>
> ✅ **The unvalidated serve path this note named is CLOSED. Verified 2026-08-11.** It read:
> *"`net/src/node.ts:951` and `:960` take `getSubBlock`'s return — typed `unknown` — cast it
> `as SubBlock`, and hand it straight to `encodeSubBlock` with no validation of any kind."*
> Both serve arms — the legacy text protocol and the framed `MSG_GET_SUB_BLOCK` — now call
> **`encodeServableSubBlock(subBlock, this.validators, id)`**, which takes `unknown` and runs
> the validator before encoding; a row we hold but cannot encode is answered exactly like a row
> we do not hold. `getSubBlock` still returns `unknown`, and that is now harmless because the
> cast no longer happens. **Carried register #22 is closed, including its rider** —
> `encodeSubBlock` occurs 0 times in `net/src/sync.ts`, so the dead import is gone too.
>
> ⚠ **This note's own closing lesson fired on this note.** It ended: *"a reachability argument
> is a claim about the rest of the tree, and this one expired when the tree moved under it… a
> check justified by a path can outlive the path."* Written about the *gossip* justification,
> it then applied verbatim to the **replacement** justification in the very next paragraph: the
> serve path was hardened and the note went on citing it as unguarded. **The lesson was correct,
> general, and not applied to the sentence sitting beside it.** All three line pins had rotted
> as well — `:951` and `:960` now land on `stream.sink` and `code = framed.code`.

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
`powTargetBits` ≥ `ORDERING_BLOCK_POW_TARGET_FLOOR` (2304), `coinbaseOutputs` is
an array with each output having a 32-byte `owner`, a `bigint` `value` in
`[0, 2⁶⁴)`, a `lockedUntilBlock` that is `isU64Safe` **and** ≥ `block.height`,
and an `isTreasury` that is a `boolean`. Each `utxoTxs` element is a byte view.

> ⚠ **The `< 2⁶⁴` bound lives HERE, not in node — corrected 2026-08-10.** This
> passage used to route it to node's apply-time `checkOutputValues` "matching the
> loose-structural / tight-apply split". **That function is retired**
> (`utxo-engine.ts:606`), and its successor — the field-type table's `u64` spec —
> covers transaction **output boxes** only, never `CoinbaseOutput`. So no `u64`
> bound on a coinbase `value` existed anywhere in the repo: the contract named an
> owner that had stopped existing, and the split it appealed to had no tight half.
> Third contract-vs-code divergence found in this file, all three by reading the
> code beside the claim rather than by a sweep.
>
> The four pins above are not a policy tightening; they are the **declared wire
> domains** of `TYPES_INTERFACE` → Layout — Block (`vlqU64` is u64, `u8(isTreasury)`
> is `writeBool` over a boolean, `lp` is bytes). Spec §2.5 assigns exactly this to
> this package: the encoder's domain is established upstream so a throw is
> unreachable and a bad value produces a **stated rejection**. Two of the four
> also close a measured remote fail-stop — see
> `prompts/node-fail-stop-reachability-measure-REPORT.md`.

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

> ⚠ **FALSE — the shrink this marker predicted is REFUTED, not delivered. Verified 2026-08-11.**
> It read `AHEAD OF CODE` until Phase 9. **It is not being retired as "done": its premise was
> never true**, and recording it as completed would write a false history of why this function
> looks the way it does.
>
> **The premise was that the positional decoder makes field-presence and type checks dead code.
> That holds for one of three production callers:**
>
> | Caller | Upstream | Codec guarantee? |
> |---|---|---|
> | `net/src/gossip.ts` | `decodeOrderingBlock(raw)` | yes |
> | `net/src/serve-encode.ts` | **store read** — `encodeServable` does a bare `value as T` | **none** |
> | `node/src/services/block-apply.ts` | gossip, sync, `fork-resolution`, **and `block-creator`'s locally-mined block built in-process** | none for our own block |
>
> `serve-encode.ts`'s own failure message is `stored row is out of domain`. **Those type checks
> are the only gate on two of the three paths**, because store corruption can put any type in
> any field — so deleting them as "subsumed by the codec" would remove the only check standing
> between a corrupt row and a peer.
>
> **The shrink that was real already happened, incrementally and elsewhere.** Phase 1f moved
> every header field check into `HEADER_DOMAIN` / `firstHeaderDomainFailure`; Phase 3b deleted
> the `subBlockRefs` presence and alignment checks along with the field. What remains *is*
> already "what the codec cannot guarantee" — it merely also coincides with what the store path
> needs. Full argument: `docs/specs/2026-08-10-pow-nonce-split.md` §4.1.
>
> **The table below is kept, because it is correct about what this function must never lose.**
> What survives, and a codec cannot know:
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

> ⚠ **NEVER BUILT as described, and it has no production caller. Verified 2026-08-11.** The
> function exists — defined and exported from `@dagsocial/validation` — but
> `packages/node/src` calls it **zero times**; the chain-link check on the live path is done
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
> **Re-verified 2026-08-11.** The two keys are `last_indexed_sequence` and
> `last_validated_sequence`, and each occurs exactly **twice** in `node/src` — the
> `advanceWatermark(...)` write in `post-service.ts` and the key's own type annotation on that
> helper's signature. **No read site exists.**
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
- **Two PoW nonce encodings, each specified, sharing no code path.** A *post* nonce is
  `vlqU`, written by `powNonceBytes` in `@dagsocial/types` and by nothing in this package.
  An *ordering-block* nonce is `encodeLE64` (`MINING_INTERFACE.md` → PoW Verification).
  Unifying them is a protocol decision, not a tidy
- The integer-range guard (M-6) applies to both, and **its purpose differs by encoding**: a
  nonce or `targetBits` that is not a non-negative safe integer within `u64` yields `false`,
  never a thrown `RangeError`. For the block nonce the guard prevents a throw from `BigInt` /
  `writeBigUInt64LE`; for the post nonce `vlqU` cannot throw, and the guard instead prevents
  every out-of-domain value collapsing onto `VLQ_SENTINEL` and sharing one hash. Validate
  with `Number.isInteger` (not a loose `typeof === 'number'`, which admits `NaN` and floats)
- Content limits measured in UTF-8 bytes, not characters
- All functions are synchronous — no Promises, no callbacks
- Protocol version `PROTOCOL_VERSION` from `@dagsocial/types`
- Ordering-block hashing is over the **header**. The PoW preimage
  (`computePowHash`) is the encoded header with `powNonce` zeroed; the canonical
  `blockHash` is the encoded header with the solved `powNonce`. Neither includes
  `validatorSignature` — it is not a header field. The body binds via the header's
  `subBlockRoot` / `utxoTxRoot` / `stateRoot`.
