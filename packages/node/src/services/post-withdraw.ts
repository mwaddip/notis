import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  getCurrentHeight,
  getTopologyHeight,
  getPost,
  isLivePost,
} from '../store/index.js';
import { ClientError } from './client-error.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the withdrawal-specific rules, run `validateTx` + `admitTx`, and
 * insert the transaction into the mempool.
 *
 * The maturity check matches the consensus rule: `getTopologyHeight(postId)`
 * must be strictly less than the current height — the post was confirmed in an
 * earlier block.
 */
export function executePostWithdraw(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { txId: string } {
  const pw = tx.postWithdraw;
  if (!pw) {
    throw new ClientError('Transaction carries no postWithdraw payload');
  }

  const currentHeight = getCurrentHeight();
  const postHeight = getTopologyHeight(pw.postId);
  if (postHeight === null || postHeight >= currentHeight) {
    throw new ClientError('Post is not confirmed in an earlier block');
  }

  const post = getPost(pw.postId);
  if (!isLivePost(post)) {
    throw new ClientError('Post is already withdrawn, pruned or unknown');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid postWithdraw transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  return { txId: result.txId! };
}
