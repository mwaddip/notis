/**
 * `txToJson` — the node's write routes read its answer
 * (TYPES_INTERFACE → The JSON form of a transaction). Every expected object is
 * written out by hand.
 */

import { describe, it, expect } from 'vitest';
import { BOX_TYPE_TAGS, txToJson } from '../src/index.js';
import type { AnyBoxCandidate, UtxoTransaction } from '../src/index.js';

const bytes = (fill: number, n = 32): Uint8Array => new Uint8Array(n).fill(fill);
const hex = (byte: string, n = 32): string => byte.repeat(n);

const ID_A = 'a1'.repeat(32);
const ID_B = 'b2'.repeat(32);
const ID_C = 'c3'.repeat(32);

function plain(outputs: AnyBoxCandidate[]): UtxoTransaction {
  return { inputs: [ID_A], outputs, signatures: {}, protocolVersion: 1 };
}

describe('txToJson', () => {
  it('renders a transaction holding every optional field to the hand-written object', () => {
    const tx: UtxoTransaction = {
      inputs: [ID_A, ID_B],
      outputs: [
        { boxType: 'karma', value: 9007199254740993n, createdAtBlock: 7, owner: bytes(0x11) },
      ],
      signatures: { [hex('22')]: bytes(0x33, 64) },
      protocolVersion: 1,
      likeTarget: ID_C,
      post: {
        contentHash: bytes(0x44),
        author: bytes(0x55),
        parentRefs: [ID_B],
        protocolVersion: 1,
        type: 'regular',
      },
      postWithdraw: { postId: ID_A },
    };
    expect(txToJson(tx)).toEqual({
      inputs: [ID_A, ID_B],
      outputs: [
        { boxType: 'karma', value: '9007199254740993', createdAtBlock: 7, owner: '11'.repeat(32) },
      ],
      signatures: { [hex('22')]: '33'.repeat(64) },
      protocolVersion: 1,
      likeTarget: ID_C,
      post: {
        contentHash: '44'.repeat(32),
        author: '55'.repeat(32),
        parentRefs: [ID_B],
        protocolVersion: 1,
        type: 'regular',
      },
      postWithdraw: { postId: ID_A },
    });
  });

  it('carries no key for an optional field the transaction does not hold', () => {
    const tx = plain([{ boxType: 'fee', value: 5n, createdAtBlock: 1 }]);
    const json = txToJson(tx);
    expect(json).toEqual({
      inputs: [ID_A],
      outputs: [{ boxType: 'fee', value: '5', createdAtBlock: 1 }],
      signatures: {},
      protocolVersion: 1,
    });
    expect(Object.keys(json).sort()).toEqual(['inputs', 'outputs', 'protocolVersion', 'signatures']);
  });

  it('carries postWithdraw alone when it is the only optional field', () => {
    const json = txToJson({ ...plain([]), postWithdraw: { postId: ID_B } });
    expect(json.postWithdraw).toEqual({ postId: ID_B });
    expect('likeTarget' in json).toBe(false);
    expect('post' in json).toBe(false);
  });

  const o = (byte: number) => bytes(byte);
  const cases: Record<keyof typeof BOX_TYPE_TAGS, [AnyBoxCandidate, Record<string, unknown>]> = {
    karma: [
      { boxType: 'karma', value: 1n, createdAtBlock: 2, owner: o(0x01), income: true },
      { boxType: 'karma', value: '1', createdAtBlock: 2, owner: '01'.repeat(32), income: true },
    ],
    credit: [
      { boxType: 'credit', value: 2n, createdAtBlock: 3, owner: o(0x02), lockedUntilBlock: 9 },
      { boxType: 'credit', value: '2', createdAtBlock: 3, owner: '02'.repeat(32), lockedUntilBlock: 9 },
    ],
    genesis_proof: [
      { boxType: 'genesis_proof', value: 0n, createdAtBlock: 0, payload: new Uint8Array([0xde, 0xad, 0x0f]) },
      { boxType: 'genesis_proof', value: '0', createdAtBlock: 0, payload: 'dead0f' },
    ],
    bond: [
      { boxType: 'bond', value: 30n, createdAtBlock: 4, inviterId: o(0x03), inviteePublicKey: o(0x04) },
      { boxType: 'bond', value: '30', createdAtBlock: 4, inviterId: '03'.repeat(32), inviteePublicKey: '04'.repeat(32) },
    ],
    vouch: [
      { boxType: 'vouch', value: 1n, createdAtBlock: 5, voucherId: o(0x05), targetId: o(0x06) },
      { boxType: 'vouch', value: '1', createdAtBlock: 5, voucherId: '05'.repeat(32), targetId: '06'.repeat(32) },
    ],
    emission: [
      { boxType: 'emission', value: 40n, createdAtBlock: 6 },
      { boxType: 'emission', value: '40', createdAtBlock: 6 },
    ],
    treasury: [
      { boxType: 'treasury', value: 41n, createdAtBlock: 6 },
      { boxType: 'treasury', value: '41', createdAtBlock: 6 },
    ],
    fee: [
      { boxType: 'fee', value: 42n, createdAtBlock: 6 },
      { boxType: 'fee', value: '42', createdAtBlock: 6 },
    ],
    karma_pool: [
      { boxType: 'karma_pool', value: 43n, createdAtBlock: 6 },
      { boxType: 'karma_pool', value: '43', createdAtBlock: 6 },
    ],
    like_accrual: [
      { boxType: 'like_accrual', value: 3n, createdAtBlock: 7, author: o(0x07) },
      { boxType: 'like_accrual', value: '3', createdAtBlock: 7, author: '07'.repeat(32) },
    ],
    vouch_escrow: [
      { boxType: 'vouch_escrow', value: 1n, createdAtBlock: 8, owner: o(0x08), releaseAtBlock: 99 },
      { boxType: 'vouch_escrow', value: '1', createdAtBlock: 8, owner: '08'.repeat(32), releaseAtBlock: 99 },
    ],
    karma_price: [
      { boxType: 'karma_price', value: 100n, createdAtBlock: 9 },
      { boxType: 'karma_price', value: '100', createdAtBlock: 9 },
    ],
    username: [
      { boxType: 'username', value: 0n, createdAtBlock: 10, owner: o(0x09), name: new Uint8Array([0x61, 0x5f, 0x42]) },
      { boxType: 'username', value: '0', createdAtBlock: 10, owner: '09'.repeat(32), name: '615f42' },
    ],
    backer_stake: [
      { boxType: 'backer_stake', value: 0n, createdAtBlock: 11, owner: o(0x0a), weight: 123456789012345678901n },
      { boxType: 'backer_stake', value: '0', createdAtBlock: 11, owner: '0a'.repeat(32), weight: '123456789012345678901' },
    ],
    backer_unstake: [
      { boxType: 'backer_unstake', value: 0n, createdAtBlock: 12, owner: o(0x0b), weight: 77n },
      { boxType: 'backer_unstake', value: '0', createdAtBlock: 12, owner: '0b'.repeat(32), weight: '77' },
    ],
    backer_pool: [
      { boxType: 'backer_pool', value: 5n, createdAtBlock: 13, staked: 6n, accrual: 7n },
      { boxType: 'backer_pool', value: '5', createdAtBlock: 13, staked: '6', accrual: '7' },
    ],
  };

  it('has a case for every output type the codec knows', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(BOX_TYPE_TAGS).sort());
  });

  for (const [type, [candidate, expected]] of Object.entries(cases)) {
    it(`renders the ${type} output with lowercase hex bytes and decimal-string bigints`, () => {
      expect(txToJson(plain([candidate])).outputs).toEqual([expected]);
    });
  }
});
