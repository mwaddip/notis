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
import { CodecError } from '../src/codec.js';
import {
  encodePost,
  decodePost,
  encodeStump,
  decodeStump,
  encodeHeader,
  decodeHeader,
  encodeUtxoTxTree,
  decodeUtxoTxTree,
  encodeOrderingBlock,
  decodeOrderingBlock,
  encodeTx,
  decodeTx,
} from '../src/serialization.js';
import { postFieldBytes, type Post } from '../src/post.js';
import { computeTxId } from '../src/utxo.js';
import type { PruneEntry, Stump } from '../src/stump.js';
import type {
  BlockHeader,
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
    protocolVersion: 2,
    timestamp: 1700000000000,
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
 * ⛔ **THREE SECTIONS, NOT FOUR.** `coinbaseOutputs` left the body: coinbase
 * outputs are outputs of the block's settlement transaction, so they arrive
 * inside `utxoTxs` like every other transaction's, and `utxoTxRoot` lost the
 * `'coinbase'` leaf class with the field (`block.ts` → `UtxoTxTree`).
 *
 * A prune entry stands where the coinbase outputs did: it is the one element
 * writer left whose width varies, so a populated body still exercises an element
 * layout rather than only count prefixes.
 */
function makeUtxoTxTree(): UtxoTxTree {
  return {
    utxoTxIds: ['f'.repeat(64)],
    // `new Uint8Array(...)` around a codec output: `readLp` returns a plain
    // `Uint8Array` and `toEqual` distinguishes a subclass, so a round-trip that
    // failed on the wrapper rather than on the bytes would be reporting the
    // wrong thing.
    utxoTxs: [new Uint8Array(encodeTx(makeTx()))],
    pruneEntries: [{
      rootPostHash: 'ee'.repeat(32),
      subtreePostIds: ['aa'.repeat(32), 'bb'.repeat(32)],
      subtreeMerkleRoot: new Uint8Array(32).fill(0x44),
      authorId: userA,
      authorSignature: sig64,
      trigger: 'storage_prune',
    }],
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
    it('Post', () => {
      expect(decodePost(encodePost(makePost()))).toEqual(makePost());
    });

    it('BlockHeader', () => {
      expect(decodeHeader(encodeHeader(makeBlockHeader()))).toEqual(makeBlockHeader());
    });

    it('UtxoTxTree with prune entries — the Merkle-leaf preimage, verbatim', () => {
      // ⛔ Prune entries moved INTO this tree — `utxoTxRoot` commits them now, and
      // the `'prune'` leaf domain is what keeps them apart from the transaction
      // leaves under the same root. Those two are the only leaf classes left:
      // `'coinbase'` retired with `CoinbaseOutput` and `'subblock'` before it.
      expect(decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()))).toEqual(makeUtxoTxTree());
    });

    it('UtxoTxTree — several entries in one section', () => {
      // More than one element in the section whose width varies, which is where
      // a per-element offset error shows up as a decode failure rather than as a
      // value that happens to round-trip.
      const tree = makeUtxoTxTree();
      const two: UtxoTxTree = {
        ...tree,
        pruneEntries: [
          tree.pruneEntries[0]!,
          { ...tree.pruneEntries[0]!, subtreePostIds: [], trigger: 'author' },
        ],
      };
      expect(decodeUtxoTxTree(encodeUtxoTxTree(two))).toEqual(two);
    });

    it('OrderingBlock', () => {
      expect(decodeOrderingBlock(encodeOrderingBlock(makeOrderingBlock()))).toEqual(makeOrderingBlock());
    });

    it('Stump — still cbor-x, and nothing in this phase moved it', () => {
      expect(decodeStump(encodeStump(makeStump()))).toEqual(makeStump());
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
        post: makePost(),
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

    it('no field name reaches the bytes, and the whole transaction is 41 bytes', () => {
      // Hand-derived from the layout: arr(inputs)=1, arr(outputs)=1+35 for the
      // karma candidate, vlqU(protocolVersion)=1, opt(likeTarget)=1,
      // opt(post)=1, arr(signatures)=1. **42 until `preimages` left** — its
      // absence marker was a byte on every transaction ever encoded, which is
      // why removing the field moved every id rather than only the ones that
      // carried one.
      const bytes = encodeTx(makeTx());
      expect(bytes.length).toBe(41);
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
      // asserted rather than assumed — arr(inputs)=1 and arr(outputs)=1+35 put it
      // at 37 — so a layout change fails here as a wrong-offset error rather than
      // by silently padding another field. It was 38 while `preimages` sat in
      // front of it, and this is where that shift is visible.
      const PROTOCOL_VERSION_OFFSET = 37;
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

    it('pruneEntry authorId is BYTES where the header validatorId is also bytes', () => {
      // Both are "a 32-byte Ed25519 public key" written `b32` in the contract,
      // and here both are `Uint8Array` — so the writer follows the schema type
      // rather than the notation. The hex writer would throw on either.
      const back = decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()));
      expect(back.pruneEntries[0]!.authorId).toBeInstanceOf(Uint8Array);
      // …while its sibling `rootPostHash` is hex, in the same struct.
      expect(typeof back.pruneEntries[0]!.rootPostHash).toBe('string');
    });

    // ⛔ **Two rows of this section lost their subject, not their argument.**
    // `CoinbaseOutput.value` was the body's only `bigint` — `vlqU` in the table,
    // `writeVlqU64OrThrow` in the code — and `isTreasury` its only `boolean`,
    // `u8` in the table and `writeBool` in the code. Both fields are gone with
    // the struct, and no field left in `UtxoTxTree` reaches either writer, so
    // there is nothing here for those rows to pin. **The class is still pinned in
    // this package**, one struct over: box `value` is the `vlqU64` row and
    // `karma.decayBurn` the `writeBool` one, both in `utxo.test.ts`.

    it('trigger is enum8, and the out-of-table byte has no decoding', () => {
      // The body's remaining notation-versus-type row: `enum8` in the table and a
      // closed string set in the code, total by a `0xff` its tag set cannot
      // reach. `writeU8OrThrow` would throw on every prune entry; a lenient
      // reader would map 254 byte strings onto one value.
      const tree = makeUtxoTxTree();
      expect(decodeUtxoTxTree(encodeUtxoTxTree(tree)).pruneEntries[0]!.trigger)
        .toBe('storage_prune');
      const bad: UtxoTxTree = {
        ...tree,
        pruneEntries: [{ ...tree.pruneEntries[0]!, trigger: 'nonsense' as PruneEntry['trigger'] }],
      };
      const bytes = encodeUtxoTxTree(bad);
      expect(hex(bytes)).toContain('ff');
      expect(() => decodeUtxoTxTree(bytes)).toThrow(ReaderError);
    });
  });

  // -------------------------------------------------------------------------
  // The block has ONE committed body
  // -------------------------------------------------------------------------

  describe('one body, and the sub-block sections are unrepresentable', () => {
    it('the tree encodes exactly three arrays, in field order', () => {
      // An empty tree is three count bytes and nothing else. A fourth array — or
      // a missing one — shows up as a length delta, which is what makes "the
      // sections are these three, in this order" a measurement rather than an
      // inspection. Field order is also the normative LEAF order for
      // `utxoTxRoot` (TYPES_INTERFACE → OrderingBlock).
      //
      // ⛔ **Four until `coinbaseOutputs` left**, and the count is the whole of
      // what this assertion is for: a tree that still wrote the section would be
      // four bytes here, and a reader that still read one would run past the end.
      const empty: UtxoTxTree = {
        utxoTxIds: [], utxoTxs: [], pruneEntries: [],
      };
      const bytes = encodeUtxoTxTree(empty);
      expect(bytes.length).toBe(3);
      expect([...bytes]).toEqual([0, 0, 0]);
    });

    it('a decoded tree carries the three sections and nothing else', () => {
      const decoded = decodeUtxoTxTree(encodeUtxoTxTree(makeUtxoTxTree()));
      expect(Object.keys(decoded))
        .toEqual(['utxoTxIds', 'utxoTxs', 'pruneEntries']);
      // The retired section is unrepresentable, not merely unwritten: an object
      // carrying it encodes to the same bytes as one without.
      const withCoinbase = { ...makeUtxoTxTree(), coinbaseOutputs: [{ owner: userB, value: 1n }] };
      expect(hex(encodeUtxoTxTree(withCoinbase as UtxoTxTree)))
        .toBe(hex(encodeUtxoTxTree(makeUtxoTxTree())));
    });

    it('a sub-block section is unrepresentable, not merely unwritten', () => {
      // The projection step, on the retired fields: an object carrying either of
      // them encodes to the same bytes as one without, so there is no byte
      // string a peer could send that would put a second body back into a
      // decoded block.
      const withSub = {
        ...makeOrderingBlock(),
        subBlockTree: { subBlockEntries: [{ postId: 'de'.repeat(32) }], pruneEntries: [] },
      };
      expect(hex(encodeOrderingBlock(withSub as OrderingBlock)))
        .toBe(hex(encodeOrderingBlock(makeOrderingBlock())));
      const withRoot = { ...makeBlockHeader(), subBlockRoot: 'de'.repeat(32) };
      expect(hex(encodeHeader(withRoot as BlockHeader)))
        .toBe(hex(encodeHeader(makeBlockHeader())));
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
      const tree = makeUtxoTxTree();
      // Junk the entry, not the tree — the array keeps its length, so a bytes
      // difference can only come from the junk key and not from a dropped
      // element.
      const junked: UtxoTxTree = {
        ...tree,
        pruneEntries: [{ ...tree.pruneEntries[0]!, evil: 1 } as never],
      };
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
        ['post', encodePost(makePost())],
        ['orderingBlock', encodeOrderingBlock(makeOrderingBlock())],
      ] as [string, Uint8Array][]) {
        const decoder = {
          header: decodeHeader,
          utxoTxTree: decodeUtxoTxTree, post: decodePost,
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
      for (const decoder of [decodePost, decodeHeader,
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
    /** Posts as transactions: the sub-block wrapper is gone and the post shrank. */
    const POST_TX_ID = '68214f55219433736fd09a81a981407fbc95701dfac9665e31b1a38abbbbf6a8';

    const PINNED_POST: Post = {
      content: 'T2b consensus pin: sub-block shape',
      author: new Uint8Array(32).fill(7),
      parentRefs: [],
      protocolVersion: 1,
      timestamp: 1754600000000,
    };

    it('Post: the sub-block wrapper is dead and the post itself is the pin', () => {
      // ⛔ The sequence continues rather than restarting. Each adjacent pair is
      // one recorded, intentional consensus break: cbor → positional →
      // posts-as-transactions. `encodeSubBlock` is gone, so what this pins is the
      // post encoding that used to ride inside it — three fields lighter, since
      // `challenge`, `powNonce` and `signature` all died with post PoW.
      const bytes = encodePost(PINNED_POST);
      // The key name cannot appear: there are no key names.
      expect(hex(bytes)).not.toContain(Buffer.from('likeBoxes', 'utf8').toString('hex'));
      expect(hex(bytes)).not.toContain(Buffer.from('subBlockId', 'utf8').toString('hex'));
      const id = hash(bytes);
      expect(id).not.toBe(PRE_T2B_ID);
      expect(id).not.toBe(CBOR_ID);
      expect(id).not.toBe(POSITIONAL_ID);
      expect(id).toBe(POST_TX_ID);
    });

    it('BlockHeader: the blockHash preimage moved, and shrank', () => {
      // ⛔ NINE fields, not ten — `subBlockRoot` is gone and every position after
      // `prevBlockHash` shifted down by one. 140 positional bytes: five VLQ
      // integers (1+1+1+2+6) plus 32+32+33+32 raw bytes, exactly 32 fewer than
      // the ten-field form's 172. A reader that dropped the field but kept the
      // old offsets would still be 140 bytes and would hash differently, which
      // is why the hash is pinned beside the length rather than instead of it.
      const bytes = encodeHeader(makeBlockHeader());
      expect(bytes.length).toBe(140);
      expect(hash(bytes)).toBe('63e9132c42173752a8449618d5371b6aafafdb7cc8e1df4e243814a9fc837a07');
      expect(hex(bytes)).not.toContain(Buffer.from('prevBlockHash', 'utf8').toString('hex'));
    });

    it('OrderingBlock: the whole frame moved', () => {
      // ⚠ **Transport, not commitment — this pin moves for reasons the others
      // cannot.** The frame carries `utxoTxs` as `arr(utxoTxs, lp)`, opaque
      // length-prefixed `encodeTx` output, so adding or removing a *field* on a
      // box or transaction moves this hash with no format change at all.
      //
      // Nothing committed follows it. `utxoTxRoot` is a Merkle root over
      // `utxoTxIds` and `serializePruneEntry` (node's `computeUtxoTxRoot`) and
      // never reads `utxoTxs`; the id itself is `computeTxId`, positional and
      // routed through `canonicalBoxBytes`. A move here is a consensus event only
      // if the BlockHeader pin above moved too — and it did not.
      //
      // ⚠ **It moved THREE times in this unit, for three unrelated reasons**, and
      // this pin cannot tell them apart — which is the whole content of calling it
      // transport:
      //
      //  1. `coinbaseOutputs` left the body, so the tree lost a section.
      //  2. `encodeTx` became positional, so the `utxoTxs` payload is other bytes.
      //  3. `preimages` left the transaction, so that payload lost a byte.
      //
      // ⛔ **Only (3) is a consensus event, and NOTHING HERE SAYS WHICH.** The
      // BlockHeader pin above is untouched by all three; the frozen ids in
      // `utxo.test.ts` are untouched by (1) and (2) and moved under (3). **Those
      // are the pins that carry the verdict** — read this one only as "the frame
      // changed", never as evidence about what.
      expect(hash(encodeOrderingBlock(makeOrderingBlock()))).toBe('c4130f6fbfdd256cdd6b36c172e8a57c5514e424a4083acd74653415828ce654');
    });

    it('Post: the wire codec IS the payload preimage, with no tail at all', () => {
      // ⛔ The two-field tail had exactly two members — `powNonce` and
      // `signature` — and both died with post PoW. So `encodePost` and
      // `postFieldBytes` are now the same bytes, and that is worth pinning
      // rather than assuming: the wire form and the preimage being one encoding
      // is what removes any chance of the two dialects drifting.
      const post = makePost();
      const wire = encodePost(post);
      const preimage = postFieldBytes(post);
      expect(hex(wire)).toBe(hex(preimage));
      expect(wire.length).toBe(preimage.length);
    });
  });
});
