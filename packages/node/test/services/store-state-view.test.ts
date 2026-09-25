import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decayCfgFor } from '@dagsocial/types';
import type { LikeAccrualBox, VouchBox } from '@dagsocial/types';
import { makePostCommit, seedProvenance, uid } from '../helpers.js';

/**
 * The store's `StateView` (CONSENSUS_INTERFACE → StateView): each read the
 * store's own query, its order and its limit included — the two list reads the
 * store holds for the view alone, a post's standing over its row, the
 * topology author as bytes — and the `ApplyContext` a node hands the rules,
 * which is its profile's numbers (CONSENSUS_INTERFACE → ApplyContext).
 */

const [voucher, target, other, author, stranger] =
  ['view/voucher', 'view/target', 'view/other', 'view/author', 'view/stranger'].map(uid) as [
    Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array,
  ];

function vouch(from: Uint8Array, to: Uint8Array, nonce: number): VouchBox {
  return seedProvenance<VouchBox>({ boxType: 'vouch', value: 1n, createdAtBlock: 1, voucherId: from, targetId: to }, 1, nonce);
}

function accrual(to: Uint8Array, nonce: number): LikeAccrualBox {
  return seedProvenance<LikeAccrualBox>({ boxType: 'like_accrual', value: 1n, createdAtBlock: 1, author: to }, 1, nonce);
}

const idsOf = (boxes: Array<{ id?: string }>): string[] => boxes.map((b) => b.id!);

async function openStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  return {
    db,
    utxo: await import('../../src/store/utxo.js'),
    vouches: await import('../../src/store/vouch-queries.js'),
    posts: await import('../../src/store/posts.js'),
    topology: await import('../../src/store/topology.js'),
    blockApply: await import('../../src/services/block-apply.js'),
  };
}

describe('the store\'s StateView', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    (await import('../../src/store/db.js')).closeDb();
    vi.resetModules();
  });

  it('a pair\'s vouch boxes: every live one for that pair, ascending id', async () => {
    const s = await openStore();
    const pair = [vouch(voucher, target, 1), vouch(voucher, target, 2), vouch(voucher, target, 3), vouch(voucher, target, 4)];
    for (const box of [...pair, vouch(voucher, other, 5), vouch(target, voucher, 6)]) s.utxo.insertBox(box);
    const spent = pair[2]!;
    s.utxo.consumeBox(spent.id!, 2);

    const expected = idsOf(pair).filter((id) => id !== spent.id).sort();
    const listed = s.blockApply.storeStateView.getVouchBoxes(voucher, target);
    expect(idsOf(listed)).toEqual(expected);
    expect(listed).toEqual(expected.map((id) => s.utxo.getBox(id)));
    expect(s.blockApply.storeStateView.getVouchBoxes(target, other)).toEqual([]);
    // The single-box read is the list's first.
    expect(s.vouches.getVouchBox(voucher, target)).toEqual(listed[0]);
    expect(s.vouches.getVouchBox(stranger, target)).toBeNull();
  });

  it('an author\'s like-accrual boxes: every live one naming the author, ascending id', async () => {
    const s = await openStore();
    const named = [accrual(author, 1), accrual(author, 2), accrual(author, 3)];
    for (const box of [...named, accrual(stranger, 4)]) s.utxo.insertBox(box);
    const spent = named[0]!;
    s.utxo.consumeBox(spent.id!, 2);

    const expected = idsOf(named).filter((id) => id !== spent.id).sort();
    const listed = s.blockApply.storeStateView.getLikeAccrualBoxes(author);
    expect(idsOf(listed)).toEqual(expected);
    expect(listed).toEqual(expected.map((id) => s.utxo.getBox(id)));
    // The carry lookup is the list's first box its caller does not exclude.
    expect(s.utxo.getLikeCarryBox(author, new Set())).toEqual(listed[0]);
    expect(s.utxo.getLikeCarryBox(author, new Set([expected[0]!]))).toEqual(listed[1]);
    expect(s.utxo.getLikeCarryBox(author, new Set(expected))).toBeNull();
  });

  it('a post\'s standing: none without a row, live for a pending or confirmed row, withdrawn once withdrawn', async () => {
    const s = await openStore();
    const view = s.blockApply.storeStateView;
    const [pending, confirmed, withdrawn] = ['aa', 'bb', 'cc'].map((c) => c.repeat(32)) as [string, string, string];
    for (const [id, text] of [[pending, 'pending'], [confirmed, 'confirmed'], [withdrawn, 'withdrawn']] as const) {
      s.posts.insertPost(id, makePostCommit(author, text), text);
    }
    s.posts.confirmPost(confirmed, 1, 0);
    s.posts.confirmPost(withdrawn, 1, 1);
    s.posts.withdrawPost(withdrawn, 2);

    expect(view.getPostStanding('dd'.repeat(32))).toBe('none');
    expect(view.getPostStanding(pending)).toBe('live');
    expect(view.getPostStanding(confirmed)).toBe('live');
    expect(view.getPostStanding(withdrawn)).toBe('withdrawn');
  });

  it('a post\'s author is the topology row\'s, as bytes', async () => {
    const s = await openStore();
    s.topology.insertBlockTopology('ee'.repeat(32), [], Buffer.from(author).toString('hex'), 3);
    const read = s.blockApply.storeStateView.getTopologyAuthor('ee'.repeat(32));
    expect(read).toEqual(author);
    expect(Object.getPrototypeOf(read)).toBe(Uint8Array.prototype);
    expect(s.blockApply.storeStateView.getTopologyHeight('ee'.repeat(32))).toBe(3);
    expect(s.blockApply.storeStateView.getTopologyAuthor('ff'.repeat(32))).toBeNull();
  });

  it('the ApplyContext a node hands the rules is its profile\'s numbers', async () => {
    const { applyContextFrom } = await import('../../src/services/block-apply.js');
    const { config } = await import('../../src/config.js');
    const profile = config.profile;
    expect(applyContextFrom(config)).toEqual({
      protocolVersionSchedule: profile.protocolVersionSchedule,
      vouchCooldownBlocks: profile.vouchCooldownBlocks,
      inviteBondMin: profile.inviteBondMin,
      inviteBondMax: profile.inviteBondMax,
      inviteProbationBlocks: profile.inviteProbationBlocks,
      decayCfg: decayCfgFor(profile),
      storageRentPeriodBlocks: profile.storageRentPeriodBlocks,
      membershipBarMultiplier: profile.membershipBarMultiplier,
      backerSupply: profile.backerSupply,
      creditFixedRateBlocks: profile.creditFixedRateBlocks,
      creditEpochBlocks: profile.creditEpochBlocks,
      creditMinerRewardDelay: profile.creditMinerRewardDelay,
    });
  });
});
