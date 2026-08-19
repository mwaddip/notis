import { computeMintTxId, u32BE } from '@dagsocial/types';
import type { MintReason, PostId, TxId } from '@dagsocial/types';

/**
 * Synthetic transaction ids for the two producer classes that create boxes
 * with no real transaction behind them (NODE_INTERFACE → Box Identity and
 * Mint Provenance): genesis seeding and post-lock vesting.
 *
 * Every other block-application effect is an output of the settlement
 * transaction and derives an ordinary transaction id. Threading the reason
 * in as a value keeps derivation at one site: `computeMintTxId` commits to
 * height, and a caller that passed both a height and a pre-derived txId
 * could pass two different heights with nothing forcing a match.
 */
export interface MintContext {
  readonly reason: MintReason;
  readonly subject: Uint8Array;
}

/**
 * Every mint event emits exactly one box, so its position within its own
 * synthetic transaction is always 0 (NODE_INTERFACE → Box Identity and Mint
 * Provenance). Named rather than inlined so the four producers cannot drift.
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

// ---------------------------------------------------------------------------
// Per-reason contexts
// ---------------------------------------------------------------------------
//
// One function per reason, each producing the fixed-width `subject` the
// contract's reason/subject table specifies (NODE_INTERFACE → Reason and
// subject table). This module exists so that rule is reviewable in one place
// instead of at every call site.
//
// Each returns a whole `MintContext` rather than bare bytes, so "right subject,
// wrong reason" is unrepresentable at a call site. The pairing is load-bearing
// wherever two same-height mints land on one recipient: `postlock-unlock` and
// `postlock-remainder` carry identical subjects at the same height — the
// reason tag alone separates them.
//
// Byte forms follow TYPES_INTERFACE → "Pinned byte forms": a hex-typed value
// (`PostId`) enters as the UTF-8 bytes of its hex text, a `Uint8Array`-typed
// value (pubkeys) as its raw bytes.

/** `postlock-unlock` — 64 bytes: the vested post's id as hex text. */
export function postlockUnlockContext(targetPostId: PostId): MintContext {
  return { reason: 'postlock-unlock', subject: utf8.encode(targetPostId) };
}

/** `postlock-remainder` — 64 bytes. The replacement PostLockBox after a tally. */
export function postlockRemainderContext(targetPostId: PostId): MintContext {
  return { reason: 'postlock-remainder', subject: utf8.encode(targetPostId) };
}

/**
 * `genesis` — 4 bytes: which genesis box.
 *
 * A `u32BE` selector, not variable-length ASCII tags. Those are merely
 * prefix-free — sufficient by accident, but not a property the
 * fixed-length-or-self-delimiting rule can check per encoding. Adding a
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
 * names one box and committee seeding mints one per member. Keyed on the
 * member so `(height, reason, subject)` is distinct per member by
 * construction, where a shared `k` would derive one synthetic txId for all
 * of them (NODE_INTERFACE → Reason and subject table).
 *
 * Copied rather than aliased, so a `MintContext` never shares mutable state
 * with the box it describes; every other encoder here allocates.
 */
export function genesisCommitteeContext(member: Uint8Array): MintContext {
  return { reason: 'genesis-committee', subject: Uint8Array.from(member) };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The single site where a mint's synthetic transaction id is derived.
 *
 * Genesis seeding and post-lock vesting route through here; every other
 * block-application effect is a settlement output with an ordinary txId.
 */
export function mintTxIdFor(ctx: MintContext, blockHeight: number): TxId {
  return computeMintTxId(blockHeight, ctx.reason, ctx.subject);
}
