import { Router } from 'express';
import type { UtxoTransaction, UsernameBox } from '@dagsocial/types';
import { isValidUsernameBytes, usernameString } from '@dagsocial/types';
import type { UtxoEngineDeps, UtxoResult } from '@dagsocial/consensus';
import { admitWriteTx } from '../services/admit-tx.js';
import { getNet } from '../services/net-instance.js';
import { checkRequestTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { parseNameParam, resolveIdentityParam, isResolveError } from './page.js';
import type { UsernameRow } from '../store/usernames.js';

// NODE_INTERFACE → Usernames

export interface UsernameRouteDeps extends UtxoEngineDeps {
  getCurrentHeight(): number;
  validateTx(tx: UtxoTransaction, txId: string, currentBlockHeight: number): UtxoResult;
  getUsername(nameLower: string): UsernameRow | null;
  getUsernameByOwner(owner: Uint8Array | string): UsernameRow | null;
}

export function createRouter(deps: UsernameRouteDeps): Router {
  const router = Router();

  // POST /usernames — claim
  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 'Request must carry a claim transaction' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = checkRequestTx(body.tx, deps.getCurrentHeight() + 1, deps.protocolVersionSchedule);
    } catch (err) {
      respondError(res, err, 'POST /usernames (tx decode)', 'message');
      return;
    }

    const usernameOut = (tx.outputs ?? []).find(o => o.boxType === 'username') as UsernameBox | undefined;
    if (!usernameOut) {
      res.status(400).json({ error: 'Transaction must output a username box' });
      return;
    }

    if (!isValidUsernameBytes(usernameOut.name)) {
      res.status(400).json({ error: 'name invalid' });
      return;
    }

    // The pending-name gates ride admission (MEMPOOL_INTERFACE →
    // Correctness gates). The handler keeps the shape-level checks only;
    // `admitWriteTx` asks the pool first (NODE_INTERFACE → Service Layer
    // Architecture → "A transaction the pool already holds is answered as
    // held") so a resubmit answers with the pooled transaction's bytes.

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
          console.warn(`Failed to broadcast claim tx: ${err.message}`);
        });
      }

      const pooledOut = (pooledTx.outputs ?? []).find(
        (o): o is UsernameBox => o.boxType === 'username',
      )!;
      const nameAsTyped = usernameString(pooledOut.name);
      res.status(200).json({ status: 'pending', txId, expiresAtHeight, name: nameAsTyped });
    } catch (err) {
      respondError(res, err, 'POST /usernames', 'message');
    }
  });

  // POST /usernames/:name/burn
  router.post('/:name/burn', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 'Request must carry a burn transaction' });
      return;
    }

    const parsed = parseNameParam(req.params.name!);
    if ('invalid' in parsed) {
      res.status(400).json({ error: 'name invalid' });
      return;
    }

    const row = deps.getUsername(parsed.canonical);
    if (!row) {
      res.status(404).json({ error: 'Name not held' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = checkRequestTx(body.tx, deps.getCurrentHeight() + 1, deps.protocolVersionSchedule);
    } catch (err) {
      respondError(res, err, 'POST /usernames/:name/burn (tx decode)', 'message');
      return;
    }

    if (!tx.inputs.includes(row.boxId)) {
      res.status(400).json({ error: `Transaction does not consume ${parsed.name}'s box` });
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
          console.warn(`Failed to broadcast burn tx: ${err.message}`);
        });
      }

      res.status(200).json({ status: 'pending', txId, expiresAtHeight });
    } catch (err) {
      respondError(res, err, 'POST /usernames/:name/burn', 'message');
    }
  });

  // GET /usernames/:name
  router.get('/:name', (req, res) => {
    const parsed = parseNameParam(req.params.name!);
    if ('invalid' in parsed) {
      res.status(400).json({ error: 'name invalid' });
      return;
    }
    const row = deps.getUsername(parsed.canonical);
    if (!row) {
      res.status(404).json({ error: 'Name not held' });
      return;
    }

    res.status(200).json({
      name: row.name,
      owner: row.owner,
      boxId: row.boxId,
      claimedAtBlock: row.claimedAtBlock,
    });
  });

  // GET /usernames?owner=<identity>
  router.get('/', (req, res) => {
    const ownerRaw = req.query.owner as string | undefined;
    if (!ownerRaw) {
      res.status(400).json({ error: 'owner parameter required' });
      return;
    }

    const resolved = resolveIdentityParam(ownerRaw, deps.getUsername);
    if (isResolveError(resolved)) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    const row = deps.getUsernameByOwner(resolved.hex);
    if (!row) {
      res.status(404).json({ error: 'Identity holds no name' });
      return;
    }

    res.status(200).json({
      name: row.name,
      owner: row.owner,
      boxId: row.boxId,
      claimedAtBlock: row.claimedAtBlock,
    });
  });

  return router;
}
