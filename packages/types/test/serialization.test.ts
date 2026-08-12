/**
 * The wire codecs — every block struct on the positional layout.
 *
 * Three kinds of test here, and the split is deliberate:
 *
 *  1. **Two-sided movement pins**, which fix "this encodes to exactly these
 *     bytes" in both directions. A round-trip test passes before and after a
 *     byte-format change and so proves nothing about the change; these are what
 *     make each movement *intentional* rather than merely observed.
 *  2. **Rejections.** The four-part boundary check is the reason this format
 *     exists, and it is only real if the rejections are pinned per failure
 *     kind. A `toThrow()` with no class and no reason passes for the wrong
 *     reason as readily as the right one.
 *  3. **Closure tests for the three defects an open map format allows** — an
 *     open key set, an uncommitted `subBlockRefs`, and a non-minimal VLQ.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { ReaderError } from '@dagsocial/wire';
import { subBlockFromPost } from '../src/block.js';
import { CodecError } from '../src/codec.js';
import {
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeSubBlock,
  decodeSubBlock,
  encodeHeader,
  decodeHeader,
  encodeSubBlockTree,
  decodeSubBlockTree,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from '../src/serialization.js';
import { postPowPreimage, powNonceBytes, type Post } from '../src/post.js';
import type { Stump } from '../src/stump.js';
import type {
  SubBlock,
  BlockHeader,
  SubBlockTree,
  UtxoTxTree,
  OrderingBlock,
} from '../src/block.js';
import type { CandidateOf, KarmaBox, UtxoTransaction } from '../src/utxo.js';

const challenge = new Uint8Array(32).fill(0xab);
// A UserId is 32 raw bytes — an Ed25519 public key. These fixtures carried
// display strings ('user123', 'validator1'), which no identity can ever be;
// the test tree was unchecked, so they typechecked as nothing.
const userA = new Uint8Array(32).fill(0x11);
const userB = new Uint8Array(32).fill(0x22);
const validatorKey = new Uint8Array(32).fill(0x33);
const sig64 = new Uint8Array(64).fill(0xcd);

function makePost(): Post {
  return {
    content: 'Hello, DAGsocial!',
    // Real 32-byte post ids, because `b32` gives an arbitrary string like
    // `'ref1'` no encoding at all. A hex-text encoding would take any string
    // faithfully and let a wrong fixture pass unnoticed.
    parentRefs: ['1a'.repeat(32), '2b'.repeat(32)],
    author: userA,
    challenge,
    powNonce: 12345,
    protocolVersion: 2,
    timestamp: 1700000000000,
    signature: sig64,
  };
}

function makeStump(): Stump {
  return {
    rootPostHash: 'a'.repeat(64),
    authorId: userB,
    replyCount: 7,
    upvoteCount: 12,
    trigger: 'author',
    protocolVersion: 2,
    compactedAtBlockHeight: 500,
  };
}

function makeSubBlock(): SubBlock {
  return {
    subBlockId: 'b'.repeat(64),
    post: makePost(),
    producerId: userA,
    protocolVersion: 2,
  };
}

function makeBlockHeader(): BlockHeader {
  return {
    protocolVersion: 2,
    height: 1,
    prevBlockHash: '0'.repeat(64),
    subBlockRoot: '0'.repeat(64),
    utxoTxRoot: '0'.repeat(64),
    stateRoot: '00'.repeat(33),
    validatorId: validatorKey,
    powNonce: 0,
    powTargetBits: 3072,
    createdAt: 1700000000000,
  };
}

function makeSubBlockTree(): SubBlockTree {
  return {
    subBlockEntries: [
      { postId: 'b'.repeat(64), parentRefs: [], author: 'c'.repeat(64) },
    ],
    pruneEntries: [],
  };
}

function makeUtxoTxTree(): UtxoTxTree {
  return {
    utxoTxIds: ['f'.repeat(64)],
    // `new Uint8Array(...)` around a codec output, and it is not noise: `encodeTx`
    // is still `cbor-x`, which returns a **Buffer**, while `readLp` returns a
    // plain `Uint8Array`. Both satisfy `Uint8Array[]` — Buffer is a subclass —
    // so nothing is wrong, but `toEqual` distinguishes them and a round-trip
    // that failed on the wrapper rather than the bytes would be reporting the
    // wrong thing. Node reads these back through `decodeTx`, which does
    // `Buffer.from`, so neither side cares.
    utxoTxs: [new Uint8Array(encodeTx(makeTx()))],
    coinbaseOutputs: [
      { owner: userB, value: 5_000_000_00000000n, lockedUntilBlock: 720, isTreasury: false },
      { owner: userA, value: 1n, lockedUntilBlock: 1, isTreasury: true },
    ],
  };
}

function makeOrderingBlock(): OrderingBlock {
  return {
    header: makeBlockHeader(),
    subBlockTree: makeSubBlockTree(),
    utxoTxTree: makeUtxoTxTree(),
    validatorSignature: sig64,
  };
}

// A CANDIDATE, not a box: `UtxoTransaction.outputs` is `AnyBoxCandidate[]`
// (TYPES_INTERFACE → BoxId). An output cannot carry provenance — its `txId` would be
// the id of the transaction being built, which is circular — so the fixture is
// typed as what it actually is rather than given invented `txId`/`index`.
function makeKarmaBox(): CandidateOf<KarmaBox> {
  return {
    boxType: 'karma',
    value: 100n,
    owner: new Uint8Array(32).fill(0xaa),
    guard: 'owner_signature',
    proofSource: 'genesis',
  };
}

function makeTx(): UtxoTransaction {
  return {
    inputs: [],
    outputs: [makeKarmaBox()],
    signatures: {},
    protocolVersion: 2,
  };
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const hash = (b: Uint8Array): string =>
  createHash('blake2b512').update(b).digest().subarray(0, 32).toString('hex');

/** Append one byte — the cheapest way to violate boundary-check step 2. */
function withTrailingByte(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

/** The `CodecError.failure` a decode produced, or the thrown value itself. */
function failureOf(fn: () => unknown): string | unknown {
  try {
    fn();
  } catch (err) {
    return err instanceof CodecError ? err.failure : err;
  }
  return 'DID NOT THROW';
}

describe('positional serialization', () => {
  // -------------------------------------------------------------------------
  // Round-trips — necessary, and explicitly not sufficient
  // -------------------------------------------------------------------------

  describe('round-trips', () => {
    it('Post', () => {
      expect(decodePost(encodePost(makePost()))).toEqual(makePost());
    });

    it('SubBlock — the embedded post is read inline, with no length prefix', () => {
      expect(decodeSubBlock(encodeSubBlock(makeSubBlock()))).toEqual(makeSubBlock());
    });

    it('BlockHeader', () => {
      expect(decodeHeader(encodeHeader(makeBlockHeader()))).toEqual(makeBlockHeader());
    });

    it('SubBlockTree', () => {
      expect(decodeSubBlockTree(encodeSubBlockTree(makeSubBlockTree()))).toEqual(makeSubBlockTree());
    });

    it('SubBlockTree with prune entries — the Merkle-leaf preimage, verbatim', () => {
      const tree: SubBlockTree = {
        subBlockEntries: [
          { postId: 'aa'.repeat(32), parentRefs: [], author: 'cc'.repeat(32) },
          { postId: 'bb'.repeat(32), parentRefs: ['aa'.repeat(32)], author: 'dd'.repeat(32) },
        ],
        pruneEntries: [{
          rootPostHash: 'ee'.repeat(32),
          subtreePostIds: ['aa'.repeat(32), 'bb'.repeat(32)],
          subtreeMerkleRoot: new Uint8Array(32).fill(0x44),
          authorId: userA,
          authorSignature: sig64,
          trigger: 'storage_prune',
        }],
      };
      expect(decodeSubBlockTree(encodeSubBlockTree(tree))).toEqual(tree);
    });

    it('UtxoTxTree — including both coinbase arms', () => {
      expect(decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()))).toEqual(makeUtxoTxTree());
    });

    it('OrderingBlock', () => {
      expect(decodeOrderingBlock(encodeOrderingBlock(makeOrderingBlock()))).toEqual(makeOrderingBlock());
    });

    it('Stump — still cbor-x, and nothing in this phase moved it', () => {
      expect(decodeStump(encodeStump(makeStump()))).toEqual(makeStump());
    });

    it('UtxoTransaction — still cbor-x; the tree carries it as opaque lp bytes', () => {
      expect(decodeTx(encodeTx(makeTx()))).toEqual(makeTx());
    });
  });

  // -------------------------------------------------------------------------
  // The writer-versus-schema-type rows — the three that disagree
  // -------------------------------------------------------------------------

  describe('writers match their fields, not their table neighbours', () => {
    // TYPES_INTERFACE → Layout — Boxes ends by requiring this phase to run
    // writer against schema type, field by field, because two rows of that
    // contract were wrong and both threw in production. These three are the
    // rows where the block layout's notation and the field's declared type point
    // at different writers, pinned as behaviour so a "corrected" writer fails
    // here rather than at a node.

    it('header validatorId is b32 from BYTES while its three neighbours are b32 from HEX', () => {
      const h = makeBlockHeader();
      const bytes = encodeHeader(h);
      // 32 raw bytes of 0x33, not 64 characters of "33" — the hex writer would
      // have thrown on a Uint8Array, so this is the row, not a re-statement.
      expect(hex(bytes)).toContain('33'.repeat(32));
      expect(decodeHeader(bytes).validatorId).toBeInstanceOf(Uint8Array);
      expect(decodeHeader(bytes).validatorId).toHaveLength(32);
      // ...and the three hex rows decode back to strings, not bytes.
      expect(typeof decodeHeader(bytes).prevBlockHash).toBe('string');
      expect(decodeHeader(bytes).stateRoot).toHaveLength(66); // b33, not b32
    });

    it('SubBlockEntry.author is HEX where the header validatorId is bytes', () => {
      // Both are "a 32-byte Ed25519 public key" written `b32` in the contract.
      // The in-memory spelling decides the writer, and they differ.
      const tree = decodeSubBlockTree(encodeSubBlockTree(makeSubBlockTree()));
      expect(typeof tree.subBlockEntries[0]!.author).toBe('string');
      expect(tree.subBlockEntries[0]!.author).toHaveLength(64);
    });

    it('coinbase value is the THROWING bigint writer, not the total number one', () => {
      // `vlqU` in the table, `writeVlqU64OrThrow` in the code, because the field
      // is `bigint`. The total `number` writer would have sentinelled every
      // coinbase output ever produced; here the ceiling throws instead.
      const tree = makeUtxoTxTree();
      expect(decodeUtxoTxTree(encodeUtxoTxTree(tree)).coinbaseOutputs[0]!.value)
        .toBe(5_000_000_00000000n);
      const overflow: UtxoTxTree = {
        ...tree,
        coinbaseOutputs: [{ ...tree.coinbaseOutputs[0]!, value: 2n ** 64n }],
      };
      expect(() => encodeUtxoTxTree(overflow)).toThrow();
    });

    it('coinbase isTreasury is writeBool, and 0xff has no decoding', () => {
      // `u8` in the table; the field is `boolean`, so the writer is the total
      // one whose `{0,1}` domain leaves `0xff` unreachable. `writeU8OrThrow`
      // would have thrown on every block.
      const tree = decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()));
      expect(tree.coinbaseOutputs[0]!.isTreasury).toBe(false);
      expect(tree.coinbaseOutputs[1]!.isTreasury).toBe(true);
      // The sentinel a malformed value takes is one-way: it cannot decode back.
      const bad = { ...makeUtxoTxTree() };
      bad.coinbaseOutputs = [{ ...bad.coinbaseOutputs[0]!, isTreasury: 'yes' as unknown as boolean }];
      const bytes = encodeUtxoTxTree(bad);
      expect(hex(bytes)).toContain('ff');
      expect(() => decodeUtxoTxTree(bytes)).toThrow(ReaderError);
    });
  });

  // -------------------------------------------------------------------------
  // subBlockRefs is gone
  // -------------------------------------------------------------------------

  describe('subBlockRefs is deleted (spec §1.2, §4.1)', () => {
    it('the tree encodes exactly two arrays, and neither is a ref list', () => {
      // A one-entry tree with no prune entries: count(1) ‖ entry ‖ count(0).
      // A third array would show up as an extra count byte, and the length
      // arithmetic below is what makes "there is no room for it" a measurement
      // rather than an inspection.
      const bytes = encodeSubBlockTree(makeSubBlockTree());
      const entry = 32 + 1 + 32;            // b32(postId) ‖ arr(0 refs) ‖ b32(author)
      expect(bytes.length).toBe(1 + entry + 1);
      expect(bytes[0]).toBe(1);             // one sub-block entry
      expect(bytes[bytes.length - 1]).toBe(0); // zero prune entries
    });

    it('a decoded tree has no subBlockRefs property at all', () => {
      const decoded = decodeSubBlockTree(encodeSubBlockTree(makeSubBlockTree()));
      expect(Object.keys(decoded)).toEqual(['subBlockEntries', 'pruneEntries']);
      expect('subBlockRefs' in decoded).toBe(false);
    });

    it('the field is unrepresentable, not merely unwritten', () => {
      // The projection step: an object carrying the old field encodes to the
      // same bytes as one without it, so there is no byte string a peer could
      // send that would put refs back into a decoded tree.
      const withRefs = { ...makeSubBlockTree(), subBlockRefs: ['de'.repeat(32)] };
      expect(hex(encodeSubBlockTree(withRefs as SubBlockTree)))
        .toBe(hex(encodeSubBlockTree(makeSubBlockTree())));
    });
  });

  // -------------------------------------------------------------------------
  // The open key set is closed
  // -------------------------------------------------------------------------

  describe('unknown keys are unrepresentable (spec §1.1)', () => {
    it('header junk does not survive an encode/decode', () => {
      // Measured on the pre-migration tree: header junk moved `blockHash` and
      // the block was still accepted, because `computePowHash` spreads the
      // header and cbor carried the extra keys into the preimage. Unbounded
      // header bloat, signed by the validator that added it.
      const junk = { ...makeBlockHeader(), evil: true, moreEvil: 'x'.repeat(200) };
      expect(hex(encodeHeader(junk as BlockHeader))).toBe(hex(encodeHeader(makeBlockHeader())));
      expect(decodeHeader(encodeHeader(junk as BlockHeader))).toEqual(makeBlockHeader());
    });

    it('body and entry-level junk likewise', () => {
      const tree = makeSubBlockTree();
      const junked: SubBlockTree = {
        ...tree,
        subBlockEntries: [{ ...tree.subBlockEntries[0]!, evil: 1 } as never],
      };
      expect(hex(encodeSubBlockTree(junked))).toBe(hex(encodeSubBlockTree(tree)));
    });

    it('two nodes cannot hold byte-different blobs for one block hash', () => {
      // The open-key-set defect stated as its consequence: `createOrderingBlock`
      // re-encodes from the parsed struct, so any junk a decoder retained would
      // be written to disk and re-propagated on serve. With junk
      // unrepresentable, re-encoding a decoded block is a fixed point.
      const bytes = encodeOrderingBlock(makeOrderingBlock());
      expect(hex(encodeOrderingBlock(decodeOrderingBlock(bytes)))).toBe(hex(bytes));
    });
  });

  // -------------------------------------------------------------------------
  // The boundary check, per failure kind
  // -------------------------------------------------------------------------

  describe('the four-part boundary check', () => {
    it('step 2 — trailing bytes are a rejection, not slack', () => {
      for (const [label, bytes] of [
        ['header', encodeHeader(makeBlockHeader())],
        ['subBlockTree', encodeSubBlockTree(makeSubBlockTree())],
        ['utxoTxTree', encodeUtxoTxTree(makeUtxoTxTree())],
        ['post', encodePost(makePost())],
        ['subBlock', encodeSubBlock(makeSubBlock())],
        ['orderingBlock', encodeOrderingBlock(makeOrderingBlock())],
      ] as [string, Uint8Array][]) {
        const decoder = {
          header: decodeHeader, subBlockTree: decodeSubBlockTree,
          utxoTxTree: decodeUtxoTxTree, post: decodePost,
          subBlock: decodeSubBlock, orderingBlock: decodeOrderingBlock,
        }[label]!;
        expect(failureOf(() => decoder(withTrailingByte(bytes))), label).toBe('trailing-bytes');
      }
    });

    it('step 3 — a non-minimal VLQ decodes to the same value and is still rejected', () => {
      // `0x81 0x00` and `0x01` both decode to 1, and wire accepts the
      // padded form deliberately. Canonicity is enforced by the compare and
      // nowhere else, which is why tightening the reader for symmetry would
      // break it. `protocolVersion` is the header's first field, so padding it
      // needs no offset arithmetic.
      const bytes = encodeHeader(makeBlockHeader());
      const padded = new Uint8Array(bytes.length + 1);
      padded.set([0x82, 0x00], 0);          // vlqU(2), ten-bit form
      padded.set(bytes.subarray(1), 2);
      expect(failureOf(() => decodeHeader(padded))).toBe('non-canonical');
    });

    it('step 1 — truncation is wire’s own rejection, not a boundary-check one', () => {
      const bytes = encodeHeader(makeBlockHeader());
      const err = failureOf(() => decodeHeader(bytes.subarray(0, bytes.length - 3)));
      expect(err).toBeInstanceOf(ReaderError);
      expect(err).not.toBeInstanceOf(CodecError);
    });

    it('garbage is rejected as a ReaderError, not as an accidental throw', () => {
      // The pre-migration version of this asserted a bare `toThrow()`, which
      // passes for any reason at all — including a `TypeError` from reading a
      // property of `undefined`. The class is the assertion.
      for (const decoder of [decodePost, decodeHeader, decodeSubBlock,
                             decodeSubBlockTree, decodeUtxoTxTree, decodeOrderingBlock]) {
        expect(() => decoder(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(ReaderError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Ordering-block framing — vlqU, and nested checks
  // -------------------------------------------------------------------------

  describe('ordering-block framing', () => {
    it('length prefixes are vlqU, not u32BE', () => {
      // The framing was three hand-rolled `DataView.setUint32` writes. Under
      // `vlqU` a section under 128 bytes costs one byte and a larger one costs
      // two, where u32BE cost four unconditionally — so the *first* byte of the
      // frame is the header's length, not the high byte of a 32-bit zero.
      const bytes = encodeOrderingBlock(makeOrderingBlock());
      const headerBytes = encodeHeader(makeBlockHeader());
      expect(headerBytes.length).toBeGreaterThan(127); // so the prefix is two bytes
      const expectedPrefix = [(headerBytes.length & 0x7f) | 0x80, headerBytes.length >> 7];
      expect([bytes[0], bytes[1]]).toEqual(expectedPrefix);
      // u32BE would have started `00 00 00 xx` — three leading zeros.
      expect(bytes[0]).not.toBe(0);
    });

    it('the four sections are header, subBlockTree, utxoTxTree, signature', () => {
      const block = makeOrderingBlock();
      const bytes = encodeOrderingBlock(block);
      const sections = [
        encodeHeader(block.header),
        encodeSubBlockTree(block.subBlockTree),
        encodeUtxoTxTree(block.utxoTxTree),
      ];
      let offset = 0;
      for (const section of sections) {
        // vlqU length prefix, then the section verbatim.
        const prefixLen = section.length < 128 ? 1 : 2;
        expect(hex(bytes.subarray(offset + prefixLen, offset + prefixLen + section.length)))
          .toBe(hex(section));
        offset += prefixLen + section.length;
      }
      expect(hex(bytes.subarray(offset))).toBe(hex(block.validatorSignature));
      expect(offset + 64).toBe(bytes.length);
    });

    it('the check runs inside each nested section, naming the section that failed', () => {
      // The requirement that distinguishes this from a flat frame: a malformed
      // header is diagnosed as the header's failure at the header's own offset,
      // not as an outer mismatch somewhere in a kilobyte of block.
      const block = makeOrderingBlock();
      const headerBytes = encodeHeader(block.header);
      const paddedHeader = new Uint8Array(headerBytes.length + 1);
      paddedHeader.set([0x82, 0x00], 0);
      paddedHeader.set(headerBytes.subarray(1), 2);

      // Re-frame the block around the non-canonical header section.
      const rest = encodeOrderingBlock(block).subarray(
        (headerBytes.length < 128 ? 1 : 2) + headerBytes.length,
      );
      const framed = new Uint8Array(2 + paddedHeader.length + rest.length);
      framed.set([(paddedHeader.length & 0x7f) | 0x80, paddedHeader.length >> 7], 0);
      framed.set(paddedHeader, 2);
      framed.set(rest, 2 + paddedHeader.length);

      let thrown: unknown;
      try { decodeOrderingBlock(framed); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(CodecError);
      expect((thrown as CodecError).failure).toBe('non-canonical');
      expect((thrown as CodecError).message).toContain('blockHeader');
    });

    it('three distinct rejections: truncated section, overrunning length, trailing bytes', () => {
      const bytes = encodeOrderingBlock(makeOrderingBlock());

      // (a) a truncated final section — the signature is 32 bytes short.
      expect(failureOf(() => decodeOrderingBlock(bytes.subarray(0, bytes.length - 32))))
        .toBeInstanceOf(ReaderError);

      // (b) a section whose declared length overruns its parent. The header
      // prefix is two bytes; raise it past what remains.
      const overrun = bytes.slice();
      overrun.set([0xff, 0x7f], 0);   // vlqU(16383) — far past the frame
      expect(failureOf(() => decodeOrderingBlock(overrun))).toBeInstanceOf(ReaderError);

      // (c) trailing bytes after the signature.
      expect(failureOf(() => decodeOrderingBlock(withTrailingByte(bytes)))).toBe('trailing-bytes');
    });
  });

  // -------------------------------------------------------------------------
  // Two-sided movement pins
  // -------------------------------------------------------------------------

  describe('movement pins — every byte moved, and to exactly here', () => {
    /**
     * The T2b pin, carried forward through its second format change.
     *
     * `PRE_T2B_ID` was the shape with a `likeBoxes: []` sidecar; `CBOR_ID` was
     * the shape after that field was deleted, on `cbor-x`. `POSITIONAL_ID` is
     * this phase. Keeping all three is what makes the sequence auditable: each
     * pair of adjacent values is one recorded, intentional consensus break, and
     * a future reader can see that no shape was ever silently revisited.
     */
    const PRE_T2B_ID = '586ff286a6309e50e07f429cff6bccb026ccf3d6e1b67b7036e654c8c2a487cc';
    const CBOR_ID = '9a1155ead5ddfb05d495a34df1f4be31482e2df4f9094925ba135b4679e0d114';
    const POSITIONAL_ID = '60ccc4811541897d5bfca53ccf1155ebe198efb16ee635fc9f181432ec90ba32';

    const PINNED_POST: Post = {
      content: 'T2b consensus pin: sub-block shape',
      author: new Uint8Array(32).fill(7),
      parentRefs: [],
      challenge: new Uint8Array(32).fill(9),
      powNonce: 424242,
      protocolVersion: 1,
      timestamp: 1754600000000,
      signature: new Uint8Array(64).fill(3),
    };

    it('SubBlock: cbor → positional, and the sidecar shape stays dead', () => {
      const sb = subBlockFromPost(PINNED_POST, 'ab'.repeat(32));
      expect(Object.keys(sb)).toEqual(['subBlockId', 'post', 'producerId', 'protocolVersion']);
      const bytes = encodeSubBlock(sb);
      // The key name cannot appear: there are no key names.
      expect(hex(bytes)).not.toContain(Buffer.from('likeBoxes', 'utf8').toString('hex'));
      expect(hex(bytes)).not.toContain(Buffer.from('subBlockId', 'utf8').toString('hex'));
      const id = hash(bytes);
      expect(id).not.toBe(PRE_T2B_ID);
      expect(id).not.toBe(CBOR_ID);
      expect(id).toBe(POSITIONAL_ID);
    });

    it('BlockHeader: the blockHash preimage moved, and shrank', () => {
      // 434 bytes of cbor-x — a `b9`-prefixed map header, ten key names, and
      // every id as its 64-character hex TEXT — against 172 positional:
      // five VLQ integers (1+1+1+2+6) plus 32+32+32+33+32 raw bytes.
      const bytes = encodeHeader(makeBlockHeader());
      expect(bytes.length).toBe(172);
      expect(hash(bytes)).toBe('7334d5610810d80804fe316876cdb9e5968b80301c6709b6c686d6cfc5b944ad');
      expect(hex(bytes)).not.toContain(Buffer.from('prevBlockHash', 'utf8').toString('hex'));
    });

    it('OrderingBlock: the whole frame moved', () => {
      expect(hash(encodeOrderingBlock(makeOrderingBlock()))).toBe('91e57d42cc34321a0fe6b080ca19300c58947aa056de4b0b650cf19082c0f8eb');
    });

    it('Post: the wire codec is the id preimage plus a two-field tail', () => {
      // `encodePost` = `postFieldBytes` ‖ vlqU(powNonce) ‖ b64(signature), so
      // the first bytes of the wire form ARE the preimage's. That relationship
      // is the reason the post codec moved with this phase at all.
      const post = makePost();
      const wire = encodePost(post);
      const preimage = postPowPreimage(post);
      expect(hex(wire.subarray(0, preimage.length))).toBe(hex(preimage));
      // ...and the tail is exactly the two excluded fields: vlqU(12345) is two
      // bytes, the signature is 64.
      expect(wire.length).toBe(preimage.length + 2 + 64);
      // The nonce row is asserted against `powNonceBytes`, not only against its
      // width. The codec writes that row itself rather than calling the export
      // (serialization.ts, the `vlqU(powNonce)` line), so this is the only
      // thing holding the wire form's nonce to the tail the id and the PoW hash
      // append — and a width check alone cannot tell two same-width dialects
      // apart.
      const tail = powNonceBytes(post.powNonce);
      expect(tail.length).toBe(2);
      expect(hex(wire.subarray(preimage.length, preimage.length + 2))).toBe(hex(tail));
    });
  });
});
