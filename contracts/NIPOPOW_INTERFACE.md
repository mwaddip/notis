# NIPOPOW Interface Contract

**Component:** `@dagsocial/nipopow`
**Protocol version:** 1
**Last updated:** 2026-10-24

## Scope

Non-interactive proofs of proof-of-work over Notis ordering-block headers — KMZ17 superblock
proofs: the proof object and its positional codecs, the verifier, the comparator, and the prover.
**Pure** — no I/O, no store, no network, no module-level state; the prover reads through a
caller-supplied reader. Depends on `@dagsocial/types` (the header, `updateInterlinks`,
`interlinkRoot`, the codec primitives) and `@dagsocial/validation` (`level`, `levelOfHit`, `powHit`,
`blockHash`, `verifyHeaderFieldDomains`, `verifyOrderingBlockPoW`, `verifyProtocolVersion`) and on
nothing else. Consumed by `@dagsocial/node` (the prover behind `GET /nipopow/proof/:m/:k` —
`NODE_INTERFACE → Nipopow prover`) and by light clients.

**Two rules this contract consumes and does not restate:** the interlink vector a proof walks is
`TYPES_INTERFACE → Interlink vector`; a header's level is `VALIDATION_INTERFACE → level`. Nothing
here computes a level or a vector of its own.

Exports from `packages/nipopow/src/index.ts`.

---

## Objects

### PoPowHeader

```
PoPowHeader {
  header: BlockHeader            // the eleven-field header (TYPES_INTERFACE → Layout — Block)
  interlinks: string[]           // hex(32) ids — the vector I(h) the header commits to
}
```

**Layout:** `lp(header)` ‖ `lp(interlinks)` — the header as `encodeHeader` bytes and the vector as
`encodeInterlinks` bytes (`vlqU(n) ‖ b32 × n`, `n ≤ MAX_INTERLINKS`, the count refused before the
first element), each behind its own length prefix and each decoded by its own canonical decoder —
the framing `OrderingBlock` gives its header (`TYPES_INTERFACE → Layout — Block`), and for the same
reason: the boundary check runs at the outer level and again inside each section. There is no
Merkle proof: the commitment is recomputed from the vector (`interlinkRoot(interlinks)`), and the
vector is what a verifier needs in full anyway.

### NipopowProof

```
NipopowProof {
  m: number                      // the security parameter the prover was asked for
  k: number                      // the suffix length the prover was asked for
  prefix: PoPowHeader[]          // heights strictly ascending; prefix[0] is height 1
  suffixHead: PoPowHeader        // the k-th header from the tip
  suffixTail: BlockHeader[]      // the k − 1 headers above it, ascending — exactly k − 1
}
```

**Layout:** `vlqU(m) ‖ vlqU(k) ‖ arr(PoPowHeader) ‖ PoPowHeader ‖ arr(lp(header))` — a PoPowHeader
is its two `lp` sections inline; a tail header is one `lp(header)`.

Both objects are `StructCodec`s, so `decodeStruct`'s re-encode compare makes every proof
canonical: a non-minimal encoding or trailing bytes is refused as a decode failure, never
normalised. **Bounds live inside `read` and are each refused before the first element they bound:**

| Bound | Value | Where |
|---|---|---|
| `1 ≤ m ≤ MAX_NIPOPOW_PARAM` | 128 | `m` |
| `1 ≤ k ≤ MAX_NIPOPOW_PARAM` | 128 | `k` |
| `prefix.length ≤ MAX_NIPOPOW_PREFIX` | 16 384 | the prefix count |
| `suffixTail.length = k − 1` | — | the tail count, after `k` is known — any other count is refused |
| `interlinks.length ≤ MAX_INTERLINKS` | 257 | every PoPowHeader (`TYPES_INTERFACE → Interlink vector`) |

### Constants

```typescript
export const MAX_NIPOPOW_PARAM = 128;      // m and k — provisional
export const MAX_NIPOPOW_PREFIX = 16_384;  // prefix entries — provisional
```

**The prefix bound's arithmetic, so it reproduces:** the prover keeps at most ~2m headers per
level (the m-th-from-last anchoring at each level plus the level below's members above it) over
≈ log₂(work / W_a) levels — levels are measured against the anchor target, so a chain 2⁷ above its
anchor and below 2³² blocks holds ≤ 39 of them: 9 984 at `m = 128`. Level 0 adds the sweep (→ proveWithReader):
about `m / p₁` headers, `p₁ = min(1, T_a / (2 · T_b))` the chance that a header mined at target `T_b` reaches level 1
against the anchor `T_a` — `m` on a chain at least twice as hard as its anchor, `2m` at the anchor, and at the floor
`2m · 2^f`, `f` the bits between the floor and the anchor: 3 on devnet (`16m`), 3.375 on mainnet and testnet (about
`21m`, 2 650 at `m = 128`, so 12 634 in all). The reader bound is 2¹⁴, above that with headroom, and `LEVEL_CAP`
bounds the level count absolutely. Both numbers are provisional (`CONSTANTS → nipopow`).

**What `m` costs**, measured 2026-10-15 with `packages/nipopow/scripts/bench-proof-m.mjs` on a 100 000-block chain
mined at its anchor's target, at `k = 20` — the proof's decode, `verifyProof` and one `compareProofs` against a second
copy, medians of nine runs pinned to performance cores of the i9-14900HX:

| `m` | PoPowHeaders | Proof | The route's JSON | Node 22 | Waterfox 140 |
|---|---|---|---|---|---|
| 6 | 101 | 65 KB | 130 KB | 30 ms | 52 ms |
| 12 | 156 | 106 KB | 212 KB | 47 ms | 83 ms |
| 24 | 307 | 219 KB | 438 KB | 97 ms | 162 ms |
| 48 | 580 | 424 KB | 848 KB | 181 ms | 315 ms |

The prover keeps about `m` headers a level — the bound above is the ceiling — so a proof grows with `m` and with the
log of the chain's length: at 20 000 blocks the `m = 24` proof is 183 KB.
**`k` is a block count, and under a moving target a k-deep suffix is read in work** — the reference's
own note; `k` is the client's own settlement depth, 20 by default, and not a full node's reorg horizon —
`maxReorgDepth` is per network and larger (`TYPES_INTERFACE → Chain reorganisation`; `CONSTANTS → Client
defaults`).

**A moving target changes no layout here.** The proof carries no difficulty headers, and needs none:
a superblock level is measured against the network's anchor target rather than the header's own
(`VALIDATION_INTERFACE → level`), so a count of superblocks is a count of work in anchor units whatever
a header declares and → compareProofs stays a work comparison; every target whose inputs the proof carries is
recomputed exactly (→ verifyProof, rule 3) — block 1's, and each header's whose parent is the element before it, the
level-0 sweep, the suffix head and the tail running contiguously as the chain they are drawn from, and block 1 being
every proof's first element. What the difficulty schedule (`MINING_INTERFACE → Difficulty Schedule`) moves is
`interlinkRoot` — a committed byte the fresh chain covers — not this contract's objects, codecs or
version.

---

## Codecs

| Export | Signature | Notes |
|---|---|---|
| `encodePoPowHeader(p)` | `(PoPowHeader) => Uint8Array` | Layout above |
| `decodePoPowHeader(bytes)` | `(Uint8Array) => PoPowHeader` | Inverse; throws types' `ReaderError` on a refused count, a truncation, a non-canonical encoding |
| `encodeNipopowProof(p)` | `(NipopowProof) => Uint8Array` | Layout above |
| `decodeNipopowProof(bytes)` | `(Uint8Array) => NipopowProof` | Inverse; the same refusals |

The decoders are the one place in this package that throws on wire input, and only with the
codec layer's own errors (`TYPES_INTERFACE → Serialization`); `verifyProof` catches them and answers
`parse-failed`. A caller decoding bytes itself owns that catch.

---

## verifyProof

```
verifyProof(
  proof: Uint8Array | NipopowProof,
  params: { m: number; k: number },  // the client's own — the m and k it asked every node for
  profile: {
    retarget: RetargetParams;        // VALIDATION_INTERFACE → asertTargetBits — the anchor's bits are the yardstick
    maxFutureDriftMs: number;        // MAX_FUTURE_DRIFT_MS
    nowMs: number;                   // the client's clock, injected
    genesisId: string;
    protocolVersionSchedule: readonly ProtocolEra[];   // TYPES_INTERFACE → Version
  },
): VerifyResult

VerifyResult =
  | { ok: true; headers: BlockHeader[]; tip: BlockHeader; tipHeight: number; suffixHead: PoPowHeader }
  | { ok: false; reason: 'parse-failed' | 'shape' | 'anchor' | 'domain' | 'version' | 'target'
                       | 'pow' | 'time' | 'clock' | 'interlinks' | 'heights' | 'connections'; index?: number }
```

**The rules a proof must pass, in order; the first failure answers `{ ok: false, reason, index }`
for the whole proof — refuse-whole, never skip.** `index` is the position in the flattened
sequence `prefix ++ [suffixHead] ++ suffixTail` of the element that failed, where one element is
at fault.

1. **Shape.** `m` and `k` equal `params.m` and `params.k`, each at least 1; `prefix` non-empty;
   `suffixTail.length === k − 1` (`shape`). Bytes that do not decode are `parse-failed`. The parameters are the
   verifier's, never the proof's: KMZ17's `Verify_{m,k}` requires a suffix of exactly its own `k` (→ The trust
   model).
2. **Anchor.** `prefix[0].header.height === 1` with an empty vector; when `profile.genesisId` is
   non-empty, `blockHash(prefix[0].header) === genesisId`; every other PoPowHeader's `interlinks[0]`
   equals `blockHash(prefix[0].header)` (`anchor`). The rule is one whether or not the profile pins
   — the pin only decides *which* block 1 is acceptable (`TYPES_INTERFACE → Network profiles`).
3. **Every header** — prefix, suffixHead and tail alike: `verifyHeaderFieldDomains` (`domain`),
   `verifyProtocolVersion(h.protocolVersion, h.height, profile.protocolVersionSchedule)` (`version`),
   `powTargetBits` inside the profile band
   `[floorBits, ceilingBits]` (`target`), and `verifyOrderingBlockPoW` against the header's **own**
   declared bits (`pow`). **A header whose parent the proof carries carries exactly the scheduled
   target** (`target`): block 1 carries `profile.retarget.anchorBits` — the height-1 block is not scheduled
   (`VALIDATION_INTERFACE → asertTargetBits`); every other element whose `prevBlockHash` is the `blockHash` of the
   element before it carries `asertTargetBits(profile.retarget, t_a, previous)`, `t_a` block 1's `createdAt` and
   `previous` the element before it — the inputs a full node schedules the header from
   (`MINING_INTERFACE → Difficulty Schedule`). On a proof `proveWithReader` builds, that is the
   level-0 sweep from its second header on, the suffix head and the tail; an element whose parent is not the
   element before it — a superblock reached by a vector hop, or the sweep's first header — is band-bounded alone,
   its parent absent. Declared bits are never trusted as work: a level is measured against the anchor target
   (`VALIDATION_INTERFACE → level`), so a cheap target buys no score; and where the parent is present a declared
   target is the schedule's, so a chained stretch carries the targets its own timestamps schedule, never cheaper
   ones of its choosing. **Time:** `createdAt` strictly increases across the flattened sequence
   (`time`) — an honest chain is monotone in time, so its every subsequence is — and the tip's
   `createdAt ≤ profile.nowMs + profile.maxFutureDriftMs` (`clock`), the acceptance rule a full node
   applies, so a proof cannot claim more real time than exists.
4. **Every PoPowHeader:** `interlinkRoot(interlinks) === header.interlinkRoot` (`interlinks`).
5. **Heights** strictly increase across the flattened sequence, and an element whose `prevBlockHash` is the
   `blockHash` of the element before it sits exactly one height above it (`heights`) — so the suffix, parent-linked
   throughout (rule 6), and the prefix's level-0 sweep (→ proveWithReader) run contiguously, as the chain they are
   drawn from does.
6. **Connections, strict adjacency** (`connections`). Each element of `prefix ++ [suffixHead]` from
   the second onward either carries its immediate predecessor's `blockHash` in its vector or has
   it as `prevBlockHash`; the suffix is parent-linked from `suffixHead` through every tail header.
   Ergo's verifier tolerates an eleven-entry lookback because its proofs carry injected
   difficulty headers; a Notis proof carries none, and every proof `proveWithReader` builds over a
   valid chain satisfies adjacency — **pinned by the package's property test over mined chains,
   not argued here.** If that test ever fails, this rule loosens and this contract says why.

> ⚠ **AHEAD OF CODE (2026-10-24).** Rule 3's scheduled target, and the trust model's rule 2 that restates it, lead
> `packages/nipopow/src/verify.ts`, which checks the schedule on the suffix tail alone and holds block 1, the level-0
> sweep and the suffix head to the band.

On success `headers` is the flattened sequence, `tip` its last element, `tipHeight` that header's
height, `suffixHead` the PoPowHeader a client verifies box proofs against
(`NODE_INTERFACE → Nipopow prover`, the light client's use).

**M-5 applies.** Malformed input — bytes that do not parse, a hand-built object with a
non-array `prefix`, a header outside its domain, a vector with a non-hex entry — answers
`ok: false`; the function never throws. `interlinkRoot` throws on a malformed vector, so the
vector's shape is checked before it is hashed, as `verifyHeaderChain` checks its anchor.

---

## compareProofs

```
compareProofs(a: NipopowProof, b: NipopowProof, params: { m: number; k: number }, profile): CompareResult
CompareResult =
  | { verdict: 'a' | 'b' | 'tie'; scoreA: bigint; scoreB: bigint; lca: BlockHeader }
  | { verdict: 'incomparable'; reason: 'no-common-ancestor' | 'invalid' }
```

KMZ17 §4.3, for two proofs the caller has **already verified** — the comparator runs `verifyProof`
on each (with `params` and `profile`) and answers `incomparable / invalid` if either fails, so it can be called
on bytes a client has not screened, but it re-derives nothing a passed verdict established.

- **`m` and `k` are the client's.** `verifyProof` holds each proof to `params` (rule 1) — the client asked every
  node for the same `(m, k)` — so a proof that declares another `m` or `k` answers `incomparable / invalid`, and
  both proofs are scored under the client's `m`, never under one proof's own.
- **The LCA** is the highest header present in both flattened chains by `blockHash`. Chains with
  no common header are `incomparable / no-common-ancestor` — under a pinned `genesisId` every
  valid proof shares block 1, so this arm is reachable only on an unpinned network.
- **Above the LCA:** `chainX = headers with height > lca.height`;
  `bestArg(chain, m) = max over μ ∈ [0, LEVEL_CAP] of 2^μ · |{ h ∈ chain : level(h, anchorBits) ≥ μ }|`, counting a
  level `μ ≥ 1` only while it holds at least `m` headers (`μ = 0` counts every header **that has a
  level**; a header below the yardstick counts nowhere). An honest proof keeps, at every level μ, every level-μ
  header from the level above's anchoring height up, down to level 0 (→ proveWithReader); so above any LCA, the
  lowest level whose kept span reaches below it holds every one of the honest chain's headers of that level above it —
  at level 0, the chain's own registered headers. A proof that left level 0 out would count only its level-1
  headers among the blocks above an LCA near its suffix — about half of them at the anchor's target — and a fork
  that carries all of its own headers would outscore it with fewer.
  `scoreA > scoreB` → `'a'`; `<` → `'b'`; equal → `'tie'` (the client keeps the proof it already holds).
- **The score is work, whatever the headers declare.** Levels are measured against the network's
  anchor target (`VALIDATION_INTERFACE → level`), so a header mined at its own target `T_b` reaches
  level ≥ μ with probability `T_a / (2^μ · T_b)` and a count at level μ estimates `work / (2^μ · W_a)`;
  `max_μ` recovers the work of a chain harder than the yardstick at the level where every block
  registers. **This is our construction, not a citation.** Ergo measures levels against the header's
  own target and verifies no prefix header's difficulty; the published variable-difficulty
  construction keeps own-target levels and adds an online round. The argument is the query-level one:
  a random-oracle query is a level-μ hit with a probability that depends on no target, so at every
  fully-registering level the counts are the constant-difficulty model's random variables. **A
  cheap-target chain therefore buys no score beyond its work**: its headers register levels against the anchor at the
  rate its work allows, so its proof scores as an honest proof of the same work would — where own-target levels gave
  it the lead every time. The package's property tests pin the mechanism over one cheap chain's floor headers — the
  registered count a binomial draw about its work, `bestArg` against the anchor at least half its work, own-target
  levels inflating the score by the target ratio (8×: the floor target is exactly 8× the anchor's) — and that the
  own-target control picks the cheap side in every comparison; and that a lower-difficulty chain of more work wins. Each
  runs where the model puts a re-mining's chance of flipping it far below one in a thousand. **How often a proof of
  less work wins at all is `m`'s to bound, not the yardstick's**: the deciding level holds `m` to about `2m`
  superblocks, so a score carries about `1/√m` relative noise, for a cheap chain and an honest one alike (measured
  2026-10-15 over 120 pairs of independent chains a row, `packages/nipopow/scripts/bench-proof-m.mjs`: three quarters
  of the honest work wins about 18% of comparisons at `m = 6`, 8% at 12, 4% at 24 and 2% at 48; half about 4% at 6
  and none of 120 pairs from 12; a quarter none of 120 at any `m`). The client's `m` is 24 (`CONSTANTS → Client defaults`). A lying pointer can skip honest blocks and lower a score, never raise one.

`bestArg(headers: BlockHeader[], m: number, anchorBits: number): bigint` is exported beside it — the
anchor bits are the yardstick its levels are measured against, and `μ` ranges over `[0, LEVEL_CAP]`, so it answers
every input: a height-1 header, whose level is ∞, counts at every level, and `m < 1` admits every level.

---

## proveWithReader

```
interface PopowHeaderReader {
  chainHeight(): number;
  popowHeaderByHash(hash: string): PoPowHeader | null;
  popowHeaderAtHeight(height: number): PoPowHeader | null;
  lastHeaders(n: number): BlockHeader[];                   // the n highest, ascending
}

proveWithReader(reader: PopowHeaderReader, params: { m: number; k: number }): NipopowProof
  // throws ProofBuildError
```

The one prover, and the one throwing surface: its input is the caller's, not the wire's.

**Preconditions** (`ProofBuildError`, by `code`): `m` and `k` integers in `[1, MAX_NIPOPOW_PARAM]`
(`invalid-m` / `invalid-k`); `reader.chainHeight() ≥ m + k` (`chain-too-short`); every header the
walk needs is answered — a `null` for a required hash or height is `missing-popow-header`, **never
a partial proof**.

**The walk** — KMZ17's prover (Algorithm 3), its levels `M … 1` walked as Ergo's production prover
(`NipopowProverWithDbAlgs`) walks them, on the ascending vector:

1. **Suffix.** `lastHeaders(k)`: `suffixHead = popowHeaderByHash(blockHash(first))`, the rest the
   tail.
2. **Prefix, from the top level down.** With `M = suffixHead.interlinks.length − 1` and
   `anchoringHeight = 1`: for `i = M … 1`, follow `interlinks[i]` back — each hop
   `popowHeaderByHash`, stopping below `anchoringHeight` — collecting the level-`i` chain in
   ascending order; if the chain holds more than `m` headers, `anchoringHeight` becomes the height
   of its `m`-th from last.
3. **Level 0, the sweep.** Every height from `anchoringHeight` to `suffixHead.header.height − 1`, each read by
   `popowHeaderAtHeight` — every header, whatever its level: one with no level against the anchor counts nowhere
   (→ compareProofs) but carries the parent link the sweep runs on (→ verifyProof, rules 5 and 6). KMZ17's level
   loop runs down to 0, and Ergo's paper prover (`NipopowAlgos.prove`) sweeps level 0; its production prover, whose
   walk step 2 follows, does not, and a proof without the sweep counts only its level-1 headers among the blocks
   above an LCA near the suffix (→ compareProofs).
4. **Seed genesis** — `popowHeaderAtHeight(1)` — dedupe by height, sort ascending.

**Cost:** O(m · M + S + k) reader calls, every one a point lookup. `S` is the sweep: about `m / p₁` headers
(→ Constants, the prefix bound's arithmetic), and longer only where level 1 holds `m` or fewer headers above the
anchoring height the levels above it left, which the sweep then starts from — on a young chain, height 1. Only the
sweep reads every height of a span.

**Postconditions, pinned by tests:** `prefix[0]` is height 1; heights strictly ascending across
the flattened sequence; every height from the anchoring height the level-1 walk leaves to `suffixHead`'s parent is in
the prefix; `suffixHead.header.height === chainHeight − k + 1` and the tail is the
`k − 1` headers above it; every proof built over a valid chain passes `verifyProof` with that
chain's profile and its own `m` and `k` — including rule 6's strict adjacency — and the proof's bytes decode to an
equal object.

```typescript
class ProofBuildError extends Error {
  code: 'invalid-m' | 'invalid-k' | 'chain-too-short' | 'missing-popow-header';
}
```

---

## The trust model — what a proof proves

Five rules, stated once here and consumed by `NODE_INTERFACE → Nipopow prover` and by every
light client:

1. **A proof carries headers and vectors.** Body validity — the validator signature, the
   transactions, the state transitions, the genesis state — is trusted to the honest share of the PoW:
   a chain no honest full node accepts is an attacker's chain, and a proof of it stands against the
   honest chain's on work (→ rule 5). The SPV assumption, stated rather than assumed.
2. **A header's declared target is never trusted as work.** Rule 3 checks every header's PoW against
   its own declared bits and the bits against the profile band, recomputes every target whose parent the
   proof carries from the schedule the client was built with, and measures every level against the profile's anchor
   target — so what a proof scores is work in the client's own unit, and a header's `powTargetBits`
   decides its validity, never its weight.
3. **Chain choice is the best proof among the nodes asked.** A client that asks one node can be
   eclipsed by it; asking two or more independent nodes and comparing is the client's own
   mitigation — no proof carries evidence about the nodes that were not asked.
4. **A proof is held to the client's own parameters.** `verifyProof` and `compareProofs` take the `m` and `k` the
   client asked every node for, and refuse a proof that declares others or carries a suffix of another length
   (→ verifyProof, rule 1) — KMZ17's verifier is `Verify_{m,k}`, its own `k` the length of the suffix it requires.
   The suffix head, the header a client proves state against, is therefore the client's `k` deep: a `stateRoot` a
   node chose stands there only beneath `k − 1` headers mined at the schedule's own targets (→ verifyProof,
   rule 3), on a chain whose proof outscores the honest one. **The tip is one header deep**: its `stateRoot` stands
   beneath no header but its own — one block at the schedule's target, which a node can mine over the honest tip with
   a root of its choosing — so a client proves what it acts on at the suffix head, and reads the tip only for what has
   landed since.
5. **The hashrate share a proof comparison tolerates is not established.** The comparison is our construction
   (→ compareProofs, "The score is work, whatever the headers declare"), and the analysis it builds on needs an
   adversary below one quarter for its level-comparison lemma, by its authors' own note in KMZ17's LaTeX source; how
   often a proof of less work wins is measured, not proven (→ compareProofs). Below the anchor's target few headers
   register a level, so a short fork is decided by few of them: in a simulation of the comparison (2026-10-15 — the
   walk with the level-0 sweep, the fork's proof carrying every header it has, `m = 24`, 1 000 trials a cell), a
   fork of 40 blocks against the honest chain's 50, both at one target, won about 14% of comparisons at the anchor's
   target and 39% at the floor's. **While a network's hashrate is low, a client's protection is the nodes it asks**
   (rule 3): a seed list of nodes run by operators the client trusts — the extension's is its build's
   (`WEB_INTERFACE → The extension`).

---

## Preconditions
- Node.js ≥ 24
- `@dagsocial/types` and `@dagsocial/validation` built and importable — the only dependencies

## Postconditions
- Build produces `dist/index.js` (ESM) + `dist/index.d.ts`
- Every exported function is pure — no I/O, no side effects, no module-level state
- `verifyProof` and `compareProofs` never throw; `proveWithReader` throws `ProofBuildError` only;
  the decoders throw the codec layer's `ReaderError` only

## Invariants
- Must not import from `@dagsocial/node`, `@dagsocial/net` or `@dagsocial/wire` (wire's primitives
  reach it through `@dagsocial/types`)
- Every count bound is refused before the first element it bounds
- No level and no vector is computed here: `level` / `levelOfHit` are validation's,
  `updateInterlinks` / `interlinkRoot` are types'
- A proof's bytes are canonical: `decode(encode(p))` equals `p`, and any other byte string for the
  same object is refused
