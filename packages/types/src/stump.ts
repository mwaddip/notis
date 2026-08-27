import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  readHexN,
  writeHexNOrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

// ---------------------------------------------------------------------------
// Prune commit (the payload inside a prune transaction)
// ---------------------------------------------------------------------------

/**
 * The prune payload carried by a karma transaction (`UtxoTransaction.prune`).
 *
 * One field — the subtree is derived from `block_topology` at apply
 * (TYPES_INTERFACE → Layout — PruneCommit). The transaction's signature over
 * `txId` covers this payload, so `authorId` and `authorSignature` leave the
 * struct — the author is `inputKarma.owner`.
 */
export interface PruneCommit {
  rootPostHash: PostId;
}

// ---------------------------------------------------------------------------
// Stump (compact proof replacing a pruned subtree — historical artifact)
// ---------------------------------------------------------------------------

export interface Stump {
  rootPostHash: PostId;
  authorId: UserId;
  replyCount: number;
  upvoteCount: number;
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export type StumpId = string;

// ---------------------------------------------------------------------------
// Post-withdrawal commit (the payload inside a withdrawal transaction)
// ---------------------------------------------------------------------------

/**
 * The withdrawal payload carried by a karma transaction
 * (`UtxoTransaction.postWithdraw`). One field — a withdrawal's effect is
 * one post, authorship is `inputKarma.owner` against topology, and the
 * signature over `txId` covers the payload through `txIdBytes`.
 */
export interface PostWithdrawCommit {
  postId: PostId;
}

// ---------------------------------------------------------------------------
// Prune commit encoding
// ---------------------------------------------------------------------------

/**
 * The canonical encoding of a PruneCommit — the prune payload inside
 * `txIdBytes` field 6 (TYPES_INTERFACE → Layout — PruneCommit).
 *
 *   | 1 | rootPostHash | b32 (hex) |
 *
 * One fixed-width field, so self-delimiting: 32 bytes unconditionally.
 */
export function pruneFieldBytes(prune: PruneCommit): Uint8Array {
  const w = new ByteWriter();
  writeHexNOrThrow(w, prune.rootPostHash, 32);
  return w.toBytes();
}

/**
 * The inverse of `pruneFieldBytes` — read a PruneCommit back.
 *
 * Adjacent to the writer for the same reason every pair in this format is:
 * field order is normative and a reader that walks it differently is a
 * consensus divergence with no compiler signal (TYPES_INTERFACE → Primitives).
 */
export function readPruneCommitFields(r: ByteReader): PruneCommit {
  return {
    rootPostHash: readHexN(r, 32),
  };
}

// ---------------------------------------------------------------------------
// Post-withdrawal commit encoding
// ---------------------------------------------------------------------------

/**
 * The canonical encoding of a PostWithdrawCommit — the withdrawal payload
 * inside `txIdBytes` field 7 (TYPES_INTERFACE → Layout — UtxoTransaction).
 *
 *   | 1 | postId | b32 (hex) |
 *
 * One fixed-width field, so self-delimiting: 32 bytes unconditionally.
 */
export function postWithdrawFieldBytes(pw: PostWithdrawCommit): Uint8Array {
  const w = new ByteWriter();
  writeHexNOrThrow(w, pw.postId, 32);
  return w.toBytes();
}

/**
 * The inverse of `postWithdrawFieldBytes` — read a PostWithdrawCommit back.
 *
 * Adjacent to the writer for the same reason every pair in this format is:
 * field order is normative and a reader that walks it differently is a
 * consensus divergence with no compiler signal (TYPES_INTERFACE → Primitives).
 */
export function readPostWithdrawCommitFields(r: ByteReader): PostWithdrawCommit {
  return {
    postId: readHexN(r, 32),
  };
}
