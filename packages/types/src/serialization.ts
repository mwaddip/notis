/**
 * The wire codecs — positional for every block struct, `cbor-x` for the two
 * that no block embeds.
 *
 * Contract: `contracts/TYPES_INTERFACE.md` → Serialization → Layout — Block.
 *
 * Each struct below is written as a `StructCodec` whose `write` and `read` walk
 * the same field list in the same order, laid out to be read line-by-line
 * against the contract's layout table. **Field order IS the specification**
 * (TYPES_INTERFACE → Primitives): reordering one is a consensus change with no
 * compiler signal, which is why the two halves sit adjacent rather than in
 * separate sections.
 *
 * Every `decodeX` goes through `decodeStruct`, so it carries the whole
 * four-part boundary check (TYPES_INTERFACE → The boundary check) — schema
 * projection, exhaustion, and the re-encode compare that rejects a non-minimal
 * VLQ. Unknown keys are unrepresentable and key order does not exist, which is
 * what shuts the open-map defect TYPES_INTERFACE → Serialization measures: an
 * ordering block carrying arbitrary extra keys hashing to a byte-identical
 * `blockHash` while the encoding differs by 395 bytes.
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
 * ## What is `cbor-x`, and why that is not an oversight
 *
 * `encodeStump` and `encodeTx`. Neither is reachable from a block struct —
 * `UtxoTxTree` commits `PruneEntry`, not `Stump`, and carries transactions as
 * `arr(utxoTxs, lp)`, opaque length-prefixed bytes. So neither is a consensus
 * preimage: transaction identity comes from `computeTxId`, which is positional,
 * and no committed root covers the stump codec.
 *
 * ⚠ **`TYPES_INTERFACE` → Layout — Stump specifies a positional form for
 * `Stump` that this file does not implement**, and its Serialization section
 * records the same gap for `encodeTx`. Nothing here closes either.
 *
 * ⚠ **`encodeTx` is the codec a post's payload crosses the wire under.** A post
 * rides `UtxoTransaction.post`, and `utxoTxs` carries CBOR — so the positional
 * `POST` codec below is the *id-preimage* statement of a post's layout, and
 * cbor-x is what a block body actually transports.
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
  type BlockHeader,
  type CoinbaseOutput,
  type UtxoTxTree,
  type OrderingBlock,
} from './block.js';

// ---------------------------------------------------------------------------
// Post — TYPES_INTERFACE → Layout — Post, wire codec row
// ---------------------------------------------------------------------------

/**
 * Fields 1–5 — **exactly the `postFieldBytes` sequence, with nothing after it.**
 *
 * The wire form and the id-preimage form are now the same bytes. A post has no
 * signature of its own (the creating transaction is signed over its `TxId`) and
 * no nonce to vary, so the two-field tail that used to distinguish them has no
 * members left. `postFieldBytes` stays the normative statement of the layout in
 * `post.ts`; this codec exists for the read half.
 *
 * ## Totality
 *
 * `content` (`lpUtf8`), `protocolVersion` and `timestamp` (`vlqU`) are total by
 * sentinel. `author` and every `parentRefs` entry are fixed-width and throw, and
 * their domain is `verifyPostFieldDomains` (`@dagsocial/validation`) — 32 bytes
 * and 64 lowercase hex.
 *
 * ⛔ **Both throwing rows are now reachable from `computeTxId`**, because
 * `txIdBytes` writes `postFieldBytes` for a post-bearing transaction. The
 * obligation `verifyPostFieldDomains` discharges therefore extends to every path
 * that hashes such a transaction — `validateTx` runs it before the id is taken,
 * and block apply's embedded-tx path is the call site TYPES_INTERFACE → Totality
 * books for the same reason it books the output fields.
 */
const POST: StructCodec<Post> = {
  name: 'post',
  write(w, p) {
    writeLpUtf8(w, p.content);
    writeBytesNOrThrow(w, p.author, 32);
    writeArr(w, p.parentRefs, (ww, ref) => writeHexNOrThrow(ww, ref, 32));
    writeVlqU(w, p.protocolVersion);
    writeVlqU(w, p.timestamp);
  },
  read(r) {
    return {
      content: readLpUtf8(r),
      author: readBytesN(r, 32),
      parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
      protocolVersion: readVlqU(r),
      timestamp: readVlqU(r),
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
// Stump — cbor-x
// ---------------------------------------------------------------------------
//
// No block struct embeds a `Stump`: `SubBlockTree` commits `PruneEntry`, whose
// preimage is positional. `TYPES_INTERFACE` → Layout — Stump specifies a
// positional form for `Stump` too, and this codec does not implement it — an
// open gap, flagged rather than closed here, because closing it moves bytes.

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
 * Nine fields. `protocolVersion` is **first** so it can be read before any
 * version-dependent dispatch exists to need it (TYPES_INTERFACE → Layout —
 * Block); there is exactly one
 * version today, and this pins the seam without building the version-keyed rule
 * table, which does not exist. Do not write code here that assumes it does.
 *
 * ⚠ **`validatorId` is `b32` from BYTES; its two table-neighbours are `b32`
 * from HEX.** `UserId = Uint8Array` (`identity.ts`), so `validatorId` takes
 * `writeBytesNOrThrow` while `prevBlockHash` / `utxoTxRoot`
 * take `writeHexNOrThrow`, even though the contract's table writes all three as
 * `b32` and its totality note groups them. Reading the row off its
 * neighbours rather than off the field's schema type gives a writer that throws
 * on **every** block — the `bond.inviteePublicKey` failure exactly, which is why
 * `TYPES_INTERFACE` → Layout — Boxes requires each writer to be checked against
 * its field's schema type, one row at a time.
 * `verifyHeaderFieldDomains`' own table agrees:
 * `isHex32` for the three, `isBytesOfLength(v, 32)` for this one.
 *
 * ## Totality
 *
 * Four throwing rows (`b32` ×3, `b33` ×1) and five `vlqU`, which are total by
 * sentinel and therefore **collide rather than throw**. All nine are pinned by
 * `verifyHeaderFieldDomains`, which is the only header domain in the
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
// Prune entry — a committed leaf of the one block body
// ---------------------------------------------------------------------------

/**
 * `b32(rootPostHash)` ‖ `arr(subtreePostIds, b32)` ‖ `b32(subtreeMerkleRoot)` ‖
 * `b32(authorId)` ‖ `b64(authorSignature)` ‖ `enum8(trigger)`.
 *
 * **The write half delegates to `serializePruneEntry` rather than restating the
 * layout**, and that is the whole point of doing it this way: those bytes are
 * the `'prune'` Merkle leaf preimage committed under `utxoTxRoot`, so an entry's
 * wire form and its committed form must be the same bytes. Two statements of one
 * layout is the drift class this format exists to close — the same reason
 * `boxRecordBytes` delegates its content half to `canonicalBoxBytes`.
 *
 * Every field is fixed-width and throws; the domain is
 * `verifyOrderingBlockStructure`'s per-entry checks, which pin the
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
 * `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)` ‖ `arr(pruneEntries)` ‖
 * `arr(coinbaseOutputs)`.
 *
 * **The block's one committed body.** Field order here is the same order
 * `computeUtxoTxRoot` lays its leaves in, and that order is normative
 * (TYPES_INTERFACE → OrderingBlock) — the wire form and the committed form walk
 * the sections in step rather than each choosing for itself.
 *
 * `utxoTxs` stays opaque: transactions cross as length-prefixed bytes, so this
 * tree does not depend on the transaction codec. `writeLp` is total — a
 * non-byte-view sentinels its *length prefix* and writes no payload — and
 * `verifyOrderingBlockStructure` checks the array's length alignment but **not
 * its element types**, so that sentinel is reachable on the encode side. Another
 * gate finding; `readLp` rejects it on decode because the sentinel length
 * overflows `readVlqU`.
 */
const UTXO_TX_TREE: StructCodec<UtxoTxTree> = {
  name: 'utxoTxTree',
  write(w, t) {
    writeArr(w, t.utxoTxIds, (ww, id) => writeHexNOrThrow(ww, id, 32));
    writeArr(w, t.utxoTxs, writeLp);
    writeArr(w, t.pruneEntries, writePruneEntry);
    writeArr(w, t.coinbaseOutputs, writeCoinbaseOutput);
  },
  read(r) {
    return {
      utxoTxIds: readArr(r, (rr) => readHexN(rr, 32)),
      utxoTxs: readArr(r, readLp),
      pruneEntries: readArr(r, readPruneEntry),
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
// Ordering block — the nested framing
// ---------------------------------------------------------------------------

/**
 * `lp(header)` ‖ `lp(utxoTxTree)` ‖ `b64(validatorSignature)`.
 *
 * The length prefixes are `vlqU` — the same primitive as every other count and
 * length in the format, rather than a fourth integer convention living in one
 * function.
 *
 * **The boundary check runs at the outer level AND inside each `lp` section.**
 * Each section is decoded through its own `decodeStruct`, so a malformed header
 * is rejected as `blockHeader: …` at its own offset rather than as an outer
 * mismatch somewhere in a 1200-byte blob. The outer `decodeStruct` then re-runs
 * exhaustion and the compare over the whole frame, which is what makes the three
 * distinct rejections distinct: a truncated section, a section whose length
 * overruns its parent, and trailing bytes after the signature.
 *
 * **Two sections, not three.** A post is a transaction, so the body it used to
 * ride is gone and `pruneEntries` moved inside `utxoTxTree` (`block.ts`).
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
    writeLp(w, encodeStruct(UTXO_TX_TREE, b.utxoTxTree));
    writeBytesNOrThrow(w, b.validatorSignature, 64);
  },
  read(r) {
    return {
      header: decodeStruct(HEADER, readLp(r)),
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
// UTXO transaction — cbor-x
// ---------------------------------------------------------------------------
//
// ⚠ **No `serializeTx` and no `serializeBox` here, and neither may be added.** A
// transaction's identity comes from `computeTxId` in `utxo.ts`, which is
// positional and routes outputs through `canonicalBoxBytes`; a third encoder
// built on cbor-x's *default* `encode` would be neither of the two encoders that
// matter (`TYPES_INTERFACE` → BoxId).
//
// These two are what `UtxoTxTree.utxoTxs` carries, and the tree carries them as
// `arr(utxoTxs, lp)` — opaque bytes with a length prefix — so no block struct
// depends on their shape. `TYPES_INTERFACE` → Layout — UtxoTransaction specifies
// a positional form this codec does not implement.

export function encodeTx(tx: UtxoTransaction): Uint8Array {
  return encode(tx) as unknown as Uint8Array;
}

export function decodeTx(bytes: Uint8Array): UtxoTransaction {
  return decode(Buffer.from(bytes)) as UtxoTransaction;
}
