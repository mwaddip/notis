/**
 * The per-identity decay clock and standing — the second committed entity
 * alongside boxes (TYPES_INTERFACE → Identity record and karma valuation).
 *
 * The type, its AVL key and its layout live here so that a light client
 * derives the key, decodes the value it is served, and values it with the
 * same function the node runs — one implementation of the valuation, never a
 * second one a client would have to trust.
 */

import { createHash } from 'crypto';
import { ReaderError } from '@dagsocial/wire';
import {
  encodeStruct,
  decodeStruct,
  readU8,
  readVlqU,
  readVlqU64,
  writeU8OrThrow,
  writeVlqU,
  writeVlqU64OrThrow,
} from './codec.js';
import type { StructCodec } from './codec.js';
import { IDENTITY_KEY_DOMAIN } from './utxo.js';
import type { UserId } from './identity.js';

/**
 * The per-identity decay clock — the second committed entity alongside boxes.
 * Who writes each field and what is derived from it is `NODE_INTERFACE →
 * Identity Records`; the bytes are TYPES_INTERFACE → Layout — IdentityRecord.
 *
 * **Key type is `UserId`** — the raw 32 Ed25519 public-key bytes, and there is
 * deliberately no separate identity type. Box `owner`/`likerId`/`inviterId`/
 * `voucherId` are the same pubkey and all `UserId`, so key rotation would have
 * to move box ownership too: the two move together or not at all, and branding
 * two semantically identical things buys no safety while costing a cast at
 * every boundary.
 */
export interface IdentityRecord {
  /** u32 — bumped when the owner's post transaction applies. */
  lastActivityBlock: number;
  /** u32 — bumped when decay fires. */
  lastDecayBlock: number;
  /**
   * u32 — the height an invite claim applied for this identity. `0` = never
   * invited.
   *
   * **The probation clock, and only that.** The paired bond settles at
   * `invitedAtBlock + INVITE_PROBATION_BLOCKS`, which is the whole of what this
   * field decides — a bond therefore carries no probation fields of its own
   * (NODE_INTERFACE → Identity Records). It is **not** the invite bar: an invite
   * may only name a key that is not already an account, and *that* test is the
   * existence of this record, not the value of this field.
   *
   * `0` stays reachable and stays meaningful — every identity that received
   * karma without being invited carries it, the genesis committee and the
   * faucet identity included — so the settlement sweep must exclude it rather than
   * treat it as an ordinary height.
   *
   * Written ONLY by block application when a claim applies. Every other writer
   * of this record carries the stored value through unchanged.
   */
  invitedAtBlock: number;
  /**
   * Likes this identity has received over its whole life — the bond settlement's
   * only input, `min(floor(n / INVITE_BOND_VEST_PER_LIKES), bond.value)`.
   *
   * **Monotonic: incremented by per-block like settlement and decremented by
   * nothing.** `like_records` is deliberately outside the `stateRoot`
   * (NODE_INTERFACE → Like-records), so a consensus-critical settlement input
   * cannot be sourced from it; the counter is the committed value instead. A
   * withdrawal of the reply that earned the likes empties its content but
   * leaves its like-records in place, so the counter is unaffected either way.
   *
   * `bigint` for the same two reasons the counter is: the value is consensus
   * input to bigint arithmetic, and the row boundary (`safeIntegers`) hands back
   * bigint — so no `Number()` coercion can appear in a settlement path. It takes
   * `vlqU64`, which throws outside `[0, 2⁶⁴)` rather than colliding on a
   * sentinel.
   */
  lifetimeLikesReceived: bigint;
  /** u32 — 0 = never a member; else the height the bar was first met — the AGE, never reset. */
  memberSinceBlock: number;
  /** u32 — D(N) at first set, never reset; 0 on a root and on a root's invitee. */
  memberBar: number;
  /** u32 — live counted vouches naming this identity. */
  memberVouches: number;
  /** Likes received from members; never decremented. */
  memberLikes: bigint;
  /** u32 — bonds this identity has created; never decremented. */
  invitesUsed: number;
}

/**
 * The record's **AVL** key: `blake2b512(IDENTITY_KEY_DOMAIN ‖ identityId)[0:32]`,
 * hex — never the raw `identityId`.
 *
 * Records and boxes share one 32-byte AVL keyspace, and an `identityId` is 32
 * *attacker-chosen* bytes (a public key): used raw, someone could grind a
 * keypair whose pubkey equals a live box id and collide the five entity kinds in
 * the tree. Hashing under a domain tag makes that infeasible, and is what makes
 * the kinds provably disjoint (NODE_INTERFACE → Entity kinds) — by domain
 * separation, not by luck.
 */
export function identityRecordKey(identityId: UserId): string {
  return createHash('blake2b512')
    .update(IDENTITY_KEY_DOMAIN)
    .update(identityId)
    .digest()
    .subarray(0, 32)
    .toString('hex');
}

/** Field 1 of the layout — the record discriminator (NODE_INTERFACE → Entity kinds). */
export const IDENTITY_RECORD_TAG = 0x80;

/**
 * The identity record's AVL value — TYPES_INTERFACE → Layout — IdentityRecord.
 *
 * **The tag is field 1 of the layout, not a wrapper around it**, exactly as
 * `enum8(boxType)` is field 1 of the box record rather than a prefix bolted on
 * outside it. One encoder, one byte string, no composition step where a caller
 * could disagree about ordering.
 *
 * Written as a `StructCodec` so `encodeStruct`/`decodeStruct` apply — which is
 * what gives the record the same four-part boundary check the box arm gets
 * (TYPES_INTERFACE → "The boundary check"): project onto the schema, assert the
 * reader is exhausted, re-encode and byte-compare. Step 3 is the one that
 * matters most here: without it, non-minimal VLQ means two byte strings decode
 * to one record, which is two AVL values for one state.
 *
 * Every field is **always written, zero included** — they are fields of the
 * record and a layout writes every field. Conditional presence would reopen
 * the key-set-exactness fork. `bigint` is the two counters' type for the
 * `safeIntegers` row boundary, not for the bytes: under `vlqU64` a `number`
 * and a `bigint` of equal value encode **identically**, so what the type
 * guards is a silent `Number()` coercion at the store edge.
 *
 * Domains belong upstream (TYPES_INTERFACE → "Totality"): the four heights
 * (`lastActivityBlock`, `lastDecayBlock`, `invitedAtBlock`, `memberSinceBlock`)
 * and the three u32 counts (`memberBar`, `memberVouches`, `invitesUsed`) are
 * `vlqU`, total by sentinel, so an out-of-domain value collides rather than
 * panicking; `lifetimeLikesReceived` and `memberLikes` are `vlqU64` and
 * `writeVlqU64OrThrow` throws outside `[0, 2⁶⁴)`. Per-block like settlement is
 * their only writer and it only ever adds, bounded by how many likes one
 * identity can receive, so it establishes the domain.
 *
 * ⛔ **The outstanding like accrual is NOT a field here, and its absence is the
 * point.** The accrual sits in a `LikeAccrualBox` carry box, so **the box IS the
 * carry** (ARCHITECTURE → Likes) — a field here as well would be two
 * representations of one quantity, free to disagree. The carry reaches the
 * `stateRoot` either way, because every box does.
 */
const IDENTITY_RECORD: StructCodec<IdentityRecord> = {
  name: 'identityRecord',
  write(w, record) {
    writeU8OrThrow(w, IDENTITY_RECORD_TAG);
    writeVlqU(w, record.lastActivityBlock);
    writeVlqU(w, record.lastDecayBlock);
    writeVlqU(w, record.invitedAtBlock);
    writeVlqU64OrThrow(w, record.lifetimeLikesReceived);
    writeVlqU(w, record.memberSinceBlock);
    writeVlqU(w, record.memberBar);
    writeVlqU(w, record.memberVouches);
    writeVlqU64OrThrow(w, record.memberLikes);
    writeVlqU(w, record.invitesUsed);
  },
  read(r) {
    const tag = readU8(r);
    if (tag !== IDENTITY_RECORD_TAG) {
      // ReaderError rather than a bare Error: `decodeStruct` passes it through
      // as-is, where anything else is wrapped as a `reader-fault`. Same shape
      // as `enum8`'s unknown-tag rejection on the box arm.
      throw new ReaderError(
        `identityRecord: not an identity record: tag 0x${tag.toString(16)}`,
        'invalid-tag',
      );
    }
    return {
      lastActivityBlock: readVlqU(r),
      lastDecayBlock: readVlqU(r),
      invitedAtBlock: readVlqU(r),
      lifetimeLikesReceived: readVlqU64(r),
      memberSinceBlock: readVlqU(r),
      memberBar: readVlqU(r),
      memberVouches: readVlqU(r),
      memberLikes: readVlqU64(r),
      invitesUsed: readVlqU(r),
    };
  },
};

/** Serialize an identity record to its AVL value bytes. */
export function identityRecordBytes(record: IdentityRecord): Uint8Array {
  return encodeStruct(IDENTITY_RECORD, record);
}

/** Deserialize bytes produced by `identityRecordBytes`. */
export function identityRecordFromBytes(bytes: Uint8Array): IdentityRecord {
  return decodeStruct(IDENTITY_RECORD, bytes);
}
