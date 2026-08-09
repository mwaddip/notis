# Golden vectors — the positional wire format

Committed fixture bytes for `@dagsocial/types`' codec layer. Two jobs:

1. **Drift detector for Phases 2–5.** Every id, root and preimage in the system moves during the
   positional-format migration. This corpus is what separates *moved because the dialect changed*
   from *moved because something is wrong* — the migration's dominant risk is a real defect hiding
   inside a wall of expected failures.
2. **Conformance suite afterwards.** The `.json` files contain no TypeScript. An independent
   implementation reads them directly and checks itself against the same bytes. Half the reason the
   positional format exists is that "whatever `cbor-x` 1.6.4 emits" is not a specification anyone
   can write against — see `docs/specs/2026-08-09-positional-wire-format.md` §1.3.

Normative source for the layouts: `contracts/TYPES_INTERFACE.md` → Serialization.

## Files

| File | Contents |
|---|---|
| `primitives.json` | One group per row of the Primitives table, at its boundaries |
| `probe.json` | Struct-level vectors for the probe struct, plus struct-level rejections |
| `reject.json` | Byte strings the boundary check must refuse |
| `harness.ts` | Codec registry, the JSON value forms, the readable byte diff |
| `probe.ts` | The probe struct — a synthetic struct with a field of every kind |

Phases 2–5 add `post.json`, `boxes.json`, `block.json` beside these, in the same shape.

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

`{"$special": "NaN" \| "Infinity" \| "-Infinity" \| "undefined"}` expresses the values JSON has no
literal for. For a wrong *type*, write the raw JSON value and set `"raw": true`.

### Adding a struct codec (Phases 2–5)

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
