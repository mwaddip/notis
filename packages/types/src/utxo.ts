import { createHash } from 'crypto';
import { ByteReader, ByteWriter, ReaderError } from '@dagsocial/wire';
import { MAX_GENESIS_PROOF_PAYLOAD_BYTES } from './constants.js';
import {
  u32BE,
  type StructCodec,
  decodeStruct,
  encodeStruct,
  enum8,
  readArr,
  readBool,
  readBytesN,
  readHexN,
  readLp,
  readOpt,
  readVlqU,
  readVlqU64,
  writeArr,
  writeBool,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeOpt,
  writeVlqU,
  writeVlqU64OrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import { postFieldBytes, readPostFields, type Post, type PostId } from './post.js';

// ---------------------------------------------------------------------------
// Box identity
// ---------------------------------------------------------------------------

export type BoxId = string;
export type TxId = string;

const encoder = new TextEncoder();

/**
 * Domain separators — TYPES_INTERFACE → BoxId.
 *
 * Box ids, transaction ids and identity-record keys all live in one 32-byte
 * keyspace, and the AVL tree holds more than one entity kind, so the
 * separation has to be in the preimage rather than in the caller's head.
 * `computePostId` already works this way via its module-local `POST_ID_DOMAIN`;
 * these are exported because node and the demo UI must mirror them byte for
 * byte.
 */
export const BOX_ID_DOMAIN = encoder.encode('dagsocial/box-id/1');
export const TX_ID_DOMAIN = encoder.encode('dagsocial/tx-id/1');
export const MINT_ID_DOMAIN = encoder.encode('dagsocial/mint-tx-id/1');
export const IDENTITY_KEY_DOMAIN = encoder.encode('dagsocial/identity-key/1');

/**
 * The `boxType` tag table — **the single source of the box-type numbering.**
 *
 * **A tag is never renumbered.** `boxType` is the first byte of every box's
 * identity preimage, so moving a number silently moves every box id and every
 * `stateRoot` covering it, with no compiler signal — TYPES_INTERFACE →
 * Primitives, applying inside the id preimage itself. Node's AVL value
 * (`state/serialize-box.ts`) reads this same table.
 *
 * Giving a retired type's *number* to a new type is a different operation with
 * its own conditions, which TYPES_INTERFACE → Primitives states. A retired
 * **string** is reserved regardless; see `BoxCandidate.boxType`.
 *
 * ⛔ **Tag 2 is reserved and left out of the table**, so the numbering has a hole
 * in it rather than a renumber closing the gap, and an unassigned tag has no
 * decoding at all — the same standing every number above the table has.
 * **TYPES_INTERFACE → Layout — Boxes governs the NUMBER** ("Tag 2 is reserved,
 * not free"); §InviteBox governs the retired **string**. Two rules, two sections.
 *
 * Exported because a second numbering of one thing is exactly what the
 * never-renumber rule cannot survive. **The demo UI's `BOX_TYPE_TAGS` is the one
 * copy that cannot import this** — it is browser JS served to a page with no
 * module graph, and stays a mirror by construction.
 *
 * The golden corpus's reverse table (`test/golden/structs.ts`) restates the
 * numbering deliberately and is **not** a copy to collapse into this one: it
 * feeds the independent reader those vectors are checked against, and a reader
 * importing the writer's own table would check nothing.
 */
export const BOX_TYPE_TAGS = Object.freeze({
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
} as const satisfies Readonly<Record<BoxCandidate['boxType'], number>>);

/** The `enum8` codec over that table — one table, both directions. */
const BOX_TYPE = enum8<BoxCandidate['boxType']>('boxType', BOX_TYPE_TAGS);

/**
 * The single canonical identity encoding for a box — `boxContentBytes` in
 * TYPES_INTERFACE → Layout — Boxes.
 *
 * This is the encoder that actually computes ids — exported so tests and mirror
 * implementations (demo UI, light client) assert against it instead of a
 * lookalike. Node's `state/serialize-box.ts` is a *separate* encoding for AVL
 * values and is not interchangeable with it.
 *
 * Shared prefix, then the per-type fields in their normative order:
 *
 *   enum8(boxType) ‖ vlqU64(value) ‖ vlqU(createdAtBlock) ‖ <per-type>
 *
 *   | karma         | b32(owner) ‖ opt(nonActivity)                                |
 *   | credit        | b32(owner) ‖ opt(lockedUntilBlock)                         |
 *   | genesis_proof | lp(payload)                                               |
 *   | bond          | b32(inviterId) ‖ b32(inviteePublicKey)                     |
 *   | post_lock     | vlqU64(originalValue) ‖ b32(owner)                         |
 *   | vouch         | b32(voucherId) ‖ b32(targetId)                            |
 *   | emission      | (none)                                                    |
 *   | treasury      | (none)                                                    |
 *   | fee           | (none)                                                    |
 *   | karma_pool    | (none)                                                    |
 *   | like_accrual  | b32(author)                                               |
 *   | vouch_escrow  | b32(owner) ‖ vlqU(releaseAtBlock)                          |
 *
 * **`emission`, `treasury`, `fee` and `karma_pool` stop after the prefix**, and
 * an empty cell above is a layout rather than an omission (TYPES_INTERFACE →
 * Layout — Boxes). None of the four names an owner, so there is no trailing
 * field to write and **the smallest legal box of any type is three bytes** — the
 * tag, a zero value and a zero height, each one group wide.
 *
 * **Provenance is structurally absent**, not stripped at runtime: there is no
 * branch here that could write `id`/`txId`/`index`, so "provenance is not in
 * the candidate bytes" is a property of this encoder rather than a rule a
 * caller has to remember. `computeBoxId` binds provenance by appending it
 * *after* these bytes, which is what keeps the derivation non-circular.
 *
 * **Key order does not exist.** Field order is fixed by the table above, so a
 * producer's own field order is not consensus-visible and no sorting pass is
 * required to make it so. A stray extra key on a box object is likewise
 * unrepresentable — the encoder reads the fields it declares and nothing else.
 *
 * ## Totality
 *
 * Total for an unknown `boxType`: `enum8` writes the reserved `0xff` sentinel
 * and no per-type fields follow, so a malformed box still encodes and can never
 * collide with a well-formed one (no valid tag is `0xff`). Two *malformed*
 * boxes with different bogus types do share bytes — the same malformed-only
 * residue the numeric sentinel has.
 *
 * **`value` throws** outside `[0, 2^64)`, one of the non-total writers
 * TYPES_INTERFACE → Totality names: `value: bigint` spans the entire u64 wire
 * domain, so no sentinel is unreachable — an all-ones u64 is a value this
 * encoder must write, and using it to mean "malformed" would give a malformed
 * box a well-formed box's id. ⛔ **Consensus admitting only
 * `[0, BOX_VALUE_BOUND)` (TYPES_INTERFACE → Box value domain) does not make that
 * sentinel available**: the domain the argument rests on is this encoder's, and
 * it is unchanged. The fixed-width `b32` fields throw for the same structural
 * reason. Their
 * domain is `checkOutputShape`'s (node, `validateTx` step 4); see the note on
 * `computeTxId` for the one call site where that gate has not run yet.
 *
 * **`bond` and `vouch` carry identical trailing fields** — two adjacent `b32`
 * key fields each (TYPES_INTERFACE → Layout — Boxes). `enum8(boxType)` is field
 * 1, so the tag is what makes the encoding injective across the two, and nothing
 * may rest on their values differing. It is the standing `karma` and `credit`
 * already have. **`emission`, `treasury`, `fee` and `karma_pool` stand in the
 * same relation with no fields at all**, so at equal `value` the tag is the
 * whole of the difference and their ids part on the provenance `computeBoxId`
 * appends.
 *
 * ⛔ **`createdAtBlock` SENTINELS, AND IT DOES SO FOR EVERY BOX TYPE.** It is the
 * one field in the shared prefix written by a total writer: `writeVlqU` emits the
 * reserved sentinel for anything outside `[0, MAX_SAFE_INTEGER]` rather than
 * throwing, so a negative, fractional or oversized height **encodes**, and every
 * out-of-domain height on a box of one type, value and tail produces **one id**.
 * The residue reaches every box type, not one optional arm, which is why the
 * domain has to be established upstream — node's output-shape schema,
 * `validateTx` step 4.
 *
 * ⚠ **`vlqU64`, not `vlqU`, for `value` — and the prefix now holds one of each,
 * adjacent.** `value` and `post_lock.originalValue` are `bigint`, so they take
 * `writeVlqU64OrThrow`; `createdAtBlock` is a `number`, so it takes `writeVlqU`.
 * The bytes are identical over the overlapping range, so the difference is
 * invisible in a golden vector and cannot be inferred from a field's type:
 * `vlqU` is total by sentinel and `vlqU64` throws. TYPES_INTERFACE → Totality
 * names the `…OrThrow` writers precisely so the totality exception is visible
 * at the call site.
 */
export function canonicalBoxBytes(candidate: BoxCandidate): Uint8Array {
  const w = new ByteWriter();
  BOX_TYPE.write(w, candidate.boxType);
  writeVlqU64OrThrow(w, candidate.value);
  writeVlqU(w, candidate.createdAtBlock);
  writeBoxTypeFields(w, candidate as AnyBoxCandidate);
  return w.toBytes();
}

/** The per-type tail of `canonicalBoxBytes`. Field order is normative. */
function writeBoxTypeFields(w: ByteWriter, box: AnyBoxCandidate): void {
  switch (box.boxType) {
    case 'karma':
      writeBytesNOrThrow(w, box.owner, 32);
      writeOpt(w, box.nonActivity, writeBool);
      return;
    case 'credit':
      writeBytesNOrThrow(w, box.owner, 32);
      writeOpt(w, box.lockedUntilBlock, writeVlqU);
      return;
    case 'genesis_proof':
      // `lp`, not `lpUtf8`: the payload is opaque to consensus. Whether it
      // decodes as text is a client's question, and a UTF-8 writer would put a
      // validity rule inside an encoder that does not own one. The length
      // prefix is the whole of the field's injectivity — appended raw, an empty
      // payload would be indistinguishable from the end of the box.
      //
      // Unbounded here and bounded in the reader: `MAX_GENESIS_PROOF_PAYLOAD_BYTES`
      // is a decode rule, so a payload over it encodes and has no decoding —
      // the same one-way shape as the `0xff` tag sentinel below.
      writeLp(w, box.payload);
      return;
    case 'bond':
      writeBytesNOrThrow(w, box.inviterId, 32);
      writeBytesNOrThrow(w, box.inviteePublicKey, 32);
      return;
    case 'post_lock':
      writeVlqU64OrThrow(w, box.originalValue);
      writeBytesNOrThrow(w, box.owner, 32);
      return;
    case 'vouch':
      writeBytesNOrThrow(w, box.voucherId, 32);
      writeBytesNOrThrow(w, box.targetId, 32);
      return;
    case 'like_accrual':
      // `author` is attribution, not authorization — no signature by it unlocks
      // the box (see `LikeAccrualBox`). The encoder makes no distinction: it is
      // a `b32` field like `vouch.targetId`, which names a party that cannot
      // spend either.
      writeBytesNOrThrow(w, box.author, 32);
      return;
    case 'vouch_escrow':
      writeBytesNOrThrow(w, box.owner, 32);
      // `vlqU`, total by sentinel, which is the standing every height in this
      // format has (TYPES_INTERFACE → Totality). Required rather than optional,
      // so there is no `opt` tag: an escrow always names the height it releases
      // at, and absence is not a state it has.
      writeVlqU(w, box.releaseAtBlock);
      return;
    case 'emission':
    case 'treasury':
    case 'fee':
    case 'karma_pool':
      // The tail is empty by layout, not by oversight (TYPES_INTERFACE →
      // Layout — Boxes). None of the four names an owner — block application
      // is the only spender — so the content encoding is the shared prefix
      // alone. Stated as its own arm rather than left to `default`, which is
      // the unknown-tag sentinel below and would write these bytes for a
      // reason that is not this one.
      return;
    default:
      // Unreachable from a valid box, and returning rather than throwing is
      // what keeps this total: `enum8` has already written the reserved `0xff`
      // for the unknown tag, so there are no declared fields to write and no
      // well-formed box can produce these bytes.
      return;
  }
}

/**
 * The inverse of `canonicalBoxBytes` — read a box back out of its content bytes.
 *
 * **Deliberately adjacent to `writeBoxTypeFields`**, and that placement is the
 * point: field order is normative and a reader that walks it differently is a
 * consensus divergence with no compiler signal, so the two arms sit where a
 * reviewer reads them as one table. `BOX_TYPE.read` rejects the reserved `0xff`
 * and every unassigned tag, so the writer's total-by-sentinel arm has no
 * decoding at all — a malformed box cannot round-trip as if it were fine.
 *
 * **One per-type domain rule lives here**, and it is the only one:
 * `genesis_proof.payload` is bounded at `MAX_GENESIS_PROOF_PAYLOAD_BYTES`. Every
 * other refusal this reader makes belongs to a primitive in `codec.ts` and
 * therefore to every field that uses it; this one binds a single arm.
 *
 * One absence is mapped rather than passed through, and it is what makes the
 * re-encode compare close: `opt` fields decode to `undefined`, not `null`.
 * `nonActivity?: boolean` and `lockedUntilBlock?: number` are optional, so
 * `undefined` is the type-correct spelling of absent and it is what re-encodes to
 * the same `u8(0)`.
 */
function readBoxContentFields(r: ByteReader): DecodedBoxCandidate {
  const boxType = BOX_TYPE.read(r);
  const value = readVlqU64(r);
  // Read before the switch because it is prefix, not per-type — one read for
  // twelve arms, so no arm can walk the shared prefix differently from another.
  const createdAtBlock = readVlqU(r);
  switch (boxType) {
    case 'karma':
      return {
        boxType,
        value,
        createdAtBlock,
        owner: readBytesN(r, 32),
        nonActivity: readOpt(r, readBool) ?? undefined,
      };
    case 'credit':
      return {
        boxType,
        value,
        createdAtBlock,
        owner: readBytesN(r, 32),
        lockedUntilBlock: readOpt(r, readVlqU) ?? undefined,
      };
    case 'genesis_proof': {
      const payload = readLp(r);
      // The payload bound, and this arm is the whole of it — `readLp` is the
      // shared primitive behind every `lp` field in the format, so a bound
      // there would bind `utxoTxs` and the block's other sections along with
      // this one.
      //
      // One-way, like the unknown-tag sentinel above: `writeLp` stays total, so
      // an over-bound payload still *encodes* and `computeBoxId` still answers
      // for it — it simply has no decoding, which is the standing this reader
      // already gives an unassigned tag.
      //
      // `invalid-tag` because `ReaderErrorCode` (owned by `@dagsocial/wire`) has
      // no member for a domain refusal; it is the code `readLpUtf8` already
      // uses for the same shape — a length-prefixed field whose *contents* are
      // out of domain — and the one `CodecError` picks for "present and wrong,
      // which is not truncation".
      if (payload.length > MAX_GENESIS_PROOF_PAYLOAD_BYTES) {
        throw new ReaderError(
          `readBoxContentFields: genesis_proof payload is ${payload.length} bytes, over ` +
            `MAX_GENESIS_PROOF_PAYLOAD_BYTES (${MAX_GENESIS_PROOF_PAYLOAD_BYTES})`,
          'invalid-tag',
        );
      }
      return { boxType, value: value as 0n, createdAtBlock, payload };
    }
    case 'bond':
      return {
        boxType,
        value,
        createdAtBlock,
        inviterId: readBytesN(r, 32),
        inviteePublicKey: readBytesN(r, 32),
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
        boxType,
        value: value as 1n,
        createdAtBlock,
        voucherId: readBytesN(r, 32),
        targetId: readBytesN(r, 32),
      };
    case 'like_accrual':
      return {
        boxType,
        value,
        createdAtBlock,
        author: readBytesN(r, 32),
      };
    case 'vouch_escrow':
      return {
        boxType,
        value,
        createdAtBlock,
        owner: readBytesN(r, 32),
        releaseAtBlock: readVlqU(r),
      };
    case 'emission':
    case 'treasury':
    case 'fee':
    case 'karma_pool':
      // Nothing follows the prefix on any of the four arms, so the box is
      // complete at the point the tag and value have been read.
      // `boxRecordFromBytes`' exhaustion check is what makes that a decoding
      // rather than a silent stop: bytes past this point are `trailing-bytes`,
      // not a tail this reader declined to walk.
      return { boxType, value, createdAtBlock };
  }
}

// `u32BE` lives in `codec.ts` with the other field writers and is re-exported
// here, where its callers are. It moved so `post.ts` can reach it without a
// value import of this module, which `postFieldBytes` already makes a cycle.
export { u32BE } from './codec.js';

/**
 * A box **with its provenance** — TYPES_INTERFACE → Layout — Boxes:
 *
 *   boxRecordBytes = canonicalBoxBytes(candidate) ‖ b32(txId) ‖ vlqU(index)
 *
 * The contract names two box encodings and separates them so that "provenance
 * is not in the id" is structural rather than a runtime strip somebody has to
 * remember: `canonicalBoxBytes` is what `computeBoxId` and `computeTxId` hash,
 * and **this** is what the AVL value and the store hold. The `id` is never
 * encoded — it *is* the hash of these bytes under `BOX_ID_DOMAIN`.
 *
 * **The id derivation below calls this function**, so the AVL value and the box
 * id are the same bytes by construction and not by two implementations
 * agreeing.
 *
 * **`txId` crosses as 32 raw bytes, not as the UTF-8 of its hex text.** Two
 * properties a text encoding would give for free are secured elsewhere instead:
 *
 * - *Totality.* A hex decode throws on a malformed `txId`, so text would keep
 *   this function total by itself. `b32` throws, and the domain is established
 *   at every call site instead: every `txId` reaching here is a
 *   `.toString('hex')` output of `computeTxId` or `computeMintTxId`, so it is
 *   64 lowercase hex by construction. A throwing writer with an established
 *   domain is this format's standard trade (TYPES_INTERFACE → Totality), not an
 *   exception.
 * - *Injectivity.* A decode would map `AB…` and `ab…` onto one id. `b32`
 *   accepts lowercase only, so an uppercase id has **no encoding at all**
 *   instead of sharing one.
 *
 * `index` is `vlqU`, which is total by sentinel — so an out-of-domain index
 * still cannot panic this function, and still cannot impersonate a valid one.
 *
 * @throws {Error} if `candidate` is unencodable (see `canonicalBoxBytes`) or
 *   `txId` is not 64 lowercase hex characters
 */
export function boxRecordBytes(candidate: BoxCandidate, txId: TxId, index: number): Uint8Array {
  return encodeStruct(BOX_RECORD, { candidate: candidate as DecodedBoxCandidate, txId, index });
}

/**
 * Read a box record back — the inverse of `boxRecordBytes`, and the reason this
 * layout has exactly one definition instead of two.
 *
 * **A writer without a reader is what lets a format drift.** Node's AVL store
 * holds these bytes and has to parse them back; a reader written over there
 * would put the box layout in two packages, and the two would be free to
 * disagree about field order with nothing to catch it — the defect
 * `NODE_INTERFACE`'s discriminator note records, arrived at from the other
 * direction. Every other wire struct in this repo is a pair; this one is too.
 *
 * Goes through `decodeStruct`, so it carries the whole four-part boundary check
 * (TYPES_INTERFACE → The boundary check): schema projection, exhaustion, and
 * the re-encode compare that
 * rejects a non-minimal VLQ. Truncation and an unknown `boxType` tag come from
 * the readers themselves. So a value the store hands back is not merely
 * parseable — it is the *only* byte string that decodes to it.
 *
 * @throws {ReaderError} — `CodecError` for a boundary-check failure, wire's own
 *   for a short read or an unknown tag. Callers convert it to a verdict.
 */
export function boxRecordFromBytes(bytes: Uint8Array): BoxRecord {
  return decodeStruct(BOX_RECORD, bytes);
}

/** What `boxRecordFromBytes` returns: the box, and the provenance that names it. */
export interface BoxRecord {
  candidate: DecodedBoxCandidate;
  txId: TxId;
  index: number;
}

/**
 * A box candidate as the **bytes** carry it — every field a candidate has, so
 * this is `AnyBoxCandidate` and not a narrowing of it.
 *
 * It has its own name because it names the **reader's** side of the layout:
 * `readBoxContentFields` and `BoxRecord.candidate` answer with one, and the
 * round-trip claim reads as a claim with both directions named.
 */
export type DecodedBoxCandidate = AnyBoxCandidate;

/**
 * The box-record layout, written once and walked from both ends.
 *
 * `write` delegates the content half to `canonicalBoxBytes` rather than
 * repeating it, so the id preimage and the record share one encoder and cannot
 * drift; only the two-field provenance tail lives here.
 */
const BOX_RECORD: StructCodec<BoxRecord> = {
  name: 'boxRecord',
  write(w, record) {
    w.writeBytes(canonicalBoxBytes(record.candidate as BoxCandidate));
    writeHexNOrThrow(w, record.txId, 32);
    writeVlqU(w, record.index);
  },
  read(r) {
    return {
      candidate: readBoxContentFields(r),
      txId: readHexN(r, 32),
      index: readVlqU(r),
    };
  },
};

/**
 * Box id from creating-transaction provenance — TYPES_INTERFACE → BoxId:
 *
 *   blake2b512( BOX_ID_DOMAIN ‖ boxRecordBytes(candidate, txId, index) )[0:32]
 *
 * Honest, predictable and collision-free at once: the derivation binds content
 * *and* the position that content was created at, so it is knowable at signing
 * time and cannot be invalidated by anything block application does.
 */
export function computeCandidateBoxId(candidate: BoxCandidate, txId: TxId, index: number): BoxId {
  return createHash('blake2b512')
    .update(BOX_ID_DOMAIN)
    .update(boxRecordBytes(candidate, txId, index))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Synthetic ids exist for genesis seeding and post-lock vesting only;
 * everything else is a settlement output with an ordinary transaction id
 * (NODE_INTERFACE → Box Identity and Mint Provenance).
 *
 * The discriminant is semantic, never positional: deriving it from journal
 * position would put ordering back into *identity*, which is the failure
 * class M-12 closed for the AVL feed.
 *
 * Subject bytes are the caller's, per `NODE_INTERFACE.md`'s reason/subject
 * table; this package never sees a postId.
 *
 * `genesis-committee` keys on the **member** — the raw 32-byte public key,
 * one karma box per `genesisCommitteeKeys` entry, drawn out of the karma
 * pool. The `genesis` reason cannot carry it: that subject is `u32BE(k)`,
 * one number per genesis box, so every member would share one synthetic
 * txId (NODE_INTERFACE → Reason and subject table).
 */
export type MintReason =
  | 'postlock-unlock'
  | 'postlock-remainder'
  | 'genesis'
  | 'genesis-committee';

/**
 * The `MintReason` tag table.
 *
 * A closed set of ASCII tags inside a consensus preimage is exactly what
 * `enum8` is for, and it is what `boxType` and `trigger` already use — writing
 * this one as `lpUtf8` instead would put two ways of encoding one kind of thing
 * back into a format whose entire purpose is that there is one.
 *
 * Two things it buys beyond uniformity:
 *
 * - **Exhaustiveness is compile-time.** `Readonly<Record<MintReason, number>>`
 *   means a new member cannot be added without assigning it a tag. Without the
 *   table, a new reason ships with no thought given to its encoding at all.
 * - **Prefix-freeness stops being a property anyone has to maintain.** Written
 *   as bare ASCII into a `reason ‖ subject` preimage, cross-reason injectivity
 *   would rest on no member being a prefix of another — checkable, pinnable, and
 *   one careless addition away from false. A one-byte tag makes it structural.
 *
 * **A live tag is never renumbered** (TYPES_INTERFACE → Primitives). A
 * renumber moves every mint txId carrying the tag and, through
 * `computeCandidateBoxId`, every box id minted under it — with no compiler
 * signal.
 */
const MINT_REASON = enum8<MintReason>('mintReason', {
  'postlock-unlock': 3,
  'postlock-remainder': 4,
  genesis: 6,
  'genesis-committee': 13,
});

/**
 * Synthetic transaction id for a mint event:
 *
 *   blake2b512( MINT_ID_DOMAIN ‖ vlqU(height) ‖ enum8(reason) ‖ lp(subject) )[0:32]
 *
 * Feeding this to `computeCandidateBoxId` gives mints and user transactions one
 * derivation path rather than two id schemes.
 *
 * `subject` bytes are the **caller's** to encode — this package does not know
 * what a postId or a voucher pair is; the per-reason encoding table belongs to
 * `NODE_INTERFACE.md`. It is **length-prefixed** here, and that is what makes
 * uniqueness *within* a reason structural, the same way the tag makes it
 * structural *across* reasons. Appended raw, two different subjects could
 * concatenate identically, and every per-reason subject encoding would have to
 * be fixed-length or self-delimiting for the contract to hold.
 *
 * Total throughout: `vlqU` and `lp` sentinel rather than throw, and `enum8`
 * writes its reserved `0xff` for a tag outside the table. A malformed mint
 * context cannot panic id derivation.
 */
export function computeMintTxId(height: number, reason: MintReason, subject: Uint8Array): TxId {
  const w = new ByteWriter();
  writeVlqU(w, height);
  MINT_REASON.write(w, reason);
  writeLp(w, subject);
  return createHash('blake2b512')
    .update(MINT_ID_DOMAIN)
    .update(w.toBytes())
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/**
 * Box id of a **stored** box — a total function of the box itself.
 *
 * Exactly `computeCandidateBoxId` applied to the box's own provenance, so there
 * is one derivation rather than two. Binding the id to `txId ‖ index` instead of
 * to content alone is what makes `stored.id === computeBoxId(stored)` hold **by
 * construction** for every box in the UTXO set, checkable by any light client,
 * indexer or AVL prover. A content-only hash cannot: it would cover whatever
 * block application mutates, and a stored box would stop matching its own id —
 * audit M-11.
 *
 * Takes one argument, and must keep taking one: a second argument would mean the
 * box no longer carries what its id derives from.
 */
export function computeBoxId(box: Omit<BoxBase, 'id'>): BoxId {
  return computeCandidateBoxId(box, box.txId, box.index);
}

// ---------------------------------------------------------------------------
// Box types
// ---------------------------------------------------------------------------

/**
 * The creator-chosen fields — what a client builds and what `computeTxId`
 * hashes. No `id`, no provenance.
 */
export interface BoxCandidate {
  // `'like'` and `'invite'` are tracked reservations (TYPES_INTERFACE →
  // Tracked reservations). Tag 2 is a tracked hole (TYPES_INTERFACE →
  // tag rules); `BOX_TYPE_TAGS` leaves it out.
  boxType: 'karma' | 'credit' | 'genesis_proof' | 'bond' | 'post_lock' | 'vouch'
    | 'emission' | 'treasury' | 'fee' | 'karma_pool' | 'like_accrual' | 'vouch_escrow';
  value: bigint;        // integer base units, uniform across box types; value < 2^64 is the `vlqU` wire domain
  // ⚠ **`< 2^64` above is the ENCODABLE domain, and it is wider than the
  // accepted one.** Consensus admits `[0, BOX_VALUE_BOUND)` (`constants.ts`),
  // which node and validation enforce; no encoder here narrows to it.
  /**
   * The height its creator built this box at.
   *
   * ⛔ **CONTENT, NOT PROVENANCE, and the distinction is forced rather than
   * chosen.** Provenance in this codebase is what `CandidateOf` omits — `txId`
   * and `index`, attached by block application because a creator cannot know
   * them. A field a creator *declares* has to ride the transaction, so it has to
   * sit in the candidate, so `canonicalBoxBytes` encodes it and `computeTxId`
   * covers it. **A field cannot be both creator-declared and provenance.**
   *
   * ✅ **This is what keeps a box id derivable before inclusion.**
   * `computeCandidateBoxId(candidate, txId, index)` is unchanged and the record's
   * two-field tail is unchanged; the candidate simply carries one more field.
   *
   * ⚠ **A box may not claim the future** — `createdAtBlock <= currentBlockHeight`
   * for every output, checked in node's `validateTx`. Backdating is unbounded,
   * and that is safe only while nothing reads the value: **every rule that later
   * derives from this field owes its own exact check.**
   *
   * ⚠ **The node's `created_at_block` STORE column is written from this field**,
   * so the two hold one number. The column is a denormalisation for querying and
   * is **not committed in the `stateRoot`** — a rule reading it instead of the box
   * would be reading something no light client can verify.
   *
   * ⛔ **The activity clock is the number that is NOT this one.** It takes the open
   * journal's height, because it records when the chain saw activity rather than
   * what a creator declared — reading this field there would let a backdated box
   * backdate its owner's decay clock.
   */
  createdAtBlock: number;
}

/**
 * A box as it exists in the ledger, the store and the AVL value: a candidate
 * plus the provenance that gives it identity.
 *
 * `txId`/`index` are **required**, which is what makes "has an id but no
 * provenance" — the M-11 state — unrepresentable rather than merely discouraged.
 * A producer that forgets provenance is a compile error.
 *
 * `id` stays optional: producers build the candidate-plus-provenance object and
 * hash *it* to get the id, so the value is genuinely absent for one expression.
 * Every stored box has one — see the invariant in `TYPES_INTERFACE.md`.
 */
export interface BoxBase extends BoxCandidate {
  id?: BoxId;           // Computed via computeBoxId; absent only mid-construction
  txId: TxId;           // Creating transaction — real or synthetic (see computeMintTxId)
  index: number;        // u32, position within that transaction's outputs
}

/**
 * A box as its creator builds it: the per-type fields, with identity and
 * provenance removed.
 *
 * `BoxCandidate` above is the shared *base*; this is the per-box-type form the
 * contract's `interface BoxCandidate { …per-type fields }` describes. `Omit` is
 * applied per member rather than to `AnyBox` as a whole, because omitting from a
 * union collapses it to the common keys.
 */
export type CandidateOf<B extends BoxBase> = Omit<B, 'id' | 'txId' | 'index'>;

// --- Karma ---

export interface KarmaBox extends BoxBase {
  boxType: 'karma';
  owner: Uint8Array;          // 32 raw bytes — Ed25519 public key
  // No per-box age field: the decay clock reads the committed per-identity
  // record, not box ages.
  nonActivity?: boolean;
}

// --- Credit ---

export interface CreditBox extends BoxBase {
  boxType: 'credit';
  owner: Uint8Array;          // 32 raw bytes
  lockedUntilBlock?: number;  // Block height before which credits cannot be spent
}

// --- Genesis proof ---

/**
 * The box that makes one network's genesis state differ from another's.
 *
 * **The type is barred from both transaction positions** (TYPES_INTERFACE →
 * GenesisProofBox), and neither half is this package's: the output rule is
 * `VALIDATION_INTERFACE`'s, because a candidate output is a whole box and
 * typing it reads nothing, and the input rule is `NODE_INTERFACE`'s, because
 * `tx.inputs` are box id strings and typing one requires the UTXO set.
 *
 * `value` is `0n`: the box holds neither karma nor credits, so it never enters
 * supply accounting.
 */
export interface GenesisProofBox extends BoxBase {
  boxType: 'genesis_proof';
  value: 0n;
  /**
   * Opaque bytes — `lp` on the wire, and consensus reads nothing inside them.
   * `NetworkProfile.genesisProofPayload` carries the per-network value as hex.
   */
  payload: Uint8Array;
}

// --- Bond ---

/**
 * The inviter's stake — TYPES_INTERFACE → BondBox.
 *
 * ⛔ **THE BOND IS THE REQUEST**, and `inviteePublicKey` is what the block's
 * settlement transaction reads to address the invitee's grant: one bond, one
 * grant, with the pairing structural rather than compared between two lists
 * (TYPES_INTERFACE → InviteBox, `ARCHITECTURE → Invite System`).
 *
 * **A `BondBox` is byte-identical from creation to the block that consumes it**,
 * and the field list is what makes that true. An address can be invited only
 * once, so `inviteePublicKey` identifies exactly one bond: no box id, no output
 * index, no provenance walk. It carries no probation fields either — the window
 * runs from the bond's own creation height, which is already committed as
 * `IdentityRecord.invitedAtBlock` (NODE_INTERFACE → Identity Records), so
 * carrying it here would be a second copy of committed state.
 *
 * **There is no `originalValue`,** and the contrast with `PostLockBox` is the
 * reason: a post lock vests per block, so its current and initial values differ.
 * A bond settles **once**, for `min(floor(inviteeLifetimeLikes /
 * INVITE_BOND_VEST_PER_LIKES), value)` — a pure function of a lifetime count, so
 * one evaluation is arithmetically identical to accumulated instalments and no
 * partial state exists to record.
 *
 * **Nothing spends a bond.** Creation and settlement both move it through block
 * application, so no transition admits it into a user transaction — the same
 * standing `PostLockBox` has.
 */
export interface BondBox extends BoxBase {
  boxType: 'bond';
  value: bigint;                   // B karma deposited by the inviter
  inviterId: UserId;               // Owner — the inviter
  inviteePublicKey: Uint8Array;    // 32 raw bytes — set at creation, the key the grant is addressed to
}

// --- Post Lock ---

/**
 * ⛔ **There is no `targetPostId`, and the reason is CIRCULARITY — not tidiness.**
 *
 * A post's id comes from the transaction that creates it,
 * `computePostId(txId, index)`. The lock is an **output of that same
 * transaction**, and `canonicalBoxBytes` is inside the `TxId` preimage — so a
 * `targetPostId` field would have to be known before the `TxId` that produces
 * it. **The transaction would be unbuildable.** This is the same circularity
 * that makes `outputs` carry *candidates*: a transaction cannot name its own
 * outputs' ids, so ids are derived once `TxId` is known.
 *
 * It would also be a second copy of committed state. The lock's target is
 * recomputable — `computePostId(box.txId, 0)` for the lock a post transaction
 * creates — so carrying it adds a field that can disagree with the thing it
 * describes and buys nothing.
 *
 * ⚠ **Do not re-add it.** It looks obviously useful and it is unbuildable. Node
 * keeps the lock→post mapping as **derived state**, written at apply by every
 * node identically (NODE_INTERFACE → Post-lock vesting), which is the same shape
 * P2-D used for like settlement.
 */
export interface PostLockBox extends BoxBase {
  boxType: 'post_lock';
  value: bigint;              // Current locked karma (vests per block as likes accumulate)
  originalValue: bigint;      // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array;          // 32 raw bytes — post author's Ed25519 public key
}

// --- Vouch ---

export interface VouchBox extends BoxBase {
  boxType: 'vouch';
  value: 1n;                         // always 1 karma
  voucherId: UserId;                 // who staked the karma
  targetId: UserId;                  // who is being vouched for
}

// --- Vouch escrow ---

/**
 * Where an unvouched stake waits out its cooldown — TYPES_INTERFACE →
 * VouchEscrowBox.
 *
 * ⛔ **`value` IS THE CONSUMED `VouchBox`'S, never `VOUCH_KARMA_AMOUNT`.** The
 * round trip has to be conservation-**structural** rather than true by
 * coincidence, so it must not depend on the cast's pin holding for the box in
 * hand.
 *
 * ⛔ **This is what makes an unvouch conserve.** The value moves from a box the
 * voucher's own transaction consumes into one it creates, so both ends are named
 * inside one transaction and the pool is uninvolved — `ARCHITECTURE → How a
 * source and a sink get named`, first shape. No marker is needed here.
 *
 * ⚠ **`releaseAtBlock` is committed state, and that is the point.** A node
 * holding the `stateRoot` holds the obligation itself rather than a root it
 * cannot interpret without replaying every block.
 *
 * **`owner` is where the karma returns, and nothing else.** Block application is
 * the only spender, so no signature by it unlocks the box — the standing
 * `BondBox.inviterId` and `PostLockBox.owner` already have.
 */
export interface VouchEscrowBox extends BoxBase {
  boxType: 'vouch_escrow';
  value: bigint;              // Exactly what the consumed VouchBox held
  owner: Uint8Array;          // 32 raw bytes — the voucher; where the karma returns
  releaseAtBlock: number;     // Unvouch height + VOUCH_COOLDOWN_BLOCKS
}

// --- Like accrual ---

/**
 * The one marker box in the design — TYPES_INTERFACE → LikeAccrualBox,
 * `ARCHITECTURE → How a source and a sink get named`, third shape.
 *
 * ⛔ **ONE TYPE, TWO LIFETIMES, AND THEY MUST NOT BE CONFLATED.** The settlement
 * consumes both in the same step, which is why they share a type rather than
 * being told apart by a field:
 *
 *   | marker     | the like transaction's output; consumed by the same block's
 *   |            | settlement; one per like, holding `LIKE_KARMA_COST`
 *   | carry box  | the settlement's output; persists across blocks until a payout
 *   |            | consumes it; one per author, holding `value <
 *   |            | LIKES_PER_KARMA_PAYOUT`
 *
 * ⛔ **`author` IS ATTRIBUTION, NOT AUTHORIZATION** — the same distinction
 * `BondBox.inviterId` and `PostLockBox.owner` carry. **No signature by `author`
 * unlocks this box.** Only the settlement transaction consumes it, so no user
 * transition admits one as an input.
 *
 * ⛔ **A MARKER CARRIES ITS VALUE.** A zero-value marker would mean the units it
 * stands for ceased to exist between the transaction and the settlement, which is
 * what `ARCHITECTURE → The conservation axiom`'s "not even as an intermediary
 * step" forbids by name.
 *
 * ⛔ **A LIKE MUST NOT NAME A SHARED BOX.** Two likers of the same author in one
 * block would name the same carry-box id and the second would be **permanently
 * invalid, not deferred** — a popular author becomes unlikeable. Hence a fresh
 * marker per like, and a carry box only the settlement touches.
 *
 * The shape rule that keeps a marker from being an ordinary karma transfer —
 * `likeTarget` present ⟺ exactly one marker of `LIKE_KARMA_COST` naming that
 * target's author — is consensus validation and lives in node's UTXO engine, as
 * the like biconditional already does.
 */
export interface LikeAccrualBox extends BoxBase {
  boxType: 'like_accrual';
  value: bigint;              // LIKE_KARMA_COST on a marker; the running carry on a carry box
  author: Uint8Array;         // 32 raw bytes — the key the accrual is earmarked for
}

// --- Emission ---

/**
 * The whole of a network's credit emission, held as state — TYPES_INTERFACE →
 * EmissionBox.
 *
 * Genesis creates one on every network holding that profile's entire emission
 * total, and each block spends it to a successor holding `value −
 * computeBlockReward(height)`. No other rule reduces it and none increases it,
 * so what remains to be emitted is a value an observer reads rather than a
 * schedule they trust.
 *
 * **No owner, and therefore no trailing fields.** The box names no spender
 * because block application is the only one, so its content encoding is the
 * shared prefix alone (see `canonicalBoxBytes`).
 *
 * ⛔ **A successor whose value would be `0` is not created.** The total equals
 * the schedule's sum exactly, so the last emitting block consumes the box and
 * leaves none; above the terminus no emission box exists and nothing is spent.
 * Without it a zero-value box is removed and reinserted on every block forever.
 *
 * ⚠ **The genesis value is derived from the profile's schedule, never carried
 * in the profile.** A hardcoded total that disagrees with `computeBlockReward`
 * either starves the box before the terminus, making every block from that
 * height unproducible, or strands a residue no rule can release. The
 * derivation is node's (MINING_INTERFACE → Emission Schedule); this package
 * declares only the type.
 */
export interface EmissionBox extends BoxBase {
  boxType: 'emission';
  value: bigint;              // Credits not yet released, in base units
}

// --- Treasury ---

/**
 * Where the coinbase's treasury slice and the forfeited inclusion bonus land —
 * TYPES_INTERFACE → TreasuryBox.
 *
 * Block application spends it to a successor holding `value + split.treasury`,
 * and there is no rule that reduces it. ARCHITECTURE → Treasury requires the
 * treasury be unspendable **by absent rule** rather than by a withheld key, and
 * this is that rule's shape: no key exists, and block application carries no
 * release path to write one out.
 *
 * Genesis creates none — it would hold `0`, which the emission box's rule
 * refuses. The first block whose `split.treasury` is nonzero creates it.
 *
 * **Separate from the emission box, structurally.** A future protocol version
 * gives the treasury a spend gate; held in one box with the emission remainder,
 * that gate's ceiling would be the computable `value − remainingEmission(height)`
 * — which works, and makes the ceiling depend on a schedule sum staying
 * consistent with `computeBlockReward` forever. Two boxes mean no rule lets a
 * treasury spend reach unreleased emission.
 */
export interface TreasuryBox extends BoxBase {
  boxType: 'treasury';
  value: bigint;              // Credits accrued, in base units
}

// --- Fee ---

/**
 * What a credit transaction pays for its inclusion, named as an output so the
 * transaction balances exactly — TYPES_INTERFACE → FeeBox.
 *
 * A credit-side transaction carries zero or one. Block application sums the
 * block's fee boxes into the coinbase's income term and consumes them in the
 * same block (MINING_INTERFACE → Coinbase Application).
 *
 * **No owner, and therefore no trailing fields.** Block application is the only
 * spender, and which key the fee reaches is already decided — the coinbase pays
 * `split.miner`. A field naming the recipient would be a second statement of
 * that, free for a producer to set and never read.
 *
 * ⛔ **A zero-value fee box is not created: zero fee means no box.** Both
 * encodings would express one economic fact with different `utxoTxRoot`, which
 * is the rule `EmissionBox` states for the zero-value successor and the coinbase
 * states for its own outputs. **A transaction carrying no fee box is valid
 * consensus** — no amount is checked anywhere, because the price of inclusion is
 * relay policy and block assembly rather than validity (MEMPOOL_INTERFACE → Fee
 * floor). Both rules are node's; this encoder writes any value in the u64.
 *
 * **At most one per transaction**, for the same one-block-one-encoding reason: a
 * second carries no information a producer could not put in the first.
 *
 * ⚠ **`fee` is not a member of the karma family**, so a fee output on a
 * karma-side transaction is rejected by the karma transition arm rather than by
 * a rule of its own (NODE_INTERFACE → the karma transition rules).
 */
export interface FeeBox extends BoxBase {
  boxType: 'fee';
  value: bigint;              // Credits paid to the block's miner, in base units
}

// --- Karma supply pool ---

/**
 * The whole of a network's karma supply, held as state from height 0 —
 * TYPES_INTERFACE → KarmaPoolBox.
 *
 * Genesis creates exactly one, holding the **maximum STORABLE karma**,
 * `BOX_VALUE_BOUND − 1` (TYPES_INTERFACE → Box value domain). Every mint draws
 * from it and every burn returns to it, so the supply is fixed at that ceiling
 * from the first block and no rule anywhere can inflate it: karma is not scarce
 * by policy, it is non-inflatable by construction.
 *
 * ⛔ **`pool.value + circulating karma == BOX_VALUE_BOUND − 1`, at every height,
 * forever.** That invariant is what makes overflow structurally impossible — a
 * burn can only return what a mint drew, so the pool can never exceed its
 * genesis value. **The binding constraint is the store, not the writer**: that
 * value sits a full bit below what `writeVlqU64OrThrow` refuses, so a pool past
 * it would break the ledger's bind while still encoding cleanly. Genesis
 * committee grants come **out** of the pool rather than alongside it, so it
 * holds from height 0.
 *
 * **No owner, and therefore no trailing fields.** Block application is its only
 * spender and its only producer, so its content encoding is the shared prefix
 * alone (see `canonicalBoxBytes`).
 *
 * ⛔ **It is NOT a karma box.** A karma box is something an identity holds;
 * giving the pool that type would put the maximum supply inside every balance
 * query and every conservation sum in the tree.
 *
 * ⛔ **It is in the CONSERVATION set and in neither of the other two** — not the
 * transition set, not the supply set (NODE_INTERFACE → "Three karma sets, and
 * none derives from another"). The pool is not karma anyone holds, so it is not
 * supply; it is karma that exists, so it is conservation — **that combination is
 * why the third set exists.**
 *
 * ⛔ **A zero-value successor IS created, and this is the one place the
 * `EmissionBox` rule inverts.** Emission terminates, so above the terminus no
 * box exists and nothing is spent. The pool never terminates: burns must always
 * have somewhere to return, so the box exists at every height whatever its
 * value. A reader who pattern-matches to the emission rule here gets it exactly
 * backwards.
 */
export interface KarmaPoolBox extends BoxBase {
  boxType: 'karma_pool';
  value: bigint;              // Karma not in circulation. Genesis: BOX_VALUE_BOUND − 1
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type AnyBox =
  | KarmaBox
  | CreditBox
  | GenesisProofBox
  | BondBox
  | PostLockBox
  | VouchBox
  | VouchEscrowBox
  | LikeAccrualBox
  | EmissionBox
  | TreasuryBox
  | FeeBox
  | KarmaPoolBox;

/** Every box type in its creator-built form — no `id`, no provenance. */
export type AnyBoxCandidate =
  | CandidateOf<KarmaBox>
  | CandidateOf<CreditBox>
  | CandidateOf<GenesisProofBox>
  | CandidateOf<BondBox>
  | CandidateOf<PostLockBox>
  | CandidateOf<VouchBox>
  | CandidateOf<VouchEscrowBox>
  | CandidateOf<LikeAccrualBox>
  | CandidateOf<EmissionBox>
  | CandidateOf<TreasuryBox>
  | CandidateOf<FeeBox>
  | CandidateOf<KarmaPoolBox>;

// ---------------------------------------------------------------------------
// UTXO transaction
// ---------------------------------------------------------------------------

export interface UtxoTransaction {
  inputs: BoxId[];
  /**
   * Candidates, not boxes. A transaction's outputs cannot
   * carry provenance: their `txId` is the id of the very transaction being
   * built, so a signed output with an `id` in it would be circular. Block
   * application materializes them — see node's `materializeOutput`.
   */
  outputs: AnyBoxCandidate[];
  signatures: Record<string, Uint8Array>;  // publicKey (hex) → Ed25519 sig (64 bytes) over txId
  /**
   * ⛔ **THE NAME `preimages` IS RESERVED — never reuse it** (TYPES_INTERFACE →
   * Layout — UtxoTransaction). No transition requires knowledge of a secret.
   *
   * ⛔ **Do not add a secret-carrying field here.** One would have to state what
   * reads it, or it is a consensus surface carrying no meaning — and a field in
   * this list is inside every `TxId`, so adding one moves every transaction id and
   * every box id derived from one. **A field that belongs on the wire alone goes in
   * the wire codec, not in this list**: that costs the wire and no committed hash,
   * which is a different kind of change from this one.
   */
  protocolVersion: number;
  /**
   * Present ⟺ this transaction is a like on the named post (ARCHITECTURE →
   * The like transaction). The field
   * sits inside the `computeTxId` preimage, so the signature covers the
   * target and a relay cannot re-point a like. This package defines only the
   * field and its encoding; the biconditional itself — present ⟺ the tx
   * burns exactly `LIKE_KARMA_COST`, the only legal karma deficit in a user
   * transaction — is consensus validation and lives in node's UTXO engine.
   */
  likeTarget?: PostId;
  /**
   * Present ⟺ this transaction creates a post (NODE_INTERFACE → Post
   * transactions), carrying the post's payload inside the transaction that locks
   * its karma. Same pattern `likeTarget` set: an optional field whose presence is
   * biconditional with a rule.
   *
   * ⛔ **This is what makes the post id derivable.** `postFieldBytes(post)` sits
   * inside the `computeTxId` preimage, so a transaction carrying a distinct post
   * has a distinct id and `computePostId(txId, index)` inherits that uniqueness.
   * It also puts the payload under the author's signature, so a relay cannot
   * rewrite the post any more than it can re-point a like.
   *
   * This package defines only the field and its encoding; the biconditional —
   * present ⟺ the tx locks `POST_LOCK_{THREAD,REPLY}_COST` into a `PostLockBox`
   * and conserves value — is consensus validation and lives in node's UTXO
   * engine.
   */
  post?: Post;
}

/**
 * The transaction-id preimage body — `txIdBytes` in TYPES_INTERFACE → Layout —
 * UtxoTransaction:
 *
 *   | 1 | inputs          | arr(ids, b32)                                |
 *   | 2 | outputs         | arr(candidates, canonicalBoxBytes)           |
 *   | 3 | protocolVersion | vlqU                                         |
 *   | 4 | likeTarget      | opt(b32)                                     |
 *   | 5 | post            | opt(postFieldBytes)                          |
 *
 * ⛔ **FIVE FIELDS, and dropping one RENUMBERS every field after it unless it is
 * last.** This is a positional layout with no keys, so a reader that skips a field
 * but keeps the old offsets reads `protocolVersion` out of `likeTarget`'s tag and
 * every later field one slot early — a silently wrong `TxId`, not a decode error.
 * **The count and the numbering move together in this table, in the
 * `UtxoTransaction` declaration above, and in both halves of the codec** — the
 * same hazard §Layout — Block states for the header, one struct over.
 *
 * **Every field is counted, tagged or length-prefixed, and each one is
 * load-bearing for injectivity:**
 *
 * - `inputs` and `outputs` carry `arr()`'s count prefix. Concatenated without
 *   one, two different output lists could produce identical bytes, since
 *   `canonicalBoxBytes` is variable-length.
 * - `protocolVersion` is `vlqU`. As unprefixed decimal text it would be the
 *   exact M-1 collision pattern, one struct over.
 * - `likeTarget` presence is `opt()`'s 0/1 tag, which needs no in-band marker
 *   that a neighbouring field could forge, and preserves the `!== undefined`
 *   distinction — an empty-string target hashes differently from absence.
 * - `post` takes the same `opt()` tag, for the same reason, and needs no length
 *   prefix inside it: `postFieldBytes` is self-delimiting (every field is
 *   fixed-width, length-prefixed or a VLQ) and it is last, so nothing follows it
 *   to be ambiguous against. Its own injectivity is `postFieldBytes`'
 *   (`post.ts`), which is why that property is required there even though the
 *   post id no longer reads those bytes.
 * ⚠ **`likeTarget` and `post` are mutually exclusive in practice** — a
 * transaction is a like or a post, never both — but the encoding does not rest on
 * it: each carries its own presence tag, so the tail stays unambiguous however
 * the fields combine.
 *
 * Signatures are absent and stay absent: they are Ed25519 *over* this id.
 *
 * ⛔ **THIS IS THE ONLY STATEMENT OF THESE SIX FIELDS, and `encodeTx` reaches it
 * rather than repeating it.** The wire codec is exactly these bytes plus
 * `arr(signatures sorted, b32(pubkey) ‖ b64(sig))` (TYPES_INTERFACE → Layout —
 * UtxoTransaction, the wire-codec row), so the id preimage and the wire form
 * share one writer and cannot drift — the same delegation `boxRecordBytes` makes
 * to `canonicalBoxBytes`. A second statement of a layout in a second function is
 * the drift class this format exists to close, and it round-trips perfectly under
 * a consistent transposition, so no round-trip test could see it.
 */
export function writeTxIdFields(w: ByteWriter, tx: UtxoTransaction): void {
  writeArr(w, tx.inputs, (ww, id) => writeHexNOrThrow(ww, id, 32));
  writeArr(w, tx.outputs, (ww, out) => ww.writeBytes(canonicalBoxBytes(out)));
  writeVlqU(w, tx.protocolVersion);
  // `undefined` and `null` both take the absent branch — `writeOpt`'s job.
  writeOpt(w, tx.likeTarget, (ww, target) => writeHexNOrThrow(ww, target, 32));
  writeOpt(w, tx.post, (ww, post) => ww.writeBytes(postFieldBytes(post)));
}

/**
 * The inverse of `writeTxIdFields` — the six preimage fields, read back.
 *
 * **Adjacent to the writer for the reason every pair in this format is**: field
 * order is normative and a reader that walks it differently is a consensus
 * divergence with no compiler signal (TYPES_INTERFACE → Primitives).
 *
 * It takes a reader rather than bytes because it is read **inline**: these fields
 * are the head of `encodeTx`, which appends the signature array after them, so
 * the wire codec holds the signature tail and nothing else. The boundary check
 * belongs to the enclosing `decodeStruct`.
 *
 * `readOpt` answers `null` for an absent option and the fields are optional, so
 * `undefined` is the type-correct spelling of absent and it is what re-encodes to
 * the same `u8(0)` — the mapping `readBoxContentFields` already makes for
 * `nonActivity`, and what keeps the re-encode compare closable.
 */
export function readTxIdFields(r: ByteReader): Omit<UtxoTransaction, 'signatures'> {
  return {
    inputs: readArr(r, (rr) => readHexN(rr, 32)),
    outputs: readArr(r, readBoxContentFields),
    protocolVersion: readVlqU(r),
    likeTarget: readOpt(r, (rr) => readHexN(rr, 32)) ?? undefined,
    post: readOpt(r, readPostFields) ?? undefined,
  };
}

function txIdBytes(tx: UtxoTransaction): Uint8Array {
  const w = new ByteWriter();
  writeTxIdFields(w, tx);
  return w.toBytes();
}

/**
 * Deterministic transaction ID: `blake2b512(TX_ID_DOMAIN ‖ txIdBytes)[0:32]`.
 *
 * Outputs go through `canonicalBoxBytes`, so identity has exactly **one** box
 * encoding rather than two that must be kept in agreement. Node's
 * `materializeOutput` sets `txId`/`index` on outputs, so a local
 * `{ id, ...rest }` strip here would hash provenance into the very txId that
 * provenance derives from — circular, and it would make a transaction's id
 * depend on ids that cannot exist until that id is known. Under this encoder
 * those fields are not merely stripped: they have no writer.
 *
 * `TX_ID_DOMAIN` separates this preimage. Box ids, transaction ids and
 * identity-record keys share one 32-byte keyspace and the AVL tree holds two
 * entity kinds, so the separation has to be in the preimage. This is also **the
 * only implementation**, and must stay so — a second one that omitted the tag
 * would verify signatures against an untagged id while every builder signed a
 * tagged one.
 *
 * ⚠ **This function throws on an out-of-domain transaction.** `checkTxEnvelope`
 * establishes the domain of `inputs` and `likeTarget` (both pinned at 64
 * lowercase hex) — but it deliberately does **not** type the
 * output entries, and `checkOutputShape` runs later, at `validateTx` step 4.
 * At `block-apply.ts`'s embedded-tx path only the envelope has run, so an
 * output carrying a `value` outside the u64 or a 31-byte `owner` reaches a
 * throwing writer there. TYPES_INTERFACE → Totality books an explicit domain
 * check at that call site; the obligation is **wider than the `bigint` the
 * contract names** — it covers every fixed-width output field.
 */
export function computeTxId(tx: UtxoTransaction): TxId {
  return createHash('blake2b512')
    .update(TX_ID_DOMAIN)
    .update(txIdBytes(tx))
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

// ---------------------------------------------------------------------------
// Box selection
// ---------------------------------------------------------------------------

/**
 * Largest-first UTXO selection. Returns the minimal subset of boxes whose
 * combined value covers `requiredAmount`. Assumes boxes are pre-sorted by
 * value descending. Throws if the total value of all boxes is insufficient.
 */
export function selectBoxes<T extends { value: bigint }>(
  boxes: T[],
  requiredAmount: bigint,
): T[] {
  if (requiredAmount <= 0n) return [];

  let accumulated = 0n;
  const selected: T[] = [];
  for (const box of boxes) {
    accumulated += box.value;
    selected.push(box);
    if (accumulated >= requiredAmount) break;
  }

  if (accumulated < requiredAmount) {
    throw new Error('Insufficient total value');
  }

  return selected;
}
