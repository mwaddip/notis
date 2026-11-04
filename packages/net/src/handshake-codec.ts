// NET_INTERFACE → Handshake Body — the handshake struct codec and its
// decode-side rules, in a module the browser entry imports as written. The
// framing side — `encodeFrame` and the 4-byte checksum — is parameterized
// in `./frame-codec.js`, so this module imports no Node built-in.
import {
  ReaderError,
  decodeStruct,
  encodeStruct,
  readVlqU,
  writeArr,
  writeOpt,
  readOpt,
  writeVlqU,
  writeLpUtf8,
} from '@dagsocial/types';
import type { StructCodec } from '@dagsocial/types';
import { encodeFrame as encodeFrameWithHash } from './frame-codec.js';
import type { HashFn } from './frame-codec.js';
import { PenaltyKind } from './types.js';
import {
  isBoundedInt,
  isHeight,
  MAX_CAPABILITY_CODE,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
} from './msg-guards.js';
import { readBoundedLpUtf8, readBoundedCapabilities } from './codec-helpers.js';

/**
 * NET_INTERFACE → Handshake → "The side that dialled a connection opens a
 * stream on `/dagsocial/handshake/1` on it".
 */
export const HANDSHAKE_PROTOCOL = '/dagsocial/handshake/1';

export interface HandshakeMsg {
  agentName: string;
  protocolVersion: number;
  nodeName: string;
  chainHeight: number;
  declaredAddress?: string;
  capabilities: number[];
}

/**
 * Why a handshake was refused.
 *
 * NET_INTERFACE → Handshake → "Ban policy"
 *
 * - `malformed` — missing or wrong-typed fields, negative or over-bound
 *   heights. Nothing legitimate produces this, so the peer is adversarial
 *   and earns a permanent ban.
 * - `unsupported-version` — a well-formed handshake from a peer whose
 *   declared version is below our era; a compatibility mismatch, not an
 *   attack.
 */
export type HandshakeRejection = 'malformed' | 'unsupported-version';

export interface HandshakeResult {
  ok: boolean;
  error?: string;
  rejection?: HandshakeRejection;
  peerHeight: number;
  peerCapabilities: number[];
  msg?: HandshakeMsg;
}

/**
 * Penalty tier for a refused handshake. NET_INTERFACE → Handshake →
 * "Ban policy".
 */
export function handshakePenalty(rejection: HandshakeRejection | undefined): PenaltyKind {
  return rejection === 'unsupported-version'
    ? PenaltyKind.Transient
    : PenaltyKind.ProtocolViolation;
}

// NET_INTERFACE → Handshake Body — the positional codec:
// lpUtf8(agentName) ‖ vlqU(protocolVersion) ‖ lpUtf8(nodeName) ‖
// vlqU(chainHeight) ‖ opt(lpUtf8(declaredAddress)) ‖ arr(vlqU(capability)).
export const handshakeCodec: StructCodec<HandshakeMsg> = {
  name: 'handshake',
  write(w, msg) {
    writeLpUtf8(w, msg.agentName);
    writeVlqU(w, msg.protocolVersion);
    writeLpUtf8(w, msg.nodeName);
    writeVlqU(w, msg.chainHeight);
    writeOpt(w, msg.declaredAddress ?? null, writeLpUtf8);
    writeArr(w, msg.capabilities, (cw, c) => writeVlqU(cw, c));
  },
  read(r) {
    const agentName = readBoundedLpUtf8(r, MAX_NAME_BYTES, 'handshake.agentName');
    if (agentName.length === 0) {
      throw new ReaderError('handshake: empty agentName', 'out-of-domain');
    }
    const protocolVersion = readVlqU(r);
    if (!isBoundedInt(protocolVersion, MAX_CAPABILITY_CODE)) {
      throw new ReaderError(`handshake: protocolVersion ${protocolVersion} out of domain`, 'out-of-domain');
    }
    const nodeName = readBoundedLpUtf8(r, MAX_NAME_BYTES, 'handshake.nodeName');
    const chainHeight = readVlqU(r);
    if (!isHeight(chainHeight)) {
      throw new ReaderError(`handshake: chainHeight ${chainHeight} out of domain`, 'out-of-domain');
    }
    const declaredAddressRaw = readOpt(r, (or) =>
      readBoundedLpUtf8(or, MAX_ADDRESS_BYTES, 'handshake.declaredAddress'),
    );
    const capabilities = readBoundedCapabilities(r, 'handshake');
    const msg: HandshakeMsg = {
      agentName,
      protocolVersion,
      nodeName,
      chainHeight,
      capabilities,
    };
    if (declaredAddressRaw !== null) msg.declaredAddress = declaredAddressRaw;
    return msg;
  },
};

/**
 * Build a handshake frame with the given 32-byte checksum —
 * NET_INTERFACE → The browser entry → "The frame codec is one code with
 * its checksum handed in". Node and browser bindings each hand their own
 * `hashFn` to this one function.
 */
export function buildHandshakeFrameWithHash(
  magic: number,
  msg: HandshakeMsg,
  hashFn: HashFn,
): Uint8Array {
  return encodeFrameWithHash(magic, 1, encodeStruct(handshakeCodec, msg), hashFn);
}

/** Decode a handshake body. Returns null for malformed bytes. */
export function decodeHandshakeBody(body: Uint8Array): HandshakeMsg | null {
  try {
    return decodeStruct(handshakeCodec, body);
  } catch {
    return null;
  }
}

function reject(
  error: string,
  rejection: HandshakeRejection = 'malformed',
): HandshakeResult {
  return { ok: false, error, rejection, peerHeight: 0, peerCapabilities: [] };
}

/**
 * Validate a decoded handshake.
 *
 * Shape and bounds are enforced by the codec; this function checks that the
 * peer covers our era. NET_INTERFACE → Handshake → "Peering is by era
 * coverage": accept iff the peer's declared `protocolVersion` is at or
 * above `era`, the era of the next block we would apply. The codec runs
 * first, so a malformed body is `null` before this is reached — a body
 * that is malformed AND version-mismatched is classified `malformed`, not
 * `unsupported-version`.
 */
export function validateHandshake(
  raw: unknown,
  era: number | null,
): HandshakeResult {
  if (raw === null || typeof raw !== 'object') {
    return reject('handshake body is not a valid message');
  }
  const msg = raw as HandshakeMsg;

  if (era === null || msg.protocolVersion < era) {
    return reject(
      `unsupported protocol version ${msg.protocolVersion}; era ${era}`,
      'unsupported-version',
    );
  }

  return {
    ok: true,
    peerHeight: msg.chainHeight,
    peerCapabilities: [...msg.capabilities],
    msg,
  };
}
