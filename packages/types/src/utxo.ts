import { createHash } from 'crypto';
import { ByteReader, ByteWriter } from '@dagsocial/wire';
import {
  type StructCodec,
  decodeStruct,
  encodeStruct,
  enum8,
  readBool,
  readBytesN,
  readHexN,
  readLpUtf8,
  readOpt,
  readVlqS,
  readVlqU,
  readVlqU64,
  writeArr,
  writeBool,
  writeBytesNOrThrow,
  writeHexNOrThrow,
  writeLp,
  writeLpUtf8,
  writeOpt,
  writeVlqS,
  writeVlqU,
  writeVlqU64OrThrow,
} from './codec.js';
import type { UserId } from './identity.js';
import type { PostId } from './post.js';

// ---------------------------------------------------------------------------
// Box identity
// ---------------------------------------------------------------------------

export type BoxId = string;
export type TxId = string;

const encoder = new TextEncoder();

/**
 * Domain separators (Spec G).
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
 * The `boxType` tag table.
 *
 * **Tag 3 is permanently burnt** for the retired `like` box type. Reserving a
 * retired tag rather than renumbering is not tidiness: `boxType` is the first
 * byte of every box's identity preimage, so a renumber silently moves every box
 * id and every `stateRoot` covering them, with no compiler signal. That is the
 * T2b `0x03` lesson (node's `serialize-box.ts` removed a tag without
 * renumbering for exactly this reason), now applying inside the id preimage
 * itself. Reserve by leaving the number out of this table; never reuse it.
 */
const BOX_TYPE = enum8<BoxCandidate['boxType']>('boxType', {
  karma: 0,
  credit: 1,
  invite: 2,
  // 3 — reserved, retired `like`. Never reuse.
  bond: 4,
  post_lock: 5,
  vouch: 6,
});

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
 *   | karma     | b32(owner) ‖ lpUtf8(proofSource) ‖ opt(decayBurn)          |
 *   | credit    | b32(owner) ‖ vlqS(proofSource) ‖ opt(lockedUntilBlock)     |
 *   | invite    | b32(secretHash) ‖ b32(inviterId)                          |
 *   | bond      | b32(inviterId) ‖ vlqU(inviteOutputIndex)                   |
 *   |           |   ‖ opt(b32(inviteePublicKey)) ‖ vlqU(probationStartBlock) |
 *   |           |   ‖ vlqU(probationEndBlock)                               |
 *   | post_lock | vlqU64(originalValue) ‖ b32(owner) ‖ b32(targetPostId)     |
 *   | vouch     | b32(voucherId) ‖ b32(targetId)                            |
 *
 * **`guard` is gone from the consensus bytes (P2-C row C10).** It is a pure
 * function of `boxType` — one guard string per type, with no box choosing
 * between two — so it carried zero information in a preimage while costing 16
 * to 30 bytes in every box id (the key name plus the guard string). The field
 * stays on the interfaces; it simply stops being hashed.
 *
 * **Provenance is structurally absent**, not stripped at runtime. The old form
 * destructured `id`/`txId`/`index` out of the object and CBOR-encoded the rest,
 * so "provenance is not in the candidate bytes" was a rule someone had to
 * remember; here there is no branch that could write them. `computeBoxId` binds
 * provenance by appending it *after* these bytes, which is what keeps the
 * derivation non-circular.
 *
 * **Key order is not a thing any more.** The G3b `sortKeys` pass existed
 * because cbor-x emitted map keys in JS insertion order, making a producer's
 * field order consensus-visible; a positional format has fixed field order, so
 * that whole class is retired by construction rather than by a sort. A stray
 * extra key on a box object is likewise unrepresentable now — the encoder reads
 * the fields it declares and nothing else.
 *
 * ## Totality
 *
 * Total for an unknown `boxType`: `enum8` writes the reserved `0xff` sentinel
 * and no per-type fields follow, so a malformed box still encodes and can never
 * collide with a well-formed one (no valid tag is `0xff`). Two *malformed*
 * boxes with different bogus types do share bytes — the same malformed-only
 * residue the numeric sentinel has.
 *
 * **`value` throws** outside `[0, 2^64)`, and that is the spec's one originally
 * stated exception (§2.5, layout D6): `value: bigint` spans the entire u64 wire
 * domain, so no sentinel is unreachable — an all-ones u64 is a legal value, and
 * writing it to mean "malformed" would give a malformed box a well-formed box's
 * id. The fixed-width `b32` fields throw for the same structural reason. Their
 * domain is `checkOutputShape`'s (node, `validateTx` step 4); see the note on
 * `computeTxId` for the one call site where that gate has not run yet.
 *
 * **One field is not fixed-width**: `bond.inviteePublicKey` is 0-or-32 bytes and
 * therefore `opt(b32)` — see `writeOptBytesNOrThrow`.
 *
 * ⚠ **`vlqU64`, not `vlqU`, in the table above** — `value` and
 * `post_lock.originalValue` are `bigint`, so they take `writeVlqU64OrThrow`.
 * The bytes are identical over the overlapping range, which is why writing
 * `vlqU` here was harmless to read and wrong to rely on: `vlqU` is total by
 * sentinel and `vlqU64` throws, and spec §2.5 names the `…OrThrow` writers
 * precisely so the totality exception is visible at the call site rather than
 * inferred from a field's type. Found by Phase 5 hand-deriving goldens off the
 * contract; the contract's own cells are corrected too.
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
      // `lpUtf8`, not `b32`: verified against the producers, not inferred from
      // the type. Production stamps `mint-<height>`, `decay-<height>`,
      // `faucet:system`, `genesis:system` and `invite-cancel:<id>` here, and
      // node's own output-shape schema types it as a free `'string'`. A `b32`
      // would throw on every karma mint the node performs.
      writeLpUtf8(w, box.proofSource);
      writeOpt(w, box.decayBurn, writeBool);
      return;
    case 'credit':
      writeBytesNOrThrow(w, box.owner, 32);
      // `vlqS`, not `vlqU`: this carries `-1`, the transfer sentinel stamped on
      // every user-path credit box (`heightOrTransfer`, node's
      // `routes/utxo.ts`). A `vlqU` would sentinel every one of them.
      writeVlqS(w, box.proofSource);
      writeOpt(w, box.lockedUntilBlock, writeVlqU);
      return;
    case 'invite':
      writeBytesNOrThrow(w, box.secretHash, 32);
      writeBytesNOrThrow(w, box.inviterId, 32);
      return;
    case 'bond':
      writeBytesNOrThrow(w, box.inviterId, 32);
      writeVlqU(w, box.inviteOutputIndex);
      // `opt(b32)`, not `b32`: this field is 0-or-32 bytes. See below.
      writeOptBytesNOrThrow(w, box.inviteePublicKey, 32);
      writeVlqU(w, box.probationStartBlock);
      writeVlqU(w, box.probationEndBlock);
      return;
    case 'post_lock':
      writeVlqU64OrThrow(w, box.originalValue);
      writeBytesNOrThrow(w, box.owner, 32);
      writeHexNOrThrow(w, box.targetPostId, 32);
      return;
    case 'vouch':
      writeBytesNOrThrow(w, box.voucherId, 32);
      writeBytesNOrThrow(w, box.targetId, 32);
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
 * **`guard` is not returned**, because it is not in the bytes (C10). It is a
 * pure function of `boxType` — each box interface types it as a single literal —
 * so a consumer that needs it synthesises it from the discriminator. Returning
 * it here would have this package assert an authorization fact it does not own,
 * and would put the guard table in two places.
 *
 * Two absences are mapped rather than passed through, and both are what make the
 * re-encode compare close:
 *
 * - `opt` fields decode to `undefined`, not `null`. `decayBurn?: boolean` and
 *   `lockedUntilBlock?: number` are optional, so `undefined` is the type-correct
 *   spelling of absent and it is what re-encodes to the same `u8(0)`.
 * - `bond.inviteePublicKey` decodes absent as **empty bytes**, inverting the
 *   encoder's empty-↔-absent mapping for a 0-or-32-byte field. A reader
 *   returning `undefined` there would fail the boundary check on every
 *   unclaimed bond.
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
        proofSource: readLpUtf8(r),
        decayBurn: readOpt(r, readBool) ?? undefined,
      };
    case 'credit':
      return {
        boxType,
        value,
        owner: readBytesN(r, 32),
        proofSource: readVlqS(r),
        lockedUntilBlock: readOpt(r, readVlqU) ?? undefined,
      };
    case 'invite':
      return {
        boxType,
        value,
        secretHash: readBytesN(r, 32),
        inviterId: readBytesN(r, 32),
      };
    case 'bond':
      return {
        boxType,
        value,
        inviterId: readBytesN(r, 32),
        inviteOutputIndex: readVlqU(r),
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
      return {
        boxType,
        value: value as 1n,
        voucherId: readBytesN(r, 32),
        targetId: readBytesN(r, 32),
      };
  }
}

/**
 * `opt(b32(x))` over a field whose *absence* is spelled **empty bytes** in
 * memory — `bond.inviteePublicKey`, and it is the only one in the box arms.
 *
 * The field is **0-or-32 bytes**, not 32: empty = unclaimed, 32 bytes =
 * committed (`BondBox` below, and TYPES_INTERFACE → BondBox). Invite creation
 * *requires* it empty — node's engine rejects an invite-create whose bond output
 * carries a key, because a pre-committed bond would let the inviter reclaim
 * immediately and make the network's only sybil cost free. So a fixed-width
 * `b32` here threw on the create path, which is to say on **every invite the
 * node makes**: dead in production, not merely in fixtures.
 *
 * **The in-memory type does not change.** Empty ↔ absent is this encoder's
 * mapping; `inviteePublicKey: Uint8Array` stays, and node's `bytes0or32`
 * output-shape entry stays the domain gate.
 *
 * Three things this shape buys, none of them incidental:
 *
 * - **`opt`, not `lp`.** Identical byte cost, but `lp` would round-trip a
 *   5-byte value and leave the 0-or-32 domain entirely to validation. `opt(b32)`
 *   makes it structural: a decoder can produce absence or exactly 32 bytes, and
 *   there is no third thing to reject.
 * - **Injectivity, both directions.** Unclaimed ↔ `00`; committed ↔
 *   `01 ‖ bytes`. The tags differ in the first byte, so no committed bond shares
 *   an encoding with an uncommitted one, and `01` is always followed by exactly
 *   32 bytes so no two committed bonds share one either.
 * - **`writeOpt`'s own null/undefined coercion must not fire here.** A *missing*
 *   field is out of domain, not unclaimed, and letting it take the absent branch
 *   would give a malformed box a well-formed box's id — precisely the collision
 *   `canonicalBoxBytes`' totality note refuses for `value`. So the absence test
 *   is "byte view of length zero" and nothing else; anything that is not a
 *   `Uint8Array` goes to the present branch and reaches the throwing writer,
 *   where the other fixed-width fields already send it.
 *
 * `writeOpt` writes the tag rather than this function hand-rolling `0x00`/`0x01`,
 * so the option encoding has one definition and cannot drift from the three
 * sibling fields already using it (`karma.decayBurn`, `credit.lockedUntilBlock`,
 * `tx.likeTarget`). The one-field wrapper is what keeps that coercion
 * unreachable while still going through it: a wrapper object is never `null` or
 * `undefined`, whatever it holds.
 *
 * @throws {Error} if `bytes` is present-but-not-`n`-bytes, or not a byte view
 */
function writeOptBytesNOrThrow(w: ByteWriter, bytes: Uint8Array, n: number): void {
  const unclaimed = bytes instanceof Uint8Array && bytes.length === 0;
  writeOpt(w, unclaimed ? undefined : { present: bytes }, (ww, wrapped) => {
    writeBytesNOrThrow(ww, wrapped.present, n);
  });
}

/**
 * Write `n` as 4 bytes big-endian.
 *
 * Deliberately *total*: a value outside the encodable domain writes the
 * all-ones sentinel rather than throwing, so a malformed value can never turn
 * id derivation into a panic on untrusted input (audit M-5). The encodable
 * domain excludes the sentinel itself, so a well-formed value never collides
 * with a malformed one.
 *
 * ⚠ **Nothing in THIS package hashes a `u32BE` any more.** Phase 2a-ii moved
 * the last two — `computeCandidateBoxId`'s `index` and `computeMintTxId`'s
 * `height` — onto `vlqU`. It survives for one reason only:
 *
 * **Two mint `subject` encodings are `u32BE`, and subjects are the caller's.**
 * `coinbase` and `genesis` encode a `u32BE` selector
 * (`node/src/mint-provenance.ts`), `computeMintTxId` takes those bytes
 * opaquely, and `NODE_INTERFACE.md`'s reason/subject table is what mandates the
 * form. Exporting one implementation is the only way to stop node reimplementing
 * it and drifting — a silent divergence would move mint txIds, and through them
 * every box id, with nothing to catch it.
 *
 * So this is now a **caller-side helper, not part of any preimage this package
 * writes**, and the subject encodings are the one place the old dialect still
 * reaches an id. Unifying them is `NODE_INTERFACE`'s call, not this file's.
 */
const U32_SENTINEL = 0xffffffff;

export function u32BE(n: number): Uint8Array {
  const encodable = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < U32_SENTINEL;
  const v = encodable ? n : U32_SENTINEL;
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

/**
 * A box **with its provenance** — TYPES_INTERFACE → Layout — Boxes (D4):
 *
 *   boxRecordBytes = canonicalBoxBytes(candidate) ‖ b32(txId) ‖ vlqU(index)
 *
 * The contract names two box encodings and separates them so that "provenance
 * is not in the id" is structural rather than a runtime strip somebody has to
 * remember: `canonicalBoxBytes` is what `computeBoxId` and `computeTxId` hash,
 * and **this** is what the AVL value and the store hold. The `id` is never
 * encoded — it *is* the hash of these bytes under `BOX_ID_DOMAIN`.
 *
 * It was written inline inside `computeCandidateBoxId` until Phase 3b, on the
 * ground that a second copy could drift from the id's preimage. Extracting it
 * removes that risk rather than taking it on: the id derivation below now calls
 * this function, so the AVL value and the box id are the same bytes by
 * construction and not by two implementations agreeing.
 *
 * **`txId` crosses as 32 raw bytes, not as the UTF-8 of its hex text** (Phase
 * 2a-ii). The prior form was argued for on two grounds, and the positional
 * format answers both somewhere better:
 *
 * - *"a hex decode throws on a malformed txId, so text keeps this total"* — true,
 *   and now deliberate. `b32` throws, and the domain is established at every
 *   call site instead: every `txId` reaching here is a `.toString('hex')` output
 *   of `computeTxId` or `computeMintTxId`, so it is 64 lowercase hex by
 *   construction. A throwing writer with an established domain is the format's
 *   standard trade (spec §2.5), not an exception.
 * - *"decoding would map `AB…`/`ab…` onto one id"* — the collision is removed
 *   rather than tolerated: `b32` accepts lowercase only, so an uppercase id has
 *   **no encoding at all** instead of sharing one.
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
 * (spec §2.1): schema projection, exhaustion, and the re-encode compare that
 * rejects a non-minimal VLQ. Truncation and an unknown `boxType` tag come from
 * the readers themselves. So a value the store hands back is not merely
 * parseable — it is the *only* byte string that decodes to it.
 *
 * **`candidate.guard` is absent**, per C10: it is not in the bytes and it is a
 * pure function of `boxType`. See `readBoxContentFields`.
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
 * A box candidate as the **bytes** carry it — every per-type field except
 * `guard`, which C10 removed from the encoding.
 *
 * The omission is applied per union member, not to the union: `Omit` on a union
 * collapses it to the common keys, which here would leave `boxType` and `value`
 * and discard every field that distinguishes one box type from another. Same
 * reason `CandidateOf` is written the way it is.
 */
export type DecodedBoxCandidate =
  | Omit<CandidateOf<KarmaBox>, 'guard'>
  | Omit<CandidateOf<CreditBox>, 'guard'>
  | Omit<CandidateOf<InviteBox>, 'guard'>
  | Omit<CandidateOf<BondBox>, 'guard'>
  | Omit<CandidateOf<PostLockBox>, 'guard'>
  | Omit<CandidateOf<VouchBox>, 'guard'>;

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
 * Box id from creating-transaction provenance (Spec G):
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
 * `like-payout` is P2-D's per-block like settlement (one mint per author per
 * block, subject = the raw author key).
 *
 * Retired members (P2-D): `'author-reward'` and `'liker-refund'` (the
 * epoch-tally pair `like-payout` superseded), and `'prune-refund-liker'` (likes
 * are one-way burns; prune settlement refunds no liker). They were retired
 * before any tag existed, so there is no tag of theirs to burn — but see
 * `MINT_REASON` for the rule that applies to the next retirement.
 */
export type MintReason =
  | 'coinbase'
  | 'vouch-settle'
  | 'like-payout'
  | 'postlock-unlock'
  | 'postlock-remainder'
  | 'decay'
  | 'genesis'
  | 'prune-refund-author';

/**
 * The `MintReason` tag table (Phase 2a-ii).
 *
 * A closed set of ASCII tags inside a consensus preimage is exactly what
 * `enum8` is for, and it is what `boxType` and `trigger` already use — writing
 * this one as `lpUtf8` instead would put two ways of encoding one kind of thing
 * back into a format whose entire purpose is that there is one.
 *
 * Two things it buys beyond uniformity:
 *
 * - **Exhaustiveness is compile-time.** `Readonly<Record<MintReason, number>>`
 *   means a new member cannot be added without assigning it a tag. The previous
 *   form let a new reason ship with no thought given to its encoding at all.
 * - **Prefix-freeness stops being a property anyone has to maintain.** The old
 *   preimage was `reason ‖ subject` with the reason as bare ASCII, so
 *   cross-reason injectivity rested on no member being a prefix of another —
 *   true, test-pinned, and one careless addition away from false. A one-byte tag
 *   makes it structural.
 *
 * **Tags reserve retired values and are never renumbered** (D1). A renumber
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
 * `NODE_INTERFACE.md`. It is **length-prefixed** here, which retires that
 * table's other standing obligation: the previous form appended it raw, so the
 * contract had to require every per-reason subject encoding to be fixed-length
 * or self-delimiting. `lp()` makes uniqueness within a reason structural, in the
 * same way the tag makes it structural across reasons.
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
 * As of Spec G phase G3b this is exactly `computeCandidateBoxId` applied to the
 * box's own provenance, so there is one derivation rather than two. The legacy
 * content hash it replaced (`blake2b512(canonicalBoxBytes(box))`, no domain tag,
 * no provenance in the preimage) is gone — that derivation is what M-11 was:
 * it hashed the apply-mutated `createdAtBlock`, so a stored box could not match
 * its own id. Deleting the field and binding the id to `txId ‖ index` is what
 * makes `stored.id === computeBoxId(stored)` hold **by construction** for every
 * box in the UTXO set, checkable by any light client, indexer or AVL prover.
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

// 'block_apply' replaced 'epoch_tally' (P2-D): the meaning was always
// "consumable only by block application", and there is no epoch. The retired
// 'epoch_tally' string stays reserved — never reuse: guard strings are box
// content, inside the box-id preimage.
export type BoxGuard = 'owner_signature' | 'block_apply' | 'hash_preimage' | 'inviter_signature' | 'bond_dual' | 'hash_preimage_with_bond';

/**
 * The creator-chosen fields — what a client builds and what `computeTxId`
 * hashes. No `id`, no provenance.
 */
export interface BoxCandidate {
  // boxType 'like' retired (P2-D) — string reserved, never reuse: boxType is
  // box content, inside the box-id preimage.
  boxType: 'karma' | 'credit' | 'invite' | 'bond' | 'post_lock' | 'vouch';
  value: bigint;        // integer base units, uniform across box types; value < 2^64 is the `vlqU` wire domain
  // `createdAtBlock` was here and is **deleted** (Spec G phase G3b, D3). It was
  // the only apply-mutated field, and its presence is what made the id
  // dishonest. The node still records the settled height in a `created_at_block`
  // store column, which consensus code must never read: it is not committed in
  // the `stateRoot`, so a node bootstrapping from an AVL snapshot cannot
  // reconstruct it. The decay clock reads a committed per-identity record.
}

/**
 * A box as it exists in the ledger, the store and the AVL value: a candidate
 * plus the provenance that gives it identity.
 *
 * `txId`/`index` are **required** (Spec G phase G3a), which is what makes "has
 * an id but no provenance" — the M-11 state — unrepresentable rather than merely
 * discouraged. A producer that forgets provenance is now a compile error, in the
 * same way phase G2 turned a missing `MintContext` into one.
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
  guard: 'owner_signature';
  proofSource: string;        // PostId | StumpHash | InviteTxId
  // `lastTouchBlock` was here and is **deleted** (Spec G phase G3b). It had no
  // reader anywhere in `src` — the decay clock reads the committed per-identity
  // record, not box ages.
  decayBurn?: boolean;
}

// --- Credit ---

export interface CreditBox extends BoxBase {
  boxType: 'credit';
  owner: Uint8Array;          // 32 raw bytes
  guard: 'owner_signature';
  proofSource: number;        // Minting block height, OR -1: the transfer sentinel (heightOrTransfer)
  lockedUntilBlock?: number;  // Block height before which credits cannot be spent
}

// --- Invite ---

export interface InviteBox extends BoxBase {
  boxType: 'invite';
  value: bigint;                    // N karma transferred
  secretHash: Uint8Array;           // 32 bytes — H(s) = blake2b512(s).subarray(0,32)
  inviterId: UserId;
  guard: 'hash_preimage_with_bond'; // Unlocked by preimage + committed BondBox
}

// --- Bond ---

export interface BondBox extends BoxBase {
  boxType: 'bond';
  value: bigint;                    // D karma deposited
  inviterId: UserId;               // Owner — the inviter
  /**
   * Which output of this bond's **own creating transaction** is the paired
   * InviteBox. Replaces `inviteBoxId: BoxId` (user decision, 2026-08-06).
   *
   * A box id here would be **circular**: the id derives from the creating
   * transaction's `txId`, and this is a content field, so it sits inside the
   * bytes `computeTxId` hashes. Measured: no fixed point exists. Spec G §3.1's
   * "no circularity" argument covers *provenance* fields (`computeTxId` excludes
   * `id`/`txId`/`index`) and does not reach a content field carrying a box id.
   *
   * An index is not merely a workaround for that. The bond and the invite are
   * always outputs of one transaction, so pairing by position makes a bond that
   * points at *someone else's* invite inexpressible rather than caught late —
   * the old field could name any box in the world and was only checked when it
   * was dereferenced, one transaction later. The invite resolves from
   * `(bond.txId, inviteOutputIndex)`, which `UNIQUE(tx_id, output_index)`
   * already indexes.
   */
  inviteOutputIndex: number;
  /**
   * **0 or 32 raw bytes**: empty = unclaimed, 32 bytes = committed. Set during
   * commit; empty on the create path, which node's engine *requires* — a
   * pre-committed bond would let the inviter reclaim immediately and make the
   * network's only sybil cost free.
   *
   * The width is the field's whole subtlety, and this comment used to read
   * "32 raw bytes — set during commit", which is what the layout table was
   * drafted from. It encodes as `opt(b32)`; see `writeOptBytesNOrThrow`.
   */
  inviteePublicKey: Uint8Array;
  probationStartBlock: number;     // Set during commit
  probationEndBlock: number;       // probationStartBlock + INVITE_PROBATION_BLOCKS
  guard: 'bond_dual';              // inviter_signature (reclaim) OR hash_preimage (commit)
}

// --- Post Lock ---

export interface PostLockBox extends BoxBase {
  boxType: 'post_lock';
  value: bigint;              // Current locked karma (vests per block as likes accumulate)
  originalValue: bigint;      // Initial lock amount (POST_LOCK_THREAD_COST or POST_LOCK_REPLY_COST)
  owner: Uint8Array;          // 32 raw bytes — post author's Ed25519 public key
  targetPostId: PostId;       // The post this lock secures
  guard: 'block_apply';       // Only consumable by block application
}

// --- Vouch ---

export interface VouchBox extends BoxBase {
  boxType: 'vouch';
  value: 1n;                         // always 1 karma
  voucherId: UserId;                 // who staked the karma
  targetId: UserId;                  // who is being vouched for
  guard: 'owner_signature';          // voucher controls spend
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type AnyBox = KarmaBox | CreditBox | InviteBox | BondBox | PostLockBox | VouchBox;

/** Every box type in its creator-built form — no `id`, no provenance. */
export type AnyBoxCandidate =
  | CandidateOf<KarmaBox>
  | CandidateOf<CreditBox>
  | CandidateOf<InviteBox>
  | CandidateOf<BondBox>
  | CandidateOf<PostLockBox>
  | CandidateOf<VouchBox>;

// ---------------------------------------------------------------------------
// UTXO transaction
// ---------------------------------------------------------------------------

export interface UtxoTransaction {
  inputs: BoxId[];
  /**
   * Candidates, not boxes (Spec G phase G3a). A transaction's outputs cannot
   * carry provenance: their `txId` is the id of the very transaction being
   * built, so a signed output with an `id` in it would be circular. Block
   * application materializes them — see node's `materializeOutput`.
   */
  outputs: AnyBoxCandidate[];
  signatures: Record<string, Uint8Array>;  // publicKey (hex) → Ed25519 sig (64 bytes) over txId
  preimages?: Record<string, Uint8Array>;  // boxId → hash preimage for hash_preimage guards
  protocolVersion: number;
  /**
   * Present ⟺ this transaction is a like on the named post (P2-D). The field
   * sits inside the `computeTxId` preimage, so the signature covers the
   * target and a relay cannot re-point a like. This package defines only the
   * field and its encoding; the biconditional itself — present ⟺ the tx
   * burns exactly `LIKE_KARMA_COST`, the only legal karma deficit in a user
   * transaction — is consensus validation and lives in node's UTXO engine.
   */
  likeTarget?: PostId;
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
 *
 * Order preserves the pre-migration sequence, so the change is dialect-only in
 * *coverage* — but it is the one place in this phase where the dialect change
 * closes a real defect rather than only unifying a style. **This is P2-C row C1,
 * satisfied structurally:**
 *
 * - `inputs` and `outputs` were concatenated with **no count and no length
 *   prefix** (`for (const input of tx.inputs) h.update(input)`), and
 *   `canonicalBoxBytes` is variable-length — so two different output lists
 *   could concatenate to identical bytes. `arr()`'s count prefix closes it.
 * - `protocolVersion` went in as `String(...)`, unprefixed decimal text: the
 *   exact M-1 pattern, one struct over. It is `vlqU` now.
 * - `likeTarget` presence was marked by an ASCII `like:` tag chosen so a
 *   decimal `protocolVersion` could not forge it. `opt()`'s 0/1 tag replaces
 *   the trick, and preserves the `!== undefined` distinction — an empty-string
 *   target still hashes differently from absence.
 * - `preimages` already sorted by key, so the normative sort **ratifies**
 *   existing behaviour here rather than changing it. Keys are lowercase hex, so
 *   sorting the strings and sorting the decoded bytes give the same order.
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
  return w.toBytes();
}

/**
 * Deterministic transaction ID: `blake2b512(TX_ID_DOMAIN ‖ txIdBytes)[0:32]`.
 *
 * Outputs go through `canonicalBoxBytes`, so identity has exactly **one** box
 * encoding rather than two that must be kept in agreement. This matters from
 * Spec G phase C on: once producers materialize outputs with `txId`/`index`
 * set, a local `{ id, ...rest }` strip would hash provenance into the very txId
 * that provenance is derived from — circular, and it would make a
 * transaction's id depend on ids that cannot exist until that id is known.
 * Under the positional encoder those fields are not merely stripped, they have
 * no writer.
 *
 * `TX_ID_DOMAIN` is applied as of Spec G phase G3b. Box ids, transaction ids and
 * identity-record keys share one 32-byte keyspace and the AVL tree holds two
 * entity kinds, so the separation has to be in the preimage. This is also **the
 * only implementation** — node's `utxo-engine.ts` carried a second one until
 * G3b deleted it; it verified signatures against an untagged id while every
 * builder signed a tagged one.
 *
 * ⚠ **This function now throws on an out-of-domain transaction**, where the
 * text-and-concatenation form absorbed almost anything. `checkTxEnvelope`
 * establishes the domain of `inputs`, the `preimages` keys and `likeTarget`
 * (all pinned at 64 lowercase hex) — but it deliberately does **not** type the
 * output entries, and `checkOutputShape` runs later, at `validateTx` step 4.
 * At `block-apply.ts`'s embedded-tx path only the envelope has run, so an
 * output carrying a `value` outside the u64 or a 31-byte `owner` reaches a
 * throwing writer there. Spec §2.5 books an explicit domain check at that call
 * site to Phase 6; that obligation is **wider than the `bigint` the spec names**
 * — it covers every fixed-width output field.
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
