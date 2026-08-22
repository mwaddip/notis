import { createHash } from 'crypto';
import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  u32BE,
  enum8,
  readArr,
  readBytesN,
  readHexN,
  readVlqU,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeVlqU,
} from './codec.js';
import type { UserId } from './identity.js';
import type { TxId } from './utxo.js';

export type PostId = string;

export type PostType = 'regular' | 'profile';

export const POST_TYPE = enum8<PostType>('postType', { regular: 0, profile: 1 });

/**
 * The consensus struct — rides the creating transaction (`tx.post`).
 *
 * `contentHash` is the body's 32-byte commitment; the body itself travels
 * apart as a packet and lives only in the DAG (TYPES_INTERFACE → Post,
 * Layout — PostCommit).
 */
export interface PostCommit {
  contentHash: Uint8Array;      // 32 bytes — computeContentHash(content)
  author: UserId;               // 32-byte Ed25519 public key
  parentRefs: PostId[];         // 0–MAX_PARENT_REFS
  protocolVersion: number;
  type: PostType;               // enum8 — TYPES_INTERFACE → Post typing and profiles
}

/**
 * The DAG's object — never in a block. The body itself, with the commit's
 * four remaining fields verbatim.
 */
export interface Post {
  content: string;              // 1–MAX_CONTENT_BYTES UTF-8
  author: UserId;               // 32-byte Ed25519 public key
  parentRefs: PostId[];         // 0–MAX_PARENT_REFS
  protocolVersion: number;
  type: PostType;               // enum8 — TYPES_INTERFACE → Post typing and profiles
}

// ---------------------------------------------------------------------------
// Canonical field encoding — TYPES_INTERFACE → Canonical field encoding
// ---------------------------------------------------------------------------
//
// `postFieldBytes` is **injective**: every field is fixed-width, counted or
// length-prefixed, so no two distinct commits share one encoding. Numeric
// fields are encoded, never stringified — an undelimited `String(n)`
// concatenation collides, since (a=5, b=23) and (52, 3) both yield
// …"5""23"… == …"52""3"…, one encoding for two posts. That is the defect
// audit M-1 closed, and injectivity is the property every later dialect
// change has had to preserve.
//
// ⛔ Injectivity is required here even though the post id no longer reads these
// bytes (TYPES_INTERFACE → Canonical field encoding). They are the post's
// payload inside its creating transaction, so they enter that transaction's
// `TxId` — a non-injective encoding would collide two transactions, which is
// strictly worse than colliding two ids.
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
 * Domain separator for the content hash — TYPES_INTERFACE → Hashing functions.
 * Hash-side only, never on the wire.
 */
const POST_CONTENT_DOMAIN = encoder.encode('dagsocial/post-content/1');

/**
 * The body's 32-byte commitment:
 *   blake2b512(POST_CONTENT_DOMAIN ‖ utf8(content))[0:32]
 *
 * TYPES_INTERFACE → Hashing functions. Hash-side tag, never on the wire.
 */
export function computeContentHash(content: string): Uint8Array {
  return new Uint8Array(createHash('blake2b512')
    .update(POST_CONTENT_DOMAIN)
    .update(encoder.encode(content))
    .digest()
    .subarray(0, 32));
}

/**
 * The canonical, injective field encoding — `postFieldBytes` in
 * TYPES_INTERFACE.md → Layout — PostCommit:
 *
 *   | 1 | contentHash     | b32   (bytes)  |
 *   | 2 | author          | b32   (bytes)  |
 *   | 3 | parentRefs      | arr(refs, b32) |
 *   | 4 | protocolVersion | vlqU           |
 *   | 5 | type            | enum8(POST_TYPE) |
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
 * - `vlqU` is **total**. `vlqU`'s sentinel guards `protocolVersion` alone,
 *   and an out-of-domain version encodes to a value the strict-equality
 *   version check refuses — the sentinel never reaches a rule as a meaning.
 *   Audits M-5/M-6, and the property the no-panic contract in
 *   `@dagsocial/validation` rests on.
 * - `b32` — `contentHash`, `author`, every `parentRefs` entry — **throws**.
 *   A fixed-width field's wire domain *is* its encodable domain, so it has
 *   no unreachable sentinel; padding or truncating a 31-byte value to 32
 *   would map it onto a **well-formed commit's** encoding, a consensus-level
 *   collision strictly worse than the panic it avoids.
 * - `enum8` — `type` — **total** at byte width: an off-table value takes
 *   the reserved 0xff sentinel, refused at decode as invalid-tag
 *   (TYPES_INTERFACE → Canonical field encoding). `verifyPostCommitDomains`'
 *   membership rule keeps the sentinel path unreachable, so two malformed
 *   commits cannot share an encoding.
 *
 * The non-total fields (`b32`) therefore have their domain established
 * upstream: `verifyPostCommitDomains` in `@dagsocial/validation` pins
 * `contentHash` and `author` at 32 bytes and every ref at 64 **lowercase**
 * hex characters, and `verifyTxStructure` calls it for a post-bearing
 * transaction. Lowercase is load-bearing: `'AB…'` and `'ab…'` decode to
 * identical bytes, so accepting both would make this encoding non-injective
 * at the hex boundary.
 */
export function postFieldBytes(commit: PostCommit): Uint8Array {
  const w = new ByteWriter();
  writeBytesNOrThrow(w, commit.contentHash, 32);
  writeBytesNOrThrow(w, commit.author, 32);
  writeArr(w, commit.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
  writeVlqU(w, commit.protocolVersion);
  POST_TYPE.write(w, commit.type);
  return w.toBytes();
}

/**
 * The inverse of `postFieldBytes` — read a commit's fields back from a stream.
 *
 * **Deliberately adjacent to the writer**, and that placement is the point:
 * field order is normative and a reader that walks it differently is a
 * consensus divergence with no compiler signal, so the two sit where a
 * reviewer reads them as one table. This is the same pairing rule
 * `boxRecordBytes` / `boxRecordFromBytes` follow (TYPES_INTERFACE → Layout —
 * Boxes).
 *
 * **It takes a reader rather than a byte array, because it is read INLINE.**
 * A commit's fields are the tail of `txIdBytes`' `post` option and the whole
 * of `encodePostCommit`, so the same reader serves both and neither has to
 * hold a second statement of the layout. The boundary check belongs to
 * whichever `decodeStruct` encloses it — `decodePostCommit` at the top level,
 * `decodeTx` when the commit rides a transaction.
 */
export function readPostCommitFields(r: ByteReader): PostCommit {
  return {
    contentHash: readBytesN(r, 32),
    author: readBytesN(r, 32),
    parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
    protocolVersion: readVlqU(r),
    type: POST_TYPE.read(r),
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
