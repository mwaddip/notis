import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes } from './codec.js';
import { ED25519_PKCS8_PREFIX } from './constants.js';

export interface KeyPair {
  publicKey: Uint8Array;  // 32 raw bytes — Ed25519 public key
  secretKey: Uint8Array;
}

/**
 * A DAGsocial user identity IS the 32-byte Ed25519 public key.
 * There is no separate "account" concept — the key is the identity.
 */
export type UserId = Uint8Array;

/** `ED25519_PKCS8_PREFIX` as bytes. */
const PKCS8_PREFIX_BYTES = hexToBytes(ED25519_PKCS8_PREFIX);

/**
 * A random 32-byte seed through `@noble/curves`' Ed25519 (TYPES_INTERFACE →
 * Identity): `publicKey` is the 32 raw bytes; `secretKey` is the seed's PKCS8
 * DER, `ED25519_PKCS8_PREFIX` ‖ the seed — 48 bytes.
 */
export function generateKeyPair(): KeyPair {
  const seed = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(PKCS8_PREFIX_BYTES.length + seed.length);
  secretKey.set(PKCS8_PREFIX_BYTES, 0);
  secretKey.set(seed, PKCS8_PREFIX_BYTES.length);
  return { publicKey, secretKey };
}
