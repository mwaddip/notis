// NODE_INTERFACE → Backers
import { Router } from 'express';
import type { BackerPoolBox, BackerStakeBox, UtxoTransaction } from '@dagsocial/types';
import type { UtxoEngineDeps, UtxoResult } from '@dagsocial/consensus';
import { admitWriteTx } from '../services/admit-tx.js';
import { ClientError } from '../services/client-error.js';
import { getNet } from '../services/net-instance.js';
import { checkRequestTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { resolveIdentityParam, isResolveError } from './page.js';

export interface BackerRouteDeps extends UtxoEngineDeps {
  getCurrentHeight(): number;
  validateTx(tx: UtxoTransaction, txId: string, currentBlockHeight: number): UtxoResult;
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
      tx = checkRequestTx(body.tx, deps.getCurrentHeight() + 1, deps.protocolVersionSchedule);
    } catch (err) {
      respondError(res, err, 'POST /backers/unstake (tx decode)', 'message');
      return;
    }

    // NODE_INTERFACE → Backers: a transaction of any other shape is refused
    // here, before admission; `validateTx`'s unstake arm answers everything
    // else about the shape.
    const outs = tx.outputs ?? [];
    const markers = outs.filter((o) => o.boxType === 'backer_unstake');
    const successors = outs.filter((o) => o.boxType === 'backer_stake');
    if (markers.length !== 1 || successors.length > 1
        || outs.length !== markers.length + successors.length) {
      respondError(
        res,
        new ClientError(
          'unstake outputs must be one backer_unstake marker and at most one backer_stake successor',
        ),
        'POST /backers/unstake',
        'message',
      );
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight() + 1;
      const { txId, expiresAtHeight, tx: pooledTx } = admitWriteTx(
        () => {},
        deps.validateTx,
        tx,
        currentHeight,
        '',
      );

      const net = getNet();
      if (net) {
        net.broadcastTx(pooledTx).catch((err: Error) => {
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
