import type { UtxoTransaction } from '@dagsocial/types';

import { ClientError } from './client-error.js';
import { validateTx } from '@dagsocial/consensus';
import { admitWriteTx } from './admit-tx.js';
import type { UtxoEngineDeps } from '@dagsocial/consensus';

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
 * `consumeBox`/`insertBox` directly — no block, no journal — bypasses
 * consensus entirely: the transfer enters no block, produces no journal
 * entries, never reaches the tree, and the divergence detonates at the next
 * restart-rebuild as a permanent `stateRoot` fork. A
 * server-side builder also has to mirror the client's transaction construction
 * byte-for-byte; taking the client's own transaction means there is no second
 * implementation to keep in step.
 */
export function sendCredits(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): CreditTransferResult {
  // NODE_INTERFACE → Service Layer Architecture → "A write request runs in
  // one order, cheapest first", → "One function admits". The pool's word on
  // the id leads; the caller's checks ride inside `admitWriteTx` so a held
  // transaction never reaches them (MEMPOOL_INTERFACE → getHeldEntry).
  const r = admitWriteTx(
    () => {
      // NODE_INTERFACE → Legal box transitions, the `CreditBox | CreditBox(s)
      // and/or FeeBox` row: a credit spend's outputs are credit boxes and at
      // most one fee box, nothing else. This routes other tx kinds to their
      // own endpoints — it is not a consensus rule; those live in `validateTx`
      // below, which refuses an empty output set and a second fee box among
      // them.
      if (tx.outputs.some((o) => o.boxType !== 'credit' && o.boxType !== 'fee')) {
        throw new ClientError('credit transfer outputs must be credit or fee boxes');
      }
    },
    (t, h) => validateTx(deps, t, h),
    tx,
    currentBlockHeight,
    'Invalid credit transfer: ',
  );

  return {
    status: 'pending',
    txId: r.txId,
    expiresAtHeight: r.expiresAtHeight,
    tx: r.tx,
  };
}
