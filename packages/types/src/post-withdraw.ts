import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  readHexN,
  writeHexNOrThrow,
} from './codec.js';
import type { PostId } from './post.js';

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
// Post-withdrawal commit encoding
// ---------------------------------------------------------------------------

/**
 * The canonical encoding of a PostWithdrawCommit — the withdrawal payload
 * inside `txIdBytes` field 6 (TYPES_INTERFACE → Layout — PostWithdrawCommit).
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
