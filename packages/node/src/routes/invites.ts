import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface InvitesDeps extends UtxoEngineDeps {
  createInvite(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    bondBox: { id?: string };
    tx: UtxoTransaction;
  };
  getCurrentHeight(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: InvitesDeps): Router {
  const router = Router();

  // POST /invites — create a new invite
  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'POST /invites (tx decode)', 'message');
      return;
    }

    try {
      // Admission judges at tip + 1 (NODE_INTERFACE → validateTx).
      const currentHeight = deps.getCurrentHeight() + 1;
      const result = deps.createInvite(deps, tx, currentHeight);

      // Broadcast invite create tx to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast invite create tx: ${err.message}`);
        });
      }

      // ⛔ **`inviteBoxId` is gone from this response, and that is an API
      // break rather than internal cleanup** (NODE_INTERFACE → Invites). There
      // is no invite box: the bond is the request, and the block's settlement
      // grants the invitee their karma out of the pool.
      res.status(201).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        bondBoxId: result.bondBox.id,
      });
    } catch (err) {
      respondError(res, err, 'POST /invites', 'message');
    }
  });

  // `POST /invites/claim` and `POST /invites/cancel` are deleted with the
  // transactions they submitted (NODE_INTERFACE → Invites). There is one step,
  // not two.

  return router;
}
