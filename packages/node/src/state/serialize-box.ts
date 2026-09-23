import {
  IDENTITY_RECORD_TAG,
  ReaderError,
  boxRecordBytes,
  boxRecordFromBytes,
  decodeStruct,
  encodeStruct,
  identityRecordFromBytes,
  readU8,
  readVlqU,
  readBytesN,
  writeU8OrThrow,
  writeVlqU,
  writeBytesNOrThrow,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord, StructCodec } from '@dagsocial/types';
// Type-only: erased at compile time, so state/ does not gain a runtime edge
// into the store module graph.
import type { NetworkRecord } from '../store/identity-records.js';
import type { HolderRecord } from '../store/usernames.js';

// NODE_INTERFACE → Entity kinds — the three record kinds this module owns.
// The identity record's tag is `@dagsocial/types`' (TYPES_INTERFACE → Layout —
// IdentityRecord); this module dispatches on it and encodes the other three.
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
    return { kind: 'record', record: identityRecordFromBytes(bytes) };
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
