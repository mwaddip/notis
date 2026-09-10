import { Router } from 'express';
import type { UtxoTransaction, UsernameBox } from '@dagsocial/types';
import { protocolVersionAt, canonicalUsernameBytes, isValidUsernameBytes, computeTxId, MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { UtxoEngineDeps, UtxoResult } from '../services/utxo-engine.js';
import { admitTx } from '../services/admit-tx.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { resolveIdentityParam, isResolveError } from './page.js';
import { hasPendingClaim, hasPendingClaimBy } from '../store/mempool.js';
import type { UsernameRow } from '../store/usernames.js';

// NODE_INTERFACE → Usernames

export interface UsernameRouteDeps extends UtxoEngineDeps {
  getCurrentHeight(): number;
  validateTx(tx: UtxoTransaction, currentBlockHeight: number): UtxoResult;
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
      tx = jsonToTx(body.tx, protocolVersionAt(deps.protocolVersionSchedule, deps.getCurrentHeight() + 1)!);
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

    const canonical = Buffer.from(canonicalUsernameBytes(usernameOut.name)).toString('utf8');
    if (hasPendingClaim(canonical)) {
      res.status(409).json({ error: 'A pending claim for this name exists' });
      return;
    }
    const claimantHex = Buffer.from(usernameOut.owner).toString('hex');
    if (hasPendingClaimBy(claimantHex)) {
      res.status(409).json({ error: 'This identity already has a pending claim' });
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
          console.warn(`Failed to broadcast claim tx: ${err.message}`);
        });
      }

      const nameAsTyped = Buffer.from(usernameOut.name).toString('utf8');
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

    let rawName = req.params.name!;
    if (rawName.startsWith('@')) rawName = rawName.slice(1);
    const nameBytes = Buffer.from(rawName, 'utf8');
    if (!isValidUsernameBytes(nameBytes)) {
      res.status(400).json({ error: 'name invalid' });
      return;
    }

    const canonical = Buffer.from(canonicalUsernameBytes(nameBytes)).toString('utf8');
    const row = deps.getUsername(canonical);
    if (!row) {
      res.status(404).json({ error: 'Name not held' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx, protocolVersionAt(deps.protocolVersionSchedule, deps.getCurrentHeight() + 1)!);
    } catch (err) {
      respondError(res, err, 'POST /usernames/:name/burn (tx decode)', 'message');
      return;
    }

    if (!tx.inputs.includes(row.boxId)) {
      res.status(400).json({ error: `Transaction does not consume ${rawName}'s box` });
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
    let rawName = req.params.name!;
    if (rawName.startsWith('@')) rawName = rawName.slice(1);
    const nameBytes = Buffer.from(rawName, 'utf8');
    if (!isValidUsernameBytes(nameBytes)) {
      res.status(400).json({ error: 'name invalid' });
      return;
    }

    const canonical = Buffer.from(canonicalUsernameBytes(nameBytes)).toString('utf8');
    const row = deps.getUsername(canonical);
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
