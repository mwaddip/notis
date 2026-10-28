// TYPES_INTERFACE → Size caps → "The settlement has its own bound because it
// is derived": an empty-body settlement with every state-driven leg at its
// cap fits `MAX_SETTLEMENT_BYTES`. Each paid owner costs one input and one
// karma output (NODE_INTERFACE → The settlement transaction → "The income
// leg pays each owner once"), whatever they hold. The decay leg's ceiling
// is `decayLegMaxBytes(version)` — two inputs and one karma output, priced
// at the widest `value` and `createdAtBlock` the codec writes for a karma
// box (CONSENSUS_INTERFACE → The settlement build →
// "`decayLegMaxBytes(protocolVersion)` is what one squaring adds to a
// settlement at most").
import { describe, it, expect } from 'vitest';
import {
  BOX_VALUE_BOUND,
  INVITE_BOND_VEST_PER_LIKES,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKES_PER_KARMA_PAYOUT,
  MAX_BLOCK_COST,
  MAX_BOND_SETTLEMENTS_PER_BLOCK,
  MAX_ESCROW_RETURNS_PER_BLOCK,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  MAX_SETTLEMENT_BYTES,
  PROTOCOL_VERSION,
  encodeTx,
  hexToBytes,
  postKey,
  postRecordBytes,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  IdentityRecord,
  KarmaBox,
  NetworkRecord,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import {
  applyBlock,
  blockCost,
  buildSettlement,
  decayLegMaxBytes,
  seedTreeWrites,
  treeStateView,
  treeWritesOf,
} from '@dagsocial/consensus';
import type { ApplyContext, DecayPlan, SettlementBody, SettlementDeps } from '@dagsocial/consensus';
import {
  applyContextFor,
  bondBox,
  candidateBlock,
  escrowBox,
  hex,
  identityRecord,
  incomeBox,
  karmaBox,
  labelNonce,
  likeTx,
  seedProvenance,
  seededIdentity,
  uid,
  vouchBox,
} from './helpers.js';
import { mapSessionFrom } from './tree-session-map.js';

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
    // `burnAmount` is positive so the decay leg emits its output: the test
    // probes the widest karma box a leg can emit (NODE_INTERFACE → Karma
    // decay → "The leg is two inputs at most and one output"). A zero-burn
    // plan emits nothing by design, so the measurement needs a positive
    // burn to see the output's width.
    const plan: DecayPlan = {
      owner,
      consumedBoxIds: [b1.id!, b2.id!],
      newValue: value,
      burnAmount: 1n,
      settledThrough: height,
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

  it('every (height, value) pair fits inside decayLegMaxBytes', () => {
    const figure = decayLegMaxBytes(PROTOCOL_VERSION);
    for (const h of HEIGHTS) {
      for (const v of VALUES) {
        expect(measure(h, v), `h=${h}, v=${v}`).toBeLessThanOrEqual(figure);
      }
    }
  });

  it('at the widest height and value the growth equals decayLegMaxBytes modulo count prefixes and the first protocol-box input', () => {
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
  // `MAX_SETTLEMENT_BYTES`. Three shapes are measured — one owner per leg
  // position, one owner for every bond and escrow, and every paid owner
  // owing decay and holding an own box beside their income box.
  function capped(
    disjointOwners: boolean,
    withDecay: boolean = false,
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
    // Each paid owner holds a pre-body income box the leg consumes. With
    // decay, each paid owner also holds an own box of value KARMA_MINIMUM +
    // 100n so decay burns the per-period amount at this height.
    const paidOwners = new Set<string>();
    for (const inviter of inviters) paidOwners.add(Buffer.from(inviter).toString('hex'));
    for (const owner of escrowOwners) paidOwners.add(Buffer.from(owner).toString('hex'));
    const incomeBoxes = new Map<string, KarmaBox>();
    const ownBoxes = new Map<string, KarmaBox>();
    for (const ownerHex of paidOwners) {
      const owner = Uint8Array.from(Buffer.from(ownerHex, 'hex'));
      const ib = incomeBox(owner, 1n, 5000 + incomeBoxes.size, 0);
      incomeBoxes.set(ownerHex, ib);
      if (withDecay) {
        const ob = karmaBox(owner, 110n, 6000 + ownBoxes.size, 0);
        ownBoxes.set(ownerHex, ob);
      }
    }

    const boxMap = new Map<string, AnyBox>();
    boxMap.set(emission.id!, emission);
    boxMap.set(pool.id!, pool);
    for (const b of bonds) boxMap.set(b.id!, b as AnyBox);
    for (const e of escrows) boxMap.set(e.id!, e as AnyBox);
    for (const v of lapsedVouches) boxMap.set(v.id!, v as AnyBox);
    for (const box of incomeBoxes.values()) boxMap.set(box.id!, box);
    for (const box of ownBoxes.values()) boxMap.set(box.id!, box);

    // One decay plan per paid owner: consumes the own and income boxes,
    // emits unmarked karma of effective, burns KARMA_DECAY_AMOUNT to pool.
    // `settledThrough` is the height, as any period-end at the window — the
    // bound is blind to its exact value.
    const decayPlans = withDecay
      ? [...paidOwners].sort().map((ownerHex) => {
          const owner = Uint8Array.from(Buffer.from(ownerHex, 'hex'));
          const ob = ownBoxes.get(ownerHex)!;
          const ib = incomeBoxes.get(ownerHex)!;
          return {
            owner,
            consumedBoxIds: [ob.id!, ib.id!],
            newValue: ob.value + ib.value - 5n,
            burnAmount: 5n,
            settledThrough: H,
          };
        })
      : [];

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
      // With decay, the owner's income box is in the decay plan's
      // consumedBoxIds (the caller passes those as `excludeIds`), so the
      // income leg skips it and pays into a fresh box.
      getIncomeBox: (owner, excludeIds) => {
        const box = incomeBoxes.get(Buffer.from(owner).toString('hex'));
        if (!box) return null;
        if (excludeIds.has(box.id!)) return null;
        return box;
      },
      getDecayPlans: () => decayPlans,
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

  it('each paid owner owing decay and holding an own box beside their income box, fits', () => {
    const { settlementBytes } = capped(true, true);
    expect(settlementBytes).toBeLessThanOrEqual(MAX_SETTLEMENT_BYTES);
    // eslint-disable-next-line no-console
    console.log(`capped legs, each paid owner owing decay: settlement = ${settlementBytes} bytes`);
  });
});

// ---------------------------------------------------------------------------
// Block cost — the squared set extends who the apply loop writes
// (CONSENSUS_INTERFACE → The block's cost)
// ---------------------------------------------------------------------------

/**
 * The context the cost measurements share. Timescales short so the authors
 * are stale at the measurement height, with the universal decay amount and
 * floor.
 */
const COST_CTX: ApplyContext = {
  ...applyContextFor(PROFILE),
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
  decayCfg: {
    staleThresholdBlocks: 6,
    decayIntervalBlocks: 3,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  },
};
const COST_MINER = seededIdentity('cost/miner');

describe('block cost: a body of likes each paying a distinct stale author', () => {
  it('fits under MAX_BLOCK_COST and reports the figure', () => {
    const N = 50;
    const COST_H = 20;
    const authors = Array.from({ length: N }, (_, i) => seededIdentity(`cost/author-${i}`));
    const likers = Array.from({ length: N }, (_, i) => seededIdentity(`cost/liker-${i}`));

    const initialBoxes: AnyBox[] = [
      seedProvenance<AnyBox>(
        { boxType: 'emission', value: PROFILE.creditEmissionTotal, createdAtBlock: 0 }, 0, labelNonce('cost/emission'),
      ),
      seedProvenance<AnyBox>(
        { boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 }, 0, labelNonce('cost/pool'),
      ),
    ];
    let nonce = 1;
    for (const a of authors) initialBoxes.push(karmaBox(a.userId, KARMA_MINIMUM, nonce++, 0));
    for (const l of likers) initialBoxes.push(karmaBox(l.userId, 11n, nonce++, 0));
    // Each author's pre-seeded accrual carry (value 4) tips payout on the
    // single like that targets them in this block.
    for (const a of authors) {
      initialBoxes.push(seedProvenance<AnyBox>(
        { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: a.userId }, 0, nonce++,
      ));
    }

    const initialRecords: Array<{ identityId: Uint8Array; record: IdentityRecord }> = [
      { identityId: COST_MINER.userId, record: identityRecord({ memberSinceBlock: 1 }) },
    ];
    for (const a of authors) initialRecords.push({ identityId: a.userId, record: identityRecord({ lastActivityBlock: 0 }) });
    for (const l of likers) initialRecords.push({ identityId: l.userId, record: identityRecord({ lastActivityBlock: COST_H - 1 }) });
    const network: NetworkRecord = { memberCount: 1 };

    const initialWrites = seedTreeWrites(initialBoxes, initialRecords, network);
    const session = mapSessionFrom(initialWrites);

    // Each author's confirmed post, inserted into the session before the
    // block runs. The tree view answers an author and standing from this row.
    const postIds = authors.map((_, i) => hex(uid(`cost/post-${i}`)));
    for (let i = 0; i < N; i++) {
      session.apply([{
        tag: 'Insert',
        key: postKey(hexToBytes(postIds[i]!)),
        value: postRecordBytes({ author: authors[i]!.userId, height: 1, standing: 'live' as const }),
      }]);
    }

    const buildView = treeStateView(session);
    const txs = likers.map((l, i) => likeTx(l, buildView.getKarmaBoxes(l.userId)[0]!, postIds[i]!, authors[i]!.userId, COST_H));
    const block = candidateBlock(buildView, COST_H, txs, COST_MINER.userId, COST_CTX);

    const applyView = treeStateView(session);
    const result = applyBlock(applyView, block, COST_CTX);
    if (!result.ok) throw new Error(`cost block refused: ${result.reason}`);
    const writes = treeWritesOf(result.effects, COST_H, applyView);
    const cost = {
      signatures: result.effects.signatures,
      lookups: applyView.lookupCount(),
      writes: writes.length,
    };
    const total = blockCost(cost);
    expect(total).toBeLessThanOrEqual(MAX_BLOCK_COST);
    // eslint-disable-next-line no-console
    console.log(
      `N=${N} likes paying distinct stale authors: cost ${total} of ${MAX_BLOCK_COST} — ` +
      `signatures ${cost.signatures}, lookups ${cost.lookups}, writes ${cost.writes}`,
    );
  });
});

describe('block cost: an empty-body block with capped legs and every paid owner owing decay', () => {
  it('fits under MAX_BLOCK_COST and reports the figure', () => {
    const COST_H = 20;
    const B = MAX_BOND_SETTLEMENTS_PER_BLOCK;
    const E = MAX_ESCROW_RETURNS_PER_BLOCK;
    const L = MAX_LAPSE_WITHDRAWALS_PER_BLOCK;

    const inviters = Array.from({ length: B }, (_, i) => seededIdentity(`cost-legs/inviter-${i}`));
    const invitees = Array.from({ length: B }, (_, i) => seededIdentity(`cost-legs/invitee-${i}`));
    const escrowOwners = Array.from({ length: E }, (_, i) => seededIdentity(`cost-legs/escrow-${i}`));
    const vouchers = Array.from({ length: L }, (_, i) => seededIdentity(`cost-legs/voucher-${i}`));
    const targets = Array.from({ length: L }, (_, i) => seededIdentity(`cost-legs/target-${i}`));

    const initialBoxes: AnyBox[] = [
      seedProvenance<AnyBox>(
        { boxType: 'emission', value: PROFILE.creditEmissionTotal, createdAtBlock: 0 }, 0, labelNonce('cost-legs/emission'),
      ),
      seedProvenance<AnyBox>(
        { boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 }, 0, labelNonce('cost-legs/pool'),
      ),
    ];
    let nonce = 1;
    const paidOwners = new Set<string>();
    for (const inviter of inviters) paidOwners.add(hex(inviter.userId));
    for (const o of escrowOwners) paidOwners.add(hex(o.userId));
    // Each paid owner holds an own box and an income box, both at the floor
    // so decay fires zero-burn plans — the clock write and the squaring the
    // squared set extension drives.
    for (const ownerHex of [...paidOwners].sort()) {
      const owner = hexToBytes(ownerHex);
      initialBoxes.push(karmaBox(owner, KARMA_MINIMUM, nonce++, 0));
      initialBoxes.push(incomeBox(owner, 1n, nonce++, 0));
    }
    for (let i = 0; i < B; i++) initialBoxes.push(bondBox(inviters[i]!.userId, invitees[i]!.userId, nonce++, 1));
    for (let i = 0; i < E; i++) initialBoxes.push(escrowBox(escrowOwners[i]!.userId, 1, nonce++, 1));
    for (let i = 0; i < L; i++) initialBoxes.push(vouchBox(vouchers[i]!.userId, targets[i]!.userId, nonce++, 1));

    const initialRecords: Array<{ identityId: Uint8Array; record: IdentityRecord }> = [
      { identityId: COST_MINER.userId, record: identityRecord({ memberSinceBlock: 1 }) },
    ];
    for (const ownerHex of [...paidOwners].sort()) {
      initialRecords.push({ identityId: hexToBytes(ownerHex), record: identityRecord({ lastActivityBlock: 0, memberSinceBlock: 1 }) });
    }
    for (const invitee of invitees) initialRecords.push({ identityId: invitee.userId, record: identityRecord({ invitedAtBlock: 1, lifetimeLikesReceived: 1_000_000n, memberSinceBlock: 1 }) });
    // Each voucher is a lapsed member — `memberSinceBlock > 0` and
    // `memberVouches < memberBar`.
    for (const voucher of vouchers) initialRecords.push({ identityId: voucher.userId, record: identityRecord({ lastActivityBlock: 0, memberSinceBlock: 1, memberBar: 2, memberVouches: 1 }) });
    for (const target of targets) initialRecords.push({ identityId: target.userId, record: identityRecord({ lastActivityBlock: 0, memberSinceBlock: 1 }) });
    const network: NetworkRecord = { memberCount: 1 };

    const initialWrites = seedTreeWrites(initialBoxes, initialRecords, network);
    const session = mapSessionFrom(initialWrites);

    const buildView = treeStateView(session);
    const block = candidateBlock(buildView, COST_H, [], COST_MINER.userId, COST_CTX);

    const applyView = treeStateView(session);
    const result = applyBlock(applyView, block, COST_CTX);
    if (!result.ok) throw new Error(`cost legs block refused: ${result.reason}`);
    const writes = treeWritesOf(result.effects, COST_H, applyView);
    const cost = {
      signatures: result.effects.signatures,
      lookups: applyView.lookupCount(),
      writes: writes.length,
    };
    const total = blockCost(cost);
    expect(total).toBeLessThanOrEqual(MAX_BLOCK_COST);
    // eslint-disable-next-line no-console
    console.log(
      `empty-body capped legs, every paid owner owing decay: cost ${total} of ${MAX_BLOCK_COST} — ` +
      `signatures ${cost.signatures}, lookups ${cost.lookups}, writes ${cost.writes}`,
    );
  });
});

// LIKES_PER_KARMA_PAYOUT is used in the general bound argument above but no
// specific case here reads it; the reference to the constant pins the file
// to the import.
void LIKES_PER_KARMA_PAYOUT;
