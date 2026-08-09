import { createHash } from 'crypto';
import { ByteWriter } from '@dagsocial/wire';
import {
  enum8,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

/**
 * What caused a subtree to be compacted. Shared by `PruneIntent`, `PruneEntry`
 * and `Stump` — one alias rather than three inline unions, because it is also
 * the domain of the `trigger` tag table below.
 */
export type PruneTrigger = 'author' | 'storage_prune';

/**
 * The `trigger` tag table (TYPES_INTERFACE → Layout — Stump / PruneEntry).
 *
 * **Tags reserve retired values and are never renumbered.** A renumber
 * silently moves every prune Merkle leaf and every id covering the tag, with no
 * compiler signal — the T2b `0x03` lesson, now inside a consensus preimage.
 *
 * Exported because `Stump` (Phase 3) and the golden-vector harness both need
 * *this* table rather than a second copy of it: two implementations of one tag
 * table is the drift class this format exists to close.
 */
export const TRIGGER = enum8<PruneTrigger>('trigger', {
  author: 0,
  storage_prune: 1,
});

// ---------------------------------------------------------------------------
// Karma delta (aggregated from pruned subtree)
// ---------------------------------------------------------------------------

export interface KarmaDelta {
  userId: UserId;
  delta: number;
}

// ---------------------------------------------------------------------------
// Prune intent (author signs this to authorize pruning)
// ---------------------------------------------------------------------------

export interface PruneIntent {
  rootPostHash: PostId;
  trigger: PruneTrigger;
  authorId: UserId;
  subtreeMerkleRoot: Uint8Array;   // 32 bytes — Merkle root over leafHash('stump', postId) per pruned post
  subtreePostIds: PostId[];        // All post IDs in the reply subtree
  signature: Uint8Array;           // 64 bytes — Ed25519 sig over (rootPostHash, subtreeMerkleRoot)
}

// ---------------------------------------------------------------------------
// Prune entry (committed in SubBlockTree; one per pruned reply subtree)
// ---------------------------------------------------------------------------

export interface PruneEntry {
  rootPostHash: PostId;
  subtreePostIds: PostId[];
  subtreeMerkleRoot: Uint8Array;
  authorId: UserId;
  authorSignature: Uint8Array;     // 64 bytes — Ed25519 sig over blake2b512(rootPostHash ++ subtreeMerkleRoot)
  trigger: PruneTrigger;
}

// ---------------------------------------------------------------------------
// Stump (compact proof replacing a pruned subtree — historical artifact)
// ---------------------------------------------------------------------------

export interface Stump {
  rootPostHash: PostId;
  authorId: UserId;
  replyCount: number;
  upvoteCount: number;
  trigger: PruneTrigger;
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export type StumpId = string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic ID for a PruneEntry.
 *
 * ⚠ **Still the old dialect, and deliberately out of this phase's scope.**
 * `rootPostHash` enters as the UTF-8 of its hex text while the two byte fields
 * enter raw, so this is the last preimage in the file that is not the
 * positional format. It is not a `serializePruneEntry` caller and no committed
 * root covers it — the id is a mempool/store key — so moving it is an
 * independent change; flagged for main rather than folded in here.
 */
export function computePruneEntryId(entry: PruneEntry): string {
  const h = createHash('blake2b512');
  h.update(entry.rootPostHash);
  h.update(entry.subtreeMerkleRoot);
  h.update(entry.authorId);
  return h.digest().subarray(0, 32).toString('hex');
}

/**
 * The canonical encoding of a PruneEntry — the Merkle leaf preimage in the
 * subtree proof, committed under `subBlockRoot`.
 *
 * TYPES_INTERFACE → Layout — Stump / PruneEntry:
 *
 *   | 1 | rootPostHash      | b32 (hex)      |
 *   | 2 | subtreePostIds    | arr(ids, b32)  |
 *   | 3 | subtreeMerkleRoot | b32 (bytes)    |
 *   | 4 | authorId          | b32 (bytes)    |
 *   | 5 | authorSignature   | b64 (bytes)    |
 *   | 6 | trigger           | enum8          |
 *
 * Field order matches the CBOR object literal this replaces, so the change is
 * **dialect-only**: same coverage, one encoding language. The old form went
 * through `cbor-x`'s *default* `encode`, which tags every `Uint8Array` with
 * `d840` and writes ids as hex text — 428 bytes for a two-id entry against 226
 * here.
 *
 * Every field is fixed-width, so **every writer throws** outside its domain
 * (spec §2.5): there is no unreachable sentinel at a fixed width, and padding a
 * malformed id to 32 bytes would map it onto a well-formed entry's leaf. The
 * domain is `verifyOrderingBlockStructure`'s (Phase 1e), which pins the hex and
 * byte widths of every prune-entry field before a block reaches the Merkle
 * builder.
 */
export function serializePruneEntry(entry: PruneEntry): Uint8Array {
  const w = new ByteWriter();
  writeHexNOrThrow(w, entry.rootPostHash, 32);
  writeArr(w, entry.subtreePostIds, (ww, id) => writeHexNOrThrow(ww, id, 32));
  writeBytesNOrThrow(w, entry.subtreeMerkleRoot, 32);
  writeBytesNOrThrow(w, entry.authorId, 32);
  writeBytesNOrThrow(w, entry.authorSignature, 64);
  TRIGGER.write(w, entry.trigger);
  return w.toBytes();
}
