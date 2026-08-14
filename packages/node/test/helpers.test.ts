import { describe, it, expect } from 'vitest';
import { computeBoxId } from '@dagsocial/types';
import { seedInviteAndBond, uid } from './helpers.js';

/**
 * Pins the fixture helpers themselves.
 *
 * `seedInviteAndBond` is the single source of invite/bond fixtures across this
 * suite, and centralising is what makes its provenance rule load-bearing: a
 * shared helper that let two callers collide produces the collision at every
 * site at once. These are the properties that make it safe to share.
 */
describe('seedInviteAndBond — distinct provenance per call', () => {
  const inviterId = uid('alice');

  it('two pairs built with different labels have four distinct ids', () => {
    const a = seedInviteAndBond({ label: 'first', inviterId });
    const b = seedInviteAndBond({ label: 'second', inviterId });

    const ids = [a.invite.id, a.bond.id, b.invite.id, b.bond.id];
    expect(new Set(ids).size).toBe(4);
  });

  it('the two pairs are also distinct transactions, not just distinct boxes', () => {
    const a = seedInviteAndBond({ label: 'first', inviterId });
    const b = seedInviteAndBond({ label: 'second', inviterId });

    // Same txId within a pair — the invite and bond are outputs of ONE tx, the
    // shape invite creation actually emits.
    expect(a.invite.txId).toBe(a.bond.txId);
    expect(a.invite.index).toBe(0);
    expect(a.bond.index).toBe(1);
    // And the pairing itself: one invitee key on both boxes, which is the whole
    // of what resolves a bond from its invite.
    expect(Buffer.from(a.bond.inviteePublicKey).toString('hex'))
      .toBe(Buffer.from(a.invite.inviteePublicKey).toString('hex'));

    // Different txId across pairs — the property `label` exists to guarantee.
    // Without it these two calls share a txId and both bonds land on
    // (txId, index) = (same, 1), which `UNIQUE(tx_id, output_index)` forbids.
    expect(a.invite.txId).not.toBe(b.invite.txId);
  });

  it('a difference confined to the BOND still separates the pairs', () => {
    // The sharp case. `seedAsOneTx` derives the shared txId from
    // `candidates[0]` — the invite — alone, so a difference confined to the
    // BOND does not reach the txId at all. Without `label` these two pairs
    // share one txId and put two differently-identified bonds on a single
    // `(txId, index)`, which `UNIQUE(tx_id, output_index)` forbids.
    const a = seedInviteAndBond({ label: 'bond-a', inviterId, bondValue: 5n });
    const b = seedInviteAndBond({ label: 'bond-b', inviterId, bondValue: 99n });

    expect(a.invite.txId).not.toBe(b.invite.txId);
    expect(a.bond.id).not.toBe(b.bond.id);
  });

  it('every box it returns satisfies id integrity', () => {
    const { invite, bond } = seedInviteAndBond({ label: 'integrity', inviterId });
    expect(computeBoxId(invite)).toBe(invite.id);
    expect(computeBoxId(bond)).toBe(bond.id);
  });

  it('is deterministic — the same label reproduces the same ids', () => {
    // Not a counter: ids must not depend on how many fixtures a test happened
    // to build first, or golden vectors move with file ordering.
    const a = seedInviteAndBond({ label: 'stable', inviterId });
    const b = seedInviteAndBond({ label: 'stable', inviterId });
    expect(a.invite.id).toBe(b.invite.id);
    expect(a.bond.id).toBe(b.bond.id);
  });
});
