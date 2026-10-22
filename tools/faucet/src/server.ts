import express from 'express';
import { buildInviteTx } from './invite.js';
import { buildCreditTransferTx } from './transfer.js';
import { PendingChain } from './pending.js';
import { RateLimiter } from './rate-limit.js';
import { NodeError } from './node-client.js';
import { BadRequestError, InsufficientFundsError, HEX64 } from './tx.js';
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
  // nginx runs on loopback in front and appends the caller to X-Forwarded-For,
  // so with loopback trusted `req.ip` is that appended hop. A client controls
  // the hops it sends but not the one nginx adds, so it cannot prepend a value
  // to spend a rate-limit key other than its own.
  app.set('trust proxy', 'loopback');
  app.use(express.json());

  const chain = new PendingChain();
  const karmaLimit = new RateLimiter(cfg.rateLimitPerHour);
  const creditLimit = new RateLimiter(cfg.rateLimitPerHour);

  const ip = (req: express.Request): string => req.ip ?? 'unknown';

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
      const { blockHeight, protocolVersion } = await client.status();
      const built = buildInviteTx(
        cfg, chain.view(await client.karmaBoxes(cfg.publicKeyHex)), pubkey, blockHeight, protocolVersion,
      );
      const { expiresAtHeight } = await client.submitInvite(built.tx);
      chain.advance(built);
      res.status(202).json({ txId: built.txId, status: 'pending', expiresAtHeight });
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
      const { blockHeight, protocolVersion } = await client.status();
      const built = buildCreditTransferTx(
        cfg, await client.creditBoxes(cfg.publicKeyHex), pubkey, blockHeight, protocolVersion,
      );
      // `buildCreditTransferTx` emits the payment at index 0 unconditionally,
      // so `built.payment` is non-null here (transfer.ts).
      if (built.payment === null) throw new Error('transfer built no payment output');
      const { expiresAtHeight } = await client.submitTransfer(built.tx);
      res.status(202).json({
        txId: built.txId,
        status: 'pending',
        expiresAtHeight,
        boxId: built.payment.boxId,
      });
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
 * NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
 * node's, never one dressed as the other" — the verdict is a `NodeError` the
 * client built where the node's answer was read, carrying the status to
 * answer; the service's own states carry theirs here.
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
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // `express.json()` rejects a body it cannot parse with a 4xx of its own; the
  // service relays that status with its own error text.
  if (
    typeof err === 'object'
    && err !== null
    && typeof (err as { status?: unknown }).status === 'number'
    && (err as { status: number }).status >= 400
    && (err as { status: number }).status < 500
  ) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'bad request body' });
    return;
  }
  // A fault of the service's own: the error text is not relayed; the error
  // itself is logged server-side.
  console.error('faucet request failed', err);
  res.status(500).json({ error: 'faucet request failed' });
}
