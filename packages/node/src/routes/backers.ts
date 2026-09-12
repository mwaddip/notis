// NODE_INTERFACE → Backers
import { Router } from 'express';
import type { BackerPoolBox, BackerStakeBox, UtxoTransaction } from '@dagsocial/types';
import { protocolVersionAt, computeTxId, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoEngineDeps, UtxoResult } from '../services/utxo-engine.js';
import { admitTx } from '../services/admit-tx.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { resolveIdentityParam, isResolveError } from './page.js';

export interface BackerRouteDeps extends UtxoEngineDeps {
  getCurrentHeight(): number;
  validateTx(tx: UtxoTransaction, currentBlockHeight: number): UtxoResult;
  getBackerPoolBox(): BackerPoolBox | null;
  getBackerStakeBox(owner: Uint8Array): BackerStakeBox | null;
  backerSupply: bigint;
  creditFixedRateBlocks: number;
}

export function createRouter(deps: BackerRouteDeps): Router {
  const router = Router();

  // GET /backers
  router.get('/', (_req, res) => {
    const pool = deps.getBackerPoolBox();
    if (!pool) {
      res.status(404).json({ error: 'no backer pool' });
      return;
    }
    res.json({
      supply: deps.backerSupply.toString(),
      staked: pool.staked.toString(),
      accrual: pool.accrual.toString(),
      unreleased: pool.value.toString(),
      accrualEndsAtBlock: deps.creditFixedRateBlocks,
    });
  });

  // GET /backers/:userId
  router.get('/:userId', (req, res) => {
    const pool = deps.getBackerPoolBox();
    if (!pool) {
      res.status(404).json({ error: 'no backer pool' });
      return;
    }

    const resolved = resolveIdentityParam(req.params.userId!, deps.getUsername);
    if (isResolveError(resolved)) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    const owner = new Uint8Array(Buffer.from(resolved.hex, 'hex'));
    const stake = deps.getBackerStakeBox(owner);
    if (!stake) {
      res.status(404).json({ error: 'no stake' });
      return;
    }

    const accrued = deps.backerSupply > 0n
      ? (stake.weight * pool.accrual) / deps.backerSupply
      : 0n;

    res.json({
      owner: resolved.hex,
      boxId: stake.id,
      weight: stake.weight.toString(),
      accrued: accrued.toString(),
    });
  });

  // POST /backers/unstake
  router.post('/unstake', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 'Request must carry an unstake transaction' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx, protocolVersionAt(deps.protocolVersionSchedule, deps.getCurrentHeight() + 1)!);
    } catch (err) {
      respondError(res, err, 'POST /backers/unstake (tx decode)', 'message');
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight() + 1;
      const result = deps.validateTx(tx, currentHeight);
      if (!result.valid) {
        res.status(400).json({ error: result.error });
        return;
      }

      const txId = computeTxId(tx);
      const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
      admitTx(tx, expiresAtHeight);

      const net = getNet();
      if (net) {
        net.broadcastTx(tx).catch((err: Error) => {
          console.warn(`Failed to broadcast unstake tx: ${err.message}`);
        });
      }

      res.status(200).json({ status: 'pending', txId, expiresAtHeight });
    } catch (err) {
      respondError(res, err, 'POST /backers/unstake', 'message');
    }
  });

  return router;
}
