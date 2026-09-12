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
  BackerPoolBox,
  BackerUnstakeBox,
  BondBox,
  CreditBox,
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
const backerOwner = makeTestIdentity();

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

// ---- Backer boxes ----

const BACKER_SUPPLY = 100n;
const backerPoolBoxObj = seedProvenance<BackerPoolBox>({
  boxType: 'backer_pool', value: 500n, staked: 50n, accrual: 1000n, createdAtBlock: 0,
}, 1, labelNonce('leg-order-backer-pool'));

const unstakeMarker = seedProvenance<BackerUnstakeBox>({
  boxType: 'backer_unstake', value: 0n as 0n, owner: backerOwner.userId, weight: 10n,
  createdAtBlock: HEIGHT,
}, HEIGHT, labelNonce('leg-order-unstake'));

// ---- Lookup for checkSettlement's conservation check ----

const boxMap = new Map<string, AnyBox>();
for (const box of [emissionBox, treasuryBox, poolBox, markerBox, carryBox,
                    bondBox, escrowBox, lapsedVouchBox, decayKarmaBox, feeBox, priceBox,
                    backerPoolBoxObj, unstakeMarker]) {
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
  unstakes: [{ id: unstakeMarker.id!, owner: backerOwner.userId, weight: 10n }],
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
  getBackerPoolBox: () => backerPoolBoxObj as BackerPoolBox,
  backerSupply: BACKER_SUPPLY,
  creditFixedRateBlocks: 1_000_000,
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
    //   emission → treasury → backer pool → unstake marker →
    //   like markers (committed tx order) →
    //   price boxes (committed tx order) → carry (ascending author hex) →
    //   bonds (ascending box id) → escrows (ascending box id) →
    //   lapsed vouches → decay consumed → pool → fees (committed tx order)
    expect(tx.inputs).toEqual([
      emissionBox.id,
      treasuryBox.id,
      backerPoolBoxObj.id,
      unstakeMarker.id,
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
    //   emission successor → treasury successor → backer pool successor →
    //   karma pool successor →
    //   invite grants → like payouts + carry → bond vested →
    //   escrow returns → lapse escrows → decay replacements →
    //   backer releases → coinbase credit
    const outs = tx.outputs;

    let idx = 0;
    expect(outs[idx]!.boxType).toBe('emission');
    idx++;

    expect(outs[idx]!.boxType).toBe('treasury');
    idx++;

    expect(outs[idx]!.boxType).toBe('backer_pool');
    idx++;

    expect(outs[idx]!.boxType).toBe('karma_pool');
    idx++;

    expect(outs[idx]!.boxType).toBe('karma');
    expect((outs[idx] as KarmaBox).owner).toEqual(newInvitee.userId);
    expect(outs[idx]!.value).toBe(15n);
    idx++;

    expect(outs[idx]!.boxType).toBe('karma');
    expect((outs[idx] as KarmaBox).owner).toEqual(likeAuthor.userId);
    expect(outs[idx]!.value).toBe(likePaid);
    idx++;

    expect(outs[idx]!.boxType).toBe('like_accrual');
    expect((outs[idx] as LikeAccrualBox).author).toEqual(likeAuthor.userId);
    expect(outs[idx]!.value).toBe(likeCarry);
    idx++;

    expect(outs[idx]!.boxType).toBe('karma');
    expect((outs[idx] as KarmaBox).owner).toEqual(bondInviter.userId);
    expect(outs[idx]!.value).toBe(bondVested);
    idx++;

    expect(outs[idx]!.boxType).toBe('karma');
    expect((outs[idx] as KarmaBox).owner).toEqual(escrowOwner.userId);
    expect(outs[idx]!.value).toBe(10n);
    idx++;

    expect(outs[idx]!.boxType).toBe('vouch_escrow');
    expect((outs[idx] as VouchEscrowBox).owner).toEqual(lapseOwner.userId);
    expect(outs[idx]!.value).toBe(1n);
    expect((outs[idx] as VouchEscrowBox).releaseAtBlock).toBe(3 + 2);
    idx++;

    expect(outs[idx]!.boxType).toBe('karma');
    expect((outs[idx] as KarmaBox).owner).toEqual(decayOwner.userId);
    expect(outs[idx]!.value).toBe(8n);
    idx++;

    // The backer release — one credit output per unstake marker whose
    // release is positive, after decay replacements and before the coinbase.
    expect(outs[idx]!.boxType).toBe('credit');
    expect((outs[idx] as CreditBox).owner).toEqual(backerOwner.userId);
    expect(outs[idx]!.createdAtBlock).toBe(HEIGHT);
    expect((outs[idx] as CreditBox).lockedUntilBlock).toBeUndefined();
    idx++;

    expect(outs[idx]!.boxType).toBe('credit');
    expect(idx).toBe(outs.length - 1);

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

// ---------------------------------------------------------------------------
// Coinbase tail binding — count capped at 1 and createdAtBlock pinned to the
// block height (MINING_INTERFACE → On block receipt, step 2).
// ---------------------------------------------------------------------------

describe('coinbase tail binding', () => {
  const ONE_ERA = [{ version: 1, fromHeight: 0 }] as const;

  function findCoinbaseIdx(tx: { outputs: readonly import('@dagsocial/types').AnyBoxCandidate[] }): number {
    for (let i = tx.outputs.length - 1; i >= 0; i--) {
      const o = tx.outputs[i]!;
      if (o.boxType === 'credit' && 'lockedUntilBlock' in o) return i;
    }
    return -1;
  }

  function validTx() {
    const result = buildSettlement(
      deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, miner.userId);
    if (!('tx' in result)) throw new Error(`fixture: ${result.error}`);
    return result.tx;
  }

  it('accepts the honest single-output coinbase', () => {
    const tx = validTx();
    const check = checkSettlement(
      deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, tx);
    expect(check.valid).toBe(true);
  });

  it('rejects a 2-output coinbase summing to the miner slice', () => {
    const tx = validTx();
    const coinbaseIdx = findCoinbaseIdx(tx);
    const coinbase = tx.outputs[coinbaseIdx] as CreditBox;
    const half = coinbase.value / 2n;
    const poisoned = {
      ...tx,
      outputs: [
        ...tx.outputs.filter((_, i) => i !== coinbaseIdx),
        { ...coinbase, value: half },
        { ...coinbase, value: coinbase.value - half },
      ],
    };
    const check = checkSettlement(
      deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, poisoned);
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/exactly 1 required/);
  });

  it('rejects createdAtBlock ahead of height', () => {
    const tx = validTx();
    const idx = findCoinbaseIdx(tx);
    const poisoned = {
      ...tx,
      outputs: tx.outputs.map((o, i) =>
        i === idx ? { ...o, createdAtBlock: HEIGHT + 5 } : o),
    };
    const check = checkSettlement(
      deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, poisoned);
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/coinbase createdAtBlock/);
  });

  it('rejects createdAtBlock below height', () => {
    const tx = validTx();
    const idx = findCoinbaseIdx(tx);
    const poisoned = {
      ...tx,
      outputs: tx.outputs.map((o, i) =>
        i === idx ? { ...o, createdAtBlock: HEIGHT - 3 } : o),
    };
    const check = checkSettlement(
      deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, poisoned);
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/coinbase createdAtBlock/);
  });

  it('rejects createdAtBlock of 0', () => {
    const tx = validTx();
    const idx = findCoinbaseIdx(tx);
    const poisoned = {
      ...tx,
      outputs: tx.outputs.map((o, i) =>
        i === idx ? { ...o, createdAtBlock: 0 } : o),
    };
    const check = checkSettlement(
      deps, HEIGHT, ONE_ERA, EMISSION, MINER_REWARD_DELAY, body, poisoned);
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/coinbase createdAtBlock/);
  });

  it('accepts zero coinbase outputs when miner slice is zero', () => {
    const zeroDeps: SettlementDeps = {
      ...deps,
      getLikeCarryBox: () => null,
      getBondsSettlingAt: () => [],
      getEscrowsReleasableAt: () => [],
      getLapsedVouches: () => [],
      getDecayPlans: () => [],
    };
    const zeroBody: SettlementBody = {
      fees: 0n, rent: 0n, actors: 0,
      feeBoxIds: [], invites: [], markers: [], priceBoxes: [], unstakes: [],
    };
    const result = buildSettlement(
      zeroDeps, HEIGHT, ONE_ERA, 0n, MINER_REWARD_DELAY, zeroBody, miner.userId);
    if (!('tx' in result)) throw new Error(`fixture: ${result.error}`);
    expect(result.tx.outputs.filter((o) => o.boxType === 'credit')).toHaveLength(0);
    const check = checkSettlement(
      zeroDeps, HEIGHT, ONE_ERA, 0n, MINER_REWARD_DELAY, zeroBody, result.tx);
    expect(check.valid).toBe(true);
  });
});
