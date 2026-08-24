// ---------------------------------------------------------------------------
// The order of legs in derive() is consensus: checkSettlement compares
// inputs "exactly and in order" and outputs "element-wise and in order"
// (NODE_INTERFACE → The settlement transaction). A reorder moves every
// settlement's bytes, on both sides identically, with nothing going red
// unless pinned here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  LIKES_PER_KARMA_PAYOUT,
  INVITE_BOND_VEST_PER_LIKES,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  EmissionBox,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  TreasuryBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import {
  buildSettlement,
  checkSettlement,
} from '../../src/services/settlement.js';
import type { SettlementDeps, SettlementBody } from '../../src/services/settlement.js';
import type { DecayPlan } from '../../src/services/decay.js';
import {
  makeTestIdentity,
  seedProvenance,
  hex,
  labelNonce,
} from '../helpers.js';

const HEIGHT = 10;
const EMISSION = 100n;
const MINER_REWARD_DELAY = 5;

// Distinct identities per role so no leg's owner collides with another's.
const miner       = makeTestIdentity();
const likeAuthor  = makeTestIdentity();
const bondInviter = makeTestIdentity();
const bondInvitee = makeTestIdentity();
const escrowOwner = makeTestIdentity();
const decayOwner  = makeTestIdentity();
const newInvitee  = makeTestIdentity();

// ---- Protocol boxes ----

const emissionBox = seedProvenance<EmissionBox>({
  boxType: 'emission', value: 1000n, createdAtBlock: 0,
}, 1, labelNonce('leg-order-emission'));

const treasuryBox = seedProvenance<TreasuryBox>({
  boxType: 'treasury', value: 50n, createdAtBlock: 0,
}, 1, labelNonce('leg-order-treasury'));

const poolBox = seedProvenance<KarmaPoolBox>({
  boxType: 'karma_pool', value: 500n, createdAtBlock: 0,
}, 1, labelNonce('leg-order-pool'));

// ---- Karma-side boxes ----

const markerBox = seedProvenance<LikeAccrualBox>({
  boxType: 'like_accrual', value: 3n, createdAtBlock: HEIGHT,
  author: likeAuthor.userId,
}, HEIGHT, labelNonce('leg-order-marker'));

// Carry box from a previous block. total = marker(3) + carry(3) = 6 >=
// LIKES_PER_KARMA_PAYOUT(5), so q = 1, paid = 4, carry_new = 1.
const carryBox = seedProvenance<LikeAccrualBox>({
  boxType: 'like_accrual', value: 3n, createdAtBlock: 5,
  author: likeAuthor.userId,
}, 5, labelNonce('leg-order-carry'));

const bondBox = seedProvenance<BondBox>({
  boxType: 'bond', value: 20n, createdAtBlock: 0,
  inviterId: bondInviter.userId,
  inviteePublicKey: bondInvitee.userId,
}, 1, labelNonce('leg-order-bond'));

const escrowBox = seedProvenance<VouchEscrowBox>({
  boxType: 'vouch_escrow', value: 10n, createdAtBlock: 0,
  owner: escrowOwner.userId, releaseAtBlock: HEIGHT,
}, 1, labelNonce('leg-order-escrow'));

const decayKarmaBox = seedProvenance<KarmaBox>({
  boxType: 'karma', value: 10n, createdAtBlock: 0,
  owner: decayOwner.userId,
}, 1, labelNonce('leg-order-decay-karma'));

const feeBox = seedProvenance<AnyBox>({
  boxType: 'fee', value: 10n, createdAtBlock: HEIGHT,
} as AnyBox, HEIGHT, labelNonce('leg-order-fee'));

// ---- Lookup for checkSettlement's conservation check ----

const boxMap = new Map<string, AnyBox>();
for (const box of [emissionBox, treasuryBox, poolBox, markerBox, carryBox,
                    bondBox, escrowBox, decayKarmaBox, feeBox]) {
  boxMap.set(box.id!, box as AnyBox);
}

// ---- Deps and body ----

const decayPlan: DecayPlan = {
  owner: decayOwner.userId,
  consumedBoxIds: [decayKarmaBox.id!],
  burnAmount: 2n,
  newValue: 8n,
};

const body: SettlementBody = {
  fees: 10n,
  actors: 1,
  feeBoxIds: [feeBox.id!],
  invites: [{ invitee: newInvitee.userId, amount: 15n }],
  markers: [{ id: markerBox.id!, author: likeAuthor.userId, value: 3n }],
  prunes: [],
};

const deps: SettlementDeps = {
  getEmissionBox: () => emissionBox as EmissionBox,
  getTreasuryBox: () => treasuryBox as TreasuryBox,
  getKarmaPoolBox: () => poolBox as KarmaPoolBox,
  getBox: (id) => boxMap.get(id) ?? null,
  getLikeCarryBox: (author, exclude) => {
    if (hex(author) === hex(likeAuthor.userId) && !exclude.has(carryBox.id!))
      return carryBox as LikeAccrualBox;
    return null;
  },
  getBondsSettlingAt: () => [bondBox as BondBox],
  getEscrowsReleasableAt: () => [escrowBox as VouchEscrowBox],
  getLifetimeLikes: (invitee) =>
    hex(invitee) === hex(bondInvitee.userId) ? 9n : 0n,
  getDecayPlans: () => [decayPlan],
};

// Derived from the constants, for the output-value assertions below.
const PAYOUT_X = BigInt(LIKES_PER_KARMA_PAYOUT);           // 5
const VEST_PER = BigInt(INVITE_BOND_VEST_PER_LIKES);       // 3
const likeTotal = 3n + 3n;                                 // marker + carry
const likePaid  = (likeTotal / PAYOUT_X) * (PAYOUT_X - 1n); // 4
const likeCarry = likeTotal % PAYOUT_X;                     // 1
const bondVested = 9n / VEST_PER < 20n ? 9n / VEST_PER : 20n; // min(3, 20) = 3

describe('settlement leg order', () => {
  // The order is consensus and the contract pins it
  // (NODE_INTERFACE → The settlement transaction, the Consumes / Emits rows
  // and the "exactly and in order" / "element-wise and in order" checks).
  it('inputs and outputs land in derive()\'s leg order', () => {
    const result = buildSettlement(
      deps, HEIGHT, EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const { tx } = result;

    // ---- Inputs: exact order ----
    //
    //   emission → treasury → markers (committed tx order) →
    //   carry (ascending author hex) → bonds (ascending box id) →
    //   escrows (ascending box id) → decay consumed →
    //   [prunes — empty here] → pool → fees (committed tx order)
    expect(tx.inputs).toEqual([
      emissionBox.id,
      treasuryBox.id,
      markerBox.id,
      carryBox.id,
      bondBox.id,
      escrowBox.id,
      decayKarmaBox.id,
      poolBox.id,
      feeBox.id,
    ]);

    // ---- Outputs: exact order ----
    //
    //   emission successor → treasury successor → pool successor →
    //   invite grants → like payouts + carry → bond vested →
    //   escrow returns → decay replacements → coinbase credit
    const outs = tx.outputs;
    expect(outs).toHaveLength(10);

    expect(outs[0]!.boxType).toBe('emission');
    expect(outs[0]!.value).toBe(900n);

    expect(outs[1]!.boxType).toBe('treasury');

    expect(outs[2]!.boxType).toBe('karma_pool');

    expect(outs[3]!.boxType).toBe('karma');
    expect((outs[3] as KarmaBox).owner).toEqual(newInvitee.userId);
    expect(outs[3]!.value).toBe(15n);

    expect(outs[4]!.boxType).toBe('karma');
    expect((outs[4] as KarmaBox).owner).toEqual(likeAuthor.userId);
    expect(outs[4]!.value).toBe(likePaid);

    expect(outs[5]!.boxType).toBe('like_accrual');
    expect((outs[5] as LikeAccrualBox).author).toEqual(likeAuthor.userId);
    expect(outs[5]!.value).toBe(likeCarry);

    expect(outs[6]!.boxType).toBe('karma');
    expect((outs[6] as KarmaBox).owner).toEqual(bondInviter.userId);
    expect(outs[6]!.value).toBe(bondVested);

    expect(outs[7]!.boxType).toBe('karma');
    expect((outs[7] as KarmaBox).owner).toEqual(escrowOwner.userId);
    expect(outs[7]!.value).toBe(10n);

    expect(outs[8]!.boxType).toBe('karma');
    expect((outs[8] as KarmaBox).owner).toEqual(decayOwner.userId);
    expect(outs[8]!.value).toBe(8n);

    expect(outs[9]!.boxType).toBe('credit');

    // Builder and verifier share derive(), so checkSettlement passing is
    // necessary but not sufficient — the positional assertions above are
    // the pin.
    const check = checkSettlement(
      deps, HEIGHT, EMISSION, MINER_REWARD_DELAY, body, tx);
    expect(check.valid).toBe(true);
  });
});
