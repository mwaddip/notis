import { describe, it, expect } from 'vitest';
import { computeMintTxId } from '@dagsocial/types';
import type { MintReason } from '@dagsocial/types';
import {
  MINT_OUTPUT_INDEX,
  GENESIS_SYSTEM_KARMA,
  GENESIS_FAUCET_CREDITS,
  postlockUnlockContext,
  postlockRemainderContext,
  genesisContext,
  genesisCommitteeContext,
  mintTxIdFor,
} from '../../src/mint-provenance.js';
import type { MintContext } from '../../src/mint-provenance.js';

// Deterministic fixtures — no Date.now(), no randomness.
const pubkey = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const postId = (fill: string): string => fill.repeat(64).slice(0, 64);

const POST_A = postId('a');
const POST_B = postId('b');
const OWNER = pubkey(0x44);

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
 * `postlock-unlock` and `postlock-remainder` share identical subjects at one
 * height — the reason tag alone separates them.
 */
const ALL_CONTEXTS = {
  'postlock-unlock': { ctx: postlockUnlockContext(POST_A), bytes: 64 },
  'postlock-remainder': { ctx: postlockRemainderContext(POST_A), bytes: 64 },
  genesis: { ctx: genesisContext(GENESIS_SYSTEM_KARMA), bytes: 4 },
  'genesis-committee': { ctx: genesisCommitteeContext(OWNER), bytes: 32 },
} satisfies Record<MintReason, { ctx: MintContext; bytes: number }>;

function allContexts(): Array<{ ctx: MintContext; bytes: number }> {
  return Object.values(ALL_CONTEXTS);
}

describe('mint provenance — subject encodings', () => {
  it('every reason encodes a subject of exactly the width the contract pins', () => {
    for (const { ctx, bytes } of allContexts()) {
      expect(ctx.subject.length, ctx.reason).toBe(bytes);
    }
  });

  it('covers every MintReason exactly once — the table is the whole union', () => {
    for (const [key, { ctx }] of Object.entries(ALL_CONTEXTS)) {
      expect(ctx.reason, `filed under ${key}`).toBe(key as MintReason);
    }
    const reasons = allContexts().map(({ ctx }) => ctx.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('hex-typed values enter as UTF-8 text, raw-typed values as raw bytes', () => {
    expect(Buffer.from(postlockUnlockContext(POST_A).subject).toString()).toBe(POST_A);
    expect(genesisCommitteeContext(OWNER).subject).toEqual(OWNER);
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
  });

  it('mintTxIdFor is exactly computeMintTxId at the derivation height', () => {
    const ctx = postlockUnlockContext(POST_A);
    expect(mintTxIdFor(ctx, HEIGHT)).toBe(computeMintTxId(HEIGHT, ctx.reason, ctx.subject));
  });
});
