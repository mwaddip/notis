// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeTx, decodeTx, POST_PRICE_THREAD, POST_PRICE_REPLY, LIKE_KARMA_COST, USERNAME_BURN_PRICE } from '@dagsocial/types';
import type { UtxoTransaction, AnyBoxCandidate } from '@dagsocial/types';
import {
  buildPost, buildLike, buildVouch, buildUnvouch, buildInvite, buildWithdraw, buildClaim, buildBurn,
  type BuildContext,
} from '../src/wallet/builders';
import { classifyLedger, summarise } from '../src/extension/policy';

// The classification and summary are pure, and the truth is the wallet's own
// builders. A transaction is built with the shape the flow produces, the
// summary is derived from the encoded → decoded transaction (so no test
// artefact rides on the builder's own object identity), and the assertion
// pins the summary WEB_INTERFACE → "The summary the prompt shows is derived
// from the transaction" spells out.

const SIGNER = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);
const BOX = '11'.repeat(32);
const PARENT = 'cc'.repeat(32);
const TARGET_POST = 'dd'.repeat(32);
const TARGET_KEY = 'ee'.repeat(32);
const INVITEE = '22'.repeat(32);
const VOUCH_BOX = '33'.repeat(32);

function ctx(spendableValue = 227n): BuildContext {
  return {
    spendable: [{ boxId: BOX, value: spendableValue }],
    height: 6000,
    era: 1,
    author: SIGNER,
  };
}

/** Round-trip the built tx through encodeTx/decodeTx so the summary reads from
 *  the shape the wire produces, not the builder's own reference. */
function roundtrip(tx: UtxoTransaction): UtxoTransaction {
  return decodeTx(encodeTx(tx));
}

describe('classifyLedger — the ledger is read from the outputs', () => {
  it('a thread is karma-side', () => {
    const { tx } = buildPost(ctx(), 'a thread');
    expect(classifyLedger(roundtrip(tx))).toBe('karma');
  });

  it('every karma-side builder produces a karma-side transaction', () => {
    for (const tx of [
      buildPost(ctx(), 'a thread').tx,
      buildPost(ctx(), 'a reply', { id: PARENT, authorHex: AUTHOR }).tx,
      buildLike(ctx(), TARGET_POST, AUTHOR).tx,
      buildVouch(ctx(), TARGET_KEY).tx,
      buildUnvouch(ctx(), { boxId: VOUCH_BOX, value: 1n, createdAtBlock: 5900 }, 100).tx,
      buildInvite(ctx(), INVITEE, 100n).tx,
      buildWithdraw(ctx(), TARGET_POST).tx,
      buildClaim(ctx(), 'Alice_01').tx,
      buildBurn(ctx(), { boxId: '44'.repeat(32) }).tx,
    ]) {
      expect(classifyLedger(roundtrip(tx))).toBe('karma');
    }
  });

  it('a credit output names credits-side', () => {
    // The client has no credit builder yet; build a hand-shaped tx.
    const tx: UtxoTransaction = {
      inputs: [BOX],
      outputs: [
        { boxType: 'credit', value: 12n, createdAtBlock: 6000, owner: hexToBytes(TARGET_KEY) },
        { boxType: 'fee', value: 1n, createdAtBlock: 6000 },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: 1,
    };
    expect(classifyLedger(tx)).toBe('credits');
  });

  it('a whole-input fee (credit → fee) is credits-side', () => {
    const tx: UtxoTransaction = {
      inputs: [BOX],
      outputs: [{ boxType: 'fee', value: 12n, createdAtBlock: 6000 }] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: 1,
    };
    expect(classifyLedger(tx)).toBe('credits');
  });
});

describe('summarise — the derived summary matches the transaction shape', () => {
  it('a thread names spendRep as the karma_price', () => {
    const { tx } = buildPost(ctx(), 'a thread');
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'thread', spendRep: POST_PRICE_THREAD.toString() });
  });

  it('a reply names spendRep as karma_price + like_accrual', () => {
    const { tx } = buildPost(ctx(), 'a reply', { id: PARENT, authorHex: AUTHOR });
    // A reply spends POST_PRICE_REPLY altogether: karma_price + like_accrual sum to it.
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'reply', spendRep: POST_PRICE_REPLY.toString() });
  });

  it('a like names its target and spendRep = LIKE_KARMA_COST (the like_accrual)', () => {
    const { tx } = buildLike(ctx(), TARGET_POST, AUTHOR);
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'like', targetHex: TARGET_POST, spendRep: LIKE_KARMA_COST.toString() });
  });

  it('a withdraw names its post id and spends nothing', () => {
    const { tx } = buildWithdraw(ctx(), TARGET_POST);
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'withdraw', postId: TARGET_POST });
  });

  it('a vouch names its target and its value', () => {
    const { tx } = buildVouch(ctx(), TARGET_KEY);
    const s = summarise(roundtrip(tx), SIGNER);
    expect(s.kind).toBe('vouch');
    if (s.kind !== 'vouch') return;
    expect(s.targetHex).toBe(TARGET_KEY);
    expect(BigInt(s.spendRep)).toBeGreaterThan(0n);
  });

  it('an unvouch carries no target — the VouchEscrowBox has none and the input vouch is an id only', () => {
    const { tx } = buildUnvouch(ctx(), { boxId: VOUCH_BOX, value: 1n, createdAtBlock: 5900 }, 100);
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'unvouch' });
  });

  it('an invite names the invitee and the bond\'s value', () => {
    const { tx } = buildInvite(ctx(), INVITEE, 100n);
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'invite', inviteeHex: INVITEE, spendRep: '100' });
  });

  it('a claim names the name and spends nothing', () => {
    const { tx } = buildClaim(ctx(), 'Alice_01');
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'claim', name: 'Alice_01' });
  });

  it('a burn is a karma_price with post and likeTarget absent — spends USERNAME_BURN_PRICE, no name', () => {
    const { tx } = buildBurn(ctx(), { boxId: '44'.repeat(32) });
    expect(summarise(roundtrip(tx), SIGNER)).toEqual({ kind: 'burn', spendRep: USERNAME_BURN_PRICE.toString() });
  });

  it('a bare karma consolidation — karma in, karma change out — reads as `other` and does not throw', () => {
    // Karma to the signer as change, nothing else. Legal on the ledger; the
    // client never builds one, so the summary is the catch-all rather than a
    // throw the dispatcher would surface as a rejected message promise.
    const tx: UtxoTransaction = {
      inputs: [BOX],
      outputs: [
        { boxType: 'karma', value: 200n, createdAtBlock: 6000, owner: hexToBytes(SIGNER) },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: 1,
    };
    expect(summarise(tx, SIGNER)).toEqual({ kind: 'other', spendRep: '0' });
  });

  it('credits: signer-owned outputs are change, never listed as sent', () => {
    // 12 to another key, 5 back to the signer as change, 1 fee — the summary
    // names the send to the other key and the fee, and nothing else.
    const tx: UtxoTransaction = {
      inputs: [BOX],
      outputs: [
        { boxType: 'credit', value: 12n, createdAtBlock: 6000, owner: hexToBytes(TARGET_KEY) },
        { boxType: 'credit', value: 5n, createdAtBlock: 6000, owner: hexToBytes(SIGNER) },
        { boxType: 'fee', value: 1n, createdAtBlock: 6000 },
      ] as AnyBoxCandidate[],
      signatures: {},
      protocolVersion: 1,
    };
    expect(summarise(tx, SIGNER)).toEqual({
      kind: 'credits',
      sends: [{ ownerHex: TARGET_KEY, value: '12' }],
      feeValue: '1',
    });
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
