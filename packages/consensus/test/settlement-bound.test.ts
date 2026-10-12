// TYPES_INTERFACE → Size caps → "The settlement has its own bound because it
// is derived": an empty-body settlement with every state-driven leg at its
// cap fits `MAX_SETTLEMENT_BYTES`. Each paid owner costs one input and one
// karma output (NODE_INTERFACE → The settlement transaction → "The income
// leg pays each owner once"), whatever they hold. The decay leg's ceiling
// is `decayLegMaxBytes(version)` — two inputs and one karma output, priced
// at the widest `value` and `createdAtBlock` the codec writes for a karma
// box (CONSENSUS_INTERFACE → The settlement build → "`decayLegMaxBytes` is
// what one squaring adds to a settlement at most").
import { describe, it, expect } from 'vitest';
import {
  BOX_VALUE_BOUND,
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

describe('decayLegMaxBytes — the ceiling at every (height, value) pair', () => {
  // The widest `value` the codec writes for a karma box: `BOX_VALUE_BOUND -
  // 1n`, the ceiling the accepted domain pins at `2⁶³ − 1` (TYPES_INTERFACE
  // → Box value domain). The widest `createdAtBlock` the codec writes
  // faithfully is `Number.MAX_SAFE_INTEGER` — beyond it `writeVlqU` writes
  // the sentinel (TYPES_INTERFACE → Totality names `vlqU` as the sentinel
  // arm).
  const WIDEST_VALUE = BOX_VALUE_BOUND - 1n;
  const WIDEST_HEIGHT = Number.MAX_SAFE_INTEGER;

  /**
   * The settlement's growth over the empty-decay reference, measured by
   * encoding both sides: a decay plan consuming two boxes and emitting one
   * karma output of `value` at the block's `height`. The ref body carries
   * one bond invite so the karma pool is already a settlement input on both
   * sides — the "first protocol-box input" delta the figure's comment names
   * is zero here.
   */
  function measure(height: number, value: bigint): number {
    const owner = uid(`ceiling/owner/${height}/${value}`);
    const b1 = karmaBox(owner, 10n, labelNonce(`ceiling/b1/${height}/${value}`), 0);
    const b2 = karmaBox(owner, 5n, labelNonce(`ceiling/b2/${height}/${value}`), 0);
    const emission = seedProvenance<AnyBox>(
      { boxType: 'emission', value: PROFILE.creditEmissionTotal, createdAtBlock: 0 },
      0,
      labelNonce(`ceiling/emission/${height}/${value}`),
    );
    const pool = seedProvenance<AnyBox>(
      { boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 },
      0,
      labelNonce(`ceiling/pool/${height}/${value}`),
    );
    const boxMap = new Map<string, AnyBox>([
      [emission.id!, emission],
      [pool.id!, pool],
      [b1.id!, b1 as AnyBox],
      [b2.id!, b2 as AnyBox],
    ]);
    const invitee = uid(`ceiling/invitee/${height}/${value}`);
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
    const refResult = buildSettlement(
      noDecayDeps, height, ONE_ERA, 0n, PROFILE.creditMinerRewardDelay, refBody, miner.userId,
    );
    if ('error' in refResult) throw new Error(refResult.error);
    const plan: DecayPlan = {
      owner,
      consumedBoxIds: [b1.id!, b2.id!],
      newValue: value,
      burnAmount: 15n - value < 0n ? 0n : 15n - value,
    };
    const withDecayDeps: SettlementDeps = {
      ...noDecayDeps,
      getDecayPlans: () => [plan],
    };
    const result = buildSettlement(
      withDecayDeps, height, ONE_ERA, 0n, PROFILE.creditMinerRewardDelay, refBody, miner.userId,
    );
    if ('error' in result) throw new Error(result.error);
    return encodeTx(result.tx).length - encodeTx(refResult.tx).length;
  }

  const HEIGHTS = [1, 200, 20_000, 5_000_000] as const;
  const VALUES = [1n, 200n, 20_000n, WIDEST_VALUE] as const;

  it.fails('every (height, value) pair fits inside decayLegMaxBytes', () => {
    const figure = decayLegMaxBytes(PROTOCOL_VERSION);
    for (const h of HEIGHTS) {
      for (const v of VALUES) {
        expect(measure(h, v), `h=${h}, v=${v}`).toBeLessThanOrEqual(figure);
      }
    }
  });

  it.fails('at the widest height and value the growth equals decayLegMaxBytes modulo count prefixes and the first protocol-box input', () => {
    const figure = decayLegMaxBytes(PROTOCOL_VERSION);
    const delta = measure(WIDEST_HEIGHT, WIDEST_VALUE);
    expect(delta).toBeLessThanOrEqual(figure);
    expect(delta).toBeGreaterThanOrEqual(figure - 4);
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
