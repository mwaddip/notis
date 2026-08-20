/**
 * The positional wire codecs — every struct paired encoder/decoder.
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
 * ## The element writer holds no layout of its own
 *
 * `writePruneEntry` is one `w.writeBytes(...)`, delegating to
 * `serializePruneEntry` beside its struct. A prune entry is the one element
 * whose bytes are also a Merkle leaf preimage, and the delegation is what keeps
 * the wire form and the committed form one statement instead of two. **It may
 * not grow a field writer of its own** — a reviewer can check that at a glance,
 * which is the point of the shape.
 */

import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  arrByteLength,
  decodeStruct,
  encodeStruct,
  lpByteLength,
  readArr,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readVlqU,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeVlqU,
} from './codec.js';
import { postFieldBytes, readPostFields, type Post } from './post.js';
import { readTxIdFields, writeTxIdFields, type UtxoTransaction } from './utxo.js';
import { serializePruneEntry, type PruneEntry } from './stump.js';
import type {
  BlockHeader,
  UtxoTxTree,
  OrderingBlock,
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
 * `content` (`lpUtf8`) and `protocolVersion` (`vlqU`) are total by sentinel.
 * `author` and every `parentRefs` entry are fixed-width and throw, and `type`
 * (`enum8`) throws on an unknown key — all three have their domain established
 * by `verifyPostFieldDomains` (`@dagsocial/validation`).
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
  // ⛔ **Both halves DELEGATE to `post.ts`, and neither restates the layout.**
  // `postFieldBytes` is the normative writer and `readPostFields` its adjacent
  // reader, and the same pair is reached from inside `txIdBytes`' `post` option —
  // so a post's fields have one statement whether they arrive standalone or
  // inside the transaction that creates them. Restating either half here would
  // put two statements of one layout in two files, free to disagree with no
  // compiler signal.
  write(w, p) {
    w.writeBytes(postFieldBytes(p));
  },
  read: readPostFields,
};

export function encodePost(post: Post): Uint8Array {
  return encodeStruct(POST, post);
}

export function decodePost(bytes: Uint8Array): Post {
  return decodeStruct(POST, bytes);
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
 * `b32(authorId)` ‖ `b64(authorSignature)`.
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
  };
}

/**
 * The width `writePruneEntry` produces (TYPES_INTERFACE → Sizing without
 * encoding). Four fixed-width fields around one count-prefixed array of `b32`
 * ids — the entry's only variable term, and the reason an entry has no constant
 * size.
 */
function pruneEntryByteLength(e: PruneEntry): number {
  return (
    32 +                                        // rootPostHash      b32
    arrByteLength(e.subtreePostIds, () => 32) + // subtreePostIds    arr(ids, b32)
    32 +                                        // subtreeMerkleRoot b32
    32 +                                        // authorId          b32
    64                                          // authorSignature   b64
  );
}

// ---------------------------------------------------------------------------
// UTXO transaction tree
// ---------------------------------------------------------------------------

/**
 * `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)` ‖ `arr(pruneEntries)`.
 *
 * **The block's one committed body.** Field order here is the same order
 * `computeUtxoTxRoot` lays its leaves in, and that order is normative
 * (TYPES_INTERFACE → OrderingBlock) — the wire form and the committed form walk
 * the sections in step rather than each choosing for itself.
 *
 * ⛔ **THREE SECTIONS.** Coinbase outputs are outputs of the block's settlement
 * transaction, so they arrive inside `utxoTxs` like every other transaction's
 * (`block.ts` → `UtxoTxTree`).
 *
 * ⛔ **`utxoTxTreeByteLength` COMPUTES THIS TREE'S LENGTH A SECOND WAY**, so a
 * section added here or removed from here owes the matching term there in the same
 * change — otherwise two ways of computing one length diverge with no compiler
 * signal. Adding or removing a section that is not the **last** also renumbers the
 * ones after it, since a positional format has no keys.
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
  },
  read(r) {
    return {
      utxoTxIds: readArr(r, (rr) => readHexN(rr, 32)),
      utxoTxs: readArr(r, readLp),
      pruneEntries: readArr(r, readPruneEntry),
    };
  },
};

export function encodeUtxoTxTree(t: UtxoTxTree): Uint8Array {
  return encodeStruct(UTXO_TX_TREE, t);
}

export function decodeUtxoTxTree(bytes: Uint8Array): UtxoTxTree {
  return decodeStruct(UTXO_TX_TREE, bytes);
}

/**
 * The byte length `encodeUtxoTxTree` produces, computed from the structure and
 * allocating nothing (TYPES_INTERFACE → Sizing without encoding). The measure
 * `MAX_BLOCK_BODY_BYTES` is checked against.
 *
 * ⛔ **The equivalence with `encodeUtxoTxTree(t).length` is the contract** —
 * `test/utxo-tx-tree-size.test.ts` is what holds two ways of computing one
 * number together, and it is exact over every tree the encoder encodes. That
 * includes the branches where a writer sentinels rather than throws, which are
 * inside the encoder's success domain and are where a sizer assuming
 * well-formed fields would report *fewer* bytes than the encoder writes.
 *
 * Where a writer throws, the tree has no encoding at all and this returns a
 * number rather than propagating — the contract puts the body check inside
 * `verifyOrderingBlockStructure`, which runs over peer-supplied bodies on the
 * gossip relay path.
 *
 * `utxoTxs` stays opaque here as it does in the codec above — element lengths
 * are read, contents never — so nothing in this measurement depends on the
 * transaction codec.
 */
export function utxoTxTreeByteLength(t: UtxoTxTree): number {
  return (
    arrByteLength(t.utxoTxIds, () => 32) +
    arrByteLength(t.utxoTxs, lpByteLength) +
    arrByteLength(t.pruneEntries, pruneEntryByteLength)
  );
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
// UTXO transaction — TYPES_INTERFACE → Layout — UtxoTransaction, wire-codec row
// ---------------------------------------------------------------------------

/**
 * `txIdBytes` ‖ `arr(signatures sorted, b32(pubkey) ‖ b64(sig))`.
 *
 * ⛔ **The six preimage fields are NOT restated here.** `writeTxIdFields` and
 * `readTxIdFields` (`utxo.ts`) are the single statement of them, and this codec
 * is that pair plus the signature array — so the wire form and the `TxId`
 * preimage share one writer rather than agreeing by inspection.
 *
 * ✅ **THIS MOVES NO COMMITTED HASH.** `computeTxId` walks the same
 * `writeTxIdFields`, and `computeUtxoTxRoot`'s leaves are `leafHash('utxotx',
 * id)` — the id, never the encoding — so every box id, transaction id,
 * `utxoTxRoot` and `stateRoot` is byte-identical across the change from `cbor-x`.
 * What moves is the **wire**: peers must agree on this codec to decode a body at
 * all, and `utxoTxTreeByteLength` gates `MAX_BLOCK_BODY_BYTES`, so they must agree
 * in order to agree on whether a block fits.
 *
 * **Signatures are the only field this layout adds to the preimage**, and they
 * are correctly absent from it: they are Ed25519 *over* the `TxId`, so hashing
 * them would make the id depend on signatures over itself.
 *
 * `signatures` is a **map, and a positional format has none** — it encodes as an
 * array sorted by raw key bytes ascending (TYPES_INTERFACE → Primitives, the
 * normative map sort), or one transaction would have two encodings and the
 * malleability this format closes would reopen for the one field a relay handles.
 * Keys are lowercase hex, so sorting the strings and sorting the decoded bytes
 * give the same order, and `signatures` is the only map left in this layout for
 * that argument to carry.
 *
 * ⛔ **A duplicate or out-of-order key has no encoding, and the boundary check is
 * what says so rather than a rule here.** Duplicates collapse into one map entry
 * on decode and re-encode shorter; a mis-sorted array re-encodes sorted. Both
 * come back as `non-canonical` from `decodeStruct`'s compare, which is where every
 * other canonicity rule in this format is enforced.
 *
 * ## Totality
 *
 * Both signature fields **throw**: a pubkey outside 64 lowercase hex and a
 * signature that is not exactly 64 bytes have no encoding rather than sharing one
 * with a well-formed pair (TYPES_INTERFACE → Totality). Their domain is
 * `checkTxEnvelope`'s (node), which pins the map's keys — and the values are
 * `b64` for the same reason `validatorSignature` is.
 */
const TX: StructCodec<UtxoTransaction> = {
  name: 'utxoTransaction',
  write(w, tx) {
    writeTxIdFields(w, tx);
    const sortedKeys = Object.keys(tx.signatures).sort();
    writeArr(w, sortedKeys, (ww, pubkey) => {
      writeHexNOrThrow(ww, pubkey, 32);
      writeBytesNOrThrow(ww, tx.signatures[pubkey]!, 64);
    });
  },
  read(r) {
    const fields = readTxIdFields(r);
    const entries = readArr(r, (rr) => [readHexN(rr, 32), readBytesN(rr, 64)] as const);
    return { ...fields, signatures: Object.fromEntries(entries) };
  },
};

export function encodeTx(tx: UtxoTransaction): Uint8Array {
  return encodeStruct(TX, tx);
}

export function decodeTx(bytes: Uint8Array): UtxoTransaction {
  return decodeStruct(TX, bytes);
}
