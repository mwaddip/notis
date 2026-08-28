import { Router, Response } from 'express';
import type { UtxoTransaction, KarmaBox, CreditBox, BondBox } from '@dagsocial/types';
import { sendCredits } from '../services/credits.js';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import type { IdentityRecord } from '../store/identity-records.js';
import type { Page, PageResult, BoxKey } from '../store/index.js';
import type { DecayCfg } from '../services/decay.js';
import { effectiveKarma } from '../services/decay.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { parseLimit, isLimitError, parseAfter, isAfterError, formatKey } from './page.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  getKarmaTotal(owner: Uint8Array): bigint;
  getKarmaBoxesPage(owner: Uint8Array, page: Page<BoxKey>): PageResult<KarmaBox, BoxKey>;
  getIdentityRecord(owner: Uint8Array): IdentityRecord | null;
  getCreditValue(owner: Uint8Array): bigint;
  getCreditBoxesPage(owner: Uint8Array, page: Page<BoxKey>): PageResult<CreditBox, BoxKey>;
  getBondBoxesPage(inviterId: Uint8Array, page: Page<string>): PageResult<BondBox, string>;
  getCurrentHeight(): number;
  getUtxoEngineDeps(): UtxoEngineDeps;
  decayCfg: DecayCfg;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRouter(deps: UtxoDeps): Router {
  const router = Router();

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

  // GET /karma/:userId
  router.get('/karma/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'box');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }

    const pageResult = deps.getKarmaBoxesPage(userIdBytes, {
      limit, after: after as BoxKey | undefined,
    });
    if (pageResult.count === 0) {
      res.status(404).json({ error: 'No karma box found' });
      return;
    }

    const total = deps.getKarmaTotal(userIdBytes);
    const record = deps.getIdentityRecord(userIdBytes);
    const height = deps.getCurrentHeight();
    const eff = effectiveKarma(total, record, height, deps.decayCfg);

    res.json({
      userId: req.params['userId'],
      total: total.toString(),
      effective: eff.toString(),
      boxes: pageResult.rows.map(b => ({
        boxId: b.id!,
        value: b.value.toString(),
      })),
      boxCount: pageResult.count,
      next: pageResult.next ? formatKey('box', pageResult.next) : null,
      lastActivityBlock: record?.lastActivityBlock ?? 0,
      lastDecayBlock: record?.lastDecayBlock ?? 0,
      height,
    });
  });

  // GET /credits/:userId
  router.get('/credits/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'box');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }

    const total = deps.getCreditValue(userIdBytes);
    const pageResult = deps.getCreditBoxesPage(userIdBytes, {
      limit, after: after as BoxKey | undefined,
    });
    if (pageResult.count === 0) {
      res.status(404).json({ error: 'No credit box found' });
      return;
    }

    res.json({
      userId: req.params['userId'],
      total: total.toString(),
      boxes: pageResult.rows.map(b => ({
        boxId: b.id!,
        value: b.value.toString(),
        ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
      })),
      boxCount: pageResult.count,
      next: pageResult.next ? formatKey('box', pageResult.next) : null,
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

  // NODE_INTERFACE → UTXO queries — a bond IS the open invite; unspent bonds only.
  router.get('/invites/:userId', (req, res) => {
    const userIdBytes = parseUserId(req.params['userId']!, res);
    if (!userIdBytes) return;

    const limit = parseLimit(req.query as Record<string, unknown>);
    if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
    const after = parseAfter(req.query as Record<string, unknown>, 'id');
    if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }

    const pageResult = deps.getBondBoxesPage(userIdBytes, {
      limit, after: after as string | undefined,
    });

    res.json({
      bonds: pageResult.rows.map((b) => ({
        id: b.id,
        value: b.value.toString(),
        inviterId: Buffer.from(b.inviterId).toString('hex'),
        inviteePublicKey: Buffer.from(b.inviteePublicKey).toString('hex'),
      })),
      bondCount: pageResult.count,
      next: pageResult.next,
    });
  });

  return router;
}
