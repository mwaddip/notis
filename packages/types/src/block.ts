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
 * restating the layout, for the reason `writePruneEntry` has delegated to
 * `serializePruneEntry` since Phase 2: an output's wire form and its committed
 * form must be one statement, because two statements of one layout drift with no
 * compiler signal and a consistent transposition round-trips perfectly — no
 * round-trip test can see it.
 *
 * ⚠ **The `leafHash('coinbase', …)` domain tag stays outside.** This returns the
 * output bytes alone; the caller supplies the tag. That is what makes the wire
 * form and the preimage byte-identical rather than merely parallel.
 *
 * The contract's table writes row 2 as `vlqU`; it is `vlqU64` because the field
 * is `bigint`, and the distinction is the throwing/total one, not a byte one.
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
 * ## Domain — the least-covered struct in the block layout
 *
 * `verifyOrderingBlockStructure` pins `owner` (`isBytes` + length 32) and the
 * *sign* of `value` (`>= 0n`). The other three pins are missing, reported to
 * main as Phase 3b's gate findings and none of them this package's to add — the
 * domain belongs upstream of the encoder (spec §2.5), in `@dagsocial/validation`:
 *
 * - `value` has **no `< 2^64` ceiling**, and this writer throws above it.
 * - `lockedUntilBlock` is checked `typeof === 'number' && >= header.height` —
 *   a lower bound only, so `1.5`, `Infinity` and `2^60` all pass and all
 *   **collide** on the sentinel. This is the `createdAt` failure Phase 1f
 *   closed, one struct over and still open.
 * - `isTreasury` is **checked nowhere at all**.
 *
 * Decode closes the reachable half of each: `readVlqU` throws past
 * `MAX_SAFE_INTEGER`, `readVlqU64` wraps into the u64 domain, `readBool` rejects
 * any byte but `0x00`/`0x01`, and the re-encode compare rejects non-minimal
 * padding. So a peer cannot inject one of these through gossip. What remains is
 * the encode side, which `encodeOrderingBlock` and node's store write reach
 * without passing a decoder — and, once Phase 4 lands, node's `computeUtxoTxRoot`
 * as well, at block *creation* and again at block *apply*.
 *
 * That third reach adds no surface the other two did not already have, in either
 * direction: a gossiped block reaches apply through `decodeOrderingBlock`, which
 * has closed the domain above; a self-produced one carries node's own coinbase
 * construction, which is exactly what `encodeOrderingBlock` already encodes. It
 * does mean an out-of-domain value now throws inside root computation rather
 * than inside framing — a stated rejection either way only because the apply
 * funnel's totality catch is there to convert it.
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

/**
 * The widest PoW target any block can satisfy: the bit length of the PoW hash.
 *
 * `hasLeadingZeroBits` (`@dagsocial/validation`, `verify.ts:103`) answers
 * `false` for any `targetBits` past the digest's own width, and the digest is
 * `blake2b512(...).subarray(0, 32)` — 32 bytes, 256 bits. A header claiming
 * more describes a block no nonce can ever produce.
 *
 * This is a fact about the hash, **not a difficulty policy and not a validity
 * rule**: nothing rejects a block for exceeding it. The consensus minimum is
 * `ORDERING_BLOCK_POW_TARGET_FLOOR` in `constants.ts`, checked at apply. This
 * one bounds arithmetic, not admission — see `cumulativeWork`.
 */
export const MAX_SATISFIABLE_TARGET_BITS = 32 * 8;

/**
 * Sum of expected hashes over a chain segment = Σ 2^powTargetBits.
 *
 * The fork-choice quantity: a node compares its own segment against a competing
 * one and reorgs only on strictly greater work.
 *
 * **Total, and it has to be.** `node/src/index.ts:261` calls this on
 * `theirChainHeaders`, which reaches it from `net`'s `requestHeaders` —
 * `decode(response) as BlockHeader[]`, a raw cbor decode plus a TypeScript
 * cast. Fork resolution refuses a peer batch holding a header outside the
 * *encodable* domain (`findForkPoint` → `blockHash`), but that domain is
 * `isU64Safe`, so `powTargetBits` still arrives anywhere in [0, 2⁵³).
 * Measured 2026-08-09, node v22.19.0:
 *
 * - `powTargetBits = 2³⁰−1` → succeeds, allocating 128 MiB in 32 ms
 * - `powTargetBits = 2³⁰`   → `RangeError: Maximum BigInt size exceeded`
 * - two headers at `2³⁰−2`  → every term fits; the **sum** overflows and throws
 *
 * so the exponent is a peer-controlled allocation knob and a peer-controlled
 * panic, and the accumulator overflows independently of any single term.
 *
 * **The convention: a header whose `powTargetBits` falls outside
 * `[0, MAX_SATISFIABLE_TARGET_BITS]` — or is not an integer at all — counts as
 * zero, per header, and the rest of the segment still counts.** This is not a
 * defensive skip. A target wider than the hash cannot be met by any nonce, so
 * no work can have been done on such a header and zero *is* its expected-hash
 * count. It costs no legitimate reorg: `expectedTarget` is a network constant
 * (12 bits on every profile) and apply rejects anything under
 * `ORDERING_BLOCK_POW_TARGET_FLOOR`, so no header on an honest chain can be
 * one. Understating a segment only ever declines a reorg, which is the safe
 * direction; the caller reads a smaller number as "not heavier" and stays put.
 *
 * **What this does not do.** It removes the allocation and the panic; it does
 * not make the comparison sound. Nothing here or at the call site verifies a
 * competing header's PoW, so a peer claiming `powTargetBits: 200` on 40 headers
 * still outweighs an honest 12-bit chain by 2¹⁸⁸ and still buys a reorg
 * attempt — inside the domain, no allocation, no throw. Bounding *claimed* work
 * cannot fix *comparing* claimed work; that is the caller's to close.
 *
 * Totality is claimed for exactly what the signature admits: an array whose
 * elements are `BlockHeader`s, whose `powTargetBits` is any `number` — NaN,
 * Infinity, floats and negatives included. A non-array still throws at the
 * `for…of`, deliberately: covering that would be absorbing a cast violation
 * that belongs upstream, and half a boundary reads as protection while being
 * none.
 */
export function cumulativeWork(headers: BlockHeader[]): bigint {
  let sum = 0n;
  for (const h of headers) {
    const bits = h.powTargetBits;
    if (!Number.isSafeInteger(bits) || bits < 0 || bits > MAX_SATISFIABLE_TARGET_BITS) {
      continue;
    }
    sum += 1n << BigInt(bits);
  }
  return sum;
}

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
 * restating the layout, for the reason `writePruneEntry` has delegated to
 * `serializePruneEntry` since Phase 2: an entry's wire form and its committed
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
 * Every row throws, and every row is pinned by `verifyOrderingBlockStructure`
 * (Phase 1e), including `parentRefs.length <= MAX_PARENT_REFS`.
 */
export function subBlockEntryBytes(e: SubBlockEntry): Uint8Array {
  const w = new ByteWriter();
  writeHexNOrThrow(w, e.postId, 32);
  writeArr(w, e.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
  writeHexNOrThrow(w, e.author, 32);
  return w.toBytes();
}

/**
 * `subBlockRefs` was here and is **DELETED** (Phase 3b; spec §1.2, §4.1).
 *
 * It was uncommitted — `computeSubBlockRoot` builds its leaves from
 * `subBlockEntries` and `pruneEntries` and never read it — and unvalidated
 * beyond `Array.isArray` plus a length equal to `subBlockEntries.length`.
 * Measured: a block whose refs named entirely different post ids was accepted
 * with an unchanged `subBlockRoot` and an unchanged `blockHash`, and element
 * types were never checked at all. Those attacker-chosen values reached a
 * mempool **eviction** (`removeSubBlockEntries`) and, through the journal's
 * `confirmedSubBlockIds`, a mempool **injection** on reorg.
 *
 * The asymmetry was the defect: apply confirmed from `subBlockEntries`, which is
 * committed, while rollback un-confirmed from `subBlockRefs`, which was not.
 *
 * Deleted rather than pinned because it was exactly
 * `subBlockEntries.map(e => e.postId)` for any honest block — this comment used
 * to say so itself, calling it "derived from subBlockEntries, kept for
 * ordering" — and because this unit moves every committed byte anyway, so
 * removing a wire field costs nothing it would have cost under a tightening.
 * Consumers derive it (Phase 3a) and the two JSON routes still emit it, so the
 * HTTP response shape is unchanged.
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
