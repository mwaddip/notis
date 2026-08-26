import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface DeleteDeps extends UtxoEngineDeps {
  executePrune: (deps: UtxoEngineDeps, tx: UtxoTransaction, currentBlockHeight: number) => { txId: string };
  getCurrentHeight: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function deleteRoutes(deps: DeleteDeps): Router {
  const router = Router();

  // POST /posts/:id/prune — submit a signed prune transaction
  router.post('/posts/:id/prune', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'Request must carry a prune transaction' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'POST /posts/:id/prune (tx decode)', 'message');
      return;
    }

    if (!tx.prune) {
      res.status(400).json({ error: 'Request must carry a prune transaction' });
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const { txId } = deps.executePrune(deps, tx, currentHeight);

      const net = getNet();
      if (net) {
        net.broadcastTx(tx).catch((err: Error) => {
          console.warn(`Failed to broadcast prune tx: ${err.message}`);
        });
      }

      res.status(201).json({
        status: 'submitted',
        txId,
        postId: tx.prune.rootPostHash,
        replyCount: tx.prune.subtreePostIds.length - 1,
      });
    } catch (err: unknown) {
      respondError(res, err, 'POST /posts/:id/prune', 'message');
    }
  });

  return router;
}
