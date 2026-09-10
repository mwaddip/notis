import {
  ReaderError,
  boxRecordBytes,
  boxRecordFromBytes,
  decodeStruct,
  encodeStruct,
  readU8,
  readVlqU,
  readVlqU64,
  readBytesN,
  writeU8OrThrow,
  writeVlqU,
  writeVlqU64OrThrow,
  writeBytesNOrThrow,
} from '@dagsocial/types';
import type { AnyBox, StructCodec } from '@dagsocial/types';
// Type-only: erased at compile time, so state/ does not gain a runtime edge
// into the store module graph.
import type { IdentityRecord, NetworkRecord } from '../store/identity-records.js';
import type { HolderRecord } from '../store/usernames.js';

// NODE_INTERFACE → Entity kinds
export const IDENTITY_RECORD_TAG = 0x80;
export const NETWORK_RECORD_TAG = 0x81;
export const NAME_RECORD_TAG = 0x82;
export const HOLDER_RECORD_TAG = 0x83;

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
 * `invitedAtBlock` and `lifetimeLikesReceived` are **always
 * written, zero included** — they are fields of the record and a layout writes
 * every field. Conditional presence would reopen the key-set-exactness fork.
 * `bigint` is the two counters' type for the `safeIntegers` row boundary, not for
 * the bytes: under `vlqU64` a `number` and a `bigint` of equal value encode
 * **identically**, so what the type guards is a silent `Number()` coercion at the
 * store edge.
 *
 * Domains belong upstream (TYPES_INTERFACE → "Totality"): the three heights are
 * `vlqU`, total by sentinel, so an out-of-domain height collides rather than
 * panicking; `lifetimeLikesReceived` is `vlqU64` and `writeVlqU64OrThrow` throws
 * outside `[0, 2⁶⁴)`. Per-block like settlement is its only writer and it only
 * ever adds, bounded by how many likes one identity can receive, so it
 * establishes the domain.
 *
 * ⛔ **The outstanding like accrual is NOT a field here, and its absence is the
 * point.** The accrual sits in a `LikeAccrualBox` carry box, so **the box IS the
 * carry** (ARCHITECTURE → Likes) — a field here as well would be two
 * representations of one quantity, free to disagree. The carry reaches the
 * `stateRoot` either way, because every box does.
 */
const IDENTITY_RECORD: StructCodec<IdentityRecord> = {
  name: 'identityRecord',
  write(w, record) {
    writeU8OrThrow(w, IDENTITY_RECORD_TAG);
    writeVlqU(w, record.lastActivityBlock);
    writeVlqU(w, record.lastDecayBlock);
    writeVlqU(w, record.invitedAtBlock);
    writeVlqU64OrThrow(w, record.lifetimeLikesReceived);
    writeVlqU(w, record.memberSinceBlock);
    writeVlqU(w, record.memberBar);
    writeVlqU(w, record.memberVouches);
    writeVlqU64OrThrow(w, record.memberLikes);
    writeVlqU(w, record.invitesUsed);
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
      invitedAtBlock: readVlqU(r),
      lifetimeLikesReceived: readVlqU64(r),
      memberSinceBlock: readVlqU(r),
      memberBar: readVlqU(r),
      memberVouches: readVlqU(r),
      memberLikes: readVlqU64(r),
      invitesUsed: readVlqU(r),
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
 * Network-record AVL value — `NODE_INTERFACE` → Network record.
 * `u8 0x81 ‖ vlqU(memberCount)`.
 */
const NETWORK_RECORD: StructCodec<NetworkRecord> = {
  name: 'networkRecord',
  write(w, record) {
    writeU8OrThrow(w, NETWORK_RECORD_TAG);
    writeVlqU(w, record.memberCount);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== NETWORK_RECORD_TAG) {
      throw new ReaderError(
        `networkRecord: not a network record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    return { memberCount: readVlqU(r) };
  },
};

export function serializeNetworkRecord(record: NetworkRecord): Uint8Array {
  return encodeStruct(NETWORK_RECORD, record);
}

export function deserializeNetworkRecord(bytes: Uint8Array): NetworkRecord {
  return decodeStruct(NETWORK_RECORD, bytes);
}

/** Name-record AVL value — NODE_INTERFACE → Username records. `u8(0x82) ‖ b32(boxId)`. */
export interface UsernameAvlRecord { boxId: string }

const USERNAME_RECORD: StructCodec<UsernameAvlRecord> = {
  name: 'usernameRecord',
  write(w, record) {
    writeU8OrThrow(w, NAME_RECORD_TAG);
    writeBytesNOrThrow(w, Buffer.from(record.boxId, 'hex'), 32);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== NAME_RECORD_TAG) {
      throw new ReaderError(
        `usernameRecord: not a name record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    return { boxId: Buffer.from(readBytesN(r, 32)).toString('hex') };
  },
};

export function serializeUsernameRecord(record: UsernameAvlRecord): Uint8Array {
  return encodeStruct(USERNAME_RECORD, record);
}

export function deserializeUsernameRecord(bytes: Uint8Array): UsernameAvlRecord {
  return decodeStruct(USERNAME_RECORD, bytes);
}

/**
 * Holder-record AVL value — NODE_INTERFACE → Username records.
 * `u8(0x83) ‖ u8(claimAvailable) ‖ opt(b32(boxId))`.
 */
const HOLDER_RECORD: StructCodec<HolderRecord> = {
  name: 'holderRecord',
  write(w, record) {
    writeU8OrThrow(w, HOLDER_RECORD_TAG);
    writeU8OrThrow(w, record.claimAvailable ? 1 : 0);
    if (record.boxId !== null) {
      writeU8OrThrow(w, 1);
      writeBytesNOrThrow(w, Buffer.from(record.boxId, 'hex'), 32);
    } else {
      writeU8OrThrow(w, 0);
    }
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== HOLDER_RECORD_TAG) {
      throw new ReaderError(
        `holderRecord: not a holder record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    const claimAvailable = readU8(r) !== 0;
    const hasBox = readU8(r);
    const boxId = hasBox ? Buffer.from(readBytesN(r, 32)).toString('hex') : null;
    return { claimAvailable, boxId };
  },
};

export function serializeHolderRecord(record: HolderRecord): Uint8Array {
  return encodeStruct(HOLDER_RECORD, record);
}

export function deserializeHolderRecord(bytes: Uint8Array): HolderRecord {
  return decodeStruct(HOLDER_RECORD, bytes);
}

// NODE_INTERFACE → Entity kinds
export function deserializeBox(bytes: Uint8Array): Omit<AnyBox, 'id'> {
  if (bytes.length > 0 && bytes[0] === IDENTITY_RECORD_TAG) {
    throw new Error('Value is an identity record, not a box');
  }
  if (bytes.length > 0 && bytes[0] === NETWORK_RECORD_TAG) {
    throw new Error('Value is a network record, not a box');
  }
  if (bytes.length > 0 && bytes[0] === NAME_RECORD_TAG) {
    throw new Error('Value is a name record, not a box');
  }
  if (bytes.length > 0 && bytes[0] === HOLDER_RECORD_TAG) {
    throw new Error('Value is a holder record, not a box');
  }

  const { candidate, txId, index } = boxRecordFromBytes(bytes);
  return {
    ...candidate,
    txId,
    index,
  } as Omit<AnyBox, 'id'>;
}

/** A decoded AVL value, discriminated by its tag byte — NODE_INTERFACE → Entity kinds. */
export type AvlValue =
  | { kind: 'box'; box: Omit<AnyBox, 'id'> }
  | { kind: 'record'; record: IdentityRecord }
  | { kind: 'network'; network: NetworkRecord }
  | { kind: 'username'; username: UsernameAvlRecord }
  | { kind: 'holder'; holder: HolderRecord };

/** Kind-dispatching decoder — NODE_INTERFACE → Entity kinds. */
export function deserializeAvlValue(bytes: Uint8Array): AvlValue {
  if (bytes.length === 0) throw new Error('Truncated AVL value');
  if (bytes[0] === IDENTITY_RECORD_TAG) {
    return { kind: 'record', record: deserializeIdentityRecord(bytes) };
  }
  if (bytes[0] === NETWORK_RECORD_TAG) {
    return { kind: 'network', network: deserializeNetworkRecord(bytes) };
  }
  if (bytes[0] === NAME_RECORD_TAG) {
    return { kind: 'username', username: deserializeUsernameRecord(bytes) };
  }
  if (bytes[0] === HOLDER_RECORD_TAG) {
    return { kind: 'holder', holder: deserializeHolderRecord(bytes) };
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
