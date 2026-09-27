/**
 * The value codecs of `TYPES_INTERFACE → Layout — tree records`: what the AVL+
 * tree holds at a non-box key, plus the decoder from a box's own record bytes
 * to the box (a box's value is `boxRecordBytes` unchanged — see `utxo.ts`).
 *
 * Every codec is positional and goes through `decodeStruct`/`encodeStruct`, so
 * each one carries the whole four-part boundary check (TYPES_INTERFACE → The
 * boundary check): schema projection, exhaustion, and the re-encode compare
 * that rejects a non-minimal VLQ.
 *
 * No Node built-in, no Node global: the browser runs this module exactly as
 * written (ARCHITECTURE → Package boundaries).
 */

import { ReaderError } from '@dagsocial/wire';
import {
  type StructCodec,
  decodeStruct,
  encodeStruct,
  readBytesN,
  readHexN,
  readOpt,
  readU8,
  readVlqU,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeOpt,
  writeU8OrThrow,
  writeVlqU,
} from './codec.js';
import { boxRecordFromBytes, type AnyBox } from './utxo.js';

// ---------------------------------------------------------------------------
// Network record — u8(0x81) ‖ vlqU(memberCount)
// ---------------------------------------------------------------------------

export interface NetworkRecord {
  memberCount: number;
}

const NETWORK_RECORD_TAG = 0x81;

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

export function networkRecordBytes(record: NetworkRecord): Uint8Array {
  return encodeStruct(NETWORK_RECORD, record);
}

export function networkRecordFromBytes(bytes: Uint8Array): NetworkRecord {
  return decodeStruct(NETWORK_RECORD, bytes);
}

// ---------------------------------------------------------------------------
// Name record — u8(0x82) ‖ b32(boxId) ‖ vlqU(claimedAtBlock)
// ---------------------------------------------------------------------------

export interface NameRecord {
  boxId: string; // 64-char lowercase hex
  claimedAtBlock: number;
}

const NAME_RECORD_TAG = 0x82;

const NAME_RECORD: StructCodec<NameRecord> = {
  name: 'nameRecord',
  write(w, record) {
    writeU8OrThrow(w, NAME_RECORD_TAG);
    writeHexNOrThrow(w, record.boxId, 32);
    writeVlqU(w, record.claimedAtBlock);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== NAME_RECORD_TAG) {
      throw new ReaderError(
        `nameRecord: not a name record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    const boxId = readHexN(r, 32);
    const claimedAtBlock = readVlqU(r);
    return { boxId, claimedAtBlock };
  },
};

export function nameRecordBytes(record: NameRecord): Uint8Array {
  return encodeStruct(NAME_RECORD, record);
}

export function nameRecordFromBytes(bytes: Uint8Array): NameRecord {
  return decodeStruct(NAME_RECORD, bytes);
}

// ---------------------------------------------------------------------------
// Holder record — u8(0x83) ‖ u8(claimAvailable) ‖ opt(b32(boxId))
// ---------------------------------------------------------------------------

export interface HolderRecord {
  claimAvailable: boolean;
  boxId: string | null; // 64-char lowercase hex, or absent
}

const HOLDER_RECORD_TAG = 0x83;

const HOLDER_RECORD: StructCodec<HolderRecord> = {
  name: 'holderRecord',
  write(w, record) {
    writeU8OrThrow(w, HOLDER_RECORD_TAG);
    writeU8OrThrow(w, record.claimAvailable ? 1 : 0);
    writeOpt(w, record.boxId, (ww, boxId) => writeHexNOrThrow(ww, boxId, 32));
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
    const boxId = readOpt(r, (rr) => readHexN(rr, 32));
    return { claimAvailable, boxId };
  },
};

export function holderRecordBytes(record: HolderRecord): Uint8Array {
  return encodeStruct(HOLDER_RECORD, record);
}

export function holderRecordFromBytes(bytes: Uint8Array): HolderRecord {
  return decodeStruct(HOLDER_RECORD, bytes);
}

// ---------------------------------------------------------------------------
// Post record — u8(0x84) ‖ b32(author) ‖ vlqU(height) ‖ u8(standing)
// ---------------------------------------------------------------------------

export interface PostRecord {
  author: Uint8Array; // 32 raw bytes
  height: number; // confirmation height
  standing: 'live' | 'withdrawn';
}

const POST_RECORD_TAG = 0x84;

const POST_RECORD: StructCodec<PostRecord> = {
  name: 'postRecord',
  write(w, record) {
    writeU8OrThrow(w, POST_RECORD_TAG);
    writeBytesNOrThrow(w, record.author, 32);
    writeVlqU(w, record.height);
    writeU8OrThrow(w, record.standing === 'withdrawn' ? 1 : 0);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== POST_RECORD_TAG) {
      throw new ReaderError(
        `postRecord: not a post record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    const author = readBytesN(r, 32);
    const height = readVlqU(r);
    const standingByte = readU8(r);
    let standing: 'live' | 'withdrawn';
    if (standingByte === 0) standing = 'live';
    else if (standingByte === 1) standing = 'withdrawn';
    else {
      throw new ReaderError(
        `postRecord: invalid standing byte 0x${standingByte.toString(16)}`,
        'out-of-domain',
      );
    }
    return { author, height, standing };
  },
};

export function postRecordBytes(record: PostRecord): Uint8Array {
  return encodeStruct(POST_RECORD, record);
}

export function postRecordFromBytes(bytes: Uint8Array): PostRecord {
  return decodeStruct(POST_RECORD, bytes);
}

// ---------------------------------------------------------------------------
// Like record and index entry — single-byte markers, no further fields
// ---------------------------------------------------------------------------

export const LIKE_MARKER = Uint8Array.of(0x85);
export const INDEX_MARKER = Uint8Array.of(0x86);

// ---------------------------------------------------------------------------
// Vouch-pair value — u8(0x87) ‖ b32(boxId)
// ---------------------------------------------------------------------------

const VOUCH_PAIR_TAG = 0x87;

const VOUCH_PAIR_VALUE: StructCodec<Uint8Array> = {
  name: 'vouchPairValue',
  write(w, boxId) {
    writeU8OrThrow(w, VOUCH_PAIR_TAG);
    writeBytesNOrThrow(w, boxId, 32);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== VOUCH_PAIR_TAG) {
      throw new ReaderError(
        `vouchPairValue: not a vouch-pair value: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    return readBytesN(r, 32);
  },
};

export function vouchPairValue(boxId: Uint8Array): Uint8Array {
  return encodeStruct(VOUCH_PAIR_VALUE, boxId);
}

export function vouchPairBoxId(value: Uint8Array): Uint8Array {
  return decodeStruct(VOUCH_PAIR_VALUE, value);
}

// ---------------------------------------------------------------------------
// Cast count — u8(0x88) ‖ vlqU(count); TYPES_INTERFACE → Layout — tree records:
// the voucher's live vouch boxes, never 0 — a count of 0 is no entry, so the
// row itself is absent rather than stored as zero.
// ---------------------------------------------------------------------------

const CAST_COUNT_TAG = 0x88;

const CAST_COUNT: StructCodec<number> = {
  name: 'castCount',
  write(w, count) {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError(`castCount: not a positive count: ${count}`);
    }
    writeU8OrThrow(w, CAST_COUNT_TAG);
    writeVlqU(w, count);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== CAST_COUNT_TAG) {
      throw new ReaderError(
        `castCount: not a cast count: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    const count = readVlqU(r);
    if (count === 0) {
      throw new ReaderError('castCount: a count of 0 is no entry', 'out-of-domain');
    }
    return count;
  },
};

export function castCountBytes(count: number): Uint8Array {
  return encodeStruct(CAST_COUNT, count);
}

export function castCountFromBytes(bytes: Uint8Array): number {
  return decodeStruct(CAST_COUNT, bytes);
}

// ---------------------------------------------------------------------------
// The box decoder — a box's tree value IS `boxRecordBytes`, unchanged
// ---------------------------------------------------------------------------

/**
 * Decode a box's tree value back into the box, the id supplied by the caller
 * (the AVL key it was read at names it; no id rides the value itself, per
 * `boxRecordBytes` — TYPES_INTERFACE → Layout — Boxes).
 *
 * Refuses a record tag (`0x80`–`0x88`) with its own message; every other tag
 * goes through `boxRecordFromBytes`, the one box-record decoder, unchanged.
 *
 * @throws {Error} if the value's first byte is a record tag
 * @throws {ReaderError} if `boxRecordFromBytes` refuses the value
 */
export function boxFromRecordBytes(boxId: string, bytes: Uint8Array): AnyBox {
  if (bytes.length > 0) {
    const tag = bytes[0]!;
    if (tag >= 0x80 && tag <= 0x88) {
      throw new Error(
        `boxFromRecordBytes: value is a record (tag 0x${tag.toString(16)}), not a box`,
      );
    }
  }
  const { candidate, txId, index } = boxRecordFromBytes(bytes);
  return { ...candidate, txId, index, id: boxId } as AnyBox;
}
