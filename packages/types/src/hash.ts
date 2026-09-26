/**
 * The protocol's one hash — TYPES_INTERFACE → The protocol hash.
 *
 * Every 32-byte digest this package computes goes through `hash32`: the ids,
 * the domain-separated keys, the Merkle leaves and nodes, the header hash and
 * the PoW hash. It is the one call into a BLAKE2b implementation in the
 * packages the browser runs (ARCHITECTURE → Package boundaries) — `@noble/hashes`'
 * `blake2b`, over pure TS, with no Node built-in and no Node global.
 */

import { blake2b } from '@noble/hashes/blake2.js';

/**
 * BLAKE2b-512 over `parts` in order, truncated to the first 32 bytes.
 *
 * **The parts are one stream** — `hash32(a, b)` equals `hash32(a ‖ b)`: a part
 * boundary separates nothing, so every domain separation is a prefix the
 * preimage carries, never a part boundary (TYPES_INTERFACE → The protocol
 * hash).
 *
 * **Truncated BLAKE2b-512, never BLAKE2b-256** — the digest length is a
 * parameter of BLAKE2b, so `dkLen: 64` then `slice(0, 32)` is a different
 * function from asking for a 32-byte digest directly, and matches
 * `node:crypto`'s `createHash('blake2b512').digest().subarray(0, 32)`
 * byte-for-byte (`ARCHITECTURE → Cryptographic`).
 *
 * Answers a fresh 32-byte `Uint8Array` — `slice(0, 32)`, never a `subarray`
 * view whose `.buffer` is the 64-byte digest.
 */
export function hash32(...parts: Uint8Array[]): Uint8Array {
  const h = blake2b.create({ dkLen: 64 });
  for (const part of parts) h.update(part);
  return h.digest().slice(0, 32);
}
