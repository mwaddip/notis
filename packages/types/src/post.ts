import { createHash } from 'crypto';
import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  u32BE,
  readArr,
  readBytesN,
  readHexN,
  readLpUtf8,
  readVlqU,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLpUtf8,
  writeVlqU,
} from './codec.js';
import type { UserId } from './identity.js';
import type { TxId } from './utxo.js';

export type PostId = string;

export interface Post {
  content: string;              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId;               // 32-byte Ed25519 public key
  parentRefs: PostId[];         // 0–MAX_PARENT_REFS
  protocolVersion: number;
  timestamp: number;            // Unix ms
}

// ---------------------------------------------------------------------------
// Canonical field encoding — TYPES_INTERFACE → Canonical field encoding
// ---------------------------------------------------------------------------
//
// `postFieldBytes` is **injective**: every variable-length field is
// length-prefixed and the ref array carries an explicit count, so no two
// distinct posts share one encoding. Numeric fields are encoded, never
// stringified — an undelimited `String(n)` concatenation collides, since
// (a=5, b=23) and (52, 3) both yield …"5""23"… == …"52""3"…, one encoding for
// two posts. That is the defect audit M-1 closed, and injectivity is the
// property every later dialect change has had to preserve; the tests pin that
// exact pair to distinct encodings.
//
// ⛔ Injectivity is required here even though the post id no longer reads these
// bytes (TYPES_INTERFACE → Canonical field encoding). They are the post's
// payload inside its creating transaction, so they enter that transaction's
// `TxId` — a non-injective encoding would collide two transactions, which is
// strictly worse than colliding two ids.
//
// One encoding language throughout: integers are VLQ rather than fixed-width
// little-endian, and a `b32` field carries the 32 raw bytes it names rather than
// the UTF-8 of its hex text.
//
// ⚠ **`computePostId` below takes the OTHER form deliberately** — a standalone
// derivation hashes a txId as hex text, where a positional layout decodes it
// (TYPES_INTERFACE → Pinned byte forms). Both are live; which one applies is a
// property of the preimage, not of the value.
//
// Encoding is protocol-breaking and unversioned. It MUST stay byte-identical
// here and in the demo-UI JS (packages/node/public/index.html); the frozen
// golden vectors in the tests are the cross-implementation anchor.

const encoder = new TextEncoder();

/**
 * Domain separator for the post id. Box ids, transaction ids and post ids are
 * all derived from the same `(txId, index)` provenance, so the tag is the whole
 * of the separation between them — the discipline `computeBoxId` and
 * `computeMintTxId` already follow.
 */
const POST_ID_DOMAIN = encoder.encode('dagsocial/post-id/1');

/**
 * The canonical, injective field encoding — `postFieldBytes` in
 * TYPES_INTERFACE.md → Layout — Post:
 *
 *   | 1 | content         | lpUtf8         |
 *   | 2 | author          | b32   (bytes)  |
 *   | 3 | parentRefs      | arr(refs, b32) |
 *   | 4 | protocolVersion | vlqU           |
 *   | 5 | timestamp       | vlqU           |
 *
 * **Field order IS the specification** (TYPES_INTERFACE → Primitives):
 * reordering it is a
 * consensus change with no compiler signal, so the calls below are laid out to
 * be read line-by-line against that table.
 *
 * These bytes are the post's payload inside its creating transaction —
 * `txIdBytes` writes them as its `post` field, so they enter that transaction's
 * `TxId`.
 *
 * ## Totality — which writers throw here, and why that is safe
 *
 * Split, deliberately (TYPES_INTERFACE → Totality):
 *
 * - `lpUtf8`, `vlqU` are **total**. A value outside the encodable domain takes
 *   the all-ones sentinel instead of throwing, because the encodable domain
 *   (non-negative safe integers, real byte lengths) is narrower than the u64
 *   wire domain, so the sentinel is unreachable from a well-formed field.
 *   That is what keeps `NaN`/`-1`/`1.5` timestamps out of a panic — audits
 *   M-5/M-6, and the property the no-panic contract in
 *   `@dagsocial/validation` rests on.
 * - `b32` — `author`, every `parentRefs` entry — **throws**. A fixed-width
 *   field's wire domain *is* its encodable domain, so it has no unreachable
 *   sentinel; padding or truncating a 31-byte author to 32 would map it onto a
 *   **well-formed post's** encoding, a consensus-level collision strictly worse
 *   than the panic it avoids.
 *
 * The throwing fields therefore have their domain established upstream:
 * `verifyPostFieldDomains` in `@dagsocial/validation` pins `author` at 32 bytes
 * and every ref at 64 **lowercase** hex characters, and `verifyTxStructure`
 * calls it for a post-bearing transaction. Lowercase is load-bearing:
 * `'AB…'` and `'ab…'` decode to identical bytes, so accepting both would make
 * this encoding non-injective at the hex boundary.
 */
export function postFieldBytes(post: Post): Uint8Array {
  const w = new ByteWriter();
  writeLpUtf8(w, post.content);
  writeBytesNOrThrow(w, post.author, 32);
  writeArr(w, post.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
  writeVlqU(w, post.protocolVersion);
  writeVlqU(w, post.timestamp);
  return w.toBytes();
}

/**
 * The inverse of `postFieldBytes` — read a post's fields back out of a stream.
 *
 * **Deliberately adjacent to the writer**, and that placement is the point: field
 * order is normative and a reader that walks it differently is a consensus
 * divergence with no compiler signal, so the two sit where a reviewer reads them
 * as one table. This is the same pairing rule `boxRecordBytes` /
 * `boxRecordFromBytes` follow (TYPES_INTERFACE → Layout — Boxes).
 *
 * **It takes a reader rather than a byte array, because it is read INLINE.** A
 * post's fields are the tail of `txIdBytes`' `post` option and the whole of
 * `encodePost`, so the same reader serves both and neither has to hold a second
 * statement of the layout. The boundary check belongs to whichever `decodeStruct`
 * encloses it — `decodePost` at the top level, `decodeTx` when the post rides a
 * transaction.
 */
export function readPostFields(r: ByteReader): Post {
  return {
    content: readLpUtf8(r),
    author: readBytesN(r, 32),
    parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
    protocolVersion: readVlqU(r),
    timestamp: readVlqU(r),
  };
}

/**
 * Deterministic post ID:
 *   blake2b512(POST_ID_DOMAIN ‖ utf8(txId) ‖ u32BE(index))[0..32]
 *
 * ⛔ **Provenance-derived, and neither argument is a `Post`** (TYPES_INTERFACE →
 * Hashing functions). The creating transaction spends the author's karma box, so
 * no two posts can share one and `(txId, index)` names a post uniquely **by
 * construction** — the same move `computeBoxId` makes, for the same reason. A
 * `(Post) => PostId` signature is what a content-derived id required, and it
 * would reintroduce the uniqueness problem PoW was carrying.
 *
 * `index` is the post's position among the transaction's post-bearing outputs.
 * Exactly one post rides one transaction today, so it is always `0`; the
 * parameter exists so that stays a stated rule rather than an assumption baked
 * into a call site.
 *
 * ⚠ **`utf8(txId)`, not decoded bytes**, and `u32BE` rather than `vlqU` — both
 * from TYPES_INTERFACE → Pinned byte forms, and **both are about TOTALITY**. A
 * light client derives post ids from attacker-supplied fields, so a hex decode
 * (which throws on a malformed `txId`) and a throwing integer writer are the two
 * ways this derivation could become a panic. `u32BE` is total by sentinel, which
 * is why it is that function and not `Buffer.writeUInt32BE`.
 */
export function computePostId(txId: TxId, index: number): PostId {
  return createHash('blake2b512')
    .update(POST_ID_DOMAIN)
    .update(encoder.encode(txId))
    .update(u32BE(index))
    .digest()
    .subarray(0, 32)
    .toString('hex');
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
