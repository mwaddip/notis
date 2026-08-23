# VALIDATION Interface Contract

**Component:** `@dagsocial/validation`
**Protocol version:** 1
**Last updated:** 2026-08-23

## Scope

Stateless validation functions for DAGsocial. Pure functions — no I/O, no
database access, no side effects. Shared by `@dagsocial/net` (Stage 1 checks
before gossip forwarding) and `@dagsocial/node` (Stage 2 verification for
both local and relayed objects). Depends only on `@dagsocial/types`.

Exports from `packages/validation/src/index.ts`.

---

## PoW Verification

### meetsPowTarget

```
meetsPowTarget(hash: Uint8Array, target: Uint8Array): boolean
```

The comparator half of the PoW admission rule: `hash <= target`, both read big-endian, byte by byte
over `target.length`. The admission rule is **`meetsPowTarget(hash, orderingPowTarget(bits))`** — every
PoW question in the repo, the verifier's and every solver's, is that composition and nothing else. The
expansion half is `orderingPowTarget` below.

A `hash` shorter than `target` is refused rather than zero-extended: a digest that cannot be compared
over the target's full width does not meet it. The comparison iterates `target.length`, so the target's
width is part of the admission rule and **this function cannot detect a wrong one** — the third clause
of `orderingPowTarget`'s rule is what fixes the width at 32 bytes.

Neither function throws, on any input. A `null` target — `orderingPowTarget` refusing its input — is the
caller's `false`: no digest can satisfy it.

A *solver* that holds no predicate and asks the verifier instead — `node/test/helpers.ts`'s
`solveHeaderPow` is the example — inherits this rule with no edit and is the shape to prefer. **"PoW
solvers" and "PoW predicates" are different enumerations**; only the second should ever be counted
when asking how many places implement this rule.

**Why a pair rather than one function.** The expansion is the half a retarget changes; the comparison
never does. Splitting them is what lets a schedule change without touching the admission rule. The
comparison is byte-wise rather than `BigInt` because a solver runs it once per nonce.

> ⚠ **AHEAD OF CODE — 2026-08-23.** `packages/validation/src/index.ts` still exports `powTarget`, the
> whole-bit expansion `2^(256 − n) − 1` over `[0, 256]`, which no verifier, solver or mirror calls. The
> validation unit on this branch deletes it; the whole-bit regression under `orderingPowTarget` then
> holds against a test-local rendering of that expansion rather than a src export.

### orderingPowTarget

```
orderingPowTarget(scaledBits: number): Uint8Array | null
```

Ordering-block difficulty in units of **1/256 of a bit**, so a target between two whole bits is
expressible. The expansion half of the admission rule; `meetsPowTarget` above is the comparator.

**Solvers hoist the expansion.** `orderingPowTarget` depends only on `scaledBits`, so a solver derives
it once per template and calls `meetsPowTarget` per nonce. Deriving it inside the loop allocates once
per hash.

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

**Inclusive, not exclusive.** The exclusive threshold `R` is `2^256` at `scaledBits = 0` and is not
representable in 32 bytes; the inclusive `R − 1` is `0xff × 32` at one end and `0x00 × 32` at the
other, so both extremes are ordinary values and the domain needs no special case. And `target + 1` is
exactly `R`, which is what keeps the work quotient below exact at every whole bit.

**At every whole bit the target is the whole-bit expansion `2^(256 − n) − 1`** — `orderingPowTarget(256n)`
is `n` leading zero bits then ones, for all `n` in `[0, 256]`, because `2^(65536 − 256n)` is a perfect
256th power and the fractional machinery contributes nothing. This is a theorem, and it is also the
regression that detects a wrong scale before anything else is evaluated: `ordering-pow-target.test.ts`
holds every whole bit against an independent byte-fill rendering of that expansion, which shares no
arithmetic with the fixed-point path.

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

**`scripts/miner.mjs` mirrors this function and `meetsPowTarget`**: it expands `header.powTargetBits`
off a mining template and is standalone by decision — `node:crypto` and nothing else, so the machine
that mines needs no build step (`MINING_INTERFACE` → Miner Script). It cannot import this package, so
`node/test/unit/miner-mirror.test.ts` holds the copy to it by extracting both declarations **by name**
and comparing them against this package's — the expansion on every admitted input; a mirror that
stops finding its declaration fails, which is the property the test exists for. `public/index.html` performs no PoW and
mirrors nothing from this section.

### blockWork / cumulativeWork

```
blockWork(scaledBits: number): bigint | null
cumulativeWork(headers: BlockHeader[]): bigint
```

How much work a header claims, and how much a sequence of them claims together. `blockWork` is
**`2^256 / (target + 1)`**, where `target` is the expansion of the header's `powTargetBits` —
`orderingPowTarget`'s **1/256-bit** unit, domain `[0, 65536]`.

**Fork choice does not hand a peer's headers to `cumulativeWork` directly.** It obtains a segment's
work from `verifyHeaderChain` (below), which sums only a segment that has passed every header-level
rule; `cumulativeWork` stays total because it is the primitive, and a primitive states its domain once.

**The identity is exact at every whole-bit target, and inclusivity is what makes it so.** `target + 1`
is precisely `R`, which at `scaledBits = 256n` is `2^(256 − n)`, so the quotient is `2^n` with no
remainder. An *exclusive* target would floor to one less at every integer target — which is detectable,
and the regression that detects it is the agreement check against `1n << bits` across the whole domain.

⚠ **A whole-bit count passed by mistake fails SILENTLY.** The domain `[0, 65536]` contains every
whole-bit value, so `blockWork(12)` is `1` — twelve 1/256-bit steps — not `null` and not a throw: a
plausible number, and a chain summed in the wrong unit carries ~1 work per block. Nothing in the type
system distinguishes the two denominations; the unit is the caller's to get right.

⚠ **Work resolves only on `[2305, 63357]`** — every step inside that band moves it, and 1816 steps at
each end do not. Beneath 2180 a 1/256-bit step can buy zero additional work, so a chain running there
**retargets without moving the quantity fork choice selects on**; above 63358 work stops because the
target does, at a difficulty nothing reaches. The flooring is also one-sided, so `cumulativeWork`
under-counts; at `scaledBits = 255` the true expected-trial count is 1.9945 and `blockWork` answers 1.
Neither is a consensus break, since every node floors identically. It is why
`ORDERING_BLOCK_POW_TARGET_FLOOR` sits above the line and why devnet is not seeded beneath it: the
profile built to exercise a retarget must be able to see one.

⚠ **The floor is enforced on both sides of the boundary, and the producer half is the newer one.**
`verifyHeaderFieldDomains` refuses an arriving header below the floor; `loadConfig` refuses to *start*
on a profile below it. Without the second, a misconfigured node builds templates its own verifier
rejects and sits there mining nothing — up, quiet, and producing no blocks, which is the silence this
contract's fail-stop rules exist to prevent. **It is a refusal, not a clamp**: raising a below-floor
value to the floor would mine a chain against a target nobody configured.

⚠ **The producer check lives at config load, which is complete only while the target is constant in
height.** A schedule that can *compute* a below-floor target needs the check where the target is
produced — `expectedTarget` — and a load-time guard will look complete to whoever writes that schedule.

`blockWork` returns `null` for exactly the inputs the expansion refuses, so the domain is stated once
rather than re-derived. `cumulativeWork` **skips** such a header rather than throwing: the array
reaches it from the wire, where `powTargetBits` is any `number`, and refusing a whole comparison over
one bad member would hand a peer a way to void a fork-choice decision.

**This lives here and not in `@dagsocial/types` because it depends on `orderingPowTarget`**, and the
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
near the arithmetic limit. **The term count is bounded by the caller's own request**: `requestHeaders`
passes its `maxCount` to `decodeHeaders`, and `lpItemsCodec` checks
`min(maxCount, MAX_CHAIN_RESPONSE_ITEMS)` — 400 — **before the first element is read**, so a peer
answering a `MAX_REORG_DEPTH * 2` request with 18,900 headers is refused rather than summed. The bound
here is still the digest width and not that count: a per-term bound never was the thing holding, and
tying this argument to a response cap in another package would make it decay on that package's
schedule.

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
> was published to peers as `SyncInfo.tipCumulativeWork` (a field since removed — nothing compared
> it). Summing `blockWork` closes that one. Whether
> such a header can reach the store is a `node` question — `verifyHeaderFieldDomains` pins
> `powTargetBits` as `isU64Safe` only, with no upper bound.

**A chain's work and a header sequence's work are different questions.** `net`'s
`LazySyncStore.cumulativeWork()` walks its own store and answers the first; this function is handed
headers and answers the second. They share only `blockWork`, and neither is a copy of the other — an
enumeration of "what computes work" that greps this function's callers will not reach `net`.

**Totality is arithmetic, not a validity rule.** Past `65536` — 256 whole bits — `orderingPowTarget`
returns `null`, so no digest can satisfy such a target and no work can have been done on that header —
zero *is* its expected-hash count. Nothing rejects a block for exceeding the bound; the consensus
minimum is `ORDERING_BLOCK_POW_TARGET_FLOOR`, checked at apply.

**Totality is required, not convenient.** The headers reach fork choice from `net`'s `requestHeaders`
through the positional codec, which checks each element's byte span — **and that is a shape check, not
a domain check.** The encodable domain is `isU64Safe`, so `powTargetBits` still arrives anywhere in
`[0, 2^53)`: a value in range for the codec and far outside anything this function can shift. A header
outside the domain is a routine input on that path, not an anomaly, and refusing the whole segment over
one would hand a peer a way to void the comparison.

**`blockWork`'s `null` is what bounds a claimed target, and the bound is consensus-visible.** Fork
choice sums `blockWork` over the verified segment it is handed (`NODE_INTERFACE → Fork choice decides
on verified headers`). A header claiming more than 256 target bits is arithmetically shiftable —
`1n << 257n` is an ordinary BigInt — so a sum that shifts without consulting this domain counts `2^257`
from a single header and outweighs any honest chain. Refusing out of domain is the bound; there is no
separate range check to keep in step with it.

**There is no post PoW.** A post is a transaction, admitted by a **stateful** check —
the author holds the karma and really locks it — which is strictly stronger than
proving someone burned a millisecond.

⚠ **The one `isU64Safe` pin on the post path guards `protocolVersion`, and it is not a
search-variable guard:** no consensus field of a post is a variable an attacker varies to
hit a target — `protocolVersion` is `vlqU` and total by sentinel, and an out-of-domain
version encodes to a value the strict-equality version check refuses, so the sentinel never
reaches a rule as a meaning.

`verifyOrderingBlockPoW` is unaffected — ordering-block PoW is the consensus PoW and
always was. **Consensus is honestly single-phase.**

### verifyOrderingBlockPoW

```
verifyOrderingBlockPoW(header: BlockHeader): boolean
```

Computes the PoW preimage via `computePowHash(header)`, encodes `header.powNonce`
as u64 LE, hashes `preimage || nonceBytes` with blake2b512, takes the first 32
bytes, and answers `meetsPowTarget(hash, orderingPowTarget(header.powTargetBits))` —
`false` when `orderingPowTarget` returns `null`.
Guards its inputs (M-5 / M-6): returns `false` — never throws — if the
header is not encodable, or if `powNonce` / `powTargetBits` is not a
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
`powNonce` set to `0`, encodes it (`encodeHeader`), and returns
`blake2b512(encoded).subarray(0, 32)`. The preimage is over the **header**, not a
separate "block body" — it covers `protocolVersion`, `height`, `prevBlockHash`,
`utxoTxRoot`, `stateRoot`, `validatorId`, `powTargetBits`, and
`createdAt`, with `powNonce` zeroed. The block *body* (UTXO txs and prune
entries) is committed **transitively**: `utxoTxRoot` is the
Merkle root over it and `stateRoot` is the AVL+ digest, so any body change alters
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
> data that has passed **no domain check**: `net`'s `requestHeaders` hands its result to node's fork
> resolution, which passes those bare headers straight here. The positional codec those headers now
> decode through checks each element's byte span and refuses a malformed one — **it does not check a
> field's range**, so `powTargetBits` still arrives anywhere `isU64Safe` allows. Shape and domain are
> different questions, and only one of them was ever answered on this path.
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

**A post carries no signature of its own.** It is created by a transaction signed
over that transaction's `TxId`, and the signing key is the author — so a post's
authorship is verified by the transaction's signature check and nothing else.
**No path may reintroduce a post-level signature**: two signatures over one
object is two places for them to disagree.

The SPKI-envelope mechanics survive in the transaction signature path unchanged —
32 raw bytes wrapped with the `302a300506032b6570032100` prefix, a `KeyObject` via
`crypto.createPublicKey`, then `crypto.verify(null, …)`.

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
authorship) fails this check. The caller supplies the public key (the header's
own `validatorId`) and the function performs no I/O.

**No-panic (M-5).** Returns `false` — never throws — on malformed input: a
`signature` that is not a byte view, or any header outside the domain, which
since Phase 1f is **one** guard rather than two. `blockHash` returns `null` on
exactly the headers `verifyHeaderFieldDomains` rejects, and its non-null return
*proves* `validatorId` is exactly 32 bytes — which is what keeps the SPKI wrap and
`createPublicKey` ("Failed to read asymmetric key") out of reach without a
separate length check here. A wrong-*length* signature is left to `crypto.verify`,
which rejects it cleanly.

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

### verifyPostBody

```
verifyPostBody(content: unknown, contentHash: Uint8Array): { valid: boolean; error?: string }
```

**The one check a body passes at every entry** — the packet's trailing field at the gossip
topic validator, a pull response's element, and `POST /posts`' `content` — and the only place
the content rules run: `content` is a string; `verifyContentLimits`; `verifyContentCharacters`;
`computeContentHash(content)` equals `contentHash` byte-for-byte (`TYPES_INTERFACE` → Hashing
functions). The commitment is read from the transaction the caller already holds
(`tx.post.contentHash`); a caller with no transaction has nothing to verify against and does
not call this.

⛔ **No transaction check reads content, and no body check reads a transaction beyond its
commitment.** `MAX_CONTENT_BYTES` and the character table are body rules; `verifyTxStructure`'s
post arm checks the commit's domains and never a body, because the transaction carries none
(`TYPES_INTERFACE` → Layout — PostCommit). A content limit enforced inside a transaction check
would be enforcing it on a field that does not exist there.

Total on adversarial input, like every function here — a non-string `content`, a
wrong-width `contentHash`, a body over the limit are each `{ valid: false }` with the reason.

---

## Structural Validation

### ⛔ What a decoder subsumes depends on the ENTRY PATH, and a store read is one

Since the positional codecs, a fixed-width field has **exactly one encodable width** — `readBytesN(r, 32)`
either yields 32 bytes or throws. So a check of the form *"is this field 32 bytes"* is **subsumed**
when the object came through a decoder, and **live** when it did not.

⛔ **THE QUESTION IS NEVER "IS THIS CHECK REDUNDANT" — IT IS "BY WHICH PATHS CAN THIS OBJECT
ARRIVE".** The same check on the same field has opposite verdicts in two packages, and the field is
not what decides it.

**Measured in `@dagsocial/net`, 2026-08-18 — four entry paths, and only half cross a decoder:**

| Path | Decoded? | Width checks |
|---|---|---|
| gossip | ✅ `decodeTx` / `decodeOrderingBlock` | **subsumed** |
| sync codec | ✅ | **subsumed** |
| **store read** | ⛔ **no** — `encodeServable` takes `value: unknown` and casts `value as T` | ⚠ **LIVE** |
| `broadcastTx` / `broadcast*` | ⛔ no | the **encoder** throws instead |

⚠ **A STORE READ IS A NON-DECODER ENTRY AND IT DOES NOT LOOK LIKE ONE.** It is internal, it carries
no untrusted-input smell, and the data never crosses a codec in either direction — it comes back out
of SQLite as objects. **Reasoning about entry paths by looking for *edges* misses it**, which is the
error this section exists to prevent: `net` was predicted "fully subsumed, because it has no HTTP
edge", and the prediction was refuted by the package's own module header.

⛔ **`@dagsocial/node` has BOTH a store and an HTTP edge**, so the identical checks there are live
twice over. **Do not carry net's answer into node.**

⛔ **NEVER DELETE A SUBSUMED CHECK.** Unreachable is not wrong, and it costs nothing; it is what
stands where a future non-decoder caller would land, and that failure would be silent. ⚠ **Say so
beside it** — a defensive check with no comment reads as a live one, and the next reader reasons
about a path that cannot happen.

### verifyPostCommitDomains

```
verifyPostCommitDomains(commit: unknown): { valid: boolean; error?: string }
```

The **field-domain pin** (Phase 1c, `5c0bf71`) over the transaction's post payload, the
`PostCommit` (TYPES_INTERFACE → Layout — PostCommit). Carries the type checks `isSignablePost`
has always made, plus the domain rules `postFieldBytes` relies on:

- `contentHash` is a `Uint8Array` of **exactly 32 bytes** — the `b32` writer in slot 1
- `author` is a `Uint8Array` of **exactly 32 bytes**
- every `parentRefs` entry matches `/^[0-9a-f]{64}$/` — 64 **lowercase** hex, and there are at
  most `MAX_PARENT_REFS` of them
- `protocolVersion` is a safe unsigned integer (`isU64Safe`)
- `type` is a member of the `POST_TYPE` table — `'regular' | 'profile'`
  (TYPES_INTERFACE → Post typing and profiles)

It reads **no content** — the commit carries none; the body's rules are `verifyPostBody`'s.

**Why lowercase is load-bearing, not stylistic.** `'AB…'` and `'ab…'` hex-decode
to the same 32 bytes. Accepting both would make the hex→bytes conversion at the
codec boundary non-injective: two distinct in-memory posts, one preimage, one
id. That is precisely the malleability the M-1 field encoding exists to close,
arriving from the codec side instead of the concatenation side.

**Why it exists.** `author` and the refs take fixed-width `b32` writers, which cannot carry
a sentinel and therefore **throw**; `type` takes `enum8`, whose writer is **total** — an
off-table value writes the reserved `0xff` sentinel (see `TYPES_INTERFACE.md` → Totality).
The pin does both jobs: it keeps the throwing writers unreachable by malformed input, and
it keeps the sentinel path closed so two distinct malformed posts cannot share one
encoding. The payload reaches `computeTxId` through
`postFieldBytes`, so the domain must be established before then — without this
pin a malformed post would put a throw in a path this contract requires never
to throw (the M-5/M-6 regression).

**This was not only tightening the already-unusable.** A post with a
64-character *non-hex* `parentRef` passed every then-live check, because the
ref was hashed as UTF-8 text and the signature covered those same bytes —
rejecting it was a real behavioural change. `author`'s width, by contrast, was
already fatal downstream.

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
has no analogue here: `expectedTarget(_height)` (`node/src/services/difficulty.ts`) **ignores its
argument** and returns `config.orderingBlockPowTargetBits` — a constant, sourced from the network
profile, with the height parameter reserved as the seam a real retarget will need — and a constant
target has no adjustment algorithm for a timestamp to attack. **Revisit this
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

**There is no sub-block to structurally verify.** A post commit's structural checks —
`verifyPostCommitDomains` — live in the post-bearing transaction's validation, where
`verifyTxStructure` runs. The body's checks — `verifyPostBody` — run wherever a body enters a
node (the packet validator, a pull response, `POST /posts`) and never inside a transaction
check (→ verifyPostBody).

⚠ **`verifyPostCommitDomains` is still needed** — the post payload is
still attacker-supplied bytes reaching an encoder, and the no-panic contract
(M-5/M-6) is unchanged.

⛔ **A method rule:** a
check justified by a path is a claim about the rest of the tree, and it expires
when the tree moves — re-derive the justification, not just the check, whenever
either side changes.

### verifyTxStructure

```
verifyTxStructure(tx: UtxoTransaction): { valid: boolean; error?: string }
```

Checks: `tx` is an object, `inputs` is a non-empty array, `outputs` is a
non-empty array, **no output is a `genesis_proof` box**, no duplicate inputs,
`protocolVersion` is a number, **when `post` is present, `verifyPostCommitDomains(tx.post)`**
— the commit's domain established before `postFieldBytes` can run inside `computeTxId`, and
**no content check, because the transaction carries no content** — and **the encoded
transaction is at most `MAX_TX_BYTES`**. That is the whole list.

**It does not check `likeTarget`.** The field *is* domain-pinned, just not here: node's
`checkTxEnvelope` requires it to be 64 lowercase hex when present (`utxo-engine.ts`,
`validateTx` step 0), which is what establishes the domain for the `opt(b32)` writer in
`txIdBytes`. A contract that names the wrong layer for a check is how a later reader deletes
the real check as redundant — name the layer that holds it.

Also does NOT check UTXO conservation, authorization, or the like
biconditional (`likeTarget` ⟺ deficit) — those are Stage 2 (stateful) checks.

#### The size bound measures `encodeTx`, and runs last

`encodeTx(tx).length > MAX_TX_BYTES` rejects. **The measure is the re-encoding, not the bytes the
transaction arrived as**, and the reason is that node's `insertUtxoTx` re-encodes on the way into the
mempool — so a node's own canonical encoding, never the received bytes, is what will occupy a block.
Measuring the re-encoding measures the future cost exactly, and it is the same number on every node
where a received-bytes measure would not be.

⚠ **A block's embedded transactions are bounded differently, and the asymmetry is deliberate.**
`verifyOrderingBlockStructure` weighs `utxoTxs` as they arrived, because those opaque bytes are what
the node stores and re-serves. Each check measures the bytes its own object actually costs; neither
is the other's approximation.

⛔ **It runs after every shape check, and the encode is total.** This package's no-panic rule
(`Postconditions` — No-panic (M-5)) binds here as everywhere: `encodeTx` is `cbor-x` over a
peer-supplied object, so it is called only once the shape checks have passed and its throw is turned
into a rejection rather than allowed out. A size bound that panics on the input it exists to refuse
would be worse than no bound.

**Why not compute it arithmetically**, as `utxoTxTreeByteLength` does for the body: that tree is a
positional struct whose terms are all knowable, while a transaction is `cbor-x`, so an arithmetic
sizer would have to reimplement a third-party encoder's rules and would rot silently against it.

#### `genesis_proof` may not be a transaction output

A `genesis_proof` box (`TYPES_INTERFACE` → GenesisProofBox) is written by genesis
seeding alone, so a transaction carrying one among its `outputs` is rejected with
`Transaction may not output a genesis_proof box`. The tag alone decides: the scan
reads `boxType` and no other field, so a proof box with nothing else set is
refused on the same line as a complete one.

**This is the package's first box-type-aware rule, and the widening is a
decision rather than a side effect** — `boxType` occurred zero times in
`src/verify.ts` before it. Neither adjacent prohibition bars it. *"Never add
checks the reference lacks"* does not reach it, because "a `genesis_proof` box
may never be created by a transaction" is a protocol rule and not an extra one;
the stateless rule does not reach it either, because inspecting a candidate
output reads nothing.

**The rule has two halves and they cannot share a home.**

| Half | Home | Why it can only go there |
|---|---|---|
| never an **output** | here | a candidate output is a whole box, and typing it needs no state |
| never an **input** | `@dagsocial/node` | `tx.inputs` are box **id** strings; typing one requires the UTXO set |

⚠ **`TYPES_INTERFACE` → GenesisProofBox routes *both* halves to this contract.**
This package cannot run the input half: `verifyTxStructure` receives `tx.inputs`
as strings and holds no UTXO set. That sentence therefore describes a dead end
rather than scheduled work — the same shape as the `networkType` profile match
under `verifyHeaderFieldDomains`, and it reads identically to a rule that has
simply not landed yet.

**The output half earns its place here on peer scoring rather than on tidiness,
and that argument is a claim about the rest of the tree.** Stated with the search
that produced it: `verifyTxStructure` across `packages/`, `scripts/` and
`contracts/`, 2026-08-13 — **one** production caller outside this package,
`net/src/gossip.ts`'s `tx` topic validator, reached through the `validators`
interface object (`net/src/types.ts`). `packages/node` calls it **zero** times,
its two `import * as validation` namespaces included. A structural rejection in
that validator costs the sending peer the same 100-point `misbehavior` penalty as
a PoW rejection; enforced in node alone, such a transaction relays mesh-wide for
free and dies at mempool with nobody scored. Neither placement is a consensus
difference — the difference is amplification. The search is keyed on the name and
would miss a caller reaching this function under another one.

#### This package states no `genesis_proof` payload bound

**`MAX_GENESIS_PROOF_PAYLOAD_BYTES` is deliberately not defined or exported
here.** The rule above refuses a `genesis_proof` output outright, so a bound
standing behind it rejects nothing, and `verifyTxStructure` is the only exported
function whose argument reaches a box candidate at all — established by reading
every export's signature, 2026-08-13, rather than by grepping for `outputs`. A
bound stated here would be a dead export.

Its live subject is the seeder that writes the box, plus the single readback path
that decodes one (`node`'s `avl-endpoint.ts`, serving `GET /api/v1/proof/:boxId`).
⚠ **There is no peer-sync decode path**: `packages/net/src` decodes no boxes at
all, measured 2026-08-13. An earlier form of this sentence named one, which is
the failure this contract warns about two sections up — a rule justified by a
path that does not exist. The value belongs
beside the other protocol bounds in `@dagsocial/types` (`src/constants.ts`),
where `MAX_CONTENT_BYTES` and `MAX_PARENT_REFS` already sit and from which this
package imports every constant it enforces. **This package defines no protocol
constant of its own**, and a bound with no subject here would be the first.

### verifyOrderingBlockStructure

```
verifyOrderingBlockStructure(block: OrderingBlock): { valid: boolean; error?: string }
```

**The block has one body**, and the header is **nine positional fields**
(`TYPES_INTERFACE` → Layout — Block). Checks, in order: the block is an object
with a `header`; every header field's domain via `verifyHeaderFieldDomains` —
delegated to the one statement of those domains, re-labelled with this
function's messages. Every `utxoTxTree.pruneEntries` element: `rootPostHash`
hex-32, `subtreePostIds` an array of hex-32 **with no repeated id** (a list whose
length exceeds its set size is refused — the apply-time set compare and the
Merkle root over the raw list would both admit a repeat, and a repeated id
inflates the stump's `replyCount` and names one lock box twice),
`subtreeMerkleRoot` 32 bytes, `authorId` 32 bytes, `authorSignature` 64 bytes —
byte fields by `isBytes`, never a bare `.length`, because a stored row put back
through a cast can carry any type and a length check passes what the hash calls
throw on.
`validatorSignature` is 64
bytes (`isBytes`, same rule). Then the two semantic floors a domain check
cannot know: `height ≥ 1`, and `powTargetBits ≥
ORDERING_BLOCK_POW_TARGET_FLOOR` (2304) — the gossip pre-filter against a
trivially cheap target. `utxoTxTree.utxoTxIds` is a **non-empty** array of
hex-32 — non-empty because **the settlement transaction is the LAST entry**,
and non-emptiness is the whole of what this package can state about that rule:
position decides identity, and the byte-identical-derivation half is node's
(`NODE_INTERFACE` → Determinism is this mechanism's whole risk). `utxoTxs`
aligns 1:1 with `utxoTxIds`, each element a byte view of at most
`MAX_TX_BYTES`. Last, the encoded body is at most `MAX_BLOCK_BODY_BYTES`.

> ## ✅ RESOLVED — `coinbaseOutputs` HAS LEFT THE BODY, AND THE GAP CLOSED BY CONSTRUCTION
>
> ✅ **Landed 2026-08-17/18**: C1 removed the field from `UtxoTxTree` and C2 removed the structural
> checks here, so the body carries three arrays and this paragraph has no
> `coinbaseOutputs` clause. The settlement transaction that receives those outputs ships;
> this package's obligation (`utxoTxIds.length >= 1`) is its half of that rule.
>
> ⛔ **This block read `⚠ AHEAD OF CODE` after both halves had landed**, which is the second decay
> trigger — implementation strands a **claim** while every name in it still resolves, so no
> deletion-grep reaches it (`TYPES_INTERFACE` → How a dispatch decays this contract).
>
> ✅ **A coinbase output IS a transaction output box, so it inherits the field-type table's
> `u64` bound by being one.** ⛔ **The bound is not a second statement that
> can rot out of step with the first**, which is the class of defect this file has found three
> times.
>
> ⚠ **All four pins leave this package, and none is dropped.** `value`, `owner` and `isTreasury` go
> as stated above. ⛔ **`lockedUntilBlock` GOES TOO — the claim that it had "no box-level
> equivalent" was FALSE, refuted 2026-08-17.** It is covered at apply **twice, and more strictly
> than the structural check ever was**:
>
> | Cover | Where | Strength |
> |---|---|---|
> | non-negative safe integer, **never `-0`** | `NODE_INTERFACE` → `validateTx`'s field-type table, `credit.lockedUntilBlock` | ⬆ `isU64Safe` **plus** `-0` |
> | `== height + CREDIT_MINER_REWARD_DELAY` | `MINING_INTERFACE` → coinbase invariants | ⬆ an equality, not `≥ block.height` |
>
> ⛔ **THE CHECK FOLLOWED ITS SUBJECT, WHICH IS WHY IT LEAVES.** It lived here because
> `coinbaseOutputs` was a **structural body field**. It is not one any more, so a rule about it is a
> rule about a transaction's contents — and that is apply's, by this package's own split.
>
> ⚠ **What is genuinely given up is PRE-RELAY coverage, and it is given up deliberately.** A block
> whose coinbase lock height is wrong now relays one hop before apply refuses it. ⛔ **Buying it back
> would cost a full `decodeStruct` of the last `utxoTxs` element on the relay path — read,
> exhaustion, re-encode, byte-compare, per block** — and would retire the opaque-bytes premise that
> makes `MAX_TX_BYTES` and the body bound cheap. **Refused** (2026-08-17): a block still needs valid
> PoW to be relayed at all, so the surface is bounded by PoW rather than by this check, and `net` is
> the one package with a measured performance defect on record.
>
> ⛔ **A new structural obligation replaces them, and it is SMALLER than first written:
> `utxoTxIds.length >= 1`.** Every block carries at least one transaction, because the settlement is
> one.
>
> ⚠ **"EXACTLY ONE, AND LAST" IS NOT A CHECK — IT IS A DEFINITION, and this text asserted otherwise.
> Corrected 2026-08-17.** The settlement **is** the last entry (NODE_INTERFACE → the settlement
> transaction), so there is no count to take and no *"settlement that is not last"* state to detect.
> Recognising a settlement anywhere else would mean recognising **what it spends** — the pool — which
> needs the UTXO set and is therefore node's. ⚠ **Node enforces it by recomputing each DERIVED
> quantity and constraining each PRODUCER-CHOSEN one — not by byte-identical reconstruction, which
> `?miner=` makes impossible** (NODE_INTERFACE → the settlement transaction). ⛔ **A definition
> dressed as a predicate reads like coverage and produces none.**
>
> ⚠ **A non-empty body is therefore the precondition, and it is new.** Every block must carry at
> least one transaction now, because the settlement is one. A structural check that admitted an
> empty `utxoTxIds` is admitting a block that cannot have paid its own coinbase.

Also checks **`pruneEntries`**: an array, each entry an object with a 64-char
`rootPostHash`, a `subtreePostIds` array of 64-char strings **with no repeated id**
(length equals set size), a 32-byte
`subtreeMerkleRoot`, a 32-byte `authorId`, and a 64-byte `authorSignature`. Byte-length fields must
be `Uint8Array`, not merely length-bearing — a CBOR payload can put any type
in any field, and the consumers of these fields call `Buffer.from(...)` and
`createHash().update(...)`, which throw on a number or object. Structure
validation is the layer that guarantees they never see one.

#### Each embedded transaction is bounded too

`utxoTxs[i].length > MAX_TX_BYTES` rejects, checked in the same loop that types the elements.

⛔ **Without it, `MAX_TX_BYTES` would not be a consensus bound at all.** `verifyTxStructure` carries
the same limit but has exactly one production caller — net's gossip `tx` validator — and
`@dagsocial/node` calls it zero times. So that check alone bounds transactions arriving by gossip and
nothing arriving inside a block: a miner could mine a transaction no peer could have relayed, and
every node would accept the block. A bound that binds users and not miners is an asymmetry with no
purpose.

**The measure here is the as-arrived byte length**, matching how the body bound weighs the same
array, and deliberately unlike `verifyTxStructure`'s re-encoding. It needs no decode — the elements
are already opaque bytes.

#### The body size bound — `utxoTxTreeByteLength` ≤ `MAX_BLOCK_BODY_BYTES`

`utxoTxTreeByteLength(block.utxoTxTree) > MAX_BLOCK_BODY_BYTES` rejects. **This is where the bound
belongs rather than in node's apply path**, because this function is what net runs *before relay*
(`NET_INTERFACE` → Stage 1 (net package, stateless)): enforced at apply instead, an oversized block is forwarded to
every peer first and refused second, which is the amplification the bound exists to prevent.

⛔ **It runs after every shape check above, and that order is load-bearing.** The sizer reads
`utxoTxs` element lengths, the prune-entry fields and the coinbase array; run before those are typed,
it reads a length off whatever a peer put there. The checks above are what make it total — the same
relationship the `pruneEntries` paragraph describes for `Buffer.from` and `createHash`.

**The measure is the bytes as they arrived.** `utxoTxs` are opaque, so a received block weighs what
the peer actually put in it — which is what this node stores and re-serves. See the transaction bound
under `verifyTxStructure`, which measures a re-encoding instead and says why the two differ.

⚠ **The bound holds a three-way relation, not a number** — `MAX_BLOCK_BODY_BYTES` <
`MAX_SERVE_BODY_BYTES` < `MAX_STREAM_BYTES` (`TYPES_INTERFACE` → Size caps). Moving this constant
above net's serve limit makes a block legal here and impossible to serve, which is worse than having
no bound: the block propagates by gossip and no syncing peer can ever fetch it.

Structure-only: `author` is checked for shape here, not truth — binding it to
the real post (when content is locally present) and to prune authorization is
stateful and lives in `@dagsocial/node` (see `NODE_INTERFACE.md`).

Every check is total: adversarial input yields `{ valid: false }`, never a
throw. That is what lets the block-apply funnel treat this function as its
gate (see `NODE_INTERFACE.md`, "Structure validation in the apply funnel").

> ✅ **RESOLVED 2026-08-09 — two never-true claims in this file, both found by reading the code
> beside the claim.** This description listed *"`hash` present and non-empty"*: no `hash` field
> exists on `BlockHeader` or `OrderingBlock` and the function checks none — the block hash is
> *derived* by `blockHash`, never carried, and a self-reported hash would be the "trust the
> object's own claim" pattern this package refuses. `verifyTxStructure` was described as checking
> `likeTarget`; it does not (the domain is node's `checkTxEnvelope`'s — see that function). Neither
> was found by a sweep, which is the argument for the standing contract-vs-code audit.

**The header-field checks in this function** (`prevBlockHash`, `utxoTxRoot`,
`stateRoot`, `validatorId`, `height`, `protocolVersion`, `powNonce`, `powTargetBits`, `createdAt`) are
**delegated to `verifyHeaderFieldDomains`** (Phase 1f), which is the single statement of that
domain. The error labels this function emits did not change — that is why the predicate returns a
reason rather than a boolean, and Phase 1e's teeth demonstration asserts those strings exactly. The
block-level checks (`pruneEntries`, `utxoTxIds`, `utxoTxs` alignment and weight,
`validatorSignature`) stay here: they are not header fields and no header predicate can see them.

> **The type and presence checks here are not subsumed by the positional codec**, because the codec's
> guarantee reaches one of this function's three production callers:
>
> | Caller | Upstream | Codec guarantee? |
> |---|---|---|
> | `net/src/gossip.ts` | `decodeOrderingBlock(raw)` | yes |
> | `net/src/serve-encode.ts` | **store read** — `encodeServable` does a bare `value as T` | **none** |
> | `node/src/services/block-apply.ts` | gossip, sync, `fork-resolution`, **and `block-creator`'s locally-mined block built in-process** | none for our own block |
>
> `serve-encode.ts`'s own failure message is `stored row is out of domain`. **These checks are the only
> gate on two of the three paths**, because store corruption can put any type in any field — a check
> deleted as "subsumed by the codec" removes the only thing standing between a corrupt row and a peer.
>
> **What a codec cannot know, and this function must never lose:**
>
> | Check | Why the codec can't |
> |---|---|
> | `height ≥ 1` | genesis is a semantic floor |
> | `powTargetBits ≥ ORDERING_BLOCK_POW_TARGET_FLOOR` | a policy floor |
> | `utxoTxIds.length === utxoTxs.length` | two independently-counted arrays |
> | `Number.isSafeInteger(height)` (`HEADER_DOMAIN` → `isU64Safe`) | `vlqU` decodes the full u64 range, so a height above 2^53 is *well-formed* at the codec layer and loses precision the moment it becomes a JS `number`; every VLQ-sourced value that reaches `number` needs this bound, and the sync path does not pass through the gossip validator |
>
> **Deleting checks needs the care of adding them.** Use the established deletion proof: exhaustive
> grep-to-zero plus diff purity, mutation only where behaviour changes.

### verifyBlockChainLink

```
verifyBlockChainLink(block: OrderingBlock, prevBlock: OrderingBlock): boolean
```

Returns `true` iff `block.header.prevBlockHash === blockHash(prevBlock.header)`
and `block.header.height === prevBlock.header.height + 1`. The previous block's
hash is **recomputed from its header**, never read off the block — a block
carries no `hash` field. Pure chain-link check — does not verify PoW,
signatures, or UTXO state transitions.

This is the sanctioned chain-link check: `applyOrderingBlock` calls it for
every non-genesis block (the genesis case has no previous block to link to).

### verifyHeaderChain

```
verifyHeaderChain(
  headers: BlockHeader[],                 // chronological; expected to start at anchor.height + 1
  anchor: { prevBlockHash: string; height: number },
  scheduledTarget: (height: number) => number,
): { ok: true; work: bigint; hashes: string[] }
 | { ok: false; index: number; reason: 'domain' | 'version' | 'height' | 'link' | 'target' | 'pow' }
```

**The header-level rules a chain must pass before any of its work counts**, applied to every header
in order. For header `i`: `blockHash(header) !== null` (`domain` — the whole
`verifyHeaderFieldDomains` domain, stated once by the hash) · `verifyProtocolVersion` (`version`) ·
`height === anchor.height + 1 + i` (`height`) · `prevBlockHash` equals `anchor.prevBlockHash` for
`i = 0` and `hashes[i − 1]` after (`link`) · `powTargetBits === scheduledTarget(height)` (`target`) ·
`verifyOrderingBlockPoW(header)` (`pow`). The first failure answers `{ ok: false, index, reason }`
for the whole segment — **refuse-whole, never skip**: skipping would let the peer choose which of its
headers count, and a header that cannot be interpreted decides nothing. Nothing partial is exposed.

On success, `work` is `cumulativeWork(headers)` — every header has passed `target` and `pow`, so no
term is `null` — and `hashes[i]` is `blockHash(headers[i])`. An empty segment is `{ ok: true, work:
0n, hashes: [] }`: a segment that adds nothing to the anchor carries no work. A non-array `headers`
is read as the empty segment — the same verdict, and it grants nothing: zero work never exceeds the
incumbent's and an empty `hashes` admits no block.

**The anchor is the fork point.** Its `prevBlockHash` is the hash of the block the segment must
build on — for a fork at `GENESIS_HEIGHT` it is `GENESIS_PREV_BLOCK_HASH` (TYPES_INTERFACE → Genesis
parent hash), the same value apply's genesis branch checks a height-1 block against.

**The schedule is injected, not imported.** This package is stateless and owns no
`expectedTarget`; the caller passes the network's schedule. A retarget therefore changes the
caller's function and nothing here — the retarget seam is the parameter.

**These are exactly the header-level checks of the apply funnel** (`applyOrderingBlock`: structure's
header domain and version, chain link, scheduled target, PoW), run once over a peer's segment before
it is scored and again by apply when it is applied. The validator signature is **not** among them:
`validatorSignature` rides the block, not the header, so it stays a body-stage check.

**M-5 applies.** Malformed input — non-object headers, a `NaN` height, an out-of-domain target —
answers `ok: false`; the function never throws. `NODE_INTERFACE → Fork choice decides on verified
headers` states how the caller classifies a refusal (window miss versus misbehaviour).

---

## Phased Validation Pipeline

Validation runs in order of increasing cost. A post failing phase N is
rejected before phase N+1 executes.

**Phase 1 — Structural (cheapest):**
- The transaction (and its packet) deserializes without error
- Commit field domains (`verifyPostCommitDomains`) — `contentHash` width, `author` width,
  refs hex and count within [0, MAX_PARENT_REFS], `type` in the table
- `protocolVersion` is supported
- The body, wherever it enters (`verifyPostBody`): `content` within [1, MAX_CONTENT_BYTES]
  UTF-8 bytes, no category-C characters, and `computeContentHash(content)` equals the
  commit's `contentHash`

**Phase 2 — Cryptographic (cheap):**
- The creating transaction's signature over its `TxId` verifies (node's
  `validateTx`) — a post has no signature and no PoW of its own

**Phase 3 — DAG integrity (moderate):**
- Every `parentRefs[i]` exists in local DAG or unconfirmed pool
- No duplicate post in local DAG (idempotent — treated as no-op, not error)

**Phase 4 — Content (variable cost, deferrable):**
- `verifyContentCharacters(content)` is not here: it runs inside `verifyPostBody` at every
  body entry (Phase 1), because a body that fails it must never be stored or relayed
- Content-specific validation (future: homoglyph detection, media checks)

Queries serve the DAG tip. Phase completion gates nothing a reader can observe.

**Protocol vs. local-policy rules:**
- Phases 1-3 are protocol rules — all nodes must enforce identically
- Phase 4 may include local-policy rules — configurable, non-consensus
- Local-policy rules are explicitly documented as such

---

## Usage in the Validation Pipeline

```
Stage 1 (@dagsocial/net — topic validators, before mesh forwarding)
  ├── tx topic     → decodeTxPacket → verifyTxStructure → the packet biconditional
  │                  (tx.post present ⟺ content present) → verifyPostBody(content, tx.post.contentHash)
  ├── body pull    → verifyPostBody over each returned body, against the row's commitment
  └── block topic  → verifyOrderingBlockStructure (+ chain-link / PoW pre-filters)

Stage 2 (@dagsocial/node — after receipt)
  ├── onTx         → validateTx (authorization, transitions, conservation — NODE_INTERFACE)
  ├── POST /posts  → verifyPostBody over `content`, then verifyPost over the commit
  │                  (field domains, refs, version, karma)
  ├── Fork resolution (resolveFork — a received block that extends nothing)
  │     └── verifyHeaderChain over the peer's segment, before any work is
  │           compared or any block fetched (NODE_INTERFACE → Fork choice
  │           decides on verified headers)
  └── Block receipt (applyOrderingBlock — the funnel every apply path passes
        through: gossip, sync, reorg — so no path can skip it)
        ├── verifyOrderingBlockStructure
        ├── verifyBlockChainLink (non-genesis: prevBlockHash against
        │     blockHash(prev header) + height increment)
        ├── verifyOrderingBlockPoW
        ├── verifyValidatorSignature (blockHash(header) signed with validatorId's key)
        └── State application (UTXO, post confirmation, mempool cleanup)
```

⛔ **One implementation per rule.** A stage that reimplements a check inline
builds a mirror, and two copies of a rule diverge — that is what mirrors do.
Stage 2 calls the same exported functions Stage 1 calls wherever both stages
state one rule.

Ordering block PoW is verified at receipt time; a post carries no PoW of its
own.

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
- Signatures verified with `crypto.verify(null, message, keyObj, sig)` and a KeyObject
  using a `KeyObject` created via `crypto.createPublicKey`
- SPKI DER prefix for Ed25519: `302a300506032b6570032100`
- **One PoW nonce encoding**: the ordering-block nonce is `encodeLE64`
  (`MINING_INTERFACE.md` → PoW Verification). A post carries no nonce.
- The integer-range guard (M-6): a nonce or `targetBits` that is not a
  non-negative safe integer within `u64` yields `false`, never a thrown
  `RangeError` — the guard prevents a throw from `BigInt` / `writeBigUInt64LE`.
  Validate with `Number.isInteger` (not a loose `typeof === 'number'`, which
  admits `NaN` and floats)
- Content limits measured in UTF-8 bytes, not characters
- A body check (`verifyPostBody`) never runs inside a transaction check, and a transaction
  check never reads content — the transaction carries a commit, the body travels apart
  (TYPES_INTERFACE → Layout — PostCommit, Layout — Post body)
- All functions are synchronous — no Promises, no callbacks
- Protocol version `PROTOCOL_VERSION` from `@dagsocial/types`
- Ordering-block hashing is over the **header**. The PoW preimage
  (`computePowHash`) is the encoded header with `powNonce` zeroed; the canonical
  `blockHash` is the encoded header with the solved `powNonce`. Neither includes
  `validatorSignature` — it is not a header field. The body binds via the header's
  `utxoTxRoot` / `stateRoot`.
