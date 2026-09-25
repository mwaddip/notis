import { describe, it, expect } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  PROTOCOL_VERSION,
  computeTxId,
  encodeTx,
  profileFor,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, UtxoTransaction } from '@dagsocial/types';
import {
  buildBlockSettlement,
  checkSettlement,
  computeBlockReward,
  materializeOutput,
  splitCoinbase,
} from '@dagsocial/consensus';
import type { ApplyContext } from '@dagsocial/consensus';
import { emptyBody, settlementDepsWith } from '../src/settlement.js';
import { collectPostBodyKarma } from '../src/decay.js';
import {
  MemoryStateView,
  accrualBox,
  applyContextFor,
  bondBox,
  escrowBox,
  hex,
  identityRecord,
  karmaBox,
  protocolBox,
  seedProvenance,
  uid,
  vouchBox,
} from './helpers.js';

/**
 * The derivations the producer's settlement build shares with the applier
 * (CONSENSUS_INTERFACE → The settlement build): the reward, the post-body karma
 * projection, the settlement's read wiring, and the build itself, each over a
 * stub view.
 */

const devnet = profileFor('devnet');
const ctx = applyContextFor(devnet);
const CREDIT = 10n ** 8n;
const miner = uid('build/miner');

const ids = (boxes: AnyBox[]): string[] => boxes.map((b) => b.id!);

/** A body transaction as the build and the applier read it: its id, inputs and materialized outputs. */
function bodyTx(inputs: string[], outputs: AnyBoxCandidate[], signatures: Record<string, Uint8Array> = {}): {
  tx: UtxoTransaction;
  txId: string;
  inputs: string[];
  outputs: AnyBox[];
} {
  const tx: UtxoTransaction = { inputs, outputs, signatures, protocolVersion: PROTOCOL_VERSION };
  const txId = computeTxId(tx);
  return { tx, txId, inputs, outputs: outputs.map((o, i) => materializeOutput(o, txId, i)) };
}

const karma = (owner: Uint8Array, value: bigint, createdAtBlock = 1): AnyBoxCandidate =>
  ({ boxType: 'karma', value, createdAtBlock, owner }) as AnyBoxCandidate;

/** A view holding the emission box and the karma pool. */
function genesisView(): MemoryStateView {
  const view = new MemoryStateView({ memberCount: 0 });
  view.insertBox(protocolBox('emission', devnet.creditEmissionTotal, 1));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, 2));
  return view;
}

function built(result: { tx: UtxoTransaction } | { error: string }): UtxoTransaction {
  if ('error' in result) throw new Error(result.error);
  return result.tx;
}

describe('computeBlockReward (MINING_INTERFACE → Emission Schedule)', () => {
  for (const network of ['devnet', 'testnet', 'mainnet'] as const) {
    it(`${network}: 42 through the fixed rate, one credit less per epoch begun, nothing after the forty-first`, () => {
      const c = applyContextFor(profileFor(network));
      const [F, E] = [c.creditFixedRateBlocks, c.creditEpochBlocks];
      expect(computeBlockReward(0, c)).toBe(0n);
      expect(computeBlockReward(1, c)).toBe(42n * CREDIT);
      expect(computeBlockReward(F, c)).toBe(42n * CREDIT);
      expect(computeBlockReward(F + 1, c)).toBe(41n * CREDIT);
      expect(computeBlockReward(F + E, c)).toBe(41n * CREDIT);
      expect(computeBlockReward(F + E + 1, c)).toBe(40n * CREDIT);
      expect(computeBlockReward(F + 41 * E, c)).toBe(1n * CREDIT);
      expect(computeBlockReward(F + 41 * E + 1, c)).toBe(0n);
      expect(computeBlockReward(F + 1000 * E, c)).toBe(0n);
    });
  }
});

describe('collectPostBodyKarma — the post-body projection over a view', () => {
  it('lists each owner a body input touches, ascending hex: the pre-body boxes the body left, then its own', () => {
    const [alice, bob, carol] = [uid('cpbk/alice'), uid('cpbk/bob'), uid('cpbk/carol')];
    const view = new MemoryStateView();
    const [a1, a2, a3] = [karmaBox(alice, 10n, 1), karmaBox(alice, 10n, 2), karmaBox(alice, 5n, 3)];
    const b1 = karmaBox(bob, 7n, 4);
    for (const box of [a1, a2, a3, b1]) view.insertBox(box);

    const first = bodyTx([a1.id], [karma(alice, 6n), karma(carol, 4n)]);
    const second = bodyTx([first.outputs[0]!.id!], [karma(alice, 6n, 2)]);
    const third = bodyTx([b1.id], [karma(bob, 7n)]);
    const projection = collectPostBodyKarma(view, [first, second, third]);

    expect([...projection.keys()]).toEqual([hex(alice), hex(bob)].sort());
    expect(ids(projection.get(hex(alice))!.boxes)).toEqual([
      ...ids(view.getKarmaBoxes(alice)).filter((id) => id !== a1.id),
      second.outputs[0]!.id!,
    ]);
    expect(ids(projection.get(hex(bob))!.boxes)).toEqual([third.outputs[0]!.id!]);
    expect(projection.get(hex(alice))!.owner).toEqual(alice);
  });
});

describe('settlementDepsWith — the settlement\'s reads over a view', () => {
  it('the carry box is the author\'s first live accrual box by id that is not one of the block\'s markers', () => {
    const author = uid('carry/author');
    const view = new MemoryStateView();
    const boxes = [accrualBox(author, 2n, 1), accrualBox(author, 1n, 2), accrualBox(author, 1n, 3)]
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const box of boxes) view.insertBox(box);
    const deps = settlementDepsWith(view, ctx, () => [], [], [], () => null);

    expect(deps.getLikeCarryBox(author, new Set())).toBe(boxes[0]);
    expect(deps.getLikeCarryBox(author, new Set([boxes[0]!.id]))).toBe(boxes[1]);
    expect(deps.getLikeCarryBox(author, new Set(ids(boxes)))).toBeNull();
    expect(deps.getLikeCarryBox(uid('carry/nobody'), new Set())).toBeNull();
  });

  it('the bonds settling at a height are those invited a probation before it, and none inside the first', () => {
    const [inviter, early, late] = [uid('bonds/inviter'), uid('bonds/early'), uid('bonds/late')];
    const view = new MemoryStateView();
    view.putIdentityRecord(early, identityRecord({ invitedAtBlock: 2 }));
    view.putIdentityRecord(late, identityRecord({ invitedAtBlock: 7 }));
    const [bEarly, bLate] = [bondBox(inviter, early, 1), bondBox(inviter, late, 2)];
    view.insertBox(bEarly);
    view.insertBox(bLate);
    const deps = settlementDepsWith(view, ctx, () => [], [], [], () => null);
    const P = ctx.inviteProbationBlocks;

    expect(deps.getBondsSettlingAt(P)).toEqual([]);
    expect(deps.getBondsSettlingAt(P + 1)).toEqual([]);
    expect(deps.getBondsSettlingAt(P + 2)).toEqual([bEarly]);
    expect(deps.getBondsSettlingAt(P + 7)).toEqual([bEarly, bLate]);
  });

  it('reads lifetime likes off the record, hands the captures back as given, and carries the context', () => {
    const [invitee, stranger] = [uid('deps/invitee'), uid('deps/stranger')];
    const view = new MemoryStateView();
    view.putIdentityRecord(invitee, identityRecord({ lifetimeLikesReceived: 9n }));
    const escrows = [escrowBox(invitee, 1, 1)];
    const lapsed = [vouchBox(stranger, invitee, 2)];
    const pool = protocolBox('backer_pool', 0n, 3);
    const plans = [{ owner: invitee, consumedBoxIds: [], newValue: 1n, burnAmount: 1n }];
    const deps = settlementDepsWith(view, ctx, () => plans, escrows, lapsed, () => pool as never);

    expect(deps.getLifetimeLikes(invitee)).toBe(9n);
    expect(deps.getLifetimeLikes(stranger)).toBe(0n);
    expect(deps.getEscrowsReleasableAt(50)).toBe(escrows);
    expect(deps.getLapsedVouches()).toBe(lapsed);
    expect(deps.getBackerPoolBox()).toBe(pool);
    expect(deps.getDecayPlans()).toBe(plans);
    expect(deps.vouchCooldownBlocks).toBe(ctx.vouchCooldownBlocks);
    expect(deps.backerSupply).toBe(ctx.backerSupply);
    expect(deps.creditFixedRateBlocks).toBe(ctx.creditFixedRateBlocks);
  });
});

describe('buildBlockSettlement — the producer\'s settlement over a view', () => {
  it('an empty body: the release, the treasury\'s share and the locked coinbase, which the applier\'s check accepts', () => {
    const view = genesisView();
    const height = 7;
    const tx = built(buildBlockSettlement(view, [], height, miner, miner, ctx));

    expect(tx.inputs).toEqual([view.getEmissionBox()!.id]);
    expect(tx.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(tx.signatures).toEqual({});
    expect(tx.outputs.at(-1)).toMatchObject({
      boxType: 'credit',
      owner: miner,
      lockedUntilBlock: height + ctx.creditMinerRewardDelay,
      createdAtBlock: height,
    });
    const verdict = checkSettlement(
      settlementDepsWith(view, ctx, () => [], [], [], () => view.getBackerPoolBox()),
      height,
      ctx.protocolVersionSchedule,
      computeBlockReward(height, ctx),
      ctx.creditMinerRewardDelay,
      emptyBody(),
      tx,
    );
    expect(verdict).toEqual({ valid: true });
  });

  it('a body\'s fee box is a settlement input in body order; a signed spend\'s is a fee, an unsigned one\'s rent', () => {
    const view = genesisView();
    const [payer, payee] = [uid('fee/payer'), uid('fee/payee')];
    const held = seedProvenance<AnyBox>({ boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 1, owner: payer }, 1, 1);
    view.insertBox(held);
    const height = 7;
    const charge = CREDIT;
    const outputs = [
      { boxType: 'credit', value: 40n * CREDIT, createdAtBlock: height, owner: payee } as AnyBoxCandidate,
      { boxType: 'credit', value: 60n * CREDIT - charge, createdAtBlock: height, owner: payer } as AnyBoxCandidate,
      { boxType: 'fee', value: charge, createdAtBlock: height } as AnyBoxCandidate,
    ];
    const release = computeBlockReward(height, ctx);

    const signed = bodyTx([held.id!], outputs, { [hex(payer)]: new Uint8Array(64) });
    const paid = built(buildBlockSettlement(view, [encodeTx(signed.tx)], height, miner, miner, ctx));
    expect(paid.inputs).toEqual([view.getEmissionBox()!.id, signed.outputs[2]!.id]);
    expect(paid.outputs.at(-1)!.value).toBe(splitCoinbase(release, charge, 0n, 0).miner);

    const unsigned = bodyTx([held.id!], outputs);
    const rented = built(buildBlockSettlement(view, [encodeTx(unsigned.tx)], height, miner, miner, ctx));
    expect(rented.inputs).toEqual([view.getEmissionBox()!.id, unsigned.outputs[2]!.id]);
    expect(rented.outputs.at(-1)!.value).toBe(splitCoinbase(release, 0n, charge, 0).miner);
  });

  it('decay consumes the post-body boxes of an owner the body touches, derived from the pre-body record', () => {
    const decayCtx: ApplyContext = {
      ...ctx,
      decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
    };
    const view = genesisView();
    const stale = uid('decay/stale');
    const [a1, a2] = [karmaBox(stale, 40n, 1), karmaBox(stale, 30n, 2)];
    view.insertBox(a1);
    view.insertBox(a2);
    view.putIdentityRecord(stale, identityRecord());
    const height = 9;
    const consolidate = bodyTx([a1.id], [karma(stale, 40n, height)]);
    const produced = consolidate.outputs[0]!;
    const tx = built(buildBlockSettlement(view, [encodeTx(consolidate.tx)], height, miner, miner, decayCtx));

    // Stale at 9 with 3 whole intervals owed: 70 face, 15 burned, 55 re-emitted.
    const planInputs = tx.inputs.slice(tx.inputs.indexOf(a2.id));
    expect(planInputs.slice(0, 2)).toEqual([a2.id, produced.id]);
    expect(tx.inputs).not.toContain(a1.id);
    expect(tx.outputs).toContainEqual({ boxType: 'karma', value: 55n, owner: stale, createdAtBlock: height });
    expect(tx.outputs).toContainEqual({ boxType: 'karma_pool', value: 1_000_015n, createdAtBlock: height });
  });

  it('the escrow leg consumes what the view holds releasable, never an escrow the body creates', () => {
    const view = genesisView();
    const [voucher, target] = [uid('escrow/voucher'), uid('escrow/target')];
    const held = escrowBox(voucher, 3, 1);
    const staked = vouchBox(voucher, target, 2, 1);
    view.insertBox(held);
    view.insertBox(staked);
    const height = 9;
    const unvouch = bodyTx([staked.id], [{
      boxType: 'vouch_escrow',
      value: 1n,
      createdAtBlock: height,
      owner: voucher,
      releaseAtBlock: staked.createdAtBlock + ctx.vouchCooldownBlocks,
    } as AnyBoxCandidate]);
    const tx = built(buildBlockSettlement(view, [encodeTx(unvouch.tx)], height, miner, miner, ctx));

    expect(tx.inputs).toContain(held.id);
    expect(tx.inputs).not.toContain(unvouch.outputs[0]!.id);
    expect(tx.outputs).toContainEqual({ boxType: 'karma', value: 1n, owner: voucher, createdAtBlock: height });
    // The unvouch's input resolves from the view and names its voucher: one karma-side actor.
    expect(tx.outputs.at(-1)!.value).toBe(splitCoinbase(computeBlockReward(height, ctx), 0n, 0n, 1).miner);
  });

  it('a chain holding no emission box yields no settlement, and says why', () => {
    const view = new MemoryStateView();
    expect(buildBlockSettlement(view, [], 3, miner, miner, ctx)).toEqual({
      error: 'height 3 requires an emission box but this chain holds none',
    });
  });
});
