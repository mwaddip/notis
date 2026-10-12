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
 *
 * The view keeps the owner's two karma boxes — the pending change replaces
 * their own box, and the income box is kept unless a pending transaction
 * consumed it (NODE_INTERFACE → Karma transition rules → "An identity holds at
 * most two karma boxes"). The view names one box per id: once the confirmed
 * list holds a box under the tip id, the two are the same box and the tip is
 * dropped. A consumed id is forgotten the first view after the confirmed list
 * no longer lists it, so the chain remembers only what the node still holds.
 */
export class PendingChain {
  private tip: BoxRef | null = null;
  private readonly consumedIds = new Set<string>();

  /**
   * Boxes to select from: the pending change (an unmarked own box) replacing
   * what it chained from, beside the confirmed boxes the pending transactions
   * have not consumed.
   *
   * ⛔ **One id, one box.** The confirmed list is authoritative under its ids:
   * when it holds a box the chain tracks as the tip, that box is the tip, so
   * the tip is dropped and the confirmed one stands. When it no longer holds a
   * consumed id, the chain forgets it: what the node no longer serves does not
   * need filtering, and the set does not grow without bound.
   */
  view(confirmed: readonly BoxRef[]): readonly BoxRef[] {
    for (const id of [...this.consumedIds]) {
      if (!confirmed.some((b) => b.boxId === id)) this.consumedIds.delete(id);
    }
    const tip = this.tip;
    if (tip !== null && confirmed.some((b) => b.boxId === tip.boxId)) {
      this.tip = null;
    }
    const remaining = this.consumedIds.size === 0
      ? confirmed
      : confirmed.filter((b) => !this.consumedIds.has(b.boxId));
    return this.tip === null ? remaining : [this.tip, ...remaining];
  }

  /**
   * Record a submitted transaction's change output as the new tip and its
   * karma inputs as consumed.
   *
   * The ids come from the transaction that was signed, so the tip cannot name
   * a box the block will materialize differently. A transaction that emits no
   * change clears the tip; its karma inputs still bind — the income box a
   * payout outruns is one the owner no longer holds.
   */
  advance(built: BuiltTx): void {
    this.tip = built.change;
    for (const input of built.karmaInputs) this.consumedIds.add(input.boxId);
  }

  /** Drop the tip — the node has refused a submission, so it is not what the node holds. */
  reset(): void {
    this.tip = null;
    this.consumedIds.clear();
  }
}
