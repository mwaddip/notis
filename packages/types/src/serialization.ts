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
 * The `utxoTxTree` codec carries two sections, `utxoTxIds` and `utxoTxs`. A
 * prune rides the transaction rail as a `UtxoTransaction.prune` payload, so it
 * needs no section of its own (TYPES_INTERFACE → Ordering block).
 */

import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  CodecError,
  arrByteLength,
  decodeStruct,
  encodeStruct,
  firstDifference,
  lpByteLength,
  readArr,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readOpt,
  readVlqU,
  writeArr,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeOpt,
  writeVlqU,
} from './codec.js';
import { postFieldBytes, readPostCommitFields, type PostCommit } from './post.js';
import { readTxIdFields, writeTxIdFields, type UtxoTransaction } from './utxo.js';
import type {
  BlockHeader,
  UtxoTxTree,
  OrderingBlock,
} from './block.js';

// ---------------------------------------------------------------------------
// PostCommit — TYPES_INTERFACE → Layout — PostCommit, wire codec row
// ---------------------------------------------------------------------------

/**
 * Fields 1–5 — **exactly the `postFieldBytes` sequence, with nothing after it.**
 *
 * The wire form and the id-preimage form are the same bytes. A commit has no
 * signature of its own (the creating transaction is signed over its `TxId`) and
 * no body — the body travels apart (TYPES_INTERFACE → Layout — Post body).
 * `postFieldBytes` stays the normative statement of the layout in `post.ts`;
 * this codec exists for the read half.
 *
 * ## Totality
 *
 * `protocolVersion` (`vlqU`) is total by sentinel. `contentHash`, `author`
 * and every `parentRefs` entry are fixed-width (`b32`) and throw;
 * `type` (`enum8`) sentinels to 0xff, refused at decode as invalid-tag
 * (TYPES_INTERFACE → Canonical field encoding). All have their domain
 * established by `verifyPostCommitDomains` (`@dagsocial/validation`) — `b32`
 * stays unreachable because its writers throw, `enum8` because the membership
 * rule keeps the sentinel path closed.
 *
 * ⛔ **The throwing rows (`b32`) are reachable from `computeTxId`**, because
 * `txIdBytes` writes `postFieldBytes` for a post-bearing transaction. The
 * obligation `verifyPostCommitDomains` discharges therefore extends to every
 * path that hashes such a transaction — `validateTx` runs it before the id
 * is taken, and block apply's embedded-tx path is the call site
 * TYPES_INTERFACE → Totality books for the same reason it books the output
 * fields.
 */
const POST_COMMIT: StructCodec<PostCommit> = {
  name: 'postCommit',
  write(w, c) {
    w.writeBytes(postFieldBytes(c));
  },
  read: readPostCommitFields,
};

export function encodePostCommit(commit: PostCommit): Uint8Array {
  return encodeStruct(POST_COMMIT, commit);
}

export function decodePostCommit(bytes: Uint8Array): PostCommit {
  return decodeStruct(POST_COMMIT, bytes);
}

// ---------------------------------------------------------------------------
// Post body — TYPES_INTERFACE → Layout — Post body
// ---------------------------------------------------------------------------

/**
 * The body's standalone wire form: `lpUtf8(content)`.
 *
 * Keyed by the post id wherever it travels (the packet's transaction, the
 * pull request's id list); **never hashed into anything** — the only binding
 * is `computeContentHash(content) == commit.contentHash`, checked by
 * `verifyPostBody` at every entry (VALIDATION_INTERFACE → verifyPostBody).
 */
const POST_BODY: StructCodec<string> = {
  name: 'postBody',
  write(w, content) {
    writeLpUtf8(w, content);
  },
  read(r) {
    return readLpUtf8(r);
  },
};

export function encodePostBody(content: string): Uint8Array {
  return encodeStruct(POST_BODY, content);
}

export function decodePostBody(bytes: Uint8Array): string {
  return decodeStruct(POST_BODY, bytes);
}

// ---------------------------------------------------------------------------
// Transaction packet — TYPES_INTERFACE → Layout — UtxoTransaction, packet codec
// ---------------------------------------------------------------------------

/**
 * `encodeTx(tx)` ‖ `opt(lpUtf8(content))` — the gossip payload for every
 * transaction (NET_INTERFACE → Gossip Topics).
 *
 * The body is outside `txIdBytes`, outside every id and every Merkle leaf;
 * a transaction that carries no post pays the `opt` absence tag, one byte,
 * on the wire only.
 *
 * ⛔ **The biconditional (`tx.post` present ⟺ `content` present) is NOT a
 * property of these bytes.** The codec encodes what it is given; the rule is
 * stated and enforced where packets enter (NET_INTERFACE → Gossip Topics,
 * NODE_INTERFACE → Post transactions).
 *
 * `decodeTxPacket` keeps the boundary discipline the struct decoder has:
 * trailing bytes reject, and re-encoding the decoded value reproduces the
 * input byte-for-byte.
 */
export function encodeTxPacket(tx: UtxoTransaction, content?: string): Uint8Array {
  const w = new ByteWriter();
  TX.write(w, tx);
  writeOpt(w, content, writeLpUtf8);
  return w.toBytes();
}

export interface TxPacket {
  tx: UtxoTransaction;
  content?: string;
}

export function decodeTxPacket(bytes: Uint8Array): TxPacket {
  const r = new ByteReader(bytes);
  const tx = TX.read(r);
  const content = readOpt(r, readLpUtf8) ?? undefined;
  if (!r.isExhausted) throw new CodecError('txPacket', 'trailing-bytes');
  const reEncoded = encodeTxPacket(tx, content);
  const diff = firstDifference(bytes, reEncoded);
  if (diff !== -1) throw new CodecError('txPacket', 'non-canonical');
  return { tx, content };
}

// ---------------------------------------------------------------------------
// Block header — TYPES_INTERFACE → Layout — Block, fields 1–10
// ---------------------------------------------------------------------------

/**
 * Ten fields. `protocolVersion` is **first** so it can be read before any
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
 * Five throwing rows (`b32` ×4, `b33` ×1) and five `vlqU`, which are total by
 * sentinel and therefore **collide rather than throw**. All ten are pinned by
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
    writeHexNOrThrow(w, h.interlinkRoot, 32);
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
      interlinkRoot: readHexN(r, 32),
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
// UTXO transaction tree
// ---------------------------------------------------------------------------

/**
 * `arr(utxoTxIds, b32)` ‖ `arr(utxoTxs, lp)`.
 *
 * **The block's one committed body.** Prunes are transactions, so they ride
 * `utxoTxIds` with everything else and there is no second section.
 *
 * ⛔ **TWO SECTIONS.** Coinbase outputs are outputs of the block's settlement
 * transaction, so they arrive inside `utxoTxs` like every other transaction's
 * (`block.ts` → `UtxoTxTree`).
 *
 * ⛔ **`utxoTxTreeByteLength` COMPUTES THIS TREE'S LENGTH A SECOND WAY**, so a
 * section added here or removed from here owes the matching term there in the same
 * change — otherwise two ways of computing one length diverge with no compiler
 * signal.
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
  },
  read(r) {
    return {
      utxoTxIds: readArr(r, (rr) => readHexN(rr, 32)),
      utxoTxs: readArr(r, readLp),
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
    arrByteLength(t.utxoTxs, lpByteLength)
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
 * **Two `lp` sections** — `header` (the `HEADER` codec) and `utxoTxTree` (the
 * `UTXO_TX_TREE` codec) — followed by the fixed 64-byte `validatorSignature`.
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
 * ✅ **Box ids, tx ids, `utxoTxRoot` and `stateRoot` do not depend on this codec.**
 * `computeTxId` walks `writeTxIdFields` and `computeUtxoTxRoot` hashes
 * `leafHash('utxotx', id)` — the id, never the body encoding. What the codec
 * decides is the wire bytes peers must agree on and the `utxoTxTreeByteLength`
 * that gates `MAX_BLOCK_BODY_BYTES`.
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
