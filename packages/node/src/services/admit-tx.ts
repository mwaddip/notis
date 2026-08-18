import { encodeTx } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { bidOf, entryByteCost, insertUtxoTx } from '../store/mempool.js';
import { config } from '../config.js';
import { ClientError } from './client-error.js';

/**
 * Thrown when a credit transaction's fee rate is beneath this node's floor.
 *
 * A `ClientError`, because refusing to relay a transaction that pays too
 * little is an intentional policy answer rather than a fault — and 402,
 * because the request is well formed and the thing it lacks is payment.
 */
export class FeeBelowFloorError extends ClientError {
  constructor(
    public readonly fee: bigint,
    public readonly bytes: number,
    public readonly floor: bigint,
  ) {
    super(
      `Fee rate below this node's floor: ${fee} over ${bytes} in-block bytes, ` +
      `floor ${floor} per in-block byte`,
      402,
    );
    this.name = 'FeeBelowFloorError';
  }
}

/**
 * Admission: this node's relay policy, then the pool.
 *
 * ⛔ **The floor lives here and must never move into `insertUtxoTx`.**
 * `fork-resolution` re-inserts transactions the chain has already accepted
 * after a reorg, and it reaches the store directly. A floor applied inside the
 * store cannot tell that caller from a submitter, so raising it — which is
 * exactly what an operator does under load — would permanently drop confirmed
 * history on the next reorg. A seam above the store can tell them apart; the
 * store cannot (MEMPOOL_INTERFACE → Fee floor).
 *
 * **Policy, not consensus.** A zero-fee transaction is valid and a miner may
 * mine one (NODE_INTERFACE → `validateTx`); the floor only decides what this
 * node is willing to hold and relay, and two nodes may answer differently
 * without either being wrong. That is why it reads an environment variable at
 * all, which no consensus value in this package does.
 *
 * `validateTx` is deliberately **not** folded in here. Every caller already
 * runs it against its own dependency set and turns a failure into its own
 * error — the invite routes' differs from the like routes', which differ from
 * the gossip relay's — and collapsing those contracts into one would be a
 * change to satisfy a signature rather than a rule.
 */
export function admitTx(tx: UtxoTransaction, expiresAtHeight: number): number {
  const floor = config.minFeeRatePerByte;
  if (floor > 0n) {
    const fee = bidOf(tx);
    // `null` is karma-side, which bids nothing by nature and is never measured
    // against a price. Charging it the floor would close the network to posts
    // and likes the moment an operator raised one.
    if (fee !== null) {
      // The in-block cost, not the bare encoding: the floor prices the block
      // budget a transaction competes for, and `entryByteCost` is the same
      // number the creator spends against it.
      const bytes = entryByteCost(encodeTx(tx));
      // `fee / bytes >= floor`, without the division.
      if (fee < floor * BigInt(bytes)) {
        throw new FeeBelowFloorError(fee, bytes, floor);
      }
    }
  }
  return insertUtxoTx(tx, expiresAtHeight);
}
