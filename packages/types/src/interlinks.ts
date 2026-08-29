// The interlink vector — TYPES_INTERFACE → Interlink vector.
//
// Every block commits, through `interlinkRoot`, to the superblock
// back-pointers a NiPoPoW proof walks. This module is the vector's
// codec and commitment; the level function belongs to @dagsocial/validation.

import { createHash } from 'crypto';
import { ReaderError } from '@dagsocial/wire';
import {
  type StructCodec,
  decodeStruct,
  encodeStruct,
  readHexN,
  readVlqU,
  writeArr,
  writeHexNOrThrow,
} from './codec.js';
import { MAX_INTERLINKS, LEVEL_CAP } from './constants.js';

const encoder = new TextEncoder();

// TYPES_INTERFACE → Domain tags
export const INTERLINK_DOMAIN = encoder.encode('dagsocial/interlinks/1');

// ---------------------------------------------------------------------------
// Codec — TYPES_INTERFACE → Interlink vector, encoding
// ---------------------------------------------------------------------------

const INTERLINKS: StructCodec<string[]> = {
  name: 'interlinks',
  write(w, vector) {
    writeArr(w, vector, (ww, id) => writeHexNOrThrow(ww, id, 32));
  },
  read(r) {
    const count = readVlqU(r);
    if (count > MAX_INTERLINKS) {
      throw new ReaderError(
        `interlinks: ${count} entries exceeds MAX_INTERLINKS (${MAX_INTERLINKS})`,
        'array-too-large',
      );
    }
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(readHexN(r, 32));
    return ids;
  },
};

export function encodeInterlinks(vector: string[]): Uint8Array {
  return encodeStruct(INTERLINKS, vector);
}

export function decodeInterlinks(bytes: Uint8Array): string[] {
  return decodeStruct(INTERLINKS, bytes);
}

// ---------------------------------------------------------------------------
// Commitment — TYPES_INTERFACE → Interlink vector, interlinkRoot
// ---------------------------------------------------------------------------

export function interlinkRoot(vector: string[]): string {
  const encoded = encodeInterlinks(vector);
  return createHash('blake2b512')
    .update(INTERLINK_DOMAIN)
    .update(encoded)
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

// ---------------------------------------------------------------------------
// Update rule — TYPES_INTERFACE → Interlink vector, update rule
// ---------------------------------------------------------------------------

/** TYPES_INTERFACE → Interlink vector. */
export function updateInterlinks(
  prev: string[],
  prevHash: string,
  prevLevel: number | null,
): string[] {
  if (prevLevel === Infinity) {
    return [prevHash];
  }
  if (prevLevel === null) {
    if (prev.length === 0) {
      throw new RangeError(
        'updateInterlinks: prev must be non-empty when prevLevel is null',
      );
    }
    return prev.slice();
  }
  if (
    !Number.isInteger(prevLevel) ||
    prevLevel < 0 ||
    prevLevel > LEVEL_CAP
  ) {
    throw new RangeError(
      `updateInterlinks: prevLevel must be Infinity, null, or an integer in [0, ${LEVEL_CAP}], got ${prevLevel}`,
    );
  }
  if (prev.length === 0) {
    throw new RangeError(
      'updateInterlinks: prev must be non-empty when prevLevel is finite',
    );
  }
  const L = prevLevel;
  const result = prev.slice();
  // Positions 1..L become prevHash (1-indexed; array index 0 is the genesis entry).
  for (let i = 1; i <= L; i++) {
    if (i < result.length) {
      result[i] = prevHash;
    }
  }
  // Grow to L + 1 when needed.
  if (L >= result.length) {
    while (result.length <= L) {
      result.push(prevHash);
    }
  }
  return result;
}
