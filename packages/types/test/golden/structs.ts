/**
 * The Phase 2 struct codecs — the three id preimages, as golden-vector codecs.
 *
 * These differ from `probe.ts` in one deliberate way, and it is the point of
 * the file: **the write half is the production function.** `probe` is a
 * synthetic struct whose two halves are both test-side, so it regression-tests
 * the harness; these encode through `postPowPreimage`, `canonicalBoxBytes` and
 * `serializePruneEntry` themselves, so a vector is a pin on the shipped
 * encoder rather than on a lookalike.
 *
 * The **read** half is written independently, from the layout tables in
 * `contracts/TYPES_INTERFACE.md` → Serialization. That is what earns the decode
 * direction: `decodeStruct` parses with this reader, asserts exhaustion, then
 * re-encodes through the *production* writer and byte-compares. So a vector
 * proves the preimage is self-delimiting and canonical — no trailing slack, no
 * non-minimal integer — which a one-directional "these bytes are frozen"
 * assertion cannot.
 *
 * None of these preimages is decoded in production. The readers exist for the
 * boundary check and for the conformance role the corpus takes on afterwards:
 * an independent implementation reads the `.json` and checks itself both ways.
 */

import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  readArr,
  readBool,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readOpt,
  readVlqS,
  readVlqU,
  readVlqU64,
} from '../../src/codec.js';
import { postPowPreimage, powNonceBytes, type Post } from '../../src/post.js';
import { serializePruneEntry, TRIGGER, type PruneEntry } from '../../src/stump.js';
import { canonicalBoxBytes, type BoxCandidate } from '../../src/utxo.js';
import {
  encodeHeader,
  encodeSubBlockTree,
  encodeUtxoTxTree,
  encodeSubBlock,
  encodeOrderingBlock,
} from '../../src/serialization.js';
import {
  coinbaseOutputBytes,
  subBlockEntryBytes,
  type BlockHeader,
  type CoinbaseOutput,
  type OrderingBlock,
  type SubBlock,
  type SubBlockEntry,
  type SubBlockTree,
  type UtxoTxTree,
} from '../../src/block.js';
import { hex, registerStruct, type ValueCodec } from './harness.js';

// ---------------------------------------------------------------------------
// postFields — what `postFieldBytes` covers
// ---------------------------------------------------------------------------

/**
 * The six fields the post preimage encodes.
 *
 * `powNonce` and `signature` are deliberately absent: the miner varies the
 * first and the second is never in any preimage. Naming the subject `PostFields`
 * rather than `Post` keeps the corpus honest about what the bytes carry — a
 * vector cannot accidentally claim coverage of a field the encoder skips.
 */
export interface PostFields {
  content: string;
  author: Uint8Array;
  parentRefs: string[];
  challenge: Uint8Array;
  protocolVersion: number;
  timestamp: number;
}

/** Values for the two excluded fields. Neither reaches `postFieldBytes`. */
const NOT_IN_PREIMAGE = { powNonce: 0, signature: new Uint8Array(64) };

const postFieldsCodec: ValueCodec<PostFields> = {
  parse(json: unknown): PostFields {
    const j = json as Record<string, unknown>;
    return {
      content: j.content as string,
      author: hex(j.author as string),
      parentRefs: j.parentRefs as string[],
      challenge: hex(j.challenge as string),
      protocolVersion: j.protocolVersion as number,
      timestamp: j.timestamp as number,
    };
  },

  // Production writer. `postPowPreimage` IS `postFieldBytes`.
  write(w: ByteWriter, p: PostFields): void {
    w.writeBytes(postPowPreimage({ ...p, ...NOT_IN_PREIMAGE } as Post));
  },

  // Independent reader — TYPES_INTERFACE → Layout — Post, in order.
  read(r: ByteReader): PostFields {
    return {
      content: readLpUtf8(r),
      author: readBytesN(r, 32),
      parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
      challenge: readBytesN(r, 32),
      protocolVersion: readVlqU(r),
      timestamp: readVlqU(r),
    };
  },
};

// ---------------------------------------------------------------------------
// powNonceTail / powPreimage — the tail the id and the PoW hash both append
// ---------------------------------------------------------------------------
//
// `powNonceBytes` is that tail's only writer (TYPES_INTERFACE → Hashing
// functions), so it is the one preimage element a second package builds by
// calling this package rather than by re-reading a layout table. These two
// codecs are what a conformance implementation — or `@dagsocial/validation` —
// checks itself against.
//
// The split is deliberate. `powNonceTail` pins the export alone, which is the
// unit `verifyPoW` calls and the only place the encoding is stated; the tail is
// one byte at the nonces a post is actually mined at, so inside a 132-byte
// vector its whole width is invisible. `powPreimage` pins the concatenation —
// the exact bytes the PoW hash covers, `computePostId` domain-tags and
// `verifyPoW` hashes bare — so a vector also fixes where the boundary between
// the two falls.

/** `postFieldBytes` plus the nonce the miner varies. `signature` stays out. */
export interface PowPreimage extends PostFields {
  powNonce: number;
}

const powNonceTailCodec: ValueCodec<number> = {
  parse: (json: unknown): number => json as number,

  // Production writer — the export itself, not a lookalike.
  write(w: ByteWriter, nonce: number): void {
    w.writeBytes(powNonceBytes(nonce));
  },

  // Independent reader — TYPES_INTERFACE → Layout — Post, the `vlqU(powNonce)`
  // row.
  read: readVlqU,
};

const powPreimageCodec: ValueCodec<PowPreimage> = {
  parse(json: unknown): PowPreimage {
    const j = json as Record<string, unknown>;
    return { ...postFieldsCodec.parse(j), powNonce: j.powNonce as number };
  },

  // Both production writers, composed in `computePostId`'s order — the field
  // bytes, then the tail.
  write(w: ByteWriter, p: PowPreimage): void {
    postFieldsCodec.write(w, p);
    w.writeBytes(powNonceBytes(p.powNonce));
  },

  read(r: ByteReader): PowPreimage {
    return { ...postFieldsCodec.read(r), powNonce: readVlqU(r) };
  },
};

// ---------------------------------------------------------------------------
// boxContent — what `canonicalBoxBytes` covers
// ---------------------------------------------------------------------------

/**
 * A box as its identity preimage sees it.
 *
 * **`guard` is not a member**, and that is structural rather than an omission:
 * it left the consensus bytes with P2-C row C10, so a corpus entry has no way
 * to carry it and the decode direction could not reconstruct it if it did.
 * Provenance (`id`/`txId`/`index`) is absent for the same reason.
 */
export type BoxContent =
  | { boxType: 'karma'; value: bigint; owner: Uint8Array; proofSource: string; decayBurn: boolean | null }
  | { boxType: 'credit'; value: bigint; owner: Uint8Array; proofSource: number; lockedUntilBlock: number | null }
  | { boxType: 'invite'; value: bigint; secretHash: Uint8Array; inviterId: Uint8Array }
  | {
      boxType: 'bond';
      value: bigint;
      inviterId: Uint8Array;
      inviteOutputIndex: number;
      /** 0 or 32 bytes — empty = unclaimed, 32 = committed. Encodes as `opt(b32)`. */
      inviteePublicKey: Uint8Array;
      probationStartBlock: number;
      probationEndBlock: number;
    }
  | { boxType: 'post_lock'; value: bigint; originalValue: bigint; owner: Uint8Array; targetPostId: string }
  | { boxType: 'vouch'; value: bigint; voucherId: Uint8Array; targetId: Uint8Array };

/** The tag table, restated from the contract so a renumber fails here too. */
const BOX_TYPE_BY_TAG: Record<number, BoxContent['boxType']> = {
  0: 'karma',
  1: 'credit',
  2: 'invite',
  // 3 — reserved, retired `like`. Never reuse.
  4: 'bond',
  5: 'post_lock',
  6: 'vouch',
};

const boxContentCodec: ValueCodec<BoxContent> = {
  parse(json: unknown): BoxContent {
    const j = json as Record<string, unknown>;
    const value = BigInt(j.value as string);
    switch (j.boxType as BoxContent['boxType']) {
      case 'karma':
        return {
          boxType: 'karma',
          value,
          owner: hex(j.owner as string),
          proofSource: j.proofSource as string,
          decayBurn: (j.decayBurn ?? null) as boolean | null,
        };
      case 'credit':
        return {
          boxType: 'credit',
          value,
          owner: hex(j.owner as string),
          proofSource: j.proofSource as number,
          lockedUntilBlock: (j.lockedUntilBlock ?? null) as number | null,
        };
      case 'invite':
        return {
          boxType: 'invite',
          value,
          secretHash: hex(j.secretHash as string),
          inviterId: hex(j.inviterId as string),
        };
      case 'bond':
        return {
          boxType: 'bond',
          value,
          inviterId: hex(j.inviterId as string),
          inviteOutputIndex: j.inviteOutputIndex as number,
          inviteePublicKey: hex(j.inviteePublicKey as string),
          probationStartBlock: j.probationStartBlock as number,
          probationEndBlock: j.probationEndBlock as number,
        };
      case 'post_lock':
        return {
          boxType: 'post_lock',
          value,
          originalValue: BigInt(j.originalValue as string),
          owner: hex(j.owner as string),
          targetPostId: j.targetPostId as string,
        };
      case 'vouch':
        return {
          boxType: 'vouch',
          value,
          voucherId: hex(j.voucherId as string),
          targetId: hex(j.targetId as string),
        };
      default:
        throw new Error(`boxContent: unknown boxType ${String(j.boxType)}`);
    }
  },

  // Production writer.
  write(w: ByteWriter, box: BoxContent): void {
    w.writeBytes(canonicalBoxBytes(box as BoxCandidate));
  },

  // Independent reader — TYPES_INTERFACE → Layout — Boxes, in order.
  read(r: ByteReader): BoxContent {
    const tag = r.readU8();
    const boxType = BOX_TYPE_BY_TAG[tag];
    if (boxType === undefined) throw new Error(`boxContent: unknown boxType tag ${tag}`);
    const value = readVlqU64(r);
    switch (boxType) {
      case 'karma':
        return {
          boxType,
          value,
          owner: readBytesN(r, 32),
          proofSource: readLpUtf8(r),
          decayBurn: readOpt(r, readBool),
        };
      case 'credit':
        return {
          boxType,
          value,
          owner: readBytesN(r, 32),
          proofSource: readVlqS(r),
          lockedUntilBlock: readOpt(r, readVlqU),
        };
      case 'invite':
        return { boxType, value, secretHash: readBytesN(r, 32), inviterId: readBytesN(r, 32) };
      case 'bond':
        return {
          boxType,
          value,
          inviterId: readBytesN(r, 32),
          inviteOutputIndex: readVlqU(r),
          // `opt(b32)`, and absent decodes to EMPTY rather than to `null`:
          // empty ↔ absent is the encoder's mapping of a 0-or-32-byte field,
          // so the reader has to invert it for the re-encode compare to close.
          // A reader returning `null` here would fail the boundary check on
          // every unclaimed bond — which is what makes this the vector that
          // proves the mapping, in both directions, rather than only one.
          inviteePublicKey: readOpt(r, (rr) => readBytesN(rr, 32)) ?? new Uint8Array(0),
          probationStartBlock: readVlqU(r),
          probationEndBlock: readVlqU(r),
        };
      case 'post_lock':
        return {
          boxType,
          value,
          originalValue: readVlqU64(r),
          owner: readBytesN(r, 32),
          targetPostId: readHexN(r, 32),
        };
      case 'vouch':
        return { boxType, value, voucherId: readBytesN(r, 32), targetId: readBytesN(r, 32) };
    }
  },
};

// ---------------------------------------------------------------------------
// pruneEntry — the subtree-proof Merkle leaf
// ---------------------------------------------------------------------------

const pruneEntryCodec: ValueCodec<PruneEntry> = {
  parse(json: unknown): PruneEntry {
    const j = json as Record<string, unknown>;
    return {
      rootPostHash: j.rootPostHash as string,
      subtreePostIds: j.subtreePostIds as string[],
      subtreeMerkleRoot: hex(j.subtreeMerkleRoot as string),
      authorId: hex(j.authorId as string),
      authorSignature: hex(j.authorSignature as string),
      trigger: j.trigger as PruneEntry['trigger'],
    };
  },

  // Production writer.
  write(w: ByteWriter, entry: PruneEntry): void {
    w.writeBytes(serializePruneEntry(entry));
  },

  // Independent reader — TYPES_INTERFACE → Layout — Stump / PruneEntry.
  read(r: ByteReader): PruneEntry {
    return {
      rootPostHash: readHexN(r, 32),
      subtreePostIds: readArr(r, (rr) => readHexN(rr, 32)),
      subtreeMerkleRoot: readBytesN(r, 32),
      authorId: readBytesN(r, 32),
      authorSignature: readBytesN(r, 64),
      trigger: TRIGGER.read(r),
    };
  },
};

// ---------------------------------------------------------------------------
// The block structs — TYPES_INTERFACE → Layout — Block (Phase 3b)
// ---------------------------------------------------------------------------
//
// ⚠ **These are new, not reset.** The dispatch brief described block-struct
// vectors as being "reset to the new format"; there were none. Before Phase 3b
// this corpus covered `postFields`, `boxContent` and `pruneEntry` — the three
// Phase 2 id preimages — and the corpus files are `primitives`, `probe`,
// `post`, `boxes` and `prune`. So the block half of the conformance suite is
// being written for the first time here, which makes it a larger deliverable
// than "reset" implies and is worth knowing before anyone reads a byte count as
// a diff.
//
// Same discipline as above: the **write** half is the production codec, so a
// vector pins the shipped encoder; the **read** half is written independently
// from the layout table, so `decodeStruct`'s re-encode compare has two
// implementations to disagree.

const blockHeaderCodec: ValueCodec<BlockHeader> = {
  parse(json: unknown): BlockHeader {
    const j = json as Record<string, unknown>;
    return {
      protocolVersion: j.protocolVersion as number,
      height: j.height as number,
      prevBlockHash: j.prevBlockHash as string,
      subBlockRoot: j.subBlockRoot as string,
      utxoTxRoot: j.utxoTxRoot as string,
      stateRoot: j.stateRoot as string,
      // Bytes, where its three `b32` table-neighbours are hex. The JSON spells
      // it as hex like everything else; the in-memory type is what differs.
      validatorId: hex(j.validatorId as string),
      powNonce: j.powNonce as number,
      powTargetBits: j.powTargetBits as number,
      createdAt: j.createdAt as number,
    };
  },
  write(w: ByteWriter, h: BlockHeader): void {
    w.writeBytes(encodeHeader(h));
  },
  read(r: ByteReader): BlockHeader {
    return {
      protocolVersion: readVlqU(r),
      height: readVlqU(r),
      prevBlockHash: readHexN(r, 32),
      subBlockRoot: readHexN(r, 32),
      utxoTxRoot: readHexN(r, 32),
      stateRoot: readHexN(r, 33),   // b33 — the AVL+ digest carries a height byte
      validatorId: readBytesN(r, 32),
      powNonce: readVlqU(r),
      powTargetBits: readVlqU(r),
      createdAt: readVlqU(r),
    };
  },
};

/** Independent readers for the three nested structs, from the layout lines. */
function readEntry(r: ByteReader): SubBlockEntry {
  return {
    postId: readHexN(r, 32),
    parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
    author: readHexN(r, 32),   // hex, unlike the header's validatorId
  };
}

function readPrune(r: ByteReader): PruneEntry {
  return {
    rootPostHash: readHexN(r, 32),
    subtreePostIds: readArr(r, (rr) => readHexN(rr, 32)),
    subtreeMerkleRoot: readBytesN(r, 32),
    authorId: readBytesN(r, 32),
    authorSignature: readBytesN(r, 64),
    trigger: TRIGGER.read(r),
  };
}

function readCoinbase(r: ByteReader): CoinbaseOutput {
  return {
    owner: readBytesN(r, 32),
    value: readVlqU64(r),        // bigint — the throwing writer's row
    lockedUntilBlock: readVlqU(r),
    isTreasury: readBool(r),     // strict 0/1; 0xff has no decoding
  };
}

function parseEntry(j: Record<string, unknown>): SubBlockEntry {
  return {
    postId: j.postId as string,
    parentRefs: j.parentRefs as string[],
    author: j.author as string,
  };
}

function parsePrune(j: Record<string, unknown>): PruneEntry {
  return {
    rootPostHash: j.rootPostHash as string,
    subtreePostIds: j.subtreePostIds as string[],
    subtreeMerkleRoot: hex(j.subtreeMerkleRoot as string),
    authorId: hex(j.authorId as string),
    authorSignature: hex(j.authorSignature as string),
    trigger: j.trigger as PruneEntry['trigger'],
  };
}

function parseCoinbase(j: Record<string, unknown>): CoinbaseOutput {
  return {
    owner: hex(j.owner as string),
    value: BigInt(j.value as string),   // decimal string — JSON cannot carry a u64
    lockedUntilBlock: j.lockedUntilBlock as number,
    isTreasury: j.isTreasury as boolean,
  };
}

// ---------------------------------------------------------------------------
// The two element preimages — TYPES_INTERFACE → Layout — Merkle leaf preimages
// ---------------------------------------------------------------------------
//
// `subBlockEntryBytes` and `coinbaseOutputBytes` are the block's other two
// Merkle leaf preimages: `leafHash('subblock', …)` under `subBlockRoot` and
// `leafHash('coinbase', …)` under `utxoTxRoot`, exactly as `serializePruneEntry`
// is the `'prune'` one. They earn their own vectors rather than riding inside
// `subBlockTree` / `utxoTxTree` because from Phase 4 node hashes them directly,
// so they need the same cross-implementation anchor every other preimage here
// has — a conformance reader must be able to check one leaf without building a
// tree around it.
//
// The readers and parsers are the tree codecs' own (`readEntry` / `readCoinbase`,
// written independently from the layout table at Phase 3b), which is what makes
// a moved element byte fail here **and** in the enclosing tree vector.

const subBlockEntryCodec: ValueCodec<SubBlockEntry> = {
  parse: (json: unknown): SubBlockEntry => parseEntry(json as Record<string, unknown>),
  write(w: ByteWriter, e: SubBlockEntry): void {
    w.writeBytes(subBlockEntryBytes(e));
  },
  read: readEntry,
};

const coinbaseOutputCodec: ValueCodec<CoinbaseOutput> = {
  parse: (json: unknown): CoinbaseOutput => parseCoinbase(json as Record<string, unknown>),
  write(w: ByteWriter, o: CoinbaseOutput): void {
    w.writeBytes(coinbaseOutputBytes(o));
  },
  read: readCoinbase,
};

const subBlockTreeCodec: ValueCodec<SubBlockTree> = {
  parse(json: unknown): SubBlockTree {
    const j = json as Record<string, unknown>;
    return {
      // No `subBlockRefs`: the vector file has no way to spell it, which is the
      // deletion stated in the conformance suite rather than only in the type.
      subBlockEntries: (j.subBlockEntries as Record<string, unknown>[]).map(parseEntry),
      pruneEntries: (j.pruneEntries as Record<string, unknown>[]).map(parsePrune),
    };
  },
  write(w: ByteWriter, t: SubBlockTree): void {
    w.writeBytes(encodeSubBlockTree(t));
  },
  read(r: ByteReader): SubBlockTree {
    return {
      subBlockEntries: readArr(r, readEntry),
      pruneEntries: readArr(r, readPrune),
    };
  },
};

const utxoTxTreeCodec: ValueCodec<UtxoTxTree> = {
  parse(json: unknown): UtxoTxTree {
    const j = json as Record<string, unknown>;
    return {
      utxoTxIds: j.utxoTxIds as string[],
      utxoTxs: (j.utxoTxs as string[]).map(hex),
      coinbaseOutputs: (j.coinbaseOutputs as Record<string, unknown>[]).map(parseCoinbase),
    };
  },
  write(w: ByteWriter, t: UtxoTxTree): void {
    w.writeBytes(encodeUtxoTxTree(t));
  },
  read(r: ByteReader): UtxoTxTree {
    return {
      utxoTxIds: readArr(r, (rr) => readHexN(rr, 32)),
      utxoTxs: readArr(r, readLp),   // opaque: transactions are length-prefixed bytes
      coinbaseOutputs: readArr(r, readCoinbase),
    };
  },
};

/** The post as `encodePost` writes it: the six preimage fields, then two more. */
function readWirePost(r: ByteReader): Post {
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
}

function parseWirePost(j: Record<string, unknown>): Post {
  return {
    content: j.content as string,
    author: hex(j.author as string),
    parentRefs: j.parentRefs as string[],
    challenge: hex(j.challenge as string),
    protocolVersion: j.protocolVersion as number,
    timestamp: j.timestamp as number,
    powNonce: j.powNonce as number,
    signature: hex(j.signature as string),
  };
}

const subBlockCodec: ValueCodec<SubBlock> = {
  parse(json: unknown): SubBlock {
    const j = json as Record<string, unknown>;
    return {
      subBlockId: j.subBlockId as string,
      post: parseWirePost(j.post as Record<string, unknown>),
      producerId: hex(j.producerId as string),   // bytes; subBlockId is hex
      protocolVersion: j.protocolVersion as number,
    };
  },
  write(w: ByteWriter, sb: SubBlock): void {
    w.writeBytes(encodeSubBlock(sb));
  },
  read(r: ByteReader): SubBlock {
    // `postBytes` is read inline — no length prefix, because every post field
    // is fixed-width, length-prefixed or a VLQ, so the post is self-delimiting.
    return {
      subBlockId: readHexN(r, 32),
      post: readWirePost(r),
      producerId: readBytesN(r, 32),
      protocolVersion: readVlqU(r),
    };
  },
};

const orderingBlockCodec: ValueCodec<OrderingBlock> = {
  parse(json: unknown): OrderingBlock {
    const j = json as Record<string, unknown>;
    return {
      header: blockHeaderCodec.parse(j.header),
      subBlockTree: subBlockTreeCodec.parse(j.subBlockTree),
      utxoTxTree: utxoTxTreeCodec.parse(j.utxoTxTree),
      validatorSignature: hex(j.validatorSignature as string),
    };
  },
  write(w: ByteWriter, b: OrderingBlock): void {
    w.writeBytes(encodeOrderingBlock(b));
  },
  read(r: ByteReader): OrderingBlock {
    // Each `lp` section is decoded through its own reader over a bounded slice,
    // mirroring production's nested boundary check: a section that overruns its
    // parent or leaves slack inside it is caught at the section, not at the
    // frame.
    const section = <T>(f: (rr: ByteReader) => T): T => {
      const bytes = readLp(r);
      const inner = new ByteReader(bytes);
      const value = f(inner);
      if (!inner.isExhausted) throw new Error('orderingBlock: slack inside an lp section');
      return value;
    };
    return {
      header: section((rr) => blockHeaderCodec.read(rr)),
      subBlockTree: section((rr) => subBlockTreeCodec.read(rr)),
      utxoTxTree: section((rr) => utxoTxTreeCodec.read(rr)),
      validatorSignature: readBytesN(r, 64),
    };
  },
};

registerStruct('postFields', postFieldsCodec);
registerStruct('powNonceTail', powNonceTailCodec);
registerStruct('powPreimage', powPreimageCodec);
registerStruct('boxContent', boxContentCodec);
registerStruct('pruneEntry', pruneEntryCodec);
registerStruct('blockHeader', blockHeaderCodec);
registerStruct('subBlockEntry', subBlockEntryCodec);
registerStruct('coinbaseOutput', coinbaseOutputCodec);
registerStruct('subBlockTree', subBlockTreeCodec);
registerStruct('utxoTxTree', utxoTxTreeCodec);
registerStruct('subBlock', subBlockCodec);
registerStruct('orderingBlock', orderingBlockCodec);
