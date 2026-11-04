// NET_INTERFACE → Handshake Body — the Node binding's `buildHandshakeFrame`.
// The codec, decode and validation live in `./handshake-codec.js`
// (browser-safe); this module hands the Node checksum to the parameterized
// `buildHandshakeFrameWithHash`. The public signature `(magic, msg) =>
// Uint8Array` is unchanged.
import { createBlake2b256Hash } from './frame.js';
import {
  buildHandshakeFrameWithHash,
  handshakeCodec,
  decodeHandshakeBody,
  handshakePenalty,
  validateHandshake,
} from './handshake-codec.js';
import type {
  HandshakeMsg,
  HandshakeRejection,
  HandshakeResult,
} from './handshake-codec.js';

export { handshakeCodec, decodeHandshakeBody, handshakePenalty, validateHandshake };
export type { HandshakeMsg, HandshakeRejection, HandshakeResult };

/** Build a handshake frame for our node, using the Node checksum. */
export function buildHandshakeFrame(
  magic: number,
  msg: HandshakeMsg,
): Uint8Array {
  return buildHandshakeFrameWithHash(magic, msg, createBlake2b256Hash());
}
