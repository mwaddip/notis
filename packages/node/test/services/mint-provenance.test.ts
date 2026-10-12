import { describe, it, expect } from 'vitest';
import { computeMintTxId } from '@dagsocial/types';
import type { MintReason } from '@dagsocial/types';
import {
  MINT_OUTPUT_INDEX,
  GENESIS_SYSTEM_KARMA,
  GENESIS_FAUCET_CREDITS,
  genesisContext,
  genesisCommitteeContext,
  genesisBackerContext,
  mintTxIdFor,
} from '../../src/mint-provenance.js';
import type { MintContext } from '../../src/mint-provenance.js';
import { TEST_GENESIS_PROOF_PAYLOAD } from '../helpers.js';

const pubkey = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const OWNER = pubkey(0x44);

const HEIGHT = 4242;

/** A payload that differs from `TEST_GENESIS_PROOF_PAYLOAD` byte-for-byte —
 *  the second chain in the per-payload binding case below. Byte-wise distinct
 *  by construction so the two derivations cannot agree by coincidence. */
const OTHER_PAYLOAD: Uint8Array = Uint8Array.from(
  TEST_GENESIS_PROOF_PAYLOAD,
  (b) => b ^ 0xff,
);

const ALL_CONTEXTS = {
  genesis: { ctx: genesisContext(GENESIS_SYSTEM_KARMA), bytes: 4 },
  'genesis-committee': { ctx: genesisCommitteeContext(OWNER), bytes: 32 },
  'genesis-backer': { ctx: genesisBackerContext(OWNER), bytes: 32 },
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

  it('raw-typed values enter as raw bytes', () => {
    expect(genesisCommitteeContext(OWNER).subject).toEqual(OWNER);
  });

  it('genesis selectors are distinct', () => {
    expect(GENESIS_SYSTEM_KARMA).toBe(0);
    expect(GENESIS_FAUCET_CREDITS).toBe(1);
    expect(mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, genesisContext(GENESIS_SYSTEM_KARMA), 1)).not.toBe(
      mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, genesisContext(GENESIS_FAUCET_CREDITS), 1),
    );
  });

  it('every mint emits exactly one box, so index is 0', () => {
    expect(MINT_OUTPUT_INDEX).toBe(0);
  });
});

describe('mint provenance — txId uniqueness', () => {
  it('all table reasons produce pairwise-distinct txIds at one height', () => {
    const ids = allContexts().map(({ ctx }) => mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, ctx, HEIGHT));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the same reason at different heights produces different txIds', () => {
    expect(mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, genesisContext(GENESIS_SYSTEM_KARMA), HEIGHT)).not.toBe(
      mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, genesisContext(GENESIS_SYSTEM_KARMA), HEIGHT + 1),
    );
  });

  it('mintTxIdFor is exactly computeMintTxId at the derivation height', () => {
    const ctx = genesisContext(GENESIS_SYSTEM_KARMA);
    expect(mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, ctx, HEIGHT)).toBe(
      computeMintTxId(TEST_GENESIS_PROOF_PAYLOAD, HEIGHT, ctx.reason, ctx.subject),
    );
  });

  it('two payloads at one context and height derive two txIds — the mint id opens with the payload', () => {
    // TYPES_INTERFACE → "A mint id opens with its chain's genesis proof": the
    // payload reaches the preimage of every mint id, so one context and height
    // under two payloads cannot derive the same id.
    for (const { ctx } of allContexts()) {
      expect(
        mintTxIdFor(TEST_GENESIS_PROOF_PAYLOAD, ctx, HEIGHT),
        ctx.reason,
      ).not.toBe(mintTxIdFor(OTHER_PAYLOAD, ctx, HEIGHT));
    }
  });
});
