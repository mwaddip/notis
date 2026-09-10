import { Router } from 'express';
import type { UtxoTransaction } from '@dagsocial/types';
import { protocolVersionAt } from '@dagsocial/types';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import {
  getVouchesForTargetPage,
  getVouchesForVoucherPage,
  getVouchEscrowsForPage,
} from '../store/index.js';
import { parseLimit, isLimitError, parseAfter, isAfterError, resolveIdentityParam, isResolveError } from './page.js';
import { nameFor } from '../services/name-cache.js';

export interface VouchesDeps extends UtxoEngineDeps {
  castVouch(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction };
  initiateUnvouch(
    deps: UtxoEngineDeps,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ): {
    status: 'pending';
    txId: string;
    expiresAtHeight: number;
    karmaReturnsAtBlock: number;
    tx: UtxoTransaction;
  };
  getCurrentHeight(): number;
}

export function createRouter(deps: VouchesDeps): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }
    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx, protocolVersionAt(deps.protocolVersionSchedule, deps.getCurrentHeight() + 1)!);
    } catch (err) {
      respondError(res, err, 'POST /vouches (tx decode)');
      return;
    }
    try {
      // Admission judges at tip + 1 (NODE_INTERFACE → validateTx).
      const currentHeight = deps.getCurrentHeight() + 1;
      const result = deps.castVouch(deps, tx, currentHeight);
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast vouch tx: ${err.message}`);
        });
      }
      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
      });
    } catch (err) {
      respondError(res, err, 'POST /vouches');
    }
  });

  router.delete('/:targetId', (req, res) => {
    const body = req.body as { tx?: Record<string, unknown> };
    if (!body.tx) {
      res.status(400).json({ error: 400, reason: 'tx required' });
      return;
    }
    let tx: UtxoTransaction;
    try {
      tx = jsonToTx(body.tx, protocolVersionAt(deps.protocolVersionSchedule, deps.getCurrentHeight() + 1)!);
    } catch (err) {
      respondError(res, err, 'DELETE /vouches/:targetId (tx decode)');
      return;
    }
    try {
      // Admission judges at tip + 1 (NODE_INTERFACE → validateTx).
      const currentHeight = deps.getCurrentHeight() + 1;
      const result = deps.initiateUnvouch(deps, tx, currentHeight);
      const net = getNet();
      if (net) {
        net.broadcastTx(result.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast unvouch tx: ${err.message}`);
        });
      }
      res.status(200).json({
        status: 'pending',
        txId: result.txId,
        expiresAtHeight: result.expiresAtHeight,
        karmaReturnsAtBlock: result.karmaReturnsAtBlock,
      });
    } catch (err) {
      respondError(res, err, 'DELETE /vouches/:targetId');
    }
  });

  router.get('/', (req, res) => {
    const targetRaw = req.query.target as string | undefined;
    const voucherRaw = req.query.voucher as string | undefined;
    const cooldownsParam = req.query.cooldowns as string | undefined;

    let target: string | undefined;
    if (targetRaw) {
      const resolved = resolveIdentityParam(targetRaw, deps.getUsername);
      if (isResolveError(resolved)) { res.status(resolved.status).json({ error: resolved.error }); return; }
      target = resolved.hex;
    }
    let voucher: string | undefined;
    if (voucherRaw) {
      const resolved = resolveIdentityParam(voucherRaw, deps.getUsername);
      if (isResolveError(resolved)) { res.status(resolved.status).json({ error: resolved.error }); return; }
      voucher = resolved.hex;
    }

    if (cooldownsParam !== undefined && voucher) {
      const limit = parseLimit(req.query as Record<string, unknown>);
      if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
      const after = parseAfter(req.query as Record<string, unknown>, 'id');
      if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
      const voucherBytes = new Uint8Array(Buffer.from(voucher, 'hex'));
      // ⛔ **No `targetId`, because a `VouchEscrowBox` carries none**
      // (TYPES_INTERFACE → VouchEscrowBox). It holds the voucher, the staked
      // value and the release height, so the response reports what committed
      // state says rather than a field reconstructed from somewhere else.
      const result = getVouchEscrowsForPage(voucherBytes, {
        limit, after: after as string | undefined,
      });
      res.status(200).json({
        cooldowns: result.rows.map((e) => ({
          boxId: e.id!,
          value: e.value.toString(),
          releaseAtBlock: e.releaseAtBlock,
        })),
        count: result.count,
        next: result.next,
      });
      return;
    }

    if (target) {
      const limit = parseLimit(req.query as Record<string, unknown>);
      if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
      const after = parseAfter(req.query as Record<string, unknown>, 'id');
      if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
      const targetBytes = new Uint8Array(Buffer.from(target, 'hex'));
      const result = getVouchesForTargetPage(targetBytes, {
        limit, after: after as string | undefined,
      });
      // NODE_INTERFACE → Usernames → "A list row carries its names"
      const names = new Map<string, string | null>();
      res.status(200).json({
        vouches: result.rows.map((v) => {
          const voucherHex = Buffer.from(v.voucherId).toString('hex');
          const targetHex = Buffer.from(v.targetId).toString('hex');
          return {
            voucherId: voucherHex,
            voucherName: nameFor(voucherHex, names, deps.getUsernameByOwner),
            targetId: targetHex,
            targetName: nameFor(targetHex, names, deps.getUsernameByOwner),
          };
        }),
        count: result.count,
        next: result.next,
      });
      return;
    }

    if (voucher) {
      const limit = parseLimit(req.query as Record<string, unknown>);
      if (isLimitError(limit)) { res.status(400).json({ error: limit.error }); return; }
      const after = parseAfter(req.query as Record<string, unknown>, 'id');
      if (isAfterError(after)) { res.status(400).json({ error: after.error }); return; }
      const voucherBytes = new Uint8Array(Buffer.from(voucher, 'hex'));
      const result = getVouchesForVoucherPage(voucherBytes, {
        limit, after: after as string | undefined,
      });
      // NODE_INTERFACE → Usernames → "A list row carries its names"
      const names = new Map<string, string | null>();
      res.status(200).json({
        vouches: result.rows.map((v) => {
          const voucherHex = Buffer.from(v.voucherId).toString('hex');
          const targetHex = Buffer.from(v.targetId).toString('hex');
          return {
            // The VouchBox's id; an unvouch spends a named box and this arm
            // is the read surface that names it (NODE_INTERFACE → Vouches).
            boxId: v.id!,
            // ⛔ **The stake, because the escrow must carry the CONSUMED BOX's
            // value and never `VOUCH_KARMA_AMOUNT`** (TYPES_INTERFACE →
            // VouchEscrowBox).
            value: v.value.toString(),
            createdAtBlock: v.createdAtBlock,
            voucherId: voucherHex,
            voucherName: nameFor(voucherHex, names, deps.getUsernameByOwner),
            targetId: targetHex,
            targetName: nameFor(targetHex, names, deps.getUsernameByOwner),
          };
        }),
        count: result.count,
        next: result.next,
      });
      return;
    }

    res.status(400).json({
      error: 400,
      reason: 'Provide ?target=<hex> or ?voucher=<hex> or ?voucher=<hex>&cooldowns=1',
    });
  });

  return router;
}
