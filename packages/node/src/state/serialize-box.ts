import {
  ReaderError,
  boxRecordBytes,
  boxRecordFromBytes,
  decodeStruct,
  encodeStruct,
  readU8,
  readVlqU,
  readVlqU64,
  writeU8OrThrow,
  writeVlqU,
  writeVlqU64OrThrow,
} from '@dagsocial/types';
import type { AnyBox, BoxGuard, StructCodec } from '@dagsocial/types';
// Type-only: erased at compile time, so state/ does not gain a runtime edge
// into the store module graph.
import type { IdentityRecord } from '../store/identity-records.js';

/**
 * `guard` per box type — the decode-side inverse of the encoder dropping it.
 *
 * `guard` is not in the value bytes (C10, `TYPES_INTERFACE` → Layout — Boxes:
 * "**`guard` is absent** — it is a pure function of `boxType`"). It was in the
 * cbor payload, so dropping it is a real change to what the value carries; it
 * is lossless because every box interface declares `guard` as a **single string
 * literal**, not a union, so the discriminator determines it completely. This
 * table is that function written out, and the `Record` type makes a new box
 * type a compile error here rather than an `undefined` guard at runtime.
 */
const GUARD_FOR: Record<AnyBox['boxType'], BoxGuard> = {
  karma: 'owner_signature',
  credit: 'owner_signature',
  invite: 'hash_preimage_with_bond',
  bond: 'bond_dual',
  post_lock: 'block_apply',
  vouch: 'owner_signature',
};

/**
 * Identity-record discriminator (Spec G phase B).
 *
 * Deliberately **outside** the box discriminator's range, with the high bit
 * set: "box" versus "not a box" is a single bit test, and the box-type space
 * stays open for future box kinds without ever colliding with an entity
 * discriminator.
 *
 * ⚠ **The box side is `enum8(boxType)` — `0` karma … `6` vouch, `3` reserved —
 * and this package no longer carries a second numbering.** It used to: an AVL
 * tag of `0x01` karma … `0x07` vouch, written years apart from `enum8` and
 * never put beside it. The two did not differ by a constant — the retired-`like`
 * reservation sat in a *different position* (`0x03` between credit and invite
 * here; `3` between invite and bond there) — so `invite` was `+2` while
 * everything else was `+1`. Composing them, `avlTag ‖ boxRecordBytes`, would
 * have written the box type twice in two disagreeing numberings in adjacent
 * bytes. `enum8` won (Phase 5, 2026-08-10; `NODE_INTERFACE` → "Two entity
 * kinds"). The discipline the old numbers protected — a retired type's tag is
 * never reused — survives intact, because `enum8` reserves `3` too.
 */
export const IDENTITY_RECORD_TAG = 0x80;

/**
 * Serialize an AnyBox to its AVL value bytes.
 *
 * **The value IS `boxRecordBytes` — no wrapper, no tag byte of our own.**
 * `boxRecordBytes` begins with `enum8(boxType)`, so it is already
 * self-describing, and `TYPES_INTERFACE` → Layout — Boxes defines it as "what
 * the AVL value and the store hold". One encoder owns the format; this function
 * is the naming of it, not a second composition step.
 *
 * That equality makes an existing claim exact rather than approximate:
 * **`boxId = blake2b512(BOX_ID_DOMAIN ‖ avlValue)[0:32]`**, so a light client
 * recomputes the AVL *key* from the value it was served. Under the cbor form it
 * was only nearly true — the value carried `guard`, which the id derivation does
 * not consume, and omitted `boxType`, which it does.
 *
 * ## What the positional layout retires, and why the reasoning still matters
 *
 * Three mechanisms lived here solely because cbor-x emitted map keys in
 * insertion order. All three are gone, and none of them is missed:
 *
 * - **`sortKeys`** imposed a caller-independent key order because key order was
 *   consensus-visible in the `stateRoot`. `post_lock` had its producer and
 *   `rowToBox` transposed (`originalValue`/`createdAtBlock`), so wiping the AVL
 *   store without wiping the chain silently changed the root (Spec G phase G3b).
 *   **A positional layout has no keys**: field order is the layout's, and a
 *   producer can no longer get it wrong because it no longer chooses it. The
 *   G3b property is now structural rather than enforced at one site.
 * - **`normaliseFields` / `UINT8ARRAY_FIELDS`** converted cbor-x's `Buffer`
 *   output back to `Uint8Array` so round-trip equality held. `readBytesN`
 *   returns what the layout says.
 * - **`boxEncoder`** (`variableMapSize: false`, `useRecords: false`,
 *   `tagUint8Array: false`) forced cbor-x to be deterministic. There is no
 *   encoder to configure, and `decodeStruct` re-encodes and byte-compares, so
 *   non-canonical input is rejected rather than merely unlikely.
 *
 * The **key-set-exactness** hazard goes with them: cbor-x distinguished an
 * absent key from a present-but-`undefined` one and counted both in the map
 * header, so a box rebuilt by `rowToBox` with explicit `undefined` provenance
 * hashed differently from the same box built by a producer — a restart-triggered
 * fork from nothing but an object shape. A layout writes its declared fields and
 * reads its declared fields; a stray key is unrepresentable.
 */
export function serializeBox(box: AnyBox): Uint8Array {
  return boxRecordBytes(box, box.txId, box.index);
}

/**
 * The identity record's AVL value — `NODE_INTERFACE` → Layout — IdentityRecord.
 *
 * **The tag is field 1 of the layout, not a wrapper around it**, exactly as
 * `enum8(boxType)` is field 1 of the box record rather than a prefix bolted on
 * outside it. One encoder, one byte string, no composition step where a caller
 * could disagree about ordering.
 *
 * Written as a `StructCodec` so `encodeStruct`/`decodeStruct` apply — which is
 * what gives the record the same four-part boundary check the box arm gets
 * (spec §2.1): project onto the schema, assert the reader is exhausted,
 * re-encode and byte-compare. Step 3 is the one that matters most here and had
 * no cbor-era equivalent: without it, non-minimal VLQ means two byte strings
 * decode to one record, which is two AVL values for one state.
 *
 * `likeCarry` is **always written, zero included** (P2-D). The cbor reason —
 * conditional presence changed the map header and forked the bytes — is retired
 * by construction, since a layout has no header to count. The rule stands on
 * the plainer ground that the field is part of the record and a layout writes
 * every field. `bigint` likewise stays the type, but its justification moved:
 * under `vlqU64` a `number` and a `bigint` of equal value encode **identically**,
 * so the type no longer guards the bytes — it guards the `safeIntegers` row
 * boundary against a silent `Number()` coercion, which is a different and still
 * live reason.
 *
 * Domains, per spec §2.5, belong upstream: the two heights are `vlqU`, total by
 * sentinel, so an out-of-domain height collides rather than panicking;
 * `likeCarry` is `vlqU64` and `writeVlqU64OrThrow` throws outside `[0, 2⁶⁴)`,
 * with per-block like settlement — its only writer, bounded by
 * `LIKES_PER_KARMA_PAYOUT` — establishing that domain.
 */
const IDENTITY_RECORD: StructCodec<IdentityRecord> = {
  name: 'identityRecord',
  write(w, record) {
    writeU8OrThrow(w, IDENTITY_RECORD_TAG);
    writeVlqU(w, record.lastActivityBlock);
    writeVlqU(w, record.lastDecayBlock);
    writeVlqU64OrThrow(w, record.likeCarry);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== IDENTITY_RECORD_TAG) {
      // ReaderError rather than a bare Error: `decodeStruct` passes it through
      // as-is, where anything else is wrapped as a `reader-fault`. Same shape
      // as `enum8`'s unknown-tag rejection on the box arm.
      throw new ReaderError(
        `identityRecord: not an identity record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    return {
      lastActivityBlock: readVlqU(r),
      lastDecayBlock: readVlqU(r),
      likeCarry: readVlqU64(r),
    };
  },
};

/**
 * Serialize an identity record to its AVL value bytes.
 *
 * The AVL key is `blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32]` (see
 * `store/identity-records.ts`), not part of the value — the same split boxes
 * use.
 */
export function serializeIdentityRecord(record: IdentityRecord): Uint8Array {
  return encodeStruct(IDENTITY_RECORD, record);
}

/** Deserialize bytes produced by `serializeIdentityRecord`. */
export function deserializeIdentityRecord(bytes: Uint8Array): IdentityRecord {
  return decodeStruct(IDENTITY_RECORD, bytes);
}

/**
 * Deserialize an AVL box value back into a box (without `id`).
 *
 * The box `id` is NOT restored — callers must supply it separately (it is the
 * AVL key, and `deserializeBoxWithId` is the helper that reattaches it).
 *
 * Rejects the record tag rather than mis-decoding it. The tree holds two entity
 * kinds and their keys are indistinguishable from outside — both are 32 bytes of
 * hash output — so a caller that can see either value MUST dispatch on the tag
 * via `deserializeAvlValue`, not assume "box". `0x80` is outside `enum8`'s tag
 * set, so the layer below would reject it anyway; the explicit check is here to
 * say *which* kind arrived rather than "unknown tag 128".
 *
 * `guard` is reattached from `GUARD_FOR` because the bytes do not carry it.
 */
export function deserializeBox(bytes: Uint8Array): Omit<AnyBox, 'id'> {
  if (bytes.length > 0 && bytes[0] === IDENTITY_RECORD_TAG) {
    throw new Error('Value is an identity record, not a box');
  }

  const { candidate, txId, index } = boxRecordFromBytes(bytes);
  return {
    ...candidate,
    guard: GUARD_FOR[candidate.boxType],
    txId,
    index,
  } as Omit<AnyBox, 'id'>;
}

/** A decoded AVL value, discriminated by its tag byte. */
export type AvlValue =
  | { kind: 'box'; box: Omit<AnyBox, 'id'> }
  | { kind: 'record'; record: IdentityRecord };

/**
 * Kind-dispatching decoder — what any caller that can see either entity uses.
 *
 * Phase D owes the proof endpoint this: `GET /api/v1/proof/:boxId` decodes
 * whatever value a key resolves to, and a client can ask for a record key
 * because keys are indistinguishable from outside.
 *
 * The dispatch is on byte 0 and survives the codec migration unchanged, which
 * is the point — it is an entity-kind question, not a codec concern.
 */
export function deserializeAvlValue(bytes: Uint8Array): AvlValue {
  if (bytes.length === 0) throw new Error('Truncated AVL value');
  if (bytes[0] === IDENTITY_RECORD_TAG) {
    return { kind: 'record', record: deserializeIdentityRecord(bytes) };
  }
  return { kind: 'box', box: deserializeBox(bytes) };
}

/**
 * Full roundtrip helper: deserializes and restores the `id` field.
 */
export function deserializeBoxWithId(id: string, bytes: Uint8Array): AnyBox {
  const fields = deserializeBox(bytes);
  return { id, ...fields } as AnyBox;
}
