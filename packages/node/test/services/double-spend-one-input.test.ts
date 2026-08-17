import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AnyBox, CreditBox, OrderingBlock } from '@dagsocial/types';
import {
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestIdentity,
  activateProverOverStore,
} from '../helpers.js';

/**
 * A block whose two transactions name one input is REJECTED, and the tree is
 * never asked to remove that id twice.
 *
 * ⛔ **This is what keeps `DivergedStateTreeError` off the peer-reachable side
 * of the fail-stop boundary** (NODE_INTERFACE → "What the funnel's totality
 * catch is FOR"), and the mechanism is not local to one file. The journal
 * records a remove per `consumeBox` call, and `proverFeedFromJournal` cancels
 * insert-then-remove pairs but does **not** dedupe repeated removes — so a
 * `consumed` list carrying one id twice would refuse on the second `Remove`.
 *
 * What prevents it is the apply loop's liveness pre-check, which runs against
 * state the loop is itself evolving: once the first transaction's `applyTx`
 * marks the box spent, the second fails `getBox(id) !== null`, is deferred to
 * `remaining`, and is never applied. No pass can make progress on it, so the
 * block is rejected rather than applied with a transaction missing.
 * `consumeBox` is the backstop under that: it refuses a consume of an id no
 * live row holds, so the second remove could not be journalled at all.
 *
 * The assertion is that the boundary is not reached — a root comparison cannot
 * see this, because the block never gets far enough to produce a root.
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
  };
}

describe('PROBE: two txs, one input', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    try { (await importDb()).closeDb(); } catch { /* never opened */ }
    vi.resetModules();
  });

  it('rejects the block and never reaches the fail-stop boundary', async () => {
    const exited: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      throw new Error('process.exit');
    }) as never);

    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const sender = makeTestIdentity();
    const miner = makeTestIdentity();
    const box = makeCreditBox(1000n, sender.userId, 0, 1) as CreditBox;
    utxo.insertBox(box);

    // Live prover over the whole store — so the tree really does hold the box
    // both transactions name.
    const handle = await activateProverOverStore();
    const before = Buffer.from(handle.prover.digest()!).toString('hex');

    // Different fees → different outputs → different txIds, so the block
    // carries two distinct transactions that spend one box.
    const txA = makeCreditTx(sender, [box], 100n);
    const txB = makeCreditTx(sender, [box], 200n);
    expect(txA.inputs).toEqual(txB.inputs);

    const blockApply = (await import('../../src/services/block-apply.js')) as unknown as {
      applyOrderingBlock: (block: OrderingBlock) => boolean;
    };

    const block = await makeApplicableBlock({ miner, utxoTxs: [txA, txB] });
    const applied = blockApply.applyOrderingBlock(block);

    // The measurement: an ordinary rejection, not a halt.
    expect(exited).toEqual([]);
    expect(applied).toBe(false);
    expect(Buffer.from(handle.prover.digest()!).toString('hex')).toBe(before);
  });
});
