import { ByteWriter } from '@dagsocial/wire';
import {
  writeArr,
  writeBool,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeVlqU,
  writeVlqU64OrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import type { Post, PostId } from './post.js';
import type { TxId } from './utxo.js';
import type { PruneEntry } from './stump.js';

// ---------------------------------------------------------------------------
// Sub-block (user-produced)
// ---------------------------------------------------------------------------

export interface SubBlock {
  subBlockId: PostId;         // = post.postId (the post IS the sub-block)
  post: Post;                 // The post (with PoW = sub-block proof)
  producerId: UserId;         // = post.author
  protocolVersion: number;
}

/** Construct a SubBlock from a Post, deriving producerId and protocolVersion. */
export function subBlockFromPost(post: Post, subBlockId: string): SubBlock {
  return {
    subBlockId,
    post,
    producerId: post.author,
    protocolVersion: post.protocolVersion,
  };
}

// ---------------------------------------------------------------------------
// Coinbase output (block reward)
// ---------------------------------------------------------------------------

export interface CoinbaseOutput {
  owner: UserId;              // 32-byte recipient public key
  value: bigint;              // Credits minted (integer base units of 10^-8 credit)
  lockedUntilBlock: number;   // Height at which credits become spendable
  isTreasury: boolean;        // Treasury or miner output
}

/**
 * One coinbase output's positional bytes — `b32(owner)` ‖ `vlqU64(value)` ‖
 * `vlqU(lockedUntilBlock)` ‖ `u8(isTreasury)`.
 *
 * **These bytes are the `'coinbase'` Merkle leaf preimage and the output's wire
 * encoding, and they are the same bytes** (TYPES_INTERFACE → Layout — Merkle
 * leaf preimages). `UtxoTxTree`'s element writer delegates here rather than
 * restating the layout, for the same reason `writePruneEntry` delegates to
 * `serializePruneEntry`: an output's wire form and its committed
 * form must be one statement, because two statements of one layout drift with no
 * compiler signal and a consistent transposition round-trips perfectly — no
 * round-trip test can see it.
 *
 * ⚠ **The `leafHash('coinbase', …)` domain tag stays outside.** This returns the
 * output bytes alone; the caller supplies the tag. That is what makes the wire
 * form and the preimage byte-identical rather than merely parallel.
 *
 * ⚠ **Three of these four rows are where the contract's notation and the field's
 * schema type disagree, and each disagreement points at a different writer.**
 *
 * - `owner` is `UserId` = `Uint8Array`, so `b32` means `writeBytesNOrThrow`, not
 *   the hex writer three of the header's `b32` rows use.
 * - **`value` is `bigint`**, so `vlqU` means `writeVlqU64OrThrow` — the
 *   **throwing** bigint writer, not the total `number` one. The compiler catches
 *   this substitution, which is the only reason it is not the sharpest row here:
 *   `writeVlqU` would have sentinelled every coinbase output in existence.
 * - **`isTreasury` is `boolean`**, so `u8` means `writeBool`, which is total
 *   (`{0,1}` is narrower than a byte, so `0xff` is unreachable from a valid
 *   value and `readBool` refuses it). `writeU8OrThrow` would throw on every
 *   block.
 *
 * ## Domain
 *
 * All four fields have their domain established upstream of this encoder
 * (TYPES_INTERFACE → Totality), in `@dagsocial/validation` —
 * VALIDATION_INTERFACE → `verifyOrderingBlockStructure`.
 *
 * Decode closes the reachable half of each: `readVlqU` throws past
 * `MAX_SAFE_INTEGER`, `readVlqU64` wraps into the u64 domain, `readBool` rejects
 * any byte but `0x00`/`0x01`, and the re-encode compare rejects non-minimal
 * padding. So a peer cannot inject one of these through gossip. What remains is
 * the encode side, which `encodeOrderingBlock`, node's store write and node's
 * `computeUtxoTxRoot` reach without passing a decoder — the last at block
 * *creation* and again at block *apply*.
 *
 * That third reach adds no surface the other two did not already have, in either
 * direction: a gossiped block reaches apply through `decodeOrderingBlock`, which
 * has closed the domain above; a self-produced one carries node's own coinbase
 * construction, which is exactly what `encodeOrderingBlock` already encodes.
 * Neither reach is where the rejection is stated: the upstream domain check
 * above is, and it is what makes this encoder's throw unreachable.
 */
export function coinbaseOutputBytes(o: CoinbaseOutput): Uint8Array {
  const w = new ByteWriter();
  writeBytesNOrThrow(w, o.owner, 32);
  writeVlqU64OrThrow(w, o.value);
  writeVlqU(w, o.lockedUntilBlock);
  writeBool(w, o.isTreasury);
  return w.toBytes();
}

// ---------------------------------------------------------------------------
// Block header — what gets hashed for block ID and PoW
// ---------------------------------------------------------------------------

export interface BlockHeader {
  protocolVersion: number;
  height: number;
  prevBlockHash: string;        // hex(32) — hash of previous header
  subBlockRoot: string;         // hex(32) — Merkle root over DAG content
  utxoTxRoot: string;           // hex(32) — Merkle root over UTXO content
  stateRoot: string;            // hex(33) — AVL+ digest (zeroed for MVP)
  validatorId: UserId;
  powNonce: number;
  powTargetBits: number;
  createdAt: number;            // unix ms
}

/** 33 zero bytes — placeholder for future AVL+ state root. */
export const EMPTY_STATE_ROOT = '00'.repeat(33);

// ---------------------------------------------------------------------------
// Body sections (independently requestable)
// ---------------------------------------------------------------------------

/**
 * Committed topology + authorship for one confirmed sub-block.
 *
 * `author` is consensus-carried (audit H-3): it rides in the block, committed
 * under `subBlockRoot`, so every node — including one that synced from ordering
 * blocks alone and never saw the post content — records an identical author per
 * post. It is a `postId`-preimage field, so any node holding the content can
 * verify the claim; nodes holding the post at apply time MUST reject a block
 * whose entry contradicts it (see NODE_INTERFACE.md, apply-time authorization).
 * This is what makes prune authorship checkable without DAG content.
 */
export interface SubBlockEntry {
  postId: string;        // hex-encoded 32-byte post ID
  parentRefs: string[];  // hex-encoded parent post IDs (0–MAX_PARENT_REFS entries)
  author: string;        // hex-encoded 32-byte author public key of the post
}

/**
 * One entry's positional bytes — `b32(postId)` ‖ `arr(parentRefs, b32)` ‖
 * `b32(author)`, all three hex.
 *
 * **These bytes are the `'subblock'` Merkle leaf preimage and the entry's wire
 * encoding, and they are the same bytes** (TYPES_INTERFACE → Layout — Merkle
 * leaf preimages). `SubBlockTree`'s element writer delegates here rather than
 * restating the layout, for the same reason `writePruneEntry` delegates to
 * `serializePruneEntry`: an entry's wire form and its committed
 * form must be one statement, because two statements of one layout drift with no
 * compiler signal and a consistent transposition round-trips perfectly — no
 * round-trip test can see it.
 *
 * ⚠ **The `leafHash('subblock', …)` domain tag stays outside.** This returns the
 * entry bytes alone; the caller supplies the tag. That is what makes the wire
 * form and the preimage byte-identical rather than merely parallel.
 *
 * ⚠ **`author` is hex here and `validatorId` is bytes in the header**, and both
 * are "a 32-byte Ed25519 public key" carried as `b32`. The in-memory spelling is
 * what decides the writer, not what the field means: `SubBlockEntry.author` is
 * declared `string` above and `verifyOrderingBlockStructure` checks it with
 * `isHex32`.
 *
 * Every row throws, and every row is pinned by `verifyOrderingBlockStructure`,
 * including `parentRefs.length <= MAX_PARENT_REFS`.
 */
export function subBlockEntryBytes(e: SubBlockEntry): Uint8Array {
  const w = new ByteWriter();
  writeHexNOrThrow(w, e.postId, 32);
  writeArr(w, e.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
  writeHexNOrThrow(w, e.author, 32);
  return w.toBytes();
}

/**
 * **Two arrays, and `subBlockRefs` is not one of them** (TYPES_INTERFACE →
 * Layout — Block).
 *
 * `computeSubBlockRoot` builds its leaves from `subBlockEntries` and
 * `pruneEntries` alone, so a `subBlockRefs` field here would be uncommitted:
 * refs naming entirely different post ids would ride an unchanged
 * `subBlockRoot` and an unchanged `blockHash`, and still reach a mempool
 * **eviction** (`removeSubBlockEntries`) and, through the journal's
 * `confirmedSubBlockIds`, a mempool **injection** on reorg.
 *
 * The asymmetry is what makes that reachable rather than merely untidy: apply
 * confirms from `subBlockEntries`, which is committed, so an uncommitted
 * parallel list on the rollback side lets the two disagree.
 *
 * It is also exactly `subBlockEntries.map(e => e.postId)` for any honest block,
 * so consumers derive it — `subBlockIdsOf` in node — and the two JSON routes
 * emit the field, leaving the HTTP response shape unchanged.
 */
export interface SubBlockTree {
  subBlockEntries: SubBlockEntry[]; // topology committed in the block
  pruneEntries: PruneEntry[];       // prune entries committed in this block
}

export interface UtxoTxTree {
  utxoTxIds: TxId[];            // UTXO transactions
  utxoTxs: Uint8Array[];        // CBOR-encoded UtxoTransactions (aligned with utxoTxIds)
  coinbaseOutputs: CoinbaseOutput[];
}

// ---------------------------------------------------------------------------
// Ordering block (validator-produced)
// ---------------------------------------------------------------------------

export interface OrderingBlock {
  header: BlockHeader;
  subBlockTree: SubBlockTree;
  utxoTxTree: UtxoTxTree;
  validatorSignature: Uint8Array;  // 64 bytes — Ed25519 over header hash
}
