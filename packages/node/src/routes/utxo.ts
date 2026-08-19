import { Router, Response } from 'express';
import {
  selectBoxes,
  computeTxId,
  PROTOCOL_VERSION,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { CandidateOf, KarmaBox, CreditBox, BondBox, UtxoTransaction } from '@dagsocial/types';
import { sendCredits } from '../services/credits.js';
import { validateTx } from '../services/utxo-engine.js';
import { admitTx } from '../services/admit-tx.js';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import type { IdentityRecord } from '../store/identity-records.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getKarmaBoxes(owner: Uint8Array): KarmaBox[];
  getIdentityRecord(owner: Uint8Array): IdentityRecord | null;
  getCreditBox(owner: Uint8Array): CreditBox | null;
  getCreditBoxes(owner: Uint8Array): CreditBox[];
  getBondBoxes(inviterId: Uint8Array): BondBox[];
  getCurrentHeight(): number;
  getUtxoEngineDeps(): UtxoEngineDeps;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: UtxoDeps): Router {
  const router = Router();

  // Helper: parse hex userId from URL param, return Uint8Array
  function parseUserId(param: string, res: Response): Uint8Array | null {
    if (!param || typeof param !== 'string' || param.length !== 64) {
      res.status(400).json({ error: 'userId must be a 64-character hex string' });
      return null;
    }
    try {
      return new Uint8Array(Buffer.from(param, 'hex'));
    } catch {
      res.status(400).json({ error: 'userId must be a hex string' });
      return null;
    }
  }

  // GET /karma/:userId — get karma balance for a user
  router.get('/karma/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const karmaBoxes = deps.getKarmaBoxes(userIdBytes);
    if (karmaBoxes.length === 0) {
      res.status(404).json({ error: 'No karma box found' });
      return;
    }

    const total = karmaBoxes.reduce((sum, b) => sum + b.value, 0n);
    const boxes = karmaBoxes.map(b => ({
      boxId: b.id!,
      value: b.value.toString(),
    }));
    const record = deps.getIdentityRecord(userIdBytes);
    const height = deps.getCurrentHeight();

    res.json({
      userId: req.params['userId'],
      total: total.toString(),
      boxes,
      lastActivityBlock: record?.lastActivityBlock ?? 0,
      lastDecayBlock: record?.lastDecayBlock ?? 0,
      height,
    });
  });

  // GET /credits/:userId — get credit balance for a user (multi-box)
  router.get('/credits/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const creditBoxes = deps.getCreditBoxes(userIdBytes);
    if (creditBoxes.length === 0) {
      res.status(404).json({ error: 'No credit box found' });
      return;
    }

    const total = creditBoxes.reduce((sum, b) => sum + b.value, 0n);
    const boxes = creditBoxes.map(b => ({
      boxId: b.id!,
      value: b.value.toString(),
      ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
    }));

    res.json({
      userId: req.params['userId'],
      total: total.toString(),
      boxes,
    });
  });

  // POST /credits/transfer — pool a client-built, client-signed credit
  // transfer: jsonToTx → validateTx + admitTx in the service → broadcast
  // → pending response, the path every other tx route takes. Credits move when
  // the transaction is mined.
  router.post('/credits/transfer', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };

    if (!body.tx) {
      res.status(400).json({ error: 'tx required' });
      return;
    }

    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx);
    } catch (err) {
      respondError(res, err, 'POST /credits/transfer (tx decode)', 'message');
      return;
    }

    try {
      const currentHeight = deps.getCurrentHeight();
      const result = sendCredits(deps.getUtxoEngineDeps(), tx, currentHeight);

      // Broadcast to peers (fire-and-forget)
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast credit transfer tx: ${err.message}`);
        });
      }

      res.json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err: unknown) {
      respondError(res, err, 'POST /credits/transfer', 'message');
    }
  });

  // GET /invites/:userId — the bonds an inviter holds
  //
  // ⛔ **The `open` array is gone with the box it listed.** An invite is one
  // transaction creating a bond, so a bond IS the open invite and a second list
  // would be the same rows under another name (ARCHITECTURE → Invite System).
  // A bond is live from creation until its probation deadline.
  router.get('/invites/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const bonds = deps.getBondBoxes(userIdBytes);

    res.json({
      bonds: bonds.map((b) => ({
        id: b.id,
        value: b.value.toString(),
        inviterId: Buffer.from(b.inviterId).toString('hex'),
        inviteePublicKey: Buffer.from(b.inviteePublicKey).toString('hex'),
      })),
    });
  });

  return router;
}
