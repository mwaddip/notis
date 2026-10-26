import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { seedProvenance, uid } from '../helpers.js';
import type { VouchEscrowBox, BondBox, VouchBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers (module-level singleton state resets between tests)
// ---------------------------------------------------------------------------

async function importAll() {
  const db = await import('../../src/store/db.js');
  const utxo = await import('../../src/store/utxo.js');
  const vouchQueries = await import('../../src/store/vouch-queries.js');
  const identityRecords = await import('../../src/store/identity-records.js');
  return { ...db, ...utxo, ...vouchQueries, ...identityRecords };
}

// ---------------------------------------------------------------------------
// Box factories
// ---------------------------------------------------------------------------

function makeEscrowBox(
  value: bigint,
  owner: Uint8Array,
  releaseAtBlock: number,
  nonce = 0,
): VouchEscrowBox {
  const candidate = {
    boxType: 'vouch_escrow' as const,
    value,
    createdAtBlock: 1,
    owner,
    releaseAtBlock,
  };
  return seedProvenance<VouchEscrowBox>(candidate, 1, nonce);
}

function makeBondBox(
  inviterId: Uint8Array,
  inviteePublicKey: Uint8Array,
  value = 25n,
  nonce = 0,
): BondBox {
  const candidate = {
    boxType: 'bond' as const,
    value,
    createdAtBlock: 1,
    inviterId,
    inviteePublicKey,
  };
  return seedProvenance<BondBox>(candidate, 1, nonce);
}

function makeVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  nonce = 0,
): VouchBox {
  const candidate = {
    boxType: 'vouch' as const,
    value: 1n,
    createdAtBlock: 1,
    voucherId,
    targetId,
  };
  return seedProvenance<VouchBox>(candidate, 1, nonce);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getBondsInvitedAt — range, limit, order', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('returns bonds whose invitee invited_at_block is in (0, maxInvitedAt], ascending (invited_at_block, id)', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const inviter = uid('inviter');
    const invitee1 = uid('invitee1');
    const invitee2 = uid('invitee2');
    const invitee3 = uid('invitee3');

    // Create identity records with different invited_at_block values
    s.putIdentityRecord(invitee1, {
      invitedAtBlock: 5,
      lastActivityBlock: 5,
      lastDecayBlock: 5,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    s.putIdentityRecord(invitee2, {
      invitedAtBlock: 3,
      lastActivityBlock: 3,
      lastDecayBlock: 3,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    s.putIdentityRecord(invitee3, {
      invitedAtBlock: 0,
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });

    const bond1 = makeBondBox(inviter, invitee1, 25n, 1);
    const bond2 = makeBondBox(inviter, invitee2, 25n, 2);
    const bond3 = makeBondBox(inviter, invitee3, 25n, 3);
    s.insertBox(bond1);
    s.insertBox(bond2);
    s.insertBox(bond3);

    // Range (0, 5]: should return invitee2 (invited_at_block=3) then invitee1 (invited_at_block=5)
    // invitee3 (invited_at_block=0) is excluded by the > 0 guard
    const result = s.getBondsInvitedAt(5, 10);
    expect(result).toHaveLength(2);
    // Ordered by (invited_at_block, box id): invitee2 at 3 comes first
    expect(result[0]!.inviteePublicKey).toEqual(invitee2);
    expect(result[1]!.inviteePublicKey).toEqual(invitee1);

    // Limit = 1
    const limited = s.getBondsInvitedAt(5, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.inviteePublicKey).toEqual(invitee2);

    // Range that excludes invitee1 (invited_at_block=5)
    const narrow = s.getBondsInvitedAt(4, 10);
    expect(narrow).toHaveLength(1);
    expect(narrow[0]!.inviteePublicKey).toEqual(invitee2);
  });

  it('the sentinel invited_at_block=0 is never returned', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const inviter = uid('inviter-s');
    const invitee = uid('invitee-s');

    s.putIdentityRecord(invitee, {
      invitedAtBlock: 0,
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    const bond = makeBondBox(inviter, invitee, 25n);
    s.insertBox(bond);

    expect(s.getBondsInvitedAt(100, 64)).toHaveLength(0);
  });
});

describe('getVouchEscrowsReleasableAt — order and limit', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('orders by (releaseAtBlock, id) and respects limit', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const owner = uid('escrow-owner');

    // Insert with different release heights, out of ascending order
    const e1 = makeEscrowBox(3n, owner, 20, 1);
    const e2 = makeEscrowBox(3n, owner, 10, 2);
    const e3 = makeEscrowBox(3n, owner, 10, 3);
    s.insertBox(e1);
    s.insertBox(e2);
    s.insertBox(e3);

    // All three releasable at height 20
    const result = s.getVouchEscrowsReleasableAt(20, 10);
    expect(result).toHaveLength(3);

    // Ordered by (releaseAtBlock, id): the two at height 10 come first
    expect(result[0]!.releaseAtBlock).toBe(10);
    expect(result[1]!.releaseAtBlock).toBe(10);
    expect(result[2]!.releaseAtBlock).toBe(20);

    // Within the same releaseAtBlock, ascending id
    expect(result[0]!.id! < result[1]!.id!).toBe(true);

    // Limit = 2
    const limited = s.getVouchEscrowsReleasableAt(20, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.releaseAtBlock).toBe(10);
    expect(limited[1]!.releaseAtBlock).toBe(10);
  });
});


describe('getLapsedVouches — lapsed-member predicate', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // CONSENSUS_INTERFACE → What it holds → "Membership is one predicate" —
  // isLapsedMember(record) = memberSinceBlock > 0 ∧ NOT isMember(record), i.e.
  // the record has crossed the floor once and now falls short.
  it('lists an unspent vouch whose voucher is a lapsed member', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const voucher = uid('lapsed-voucher');
    const target = uid('lapsed-target');

    s.putIdentityRecord(voucher, {
      invitedAtBlock: 1,
      lastActivityBlock: 1,
      lastDecayBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 5,
      memberBar: 3,
      memberVouches: 1,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    const vouch = makeVouchBox(voucher, target, 1);
    s.insertBox(vouch);

    const lapsed = s.getLapsedVouches(10);
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]!.id).toBe(vouch.id);
  });

  // A record with memberSinceBlock = 0 never joined, so it cannot have lapsed
  // (CONSENSUS_INTERFACE → What it holds → "Membership is one predicate"); the
  // settlement's lapse leg must not sweep a vouch whose voucher is not even a
  // former member.
  it('ignores a vouch whose voucher has memberSinceBlock 0 and too few vouches', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const voucher = uid('never-member-voucher');
    const target = uid('never-member-target');

    s.putIdentityRecord(voucher, {
      invitedAtBlock: 1,
      lastActivityBlock: 1,
      lastDecayBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 3,
      memberVouches: 1,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    const vouch = makeVouchBox(voucher, target, 1);
    s.insertBox(vouch);

    expect(s.getLapsedVouches(10)).toHaveLength(0);
  });
});
