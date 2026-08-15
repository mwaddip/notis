# Golden vectors — the positional wire format

Committed fixture bytes for `@dagsocial/types`' codec layer. Two jobs:

1. **Drift detector.** Every id, root and preimage in the system is frozen here, so this corpus is
   what separates *moved because the dialect changed* from *moved because something is wrong* — the
   dominant risk in any format change is a real defect hiding inside a wall of expected failures.
2. **Conformance suite.** The `.json` files contain no TypeScript. An independent implementation
   reads them directly and checks itself against the same bytes. Half the reason the positional
   format exists is that "whatever `cbor-x` 1.6.4 emits" is not a specification anyone can write
   against (`contracts/TYPES_INTERFACE.md` → Serialization).

Normative source for the layouts: `contracts/TYPES_INTERFACE.md` → Serialization.

## Files

| File | Contents |
|---|---|
| `primitives.json` | One group per row of the Primitives table, at its boundaries |
| `probe.json` | Struct-level vectors for the probe struct, plus struct-level rejections |
| `reject.json` | Byte strings the boundary check must refuse |
| `post.json` | `postFieldBytes` — the post payload inside its creating transaction's `TxId` preimage |
| `boxes.json` | `canonicalBoxBytes` — box identity, one vector per box type, both states of `bond.inviteePublicKey`, and both states of `genesis_proof.payload` |
| `prune.json` | `serializePruneEntry` — the prune Merkle leaf preimage |
| `block.json` | The block header, the one body tree and the ordering-block framing, plus the coinbase leaf preimage |
| `harness.ts` | Codec registry, the JSON value forms, the readable byte diff |
| `probe.ts` | The probe struct — a synthetic struct with a field of every kind |
| `structs.ts` | The id-preimage codecs, the block codecs, the element codecs |

`block.json` covers `blockHeader`, `utxoTxTree` (with and without transactions
and coinbase outputs) and `orderingBlock` — each at a typical value and at its
smallest legal one, because the all-zeros case is where a transposition of two
same-width fields becomes invisible.

⛔ **The header is NINE fields.** `subBlockRoot` is gone and every position after
`prevBlockHash` shifted down by one, which is a renumbering rather than a
deletion in place — a reader keeping the old offsets produces a silently wrong
`blockHash`, not a decode error. The `blockHeader` vectors are what catch that.

It also covers `coinbaseOutput` **on its own**, not only inside the tree that
embeds it. It is a Merkle leaf preimage — `leafHash('coinbase', …)` under
`utxoTxRoot`, as `prune.json` already is for `leafHash('prune', …)`, and both now
sit under that same root — so node hashes it directly and a conformance
implementation must be able to check one leaf without building a tree around it.
The domain tag is **not** in the vector bytes; it is the caller's, which is what
makes the leaf preimage and the wire encoding the same bytes rather than merely
parallel ones.

**Reserved, never to be reused:** the vector names `subBlockEntry`,
`subBlockTree`, `subBlock`, `powNonceTail` and `powPreimage`, and the leaf domain
`'subblock'`. A post is a transaction, so there is no sub-block to encode and no
PoW nonce to append; `encodePost` is now exactly `postFieldBytes`, so the
`postFields` vectors pin the wire post too.

### Two kinds of struct codec, and the difference is the point

`probe.ts` writes **and** reads test-side. It is synthetic, so both halves are the harness's own
regression test.

`structs.ts` is the opposite, deliberately: **its write half IS the production function**
(`postPowPreimage`, `powNonceBytes`, `canonicalBoxBytes`, `serializePruneEntry`), and only the reader is written
test-side, from the layout tables in `contracts/TYPES_INTERFACE.md`. An encode assertion therefore
pins the shipped encoder rather than a lookalike, and the decode direction — parse with the
independent reader, assert exhaustion, re-encode through the *production* writer, byte-compare —
proves the preimage is self-delimiting and canonical, which a one-directional "these bytes are
frozen" assertion cannot. None of those three preimages is decoded anywhere in production; the
readers exist for that check and for the conformance role the corpus takes on afterwards.

Register a new struct the same way: production writer, independent reader, `registerStruct`.

## A vector may exceed a validation bound — silently, it may not

This corpus pins the **encodable** domain, which is deliberately wider than the valid one: the
sentinel discipline lives in that gap, and a field's domain is established upstream of the encoder,
never inside it (`TYPES_INTERFACE.md` → Totality). So `post/wide-numerics` carries a
`protocolVersion` of 2⁵³−1 and `post/multibyte-content` carries two `parentRefs` where
`MAX_PARENT_REFS` is 1 — both deliberately, because the writer has no cap and something must pin
what it does past one.

Two rules keep that from teaching the layout wrong:

- **A vector that exceeds a bound says so in its note, and names the bound.** A reader derives
  limits from the corpus, and an unannotated `02` count byte is where they derive the wrong one.
- **A vector named `typical` is protocol-typical.** Out-of-domain and boundary cases get names that
  say so — `minimal`, `wide-numerics`, `u64-max`.

`subBlockEntry/typical` and `subBlock/with-parent` are where both rules bite at once: each carries
one `parentRef` and says why in its note, because `MAX_PARENT_REFS` is 1 and a vector named
`typical` is where a reader goes looking for the bound.

## Adding a vector

Append to the `vectors` array of the relevant file:

```json
{
  "name": "group/case",
  "codec": "vlqU",
  "value": 128,
  "bytes": "8001",
  "note": "Why this case earns its place."
}
```

`test/golden.test.ts` picks it up with no code change. It is asserted **both directions**: `value`
encodes to `bytes`, and `bytes` decodes back to `value` — through `decodeStruct`, so every vector
gets all four boundary-check steps even when it is a single byte.

### Fields

| Field | Meaning |
|---|---|
| `name` | `group/case`. Must be unique within the file; appears verbatim in the test name |
| `codec` | A descriptor — see below |
| `value` | The value, in this file's JSON encoding — see below |
| `bytes` | Lowercase hex of the canonical bytes |
| `raw` | `true` → use `value` exactly as JSON gives it, skipping the per-codec parse. For malformed inputs |
| `decode` | `false` → the bytes are what a *malformed* value encodes to and must not decode back. Asserted to throw |
| `note` | Optional. Why the case exists, when the name does not say it |

### Codec descriptors

A bare string names a leaf codec; the object forms compose, so `{"arr": {"opt": "vlqU"}}` is valid.

| Descriptor | In-memory type | JSON form |
|---|---|---|
| `u8` | `number` | JSON number |
| `bool` | `boolean` | `true` / `false` |
| `vlqU`, `vlqS` | `number` | JSON number, or `{"$special": …}` |
| `vlqU64` | `bigint` | **decimal string** — JSON numbers cannot carry a u64 |
| `b32hex`, `b33hex`, `b64hex` | `string` | lowercase hex, exactly `2n` chars |
| `b32bytes`, `b64bytes` | `Uint8Array` | lowercase hex |
| `lp` | `Uint8Array` | lowercase hex |
| `lpUtf8` | `string` | JSON string |
| `{"arr": D}` | `T[]` | JSON array of `D`'s form |
| `{"opt": D}` | `T \| null` | `null` for absent, else `D`'s form |
| `{"enum8": "table"}` | `string` | the variant name |
| `probe` | `Probe` | object — see `probe.ts` |
| `subBlockEntry`, `coinbaseOutput` | the struct | object — `coinbaseOutput.value` is a **decimal string** (u64) |
| `powNonceTail` | `number` | JSON number — the nonce, not the bytes |
| `powPreimage` | `PostFields` + `powNonce` | object — `postFields`' form with one more key |

`{"$special": "NaN" \| "Infinity" \| "-Infinity" \| "undefined"}` expresses the values JSON has no
literal for. For a wrong *type*, write the raw JSON value and set `"raw": true`.

### Adding a struct codec

Build a `StructCodec` from `src/codec.ts`'s primitives in the order of its table in
`TYPES_INTERFACE.md`, wrap it as a `ValueCodec` with a `parse` for the JSON form, and call
`registerStruct('name', codec)`. `probe.ts` is the worked example; `struct.write` and `struct.read`
are laid out so they can be read side by side against the layout table, which is how a field-order
error gets caught by review rather than by a moved hash.

## Adding a rejection

Append to a `rejects` array:

```json
{
  "name": "non-minimal/vlqU-one-padded",
  "codec": "vlqU",
  "bytes": "8100",
  "failure": "non-canonical"
}
```

Exactly one of:

- **`failure`** — a `CodecError.failure` from the boundary check: `non-canonical`,
  `trailing-bytes`, `unencodable`, `reader-fault`.
- **`code`** — a `ReaderError.code` raised by `@dagsocial/wire` itself: `truncated`, `invalid-tag`,
  `vlq-overflow`, `array-too-large`.

The distinction is asserted, not decorative: a `code` vector additionally asserts the error is
**not** a `CodecError`, so a vector cannot quietly start passing for a different reason than it
claims.

## Why step 3 cannot be dropped

`readVlqU` accepts non-minimal encodings — `0x81 0x00` decodes to `1` exactly as `0x01` does, up to
ten bytes of padding per integer field — and `@dagsocial/wire` accepts them **deliberately**
(`WIRE_INTERFACE.md` → "Two asymmetries are deliberate"). Canonicity is enforced one layer up, by
re-encoding through the minimal-form writer and comparing bytes. It works *only* because decode is
permissive and re-encode is minimal; tightening either side for symmetry breaks it.

`reject.json`'s `non-minimal/*` group is the direct proof. Remove step 3 from `decodeStruct` and
those six vectors are the ones that stop failing — nothing else in the suite notices.

## Coverage the JSON cannot carry

`test/codec.test.ts` holds what a fixture file cannot express: the encode-side domain errors of the
throwing writers, the `unencodable` and `reader-fault` arms, `enum8`'s construction-time checks, and
the two traps that produce no byte difference at all — `undefined` taking `writeOption`'s *present*
branch, and `readBytes` handing back a view onto the caller's buffer.
