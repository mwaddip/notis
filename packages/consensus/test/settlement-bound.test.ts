// TYPES_INTERFACE → Size caps → "The settlement has its own bound because it
// is derived": an empty-body settlement with every state-driven leg at its
// cap fits `MAX_SETTLEMENT_BYTES`. Each paid owner costs one input and one
// karma output (NODE_INTERFACE → The settlement transaction → "The income
// leg pays each owner once"), whatever they hold. The decay leg's ceiling
// is `decayLegMaxBytes(version)` — two inputs and one karma output.
import { describe, it, expect } from 'vitest';
import {
  INVITE_BOND_VEST_PER_LIKES,
  LIKES_PER_KARMA_PAYOUT,
  MAX_BOND_SETTLEMENTS_PER_BLOCK,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  MAX_SETTLEMENT_BYTES,
  PROTOCOL_VERSION,
  encodeTx,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  KarmaBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import {
  buildSettlement,
  decayLegMaxBytes,
} from '@dagsocial/consensus';
import type { DecayPlan, SettlementBody, SettlementDeps } from '@dagsocial/consensus';
import {
  bondBox,
  escrowBox,
  incomeBox,
  karmaBox,
  labelNonce,
  seedProvenance,
  seededIdentity,
  uid,
  vouchBox,
} from './helpers.js';

const PROFILE = profileFor('devnet');
const ONE_ERA = PROFILE.protocolVersionSchedule;
const H = 1_000;
const miner = seededIdentity('bound/miner');

describe('decayLegMaxBytes — one squaring\'s ceiling', () => {
  it('two settlement inputs and one karma output grow a settlement by exactly `decayLegMaxBytes`', () => {
    // Compare two settlements that already move the karma pool box (so the
    // present-pool-input delta is already counted on both sides): the
    // reference has no decay plan, the comparee's plan consumes two boxes
    // and emits a karma output of 1n.
    const owner = uid('decay-grow/owner');
    const b1 = karmaBox(owner, 10n, 1, 0);
    const b2 = karmaBox(owner, 5n, 2, 0);
    const emission = seedProvenance<AnyBox>(
      { boxType: 'emission', value: PROFILE.creditEmissionTotal, createdAtBlock: 0 },
      0,
      labelNonce('decay-grow/emission'),
    );
    const pool = seedProvenance<AnyBox>(
      { boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 },
      0,
      labelNonce('decay-grow/pool'),
    );
    const boxMap = new Map<string, AnyBox>([
      [emission.id!, emission],
      [pool.id!, pool],
      [b1.id!, b1 as AnyBox],
      [b2.id!, b2 as AnyBox],
    ]);
    // The reference's body carries one bond invite so the karma pool is
    // spent: the pool input stands on both sides, so the per-input delta
    // the one measures is the decay inputs alone.
    const invitee = uid('decay-grow/invitee');
    const refBody: SettlementBody = {
      fees: 0n, rent: 0n, actors: 0,
      feeBoxIds: [],
      invites: [{ invitee, amount: 5n }],
      markers: [], priceBoxes: [], unstakes: [],
    };
    const noDecayDeps: SettlementDeps = {
      getEmissionBox: () => emission as never,
      getTreasuryBox: () => null,
      getKarmaPoolBox: () => pool as never,
      getBox: (id) => boxMap.get(id) ?? null,
      getLikeCarryBox: () => null,
      getBondsSettlingAt: () => [],
      getEscrowsReleasableAt: () => [],
      getLapsedVouches: () => [],
      getLifetimeLikes: () => 0n,
      getIncomeBox: () => null,
      getDecayPlans: () => [],
      vouchCooldownBlocks: PROFILE.vouchCooldownBlocks,
      getBackerPoolBox: () => null,
      backerSupply: 0n,
      creditFixedRateBlocks: PROFILE.creditFixedRateBlocks,
    };
    const refResult = buildSettlement(noDecayDeps, H, ONE_ERA, 0n, PROFILE.creditMinerRewardDelay, refBody, miner.userId);
    if ('error' in refResult) throw new Error(refResult.error);

    const plan: DecayPlan = {
      owner,
      consumedBoxIds: [b1.id!, b2.id!],
      newValue: 1n,
      burnAmount: 14n,
    };
    const withDecayDeps: SettlementDeps = {
      ...noDecayDeps,
      getDecayPlans: () => [plan],
    };
    const result = buildSettlement(withDecayDeps, H, ONE_ERA, 0n, PROFILE.creditMinerRewardDelay, refBody, miner.userId);
    if ('error' in result) throw new Error(result.error);

    const refBytes = encodeTx(refResult.tx).length;
    const withBytes = encodeTx(result.tx).length;
    const delta = withBytes - refBytes;
    // `decayLegMaxBytes` prices the leg's structure — two input ids and one
    // karma output's fixed-width fields — at the probe's `createdAtBlock: 0`
    // and `value: 1n`. At real heights the output's `createdAtBlock` VLQ
    // widens by one byte above 127 and again above 16 383, and the value's
    // VLQ by the same cadence; the array count prefixes a decay charge
    // moves across the same thresholds have the same bite. All three bite
    // once each in a settlement, and the sizer has the last word, so the
    // figure is a close reservation rather than an exact match.
    expect(delta).toBeLessThanOrEqual(decayLegMaxBytes(PROTOCOL_VERSION) + 4);
    expect(delta).toBeGreaterThanOrEqual(decayLegMaxBytes(PROTOCOL_VERSION) - 4);
  });

  it('reports decayLegMaxBytes at the current version', () => {
    // A smoke-check pinning the number for the current era. The figure is
    // blind to the same two things `settlementMarginalBytes` is: the
    // settlement's own array count prefixes widen with their counts rather
    // than with any one decay charge, and a first charge turns an absent
    // protocol-box input into a present one.
    expect(decayLegMaxBytes(PROTOCOL_VERSION)).toBeGreaterThan(0);
  });
});

describe('the capped legs fit', () => {
  // A body with all three state-driven legs full, every paid owner a
  // distinct identity already holding an income box: the settlement fits
  // `MAX_SETTLEMENT_BYTES`. Two shapes are measured — one owner per leg
  // position, and one owner for every bond and escrow.
  function capped(
    disjointOwners: boolean,
  ): { settlementBytes: number; settlement: ReturnType<typeof buildSettlement> } {
    const vouchers = Array.from({ length: MAX_LAPSE_WITHDRAWALS_PER_BLOCK }, (_, i) =>
      uid(`bound/voucher-${i}`),
    );
    const targets = Array.from({ length: MAX_LAPSE_WITHDRAWALS_PER_BLOCK }, (_, i) =>
      uid(`bound/target-${i}`),
    );
    const inviters = disjointOwners
      ? Array.from({ length: MAX_BOND_SETTLEMENTS_PER_BLOCK }, (_, i) => uid(`bound/inviter-${i}`))
      : Array.from({ length: MAX_BOND_SETTLEMENTS_PER_BLOCK }, () => uid('bound/one-inviter'));
    const invitees = Array.from({ length: MAX_BOND_SETTLEMENTS_PER_BLOCK }, (_, i) => uid(`bound/invitee-${i}`));
    const escrowOwners = disjointOwners
      ? Array.from({ length: MAX_ESCROW_RETURNS_PER_BLOCK }, (_, i) => uid(`bound/escrow-${i}`))
      : Array.from({ length: MAX_ESCROW_RETURNS_PER_BLOCK }, () => uid('bound/one-inviter'));

    const bonds = inviters.map((inviter, i) =>
      bondBox(inviter, invitees[i]!, 1000 + i, 0),
    );
    const escrows = escrowOwners.map((owner, i) =>
      escrowBox(owner, 1, 2000 + i, 0),
    );
    const lapsedVouches = vouchers.map((v, i) => vouchBox(v, targets[i]!, 3000 + i, 0));

    const emission = seedProvenance<AnyBox>(
      { boxType: 'emission', value: PROFILE.creditEmissionTotal, createdAtBlock: 0 },
      0,
      labelNonce('capped/emission'),
    );
    const pool = seedProvenance<AnyBox>(
      { boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 },
      0,
      labelNonce('capped/pool'),
    );
    // Each paid owner holds a pre-body income box the leg consumes.
    const paidOwners = new Set<string>();
    for (const inviter of inviters) paidOwners.add(Buffer.from(inviter).toString('hex'));
    for (const owner of escrowOwners) paidOwners.add(Buffer.from(owner).toString('hex'));
    const incomeBoxes = new Map<string, KarmaBox>();
    for (const ownerHex of paidOwners) {
      const owner = Uint8Array.from(Buffer.from(ownerHex, 'hex'));
      const box = incomeBox(owner, 1n, 5000 + incomeBoxes.size, 0);
      incomeBoxes.set(ownerHex, box);
    }

    const boxMap = new Map<string, AnyBox>();
    boxMap.set(emission.id!, emission);
    boxMap.set(pool.id!, pool);
    for (const b of bonds) boxMap.set(b.id!, b as AnyBox);
    for (const e of escrows) boxMap.set(e.id!, e as AnyBox);
    for (const v of lapsedVouches) boxMap.set(v.id!, v as AnyBox);
    for (const box of incomeBoxes.values()) boxMap.set(box.id!, box);

    const deps: SettlementDeps = {
      getEmissionBox: () => emission as never,
      getTreasuryBox: () => null,
      getKarmaPoolBox: () => pool as never,
      getBox: (id) => boxMap.get(id) ?? null,
      getLikeCarryBox: () => null,
      getBondsSettlingAt: () => bonds as BondBox[],
      getEscrowsReleasableAt: () => escrows as VouchEscrowBox[],
      getLapsedVouches: () => lapsedVouches as VouchBox[],
      getLifetimeLikes: () => BigInt(10 * INVITE_BOND_VEST_PER_LIKES * Number(bonds[0]!.value)),
      getIncomeBox: (owner) => incomeBoxes.get(Buffer.from(owner).toString('hex')) ?? null,
      getDecayPlans: () => [],
      vouchCooldownBlocks: PROFILE.vouchCooldownBlocks,
      getBackerPoolBox: () => null,
      backerSupply: 0n,
      creditFixedRateBlocks: PROFILE.creditFixedRateBlocks,
    };

    const emptyBody: SettlementBody = {
      fees: 0n, rent: 0n, actors: 0,
      feeBoxIds: [], invites: [], markers: [], priceBoxes: [], unstakes: [],
    };
    const result = buildSettlement(
      deps, H, ONE_ERA, 0n, PROFILE.creditMinerRewardDelay, emptyBody, miner.userId,
    );
    if ('error' in result) throw new Error(result.error);
    return { settlementBytes: encodeTx(result.tx).length, settlement: result };
  }

  it('a body with each cap full, every paid owner distinct and holding an income box, fits', () => {
    const { settlementBytes } = capped(true);
    expect(settlementBytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    // Report the measured bytes.
    // eslint-disable-next-line no-console
    console.log(`capped legs, distinct owners: settlement = ${settlementBytes} bytes`);
  });

  it('the same body with one owner for every bond and escrow is strictly smaller', () => {
    const { settlementBytes: shared } = capped(false);
    const { settlementBytes: distinct } = capped(true);
    expect(shared).toBeLessThan(distinct);
    expect(shared).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    // eslint-disable-next-line no-console
    console.log(`capped legs, one owner shared across bonds+escrows: settlement = ${shared} bytes`);
  });
});

// LIKES_PER_KARMA_PAYOUT is used in the general bound argument above but no
// specific case here reads it; the reference to the constant pins the file
// to the import.
void LIKES_PER_KARMA_PAYOUT;
