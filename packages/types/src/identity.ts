import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from './codec.js';

export interface KeyPair {
  publicKey: Uint8Array;  // 32 raw bytes — Ed25519 public key
  secretKey: Uint8Array;
}

/**
 * A DAGsocial user identity IS the 32-byte Ed25519 public key.
 * There is no separate "account" concept — the key is the identity.
 */
export type UserId = Uint8Array;

/**
 * The RFC 8410 PKCS8 prefix for a raw Ed25519 seed (TYPES_INTERFACE →
 * Identity) — the ASN.1 `PrivateKeyInfo` wrapping an OCTET STRING around
 * nothing but the 32-byte seed that follows it.
 */
const ED25519_PKCS8_PREFIX = hexToBytes('302e020100300506032b657004220420');

/**
 * A random 32-byte seed through `@noble/curves`' Ed25519 (TYPES_INTERFACE →
 * Identity): `publicKey` is the 32 raw bytes; `secretKey` is the seed's PKCS8
 * DER, `ED25519_PKCS8_PREFIX` ‖ the seed — 48 bytes.
 */
export function generateKeyPair(): KeyPair {
  const seed = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  secretKey.set(ED25519_PKCS8_PREFIX, 0);
  secretKey.set(seed, ED25519_PKCS8_PREFIX.length);
  return { publicKey, secretKey };
}
