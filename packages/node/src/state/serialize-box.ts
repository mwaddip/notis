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
 * "**`guard` is absent** — it is a pure function of `boxType`"). Omitting it is
 * lossless because every box interface declares `guard` as a **single string
 * literal**, not a union, so the discriminator determines it completely. This
 * table is that function written out, and the `Record` type makes a new box
 * type a compile error here rather than an `undefined` guard at runtime.
 */
const GUARD_FOR: Record<AnyBox['boxType'], BoxGuard> = {
  karma: 'owner_signature',
  credit: 'owner_signature',
  invite: 'hash_preimage_with_bond',
  genesis_proof: 'unspendable',
  bond: 'bond_dual',
  post_lock: 'block_apply',
  vouch: 'owner_signature',
};

/**
 * Identity-record discriminator (`NODE_INTERFACE` → "Two entity kinds").
 *
 * Deliberately **outside** the box discriminator's range, with the high bit
 * set: "box" versus "not a box" is a single bit test, and the box-type space
 * stays open for future box kinds without ever colliding with an entity
 * discriminator.
 *
 * ⚠ **`enum8(boxType)` — `0` karma … `6` vouch — is the box numbering, and this
 * package must never carry a second one.** Composing a local tag with the
 * record's own, `tag ‖ boxRecordBytes`, writes the box type twice in adjacent
 * bytes under two schemes nothing forces to agree, and they need not differ by
 * a constant: a number assigned at a different position shifts one type and not
 * its neighbours. The rule the numbering protects — a tag is never *renumbered*,
 * because `boxType` is the first byte of every box's identity preimage
 * (`TYPES_INTERFACE` → Primitives) — is exactly what a second table would
 * silently break.
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
 * That equality makes the id claim exact rather than approximate:
 * **`boxId = blake2b512(BOX_ID_DOMAIN ‖ avlValue)[0:32]`**, so a light client
 * recomputes the AVL *key* from the value it was served.
 *
 * The layout is **positional**, which is what makes the whole key-order and
 * key-set class unreachable here: field order is the layout's, so a producer
 * cannot get it wrong because it never chooses it; a layout writes its declared
 * fields and reads its declared fields, so a stray key — or a present-but-
 * `undefined` one — is unrepresentable rather than a divergence risk. Canonical
 * form is checked, not assumed: `decodeStruct` re-encodes and byte-compares, so
 * a non-minimal encoding is rejected rather than merely unlikely.
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
 * (TYPES_INTERFACE → "The boundary check"): project onto the schema, assert the
 * reader is exhausted, re-encode and byte-compare. Step 3 is the one that
 * matters most here: without it, non-minimal VLQ means two byte strings decode
 * to one record, which is two AVL values for one state.
 *
 * `likeCarry` is **always written, zero included** — the field is part of the
 * record and a layout writes every field. `bigint` is its type for the
 * `safeIntegers` row boundary, not for the bytes: under `vlqU64` a `number` and
 * a `bigint` of equal value encode **identically**, so what the type guards is a
 * silent `Number()` coercion at the store edge.
 *
 * Domains belong upstream (TYPES_INTERFACE → "Totality"): the two heights are
 * `vlqU`, total by sentinel, so an out-of-domain height collides rather than
 * panicking;
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
