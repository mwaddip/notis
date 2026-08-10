import { createHash } from 'crypto';
import { ByteWriter } from '@dagsocial/wire';
import {
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLpUtf8,
  writeVlqU,
} from './codec.js';
import type { UserId } from './identity.js';

export type PostId = string;

export interface Post {
  content: string;              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId;               // 32-byte Ed25519 public key
  parentRefs: PostId[];         // 0–MAX_PARENT_REFS
  challenge: Uint8Array;        // 32 bytes — random nonce from node (anti-precomputation)
  powNonce: number;             // PoW solution against challenge
  protocolVersion: number;
  timestamp: number;            // Unix ms
  signature: Uint8Array;        // 64 bytes — Ed25519 over signingHash(post)
}

// ---------------------------------------------------------------------------
// Canonical field encoding (audit M-1, positional dialect since Phase 2)
// ---------------------------------------------------------------------------
//
// The pre-M-1 preimages concatenated fields with no delimiters, so distinct
// field tuples produced identical bytes: (powNonce=5, timestamp=23) and
// (52, 3) both yielded …"5""23"… == …"52""3"… → the same postId. M-1 closed
// that by making every variable-length field length-prefixed and giving the
// ref array an explicit count.
//
// ⚠ **This phase changes the DIALECT, not the coverage.** `postFieldBytes` was
// already positional and injective, and it did not need migrating to close any
// defect — see spec §3.1. It moves so that the repo has exactly *one* encoding
// language: fixed-width little-endian integers become VLQ, and ids stop
// crossing a preimage as the UTF-8 of their hex text (68 bytes per parent ref)
// and cross as the 32 raw bytes they name. Injectivity is therefore
// **preserved, not introduced** — the M-1 collision pair must still yield
// distinct ids after the move, which the tests pin.
//
// Encoding is protocol-breaking and unversioned. It MUST stay byte-identical
// here and in the demo-UI JS (packages/node/public/index.html); the frozen
// golden vectors in the tests are the cross-implementation anchor.

const encoder = new TextEncoder();

/**
 * Domain separator for the post id. Prefixing it makes the id a distinct hash
 * from the PoW hash `blake2b512(postFieldBytes ‖ vlqU(powNonce))`, which
 * otherwise shares the entire tail.
 */
const POST_ID_DOMAIN = encoder.encode('dagsocial/post-id/1');

/**
 * The canonical, injective field encoding — `postFieldBytes` in
 * TYPES_INTERFACE.md → Layout — Post:
 *
 *   | 1 | content         | lpUtf8         |
 *   | 2 | author          | b32   (bytes)  |
 *   | 3 | parentRefs      | arr(refs, b32) |
 *   | 4 | challenge       | b32   (bytes)  |
 *   | 5 | protocolVersion | vlqU           |
 *   | 6 | timestamp       | vlqU           |
 *
 * **Field order IS the specification** (spec §2.3): reordering it is a
 * consensus change with no compiler signal, so the calls below are laid out to
 * be read line-by-line against that table.
 *
 * `powNonce` is excluded — the author signs before mining, and the PoW hash
 * appends the nonce itself. `signature` is excluded from every preimage.
 *
 * ## Totality — which writers throw here, and why that is safe
 *
 * Split, deliberately (spec §2.5, TYPES_INTERFACE → Totality):
 *
 * - `lpUtf8`, `vlqU` are **total**. A value outside the encodable domain takes
 *   the all-ones sentinel instead of throwing, because the encodable domain
 *   (non-negative safe integers, real byte lengths) is narrower than the u64
 *   wire domain, so the sentinel is unreachable from a well-formed field.
 *   That is what keeps `NaN`/`-1`/`1.5` timestamps out of a panic — audits
 *   M-5/M-6, and the property the no-panic contract in
 *   `@dagsocial/validation` rests on.
 * - `b32` — `author`, `challenge`, every `parentRefs` entry — **throws**. A
 *   fixed-width field's wire domain *is* its encodable domain, so it has no
 *   unreachable sentinel; padding or truncating a 31-byte author to 32 would
 *   map it onto a **well-formed post's** encoding, a consensus-level collision
 *   strictly worse than the panic it avoids.
 *
 * The three throwing fields therefore have their domain established upstream,
 * one phase ahead of this one: `verifyPostFieldDomains` in
 * `@dagsocial/validation` (Phase 1c) pins `author`/`challenge` at 32 bytes and
 * every ref at 64 **lowercase** hex characters, and node's `verifyPost`,
 * `verifyPostForRelay` and `content-sweep` gates call it (Phase 1d). Lowercase
 * is load-bearing: `'AB…'` and `'ab…'` decode to identical bytes, so accepting
 * both would make this encoding non-injective at the hex boundary.
 */
function postFieldBytes(post: Post): Uint8Array {
  const w = new ByteWriter();
  writeLpUtf8(w, post.content);
  writeBytesNOrThrow(w, post.author, 32);
  writeArr(w, post.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
  writeBytesNOrThrow(w, post.challenge, 32);
  writeVlqU(w, post.protocolVersion);
  writeVlqU(w, post.timestamp);
  return w.toBytes();
}

/**
 * `vlqU(powNonce)` — the preimage tail the post id and the PoW hash append.
 *
 * **The only writer of that tail** (TYPES_INTERFACE → Hashing functions).
 * `@dagsocial/validation`'s `verifyPoW` calls this rather than encoding the
 * nonce itself, so the two sides of one layout cannot drift.
 *
 * Total by sentinel, so every out-of-domain nonce shares one tail and therefore
 * one id. What keeps that harmless is `verifyPoW`'s `isU64Safe(nonce)` — a
 * guard upstream and in another package, **not** this writer's totality, and so
 * not redundant with it. See TYPES_INTERFACE → Canonical field encoding.
 */
export function powNonceBytes(powNonce: number): Uint8Array {
  const w = new ByteWriter();
  writeVlqU(w, powNonce);
  return w.toBytes();
}

/**
 * Build the deterministic PoW preimage for a post — the canonical
 * `postFieldBytes` encoding above. The miner hashes this against candidate
 * nonces; `signingHash` hashes it unchanged. Excludes powNonce (the miner
 * varies this) and signature (not yet set).
 */
export function postPowPreimage(post: Post): Uint8Array {
  return postFieldBytes(post);
}

/**
 * Hash that the author signs: blake2b512(postFieldBytes(post)) truncated to
 * 32 bytes. Carries no domain tag — these are the exact bytes PoW is solved
 * over. Uses blake2b512 (Node.js v22 lacks blake2b256).
 */
export function signingHash(post: Post): Buffer {
  return createHash('blake2b512')
    .update(postFieldBytes(post))
    .digest()
    .subarray(0, 32);
}

/**
 * Deterministic post ID:
 *   blake2b512(POST_ID_DOMAIN ‖ postFieldBytes(post) ‖ vlqU(powNonce))[0..32]
 *
 * Includes powNonce (excluded from signingHash) and is domain-tagged, so the
 * id is never equal to the PoW hash over the same post.
 */
export function computePostId(post: Post): PostId {
  return createHash('blake2b512')
    .update(POST_ID_DOMAIN)
    .update(postFieldBytes(post))
    .update(powNonceBytes(post.powNonce))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/** Verify that a post's computed ID matches an expected ID. */
export function verifyPostId(post: Post, expectedId: string): boolean {
  return computePostId(post) === expectedId;
}

// ---------------------------------------------------------------------------
// Profile post discriminators
// ---------------------------------------------------------------------------

/**
 * Try to extract a profile type discriminator from post content.
 * Returns null for regular posts (content is plain text, not JSON).
 */
export function getPostDiscriminator(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
      return parsed.type;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build profile post content JSON. Embed the type discriminator and any
 * additional fields. The receiver extracts the type via getPostDiscriminator.
 */
export function buildProfileContent(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}
