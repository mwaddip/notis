import { encodeFrame } from './frame.js';
import { PenaltyKind } from './types.js';
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
import {
  isBoundedInt,
  isHeight,
  MAX_CAPABILITY_CODE,
  MAX_UINT32,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
} from './msg-guards.js';
import { readBoundedLpUtf8, readBoundedCapabilities } from './sync-codec.js';

export interface HandshakeMsg {
  agentName: string;
  protocolVersion: number;
  nodeName: string;
  chainHeight: number;
  declaredAddress?: string;
  capabilities: number[];
  sessionMagic: number;
}

/**
 * Why a handshake was refused.
 *
 * The two classes are treated differently on purpose (NET_INTERFACE → Handshake
 * → "Ban policy"):
 *
 * - `malformed` — missing or wrong-typed fields, negative or over-bound heights.
 *   Nothing legitimate produces this, so the peer is adversarial and earns a
 *   permanent ban.
 * - `unsupported-version` — a well-formed handshake from a peer whose declared
 *   version is below our era, so it does not cover the era we are applying
 *   (NET_INTERFACE → Handshake). That is a compatibility mismatch, not an
 *   attack: peering is by era coverage, and a version mismatch anywhere is a
 *   soft refusal, never a permanent ban — a bump adds its era an upgrade window
 *   ahead, and the peer may upgrade and reconnect.
 */
export type HandshakeRejection = 'malformed' | 'unsupported-version';

export interface HandshakeResult {
  ok: boolean;
  error?: string;
  /** Why the handshake was refused. Present only when `ok` is false. */
  rejection?: HandshakeRejection;
  peerHeight: number;
  peerCapabilities: number[];
  /** The validated, normalized handshake. Present only when `ok` is true. */
  msg?: HandshakeMsg;
}

/**
 * Penalty tier for a refused handshake — the ban policy in one place, so the
 * inbound and outbound paths cannot drift apart.
 *
 * A soft refusal still costs the peer a cooldown: `Transient` accrues ban
 * pressure so a peer cannot hammer us with version-mismatched handshakes for
 * free, but it can only ever produce a temporal ban that expires on its own.
 */
export function handshakePenalty(rejection: HandshakeRejection | undefined): PenaltyKind {
  return rejection === 'unsupported-version'
    ? PenaltyKind.Transient
    : PenaltyKind.ProtocolViolation;
}

// ---------------------------------------------------------------------------
// Handshake codec (code 1) — NET_INTERFACE → Handshake Body
//
// lpUtf8(agentName) ‖ vlqU(protocolVersion) ‖ lpUtf8(nodeName) ‖
// vlqU(chainHeight) ‖ opt(lpUtf8(declaredAddress)) ‖
// arr(vlqU(capability)) ‖ vlqU(sessionMagic)
//
// Every domain rule fires inside `read` as a ReaderError; the decode boundary
// collapses it to null → malformed. The version-support check runs AFTER
// decode, on a structurally sound message only — the ordering pin that keeps
// garbage-with-bogus-version classified as malformed, not unsupported-version.
// ---------------------------------------------------------------------------

export const handshakeCodec: StructCodec<HandshakeMsg> = {
  name: 'handshake',
  write(w, msg) {
    writeLpUtf8(w, msg.agentName);
    writeVlqU(w, msg.protocolVersion);
    writeLpUtf8(w, msg.nodeName);
    writeVlqU(w, msg.chainHeight);
    writeOpt(w, msg.declaredAddress ?? null, writeLpUtf8);
    writeArr(w, msg.capabilities, (cw, c) => writeVlqU(cw, c));
    writeVlqU(w, msg.sessionMagic);
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
    const sessionMagic = readVlqU(r);
    if (!isBoundedInt(sessionMagic, MAX_UINT32)) {
      throw new ReaderError(`handshake: sessionMagic ${sessionMagic} out of domain`, 'out-of-domain');
    }
    const msg: HandshakeMsg = {
      agentName,
      protocolVersion,
      nodeName,
      chainHeight,
      capabilities,
      sessionMagic,
    };
    if (declaredAddressRaw !== null) msg.declaredAddress = declaredAddressRaw;
    return msg;
  },
};

/** Build a handshake frame for our node. */
export function buildHandshakeFrame(
  magic: number,
  msg: HandshakeMsg,
): Uint8Array {
  return encodeFrame(magic, 1, encodeStruct(handshakeCodec, msg));
}

/** Decode a handshake body. Returns null for malformed bytes. */
export function decodeHandshakeBody(body: Uint8Array): HandshakeMsg | null {
  try {
    return decodeStruct(handshakeCodec, body);
  } catch {
    return null;
  }
}

/**
 * Decode a handshake body through the positional codec.
 *
 * Returns a `HandshakeMsg` on success or `null` on malformed input. Pass the
 * result to `validateHandshake` to check version support.
 */
export function parseHandshakeBody(body: Uint8Array): unknown {
  return decodeHandshakeBody(body);
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
 * Shape and bounds are enforced by the codec; this function checks that the peer
 * covers our era. Peering is by era coverage (NET_INTERFACE → Handshake): accept
 * iff the peer's declared `protocolVersion` is at or above `era`, the era of the
 * next block we would apply. A newer build passes — it covers our era; a build
 * whose versions end below our era is refused. The codec runs first, so a
 * malformed body is `null` before this is reached — a body that is malformed AND
 * version-mismatched is classified `malformed`, not `unsupported-version`.
 *
 * `era` is `protocolVersionAt(schedule, chainHeight() + 1)`, so it is `null` when
 * the chain height is out of the schedule's domain — a build defect, since
 * `SyncStore` supplies a non-negative integer and `{ version: 1, fromHeight: 0 }`
 * covers it. A null era refuses softly: we decline what we cannot place against
 * an era we cannot compute, and the refusal is reversible (Transient).
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
