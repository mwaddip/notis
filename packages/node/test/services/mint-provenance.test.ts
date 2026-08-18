import { describe, it, expect } from 'vitest';
import { computeMintTxId } from '@dagsocial/types';
import type { MintReason } from '@dagsocial/types';
import {
  MINT_OUTPUT_INDEX,
  GENESIS_SYSTEM_KARMA,
  GENESIS_FAUCET_CREDITS,
  coinbaseContext,
  likePayoutContext,
  postlockUnlockContext,
  postlockRemainderContext,
  decayContext,
  genesisContext,
  genesisCommitteeContext,
  pruneRefundAuthorContext,
  inviteClaimContext,
  bondSettleContext,
  bondReturnContext,
  emissionSuccessorContext,
  poolSettleContext,
  treasurySuccessorContext,
  mintTxIdFor,
} from '../../src/mint-provenance.js';
import type { MintContext } from '../../src/mint-provenance.js';

// Deterministic fixtures — no Date.now(), no randomness.
const pubkey = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const postId = (fill: string): string => fill.repeat(64).slice(0, 64);

const POST_A = postId('a');
const POST_B = postId('b');
const VOUCHER = pubkey(0x11);
const TARGET = pubkey(0x22);
const OWNER = pubkey(0x44);
const INVITEE = pubkey(0x55);

/** Two prune entries, i.e. two subtrees settled at one height. */
const ROOT_A = postId('c');
const ROOT_B = postId('d');

const HEIGHT = 4242;

/**
 * Every reason, built at one height, **keyed by the reason so coverage is a
 * compile error.**
 *
 * ⛔ **`satisfies Record<MintReason, …>` is what makes the coverage structural:
 * a member added to the union without a row here is a compile error.** An array
 * cannot carry that property — an array of the union is satisfied by any subset
 * of it, so it tracks the set only by hand, and the "covers every MintReason
 * exactly once" test below would then be comparing a hand-kept list against
 * itself. Same shape as `MINT_REASON_GOLDENS` in `@dagsocial/types` and the UI
 * mirror's box-type fixtures.
 *
 * Several entries deliberately share a subject: `like-payout` and `decay` are
 * one raw pubkey each, and the three invite reasons are all the invitee's key,
 * so the pairwise-distinct txId test below covers exactly the pairs the reason
 * tag alone separates.
 */
const ALL_CONTEXTS = {
  coinbase: { ctx: coinbaseContext(0), bytes: 4 },
  'like-payout': { ctx: likePayoutContext(OWNER), bytes: 32 },
  'postlock-unlock': { ctx: postlockUnlockContext(POST_A), bytes: 64 },
  'postlock-remainder': { ctx: postlockRemainderContext(POST_A), bytes: 64 },
  decay: { ctx: decayContext(OWNER), bytes: 32 },
  genesis: { ctx: genesisContext(GENESIS_SYSTEM_KARMA), bytes: 4 },
  // The member's raw key, and the whole reason this is not a `genesis`
  // selector: a selector names one box, and committee seeding mints one per
  // member.
  'genesis-committee': { ctx: genesisCommitteeContext(OWNER), bytes: 32 },
  'prune-refund-author': { ctx: pruneRefundAuthorContext(ROOT_A, OWNER), bytes: 96 },
  'invite-claim': { ctx: inviteClaimContext(INVITEE), bytes: 32 },
  'bond-settle': { ctx: bondSettleContext(INVITEE), bytes: 32 },
  'bond-return': { ctx: bondReturnContext(INVITEE), bytes: 32 },
  // Zero-width, which is a subject rather than the absence of one: the preimage
  // writes `lp(subject)`, so an empty subject is a zero length and stays
  // self-delimiting (NODE_INTERFACE → The subject encoding rule).
  'emission-release': { ctx: emissionSuccessorContext(), bytes: 0 },
  'treasury-accrue': { ctx: treasurySuccessorContext(), bytes: 0 },
  // The third of that family, and the reason the empty subject is safe is the
  // same: one pool successor per height, so the height separates instances
  // within the reason and the tag separates the reason from the other thirteen.
  'pool-settle': { ctx: poolSettleContext(), bytes: 0 },
} satisfies Record<Exclude<MintReason, 'vouch-settle'>, { ctx: MintContext; bytes: number }>;

function allContexts(): Array<{ ctx: MintContext; bytes: number }> {
  return Object.values(ALL_CONTEXTS);
}

describe('mint provenance — subject encodings', () => {
  // The fixed-length rule is the invariant this module exists to satisfy, and
  // what it protects is the subject's own INTERNAL structure: `computeMintTxId`
  // writes `lp(subject)`, so one whole subject can never be confused with
  // another — what `lp` cannot separate is the *parts* of a multi-part subject,
  // which it wraps as one opaque run (NODE_INTERFACE → The subject encoding
  // rule). `prune-refund-author` is the live case: `utf8(hex) ‖ raw`, where a
  // variable-width part would let two pairs concatenate to the same 96 bytes.
  it('every reason encodes a subject of exactly the width the contract pins', () => {
    for (const { ctx, bytes } of allContexts()) {
      expect(ctx.subject.length, ctx.reason).toBe(bytes);
    }
  });

  it('covers every MintReason exactly once — the table is the whole union', () => {
    // ⛔ **Coverage is enforced by `satisfies Record<MintReason, …>` on the
    // table itself, and restating the reasons here would not add to it** — a
    // list written out by hand is satisfied by whatever it happens to contain.
    // What this asserts is the half a type cannot: that the key each entry is
    // filed under is the reason its context actually carries, so a context
    // pasted under the wrong key is caught rather than counted as coverage of
    // the key it sits beside.
    for (const [key, { ctx }] of Object.entries(ALL_CONTEXTS)) {
      expect(ctx.reason, `filed under ${key}`).toBe(key as MintReason);
    }
    const reasons = allContexts().map(({ ctx }) => ctx.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('hex-typed values enter as UTF-8 text, raw-typed values as raw bytes', () => {
    // TYPES_INTERFACE → "Pinned byte forms". A mirror that decodes the hex
    // instead computes different ids.
    expect(Buffer.from(postlockUnlockContext(POST_A).subject).toString()).toBe(POST_A);

    expect(decayContext(OWNER).subject).toEqual(OWNER);
    expect(likePayoutContext(OWNER).subject).toEqual(OWNER);

    // The prune leg: entry root as hex text, then the refunded key raw.
    const pruneAuthor = pruneRefundAuthorContext(ROOT_A, OWNER);
    expect(Buffer.from(pruneAuthor.subject.subarray(0, 64)).toString()).toBe(ROOT_A);
    expect(pruneAuthor.subject.subarray(64)).toEqual(OWNER);
  });

  it('u32BE subjects are big-endian, and total on out-of-domain input', () => {
    expect(coinbaseContext(0).subject).toEqual(new Uint8Array([0, 0, 0, 0]));
    expect(coinbaseContext(1).subject).toEqual(new Uint8Array([0, 0, 0, 1]));
    expect(coinbaseContext(258).subject).toEqual(new Uint8Array([0, 0, 1, 2]));
    // Mirrors the sentinel discipline in types' u32BE: writes all-ones rather
    // than throwing, so id derivation never panics on untrusted input (M-5).
    expect(coinbaseContext(-1).subject).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(coinbaseContext(2 ** 32).subject).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  });

  it('genesis selectors are distinct', () => {
    expect(GENESIS_SYSTEM_KARMA).toBe(0);
    expect(GENESIS_FAUCET_CREDITS).toBe(1);
    expect(mintTxIdFor(genesisContext(GENESIS_SYSTEM_KARMA), 1)).not.toBe(
      mintTxIdFor(genesisContext(GENESIS_FAUCET_CREDITS), 1),
    );
  });

  it('every mint emits exactly one box, so index is 0', () => {
    expect(MINT_OUTPUT_INDEX).toBe(0);
  });
});

describe('mint provenance — txId uniqueness', () => {
  it('all table reasons produce pairwise-distinct txIds at one height', () => {
    const ids = allContexts().map(({ ctx }) => mintTxIdFor(ctx, HEIGHT));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  // Why `rootPostHash` is in the subject at all: `settlePruneUtxo` runs once
  // per prune entry, so two entries in one block call it twice at one height.
  // Without the entry's identity these two would be the same id at `index` 0.
  it('the same refund leg in two prune entries at one height produces different txIds', () => {
    expect(mintTxIdFor(pruneRefundAuthorContext(ROOT_A, OWNER), HEIGHT)).not.toBe(
      mintTxIdFor(pruneRefundAuthorContext(ROOT_B, OWNER), HEIGHT),
    );
  });

  it('postlock-unlock and postlock-remainder do not collide either', () => {
    expect(mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT)).not.toBe(
      mintTxIdFor(postlockRemainderContext(POST_A), HEIGHT),
    );
  });

  it('the same reason at different heights produces different txIds', () => {
    expect(mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT)).not.toBe(
      mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT + 1),
    );
  });

  it('the same reason with different subjects produces different txIds', () => {
    expect(mintTxIdFor(postlockUnlockContext(POST_A), HEIGHT)).not.toBe(
      mintTxIdFor(postlockUnlockContext(POST_B), HEIGHT),
    );
    expect(mintTxIdFor(pruneRefundAuthorContext(ROOT_A, OWNER), HEIGHT)).not.toBe(
      mintTxIdFor(pruneRefundAuthorContext(ROOT_A, pubkey(0x99)), HEIGHT),
    );
    expect(mintTxIdFor(coinbaseContext(0), HEIGHT)).not.toBe(
      mintTxIdFor(coinbaseContext(1), HEIGHT),
    );
  });

  it('mintTxIdFor is exactly computeMintTxId at the derivation height', () => {
    // Pins that the module adds no derivation of its own — the one place a
    // height could otherwise disagree with itself.
    const ctx = postlockUnlockContext(POST_A);
    expect(mintTxIdFor(ctx, HEIGHT)).toBe(computeMintTxId(HEIGHT, ctx.reason, ctx.subject));
  });

  it('a MintContext does not alias the caller-owned bytes it was built from', () => {
    const owner = pubkey(0x55);
    const ctx = decayContext(owner);
    const before = mintTxIdFor(ctx, HEIGHT);
    owner[0] = 0xee;
    expect(mintTxIdFor(ctx, HEIGHT)).toBe(before);
  });
});
