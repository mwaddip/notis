import express from 'express';
import { buildInviteTx } from './invite.js';
import { buildCreditTransferTx } from './transfer.js';
import { PendingChain } from './pending.js';
import { RateLimiter } from './rate-limit.js';
import { NodeError } from './node-client.js';
import { InsufficientFundsError, HEX64 } from './tx.js';
import type { NodeClient } from './node-client.js';
import type { FaucetConfig } from './config.js';

/**
 * Two endpoints, because a karma grant is repeatable once and a credit transfer
 * is unlimited: an invite may not name a key that already holds an identity
 * record (NODE_INTERFACE → Karma transition rules), while the same key may
 * receive credits any number of times. Folding both into one call would spend a
 * tester's single invite to give them credits they could have had again.
 *
 * ⛔ **No grant ledger.** Once-per-identity is consensus state; the node's
 * refusal is the whole record, and it is relayed with its own status.
 */
export function createApp(cfg: FaucetConfig, client: NodeClient): express.Express {
  const app = express();
  app.use(express.json());

  const chain = new PendingChain();
  const karmaLimit = new RateLimiter(cfg.rateLimitPerHour);
  const creditLimit = new RateLimiter(cfg.rateLimitPerHour);

  // nginx terminates in front, so the socket address is the proxy for every
  // caller and the first forwarded hop is the client.
  const ip = (req: express.Request): string =>
    (req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || req.ip || 'unknown';

  /** The requested key, or `null` once the request has been answered. */
  const requested = (req: express.Request, res: express.Response): string | null => {
    const pubkey = String((req.body as { pubkey?: unknown } | undefined)?.pubkey ?? '')
      .toLowerCase();
    if (!HEX64.test(pubkey)) {
      res.status(400).json({ error: 'pubkey must be 64 hex characters, an Ed25519 public key' });
      return null;
    }
    return pubkey;
  };

  const limited = (limiter: RateLimiter, req: express.Request, res: express.Response): boolean => {
    if (limiter.allow(ip(req), Date.now())) return false;
    res.status(429).json({ error: 'rate limit reached — try again later' });
    return true;
  };

  app.post('/faucet/karma', async (req, res) => {
    const pubkey = requested(req, res);
    if (pubkey === null || limited(karmaLimit, req, res)) return;
    try {
      const height = await client.currentHeight();
      const built = buildInviteTx(cfg, chain.view(await client.karmaBoxes(cfg.publicKeyHex)), pubkey, height);
      await client.submitInvite(built.tx);
      chain.advance(built);
      res.status(202).json({ txId: built.txId, status: 'pending' });
    } catch (err) {
      // Whatever went wrong, the tip is no longer known to be what the node
      // holds. The cost of dropping it is one reselection.
      chain.reset();
      relay(res, err);
    }
  });

  app.post('/faucet/credits', async (req, res) => {
    const pubkey = requested(req, res);
    if (pubkey === null || limited(creditLimit, req, res)) return;
    try {
      const height = await client.currentHeight();
      const built = buildCreditTransferTx(
        cfg, await client.creditBoxes(cfg.publicKeyHex), pubkey, height,
      );
      await client.submitTransfer(built.tx);
      res.status(202).json({ txId: built.txId, status: 'pending' });
    } catch (err) {
      relay(res, err);
    }
  });

  // A malformed JSON body reaches here from `express.json()`; without this it
  // becomes a 500 for what is a client's mistake.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    relay(res, err);
  });

  return app;
}

/**
 * The node's verdict is relayed with its own status; the faucet's own states
 * carry theirs.
 *
 * ⚠ **A drained faucet answers 503, not 400.** It draws down as it invites and
 * does not replenish, so exhaustion is a state of this service — a 400 would
 * tell the caller their request was wrong.
 */
function relay(res: express.Response, err: unknown): void {
  if (err instanceof NodeError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof InsufficientFundsError) {
    res.status(503).json({ error: err.message });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : 'faucet request failed' });
}
