import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  getTopologyHeight,
  getPost,
  isStoredPost,
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

  // The maturity bind judges at the prune's block — the same judged-for height
  // validateTx uses, one rule (NODE_INTERFACE → validateTx). The route passes
  // tip + 1.
  const rootHeight = getTopologyHeight(prune.rootPostHash);
  if (rootHeight === null || rootHeight >= currentBlockHeight) {
    throw new ClientError('Post is not confirmed in an earlier block');
  }

  // A root prunes once (NODE_INTERFACE → Prune transactions). Topology keeps a
  // pruned root's row, so the bind above and validateTx's authorship read both
  // hold for a stump or a tombstone — this is the read that refuses them. A
  // withdrawn root keeps its `dag_posts` row and stays prunable.
  if (!isStoredPost(getPost(prune.rootPostHash))) {
    throw new ClientError('Post is already pruned or unknown');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid prune transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  return { txId: result.txId! };
}
