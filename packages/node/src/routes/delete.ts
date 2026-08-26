import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import { MempoolFullError, PendingSpendConflictError, TxTooLargeError } from '../store/mempool.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface DeleteDeps {
  executePrune: (tx: UtxoTransaction) => { txId: string };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function deleteRoutes(deps: DeleteDeps): Router {
  const router = Router();

  // POST /posts/:id/prune — submit a signed prune transaction
  router.post('/posts/:id/prune', (req, res) => {
    try {
      const tx = req.body as UtxoTransaction;
      if (!tx || !tx.prune) {
        return res.status(400).json({ error: 'Request must carry a prune transaction' });
      }

      const { txId } = deps.executePrune(tx);

      return res.status(201).json({
        status: 'submitted',
        txId,
        postId: tx.prune.rootPostHash,
        replyCount: tx.prune.subtreePostIds.length - 1,
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        return res.status(404).json({ error: 'Post not found' });
      }
      if (err.statusCode === 403) {
        return res.status(403).json({ error: err.message });
      }
      if (err.statusCode === 400) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof MempoolFullError) {
        return res.status(503).json({ error: 'mempool full' });
      }
      if (err instanceof PendingSpendConflictError) {
        return res.status(409).json({ error: err.message });
      }
      if (err instanceof TxTooLargeError) {
        return res.status(413).json({ error: err.message });
      }
      console.error('DELETE /posts/:id failed with an unexpected error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
