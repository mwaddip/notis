import { describe, it, expect } from 'vitest';
import {
  INDEX_MARKER,
  boxKey,
  boxRecordBytes,
  bondDueKey,
  castCountBytes,
  castCountKey,
  hexToBytes,
  identityKey,
  identityRecordBytes,
  lapsedKey,
  networkKey,
  networkRecordBytes,
  vouchPairKey,
  vouchPairValue,
} from '@dagsocial/types';
import type { AnyBox, CreditBox, IdentityRecord } from '@dagsocial/types';
import { seedTreeWrites } from '@dagsocial/consensus';
import type { TreeWrite } from '@dagsocial/consensus';
import { bondBox, escrowBox, identityRecord, karmaBox, seedProvenance, uid, vouchBox } from './helpers.js';

/**
 * The tree writes (CONSENSUS_INTERFACE → The tree writes): genesis as ordered
 * `Insert`s.
 */

const [alice, bob, carol] = [uid('tree-writes/alice'), uid('tree-writes/bob'), uid('tree-writes/carol')];

const member = identityRecord({ memberSinceBlock: 1, memberBar: 1, memberVouches: 1 });
const lapsed = identityRecord({ memberSinceBlock: 1, memberBar: 2, memberVouches: 1 });
const invitedAt = (h: number): IdentityRecord => identityRecord({ invitedAtBlock: h });

const idOf = (box: AnyBox): Uint8Array => hexToBytes(box.id!);

const creditOf = (owner: Uint8Array, value: bigint, nonce: number): CreditBox =>
  seedProvenance<CreditBox>({ boxType: 'credit', value, createdAtBlock: 1, owner }, 1, nonce);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const K = karmaBox(alice, 5n, 1);
const C = creditOf(bob, 7n, 2);
const E = escrowBox(carol, 9, 3);

describe('seedTreeWrites', () => {
  it('seeds genesis as Inserts in key order', () => {
    const w = seedTreeWrites([K, C, E], [{ identityId: alice, record: member }], { memberCount: 1 });
    expect(w.every((x) => x.tag === 'Insert')).toBe(true);
    for (let i = 1; i < w.length; i++) expect(compareBytes(w[i - 1]!.key, w[i]!.key)).toBe(-1);
  });

  it('seeds every box with its entries, each voucher\'s cast count, every record with its lapsed entry, and the network record', () => {
    const V = vouchBox(bob, alice, 4);
    const B = bondBox(alice, carol, 5, 1);
    const w = seedTreeWrites(
      [V, B],
      [{ identityId: bob, record: lapsed }, { identityId: carol, record: invitedAt(6) }],
      { memberCount: 2 },
    );
    const insert = (key: Uint8Array, value: Uint8Array): TreeWrite => ({ tag: 'Insert', key, value });
    expect(w).toEqual([
      insert(boxKey(idOf(V)), boxRecordBytes(V, V.txId, V.index)),
      insert(boxKey(idOf(B)), boxRecordBytes(B, B.txId, B.index)),
      insert(identityKey(bob), identityRecordBytes(lapsed)),
      insert(identityKey(carol), identityRecordBytes(invitedAt(6))),
      insert(networkKey(), networkRecordBytes({ memberCount: 2 })),
      insert(bondDueKey(6, idOf(B)), INDEX_MARKER),
      insert(vouchPairKey(bob, alice), vouchPairValue(idOf(V))),
      insert(lapsedKey(bob), INDEX_MARKER),
      insert(castCountKey(bob), castCountBytes(1)),
    ].sort((a, b) => compareBytes(a.key, b.key)));
  });

  it('places no lapsed entry for a lapsed member who casts nothing, nor for a member who casts', () => {
    const V = vouchBox(alice, bob, 6);
    const w = seedTreeWrites([V], [{ identityId: alice, record: member }, { identityId: carol, record: lapsed }], { memberCount: 1 });
    expect(w.some((x) => x.key[0] === lapsedKey(alice)[0])).toBe(false);
  });

  it('refuses a bond whose invitee holds no record among the seed\'s', () => {
    expect(() => seedTreeWrites([bondBox(alice, carol, 7, 1)], [], { memberCount: 0 })).toThrow(/invitee/);
  });

  it('refuses a seed that writes one key twice', () => {
    expect(() => seedTreeWrites([], [
      { identityId: alice, record: member },
      { identityId: new Uint8Array(alice), record: lapsed },
    ], { memberCount: 1 })).toThrow(/two writes/);
  });
});
