import { createHash } from 'crypto';
import { ByteReader, ByteWriter, ReaderError } from '@dagsocial/wire';
import { MAX_GENESIS_PROOF_PAYLOAD_BYTES } from './constants.js';
import {
  u32BE,
  type StructCodec,
  decodeStruct,
  encodeStruct,
  enum8,
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
import { postFieldBytes, type Post, type PostId } from './post.js';

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
  invite: 2,
  genesis_proof: 3,
  bond: 4,
  post_lock: 5,
  vouch: 6,
  emission: 7,
  treasury: 8,
  fee: 9,
  karma_pool: 10,
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
 *   enum8(boxType) ‖ vlqU64(value) ‖ <per-type>
 *
 *   | karma         | b32(owner) ‖ opt(decayBurn)                                |
 *   | credit        | b32(owner) ‖ opt(lockedUntilBlock)                         |
 *   | invite        | b32(inviterId) ‖ b32(inviteePublicKey)                     |
 *   | genesis_proof | lp(payload)                                               |
 *   | bond          | b32(inviterId) ‖ b32(inviteePublicKey)                     |
 *   | post_lock     | vlqU64(originalValue) ‖ b32(owner)                         |
 *   | vouch         | b32(voucherId) ‖ b32(targetId)                            |
 *   | emission      | (none)                                                    |
 *   | treasury      | (none)                                                    |
 *   | fee           | (none)                                                    |
 *   | karma_pool    | (none)                                                    |
 *
 * **`emission`, `treasury`, `fee` and `karma_pool` stop after the prefix**, and
 * an empty cell above is a layout rather than an omission (TYPES_INTERFACE →
 * Layout — Boxes). None of the four names an owner, so there is no trailing
 * field to write and the smallest legal box of any type is two bytes.
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
 * domain, so no sentinel is unreachable — an all-ones u64 is a legal value, and
 * writing it to mean "malformed" would give a malformed box a well-formed box's
 * id. The fixed-width `b32` fields throw for the same structural reason. Their
 * domain is `checkOutputShape`'s (node, `validateTx` step 4); see the note on
 * `computeTxId` for the one call site where that gate has not run yet.
 *
 * **`invite` and `bond` carry identical trailing fields** (TYPES_INTERFACE →
 * Layout — Boxes). `enum8(boxType)` is field 1, so the tag is what makes the
 * encoding injective across the two; `value` happens to differ as well — an
 * invite is always `0` — but nothing may rely on that. It is the standing
 * `karma` and `credit` already have. **`emission`, `treasury`, `fee` and
 * `karma_pool` stand in the same relation with no fields at all**, so at equal
 * `value` the tag is the whole of the difference and their ids part on the
 * provenance `computeBoxId` appends.
 *
 * ⚠ **`vlqU64`, not `vlqU`, in the table above** — `value` and
 * `post_lock.originalValue` are `bigint`, so they take `writeVlqU64OrThrow`.
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
  writeBoxTypeFields(w, candidate as AnyBoxCandidate);
  return w.toBytes();
}

/** The per-type tail of `canonicalBoxBytes`. Field order is normative. */
function writeBoxTypeFields(w: ByteWriter, box: AnyBoxCandidate): void {
  switch (box.boxType) {
    case 'karma':
      writeBytesNOrThrow(w, box.owner, 32);
      writeOpt(w, box.decayBurn, writeBool);
      return;
    case 'credit':
      writeBytesNOrThrow(w, box.owner, 32);
      writeOpt(w, box.lockedUntilBlock, writeVlqU);
      return;
    case 'invite':
      writeBytesNOrThrow(w, box.inviterId, 32);
      writeBytesNOrThrow(w, box.inviteePublicKey, 32);
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
 * `decayBurn?: boolean` and `lockedUntilBlock?: number` are optional, so
 * `undefined` is the type-correct spelling of absent and it is what re-encodes to
 * the same `u8(0)`.
 */
function readBoxContentFields(r: ByteReader): DecodedBoxCandidate {
  const boxType = BOX_TYPE.read(r);
  const value = readVlqU64(r);
  switch (boxType) {
    case 'karma':
      return {
        boxType,
        value,
        owner: readBytesN(r, 32),
        decayBurn: readOpt(r, readBool) ?? undefined,
      };
    case 'credit':
      return {
        boxType,
        value,
        owner: readBytesN(r, 32),
        lockedUntilBlock: readOpt(r, readVlqU) ?? undefined,
      };
    case 'invite':
      return {
        boxType,
        value,
        inviterId: readBytesN(r, 32),
        inviteePublicKey: readBytesN(r, 32),
      };
    case 'genesis_proof': {
      const payload = readLp(r);
      // The payload bound, and this arm is the whole of it — `readLp` is the
      // shared primitive behind every `lp` field in the format, so a bound
      // there would bind `tx.preimages`, `utxoTxs` and the block's three
      // sections along with this one.
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
      return { boxType, value: value as 0n, payload };
    }
    case 'bond':
      return {
        boxType,
        value,
        inviterId: readBytesN(r, 32),
        inviteePublicKey: readBytesN(r, 32),
      };
    case 'post_lock':
      return {
        boxType,
        value,
        originalValue: readVlqU64(r),
        owner: readBytesN(r, 32),
      };
    case 'vouch':
      return {
        boxType,
        value: value as 1n,
        voucherId: readBytesN(r, 32),
        targetId: readBytesN(r, 32),
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
      return { boxType, value };
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
 * Why a box created by block application rather than by a user transaction
 * still has one — coinbase, karma mints, decay, post-lock vesting, genesis,
 * prune settlement. The discriminant is semantic, never positional: deriving it
 * from journal position would put ordering back into *identity*, which is the
 * failure class M-12 closed for the AVL feed.
 *
 * Subject bytes are the caller's, per `NODE_INTERFACE.md`'s reason/subject
 * table; this package never sees a postId.
 *
 * `like-payout` settles likes per block (ARCHITECTURE → Per-block accrual and
 * settlement): one mint per author per block, subject = the raw author key.
 *
 * The three invite reasons all take the invitee's public key as subject, and a
 * key is invited **at most once** — an invite may not name an existing account
 * and a claim makes the invitee one (NODE_INTERFACE → Bond transition rules) —
 * so each `(reason, subject)` pair occurs at most once in the whole history,
 * without reading the height at all. `invite-claim` is the only reason on the
 * table that *increases* karma supply; `bond-settle` and `bond-return` re-mint
 * what a `BondBox` already held, in the sense `vouch-settle` re-mints an escrow.
 *
 * `emission-release` and `treasury-accrue` take an **empty** subject, and
 * `lp(subject)` writes that as a zero length rather than as an absence. Exactly
 * one emission successor and one treasury successor exist per height, so the
 * height alone separates every instance within a reason and the tag byte
 * separates the reasons — nothing is derived from a position in the block.
 * Neither creates credits: both name a box that block application spends and
 * recreates (NODE_INTERFACE → Reason and subject table).
 *
 * `genesis-committee` keys on the **member** — the raw 32-byte public key, one
 * karma box per `genesisCommitteeKeys` entry, drawn out of the karma pool. The
 * `genesis` reason cannot carry it: that subject is `u32BE(k)`, one number per
 * genesis box, so every member would share one synthetic txId (NODE_INTERFACE →
 * Reason and subject table).
 *
 * **Retired reasons — reserved, never reuse:** `'author-reward'`,
 * `'liker-refund'` and `'prune-refund-liker'` (likes are one-way burns, so
 * prune settlement refunds no liker). None of them holds a number in
 * `MINT_REASON`, so there is no tag of theirs to burn — but see `MINT_REASON`
 * for the rule that applies to the next retirement.
 */
export type MintReason =
  | 'coinbase'
  | 'vouch-settle'
  | 'like-payout'
  | 'postlock-unlock'
  | 'postlock-remainder'
  | 'decay'
  | 'genesis'
  | 'prune-refund-author'
  | 'invite-claim'
  | 'bond-settle'
  | 'bond-return'
  | 'emission-release'
  | 'treasury-accrue'
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
 * **Tags reserve retired values and are never renumbered** (TYPES_INTERFACE →
 * Primitives). A renumber
 * moves every mint txId carrying the tag and, through `computeCandidateBoxId`,
 * every box id minted under it — with no compiler signal. Reserve by leaving the
 * number out of this table; never reuse it.
 */
const MINT_REASON = enum8<MintReason>('mintReason', {
  coinbase: 0,
  'vouch-settle': 1,
  'like-payout': 2,
  'postlock-unlock': 3,
  'postlock-remainder': 4,
  decay: 5,
  genesis: 6,
  'prune-refund-author': 7,
  'invite-claim': 8,
  'bond-settle': 9,
  'bond-return': 10,
  'emission-release': 11,
  'treasury-accrue': 12,
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
  // `'like'` is a retired box type — string reserved, never reuse. A new box
  // type wearing the name would make old-vs-new greps and historical debugging
  // ambiguous forever.
  boxType: 'karma' | 'credit' | 'invite' | 'genesis_proof' | 'bond' | 'post_lock' | 'vouch'
    | 'emission' | 'treasury' | 'fee' | 'karma_pool';
  value: bigint;        // integer base units, uniform across box types; value < 2^64 is the `vlqU` wire domain
  // ⚠ **`< 2^64` above is the ENCODABLE domain, and it is wider than the
  // accepted one.** Consensus admits `[0, BOX_VALUE_BOUND)` (`constants.ts`),
  // which node and validation enforce; no encoder here narrows to it.
  // **`createdAtBlock` is not a box field** (TYPES_INTERFACE → BoxId). An
  // apply-mutated field in the candidate makes the id dishonest: the box the
  // store holds stops matching its own derivation. The node records the settled
  // height in a `created_at_block` store column, which consensus code must never
  // read — it is not committed in the `stateRoot`, so a node bootstrapping from
  // an AVL snapshot cannot reconstruct it. The decay clock reads a committed
  // per-identity record.
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
  decayBurn?: boolean;
}

// --- Credit ---

export interface CreditBox extends BoxBase {
  boxType: 'credit';
  owner: Uint8Array;          // 32 raw bytes
  lockedUntilBlock?: number;  // Block height before which credits cannot be spent
}

// --- Invite ---

/**
 * A named right to mint — TYPES_INTERFACE → InviteBox.
 *
 * **The box carries no value because the karma does not exist yet.** It is held
 * open until one of the two keys it names acts: the invitee spends it into a
 * `KarmaBox` of `INVITE_KARMA_AMOUNT`, which is where the mint happens, or the
 * inviter spends it to nothing and takes their bond back through block
 * application.
 *
 * **An invite never expires.** With no deadline there is no sweep and no
 * `expiryBlock` field; it stays claimable until the inviter cancels, and their
 * bond stays locked for exactly that long. `K / INVITE_BOND_KARMA` bounds an
 * account's concurrent invites, which is what makes the rate limit self-enforcing
 * without a rule.
 */
export interface InviteBox extends BoxBase {
  boxType: 'invite';
  value: bigint;                   // Always 0 — a claim ticket, not a container
  inviterId: UserId;               // May cancel
  inviteePublicKey: Uint8Array;    // 32 raw bytes — may claim; the key INVITE_KARMA_AMOUNT mints to
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
 * **A `BondBox` is byte-identical from creation to the block that consumes it**,
 * and the field list is what makes that true. An address can be invited only
 * once, so `inviteePublicKey` names the paired invite by itself: no box id, no
 * output index, no provenance walk. It carries no probation fields either — the
 * window runs from the **claim**, and that height is already committed as
 * `IdentityRecord.invitedAtBlock` (NODE_INTERFACE → Identity Records).
 *
 * **There is no `originalValue`,** and the contrast with `PostLockBox` is the
 * reason: a post lock vests per block, so its current and initial values differ.
 * A bond settles **once**, for `min(floor(inviteeLifetimeLikes /
 * INVITE_BOND_VEST_PER_LIKES), value)` — a pure function of a lifetime count, so
 * one evaluation is arithmetically identical to accumulated instalments and no
 * partial state exists to record.
 *
 * **Nothing spends a bond.** Creation, claim, cancellation and settlement all
 * move it through block application, so no transition admits it into a user
 * transaction — the same standing `PostLockBox` has.
 */
export interface BondBox extends BoxBase {
  boxType: 'bond';
  value: bigint;                   // B karma deposited by the inviter
  inviterId: UserId;               // Owner — the inviter
  inviteePublicKey: Uint8Array;    // 32 raw bytes — set at creation, the key the paired invite names
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
 * ⛔ **It is NOT a karma box, and it belongs to NEITHER karma set** — not the
 * transition set, not the supply set (NODE_INTERFACE → "Two karma sets, and
 * neither derives from the other"). A karma box is something an identity holds;
 * giving the pool that type would put the maximum supply inside every balance
 * query and every conservation sum in the tree.
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
  | InviteBox
  | GenesisProofBox
  | BondBox
  | PostLockBox
  | VouchBox
  | EmissionBox
  | TreasuryBox
  | FeeBox
  | KarmaPoolBox;

/** Every box type in its creator-built form — no `id`, no provenance. */
export type AnyBoxCandidate =
  | CandidateOf<KarmaBox>
  | CandidateOf<CreditBox>
  | CandidateOf<InviteBox>
  | CandidateOf<GenesisProofBox>
  | CandidateOf<BondBox>
  | CandidateOf<PostLockBox>
  | CandidateOf<VouchBox>
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
   * ⛔ **No consumer.** No transition requires knowledge of a secret, so nothing
   * reads this map — but it stays field 3 of the encoding, sorted by key and
   * hashed into every `TxId`, so it is a consensus surface that carries no
   * meaning. Removing it changes every transaction id, which is why it goes with
   * the transaction-representation work (TYPES_INTERFACE → Layout —
   * UtxoTransaction). Until then it is encoded, validated for envelope shape, and
   * never consulted.
   */
  preimages?: Record<string, Uint8Array>;  // boxId → hash preimage
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
 *   | 3 | preimages       | opt(arr(sorted, b32(boxId) ‖ lp(preimage)))  |
 *   | 4 | protocolVersion | vlqU                                         |
 *   | 5 | likeTarget      | opt(b32)                                     |
 *   | 6 | post            | opt(postFieldBytes)                          |
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
 * - `preimages` is sorted by key, per the normative map sort. Keys are
 *   lowercase hex, so sorting the strings and sorting the decoded bytes give
 *   the same order.
 *
 * ⚠ **`likeTarget` and `post` are mutually exclusive in practice** — a
 * transaction is a like or a post, never both — but the encoding does not rest on
 * it: each carries its own presence tag, so the tail stays unambiguous however
 * the fields combine.
 *
 * Signatures are absent and stay absent: they are Ed25519 *over* this id.
 */
function txIdBytes(tx: UtxoTransaction): Uint8Array {
  const w = new ByteWriter();
  writeArr(w, tx.inputs, (ww, id) => writeHexNOrThrow(ww, id, 32));
  writeArr(w, tx.outputs, (ww, out) => ww.writeBytes(canonicalBoxBytes(out)));
  // `undefined` and `null` both take the absent branch — `writeOpt`'s job.
  writeOpt(w, tx.preimages, (ww, preimages) => {
    const sortedKeys = Object.keys(preimages).sort();
    writeArr(ww, sortedKeys, (www, boxId) => {
      writeHexNOrThrow(www, boxId, 32);
      writeLp(www, preimages[boxId]!);
    });
  });
  writeVlqU(w, tx.protocolVersion);
  writeOpt(w, tx.likeTarget, (ww, target) => writeHexNOrThrow(ww, target, 32));
  writeOpt(w, tx.post, (ww, post) => ww.writeBytes(postFieldBytes(post)));
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
 * establishes the domain of `inputs`, the `preimages` keys and `likeTarget`
 * (all pinned at 64 lowercase hex) — but it deliberately does **not** type the
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
