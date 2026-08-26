import {
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  getCurrentHeight,
  getTopologyHeight,
} from '../store/index.js';
import { getSubtreeTopology } from '../store/topology.js';
import { ClientError } from './client-error.js';
import { validateTx } from './utxo-engine.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the prune-specific rules, run `validateTx` + `admitTx`, and insert
 * the transaction into the mempool.
 *
 * The prune-specific checks run first because they are cheap and give better
 * errors than the generic validation path would for a clearly-doomed prune.
 */
export function executePrune(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { txId: string } {
  const prune = tx.prune;
  if (!prune) {
    throw new ClientError('Transaction carries no prune payload');
  }

  // The root must be confirmed in an earlier block.
  const currentHeight = getCurrentHeight();
  const rootHeight = getTopologyHeight(prune.rootPostHash);
  if (rootHeight === null || rootHeight >= currentHeight) {
    throw new ClientError('Post is not confirmed in an earlier block');
  }

  // subtreePostIds must match the committed topology.
  const topologyIds = getSubtreeTopology(prune.rootPostHash);
  const entryIds = new Set(prune.subtreePostIds);
  if (topologyIds.size !== entryIds.size ||
      ![...topologyIds].every(id => entryIds.has(id))) {
    throw new ClientError('subtreePostIds does not match committed topology');
  }

  // Merkle root must match the postId list.
  const leaves = [...prune.subtreePostIds]
    .sort()
    .map(id => leafHash('stump', hexToBuf(id)));
  const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
  const entryRoot = Buffer.from(prune.subtreeMerkleRoot).toString('hex');
  if (computedRoot !== entryRoot) {
    throw new ClientError('subtreeMerkleRoot does not match postId list');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid prune transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  return { txId: result.txId! };
}
