// NET_INTERFACE → The browser entry → "The frame codec is one code with its
// checksum handed in" — the Node binding of the codec. The 32-byte checksum
// is `createHash('blake2b512').update(data).digest().subarray(0, 32)`
// (ARCHITECTURE → Cryptographic), the same 32 bytes `@dagsocial/types`'
// `hash32` answers (TYPES_INTERFACE → The protocol hash → "Truncated
// BLAKE2b-512, never BLAKE2b-256"), so the browser entry's frames and this
// entry's are one frame on the wire.
import { createHash } from 'crypto';
import {
  encodeFrame as encodeFrameWithHash,
  decodeFrame as decodeFrameWithHash,
} from './frame-codec.js';
import type { HashFn } from './frame-codec.js';

export { MAGIC_MAINNET, MAGIC_TESTNET, MAGIC_DEVNET, KNOWN_FRAME_MAGICS } from './frame-codec.js';

/** The Node binding's 32-byte checksum. */
export function createBlake2b256Hash(): HashFn {
  return (data: Uint8Array): Uint8Array => {
    return new Uint8Array(createHash('blake2b512').update(data).digest().subarray(0, 32));
  };
}

/** Encode a message into a framed envelope for this node's network. */
export function encodeFrame(
  magic: number,
  code: number,
  body: Uint8Array,
): Uint8Array {
  return encodeFrameWithHash(magic, code, body, createBlake2b256Hash());
}

/** Decode a framed envelope. Throws on wrong magic, bad checksum, or truncation. */
export function decodeFrame(
  magic: number,
  data: Uint8Array,
): { code: number; body: Uint8Array } {
  return decodeFrameWithHash(magic, data, createBlake2b256Hash());
}
