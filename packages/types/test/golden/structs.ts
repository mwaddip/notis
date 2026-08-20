/**
 * The id-preimage struct codecs, as golden-vector codecs.
 *
 * These differ from `probe.ts` in one deliberate way, and it is the point of
 * the file: **the write half is the production function.** `probe` is a
 * synthetic struct whose two halves are both test-side, so it regression-tests
 * the harness; these encode through `postFieldBytes`, `canonicalBoxBytes` and
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

import { ByteReader, ByteWriter, ReaderError } from '@dagsocial/wire';
import { MAX_GENESIS_PROOF_PAYLOAD_BYTES } from '../../src/constants.js';
import {
  readArr,
  readBool,
  readBytesN,
  readHexN,
  readLp,
  readLpUtf8,
  readOpt,
  readVlqU,
  readVlqU64,
} from '../../src/codec.js';
import { postFieldBytes, POST_TYPE, type Post } from '../../src/post.js';
import { serializePruneEntry, type PruneEntry } from '../../src/stump.js';
import { canonicalBoxBytes, type BoxCandidate } from '../../src/utxo.js';
import {
  encodeHeader,
  encodeUtxoTxTree,
  encodeOrderingBlock,
} from '../../src/serialization.js';
import type {
  BlockHeader,
  OrderingBlock,
  UtxoTxTree,
} from '../../src/block.js';
import { hex, registerStruct, type ValueCodec } from './harness.js';

// ---------------------------------------------------------------------------
// postFields — what `postFieldBytes` covers
// ---------------------------------------------------------------------------

/**
 * The five fields the post preimage encodes — every field a `Post` has.
 *
 * `PostFields` is now exactly `Post`, and the alias is kept rather than collapsed
 * because the corpus's subject is the **preimage**, not the struct: if a field is
 * ever added to `Post` that the encoder skips, this is where that divergence has
 * to be spelled out, and a vector silently claiming coverage of it is the failure
 * the separate name exists to prevent.
 */
export type PostFields = Post;

const postFieldsCodec: ValueCodec<PostFields> = {
  parse(json: unknown): PostFields {
    const j = json as Record<string, unknown>;
    return {
      content: j.content as string,
      author: hex(j.author as string),
      parentRefs: j.parentRefs as string[],
      protocolVersion: j.protocolVersion as number,
      type: j.type as 'regular' | 'profile',
    };
  },

  // Production writer.
  write(w: ByteWriter, p: PostFields): void {
    w.writeBytes(postFieldBytes(p));
  },

  // Independent reader — TYPES_INTERFACE → Layout — Post, in order.
  read(r: ByteReader): PostFields {
    return {
      content: readLpUtf8(r),
      author: readBytesN(r, 32),
      parentRefs: readArr(r, (rr) => readHexN(rr, 32)),
      protocolVersion: readVlqU(r),
      type: POST_TYPE.read(r),
    };
  },
};

// ---------------------------------------------------------------------------
// boxContent — what `canonicalBoxBytes` covers
// ---------------------------------------------------------------------------

/**
 * A box as its identity preimage sees it.
 *
 * `boxType`, `value` and `createdAtBlock` are the shared prefix and are repeated
 * on every member, so each row reads against the layout table whole rather than
 * against a base type the arms would have to be merged with.
 *
 * Provenance (`id`/`txId`/`index`) is absent, and that is structural rather than
 * an omission: it is not in the consensus bytes (TYPES_INTERFACE → Layout —
 * Boxes), so a corpus entry has no way to carry it and the decode direction
 * could not reconstruct it if it did.
 */
export type BoxContent =
  | { boxType: 'karma'; value: bigint; createdAtBlock: number; owner: Uint8Array; nonActivity: boolean | null }
  | { boxType: 'credit'; value: bigint; createdAtBlock: number; owner: Uint8Array; lockedUntilBlock: number | null }
  /** `payload` is `lp` — opaque bytes, not `lpUtf8`. `value` is always 0. */
  | { boxType: 'genesis_proof'; value: bigint; createdAtBlock: number; payload: Uint8Array }
  /** The same trailing fields as `vouch`; the tag is what separates the two. */
  | { boxType: 'bond'; value: bigint; createdAtBlock: number; inviterId: Uint8Array; inviteePublicKey: Uint8Array }
  | { boxType: 'post_lock'; value: bigint; createdAtBlock: number; originalValue: bigint; owner: Uint8Array }
  | { boxType: 'vouch'; value: bigint; createdAtBlock: number; voucherId: Uint8Array; targetId: Uint8Array }
  /** A `b32` beside a bare `vlqU` — the only arm that mixes the two. */
  | { boxType: 'vouch_escrow'; value: bigint; createdAtBlock: number; owner: Uint8Array; releaseAtBlock: number }
  /** One `b32` and nothing after it — the only arm whose tail is a single field. */
  | { boxType: 'like_accrual'; value: bigint; createdAtBlock: number; author: Uint8Array }
  /**
   * No trailing fields on any of the four — the content encoding is the shared
   * prefix alone. Each member carries `boxType` and `value` and nothing else,
   * which is what a reader assuming at least one field after the prefix gets
   * wrong.
   */
  | { boxType: 'emission'; value: bigint; createdAtBlock: number }
  | { boxType: 'treasury'; value: bigint; createdAtBlock: number }
  | { boxType: 'fee'; value: bigint; createdAtBlock: number }
  | { boxType: 'karma_pool'; value: bigint; createdAtBlock: number };

// TYPES_INTERFACE → Layout — Boxes, "independent in its numbers, not in its
// coverage": the corpus's BoxContent['boxType'] and production's
// BoxCandidate['boxType'] must be the same union in both directions.
type _AssertBoxTypesMatch =
  BoxContent['boxType'] extends BoxCandidate['boxType']
    ? BoxCandidate['boxType'] extends BoxContent['boxType']
      ? true
      : never
    : never;
const _boxTypeCheck: _AssertBoxTypesMatch = true;

/**
 * The type→tag table, restated from the contract so a renumber fails here too
 * (TYPES_INTERFACE → What a new box type costs). `satisfies` gates coverage: a
 * box type added to the union without a row here is a compile error.
 *
 * **Tag 2 has no type** — it held `invite`, the number is reserved rather than
 * reassigned. The derived reverse lookup preserves the hole: a tag inside the
 * range with no type has no decoding, which is checkable from the independent
 * side.
 */
export const BOX_TAG_BY_TYPE = {
  karma: 0,
  credit: 1,
  genesis_proof: 3,
  bond: 4,
  post_lock: 5,
  vouch: 6,
  emission: 7,
  treasury: 8,
  fee: 9,
  karma_pool: 10,
  like_accrual: 11,
  vouch_escrow: 12,
} as const satisfies Record<BoxContent['boxType'], number>;

/** Reverse lookup derived from `BOX_TAG_BY_TYPE` — `read()` uses this. */
const BOX_TYPE_BY_TAG: ReadonlyMap<number, BoxContent['boxType']> = new Map(
  (Object.entries(BOX_TAG_BY_TYPE) as [BoxContent['boxType'], number][]).map(
    ([type, tag]) => [tag, type],
  ),
);

const boxContentCodec: ValueCodec<BoxContent> = {
  parse(json: unknown): BoxContent {
    const j = json as Record<string, unknown>;
    const value = BigInt(j.value as string);
    // Prefix, so it is parsed once for every arm — a JSON number like the other
    // `number` fields in this corpus, never a decimal string (that form is the
    // u64 values only).
    const createdAtBlock = j.createdAtBlock as number;
    switch (j.boxType as BoxContent['boxType']) {
      case 'karma':
        return {
          boxType: 'karma',
          value,
          createdAtBlock,
          owner: hex(j.owner as string),
          nonActivity: (j.nonActivity ?? null) as boolean | null,
        };
      case 'credit':
        return {
          boxType: 'credit',
          value,
          createdAtBlock,
          owner: hex(j.owner as string),
          lockedUntilBlock: (j.lockedUntilBlock ?? null) as number | null,
        };
      case 'genesis_proof':
        return { boxType: 'genesis_proof', value, createdAtBlock, payload: hex(j.payload as string) };
      case 'bond':
        return {
          boxType: 'bond',
          value,
          createdAtBlock,
          inviterId: hex(j.inviterId as string),
          inviteePublicKey: hex(j.inviteePublicKey as string),
        };
      case 'post_lock':
        return {
          boxType: 'post_lock',
          value,
          createdAtBlock,
          originalValue: BigInt(j.originalValue as string),
          owner: hex(j.owner as string),
        };
      case 'vouch':
        return {
          boxType: 'vouch',
          value,
          createdAtBlock,
          voucherId: hex(j.voucherId as string),
          targetId: hex(j.targetId as string),
        };
      case 'vouch_escrow':
        return {
          boxType: 'vouch_escrow',
          value,
          createdAtBlock,
          owner: hex(j.owner as string),
          releaseAtBlock: j.releaseAtBlock as number,
        };
      case 'like_accrual':
        return { boxType: 'like_accrual', value, createdAtBlock, author: hex(j.author as string) };
      case 'emission':
        return { boxType: 'emission', value, createdAtBlock };
      case 'treasury':
        return { boxType: 'treasury', value, createdAtBlock };
      case 'fee':
        return { boxType: 'fee', value, createdAtBlock };
      case 'karma_pool':
        return { boxType: 'karma_pool', value, createdAtBlock };
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
    const boxType = BOX_TYPE_BY_TAG.get(tag);
    if (boxType === undefined) throw new Error(`boxContent: unknown boxType tag ${tag}`);
    const value = readVlqU64(r);
    // The prefix's third field, read off the layout table's own row —
    // `enum8(boxType) ‖ vlqU64(value) ‖ vlqU(createdAtBlock)`. `vlqU` because the
    // field is a `number`; reading it as the bigint writer's field would decode
    // the same bytes and re-encode identically, so the row is written from the
    // field's type rather than from any byte string.
    const createdAtBlock = readVlqU(r);
    switch (boxType) {
      case 'karma':
        return {
          boxType,
          value,
          createdAtBlock,
          owner: readBytesN(r, 32),
          nonActivity: readOpt(r, readBool),
        };
      case 'credit':
        return {
          boxType,
          value,
          createdAtBlock,
          owner: readBytesN(r, 32),
          lockedUntilBlock: readOpt(r, readVlqU),
        };
      case 'genesis_proof': {
        const payload = readLp(r);
        // The payload bound, read off the layout table like every other row in
        // this reader. It belongs to this arm and not to `readLp`, so a reader
        // that took the bound from the primitive would refuse fields production
        // accepts — which is the kind of disagreement the two implementations
        // exist to surface. The constant is imported rather than restated: one
        // definition, two readers.
        if (payload.length > MAX_GENESIS_PROOF_PAYLOAD_BYTES) {
          throw new ReaderError(
            `boxContent: genesis_proof payload is ${payload.length} bytes, over ` +
              `MAX_GENESIS_PROOF_PAYLOAD_BYTES (${MAX_GENESIS_PROOF_PAYLOAD_BYTES})`,
            'invalid-tag',
          );
        }
        return { boxType, value, createdAtBlock, payload };
      }
      case 'bond':
        // Byte-for-byte the `vouch` arm below, and reached only by the tag —
        // which is the property the two vectors in `boxes.json` exist to hold.
        return {
          boxType, value, createdAtBlock,
          inviterId: readBytesN(r, 32), inviteePublicKey: readBytesN(r, 32),
        };
      case 'post_lock':
        return {
          boxType,
          value,
          createdAtBlock,
          originalValue: readVlqU64(r),
          owner: readBytesN(r, 32),
        };
      case 'vouch':
        return {
          boxType, value, createdAtBlock,
          voucherId: readBytesN(r, 32), targetId: readBytesN(r, 32),
        };
      case 'vouch_escrow':
        // `vlqU` after the key, not `vlqU64`: the height is a `number`. Reading
        // it as the bigint writer's field would decode the same bytes and
        // re-encode identically, so the two are told apart by their domains
        // rather than by a vector — which is why the row is written here from the
        // field's type and not from the byte string.
        return {
          boxType, value, createdAtBlock,
          owner: readBytesN(r, 32), releaseAtBlock: readVlqU(r),
        };
      case 'like_accrual':
        return { boxType, value, createdAtBlock, author: readBytesN(r, 32) };
      case 'emission':
      case 'treasury':
      case 'fee':
      case 'karma_pool':
        // The box is complete at the prefix. An independent reader is where a
        // phantom trailing field would show up as a decode failure rather than
        // as agreement between a writer and a reader that share the mistake.
        return { boxType, value, createdAtBlock };
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
    };
  },
};

// ---------------------------------------------------------------------------
// The block structs — TYPES_INTERFACE → Layout — Block
// ---------------------------------------------------------------------------
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
      utxoTxRoot: j.utxoTxRoot as string,
      stateRoot: j.stateRoot as string,
      // Bytes, where its two `b32` table-neighbours are hex. The JSON spells
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
      utxoTxRoot: readHexN(r, 32),
      stateRoot: readHexN(r, 33),   // b33 — the AVL+ digest carries a height byte
      validatorId: readBytesN(r, 32),
      powNonce: readVlqU(r),
      powTargetBits: readVlqU(r),
      createdAt: readVlqU(r),
    };
  },
};

/** Independent readers for the nested structs, from the layout lines. */
function readPrune(r: ByteReader): PruneEntry {
  return {
    rootPostHash: readHexN(r, 32),
    subtreePostIds: readArr(r, (rr) => readHexN(rr, 32)),
    subtreeMerkleRoot: readBytesN(r, 32),
    authorId: readBytesN(r, 32),
    authorSignature: readBytesN(r, 64),
  };
}

function parsePrune(j: Record<string, unknown>): PruneEntry {
  return {
    rootPostHash: j.rootPostHash as string,
    subtreePostIds: j.subtreePostIds as string[],
    subtreeMerkleRoot: hex(j.subtreeMerkleRoot as string),
    authorId: hex(j.authorId as string),
    authorSignature: hex(j.authorSignature as string),
  };
}

// ---------------------------------------------------------------------------
// The element preimage — TYPES_INTERFACE → Layout — Merkle leaf preimages
// ---------------------------------------------------------------------------
//
// `serializePruneEntry` is the one element preimage left under `utxoTxRoot` —
// `leafHash('prune', …)` — and it has its own vector above, in `prune.json`,
// where node hashes it directly and a conformance reader can check one leaf
// without building a tree around it.
//
// The leaf domains `'subblock'` and `'coinbase'` are tracked reservations
// (TYPES_INTERFACE → Tracked reservations).

const utxoTxTreeCodec: ValueCodec<UtxoTxTree> = {
  parse(json: unknown): UtxoTxTree {
    const j = json as Record<string, unknown>;
    return {
      utxoTxIds: j.utxoTxIds as string[],
      utxoTxs: (j.utxoTxs as string[]).map(hex),
      pruneEntries: (j.pruneEntries as Record<string, unknown>[]).map(parsePrune),
    };
  },
  write(w: ByteWriter, t: UtxoTxTree): void {
    w.writeBytes(encodeUtxoTxTree(t));
  },
  read(r: ByteReader): UtxoTxTree {
    return {
      utxoTxIds: readArr(r, (rr) => readHexN(rr, 32)),
      utxoTxs: readArr(r, readLp),   // opaque: transactions are length-prefixed bytes
      pruneEntries: readArr(r, readPrune),
    };
  },
};

// `encodePost` is now exactly `postFieldBytes`, so the `postFields` vectors pin
// the wire post too.

const orderingBlockCodec: ValueCodec<OrderingBlock> = {
  parse(json: unknown): OrderingBlock {
    const j = json as Record<string, unknown>;
    return {
      header: blockHeaderCodec.parse(j.header),
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
      utxoTxTree: section((rr) => utxoTxTreeCodec.read(rr)),
      validatorSignature: readBytesN(r, 64),
    };
  },
};

registerStruct('postFields', postFieldsCodec);
registerStruct('boxContent', boxContentCodec);
registerStruct('pruneEntry', pruneEntryCodec);
registerStruct('blockHeader', blockHeaderCodec);
registerStruct('utxoTxTree', utxoTxTreeCodec);
registerStruct('orderingBlock', orderingBlockCodec);
