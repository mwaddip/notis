// TYPES_INTERFACE → The JSON form of a transaction: `txToJson` is the one
// renderer for the HTTP edge, and every write route reads JSON back through
// `jsonToTx`. The two meet through the signed bytes — `likeTarget`, `post`
// and `postWithdraw` each sit inside the id's preimage — so the round-trip
// is byte-exact under `computeTxId`.

import { describe, expect, it } from 'vitest';
import {
  computeTxId,
  LIKE_KARMA_COST,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  txToJson,
} from '@dagsocial/types';
import type {
  BondBox,
  CandidateOf,
  KarmaBox,
  KarmaPriceBox,
  UsernameBox,
  UtxoTransaction,
  VouchBox,
  VouchEscrowBox,
  BackerStakeBox,
  BackerUnstakeBox,
} from '@dagsocial/types';
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import {
  makeKarmaBox,
  makeCreditBox,
  makeCreditTx,
  makeLikeTx,
  makePostTx,
  makeTestIdentity,
  signTransaction,
  toHex,
} from '../helpers.js';

const POST_ID = 'ab'.repeat(32);
const BOX_ID = 'cd'.repeat(32);
const RELEASE_AT = 10;

function expectSameId(tx: UtxoTransaction): void {
  const back = jsonToTx(txToJson(tx), PROTOCOL_VERSION);
  expect(computeTxId(back)).toBe(computeTxId(tx));
}

describe('txToJson is the one JSON renderer — a transaction of each shape round-trips to the same id', () => {
  it('a thread post', () => {
    const author = makeTestIdentity();
    expectSameId(makePostTx(author).tx);
  });

  it('a reply', () => {
    const author = makeTestIdentity();
    const parent = makeTestIdentity();
    expectSameId(makePostTx(author, 'r', { parentRefs: [POST_ID] }, parent.userId).tx);
  });

  it('a like', () => {
    const liker = makeTestIdentity();
    const author = makeTestIdentity();
    const karma = makeKarmaBox(LIKE_KARMA_COST + 1n, liker.userId, 1, 1);
    expectSameId(makeLikeTx(liker, karma, POST_ID, author.userId));
  });

  it('a vouch', () => {
    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const karma = makeKarmaBox(100n, voucher.userId, 1, 2);
    const stake = 1n;
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value - stake, createdAtBlock: 1, owner: voucher.userId } as CandidateOf<KarmaBox>,
        { boxType: 'vouch', value: stake, createdAtBlock: 1, voucherId: voucher.userId, targetId: target.userId } as CandidateOf<VouchBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.privateKey, toHex(voucher.userId));
    expectSameId(tx);
  });

  it('an unvouch', () => {
    const voucher = makeTestIdentity();
    const tx: UtxoTransaction = {
      inputs: [BOX_ID],
      outputs: [
        {
          boxType: 'vouch_escrow',
          value: 1n,
          createdAtBlock: 1,
          owner: voucher.userId,
          releaseAtBlock: RELEASE_AT,
        } as CandidateOf<VouchEscrowBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, voucher.privateKey, toHex(voucher.userId));
    expectSameId(tx);
  });

  it('an invite', () => {
    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const karma = makeKarmaBox(100n, inviter.userId, 1, 3);
    const bond = 25n;
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value - bond, createdAtBlock: 1, owner: inviter.userId } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: bond, createdAtBlock: 1, inviterId: inviter.userId, inviteePublicKey: invitee.userId } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviter.privateKey, toHex(inviter.userId));
    expectSameId(tx);
  });

  it('a credit transfer', () => {
    const spender = makeTestIdentity();
    const credit = makeCreditBox(100n, spender.userId, 1, 4);
    expectSameId(makeCreditTx(spender, [credit], 1n));
  });

  it('a username claim', () => {
    const claimant = makeTestIdentity();
    const karma = makeKarmaBox(POST_PRICE_THREAD + 1n, claimant.userId, 1, 5);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value, createdAtBlock: 1, owner: claimant.userId } as CandidateOf<KarmaBox>,
        {
          boxType: 'username',
          value: 0n as 0n,
          createdAtBlock: 1,
          owner: claimant.userId,
          name: new TextEncoder().encode('Claimer'),
        } as CandidateOf<UsernameBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, claimant.privateKey, toHex(claimant.userId));
    expectSameId(tx);
  });

  it('a username burn', () => {
    const holder = makeTestIdentity();
    const karma = makeKarmaBox(POST_PRICE_THREAD + 10n, holder.userId, 1, 6);
    const tx: UtxoTransaction = {
      inputs: [BOX_ID, karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value, createdAtBlock: 1, owner: holder.userId } as CandidateOf<KarmaBox>,
        { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: 1 } as CandidateOf<KarmaPriceBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, toHex(holder.userId));
    expectSameId(tx);
  });

  it('a backer unstake', () => {
    const holder = makeTestIdentity();
    const tx: UtxoTransaction = {
      inputs: [BOX_ID],
      outputs: [
        { boxType: 'backer_stake', value: 0n as 0n, createdAtBlock: 1, owner: holder.userId, weight: 60n } as CandidateOf<BackerStakeBox>,
        { boxType: 'backer_unstake', value: 0n as 0n, createdAtBlock: 1, owner: holder.userId, weight: 40n } as CandidateOf<BackerUnstakeBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, holder.privateKey, toHex(holder.userId));
    expectSameId(tx);
  });

  it('a post withdrawal', () => {
    const author = makeTestIdentity();
    const karma = makeKarmaBox(10n, author.userId, 1, 7);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value, createdAtBlock: 1, owner: author.userId } as CandidateOf<KarmaBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId: POST_ID },
    };
    signTransaction(tx, author.privateKey, toHex(author.userId));
    expectSameId(tx);
  });
});
