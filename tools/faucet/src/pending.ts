import type { BoxRef, BuiltTx } from './tx.js';

/**
 * The faucet's own unconfirmed change, held in memory.
 *
 * ⛔ **The node's API exposes only the CONFIRMED box set**, so two submissions
 * inside one block interval would both select the same box and the second is a
 * double spend. The service builds the transaction, so it already holds the
 * change output's derived id and can chain from it.
 *
 * ⚠ **Memory only, and a restart falls back to the confirmed view.** The cost
 * is at most one rejected submission, and correctness never depends on it: the
 * node is the authority and refuses anything stale. ⛔ **This must never be
 * persisted** — a durable pending view is a second source of truth about the
 * chain.
 *
 * ⚠ **Karma only.** A credit transfer has its own box set, and the credit side
 * is not chained: credits are repeatable, so a request refused inside one block
 * interval can simply be made again.
 */
export class PendingChain {
  private tip: BoxRef | null = null;

  /** Boxes to select from: the chain tip if one is held, the confirmed set otherwise. */
  view(confirmed: readonly BoxRef[]): readonly BoxRef[] {
    return this.tip === null ? confirmed : [this.tip];
  }

  /**
   * Record a submitted transaction's change output as the new tip.
   *
   * The id comes from the transaction that was signed, so the tip cannot name a
   * box the block will materialize differently. A transaction that emits no
   * change clears the tip: there is nothing left to chain from.
   */
  advance(built: BuiltTx): void {
    this.tip = built.change;
  }

  /** Drop the tip — the node has refused a submission, so it is not what the node holds. */
  reset(): void {
    this.tip = null;
  }
}
