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
  encodeTx,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  EmissionBox,
  KarmaBox,
  KarmaPriceBox,
  KarmaPoolBox,
  LikeAccrualBox,
  TreasuryBox,
  VouchBox,
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
const lapseOwner  = makeTestIdentity();
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

const lapsedVouchBox = seedProvenance<VouchBox>({
  boxType: 'vouch', value: 1n, createdAtBlock: 3,
  voucherId: lapseOwner.userId,
  targetId: newInvitee.userId,
}, 1, labelNonce('leg-order-lapsed-vouch'));

const decayKarmaBox = seedProvenance<KarmaBox>({
  boxType: 'karma', value: 10n, createdAtBlock: 0,
  owner: decayOwner.userId,
}, 1, labelNonce('leg-order-decay-karma'));

const feeBox = seedProvenance<AnyBox>({
  boxType: 'fee', value: 10n, createdAtBlock: HEIGHT,
} as AnyBox, HEIGHT, labelNonce('leg-order-fee'));

const priceBox = seedProvenance<KarmaPriceBox>({
  boxType: 'karma_price', value: 5n, createdAtBlock: HEIGHT,
}, HEIGHT, labelNonce('leg-order-price'));

// ---- Lookup for checkSettlement's conservation check ----

const boxMap = new Map<string, AnyBox>();
for (const box of [emissionBox, treasuryBox, poolBox, markerBox, carryBox,
                    bondBox, escrowBox, lapsedVouchBox, decayKarmaBox, feeBox, priceBox]) {
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
  rent: 0n,
  actors: 1,
  feeBoxIds: [feeBox.id!],
  invites: [{ invitee: newInvitee.userId, amount: 15n }],
  markers: [{ id: markerBox.id!, author: likeAuthor.userId, value: 3n }],
  priceBoxes: [{ id: priceBox.id!, value: 5n }],
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
  getLapsedVouches: () => [lapsedVouchBox as VouchBox],
  getLifetimeLikes: (invitee) =>
    hex(invitee) === hex(bondInvitee.userId) ? 9n : 0n,
  getDecayPlans: () => [decayPlan],
  vouchCooldownBlocks: 2,
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
      deps, HEIGHT, [{ version: 1, fromHeight: 0 }], EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const { tx } = result;

    // ---- Inputs: exact order ----
    //
    //   emission → treasury → markers (committed tx order) →
    //   price boxes (committed tx order) → carry (ascending author hex) →
    //   bonds (ascending box id) → escrows (ascending box id) →
    //   decay consumed → pool → fees (committed tx order)
    expect(tx.inputs).toEqual([
      emissionBox.id,
      treasuryBox.id,
      markerBox.id,
      priceBox.id,
      carryBox.id,
      bondBox.id,
      escrowBox.id,
      lapsedVouchBox.id,
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
    expect(outs).toHaveLength(11);

    expect(outs[0]!.boxType).toBe('emission');
    // 1000 − min(100, 1000) + unearned(23) = 923
    // splitCoinbase(100, 10, 0, 1): bonusPool=(110×25)/100=27,
    // earned=27×1/6=4, unearned=23
    expect(outs[0]!.value).toBe(923n);

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

    // The lapse leg's escrow output: vouch_escrow, value = vouch.value,
    // owner = voucher, releaseAtBlock = createdAtBlock + cooldown.
    expect(outs[8]!.boxType).toBe('vouch_escrow');
    expect((outs[8] as VouchEscrowBox).owner).toEqual(lapseOwner.userId);
    expect(outs[8]!.value).toBe(1n);
    expect((outs[8] as VouchEscrowBox).releaseAtBlock).toBe(3 + 2); // createdAtBlock + vouchCooldownBlocks

    expect(outs[9]!.boxType).toBe('karma');
    expect((outs[9] as KarmaBox).owner).toEqual(decayOwner.userId);
    expect(outs[9]!.value).toBe(8n);

    expect(outs[10]!.boxType).toBe('credit');

    // Builder and verifier share derive(), so checkSettlement passing is
    // necessary but not sufficient — the positional assertions above are
    // the pin.
    const check = checkSettlement(
      deps, HEIGHT, [{ version: 1, fromHeight: 0 }], EMISSION, MINER_REWARD_DELAY, body, tx);
    expect(check.valid).toBe(true);
  });

  it('refuses a settlement carrying a postWithdraw payload', () => {
    const result = buildSettlement(
      deps, HEIGHT, [{ version: 1, fromHeight: 0 }], EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    expect('tx' in result).toBe(true);
    if (!('tx' in result)) return;
    const poisoned = { ...result.tx, postWithdraw: { postId: 'aa'.repeat(32) } };
    const check = checkSettlement(
      deps, HEIGHT, [{ version: 1, fromHeight: 0 }], EMISSION, MINER_REWARD_DELAY, body, poisoned);
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/settlement carries a postWithdraw/);
  });
});

describe('the settlement declares the block\'s era', () => {
  // A synthetic two-era schedule; a fixture may schedule a version the build
  // does not implement (TYPES_INTERFACE → Version).
  const AT_H = [{ version: 1, fromHeight: 0 }, { version: 2, fromHeight: HEIGHT }];
  const ONE_ERA = [{ version: 1, fromHeight: 0 }];

  it('the builder stamps the era at the block\'s height', () => {
    const built = buildSettlement(deps, HEIGHT, AT_H, EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    expect('tx' in built).toBe(true);
    if (!('tx' in built)) return;
    expect(built.tx.protocolVersion).toBe(2);
  });

  it('checkSettlement refuses a settlement declaring a version other than the era', () => {
    const era1 = buildSettlement(deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    expect('tx' in era1).toBe(true);
    if (!('tx' in era1)) return;
    // Built declaring 1, checked at H where the era is 2.
    const check = checkSettlement(deps, HEIGHT, AT_H, EMISSION, MINER_REWARD_DELAY, body, era1.tx);
    expect(check.valid).toBe(false);
    expect(check.error).toContain('not the era 2');
  });

  it('the byte probe measures a wide version — era 128 is one byte more than era 1', () => {
    const era1 = buildSettlement(deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    const era128 = buildSettlement(
      deps, HEIGHT, [{ version: 1, fromHeight: 0 }, { version: 128, fromHeight: HEIGHT }],
      EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    expect('tx' in era1 && 'tx' in era128).toBe(true);
    if (!('tx' in era1) || !('tx' in era128)) return;
    expect(era128.tx.protocolVersion).toBe(128);
    expect(encodeTx(era128.tx).length).toBe(encodeTx(era1.tx).length + 1);
  });
});
