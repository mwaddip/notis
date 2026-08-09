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
  readLpUtf8,
  readOpt,
  readVlqS,
  readVlqU,
  readVlqU64,
} from '../../src/codec.js';
import { postPowPreimage, type Post } from '../../src/post.js';
import { serializePruneEntry, TRIGGER, type PruneEntry } from '../../src/stump.js';
import { canonicalBoxBytes, type BoxCandidate } from '../../src/utxo.js';
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

registerStruct('postFields', postFieldsCodec);
registerStruct('boxContent', boxContentCodec);
registerStruct('pruneEntry', pruneEntryCodec);
