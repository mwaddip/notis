// WEB_INTERFACE → The wallet → "The reader's spends run one at a time, per ledger"
// and → "A press waiting its turn belongs to the key and the node it was made under".
//
// A small queue: one flow at a time runs; the next flow waits until the one
// ahead has its answer — an answer, a thrown transport failure, or `notSigned`.
// `isActive` is read at the turn (not at enqueue), so a node or identity
// change moving the generation between press and turn ends the waiting press:
// its turn runs nothing, the queue returns `'cancelled'`, and the pump moves
// to the next. A thrown `run` releases its slot and never stops the pump.
// No timer.

export class FlowQueue {
  private pending: Array<() => Promise<void>> = [];
  private running = false;

  /** Enqueue a flow; answer the flow's result, `'cancelled'` when the turn's
   *  `isActive()` returns false, or re-throw when the flow itself throws. */
  enqueue<T>(run: () => Promise<T>, isActive: () => boolean): Promise<T | 'cancelled'> {
    return new Promise<T | 'cancelled'>((resolve, reject) => {
      this.pending.push(async () => {
        if (!isActive()) { resolve('cancelled'); return; }
        try {
          resolve(await run());
        } catch (e) {
          reject(e);
        }
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.pending.length > 0) {
      // Each queued item settles its own outer promise and never throws out
      // of here: `enqueue` wraps the `run` in try/catch and routes a throw to
      // `reject`. The pump moves on regardless of the outer promise's fate,
      // which is the rule that a failure never stops the queue.
      await this.pending.shift()!();
    }
    this.running = false;
  }
}
