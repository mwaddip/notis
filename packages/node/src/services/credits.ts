import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';

import { ClientError } from './client-error.js';
import { validateTx } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';
import type { UtxoEngineDeps } from './utxo-engine.js';

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface CreditTransferResult {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  /** The pooled transaction, for the route's broadcast. */
  tx: UtxoTransaction;
}

/**
 * Pool a client-built, client-signed credit transfer.
 *
 * Receives a pre-built, signed UtxoTransaction from the client and does what
 * every other tx route does: `validateTx`, then `admitTx`. Credits move at
 * block application on every node, not when the HTTP call returns — signature
 * verification stays inside `validateTx`'s authorization check, and the fee floor
 * inside `admitTx`'s.
 *
 * Building the transfer server-side and applying it with
 * `consumeBox`/`insertBox` directly — no block, no open journal — bypasses
 * consensus entirely (audit F-consensus-7): the transfer enters no block,
 * produces no journal entries, never reaches the AVL feed, and the divergence
 * detonates at the next restart-rebuild as a permanent `stateRoot` fork. A
 * server-side builder also has to mirror the client's transaction construction
 * byte-for-byte; taking the client's own transaction means there is no second
 * implementation to keep in step.
 */
export function sendCredits(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): CreditTransferResult {
  // Shape gate for this route: every output is a CreditBox. The transition arms
  // then pin the inputs to credit boxes too — `credit` sits outside
  // `KARMA_TRANSITION_TYPES` so the karma arm refuses these outputs, the invite
  // and vouch arms admit one karma output or none, and every remaining type is
  // barred from user transactions by authorization (NODE_INTERFACE → "Legal box
  // transitions"). Conservation pins no input type at all: it is one total per
  // side. This routes other tx kinds to their own endpoints — it is not a
  // consensus rule; those live in `validateTx` below.
  if (tx.outputs.length === 0 || tx.outputs.some((o) => o.boxType !== 'credit')) {
    throw new ClientError('credit transfer outputs must all be CreditBoxes');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid credit transfer: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  return {
    status: 'pending',
    txId: result.txId!,
    expiresAtHeight,
    tx,
  };
}
