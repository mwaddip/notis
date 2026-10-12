import { describe, it, expect } from 'vitest';
import {
  EMPTY_STATE_ROOT,
  MAX_LAPSE_WITHDRAWALS_PER_BLOCK,
  PROTOCOL_VERSION,
  castCountKey,
  computeTxId,
  decodeTx,
  encodeTx,
  equalBytes,
  lapsedKey,
  profileFor,
} from '@dagsocial/types';
import type {
  OrderingBlock,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import {
  applyBlock,
  buildSettlement,
  computeBlockReward,
  seedTreeWrites,
  treeStateView,
  treeWritesOf,
} from '@dagsocial/consensus';
import {
  emptyBody,
  lapseLegOf,
  settlementDepsWith,
} from '../src/settlement.js';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  hex,
  identityRecord,
  protocolBox,
  seededIdentity,
  unvouchTx,
  vouchBox,
  writeEffects,
} from './helpers.js';
import { mapSessionFrom } from './tree-session-map.js';

/**
 * The leg is the pre-body capture less every vouch the body spends
 * (NODE_INTERFACE → The settlement transaction → "The lapse leg leaves out a
 * vouch the body spends"). The function `lapseLegOf` reads no state, and both
 * `applyBlock` and `buildBlockSettlement` take their lapse list from it
 * (CONSENSUS_INTERFACE → The settlement build → "The lapse list is one
 * function's answer on both sides").
 */

const devnet = profileFor('devnet');
const ctx = applyContextFor(devnet);

const miner = seededIdentity('lapse/miner');

/** A lapsed voucher: a record failing `member()` — age set, bar above its count. */
function lapsedRecord(fields: Partial<ReturnType<typeof identityRecord>> = {}) {
  return identityRecord({
    memberSinceBlock: 2,
    memberBar: 3,
    memberVouches: 0,
    lastActivityBlock: 1,
    ...fields,
  });
}

/** A view with the two protocol boxes the settlement reads. */
function genesisView(network: { memberCount: number } = { memberCount: 0 }): MemoryStateView {
  const view = new MemoryStateView(network);
  view.insertBox(protocolBox('emission', devnet.creditEmissionTotal, 1));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, 2));
  return view;
}

// ---------------------------------------------------------------------------
// `lapseLegOf` alone — pure, state-free
// ---------------------------------------------------------------------------

describe('lapseLegOf (NODE_INTERFACE → The settlement transaction → "The lapse leg leaves out a vouch the body spends")', () => {
  const V = seededIdentity('lapse-leg/voucher').userId;
  const t1 = seededIdentity('lapse-leg/t1').userId;
  const t2 = seededIdentity('lapse-leg/t2').userId;
  const t3 = seededIdentity('lapse-leg/t3').userId;
  const v1 = vouchBox(V, t1, 1);
  const v2 = vouchBox(V, t2, 2);
  const v3 = vouchBox(V, t3, 3);
  const capture: VouchBox[] = [v1, v2, v3];

  it('keeps the capture\'s order and drops only the ids `spent` names', () => {
    const spent = new Set<string>([v2.id!]);
    expect(lapseLegOf(capture, spent).map((v) => v.id)).toEqual([v1.id, v3.id]);
  });

  it('a `spent` id the capture does not hold changes nothing', () => {
    const stranger = 'f'.repeat(64);
    const spent = new Set<string>([stranger]);
    expect(lapseLegOf(capture, spent).map((v) => v.id)).toEqual([v1.id, v2.id, v3.id]);
  });

  it('an empty `spent` answers every element', () => {
    expect(lapseLegOf(capture, new Set<string>()).map((v) => v.id)).toEqual([v1.id, v2.id, v3.id]);
  });

  it('every element spent answers none', () => {
    const spent = new Set<string>([v1.id!, v2.id!, v3.id!]);
    expect(lapseLegOf(capture, spent)).toEqual([]);
  });

  it('the capture is not mutated', () => {
    const before = capture.map((v) => v.id);
    lapseLegOf(capture, new Set<string>([v2.id!]));
    expect(capture.map((v) => v.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// `applyBlock` — a body unvouch of a lapsed voucher's vouch
// ---------------------------------------------------------------------------

describe('applyBlock — the body\'s unvouch and the lapse leg (NODE_INTERFACE → The settlement transaction)', () => {
  it('the unvouch applies and the leg emits no escrow for the spent vouch', () => {
    const voucher = seededIdentity('lapse-apply/one/voucher');
    const target = seededIdentity('lapse-apply/one/target');
    const view = genesisView();
    view.putIdentityRecord(voucher.userId, lapsedRecord());
    view.putIdentityRecord(target.userId, identityRecord({ memberSinceBlock: 1 }));
    const vouch = vouchBox(voucher.userId, target.userId, 1, 3);
    view.insertBox(vouch);

    const H = 10;
    const body = unvouchTx(voucher, vouch, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [body], miner.userId, ctx);

    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const settlementTx = decodeSettlement(block);
    expect(settlementTx.inputs).not.toContain(vouch.id);
    expect(settlementTx.outputs.some((o) =>
      o.boxType === 'vouch_escrow' && equalBytes(o.owner!, voucher.userId))).toBe(false);

    writeEffects(view, result.effects, H);
    expect(view.getBox(vouch.id!)).toBeNull();
    const escrows = view.getVouchEscrowsFor(voucher.userId);
    expect(escrows).toHaveLength(1);
    expect(escrows[0]!.value).toBe(vouch.value);
    expect(escrows[0]!.releaseAtBlock).toBe(vouch.createdAtBlock + ctx.vouchCooldownBlocks);
  });

  it('the target\'s count falls once, and the membership pass sees it', () => {
    const voucher = seededIdentity('lapse-apply/count/voucher');
    const target = seededIdentity('lapse-apply/count/target');
    // The voucher's age is strictly below the target's — the counted() predicate
    // (NODE_INTERFACE → Vouch transition rules → "The counter has two writers and
    // one predicate") — so the cast counted and the consumption uncounts once.
    const view = genesisView({ memberCount: 1 });
    view.putIdentityRecord(voucher.userId, lapsedRecord({ memberSinceBlock: 2 }));
    view.putIdentityRecord(target.userId, identityRecord({
      memberSinceBlock: 5,
      memberBar: 1,
      memberVouches: 1,
    }));
    const vouch = vouchBox(voucher.userId, target.userId, 1, 3);
    view.insertBox(vouch);

    const H = 10;
    const body = unvouchTx(voucher, vouch, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [body], miner.userId, ctx);

    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    writeEffects(view, result.effects, H);
    expect(view.getIdentityRecord(target.userId)!.memberVouches).toBe(0);
    expect(view.getNetworkRecord().memberCount).toBe(0);
  });

  it('the voucher\'s other vouches are still taken by the leg, in target order', () => {
    const voucher = seededIdentity('lapse-apply/three/voucher');
    const unsortedTargets = [1, 2, 3].map((i) =>
      seededIdentity(`lapse-apply/three/t/${i}`).userId);
    const sortedTargets = [...unsortedTargets].sort((a, b) =>
      hex(a) < hex(b) ? -1 : 1);
    const [t1, t2, t3] = sortedTargets as [Uint8Array, Uint8Array, Uint8Array];

    const view = genesisView();
    // The voucher's age is 2; each target's is strictly above it, so every
    // vouch is counted (NODE_INTERFACE → Vouch transition rules → "The
    // counter has two writers and one predicate"). Each target starts with
    // `memberVouches: 1` so the consumption lands at 0.
    view.putIdentityRecord(voucher.userId, lapsedRecord());
    for (const t of sortedTargets) {
      view.putIdentityRecord(t, identityRecord({
        memberSinceBlock: 3,
        memberBar: 0,
        memberVouches: 1,
      }));
    }
    const v1 = vouchBox(voucher.userId, t1, 1, 3);
    const v2 = vouchBox(voucher.userId, t2, 2, 3);
    const v3 = vouchBox(voucher.userId, t3, 3, 3);
    for (const box of [v1, v2, v3]) view.insertBox(box);

    const H = 10;
    const body = unvouchTx(voucher, v2, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [body], miner.userId, ctx);

    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const settlementTx = decodeSettlement(block);
    // The leg's inputs sit before the pool's input in the derived order.
    const vouchInputs = settlementTx.inputs
      .filter((id) => id === v1.id || id === v3.id);
    expect(vouchInputs).toEqual([v1.id, v3.id]);
    expect(settlementTx.inputs).not.toContain(v2.id);

    writeEffects(view, result.effects, H);
    const escrows = view.getVouchEscrowsFor(voucher.userId);
    expect(escrows).toHaveLength(3);
    for (const t of sortedTargets) {
      expect(view.getVouchBoxes(voucher.userId, t)).toEqual([]);
      expect(view.getIdentityRecord(t)!.memberVouches).toBe(0);
    }

    // The next block's capture holds none of the voucher's vouches.
    expect(view.getLapsedVouches(MAX_LAPSE_WITHDRAWALS_PER_BLOCK)).toEqual([]);
  });

  it('at the cap: 65 lapsed, body unvouches one of the first 64, settlement consumes the other 63', () => {
    const voucher = seededIdentity('lapse-apply/cap/voucher');
    const unsorted = Array.from({ length: 65 }, (_, i) =>
      seededIdentity(`lapse-apply/cap/t/${i.toString().padStart(3, '0')}`).userId);
    const sorted = [...unsorted].sort((a, b) => hex(a) < hex(b) ? -1 : 1);

    const view = genesisView();
    view.putIdentityRecord(voucher.userId, lapsedRecord());
    const vouches: VouchBox[] = [];
    let nonce = 10;
    for (const t of sorted) {
      view.putIdentityRecord(t, identityRecord({ memberSinceBlock: 1 }));
      const v = vouchBox(voucher.userId, t, nonce++, 3);
      view.insertBox(v);
      vouches.push(v);
    }

    // The capture at MAX_LAPSE_WITHDRAWALS_PER_BLOCK is the first 64 in
    // (voucher, target) order; the 65th is outside.
    expect(view.getLapsedVouches(MAX_LAPSE_WITHDRAWALS_PER_BLOCK).map((b) => b.id))
      .toEqual(vouches.slice(0, MAX_LAPSE_WITHDRAWALS_PER_BLOCK).map((b) => b.id));

    const H = 10;
    const body = unvouchTx(voucher, vouches[0]!, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [body], miner.userId, ctx);
    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const settlementTx = decodeSettlement(block);
    const legIds = settlementTx.inputs.filter((id) =>
      vouches.slice(1, MAX_LAPSE_WITHDRAWALS_PER_BLOCK).some((v) => v.id === id));
    expect(legIds).toEqual(vouches.slice(1, MAX_LAPSE_WITHDRAWALS_PER_BLOCK).map((b) => b.id));
    expect(settlementTx.inputs).not.toContain(vouches[0]!.id);
    expect(settlementTx.inputs).not.toContain(vouches[MAX_LAPSE_WITHDRAWALS_PER_BLOCK]!.id);

    writeEffects(view, result.effects, H);
    // The 65th is still live and alone in the next capture.
    const remaining = view.getLapsedVouches(MAX_LAPSE_WITHDRAWALS_PER_BLOCK);
    expect(remaining.map((b) => b.id)).toEqual([vouches[MAX_LAPSE_WITHDRAWALS_PER_BLOCK]!.id]);

    const nextBlock = candidateBlock(view, H + 1, [], miner.userId, ctx);
    const next = applyBlock(view, nextBlock, ctx);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const nextSettlement = decodeSettlement(nextBlock);
    expect(nextSettlement.inputs).toContain(vouches[MAX_LAPSE_WITHDRAWALS_PER_BLOCK]!.id);
  });

  it('past the cap: 65 lapsed, body unvouches the 65th, settlement consumes the first 64', () => {
    const voucher = seededIdentity('lapse-apply/past/voucher');
    const unsorted = Array.from({ length: 65 }, (_, i) =>
      seededIdentity(`lapse-apply/past/t/${i.toString().padStart(3, '0')}`).userId);
    const sorted = [...unsorted].sort((a, b) => hex(a) < hex(b) ? -1 : 1);

    const view = genesisView();
    view.putIdentityRecord(voucher.userId, lapsedRecord());
    const vouches: VouchBox[] = [];
    let nonce = 10;
    for (const t of sorted) {
      view.putIdentityRecord(t, identityRecord({ memberSinceBlock: 1 }));
      const v = vouchBox(voucher.userId, t, nonce++, 3);
      view.insertBox(v);
      vouches.push(v);
    }

    const H = 10;
    const body = unvouchTx(voucher, vouches[MAX_LAPSE_WITHDRAWALS_PER_BLOCK]!, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [body], miner.userId, ctx);
    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const settlementTx = decodeSettlement(block);
    const first64 = vouches.slice(0, MAX_LAPSE_WITHDRAWALS_PER_BLOCK).map((b) => b.id);
    const legIds = settlementTx.inputs.filter((id) => first64.includes(id));
    expect(legIds).toEqual(first64);
    expect(settlementTx.inputs).not.toContain(vouches[MAX_LAPSE_WITHDRAWALS_PER_BLOCK]!.id);
  });

  it('a member\'s unvouch beside a lapse leg: the leg takes all of the lapsed voucher\'s vouches', () => {
    const lapsedVoucher = seededIdentity('lapse-apply/beside/lapsed');
    const standing = seededIdentity('lapse-apply/beside/standing');
    const targetOfStanding = seededIdentity('lapse-apply/beside/target-of-standing');
    const unsortedTargetsOfLapsed = [1, 2].map((i) =>
      seededIdentity(`lapse-apply/beside/target-of-lapsed/${i}`).userId);
    const sortedLapsedTargets = [...unsortedTargetsOfLapsed]
      .sort((a, b) => hex(a) < hex(b) ? -1 : 1);
    const [lt1, lt2] = sortedLapsedTargets as [Uint8Array, Uint8Array];

    const view = genesisView({ memberCount: 1 });
    view.putIdentityRecord(lapsedVoucher.userId, lapsedRecord());
    view.putIdentityRecord(standing.userId, identityRecord({
      memberSinceBlock: 2, memberBar: 1, memberVouches: 1,
    }));
    view.putIdentityRecord(targetOfStanding.userId, identityRecord({ memberSinceBlock: 1 }));
    for (const t of sortedLapsedTargets) {
      view.putIdentityRecord(t, identityRecord({ memberSinceBlock: 1 }));
    }
    const lv1 = vouchBox(lapsedVoucher.userId, lt1, 1, 3);
    const lv2 = vouchBox(lapsedVoucher.userId, lt2, 2, 3);
    const memberVouch = vouchBox(standing.userId, targetOfStanding.userId, 3, 3);
    for (const box of [lv1, lv2, memberVouch]) view.insertBox(box);

    const H = 10;
    const memberUnvouch = unvouchTx(standing, memberVouch, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [memberUnvouch], miner.userId, ctx);
    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const settlementTx = decodeSettlement(block);
    expect(settlementTx.inputs).toContain(lv1.id);
    expect(settlementTx.inputs).toContain(lv2.id);
    expect(settlementTx.inputs).not.toContain(memberVouch.id);
  });
});

// ---------------------------------------------------------------------------
// `checkSettlement` — the comparison refuses both wrong settlements
// ---------------------------------------------------------------------------

describe('checkSettlement — the comparison refuses', () => {
  it('a block whose body carries the unvouch and whose settlement still names the spent vouch', () => {
    const voucher = seededIdentity('lapse-wrong/A/voucher');
    const target = seededIdentity('lapse-wrong/A/target');
    const view = genesisView();
    view.putIdentityRecord(voucher.userId, lapsedRecord());
    view.putIdentityRecord(target.userId, identityRecord({ memberSinceBlock: 1 }));
    const vouch = vouchBox(voucher.userId, target.userId, 1, 3);
    view.insertBox(vouch);

    const H = 10;
    const body = unvouchTx(voucher, vouch, ctx.vouchCooldownBlocks, H);

    // The "wrong" settlement: deps whose `getLapsedVouches` returns the full
    // pre-body capture — the vouch the body also spends.
    const wrong = buildSettlement(
      settlementDepsWith(view, ctx, () => [], [], [vouch], () => null, new Set()),
      H,
      ctx.protocolVersionSchedule,
      computeBlockReward(H, ctx),
      ctx.creditMinerRewardDelay,
      emptyBody(),
      miner.userId,
    );
    if ('error' in wrong) throw new Error(wrong.error);

    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: H,
        prevBlockHash: '0'.repeat(64),
        utxoTxRoot: '0'.repeat(64),
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        powNonce: 0,
        powTargetBits: 0,
        createdAt: 0,
        interlinkRoot: '0'.repeat(64),
        adProofsRoot: '0'.repeat(64),
      },
      utxoTxTree: {
        utxoTxIds: [body.txId, computeTxId(wrong.tx)],
        utxoTxs: [encodeTx(body.tx), encodeTx(wrong.tx)],
      },
      validatorSignature: new Uint8Array(64),
    };

    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('settlement consumes 2 boxes, the body derives 1');
  });

  it('a block whose body carries no unvouch and whose settlement omits a listed vouch', () => {
    const voucher = seededIdentity('lapse-wrong/B/voucher');
    const target = seededIdentity('lapse-wrong/B/target');
    const view = genesisView();
    view.putIdentityRecord(voucher.userId, lapsedRecord());
    view.putIdentityRecord(target.userId, identityRecord({ memberSinceBlock: 1 }));
    const vouch = vouchBox(voucher.userId, target.userId, 1, 3);
    view.insertBox(vouch);

    const H = 10;
    // The "wrong" settlement: deps whose `getLapsedVouches` returns no element
    // — the vouch the view's capture holds is omitted.
    const wrong = buildSettlement(
      settlementDepsWith(view, ctx, () => [], [], [], () => null, new Set()),
      H,
      ctx.protocolVersionSchedule,
      computeBlockReward(H, ctx),
      ctx.creditMinerRewardDelay,
      emptyBody(),
      miner.userId,
    );
    if ('error' in wrong) throw new Error(wrong.error);

    const block: OrderingBlock = {
      header: {
        protocolVersion: PROTOCOL_VERSION,
        height: H,
        prevBlockHash: '0'.repeat(64),
        utxoTxRoot: '0'.repeat(64),
        stateRoot: EMPTY_STATE_ROOT,
        validatorId: miner.userId,
        powNonce: 0,
        powTargetBits: 0,
        createdAt: 0,
        interlinkRoot: '0'.repeat(64),
        adProofsRoot: '0'.repeat(64),
      },
      utxoTxTree: {
        utxoTxIds: [computeTxId(wrong.tx)],
        utxoTxs: [encodeTx(wrong.tx)],
      },
      validatorSignature: new Uint8Array(64),
    };

    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('settlement consumes 1 boxes, the body derives 2');
  });
});

// ---------------------------------------------------------------------------
// Over the tree view — the writes agree with the rule
// ---------------------------------------------------------------------------

describe('applyBlock over the tree view — one voucher\'s vouches leave by the body and by the leg', () => {
  it('the voucher\'s cast count and its lapsed entry are each removed by one write', () => {
    const voucher = seededIdentity('lapse-tree/voucher');
    const unsorted = [1, 2, 3].map((i) =>
      seededIdentity(`lapse-tree/t/${i}`).userId);
    const sorted = [...unsorted].sort((a, b) => hex(a) < hex(b) ? -1 : 1);
    const [t1, t2, t3] = sorted as [Uint8Array, Uint8Array, Uint8Array];

    const v1 = vouchBox(voucher.userId, t1, 1, 3);
    const v2 = vouchBox(voucher.userId, t2, 2, 3);
    const v3 = vouchBox(voucher.userId, t3, 3, 3);
    // The voucher's record is lapsed; the targets' records exist so
    // `adjustVouchCount` can read them.
    const voucherRecord = lapsedRecord();
    const targetRecord = identityRecord({ memberSinceBlock: 1 });
    const emission = protocolBox('emission', devnet.creditEmissionTotal, 10);
    const pool = protocolBox('karma_pool', 1_000_000n, 11);
    const writes = seedTreeWrites(
      [emission, pool, v1, v2, v3],
      [
        { identityId: voucher.userId, record: voucherRecord },
        { identityId: t1, record: targetRecord },
        { identityId: t2, record: targetRecord },
        { identityId: t3, record: targetRecord },
      ],
      { memberCount: 0 },
    );
    const session = mapSessionFrom(writes);
    const view = treeStateView(session);

    const H = 20;
    const body = unvouchTx(voucher, v2, ctx.vouchCooldownBlocks, H);
    const block = candidateBlock(view, H, [body], miner.userId, ctx);
    const result = applyBlock(view, block, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const treeWrites = treeWritesOf(result.effects, H, view);
    const atCastCount = treeWrites.filter((w) => equalBytes(w.key, castCountKey(voucher.userId)));
    const atLapsed = treeWrites.filter((w) => equalBytes(w.key, lapsedKey(voucher.userId)));
    expect(atCastCount.map((w) => w.tag)).toEqual(['Remove']);
    expect(atLapsed.map((w) => w.tag)).toEqual(['Remove']);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The decoded settlement transaction a block carries at its last entry. */
function decodeSettlement(block: OrderingBlock): UtxoTransaction {
  const bytes = block.utxoTxTree.utxoTxs.at(-1)!;
  return decodeTx(bytes);
}
