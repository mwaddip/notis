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
 *     open key set, an uncommitted body field, and a non-minimal VLQ.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { ReaderError } from '@dagsocial/wire';
import { CodecError } from '../src/codec.js';
import {
  encodePostCommit,
  decodePostCommit,
  encodePostBody,
  decodePostBody,
  encodeTxPacket,
  decodeTxPacket,
  encodeHeader,
  decodeHeader,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from '../src/serialization.js';
import { postFieldBytes, computeContentHash, type PostCommit } from '../src/post.js';
import { computeTxId } from '../src/utxo.js';
import type {
  BlockHeader,
  UtxoTxTree,
  OrderingBlock,
} from '../src/block.js';
import type { CandidateOf, KarmaBox, UtxoTransaction } from '../src/utxo.js';

// A UserId is 32 raw bytes — an Ed25519 public key. These fixtures carried
// display strings ('user123', 'validator1'), which no identity can ever be;
// the test tree was unchecked, so they typechecked as nothing.
const userA = new Uint8Array(32).fill(0x11);
const userB = new Uint8Array(32).fill(0x22);
const validatorKey = new Uint8Array(32).fill(0x33);
const sig64 = new Uint8Array(64).fill(0xcd);

function makePostCommit(): PostCommit {
  return {
    contentHash: computeContentHash('Hello, DAGsocial!'),
    parentRefs: ['1a'.repeat(32), '2b'.repeat(32)],
    author: userA,
    protocolVersion: 2,
    type: 'regular' as const,
  };
}

function makeBlockHeader(): BlockHeader {
  return {
    protocolVersion: 2,
    height: 1,
    prevBlockHash: '0'.repeat(64),
    utxoTxRoot: '0'.repeat(64),
    stateRoot: '00'.repeat(33),
    validatorId: validatorKey,
    powNonce: 0,
    powTargetBits: 3072,
    createdAt: 1700000000000,
  };
}

/**
 * ⛔ **TWO SECTIONS.** Prunes ride the transaction rail, so the tree is
 * `utxoTxIds` and `utxoTxs` only.
 */
function makeUtxoTxTree(): UtxoTxTree {
  return {
    utxoTxIds: ['f'.repeat(64)],
    // `new Uint8Array(...)` around a codec output: `readLp` returns a plain
    // `Uint8Array` and `toEqual` distinguishes a subclass, so a round-trip that
    // failed on the wrapper rather than on the bytes would be reporting the
    // wrong thing.
    utxoTxs: [new Uint8Array(encodeTx(makeTx()))],
  };
}

function makeOrderingBlock(): OrderingBlock {
  return {
    header: makeBlockHeader(),
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
    // Prefix field, declared by whoever builds the box (TYPES_INTERFACE →
    // Layout — Boxes). It rides the transaction, so `computeTxId` covers it.
    createdAtBlock: 300,
    owner: new Uint8Array(32).fill(0xaa),
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
    it('PostCommit', () => {
      expect(decodePostCommit(encodePostCommit(makePostCommit()))).toEqual(makePostCommit());
    });

    it('BlockHeader', () => {
      expect(decodeHeader(encodeHeader(makeBlockHeader()))).toEqual(makeBlockHeader());
    });

    it('UtxoTxTree — two sections, no prune entries', () => {
      expect(decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()))).toEqual(makeUtxoTxTree());
    });

    it('OrderingBlock', () => {
      expect(decodeOrderingBlock(encodeOrderingBlock(makeOrderingBlock()))).toEqual(makeOrderingBlock());
    });

    it('UtxoTransaction — positional; the tree carries it as opaque lp bytes', () => {
      expect(decodeTx(encodeTx(makeTx()))).toEqual(makeTx());
    });

    it('UtxoTransaction — every optional field present at once', () => {
      // `likeTarget` and `post` are mutually exclusive in practice and the
      // encoding does not rest on it, so the round-trip that matters is the one
      // where both tags are set and the signature map carries more than one
      // entry: two options and a map in one tail, which is where a reader that
      // dropped a presence tag would run the next field's bytes into the wrong
      // slot. `post` is last and self-delimiting, so it is the one whose bytes a
      // missing tag before it would swallow whole.
      const full: UtxoTransaction = {
        inputs: ['1a'.repeat(32), '2b'.repeat(32)],
        outputs: [makeKarmaBox()],
        signatures: { ['3c'.repeat(32)]: sig64, ['4d'.repeat(32)]: new Uint8Array(64).fill(0xef) },
        protocolVersion: 1,
        likeTarget: 'ab'.repeat(32),
        post: makePostCommit(),
      };
      expect(decodeTx(encodeTx(full))).toEqual(full);
    });
  });

  // -------------------------------------------------------------------------
  // The transaction codec — positional, and it moves no committed hash
  // -------------------------------------------------------------------------

  /**
   * ⛔ **`encodeTx` IS the `TxId` preimage plus the signature array**, and that is
   * what makes "the codec change moves no committed hash" true by construction
   * rather than by a frozen hash happening not to move (TYPES_INTERFACE → Layout —
   * UtxoTransaction, the wire-codec row). `computeTxId` walks the same
   * `writeTxIdFields`, and `computeUtxoTxRoot`'s leaves are ids rather than
   * encodings, so box ids, transaction ids, `utxoTxRoot` and `stateRoot` are
   * byte-identical across it.
   *
   * The frozen ids in `utxo.test.ts` are the other half of that claim: they were
   * pinned before this codec existed and they are unchanged after it. **Both
   * halves are needed** — the pins alone would still hold if the two layouts had
   * drifted apart in some way no fixture reaches, and the structural equality
   * alone would hold if both had moved together.
   */
  describe('the transaction codec is the id preimage plus signatures', () => {
    const PUBKEY_A = '3c'.repeat(32);

    it('the head is the id preimage, byte for byte, and the tail is the signatures', () => {
      const bare: UtxoTransaction = { ...makeTx(), signatures: {} };
      const signed: UtxoTransaction = { ...makeTx(), signatures: { [PUBKEY_A]: sig64 } };
      const bareBytes = encodeTx(bare);
      const signedBytes = encodeTx(signed);
      // An empty signature array is one byte, so everything before it is the
      // preimage — and it must be identical under both.
      const headLength = bareBytes.length - 1;
      expect(hex(bareBytes.subarray(headLength))).toBe('00');
      expect(hex(signedBytes.subarray(0, headLength))).toBe(hex(bareBytes.subarray(0, headLength)));
      // …and the tail is exactly `arr(sigs, b32(pubkey) ‖ b64(sig))`.
      expect(hex(signedBytes.subarray(headLength))).toBe('01' + PUBKEY_A + hex(sig64));
    });

    it('signatures are outside the id, so signing cannot move the id', () => {
      // They are Ed25519 OVER the id: hashing them would make the id depend on
      // signatures over itself. This is the property the split exists for.
      const bare: UtxoTransaction = { ...makeTx(), signatures: {} };
      const signed: UtxoTransaction = { ...makeTx(), signatures: { [PUBKEY_A]: sig64 } };
      const other: UtxoTransaction = { ...makeTx(), signatures: { [PUBKEY_A]: new Uint8Array(64).fill(1) } };
      expect(computeTxId(signed)).toBe(computeTxId(bare));
      expect(computeTxId(other)).toBe(computeTxId(bare));
      // …and the WIRE bytes do differ, so the codec is not simply ignoring them.
      expect(hex(encodeTx(signed))).not.toBe(hex(encodeTx(other)));
    });

    it('the id survives the round-trip, which is what a relay cannot alter', () => {
      const signed: UtxoTransaction = {
        ...makeTx(),
        signatures: { [PUBKEY_A]: sig64 },
        likeTarget: 'ab'.repeat(32),
      };
      expect(computeTxId(decodeTx(encodeTx(signed)))).toBe(computeTxId(signed));
    });

    it('no field name reaches the bytes, and the whole transaction is 45 bytes', () => {
      // Hand-derived from the layout: arr(inputs)=1, arr(outputs)=1+37 for the
      // karma candidate, vlqU(protocolVersion)=1, opt(likeTarget)=1,
      // opt(post)=1, opt(prune)=1, opt(postWithdraw)=1, arr(signatures)=1.
      //
      // 37, not 35: the shared prefix is three fields, and this candidate's
      // `createdAtBlock` of 300 takes two VLQ groups.
      //
      // ⚠ **Every `opt` costs its tag byte whether or not the field is there**, so
      // an eighth field would show up here as 46 even on a transaction that
      // carries none of it — which is why an optional field is inside every id,
      // not only the ids that use it.
      const bytes = encodeTx(makeTx());
      expect(bytes.length).toBe(45);
      for (const name of ['inputs', 'outputs', 'signatures', 'protocolVersion', 'boxType', 'karma']) {
        expect(hex(bytes)).not.toContain(Buffer.from(name, 'utf8').toString('hex'));
      }
    });

    it('signatures encode as an array sorted by key, whatever order they were built in', () => {
      // A positional format has no maps, and without the normative sort one
      // transaction has two encodings — the malleability this format closes,
      // reopened for the one field a relay handles.
      const a = '11'.repeat(32), b = '22'.repeat(32);
      const sigA = new Uint8Array(64).fill(0xa1), sigB = new Uint8Array(64).fill(0xb2);
      const forward: UtxoTransaction = { ...makeTx(), signatures: { [a]: sigA, [b]: sigB } };
      const reverse: UtxoTransaction = { ...makeTx(), signatures: { [b]: sigB, [a]: sigA } };
      expect(hex(encodeTx(forward))).toBe(hex(encodeTx(reverse)));
      expect(hex(encodeTx(forward))).toContain(a + hex(sigA) + b + hex(sigB));
    });

    it('a mis-sorted signature array has no encoding — the compare says so', () => {
      // Not a rule in the codec: the re-encode compare is where every canonicity
      // rule in this format is enforced, and a swapped pair comes back
      // non-canonical rather than decoding into a differently-ordered map.
      const a = '11'.repeat(32), b = '22'.repeat(32);
      const sigA = new Uint8Array(64).fill(0xa1), sigB = new Uint8Array(64).fill(0xb2);
      const tx: UtxoTransaction = { ...makeTx(), signatures: { [a]: sigA, [b]: sigB } };
      const good = hex(encodeTx(tx));
      const swapped = good.replace(a + hex(sigA) + b + hex(sigB), b + hex(sigB) + a + hex(sigA));
      expect(swapped).not.toBe(good);
      expect(failureOf(() => decodeTx(Buffer.from(swapped, 'hex')))).toBe('non-canonical');
    });

    it('a duplicated signature key has no encoding either', () => {
      // Two entries collapse into one map key on decode and re-encode shorter, so
      // the compare rejects them. Nothing in the reader has to count keys.
      const a = '11'.repeat(32);
      const sigA = new Uint8Array(64).fill(0xa1);
      const tx: UtxoTransaction = { ...makeTx(), signatures: { [a]: sigA } };
      const good = hex(encodeTx(tx));
      const doubled = good.replace('01' + a + hex(sigA), '02' + a + hex(sigA) + a + hex(sigA));
      expect(failureOf(() => decodeTx(Buffer.from(doubled, 'hex')))).toBe('non-canonical');
    });

    it('carries the four-part boundary check like every other decoder', () => {
      const bytes = encodeTx(makeTx());
      // 2 — trailing bytes are a rejection, not slack.
      expect(failureOf(() => decodeTx(withTrailingByte(bytes)))).toBe('trailing-bytes');
      // 3 — `protocolVersion` padded: same value, longer encoding. Its offset is
      // **asserted rather than assumed** — arr(inputs)=1 and arr(outputs)=1+37 put
      // it at 39 — so a field inserted ahead of it fails here as a wrong-offset
      // error rather than by silently padding whatever now sits at 39.
      const PROTOCOL_VERSION_OFFSET = 39;
      expect(bytes[PROTOCOL_VERSION_OFFSET]).toBe(2);
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes.subarray(0, PROTOCOL_VERSION_OFFSET));
      padded.set([0x82, 0x00], PROTOCOL_VERSION_OFFSET);   // vlqU(2), ten-bit form
      padded.set(bytes.subarray(PROTOCOL_VERSION_OFFSET + 1), PROTOCOL_VERSION_OFFSET + 2);
      expect(failureOf(() => decodeTx(padded))).toBe('non-canonical');
      // 1 — truncation is wire's own rejection.
      const short = failureOf(() => decodeTx(bytes.subarray(0, bytes.length - 3)));
      expect(short).toBeInstanceOf(ReaderError);
      expect(short).not.toBeInstanceOf(CodecError);
      // …and garbage is a ReaderError rather than an accidental TypeError.
      expect(() => decodeTx(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(ReaderError);
    });

    it('a signature of the wrong width has no encoding at all', () => {
      // `b64` from bytes, so it throws rather than sentinelling: padding a
      // 63-byte signature to 64 would map it onto a well-formed one.
      for (const width of [0, 63, 65]) {
        const tx: UtxoTransaction = { ...makeTx(), signatures: { [PUBKEY_A]: new Uint8Array(width) } };
        expect(() => encodeTx(tx)).toThrow();
      }
      const badKey: UtxoTransaction = { ...makeTx(), signatures: { ['ZZ'.repeat(32)]: sig64 } };
      expect(() => encodeTx(badKey)).toThrow();
    });

    it('junk on a transaction is unrepresentable, as it is on every other struct', () => {
      const junk = { ...makeTx(), evil: true, moreEvil: 'x'.repeat(200) };
      expect(hex(encodeTx(junk as UtxoTransaction))).toBe(hex(encodeTx(makeTx())));
      expect(decodeTx(encodeTx(junk as UtxoTransaction))).toEqual(makeTx());
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

    it('header validatorId is b32 from BYTES while its two neighbours are b32 from HEX', () => {
      const h = makeBlockHeader();
      const bytes = encodeHeader(h);
      // 32 raw bytes of 0x33, not 64 characters of "33" — the hex writer would
      // have thrown on a Uint8Array, so this is the row, not a re-statement.
      expect(hex(bytes)).toContain('33'.repeat(32));
      expect(decodeHeader(bytes).validatorId).toBeInstanceOf(Uint8Array);
      expect(decodeHeader(bytes).validatorId).toHaveLength(32);
      // ...and the two hex rows decode back to strings, not bytes.
      expect(typeof decodeHeader(bytes).prevBlockHash).toBe('string');
      expect(decodeHeader(bytes).stateRoot).toHaveLength(66); // b33, not b32
    });

    it('header validatorId is BYTES where its sibling hashes are hex', () => {
      const back = decodeHeader(encodeHeader(makeBlockHeader()));
      expect(back.validatorId).toBeInstanceOf(Uint8Array);
      expect(typeof back.prevBlockHash).toBe('string');
    });

    // ⛔ **NO FIELD IN `UtxoTxTree` REACHES `writeVlqU64OrThrow` OR `writeBool`**,
    // so this section pins neither writer and a reader must not infer that the
    // body covers them. **Both are pinned one struct over**, in `utxo.test.ts`:
    // box `value` is the `vlqU64` row and `karma.nonActivity` the `writeBool` one.
    // A `bigint` or `boolean` field added to the body owes a row here.

  });

  // -------------------------------------------------------------------------
  // The block has ONE committed body
  // -------------------------------------------------------------------------

  describe('one body, and the sub-block sections are unrepresentable', () => {
    it('the tree encodes exactly two arrays, in field order', () => {
      const empty: UtxoTxTree = {
        utxoTxIds: [], utxoTxs: [],
      };
      const bytes = encodeUtxoTxTree(empty);
      expect(bytes.length).toBe(2);
      expect([...bytes]).toEqual([0, 0]);
    });

    it('a decoded tree carries the two sections and nothing else', () => {
      const decoded = decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()));
      expect(Object.keys(decoded))
        .toEqual(['utxoTxIds', 'utxoTxs']);
      const withJunk = { ...makeUtxoTxTree(), extraJunk: [{ owner: userB, value: 1n }] };
      expect(hex(encodeUtxoTxTree(withJunk as UtxoTxTree)))
        .toBe(hex(encodeUtxoTxTree(makeUtxoTxTree())));
    });

    it('a sub-block section is unrepresentable, not merely unwritten', () => {
      // The projection step, on the retired fields: an object carrying either of
      // them encodes to the same bytes as one without, so there is no byte
      // string a peer could send that would put a second body back into a
      // decoded block.
      const withSub = {
        ...makeOrderingBlock(),
        extraJunk: { entries: [{ postId: 'de'.repeat(32) }], pruneEntries: [] },
      };
      expect(hex(encodeOrderingBlock(withSub as OrderingBlock)))
        .toBe(hex(encodeOrderingBlock(makeOrderingBlock())));
      const withRoot = { ...makeBlockHeader(), extraJunk: 'de'.repeat(32) };
      expect(hex(encodeHeader(withRoot as BlockHeader)))
        .toBe(hex(encodeHeader(makeBlockHeader())));
    });
  });

  // -------------------------------------------------------------------------
  // The open key set is closed
  // -------------------------------------------------------------------------

  describe('unknown keys are unrepresentable (spec §1.1)', () => {
    it('header junk does not survive an encode/decode', () => {
      // A header with extra keys encodes to the same bytes as one without —
      // the positional layout carries no key names, so nothing outside the
      // declared fields reaches `computePowHash`'s preimage.
      const junk = { ...makeBlockHeader(), evil: true, moreEvil: 'x'.repeat(200) };
      expect(hex(encodeHeader(junk as BlockHeader))).toBe(hex(encodeHeader(makeBlockHeader())));
      expect(decodeHeader(encodeHeader(junk as BlockHeader))).toEqual(makeBlockHeader());
    });

    it('body-level junk likewise', () => {
      const tree = makeUtxoTxTree();
      const junked = { ...tree, evil: 1 } as UtxoTxTree;
      expect(hex(encodeUtxoTxTree(junked))).toBe(hex(encodeUtxoTxTree(tree)));
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
        ['utxoTxTree', encodeUtxoTxTree(makeUtxoTxTree())],
        ['post', encodePostCommit(makePostCommit())],
        ['orderingBlock', encodeOrderingBlock(makeOrderingBlock())],
      ] as [string, Uint8Array][]) {
        const decoder = {
          header: decodeHeader,
          utxoTxTree: decodeUtxoTxTree, post: decodePostCommit,
          orderingBlock: decodeOrderingBlock,
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
      for (const decoder of [decodePostCommit, decodeHeader,
                             decodeUtxoTxTree, decodeOrderingBlock]) {
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

    it('the three sections are header, utxoTxTree, signature', () => {
      // THREE, not four: a post is a transaction, so the block commits one body.
      const block = makeOrderingBlock();
      const bytes = encodeOrderingBlock(block);
      const sections = [
        encodeHeader(block.header),
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

  describe('movement pins — each format has exactly one encoding', () => {
    /**
     * Consensus pin for the post encoding format.
     *
     * Four recorded values of this fixture's id — three earlier layouts and
     * the current one. The test asserts the current (`POST_COMMIT_ID`) and that the
     * id matches none of the earlier three, so a silent revisit of any earlier
     * shape fails.
     */
    const PRE_T2B_ID = '586ff286a6309e50e07f429cff6bccb026ccf3d6e1b67b7036e654c8c2a487cc';
    const CBOR_ID = '9a1155ead5ddfb05d495a34df1f4be31482e2df4f9094925ba135b4679e0d114';
    const POSITIONAL_ID = '60ccc4811541897d5bfca53ccf1155ebe198efb16ee635fc9f181432ec90ba32';
    /** Five-field postCommit layout: b32(contentHash) in slot 1. */
    const POST_COMMIT_ID = '490d1ace6b3c46e4624aef5f811104ca393e59e6d51cd0daa521573364e499fb';

    const PINNED_COMMIT: PostCommit = {
      contentHash: computeContentHash('T2b consensus pin: sub-block shape'),
      author: new Uint8Array(32).fill(7),
      parentRefs: [],
      protocolVersion: 1,
      type: 'regular' as const,
    };

    it('Post: the five-field post layout pins to POST_COMMIT_ID', () => {
      // ⛔ Four recorded values of this fixture's id — three earlier layouts
      // and the current one. This pins the five-field post layout
      // (TYPES_INTERFACE → Layout — PostCommit).
      const bytes = encodePostCommit(PINNED_COMMIT);
      // The key name cannot appear: there are no key names.
      expect(hex(bytes)).not.toContain(Buffer.from('likeBoxes', 'utf8').toString('hex'));
      expect(hex(bytes)).not.toContain(Buffer.from('subBlockId', 'utf8').toString('hex'));
      const id = hash(bytes);
      expect(id).not.toBe(PRE_T2B_ID);
      expect(id).not.toBe(CBOR_ID);
      expect(id).not.toBe(POSITIONAL_ID);
      expect(id).toBe(POST_COMMIT_ID);
    });

    it('BlockHeader: nine fields, 140 positional bytes', () => {
      // ⛔ Nine fields, 140 positional bytes: five VLQ
      // integers (1+1+1+2+6) plus 32+32+33+32 raw bytes. A reader with the
      // right length and wrong offsets is still 140 bytes and hashes
      // differently, which is why the hash is pinned beside the length rather
      // than instead of it.
      const bytes = encodeHeader(makeBlockHeader());
      expect(bytes.length).toBe(140);
      expect(hash(bytes)).toBe('63e9132c42173752a8449618d5371b6aafafdb7cc8e1df4e243814a9fc837a07');
      expect(hex(bytes)).not.toContain(Buffer.from('prevBlockHash', 'utf8').toString('hex'));
    });

    it('OrderingBlock: the whole frame', () => {
      // ⚠ **Transport, not commitment — this pin moves for reasons the others
      // cannot.** The frame carries `utxoTxs` as `arr(utxoTxs, lp)`, opaque
      // length-prefixed `encodeTx` output, so a *field* added to or removed from a
      // box or a transaction moves this hash with no format change at all, and so
      // does a change to the body's section list.
      //
      // Nothing committed follows it. `utxoTxRoot` is a Merkle root over
      // `utxoTxIds` (node's `computeUtxoTxRoot`) and never reads `utxoTxs`;
      // the id itself is `computeTxId`, positional and routed through
      // `canonicalBoxBytes`.
      //
      // ⛔ **A MOVE HERE CARRIES NO VERDICT, AND NOTHING HERE SAYS WHICH KIND IT
      // WAS.** Several unrelated changes reach this one hash and it cannot tell
      // them apart. The pins that decide are elsewhere: the BlockHeader pin above
      // for the header, and the frozen ids in `utxo.test.ts` for consensus. **Read
      // this one only as "the frame changed" — never as evidence about what.**
      expect(hash(encodeOrderingBlock(makeOrderingBlock()))).toBe('042d2806e34dddeb0db5d1f2fea02b26c66cb49f146d824e5fe6a5681eeb3a24');
    });

    it('Post: the wire codec IS the payload preimage, with no tail at all', () => {
      // ⛔ The two-field tail had exactly two members — `powNonce` and
      // `signature` — and both died with post PoW. So `encodePostCommit` and
      // `postFieldBytes` are now the same bytes, and that is worth pinning
      // rather than assuming: the wire form and the preimage being one encoding
      // is what removes any chance of the two dialects drifting.
      const post = makePostCommit();
      const wire = encodePostCommit(post);
      const preimage = postFieldBytes(post);
      expect(hex(wire)).toBe(hex(preimage));
      expect(wire.length).toBe(preimage.length);
    });
  });

  // -------------------------------------------------------------------------
  // Post body — TYPES_INTERFACE → Layout — Post body
  // -------------------------------------------------------------------------

  describe('post body codec', () => {
    it('round-trips content as lpUtf8', () => {
      const content = 'Hello, DAGsocial!';
      expect(decodePostBody(encodePostBody(content))).toBe(content);
    });

    it('round-trips empty content', () => {
      expect(decodePostBody(encodePostBody(''))).toBe('');
    });

    it('round-trips multibyte content', () => {
      const content = 'héllo 日本 😀';
      expect(decodePostBody(encodePostBody(content))).toBe(content);
    });

    it('rejects trailing bytes', () => {
      const bytes = encodePostBody('hello');
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes);
      expect(() => decodePostBody(padded)).toThrow(CodecError);
    });
  });

  // -------------------------------------------------------------------------
  // Transaction packet — TYPES_INTERFACE → Layout — UtxoTransaction, packet
  // -------------------------------------------------------------------------

  describe('transaction packet codec', () => {
    it('post tx with a body round-trips', () => {
      const tx: UtxoTransaction = { ...makeTx(), post: makePostCommit() };
      const content = 'Hello, DAGsocial!';
      const packet = decodeTxPacket(encodeTxPacket(tx, content));
      expect(packet.tx).toEqual(tx);
      expect(packet.content).toBe(content);
    });

    it('body is absent from txIdBytes — one TxId across two bodies', () => {
      // The body is outside `txIdBytes`, so two packets with the same tx but
      // different bodies produce the same TxId.
      const tx: UtxoTransaction = { ...makeTx(), post: makePostCommit() };
      const pktA = encodeTxPacket(tx, 'body A');
      const pktB = encodeTxPacket(tx, 'body B');
      // Packets differ (different body).
      expect(hex(pktA)).not.toBe(hex(pktB));
      // TxId is the same (body is not in the preimage).
      const { tx: txA } = decodeTxPacket(pktA);
      const { tx: txB } = decodeTxPacket(pktB);
      expect(computeTxId(txA)).toBe(computeTxId(txB));
    });

    it('non-post tx packet is encodeTx(tx) followed by opt-absent (0x00)', () => {
      const tx = makeTx();
      const pktBytes = encodeTxPacket(tx);
      const txBytes = encodeTx(tx);
      // The packet is the tx bytes + one 0x00 byte (opt absent tag).
      expect(pktBytes.length).toBe(txBytes.length + 1);
      expect(hex(pktBytes)).toBe(hex(txBytes) + '00');
    });

    it('non-post tx packet round-trips with content undefined', () => {
      const tx = makeTx();
      const packet = decodeTxPacket(encodeTxPacket(tx));
      expect(packet.tx).toEqual(tx);
      expect(packet.content).toBeUndefined();
    });

    it('rejects trailing bytes', () => {
      const bytes = encodeTxPacket(makeTx());
      const padded = new Uint8Array(bytes.length + 1);
      padded.set(bytes);
      expect(() => decodeTxPacket(padded)).toThrow(CodecError);
    });

    it('⛔ the golden harness cannot carry txPacket composites — pinned here', () => {
      // The TX struct codec is private to `serialization.ts`, so the harness
      // in `structs.ts` cannot compose the packet. The vectors below are the
      // pinned equivalent.
      //
      // Non-post packet: encodeTx(makeTx) ‖ opt-absent.
      const nonPostTx = makeTx();
      const nonPostPkt = encodeTxPacket(nonPostTx);
      const nonPostTxBytes = encodeTx(nonPostTx);
      expect(nonPostPkt.length).toBe(nonPostTxBytes.length + 1);
      expect(nonPostPkt[nonPostPkt.length - 1]).toBe(0x00);

      // Post-bearing packet: encodeTx(tx) ‖ opt-present ‖ lpUtf8(content).
      const postTx: UtxoTransaction = { ...makeTx(), post: makePostCommit() };
      const content = 'Hello, DAGsocial!';
      const postPkt = encodeTxPacket(postTx, content);
      const postTxBytes = encodeTx(postTx);
      // The packet starts with the tx bytes and the body follows.
      expect(hex(postPkt).startsWith(hex(postTxBytes))).toBe(true);
      // The trailing opt is present (0x01) followed by lpUtf8(content).
      expect(postPkt[postTxBytes.length]).toBe(0x01);
      // Round-trip produces the same content.
      const decoded = decodeTxPacket(postPkt);
      expect(decoded.content).toBe(content);
    });
  });
});
