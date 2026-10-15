import { checkBlockCost } from '@dagsocial/consensus';
import type { UtxoResult } from '@dagsocial/consensus';
import { encodeTx, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { bidOf, entryByteCost, insertUtxoTx } from '../store/mempool.js';
import { config } from '../config.js';
import { ClientError } from './client-error.js';
import { costAlone, marginalCost } from './cost-estimate.js';

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
 * Thrown when a rent transaction reaches the pool path.
 *
 * A `ClientError` at 403: the transaction is well formed and valid
 * consensus, but this node refuses to relay it — collection is the block
 * producer's (MEMPOOL_INTERFACE → Storage rent is refused at admission).
 */
export class RentRefusedError extends ClientError {
  constructor() {
    super('Rent transactions are not accepted for relay', 403);
    this.name = 'RentRefusedError';
  }
}

/**
 * Thrown when the block carrying a transaction alone costs more than a block
 * may (MEMPOOL_INTERFACE → The cost gate); the message names the cost.
 *
 * A `ClientError` at 413, as an over-size transaction is: the request is well
 * formed, and no block can carry it.
 */
export class TxOverBlockBudgetError extends ClientError {
  constructor(public readonly reason: string) {
    super(`A block carrying this transaction alone is over the budget: ${reason} — no block can carry it`, 413);
    this.name = 'TxOverBlockBudgetError';
  }
}

/**
 * Admission: this node's relay policy and the cost gate, then the pool.
 *
 * ⛔ **The floor and the cost gate live here and must never move into
 * `insertUtxoTx`.** `fork-resolution` re-inserts transactions the chain has
 * already accepted after a reorg, and it reaches the store directly. A check
 * applied inside the store cannot tell that caller from a submitter, so raising
 * the floor — which is exactly what an operator does under load — would
 * permanently drop confirmed history on the next reorg. A seam above the store
 * can tell them apart; the store cannot (MEMPOOL_INTERFACE → Fee floor;
 * MEMPOOL_INTERFACE → The cost gate).
 *
 * **The floor is policy, not consensus.** A zero-fee transaction is valid and a
 * miner may mine one (NODE_INTERFACE → `validateTx`); the floor only decides
 * what this node is willing to hold and relay, and two nodes may answer
 * differently without either being wrong. That is why it reads an environment
 * variable at all, which no consensus value in this package does. **The cost
 * gate reads the budget, which is consensus**: a transaction whose block alone
 * is over it — `checkBlockCost`'s verdict, or `applyBlock`'s own pre-batch
 * refusal on the signatures alone (`costAlone`'s `overBudget` arm) — is one no
 * block can carry, and it would sit in the pool, trimmed from every template,
 * until it expired. A transaction with no block alone to cost is not the
 * gate's to refuse (`costAlone`'s `null` arm): it is admitted, and its row
 * carries no estimate.
 *
 * **The gate keeps what it measured**: the row carries the transaction's
 * marginal cost — its block alone less the empty block at the same tip — the
 * estimate the creator packs by (MEMPOOL_INTERFACE → The cost gate).
 *
 * `validateTx` is deliberately **not** folded in here. The seam above
 * — `admitWriteTx` — folds `validateTx`, the expiry and this function into
 * one call every write route but `POST /posts` takes
 * (NODE_INTERFACE → Service Layer Architecture → "One function admits"), and
 * `POST /posts` and the gossip relay pool the transaction alongside its
 * pending row in one store transaction. This function stays the seam above
 * the store that the reorg path does not take, so a floor an operator raises
 * never drops confirmed history.
 */
export function admitTx(tx: UtxoTransaction, expiresAtHeight: number): number {
  // MEMPOOL_INTERFACE → Storage rent is refused at admission.
  // Every caller runs `validateTx` first; an unsigned transaction that passed
  // authorization is a rent collection — the biconditional (NODE_INTERFACE →
  // "Storage rent is a transition requiring no signature").
  if (Object.keys(tx.signatures).length === 0) {
    throw new RentRefusedError();
  }

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

  // MEMPOOL_INTERFACE → The cost gate.
  const alone = costAlone(tx, 'admitTx');
  if (alone === null) return insertUtxoTx(tx, expiresAtHeight);
  // The block alone is refused for its signatures alone, before its cost is
  // counted — `applyBlock`'s own refusal, named (MEMPOOL_INTERFACE → The cost
  // gate). No block can carry this transaction any more than one over
  // `checkBlockCost` below could.
  if ('overBudget' in alone) throw new TxOverBlockBudgetError(alone.reason);
  const overBudget = checkBlockCost(alone);
  if (overBudget !== null) throw new TxOverBlockBudgetError(overBudget);

  return insertUtxoTx(tx, expiresAtHeight, marginalCost(alone, 'admitTx'));
}

/**
 * The one function every write route but `POST /posts` calls — the seam that
 * folds `validateTx` at `tip + 1`, the pool entry's expiry at
 * `tip + 1 + MEMPOOL_EXPIRY_BLOCKS` and `admitTx` into one call
 * (NODE_INTERFACE → Service Layer Architecture → "One function admits").
 *
 * The caller passes its own validation — a service wraps `validateTx(deps, …)`
 * so its engine dependencies ride the closure, a route hands `deps.validateTx`
 * — and the words a refusal opens with: a non-empty `openingWords` prefixes
 * the verdict's `error` (`Invalid like transaction: `, `Invalid credit
 * transfer: `, and so on), and the two routes whose body is
 * `{ error: <message> }` through `respondError`'s `message` shape pass `''`,
 * so the message reaches that body unchanged.
 *
 * `POST /posts` and the gossip relay pool a transaction alongside its pending
 * row in one store transaction (NODE_INTERFACE → Post transactions), so they
 * run the three around that transaction themselves and this seam is not
 * theirs.
 */
export function admitWriteTx(
  validate: (tx: UtxoTransaction, currentBlockHeight: number) => UtxoResult,
  tx: UtxoTransaction,
  currentBlockHeight: number,
  openingWords: string,
): { txId: string; expiresAtHeight: number } {
  const result = validate(tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`${openingWords}${result.error ?? ''}`);
  }
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);
  return { txId: result.txId!, expiresAtHeight };
}
