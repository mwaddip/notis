/**
 * The wire codecs — positional for every block struct, `cbor-x` for the two
 * that no block embeds.
 *
 * Spec: `docs/specs/2026-08-09-positional-wire-format.md`.
 * Contract: `contracts/TYPES_INTERFACE.md` → Serialization → Layout — Block.
 *
 * Each struct below is written as a `StructCodec` whose `write` and `read` walk
 * the same field list in the same order, laid out to be read line-by-line
 * against the contract's layout table. **Field order IS the specification**
 * (spec §2.3): reordering one is a consensus change with no compiler signal,
 * which is why the two halves sit adjacent rather than in separate sections.
 *
 * Every `decodeX` goes through `decodeStruct`, so it carries the whole
 * four-part boundary check (spec §2.1) — schema projection, exhaustion, and the
 * re-encode compare that rejects a non-minimal VLQ. Unknown keys are
 * unrepresentable and key order does not exist, which is what closes §1.1: an
 * ordering block carrying arbitrary extra keys used to produce a byte-identical
 * `blockHash` while the encoding differed by 395 bytes.
 *
 * ## The three element writers hold no layout of their own
 *
 * `writeSubBlockEntry`, `writePruneEntry` and `writeCoinbaseOutput` are one
 * `w.writeBytes(...)` each, delegating to `subBlockEntryBytes`,
 * `serializePruneEntry` and `coinbaseOutputBytes` beside their structs. Those
 * three are exactly the elements whose bytes are also Merkle leaf preimages, and
 * the delegation is what keeps the wire form and the committed form one
 * statement instead of two. **None of the three may grow a field writer of its
 * own** — a reviewer can check that at a glance, which is the point of the
 * shape.
 *
 * ## What is still `cbor-x`, and why that is not an oversight
 *
 * `encodeStump` and `encodeTx`. Neither is reachable from a block struct —
 * `SubBlockTree` commits `PruneEntry`, not `Stump`, and `UtxoTxTree` carries
 * transactions as `arr(utxoTxs, lp)`, opaque length-prefixed bytes. So neither
 * is forced by this phase and neither is a consensus preimage: transaction
 * identity comes from `computeTxId` (already positional, Phase 2), and the
 * stump codec has no committed root over it. `TYPES_INTERFACE` → Layout — Stump
 * does specify a positional form for `Stump`; it is unclaimed by any phase.
 *
 * ## `encodePost` moved, and the contract is why
 *
 * `SubBlock`'s layout row is `b32(subBlockId) ‖ postBytes ‖ b32(producerId) ‖
 * vlqU(protocolVersion)` — `postBytes` with no `lp` around it, so the post
 * encoding has to be self-delimiting and positional or the reader cannot find
 * where it ends. `TYPES_INTERFACE` → Layout — Post already defines exactly that
 * sequence ("Wire codec `encodePost` = fields 1–6 ‖ `vlqU(powNonce)` ‖
 * `b64(signature)`"), so the post codec is not an addition to this phase's
 * scope — it is the row the `SubBlock` line names.
 */

import { encode, decode } from 'cbor-x';
import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  decodeStruct,
  encodeStruct,
  readArr,
  readBool,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readVlqU,
  readVlqU64,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeVlqU,
} from './codec.js';
import type { Post } from './post.js';
import type { UtxoTransaction } from './utxo.js';
import { TRIGGER, serializePruneEntry, type PruneEntry, type Stump } from './stump.js';
import {
  coinbaseOutputBytes,
  subBlockEntryBytes,
  type SubBlock,
  type SubBlockEntry,
  type BlockHeader,
  type CoinbaseOutput,
  type SubBlockTree,
  type UtxoTxTree,
  type OrderingBlock,
} from './block.js';

// ---------------------------------------------------------------------------
// Post — TYPES_INTERFACE → Layout — Post, wire codec row
// ---------------------------------------------------------------------------

/**
 * Fields 1–6 (the `postFieldBytes` sequence) ‖ `vlqU(powNonce)` ‖
 * `b64(signature)`.
 *
 * The first six fields are deliberately the id preimage's, in the id preimage's
 * order, so `encodePost` is `postFieldBytes` with a two-field tail rather than a
 * second encoding of a post. The two that follow are the two the preimage
 * excludes: the miner varies `powNonce`, and `signature` is never in any
 * preimage.
 *
 * ## Totality — two rows have no domain upstream
 *
 * `content` (`lpUtf8`), `protocolVersion`, `timestamp` and `powNonce` (`vlqU`)
 * are total by sentinel. `author`, `challenge` and every `parentRefs` entry are
 * fixed-width and throw, and their domain is `verifyPostFieldDomains`
 * (`@dagsocial/validation`, Phase 1c) — 32 bytes, 32 bytes, 64 lowercase hex.
 *
 * ⚠ **`signature` and `powNonce` are the exception, and it is not discharged.**
 * `verifyPostFieldDomains` stops after `timestamp`, deliberately: it is the
 * *signable* post's domain, and a post being signed has no signature yet. So
 * `b64(signature)` — a throwing writer — has no width check anywhere in the
 * repo (`verify.ts:355` pins `isBytes` only, and says outright that a wrong
 * *length* is left to `crypto.verify`), and `powNonce` has none either, so it
 * collides on the sentinel instead. Reported to main as Phase 3b's gate finding:
 * this is the 1c situation one struct over, and closing it belongs in
 * `@dagsocial/validation`, upstream of the encoder (spec §2.5).
 */
const POST: StructCodec<Post> = {
  name: 'post',
  write(w, p) {
    writeLpUtf8(w, p.content);
    writeBytesNOrThrow(w, p.author, 32);
    writeArr(w, p.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
    writeBytesNOrThrow(w, p.challenge, 32);
    writeVlqU(w, p.protocolVersion);
    writeVlqU(w, p.timestamp);
    writeVlqU(w, p.powNonce);
    writeBytesNOrThrow(w, p.signature, 64);
  },
  read(r) {
    return {
      content: readLpUtf8(r),
      author: readBytesN(r, 32),
      parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
      challenge: readBytesN(r, 32),
      protocolVersion: readVlqU(r),
      timestamp: readVlqU(r),
      powNonce: readVlqU(r),
      signature: readBytesN(r, 64),
    };
  },
};

export function encodePost(post: Post): Uint8Array {
  return encodeStruct(POST, post);
}

export function decodePost(bytes: Uint8Array): Post {
  return decodeStruct(POST, bytes);
}

// ---------------------------------------------------------------------------
// Stump — still cbor-x
// ---------------------------------------------------------------------------
//
// No block struct embeds a `Stump`: `SubBlockTree` commits `PruneEntry`, whose
// preimage moved with Phase 2. `TYPES_INTERFACE` → Layout — Stump specifies a
// positional form, and no phase claims it; flagged to main rather than folded
// in here, because moving it would be a byte change nothing in this phase
// forces.

export function encodeStump(stump: Stump): Uint8Array {
  return encode(stump) as unknown as Uint8Array;
}

export function decodeStump(bytes: Uint8Array): Stump {
  return decode(Buffer.from(bytes)) as Stump;
}

// ---------------------------------------------------------------------------
// Block header — TYPES_INTERFACE → Layout — Block, rows 1–10
// ---------------------------------------------------------------------------

/**
 * Ten fields. `protocolVersion` is **first** so it can be read before any
 * version-dependent dispatch exists to need it (spec §2.3); there is exactly one
 * version today, and this pins the seam without building the version-keyed rule
 * table, which does not exist. Do not write code here that assumes it does.
 *
 * ⚠ **`validatorId` is `b32` from BYTES; its three table-neighbours are `b32`
 * from HEX.** `UserId = Uint8Array` (`identity.ts`), so `validatorId` takes
 * `writeBytesNOrThrow` while `prevBlockHash` / `subBlockRoot` / `utxoTxRoot`
 * take `writeHexNOrThrow`, even though the contract's table writes all four as
 * `b32` and its totality note groups them as "`b32` ×4". Reading the row off its
 * neighbours rather than off the field's schema type gives a writer that throws
 * on **every** block — the `bond.inviteePublicKey` failure exactly, which is why
 * `TYPES_INTERFACE` → Layout — Boxes requires this phase to run writer-versus-
 * schema-type field by field. `verifyHeaderFieldDomains`' own table agrees:
 * `isHex32` for the three, `isBytesOfLength(v, 32)` for this one.
 *
 * ## Totality
 *
 * Five throwing rows (`b32` ×4, `b33` ×1) and five `vlqU`, which are total by
 * sentinel and therefore **collide rather than throw**. All ten are pinned by
 * `verifyHeaderFieldDomains` (Phase 1f), which is the only header domain in the
 * repo and which `blockHash` / `computePowHash` run internally — so the two
 * functions that reach this encoder establish their own precondition rather than
 * trusting thirteen call sites to remember it.
 */
const HEADER: StructCodec<BlockHeader> = {
  name: 'blockHeader',
  write(w, h) {
    writeVlqU(w, h.protocolVersion);
    writeVlqU(w, h.height);
    writeHexNOrThrow(w, h.prevBlockHash, 32);
    writeHexNOrThrow(w, h.subBlockRoot, 32);
    writeHexNOrThrow(w, h.utxoTxRoot, 32);
    writeHexNOrThrow(w, h.stateRoot, 33);
    writeBytesNOrThrow(w, h.validatorId, 32);
    writeVlqU(w, h.powNonce);
    writeVlqU(w, h.powTargetBits);
    writeVlqU(w, h.createdAt);
  },
  read(r) {
    return {
      protocolVersion: readVlqU(r),
      height: readVlqU(r),
      prevBlockHash: readHexN(r, 32),
      subBlockRoot: readHexN(r, 32),
      utxoTxRoot: readHexN(r, 32),
      stateRoot: readHexN(r, 33),
      validatorId: readBytesN(r, 32),
      powNonce: readVlqU(r),
      powTargetBits: readVlqU(r),
      createdAt: readVlqU(r),
    };
  },
};

export function encodeHeader(h: BlockHeader): Uint8Array {
  return encodeStruct(HEADER, h);
}

export function decodeHeader(bytes: Uint8Array): BlockHeader {
  return decodeStruct(HEADER, bytes);
}

// ---------------------------------------------------------------------------
// Sub-block tree — arr(subBlockEntries) ‖ arr(pruneEntries)
// ---------------------------------------------------------------------------

/**
 * `b32(postId)` ‖ `arr(parentRefs, b32)` ‖ `b32(author)` — all three hex.
 *
 * **The write half delegates to `subBlockEntryBytes` rather than restating the
 * layout**, for the reason `writePruneEntry` below has since Phase 2: those
 * bytes are the Merkle leaf preimage committed under `subBlockRoot`, so an
 * entry's wire form and its committed form must be the same bytes. The layout,
 * the writer choice per row (`author` is hex where the header's `validatorId` is
 * bytes) and the domain that makes each throwing writer unreachable all live
 * with the struct, in `block.ts`.
 */
function writeSubBlockEntry(w: ByteWriter, e: SubBlockEntry): void {
  w.writeBytes(subBlockEntryBytes(e));
}

function readSubBlockEntry(r: ByteReader): SubBlockEntry {
  return {
    postId: readHexN(r, 32),
    parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
    author: readHexN(r, 32),
  };
}

/**
 * `b32(rootPostHash)` ‖ `arr(subtreePostIds, b32)` ‖ `b32(subtreeMerkleRoot)` ‖
 * `b32(authorId)` ‖ `b64(authorSignature)` ‖ `enum8(trigger)`.
 *
 * **The write half delegates to `serializePruneEntry` rather than restating the
 * layout**, and that is the whole point of doing it this way: those bytes are
 * the Merkle leaf preimage committed under `subBlockRoot`, so an entry's wire
 * form and its committed form must be the same bytes. Two statements of one
 * layout is the drift class this format exists to close — the same reason
 * `boxRecordBytes` delegates its content half to `canonicalBoxBytes`.
 *
 * Every field is fixed-width and throws; the domain is
 * `verifyOrderingBlockStructure`'s per-entry checks (Phase 1e), which pin the
 * hex alphabet on the two id fields and `isBytes` plus an exact length on the
 * three byte fields.
 */
function writePruneEntry(w: ByteWriter, e: PruneEntry): void {
  w.writeBytes(serializePruneEntry(e));
}

function readPruneEntry(r: ByteReader): PruneEntry {
  return {
    rootPostHash: readHexN(r, 32),
    subtreePostIds: readArr(r, (rr) => readHexN(rr, 32)),
    subtreeMerkleRoot: readBytesN(r, 32),
    authorId: readBytesN(r, 32),
    authorSignature: readBytesN(r, 64),
    trigger: TRIGGER.read(r),
  };
}

/**
 * Two arrays, and **`subBlockRefs` is not one of them** (spec §1.2, §4.1).
 *
 * It was uncommitted — `computeSubBlockRoot` builds its leaves from
 * `subBlockEntries` and `pruneEntries` and never reads it — unvalidated beyond a
 * length check, and it drove state mutation: a block whose refs named entirely
 * different post ids was accepted with an unchanged `subBlockRoot` and an
 * unchanged `blockHash`, and those attacker-chosen ids reached a mempool
 * eviction and a mempool injection. It was also exactly
 * `subBlockEntries.map(e => e.postId)` for any honest block, so deleting it
 * costs nothing: consumers derive it (Phase 3a), and the two JSON routes still
 * emit the field so the HTTP response shape is unchanged.
 *
 * Deleted rather than pinned because this unit moves every byte anyway — under a
 * tightening the redundancy would have had to stay, since removing a wire field
 * moves bytes.
 */
const SUB_BLOCK_TREE: StructCodec<SubBlockTree> = {
  name: 'subBlockTree',
  write(w, t) {
    writeArr(w, t.subBlockEntries, writeSubBlockEntry);
    writeArr(w, t.pruneEntries, writePruneEntry);
  },
  read(r) {
    return {
      subBlockEntries: readArr(r, readSubBlockEntry),
      pruneEntries: readArr(r, readPruneEntry),
    };
  },
};

export function encodeSubBlockTree(t: SubBlockTree): Uint8Array {
  return encodeStruct(SUB_BLOCK_TREE, t);
}

export function decodeSubBlockTree(bytes: Uint8Array): SubBlockTree {
  return decodeStruct(SUB_BLOCK_TREE, bytes);
}

// ---------------------------------------------------------------------------
// UTXO transaction tree
// ---------------------------------------------------------------------------

/**
 * `b32(owner)` ‖ `vlqU64(value)` ‖ `vlqU(lockedUntilBlock)` ‖ `u8(isTreasury)`.
 *
 * **The write half delegates to `coinbaseOutputBytes`** — same rule as
 * `writeSubBlockEntry` above: those bytes are the `'coinbase'` Merkle leaf
 * preimage committed under `utxoTxRoot`, so the output's wire form and its
 * committed form are one statement, not two. The three rows where the
 * contract's notation and the field's schema type disagree, and the three
 * missing domain pins that leave two of its writers reachable from the encode
 * side, are documented with the struct in `block.ts`.
 */
function writeCoinbaseOutput(w: ByteWriter, o: CoinbaseOutput): void {
  w.writeBytes(coinbaseOutputBytes(o));
}

function readCoinbaseOutput(r: ByteReader): CoinbaseOutput {
  return {
    owner: readBytesN(r, 32),
    value: readVlqU64(r),
    lockedUntilBlock: readVlqU(r),
    isTreasury: readBool(r),
  };
}

/**
 * `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)` ‖ `arr(coinbaseOutputs)`.
 *
 * `utxoTxs` stays opaque: transactions cross as length-prefixed bytes, so this
 * tree does not depend on the transaction codec and `encodeTx` is not forced by
 * this phase. `writeLp` is total — a non-byte-view sentinels its *length prefix*
 * and writes no payload — and `verifyOrderingBlockStructure` checks the array's
 * length alignment but **not its element types**, so that sentinel is reachable
 * on the encode side. Another gate finding; `readLp` rejects it on decode
 * because the sentinel length overflows `readVlqU`.
 */
const UTXO_TX_TREE: StructCodec<UtxoTxTree> = {
  name: 'utxoTxTree',
  write(w, t) {
    writeArr(w, t.utxoTxIds, (ww, id) => writeHexNOrThrow(ww, id, 32));
    writeArr(w, t.utxoTxs, writeLp);
    writeArr(w, t.coinbaseOutputs, writeCoinbaseOutput);
  },
  read(r) {
    return {
      utxoTxIds: readArr(r, (rr) => readHexN(rr, 32)),
      utxoTxs: readArr(r, readLp),
      coinbaseOutputs: readArr(r, readCoinbaseOutput),
    };
  },
};

export function encodeUtxoTxTree(t: UtxoTxTree): Uint8Array {
  return encodeStruct(UTXO_TX_TREE, t);
}

export function decodeUtxoTxTree(bytes: Uint8Array): UtxoTxTree {
  return decodeStruct(UTXO_TX_TREE, bytes);
}

// ---------------------------------------------------------------------------
// Sub-block
// ---------------------------------------------------------------------------

/**
 * `b32(subBlockId)` ‖ `postBytes` ‖ `b32(producerId)` ‖ `vlqU(protocolVersion)`.
 *
 * `postBytes` carries no length prefix because it does not need one: every field
 * of `POST` above is either fixed-width, length-prefixed or a VLQ, so the post
 * is self-delimiting and the reader continues straight into `producerId`.
 *
 * ⚠ **`producerId` is bytes, `subBlockId` is hex** — `producerId` is `UserId`
 * (`= post.author`) and `subBlockId` is a `PostId` string. Third instance of the
 * same trap in this file.
 *
 * ⚠ **This is the weakest-gated struct in the phase, and by some distance.**
 * `verifySubBlockStructure` checks `sb.subBlockId` and `sb.producerId` for
 * **truthiness only** — no type, no width, no alphabet — while both feed
 * throwing fixed-width writers, and it checks `protocolVersion` with `typeof
 * === 'number'` only, where `vlqU` needs `isU64Safe` or it collides. Only the
 * embedded post is properly gated, by `verifyPostFieldDomains` (and only as far
 * as `timestamp` — see `POST`). Reported to main; the fix is a
 * `verifySubBlockStructure` tightening in `@dagsocial/validation`, which is
 * outside this phase's seam grant.
 */
const SUB_BLOCK: StructCodec<SubBlock> = {
  name: 'subBlock',
  write(w, sb) {
    writeHexNOrThrow(w, sb.subBlockId, 32);
    POST.write(w, sb.post);
    writeBytesNOrThrow(w, sb.producerId, 32);
    writeVlqU(w, sb.protocolVersion);
  },
  read(r) {
    return {
      subBlockId: readHexN(r, 32),
      post: POST.read(r),
      producerId: readBytesN(r, 32),
      protocolVersion: readVlqU(r),
    };
  },
};

export function encodeSubBlock(sb: SubBlock): Uint8Array {
  return encodeStruct(SUB_BLOCK, sb);
}

export function decodeSubBlock(bytes: Uint8Array): SubBlock {
  return decodeStruct(SUB_BLOCK, bytes);
}

// ---------------------------------------------------------------------------
// Ordering block — the nested framing
// ---------------------------------------------------------------------------

/**
 * `lp(header)` ‖ `lp(subBlockTree)` ‖ `lp(utxoTxTree)` ‖
 * `b64(validatorSignature)`.
 *
 * The length prefixes were hand-rolled `u32BE` (`DataView.setUint32` out,
 * `readUInt32BE` back) and are `vlqU` now, which is what makes them the same
 * primitive as every other count and length in the format instead of a fourth
 * integer convention living in one function.
 *
 * **The boundary check runs at the outer level AND inside each `lp` section.**
 * Each section is decoded through its own `decodeStruct`, so a malformed header
 * is rejected as `blockHeader: …` at its own offset rather than as an outer
 * mismatch somewhere in a 1200-byte blob. The outer `decodeStruct` then re-runs
 * exhaustion and the compare over the whole frame, which is what makes the three
 * distinct rejections distinct: a truncated section, a section whose length
 * overruns its parent, and trailing bytes after the signature.
 *
 * A nested `CodecError` is a `ReaderError`, so it propagates through the outer
 * `decodeStruct`'s step-1 catch unchanged rather than being re-wrapped as a
 * `reader-fault` — the precise diagnosis survives the nesting.
 *
 * `validatorSignature` is `b64` from bytes and throws; its domain is
 * `verifyOrderingBlockStructure`'s `isBytes` plus an exact length of 64, which
 * that function's own comment explains is a type check and not a `.length` read
 * for exactly this reason.
 */
const ORDERING_BLOCK: StructCodec<OrderingBlock> = {
  name: 'orderingBlock',
  write(w, b) {
    writeLp(w, encodeStruct(HEADER, b.header));
    writeLp(w, encodeStruct(SUB_BLOCK_TREE, b.subBlockTree));
    writeLp(w, encodeStruct(UTXO_TX_TREE, b.utxoTxTree));
    writeBytesNOrThrow(w, b.validatorSignature, 64);
  },
  read(r) {
    return {
      header: decodeStruct(HEADER, readLp(r)),
      subBlockTree: decodeStruct(SUB_BLOCK_TREE, readLp(r)),
      utxoTxTree: decodeStruct(UTXO_TX_TREE, readLp(r)),
      validatorSignature: readBytesN(r, 64),
    };
  },
};

export function encodeOrderingBlock(block: OrderingBlock): Uint8Array {
  return encodeStruct(ORDERING_BLOCK, block);
}

export function decodeOrderingBlock(bytes: Uint8Array): OrderingBlock {
  return decodeStruct(ORDERING_BLOCK, bytes);
}

// ---------------------------------------------------------------------------
// UTXO transaction — still cbor-x
// ---------------------------------------------------------------------------
//
// `serializeTx` lived here and was deleted by Spec G phase G3b, for the reason
// phase 0 deleted `serializeBox`: no `src` caller, and built on cbor-x's
// *default* `encode` — neither of the two encoders that matter. A transaction's
// identity comes from `computeTxId` in `utxo.ts`, which is positional as of
// Phase 2 and routes outputs through `canonicalBoxBytes`.
//
// These two are what `UtxoTxTree.utxoTxs` carries, and the tree carries them as
// `arr(utxoTxs, lp)` — opaque bytes with a length prefix — so no block struct
// depends on their shape and this phase does not force them. `TYPES_INTERFACE` →
// Layout — UtxoTransaction specifies the positional form; it is unclaimed.

export function encodeTx(tx: UtxoTransaction): Uint8Array {
  return encode(tx) as unknown as Uint8Array;
}

export function decodeTx(bytes: Uint8Array): UtxoTransaction {
  return decode(Buffer.from(bytes)) as UtxoTransaction;
}
