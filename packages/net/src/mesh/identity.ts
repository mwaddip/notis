// MESH_INTERFACE → Identity — "One key, two spellings": a mesh node's
// identity is an Ed25519 key in the form a Notis identity takes
// (`TYPES_INTERFACE → Identity`): the 64-lowercase-hex Notis spelling and
// libp2p's identity-multihash peer id over its protobuf key encoding.
// Pure, browser-safe (`MESH_INTERFACE → Place in the workspace`).

import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyFromRaw, publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromPublicKey } from '@libp2p/peer-id';
import type { Ed25519PublicKey, PeerId, PrivateKey } from '@libp2p/interface';
import { ED25519_PKCS8_PREFIX, bytesToHex, hexToBytes } from '@dagsocial/types';
import type { KeyPair } from '@dagsocial/types';

export class MeshKeyError extends Error {
  override readonly name = 'MeshKeyError';
}

export interface NodeMeshKey {
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

/**
 * Read the 32-byte Ed25519 seed out of a `KeyPair.secretKey`
 * (`TYPES_INTERFACE → Identity`): the layout is the RFC 8410 PKCS8 prefix ‖
 * seed, 48 bytes in all. `MeshKeyError` on a wrong length or a wrong prefix.
 */
export function seedOfMeshSecretKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== SECRET_KEY_LEN) {
    throw new MeshKeyError(`secretKey length ${secretKey.length}, must be ${SECRET_KEY_LEN}`);
  }
  if (!bytesEqual(secretKey.subarray(0, PKCS8_PREFIX_LEN), PKCS8_PREFIX_BYTES)) {
    throw new MeshKeyError('secretKey does not carry the RFC 8410 PKCS8 prefix');
  }
  return secretKey.subarray(PKCS8_PREFIX_LEN);
}

/**
 * MESH_INTERFACE → Identity — build a mesh node's identity from its
 * Notis `KeyPair`. A crossed pair would build a libp2p identity the
 * private key cannot sign for, so the two halves of the pair are held
 * to each other.
 */
export function nodeMeshKeyFromKeyPair(kp: KeyPair): NodeMeshKey {
  if (kp.publicKey.length !== 32) {
    throw new MeshKeyError(`publicKey length ${kp.publicKey.length}, must be 32`);
  }
  const seed = seedOfMeshSecretKey(kp.secretKey);
  if (!bytesEqual(ed25519.getPublicKey(seed), kp.publicKey)) {
    throw new MeshKeyError("publicKey does not match the secretKey's seed");
  }
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

/**
 * MESH_INTERFACE → Identity — the peer id named by a Notis spelling. Any
 * spelling but 64 lowercase hex is refused; `publicKeyFromRaw` reads a
 * 32-byte Ed25519 public key, so the regex fixes the length to 32 bytes.
 */
export function peerIdFromNotisId(notisId: string): PeerId {
  if (!NOTIS_ID_RE.test(notisId)) {
    throw new MeshKeyError('notisId must be 64 lowercase hex characters');
  }
  const pub = publicKeyFromRaw(hexToBytes(notisId)) as Ed25519PublicKey;
  return peerIdFromPublicKey(pub);
}

/**
 * MESH_INTERFACE → Identity — the Notis spelling of a peer id. A peer id
 * of any other key type is refused.
 */
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

// MESH_INTERFACE → Discovery → "A node added by hand" — "A private
// node prints its local WebRTC-direct address with its key, for its
// operator to hand over, and announces it to no one". `localAddrs`
// is empty for a public node, which announces its listen addresses
// already (`MESH_INTERFACE → NAT → "A public node announces its
// listen addresses from the start"`).
const WEBRTC_DIRECT_WITH_CERTHASH_RE = /\/webrtc-direct\/certhash\//;
const CIRCUIT_RE = /\/p2p-circuit(?:\/|$)/;

export function localAddrsFor(
  role: 'public' | 'private',
  listenerAddrs: readonly string[],
  peerId: string,
): string[] {
  if (role !== 'private') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of listenerAddrs) {
    if (!WEBRTC_DIRECT_WITH_CERTHASH_RE.test(a)) continue;
    if (CIRCUIT_RE.test(a)) continue;
    const withPeer = a.endsWith(`/p2p/${peerId}`) ? a : `${a}/p2p/${peerId}`;
    if (seen.has(withPeer)) continue;
    seen.add(withPeer);
    out.push(withPeer);
  }
  return out;
}
