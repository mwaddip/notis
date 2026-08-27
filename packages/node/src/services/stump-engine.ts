import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  getCurrentHeight,
  getTopologyHeight,
} from '../store/index.js';
import { ClientError } from './client-error.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// NODE_INTERFACE → Prune transactions
export function executePrune(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { txId: string } {
  const prune = tx.prune;
  if (!prune) {
    throw new ClientError('Transaction carries no prune payload');
  }

  const currentHeight = getCurrentHeight();
  const rootHeight = getTopologyHeight(prune.rootPostHash);
  if (rootHeight === null || rootHeight >= currentHeight) {
    throw new ClientError('Post is not confirmed in an earlier block');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid prune transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  return { txId: result.txId! };
}
