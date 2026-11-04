// NET_INTERFACE → The browser entry → "The frame codec is one code with its
// checksum handed in". The 32-byte checksum is a parameter, so the one codec
// runs on the Node entry — handed `node:crypto`'s `createHash('blake2b512')…
// subarray(0, 32)` — and on the browser entry — handed `@dagsocial/types`'
// `hash32` (`TYPES_INTERFACE → The protocol hash`). The two answer the same
// 32 bytes, so the two bindings produce one frame.
import {
  encodeFrame as wireEncodeFrame,
  decodeFrame as wireDecodeFrame,
} from '@dagsocial/wire';
import type { HashFn } from '@dagsocial/wire';

export type { HashFn };

export {
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from '@dagsocial/types';

/** NET_INTERFACE → Frame Format — encode with the given 32-byte checksum. */
export function encodeFrame(
  magic: number,
  code: number,
  body: Uint8Array,
  hashFn: HashFn,
): Uint8Array {
  return wireEncodeFrame(magic, code, body, hashFn);
}

/** NET_INTERFACE → Frame Format — decode with the given 32-byte checksum. */
export function decodeFrame(
  magic: number,
  data: Uint8Array,
  hashFn: HashFn,
): { code: number; body: Uint8Array } {
  return wireDecodeFrame(magic, data, hashFn);
}
