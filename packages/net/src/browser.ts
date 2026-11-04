// NET_INTERFACE → The browser entry — the half a browser runs, imports no
// Node built-in and reads no Node global; held equal by a build of it that
// refuses any Node built-in (WEB_INTERFACE → "A Node built-in fails every
// build"). AHEAD OF CODE: the entry exports the frame codec and the
// handshake codec through `hash32`, but still exports from `./handshake.js`,
// which imports `./frame.js` (crypto). The refusal is what
// `browser-entry.test.ts` asserts its last line on; the entry's
// handshake-side re-exports move off `./handshake.js` next.
import { hash32 } from '@dagsocial/types';
import {
  encodeFrame as encodeFrameWithHash,
  decodeFrame as decodeFrameWithHash,
} from './frame-codec.js';
import type { HashFn } from './frame-codec.js';
import { buildHandshakeFrameWithHash } from './handshake-codec.js';
import type { HandshakeMsg } from './handshake-codec.js';

// NET_INTERFACE → The browser entry → "The frame codec is one code with its
// checksum handed in" — the browser's checksum is `hash32`, a fresh HashFn
// per call so the codec module holds no module-level state
// (TYPES_INTERFACE → The protocol hash).
function browserHashFn(): HashFn {
  return (data) => hash32(data);
}

/** Encode a message into a framed envelope for this node's network. */
export function encodeFrame(magic: number, code: number, body: Uint8Array): Uint8Array {
  return encodeFrameWithHash(magic, code, body, browserHashFn());
}

/** Decode a framed envelope. */
export function decodeFrame(magic: number, data: Uint8Array): { code: number; body: Uint8Array } {
  return decodeFrameWithHash(magic, data, browserHashFn());
}

/** Build a handshake frame for our node, using `hash32`. */
export function buildHandshakeFrame(magic: number, msg: HandshakeMsg): Uint8Array {
  return buildHandshakeFrameWithHash(magic, msg, browserHashFn());
}

export {
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  KNOWN_FRAME_MAGICS,
} from './frame-codec.js';
export {
  HANDSHAKE_PROTOCOL,
  handshakeCodec,
  decodeHandshakeBody,
  handshakePenalty,
  validateHandshake,
} from './handshake-codec.js';
export type {
  HandshakeMsg,
  HandshakeRejection,
  HandshakeResult,
} from './handshake-codec.js';
