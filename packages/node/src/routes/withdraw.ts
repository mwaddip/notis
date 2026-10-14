import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { getNet } from '../services/net-instance.js';
import { checkRequestTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface WithdrawDeps extends UtxoEngineDeps {
  executePostWithdraw: (deps: UtxoEngineDeps, tx: UtxoTransaction, currentBlockHeight: number) => { txId: string; expiresAtHeight: number };
  getCurrentHeight: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function withdrawRoutes(deps: WithdrawDeps): Router {
  const router = Router();

  // POST /posts/:id/withdraw — submit a signed postWithdraw transaction
  router.post('/posts/:id/withdraw', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'Request must carry a postWithdraw transaction' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = checkRequestTx(body.tx, deps.getCurrentHeight() + 1, deps.protocolVersionSchedule);
    } catch (err) {
      respondError(res, err, 'POST /posts/:id/withdraw (tx decode)', 'message');
      return;
    }

    if (!tx.postWithdraw) {
      res.status(400).json({ error: 'Request must carry a postWithdraw transaction' });
      return;
    }

    // NODE_INTERFACE → Withdrawal, the `POST /posts/:id/withdraw` row's
    // "400 if the payload is absent or names a post other than `:id`": the
    // route holds the payload's `postId` to `:id` after the edge and before
    // the service.
    if (tx.postWithdraw.postId !== req.params.id) {
      res.status(400).json({ error: 'postWithdraw payload names a post other than :id' });
      return;
    }

    try {
      // Admission judges at tip + 1 (NODE_INTERFACE → validateTx).
      const currentHeight = deps.getCurrentHeight() + 1;
      const { txId, expiresAtHeight } = deps.executePostWithdraw(deps, tx, currentHeight);

      const net = getNet();
      if (net) {
        net.broadcastTx(tx).catch((err: Error) => {
          console.warn(`Failed to broadcast postWithdraw tx: ${err.message}`);
        });
      }

      res.status(201).json({
        status: 'submitted',
        txId,
        postId: tx.postWithdraw.postId,
        expiresAtHeight,
      });
    } catch (err: unknown) {
      respondError(res, err, 'POST /posts/:id/withdraw', 'message');
    }
  });

  return router;
}
