import {
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  MEMPOOL_EXPIRY_BLOCKS,
  computeTxId,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import {
  getCurrentHeight,
  insertUtxoTx,
  getTopologyHeight,
} from '../store/index.js';
import { getSubtreeTopology } from '../store/topology.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the prune-specific rules a pool admission cannot check and insert
 * the transaction into the mempool.
 *
 * The transaction is a karma→karma self-transfer carrying a `PruneCommit`
 * payload. Its signature over `txId` covers the payload, and `validateTx`'s
 * transition arm verifies that the signer is the root's topology author.
 *
 * What this function adds over bare `insertUtxoTx`:
 *  - The root must be confirmed in an **earlier** block (the maturity bind,
 *    matching §8c's consensus check)
 *  - subtreePostIds must match the committed topology
 *  - The Merkle root must match the postId list
 *
 * These are consensus rules §8c enforces at apply time. Checking them here
 * keeps a clearly-doomed transaction from taking a pool slot.
 */
export function executePrune(tx: UtxoTransaction): { txId: string } {
  const prune = tx.prune;
  if (!prune) {
    throw Object.assign(new Error('Transaction carries no prune payload'), { statusCode: 400 });
  }

  // The root must be confirmed in an earlier block.
  const currentHeight = getCurrentHeight();
  const rootHeight = getTopologyHeight(prune.rootPostHash);
  if (rootHeight === null || rootHeight >= currentHeight) {
    throw Object.assign(
      new Error('Post is not confirmed in an earlier block'),
      { statusCode: 400 },
    );
  }

  // subtreePostIds must match the committed topology.
  const topologyIds = getSubtreeTopology(prune.rootPostHash);
  const entryIds = new Set(prune.subtreePostIds);
  if (topologyIds.size !== entryIds.size ||
      ![...topologyIds].every(id => entryIds.has(id))) {
    throw Object.assign(
      new Error('subtreePostIds does not match committed topology'),
      { statusCode: 400 },
    );
  }

  // Merkle root must match the postId list.
  const leaves = [...prune.subtreePostIds]
    .sort()
    .map(id => leafHash('stump', hexToBuf(id)));
  const computedRoot = Buffer.from(buildMerkleRoot(leaves)).toString('hex');
  const entryRoot = Buffer.from(prune.subtreeMerkleRoot).toString('hex');
  if (computedRoot !== entryRoot) {
    throw Object.assign(
      new Error('subtreeMerkleRoot does not match postId list'),
      { statusCode: 400 },
    );
  }

  const txId = computeTxId(tx);
  insertUtxoTx(tx, currentHeight + MEMPOOL_EXPIRY_BLOCKS);

  return { txId };
}
