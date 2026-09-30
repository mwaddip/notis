import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAX_BLOCK_COST, PROTOCOL_VERSION, W_SIG, bytesToHex, computeTxId, encodeTx } from '@dagsocial/types';
import type { OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import {
  blockBudgetSeam,
  liveProver,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
  uid,
  uidHex,
} from '../helpers.js';

/**
 * The block's cost (CONSENSUS_INTERFACE → The block's cost; NODE_INTERFACE →
 * The block proof): counted while the block executes and checked once its
 * writes are derived, before they are performed. Apply refuses a block over the
 * budget like any rule's refusal; the speculation answers `over-budget` with
 * the body's cost and puts the prover back as it found it. The budget is lowered
 * through `blockBudgetSeam`, never through `types`' constant.
 */

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

/** A sender holding two credit boxes in the store, ahead of the tree built over it. */
async function seededSender() {
  const utxo = await import('../../src/store/utxo.js');
  const sender = makeTestIdentity();
  const boxes = [makeCreditBox(100_000n, sender.userId, 0, 1), makeCreditBox(50_000n, sender.userId, 0, 2)];
  for (const box of boxes) utxo.insertBox(box);
  return { sender, boxes };
}

/** The block's cost as the rules count it over the live tree, read unrecorded. */
async function costOf(block: OrderingBlock): Promise<number> {
  const { applyBlock, blockCost, treeStateView, treeWritesOf } = await import('@dagsocial/consensus');
  const { proverSession } = await import('../../src/state/prover-session.js');
  const { applyContextFrom } = await import('../../src/services/block-apply.js');
  const { config } = await import('../../src/config.js');
  const handle = await liveProver();
  const view = treeStateView(proverSession(handle.prover));
  const result = applyBlock(view, block, applyContextFrom(config));
  if (!result.ok) throw new Error(result.reason);
  const writes = treeWritesOf(result.effects, block.header.height, view);
  return blockCost({ signatures: result.effects.signatures, lookups: view.lookupCount(), writes: writes.length });
}

describe('the block\'s cost', () => {
  let budget: { set(budget: number): void };

  beforeEach(() => {
    vi.resetModules();
    budget = blockBudgetSeam();
  });
  afterEach(() => {
    vi.doUnmock('@dagsocial/consensus');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a block over the budget is refused at apply as a consensus rejection, before its writes; one at the budget applies', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const block = await makeApplicableBlock({
      utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n), makeCreditTx(sender, [boxes[1]!], 5_000n)],
    });
    const cost = await costOf(block);
    const digest = bytesToHex(handle.prover.digest());
    const { applyOrderingBlockVerdict } = await import('../../src/services/block-apply.js');
    const { getCurrentHeight } = await import('../../src/store/ordering.js');
    const writes = vi.spyOn(handle.prover, 'performOneOperation');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    budget.set(cost - 1);
    expect(applyOrderingBlockVerdict(block)).toEqual({ applied: false, class: 'consensus' });
    expect(warn.mock.calls.map((call) => String(call[0])))
      .toContain(`Rejected block height=1: cost ${cost} over the budget ${cost - 1}`);
    expect(writes).not.toHaveBeenCalled();
    expect(getCurrentHeight()).toBe(0);
    expect(bytesToHex(handle.prover.digest())).toBe(digest);

    budget.set(cost);
    expect(applyOrderingBlockVerdict(block)).toEqual({ applied: true });
    expect(getCurrentHeight()).toBe(1);
  });

  it('the speculation answers over budget with the body\'s cost, and leaves the prover as it found it', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const block = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const cost = await costOf(block);
    const { computePostBlockStateRoot } = await import('../../src/services/block-apply.js');
    const within = computePostBlockStateRoot(block, handle);
    if (within.kind !== 'computed') throw new Error(`the speculation answered ${within.kind}`);

    const inner = handle.prover.prover;
    const root = inner.root;
    const height = inner.height;
    const update = vi.spyOn(handle.storage, 'update');
    const rollback = vi.spyOn(handle.storage, 'rollback');

    budget.set(cost - 1);
    expect(computePostBlockStateRoot(block, handle)).toEqual({ kind: 'over-budget', cost });
    expect(inner.root).toBe(root);
    expect(inner.height).toBe(height);
    expect(inner.oldTopNode).toBe(root);
    expect(update).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();

    // Nothing of the refused run is left to prove: the block speculated again
    // within the budget proves what it proved before.
    budget.set(cost);
    const again = computePostBlockStateRoot(block, handle);
    if (again.kind !== 'computed') throw new Error(`the speculation answered ${again.kind}`);
    expect(again.proof).toEqual(within.proof);
  });

  it('a body whose signatures alone cost more than a block may is over budget, not a body the rules rejected', async () => {
    await freshStore();
    const handle = await liveProver();
    const { applyContextFrom, computePostBlockStateRoot } = await import('../../src/services/block-apply.js');
    const { config } = await import('../../src/config.js');
    const { applyBlock, buildBlockSettlement, treeStateView } = await import('@dagsocial/consensus');
    const { proverSession } = await import('../../src/state/prover-session.js');
    const ctx = applyContextFrom(config);

    // One signature more than the budget holds, each a well-formed transaction
    // `applyBlock` counts before it resolves a single input.
    const signatures = MAX_BLOCK_COST / W_SIG + 1;
    const txs: UtxoTransaction[] = Array.from({ length: signatures }, (_, i) => {
      const owner = uid(`block-cost/signer-${i}`);
      return {
        inputs: [uidHex(`block-cost/input-${i}`)],
        outputs: [{ boxType: 'credit', value: 1n, createdAtBlock: 0, owner }],
        signatures: { [bytesToHex(owner)]: new Uint8Array(64) },
        protocolVersion: PROTOCOL_VERSION,
      } as UtxoTransaction;
    });
    const miner = makeTestIdentity();
    const settled = buildBlockSettlement(treeStateView(proverSession(handle.prover)), [], 1, miner.userId, miner.userId, ctx);
    if ('error' in settled) throw new Error(settled.error);
    const body = [...txs, settled.tx];
    const candidate = {
      header: { height: 1, validatorId: miner.userId },
      utxoTxTree: { utxoTxIds: body.map((tx) => computeTxId(tx)), utxoTxs: body.map((tx) => encodeTx(tx)) },
      validatorSignature: new Uint8Array(64),
    } as unknown as OrderingBlock;

    // The rules refuse it for its signatures, before the batch runs.
    const refused = applyBlock(treeStateView(proverSession(handle.prover)), candidate, ctx);
    expect(refused).toEqual({
      ok: false,
      reason: `Rejected block height=1: its ${signatures} signatures cost more than a block may`,
    });

    const root = handle.prover.prover.root;
    expect(computePostBlockStateRoot(candidate, handle)).toEqual({ kind: 'over-budget', cost: signatures * W_SIG });
    expect(handle.prover.prover.root).toBe(root);
  });
});
