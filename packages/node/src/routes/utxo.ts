import { Router, Response } from 'express';
import {
  selectBoxes,
  computeTxId,
  PROTOCOL_VERSION,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { CandidateOf, KarmaBox, CreditBox, BondBox, NetworkType, UtxoTransaction } from '@dagsocial/types';
import { sendCredits } from '../services/credits.js';
import { validateTx } from '../services/utxo-engine.js';
import { admitTx } from '../services/admit-tx.js';
import type { UtxoEngineDeps } from '../services/utxo-engine.js';
import { resolvePendingTip } from '../store/mempool.js';
import { getUnlockedCreditBoxes } from '../store/utxo.js';
import {
  hasFaucetGrantRecord,
  hasPendingFaucetGrant,
  recordFaucetGrant,
} from '../store/faucet-grants.js';
import {
  getSystemKeypair,
  signWithSystemKey,
  ensureFaucetCreditBox,
} from '../store/system.js';
import { getNet } from '../services/net-instance.js';
import { jsonToTx } from './json-to-tx.js';
import { respondError } from './respond-error.js';
import { isFaucetNetwork } from '../config.js';

// ---------------------------------------------------------------------------
// Dependency types
// ---------------------------------------------------------------------------

export interface UtxoDeps {
  readonly networkType: NetworkType;
  getKarmaBox(owner: Uint8Array): KarmaBox | null;
  getKarmaBoxes(owner: Uint8Array): KarmaBox[];
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

    // Box values are bigint; JSON carries them as decimal strings.
    const total = karmaBoxes.reduce((sum, b) => sum + b.value, 0n);
    const boxes = karmaBoxes.map(b => ({
      boxId: b.id!,
      value: b.value.toString(),
    }));

    res.json({
      userId: req.params['userId'],
      total: total.toString(),
      boxes,
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

  // POST /credits/faucet — credit faucet, allow-listed networks only. The
  // reject-guard is the negation of the isFaucetNetwork allow-list shared
  // with the /faucet mount and the system-box provisioning — the three move
  // together.
  router.post('/credits/faucet', (req, res) => {
    if (!isFaucetNetwork(deps.networkType)) {
      res.status(403).json({ error: 'faucet disabled in production mode' });
      return;
    }

    const body = req.body as { to?: string };

    if (!body.to || typeof body.to !== 'string' || body.to.length !== 64) {
      res.status(400).json({ error: 'to must be a 64-character hex string' });
      return;
    }

    let toBytes: Uint8Array;
    try {
      toBytes = new Uint8Array(Buffer.from(body.to, 'hex'));
    } catch {
      res.status(400).json({ error: 'invalid to encoding' });
      return;
    }

    const currentHeight = deps.getCurrentHeight();
    const sysKeypair = getSystemKeypair();
    if (!sysKeypair) {
      res.status(500).json({ error: 'Faucet keypair not initialized' });
      return;
    }

    const FAUCET_AMOUNT = 1000n * 10n ** 8n;  // 1000 credits in base units
    const engineDeps = deps.getUtxoEngineDeps();

    // The eligibility check, the mempool insert and the grant record share one
    // transaction, so two calls for the same recipient in the same block cannot
    // both succeed. A settled box carries no faucet-origin marker, so the grant
    // ledger plus the mempool scan are the whole check.
    let outcome:
      | { ok: true; txId: string; tx: UtxoTransaction }
      | { ok: false; status: number; error: string }
      | undefined;

    try {
      engineDeps.runInTransaction(() => {
        if (
          hasFaucetGrantRecord(toBytes, 'credit') ||
          hasPendingFaucetGrant(toBytes, 'credit')
        ) {
          outcome = {
            ok: false,
            status: 409,
            error: 'to already funded by the credit faucet — one grant per identity',
          };
          return;
        }

        ensureFaucetCreditBox(sysKeypair.publicKey, currentHeight);

        // Under the pending view: a grant issued earlier in this block interval
        // already spends these boxes, and selecting one again would name an
        // input its own pool entry consumes. Each confirmed box resolves to the
        // live tip of its pending spend chain, so consecutive grants chain and
        // all of them apply in one block.
        const unlocked = getUnlockedCreditBoxes(sysKeypair.publicKey, currentHeight)
          .map(box => resolvePendingTip(box) as CreditBox | null)
          .filter((box): box is CreditBox => box !== null);
        const selected = selectBoxes(unlocked, FAUCET_AMOUNT);
        const totalSelected = selected.reduce((s, b) => s + b.value, 0n);
        const change = totalSelected - FAUCET_AMOUNT;

        // Candidates: this builder inserts no box and returns no predicted id,
        // so it deliberately attaches no provenance. The precomputed output
        // `id`s are gone with the type — nothing read them, and `computeTxId`
        // strips them before hashing, so the signed id is unchanged.
        const outputs: CandidateOf<CreditBox>[] = [{
          boxType: 'credit',
          value: FAUCET_AMOUNT,
          owner: toBytes,
        }];
        if (change > 0n) {
          outputs.push({
            boxType: 'credit',
            value: change,
            owner: sysKeypair.publicKey,
          });
        }

        const tx: UtxoTransaction = {
          inputs: selected.map(b => b.id!),
          outputs,
          signatures: {},
          protocolVersion: PROTOCOL_VERSION,
        };

        const txId = computeTxId(tx);
        const sysPubKeyHex = Buffer.from(sysKeypair.publicKey).toString('hex');
        const sig = signWithSystemKey(txId, sysKeypair.secretKey);
        tx.signatures[sysPubKeyHex] = sig;

        // Validate via UTXO engine
        const validation = validateTx(engineDeps, tx, currentHeight);
        if (!validation.valid) {
          outcome = {
            ok: false,
            status: 400,
            error: validation.error ?? 'transaction validation failed',
          };
          return;
        }

        // Insert into mempool and record the grant
        const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
        admitTx(tx, expiresAtHeight);
        recordFaucetGrant(toBytes, 'credit', txId, currentHeight);

        outcome = { ok: true, txId, tx };
      });
    } catch (err) {
      // A full mempool rolls the whole grant transaction back (no orphan
      // faucet_grants row) and answers 503 rather than escaping the handler.
      respondError(res, err, 'POST /credits/faucet', 'message');
      return;
    }

    if (!outcome) {
      res.status(500).json({ error: 'credit faucet grant did not complete' });
      return;
    }
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    // Broadcast (best-effort)
    try {
      const net = getNet();
      if (net) {
        net.broadcastTx(outcome.tx).catch((err: Error) => {
          console.warn(`Failed to broadcast credit faucet tx: ${err.message}`);
        });
      }
    } catch { /* net not available */ }

    res.json({ txId: outcome.txId, amount: FAUCET_AMOUNT.toString() });
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
