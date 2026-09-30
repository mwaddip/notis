import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BatchAVLVerifier } from '@ergots/avltree';
import { TREE_KEY_LENGTH, bytesToHex, hash32 } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { applyBlock, treeStateView, treeWritesOf, verifierSession } from '@dagsocial/consensus';
import type { ApplyContext, BlockEffects } from '@dagsocial/consensus';
import {
  liveProver,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
} from '../helpers.js';

/**
 * The block proof (NODE_INTERFACE → The block proof; CONSENSUS_INTERFACE → The
 * block proof): block application and the speculative run read through a
 * recording session, so the proof the prover makes for a block covers the
 * block's reads, then its writes — the same list on the producer and on every
 * node that applies it, and one a verifier replays from the parent's digest.
 */

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

async function blockApply() {
  return import('../../src/services/block-apply.js');
}

/** The rules' context as block application builds it. */
async function nodeCtx(): Promise<ApplyContext> {
  const { applyContextFrom } = await blockApply();
  const { config } = await import('../../src/config.js');
  return applyContextFrom(config);
}

/** A sender holding two credit boxes in the store, ahead of the tree built over it. */
async function seededSender() {
  const utxo = await import('../../src/store/utxo.js');
  const sender = makeTestIdentity();
  const boxes = [makeCreditBox(100_000n, sender.userId, 0, 1), makeCreditBox(50_000n, sender.userId, 0, 2)];
  for (const box of boxes) utxo.insertBox(box);
  return { sender, boxes };
}

/**
 * The block run from its parent's digest and a proof alone
 * (CONSENSUS_INTERFACE → The tree session): the rules over `verifierSession`,
 * the writes derived over the same view and performed on the verifier.
 */
function replay(
  parent: Uint8Array,
  proof: Uint8Array,
  block: OrderingBlock,
  ctx: ApplyContext,
): { effects: BlockEffects; digest: string } {
  const verifier = new BatchAVLVerifier(parent, proof, { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null });
  const view = treeStateView(verifierSession(verifier));
  const result = applyBlock(view, block, ctx);
  if (!result.ok) throw new Error(`the replay refused the block: ${result.reason}`);
  for (const write of treeWritesOf(result.effects, block.header.height, view)) {
    if (!verifier.performOneOperation(write).success) {
      throw new Error(`the proof refuses ${write.tag} of ${bytesToHex(write.key)}: ${verifier.getLastFailReason()}`);
    }
  }
  const digest = verifier.digest();
  if (digest === null) throw new Error(`the verifier is poisoned: ${verifier.getLastFailReason()}`);
  return { effects: result.effects, digest: bytesToHex(digest) };
}

describe('the block proof', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('the speculation answers the block\'s proof beside its stateRoot — adProofsRoot its hash32 — and a verifier replays it from the parent\'s digest to that root', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const parent = handle.prover.digest();
    const block = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const { computePostBlockStateRoot } = await blockApply();

    const speculation = computePostBlockStateRoot(block, handle);

    expect(speculation.kind).toBe('computed');
    if (speculation.kind !== 'computed') return;
    expect(speculation.stateRoot).toBe(block.header.stateRoot);
    expect(speculation.proof).toBeInstanceOf(Uint8Array);
    expect(speculation.adProofsRoot).toBe(bytesToHex(hash32(speculation.proof)));
    const ctx = await nodeCtx();
    const replayed = replay(parent, speculation.proof, block, ctx);
    expect(replayed.digest).toBe(block.header.stateRoot);
    // The same effects the rules answer over the prover itself.
    const { proverSession } = await import('../../src/state/prover-session.js');
    const overProver = applyBlock(treeStateView(proverSession(handle.prover)), block, ctx);
    expect(overProver.ok).toBe(true);
    if (overProver.ok) expect(replayed.effects).toEqual(overProver.effects);
  });

  it('the checkpoint apply makes proves exactly what the speculation proved', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const block = await makeApplicableBlock({
      utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n), makeCreditTx(sender, [boxes[1]!], 5_000n)],
    });
    const { computePostBlockStateRoot, applyOrderingBlock } = await blockApply();
    const speculation = computePostBlockStateRoot(block, handle);
    if (speculation.kind !== 'computed') throw new Error(`the speculation answered ${speculation.kind}`);

    const checkpoint = vi.spyOn(handle.prover, 'generateProofAndUpdateStorage');
    expect(applyOrderingBlock(block)).toBe(true);

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.results[0]!.value).toEqual(speculation.proof);
  });

  it('a block the funnel refuses leaves none of its recorded reads in the prover\'s proof cycle', async () => {
    await freshStore();
    const { sender, boxes } = await seededSender();
    const handle = await liveProver();
    const good = await makeApplicableBlock({ utxoTxs: [makeCreditTx(sender, [boxes[0]!], 10_000n)] });
    const { computePostBlockStateRoot, applyOrderingBlockVerdict } = await blockApply();
    const before = computePostBlockStateRoot(good, handle);
    if (before.kind !== 'computed') throw new Error(`the speculation answered ${before.kind}`);
    expect(before.proof).toBeInstanceOf(Uint8Array);

    // A body the rules refuse after reading the tree: it spends a box the tree
    // does not hold, which the rules read before they refuse it.
    const stranger = makeTestIdentity();
    const unseeded = makeCreditBox(7_000n, stranger.userId, 0, 99);
    const refused = await makeApplicableBlock({ utxoTxs: [makeCreditTx(stranger, [unseeded], 1_000n)] });
    expect(applyOrderingBlockVerdict(refused)).toEqual({ applied: false, class: 'consensus' });

    const after = computePostBlockStateRoot(good, handle);
    if (after.kind !== 'computed') throw new Error(`the speculation answered ${after.kind}`);
    expect(after.proof).toEqual(before.proof);
  });
});
