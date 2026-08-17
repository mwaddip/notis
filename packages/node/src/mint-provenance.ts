import { computeMintTxId, u32BE } from '@dagsocial/types';
import type { MintReason, PostId, TxId } from '@dagsocial/types';

/**
 * Why a box is being minted — the half of a synthetic transaction id that only
 * the caller knows (Spec G phase C; NODE_INTERFACE → "Box Identity and Mint
 * Provenance").
 *
 * `mintKarma`/`mintCredits` and the direct producers know the *height*; they do
 * not know whether they are settling a vouch, paying an author or unlocking a
 * post lock. Threading that in as a value, rather than as a txId the caller
 * derives itself, is what keeps derivation at one site: `computeMintTxId`
 * commits to height, and a caller that passed both a height and a pre-derived
 * txId could pass two different heights with nothing forcing a match — a box
 * whose id encodes a height it did not settle at.
 */
export interface MintContext {
  readonly reason: MintReason;
  readonly subject: Uint8Array;
}

/**
 * Every mint event emits exactly one box, so its position within its own
 * synthetic transaction is always 0 (NODE_INTERFACE → "`index` is always 0 for
 * mints"). Named rather than inlined so the eight producers cannot drift.
 */
export const MINT_OUTPUT_INDEX = 0;

/** `genesis` subject selectors. See `genesisContext`. */
export const GENESIS_SYSTEM_KARMA = 0;
export const GENESIS_FAUCET_CREDITS = 1;
export const GENESIS_PROOF = 2;
export const GENESIS_EMISSION = 3;
export const GENESIS_KARMA_POOL = 4;

const utf8 = new TextEncoder();

// `u32BE` is *imported* from types and must never be mirrored here. These bytes
// land in a `subject`, which types hashes as opaque input, so a second copy
// drifting would silently move mint txIds — and therefore box ids — with
// nothing to catch it. One implementation feeds both `computeMintTxId`'s height
// field and the subjects below, sentinel behaviour included.

/**
 * Concatenate subject parts. Plain byte concatenation with no length prefix —
 * which is why every multi-part encoding below ends in a fixed-width field.
 */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-reason contexts
// ---------------------------------------------------------------------------
//
// One function per reason, each producing the fixed-width `subject` the
// contract's reason/subject table specifies. This module exists so that rule is
// reviewable in one place instead of at every call site.
//
// Each returns a whole `MintContext` rather than bare bytes, so "right subject,
// wrong reason" is unrepresentable at a call site. The pairing is load-bearing
// wherever two same-height mints can land on one recipient: `like-payout` and
// `postlock-unlock` both mint to an author at one height, separated by reason
// (and, as it happens, subject shape — NODE_INTERFACE → reason/subject table);
// `like-payout` and `decay` share exact subject bytes — one raw pubkey — with
// the tag as the only separator. Getting one wrong produces a box-id
// collision, not an error.
//
// Byte forms follow TYPES_INTERFACE → "Pinned byte forms": a hex-typed value
// (`PostId`) enters as the UTF-8 bytes of its hex text, a `Uint8Array`-typed
// value (pubkeys) as its raw bytes.

/** `coinbase` — 4 bytes. One event per coinbase output, not one N-output tx. */
export function coinbaseContext(outputIndex: number): MintContext {
  return { reason: 'coinbase', subject: u32BE(outputIndex) };
}

/** `vouch-settle` — 64 bytes: two 32-byte pubkeys. */
export function vouchSettleContext(voucherId: Uint8Array, targetId: Uint8Array): MintContext {
  return { reason: 'vouch-settle', subject: concat(voucherId, targetId) };
}

/**
 * `like-payout` — 32 bytes: the credited author's raw pubkey (per-block like
 * settlement). Fixed length, so the injectivity rule holds by
 * construction. One mint per author per block, which is what makes
 * `(height, 'like-payout', author)` unique: the settlement consolidates every
 * like the author received in the block into a single mint.
 *
 * Copied rather than aliased, same as `decayContext`.
 */
export function likePayoutContext(author: Uint8Array): MintContext {
  return { reason: 'like-payout', subject: Uint8Array.from(author) };
}

/** `postlock-unlock` — 64 bytes: the vested post's id as hex text. */
export function postlockUnlockContext(targetPostId: PostId): MintContext {
  return { reason: 'postlock-unlock', subject: utf8.encode(targetPostId) };
}

/** `postlock-remainder` — 64 bytes. The replacement PostLockBox after a tally. */
export function postlockRemainderContext(targetPostId: PostId): MintContext {
  return { reason: 'postlock-remainder', subject: utf8.encode(targetPostId) };
}

/**
 * `decay` — 32 bytes: the owner's raw pubkey.
 *
 * Copied rather than aliased, so a `MintContext` never shares mutable state
 * with the box it describes; every other encoder here allocates.
 */
export function decayContext(owner: Uint8Array): MintContext {
  return { reason: 'decay', subject: Uint8Array.from(owner) };
}

/**
 * `genesis` — 4 bytes: which genesis box.
 *
 * A `u32BE` selector, deliberately **not** the ASCII tags `system-karma` /
 * `faucet-credits` that Spec G §3.2 sketched. Those are variable-length and
 * merely prefix-free — sufficient for this pair by accident, but not a property
 * the fixed-length-or-self-delimiting rule can check per encoding. Adding a
 * third genesis box then costs one integer rather than a re-examination.
 *
 * ⛔ **One selector names one box, so a set of boxes cannot share this reason.**
 * N boxes under one `k` derive one synthetic txId, one `computeBoxId` preimage,
 * and the second insert violates `UNIQUE(tx_id, output_index)` — which is why
 * a per-member grant is keyed on the member instead (NODE_INTERFACE → Reason
 * and subject table).
 */
export function genesisContext(which: number): MintContext {
  return { reason: 'genesis', subject: u32BE(which) };
}

/**
 * `genesis-committee` — 32 bytes: the member's raw public key.
 *
 * Its own reason rather than a `genesisContext` selector, because a selector
 * names one box and committee seeding mints one per member. Keyed on the member
 * for the reason `likePayoutContext` is keyed on the author: a key appears at
 * most once in `genesisCommitteeKeys`, so `(height, reason, subject)` is
 * distinct per member by construction, where a shared `k` would derive one
 * synthetic txId for all of them.
 *
 * Copied rather than aliased, same as `decayContext`.
 */
export function genesisCommitteeContext(member: Uint8Array): MintContext {
  return { reason: 'genesis-committee', subject: Uint8Array.from(member) };
}

// The three block-application box successors. All take an **empty** subject,
// which is the honest encoding when there is nothing to discriminate:
// `computeMintTxId` writes `lp(subject)`, so an empty one is a zero length
// rather than an absence, and stays self-delimiting.
//
// Exactly one of each exists per height, so the height alone separates every
// instance within a reason and the reason's `enum8` tag separates the three from
// each other and from every other row. That satisfies "Discriminants are
// semantic, never positional" outright rather than by argument (NODE_INTERFACE →
// Reason and subject table).
//
// ⛔ **None of them creates value.** Each names a box block application spends
// and recreates — the emission box's successor holds what the schedule has not
// yet released, the treasury's what has accrued, the pool's the karma that is
// not in circulation. Needing a synthetic txId is what any created box needs for
// an identity; it is not a claim that value was minted, the same standing
// `vouch-settle` and `bond-return` have.
//
// ⚠ **Deriving any of these subjects from a position in the block — the coinbase
// output count, say — would be collision-free and forbidden.** It is exactly
// the position-derived identity that section rules out, and being safe is what
// would make it tempting.

/** `emission-release` — no subject. The `EmissionBox` successor. */
export function emissionSuccessorContext(): MintContext {
  return { reason: 'emission-release', subject: new Uint8Array(0) };
}

/** `treasury-accrue` — no subject. The `TreasuryBox` successor. */
export function treasurySuccessorContext(): MintContext {
  return { reason: 'treasury-accrue', subject: new Uint8Array(0) };
}

/**
 * `pool-settle` — no subject. The `KarmaPoolBox` successor.
 *
 * ⛔ **Not a `genesisContext` selector**, and the pool box already holds one
 * (`GENESIS_KARMA_POOL`) for the box genesis seeds. A selector says *which
 * genesis box*, so reusing it here would give a box created at height 500 a
 * provenance reading `genesis` — collision-free, since the height differs, and
 * still a lie about why the box exists.
 */
export function poolSettleContext(): MintContext {
  return { reason: 'pool-settle', subject: new Uint8Array(0) };
}

/**
 * `prune-refund-author` — 96 bytes: the pruned subtree's root post id as hex
 * text, then the refunded author's 32 raw pubkey bytes. Unambiguous because
 * the 32-byte suffix pins the split point.
 *
 * The subject names the **prune entry**, not the post the karma was locked
 * against — refunds are aggregated per user across the whole subtree, so no
 * single postId is available to name. `rootPostHash` is load-bearing rather
 * than decoration: `settlePruneUtxo` runs once per prune entry, so a block
 * carrying two entries calls it twice at one height. Without the entry's
 * identity in the subject, an author with refunds in both subtrees derives the
 * same `mintTxId` twice at `index` 0, trips `UNIQUE(tx_id, output_index)`, and
 * a legitimate block is rejected.
 */
export function pruneRefundAuthorContext(rootPostHash: PostId, owner: Uint8Array): MintContext {
  return { reason: 'prune-refund-author', subject: concat(utf8.encode(rootPostHash), owner) };
}

// The three invite reasons all take the **invitee's** raw public key as subject
// — 32 bytes, fixed-length, so the injectivity rule holds by construction — and
// the invitee rather than the recipient is what makes them unique. An invite may
// not name an existing account and a claim makes the invitee one (NODE_INTERFACE
// → "Bond transition rules"), so a key is invited at most once and each
// `(reason, subject)` pair occurs at most once in the whole history — without
// reading the height at all. The three are mutually exclusive besides: an invite
// is claimed or cancelled, never both.
//
// ⛔ `invite-claim` is the only one that increases karma supply. `bond-settle`
// and `bond-return` re-mint karma a `BondBox` already held, in the sense
// `vouch-settle` re-mints an escrow.

/** `invite-claim` — 32 bytes. Mints `INVITE_KARMA_AMOUNT` to the invitee. */
export function inviteClaimContext(inviteePublicKey: Uint8Array): MintContext {
  return { reason: 'invite-claim', subject: Uint8Array.from(inviteePublicKey) };
}

/**
 * `bond-settle` — 32 bytes: the invitee's key, though the karma mints to the
 * **inviter**. The subject names the bond, and the invitee is what identifies
 * one; the inviter may hold several bonds maturing at one height, which would
 * collide under their own key.
 */
export function bondSettleContext(inviteePublicKey: Uint8Array): MintContext {
  return { reason: 'bond-settle', subject: Uint8Array.from(inviteePublicKey) };
}

/** `bond-return` — 32 bytes: the cancelled invite's invitee key. See above. */
export function bondReturnContext(inviteePublicKey: Uint8Array): MintContext {
  return { reason: 'bond-return', subject: Uint8Array.from(inviteePublicKey) };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The single site where a mint's synthetic transaction id is derived.
 *
 * `mintKarma`, `mintCredits` and the direct producers (decay, the vesting
 * remainder post-lock, genesis) all route through here, so the height that
 * reaches `computeMintTxId` is always the height the box settles at.
 */
export function mintTxIdFor(ctx: MintContext, blockHeight: number): TxId {
  return computeMintTxId(blockHeight, ctx.reason, ctx.subject);
}
