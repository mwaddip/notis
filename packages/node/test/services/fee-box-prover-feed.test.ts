import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AnyBox, OrderingBlock } from '@dagsocial/types';
import type { BlockJournal, BoxMutation } from '../../src/store/journal.js';
import {
  feeBoxOf,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
  activateProverOverStore,
} from '../helpers.js';

/**
 * The fee box never reaches the prover (MINING_INTERFACE → Coinbase
 * Application; NODE_INTERFACE → the prover feed derivation).
 *
 * ⛔ **This is the one claim the whole fee-box design rests on, and a root
 * comparison cannot check it.** A fee box is created by a credit-side
 * transaction and consumed by the same block's application, so
 * `proverFeedFromJournal` cancels the insert/remove pair and neither operation
 * is presented to the AVL tree. Feeding the pair through instead would leave
 * the *same* digest — an insert followed by a remove of one key returns the
 * tree to where it started — so the two hypotheses are indistinguishable
 * everywhere downstream. The feed is the only place they differ.
 *
 * The file is its own because it mocks `state/avl-prover.js`: the mock survives
 * `vi.resetModules()` within a file, so a suite sharing it would run its later
 * tests against a wrapped prover.
 */

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    closeDb: () => void;
  };
}

async function importUtxo() {
  return (await import('../../src/store/utxo.js')) as unknown as {
    insertBox: (box: unknown) => void;
    getUnspentBoxes: () => AnyBox[];
    getCreditBoxes: (owner: Uint8Array) => AnyBox[];
  };
}

describe('the fee box never reaches the prover', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    vi.doUnmock('../../src/state/avl-prover.js');
    try { (await importDb()).closeDb(); } catch { /* never opened */ }
    vi.resetModules();
  });

  it('feeds the prover no fee box id, having journalled both halves of the pair', async () => {
    // Every feed the prover is handed while this block is processed. There is
    // more than one: the header's `stateRoot` comes from a speculative run that
    // derives its feed the same way, and the claim has to hold for both — a
    // creator and an applier disagreeing about the feed is the fork this
    // netting rule exists inside.
    const feeds: Array<{ consumed: string[]; created: AnyBox[] }> = [];
    vi.doMock('../../src/state/avl-prover.js', async () => {
      // Real apart from the one wrapped export, so the singleton
      // `tryGetAvlProver` hands block-apply is the one activated below.
      const actual = await vi.importActual<
        typeof import('../../src/state/avl-prover.js')
      >('../../src/state/avl-prover.js');
      return {
        ...actual,
        applyBlockMutations: (
          prover: Parameters<typeof actual.applyBlockMutations>[0],
          height: Parameters<typeof actual.applyBlockMutations>[1],
          consumed: string[],
          created: AnyBox[],
          recordPuts: Parameters<typeof actual.applyBlockMutations>[4],
        ) => {
          feeds.push({ consumed: [...consumed], created: [...created] });
          return actual.applyBlockMutations(prover, height, consumed, created, recordPuts);
        },
      };
    });

    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const sender = makeTestIdentity();
    const miner = makeTestIdentity();
    const box = makeCreditBox(1000n, sender.userId, 0, 1);
    utxo.insertBox(box);

    await activateProverOverStore();
    const avl = await import('../../src/state/avl-prover.js');
    expect(avl.tryGetAvlProver()).not.toBeNull();

    const blockApply = (await import('../../src/services/block-apply.js')) as unknown as {
      applyOrderingBlock: (block: OrderingBlock) => boolean;
    };
    const journalStore = (await import('../../src/store/journal.js')) as {
      getBlockJournal: (height: number) => BlockJournal | null;
    };

    const tx = makeCreditTx(sender, [box], 100n);
    const feeBox = feeBoxOf(tx)!;
    expect(feeBox.boxType).toBe('fee');

    const block = await makeApplicableBlock({ miner, utxoTxs: [tx] });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    // Non-vacuity: without the pair actually recorded, "no fee box id in the
    // feed" would pass on a fee box that was never created at all.
    const journal = journalStore.getBlockJournal(1)!;
    const boxOps = journal.mutations.filter(
      (m): m is BoxMutation => m.kind === 'box' && m.boxId === feeBox.id,
    );
    expect(boxOps.map((m) => m.op)).toEqual(['insert', 'remove']);

    // ...and no feed carries either half.
    expect(feeds.length).toBeGreaterThan(0);
    for (const feed of feeds) {
      expect(feed.consumed).not.toContain(feeBox.id);
      expect(feed.created.map((b) => b.id)).not.toContain(feeBox.id);
    }

    // The value went to the miner regardless, so the box really was a fee and
    // not simply absent from the block.
    expect(utxo.getCreditBoxes(miner.userId)[0]!.value).toBeGreaterThan(0n);
  });
});
