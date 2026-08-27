# NIPOPOW Interface Contract

**Component:** `@dagsocial/nipopow`
**Protocol version:** 1
**Last updated:** 2026-08-27

> ⚠ **AHEAD OF CODE — 2026-08-27.** This contract is written for the `nipopow-prover` unit; the
> package directory holds its `CLAUDE.md` and nothing else until that unit's code lands on the same
> branch. Retired when the unit's gate is green.

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
  header: BlockHeader            // the ten-field header (TYPES_INTERFACE → Layout — Block)
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
  suffixTail: BlockHeader[]      // the k − 1 headers above it, ascending; may be shorter only in a
                                 // hand-built object — the prover always emits k − 1
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
| `suffixTail.length ≤ k − 1` | — | the tail count, after `k` is known |
| `interlinks.length ≤ MAX_INTERLINKS` | 257 | every PoPowHeader (`TYPES_INTERFACE → Interlink vector`) |

### Constants

```typescript
export const MAX_NIPOPOW_PARAM = 128;      // m and k — provisional
export const MAX_NIPOPOW_PREFIX = 16_384;  // prefix entries — provisional
```

**The prefix bound's arithmetic, so it reproduces:** the prover keeps at most ~2m headers per
level (the m-th-from-last anchoring at each level plus the level below's members above it) over
at most 33 levels below 2³² blocks — 8 448 at `m = 128`; the reader bound is twice that. Both
numbers are provisional and belong to the constants-pinning session. At `m = k = 6` on a
million-block chain a proof is ~240 PoPowHeaders, ~200 KB.

⚠ **A retarget changes this contract.** The proof carries no difficulty headers because the target
is a constant per profile at every height (`MINING_INTERFACE → Difficulty Schedule`); a difficulty
adjustment is a `PROTOCOL_VERSION` bump and a new proof layout (`TYPES_INTERFACE → Interlink
vector` states the same for the vector). Nothing here reserves for it.

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
  profile: { expectedTarget: (height: number) => number; genesisId: string; protocolVersion: number },
): VerifyResult

VerifyResult =
  | { ok: true; headers: BlockHeader[]; tip: BlockHeader; tipHeight: number; suffixHead: PoPowHeader }
  | { ok: false; reason: 'parse-failed' | 'shape' | 'anchor' | 'domain' | 'version' | 'target'
                       | 'pow' | 'interlinks' | 'heights' | 'connections'; index?: number }
```

**The rules a proof must pass, in order; the first failure answers `{ ok: false, reason, index }`
for the whole proof — refuse-whole, never skip.** `index` is the position in the flattened
sequence `prefix ++ [suffixHead] ++ suffixTail` of the element that failed, where one element is
at fault.

1. **Shape.** `m ≥ 1`, `k ≥ 1`, `prefix` non-empty, `suffixTail.length ≤ k − 1` (`shape`). Bytes
   that do not decode are `parse-failed`.
2. **Anchor.** `prefix[0].header.height === 1` with an empty vector; when `profile.genesisId` is
   non-empty, `blockHash(prefix[0].header) === genesisId`; every other PoPowHeader's `interlinks[0]`
   equals `blockHash(prefix[0].header)` (`anchor`). The rule is one whether or not the profile pins
   — the pin only decides *which* block 1 is acceptable (`TYPES_INTERFACE → Network profiles`).
3. **Every header** — prefix, suffixHead and tail alike: `verifyHeaderFieldDomains` (`domain`),
   `protocolVersion === profile.protocolVersion` (`version`), `powTargetBits ===
   profile.expectedTarget(height)` (`target`) — **from the client's schedule, never from the
   header** — and `verifyOrderingBlockPoW` (`pow`).
4. **Every PoPowHeader:** `interlinkRoot(interlinks) === header.interlinkRoot` (`interlinks`).
5. **Heights** strictly increase across the flattened sequence (`heights`).
6. **Connections, strict adjacency** (`connections`). Each element of `prefix ++ [suffixHead]` from
   the second onward either carries its immediate predecessor's `blockHash` in its vector or has
   it as `prevBlockHash`; the suffix is parent-linked from `suffixHead` through every tail header.
   Ergo's verifier tolerates an eleven-entry lookback because its proofs carry injected
   difficulty headers; a Notis proof carries none, and every proof `proveWithReader` builds over a
   valid chain satisfies adjacency — **pinned by the package's property test over mined chains,
   not argued here.** If that test ever fails, this rule loosens and this contract says why.

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
compareProofs(a: NipopowProof, b: NipopowProof, m: number, profile): CompareResult
CompareResult =
  | { verdict: 'a' | 'b' | 'tie'; scoreA: bigint; scoreB: bigint; lca: BlockHeader }
  | { verdict: 'incomparable'; reason: 'no-common-ancestor' | 'm-mismatch' | 'invalid' }
```

KMZ17 §4.3, for two proofs the caller has **already verified** — the comparator runs `verifyProof`
on each (with `profile`) and answers `incomparable / invalid` if either fails, so it can be called
on bytes a client has not screened, but it re-derives nothing a passed verdict established.

- **`m` is the client's.** Both proofs must carry `m` equal to the parameter — the client asked
  every node for the same `(m, k)` — else `incomparable / m-mismatch`. This removes the asymmetry
  of comparing under one proof's own `m`.
- **The LCA** is the highest header present in both flattened chains by `blockHash`. Chains with
  no common header are `incomparable / no-common-ancestor` — under a pinned `genesisId` every
  valid proof shares block 1, so this arm is reachable only on an unpinned network.
- **Above the LCA:** `chainX = headers with height > lca.height`;
  `bestArg(chain, m) = max over μ ≥ 0 of 2^μ · |{ h ∈ chain : level(h) ≥ μ }|`, counting a level
  `μ ≥ 1` only while it holds at least `m` headers (`μ = 0` counts every header). `scoreA >
  scoreB` → `'a'`; `<` → `'b'`; equal → `'tie'` (the client keeps the proof it already holds).
- Levels come from each header's own PoW (`VALIDATION_INTERFACE → level`): a lying pointer can
  skip honest blocks and lower a score, never raise one.

`bestArg(headers: BlockHeader[], m: number): bigint` is exported beside it.

---

## proveWithReader

```
interface PopowHeaderReader {
  chainHeight(): number;
  popowHeaderByHash(hash: string): PoPowHeader | null;
  popowHeaderAtHeight(height: number): PoPowHeader | null;
  lastHeaders(n: number): BlockHeader[];                   // the n highest, ascending
  headersAfter(height: number, n: number): BlockHeader[];   // heights height + 1 … height + n, ascending
}

proveWithReader(reader: PopowHeaderReader, params: { m: number; k: number }): NipopowProof
  // throws ProofBuildError
```

The one prover, and the one throwing surface: its input is the caller's, not the wire's.

**Preconditions** (`ProofBuildError`, by `code`): `m` and `k` integers in `[1, MAX_NIPOPOW_PARAM]`
(`invalid-m` / `invalid-k`); `reader.chainHeight() ≥ m + k` (`chain-too-short`); every header the
walk needs is answered — a `null` for a required hash or height is `missing-popow-header`, **never
a partial proof**.

**The walk** — Ergo's production prover (`NipopowProverWithDbAlgs`), on the ascending vector:

1. **Suffix.** `lastHeaders(k)`: `suffixHead = popowHeaderByHash(blockHash(first))`, the rest the
   tail.
2. **Prefix, from the top level down.** With `M = suffixHead.interlinks.length − 1` and
   `anchoringHeight = 1`: for `i = M … 1`, follow `interlinks[i]` back — each hop
   `popowHeaderByHash`, stopping below `anchoringHeight` — collecting the level-`i` chain in
   ascending order; if the chain holds more than `m` headers, `anchoringHeight` becomes the height
   of its `m`-th from last. Level 0 has no pointer and is never walked (Ergo's "paper" prover's
   level-0 sweep is not built).
3. **Seed genesis** — `popowHeaderAtHeight(1)` — dedupe by height, sort ascending.

**Cost:** O(m · M + k) reader calls, every one a point lookup; no walk is O(chain height).

**Postconditions, pinned by tests:** `prefix[0]` is height 1; heights strictly ascending across
the flattened sequence; `suffixHead.header.height === chainHeight − k + 1` and the tail is the
`k − 1` headers above it; every proof built over a valid chain passes `verifyProof` with that
chain's profile — including rule 6's strict adjacency — and the proof's bytes decode to an equal
object.

```typescript
class ProofBuildError extends Error {
  code: 'invalid-m' | 'invalid-k' | 'chain-too-short' | 'missing-popow-header';
}
```

---

## The trust model — what a proof proves

Three rules, stated once here and consumed by `NODE_INTERFACE → Nipopow prover` and by every
light client:

1. **A proof carries headers and vectors.** Body validity — the validator signature, the
   transactions, the state transitions, the genesis state — is trusted to the PoW majority: a
   chain no honest full node accepts is an attacker's chain and loses on work. The SPV assumption,
   stated rather than assumed.
2. **The PoW target is the client's profile schedule, never a header field.** Rule 3 reads
   `expectedTarget(height)` from the profile the client was built with; a header's `powTargetBits`
   is checked against it, never trusted from it.
3. **Chain choice is the best proof among the nodes asked.** A client that asks one node can be
   eclipsed by it; asking two or more independent nodes and comparing is the client's own
   mitigation — no proof carries evidence about the nodes that were not asked.

---

## Preconditions
- Node.js ≥ 22
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
