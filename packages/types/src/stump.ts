import { createHash } from 'crypto';
import { ByteWriter } from '@dagsocial/wire';
import {
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

const encoder = new TextEncoder();

/**
 * Domain separator for the prune-entry id (TYPES_INTERFACE → Layout — Stump /
 * PruneEntry). Module-local, following `POST_ID_DOMAIN` (`post.ts`).
 */
const PRUNE_ENTRY_ID_DOMAIN = encoder.encode('dagsocial/prune-entry-id/1');

// ---------------------------------------------------------------------------
// Prune intent (author signs this to authorize pruning)
// ---------------------------------------------------------------------------

export interface PruneIntent {
  rootPostHash: PostId;
  authorId: UserId;
  subtreeMerkleRoot: Uint8Array;   // 32 bytes — Merkle root over leafHash('stump', postId) per pruned post
  subtreePostIds: PostId[];        // All post IDs in the reply subtree
  signature: Uint8Array;           // 64 bytes — Ed25519 sig over (rootPostHash, subtreeMerkleRoot)
}

// ---------------------------------------------------------------------------
// Prune entry (committed in utxoTxTree; one per pruned reply subtree)
// ---------------------------------------------------------------------------

export interface PruneEntry {
  rootPostHash: PostId;
  subtreePostIds: PostId[];
  subtreeMerkleRoot: Uint8Array;
  authorId: UserId;
  authorSignature: Uint8Array;     // 64 bytes — Ed25519 sig over blake2b512(rootPostHash ++ subtreeMerkleRoot)
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic ID for a PruneEntry (TYPES_INTERFACE → Layout — Stump /
 * PruneEntry).
 *
 * `hex( blake2b512( PRUNE_ENTRY_ID_DOMAIN ‖ b32(rootPostHash) ‖
 * b32(subtreeMerkleRoot) ‖ b32(authorId) )[0..32] )`
 *
 * Two fields stay out deliberately (TYPES_INTERFACE → Layout — Stump /
 * PruneEntry): `subtreePostIds` (committed transitively by
 * `subtreeMerkleRoot`) and `authorSignature` (the id is the mempool dedup
 * key — two identically-parameterized prunes under different valid signature
 * bytes are one intent and must collapse to one entry).
 */
export function computePruneEntryId(entry: PruneEntry): string {
  const w = new ByteWriter();
  w.writeBytes(PRUNE_ENTRY_ID_DOMAIN);
  writeHexNOrThrow(w, entry.rootPostHash, 32);
  writeBytesNOrThrow(w, entry.subtreeMerkleRoot, 32);
  writeBytesNOrThrow(w, entry.authorId, 32);
  const h = createHash('blake2b512');
  h.update(w.toBytes());
  return h.digest().subarray(0, 32).toString('hex');
}

/**
 * The canonical encoding of a PruneEntry — the Merkle leaf preimage in the
 * subtree proof, committed under `utxoTxRoot`.
 *
 * TYPES_INTERFACE → Layout — Stump / PruneEntry:
 *
 *   | 1 | rootPostHash      | b32 (hex)      |
 *   | 2 | subtreePostIds    | arr(ids, b32)  |
 *   | 3 | subtreeMerkleRoot | b32 (bytes)    |
 *   | 4 | authorId          | b32 (bytes)    |
 *   | 5 | authorSignature   | b64 (bytes)    |
 *
 * Every field is fixed-width, so **every writer throws** outside its domain
 * (TYPES_INTERFACE → Totality): there is no unreachable sentinel at a fixed
 * width, and padding a malformed id to 32 bytes would map it onto a well-formed
 * entry's leaf. The domain is `verifyOrderingBlockStructure`'s, which pins the
 * hex and byte widths of every prune-entry field before a block reaches the
 * Merkle builder.
 */
export function serializePruneEntry(entry: PruneEntry): Uint8Array {
  const w = new ByteWriter();
  writeHexNOrThrow(w, entry.rootPostHash, 32);
  writeArr(w, entry.subtreePostIds, (ww, id) => writeHexNOrThrow(ww, id, 32));
  writeBytesNOrThrow(w, entry.subtreeMerkleRoot, 32);
  writeBytesNOrThrow(w, entry.authorId, 32);
  writeBytesNOrThrow(w, entry.authorSignature, 64);
  return w.toBytes();
}
