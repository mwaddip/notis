import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  TREE_KEY_LENGTH,
  accrualOfRange,
  bondDueRange,
  bytesToHex,
  escrowDueRange,
  hexToBytes,
  karmaOfRange,
  lapsedRange,
  rangeStart,
  typeRange,
  vouchPairRange,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord } from '@dagsocial/types';
import { seedTreeWrites } from '@dagsocial/consensus';
import type { TreeWrite } from '@dagsocial/consensus';
import { createAvlProver } from '../../src/state/avl-prover.js';
import type { AvlProverHandle } from '../../src/state/avl-prover.js';
import { proverSession } from '../../src/state/prover-session.js';
import { openAvlDb, seedProvenance, uid } from '../helpers.js';
import { mapSessionFrom } from '../tree-session-map.js';

/**
 * The session over the node's prover (CONSENSUS_INTERFACE → The tree session)
 * answers every lookup as the reference session over a sorted array does: a
 * present key's value and the next key, an absent key's two neighbours, the
 * neighbour past either end a sentinel.
 */

const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map((name) => uid(`prover-session/${name}`)) as [
  Uint8Array, Uint8Array, Uint8Array, Uint8Array,
];

function record(fields: Partial<IdentityRecord>): IdentityRecord {
  return {
    lastActivityBlock: 0,
    lastDecayBlock: 0,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 0,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
    ...fields,
  };
}

/**
 * A state whose seed writes every tag genesis can: each box kind with an index
 * entry, a bond whose invitee holds a record, a voucher's cast count, a lapsed
 * member who casts, the network record.
 */
function seedWrites(): TreeWrite[] {
  const boxes: AnyBox[] = [
    seedProvenance({ boxType: 'karma', value: 40n, createdAtBlock: 1, owner: alice }, 1, 1),
    seedProvenance({ boxType: 'karma', value: 7n, createdAtBlock: 1, owner: alice }, 1, 2),
    seedProvenance({ boxType: 'credit', value: 900n, createdAtBlock: 1, owner: bob }, 1, 3),
    seedProvenance({ boxType: 'vouch_escrow', value: 1n, createdAtBlock: 1, owner: carol, releaseAtBlock: 9 }, 1, 4),
    seedProvenance({ boxType: 'vouch', value: 1n, createdAtBlock: 1, voucherId: bob, targetId: alice }, 1, 5),
    seedProvenance({ boxType: 'like_accrual', value: 3n, createdAtBlock: 1, author: carol }, 1, 6),
    seedProvenance({ boxType: 'bond', value: 25n, createdAtBlock: 1, inviterId: alice, inviteePublicKey: dave }, 1, 7),
    seedProvenance({ boxType: 'emission', value: 5_000n, createdAtBlock: 0 }, 0, 8),
    seedProvenance({ boxType: 'karma_pool', value: 6_000n, createdAtBlock: 0 }, 0, 9),
  ];
  return seedTreeWrites(
    boxes,
    [
      { identityId: alice, record: record({ memberSinceBlock: 1, memberBar: 1, memberVouches: 1 }) },
      { identityId: bob, record: record({ memberSinceBlock: 1, memberBar: 2, memberVouches: 1 }) },
      { identityId: dave, record: record({ invitedAtBlock: 6 }) },
    ],
    { memberCount: 2 },
  );
}

/** The key one above `key`, as a big-endian number of `TREE_KEY_LENGTH` bytes. */
function successor(key: Uint8Array): Uint8Array {
  const next = Uint8Array.from(key);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] !== 0xff) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0x00;
  }
  throw new Error('no key above the all-0xff key');
}

const BELOW_FIRST = new Uint8Array(TREE_KEY_LENGTH).fill(0x00);
const PAST_LAST = new Uint8Array(TREE_KEY_LENGTH).fill(0xff);

describe('proverSession', () => {
  let db: Database.Database;
  let handle: AvlProverHandle;

  beforeEach(() => {
    db = openAvlDb();
    handle = createAvlProver(db);
  });

  afterEach(() => { db.close(); });

  function seeded(writes: readonly TreeWrite[]): void {
    for (const write of writes) {
      expect(handle.prover.performOneOperation(write).success, bytesToHex(write.key)).toBe(true);
    }
  }

  it('answers every present key as the reference session does', () => {
    const writes = seedWrites();
    seeded(writes);
    const reference = mapSessionFrom(writes);
    const session = proverSession(handle.prover);

    const present = reference.entries().map(([key]) => hexToBytes(key));
    expect(present).toHaveLength(writes.length);
    for (const key of present) {
      expect(session.lookup(key), bytesToHex(key)).toEqual(reference.lookup(key));
    }
  });

  it('answers an absent key between two leaves, below the first and past the last as the reference session does', () => {
    const writes = seedWrites();
    seeded(writes);
    const reference = mapSessionFrom(writes);
    const session = proverSession(handle.prover);
    const present = reference.entries().map(([key]) => hexToBytes(key));

    const absent: Uint8Array[] = [
      successor(BELOW_FIRST), // below the first leaf
      Uint8Array.from(PAST_LAST).fill(0xfe, TREE_KEY_LENGTH - 1), // past the last leaf
      ...present.map(successor), // between each leaf and the next, and past the last
      // The starts of the walks the tree view makes.
      rangeStart(karmaOfRange(alice)),
      rangeStart(escrowDueRange()),
      rangeStart(bondDueRange()),
      rangeStart(vouchPairRange(bob)),
      rangeStart(lapsedRange()),
      rangeStart(accrualOfRange(carol)),
      rangeStart(typeRange('emission')),
      rangeStart(typeRange('treasury')),
    ];
    for (const key of absent) {
      const expected = reference.lookup(key);
      expect(expected.found, bytesToHex(key)).toBe(false);
      expect(session.lookup(key), bytesToHex(key)).toEqual(expected);
    }
  });

  it('answers the empty tree as the reference session does — both neighbours sentinels', () => {
    const session = proverSession(handle.prover);
    const key = successor(BELOW_FIRST);
    expect(session.lookup(key)).toEqual(mapSessionFrom([]).lookup(key));
    expect(session.lookup(key)).toEqual({ found: false, prevKey: BELOW_FIRST, nextKey: PAST_LAST });
  });

  it('refuses a lookup of either sentinel, as the library does', () => {
    seeded(seedWrites());
    const session = proverSession(handle.prover);
    expect(() => session.lookup(Uint8Array.from(BELOW_FIRST))).toThrow();
    expect(() => session.lookup(Uint8Array.from(PAST_LAST))).toThrow();
  });

  it('never hands back an array it has handed back before — a caller may keep and write every answer', () => {
    const writes = seedWrites();
    seeded(writes);
    const session = proverSession(handle.prover);
    const leaves = mapSessionFrom(writes).entries();
    const first = hexToBytes(leaves[0]![0]);
    const [lastKey, lastValue] = leaves[leaves.length - 1]!;
    const last = hexToBytes(lastKey);

    const atLast = session.lookup(last);
    if (!atLast.found) throw new Error('the last leaf is absent');
    atLast.value.fill(0);
    atLast.nextKey.fill(0);
    const below = session.lookup(successor(BELOW_FIRST));
    if (below.found) throw new Error('a key below the first leaf is present');
    below.prevKey.fill(0xff);
    below.nextKey.fill(0);

    const again = session.lookup(last);
    if (!again.found) throw new Error('the last leaf is absent');
    expect(bytesToHex(again.value)).toBe(lastValue);
    expect(again.nextKey).toEqual(PAST_LAST);
    expect(session.lookup(successor(BELOW_FIRST))).toEqual({ found: false, prevKey: BELOW_FIRST, nextKey: first });
  });
});
