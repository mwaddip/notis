import { availableInvites, checkBlockCost } from '@dagsocial/consensus';
import type { UtxoResult } from '@dagsocial/consensus';
import { computeTxId, decodeTx, encodeTx, membershipBar, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  assertPoolAdmits,
  bidOf,
  countPendingInvites,
  entryByteCost,
  gateMetadata,
  getHeldEntry,
  hasPendingClaim,
  hasPendingClaimBy,
  hasPendingInvitee,
  hasPendingLike,
  hasPendingVouch,
  hasPendingWithdraw,
  insertUtxoTx,
} from '../store/mempool.js';
import { getIdentityRecord, getNetworkRecord } from '../store/index.js';
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
 * Admission: this node's relay policy, the pool's own refusals and the cost
 * gate, in that order (MEMPOOL_INTERFACE → assertPoolAdmits; NODE_INTERFACE
 * → Service Layer Architecture → "A write request runs in one order,
 * cheapest first").
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
export function admitTx(tx: UtxoTransaction, txId: string, expiresAtHeight: number): number {
  // MEMPOOL_INTERFACE → Storage rent is refused at admission.
  // Every caller runs `validateTx` first; an unsigned transaction that passed
  // authorization is a rent collection — the biconditional (NODE_INTERFACE →
  // "Storage rent is a transition requiring no signature").
  if (Object.keys(tx.signatures).length === 0) {
    throw new RentRefusedError();
  }

  // MEMPOOL_INTERFACE → Correctness gates — "Admission runs the gates, on
  // every path". A gate is one indexed query, so it leads the fee floor and
  // the cost gate; a refusal here is the same words and status every write
  // route and the gossip relay answer.
  const meta = gateMetadata(tx);
  if (meta.likeTarget !== null && meta.likeLiker !== null
      && hasPendingLike(meta.likeTarget, meta.likeLiker)) {
    throw new ClientError('Already liked this post', 400);
  }
  if (meta.usernameLower !== null && hasPendingClaim(meta.usernameLower)) {
    throw new ClientError('A pending claim for this name exists', 409);
  }
  if (meta.usernameClaimant !== null && hasPendingClaimBy(meta.usernameClaimant)) {
    throw new ClientError('This identity already has a pending claim', 409);
  }
  if (meta.vouchVoucher !== null && meta.vouchTarget !== null
      && hasPendingVouch(meta.vouchVoucher, meta.vouchTarget)) {
    throw new ClientError('A vouch for this pair is already pending', 400);
  }
  if (meta.inviteInvitee !== null && hasPendingInvitee(meta.inviteInvitee)) {
    throw new ClientError('A pending invite already names this key', 409);
  }
  if (meta.inviteInviter !== null) {
    // A member's pending bonds are capped at `⌊memberVouches / D(N)⌋ −
    // invitesUsed`, because two invites by one member in one block read the
    // record as the first left it (ARCHITECTURE → The invite budget). A root
    // is uncapped; a non-member and a key with no record are `validateTx`'s
    // refusal, named by the invite service for the diagnosis.
    const inviterBytes = new Uint8Array(Buffer.from(meta.inviteInviter, 'hex'));
    const record = getIdentityRecord(inviterBytes);
    const available = availableInvites(
      record,
      () => membershipBar(getNetworkRecord().memberCount, config.membershipBarMultiplier),
    );
    if (typeof available === 'number'
        && countPendingInvites(meta.inviteInviter) >= available) {
      throw new ClientError('Every invite this member has is already pending', 400);
    }
  }
  if (meta.withdrawPost !== null && hasPendingWithdraw(meta.withdrawPost)) {
    throw new ClientError('A withdrawal of this post is already pending', 409);
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

  // MEMPOOL_INTERFACE → assertPoolAdmits: the pool's own conflict and
  // capacity refusals are asked before the cost gate's speculative
  // `applyBlock`, so a transaction the pool would refuse never costs the
  // candidate block.
  assertPoolAdmits(tx);

  // MEMPOOL_INTERFACE → The cost gate.
  const alone = costAlone(tx, txId, 'admitTx');
  if (alone === null) return insertUtxoTx(tx, txId, expiresAtHeight);
  // The block alone is refused for its signatures alone, before its cost is
  // counted — `applyBlock`'s own refusal, named (MEMPOOL_INTERFACE → The cost
  // gate). No block can carry this transaction any more than one over
  // `checkBlockCost` below could.
  if ('overBudget' in alone) throw new TxOverBlockBudgetError(alone.reason);
  const overBudget = checkBlockCost(alone);
  if (overBudget !== null) throw new TxOverBlockBudgetError(overBudget);

  return insertUtxoTx(tx, txId, expiresAtHeight, marginalCost(alone, 'admitTx'));
}

/**
 * The one function every write route but `POST /posts` calls — the seam that
 * folds the pool's word on the id, the caller's own checks, `validateTx` at
 * `tip + 1`, the pool entry's expiry at `tip + 1 + MEMPOOL_EXPIRY_BLOCKS` and
 * `admitTx` into one call, in that order (NODE_INTERFACE → Service Layer
 * Architecture → "A write request runs in one order, cheapest first", → "One
 * function admits").
 *
 * The caller passes its own checks as a `() => void` that throws
 * `ClientError` on refusal, its own validation — a service wraps
 * `validateTx(deps, …)` so its engine dependencies ride the closure, a route
 * hands `deps.validateTx` — and the words a refusal opens with: a non-empty
 * `openingWords` prefixes the verdict's `error` (`Invalid like transaction:
 * `, `Invalid credit transfer: `, and so on), and the two routes whose body
 * is `{ error: <message> }` through `respondError`'s `message` shape pass
 * `''`, so the message reaches that body unchanged.
 *
 * **A transaction the pool already holds is answered as held**
 * (MEMPOOL_INTERFACE → getHeldEntry; NODE_INTERFACE → Service Layer
 * Architecture → "A transaction the pool already holds is answered as held"):
 * the pool's one point read by id leads, and a standing entry ends the path
 * with `held: true`, the pooled entry's own `expiresAtHeight` and the pooled
 * transaction decoded from its stored bytes — no caller check, no
 * `validateTx`, no gate, no floor, no cost gate and no insert runs. The
 * caller builds its answer from the returned `tx`, `txId` and
 * `expiresAtHeight` either way.
 *
 * `POST /posts` and the gossip relay pool a transaction alongside its pending
 * row in one store transaction (NODE_INTERFACE → Post transactions), so they
 * run the lookup first and the rest around that transaction themselves —
 * this seam is not theirs.
 */
export function admitWriteTx(
  checks: () => void,
  validate: (tx: UtxoTransaction, txId: string, currentBlockHeight: number) => UtxoResult,
  tx: UtxoTransaction,
  currentBlockHeight: number,
  openingWords: string,
): { txId: string; expiresAtHeight: number; tx: UtxoTransaction; held: boolean } {
  // The id derives from the transaction's canonical bytes
  // (TYPES_INTERFACE → Layout — UtxoTransaction) — the pool's lookup key.
  // An unencodeable transaction cannot be held or admitted; the encoder's
  // refusal is this layer's, under the caller's `openingWords`.
  let txId: string;
  try {
    txId = computeTxId(tx);
  } catch (err) {
    throw new ClientError(`${openingWords}${(err as Error).message}`);
  }
  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state": the pool's one point read by id leads, and
  // an entry standing ends the path with the pooled bytes decoded.
  const entry = getHeldEntry(txId);
  if (entry !== null) {
    return {
      txId,
      expiresAtHeight: entry.expiresAtHeight,
      tx: decodeTx(entry.txBytes),
      held: true,
    };
  }
  checks();
  const result = validate(tx, txId, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`${openingWords}${result.error ?? ''}`);
  }
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, txId, expiresAtHeight);
  return { txId, expiresAtHeight, tx, held: false };
}
