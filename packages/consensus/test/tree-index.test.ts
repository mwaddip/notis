import { describe, it, expect } from 'vitest';
import {
  INDEX_MARKER,
  accrualOfKey,
  bondDueKey,
  creditOfKey,
  escrowDueKey,
  escrowOfKey,
  hexToBytes,
  karmaOfKey,
  typeKey,
  vouchPairKey,
  vouchPairValue,
} from '@dagsocial/types';
import type { AnyBox } from '@dagsocial/types';
import { indexEntriesOfBox, isLapsedMember } from '@dagsocial/consensus';
import { identityRecord, seedProvenance, uid } from './helpers.js';

/**
 * The index entries (CONSENSUS_INTERFACE → The index entries): what each of the
 * sixteen box types places beside its own key, and the record half of the
 * `lapsed` condition.
 */

const [owner, other] = [uid('tree-index/owner'), uid('tree-index/other')];

let nonce = 0;
const stored = (candidate: object): AnyBox => seedProvenance<AnyBox>(candidate, 1, nonce++);

/** One stored box of every type — `satisfies` fails the compile when a type is missing. */
const boxes = {
  karma: stored({ boxType: 'karma', value: 5n, createdAtBlock: 1, owner }),
  credit: stored({ boxType: 'credit', value: 5n, createdAtBlock: 1, owner }),
  genesis_proof: stored({ boxType: 'genesis_proof', value: 0n, createdAtBlock: 0, payload: Uint8Array.of(1, 2, 3) }),
  bond: stored({ boxType: 'bond', value: 25n, createdAtBlock: 3, inviterId: owner, inviteePublicKey: other }),
  username: stored({ boxType: 'username', value: 0n, createdAtBlock: 1, owner, name: new TextEncoder().encode('alpha') }),
  vouch: stored({ boxType: 'vouch', value: 1n, createdAtBlock: 1, voucherId: owner, targetId: other }),
  vouch_escrow: stored({ boxType: 'vouch_escrow', value: 1n, createdAtBlock: 1, owner, releaseAtBlock: 7 }),
  like_accrual: stored({ boxType: 'like_accrual', value: 1n, createdAtBlock: 1, author: other }),
  karma_price: stored({ boxType: 'karma_price', value: 5n, createdAtBlock: 1 }),
  emission: stored({ boxType: 'emission', value: 100n, createdAtBlock: 0 }),
  treasury: stored({ boxType: 'treasury', value: 1n, createdAtBlock: 1 }),
  fee: stored({ boxType: 'fee', value: 1n, createdAtBlock: 1 }),
  karma_pool: stored({ boxType: 'karma_pool', value: 100n, createdAtBlock: 0 }),
  backer_stake: stored({ boxType: 'backer_stake', value: 0n, createdAtBlock: 0, owner, weight: 10n }),
  backer_unstake: stored({ boxType: 'backer_unstake', value: 0n, createdAtBlock: 1, owner, weight: 4n }),
  backer_pool: stored({ boxType: 'backer_pool', value: 0n, createdAtBlock: 0, staked: 10n, accrual: 0n }),
} satisfies Record<AnyBox['boxType'], AnyBox>;

const idOf = (box: AnyBox): Uint8Array => hexToBytes(box.id!);
const marker = (key: Uint8Array): { key: Uint8Array; value: Uint8Array } => ({ key, value: INDEX_MARKER });

describe('indexEntriesOfBox', () => {
  it('places each box type\'s entries, and none for a type no read walks', () => {
    expect(indexEntriesOfBox(boxes.karma)).toEqual([marker(karmaOfKey(owner, idOf(boxes.karma)))]);
    expect(indexEntriesOfBox(boxes.credit)).toEqual([marker(creditOfKey(owner, idOf(boxes.credit)))]);
    expect(indexEntriesOfBox(boxes.vouch_escrow)).toEqual([
      marker(escrowOfKey(owner, idOf(boxes.vouch_escrow))),
      marker(escrowDueKey(7, idOf(boxes.vouch_escrow))),
    ]);
    expect(indexEntriesOfBox(boxes.bond, 4)).toEqual([marker(bondDueKey(4, idOf(boxes.bond)))]);
    expect(indexEntriesOfBox(boxes.vouch)).toEqual([
      { key: vouchPairKey(owner, other), value: vouchPairValue(idOf(boxes.vouch)) },
    ]);
    expect(indexEntriesOfBox(boxes.like_accrual)).toEqual([marker(accrualOfKey(other, idOf(boxes.like_accrual)))]);
    for (const boxType of ['emission', 'treasury', 'karma_pool', 'backer_pool'] as const) {
      expect(indexEntriesOfBox(boxes[boxType]), boxType).toEqual([marker(typeKey(boxType, idOf(boxes[boxType])))]);
    }
    for (const boxType of ['genesis_proof', 'username', 'karma_price', 'fee', 'backer_stake', 'backer_unstake'] as const) {
      expect(indexEntriesOfBox(boxes[boxType]), boxType).toEqual([]);
    }
  });

  it('keys a bond by the grant height it is handed, never its declared height, and throws for a bond handed none', () => {
    expect(indexEntriesOfBox(boxes.bond, 9)).toEqual([marker(bondDueKey(9, idOf(boxes.bond)))]);
    expect(() => indexEntriesOfBox(boxes.bond)).toThrow(/invitedAtBlock/);
    expect(() => indexEntriesOfBox(boxes.bond, 0)).toThrow(/invitedAtBlock/);
  });

  it('reads the height for a bond alone', () => {
    expect(indexEntriesOfBox(boxes.karma, 9)).toEqual(indexEntriesOfBox(boxes.karma));
    expect(indexEntriesOfBox(boxes.vouch_escrow, 9)).toEqual(indexEntriesOfBox(boxes.vouch_escrow));
  });

  it('throws for a box that carries no id', () => {
    const { id: _id, ...unnamed } = boxes.karma;
    expect(() => indexEntriesOfBox(unnamed as AnyBox)).toThrow(/no id/);
  });
});

describe('isLapsedMember', () => {
  it('holds for a member whose vouches fell below the bar, and for no other record', () => {
    expect(isLapsedMember(identityRecord({ memberSinceBlock: 2, memberBar: 2, memberVouches: 1 }))).toBe(true);
    expect(isLapsedMember(identityRecord({ memberSinceBlock: 2, memberBar: 2, memberVouches: 2 }))).toBe(false);
    expect(isLapsedMember(identityRecord({ memberSinceBlock: 1, memberBar: 0 }))).toBe(false);
    expect(isLapsedMember(identityRecord({ memberBar: 2 }))).toBe(false);
    expect(isLapsedMember(null)).toBe(false);
  });
});
