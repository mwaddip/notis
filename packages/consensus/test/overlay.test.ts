import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, computeTxId, decodeTx, encodeTx } from '@dagsocial/types';
import {
  BlockOverlay,
  BoxIdTakenError,
  LimitedQueryAfterWriteError,
  SpendOfNonLiveBoxError,
} from '../src/overlay.js';
import { materializeOutput } from '../src/utxo-engine.js';
import type { AnyBox, AnyBoxCandidate, IdentityRecord, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import type { UsernameRow } from '@dagsocial/consensus';
import {
  MemoryStateView,
  accrualBox,
  bondBox,
  escrowBox,
  hex,
  identityRecord,
  karmaBox,
  protocolBox,
  uid,
  vouchBox,
} from './helpers.js';

/**
 * The overlay's obligations (CONSENSUS_INTERFACE → The overlay): a keyed read
 * answers the block's own entry first; an unlimited query composes the view's
 * answer with the block's writes under its own order; a limited query answers
 * the view's answer until the block writes into its set, then throws; the two
 * backstops; and the view is never written.
 *
 * `MemoryStateView` answers every query from its whole map, so the reference a
 * composition is checked against is a clone of the view with the same writes
 * applied to it directly.
 */

const [alice, bob, carol, dave] = [uid('overlay/alice'), uid('overlay/bob'), uid('overlay/carol'), uid('overlay/dave')];

const ids = (boxes: AnyBox[]): string[] => boxes.map((b) => b.id!);

const nameRow = (nameLower: string, owner: Uint8Array, boxId: string): UsernameRow =>
  ({ nameLower, name: nameLower, owner: hex(owner), boxId, claimedAtBlock: 1 });

const member = identityRecord({ memberSinceBlock: 1, memberBar: 1, memberVouches: 1 });
const lapsedMember = identityRecord({ memberSinceBlock: 1, memberBar: 2, memberVouches: 1 });

/** Every composed query over every pair of the given identities, overlay against reference. */
function expectComposedAgree(overlay: BlockOverlay, reference: MemoryStateView, who: Uint8Array[]): void {
  for (const a of who) {
    expect(overlay.getKarmaBoxes(a)).toEqual(reference.getKarmaBoxes(a));
    expect(overlay.getVouchEscrowsFor(a)).toEqual(reference.getVouchEscrowsFor(a));
    expect(overlay.getLikeAccrualBoxes(a)).toEqual(reference.getLikeAccrualBoxes(a));
    for (const b of who) {
      expect(overlay.getVouchBoxes(a, b)).toEqual(reference.getVouchBoxes(a, b));
    }
  }
}

/** A deterministic sequence in [0, 1). */
function xorshift(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

describe('BlockOverlay — keyed reads answer the block\'s own entry first', () => {
  it('a box: the view\'s while untouched, the inserted box, and none once spent', () => {
    const view = new MemoryStateView();
    const held = karmaBox(alice, 10n, 1);
    const spentBefore = karmaBox(alice, 11n, 2);
    view.insertBox(held);
    view.insertBox(spentBefore);
    view.consumeBox(spentBefore.id);
    const overlay = new BlockOverlay(view);

    expect(overlay.getBox(held.id)).toBe(held);
    expect(overlay.getBox(spentBefore.id)).toBeNull();

    const made = karmaBox(bob, 5n, 3);
    overlay.insertBox(made);
    expect(overlay.getBox(made.id)).toEqual(made);

    overlay.consumeBox(held.id);
    overlay.consumeBox(made.id);
    expect(overlay.getBox(held.id)).toBeNull();
    expect(overlay.getBox(made.id)).toBeNull();
    expect(view.getBox(held.id)).toBe(held);
  });

  it('a box\'s provenance answers for any box the state holds or held, the block\'s included', () => {
    const view = new MemoryStateView();
    const spentBefore = karmaBox(alice, 11n, 2);
    view.insertBox(spentBefore);
    view.consumeBox(spentBefore.id);
    const overlay = new BlockOverlay(view);
    const made = karmaBox(bob, 5n, 3);
    overlay.insertBox(made);
    overlay.consumeBox(made.id);

    expect(overlay.getBoxProvenance(spentBefore.id)).toEqual({ txId: spentBefore.txId, index: spentBefore.index });
    expect(overlay.getBoxProvenance(made.id)).toEqual({ txId: made.txId, index: made.index });
    expect(overlay.getBoxProvenance('00'.repeat(32))).toBeNull();
    expect(view.getBoxProvenance(made.id)).toBeNull();
  });

  it('an identity record: the last write in the block, keyed by the identity\'s bytes', () => {
    const view = new MemoryStateView();
    view.putIdentityRecord(alice, identityRecord({ memberVouches: 1 }));
    const overlay = new BlockOverlay(view);

    expect(overlay.getIdentityRecord(alice)).toEqual(identityRecord({ memberVouches: 1 }));
    const first = identityRecord({ memberVouches: 2 });
    const second = identityRecord({ memberVouches: 3 });
    overlay.putIdentityRecord(alice, first);
    overlay.putIdentityRecord(new Uint8Array(alice), second);
    expect(overlay.getIdentityRecord(alice)).toEqual(second);

    expect(overlay.getIdentityRecord(bob)).toBeNull();
    overlay.putIdentityRecord(bob, first);
    expect(overlay.getIdentityRecord(bob)).toEqual(first);
    expect(view.getIdentityRecord(alice)).toEqual(identityRecord({ memberVouches: 1 }));
    expect(view.getIdentityRecord(bob)).toBeNull();
  });

  it('the network record: the view\'s until the block writes it', () => {
    const view = new MemoryStateView({ memberCount: 4 });
    const overlay = new BlockOverlay(view);
    expect(overlay.getNetworkRecord()).toEqual({ memberCount: 4 });
    overlay.putNetworkRecord({ memberCount: 5 });
    expect(overlay.getNetworkRecord()).toEqual({ memberCount: 5 });
    expect(view.getNetworkRecord()).toEqual({ memberCount: 4 });
  });

  it('the name and holder records: a burn removes both, a claim writes both', () => {
    const view = new MemoryStateView();
    const alpha = nameRow('alpha', alice, 'a'.repeat(64));
    view.putUsername(alpha);
    const overlay = new BlockOverlay(view);
    expect(overlay.getUsername('alpha')).toBe(alpha);
    expect(overlay.getUsernameByOwner(alice)).toBe(alpha);

    overlay.deleteUsername('alpha');
    expect(overlay.getUsername('alpha')).toBeNull();
    expect(overlay.getUsernameByOwner(alice)).toBeNull();

    const reclaimed = nameRow('alpha', bob, 'b'.repeat(64));
    overlay.putUsername(reclaimed);
    expect(overlay.getUsername('alpha')).toEqual(reclaimed);
    expect(overlay.getUsernameByOwner(bob)).toEqual(reclaimed);
    expect(overlay.getUsernameByOwner(alice)).toBeNull();
    expect(view.getUsername('alpha')).toBe(alpha);
  });

  it('a post\'s author and height: the view\'s row wins, then the block\'s first', () => {
    const view = new MemoryStateView();
    view.insertBlockTopology('p1', alice, 3);
    const overlay = new BlockOverlay(view);

    overlay.insertBlockTopology('p1', bob, 7);
    expect(overlay.getTopologyAuthor('p1')).toBe(alice);
    expect(overlay.getTopologyHeight('p1')).toBe(3);

    overlay.insertBlockTopology('p2', bob, 7);
    overlay.insertBlockTopology('p2', carol, 7);
    expect(overlay.getTopologyAuthor('p2')).toEqual(bob);
    expect(overlay.getTopologyHeight('p2')).toBe(7);

    expect(overlay.getTopologyAuthor('p3')).toBeNull();
    expect(overlay.getTopologyHeight('p3')).toBeNull();
    expect(view.getTopologyAuthor('p2')).toBeNull();
  });

  it('a post\'s standing: a confirmed post with no row is live, a withdrawal is withdrawn', () => {
    const view = new MemoryStateView();
    view.insertPost('pending');
    view.insertPost('gone');
    view.withdrawPost('gone');
    const overlay = new BlockOverlay(view);

    expect(overlay.getPostStanding('pending')).toBe('live');
    expect(overlay.getPostStanding('gone')).toBe('withdrawn');
    expect(overlay.getPostStanding('placeholder')).toBe('none');

    overlay.confirmPost('placeholder');
    overlay.confirmPost('gone');
    expect(overlay.getPostStanding('placeholder')).toBe('live');
    expect(overlay.getPostStanding('gone')).toBe('withdrawn');

    overlay.withdrawPost('pending');
    expect(overlay.getPostStanding('pending')).toBe('withdrawn');
    expect(overlay.withdrawals).toEqual(['pending']);
    expect(view.getPostStanding('pending')).toBe('live');
    expect(view.getPostStanding('placeholder')).toBe('none');
  });

  it('a like record: the view\'s and the block\'s', () => {
    const view = new MemoryStateView();
    view.insertLikeRecord('p', alice);
    const overlay = new BlockOverlay(view);
    expect(overlay.hasLikeRecord('p', alice)).toBe(true);
    expect(overlay.hasLikeRecord('p', bob)).toBe(false);

    overlay.insertLikeRecord('p', bob);
    expect(overlay.hasLikeRecord('p', new Uint8Array(bob))).toBe(true);
    expect(overlay.hasLikeRecord('q', bob)).toBe(false);
    expect(overlay.likeRecords).toEqual([{ targetPostId: 'p', likerId: bob }]);
    expect(view.hasLikeRecord('p', bob)).toBe(false);
  });
});

describe('BlockOverlay — an unlimited query composes under its own order', () => {
  it('an owner\'s karma boxes: value DESC, then id, across the view\'s boxes and the block\'s', () => {
    const view = new MemoryStateView();
    const seeded = [karmaBox(alice, 5n, 1), karmaBox(alice, 9n, 2), karmaBox(alice, 5n, 3), karmaBox(alice, 7n, 4)];
    for (const box of seeded) view.insertBox(box);
    view.insertBox(karmaBox(bob, 5n, 5));
    const overlay = new BlockOverlay(view);
    const reference = view.clone();

    const writes: Array<(target: BlockOverlay | MemoryStateView) => void> = [
      (t) => t.insertBox(karmaBox(alice, 5n, 6)),
      (t) => t.insertBox(karmaBox(alice, 9n, 7)),
      (t) => t.consumeBox(seeded[2]!.id),
      (t) => t.insertBox(karmaBox(alice, 1n, 8)),
      (t) => t.consumeBox(karmaBox(alice, 9n, 7).id),
      (t) => t.insertBox(karmaBox(bob, 5n, 9)),
    ];
    for (const write of writes) {
      write(overlay);
      write(reference);
      const listed = overlay.getKarmaBoxes(alice);
      expect(listed).toEqual(reference.getKarmaBoxes(alice));
      expect(overlay.getKarmaBoxes(bob)).toEqual(reference.getKarmaBoxes(bob));
      for (let i = 1; i < listed.length; i++) {
        const [prev, next] = [listed[i - 1]!, listed[i]!];
        expect(prev.value > next.value || (prev.value === next.value && prev.id! < next.id!)).toBe(true);
      }
    }
    expect(ids(overlay.getKarmaBoxes(alice))).toContain(karmaBox(alice, 5n, 6).id);
  });

  it('a voucher\'s escrows, a pair\'s vouch boxes and an author\'s accrual boxes: id, across both', () => {
    const view = new MemoryStateView();
    for (let n = 0; n < 4; n++) {
      view.insertBox(escrowBox(alice, 10 + n, 100 + n));
      view.insertBox(vouchBox(alice, bob, 200 + n));
      view.insertBox(accrualBox(carol, 1n, 300 + n));
    }
    const overlay = new BlockOverlay(view);
    const reference = view.clone();
    const check = (): void => {
      expect(overlay.getVouchEscrowsFor(alice)).toEqual(reference.getVouchEscrowsFor(alice));
      expect(overlay.getVouchBoxes(alice, bob)).toEqual(reference.getVouchBoxes(alice, bob));
      expect(overlay.getVouchBoxes(bob, alice)).toEqual(reference.getVouchBoxes(bob, alice));
      expect(overlay.getLikeAccrualBoxes(carol)).toEqual(reference.getLikeAccrualBoxes(carol));
      for (const list of [overlay.getVouchEscrowsFor(alice), overlay.getVouchBoxes(alice, bob), overlay.getLikeAccrualBoxes(carol)]) {
        expect(ids(list)).toEqual([...ids(list)].sort());
      }
    };
    const both = (write: (t: BlockOverlay | MemoryStateView) => void): void => {
      write(overlay);
      write(reference);
      check();
    };
    check();
    for (let n = 0; n < 4; n++) {
      both((t) => t.insertBox(escrowBox(alice, 20 + n, 400 + n)));
      both((t) => t.insertBox(vouchBox(alice, bob, 500 + n)));
      both((t) => t.insertBox(accrualBox(carol, 1n, 600 + n)));
    }
    both((t) => t.consumeBox(escrowBox(alice, 11, 101).id));
    both((t) => t.consumeBox(escrowBox(alice, 21, 401).id));
    both((t) => t.consumeBox(vouchBox(alice, bob, 202).id));
    both((t) => t.consumeBox(accrualBox(carol, 1n, 603).id));
    both((t) => t.insertBox(vouchBox(bob, alice, 700)));
    expect(overlay.getVouchBoxes(bob, alice)).toHaveLength(1);
  });

  it('a scripted run of inserts and spends leaves every read equal to the reference\'s', () => {
    const who = [alice, bob, carol, dave];
    const random = xorshift(0x5eed);
    const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!;
    let nonce = 1;
    const fresh = (): AnyBox => {
      const n = nonce++;
      switch (Math.floor(random() * 4)) {
        case 0: return karmaBox(pick(who), BigInt(1 + Math.floor(random() * 3)), n);
        case 1: return escrowBox(pick(who), 1 + Math.floor(random() * 9), n);
        case 2: return vouchBox(pick(who), pick(who), n);
        default: return accrualBox(pick(who), 1n, n);
      }
    };
    const view = new MemoryStateView();
    const known: string[] = [];
    for (let i = 0; i < 40; i++) {
      const box = fresh();
      view.insertBox(box);
      known.push(box.id!);
    }
    const pristine = view.clone();
    const overlay = new BlockOverlay(view);
    const reference = view.clone();

    for (let step = 0; step < 200; step++) {
      const spendable = known.filter((id) => reference.getBox(id) !== null);
      if (spendable.length === 0 || random() < 0.5) {
        const box = fresh();
        overlay.insertBox(box);
        reference.insertBox(box);
        known.push(box.id!);
      } else {
        const id = pick(spendable);
        overlay.consumeBox(id);
        reference.consumeBox(id);
      }
      expectComposedAgree(overlay, reference, who);
      for (const id of known) {
        expect(overlay.getBox(id)).toEqual(reference.getBox(id));
        expect(overlay.getBoxProvenance(id)).toEqual(reference.getBoxProvenance(id));
      }
    }
    expectComposedAgree(new BlockOverlay(view), pristine, who);
  });
});

describe('BlockOverlay — a limited query answers the view until the block writes into its set', () => {
  const protocolReads = [
    ['emission', 'getEmissionBox'],
    ['treasury', 'getTreasuryBox'],
    ['karma_pool', 'getKarmaPoolBox'],
    ['backer_pool', 'getBackerPoolBox'],
  ] as const;

  for (const [boxType, query] of protocolReads) {
    it(`${query}: the view's answer, and the tripwire after an insert or a spend of its type`, () => {
      const view = new MemoryStateView();
      const [first, second] = [protocolBox(boxType, 100n, 1), protocolBox(boxType, 100n, 2)];
      view.insertBox(first);
      view.insertBox(second);
      const read = (o: BlockOverlay): AnyBox | null => o[query]();

      const inserting = new BlockOverlay(view);
      expect(read(inserting)).toBe(view[query]());
      inserting.insertBox(karmaBox(alice, 1n, 3));
      expect(read(inserting)).toBe(view[query]());
      inserting.insertBox(protocolBox(boxType, 50n, 4));
      expect(() => read(inserting)).toThrow(LimitedQueryAfterWriteError);

      const spending = new BlockOverlay(view);
      spending.consumeBox(second.id);
      try {
        read(spending);
        expect.unreachable('a spend of the type must trip the read');
      } catch (err) {
        expect(err).toBeInstanceOf(LimitedQueryAfterWriteError);
        expect((err as LimitedQueryAfterWriteError).query).toBe(query);
      }
    });
  }

  it('the bonds invited by a height: a bond for a record-less invitee and a carried record leave it be', () => {
    const view = new MemoryStateView();
    view.putIdentityRecord(bob, identityRecord({ invitedAtBlock: 2 }));
    view.insertBox(bondBox(alice, bob, 1));
    const overlay = new BlockOverlay(view);
    const reference = view.clone();

    expect(overlay.getBondsInvitedAt(5, 10)).toEqual(view.getBondsInvitedAt(5, 10));
    expect(overlay.getBondsInvitedAt(5, 10)).toHaveLength(1);

    const newInvite = bondBox(alice, carol, 2);
    overlay.insertBox(newInvite);
    reference.insertBox(newInvite);
    const carried = identityRecord({ invitedAtBlock: 2, lastActivityBlock: 4, memberVouches: 1 });
    overlay.putIdentityRecord(bob, carried);
    reference.putIdentityRecord(bob, carried);
    overlay.putIdentityRecord(dave, identityRecord({ lastActivityBlock: 4 }));
    reference.putIdentityRecord(dave, identityRecord({ lastActivityBlock: 4 }));
    expect(overlay.getBondsInvitedAt(5, 10)).toEqual(reference.getBondsInvitedAt(5, 10));
  });

  it('the bonds invited by a height: a bond spent, a bond for an invitee in range, or a record moved across it trips', () => {
    const view = new MemoryStateView();
    view.putIdentityRecord(bob, identityRecord({ invitedAtBlock: 2 }));
    view.putIdentityRecord(carol, identityRecord({ invitedAtBlock: 3 }));
    const held = bondBox(alice, bob, 1);
    view.insertBox(held);
    const tripped = (write: (o: BlockOverlay) => void): void => {
      const overlay = new BlockOverlay(view);
      write(overlay);
      expect(() => overlay.getBondsInvitedAt(5, 10)).toThrow(LimitedQueryAfterWriteError);
    };
    tripped((o) => o.consumeBox(held.id));
    tripped((o) => o.insertBox(bondBox(alice, carol, 2)));
    tripped((o) => o.putIdentityRecord(bob, identityRecord({ invitedAtBlock: 9 })));
    tripped((o) => o.putIdentityRecord(dave, identityRecord({ invitedAtBlock: 4 })));
  });

  it('the escrows releasable at a height: an escrow releasing later leaves it be; one due, or a spend, trips', () => {
    const view = new MemoryStateView();
    const due = escrowBox(alice, 3, 1);
    view.insertBox(due);
    const overlay = new BlockOverlay(view);
    const reference = view.clone();
    expect(overlay.getVouchEscrowsReleasableAt(5, 10)).toEqual([due]);

    const later = escrowBox(bob, 9, 2);
    overlay.insertBox(later);
    reference.insertBox(later);
    expect(overlay.getVouchEscrowsReleasableAt(5, 10)).toEqual(reference.getVouchEscrowsReleasableAt(5, 10));
    expect(() => overlay.getVouchEscrowsReleasableAt(9, 10)).toThrow(LimitedQueryAfterWriteError);

    overlay.insertBox(escrowBox(bob, 5, 3));
    expect(() => overlay.getVouchEscrowsReleasableAt(5, 10)).toThrow(LimitedQueryAfterWriteError);

    const spending = new BlockOverlay(view);
    spending.consumeBox(due.id);
    expect(() => spending.getVouchEscrowsReleasableAt(5, 10)).toThrow(LimitedQueryAfterWriteError);
  });

  it('the lapsed vouches: a member\'s vouch and a record that stays on its side leave it be', () => {
    const view = new MemoryStateView();
    view.putIdentityRecord(alice, member);
    view.putIdentityRecord(carol, lapsedMember);
    view.insertBox(vouchBox(carol, bob, 1));
    view.insertBox(vouchBox(alice, bob, 2));
    const overlay = new BlockOverlay(view);
    const reference = view.clone();
    expect(overlay.getLapsedVouches(10)).toEqual([vouchBox(carol, bob, 1)]);

    const cast = vouchBox(alice, dave, 3);
    overlay.insertBox(cast);
    reference.insertBox(cast);
    const stillMember = identityRecord({ memberSinceBlock: 1, memberBar: 1, memberVouches: 2 });
    overlay.putIdentityRecord(alice, stillMember);
    reference.putIdentityRecord(alice, stillMember);
    expect(overlay.getLapsedVouches(10)).toEqual(reference.getLapsedVouches(10));
  });

  it('the lapsed vouches: a vouch spent, a lapsed voucher\'s vouch, or a record crossing member() trips', () => {
    const view = new MemoryStateView();
    view.putIdentityRecord(alice, member);
    view.putIdentityRecord(carol, lapsedMember);
    const held = vouchBox(alice, bob, 2);
    view.insertBox(vouchBox(carol, bob, 1));
    view.insertBox(held);
    const tripped = (write: (o: BlockOverlay) => void): void => {
      const overlay = new BlockOverlay(view);
      write(overlay);
      expect(() => overlay.getLapsedVouches(10)).toThrow(LimitedQueryAfterWriteError);
    };
    tripped((o) => o.consumeBox(held.id));
    tripped((o) => o.insertBox(vouchBox(carol, dave, 3)));
    tripped((o) => o.putIdentityRecord(alice, identityRecord({ memberSinceBlock: 1, memberBar: 1, memberVouches: 0 })));
    tripped((o) => o.putIdentityRecord(carol, member));
  });
});

describe('BlockOverlay — the store\'s backstops', () => {
  it('an insert of a box id the state holds or held, live or spent, or the block inserted, throws and writes nothing', () => {
    const view = new MemoryStateView();
    const live = karmaBox(alice, 1n, 1);
    const spent = karmaBox(alice, 2n, 2);
    view.insertBox(live);
    view.insertBox(spent);
    view.consumeBox(spent.id);
    const overlay = new BlockOverlay(view);
    const made = karmaBox(bob, 3n, 3);
    overlay.insertBox(made);
    overlay.consumeBox(made.id);
    const written = overlay.mutations.length;

    for (const box of [live, spent, made]) {
      try {
        overlay.insertBox({ ...box });
        expect.unreachable(`${box.id} must be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(BoxIdTakenError);
        expect((err as BoxIdTakenError).boxId).toBe(box.id);
      }
    }
    const { id: _id, ...unnamed } = karmaBox(carol, 4n, 4);
    expect(() => overlay.insertBox(unnamed as AnyBox)).toThrow(/no id/);
    expect(overlay.mutations).toHaveLength(written);
    expect(overlay.getBox(made.id)).toBeNull();
  });

  it('a spend of a box that is not live throws and writes nothing', () => {
    const view = new MemoryStateView();
    const spentBefore = karmaBox(alice, 2n, 2);
    view.insertBox(spentBefore);
    view.consumeBox(spentBefore.id);
    const held = karmaBox(alice, 1n, 1);
    view.insertBox(held);
    const overlay = new BlockOverlay(view);
    overlay.consumeBox(held.id);
    const made = karmaBox(bob, 3n, 3);
    overlay.insertBox(made);
    overlay.consumeBox(made.id);
    const written = overlay.mutations.length;

    for (const id of ['00'.repeat(32), spentBefore.id, held.id, made.id]) {
      try {
        overlay.consumeBox(id);
        expect.unreachable(`${id} must be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(SpendOfNonLiveBoxError);
        expect((err as SpendOfNonLiveBoxError).boxId).toBe(id);
      }
    }
    expect(overlay.mutations).toHaveLength(written);
  });
});

describe('BlockOverlay — the block\'s writes, in the order it made them', () => {
  it('lists every write to committed state, each name and holder mutation saying whether its key was held', () => {
    const view = new MemoryStateView({ memberCount: 2 });
    const held = karmaBox(alice, 1n, 1);
    view.insertBox(held);
    const alpha = nameRow('alpha', alice, 'a'.repeat(64));
    view.putUsername(alpha);
    const overlay = new BlockOverlay(view);

    const made = karmaBox(bob, 3n, 2);
    const record = identityRecord({ lastActivityBlock: 3 });
    const reclaimed = nameRow('alpha', bob, 'b'.repeat(64));
    const passing = nameRow('beta', carol, 'c'.repeat(64));

    overlay.consumeBox(held.id);
    overlay.insertBox(made);
    overlay.putIdentityRecord(alice, record);
    overlay.deleteUsername('alpha');
    overlay.putUsername(reclaimed);
    overlay.putUsername(passing);
    overlay.deleteUsername('beta');
    overlay.deleteUsername('gamma');
    overlay.putNetworkRecord({ memberCount: 3 });

    expect(overlay.mutations).toEqual([
      { kind: 'box', op: 'remove', boxId: held.id },
      { kind: 'box', op: 'insert', boxId: made.id, box: made },
      { kind: 'record', identityId: alice, record },
      { kind: 'username', nameLower: 'alpha', row: null, heldBefore: true },
      { kind: 'holder', owner: expect.anything(), record: null, heldBefore: true },
      { kind: 'username', nameLower: 'alpha', row: reclaimed, heldBefore: false },
      { kind: 'holder', owner: expect.anything(), record: { claimAvailable: false, boxId: reclaimed.boxId }, heldBefore: false },
      { kind: 'username', nameLower: 'beta', row: passing, heldBefore: false },
      { kind: 'holder', owner: expect.anything(), record: { claimAvailable: false, boxId: passing.boxId }, heldBefore: false },
      { kind: 'username', nameLower: 'beta', row: null, heldBefore: true },
      { kind: 'holder', owner: expect.anything(), record: null, heldBefore: true },
      { kind: 'network', record: { memberCount: 3 } },
    ]);
    const holderOwners = overlay.mutations
      .filter((m): m is Extract<typeof m, { kind: 'holder' }> => m.kind === 'holder')
      .map((m) => hex(m.owner));
    expect(holderOwners).toEqual([hex(alice), hex(bob), hex(carol), hex(carol)]);
  });

  it('a claim over keys the state holds says each was held', () => {
    const view = new MemoryStateView();
    view.putUsername(nameRow('delta', dave, 'd'.repeat(64)));
    view.putUsername(nameRow('omega', carol, 'f'.repeat(64)));
    const overlay = new BlockOverlay(view);
    overlay.putUsername(nameRow('delta', carol, 'e'.repeat(64)));
    expect(overlay.mutations.map((m) => (m.kind === 'username' || m.kind === 'holder' ? m.heldBefore : null)))
      .toEqual([true, true]);
  });

  it('never writes the view', () => {
    const view = new MemoryStateView({ memberCount: 1 });
    const held = karmaBox(alice, 1n, 1);
    view.insertBox(held);
    view.putIdentityRecord(alice, member);
    view.putUsername(nameRow('alpha', alice, 'a'.repeat(64)));
    view.insertPost('p');
    const pristine = view.clone();
    const overlay = new BlockOverlay(view);

    overlay.consumeBox(held.id);
    overlay.insertBox(karmaBox(alice, 2n, 2));
    overlay.putIdentityRecord(alice, lapsedMember);
    overlay.putNetworkRecord({ memberCount: 9 });
    overlay.deleteUsername('alpha');
    overlay.withdrawPost('p');
    overlay.insertLikeRecord('p', bob);
    overlay.insertBlockTopology('q', bob, 2);

    expect(view.getBox(held.id)).toBe(held);
    expect(view.getKarmaBoxes(alice)).toEqual(pristine.getKarmaBoxes(alice));
    expect(view.getIdentityRecord(alice)).toEqual(member);
    expect(view.getNetworkRecord()).toEqual({ memberCount: 1 });
    expect(view.getUsername('alpha')).toEqual(pristine.getUsername('alpha'));
    expect(view.getPostStanding('p')).toBe('live');
    expect(view.hasLikeRecord('p', bob)).toBe(false);
    expect(view.getTopologyAuthor('q')).toBeNull();
  });
});

describe('BlockOverlay — a read of what the block wrote answers a copy', () => {
  /** A body's outputs as decoded, each byte field then carried as a `Buffer`. */
  function withBufferFields(outputs: AnyBoxCandidate[]): AnyBox[] {
    const tx: UtxoTransaction = { inputs: ['ab'.repeat(32)], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION };
    const decoded = decodeTx(encodeTx(tx));
    const txId = computeTxId(decoded);
    return decoded.outputs.map((out, index) => {
      const box = materializeOutput(out, txId, index) as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(box)) {
        if (value instanceof Uint8Array) box[field] = Buffer.from(value);
      }
      return box as unknown as AnyBox;
    });
  }

  const byteFields = (box: object): Array<[string, Uint8Array]> =>
    Object.entries(box).filter((entry): entry is [string, Uint8Array] => entry[1] instanceof Uint8Array);

  /** A value with every byte field as hex and every bigint as text: values compare whatever carries their bytes. */
  function shape(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
      const raw = this[key];
      if (raw instanceof Uint8Array) return Buffer.from(raw).toString('hex');
      return typeof v === 'bigint' ? `${v}n` : v;
    }));
  }

  it('a box inserted with its byte fields in Buffers reads back with every byte field a plain Uint8Array, and the effects keep the box as passed', () => {
    const [owner, holder, author, invitee] = [uid('copy/owner'), uid('copy/holder'), uid('copy/author'), uid('copy/invitee')];
    const outputs = withBufferFields([
      { boxType: 'karma', value: 7n, createdAtBlock: 2, owner },
      { boxType: 'credit', value: 9n, createdAtBlock: 2, owner: holder },
      { boxType: 'vouch', value: 1n, createdAtBlock: 2, voucherId: owner, targetId: holder },
      { boxType: 'vouch_escrow', value: 1n, createdAtBlock: 2, owner, releaseAtBlock: 5 },
      { boxType: 'like_accrual', value: 1n, createdAtBlock: 2, author },
      { boxType: 'bond', value: 25n, createdAtBlock: 2, inviterId: owner, inviteePublicKey: invitee },
      { boxType: 'username', value: 0n, createdAtBlock: 2, owner, name: new TextEncoder().encode('alpha') },
    ] as AnyBoxCandidate[]);
    for (const box of outputs) {
      expect(byteFields(box).length).toBeGreaterThan(0);
      expect(byteFields(box).every(([, bytes]) => Buffer.isBuffer(bytes))).toBe(true);
    }
    // A decoded credit output carries its absent lock as a key holding `undefined`.
    expect(Object.hasOwn(outputs[1]!, 'lockedUntilBlock')).toBe(true);

    const overlay = new BlockOverlay(new MemoryStateView());
    for (const box of outputs) overlay.insertBox(box);

    for (const box of outputs) {
      const read = overlay.getBox(box.id!)!;
      expect(read).not.toBe(box);
      expect(shape(read)).toEqual(shape(box));
      for (const [field, bytes] of byteFields(read)) {
        expect(Object.getPrototypeOf(bytes), `${box.boxType}.${field}`).toBe(Uint8Array.prototype);
        expect(bytes).not.toBe((box as unknown as Record<string, unknown>)[field]);
      }
    }
    expect(Object.hasOwn(overlay.getBox(outputs[1]!.id!)!, 'lockedUntilBlock')).toBe(false);

    const composed = [
      ...overlay.getKarmaBoxes(owner),
      ...overlay.getVouchBoxes(owner, holder),
      ...overlay.getVouchEscrowsFor(owner),
      ...overlay.getLikeAccrualBoxes(author),
    ];
    expect(ids(composed)).toEqual([outputs[0]!.id, outputs[2]!.id, outputs[3]!.id, outputs[4]!.id]);
    for (const read of composed) {
      for (const [field, bytes] of byteFields(read)) {
        expect(Object.getPrototypeOf(bytes), `${read.boxType}.${field}`).toBe(Uint8Array.prototype);
      }
    }

    // A later transaction of the block spends the karma output: the owner it
    // reads is a plain Uint8Array, and the spend lands.
    const karma = outputs[0]!;
    expect(Object.getPrototypeOf((overlay.getBox(karma.id!) as KarmaBox).owner)).toBe(Uint8Array.prototype);
    overlay.consumeBox(karma.id!);
    expect(overlay.getBox(karma.id!)).toBeNull();

    const inserted = overlay.mutations.flatMap((m) => (m.kind === 'box' && m.op === 'insert' ? [m.box] : []));
    expect(inserted).toHaveLength(outputs.length);
    inserted.forEach((box, i) => expect(box).toBe(outputs[i]));
    expect(byteFields(inserted[0]!).every(([, bytes]) => Buffer.isBuffer(bytes))).toBe(true);
  });

  it('writing through a read changes neither the effects nor a later read', () => {
    const [owner, holder, poster] = [uid('copy/w-owner'), uid('copy/w-holder'), uid('copy/w-poster')];
    const overlay = new BlockOverlay(new MemoryStateView({ memberCount: 2 }));
    const box = karmaBox(owner, 5n, 1);
    const record = identityRecord({ memberVouches: 1 });
    const row = nameRow('alpha', holder, 'b'.repeat(64));
    const author = new Uint8Array(poster);
    overlay.insertBox(box);
    overlay.putIdentityRecord(owner, record);
    overlay.putUsername(row);
    overlay.putNetworkRecord({ memberCount: 3 });
    overlay.insertBlockTopology('p', author, 4);
    const effectsBefore = shape(overlay.mutations);

    const readBox = overlay.getBox(box.id) as KarmaBox;
    readBox.owner.fill(0);
    (readBox as { value: bigint }).value = 99n;
    const [listed] = overlay.getKarmaBoxes(owner);
    listed!.owner.fill(1);
    overlay.getIdentityRecord(owner)!.memberVouches = 99;
    overlay.getUsername('alpha')!.boxId = 'f'.repeat(64);
    overlay.getUsernameByOwner(holder)!.boxId = 'e'.repeat(64);
    overlay.getNetworkRecord().memberCount = 99;
    overlay.getTopologyAuthor('p')!.fill(2);

    expect(shape(overlay.mutations)).toEqual(effectsBefore);
    expect(box.owner).toEqual(uid('copy/w-owner'));
    expect(overlay.getBox(box.id)).toEqual(box);
    expect(overlay.getKarmaBoxes(owner)).toEqual([box]);
    expect(overlay.getIdentityRecord(owner)).toEqual(record);
    expect(overlay.getUsername('alpha')).toEqual(row);
    expect(overlay.getUsernameByOwner(holder)).toEqual(row);
    expect(overlay.getNetworkRecord()).toEqual({ memberCount: 3 });
    expect(overlay.getTopologyAuthor('p')).toEqual(poster);
    expect(author).toEqual(poster);
  });

  it('a record reads back in its declared field order, whatever order its writer listed', () => {
    const who = uid('copy/r-who');
    const overlay = new BlockOverlay(new MemoryStateView());
    const listed = {
      invitesUsed: 1, memberLikes: 2n, memberVouches: 3, memberBar: 4, memberSinceBlock: 5,
      lifetimeLikesReceived: 6n, invitedAtBlock: 7, lastDecayBlock: 8, lastActivityBlock: 9,
    } as IdentityRecord;
    overlay.putIdentityRecord(who, listed);
    const read = overlay.getIdentityRecord(who)!;
    expect(Object.keys(read)).toEqual(Object.keys(identityRecord()));
    expect(read).toEqual(listed);
  });
});
