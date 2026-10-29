// The node's identity — one Ed25519 key in two spellings (`MESH_INTERFACE → Identity`):
// the 64-lowercase-hex Notis spelling, and the libp2p peer id whose identity-multihash
// digest is the protobuf-encoded Ed25519 public key.
//
// Pure, browser-safe. The on-disk key file lives in `src/node/key-store.ts`
// (`MESH_INTERFACE → Place in the workspace`).

import { privateKeyFromRaw, publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id';
import type { Ed25519PublicKey, PeerId, PrivateKey } from '@libp2p/interface';
import { ED25519_PKCS8_PREFIX, bytesToHex, hexToBytes } from '@dagsocial/types';
import type { KeyPair } from '@dagsocial/types';

export class MeshKeyError extends Error {
  override readonly name = 'MeshKeyError';
}

export interface NodeKey {
  readonly keyPair: KeyPair;
  readonly notisId: string;
  readonly privateKey: PrivateKey;
  readonly peerId: PeerId;
}

// `ED25519_PKCS8_PREFIX` as bytes, read once (`TYPES_INTERFACE → Identity`).
const PKCS8_PREFIX_BYTES = hexToBytes(ED25519_PKCS8_PREFIX);
const PKCS8_PREFIX_LEN = PKCS8_PREFIX_BYTES.length;   // 16
const SECRET_KEY_LEN = PKCS8_PREFIX_LEN + 32;         // 48 — the full secretKey
const NOTIS_ID_RE = /^[0-9a-f]{64}$/;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function nodeKeyFromKeyPair(kp: KeyPair): NodeKey {
  if (kp.publicKey.length !== 32) {
    throw new MeshKeyError(`publicKey length ${kp.publicKey.length}, must be 32`);
  }
  if (kp.secretKey.length !== SECRET_KEY_LEN) {
    throw new MeshKeyError(`secretKey length ${kp.secretKey.length}, must be ${SECRET_KEY_LEN}`);
  }
  if (!bytesEqual(kp.secretKey.subarray(0, PKCS8_PREFIX_LEN), PKCS8_PREFIX_BYTES)) {
    throw new MeshKeyError('secretKey does not carry the RFC 8410 PKCS8 prefix');
  }
  const seed = kp.secretKey.subarray(PKCS8_PREFIX_LEN);
  // `@libp2p/crypto`'s `privateKeyFromRaw` reads a 64-byte Ed25519 private key as
  // seed ‖ publicKey; its 32-byte form is read as secp256k1, so the length
  // disambiguates the key type (`MESH_INTERFACE → Identity`).
  const raw = new Uint8Array(64);
  raw.set(seed, 0);
  raw.set(kp.publicKey, 32);
  const privateKey = privateKeyFromRaw(raw);
  if (privateKey.type !== 'Ed25519') {
    throw new MeshKeyError(`privateKey type ${privateKey.type}, must be Ed25519`);
  }
  const peerId = peerIdFromPrivateKey(privateKey);
  const notisId = bytesToHex(kp.publicKey);
  return { keyPair: kp, notisId, privateKey, peerId };
}

export function peerIdFromNotisId(notisId: string): PeerId {
  if (!NOTIS_ID_RE.test(notisId)) {
    throw new MeshKeyError('notisId must be 64 lowercase hex characters');
  }
  // `publicKeyFromRaw` reads a 32-byte Ed25519 public key and a 33-byte secp256k1
  // one, so the length disambiguates; the regex above fixes the length to 32 bytes.
  const pub = publicKeyFromRaw(hexToBytes(notisId)) as Ed25519PublicKey;
  // The peer id's identity multihash is the protobuf-encoded Ed25519 public key —
  // `MESH_INTERFACE → Identity` names its exact bytes.
  return peerIdFromPublicKey(pub);
}

export function notisIdFromPeerId(peerId: PeerId): string {
  if (peerId.type !== 'Ed25519') {
    throw new MeshKeyError(`peerId type ${peerId.type}, must be Ed25519`);
  }
  const publicKey = peerId.publicKey?.raw;
  if (!publicKey || publicKey.length !== 32) {
    throw new MeshKeyError('peerId.publicKey.raw not a 32-byte Ed25519 key');
  }
  return bytesToHex(publicKey);
}
